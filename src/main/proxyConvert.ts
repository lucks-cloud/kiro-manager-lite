// 本地反代的协议转换：Anthropic / OpenAI 请求 → Kiro conversationState，
// Kiro 事件流 → 两家各自的 SSE。
//
// 这里的每一条规则都是踩出来的，不是照抄协议文档：
//  1. 系统提示不能塞进 currentMessage.content。Kiro 会把整段当成用户这一轮说的话，
//     模型于是复述系统提示。要放进 history 的第一对（user=系统提示 +
//     assistant="I will follow these instructions."），行为才和 IDE 一致。
//  2. history 里不能出现结构化的 toolUses / toolResults 配对以外的残留：
//     Kiro 对没有对应结果的 toolUse 直接 400。所以只保留「最后一轮 assistant 的
//     toolUses + 当前消息的 toolResults」这一对，更早的工具轮次压成文本叙述。
//  3. 工具名只能是字母、数字、下划线、短横且不超过 64 字符，不合规的转换后在响应里还原成原名，
//     否则客户端认不出自己的工具（见 shortenToolName）。
//  4. 空内容也会 400，用占位符顶上。
import { createHash, randomUUID } from 'crypto'
import type { ServerResponse } from 'http'
import { estimateTokens } from '../shared/proxyModels'
import { log } from './logger'
import { localDate } from './utils'

// ============ 中立消息结构 ============

export interface KiroImage {
  format: string
  source: { bytes: string }
}

export interface NormToolUse {
  toolUseId: string
  name: string
  input: Record<string, unknown>
}

export interface NormToolResult {
  toolUseId: string
  content: { text: string }[]
  status: 'success' | 'error'
}

export interface NormMessage {
  role: 'user' | 'assistant'
  text: string
  images: KiroImage[]
  toolUses: NormToolUse[]
  toolResults: NormToolResult[]
}

export interface NormTool {
  name: string
  description: string
  schema: Record<string, unknown>
  /** 反代自己执行的搜索工具；客户端声明的同名工具没有这个标记，由客户端执行 */
  managed?: boolean
}

/** 反代自己执行的联网搜索工具名；发给 Kiro 时就用这个名字 */
export const WEB_SEARCH_TOOL = 'web_search'

/** 搜索循环的轮数上限，防止模型反复搜下去把额度烧光 */
export const MAX_WEB_SEARCH_ROUNDS = 5

/**
 * 交给模型的搜索工具定义。
 * 描述写得具体一点，模型才知道什么时候该用它（不写清楚它会倾向于凭记忆作答）。
 * 也要写清楚什么时候不该用：这个工具是反代主动挂上的，客户端没要求，
 * 实测模型被问「你是什么模型」时会去搜一遍来核实，白多一轮上游请求（总耗时从 4 秒涨到 16 秒）。
 *
 * 描述里带上今天的日期：很多客户端的系统提示不写日期，模型就按训练数据的年份搜
 * （问「近况」时搜「xxx 近况 2024」），拿到的全是旧闻，答案也跟着过时。
 */
export function webSearchToolSpec(): NormTool {
  return {
    name: WEB_SEARCH_TOOL,
    managed: true,
    description:
      `Search the public web for current information. Today's date is ${localDate()}; ` +
      'your training data is older than that, so never assume the current year from it. ' +
      'Use this whenever the answer depends on recent events, prices, versions, or anything that ' +
      'may have changed after your training data, or when the user explicitly asks you to search. ' +
      'For recent news or "latest" questions, use the current year (or no year at all) in the query, ' +
      'and prefer the newest sources in the results. Do not use it for questions about yourself ' +
      '(your name, model or capabilities), for general knowledge you already have, or for the ' +
      "user's own code and files. Returns a ranked list of titles, URLs and snippets.",
    schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query, in the language most likely to match sources.' }
      },
      required: ['query'],
      additionalProperties: false
    }
  }
}

export interface NormalizedRequest {
  model: string
  stream: boolean
  system: string
  messages: NormMessage[]
  tools: NormTool[]
  maxTokens?: number
  /** 客户端显式要求推理（Anthropic thinking 字段或模型名带 -thinking） */
  thinking: boolean
  /**
   * 客户端点名的推理档位：OpenAI 的 reasoning_effort、Responses 的 reasoning.effort、
   * Anthropic 的 output_config.effort，或由 thinking.budget_tokens 折算。
   * 最终是否生效取决于目标模型的 schema，见 proxyServer。
   */
  effort?: string
  /** Anthropic thinking.budget_tokens：没有显式档位时按预算折算 */
  thinkingBudget?: number
  /**
   * 客户端挂了「托管」联网搜索工具（Codex 的 web_search / Anthropic 的 web_search_*）。
   *
   * 这类工具按设计由 provider 在服务端执行，客户端不会实现它，
   * 所以反代必须自己搜、自己把结果回灌给模型，绝不能把 toolUse 转发给客户端
   * （客户端收到一个它不认识的工具调用会直接卡住）。见 proxyServer 里的搜索循环。
   */
  webSearch?: { maxUses: number }
  /**
   * 「禁用工具调用」：除了清空 tools，历史里的工具轮次也必须全部压成文本。
   * 只清 tools 不够——历史用过的工具名会被补成占位定义发给上游，
   * 上一轮的结构化 toolUses / toolResults 也会原样带上，模型照样能发起工具调用。
   */
  toolsDisabled?: boolean
  /**
   * Claude Code 的 WebSearch 子请求要搜的词。
   *
   * Claude Code 的 WebSearch 不是自己去搜：它另发一个只挂了 Anthropic 服务端工具
   * （type: web_search_20250305）的请求，指望 API 在服务端搜完，按 server_tool_use +
   * web_search_tool_result 两种块把结果带回来，它再按块计数、取结果。我们只回文本的话它就显示
   * 「Did 0 searches」，主对话的模型以为没搜到，转头去用别的工具重试。
   * 识别到这种请求就不问模型，直接用 Kiro 的 MCP 搜索，按官方格式回（见 proxyServer.handleServerSearch）。
   */
  serverSearchQuery?: string
  /**
   * 客户端按 Anthropic 服务端工具声明了搜索（Claude 桌面版的联网搜索就是这样）。
   * 搜索循环据此把每次搜索按 server_tool_use + web_search_tool_result 回给客户端，
   * 它才能显示「搜索了什么、引用了哪些来源」，而不是只看到一段没有出处的回答。
   */
  serverSearch?: boolean
  /**
   * Responses API 的工具来源：发给 Kiro 的扁平名 → 客户端原本的样子。
   * namespace 工具（MCP 分组）在 Kiro 那边只能是一个扁平名，回给客户端时要拆回
   * { namespace, name }；custom 工具的参数是整段文本，要还原成 custom_tool_call。
   */
  toolOrigins?: Map<string, ToolOrigin>
  /**
   * 客户端自带的会话标识（只用于本地选号，不转发给上游）：
   *  - Anthropic：metadata.user_id（Claude Code 形如 user_xxx_account__session_<uuid>，取其中的 UUID）
   *  - OpenAI / Responses：prompt_cache_key（Codex 等会带）或 user 字段
   * 没有就由 sessionKeyFor 用 system + 首条 user 消息的指纹兜底。
   * 会话粘连与 conversationId 稳定化都靠它：同一会话固定同一账号，
   * 上游的前缀缓存（实测约按未缓存价格的 10% 计费）才可能命中。
   */
  sessionHint?: string
}

export interface ToolOrigin {
  name: string
  namespace?: string
  /** custom 工具：参数是一整段自由文本，Kiro 侧包成 {input: string} */
  custom?: boolean
}

/** 空内容占位：Kiro 对空字符串直接 400 */
const EMPTY_TEXT = '.'
const IMAGE_ONLY_TEXT = 'Please analyze the attached image.'
const TOOL_IMAGE_PLACEHOLDER = '[Tool returned an image, see attachment]'
const PRIMING_REPLY = 'I will follow these instructions.'
/** 工具名上限，超了缩短并在响应里还原 */
const TOOL_NAME_LIMIT = 64
/** 工具描述上限，超长部分会被上游拒绝 */
const TOOL_DESC_LIMIT = 10_000
/** 请求体上限的缺省值，与 DEFAULT_PROXY_CONFIG.payloadLimitKB 一致；实际用的是调用方传入的配置值 */
const DEFAULT_PAYLOAD_BYTES = 153_600 * 1024
/** 超限时，历史里单条消息截到这么长 */
const HISTORY_TRUNCATE_CHARS = 4_000
const TRUNCATED_NOTE =
  "[Earlier conversation history was truncated to fit the model's input limit. Older messages and tool activity have been omitted.]"

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function emptyMessage(role: 'user' | 'assistant'): NormMessage {
  return { role, text: '', images: [], toolUses: [], toolResults: [] }
}

/** data:image/png;base64,xxx → { format: 'png', source: { bytes } } */
function imageFromDataUrl(url: string): KiroImage | null {
  const match = /^data:image\/([a-z0-9.+-]+);base64,(.+)$/i.exec(url.trim())
  if (!match) return null
  return { format: normalizeImageFormat(match[1]), source: { bytes: match[2] } }
}

function normalizeImageFormat(raw: string): string {
  const format = raw.toLowerCase()
  if (format === 'jpg') return 'jpeg'
  return format
}

// ============ Anthropic → 中立结构 ============

/** system 可以是字符串，也可以是 [{type:'text',text}] */
function anthropicSystem(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value
    .map((block) => str(asRecord(block)?.text))
    .filter(Boolean)
    .join('\n')
}

/** tool_result 的 content 允许字符串、块数组或任意值 */
function toolResultText(content: unknown): { text: string; images: KiroImage[] } {
  if (typeof content === 'string') return { text: content, images: [] }
  if (!Array.isArray(content)) {
    return { text: content == null ? '' : JSON.stringify(content), images: [] }
  }
  const texts: string[] = []
  const images: KiroImage[] = []
  for (const raw of content) {
    const block = asRecord(raw)
    if (!block) continue
    if (block.type === 'text') texts.push(str(block.text))
    else if (block.type === 'image') {
      const image = anthropicImage(block)
      if (image) images.push(image)
    }
  }
  return { text: texts.filter(Boolean).join('\n'), images }
}

