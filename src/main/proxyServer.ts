// 本地反代服务：把 Anthropic / OpenAI 格式的请求转成 Kiro 的 generateAssistantResponse
//
// 面向 Claude Code、Codex 这类桌面 agent：它们只会说 Anthropic 或 OpenAI 协议，
// 而 Kiro 的对话接口是 AWS event-stream + 自己一套 conversationState。
// 这里做协议转换，账号调度与重试交给 proxyUpstream。
import * as http from 'http'
import { buildCodexCatalog, readCodexTemplate } from './proxyClients'
import {
  FALLBACK_MODEL_IDS,
  estimateTokens,
  mapProxyModel,
  resolveEffort
} from '../shared/proxyModels'
import { buildModelRequestFields } from '../shared/modelSchema'
import { errorMessage } from '../shared/errors'
import { log } from './logger'
import {
  AnthropicSseWriter,
  OpenAiSseWriter,
  ResponsesSseWriter,
  GeminiSseWriter,
  buildAnthropicResponse,
  buildKiroPayload,
  buildOpenAiResponse,
  buildResponsesResponse,
  buildGeminiResponse,
  normalizeAnthropicRequest,
  normalizeOpenAiRequest,
  normalizeResponsesRequest,
  normalizeGeminiRequest,
  normalizeStopReason,
  webSearchToolSpec,
  type ServerSearchBlock,
  MAX_WEB_SEARCH_ROUNDS,
  WEB_SEARCH_TOOL,
  type CollectedResult,
  type NormalizedRequest,
  type NormMessage,
  type NormToolResult,
  type NormToolUse,
  type StreamToolCall
} from './proxyConvert'
import {
  UpstreamError,
  cachedModelIds,
  callUpstream,
  ensureToken as ensureProxyToken,
  fetchProxyModels,
  poolMembers,
  poolOptionsFrom
} from './proxyUpstream'
import { formatSearchResults, kiroWebSearch, type WebSearchResult } from './kiroWebSearch'
import { randomUUID } from 'crypto'
import { listRawApiKeyModels, listRawKiroModels } from './kiroChat'
import { checkProxyKey, flushProxyKeyUsage, recordKeyUsage, type KeyCheck } from './proxyKeys'
import {
  LOG_CAPACITY,
  bindProxyLogSource,
  emptyStats,
  flushProxyLogs,
  loadProxyLogs,
  scheduleProxyLogFlush,
  type ProxyStats
} from './proxyLogStore'
import { getAccountData, getProxyConfig, getProxyModels, getProxyUsage, setProxyUsage } from './store'
import type {
  Account,
  KiroModelInfo,
  ProxyModelCache,
  ProxyAccountUsage,
  ProxyConfig,
  ProxyInputType,
  ProxyLogEntry,
  ProxyOutputType,
  ProxyProtocol,
  ProxyStatus
} from '../shared/types'
import {
  DEFAULT_PROXY_CONFIG,
  PAYLOAD_LIMIT_MAX_KB,
  PAYLOAD_LIMIT_MIN_KB
} from '../shared/types'

/** 请求体上限：Claude Code 带完整仓库上下文时能到几 MB */
const MAX_BODY_BYTES = 32 * 1024 * 1024

let server: http.Server | null = null
let config: ProxyConfig = getProxyConfig()
let startedAt = 0
let lastError = ''

/*
 * 日志和累计统计都从磁盘读回：关掉应用再打开，之前的请求记录还在。
 * id 从上次的最大值往后接，否则新日志会和读回的旧日志撞 id，
 * 界面按 id 就地替换时会把一条旧记录覆盖掉。
 */
const persisted = loadProxyLogs()
const stats: ProxyStats = persisted.stats
const logs: ProxyLogEntry[] = persisted.logs
let nextLogId = logs.reduce((max, entry) => Math.max(max, entry.id), 0) + 1
bindProxyLogSource(() => ({ logs, stats }))

/** 日志与状态的变化推给渲染进程，界面不用轮询 */
type Notifier = (event: 'status' | 'log', payload: unknown) => void
let notify: Notifier = () => undefined

/** /health 里报的版本号；由 index.ts 传入 app.getVersion()，这里不直接依赖 electron */
let appVersion = '0.0.0'

export function initProxyServer(notifier: Notifier, version?: string): void {
  notify = notifier
  if (version) appVersion = version
  config = getProxyConfig()
  if (config.autoStart) {
    void startProxy().catch((error) => {
      log('warn', `[Proxy] 自动启动失败：${errorMessage(error)}`)
    })
  }
}

// ============ 状态 ============

function host(): string {
  return config.allowLan ? '0.0.0.0' : '127.0.0.1'
}

export function proxyStatus(): ProxyStatus {
  return {
    running: !!server?.listening,
    port: config.port,
    baseUrl: `http://127.0.0.1:${config.port}`,
    startedAt: startedAt || undefined,
    error: lastError || undefined,
    ...stats
  }
}

function pushStatus(): void {
  notify('status', proxyStatus())
}

// ============ 日志 ============

/**
 * 这一轮客户端发来了什么类型的内容。
 *
 * 只看最后一条 user 消息：agent 客户端每次都带完整历史，
 * 把历史也算进来的话几乎每条都是「文本 + 图片 + 工具结果」，看不出这一轮在干什么。
 */
function inputTypesOf(messages: NormMessage[]): ProxyInputType[] {
  let last: NormMessage | undefined
  // 从后往前找，不必为了 reverse 复制整条历史
  for (let i = messages.length - 1; i >= 0 && !last; i--) {
    if (messages[i].role === 'user') last = messages[i]
  }
  if (!last) return []
  const types: ProxyInputType[] = []
  if (last.text.trim()) types.push('text')
  if (last.images.length) types.push('image')
  if (last.toolResults.length) types.push('toolResult')
  return types
}

/** 输出类型去重追加，顺序即首次出现的顺序 */
function markOutput(entry: ProxyLogEntry, type: ProxyOutputType): void {
  if (!entry.outputTypes.includes(type)) entry.outputTypes.push(type)
}

function newLog(
  entry: Omit<ProxyLogEntry, 'id' | 'at' | 'retries' | 'attempts' | 'outputTypes'>
): ProxyLogEntry {
  const record: ProxyLogEntry = {
    id: nextLogId++,
    at: Date.now(),
    retries: [],
    attempts: 0,
    outputTypes: [],
    ...entry
  }
  /*
   * 关掉「记录日志」时照样返回一条记录：handleChat 全程往它身上写状态，
   * 拿掉它要改一大片代码。只是不放进列表、不推给界面、不落盘。
   */
  if (!config.logRequests) {
    untracked.add(record)
    return record
  }
  logs.unshift(record)
  if (logs.length > LOG_CAPACITY) logs.length = LOG_CAPACITY
  notify('log', record)
  scheduleProxyLogFlush()
  return record
}

/**
 * 日志更新的推送节流。
 * 流式回复每几十毫秒就有新增量，逐条推会把 IPC 打满，界面也刷不动。
 */
const pendingPush = new Set<ProxyLogEntry>()
let pushTimer: NodeJS.Timeout | null = null

/** 「记录日志」关闭期间产生的记录：只在内存里给 handleChat 用，不推送、不落盘 */
const untracked = new WeakSet<ProxyLogEntry>()

function touchLog(entry: ProxyLogEntry, immediate = false): void {
  // 不拦的话，界面按 id 找不到它就会当成新日志插进列表
  if (untracked.has(entry)) return
  scheduleProxyLogFlush()
  if (immediate) {
    pendingPush.delete(entry)
    notify('log', entry)
    return
  }
  pendingPush.add(entry)
  if (pushTimer) return
  pushTimer = setTimeout(() => {
    pushTimer = null
    for (const item of pendingPush) notify('log', item)
    pendingPush.clear()
  }, 150)
}

export function proxyLogs(): ProxyLogEntry[] {
  return logs
}

export function clearProxyLogs(): void {
  logs.length = 0
  notify('log', null)
  // 用户主动清空的，立刻写盘：不然马上退出应用，重开后日志又回来了
  flushProxyLogs()
}

export function resetProxyStats(): void {
  Object.assign(stats, emptyStats())
  pushStatus()
  flushProxyLogs()
}

// ============ 按账号累计用量 ============

