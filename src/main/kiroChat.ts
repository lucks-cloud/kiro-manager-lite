// 账号测活：调 Kiro 官方对话接口做一次真实的流式请求
//
// 用量接口能通只说明 token 有效，不代表这个号真能出字：额度耗尽、模型无权限、
// 被风控降级都只在真正发起对话时才暴露。所以这里走和 Kiro IDE 完全一样的
// generateAssistantResponse，把流式增量原样回传界面。
import { createHash, randomUUID } from 'crypto'
import { errorMessage } from '../shared/errors'
import { listAvailableProfiles } from './kiroApi'
import {
  KIRO_BUILDER_ID_PLACEHOLDER_ARN,
  KIRO_SOCIAL_PROFILE_ARN,
  isSocialLogin
} from './kiroAuth'
import {
  AWS_SINGLE_ATTEMPT_HEADERS,
  awsInvocationId,
  codeWhispererEndpoint,
  kiroAmzUserAgent,
  kiroUserAgent,
  qEndpoint
} from './kiroEndpoints'
import { httpRequest, httpStream } from './net'
import { pushUnique } from './utils'
import { jsonOf, takeFrames } from './eventStream'
import { buildModelRequestFields, parseModelEffort } from '../shared/modelSchema'
import type { ChatTestInput, KiroModelInfo } from '../shared/types'

/** 对话端点：主用 CodeWhisperer，失败回退 Amazon Q，两者请求体一致（固定 us-east-1） */
const CHAT_ENDPOINTS = [
  `${codeWhispererEndpoint()}/generateAssistantResponse`,
  `${qEndpoint()}/generateAssistantResponse`
]

/** 账号身份信息：决定请求头与 profileArn 的取法 */
interface AccountIdentity {
  profileArn?: string
  region?: string
  idp?: string
  authMethod?: string
}

/**
 * 对话与模型列表接口的请求头。
 *
 * 注意不要按 idp === 'Enterprise' 附加 TokenType: EXTERNAL_IDP：实测 IdC 登录的
 * Enterprise 账号（Kiro Power 之类）带上该头后，无论 profileArn 怎么给，
 * ListAvailableModels 与 generateAssistantResponse 都回 403
 * "User is not authorized to make this call."，去掉即通。
 */
function authHeaders(accessToken: string): Record<string, string> {
  return {
    'content-type': 'application/json',
    Authorization: `Bearer ${accessToken}`,
    'user-agent': kiroUserAgent(),
    'x-amz-user-agent': kiroAmzUserAgent(),
    'x-amzn-kiro-agent-mode': 'vibe',
    'amz-sdk-invocation-id': awsInvocationId(),
    ...AWS_SINGLE_ATTEMPT_HEADERS
  }
}

/** 由 Kiro 自行挑模型：这种情况不能往请求里塞 modelId */
const AUTO_MODEL_ID = 'auto'

/**
 * 归一化 Claude 版本号里的短横线：claude-sonnet-4-5 → claude-sonnet-4.5。
 * 官方模型 ID 用点号，界面兜底列表和用户手填常写成短横，直接透传会被后端
 * 截成 claude-sonnet-4（丢掉 minor）甚至直接 400。
 * 只转 1~2 位数字的 minor，避免误伤日期快照（claude-sonnet-4-20250514）。
 */
function normalizeModelId(modelId: string): string {
  return modelId.trim().replace(/^(claude-(?:sonnet|haiku|opus))-(\d+)-(\d{1,2})(?=$|[^\d])/i, '$1-$2.$3')
}

/** ListAvailableProfiles 的结果缓存，避免每次测活都多打一次接口 */
const PROFILE_ARN_TTL = 10 * 60 * 1000
const profileArnCache = new Map<string, { arn?: string; at: number }>()

function tokenKey(accessToken: string): string {
  return createHash('sha256').update(accessToken).digest('hex').slice(0, 16)
}

