// 本地反代的模型映射：客户端写什么模型名，实际发给 Kiro 的是哪个
import type { ModelEffort } from './modelSchema'
//
// 各家 agent 发过来的模型名五花八门：Claude Code 用带日期的官方名
// （claude-sonnet-4-5-20250929），Codex 用 gpt-5 系，还有人手写 claude-3-5-sonnet。
// Kiro 只认自己那套点号命名（claude-sonnet-4.5），名字给错会直接 400，
// 所以这里统一做一次归一 + 别名映射，主进程与界面共用同一份表。

/**
 * 还没从账号拉到模型列表时的兜底：保证下拉框与 /v1/models 不是空的。
 * 真实可用的模型以「刷新模型」拉回来的为准（通常有二十来个，含 GPT 等非 Claude 模型）。
 */
export const FALLBACK_MODEL_IDS = [
  'auto',
  'claude-sonnet-4.5',
  'claude-sonnet-4',
  'claude-haiku-4.5',
  'claude-opus-4.5'
] as const

/**
 * 客户端模型名 -> Kiro 模型 id 的别名表。
 * 键一律小写，匹配前先把请求里的名字转小写。
 */
const ALIASES: Record<string, string> = {
  // Claude Code 常用的官方带日期名
  'claude-sonnet-4-5-20250929': 'claude-sonnet-4.5',
  'claude-haiku-4-5-20251001': 'claude-haiku-4.5',
  'claude-opus-4-5-20251101': 'claude-opus-4.5',
  'claude-sonnet-4-20250514': 'claude-sonnet-4',
  // 老一代名字：没有对应档位，落到最接近的可用模型
  'claude-3-5-sonnet': 'claude-sonnet-4.5',
  'claude-3-5-sonnet-latest': 'claude-sonnet-4.5',
  'claude-3-opus': 'claude-opus-4.5',
  'claude-3-sonnet': 'claude-sonnet-4',
  'claude-3-haiku': 'claude-haiku-4.5',
  'claude-sonnet-latest': 'claude-sonnet-4.5',
  'claude-opus-latest': 'claude-opus-4.5',
  // Codex / OpenAI 系：Kiro 没有 GPT，统一走 sonnet
  'gpt-4': 'claude-sonnet-4.5',
  'gpt-4o': 'claude-sonnet-4.5',
  'gpt-4o-mini': 'claude-haiku-4.5',
  'gpt-4-turbo': 'claude-sonnet-4.5',
  'gpt-4.1': 'claude-sonnet-4.5',
  'gpt-5': 'claude-sonnet-4.5',
  'gpt-5-codex': 'claude-sonnet-4.5',
  'gpt-5-mini': 'claude-haiku-4.5',
  'gpt-3.5-turbo': 'claude-haiku-4.5',
  o3: 'claude-opus-4.5',
  'o4-mini': 'claude-haiku-4.5'
}

/** 带 -thinking 后缀表示要求推理，去掉后缀参与映射 */
const THINKING_SUFFIX = '-thinking'

/**
 * Cursor BYOK 客户端前缀：Cursor 免费版对 claude-sonnet-4.5 等「高级」模型名
 * 弹升级框（Named models unavailable），但对它不认识的名字就放行。
 * 反代把每个模型多注册一份 kiro-xxx 的别名，Cursor 选它就不触发拦截；
 * 收到请求时剥掉前缀，还原成真实模型名发给上游。
 */
const CURSOR_PREFIX = 'kiro-'

export interface MappedModel {
  /** 发给 Kiro 的模型 id */
  modelId: string
  /** 客户端是否要求推理（模型名带 -thinking 后缀） */
  thinking: boolean
  /** 没命中任何规则，用了兜底模型 */
  fallback: boolean
}

/**
 * 把客户端的模型名映射成 Kiro 模型 id。
 *
 * 顺序：去 -thinking 后缀 → 别名表 → 把版本号里的短横改成点号
 * （claude-sonnet-4-5 → claude-sonnet-4.5，日期后缀不动）→ 命中已知 id 就用，
 * 否则回落到 fallbackModel。
 */