/*
 * 和按 Key 的用量一样先在内存里累加、1.5 秒内的变更合成一次落盘：
 * 主 store 是加密的整份文件（含全部账号），每个请求都写一次会反复做 pbkdf2 与整份重写。
 * 停止反代与退出应用时都会 flush，只有被强杀才可能丢最后 1.5 秒的统计。
 */
let usageCache: ProxyAccountUsage[] | null = null
let usageFlushTimer: NodeJS.Timeout | null = null

function usageList(): ProxyAccountUsage[] {
  return (usageCache ??= getProxyUsage())
}

function flushAccountUsage(): void {
  if (usageFlushTimer) {
    clearTimeout(usageFlushTimer)
    usageFlushTimer = null
  }
  if (usageCache) setProxyUsage(usageCache)
}

function scheduleUsageFlush(): void {
  if (usageFlushTimer) return
  usageFlushTimer = setTimeout(() => {
    usageFlushTimer = null
    flushAccountUsage()
  }, 1_500)
}

/**
 * 按账号累计。成功和失败都要记：失败次数是判断「哪个号有问题」的主要依据。
 */
function recordUsage(
  account: Pick<Account, 'id' | 'email'>,
  delta: { credits: number; failed: boolean; inputTokens: number; outputTokens: number; durationMs: number }
): void {
  const usage = usageList()
  const index = usage.findIndex((item) => item.accountId === account.id)
  const base: ProxyAccountUsage =
    index >= 0
      ? usage[index]
      : { accountId: account.id, email: account.email, requests: 0, failed: 0, credits: 0, lastUsedAt: 0 }
  const next: ProxyAccountUsage = {
    ...base,
    email: account.email,
    requests: base.requests + 1,
    failed: base.failed + (delta.failed ? 1 : 0),
    credits: base.credits + delta.credits,
    inputTokens: (base.inputTokens ?? 0) + delta.inputTokens,
    outputTokens: (base.outputTokens ?? 0) + delta.outputTokens,
    totalResponseMs: (base.totalResponseMs ?? 0) + delta.durationMs,
    lastUsedAt: Date.now()
  }
  if (index >= 0) usage[index] = next
  else usage.push(next)
  scheduleUsageFlush()
}

export function proxyUsage(): ProxyAccountUsage[] {
  return usageList()
}

export function clearProxyUsage(): void {
  usageCache = []
  flushAccountUsage()
}

// ============ 模型列表 ============

export function proxyModels(): ProxyModelCache | null {
  return getProxyModels()
}

/** 用当前选中的账号重新拉模型列表；配置里的账号设置在调用时现读 */
export async function refreshProxyModels(): Promise<ProxyModelCache> {
  config = getProxyConfig()
  const cache = await fetchProxyModels(poolOptionsFrom(config))
  log('info', `[Proxy] 已从 ${cache.accountEmail} 拉取 ${cache.models.length} 个模型`)
  return cache
}

// ============ HTTP 基础 ============

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'access-control-allow-origin': '*'
  })
  res.end(text)
}

/** 两家的错误体形状不同，客户端会按自己那套解析 */
function sendError(
  res: http.ServerResponse,
  protocol: ProxyProtocol,
  status: number,
  message: string
): void {
  if (protocol === 'anthropic') {
    sendJson(res, status, {
      type: 'error',
      error: { type: status === 401 ? 'authentication_error' : 'api_error', message }
    })
    return
  }
  if (protocol === 'gemini') {
    // Google 的错误体：{ error: { code, message, status } }，SDK 按 status 字符串判断错误类型
    const statusText =
      status === 401 ? 'UNAUTHENTICATED' : status === 429 ? 'RESOURCE_EXHAUSTED' : status === 400 ? 'INVALID_ARGUMENT' : 'INTERNAL'
    sendJson(res, status, { error: { code: status, message, status: statusText } })
    return
  }
  sendJson(res, status, {
    error: { message, type: status === 401 ? 'invalid_request_error' : 'server_error', code: null }
  })
}

function startSse(res: http.ServerResponse): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'access-control-allow-origin': '*',
    // Nginx 之类的反向代理会缓冲 SSE，本地直连虽无此问题，带上无副作用
    'x-accel-buffering': 'no'
  })
  res.flushHeaders?.()
}

/**
 * 客户端带来的密钥，各家放的位置不一样：
 *  - OpenAI 系：Authorization: Bearer
 *  - Anthropic：x-api-key
 *  - Gemini：x-goog-api-key，或者 URL 上的 ?key=（官方 REST 示例就是这么写的）
 */
function givenKey(req: http.IncomingMessage): string {
  const header = req.headers.authorization
  const bearer = typeof header === 'string' ? header.replace(/^Bearer\s+/i, '').trim() : ''
  const pick = (name: string): string => {
    const value = req.headers[name]
    return typeof value === 'string' ? value.trim() : ''
  }
  const query = new URL(req.url || '/', 'http://localhost').searchParams.get('key')?.trim() ?? ''
  return bearer || pick('x-api-key') || pick('x-goog-api-key') || query
}

/**
 * 校验密钥并找到它属于哪个 Key（默认 Key 或自定义 Key）。
 * 要求鉴权却一个 Key 都没设时一律拒绝，避免「以为开了其实全放行」。
 */
function authorize(req: http.IncomingMessage): KeyCheck {
  return checkProxyKey(givenKey(req), config.requireApiKey)
}

/** 自检入口只要「能过」就行，不关心额度 */
function authorized(req: http.IncomingMessage): boolean {
  const check = authorize(req)
  return check.ok || check.status === 429
}

/**
 * 管理 API 一律要一个对得上的 Key，不看「强制校验」开关。
 * 它会列出账号邮箱和请求日志，关掉校验只该放开对话接口，不该把这些也敞开。
 */
function adminAuthorized(req: http.IncomingMessage): boolean {
  const check = checkProxyKey(givenKey(req), true)
  return check.ok || check.status === 429
}

// ============ 请求处理 ============

/**
 * Codex 请求 /v1/models?client_version=… 时要的是它自己的「模型目录」格式
 * （{ models: [{ slug, base_instructions, ... }] }），不是 OpenAI 的模型列表。
 *
 * 目录每次按「当前缓存的模型列表」现拼：刷新模型后 Codex 重启即可看到新模型，
 * 不用重新点「一键写入」。模板（系统提示等）来自写入时从本机 Codex 取的那一条；
 * 没写入过 Codex 就没有模板，返回 null 退回普通列表。
 */
async function codexCatalog(): Promise<unknown | null> {
  const template = await readCodexTemplate()
  if (!template) return null
  return buildCodexCatalog(template, currentModels(), {
    model: config.defaultModel,
    effort: config.defaultEffort
  })
}

/**
 * 用账号池跑一次 Kiro MCP 搜索，失败就换下一个账号。
 *
 * 和对话请求共用同一批账号，但**不**共用重试预算：搜索是对话中的一个子步骤，
 * 它失败不该把用户配的 maxRetries 吃掉。最多试 5 个账号，池子里有几百个号时
 * 不至于一个个全试一遍。
 */
async function searchWithPool(query: string): Promise<WebSearchResult[]> {
  const members = poolMembers(poolOptionsFrom(config))
  if (!members.length) throw new Error('没有可用账号')

  let lastError: Error = new Error('没有可用账号')
  for (const member of members.slice(0, 5)) {
    try {
      if (member.kind === 'apiKey') {
        // API Key 走同一个 MCP 端点，按 Key 自己的区域、声明 tokentype
        return await kiroWebSearch(query, {
          accessToken: member.key.key,
          region: member.key.region,
          apiKey: true
        })
      }
      const ready = await ensureProxyToken(member.account)
      return await kiroWebSearch(query, {
        accessToken: ready.credentials.accessToken,
        profileArn: ready.profileArn || ready.credentials.profileArn,
        region: ready.credentials.region
      })
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
      log('warn', `[WebSearch] ${member.email} 搜索失败：${lastError.message}`)
    }
  }
  throw lastError
}

/** 拉一次上游 ListAvailableModels 的原始响应，只用于自检 */
async function rawKiroModels(): Promise<unknown> {
  const [first] = poolMembers(poolOptionsFrom(config))
  if (!first) throw new Error('没有可用账号')
  if (first.kind === 'apiKey') return listRawApiKeyModels(first.key.key, first.key.region)
  const ready = await ensureProxyToken(first.account)
  return listRawKiroModels({
    accessToken: ready.credentials.accessToken,
    profileArn: ready.profileArn || ready.credentials.profileArn,
    region: ready.credentials.region,
    idp: ready.idp
  })
}