/**
 * 该账号可以依次尝试的 profileArn，按成功率排序。
 *
 * 实测结论（KiroIDE-0.12.155 / aws-sdk-js-1.0.34 的 UA，2026-08）：
 *   - profileArn 现在是**必填**：不带会回 400 "profileArn is required for this request."
 *     （旧 UA 时代不带也能通，那条结论已失效，别再照旧注释改回去）
 *   - Enterprise / IdC：ListAvailableProfiles 返回的真实 ARN 最可信
 *   - Builder ID：没有 profile 概念，必须用 IDE 那个硬编码占位符，实测 200
 *   - Github / Google：后端认固定的 social ARN
 * 末尾仍留一个「不带」的兜底，纯粹为了后端哪天改回去时不至于完全没路走；
 * 当前它只会换来 400，而 400 不是授权类错误，调用方会就此中断，不会浪费更多请求。
 */
async function arnCandidatesFor(
  accessToken: string,
  identity: AccountIdentity
): Promise<(string | undefined)[]> {
  const out: (string | undefined)[] = []

  // 账号里存着的 ARN（切号校验时实测过）最可信
  if (identity.profileArn) pushUnique(out, identity.profileArn)

  if (isSocialLogin({ authMethod: identity.authMethod, provider: identity.idp })) {
    pushUnique(out, KIRO_SOCIAL_PROFILE_ARN)
  } else {
    // IdC / Enterprise：问后端要这个账号自己的 profile
    const key = tokenKey(accessToken)
    const cached = profileArnCache.get(key)
    if (cached && Date.now() - cached.at < PROFILE_ARN_TTL) {
      pushUnique(out, cached.arn)
    } else {
      const arns = await listAvailableProfiles(accessToken, identity.region)
      profileArnCache.set(key, { arn: arns[0], at: Date.now() })
      pushUnique(out, arns[0])
    }
    /*
     * BuilderId 占位符必须作为候选：ListAvailableModels 已改成把 profileArn 当必填，
     * 而 BuilderId 没有 profile 概念，listAvailableProfiles 对它返回空，
     * 于是没切过号的账号候选里只剩「不带」，请求必然 403。
     */
    pushUnique(out, KIRO_BUILDER_ID_PLACEHOLDER_ARN)
  }

  // 不带 profileArn 仍留作最后兜底：万一后端又改回按 token 自行解析
  pushUnique(out, undefined)
  return out
}

/** 授权 / 参数类失败：换 profileArn 候选还有救，换端点没意义 */
function isAuthStatus(status: number): boolean {
  return status === 400 || status === 401 || status === 403
}

// ============ 模型列表 ============

interface RawModel {
  modelId?: string
  modelName?: string
  description?: string
  /** 该模型消耗额度的倍率，上游 Model schema 里的 rateMultiplier */
  rateMultiplier?: number
  /** 该模型额外可传的请求字段（JSON Schema），推理档位就藏在这里 */
  additionalModelRequestFieldsSchema?: unknown
}