function anthropicImage(block: Record<string, unknown>): KiroImage | null {
  const source = asRecord(block.source)
  if (!source) return null
  const data = str(source.data)
  if (!data) return null
  const mediaType = str(source.media_type) || 'image/png'
  return { format: normalizeImageFormat(mediaType.replace(/^image\//, '')), source: { bytes: data } }
}

/**
 * 从 Anthropic 的 metadata.user_id 里取会话标识。
 *
 * Claude Code 发送的是 `user_<hash>_account__session_<uuid>`（每开一个新会话换一个 UUID），
 * 取出 UUID 作为会话键；其他客户端的 user_id 即使不是这个格式，
 * 只要同一个会话里保持不变，也照样能当会话键用。
 * 会话键只用于本地选号与生成稳定的 conversationId，不会转发给上游。
 */
function anthropicSessionHint(metadata: unknown): string | undefined {
  const userId = str(asRecord(metadata)?.user_id).trim()
  if (!userId) return undefined
  const match = /session_([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/.exec(
    userId
  )
  return (match ? match[1] : userId).toLowerCase()
}

export function normalizeAnthropicRequest(body: Record<string, unknown>): NormalizedRequest {
  const messages: NormMessage[] = []

  for (const raw of Array.isArray(body.messages) ? body.messages : []) {
    const item = asRecord(raw)
    if (!item) continue
    const role = item.role === 'assistant' ? 'assistant' : 'user'
    const message = emptyMessage(role)
    const texts: string[] = []

    if (typeof item.content === 'string') {
      texts.push(item.content)
    } else if (Array.isArray(item.content)) {
      for (const rawBlock of item.content) {
        const block = asRecord(rawBlock)
        if (!block) continue
        switch (block.type) {
          case 'text':
            texts.push(str(block.text))
            break
          /*
           * 历史里的思考内容不带回去（官方 API 对往轮的 thinking 也是直接丢弃）。
           * Kiro 那边没有结构化思考块，若按 <thinking>…</thinking> 文本塞进助手消息，
           * 模型会把它当成自己说过的正文、照着这个格式往下写，
           * Claude Code 里就会出现正文开头一段「<thinking>Now search…</thinking>」。
           */
          case 'thinking':
          case 'redacted_thinking':
            break
          case 'image': {
            const image = anthropicImage(block)
            if (image) message.images.push(image)
            break
          }
          case 'tool_use':
            message.toolUses.push({
              toolUseId: str(block.id),
              name: str(block.name),
              input: asRecord(block.input) ?? {}
            })
            break
          /*
           * 历史里的服务端搜索块：Kiro 不认这两种块，压成文本带回去，
           * 否则模型看不到之前搜过什么、搜到了什么
           */
          case 'server_tool_use': {
            const query = str(asRecord(block.input)?.query)
            if (query) texts.push(`[web_search] ${query}`)
            break
          }
          case 'web_search_tool_result': {
            const hits = Array.isArray(block.content) ? block.content : []
            const lines = hits
              .map((hit) => asRecord(hit))
              .filter((hit): hit is Record<string, unknown> => !!hit && hit.type === 'web_search_result')
              .map((hit) => `- ${str(hit.title)} ${str(hit.url)}`)
            if (lines.length) texts.push(`Search results:\n${lines.join('\n')}`)
            break
          }
          case 'tool_result': {
            const { text, images } = toolResultText(block.content)
            message.toolResults.push({
              toolUseId: str(block.tool_use_id),
              content: [{ text: text || TOOL_IMAGE_PLACEHOLDER }],
              status: block.is_error === true ? 'error' : 'success'
            })
            // 结果里的图片挪到用户消息上：Kiro 的 toolResults 不收图
            message.images.push(...images)
            break
          }
          default:
            break
        }
      }
    }

    message.text = texts.filter(Boolean).join('\n')
    messages.push(message)
  }

  const tools: NormTool[] = []
  let serverSearch = false
  for (const raw of Array.isArray(body.tools) ? body.tools : []) {
    const tool = asRecord(raw)
    const name = str(tool?.name)
    if (!tool || !name) continue
    // Anthropic 的服务端搜索工具没有 input_schema，换成我们自己那份（带 query 参数），模型才知道怎么调
    if (str(tool.type).startsWith('web_search_')) {
      serverSearch = true
      tools.push(webSearchToolSpec())
      continue
    }
    tools.push({
      name,
      description: str(tool.description),
      schema: asRecord(tool.input_schema) ?? {}
    })
  }

  /*
   * 只挂了服务端搜索、第一条消息是 Claude Code 固定句式的，就是 WebSearch 子请求（原因见 serverSearchQuery）。
   * 句式对不上的（别的客户端正常对话里带了服务端搜索）不走捷径，照常交给模型，由搜索循环处理。
   */
  const SEARCH_PREFIX = 'Perform a web search for the query:'
  const firstText = messages[0]?.text.trim() ?? ''
  const serverSearchQuery =
    serverSearch && tools.length === 1 && firstText.startsWith(SEARCH_PREFIX)
      ? firstText.slice(SEARCH_PREFIX.length).trim() || undefined
      : undefined

  const thinkingField = asRecord(body.thinking)
  const outputConfig = asRecord(body.output_config)
  return {
    model: str(body.model),
    stream: body.stream === true,
    system: anthropicSystem(body.system),
    messages,
    tools,
    maxTokens: typeof body.max_tokens === 'number' ? body.max_tokens : undefined,
    thinking: !!thinkingField && thinkingField.type !== 'disabled',
    effort: str(outputConfig?.effort) || undefined,
    thinkingBudget:
      thinkingField?.type === 'enabled' && typeof thinkingField.budget_tokens === 'number'
        ? thinkingField.budget_tokens
        : undefined,
    serverSearchQuery,
    serverSearch,
    sessionHint: anthropicSessionHint(body.metadata)
  }
}

// ============ OpenAI → 中立结构 ============

/** OpenAI content 可以是字符串或 [{type:'text'|'image_url'}] */
function openAiContent(content: unknown): { text: string; images: KiroImage[] } {
  if (typeof content === 'string') return { text: content, images: [] }
  if (!Array.isArray(content)) return { text: '', images: [] }

  const texts: string[] = []
  const images: KiroImage[] = []
  for (const raw of content) {
    const part = asRecord(raw)
    if (!part) continue
    if (part.type === 'text' || part.type === 'input_text') {
      texts.push(str(part.text))
      continue
    }
    // image_url 既可能是 { url } 也可能直接是字符串
    const urlHolder = asRecord(part.image_url)
    const url = str(urlHolder?.url) || str(part.image_url) || str(part.image) || ''
    const image = url ? imageFromDataUrl(url) : null
    if (image) images.push(image)
  }
  return { text: texts.filter(Boolean).join('\n'), images }
}

export function normalizeOpenAiRequest(body: Record<string, unknown>): NormalizedRequest {
  const systemTexts: string[] = []
  const messages: NormMessage[] = []

  for (const raw of Array.isArray(body.messages) ? body.messages : []) {
    const item = asRecord(raw)
    if (!item) continue
    const role = str(item.role)

    if (role === 'system' || role === 'developer') {
      systemTexts.push(openAiContent(item.content).text)
      continue
    }

    if (role === 'tool') {
      const { text, images } = openAiContent(item.content)
      // 连续的 tool 消息合并到同一条用户消息里，与 Kiro 的一轮工具结果对应
      const last = messages[messages.length - 1]
      const target = last && last.role === 'user' && last.toolResults.length ? last : undefined
      const message = target ?? emptyMessage('user')
      message.toolResults.push({
        toolUseId: str(item.tool_call_id),
        content: [{ text: text || TOOL_IMAGE_PLACEHOLDER }],
        status: 'success'
      })
      message.images.push(...images)
      if (!target) messages.push(message)
      continue
    }

    const message = emptyMessage(role === 'assistant' ? 'assistant' : 'user')
    const { text, images } = openAiContent(item.content)
    message.text = text
    message.images.push(...images)

    for (const rawCall of Array.isArray(item.tool_calls) ? item.tool_calls : []) {
      const call = asRecord(rawCall)
      const fn = asRecord(call?.function)
      if (!call || !fn) continue
      let input: Record<string, unknown> = {}
      try {
        input = asRecord(JSON.parse(str(fn.arguments) || '{}')) ?? {}
      } catch {
        input = {}
      }
      message.toolUses.push({ toolUseId: str(call.id), name: str(fn.name), input })
    }
    messages.push(message)
  }

  const tools: NormTool[] = []
  for (const raw of Array.isArray(body.tools) ? body.tools : []) {
    const tool = asRecord(raw)
    // 兼容 { type:'function', function:{...} } 与扁平的 { name, parameters }
    const fn = asRecord(tool?.function) ?? tool
    const name = str(fn?.name)
    if (!fn || !name) continue
    tools.push({
      name,
      description: str(fn.description),
      schema: asRecord(fn.parameters) ?? {}
    })
  }

  return {
    model: str(body.model),
    stream: body.stream === true,
    system: systemTexts.filter(Boolean).join('\n'),
    messages,
    tools,
    maxTokens:
      typeof body.max_tokens === 'number'
        ? body.max_tokens
        : typeof body.max_completion_tokens === 'number'
          ? body.max_completion_tokens
          : undefined,
    thinking: str(body.reasoning_effort) !== '' && body.reasoning_effort !== 'none',
    effort: str(body.reasoning_effort) || undefined,
    sessionHint: str(body.prompt_cache_key).trim() || str(body.user).trim() || undefined
  }
}

// ============ 中立结构 → Kiro payload ============

/** 工具名缩短后的还原表：短名 → 原名 */
export type ToolNameMap = Map<string, string>

/**
 * 工具名转成 Kiro 接受的形式，原名记进 map，响应里再还原。
 *
 * Kiro 只认字母、数字、下划线和短横：名字里出现点号、斜杠、空格等字符时，整个请求回
 * 400 "Invalid tool use format."。这类名字既可能来自客户端的工具声明，也可能来自历史：
 * 模型偶尔会编出 functions.file_write 这种带前缀的调用，它一旦进了会话历史，
 * 之后每个请求都会被拒，所以声明与历史里的名字都要经过这里。
 * 非法字符换成下划线；超长或与别的工具撞名时截短并加原名的哈希，保证一一对应。
 */
function shortenToolName(name: string, map: ToolNameMap): string {
  let safe = name.replace(/[^A-Za-z0-9_-]/g, '_') || 'tool'
  const taken = map.get(safe)
  if (safe.length > TOOL_NAME_LIMIT || (taken !== undefined && taken !== name)) {
    const hash = createHash('sha256').update(name).digest('hex').slice(0, 8)
    safe = `${safe.slice(0, TOOL_NAME_LIMIT - 9)}_${hash}`
  }
  // 原名不用转换的也登记（还原时原样返回）：先出现 a_b、后出现 a.b 时才能检测到撞名
  map.set(safe, name)
  return safe
}

/** 补齐 Kiro 要求的 JSON Schema 形状：缺 type / properties 会被拒 */
function normalizeSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...schema }
  if (typeof out.type !== 'string') out.type = 'object'
  if (!asRecord(out.properties)) out.properties = {}
  out.required = Array.isArray(out.required) ? out.required.filter((v) => typeof v === 'string') : []
  return out
}

function buildTools(
  tools: NormTool[],
  historyToolNames: string[],
  map: ToolNameMap
): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  const seen = new Set<string>()

  for (const tool of tools) {
    const name = shortenToolName(tool.name, map)
    if (seen.has(name.toLowerCase())) continue
    seen.add(name.toLowerCase())
    out.push({
      toolSpecification: {
        name,
        description: (tool.description || `Tool: ${tool.name}`).slice(0, TOOL_DESC_LIMIT),
        inputSchema: { json: normalizeSchema(tool.schema) }
      }
    })
  }

  /*
   * 历史里用过但这次没带定义的工具要补占位定义。
   * Kiro 要求 history 引用的工具名必须在 tools 里出现，否则 400；
   * Claude Code 在后续轮次里经常只带当前需要的工具。
   */
  for (const raw of historyToolNames) {
    const name = shortenToolName(raw, map)
    if (seen.has(name.toLowerCase())) continue
    seen.add(name.toLowerCase())
    out.push({
      toolSpecification: {
        name,
        description: 'Tool used in conversation history',
        inputSchema: {
          json: { type: 'object', properties: {}, required: [], additionalProperties: true }
        }
      }
    })
  }
  return out
}

/** 合并相邻同角色消息：Kiro 要求 user / assistant 严格交替 */
function mergeMessages(messages: NormMessage[]): NormMessage[] {
  const out: NormMessage[] = []
  for (const message of messages) {
    const last = out[out.length - 1]
    if (last && last.role === message.role) {
      last.text = [last.text, message.text].filter(Boolean).join('\n')
      last.images.push(...message.images)
      last.toolUses.push(...message.toolUses)
      last.toolResults.push(...message.toolResults)
      continue
    }
    out.push({ ...message, images: [...message.images], toolUses: [...message.toolUses], toolResults: [...message.toolResults] })
  }
  return out
}

/**
 * 工具结果压成可读文本，供历史里的旧轮次使用。
 * 工具名只标在 user 侧的结果上：assistant 侧一旦出现「调用了某工具」的文本，
 * 模型会照着历史把这段文字当回复输出，而不是发起真正的结构化工具调用。
 */
function narrateToolResults(results: NormToolResult[], toolNames: Map<string, string>): string {
  if (!results.length) return ''
  const body = results
    .map((result) => {
      const text = result.content.map((c) => c.text).join('\n')
      const name = toolNames.get(result.toolUseId)
      return name ? `[${name}] ${text || '(no output)'}` : text
    })
    .filter(Boolean)
    .join('\n\n')
  return body ? `Tool results:\n\n${body.slice(0, 4000)}` : ''
}

/** 客户端可能把模型误输出的「[Called tool xxx]」存进了历史，回传前清掉，避免继续被模仿 */
const POLLUTED_TOOL_TEXT = /\[Called tool [^\]]*\]/g

function stripPollutedToolText(text: string): string {
  if (!text.includes('[Called tool ')) return text
  return text.replace(POLLUTED_TOOL_TEXT, '').replace(/\n{3,}/g, '\n\n').trim()
}

function userContent(message: NormMessage, toolNames: Map<string, string>): string {
  const parts = [message.text, narrateToolResults(message.toolResults, toolNames)].filter(Boolean)
  const text = parts.join('\n\n')
  if (text) return text
  return message.images.length ? IMAGE_ONLY_TEXT : EMPTY_TEXT
}

/** 历史里一条 user 消息的有效正文；「.」占位视为空 */
function realText(value: unknown): string {
  const text = str(value).trim()
  return text === EMPTY_TEXT ? '' : text
}

/** 两段 user 正文合并；后一段与前一段末尾完全相同时不重复追加（卡在重试循环里的客户端会反复发同样的工具结果） */
function joinUserText(prev: string, next: string): string {
  if (!next || prev === next || prev.endsWith(`\n\n${next}`)) return prev
  return prev ? `${prev}\n\n${next}` : next
}

interface HistoryTail {
  text: string
  images: KiroImage[]
}

/**
 * 历史拼好后的最后一道整理，保证发给 Kiro 的 history 满足它的硬性要求，同时不给模型留下可模仿的坏样本：
 *
 *  1. 去掉空壳 assistant 轮次（只剩「.」占位、没有结构化 toolUses）。
 *     这类轮次多是工具调用被拍平后留下的，长会话里攒上几十条，模型会照着学成「什么都不说」，
 *     表现为只出一点思考就结束。工具做了什么已经写在相邻 user 轮的结果文本里，删掉不丢信息。
 *  2. 删完后相邻的 user 轮合并成一条（相同内容只留一份），保持严格交替。
 *  3. assistant 打头、或紧跟在另一条 assistant 后面时（系统提示那一对后面直接是 assistant），
 *     前面补一条占位 user：Kiro 要求 history 从 user 开始且严格交替。
 *  4. 末尾剩下的 user 轮返回给调用方并入当前消息，保证 history 以 assistant 收尾。
 */
function normalizeHistory(history: Record<string, unknown>[], modelId?: string): HistoryTail {
  const kept: Record<string, unknown>[] = []
  for (const item of history) {
    const assistant = asRecord(item.assistantResponseMessage)
    if (assistant) {
      const hollow = !Array.isArray(assistant.toolUses) && !realText(assistant.content)
      if (hollow) continue
      if (!kept.length || kept[kept.length - 1].assistantResponseMessage) {
        kept.push({
          userInputMessage: { content: EMPTY_TEXT, ...(modelId ? { modelId } : {}), origin: 'AI_EDITOR' }
        })
      }
      kept.push(item)
      continue
    }
    const user = asRecord(item.userInputMessage)
    const prev = asRecord(kept[kept.length - 1]?.userInputMessage)
    if (user && prev) {
      prev.content = joinUserText(realText(prev.content), realText(user.content)) || EMPTY_TEXT
      const images = [...((prev.images as KiroImage[]) ?? []), ...((user.images as KiroImage[]) ?? [])]
      if (images.length) prev.images = images
      continue
    }
    kept.push(item)
  }

  const tail: HistoryTail = { text: '', images: [] }
  const last = asRecord(kept[kept.length - 1]?.userInputMessage)
  if (last) {
    kept.pop()
    tail.text = realText(last.content)
    tail.images = (last.images as KiroImage[] | undefined) ?? []
  }
  history.splice(0, history.length, ...kept)
  return tail
}

/** 按 id 去重：同一个 toolUseId 出现两次，Kiro 按配对错误 400 */
function uniqueById<T extends { toolUseId: string }>(items: T[]): T[] {
  const seen = new Set<string>()
  return items.filter((item) => {
    if (!item.toolUseId) return true
    if (seen.has(item.toolUseId)) return false
    seen.add(item.toolUseId)
    return true
  })
}

export interface BuiltPayload {
  payload: Record<string, unknown>
  toolNameMap: ToolNameMap
  /** 估算的输入 token，上游没回 contextUsage 时用它兜底 */
  estimatedInputTokens: number
}

/**
 * 拼出 generateAssistantResponse 的请求体。
 *
 * @param modelId 已映射好的 Kiro 模型 id；'auto' 表示交给 Kiro 选，不带 modelId
 */
export function buildKiroPayload(
  request: NormalizedRequest,
  modelId: string,
  profileArn?: string,
  /** 推理档位等按模型 schema 拼好的字段，放在请求体根级（见 kiroChat.buildPayload 的实测说明） */
  additionalModelRequestFields?: Record<string, unknown>,
  /** 请求体上限（字节），来自配置的 payloadLimitKB */
  maxPayloadBytes: number = DEFAULT_PAYLOAD_BYTES,
  /**
   * 会话级稳定的 conversationId（来自 conversationIdFor）。
   *
   * Kiro 的对话接口本质无状态：history 每轮全量重发。但上游对相同前缀有服务端缓存，
   * 实测重复前段的计费约为未缓存价格的 10%（2026-10-21 Opus 5.5 实测，见 kiro.rs PR #203）。
   * 每个请求都换随机会话 ID 会让这类前缀永远命中不了；官方 IDE 与 kiro.rs 在同一会话内
   * 都复用同一个 conversationId，这里保持一致。不传时维持旧随机行为（托管搜索的子请求等）。
   */
  stableConversationId?: string
): BuiltPayload {
  const toolNameMap: ToolNameMap = new Map()
  const merged = mergeMessages(request.messages)

  // 末尾是 assistant（prefill）时截到最后一条 user：Kiro 不支持预填回复
  let list = merged
  const lastUserIndex = merged.map((m) => m.role).lastIndexOf('user')
  if (merged.length && merged[merged.length - 1].role !== 'user' && lastUserIndex >= 0) {
    list = merged.slice(0, lastUserIndex + 1)
  }

  const last = list[list.length - 1] ?? emptyMessage('user')
  // 同一 id 的重复结果只留第一条（结构化字段与文本叙述都按这份来）
  const current = { ...last, toolResults: uniqueById(last.toolResults) }
  const past = list.slice(0, -1)

  const sendModelId = modelId && modelId !== 'auto' ? modelId : undefined
  const history: Record<string, unknown>[] = []

  // 系统提示作为历史第一对，而不是塞进当前消息
  const systemText = request.system.trim()
  if (systemText) {
    history.push({
      userInputMessage: {
        content: systemText,
        ...(sendModelId ? { modelId: sendModelId } : {}),
        origin: 'AI_EDITOR'
      }
    })
    history.push({ assistantResponseMessage: { content: PRIMING_REPLY } })
  }

  /*
   * 结构化的工具配对只保留一对：上一条 assistant 的 toolUses + 当前消息的 toolResults。
   * Kiro 要求两边的 id 一一对应，否则 400；其余历史里的工具轮次一律压成文本。
   *
   * 配对按 id 校正而不是要求完全一致：
   *  - 同一 id 的重复结果只留第一条；
   *  - 不属于上一条 assistant 的结果不进结构化字段（仍以文本形式留在当前消息里）；
   *  - 上一条 assistant 有调用缺了结果（客户端中途取消、并行调用只回了一部分），
   *    补一条 error 结果，而不是让整轮退化成文本。
   * 只要有一条结果对得上就保留结构化，模型才能接着这一轮工具调用往下走。
   */
  const lastAssistant = past[past.length - 1]?.role === 'assistant' ? past[past.length - 1] : undefined
  const pendingUses = request.toolsDisabled
    ? []
    : uniqueById((lastAssistant?.toolUses ?? []).filter((t) => t.toolUseId))
  const pendingIds = new Set(pendingUses.map((t) => t.toolUseId))
  const answered = uniqueById(current.toolResults.filter((r) => pendingIds.has(r.toolUseId)))
  const keepStructured = answered.length > 0
  const structuredResults: NormToolResult[] = keepStructured
    ? pendingUses.map(
        (tool) =>
          answered.find((r) => r.toolUseId === tool.toolUseId) ?? {
            toolUseId: tool.toolUseId,
            content: [{ text: 'Tool call was cancelled before it returned a result.' }],
            status: 'error'
          }
      )
    : []

  // toolUseId → 工具名，旧轮次的结果文本靠它标明出自哪个工具
  const toolNames = new Map<string, string>()
  for (const message of past) {
    for (const tool of message.toolUses) {
      if (tool.toolUseId && tool.name) toolNames.set(tool.toolUseId, tool.name)
    }
  }
  for (const message of past) {
    if (message.role === 'user') {
      history.push({
        userInputMessage: {
          content: userContent(message, toolNames),
          ...(sendModelId ? { modelId: sendModelId } : {}),
          origin: 'AI_EDITOR',
          ...(message.images.length ? { images: message.images } : {})
        }
      })
      continue
    }

    const toolUses = message === lastAssistant && keepStructured ? pendingUses : []
    // 不保留结构化 toolUses 时直接丢弃，不写成文本（工具名已标在对应的结果文本上）
    const content = stripPollutedToolText(message.text) || EMPTY_TEXT
    history.push({
      assistantResponseMessage: {
        content,
        ...(toolUses.length
          ? {
              toolUses: toolUses.map((tool) => ({
                toolUseId: tool.toolUseId,
                name: shortenToolName(tool.name, toolNameMap),
                input: tool.input
              }))
            }
          : {})
      }
    })
  }

  const currentExtra = normalizeHistory(history, sendModelId)

  /*
   * 禁用工具时一个定义都不发：占位定义也是工具，模型看到了就能调。
   * 只有保留下来的结构化 toolUses 会引用工具名，只需为它们补占位定义；
   * 已压成文本的旧轮次不引用任何工具，不必把客户端已经撤掉的工具再挂回去。
   */
  const referencedNames = keepStructured ? pendingUses.map((t) => t.name).filter(Boolean) : []
  const tools = request.toolsDisabled ? [] : buildTools(request.tools, referencedNames, toolNameMap)
  const context: Record<string, unknown> = {}
  if (tools.length) context.tools = tools
  if (keepStructured) context.toolResults = structuredResults

  const userInputMessage: Record<string, unknown> = {
    content: [currentExtra.text, userContent(current, toolNames)].filter(Boolean).join('\n\n'),
    ...(sendModelId ? { modelId: sendModelId } : {}),
    origin: 'AI_EDITOR',
    userInputMessageContext: context
  }
  const currentImages = [...currentExtra.images, ...current.images]
  if (currentImages.length) userInputMessage.images = currentImages

  const payload: Record<string, unknown> = {
    conversationState: {
      // agentContinuationId 与官方 IDE / kiro.rs 一致：每个请求都换新的
      agentContinuationId: randomUUID(),
      agentTaskType: 'vibe',
      chatTriggerType: 'MANUAL',
      // 同一会话内复用同一个 conversationId（官方 IDE 行为），上游前缀缓存才有命中机会
      conversationId: stableConversationId || randomUUID(),
      currentMessage: { userInputMessage },
      ...(history.length ? { history } : {})
    }
  }
  if (profileArn) payload.profileArn = profileArn
  /*
   * 必须放根级：放进 conversationState / userInputMessage 里一律 200 但被静默忽略，
   * 只有根级才生效。给了模型本不支持的字段会 400，所以调用方只在 schema 允许时才传。
   */
  if (additionalModelRequestFields) {
    payload.additionalModelRequestFields = additionalModelRequestFields
  }

  truncateHistory(payload, maxPayloadBytes)

  const estimatedInputTokens =
    estimateTokens(systemText) +
    list.reduce((sum, m) => sum + estimateTokens(m.text) + (m.images.length ? 800 : 0), 0) +
    request.tools.reduce((sum, t) => sum + estimateTokens(t.name + t.description), 0)

  return { payload, toolNameMap, estimatedInputTokens }
}

/**
 * 会话键：客户端自带标识优先，没有就用「模型 + system + 首条 user 消息」的指纹兜底。
 *
 * 会话键只用于本地选号（proxyUpstream 的会话粘连）与派生稳定 conversationId，
 * 不转发给上游。指纹兜底与 kiro.rs PR #204 的做法一致：
 * 同一段对话的前缀不变，指纹就不变；不同对话的 system/首条消息几乎必不同。
 */
export function sessionKeyFor(request: NormalizedRequest): string {
  if (request.sessionHint) return `hint:${request.sessionHint}`
  const firstUser = request.messages.find((m) => m.role === 'user')
  const seed = [
    request.model,
    request.system,
    firstUser?.text ?? '',
    request.messages.length ? 'u' : ''
  ].join('\u0000')
  return `fp:${createHash('sha256').update(seed).digest('hex')}`
}

/**
 * 由会话键派生稳定且格式合法的 conversationId。
 *
 * 客户端给的会话 UUID 直接复用；其余的键（prompt_cache_key / user / 指纹）可能是
 * 任意字符串，不能直接当 conversationId 发给上游，统一哈希成 UUID v4 形状。
 * 同一会话键永远得到同一个 conversationId，重启应用后依然成立（不存任何状态）。
 */
export function conversationIdFor(sessionKey: string): string {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(sessionKey.slice(5))) {
    return sessionKey.slice(5)
  }
  const digest = createHash('sha256').update(`conversation:${sessionKey}`).digest()
  digest[6] = (digest[6] & 0x0f) | 0x40
  digest[8] = (digest[8] & 0x3f) | 0x80
  const hex = digest.subarray(0, 16).toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/**
 * 请求体过大时的裁剪，分两步，都从最旧的历史开始：
 *
 *  1. 先把历史里超长的单条消息截到 4000 字。agent 场景下撑爆体积的几乎总是
 *     某次读文件 / 跑命令的工具输出（在我们这里被压成了历史文本），
 *     截掉它们的尾巴，对话的来龙去脉还在，比整轮丢掉损失小得多；
 *  2. 还不够，再整条丢最旧的历史。
 *
 * 上游对体积有硬限制，超了直接 400，裁历史比整轮失败好。
 * 系统提示那一对和最后 4 条始终保留，当前这一轮不动。
 */
function truncateHistory(payload: Record<string, unknown>, maxBytes: number): void {
  const state = asRecord(payload.conversationState)
  if (!state) return
  const history = Array.isArray(state.history) ? (state.history as Record<string, unknown>[]) : []
  if (!history.length) return

  // 系统提示对固定在开头，不参与裁剪
  const hasPriming =
    asRecord(history[1]?.assistantResponseMessage)?.content === PRIMING_REPLY ? 2 : 0
  const json = (value: unknown): number => Buffer.byteLength(JSON.stringify(value))
  /*
   * 只整份序列化一次，之后按增量记账：载荷可能有几 MB，
   * 每改一条就重新 JSON.stringify 整份，是 O(消息数 × 载荷大小)，会卡住主线程好几秒。
   * 两种改动的字节差都能精确算出：
   *  - 改 content：只有这个字符串的 JSON 表示变了；
   *  - 删一对历史：删掉的是这两条的 JSON 加上各自后面的逗号（后面一定还有至少 4 条）。
   */
  let bytes = json(payload)
  if (bytes <= maxBytes) return

  // 第一步：截断超长的旧消息。最后 4 条是模型最需要的上下文，不截
  let truncated = 0
  for (let i = hasPriming; i < history.length - 4; i++) {
    const message =
      asRecord(history[i].userInputMessage) ?? asRecord(history[i].assistantResponseMessage)
    const content = str(message?.content)
    if (!message || content.length <= HISTORY_TRUNCATE_CHARS) continue
    const next =
      `${content.slice(0, HISTORY_TRUNCATE_CHARS)}\n\n[Truncated by proxy: original ${content.length} chars]`
    bytes += json(next) - json(content)
    message.content = next
    truncated++
    if (bytes <= maxBytes) break
  }

  // 第二步：整条丢（就地 splice，state.history 与 history 是同一个数组）
  let dropped = 0
  while (bytes > maxBytes) {
    if (history.length - hasPriming <= 4) break
    bytes -= json(history[hasPriming]) + json(history[hasPriming + 1]) + 2
    history.splice(hasPriming, 2)
    dropped += 2
  }
  if (dropped) {
    // 在裁剪处留一句说明，模型才知道更早的上下文被省略了，不会把残缺的历史当成完整对话
    const first = asRecord(history[hasPriming]?.userInputMessage)
    if (first) {
      const before = str(first.content)
      first.content = `${TRUNCATED_NOTE}\n\n${realText(before)}`.trim()
      bytes += json(first.content) - json(before)
    }
    state.history = history
  }

  if (truncated || dropped) {
    log(
      'info',
      `[Proxy] 请求体超过 ${Math.round(maxBytes / 1024)}KB：截断 ${truncated} 条旧消息，丢弃 ${dropped} 条旧历史，` +
        `现为 ${Math.round(bytes / 1024)}KB`
    )
  }
}

// ============ Kiro 事件 → 客户端 SSE ============

export interface StreamToolCall {
  toolUseId: string
  name: string
  input: Record<string, unknown>
}

/**
 * 修正补丁里新建文件的内容行。
 *
 * 补丁格式（*** Begin Patch / *** Add File:）要求新文件的每一行以 `+` 开头，
 * 客户端解析时只收 `+` 行，其余行直接丢掉。部分客户端的工具说明把前缀写成「` +`」，
 * 模型照抄成「空格 + 加号」，结果文件建出来是空的，客户端却报告写入成功。
 * Add File 段里「空格 + 加号」开头的行不可能有别的含义，这里去掉那个空格。
 * Update File 段里空格开头是上下文行，不动。
 */
export function repairPatchCall(call: StreamToolCall): StreamToolCall {
  let changed = false
  const input: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(call.input)) {
    if (typeof value !== 'string' || !value.includes('*** Begin Patch') || !value.includes('*** Add File:')) {
      input[key] = value
      continue
    }
    let inAdd = false
    const lines = value.split('\n').map((line) => {
      if (line.startsWith('*** ')) {
        inAdd = line.startsWith('*** Add File:')
        return line
      }
      if (inAdd && line.startsWith(' +')) {
        changed = true
        return line.slice(1)
      }
      return line
    })
    input[key] = lines.join('\n')
  }
  if (!changed) return call
  log('debug', `[Proxy] 已修正 ${call.name} 补丁里新建文件的行前缀（「 +」→「+」）`)
  return { ...call, input }
}

