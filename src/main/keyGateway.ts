// Kiro API Key 网关（ksk_ 反向代理）
//
// 本地启动两个反向代理服务器，把 Kiro IDE 发来的请求凭证换成用户的 API Key
//（ksk_），剥离 profileArn，并转发到 Kiro 官方网关：
//   - runtime.{region}.kiro.dev     生成面（KRS：generateAssistantResponse 等）
//   - management.{region}.kiro.dev  控制面（CPS：模型列表、用量等）
// 认证方式：Authorization: Bearer ksk_...  +  tokentype: API_KEY，且请求体
// 不能带 profileArn（那属于 IDE 的 OAuth 登录，会让 ksk_ 被 403）。
//
// 本地代理默认使用 KRS 19830 / CPS 19831。
import * as http from 'http'
import * as https from 'https'
import * as zlib from 'zlib'
import { PassThrough } from 'stream'
import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'
import { URL } from 'url'
import { app } from 'electron'
import { log } from './logger'
import {
  QUOTA_EXHAUSTED_REASONS,
  normalizeRetryStatuses,
  retryStatusLabel
} from '../shared/retryPolicy'
import { parseModelEffort } from '../shared/modelSchema'
import type { KeyModelInfo } from '../shared/types'
import { clearRpmWindows, createUsageCollector, recordRequest, recordResponse } from './gatewayStats'

const HEALTH_PATH = '/__kiro_key_health'
const HEALTH_MARKER = 'kiro-manager-key-ok'
const HOP_BY_HOP = [
  'connection',
  'keep-alive',
  'transfer-encoding',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'upgrade'
]

// 对齐 Kiro IDE 的签名，上游只在 UA 带 KiroIDE 标记时才放行生成请求
const KIRO_VERSION = '0.9.2'
const KIRO_SYSTEM = 'darwin#24.6.0'
const KIRO_NODE = '22.21.1'

let _machineId = ''
/** 稳定的 64 位机器标识（持久化到 userData，跨重启不变） */
function machineId(): string {
  if (_machineId) return _machineId
  try {
    const file = path.join(app.getPath('userData'), 'key-gateway-machine-id')
    if (fs.existsSync(file)) {
      _machineId = fs.readFileSync(file, 'utf-8').trim()
    }
    if (!_machineId) {
      _machineId = crypto.randomBytes(32).toString('hex')
      fs.writeFileSync(file, _machineId, 'utf-8')
    }
  } catch {
    _machineId = crypto.randomBytes(32).toString('hex')
  }
  return _machineId
}

function kiroUserAgent(): string {
  return `aws-sdk-js/1.0.34 ua/2.1 os/${KIRO_SYSTEM} lang/js md/nodejs#${KIRO_NODE} api/codewhispererstreaming#1.0.34 m/E KiroIDE-${KIRO_VERSION}-${machineId()}`
}
function kiroXAmzUserAgent(): string {
  return `aws-sdk-js/1.0.34 KiroIDE-${KIRO_VERSION}-${machineId()}`
}

function runtimeBase(region: string): string {
  return `https://runtime.${region}.kiro.dev`
}
function managementBase(region: string): string {
  return `https://management.${region}.kiro.dev`
}

function maskKey(k: string): string {
  if (!k) return '(empty)'
  if (k.length <= 12) return k.slice(0, 4) + '***'
  return k.slice(0, 8) + '…' + k.slice(-4)
}

// ---------------------------------------------------------------------------
// 错误自动续接
//
// Kiro 服务端限流会回 429 ThrottlingException，kiro-agent 把它转成
// 「Too many requests, please wait before trying again.」并中断对话，
// 用户得手动点继续。5xx 同理。开关打开后由网关自己退避重发，IDE 完全感知不到。
//
// 拦哪些状态码由用户在常用工具页勾选，候选与说明见 shared/retryPolicy。
// 唯一的硬保护是额度耗尽：那种情况重试必然失败，无论用户怎么勾都直接透传。
// ---------------------------------------------------------------------------