/** 当前可用的模型：优先用从账号拉回的列表，没拉过时用兜底表 */
function currentModels(): KiroModelInfo[] {
  return (
    getProxyModels()?.models ?? FALLBACK_MODEL_IDS.map((modelId) => ({ modelId }))
  )
}

/**
 * 模型系列，给按系列分组显示的客户端用。规则与 Kiro-account-manager 一致：
 * 认得的几个大系列直接归类，其余取 id 的前两段（deepseek-3.2 → deepseek-3）。
 */
function modelFamily(id: string): string {
  const lower = id.toLowerCase()
  if (lower === 'auto') return 'auto'
  if (lower.includes('opus')) return 'claude-opus'
  if (lower.includes('sonnet')) return 'claude-sonnet'
  if (lower.includes('haiku')) return 'claude-haiku'
  if (lower.includes('glm')) return 'glm'
  return lower.split(/[.-]/).slice(0, 2).join('-') || lower
}

/**
 * 一个模型在 /v1/models 里的完整条目。
 *
 * 为什么要这么多字段：OpenAI 标准只规定了 id / object / created / owned_by，
 * 但各客户端会从别的字段里读上限和能力——
 *  - context_length / max_tokens：OpenRouter 风格，Cherry Studio、LobeChat 读这两个；
 *  - max_input_tokens / max_output_tokens：LiteLLM 风格；
 *  - limit / modalities / reasoning / tool_call / attachment / cost / interleaved：
 *    models.dev 那套，OpenCode 靠它决定上下文窗口、能不能传图、推理内容走哪个字段；
 *  - capabilities：少数客户端读的嵌套版本。
 * 缺了这些，客户端只能按默认值（常见是 4K / 8K）来裁剪上下文，1M 的模型也被当成小模型用。
 *
 * 字段全部来自上游 ListAvailableModels，不写死；取不到的才用兜底值。
 * 和参考实现有两处刻意不同：
 *  - created 用秒。参考给的是毫秒（1790732462123），OpenAI 规范是 Unix 秒；
 *  - reasoning 按「该模型有没有推理档位」判断。参考只认 Claude 那种 thinking 字段，
 *    于是 gpt-5.6 明明有六个档位却标成 reasoning: false，客户端就不会给它开推理。
 */
function modelEntry(model: KiroModelInfo, created: number): Record<string, unknown> {
  const id = model.modelId
  const name = model.modelName || id
  const context = model.maxInputTokens ?? 200_000
  const output = model.maxOutputTokens ?? 64_000
  /*
   * 没有这个字段 ≠ 只支持文本：旧版本缓存的模型列表里压根没存它。
   * Kiro 的对话模型全都收图片，缺省按「文本 + 图片」给，
   * 否则升级后没点「刷新模型」的用户，客户端会以为所有模型都不能传图。
   */
  const inputTypes = model.inputTypes?.length ? model.inputTypes : ['TEXT', 'IMAGE']
  const image = inputTypes.includes('IMAGE')
  const efforts = model.effort?.options ?? []
  const reasoning = efforts.length > 0
  const inputModalities = ['text', ...(image ? ['image'] : [])]

  return {
    id,
    object: 'model',
    created,
    owned_by: 'kiro',
    name,
    display_name: name,
    model_name: name,
    description: model.description ?? '',
    family: modelFamily(id),
    // 上游不给发布日期；models.dev 的 schema 里有这个键（OpenCode 按它排序），留空而不是省略
    release_date: '',

    // 上限：几种风格各给一份，值相同
    context_length: context,
    max_tokens: output,
    max_input_tokens: context,
    max_output_tokens: output,
    limit: { context, input: context, output },

    // 能力（models.dev 风格）
    attachment: image,
    reasoning,
    temperature: true,
    tool_call: true,
    // 推理内容放在哪个字段里回给客户端：我们的 OpenAI 流式用 reasoning_content
    interleaved: reasoning ? { field: 'reasoning_content' } : false,
    modalities: { input: inputModalities, output: ['text'] },
    capabilities: {
      temperature: true,
      reasoning,
      attachment: image,
      toolcall: true,
      input: { text: true, audio: false, image, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      // 和顶层 interleaved 同一个值：推理模型给 { field }，告诉客户端推理内容在哪个字段
      interleaved: reasoning ? { field: 'reasoning_content' } : false
    },
    // 走的是账号的积分，不按 token 计价；给 0 而不是省略，免得客户端显示「未知价格」
    cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },

    // Kiro 自己的字段
    inputTypes,
    rateMultiplier: model.rate ?? null,
    rateUnit: model.rateUnit ?? 'Credit',
    supportsThinking: reasoning,
    supportsPromptCaching: model.promptCaching ?? false,
    ...(reasoning
      ? {
          thinkingEfforts: efforts,
          defaultThinkingEffort: model.effort?.default ?? null,
          // 档位在 additionalModelRequestFields 里的位置：Claude 系 output_config，GPT 系 reasoning
          thinkingSchemaPath: model.effort?.path[0] ?? null
        }
      : {}),

    // OpenAI 旧版字段，个别 SDK 反序列化时要求存在
    permission: [],
    root: id,
    parent: null
  }
}

/**
 * OpenAI 风格的模型列表。
 *
 * 不额外列出 kiro- 前缀的别名：它绕不过 Cursor 免费版的模型检查（门禁看的是套餐，
 * 不是模型名，Cursor 走 CCursor），只会让列表里每个模型出现两次。
 * mapProxyModel 仍然认这个前缀，兼容已经写进客户端配置的旧模型名。
 */
function modelList(): unknown {
  const created = Math.floor(Date.now() / 1000)
  return { object: 'list', data: currentModels().map((model) => modelEntry(model, created)) }
}

/** Gemini 的模型列表：name 要带 models/ 前缀，SDK 按它去拼 generateContent 的路径 */
function geminiModelList(): unknown {
  return {
    // auto 也列出来：Gemini 客户端点 models/auto 时照样能用（交给 Kiro 选），和参考一致
    models: currentModels().map((model) => ({
      name: `models/${model.modelId}`,
      baseModelId: model.modelId,
      // Google 的 Model 资源必有这个字段；上游没有版本概念，和参考一样固定给 001
      version: '001',
      displayName: model.modelName || model.modelId,
      description: model.description ?? '',
      inputTokenLimit: model.maxInputTokens ?? 200_000,
      outputTokenLimit: model.maxOutputTokens ?? 64_000,
      supportedGenerationMethods: ['generateContent', 'streamGenerateContent']
    }))
  }
}

/** 当前账号池：/health 与 /admin/accounts 共用 */
function poolIds(): Set<string> {
  return new Set(
    poolMembers(poolOptionsFrom(config)).map((member) => member.id)
  )
}

/** 服务已运行的毫秒数；没在跑时为 0 */
function uptimeMs(): number {
  return server?.listening && startedAt ? Date.now() - startedAt : 0
}

/**
 * 健康检查。
 * 前半截是 Kiro-account-manager 的字段（status / version / accounts / availableAccounts / stats），
 * 照它的形状给，拿它写的监控脚本、面板能直接复用；running 是我们自己的字段。
 */
function healthPayload(): Record<string, unknown> {
  return {
    status: 'ok',
    version: appVersion,
    running: true,
    // accounts 是账号总数、availableAccounts 是此刻会被选中的——和参考一致，
    // 一个号失效时两个数一对比就能看出来
    accounts: getAccountData().accounts.length,
    availableAccounts: poolIds().size,
    stats: {
      totalRequests: stats.requests,
      successRequests: stats.succeeded,
      failedRequests: stats.failed,
      totalTokens: stats.inputTokens + stats.outputTokens,
      uptime: uptimeMs()
    }
  }
}

/**
 * 一条请求日志换成参考实现 recentRequests 的形状。
 * 它的 model 是客户端请求里写的名字；我们另外带上实际发给 Kiro 的 kiroModel。
 */
function recentRequest(entry: ProxyLogEntry): Record<string, unknown> {
  return {
    timestamp: entry.at,
    path: entry.path,
    model: entry.model,
    kiroModel: entry.kiroModel,
    accountId: entry.accountId ?? 'unknown',
    inputTokens: entry.inputTokens ?? 0,
    outputTokens: entry.outputTokens ?? 0,
    ...(entry.credits != null ? { credits: entry.credits } : {}),
    responseTime: entry.durationMs ?? 0,
    success: entry.state === 'success',
    ...(entry.error ? { error: entry.error } : {})
  }
}