export interface StreamUsage {
  inputTokens: number
  outputTokens: number
}

/** 一次服务端搜索，按 Anthropic 官方的结果格式 */
export interface ServerSearchBlock {
  /** srvtoolu_ 开头，和官方一致 */
  id: string
  query: string
  results: {
    type: 'web_search_result'
    title: string
    url: string
    /** 官方是加密的页面内容，客户端原样回传、不解析；我们放摘要 */
    encrypted_content: string
    page_age: string | null
  }[]
}

/** SSE 写入的公共部分 */
abstract class SseWriter {
  protected started = false
  /** 最近一次往客户端写东西的时间，心跳据此判断是否已经静默太久 */
  private lastWriteAt = 0

  constructor(
    protected readonly res: ServerResponse,
    protected readonly model: string
  ) {}

  /** 已经往客户端写过内容：此后不能再重试，否则会拼出两段回复 */
  get flushed(): boolean {
    return this.started
  }

  protected writeEvent(event: string | null, data: unknown): void {
    const payload = typeof data === 'string' ? data : JSON.stringify(data)
    this.res.write(`${event ? `event: ${event}\n` : ''}data: ${payload}\n\n`)
    this.started = true
    this.lastWriteAt = Date.now()
  }

  /**
   * 心跳：流已经开始、但静默超过 idleMs 时写一条保活。
   *
   * 首字之后也会有很长的空窗：客户端没要推理时思考内容不转发；工具参数要攒齐才发
   * （模型写一个几百行的文件，参数要生成几十秒）；托管搜索在两轮之间要去搜、再等上游。
   * 这期间连接上一个字节都没有，带空闲超时的客户端或中间层会当成断线。
   *
   * Anthropic 用官方的 ping 事件（官方 API 自己就发，SDK 认识）；
   * 其余协议用 SSE 注释行（冒号开头），按规范所有解析器都直接忽略，不会被当成内容。
   * 只在 started 之后发：之前发就得先提交 200 状态码，出错时没法再回 429 / 401。
   */
  heartbeat(idleMs: number): void {
    if (!this.started || this.res.writableEnded || Date.now() - this.lastWriteAt < idleMs) return
    this.res.write(this.pingFrame())
    this.lastWriteAt = Date.now()
  }

