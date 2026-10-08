import type { AccountStatus, IdpType, KeyStatus, SubscriptionType } from '@shared/types'

/** 打码结果缓存：账号多、重渲染频繁，避免反复算 md5 */
const maskedEmailCache = new Map<string, string>()

/**
 * 邮箱打码：前缀取邮箱 md5 的前 10 位，其中中间 6 位用 * 隐藏，
 * 域名统一替换为 ***.com。同一邮箱结果稳定，便于横向比对。
 */
export function maskEmail(email: string): string {
  if (!email) return ''

  const cached = maskedEmailCache.get(email)
  if (cached) return cached

  let head: string
  const hash = window.api?.md5?.(email)
  if (hash) {
    const prefix = hash.slice(0, 10)
    head = `${prefix.slice(0, 2)}******${prefix.slice(8, 10)}`
  } else {
    // 防御性分支：preload 正常注入时不会走到，
    // 万一 md5 缺失也不能把邮箱原文露出去
    const name = email.split('@')[0] ?? ''
    head = `${name.slice(0, 2)}${'*'.repeat(Math.max(3, name.length - 2))}`
  }

  const masked = `${head}@***.com`
  maskedEmailCache.set(email, masked)
  return masked
}

/**
 * 昵称 / 账号名打码：直接取打码邮箱 @ 前面的那段，
 * 这样同一账号的邮箱与昵称在界面上呈现同一串遮罩，便于横向比对。
 */
export function maskNickname(email: string): string {
  return maskEmail(email).split('@')[0] ?? ''
}

/**
 * 积分数值。
 * 开启「积分两位小数」时固定保留两位，否则四舍五入到整数。
 */
export function formatCredits(value: number | undefined, precision = false): string {
  if (value == null || Number.isNaN(value)) return '-'
  return precision ? value.toFixed(2) : String(Math.round(value))
}

/**
 * 模型消耗倍率，来自上游 Model.rateMultiplier。
 * 整数去掉多余小数（1 → 1x），小数保留两位以内（0.33 → 0.33x）。
 * auto 之类不返回倍率的模型返回空串，由调用方决定是否显示。
 */
export function formatRate(rate?: number): string {
  if (rate == null || Number.isNaN(rate)) return ''
  const text = Number.isInteger(rate) ? String(rate) : String(Number(rate.toFixed(2)))
  return `${text}x`
}

/**
 * 「已用 / 总额」的统一写法，界面上到处都在用这个组合。
 * @param compact 去掉斜杠两侧空格，用于空间紧张的表格列
 */
export function formatCreditsPair(
  current: number | undefined,
  limit: number | undefined,
  precision = false,
  compact = false
): string {
  const separator = compact ? '/' : ' / '
  return `${formatCredits(current, precision)}${separator}${formatCredits(limit, precision)}`
}

/**
 * 更新时间显示：当天只给时分秒，跨天则补上年月日。
 * nowMs 显式传入，便于配合响应式时钟在跨天后自动切换格式。
 */
export function formatCheckedAt(ts?: number, nowMs: number = Date.now()): string {
  if (!ts) return '从未'
  const date = new Date(ts)
  if (Number.isNaN(date.getTime())) return '-'

  const pad = (n: number): string => String(n).padStart(2, '0')
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`

  const today = new Date(nowMs)
  const sameDay =
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate()
  if (sameDay) return clock

  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${clock}`
}

export function formatDate(ts?: number | string): string {
  if (!ts) return '-'
  const date = new Date(ts)
  if (Number.isNaN(date.getTime())) return '-'
  return date.toISOString().slice(0, 10)
}

/**
 * 固定格式的年月日时分秒（YYYY-MM-DD HH:mm:ss）。
 * 与 formatDateTime 的区别是不走 toLocaleString：后者在中文环境下给出
 * 「2026/8/16 14:00:53」这种月日不补零的形式，列表里对不齐。
 */
export function formatFullDateTime(ts?: number | string): string {
  if (!ts) return '-'
  const date = new Date(ts)
  if (Number.isNaN(date.getTime())) return '-'
  const pad = (n: number): string => String(n).padStart(2, '0')
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  )
}

/** 本地时区的完整日期时间，用于悬浮提示里给出精确时间 */
export function formatDateTime(ts?: number | string): string {
  if (!ts) return '-'
  const date = new Date(ts)
  if (Number.isNaN(date.getTime())) return '-'
  return date.toLocaleString('zh-CN', { hour12: false })
}

/** 日志行用的时间戳：MM-DD HH:mm:ss.SSS，毫秒能看出同一批请求的先后 */
export function formatLogTime(ts: number): string {
  const date = new Date(ts)
  if (Number.isNaN(date.getTime())) return '-'
  const pad = (n: number, width = 2): string => String(n).padStart(width, '0')
  return (
    `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.` +
    pad(date.getMilliseconds(), 3)
  )
}

/**
 * 相对时间：秒 → 分 → 时分 → 天 → 月 → 年。
 * nowMs 显式传入是为了让调用方能用响应式的「当前时间」触发重算。
 */