/**
 * 重试用固定间隔，不做指数退避。
 *
 * Kiro 的速率限流恢复得很快，实测退避到几秒纯属白等，反而让对话明显卡顿。
 * 固定短间隔配合较大的次数上限体验更好，两者都由用户在常用工具页配置。
 */
const MIN_ATTEMPTS = 1
const MAX_ATTEMPTS_LIMIT = 100
const MIN_DELAY_MS = 0
const MAX_DELAY_MS = 60_000

let autoRetryEnabled = false
let retryStatuses = new Set<number>()
let maxAttempts = 10
let retryDelayMs = 100

/** 由设置页写入；关闭时转发行为与改造前完全一致 */
export function setGatewayRetryPolicy(
  enabled: boolean,
  statuses: number[],
  attempts: number,
  delayMs: number
): void {
  autoRetryEnabled = !!enabled
  retryStatuses = new Set(normalizeRetryStatuses(statuses))
  const n = Math.round(Number(attempts) || 0)
  maxAttempts = Math.min(MAX_ATTEMPTS_LIMIT, Math.max(MIN_ATTEMPTS, n))
  // 注意不能写成 Number(delayMs)：Number(null) 是 0，会被当成「间隔 0ms」而疯狂重试。
  // 只有真正的数字才采纳，其余（null / undefined / 空串 / NaN）一律回落默认值。
  const d = typeof delayMs === 'number' && Number.isFinite(delayMs) ? Math.round(delayMs) : 100
  retryDelayMs = Math.min(MAX_DELAY_MS, Math.max(MIN_DELAY_MS, d))
}

/**
 * 该状态码是否需要拦下来判断重试。
 * 只有用户勾选过的错误状态码才拦；其余一律保持原样流式转发。
 */
function shouldInterceptStatus(status: number): boolean {
  return autoRetryEnabled && retryStatuses.has(status)
}

/**
 * 把上游的失败响应体压成一行可读说明写进日志。
 * 上游错误统一是 { message, reason } 形状，非 JSON 时截断原文兜底。
 */
function describeFailure(body: Buffer): string {
  if (!body.length) return ''
  const text = body.toString('utf8')
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>
    const parts = [parsed.message, parsed.reason, parsed.__type]
      .filter((v): v is string => typeof v === 'string' && !!v.trim())
      .map((v) => v.trim())
    if (parts.length) return parts.join(' / ').slice(0, 240)
  } catch {
    /* 非 JSON，走下面的原文兜底 */
  }
  return text.replace(/\s+/g, ' ').trim().slice(0, 240)
}

/** 从限流响应体里取 reason 字段，取不到返回 undefined */
function throttleReasonOf(body: Buffer): string | undefined {
  try {
    const parsed = JSON.parse(body.toString('utf8')) as Record<string, unknown>
    const reason = parsed.reason ?? parsed.Reason
    return typeof reason === 'string' && reason.trim() ? reason.trim() : undefined
  } catch {
    return undefined
  }
}

/**
 * 状态码已经是用户勾选的了，这里只做最后一道硬保护：
 * 若响应里的 reason 表明本周期额度已用尽，重试 100% 失败，直接透传。
 * 402 不带 reason 时按额度用尽处理——这个状态码在 Kiro 语义里就是额度问题。
 */
function isRetryableResponse(status: number, reason?: string): boolean {
  if (reason && QUOTA_EXHAUSTED_REASONS.has(reason)) return false
  if (status === 402 && !reason) return false
  return true
}



/**
 * 只有对话接口的响应才是带用量事件的 event-stream。
 * 模型列表、用量查询、/mcp 这些不会有 tokenUsage / meteringEvent，无需解析。
 */
function isChatPath(cleanPath: string): boolean {
  return /generateAssistantResponse|SendMessage|converse/i.test(cleanPath)
}

/** 读完一个响应流；仅用于限流这类小响应体 */
function collectBody(stream: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = []
    stream.on('data', (c) => parts.push(Buffer.isBuffer(c) ? c : Buffer.from(c)))
    stream.on('end', () => resolve(Buffer.concat(parts)))
    stream.on('error', reject)
  })
}