  protected pingFrame(): string {
    return ': ping\n\n'
  }

  abstract text(delta: string): void
  abstract thinking(delta: string): void
  abstract toolCall(call: StreamToolCall): void
  abstract finish(stopReason: string, usage: StreamUsage): void
  /** 已开始输出后才失败：只能在流里补一个错误事件 */
  abstract error(message: string): void
}

/** Anthropic Messages 的 SSE：message_start → content_block_* → message_delta → message_stop */
export class AnthropicSseWriter extends SseWriter {
  private readonly messageId = `msg_${randomUUID().replace(/-/g, '')}`

  protected pingFrame(): string {
    return 'event: ping\ndata: {"type":"ping"}\n\n'
  }
  private blockIndex = -1
  private openBlock: 'text' | 'thinking' | 'tool' | null = null

  start(inputTokens: number): void {
    this.writeEvent('message_start', {
      type: 'message_start',
      message: {
        id: this.messageId,
        type: 'message',
        role: 'assistant',
        content: [],
        model: this.model,
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: inputTokens, output_tokens: 1 }
      }
    })
  }

  private closeBlock(): void {
    if (!this.openBlock) return
    this.writeEvent('content_block_stop', { type: 'content_block_stop', index: this.blockIndex })
    this.openBlock = null
  }

  private openTextBlock(): void {
    if (this.openBlock === 'text') return
    this.closeBlock()
    this.blockIndex++
    this.openBlock = 'text'
    this.writeEvent('content_block_start', {
      type: 'content_block_start',
      index: this.blockIndex,
      content_block: { type: 'text', text: '' }
    })
  }

  text(delta: string): void {
    if (!delta) return
    this.openTextBlock()
    this.writeEvent('content_block_delta', {
      type: 'content_block_delta',
      index: this.blockIndex,
      delta: { type: 'text_delta', text: delta }
    })
  }

  thinking(delta: string): void {
    if (!delta) return
    if (this.openBlock !== 'thinking') {
      this.closeBlock()
      this.blockIndex++
      this.openBlock = 'thinking'
      this.writeEvent('content_block_start', {
        type: 'content_block_start',
        index: this.blockIndex,
        content_block: { type: 'thinking', thinking: '' }
      })
    }
    this.writeEvent('content_block_delta', {
      type: 'content_block_delta',
      index: this.blockIndex,
      delta: { type: 'thinking_delta', thinking: delta }
    })
  }

  /**
   * 工具调用整块发出：start（空 input）→ 一条 input_json_delta 带完整 JSON → stop。
   * 上游是分片给 input 的，但只有拼完才能保证是合法 JSON，
   * 边收边转发会让客户端解析到半截 JSON。
   */
  toolCall(call: StreamToolCall): void {
    this.closeBlock()
    this.blockIndex++
    this.writeEvent('content_block_start', {
      type: 'content_block_start',
      index: this.blockIndex,
      content_block: { type: 'tool_use', id: call.toolUseId, name: call.name, input: {} }
    })
    this.writeEvent('content_block_delta', {
      type: 'content_block_delta',
      index: this.blockIndex,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(call.input) }
    })
    this.writeEvent('content_block_stop', { type: 'content_block_stop', index: this.blockIndex })
  }

  /**
   * 服务端搜索的两个块：server_tool_use（搜了什么）+ web_search_tool_result（搜到什么）。
   * 格式照官方 API：server_tool_use 的 input 在 start 里一次给全，不走 input_json_delta；
   * 结果块同理整块给出。Claude Code 靠这两个块给搜索计数、取结果。
   */
  serverSearch(block: ServerSearchBlock): void {
    this.closeBlock()
    this.blockIndex++
    this.writeEvent('content_block_start', {
      type: 'content_block_start',
      index: this.blockIndex,
      content_block: { type: 'server_tool_use', id: block.id, name: 'web_search', input: { query: block.query } }
    })
    this.writeEvent('content_block_stop', { type: 'content_block_stop', index: this.blockIndex })
    this.blockIndex++
    this.writeEvent('content_block_start', {
      type: 'content_block_start',
      index: this.blockIndex,
      content_block: { type: 'web_search_tool_result', tool_use_id: block.id, content: block.results }
    })
    this.writeEvent('content_block_stop', { type: 'content_block_stop', index: this.blockIndex })
  }

  finish(stopReason: string, usage: StreamUsage & { webSearchRequests?: number }): void {
    this.closeBlock()
    this.writeEvent('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: {
        input_tokens: usage.inputTokens,
        output_tokens: usage.outputTokens,
        ...(usage.webSearchRequests ? { server_tool_use: { web_search_requests: usage.webSearchRequests } } : {})
      }
    })
    this.writeEvent('message_stop', { type: 'message_stop' })
  }

  error(message: string): void {
    this.writeEvent('error', { type: 'error', error: { type: 'api_error', message } })
  }
}

