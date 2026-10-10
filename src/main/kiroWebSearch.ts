// Kiro 自带的联网搜索：走它的 MCP 端点，不依赖任何第三方搜索服务
//
// 为什么需要这个模块：
//   Codex 的 web_search 是「托管工具」——按 OpenAI 的设计由 provider 在服务端执行，
//   客户端只负责把工具挂上去。Kiro 的对话接口（generateAssistantResponse）不执行它，
//   只会把 toolUse 吐出来，所以必须由反代自己去搜，再把结果回灌给模型。
//
//   Kiro 恰好自带搜索能力，挂在 https://q.<region>.amazonaws.com/mcp 上，
//   用标准 JSON-RPC 的 tools/call 调，工具名就叫 web_search。
//   这样搜索走的还是用户自己的 Kiro 账号，不用配任何外部 API key，
//   也不用担心 DuckDuckGo 之类的站点在部分网络环境下不可达。
import { randomUUID } from 'crypto'
import { qEndpoint } from './kiroEndpoints'
import { apiKeyHeaders, authHeaders } from './kiroChat'
import { httpRequest } from './net'
import { log } from './logger'
import { localDate } from './utils'

/** 单条搜索结果，字段沿用 Kiro MCP 的返回 */
export interface WebSearchResult {
  title: string
  url: string
  snippet?: string
  /** 毫秒时间戳 */
  publishedDate?: number
  domain?: string
}

export interface WebSearchCredentials {
  /** OAuth 账号的 accessToken，或 Kiro API Key（ksk_） */
  accessToken: string
  profileArn?: string
  region?: string
  /** accessToken 是 API Key 时为 true：要声明 tokentype，且不带 profileArn 头 */
  apiKey?: boolean
}

/** MCP 的请求 id：照 Kiro IDE 的格式拼，服务端不校验但保持一致省得踩坑 */
function mcpRequestId(): string {
  const alnum = (n: number, chars: string): string =>
    Array.from({ length: n }, () => chars[Math.floor(Math.random() * chars.length)]).join('')
  const upperLower = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  return `web_search_tooluse_${alnum(22, upperLower)}_${Date.now()}_${alnum(8, 'abcdefghijklmnopqrstuvwxyz0123456789')}`
}

/**
 * 调一次 Kiro 的 MCP web_search。
 *
 * 失败一律抛错，不返回空结果——静默返回「没搜到」会让模型一本正经地
 * 编造内容，比直接报错难查得多。
 */
export async function kiroWebSearch(
  query: string,
  credentials: WebSearchCredentials
): Promise<WebSearchResult[]> {
  const text = query.trim()
  if (!text) throw new Error('搜索词为空')

  const endpoint = `${qEndpoint(credentials.region)}/mcp`
  const headers: Record<string, string> = {
    ...(credentials.apiKey ? apiKeyHeaders(credentials.accessToken) : authHeaders(credentials.accessToken)),
    Accept: '*/*',
    'Amz-Sdk-Request': 'attempt=1; max=3',
    'Amz-Sdk-Invocation-Id': randomUUID()
  }
  // 非 API Key 账号必须带这个头，否则 MCP 直接 403
  if (credentials.profileArn && !credentials.apiKey) headers['x-amzn-kiro-profile-arn'] = credentials.profileArn

  const body = {
    id: mcpRequestId(),
    jsonrpc: '2.0',
    method: 'tools/call',
    params: { name: 'web_search', arguments: { query: text } }
  }

  const res = await httpRequest(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    timeoutMs: 30_000
  })
  const raw = await res.text()
  if (!res.ok) throw new Error(`MCP HTTP ${res.status}: ${raw.slice(0, 300) || '没有响应体'}`)

  let payload:
    | {
        error?: { code?: number; message?: string }
        result?: { content?: { type?: string; text?: string }[]; isError?: boolean }
      }
    | undefined
  try {
    payload = JSON.parse(raw)
  } catch {
    throw new Error(`MCP 返回的不是 JSON：${raw.slice(0, 200)}`)
  }

  if (payload?.error) {
    throw new Error(`MCP error ${payload.error.code ?? -1}: ${payload.error.message ?? '未知错误'}`)
  }
  if (payload?.result?.isError) throw new Error('MCP 返回 web_search 执行失败')

  /*
   * 真正的结果是套在 content[0].text 里的一段 JSON 字符串，要再解一层。
   * 解不出来当失败处理：200 但内容不可用时如果当成空结果，
   * 模型会以为「搜过了没结果」然后凭记忆作答。
   */
  const first = payload?.result?.content?.[0]
  if (!first || first.type !== 'text' || !first.text) throw new Error('MCP 返回内容为空')

  let parsed: { results?: WebSearchResult[]; error?: string }
  try {
    parsed = JSON.parse(first.text)
  } catch {
    throw new Error(`MCP 返回的搜索结果不是合法 JSON：${first.text.slice(0, 200)}`)
  }
  if (parsed.error?.trim()) throw new Error(`搜索失败：${parsed.error}`)

  const results = Array.isArray(parsed.results) ? parsed.results : []
  log('debug', `[WebSearch] "${text}" → ${results.length} 条结果`)
  return results
}

/**
 * 搜索结果压成给模型看的文本；截断 snippet，避免一次灌进去太多 token。
 * 开头注明搜索日期：模型据此判断哪些结果是旧闻，搜到的都偏旧时会换个词再搜。
 */
export function formatSearchResults(query: string, results: WebSearchResult[]): string {
  const today = localDate()
  if (!results.length) return `No results found for "${query}" (searched on ${today}).`
  const lines = results.map((r, i) => {
    const snippet = (r.snippet ?? '').trim()
    const clipped = snippet.length > 300 ? `${snippet.slice(0, 300)}…` : snippet
    const date = r.publishedDate ? ` (${new Date(r.publishedDate).toISOString().slice(0, 10)})` : ''
    return [`${i + 1}. ${r.title}${date}`, clipped && `   ${clipped}`, `   ${r.url}`]
      .filter(Boolean)
      .join('\n')
  })
  return (
    `Search results for "${query}" (searched on ${today}; ` +
    `if these look outdated for a question about recent events, search again with the current year):\n\n` +
    lines.join('\n\n')
  )
}