function stripHopByHop(headers: http.IncomingHttpHeaders): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {}
  for (const [k, v] of Object.entries(headers || {})) {
    if (HOP_BY_HOP.includes(k.toLowerCase())) continue
    if (v !== undefined) out[k] = v as string | string[]
  }
  return out
}

// ---- profileArn 剥离 ----

/** InvokeMCP 用这个请求头携带 profileArn，必须与 body 里的一样剥掉 */
const PROFILE_ARN_HEADER = 'x-amzn-kiro-profile-arn'
function scrubProfileArn(node: unknown): boolean {
  if (!node || typeof node !== 'object') return false
  let changed = false
  if (Array.isArray(node)) {
    for (const item of node) if (scrubProfileArn(item)) changed = true
    return changed
  }
  const obj = node as Record<string, unknown>
  if (Object.prototype.hasOwnProperty.call(obj, 'profileArn')) {
    delete obj.profileArn
    changed = true
  }
  for (const k of Object.keys(obj)) if (scrubProfileArn(obj[k])) changed = true
  return changed
}
function stripProfileArnFromBody(bodyBuf: Buffer): Buffer {
  if (!bodyBuf || !bodyBuf.length) return bodyBuf
  let j: unknown
  try {
    j = JSON.parse(bodyBuf.toString('utf8'))
  } catch {
    return bodyBuf
  }
  if (scrubProfileArn(j)) return Buffer.from(JSON.stringify(j), 'utf8')
  return bodyBuf
}

/** 构造转发到上游的请求头：保留原头，强制换成 API Key 凭证与标记 */
function injectAuthHeaders(
  incoming: http.IncomingHttpHeaders,
  targetHost: string,
  key: string
): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = {}
  for (const [k, v] of Object.entries(incoming || {})) {
    const lk = k.toLowerCase()
    if (lk === 'host' || lk === 'authorization' || lk === 'content-length' || lk === 'tokentype') continue
    // InvokeMCP（POST /mcp）把 profileArn 放在请求头而不是请求体里：
    //   InvokeMCPRequest.profileArn → httpHeader: "x-amzn-kiro-profile-arn"
    // 它属于 IDE 的 OAuth 登录身份，和 ksk_ 一起发过去会被判定
    // 「The bearer token included in the request is invalid.」并回 403。
    // body 里的 profileArn 已由 stripProfileArnFromBody 处理，这里补上请求头这一路。
    if (lk === PROFILE_ARN_HEADER) continue
    if (HOP_BY_HOP.includes(lk)) continue
    if (v !== undefined) headers[k] = v as string | string[]
  }
  headers['host'] = targetHost
  headers['authorization'] = 'Bearer ' + key
  headers['tokentype'] = 'API_KEY'
  const has = (name: string): boolean => Object.keys(headers).some((h) => h.toLowerCase() === name)
  if (!has('x-amzn-kiro-agent-mode')) headers['x-amzn-kiro-agent-mode'] = 'vibe'
  const uaKey = Object.keys(headers).find((h) => h.toLowerCase() === 'user-agent')
  if (!uaKey || !/KiroIDE/i.test(String(headers[uaKey] || ''))) {
    headers[uaKey || 'user-agent'] = kiroUserAgent()
  }
  if (!has('x-amz-user-agent')) headers['x-amz-user-agent'] = kiroXAmzUserAgent()
  if (!has('x-amzn-codewhisperer-optout')) headers['x-amzn-codewhisperer-optout'] = 'true'
  return headers
}

// ---------------------------------------------------------------------------
// 直连 API 调用（测活 / 拉模型 / 查用量）
// ---------------------------------------------------------------------------
interface ApiResponse {
  statusCode: number
  body: string
}
function apiGet(base: string, urlPath: string, key: string): Promise<ApiResponse> {
  return new Promise((resolve, reject) => {
    let target: URL
    try {
      target = new URL(base + urlPath)
    } catch (e) {
      return reject(e as Error)
    }
    const req = https.request(
      {
        method: 'GET',
        hostname: target.hostname,
        port: 443,
        path: target.pathname + target.search,
        headers: {
          Accept: 'application/json',
          Authorization: 'Bearer ' + key,
          tokentype: 'API_KEY',
          'x-amzn-kiro-agent-mode': 'vibe',
          'user-agent': kiroUserAgent()
        },
        timeout: 30000
      },
      (res) => {
        const c: Buffer[] = []
        res.on('data', (d) => c.push(d))
        res.on('end', () => resolve({ statusCode: res.statusCode || 0, body: Buffer.concat(c).toString('utf8') }))
      }
    )
    req.on('error', reject)
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.end()
  })
}