/** OpenAI Chat Completions 的 SSE：一串 chat.completion.chunk + [DONE] */
export class OpenAiSseWriter extends SseWriter {
  private readonly id = `chatcmpl-${randomUUID()}`
  private toolIndex = 0

  private chunk(delta: Record<string, unknown>, finishReason: string | null = null): void {
    this.writeEvent(null, {
      id: this.id,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: this.model,
      choices: [{ index: 0, delta, finish_reason: finishReason }]
    })
  }

  start(): void {
    this.chunk({ role: 'assistant', content: '' })
  }

  text(delta: string): void {
    if (delta) this.chunk({ content: delta })
  }

  /** OpenAI 没有标准的思考字段，跟随社区惯例用 reasoning_content */
  thinking(delta: string): void {
    if (delta) this.chunk({ reasoning_content: delta })
  }

  toolCall(call: StreamToolCall): void {
    this.chunk({
      tool_calls: [
        {
          index: this.toolIndex++,
          id: call.toolUseId,
          type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.input) }
        }
      ]
    })
  }

  finish(stopReason: string, usage: StreamUsage): void {
    this.writeEvent(null, {
      id: this.id,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: this.model,
      choices: [{ index: 0, delta: {}, finish_reason: openAiFinishReason(stopReason) }],
      usage: {
        prompt_tokens: usage.inputTokens,
        completion_tokens: usage.outputTokens,
        total_tokens: usage.inputTokens + usage.outputTokens
      }
    })
    this.writeEvent(null, '[DONE]')
  }

  error(message: string): void {
    this.writeEvent(null, { error: { message, type: 'server_error' } })
  }
}

