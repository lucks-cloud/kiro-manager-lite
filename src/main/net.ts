// 网络层：统一 fetch + 可选代理
import { Agent, ProxyAgent, fetch as undiciFetch, type Dispatcher, type RequestInit as UndiciRequestInit } from 'undici'

/**
 * 连接保持时间，由反代参数「上游连接保持」设置，默认 60 秒。
 *
 * undici 默认空闲 4 秒就关掉连接，而 agent 两次请求之间（用户在读回复、客户端在执行工具）
 * 通常远不止 4 秒，于是几乎每个请求都要重新走一遍 TCP + TLS（走代理时还要重建 CONNECT 隧道），
 * 实测重连一次多花约 0.6 秒，全部算进「上游接收」。服务端给了更短的 keep-alive 提示时仍以服务端为准。
 */
const DEFAULT_KEEP_ALIVE_MS = 60_000
let keepAliveMs = DEFAULT_KEEP_ALIVE_MS

function keepAliveOptions(): { keepAliveTimeout: number; keepAliveMaxTimeout: number } {
  // 上限至少 10 分钟，且不小于用户设的值，否则 undici 会把服务端提示夹到更短
  return { keepAliveTimeout: keepAliveMs, keepAliveMaxTimeout: Math.max(10 * 60_000, keepAliveMs) }
}

/** 不走代理时用的连接池：同样按设置放宽保持时间（全局默认的那个是 4 秒） */
let directAgent = new Agent(keepAliveOptions())

/** 丢掉现有连接池，下一次请求按当前设置重建 */
function resetAgents(): void {
  for (const agent of agentCache.values()) void agent?.close?.()
  agentCache.clear()
  const old = directAgent
  directAgent = new Agent(keepAliveOptions())
  // 正在进行的流式请求还在用旧池，等它们自然结束再关，不能 destroy
  void old.close().catch(() => undefined)
}

/** 设置上游连接保持时间（秒）；非法值回落默认 60 秒，值没变不重建连接池 */
export function setKeepAlive(seconds: number): void {
  const ms = Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : DEFAULT_KEEP_ALIVE_MS
  if (ms === keepAliveMs) return
  keepAliveMs = ms
  resetAgents()
  console.log(`[Net] keep-alive → ${ms / 1000}s`)
}

let proxyEnabled = false
let proxyUrl = ''

/**
 * 已创建的 ProxyAgent 缓存。
 * ProxyAgent 内部维护连接池，每个请求都新建一个等于放弃 keep-alive，
 * 批量刷新几百个账号时会退化成每次请求都重新握手。按目标地址复用即可。
 */
const agentCache = new Map<string, Dispatcher | null>()

/**
 * 规范化代理 URL，容错常见的手写格式：
 *   127.0.0.1:7890        → http://127.0.0.1:7890
 *   http:127.0.0.1:7890   → http://127.0.0.1:7890
 *   http:/127.0.0.1:7890  → http://127.0.0.1:7890
 */