/**
 * 最近 n 条请求，按时间正序（旧的在前）——参考实现是这个顺序，
 * 按它写的解析脚本通常直接取最后一条当「最新」。
 * 只收已经结束的：还在输出中的请求 token 和耗时都还没定，给出去是半截数据。
 */
function recentRequests(n: number): Record<string, unknown>[] {
  return logs
    .filter((entry) => entry.state === 'success' || entry.state === 'error')
    .slice(0, n)
    .reverse()
    .map(recentRequest)
}

/**
 * 管理 API。返回 undefined 表示没有这个接口。
 *
 * 字段分两部分：参考实现有的一个不少（驼峰那套），我们原有的也保留（同一份数据的另一种写法），
 * 这样按任一边写的脚本都能用。
 *
 * 账号列表只给能公开的字段。凭证（token、密码）一个都不出——
 * 这个接口能被任何持有反代 Key 的客户端调用，Key 是可以分给别人的。
 * expiresAt 是凭证的过期时间戳，不是凭证本身，参考实现也给，保留。
 */
function adminRoute(path: string, url: URL): unknown {
  if (path === '/admin/stats') {
    const all = usageList()
    /*
     * accountStats：按账号 id 的字典，和参考的 AccountStats 同形状。
     * 区别是我们的数据是持久化的累计值，参考的只算本次启动以来——重启后不会清零。
     */
    const accountStats: Record<string, unknown> = {}
    for (const item of all) {
      const input = item.inputTokens ?? 0
      const output = item.outputTokens ?? 0
      const totalMs = item.totalResponseMs ?? 0
      accountStats[item.accountId] = {
        email: item.email,
        requests: item.requests,
        tokens: input + output,
        inputTokens: input,
        outputTokens: output,
        errors: item.failed,
        credits: item.credits,
        lastUsed: item.lastUsedAt,
        avgResponseTime: item.requests ? Math.round(totalMs / item.requests) : 0,
        totalResponseTime: totalMs
      }
    }
    return {
      // ---- 参考实现的字段 ----
      totalRequests: stats.requests,
      successRequests: stats.succeeded,
      failedRequests: stats.failed,
      totalTokens: stats.inputTokens + stats.outputTokens,
      inputTokens: stats.inputTokens,
      outputTokens: stats.outputTokens,
      uptime: uptimeMs(),
      startTime: startedAt || null,
      accountStats,
      recentRequests: recentRequests(50),
      // ---- 我们原有的 ----
      running: !!server?.listening,
      credits: stats.credits,
      successRate: stats.requests ? stats.succeeded / stats.requests : 0
    }
  }

  if (path === '/admin/accounts') {
    const pool = poolIds()
    const usage = new Map(usageList().map((item) => [item.accountId, item]))
    const accounts = getAccountData().accounts.map((account) => {
      const used = usage.get(account.id)
      return {
        id: account.id,
        email: account.email,
        // 参考的 isAvailable = 此刻能不能被反代选中；我们按账号池（状态、封禁、所选范围）判断
        isAvailable: pool.has(account.id),
        lastUsed: used?.lastUsedAt ?? 0,
        requestCount: used?.requests ?? 0,
        errorCount: used?.failed ?? 0,
        expiresAt: account.credentials?.expiresAt ?? null,
        authMethod: account.idp,
        nickname: account.nickname,
        status: account.status,
        subscription: account.subscription?.title || account.subscription?.type,
        usage: { current: account.usage?.current, limit: account.usage?.limit },
        credits: used?.credits ?? 0
      }
    })
    return {
      total: accounts.length,
      available: accounts.filter((a) => a.isAvailable).length,
      mode: config.accountMode,
      accounts
    }
  }

  if (path === '/admin/logs') {
    // ?limit= 默认 100（参考的条数），最多给到内存里全部
    const limit = Math.max(1, Math.min(LOG_CAPACITY, Number(url.searchParams.get('limit')) || 100))
    return {
      // 参考实现的形状：精简字段、时间正序
      recentRequests: recentRequests(limit),
      // 我们的完整日志：新的在前，带协议、档位、重试过程等
      total: logs.length,
      logs: logs.slice(0, limit)
    }
  }

  return undefined
}

interface HandleContext {
  protocol: ProxyProtocol
  path: string
  request: NormalizedRequest
  res: http.ServerResponse
  signal: AbortSignal
  /** 这次请求用的是哪个 Key；关掉校验且没带 Key 时为空，不计入任何 Key */
  keyId?: string
  keyName?: string
  keyValue?: string
}

/** 配置里的 KB 换成字节；存了越界值（手改配置文件）也夹回可用范围 */
function payloadLimitBytes(): number {
  const kb = Number(config.payloadLimitKB) || DEFAULT_PROXY_CONFIG.payloadLimitKB
  return Math.min(PAYLOAD_LIMIT_MAX_KB, Math.max(PAYLOAD_LIMIT_MIN_KB, kb)) * 1024
}

/**
 * 流式事件计数。开「流式日志」时每个请求结束写一行摘要，
 * 而不是逐个事件写：一次长回答有上千个文本增量，逐条写会把日志文件刷爆。
 */
interface StreamEventCounts {
  text: number
  thinking: number
  toolCalls: number
  searchCalls: number
}

/** 搜索结果换成 Anthropic 的 web_search_result；官方的 page_age 形如「September 25, 2026」 */
function toServerSearchBlock(query: string, results: WebSearchResult[]): ServerSearchBlock {
  return {
    id: `srvtoolu_${randomUUID().replace(/-/g, '')}`,
    query,
    results: results.map((r) => ({
      type: 'web_search_result' as const,
      title: r.title,
      url: r.url,
      encrypted_content: r.snippet ?? '',
      page_age: r.publishedDate
        ? new Date(r.publishedDate).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
        : null
    }))
  }
}

/**
 * Claude Code 的 WebSearch 子请求：不问模型，直接搜，按官方服务端工具的格式回。
 *
 * 为什么不交给模型：这个请求只有一个目的——执行这次搜索。让模型再决定一遍「要不要搜、搜什么」
 * 既多花一次积分、多等几秒，还可能改写搜索词或干脆不搜。官方 API 的回复本身也就是
 * 「一句要搜什么 → server_tool_use → web_search_tool_result → 结果摘要」，这里照着拼。
 * 摘要是给 Claude Code 主对话里的模型看的，结果块是给它计数和列来源用的，两样都要。
 * 这里只消耗 Kiro 的 MCP 搜索，不走对话接口，所以不计积分。
 */
async function handleServerSearch(ctx: HandleContext, query: string): Promise<void> {
  const { request, res } = ctx
  const startedAtMs = Date.now()
  const replyModel = request.model || config.defaultModel
  const entry = newLog({
    protocol: 'anthropic',
    path: ctx.path,
    stream: request.stream,
    model: request.model || '(未指定)',
    kiroModel: 'web_search',
    keyName: ctx.keyName,
    keyValue: ctx.keyValue,
    inputTypes: ['text'],
    state: 'pending'
  })
  stats.requests++
  pushStatus()

  let block: ServerSearchBlock
  let summary: string
  try {
    const results = await searchWithPool(query)
    block = toServerSearchBlock(query, results)
    summary = formatSearchResults(query, results)
  } catch (error) {
    // 搜失败也按正常回复给：结果块为空、摘要里写明原因，主对话的模型能看到并自己决定怎么办
    log('warn', `[WebSearch] "${query}" 失败：${errorMessage(error)}`)
    block = toServerSearchBlock(query, [])
    summary = `Web search failed: ${errorMessage(error)}`
  }
  const lead = `I'll search for "${query}".`
  const usage = {
    inputTokens: estimateTokens(query),
    outputTokens: estimateTokens(lead + summary),
    webSearchRequests: 1
  }

  if (request.stream) {
    const writer = new AnthropicSseWriter(res, replyModel)
    startSse(res)
    writer.start(usage.inputTokens)
    writer.text(lead)
    writer.serverSearch(block)
    writer.text(summary)
    writer.finish('end_turn', usage)
    res.end()
  } else {
    sendJson(res, 200, {
      id: `msg_${randomUUID().replace(/-/g, '')}`,
      type: 'message',
      role: 'assistant',
      model: replyModel,
      content: [
        { type: 'text', text: lead },
        { type: 'server_tool_use', id: block.id, name: 'web_search', input: { query } },
        { type: 'web_search_tool_result', tool_use_id: block.id, content: block.results },
        { type: 'text', text: summary }
      ],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: {
        input_tokens: usage.inputTokens,
        output_tokens: usage.outputTokens,
        server_tool_use: { web_search_requests: 1 }
      }
    })
  }

  if (ctx.keyId) {
    recordKeyUsage(ctx.keyId, {
      at: Date.now(),
      model: 'web_search',
      protocol: 'anthropic',
      ok: true,
      credits: 0,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      durationMs: Date.now() - startedAtMs
    })
  }
  stats.succeeded++
  entry.state = 'success'
  entry.httpStatus = 200
  entry.attempts = 1
  entry.webSearches = 1
  entry.credits = 0
  entry.inputTokens = usage.inputTokens
  entry.outputTokens = usage.outputTokens
  entry.outputTypes = ['webSearch', 'text']
  entry.durationMs = Date.now() - startedAtMs
  touchLog(entry, true)
  pushStatus()
  if (config.logRequests) {
    log('info', `[WebSearch] Claude Code 搜索「${query}」→ ${block.results.length} 条，${entry.durationMs}ms`)
  }
}