/**
 * 归一 stopReason。
 * 上游给的是大写枚举（END_TURN / TOOL_USE），而两家客户端认的都是小写那套，
 * 原样透传会让 Claude Code 认不出这一轮是否结束。
 */
export function normalizeStopReason(raw: string, hasToolCalls: boolean): string {
  const value = String(raw || '').toLowerCase()
  if (hasToolCalls || value.includes('tool')) return 'tool_use'
  if (value.includes('max_token') || value === 'length' || value.includes('context_window')) {
    return 'max_tokens'
  }
  if (value.includes('stop_sequence')) return 'stop_sequence'
  return 'end_turn'
}

function openAiFinishReason(stopReason: string): string {
  if (stopReason === 'tool_use') return 'tool_calls'
  if (stopReason === 'max_tokens') return 'length'
  return 'stop'
}

// ============ 非流式响应 ============

export interface CollectedResult {
  /** 服务端搜索块（Anthropic），非流式时拼进 content；流式时已经边搜边发了 */
  searchBlocks?: ServerSearchBlock[]
  text: string
  thinking: string
  toolCalls: StreamToolCall[]
  stopReason: string
  usage: StreamUsage
}

export function buildAnthropicResponse(model: string, result: CollectedResult): Record<string, unknown> {
  const content: Record<string, unknown>[] = []
  if (result.thinking) content.push({ type: 'thinking', thinking: result.thinking })
  for (const block of result.searchBlocks ?? []) {
    content.push({ type: 'server_tool_use', id: block.id, name: 'web_search', input: { query: block.query } })
    content.push({ type: 'web_search_tool_result', tool_use_id: block.id, content: block.results })
  }
  if (result.text) content.push({ type: 'text', text: result.text })
  for (const call of result.toolCalls) {
    content.push({ type: 'tool_use', id: call.toolUseId, name: call.name, input: call.input })
  }
  // 一条内容都没有时补个空文本块，客户端普遍不接受空 content
  if (!content.length) content.push({ type: 'text', text: '' })

  return {
    id: `msg_${randomUUID().replace(/-/g, '')}`,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: result.stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: result.usage.inputTokens,
      output_tokens: result.usage.outputTokens,
      ...(result.searchBlocks?.length ? { server_tool_use: { web_search_requests: result.searchBlocks.length } } : {})
    }
  }
}