export interface FetchedModels {
  defaultModel: string
  models: KeyModelInfo[]
}
export async function fetchModels(region: string, key: string): Promise<FetchedModels> {
  const res = await apiGet(managementBase(region), '/List-Available-Models?origin=AI_EDITOR&maxResults=200', key)
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error('HTTP ' + res.statusCode + ': ' + res.body.slice(0, 200))
  }
  const data = JSON.parse(res.body)
  const rawModels = Array.isArray(data.models) ? [...data.models] : []
  const defaultModel = data?.defaultModel
  if (defaultModel?.modelId && !rawModels.some((model) => model?.modelId === defaultModel.modelId)) {
    rawModels.unshift(defaultModel)
  }
  return {
    defaultModel: defaultModel?.modelId || '',
    models: rawModels.map((m: Record<string, unknown>) => ({
      id: m.modelId as string,
      name: m.modelName as string,
      rate: m.rateMultiplier as number,
      // 推理档位藏在这份 JSON Schema 里，路径与枚举按模型不同，见 shared/modelSchema
      effort: parseModelEffort(m.additionalModelRequestFieldsSchema)
    }))
  }
}
async function fetchUsageRaw(region: string, key: string): Promise<Record<string, unknown>> {
  const res = await apiGet(
    managementBase(region),
    // isEmailRequired=true 时上游会在 userInfo.email 里带上该 Key 绑定的注册邮箱
    '/Get-Usage-Limits?origin=AI_EDITOR&resourceType=AGENTIC_REQUEST&isEmailRequired=true',
    key
  )
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error('HTTP ' + res.statusCode + ': ' + res.body.slice(0, 200))
  }
  return JSON.parse(res.body)
}

function pickNum(obj: Record<string, unknown> | null, keys: string[]): number | null {
  if (!obj || typeof obj !== 'object') return null
  for (const k of keys) {
    const v = obj[k]
    if (typeof v === 'number' && !Number.isNaN(v)) return v
    if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v)
  }
  return null
}
function collectUsagePairs(node: unknown, out: { used: number | null; limit: number | null }[]): void {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const item of node) collectUsagePairs(item, out)
    return
  }
  const obj = node as Record<string, unknown>
  const used = pickNum(obj, ['currentUsageWithPrecision', 'currentUsage', 'usedCredits', 'used'])
  const limit = pickNum(obj, ['usageLimitWithPrecision', 'usageLimit', 'totalCredits', 'limit'])
  if (used != null || limit != null) out.push({ used, limit })
  for (const k of Object.keys(obj)) collectUsagePairs(obj[k], out)
}
function tierFromTitle(title: string): string {
  const t = String(title || '').toLowerCase()
  if (!t) return ''
  if (t.includes('power')) return 'power'
  if (t.includes('pro+') || t.includes('pro plus') || t.includes('promax') || t.includes('pro max')) return 'pro+'
  if (t.includes('pro')) return 'pro'
  if (t.includes('free')) return 'free'
  return 'other'
}
export interface AccountInfo {
  subscriptionTitle: string
  tier: string
  used: number | null
  total: number | null
  /** 该 Key 绑定的注册邮箱，仅在上游返回时有值 */
  email: string | null
  /** 账号唯一标识，形如 d-<目录ID>.<用户UUID> */
  userId: string | null
  /** 额度下次重置时间戳（ms），上游未返回时为 null */
  nextResetAt: number | null
}

/**
 * 解析上游的额度重置时间。
 * 与账号侧同一个 Get-Usage-Limits 字段：数字按秒级 Unix 时间戳，字符串按日期串。
 */