/** 用一个确定的 profileArn 把分页拉完 */
async function fetchModelsWithArn(
  accessToken: string,
  identity: AccountIdentity,
  profileArn: string | undefined
): Promise<KiroModelInfo[]> {
  const models: KiroModelInfo[] = []
  const seen = new Set<string>()
  let nextToken: string | undefined

  const add = (m?: RawModel): void => {
    if (!m?.modelId || seen.has(m.modelId)) return
    seen.add(m.modelId)
    models.push({
      modelId: m.modelId,
      modelName: m.modelName,
      description: m.description,
      rate: m.rateMultiplier,
      effort: parseModelEffort(m.additionalModelRequestFieldsSchema)
    })
  }

  do {
    const params = new URLSearchParams({ origin: 'AI_EDITOR', maxResults: '50' })
    if (profileArn) params.set('profileArn', profileArn)
    if (nextToken) params.set('nextToken', nextToken)

    const res = await httpRequest(`${qEndpoint(identity.region)}/ListAvailableModels?${params}`, {
      method: 'GET',
      headers: { ...authHeaders(accessToken), accept: 'application/json' }
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      const err = new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`) as Error & { status?: number }
      err.status = res.status
      throw err
    }

    // 响应形如 { defaultModel: {...}, models: [...], nextToken }，
    // defaultModel 通常就是 auto，也已包含在 models 里，这里靠 modelId 去重
    const data = await res.json<{ defaultModel?: RawModel; models?: RawModel[]; nextToken?: string }>()
    add(data.defaultModel)
    for (const m of data.models ?? []) add(m)
    nextToken = data.nextToken
  } while (nextToken)

  return models
}

/**
 * 拉取该账号在 Kiro 官方可用的模型。
 *
 * profileArn 给错会直接 403，所以按候选逐个试（真实 ARN → 不带），
 * 全部被拒才把错误抛给界面（界面会回退到常用模型）。
 */
export async function listKiroModels(input: {
  accessToken: string
  profileArn?: string
  region?: string
  idp?: string
  authMethod?: string
}): Promise<KiroModelInfo[]> {
  // 入参已包含全部身份字段，直接当 identity 用
  const identity: AccountIdentity = input
  let lastError: Error | undefined

  for (const candidate of await arnCandidatesFor(input.accessToken, identity)) {
    try {
      const models = await fetchModelsWithArn(input.accessToken, identity, candidate)
      if (models.length) return models
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e))
      const status = (lastError as Error & { status?: number }).status
      // 非授权类错误（网络、5xx）换 ARN 也没用
      if (status !== undefined && !isAuthStatus(status)) break
    }
  }

  if (lastError) throw lastError
  return []
}

// ============ 对话测活 ============

export interface ChatStreamCallbacks {
  onDelta: (text: string) => void
}

export interface ChatStreamResult {
  /** 实际用上的端点名，便于界面提示走的是哪条链路 */
  endpoint: string
  /** 完整回复文本 */
  text: string
  /** 首个字符到达耗时（毫秒） */
  firstByteMs: number
  totalMs: number
  /** 后端在流里回报的模型（选 auto 时能看到真正被选中的那个；部分模型不回该字段） */
  modelId?: string
  /** 思考内容字数，走推理链路的模型才有 */
  thinkingChars?: number
}

/**
 * 拼一段和 Kiro IDE 同类的上下文。
 *
 * 后端只负责路由模型，不会告诉模型「你是谁、现在几点」——这些是 IDE 在系统提示里
 * 自己注入的。所以裸问「你是什么模型 / 现在几点」时模型只能回答不知道，
 * 这不代表请求没带 modelId。测活始终补上同样的上下文，行为才和 IDE 一致。
 */
function contextPrefix(modelId: string): string {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const now = new Date()
  const local = now.toLocaleString('zh-CN', { hour12: false })
  const name = !modelId || modelId === AUTO_MODEL_ID ? 'auto（由 Kiro 按任务选择）' : modelId
  return [
    '<model_information>',
    `Name: ${name}`,
    '</model_information>',
    '',
    '<current_date_and_time>',
    `Local: ${local} (${timeZone})`,
    `ISO: ${now.toISOString()}`,
    '</current_date_and_time>',
    '',
    ''
  ].join('\n')
}

function buildPayload(input: ChatTestInput, profileArn: string | undefined): Record<string, unknown> {
  const userInputMessage: Record<string, unknown> = {
    content: contextPrefix(input.modelId) + input.message,
    origin: 'AI_EDITOR',
    userInputMessageContext: {}
  }
  // auto 表示交给 Kiro 选模型，带上字面量 "auto" 后端会 400
  if (input.modelId && input.modelId !== AUTO_MODEL_ID) {
    userInputMessage.modelId = normalizeModelId(input.modelId)
  }

  const payload: Record<string, unknown> = {
    conversationState: {
      agentContinuationId: randomUUID(),
      agentTaskType: 'vibe',
      chatTriggerType: 'MANUAL',
      conversationId: randomUUID(),
      currentMessage: { userInputMessage }
    }
  }
  /*
   * additionalModelRequestFields 放在请求体**根级**（与 conversationState 同层）。
   * 实测出来的：放在 userInputMessage / userInputMessageContext / conversationState 里
   * 一律 200 但被静默忽略；只有根级会校验内容 —— 给非法档位时才回
   * 400 "Invalid additionalModelRequestFields: does not have a value in the enumeration [...]"。
   * 字段名也按模型校验：Claude 系只认 output_config、GPT 系只认 reasoning，
   * 而本来没有这一层的模型（如 claude-sonnet-4.5）带上就回
   * 400 "additionalModelRequestFields is not supported for this model"。
   * 所以档位只能来自该模型自己的 schema，不能跨模型套用。
   */
  if (input.additionalModelRequestFields) {
    payload.additionalModelRequestFields = input.additionalModelRequestFields
  }
  if (profileArn) payload.profileArn = profileArn
  return payload
}

/** 用一个确定的 profileArn 跑一遍端点列表 */
async function streamWithArn(
  input: ChatTestInput,
  profileArn: string | undefined,
  callbacks: ChatStreamCallbacks,
  signal?: AbortSignal
): Promise<ChatStreamResult> {
  const body = JSON.stringify(buildPayload(input, profileArn))
  const headers = authHeaders(input.accessToken)

  let lastError = ''
  for (const [index, url] of CHAT_ENDPOINTS.entries()) {
    const startedAt = Date.now()
    try {
      const res = await httpStream(url, { method: 'POST', headers, body, signal })

      if (!res.ok || !res.body) {
        const raw = await res.text().catch(() => '')
        lastError = `HTTP ${res.status}: ${raw.slice(0, 300) || '没有响应体'}`
        // 凭证 / 权限问题换端点没有意义，交给上层换 profileArn 候选
        if (isAuthStatus(res.status) || res.status === 423) {
          const err = new Error(lastError) as Error & { status?: number }
          err.status = res.status
          throw err
        }
        continue
      }

      const reader = res.body.getReader()
      let buffer = Buffer.alloc(0)
      let text = ''
      let firstByteMs = 0
      let modelId: string | undefined
      let thinkingChars = 0

      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer = Buffer.concat([buffer, Buffer.from(value)])
        const { frames, rest } = takeFrames(buffer)
        buffer = rest

        for (const frame of frames) {
          const messageType = frame.headers[':message-type']
          const eventType = frame.headers[':event-type']
          const data = jsonOf(frame.payload)

          if (messageType === 'exception' || frame.headers[':exception-type']) {
            const kind = frame.headers[':exception-type'] || 'Exception'
            const msg = typeof data.message === 'string' ? data.message : ''
            await reader.cancel().catch(() => undefined)
            throw new Error(`${kind}${msg ? `: ${msg}` : ''}`)
          }

          // 后端只在部分模型的响应里回 modelId，抓到就用于界面回显
          if (typeof data.modelId === 'string' && data.modelId) modelId = data.modelId

          if (eventType === 'assistantResponseEvent' && typeof data.content === 'string') {
            if (!firstByteMs) firstByteMs = Date.now() - startedAt
            text += data.content
            callbacks.onDelta(data.content)
          }

          // 推理型模型（opus-5 等）会先推一段 thinking，只计数不混进正文
          if (eventType === 'reasoningContentEvent') {
            const reasoning = (data.reasoningContentEvent ?? data) as { text?: unknown }
            if (typeof reasoning.text === 'string') thinkingChars += reasoning.text.length
          }
        }
      }

      if (!text) {
        lastError = thinkingChars
          ? `只返回了 ${thinkingChars} 字思考内容，没有正文`
          : '接口返回了空响应，账号可能没有该模型的调用权限'
        if (index < CHAT_ENDPOINTS.length - 1) continue
        throw new Error(lastError)
      }

      return {
        endpoint: new URL(url).host,
        text,
        firstByteMs,
        totalMs: Date.now() - startedAt,
        modelId,
        thinkingChars: thinkingChars || undefined
      }
    } catch (e) {
      lastError = errorMessage(e)
      if (signal?.aborted) throw new Error('已取消')
      // 授权类错误不再试下一个端点，直接冒泡让上层换 profileArn
      const status = (e as { status?: number }).status
      if (status !== undefined && (isAuthStatus(status) || status === 423)) throw e
      // 最后一个端点也失败才向上抛
      if (index === CHAT_ENDPOINTS.length - 1) throw new Error(lastError)
    }
  }

  throw new Error(lastError || '对话测试失败')
}

/**
 * 发起一次流式对话。
 *
 * profileArn 按候选逐个实测（账号自己的真实 ARN → 不带），只要有一个能出字就算通。
 * 已经开始出字之后不再重试，避免界面上出现两段拼在一起的回复。
 */
export async function streamKiroChat(
  input: ChatTestInput,
  callbacks: ChatStreamCallbacks,
  signal?: AbortSignal
): Promise<ChatStreamResult> {
  const candidates = await arnCandidatesFor(input.accessToken, input)
  let lastError: unknown

  for (const [index, candidate] of candidates.entries()) {
    let started = false
    try {
      return await streamWithArn(
        input,
        candidate,
        {
          onDelta: (delta) => {
            started = true
            callbacks.onDelta(delta)
          }
        },
        signal
      )
    } catch (e) {
      lastError = e
      if (signal?.aborted) throw new Error('已取消')
      if (started || index === candidates.length - 1) throw e
    }
  }

  throw lastError instanceof Error ? lastError : new Error('对话测试失败')
}


// ============ API Key（ksk_）真实对话测活 ============

/**
 * 使用 Kiro 官方 API Key 发起一次真实流式对话。
 * 与 OAuth 账号的 conversationState / event-stream 完全一致，但：
 * - 端点固定为 runtime.{region}.kiro.dev
 * - 认证增加 tokentype: API_KEY
 * - 请求体绝不携带 profileArn
 */
export async function streamApiKeyChat(
  apiKey: string,
  region: string,
  input: {
    modelId: string
    message: string
    additionalModelRequestFields?: Record<string, unknown>
  },
  callbacks: ChatStreamCallbacks,
  signal?: AbortSignal
): Promise<ChatStreamResult> {
  if (!apiKey.startsWith('ksk_')) throw new Error('API Key 格式无效')
  const chatInput: ChatTestInput = {
    accountId: 'api-key',
    accessToken: '',
    modelId: input.modelId,
    message: input.message,
    region,
    additionalModelRequestFields: input.additionalModelRequestFields
  }
  const body = JSON.stringify(buildPayload(chatInput, undefined))
  const url = `https://runtime.${region}.kiro.dev/generateAssistantResponse`
  const startedAt = Date.now()

  try {
    const res = await httpStream(url, {
      method: 'POST',
      headers: {
        ...authHeaders(apiKey),
        tokentype: 'API_KEY',
        'x-amzn-codewhisperer-optout': 'true'
      },
      body,
      signal
    })

    if (!res.ok || !res.body) {
      const raw = await res.text().catch(() => '')
      throw new Error(`HTTP ${res.status}: ${raw.slice(0, 300) || '没有响应体'}`)
    }

    const reader = res.body.getReader()
    let buffer = Buffer.alloc(0)
    let text = ''
    let firstByteMs = 0
    let modelId: string | undefined
    let thinkingChars = 0

    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer = Buffer.concat([buffer, Buffer.from(value)])
      const parsed = takeFrames(buffer)
      buffer = parsed.rest

      for (const frame of parsed.frames) {
        const messageType = frame.headers[':message-type']
        const eventType = frame.headers[':event-type']
        const data = jsonOf(frame.payload)

        if (messageType === 'exception' || frame.headers[':exception-type']) {
          const kind = frame.headers[':exception-type'] || 'Exception'
          const msg = typeof data.message === 'string' ? data.message : ''
          await reader.cancel().catch(() => undefined)
          throw new Error(`${kind}${msg ? `: ${msg}` : ''}`)
        }

        if (typeof data.modelId === 'string' && data.modelId) modelId = data.modelId
        if (eventType === 'assistantResponseEvent' && typeof data.content === 'string') {
          if (!firstByteMs) firstByteMs = Date.now() - startedAt
          text += data.content
          callbacks.onDelta(data.content)
        }
        if (eventType === 'reasoningContentEvent') {
          const reasoning = (data.reasoningContentEvent ?? data) as { text?: unknown }
          if (typeof reasoning.text === 'string') thinkingChars += reasoning.text.length
        }
      }
    }

    if (!text) {
      throw new Error(
        thinkingChars
          ? `只返回了 ${thinkingChars} 字思考内容，没有正文`
          : '接口返回了空响应，Key 可能没有该模型的调用权限或额度已用尽'
      )
    }

    return {
      endpoint: new URL(url).host,
      text,
      firstByteMs,
      totalMs: Date.now() - startedAt,
      modelId,
      thinkingChars: thinkingChars || undefined
    }
  } catch (error) {
    if (signal?.aborted) throw new Error('已取消')
    throw error
  }
}
