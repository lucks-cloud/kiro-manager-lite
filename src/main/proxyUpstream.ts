// 本地反代的上游调用：选账号（或 API Key）→ 发请求 → 解析事件流 → 失败时重试 / 换号
//
// 重试的边界只有一条，但很关键：**一旦有内容写给客户端就不能再重试**。
// 否则客户端会收到两段拼在一起的回复，或者一串索引错乱的 SSE 块。
// 所以调用方传进来的 canRetry() 必须如实反映「有没有 flush 过」。
import { createHash } from 'crypto'
import { errorMessage } from '../shared/errors'
import { jsonOf, takeFrames } from './eventStream'
import {
  apiKeyChatEndpoint,
  apiKeyHeaders,
  arnCandidatesFor,
  authHeaders,
  listApiKeyModels,
  listKiroModels
} from './kiroChat'
import { codeWhispererEndpoint, qEndpoint } from './kiroEndpoints'
import { httpStream } from './net'
import { refreshAccountToken } from './accountService'
import { sleep } from './utils'
import { getAccountData, getKeyData, getProxyModels, setAccountData, setProxyModels } from './store'
import type {
  Account,
  KeyEntry,
  KiroModelInfo,
  ProxyAccountMode,
  ProxyAccountSource,
  ProxyConfig,
  ProxyEndpoint,
  ProxyModelCache
} from '../shared/types'
import type { StreamToolCall } from './proxyConvert'

/** 上游端点候选 */
interface EndpointSpec {
  name: string
  url: string
}

function endpointsFor(mode: ProxyEndpoint, region?: string): EndpointSpec[] {
  const cw = { name: 'codewhisperer', url: `${codeWhispererEndpoint(region)}/generateAssistantResponse` }
  const q = { name: 'amazonq', url: `${qEndpoint(region)}/generateAssistantResponse` }
  if (mode === 'codewhisperer') return [cw]
  if (mode === 'amazonq') return [q]
  return [cw, q]
}

export interface UpstreamCallbacks {
  onText: (delta: string) => void
  onThinking: (delta: string) => void
  onToolCall: (call: StreamToolCall) => void
}

export interface UpstreamResult {
  /** 最终成功的账号或 API Key */
  account: PoolIdentity
  endpoint: string
  stopReason: string
  /** 服务端计费事件累计的积分 */
  credits: number
  /** contextUsageEvent 换算出的真实输入 token；拿不到时为 0 */
  inputTokens: number
  toolCalls: number
  attempts: number
  /** 每次失败的说明，用于日志里展示重试过程 */
  retries: string[]
}

/** 上游返回的错误，带状态码便于分类 */
class UpstreamError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message)
  }
}

/** 授权 / 参数类错误：换 profileArn 或换账号有意义，换端点没用 */
function isAuthStatus(status?: number): boolean {
  return status === 400 || status === 401 || status === 403
}

/**
 * 这个账号短期内都用不了：额度耗尽、被封、凭证失效。
 * 直接换下一个账号，不在它身上重试——重发多少次结果都一样。
 */
function isAccountUnusable(error: UpstreamError): boolean {
  if (error.status === 402 || error.status === 401 || error.status === 423) return true
  if (error.status === 403 && /suspend|banned|not authorized/i.test(error.message)) return true
  return /monthly_request_count|reached the limit|quota|suspend/i.test(error.message)
}

/** 请求上下文里可能已经被取消（客户端断开） */
function aborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true
}

// ============ 账号池 ============

/**
 * 池子里的一员：账号管理里的 OAuth 账号，或 API Key 管理里的 Kiro API Key。
 * 对外（日志、按账号用量）只看 id 与 email：API Key 没有登录邮箱时用备注或打码后的 Key 代替。
 */
export type PoolMember =
  | { kind: 'account'; id: string; email: string; account: Account }
  | { kind: 'apiKey'; id: string; email: string; key: KeyEntry }

/** 日志与用量归属只需要这两项 */
export type PoolIdentity = Pick<PoolMember, 'id' | 'email'>

export interface AccountPoolOptions {
  source: ProxyAccountSource
  mode: ProxyAccountMode
  /** group 策略的分组（按来源分别取账号分组或 Key 分组） */
  groupIds: string[]
  /** selected 策略的账号 / Key id */
  ids: string[]
}