async function handleChat(ctx: HandleContext): Promise<void> {
  const { request, res, protocol } = ctx
  if (protocol === 'anthropic' && request.serverSearchQuery && !config.disableTools) {
    return handleServerSearch(ctx, request.serverSearchQuery)
  }
  const known = cachedModelIds()
  const mapped = mapProxyModel(
    config.modelMode === 'force' ? config.defaultModel : request.model,
    config.defaultModel,
    known.length ? known : undefined
  )

  // 推理档位：按目标模型自己的 schema 取值，模型没有这一层就不带
  const modelInfo = getProxyModels()?.models.find((m) => m.modelId === mapped.modelId)
  const effort = resolveEffort({
    modelId: mapped.modelId,
    schema: modelInfo?.effort,
    requested: request.effort,
    budget: request.thinkingBudget,
    configured: config.defaultEffort,
    isDefaultModel: mapped.modelId === config.defaultModel
  })
  const requestFields = buildModelRequestFields(modelInfo?.effort, effort)

  /*
   * 主动给模型挂一个联网搜索工具，不等客户端来要。
   *
   * 为什么不依赖客户端声明：Codex 的 web_search 是「托管工具」，它只在自己认定
   * provider 支持时才挂上来，而这个判定藏在模型目录的一堆字段里（tool_mode、
   * supports_search_tool、web_search_tool_type…），跨版本还会变。实测即使
   * web_search = "live" + supports_standalone_web_search = true，
   * Codex 依然可能一个 web_search 都不发，模型于是说「没有可用的搜索工具」，
   * 或者退化成自己用 curl 去抓网页。
   *
   * 由反代注入，这条链路就完全不受客户端脾气影响：
   * 工具对 Kiro 的模型可见 → 模型调用 → 反代拦下来打 Kiro 的 MCP 搜索 → 结果回灌。
   * 客户端从头到尾看不到这个工具，也就不会收到它无法执行的调用。
   */
  if (config.disableTools) {
    /*
     * 禁用工具调用：连客户端自己声明的工具一起去掉，模型只能纯文本作答。
     * 历史里已经发生过的工具轮次会被 buildKiroPayload 压成文本叙述，
     * 不会留下没有配对的 toolUse（那会让 Kiro 直接 400）。
     */
    request.tools = []
    request.webSearch = undefined
  } else if (config.managedToolExecution) {
    /*
     * 客户端自己带了搜索工具（Claude Code 的 WebSearch）就不注入：它的 WebSearch 走上面的子请求，
     * 已经能真搜。再多挂一个 web_search，模型面前就有两个搜索工具，
     * 实测会先用 WebSearch、再换 web_search 把同样的词搜一遍，白花一轮。
     */
    // 名字以 websearch / web_search 结尾的都算（VS Code 扩展的工具名形如 xxx_webSearch）
    const clientSearch = request.tools.some(
      (tool) => tool.name !== WEB_SEARCH_TOOL && /(^|[_\-.])web_?search$/i.test(tool.name)
    )
    if (!clientSearch && !request.tools.some((tool) => tool.name === WEB_SEARCH_TOOL)) {
      request.tools.push(webSearchToolSpec())
    }
    request.webSearch = { maxUses: MAX_WEB_SEARCH_ROUNDS }
  } else {
    // 纯客户端执行：反代不注入、不拦截任何工具，模型发出的调用原样交给客户端
    request.webSearch = undefined
  }

  const payloadLimit = payloadLimitBytes()
  const { payload, toolNameMap, estimatedInputTokens } = buildKiroPayload(
    request,
    mapped.modelId,
    undefined,
    requestFields,
    payloadLimit
  )

  const entry = newLog({
    protocol,
    path: ctx.path,
    stream: request.stream,
    model: request.model || '(未指定)',
    kiroModel: mapped.modelId,
    effort,
    keyName: ctx.keyName,
    keyValue: ctx.keyValue,
    inputTypes: inputTypesOf(request.messages),
    state: 'pending'
  })

  /** 记到 Key 名下；成功失败都记，失败的积分和输出自然是 0 */
  const recordKey = (ok: boolean, credits: number): void => {
    if (!ctx.keyId) return
    recordKeyUsage(ctx.keyId, {
      at: Date.now(),
      model: mapped.modelId,
      protocol,
      ok,
      credits,
      inputTokens: ok ? collected.usage.inputTokens : 0,
      outputTokens: ok ? collected.usage.outputTokens : 0,
      durationMs: Date.now() - startedAtMs
    })
  }
  stats.requests++
  pushStatus()

  const collected: CollectedResult = {
    text: '',
    thinking: '',
    toolCalls: [],
    stopReason: 'end_turn',
    usage: { inputTokens: estimatedInputTokens, outputTokens: 0 }
  }
  const events: StreamEventCounts = { text: 0, thinking: 0, toolCalls: 0, searchCalls: 0 }
  const logStreamSummary = (ok: boolean): void => {
    if (!config.logStreamEvents) return
    log(
      'info',
      `[Proxy/Stream] ${ctx.path} ${mapped.modelId} ${ok ? '完成' : '失败'} ` +
        `文本块 ${events.text} · 推理块 ${events.thinking} · 工具调用 ${events.toolCalls} · ` +
        `托管搜索 ${events.searchCalls} · 首字 ${entry.firstTokenMs ?? '-'}ms · ` +
        `请求体 ${Math.round(Buffer.byteLength(JSON.stringify(payload)) / 1024)}KB`
    )
  }

  const replyModel = request.model || mapped.modelId
  const writer = request.stream
    ? protocol === 'anthropic'
      ? new AnthropicSseWriter(res, replyModel)
      : protocol === 'responses'
        ? new ResponsesSseWriter(res, replyModel, request.toolOrigins)
        : protocol === 'gemini'
          ? new GeminiSseWriter(res, replyModel)
          : new OpenAiSseWriter(res, replyModel)
    : null

  let firstTokenAt = 0
  const startedAtMs = Date.now()

  const onFirstToken = (): void => {
    if (firstTokenAt) return
    firstTokenAt = Date.now()
    entry.firstTokenMs = firstTokenAt - startedAtMs
    entry.state = 'streaming'
  }

  /** 流式时先写 SSE 头再发首块；非流式只收集 */
  const ensureStreamStarted = (): void => {
    if (!writer || writer.flushed) return
    startSse(res)
    if (writer instanceof AnthropicSseWriter) writer.start(estimatedInputTokens)
    else writer.start()
  }

  /*
   * 托管联网搜索的中间轮次：模型这一轮只想搜索时，把 toolUse 拦下来自己搜，
   * 结果塞回历史再问一次，直到它给出正文。这些轮次对客户端完全透明。
   */
  const searchCalls: StreamToolCall[] = []
  const isManagedSearch = (name: string): boolean =>
    !!request.webSearch && name === WEB_SEARCH_TOOL
  let searchRounds = 0
  let searchesDone = 0

  try {
    let result = await callUpstream(
      {
        payload,
        modelId: mapped.modelId,
        toolNameMap,
        endpoint: config.endpoint,
        pool: poolOptionsFrom(config),
        retryEnabled: config.retryEnabled,
        maxRetries: config.maxRetries,
        retryDelayMs: config.retryDelayMs,
        signal: ctx.signal,
        canRetry: () => !writer?.flushed,
        onAttempt: (account, attempt) => {
          entry.accountId = account.id
          entry.accountEmail = account.email
          entry.attempts = attempt
          touchLog(entry, true)
        }
      },
      {
        onText: (delta) => {
          onFirstToken()
          collected.text += delta
          events.text++
          markOutput(entry, 'text')
          ensureStreamStarted()
          writer?.text(delta)
          touchLog(entry)
        },
        onThinking: (delta) => {
          onFirstToken()
          collected.thinking += delta
          events.thinking++
          markOutput(entry, 'thinking')
          ensureStreamStarted()
          // 客户端没要求推理时不转发思考内容，免得混进正文
          if (request.thinking) writer?.thinking(delta)
          touchLog(entry)
        },
        onToolCall: (call: StreamToolCall) => {
          onFirstToken()
          /*
           * 搜索工具不能转发给客户端：Codex 把 web_search 当服务端工具，
           * 收到一个它无法执行的调用会直接卡住。先攒起来，本轮结束后我们自己搜。
           */
          if (isManagedSearch(call.name)) {
            events.searchCalls++
            searchCalls.push(call)
            touchLog(entry)
            return
          }
          collected.toolCalls.push(call)
          events.toolCalls++
          markOutput(entry, 'toolUse')
          ensureStreamStarted()
          writer?.toolCall(call)
          touchLog(entry)
        }
      }
    )

    /*
     * 搜索循环：只有「这一轮除了搜索没干别的」才继续。
     * 混着客户端工具时不能循环——那些调用已经发给客户端了，
     * 必须让它先去执行，否则会话状态就乱了。
     */
    while (
      searchCalls.length &&
      collected.toolCalls.length === 0 &&
      searchRounds < (request.webSearch?.maxUses ?? 0)
    ) {
      const round = searchCalls.splice(0, searchCalls.length)
      searchRounds++

      const toolUses: NormToolUse[] = []
      const toolResults: NormToolResult[] = []
      for (const call of round) {
        const raw = call.input?.query
        const query = typeof raw === 'string' ? raw : ''
        toolUses.push({ toolUseId: call.toolUseId, name: WEB_SEARCH_TOOL, input: call.input })
        let text: string
        let ok = true
        try {
          const results = await searchWithPool(query)
          searchesDone++
          text = formatSearchResults(query, results)
          /*
           * 客户端能认出原生搜索项的，把这次搜索按它的格式补上（其余客户端照旧只看到最终回答）：
           *  - Anthropic 且声明了服务端搜索（Claude 桌面版）：server_tool_use + web_search_tool_result，显示来源
           *  - Responses（Codex）：web_search_call，显示「Searched: …」
           */
          if (protocol === 'anthropic' && request.serverSearch) {
            const block = toServerSearchBlock(query, results)
            if (writer instanceof AnthropicSseWriter) {
              ensureStreamStarted()
              writer.serverSearch(block)
            } else {
              ;(collected.searchBlocks ??= []).push(block)
            }
          } else if (writer instanceof ResponsesSseWriter) {
            ensureStreamStarted()
            writer.webSearchCall(query)
          }
        } catch (error) {
          // 搜失败就把失败原因作为工具结果交回模型，让它自己决定怎么办，
          // 而不是整个请求报错——用户要的是回答，不是一个 502
          ok = false
          text = `Web search failed: ${errorMessage(error)}`
          log('warn', `[Proxy] 联网搜索失败：${errorMessage(error)}`)
        }
        toolResults.push({
          toolUseId: call.toolUseId,
          content: [{ text }],
          status: ok ? 'success' : 'error'
        })
      }

      // 把这一轮补进历史，再让模型接着说
      request.messages.push({
        role: 'assistant',
        text: collected.text,
        images: [],
        toolUses,
        toolResults: []
      })
      request.messages.push({ role: 'user', text: '', images: [], toolUses: [], toolResults })

      const next = buildKiroPayload(request, mapped.modelId, undefined, requestFields, payloadLimit)
      result = await callUpstream(
        {
          payload: next.payload,
          modelId: mapped.modelId,
          toolNameMap: next.toolNameMap,
          endpoint: config.endpoint,
          pool: poolOptionsFrom(config),
          retryEnabled: config.retryEnabled,
          maxRetries: config.maxRetries,
          retryDelayMs: config.retryDelayMs,
          signal: ctx.signal,
          // 已经往客户端写过内容就不能重发整轮，会出现两段拼接的回复
          canRetry: () => !writer?.flushed,
          onAttempt: (account, attempt) => {
            entry.accountId = account.id
            entry.accountEmail = account.email
            entry.attempts = attempt
            touchLog(entry, true)
          }
        },
        {
          onText: (delta) => {
            onFirstToken()
            collected.text += delta
            events.text++
            markOutput(entry, 'text')
            ensureStreamStarted()
            writer?.text(delta)
            touchLog(entry)
          },
          onThinking: (delta) => {
            onFirstToken()
            collected.thinking += delta
            events.thinking++
            markOutput(entry, 'thinking')
            ensureStreamStarted()
            if (request.thinking) writer?.thinking(delta)
            touchLog(entry)
          },
          onToolCall: (call: StreamToolCall) => {
            onFirstToken()
            if (isManagedSearch(call.name)) {
              events.searchCalls++
              searchCalls.push(call)
              touchLog(entry)
              return
            }
            collected.toolCalls.push(call)
            events.toolCalls++
            markOutput(entry, 'toolUse')
            ensureStreamStarted()
            writer?.toolCall(call)
            touchLog(entry)
          }
        }
      )
    }

    if (searchesDone) {
      entry.webSearches = searchesDone
      markOutput(entry, 'webSearch')
      log('info', `[Proxy] 本次请求执行了 ${searchesDone} 次联网搜索（${searchRounds} 轮）`)
    }

    collected.stopReason = normalizeStopReason(result.stopReason, collected.toolCalls.length > 0)
    collected.usage.inputTokens = result.inputTokens || estimatedInputTokens
    collected.usage.outputTokens =
      estimateTokens(collected.text) +
      estimateTokens(collected.thinking) +
      collected.toolCalls.reduce((sum, call) => sum + estimateTokens(JSON.stringify(call.input)), 0)

    if (writer) {
      ensureStreamStarted()
      if (writer instanceof AnthropicSseWriter && request.serverSearch) {
        writer.finish(collected.stopReason, { ...collected.usage, webSearchRequests: searchesDone })
      } else {
        writer.finish(collected.stopReason, collected.usage)
      }
      res.end()
    } else {
      sendJson(
        res,
        200,
        protocol === 'anthropic'
          ? buildAnthropicResponse(replyModel, collected)
          : protocol === 'responses'
            ? buildResponsesResponse(replyModel, collected, request.toolOrigins)
            : protocol === 'gemini'
              ? buildGeminiResponse(replyModel, collected)
              : buildOpenAiResponse(replyModel, collected)
      )
    }

    stats.succeeded++
    stats.credits += result.credits
    stats.inputTokens += collected.usage.inputTokens
    stats.outputTokens += collected.usage.outputTokens
    recordUsage(result.account, {
      credits: result.credits,
      failed: false,
      inputTokens: collected.usage.inputTokens,
      outputTokens: collected.usage.outputTokens,
      durationMs: Date.now() - startedAtMs
    })
    recordKey(true, result.credits)

    entry.state = 'success'
    entry.httpStatus = 200
    entry.attempts = result.attempts
    entry.retries = result.retries
    entry.credits = result.credits
    entry.inputTokens = collected.usage.inputTokens
    entry.outputTokens = collected.usage.outputTokens
    entry.toolCalls = result.toolCalls
    entry.durationMs = Date.now() - startedAtMs
    touchLog(entry, true)
    pushStatus()
    if (config.logRequests) {
      log(
        'info',
        `[Proxy] ${ctx.path} ${mapped.modelId}${effort ? ` · ${effort}` : ''} ${result.account.email} ` +
          `${entry.durationMs}ms 积分 ${result.credits.toFixed(4)}`
      )
    }
    logStreamSummary(true)
  } catch (error) {
    const status = error instanceof UpstreamError ? (error.status ?? 500) : 500
    const message = errorMessage(error)

    stats.failed++
    // 客户端自己断开（499）不算这个 Key 的失败请求
    if (status !== 499) recordKey(false, 0)
    // 真打到过某个账号才记到它名下；没选出账号就失败的（比如没有可用账号）不归任何人
    if (status !== 499 && entry.accountId && entry.accountEmail) {
      recordUsage(
        { id: entry.accountId, email: entry.accountEmail },
        { credits: 0, failed: true, inputTokens: 0, outputTokens: 0, durationMs: Date.now() - startedAtMs }
      )
    }
    entry.state = 'error'
    entry.error = message
    entry.httpStatus = status
    entry.durationMs = Date.now() - startedAtMs
    // 失败告警不受「记录日志」开关控制：出了问题总得有地方能查
    if (error instanceof UpstreamError && error.status !== 499) {
      log('warn', `[Proxy] ${ctx.path} 失败：${message}`)
    }
    touchLog(entry, true)
    pushStatus()
    logStreamSummary(false)

    // 已经开始写 SSE：只能在流里补一个 error 事件，HTTP 状态码改不了了
    if (writer?.flushed) {
      if (writer instanceof ResponsesSseWriter) writer.error(message, status)
      else writer.error(message)
      res.end()
      return
    }
    /*
     * Responses 流式请求还没写出任何内容就失败了：同样走 SSE 发 response.failed，
     * 而不是回 HTTP 错误码。Codex 碰到 5xx 会静默重连 5 次，用户只看到
     * 「Reconnecting... 1/5」而看不到真实原因；response.failed 会把原文直接显示出来。
     */
    if (writer instanceof ResponsesSseWriter && !res.headersSent) {
      startSse(res)
      writer.start()
      writer.error(message, status)
      res.end()
      return
    }
    if (!res.headersSent) sendError(res, protocol, status === 499 ? 499 : status, message)
    else res.end()
  }
}