function parseResetAt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value * 1000
  if (typeof value === 'string' && value.trim()) {
    const parsed = new Date(value).getTime()
    return Number.isNaN(parsed) ? null : parsed
  }
  return null
}
export async function fetchAccountInfo(region: string, key: string): Promise<AccountInfo> {
  const data = await fetchUsageRaw(region, key)
  const sub = data?.subscriptionInfo as Record<string, unknown> | undefined
  const title = String(sub?.subscriptionTitle || sub?.subscriptionType || '')
  const user = data?.userInfo as Record<string, unknown> | undefined
  const email = typeof user?.email === 'string' && user.email.trim() ? user.email.trim() : null
  const userId = typeof user?.userId === 'string' && user.userId.trim() ? user.userId.trim() : null
  const pairs: { used: number | null; limit: number | null }[] = []
  collectUsagePairs(data, pairs)
  let used: number | null = null
  let total: number | null = null
  for (const p of pairs) {
    if (p.used != null) used = (used || 0) + p.used
    if (p.limit != null) total = (total || 0) + p.limit
  }
  return {
    subscriptionTitle: title,
    tier: tierFromTitle(title),
    used,
    total,
    email,
    userId,
    nextResetAt: parseResetAt(data?.nextDateReset)
  }
}

// ---------------------------------------------------------------------------
// 本地代理服务器
// ---------------------------------------------------------------------------
interface KeyCredential {
  id: string
  key: string
}
type KeyProvider = () => KeyCredential | null
type RegionProvider = () => string

export interface KeyGatewayObservation {
  lastForwardedKeyId: string | null
  lastForwardedAt?: number
}
type ObservationChanged = (observation: KeyGatewayObservation) => void | Promise<void>

let observation: KeyGatewayObservation = { lastForwardedKeyId: null }
let observationChanged: ObservationChanged | null = null

function clearObservation(): void {
  observation = { lastForwardedKeyId: null }
}