/** 从反代配置取出当前来源对应的选号参数：账号与 Key 的分组、选择是分开存的 */
export function poolOptionsFrom(config: ProxyConfig): AccountPoolOptions {
  const apiKey = config.accountSource === 'apiKey'
  return {
    source: apiKey ? 'apiKey' : 'account',
    mode: config.accountMode,
    groupIds: apiKey ? config.keyGroupIds : config.groupIds,
    ids: apiKey ? config.keyIds : config.accountIds
  }
}

/** 轮询游标；按来源分开，进程内保持，重启从头开始 */
const cursors: Record<ProxyAccountSource, number> = { account: 0, apiKey: 0 }

/** 按策略圈定范围；group / selected 没选任何东西时范围为空，由调用方报「请先选择」 */
function inScope<T extends { id: string; groupId?: string }>(
  items: T[],
  options: AccountPoolOptions
): T[] {
  if (options.mode === 'group') {
    const groups = new Set(options.groupIds)
    return items.filter((item) => !!item.groupId && groups.has(item.groupId))
  }
  if (options.mode === 'selected') {
    const ids = new Set(options.ids)
    return items.filter((item) => ids.has(item.id))
  }
  return items
}

/**
 * 额度已用尽的先排除：上游直接回 402，放在池子里只会让每个请求都先白试几个。
 * 用量数据来自最近一次刷新，可能偏旧，所以全都用尽时仍然把它们放回来，
 * 让用户看到真实的 402 而不是「没有可用账号」。
 */
function preferWithQuota<T>(items: T[], used: (item: T) => number, limit: (item: T) => number): T[] {
  const withQuota = items.filter((item) => {
    const max = limit(item)
    return !max || max <= 0 || used(item) < max
  })
  return withQuota.length ? withQuota : items
}

/** API Key 没有登录邮箱时的展示名：备注，其次打码的 Key */
function keyLabel(key: KeyEntry): string {
  if (key.email) return key.email
  if (key.note) return key.note
  return `${key.key.slice(0, 8)}…${key.key.slice(-4)}`
}

/**
 * 当前策略下可用的账号 / Key。
 *
 * 账号：排除封禁与凭证失效的——它们必然失败，放进池子只会让每个请求都先白试一遍。
 * 只在指定账号时例外：用户明确点了名，筛完一个不剩就原样用他选的，让他看到真实错误。
 */
export function poolMembers(options: AccountPoolOptions): PoolMember[] {
  if (options.source === 'apiKey') {
    const keys = inScope(getKeyData().keys, options).filter((key) => key.key.startsWith('ksk_'))
    return preferWithQuota(
      keys,
      (key) => key.usedCredits ?? 0,
      (key) => key.totalCredits ?? 0
    ).map((key) => ({ kind: 'apiKey', id: key.id, email: keyLabel(key), key }))
  }

  const scoped = inScope(getAccountData().accounts, options)
  const usable = scoped.filter(
    (account) =>
      !!account.credentials.refreshToken && account.status !== 'banned' && account.status !== 'expired'
  )
  const base = usable.length || options.mode !== 'selected' ? usable : scoped
  return preferWithQuota(
    base,
    (account) => account.usage.current ?? 0,
    (account) => account.usage.limit ?? 0
  ).map((account) => ({ kind: 'account', id: account.id, email: account.email, account }))
}

/** 选不出任何账号 / Key 时给用户看的原因 */
function emptyPoolMessage(options: AccountPoolOptions): string {
  const noun = options.source === 'apiKey' ? 'API Key' : '账号'
  if (options.mode === 'group' && !options.groupIds.length) return `请先在「指定分组」里选择${noun}分组`
  if (options.mode === 'selected' && !options.ids.length) return `请先在「指定${noun}」里选择${noun}`
  if (options.mode === 'group') return `所选分组里没有可用的${noun}`
  if (options.mode === 'selected') return `指定的${noun}不存在或已被删除`
  return `没有可用${noun}，请先添加${noun}`
}

/** 按轮询游标排出本次请求的尝试顺序 */
function orderForRequest(members: PoolMember[], source: ProxyAccountSource): PoolMember[] {
  if (members.length <= 1) return members
  const start = cursors[source]++ % members.length
  return [...members.slice(start), ...members.slice(0, start)]
}

/** token 剩余不足这个时间就先刷新，避免请求发出去正好过期 */
const REFRESH_LEAD_MS = 2 * 60 * 1000

/**
 * 确保账号的 accessToken 可用。
 * 刷新结果要落盘：refreshToken 是轮换式的，只留在内存里下次就成废票。
 */