export function relativeTime(ts?: number, nowMs: number = Date.now()): string {
  if (!ts) return '从未'
  const diff = nowMs - ts
  // 时钟回拨或数据来自未来时，不显示负数
  if (diff < 0) return '刚刚'

  const seconds = Math.floor(diff / 1000)
  if (seconds < 60) return `${seconds} 秒前`

  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟前`

  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    const restMinutes = minutes % 60
    return restMinutes ? `${hours} 小时 ${restMinutes} 分钟前` : `${hours} 小时前`
  }

  const days = Math.floor(hours / 24)
  if (days < 30) return `${days} 天前`

  const months = Math.floor(days / 30)
  if (months < 12) return `${months} 个月前`

  return `${Math.floor(days / 365)} 年前`
}

export const STATUS_META: Record<AccountStatus, { text: string; color: string }> = {
  active: { text: '正常', color: 'green' },
  expired: { text: '已过期', color: 'orange' },
  error: { text: '异常', color: 'red' },
  banned: { text: '已封禁', color: 'volcano' },
  unknown: { text: '未检查', color: 'default' }
}

export const SUBSCRIPTION_META: Record<SubscriptionType, { text: string; color: string }> = {
  Free: { text: 'Free', color: 'default' },
  Pro: { text: 'Pro', color: 'blue' },
  Pro_Plus: { text: 'Pro+', color: 'purple' },
  Pro_Max: { text: 'Pro Max', color: 'magenta' },
  // Power 用 gold，与 API Key 页的配色一致
  Power: { text: 'Power', color: 'gold' },
  Teams: { text: 'Teams', color: 'cyan' },
  // 学生号：接口标题是 KIRO STUDENT，这里与其余档位一样用英文原名
  Student: { text: 'Student', color: 'green' }
}

/**
 * 取订阅档位的展示元数据。
 *
 * 各处都要走这里，不要直接索引 SUBSCRIPTION_META：磁盘上可能留着已废弃的档位值
 * （例如旧数据里 Power 账号存成的 'Enterprise'），直接索引会得到 undefined，
 * 紧接着取 .color / .text 就会让整张卡片渲染失败。
 */
export function subscriptionMeta(type: SubscriptionType): { text: string; color: string } {
  return SUBSCRIPTION_META[type] ?? SUBSCRIPTION_META.Free
}

/** 订阅展示名：优先用接口给的标题，缺失时回退到内部枚举文案 */
export function subscriptionLabel(subscription: {
  type: SubscriptionType
  title?: string
}): string {
  return subscription.title || subscriptionMeta(subscription.type).text
}

/** API Key 的检查状态：卡片标签与筛选 chip 共用 */
export const KEY_STATUS_META: Record<KeyStatus, { text: string; color: string }> = {
  normal: { text: '正常', color: 'green' },
  error: { text: '异常', color: 'red' },
  unchecked: { text: '未检查', color: 'default' }
}

export const IDP_META: Record<IdpType, { text: string; color: string }> = {
  BuilderId: { text: 'Builder ID', color: 'geekblue' },
  Github: { text: 'GitHub', color: 'default' },
  Google: { text: 'Google', color: 'red' },
  Enterprise: { text: 'Enterprise', color: 'gold' }
}

export function usageColor(percent: number): string {
  if (percent >= 0.9) return '#ff4d4f'
  if (percent >= 0.7) return '#faad14'
  return '#52c41a'
}

/** Access Token 剩余时间的归一结果，文案与配色由各展示处自行决定 */
export interface TokenLife {
  /** unknown = 没有过期时间；expired = 已过期 */
  state: 'unknown' | 'expired' | 'minutes' | 'hours'
  /** 剩余分钟数，state 为 minutes 时使用 */
  minutes: number
  /** 剩余小时数，state 为 hours 时使用 */
  hours: number
}

/**
 * 计算 Access Token 剩余时间。
 * @param expiresAt 过期时间戳（ms）
 * @param rounding 不足 1 小时时分钟数的取整方式
 */
export function tokenLife(expiresAt?: number, rounding: 'floor' | 'round' = 'floor'): TokenLife {
  if (!expiresAt) return { state: 'unknown', minutes: 0, hours: 0 }
  const remaining = expiresAt - Date.now()
  if (remaining <= 0) return { state: 'expired', minutes: 0, hours: 0 }

  const minutes =
    rounding === 'round' ? Math.round(remaining / 60_000) : Math.floor(remaining / 60_000)
  // 四舍五入到 0 说明只剩几十秒，按已过期处理，避免出现「0 分钟」
  if (rounding === 'round' && minutes <= 0) return { state: 'expired', minutes: 0, hours: 0 }
  if (minutes < 60) return { state: 'minutes', minutes, hours: 0 }
  return { state: 'hours', minutes, hours: Math.floor(minutes / 60) }
}

/**
 * 带并发上限的任务池。
 *
 * @param options.staggerMs 各通道启动前的错峰上限（毫秒）。
 *   置 0 时全部通道同一帧起跑，瞬时打出 concurrency 个请求；上游按突发流量
 *   限流时（Amazon Q 的用量接口会回 403）就会出现「一批里只有一部分失败」。
 *   给一个小的随机延迟把起跑时间摊开，代价是整批多花不到一秒。
 */
export async function runPool<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
  options: { staggerMs?: number } = {}
): Promise<void> {
  // 上限 100 是兜底防呆，各调用方按自己的设置传入更小的值
  const limit = Math.max(1, Math.min(Math.floor(concurrency) || 1, 100))
  const stagger = Math.max(0, options.staggerMs ?? 0)
  let cursor = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async (_, channel) => {
    // 只错峰一次：通道之后是串行取任务，起跑错开了后续自然也不会同步
    if (stagger && channel > 0) {
      await new Promise((resolve) => setTimeout(resolve, Math.random() * stagger))
    }
    while (cursor < items.length) {
      const index = cursor++
      await worker(items[index], index)
    }
  })
  await Promise.all(runners)
}