export function buildOpenAiResponse(model: string, result: CollectedResult): Record<string, unknown> {
  const message: Record<string, unknown> = {
    role: 'assistant',
    // 有工具调用时 content 必须是 null，部分客户端会因为空字符串报错
    content: result.toolCalls.length ? null : result.text
  }
  if (result.thinking) message.reasoning_content = result.thinking
  if (result.toolCalls.length) {
    message.tool_calls = result.toolCalls.map((call) => ({
      id: call.toolUseId,
      type: 'function',
      function: { name: call.name, arguments: JSON.stringify(call.input) }
    }))
  }

  return {
    id: `chatcmpl-${randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: openAiFinishReason(result.stopReason) }],
    usage: {
      prompt_tokens: result.usage.inputTokens,
      completion_tokens: result.usage.outputTokens,
      total_tokens: result.usage.inputTokens + result.usage.outputTokens
    }
  }
}

// ============ OpenAI Responses API（Codex 用的协议） ============
//
// Codex 0.158 起只剩 wire_api = "responses"，chat 已被移除，
// 所以反代必须自己实现 /v1/responses。实测 Codex 发来的请求形如：
//   { model, instructions, input: [message(developer|user|assistant) / function_call /
//     function_call_output / reasoning ...], tools: [function / namespace / web_search],
//     stream: true, store: false, ... }

/** Responses 的 content 是 [{type:'input_text'|'output_text'|'input_image'}] */
function responsesContent(content: unknown): { text: string; images: KiroImage[] } {
  if (typeof content === 'string') return { text: content, images: [] }
  if (!Array.isArray(content)) return { text: '', images: [] }
  const texts: string[] = []
  const images: KiroImage[] = []
  for (const raw of content) {
    const part = asRecord(raw)
    if (!part) continue
    if (part.type === 'input_text' || part.type === 'output_text' || part.type === 'text') {
      texts.push(str(part.text))
    } else if (part.type === 'input_image') {
      const image = imageFromDataUrl(str(part.image_url))
      if (image) images.push(image)
    }
  }
  return { text: texts.filter(Boolean).join('\n'), images }
}

/** function_call_output 的 output 可能是字符串，也可能是内容块数组 */
function responsesOutputText(output: unknown): { text: string; images: KiroImage[] } {
  if (typeof output === 'string') return { text: output, images: [] }
  if (Array.isArray(output)) return responsesContent(output)
  return { text: output == null ? '' : JSON.stringify(output), images: [] }
}

/** custom 工具（参数是整段文本）在 Kiro 侧的 schema：包成一个 input 字符串字段 */
function customToolSchema(tool: Record<string, unknown>): Record<string, unknown> {
  const format = asRecord(tool.format)
  const hint = str(format?.definition) || str(format?.syntax)
  return {
    type: 'object',
    properties: {
      input: {
        type: 'string',
        description: hint ? `Raw tool input. Format:\n${hint.slice(0, 4000)}` : 'Raw tool input'
      }
    },
    required: ['input']
  }
}

export function normalizeResponsesRequest(body: Record<string, unknown>): NormalizedRequest {
  const systemTexts: string[] = []
  if (typeof body.instructions === 'string') systemTexts.push(body.instructions)

  const messages: NormMessage[] = []
  const toolOrigins = new Map<string, ToolOrigin>()
  const tools: NormTool[] = []

  const addTool = (raw: unknown): void => {
    const tool = asRecord(raw)
    const name = str(tool?.name)
    if (!tool || !name || toolOrigins.has(name)) return
    if (tool.type === 'function') {
      tools.push({ name, description: str(tool.description), schema: asRecord(tool.parameters) ?? {} })
      toolOrigins.set(name, { name })
    } else if (tool.type === 'custom') {
      tools.push({ name, description: str(tool.description), schema: customToolSchema(tool) })
      toolOrigins.set(name, { name, custom: true })
    } else if (tool.type === 'namespace' && name === 'functions' && Array.isArray(tool.tools)) {
      // functions 是顶层工具的分组外壳，里面的工具按普通工具名调用
      for (const inner of tool.tools) addTool(inner)
    }
    /*
     * 其他 namespace（MCP / 插件工具分组）不转发：回传时需要 Codex 专有的命名空间字段，
     * 拼错了 Codex 会直接丢弃这次调用。
     * 核心的 exec_command / apply_patch / view_image 等都是普通 function，不受影响。
     */
  }

  // 工具先收集：input 里的 custom_tool_call 需要知道哪些名字是 custom 工具。
  // Responses Lite 把工具定义放在 input 的 additional_tools 项里，一并收集。
  for (const raw of Array.isArray(body.tools) ? body.tools : []) addTool(raw)
  for (const raw of Array.isArray(body.input) ? body.input : []) {
    const item = asRecord(raw)
    if (item?.type === 'additional_tools' && Array.isArray(item.tools)) {
      for (const tool of item.tools) addTool(tool)
    }
  }

  /*
   * web_search 是 OpenAI 设计成「服务端执行」的托管工具，Codex 只负责挂上去、
   * 等 provider 把结果一起返回。Kiro 的对话接口不执行它，但 Kiro 自己有搜索能力
   * （MCP 端点），所以这里把它当成普通 function 工具交给模型，
   * 模型调用时由反代拦下来实际去搜，见 proxyServer 的搜索循环。
   */
  const incomingToolTypes = (Array.isArray(body.tools) ? body.tools : []).map(
    (raw) => `${str(asRecord(raw)?.type) || '?'}:${str(asRecord(raw)?.name) || ''}`
  )
  log(
    'debug',
    `[Proxy] Responses body keys=${Object.keys(body).join(',')} | ` +
      `tools=${incomingToolTypes.join(', ') || '(无)'} | ` +
      `tool_choice=${JSON.stringify(body.tool_choice ?? null)} | ` +
      `include=${JSON.stringify(body.include ?? null)}`
  )

  /*
   * 客户端声明的托管搜索工具在上面已被跳过（它期望 provider 端执行，我们转发不了）。
   * 这里只把名字登记进 toolOrigins，保证反代注入同名工具时 Responses 的输出形状正确。
   * 真正的注入与执行都在 proxyServer，不依赖客户端是否声明，原因见那里的注释。
   */
  if (!toolOrigins.has(WEB_SEARCH_TOOL)) {
    toolOrigins.set(WEB_SEARCH_TOOL, { name: WEB_SEARCH_TOOL })
  }

  const push = (message: NormMessage): void => {
    messages.push(message)
  }

  for (const raw of typeof body.input === 'string'
    ? [{ type: 'message', role: 'user', content: body.input }]
    : Array.isArray(body.input)
      ? body.input
      : []) {
    const item = asRecord(raw)
    if (!item) continue
    // 没写 type 的项按 message 处理（Responses 允许省略）
    const type = str(item.type) || 'message'

    if (type === 'message') {
      const role = str(item.role)
      const { text, images } = responsesContent(item.content)
      if (role === 'developer' || role === 'system') {
        if (text) systemTexts.push(text)
        continue
      }
      const message = emptyMessage(role === 'assistant' ? 'assistant' : 'user')
      message.text = text
      message.images.push(...images)
      push(message)
      continue
    }

    // 往轮的托管搜索：Kiro 没有这种项，压成一句文本，模型才知道之前搜过什么
    if (type === 'web_search_call') {
      const query = str(asRecord(item.action)?.query)
      if (query) {
        const message = emptyMessage('assistant')
        message.text = `[web_search] ${query}`
        push(message)
      }
      continue
    }

    if (type === 'function_call' || type === 'custom_tool_call') {
      const message = emptyMessage('assistant')
      let input: Record<string, unknown> = {}
      if (type === 'custom_tool_call') {
        input = { input: str(item.input) }
      } else {
        try {
          input = asRecord(JSON.parse(str(item.arguments) || '{}')) ?? {}
        } catch {
          input = {}
        }
      }
      message.toolUses.push({ toolUseId: str(item.call_id), name: str(item.name), input })
      push(message)
      continue
    }

    if (type === 'function_call_output' || type === 'custom_tool_call_output') {
      const { text, images } = responsesOutputText(item.output)
      const message = emptyMessage('user')
      message.toolResults.push({
        toolUseId: str(item.call_id),
        content: [{ text: text || TOOL_IMAGE_PLACEHOLDER }],
        status: 'success'
      })
      message.images.push(...images)
      push(message)
      continue
    }
    // reasoning / local_shell_call 等其余项：Kiro 没有对应结构，跳过
  }

  const reasoning = asRecord(body.reasoning)
  return {
    model: str(body.model),
    // Responses API 默认非流式；Codex 总是显式带 stream: true
    stream: body.stream === true,
    system: systemTexts.filter(Boolean).join('\n\n'),
    messages,
    tools,
    maxTokens: typeof body.max_output_tokens === 'number' ? body.max_output_tokens : undefined,
    thinking: !!reasoning && str(reasoning.effort) !== '' && reasoning.effort !== 'none',
    effort: str(reasoning?.effort) || undefined,
    toolOrigins,
    sessionHint: str(body.prompt_cache_key).trim() || str(body.user).trim() || undefined
  }
}

/** Responses 的 usage 形状：Codex 会读 input_tokens_details / output_tokens_details */
function responsesUsage(usage: StreamUsage): Record<string, unknown> {
  return {
    input_tokens: usage.inputTokens,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: usage.outputTokens,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: usage.inputTokens + usage.outputTokens
  }
}

/** 把一次工具调用还原成客户端认得的输出项 */
function responsesToolItem(
  call: StreamToolCall,
  origins: Map<string, ToolOrigin> | undefined,
  status: 'in_progress' | 'completed'
): Record<string, unknown> {
  const origin = origins?.get(call.name)
  const id = `fc_${call.toolUseId.replace(/[^A-Za-z0-9_-]/g, '')}`
  if (origin?.custom) {
    return {
      type: 'custom_tool_call',
      id,
      call_id: call.toolUseId,
      name: origin.name,
      input: status === 'completed' ? str(call.input.input) : '',
      status
    }
  }
  return {
    type: 'function_call',
    id,
    call_id: call.toolUseId,
    name: origin?.name ?? call.name,
    arguments: status === 'completed' ? JSON.stringify(call.input) : '',
    status
  }
}

/**
 * Responses API 的 SSE。
 *
 * Codex 真正依赖的是这几件事：
 *  - 每个事件都带 `type`，并且和 `event:` 行一致
 *  - 文本走 response.output_text.delta，结束时 response.output_item.done 给完整 message
 *  - 工具调用在 response.output_item.done 里给出完整的 function_call
 *  - 最后必须有 response.completed，否则 Codex 判定「流在完成前被关闭」并重连
 */
export class ResponsesSseWriter extends SseWriter {
  private readonly responseId = `resp_${randomUUID().replace(/-/g, '')}`
  private readonly createdAt = Math.floor(Date.now() / 1000)
  private sequence = 0
  private outputIndex = 0
  private readonly output: Record<string, unknown>[] = []
  /** 正在输出的文本消息；工具调用插进来时要先把它收尾 */
  private message: { id: string; index: number; text: string } | null = null
  private reasoning: { id: string; index: number; text: string } | null = null

  constructor(
    res: ServerResponse,
    model: string,
    private readonly origins?: Map<string, ToolOrigin>
  ) {
    super(res, model)
  }

  private emit(type: string, payload: Record<string, unknown>): void {
    this.writeEvent(type, { type, sequence_number: this.sequence++, ...payload })
  }

  private snapshot(status: string, usage?: StreamUsage): Record<string, unknown> {
    return {
      id: this.responseId,
      object: 'response',
      created_at: this.createdAt,
      status,
      model: this.model,
      output: status === 'in_progress' ? [] : this.output,
      ...(usage ? { usage: responsesUsage(usage) } : {})
    }
  }

  start(): void {
    this.emit('response.created', { response: this.snapshot('in_progress') })
    this.emit('response.in_progress', { response: this.snapshot('in_progress') })
  }

  private closeReasoning(): void {
    if (!this.reasoning) return
    const { id, index, text } = this.reasoning
    const item = { type: 'reasoning', id, summary: [{ type: 'summary_text', text }] }
    this.emit('response.reasoning_summary_text.done', {
      item_id: id,
      output_index: index,
      summary_index: 0,
      text
    })
    this.emit('response.output_item.done', { output_index: index, item })
    this.output.push(item)
    this.reasoning = null
  }

  private closeMessage(): void {
    if (!this.message) return
    const { id, index, text } = this.message
    const part = { type: 'output_text', text, annotations: [] }
    this.emit('response.output_text.done', {
      item_id: id,
      output_index: index,
      content_index: 0,
      text
    })
    this.emit('response.content_part.done', {
      item_id: id,
      output_index: index,
      content_index: 0,
      part
    })
    const item = { type: 'message', id, role: 'assistant', status: 'completed', content: [part] }
    this.emit('response.output_item.done', { output_index: index, item })
    this.output.push(item)
    this.message = null
  }

  text(delta: string): void {
    if (!delta) return
    this.closeReasoning()
    if (!this.message) {
      const id = `msg_${randomUUID().replace(/-/g, '')}`
      const index = this.outputIndex++
      this.message = { id, index, text: '' }
      this.emit('response.output_item.added', {
        output_index: index,
        item: { type: 'message', id, role: 'assistant', status: 'in_progress', content: [] }
      })
      this.emit('response.content_part.added', {
        item_id: id,
        output_index: index,
        content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] }
      })
    }
    this.message.text += delta
    this.emit('response.output_text.delta', {
      item_id: this.message.id,
      output_index: this.message.index,
      content_index: 0,
      delta
    })
  }

  /** 推理内容作为 reasoning 项的 summary 下发，Codex 会在界面上显示成「思考」 */
  thinking(delta: string): void {
    if (!delta) return
    if (!this.reasoning) {
      this.closeMessage()
      const id = `rs_${randomUUID().replace(/-/g, '')}`
      const index = this.outputIndex++
      this.reasoning = { id, index, text: '' }
      this.emit('response.output_item.added', {
        output_index: index,
        item: { type: 'reasoning', id, summary: [] }
      })
      this.emit('response.reasoning_summary_part.added', {
        item_id: id,
        output_index: index,
        summary_index: 0,
        part: { type: 'summary_text', text: '' }
      })
    }
    this.reasoning.text += delta
    this.emit('response.reasoning_summary_text.delta', {
      item_id: this.reasoning.id,
      output_index: this.reasoning.index,
      summary_index: 0,
      delta
    })
  }

  toolCall(call: StreamToolCall): void {
    this.closeReasoning()
    this.closeMessage()
    const index = this.outputIndex++
    const pending = responsesToolItem(call, this.origins, 'in_progress')
    const done = responsesToolItem(call, this.origins, 'completed')
    this.emit('response.output_item.added', { output_index: index, item: pending })
    if (done.type === 'function_call') {
      this.emit('response.function_call_arguments.delta', {
        item_id: done.id,
        output_index: index,
        delta: done.arguments
      })
      this.emit('response.function_call_arguments.done', {
        item_id: done.id,
        output_index: index,
        arguments: done.arguments
      })
    } else {
      this.emit('response.custom_tool_call_input.delta', {
        item_id: done.id,
        output_index: index,
        delta: done.input
      })
      this.emit('response.custom_tool_call_input.done', {
        item_id: done.id,
        output_index: index,
        input: done.input
      })
    }
    this.emit('response.output_item.done', { output_index: index, item: done })
    this.output.push(done)
  }

  /**
   * 一次反代代为执行的搜索，按 OpenAI 托管工具的原生形状（web_search_call）告诉 Codex。
   * Codex 据此在界面上显示「Searched: …」，否则用户看不出模型到底搜没搜。
   * 只用 search 这一种 action，它是 Codex 反序列化里最早支持的那种。
   */
  webSearchCall(query: string): void {
    this.closeReasoning()
    this.closeMessage()
    const index = this.outputIndex++
    const id = `ws_${randomUUID().replace(/-/g, '')}`
    const item = { type: 'web_search_call', id, status: 'completed', action: { type: 'search', query } }
    this.emit('response.output_item.added', { output_index: index, item: { ...item, status: 'in_progress' } })
    this.emit('response.output_item.done', { output_index: index, item })
    this.output.push(item)
  }

  finish(_stopReason: string, usage: StreamUsage): void {
    this.closeReasoning()
    this.closeMessage()
    this.emit('response.completed', { response: this.snapshot('completed', usage) })
  }

  /**
   * 流中途失败：Codex 认 response.failed，会把错误原文展示给用户。
   *
   * code 决定 Codex 要不要重连：server_error 会被当成临时故障重连 5 次，
   * 额度用尽这种重试一百次也没用的错误要给 insufficient_quota，Codex 才会立刻停下。
   */
  error(message: string, status?: number): void {
    this.emit('response.failed', {
      response: {
        ...this.snapshot('failed'),
        error: { code: responsesErrorCode(message, status), message }
      }
    })
  }
}

/** 按错误性质给 Responses 的 error.code，决定 Codex 是否重连 */
function responsesErrorCode(message: string, status?: number): string {
  if (status === 402 || /monthly_request_count|reached the limit|quota/i.test(message)) {
    return 'insufficient_quota'
  }
  if (/input is too long|content_length_exceeds|context/i.test(message)) {
    return 'context_length_exceeded'
  }
  if (status === 401 || status === 403) return 'invalid_api_key'
  if (status === 429) return 'rate_limit_exceeded'
  return 'server_error'
}

/** 非流式的 Responses 结果 */
export function buildResponsesResponse(
  model: string,
  result: CollectedResult,
  origins?: Map<string, ToolOrigin>
): Record<string, unknown> {
  const output: Record<string, unknown>[] = []
  if (result.thinking) {
    output.push({
      type: 'reasoning',
      id: `rs_${randomUUID().replace(/-/g, '')}`,
      summary: [{ type: 'summary_text', text: result.thinking }]
    })
  }
  if (result.text) {
    output.push({
      type: 'message',
      id: `msg_${randomUUID().replace(/-/g, '')}`,
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: result.text, annotations: [] }]
    })
  }
  for (const call of result.toolCalls) output.push(responsesToolItem(call, origins, 'completed'))

  return {
    id: `resp_${randomUUID().replace(/-/g, '')}`,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: 'completed',
    model,
    output,
    output_text: result.text,
    usage: responsesUsage(result.usage)
  }
}

// ============ Gemini（v1beta generateContent） ============
//
// 路径：POST /v1beta/models/{model}:generateContent
//       POST /v1beta/models/{model}:streamGenerateContent?alt=sse
// 模型名在 URL 里，不在请求体里。请求体形如：
//   { contents: [{ role: 'user'|'model', parts: [{text} | {inlineData} | {functionCall} | {functionResponse}] }],
//     systemInstruction: { parts: [{text}] },
//     tools: [{ functionDeclarations: [{ name, description, parameters }] }],
//     generationConfig: { maxOutputTokens, thinkingConfig: { thinkingBudget, includeThoughts } } }
//
// 和另外三家最大的不同：functionResponse 只带函数名，没有调用 id。
// Kiro 那边的 toolResult 必须用 toolUseId 对上前一轮的 toolUse，
// 所以这里给每个 functionCall 现编一个 id，再按「同名、先进先出」把后面的 functionResponse 配回去。

function geminiParts(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? (value.map(asRecord).filter(Boolean) as Record<string, unknown>[]) : []
}

export function normalizeGeminiRequest(
  body: Record<string, unknown>,
  model: string,
  stream: boolean
): NormalizedRequest {
  const system = geminiParts(asRecord(body.systemInstruction)?.parts ?? asRecord(body.system_instruction)?.parts)
    .map((part) => str(part.text))
    .filter(Boolean)
    .join('\n')

  const messages: NormMessage[] = []
  /** 函数名 → 还没被回应的调用 id，按调用顺序 */
  const pending = new Map<string, string[]>()
  let callSeq = 0

  for (const raw of Array.isArray(body.contents) ? body.contents : []) {
    const content = asRecord(raw)
    if (!content) continue
    const message = emptyMessage(content.role === 'model' ? 'assistant' : 'user')
    const texts: string[] = []

    for (const part of geminiParts(content.parts)) {
      // 模型自己的思考过程不回灌：Kiro 没有对应的历史字段，塞进正文会被当成回答的一部分
      if (part.thought === true) continue
      if (typeof part.text === 'string') {
        texts.push(part.text)
        continue
      }
      const inline = asRecord(part.inlineData) ?? asRecord(part.inline_data)
      if (inline) {
        const mime = str(inline.mimeType) || str(inline.mime_type)
        const data = str(inline.data)
        if (data && mime.startsWith('image/')) {
          message.images.push({ format: normalizeImageFormat(mime.slice(6)), source: { bytes: data } })
        }
        continue
      }
      const call = asRecord(part.functionCall) ?? asRecord(part.function_call)
      if (call) {
        const name = str(call.name)
        const id = str(call.id) || `call_${++callSeq}_${name}`
        const queue = pending.get(name) ?? []
        queue.push(id)
        pending.set(name, queue)
        message.toolUses.push({ toolUseId: id, name, input: asRecord(call.args) ?? {} })
        continue
      }
      const response = asRecord(part.functionResponse) ?? asRecord(part.function_response)
      if (response) {
        const name = str(response.name)
        const id = str(response.id) || pending.get(name)?.shift() || `call_${++callSeq}_${name}`
        const payload = response.response
        message.toolResults.push({
          toolUseId: id,
          content: [{ text: typeof payload === 'string' ? payload : JSON.stringify(payload ?? {}) }],
          status: 'success'
        })
      }
    }
    message.text = texts.filter(Boolean).join('\n')
    messages.push(message)
  }

  const tools: NormTool[] = []
  for (const rawTool of Array.isArray(body.tools) ? body.tools : []) {
    const tool = asRecord(rawTool)
    const decls = tool?.functionDeclarations ?? tool?.function_declarations
    for (const decl of geminiParts(decls)) {
      const name = str(decl.name)
      if (!name) continue
      tools.push({
        name,
        description: str(decl.description),
        schema: asRecord(decl.parameters) ?? asRecord(decl.parametersJsonSchema) ?? {}
      })
    }
  }

  const generation = asRecord(body.generationConfig) ?? asRecord(body.generation_config)
  const thinkingConfig = asRecord(generation?.thinkingConfig) ?? asRecord(generation?.thinking_config)
  const budget =
    typeof thinkingConfig?.thinkingBudget === 'number' ? thinkingConfig.thinkingBudget : undefined
  const level = str(thinkingConfig?.thinkingLevel).toLowerCase()

  return {
    model,
    stream,
    system,
    messages,
    tools,
    maxTokens:
      typeof generation?.maxOutputTokens === 'number' ? generation.maxOutputTokens : undefined,
    // budget 为 0 在 Gemini 里就是「关掉思考」
    thinking: thinkingConfig?.includeThoughts === true || (budget !== undefined && budget > 0) || !!level,
    effort: level || undefined,
    thinkingBudget: budget && budget > 0 ? budget : undefined
  }
}

function geminiFinishReason(stopReason: string): string {
  return stopReason === 'max_tokens' ? 'MAX_TOKENS' : 'STOP'
}

function geminiUsage(usage: StreamUsage): Record<string, unknown> {
  return {
    promptTokenCount: usage.inputTokens,
    candidatesTokenCount: usage.outputTokens,
    totalTokenCount: usage.inputTokens + usage.outputTokens
  }
}

function geminiCallPart(call: StreamToolCall): Record<string, unknown> {
  return { functionCall: { id: call.toolUseId, name: call.name, args: call.input } }
}

/**
 * streamGenerateContent?alt=sse：每个 data 都是一个完整的 GenerateContentResponse，
 * 只是 parts 里放的是增量。最后一块带 finishReason 和 usageMetadata。
 */
export class GeminiSseWriter extends SseWriter {
  private candidate(parts: Record<string, unknown>[], extra: Record<string, unknown> = {}): void {
    this.writeEvent(null, {
      candidates: [{ content: { role: 'model', parts }, index: 0, ...extra }],
      modelVersion: this.model
    })
  }

  start(): void {
    /*
     * Gemini 的流没有「开始」事件，第一块就是内容。但这里必须把 started 置上：
     * 调用方靠 flushed 判断 SSE 头有没有发过，另外三家的 start() 都会写一个开场事件顺带置位，
     * 只有这里什么都不写。不置位的话下一个增量会再 writeHead 一次，抛
     * ERR_HTTP_HEADERS_SENT，客户端拿到的是一个空的 200。
     */
    this.started = true
  }

  text(delta: string): void {
    if (delta) this.candidate([{ text: delta }])
  }

  thinking(delta: string): void {
    if (delta) this.candidate([{ text: delta, thought: true }])
  }

  toolCall(call: StreamToolCall): void {
    this.candidate([geminiCallPart(call)])
  }

  finish(stopReason: string, usage: StreamUsage): void {
    this.writeEvent(null, {
      candidates: [
        { content: { role: 'model', parts: [{ text: '' }] }, finishReason: geminiFinishReason(stopReason), index: 0 }
      ],
      usageMetadata: geminiUsage(usage),
      modelVersion: this.model
    })
  }

  error(message: string): void {
    this.writeEvent(null, { error: { code: 500, message, status: 'INTERNAL' } })
  }
}

export function buildGeminiResponse(model: string, result: CollectedResult): Record<string, unknown> {
  const parts: Record<string, unknown>[] = []
  if (result.thinking) parts.push({ text: result.thinking, thought: true })
  if (result.text) parts.push({ text: result.text })
  for (const call of result.toolCalls) parts.push(geminiCallPart(call))
  if (!parts.length) parts.push({ text: '' })
  return {
    candidates: [
      { content: { role: 'model', parts }, finishReason: geminiFinishReason(result.stopReason), index: 0 }
    ],
    usageMetadata: geminiUsage(result.usage),
    modelVersion: model
  }
}