/** 确保账号的 token 可用（过期就刷新）；联网搜索也要用，所以导出 */
export async function ensureToken(account: Account): Promise<Account> {
  const expiresAt = account.credentials.expiresAt ?? 0
  if (account.credentials.accessToken && expiresAt - Date.now() > REFRESH_LEAD_MS) return account

  const result = await refreshAccountToken(account)
  const data = getAccountData()
  const index = data.accounts.findIndex((a) => a.id === account.id)
  const updated: Account = {
    ...account,
    credentials: {
      ...account.credentials,
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      expiresAt: Date.now() + result.expiresIn * 1000
    },
    status: 'active',
    lastError: undefined
  }
  if (index >= 0) {
    data.accounts[index] = { ...data.accounts[index], ...updated, isActive: data.accounts[index].isActive }
    await setAccountData(data).catch(() => undefined)
  }
  return updated
}

// ============ 模型列表 ============

/**
 * 用反代当前策略选中的账号 / Key 拉一次模型列表并缓存。
 *
 * 「当前选中」的口径与发请求时一致，依次试，第一个能拉到的为准——
 * 不同订阅档位能用的模型不一样，拿别的号拉会列出用不了的模型。
 * 最多试 5 个，池子里有几百个号时不至于把每个都试一遍。
 */
export async function fetchProxyModels(options: AccountPoolOptions): Promise<ProxyModelCache> {
  const members = poolMembers(options)
  if (!members.length) throw new Error(emptyPoolMessage(options))

  let lastError: unknown
  for (const member of members.slice(0, 5)) {
    try {
      let models: KiroModelInfo[]
      let owner: PoolIdentity = member
      if (member.kind === 'apiKey') {
        models = await listApiKeyModels(member.key.key, member.key.region)
      } else {
        const ready = await ensureToken(member.account)
        owner = { id: ready.id, email: ready.email }
        models = await listKiroModels({
          accessToken: ready.credentials.accessToken,
          profileArn: ready.profileArn || ready.credentials.profileArn,
          region: ready.credentials.region,
          idp: ready.idp,
          authMethod: ready.credentials.authMethod
        })
      }
      if (!models.length) throw new Error('上游返回了空的模型列表')

      // auto 固定放第一位：它不是具体模型，但客户端常用它表示「交给 Kiro 选」
      const sorted = [
        ...models.filter((m) => m.modelId === 'auto'),
        ...models.filter((m) => m.modelId !== 'auto')
      ]
      const cache: ProxyModelCache = {
        models: sorted,
        fetchedAt: Date.now(),
        accountId: owner.id,
        accountEmail: owner.email
      }
      setProxyModels(cache)
      return cache
    } catch (error) {
      lastError = error
    }
  }
  throw new Error(`拉取模型列表失败：${errorMessage(lastError)}`)
}

/** 当前缓存的模型 id；还没拉过时为空，调用方自行兜底 */
export function cachedModelIds(): string[] {
  return getProxyModels()?.models.map((m) => m.modelId) ?? []
}

// ============ 事件流解析 ============

interface PendingTool {
  toolUseId: string
  name: string
  raw: string
}

/** 上游把 toolUseEvent 的 input 分片给出来，拼完（stop=true）才算一个完整调用 */
class ToolAssembler {
  private readonly pending = new Map<string, PendingTool>()
  private lastId = ''

  constructor(
    private readonly restoreName: (name: string) => string,
    private readonly emit: (call: StreamToolCall) => void
  ) {}

  push(data: Record<string, unknown>): void {
    const id = typeof data.toolUseId === 'string' && data.toolUseId ? data.toolUseId : this.lastId
    if (!id) return
    this.lastId = id

    const entry = this.pending.get(id) ?? { toolUseId: id, name: '', raw: '' }
    if (typeof data.name === 'string' && data.name) entry.name = data.name
    if (typeof data.input === 'string') entry.raw += data.input
    else if (data.input && typeof data.input === 'object') entry.raw = JSON.stringify(data.input)
    this.pending.set(id, entry)

    if (data.stop === true) this.flush(id)
  }