export function mapProxyModel(
  raw: string,
  fallbackModel: string,
  /** 从账号拉到的真实模型 id；为空时用兜底表判断 */
  knownIds: readonly string[] = FALLBACK_MODEL_IDS
): MappedModel {
  /*
   * 去掉 Claude Code 的 [1m] 上下文后缀：一键写入会给 1M 模型加上它（见 proxyClients 的 claudeCodeModel），
   * 官方说发请求前会自己去掉，这里再兜一次，免得哪个版本原样发来、落到兜底模型上。
   */
  const input = String(raw || '').trim().replace(/\[1m\]$/i, '')
  const lower = input.toLowerCase()
  const thinking = lower.endsWith(THINKING_SUFFIX)
  const base = thinking ? lower.slice(0, -THINKING_SUFFIX.length) : lower

  // Cursor 前缀：kiro-claude-sonnet-4.5 → claude-sonnet-4.5
  const stripped = base.startsWith(CURSOR_PREFIX) ? base.slice(CURSOR_PREFIX.length) : base

  if (!stripped) return { modelId: fallbackModel, thinking, fallback: true }
  if (stripped === 'auto' || stripped === 'default') return { modelId: 'auto', thinking, fallback: false }

  // 大小写不敏感地查真实列表，命中就用上游原本的写法
  const known = new Map(knownIds.map((id) => [id.toLowerCase(), id]))

  /*
   * 真实列表优先于别名表：账号本身就有 gpt-5.6-sol 这类模型时，
   * 客户端点名要它就该给它，不能被「gpt-* 一律映射到 sonnet」的别名截走。
   */
  const exact = known.get(stripped)
  if (exact) return { modelId: exact, thinking, fallback: false }

  // claude-sonnet-4-5 → claude-sonnet-4.5；只转 1~2 位的 minor，避免误伤日期
  const dotted = stripped.replace(/^(claude-(?:sonnet|haiku|opus))-(\d+)-(\d{1,2})(?=$|[^\d])/, '$1-$2.$3')
  const dottedHit = known.get(dotted)
  if (dottedHit) return { modelId: dottedHit, thinking, fallback: false }

  // 带日期快照的官方名（claude-opus-4-8-20260101）：去掉日期再查一次
  const undated = dotted.replace(/-\d{8}$/, '')
  const undatedHit = known.get(undated)
  if (undatedHit) return { modelId: undatedHit, thinking, fallback: false }

  const alias = ALIASES[stripped]
  if (alias) return { modelId: known.get(alias) ?? alias, thinking, fallback: false }
  // 形如 claude-opus-4.7 这类本表还没收录的新模型：原样透传，由上游判断
  if (/^claude-(sonnet|haiku|opus)-\d/.test(dotted)) {
    return { modelId: dotted, thinking, fallback: false }
  }

  return { modelId: fallbackModel, thinking, fallback: true }
}

// ============ 推理档位 ============

/**
 * 档位的强弱顺序，用于「客户端要的档位该模型没有」时就近取值。
 * none / minimal 最弱，max 最强；不在表里的上游新档位按原样处理，不参与就近。
 */
const EFFORT_ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/**
 * Anthropic thinking.budget_tokens → 档位。
 * Claude Code 旧版只发预算不发档位，按预算大小折算，分界与 Claude 官方文档的推荐预算大致对齐。
 */
export function effortFromBudget(budget: number): string {
  if (budget <= 4_000) return 'low'
  if (budget <= 16_000) return 'medium'
  if (budget <= 32_000) return 'high'
  if (budget <= 64_000) return 'xhigh'
  return 'max'
}

/**
 * 在模型支持的档位里找最接近 wanted 的那个。
 *
 * 客户端要的档位不一定每个模型都有：Codex 统一发 xhigh，而 4.6 及更早的 Claude 没有 xhigh；
 * Claude 没有 none。原样透传会 400，直接丢掉又等于偷偷降成默认档，
 * 所以取「不超过它的最强档」，都比它强时取最弱的那个。
 */
export function nearestEffort(wanted: string, options: readonly string[]): string | undefined {
  if (!options.length) return undefined
  if (options.includes(wanted)) return wanted
  const rank = EFFORT_ORDER.indexOf(wanted)
  if (rank < 0) return undefined
  const ranked = options
    .map((option) => ({ option, rank: EFFORT_ORDER.indexOf(option) }))
    .filter((item) => item.rank >= 0)
    .sort((a, b) => a.rank - b.rank)
  if (!ranked.length) return undefined
  const lower = ranked.filter((item) => item.rank <= rank)
  return (lower.length ? lower[lower.length - 1] : ranked[0]).option
}

export interface EffortInput {
  /** 最终发给 Kiro 的模型 */
  modelId: string
  /** 该模型的档位 schema；没有表示这个模型不支持档位 */
  schema?: ModelEffort
  /** 客户端显式点名的档位 */
  requested?: string
  /** Anthropic 的 thinking.budget_tokens */
  budget?: number
  /** 界面里为默认模型设的档位 */
  configured?: string
  /** 这次用的是不是界面里的默认模型（强制模式或客户端点的正好是它） */
  isDefaultModel: boolean
}

/**
 * 决定这次请求用哪个推理档位。
 *
 * 优先级：客户端显式点名 > 客户端给的思考预算 > 界面里为默认模型配的档位 > 不带（上游默认）。
 * 客户端是跑任务的那一方，它按场景切档位（Codex 的 /model 就能选），界面的配置只是兜底。
 * 返回 undefined 表示不带该字段——该模型没有档位这一层时带上会 400。
 */
export function resolveEffort(input: EffortInput): string | undefined {
  const options = input.schema?.options ?? []
  if (!options.length) return undefined

  const wanted =
    input.requested ||
    (typeof input.budget === 'number' ? effortFromBudget(input.budget) : '') ||
    (input.isDefaultModel ? input.configured : '')
  if (!wanted) return undefined
  return nearestEffort(wanted.toLowerCase(), options)
}

export { CURSOR_PREFIX }

/** 粗略估算 token 数：中日韩按 1 字 ≈ 1.5 token，其余按 4 字 ≈ 1 token */
export function estimateTokens(text: string): number {
  if (!text) return 0
  let cjk = 0
  let rest = 0
  for (const ch of text) {
    if (/[\u3000-\u9fff\uac00-\ud7af\uff00-\uffef]/.test(ch)) cjk++
    else rest++
  }
  return Math.ceil(cjk * 1.5 + rest / 4)
}