function normalizeProxyUrl(url: string): string {
  const trimmed = (url || '').trim()
  if (!trimmed) return ''
  if (/^[a-z][a-z0-9+\-.]*:\/\//i.test(trimmed)) return trimmed
  const m = trimmed.match(/^([a-z][a-z0-9+\-.]*):(\/*)(.+)$/i)
  if (m) return `${m[1]}://${m[3]}`
  return `http://${trimmed}`
}

export function setProxyConfig(enabled: boolean, url: string): void {
  proxyEnabled = enabled
  proxyUrl = normalizeProxyUrl(url)
  // 配置变了就丢弃旧连接池，下一次请求按新地址重建
  for (const agent of agentCache.values()) void agent?.close?.()
  agentCache.clear()
  console.log(`[Net] proxy ${enabled ? `enabled → ${proxyUrl}` : 'disabled'}`)
}

/** 取（或按需创建）指定代理地址的 agent，地址非法时缓存 null 避免反复重试。入参需已规范化 */
function agentFor(target: string): Dispatcher | undefined {
  if (!target) return undefined

  const cached = agentCache.get(target)
  if (cached !== undefined) return cached ?? undefined

  try {
    const agent = new ProxyAgent({ uri: target, ...keepAliveOptions() })
    agentCache.set(target, agent)
    return agent
  } catch (e) {
    console.warn('[Net] invalid proxy url:', target, e)
    agentCache.set(target, null)
    return undefined
  }
}

/** 优先用设置里的代理，未配置时回退系统环境变量 */
function currentAgent(): Dispatcher | undefined {
  if (proxyEnabled && proxyUrl) {
    const agent = agentFor(proxyUrl)
    if (agent) return agent
  }
  return agentFor(
    normalizeProxyUrl(
      process.env.HTTPS_PROXY ||
        process.env.https_proxy ||
        process.env.HTTP_PROXY ||
        process.env.http_proxy ||
        ''
    )
  )
}

/** 组装 undici 请求参数，并挂上当前生效的代理 */
function buildInit(
  method: string,
  headers: Record<string, string> | undefined,
  body: string | Buffer | undefined,
  signal: AbortSignal
): UndiciRequestInit {
  const init: UndiciRequestInit = {
    method,
    headers,
    body: body as UndiciRequestInit['body'],
    signal
  }
  init.dispatcher = currentAgent() ?? directAgent
  return init
}

/**
 * 响应头的最小可用形态。
 * 不直接暴露 undici 的 Headers 类型：主进程的 tsconfig 不含 DOM lib，
 * 这里只声明用得到的两个方法，undici 的实现天然满足。
 */
export interface HttpHeaders {
  get: (name: string) => string | null
  forEach: (callback: (value: string, name: string) => void) => void
  /** 多条 set-cookie 必须分开取，get('set-cookie') 会拼成一串没法可靠切分 */
  getSetCookie: () => string[]
}

export interface HttpResponse {
  ok: boolean
  status: number
  /** 跟随重定向后的最终地址，更新检查可据此解析最新 Release tag。 */
  url: string
  headers: HttpHeaders
  text: () => Promise<string>
  json: <T = unknown>() => Promise<T>
  arrayBuffer: () => Promise<ArrayBuffer>
}

export interface HttpStreamResponse {
  ok: boolean
  status: number
  headers: HttpHeaders
  /** 响应体的字节流，调用方自己按协议解析（如 AWS event-stream） */
  body: ReadableStream<Uint8Array> | null
  text: () => Promise<string>
}

/**
 * 流式请求：不缓冲响应体，直接把字节流交给调用方。
 * 超时只约束「建立连接 + 首个响应头」，长连接读流阶段不设总时限，
 * 由调用方通过 signal 主动取消。
 */
export async function httpStream(
  url: string,
  options: {
    method?: string
    headers?: Record<string, string>
    body?: string | Buffer
    signal?: AbortSignal
    connectTimeoutMs?: number
  } = {}
): Promise<HttpStreamResponse> {
  const { method = 'POST', headers, body, signal, connectTimeoutMs = 30_000 } = options
  const controller = new AbortController()
  const onAbort = (): void => controller.abort(signal?.reason)
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason)
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  const timer = setTimeout(() => controller.abort(new Error('连接超时')), connectTimeoutMs)

  try {
    const res = await undiciFetch(url, buildInit(method, headers, body, controller.signal))
    // 响应头已到，后续读流不该再被连接超时打断
    clearTimeout(timer)
    return {
      ok: res.ok,
      status: res.status,
      headers: res.headers,
      body: res.body as ReadableStream<Uint8Array> | null,
      text: () => res.text()
    }
  } catch (e) {
    clearTimeout(timer)
    throw e
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }
}

/** 带超时和代理的通用请求 */
export async function httpRequest(
  url: string,
  options: {
    method?: string
    headers?: Record<string, string>
    body?: string | Buffer
    timeoutMs?: number
  } = {}
): Promise<HttpResponse> {
  const { method = 'GET', headers, body, timeoutMs = 30_000 } = options
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await undiciFetch(url, buildInit(method, headers, body, controller.signal))
    return {
      ok: res.ok,
      status: res.status,
      url: res.url,
      headers: res.headers,
      text: () => res.text(),
      json: <T>() => res.json() as Promise<T>,
      arrayBuffer: () => res.arrayBuffer()
    }
  } finally {
    clearTimeout(timer)
  }
}