  private flush(id: string): void {
    const entry = this.pending.get(id)
    if (!entry) return
    this.pending.delete(id)
    let input: Record<string, unknown> = {}
    if (entry.raw.trim()) {
      try {
        const parsed = JSON.parse(entry.raw)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          input = parsed as Record<string, unknown>
        }
      } catch {
        // 上游偶发给出截断的 JSON；丢掉参数也比整轮失败好，客户端会收到空参数调用
        input = {}
      }
    }
    this.emit({ toolUseId: entry.toolUseId, name: this.restoreName(entry.name), input })
  }

  /** 流结束时把没收到 stop 的工具补发出去 */
  flushAll(): void {
    for (const id of [...this.pending.keys()]) this.flush(id)
  }
}

/** 模型上下文窗口，用于把 contextUsagePercentage 换算成 token 数 */
function contextWindow(modelId: string): number {
  return /4\.6|4\.7|4\.8|-5$/.test(modelId) ? 1_000_000 : 200_000
}

interface ParseOutcome {
  stopReason: string
  credits: number
  inputTokens: number
  toolCalls: number
  /** 收到过任何输出（正文 / 思考 / 工具） */
  sawOutput: boolean
}

async function parseStream(
  body: ReadableStream<Uint8Array>,
  modelId: string,
  toolNameMap: Map<string, string>,
  callbacks: UpstreamCallbacks,
  onFlush: () => void
): Promise<ParseOutcome> {
  const reader = body.getReader()
  let buffer = Buffer.alloc(0)
  let stopReason = ''
  let credits = 0
  let contextPercent = 0
  let toolCalls = 0
  let sawOutput = false

  const assembler = new ToolAssembler(
    (name) => toolNameMap.get(name) ?? name,
    (call) => {
      toolCalls++
      sawOutput = true
      onFlush()
      callbacks.onToolCall(call)
    }
  )

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer = Buffer.concat([buffer, Buffer.from(value)])
    const { frames, rest } = takeFrames(buffer)
    buffer = rest

    for (const frame of frames) {
      const data = jsonOf(frame.payload)
      const messageType = frame.headers[':message-type']
      const eventType = frame.headers[':event-type']

      if (messageType === 'exception' || frame.headers[':exception-type']) {
        const kind = frame.headers[':exception-type'] || 'Exception'
        const detail = typeof data.message === 'string' ? data.message : ''
        await reader.cancel().catch(() => undefined)
        throw new UpstreamError(`${kind}${detail ? `: ${detail}` : ''}`)
      }

      switch (eventType) {
        case 'assistantResponseEvent':
          if (typeof data.content === 'string' && data.content) {
            sawOutput = true
            onFlush()
            callbacks.onText(data.content)
          }
          break
        case 'reasoningContentEvent': {
          const holder = (data.reasoningContentEvent ?? data) as { text?: unknown }
          if (typeof holder.text === 'string' && holder.text) {
            sawOutput = true
            onFlush()
            callbacks.onThinking(holder.text)
          }
          break
        }
        case 'toolUseEvent':
          assembler.push(data)
          break
        case 'meteringEvent':
          if (typeof data.usage === 'number') credits += data.usage
          break
        case 'contextUsageEvent':
          if (typeof data.contextUsagePercentage === 'number') {
            contextPercent = data.contextUsagePercentage
          }
          break
        case 'metadataEvent':
        case 'messageMetadataEvent':
          // stopReason 藏在 metadataEvent 里，没有独立的事件类型
          if (typeof data.stopReason === 'string' && data.stopReason) stopReason = data.stopReason
          break
        default:
          break
      }
    }
  }

  assembler.flushAll()
  return {
    stopReason,
    credits,
    inputTokens: contextPercent ? Math.round((contextPercent * contextWindow(modelId)) / 100) : 0,
    toolCalls,
    sawOutput
  }
}

// ============ 主流程 ============

export interface CallOptions {
  payload: Record<string, unknown>
  modelId: string
  toolNameMap: Map<string, string>
  endpoint: ProxyEndpoint
  pool: AccountPoolOptions
  /** 自动重试总开关，见 ProxyConfig.retryEnabled */
  retryEnabled: boolean
  /** 每个账号上的重试次数，见 ProxyConfig.maxRetries */
  maxRetries: number
  retryDelayMs: number
  signal?: AbortSignal
  /** 有内容写给客户端后返回 false，届时不再重试 */
  canRetry: () => boolean
  /** 每次准备用某个账号 / Key 发请求时通知调用方，用于日志展示 */
  onAttempt?: (member: PoolIdentity, attempt: number) => void
}