function recordForwarded(credential: KeyCredential): void {
  const keyChanged = observation.lastForwardedKeyId !== credential.id
  observation = {
    lastForwardedKeyId: credential.id,
    lastForwardedAt: Date.now()
  }
  if (!keyChanged || !observationChanged) return
  try {
    void Promise.resolve(observationChanged(getGatewayObservation())).catch((error) => {
      log('warn', `[KeyGateway] observation callback failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  } catch (error) {
    log('warn', `[KeyGateway] observation callback failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export function getGatewayObservation(): KeyGatewayObservation {
  return { ...observation }
}

function forwardGeneric(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  label: string,
  baseFn: (region: string) => string,
  credential: KeyCredential,
  getRegion: RegionProvider
): void {
  const chunks: Buffer[] = []
  req.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)))
  req.on('error', () => undefined)
  req.on('end', () => {
    const bodyBuf = stripProfileArnFromBody(Buffer.concat(chunks))
    const region = getRegion()
    let target: URL
    try {
      target = new URL(baseFn(region) + req.url)
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ message: 'bad target url: ' + (e as Error).message }))
      return
    }
    const headers = injectAuthHeaders(req.headers, target.host, credential.key)
    if (bodyBuf.length) headers['content-length'] = String(Buffer.byteLength(bodyBuf))
    const keyTag = 'key (' + maskKey(credential.key) + ')'
    const cleanPath = (req.url || '').split('?')[0]
    const chat = isChatPath(cleanPath)

    /**
     * 发起一次上游请求。attempt 从 1 开始，仅在命中可重试的限流时递增。
     *
     * 重试是安全的：限流响应表示请求被拒、上游没有产生副作用也没有计费，
     * 而且此时一个字节都还没写给 Kiro（res.writeHead 尚未调用），
     * 对 IDE 来说这次请求只是"慢了几秒"，不会中断对话。
     */
    const attempt = (n: number): void => {
      // 本次尝试的发起时间：统计按它归入分钟桶，保证请求与结果落在同一桶
      const startedAt = Date.now()
      log(
        'info',
        `[KeyGateway] -> [${label}] ${keyTag} ${req.method} ${cleanPath} region=${region}` +
          (n > 1 ? ` (第 ${n} 次尝试)` : '')
      )

      // 到这里凭证已经注入即将发往上游，记录本次真实转发使用的不可变快照。
      recordForwarded(credential)
      recordRequest(credential.id, chat)
      const upReq = https.request(
        {
          method: req.method,
          hostname: target.hostname,
          port: 443,
          path: target.pathname + target.search,
          headers,
          timeout: 300000
        },
        (upRes) => {
          const status = upRes.statusCode || 0
          const okStatus = status >= 200 && status < 300

          // 限流响应体很小且不是流，可以整体读出来判断 reason 再决定重试或透传。
          // 其余状态一律保持原样流式转发，绝不缓冲，避免影响对话的流式输出。
          // 失败响应一律先缓冲：错误体都是很小的 JSON，缓冲代价可以忽略，
          // 换来的是日志里能看到失败的真实原因（上游的 message / reason），
          // 而不是只有一个状态码全靠猜。缓冲后再决定重试或透传。
          if (!okStatus) {
            collectBody(upRes)
              .then((body) => {
                const reason = throttleReasonOf(body)
                const detail = describeFailure(body)
                const tag = `${retryStatusLabel(status)}${reason ? `（${reason}）` : ''}`

                // 自动续接只服务于「别让对话中断」。辅助接口（/mcp 等）失败不影响对话，
                // 对它们重试只会让每次对话白等十几秒。
                const mayRetry = chat && shouldInterceptStatus(status)
                if (mayRetry && isRetryableResponse(status, reason) && n < maxAttempts) {
                  log(
                    'warn',
                    `[KeyGateway] <- [${label}] ${keyTag} ${cleanPath} ${tag}，` +
                      `${retryDelayMs}ms 后重试（${n}/${maxAttempts}）` +
                      (detail ? ` — ${detail}` : '')
                  )
                  // 这次尝试确实失败了，要计入统计：否则 recordRequest 已经把
                  // 每次尝试都算进 requests，而失败数只在最后一次才记，
                  // 累计值就会出现 requests > succeeded + failed 的缺口。
                  recordResponse(credential.id, status, chat, startedAt)
                  setTimeout(() => attempt(n + 1), retryDelayMs)
                  return
                }

                log(
                  'warn',
                  `[KeyGateway] <- [${label}] ${keyTag} ${cleanPath} ${tag}` +
                    (mayRetry && n > 1 ? `，已重试 ${n - 1} 次仍失败` : '') +
                    (detail ? ` — ${detail}` : '')
                )
                // 透传缓冲下来的响应体：content-length 需与实际长度一致
                recordResponse(credential.id, status, chat, startedAt)
                const passHeaders = stripHopByHop(upRes.headers)
                delete passHeaders['content-length']
                if (body.length) passHeaders['content-length'] = String(body.length)
                res.writeHead(status || 502, passHeaders)
                res.end(body)
              })
              .catch(() => {
                recordResponse(credential.id, status, chat, startedAt)
                if (!res.headersSent) res.writeHead(status || 502, stripHopByHop(upRes.headers))
                try {
                  res.end()
                } catch {
                  /* ignore */
                }
              })
            return
          }

          log(okStatus ? 'info' : 'warn', `[KeyGateway] <- [${label}] ${keyTag} HTTP ${status}`)
          recordResponse(credential.id, status, chat, startedAt)
          res.writeHead(status || 502, stripHopByHop(upRes.headers))

          // 成功的对话响应里带着服务端回传的 token 与计费用量，顺路统计。
          // 只旁听不拦截：给 IDE 的数据照常原样 pipe，流式输出的实时性不受影响。
          const collector = okStatus && chat
            ? createUsageCollector(credential.id, label, startedAt)
            : null
          if (collector) {
            // 用独立的 PassThrough 分流，而不是在 upRes 上挂 data 监听：
            // 后者会让流立刻进入 flowing 模式，在 pipe(res) 注册前就可能吃掉开头的数据块。
            const tap = new PassThrough()
            upRes.pipe(tap)

            // 关键：accept-encoding 是透传给上游的，响应可能是压缩的。
            // 压缩字节喂给帧解析器只会一无所获（曾导致统计恒为 0），必须先解压。
            // 给 IDE 的那一路不受影响——它拿到的仍是原始压缩流，由 IDE 自己解压。
            const encoding = String(upRes.headers['content-encoding'] || '').toLowerCase()
            let source: NodeJS.ReadableStream = tap
            if (encoding.includes('br')) source = tap.pipe(zlib.createBrotliDecompress())
            else if (encoding.includes('gzip')) source = tap.pipe(zlib.createGunzip())
            else if (encoding.includes('deflate')) source = tap.pipe(zlib.createInflate())
            collector.noteEncoding(encoding)

            source.on('data', (c: Buffer) => collector.feed(Buffer.isBuffer(c) ? c : Buffer.from(c)))
            source.on('end', () => collector.finish())
            // 解压失败不能影响转发，也不能让 finish 丢掉已累计的数据
            source.on('error', () => collector.finish())
          }

          upRes.pipe(res)
          upRes.on('error', () => {
            try {
              res.end()
            } catch {
              /* ignore */
            }
          })
        }
      )
      upReq.on('error', (e) => {
        log('error', `[KeyGateway] !! [${label}] upstream error: ${e.message}`)
        recordResponse(credential.id, 0, chat, startedAt)
        if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' })
        try {
          res.end(JSON.stringify({ message: 'upstream error: ' + e.message }))
        } catch {
          /* ignore */
        }
      })
      upReq.on('timeout', () => upReq.destroy(new Error('upstream timeout')))
      if (bodyBuf.length) upReq.write(bodyBuf)
      upReq.end()
    }

    attempt(1)
  })
}

