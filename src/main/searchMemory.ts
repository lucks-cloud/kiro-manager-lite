// 反代代执行的联网搜索结果，跨请求保留。
//
// 搜索在一次请求内部完成：结果回灌给模型后，模型如果接着调用客户端工具（建文件等），
// 这次请求就以工具调用结束，搜索结果从没进过客户端的会话历史。
// 等客户端执行完工具再发下一次请求时，模型已经看不到搜到的内容，只能凭记忆作答。
// 这里按搜索词记住结果，后续请求的历史里出现这次搜索的标记时，把结果补回去。
import type { NormMessage } from './proxyConvert'

const TTL_MS = 6 * 60 * 60 * 1000
const MAX_ENTRIES = 200

const memory = new Map<string, { text: string; at: number }>()

const MARKER_PREFIX = '> 已联网搜索：'

/** 写进回复正文的搜索标记；客户端会把它原样带回历史，据此认出这里做过哪次搜索 */
export function searchMarker(query: string): string {
  return `${MARKER_PREFIX}${query}`
}

/** 历史里可能出现的两种标记：上面的正文标记，以及 Responses 的 web_search_call 压成的文本 */
const MARKER_PATTERN = new RegExp(`^(?:${MARKER_PREFIX}|\\[web_search\\] )(.+)$`, 'gm')

export function rememberSearch(query: string, text: string): void {
  const key = query.trim()
  if (!key) return
  const now = Date.now()
  memory.delete(key)
  memory.set(key, { text, at: now })
  for (const [k, v] of memory) {
    if (memory.size <= MAX_ENTRIES && now - v.at <= TTL_MS) break
    memory.delete(k)
  }
}

/**
 * 给历史里带搜索标记的 assistant 消息补上当时的搜索结果。
 * 找不到（过期、应用重启过）就保持原样，模型至少知道这里搜过什么。
 */
export function restoreSearchResults(messages: NormMessage[]): number {
  const now = Date.now()
  let restored = 0
  for (const message of messages) {
    if (message.role !== 'assistant' || !message.text) continue
    message.text = message.text.replace(MARKER_PATTERN, (line, query: string) => {
      const hit = memory.get(query.trim())
      if (!hit || now - hit.at > TTL_MS) return line
      restored++
      return `${line}\n\n${hit.text}\n`
    })
  }
  return restored
}