/** count_tokens：本地估算，不打上游 */
function handleCountTokens(res: http.ServerResponse, request: NormalizedRequest): void {
  const total =
    estimateTokens(request.system) +
    request.messages.reduce((sum, message) => sum + estimateTokens(message.text), 0) +
    request.tools.reduce((sum, tool) => sum + estimateTokens(tool.name + tool.description), 0)
  sendJson(res, 200, { input_tokens: Math.max(1, total) })
}

const listener: http.RequestListener = (req, res) => {
  const url = new URL(req.url || '/', 'http://localhost')
  const path = url.pathname.replace(/\/+$/, '') || '/'

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-headers': '*'
    })
    res.end()
    return
  }

  // 客户端断开时取消上游请求，不白烧额度
  const controller = new AbortController()
  res.on('close', () => {
    if (!res.writableEnded) controller.abort()
  })

  // /anthropic/v1/messages：有些工具把 Anthropic 的 base URL 写成 host/anthropic，这里一并接住
  const isAnthropic = /^(\/anthropic)?(\/v1)?\/messages$/.test(path)
  const isAnthropicCount = /^(\/anthropic)?(\/v1)?\/messages\/count_tokens$/.test(path)
  const isOpenAi = /^(\/v1)?\/chat\/completions$/.test(path)
  const isResponses = /^(\/v1)?\/responses$/.test(path)
  /*
   * Gemini 把模型和动作都放在路径里：/v1beta/models/{model}:{generateContent|streamGenerateContent}。
   * 模型名本身可能带斜杠之外的任何字符（点号、短横），所以只按最后一个冒号切。
   */
  const gemini = /^\/v1beta\/models\/(.+):(generateContent|streamGenerateContent)$/.exec(path)
  const protocol: ProxyProtocol = gemini
    ? 'gemini'
    : isResponses
      ? 'responses'
      : isOpenAi
        ? 'openai'
        : 'anthropic'

  void (async () => {
    try {
      if (path === '/health' || path === '/') {
        sendJson(res, 200, healthPayload())
        return
      }

      /*
       * 联网搜索的自检入口：直接打 Kiro 的 MCP web_search，绕开模型。
       * 排查「模型说自己没有联网工具」时，用它先确认上游这一层通不通。
       */
      if (path === '/internal/web-search') {
        if (!authorized(req)) {
          sendJson(res, 401, { error: 'API Key 不正确' })
          return
        }
        const query = url.searchParams.get('q')?.trim()
        if (!query) {
          sendJson(res, 400, { error: '缺少查询参数 q' })
          return
        }
        try {
          const results = await searchWithPool(query)
          sendJson(res, 200, { query, count: results.length, results })
        } catch (error) {
          sendJson(res, 502, { query, error: errorMessage(error) })
        }
        return
      }

      /*
       * Kimi Code 的联网搜索：它的 WebSearch 是客户端工具，不经过模型供应商，
       * 而是拿 Kimi 账号的登录凭证直接 POST 到 Moonshot 的搜索服务，免费套餐一律 403。
       * 它允许在 config.toml 的 [services.moonshot_search] 里改地址和 Key，一键写入时指到这里，
       * 由反代用账号池跑 Kiro 的搜索。格式照它的 MoonshotWebSearchProvider（读自 Kimi Code 1.0.4）：
       * 请求 { text_query }，响应 { search_results: [{ title, url, snippet, date?, site_name? }] }。
       */
      if (path === '/kimi/search') {
        if (!authorized(req)) {
          sendJson(res, 401, { error: 'API Key 不正确' })
          return
        }
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: '只接受 POST' })
          return
        }
        let query = ''
        try {
          const body = JSON.parse((await readBody(req)).toString('utf8') || '{}') as { text_query?: unknown }
          query = typeof body.text_query === 'string' ? body.text_query.trim() : ''
        } catch {
          sendJson(res, 400, { error: '请求体不是 JSON' })
          return
        }
        if (!query) {
          sendJson(res, 400, { error: '缺少 text_query' })
          return
        }
        const started = Date.now()
        try {
          const results = await searchWithPool(query)
          if (config.logRequests) {
            log('info', `[WebSearch] Kimi Code 搜索「${query}」→ ${results.length} 条，${Date.now() - started}ms`)
          }
          sendJson(res, 200, {
            search_results: results.map((r) => ({
              title: r.title,
              url: r.url,
              snippet: r.snippet ?? '',
              ...(r.publishedDate ? { date: new Date(r.publishedDate).toISOString().slice(0, 10) } : {}),
              ...(r.domain ? { site_name: r.domain } : {})
            }))
          })
        } catch (error) {
          // 非 200 时它会把响应体原样拼进报错给模型看，写清楚是反代这边的搜索失败
          sendJson(res, 502, { error: `Kiro 联网搜索失败：${errorMessage(error)}` })
        }
        return
      }

      /*
       * 上游模型列表的原始响应。
       * 我们映射出的字段只是其中一部分，排查「某个能力/上限从哪来」时
       * 需要看未经加工的那份，所以留一个自检入口。
       */
      if (path === '/internal/kiro-models') {
        if (!authorized(req)) {
          sendJson(res, 401, { error: 'API Key 不正确' })
          return
        }
        try {
          sendJson(res, 200, await rawKiroModels())
        } catch (error) {
          sendJson(res, 502, { error: errorMessage(error) })
        }
        return
      }

      if (/^(\/v1)?\/models$/.test(path)) {
        // client_version 是 Codex 独有的参数，据此区分「要目录」还是「要 OpenAI 列表」
        const catalog = url.searchParams.has('client_version') ? await codexCatalog() : null
        sendJson(res, 200, catalog ?? modelList())
        return
      }

      if (path === '/v1beta/models') {
        sendJson(res, 200, geminiModelList())
        return
      }

      // 管理 API：只读，一律要 Key
      if (path.startsWith('/admin/')) {
        if (!adminAuthorized(req)) {
          sendJson(res, 401, { error: '管理 API 需要有效的 API Key' })
          return
        }
        if (req.method !== 'GET') {
          sendJson(res, 405, { error: '只接受 GET' })
          return
        }
        const handled = adminRoute(path, url)
        if (handled === undefined) sendJson(res, 404, { error: `不支持的管理接口：${path}` })
        else sendJson(res, 200, handled)
        return
      }

      if (!isAnthropic && !isAnthropicCount && !isOpenAi && !isResponses && !gemini) {
        sendError(res, protocol, 404, `不支持的路径：${path}`)
        return
      }

      if (req.method !== 'POST') {
        sendError(res, protocol, 405, '只接受 POST')
        return
      }

      const auth = authorize(req)
      if (!auth.ok) {
        sendError(res, protocol, auth.status, auth.message)
        return
      }

      const raw = await readBody(req)
      let body: Record<string, unknown>
      try {
        body = JSON.parse(raw.toString('utf-8') || '{}') as Record<string, unknown>
      } catch {
        sendError(res, protocol, 400, '请求体不是合法 JSON')
        return
      }

      const request = gemini
        ? normalizeGeminiRequest(body, gemini[1], gemini[2] === 'streamGenerateContent')
        : isResponses
          ? normalizeResponsesRequest(body)
          : isOpenAi
            ? normalizeOpenAiRequest(body)
            : normalizeAnthropicRequest(body)

      if (isAnthropicCount) {
        handleCountTokens(res, request)
        return
      }

      if (!request.messages.length) {
        sendError(res, protocol, 400, gemini ? 'contents 不能为空' : 'messages 不能为空')
        return
      }

      await handleChat({
        protocol,
        path,
        request,
        res,
        signal: controller.signal,
        keyId: auth.keyId,
        keyName: auth.keyName,
        keyValue: auth.keyValue
      })
    } catch (error) {
      const message = errorMessage(error)
      log('warn', `[Proxy] 处理 ${path} 出错：${message}`)
      if (!res.headersSent) sendError(res, protocol, 500, message)
      else res.end()
    }
  })()
}