/** payload 里的 profileArn 每个账号不同，发请求前按账号覆盖；API Key 一律不带 */
function withProfileArn(payload: Record<string, unknown>, arn?: string): Record<string, unknown> {
  const next = { ...payload }
  if (arn) next.profileArn = arn
  else delete next.profileArn
  return next
}

/** 同一个 accessToken 的 profileArn 候选缓存，避免每次请求都问一遍上游 */
const arnCache = new Map<string, { list: (string | undefined)[]; at: number }>()
const ARN_TTL = 10 * 60 * 1000

async function arnListFor(account: Account): Promise<(string | undefined)[]> {
  const key = createHash('sha256').update(account.credentials.accessToken).digest('hex').slice(0, 16)
  const cached = arnCache.get(key)
  if (cached && Date.now() - cached.at < ARN_TTL) return cached.list
  const list = await arnCandidatesFor(account.credentials.accessToken, {
    profileArn: account.profileArn || account.credentials.profileArn,
    region: account.credentials.region,
    idp: account.idp,
    authMethod: account.credentials.authMethod
  })
  // token 大约每小时轮换一次，旧 token 的条目不会再命中，顺手清掉免得 Map 越积越多
  const now = Date.now()
  for (const [k, v] of arnCache) if (now - v.at >= ARN_TTL) arnCache.delete(k)
  arnCache.set(key, { list, at: now })
  return list
}

/** 一个账号 / Key 发请求所需的全部东西：请求头、profileArn 候选、端点候选 */
interface PreparedMember {
  identity: PoolIdentity
  headers: () => Record<string, string>
  arnList: (string | undefined)[]
  endpoints: EndpointSpec[]
}

/** 账号要先确保 token 可用（可能触发刷新）；API Key 直接可用，端点固定为 runtime.{region}.kiro.dev */
async function prepareMember(member: PoolMember, endpoint: ProxyEndpoint): Promise<PreparedMember> {
  if (member.kind === 'apiKey') {
    const { key, region } = member.key
    return {
      identity: { id: member.id, email: member.email },
      headers: () => apiKeyHeaders(key),
      arnList: [undefined],
      endpoints: [{ name: 'kiro-runtime', url: apiKeyChatEndpoint(region) }]
    }
  }
  const ready = await ensureToken(member.account)
  return {
    identity: { id: ready.id, email: ready.email },
    headers: () => authHeaders(ready.credentials.accessToken),
    arnList: await arnListFor(ready).catch(() => [undefined]),
    endpoints: endpointsFor(endpoint, ready.credentials.region)
  }
}

type AttemptOutcome =
  | { ok: true; endpoint: string; outcome: ParseOutcome }
  | { ok: false; error: UpstreamError }

/**
 * 在一个账号上发一次请求。内部会依次换 profileArn、换端点——那是同一次尝试的不同入口，
 * 不算重试：profileArn 给错只会 400/403，换一次就好；两个端点是同一份请求体的入口，
 * 某一个 5xx 时另一个往往正常。
 */
async function attemptOnce(
  prepared: PreparedMember,
  options: CallOptions,
  callbacks: UpstreamCallbacks
): Promise<AttemptOutcome> {
  let lastError = new UpstreamError('没有可用端点')
  for (const arn of prepared.arnList) {
    // 同一个 arn 换端点重试时请求体不变，序列化一次复用（载荷可能有几 MB）
    const body = JSON.stringify(withProfileArn(options.payload, arn))
    for (const endpoint of prepared.endpoints) {
      if (aborted(options.signal)) throw new UpstreamError('客户端已断开', 499)
      try {
        const res = await httpStream(endpoint.url, {
          method: 'POST',
          headers: prepared.headers(),
          body,
          signal: options.signal
        })
        if (!res.ok || !res.body) {
          const raw = await res.text().catch(() => '')
          throw new UpstreamError(`HTTP ${res.status}: ${raw.slice(0, 300) || '没有响应体'}`, res.status)
        }
        const outcome = await parseStream(
          res.body,
          options.modelId,
          options.toolNameMap,
          callbacks,
          () => undefined
        )
        if (!outcome.sawOutput) {
          throw new UpstreamError('上游返回了空响应，账号可能没有该模型的权限或额度已用尽')
        }
        return { ok: true, endpoint: endpoint.name, outcome }
      } catch (error) {
        if (aborted(options.signal)) throw new UpstreamError('客户端已断开', 499)
        const err = error instanceof UpstreamError ? error : new UpstreamError(errorMessage(error))
        // 已经写给客户端了，任何重试都会让回复错乱
        if (!options.canRetry()) throw err
        lastError = err
        // 授权类错误换端点没意义，换下一个 profileArn 候选
        if (isAuthStatus(err.status)) break
      }
    }
    // 授权类错误：继续试下一个 profileArn；其余错误这一次尝试就算失败了
    if (!isAuthStatus(lastError.status)) break
  }
  return { ok: false, error: lastError }
}