function makeGenericHandler(
  label: string,
  baseFn: (region: string) => string,
  getCredential: KeyProvider,
  getRegion: RegionProvider
): http.RequestListener {
  return function handle(req, res) {
    if (req.url === HEALTH_PATH) {
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end(HEALTH_MARKER)
      return
    }
    const credential = getCredential()
    if (!credential) {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ message: 'Key 网关：未配置 API Key' }))
      return
    }
    forwardGeneric(req, res, label, baseFn, credential, getRegion)
  }
}

/** CPS 控制面：模型列表 / 用量可能以 awsJson（POST / + x-amz-target）方式请求，
 *  直接透传会 UnknownOperation 导致模型列表为空，这里显式识别并用 GET 应答。 */
function makeCpsHandler(getCredential: KeyProvider, getRegion: RegionProvider): http.RequestListener {
  return function handle(req, res) {
    if (req.url === HEALTH_PATH) {
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end(HEALTH_MARKER)
      return
    }
    // CPS 特例和普通透传共享同一份请求级凭证快照，不能在分支内二次读取。
    const credential = getCredential()
    if (!credential) {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ message: 'Key 网关：未配置 API Key' }))
      return
    }
    const region = getRegion()
    const clean = (req.url || '/').split('?')[0]
    const amzTarget = String(req.headers['x-amz-target'] || req.headers['x-amzn-target'] || '')
    const norm = (s: string): string => String(s).replace(/[^a-z0-9]/gi, '').toLowerCase()
    const key = norm(clean) + '|' + norm(amzTarget)
    const isModels = key.includes('availablemodels')
    const isUsage = key.includes('usagelimit')
    const contentType = amzTarget ? 'application/x-amz-json-1.0' : 'application/json'

    if (isModels || isUsage) {
      req.resume()
      const upPath = isModels
        ? '/List-Available-Models?origin=AI_EDITOR&maxResults=200'
        : '/Get-Usage-Limits?origin=AI_EDITOR&resourceType=AGENTIC_REQUEST'
      const label = isModels ? 'ListAvailableModels' : 'GetUsageLimits'
      recordForwarded(credential)
      apiGet(managementBase(region), upPath, credential.key)
        .then((r) => {
          const okStatus = r.statusCode >= 200 && r.statusCode < 300
          log('info', `[KeyGateway] <- [CPS] ${label} HTTP ${r.statusCode}`)
          res.writeHead(okStatus ? 200 : r.statusCode, { 'Content-Type': contentType })
          res.end(r.body)
        })
        .catch((e) => {
          log('warn', `[KeyGateway] !! [CPS] ${label} failed: ${e.message}`)
          res.writeHead(200, { 'Content-Type': contentType })
          res.end(JSON.stringify(isModels ? { models: [] } : {}))
        })
      return
    }
    forwardGeneric(req, res, 'CPS', managementBase, credential, getRegion)
  }
}