// ============ API 端点在线调试 ============

/**
 * 响应体最多带回这么多字符给界面。
 * 账号多的时候 /admin/accounts、/v1/models 格式化后能到几十万字符，上限给宽一些；
 * 再大就没人会在弹窗里往下翻了，要看全量用「复制」或 curl。
 */
const TRY_BODY_LIMIT = 1_000_000
const TRY_TIMEOUT_MS = 120_000

export interface ProxyTryResult {
  status: number
  statusText: string
  durationMs: number
  contentType: string
  /** 给界面显示的正文：JSON 已经格式化好了，界面不用再解析 */
  body: string
  /** 原始响应的完整文本，「复制」用它，不受显示截断影响 */
  raw: string
  /** body 是不是格式化过的 JSON */
  formatted: boolean
  truncated: boolean
}

/**
 * 先格式化、再截断。
 *
 * 顺序不能反：先截到 20 万字符再交给界面去 JSON.parse 的话，
 * 响应一大（几十个账号的 /admin/accounts）截出来就是半截 JSON，
 * 解析失败，只能按一整行原文显示。
 * 截断落在行尾，不把一行切成两半。
 */
function formatForDisplay(text: string, contentType: string): { body: string; formatted: boolean; truncated: boolean } {
  let body = text
  let formatted = false
  if (/json/i.test(contentType) || /^\s*[[{]/.test(text)) {
    try {
      body = JSON.stringify(JSON.parse(text), null, 2)
      formatted = true
    } catch {
      // 不是合法 JSON（SSE、HTML 错误页之类）就原样显示
    }
  }
  if (body.length <= TRY_BODY_LIMIT) return { body, formatted, truncated: false }
  const cut = body.lastIndexOf('\n', TRY_BODY_LIMIT)
  return { body: body.slice(0, cut > 0 ? cut : TRY_BODY_LIMIT), formatted, truncated: true }
}

/**
 * 从主进程对本机反代发一次真实请求，给「API 端点」弹窗的模拟请求用。
 *
 * 为什么不在渲染进程直接 fetch：页面有 CSP，而且那样得把 Key 交给页面；
 * 在这里发，Key 只在主进程里用，界面只拿到响应。
 * 走真实的 HTTP，所以鉴权、额度、日志、统计全部和外部客户端一样生效——
 * 这正是「模拟请求」要验证的东西。
 */
export async function tryProxyEndpoint(input: {
  method: 'GET' | 'POST'
  path: string
  body?: string
}): Promise<ProxyTryResult> {
  if (!server?.listening) throw new Error('本地反代还没启动，先打开上面的开关')
  if (!/^\/[\w\-./:*?=&%]*$/.test(input.path)) throw new Error('路径不合法')

  const key = config.apiKey.trim()
  const headers: Record<string, string> = {}
  if (key) {
    headers.authorization = `Bearer ${key}`
    headers['x-api-key'] = key
    headers['x-goog-api-key'] = key
  }
  if (input.method === 'POST') {
    headers['content-type'] = 'application/json'
    // Anthropic 的 SDK 会带这个头；我们不校验，带上只是让请求和真实客户端长得一样
    headers['anthropic-version'] = '2023-06-01'
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TRY_TIMEOUT_MS)
  const started = Date.now()
  try {
    const res = await fetch(`http://127.0.0.1:${config.port}${input.path}`, {
      method: input.method,
      headers,
      body: input.method === 'POST' ? (input.body ?? '{}') : undefined,
      signal: controller.signal
    })
    const text = await res.text()
    const contentType = res.headers.get('content-type') ?? ''
    return {
      status: res.status,
      statusText: res.statusText,
      durationMs: Date.now() - started,
      contentType,
      raw: text,
      ...formatForDisplay(text, contentType)
    }
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`请求超时（${TRY_TIMEOUT_MS / 1000} 秒）`)
    throw error
  } finally {
    clearTimeout(timer)
  }
}

// ============ 生命周期 ============

export async function startProxy(): Promise<ProxyStatus> {
  config = getProxyConfig()
  if (server?.listening) return proxyStatus()

  lastError = ''
  await new Promise<void>((resolve, reject) => {
    const next = http.createServer(listener)
    // agent 的长连接不该被服务端主动掐断；0 表示不超时
    next.keepAliveTimeout = 0
    next.headersTimeout = 0
    next.requestTimeout = 0

    const onError = (error: NodeJS.ErrnoException): void => {
      next.removeAllListeners()
      lastError =
        error.code === 'EADDRINUSE'
          ? `端口 ${config.port} 已被占用，换一个端口再试`
          : errorMessage(error)
      reject(new Error(lastError))
    }

    next.once('error', onError)
    next.listen(config.port, host(), () => {
      next.removeListener('error', onError)
      // 监听期间的错误（如网卡变化）记下来但不崩进程
      next.on('error', (error) => {
        lastError = errorMessage(error)
        log('warn', `[Proxy] 运行时错误：${lastError}`)
        pushStatus()
      })
      server = next
      startedAt = Date.now()
      log('info', `[Proxy] 已启动：http://${host()}:${config.port}`)
      /*
       * 从没拉过模型列表时，启动后在后台拉一次：
       * 客户端第一次请求 /v1/models 时就能拿到账号的真实模型，不用先去界面点刷新。
       * 失败只记日志，不影响反代本身。
       */
      if (!getProxyModels()) {
        void refreshProxyModels().catch((error) => {
          log('warn', `[Proxy] 启动时拉取模型列表失败：${errorMessage(error)}`)
        })
      }
      resolve()
    })
  })

  pushStatus()
  return proxyStatus()
}

export function stopProxy(): ProxyStatus {
  // 用量和请求日志都是攒着批量落盘的，停服务时把没写的写掉
  flushProxyKeyUsage()
  flushAccountUsage()
  flushProxyLogs()
  if (server) {
    server.close()
    // close 只等现有连接结束，agent 的 keep-alive 会挂着，直接断掉
    server.closeAllConnections?.()
    server = null
    startedAt = 0
    log('info', '[Proxy] 已停止')
  }
  pushStatus()
  return proxyStatus()
}

/** 改配置：端口 / 监听范围变了要重启才生效 */
export async function applyProxyConfig(next: ProxyConfig): Promise<ProxyStatus> {
  const needRestart =
    server?.listening === true && (next.port !== config.port || next.allowLan !== config.allowLan)
  config = next
  if (needRestart) {
    stopProxy()
    await startProxy()
  }
  pushStatus()
  return proxyStatus()
}

export function shutdownProxySync(): void {
  // 放在 server 判断前：服务已停但还有没落盘的用量 / 日志时也要写
  flushProxyKeyUsage()
  flushAccountUsage()
  flushProxyLogs()
  if (!server) return
  try {
    server.closeAllConnections?.()
    server.close()
  } catch {
    // 退出阶段不抛异常
  }
  server = null
}