/** 一个请求最多轮到这么多个账号：池子有几百个号时，不至于一个请求把每个都试一遍 */
const MEMBER_CAP = 20

/**
 * 发起一次上游对话。
 *
 * 失败时的处理分三类：
 *  - 请求本身不合法（非 profileArn 引起的 400）：换谁都一样，直接报错。
 *  - 这个号用不了（额度耗尽 / 被封 / 凭证失效 / 授权被拒）：静默换下一个号。
 *    这是选号而不是重试，关掉自动重试时也照样跳过，否则池子里一个废号就能让请求失败。
 *  - 其余（限流、5xx、网络、空响应）是临时故障：
 *    开了自动重试 → 在同一个号上每隔 retryDelayMs 重发，最多 maxRetries 次；
 *    仍失败就静默换下一个号，同样最多重发 maxRetries 次，直到池子里的号都试过。
 *    没开 → 直接把错误报给客户端。
 * 任何时候只要已经有内容写给客户端，就不再重试（canRetry 由调用方如实反映）。
 */
export async function callUpstream(
  options: CallOptions,
  callbacks: UpstreamCallbacks
): Promise<UpstreamResult> {
  const members = orderForRequest(poolMembers(options.pool), options.pool.source)
  if (!members.length) throw new UpstreamError(emptyPoolMessage(options.pool), 503)

  const perMember = options.retryEnabled ? Math.max(0, options.maxRetries) : 0
  const delay = Math.max(0, options.retryDelayMs)
  const retries: string[] = []
  let attempts = 0
  let lastError: UpstreamError = new UpstreamError('没有可用账号', 503)

  for (const [index, member] of members.slice(0, MEMBER_CAP).entries()) {
    if (aborted(options.signal)) throw new UpstreamError('客户端已断开', 499)
    const isLast = index === Math.min(members.length, MEMBER_CAP) - 1

    let prepared: PreparedMember
    try {
      prepared = await prepareMember(member, options.endpoint)
    } catch (error) {
      // 凭证刷不出来属于「这个号用不了」，跳过
      lastError = new UpstreamError(`刷新凭证失败：${errorMessage(error)}`, 401)
      retries.push(`${member.email}：刷新凭证失败，换下一个账号`)
      continue
    }

    for (let round = 0; ; round++) {
      attempts++
      options.onAttempt?.(prepared.identity, attempts)

      const result = await attemptOnce(prepared, options, callbacks)
      if (result.ok) {
        const { outcome } = result
        return {
          account: prepared.identity,
          endpoint: result.endpoint,
          stopReason: outcome.stopReason || (outcome.toolCalls ? 'tool_use' : 'end_turn'),
          credits: outcome.credits,
          inputTokens: outcome.inputTokens,
          toolCalls: outcome.toolCalls,
          attempts,
          retries
        }
      }

      const err = result.error
      lastError = err
      const brief = err.message.slice(0, 120)

      // 请求本身不合法，换账号也是同样结果
      if (err.status === 400 && !/profilearn/i.test(err.message)) throw err

      if (isAccountUnusable(err) || isAuthStatus(err.status)) {
        retries.push(`${member.email}：${brief}，换下一个账号`)
        break
      }

      // 临时故障：没开自动重试就不重发
      if (!options.retryEnabled) throw err

      if (round < perMember) {
        retries.push(`${member.email}：${brief}，第 ${round + 1}/${perMember} 次重试`)
        if (delay > 0) await sleep(delay)
        if (aborted(options.signal)) throw new UpstreamError('客户端已断开', 499)
        continue
      }

      retries.push(
        perMember
          ? `${member.email}：重试 ${perMember} 次仍失败，换下一个账号`
          : `${member.email}：${brief}，换下一个账号`
      )
      // 换号前同样等一下：限流通常是一阵一阵的，紧接着打下一个号多半也撞上
      if (!isLast && delay > 0) await sleep(delay)
      break
    }
  }

  throw lastError
}

export { UpstreamError }