/** 本地端口绑定器：首次绑定失败立即报错，绝不在端点已经改写后悄悄重试。 */
class ProxyServer {
  private server: http.Server | null = null

  constructor(
    public port: number,
    private handler: http.RequestListener,
    private label: string
  ) {}

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const srv = http.createServer(this.handler)
      const onError = (error: NodeJS.ErrnoException): void => {
        srv.removeListener('listening', onListening)
        try {
          srv.close()
        } catch {
          /* ignore */
        }
        const detail = error.code === 'EADDRINUSE'
          ? `端口 ${this.port} 已被其它程序或本地网关占用`
          : `${this.label} 监听失败：${error.message}`
        log('error', `[KeyGateway] ${detail}`)
        reject(new Error(detail))
      }
      const onListening = (): void => {
        srv.removeListener('error', onError)
        // 绑定成功后仍保留运行期错误监听，避免未处理异常导致主进程退出
        srv.on('error', (error) => log('error', `[KeyGateway] [${this.label}] ${error.message}`))
        this.server = srv
        log('info', `[KeyGateway] [${this.label}] listening on 127.0.0.1:${this.port}`)
        resolve()
      }
      srv.once('error', onError)
      srv.once('listening', onListening)
      srv.listen(this.port, '127.0.0.1')
    })
  }

  isListening(): boolean {
    return !!this.server?.listening
  }

  stop(): void {
    if (!this.server) return
    try {
      this.server.close()
    } catch {
      /* ignore */
    }
    this.server = null
  }
}

// ---------------------------------------------------------------------------
// 网关生命周期：由 keyService 驱动
// ---------------------------------------------------------------------------
let krsServer: ProxyServer | null = null
let cpsServer: ProxyServer | null = null

/**
 * 先把两个端口都绑定成功，调用方才允许改写 settings.json。
 * 任意一个失败都会关闭另一个，保证不会留下半启动状态。
 */
export async function startGateway(
  krsPort: number,
  cpsPort: number,
  getCredential: KeyProvider,
  getRegion: RegionProvider,
  onObservationChanged?: ObservationChanged
): Promise<void> {
  if (krsPort === cpsPort) throw new Error('KRS 与 CPS 端口不能相同')
  if (gatewayRunning() && krsServer?.port === krsPort && cpsServer?.port === cpsPort) return
  stopGateway()
  clearObservation()
  observationChanged = onObservationChanged ?? null

  krsServer = new ProxyServer(
    krsPort,
    makeGenericHandler('KRS', runtimeBase, getCredential, getRegion),
    'KRS'
  )
  cpsServer = new ProxyServer(cpsPort, makeCpsHandler(getCredential, getRegion), 'CPS')
  try {
    // 顺序绑定可保证失败时没有仍在异步 listen 的“游离”服务器。
    await krsServer.start()
    await cpsServer.start()
  } catch (error) {
    stopGateway()
    throw error
  }
}

export function stopGateway(): void {
  if (krsServer) {
    krsServer.stop()
    krsServer = null
    log('info', '[KeyGateway] [KRS] stopped')
  }
  if (cpsServer) {
    cpsServer.stop()
    cpsServer = null
    log('info', '[KeyGateway] [CPS] stopped')
  }
  clearObservation()
  observationChanged = null
  // 累计统计与历史要长期保留，这里只清 RPM 的内存窗口
  clearRpmWindows()
}

export function gatewayRunning(): boolean {
  return !!krsServer?.isListening() && !!cpsServer?.isListening()
}
