// 本地反代的多 API Key：鉴权、额度与按 Key 的用量统计
//
// 默认 Key 仍然是 ProxyConfig.apiKey —— 「一键写入」写进各客户端的就是它，
// 这里把它合成进列表（id 固定为 PROXY_DEFAULT_KEY_ID），不另存一份，
// 免得两处明文对不上。自定义 Key 用来分给别的工具或别人，各自限额、各自统计。
import { randomBytes, randomUUID, timingSafeEqual } from 'crypto'
import {
  getProxyApiKeys,
  getProxyConfig,
  getProxyKeyUsage,
  saveProxyConfig,
  setProxyApiKeys,
  setProxyKeyUsage
} from './store'
import {
  PROXY_DEFAULT_KEY_ID,
  type ProxyApiKey,
  type ProxyApiKeyView,
  type ProxyKeyStats,
  type ProxyKeyUsage,
  type ProxyKeyUsageRecord
} from '../shared/types'

/** 每个 Key 保留的明细条数：够看最近一阵子，又不让 store 无限膨胀 */
const RECENT_LIMIT = 500
/** 每日汇总保留的天数 */
const DAY_LIMIT = 90

/** 统一的 Key 格式：sk- 前缀让各家客户端的「看起来像不像 Key」校验都能过 */
export function generateProxyKey(): string {
  return `sk-${randomBytes(24).toString('hex')}`
}

function emptyStats(): ProxyKeyStats {
  return { requests: 0, failed: 0, credits: 0, inputTokens: 0, outputTokens: 0 }
}

function emptyUsage(keyId: string): ProxyKeyUsage {
  return { keyId, total: emptyStats(), byModel: {}, byDay: {}, recent: [] }
}

// ============ 用量缓存 ============
//
// 每个请求都整份写一次加密的 electron-store 太重（明细加起来几百 KB），
// 所以先在内存里累加，1.5 秒内的变更合成一次落盘。
// 代价是应用被强杀时可能丢最后 1.5 秒的统计，停止反代与正常退出都会先 flush。

let usageCache: Record<string, ProxyKeyUsage> | null = null
let flushTimer: NodeJS.Timeout | null = null

function usageMap(): Record<string, ProxyKeyUsage> {
  if (!usageCache) usageCache = getProxyKeyUsage()
  return usageCache
}

function scheduleFlush(): void {
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    flushProxyKeyUsage()
  }, 1_500)
}

export function flushProxyKeyUsage(): void {
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  if (usageCache) setProxyKeyUsage(usageCache)
}

function statsOf(keyId: string): ProxyKeyStats {
  return usageMap()[keyId]?.total ?? emptyStats()
}

/** 本地日期：按用户所在时区切天，UTC 切会让晚上的用量算到第二天 */
function dayKey(at: number): string {
  const d = new Date(at)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function add(stats: ProxyKeyStats, record: ProxyKeyUsageRecord): void {
  stats.requests += 1
  if (!record.ok) stats.failed += 1
  stats.credits += record.credits
  stats.inputTokens += record.inputTokens
  stats.outputTokens += record.outputTokens
}

/** 记一次请求。失败的也记：请求数和失败率本身就是要看的东西 */
export function recordKeyUsage(keyId: string, record: ProxyKeyUsageRecord): void {
  const map = usageMap()
  const usage = map[keyId] ?? (map[keyId] = emptyUsage(keyId))

  add(usage.total, record)
  add((usage.byModel[record.model] ??= emptyStats()), record)
  add((usage.byDay[dayKey(record.at)] ??= emptyStats()), record)

  usage.recent.unshift(record)
  if (usage.recent.length > RECENT_LIMIT) usage.recent.length = RECENT_LIMIT

  // YYYY-MM-DD 的字典序就是时间序，删最旧的
  const days = Object.keys(usage.byDay).sort()
  for (const stale of days.slice(0, Math.max(0, days.length - DAY_LIMIT))) {
    delete usage.byDay[stale]
  }

  usage.lastUsedAt = record.at
  scheduleFlush()
}

export function proxyKeyUsage(keyId: string): ProxyKeyUsage {
  return usageMap()[keyId] ?? emptyUsage(keyId)
}

export function resetProxyKeyUsage(keyId: string): void {
  delete usageMap()[keyId]
  flushProxyKeyUsage()
}

// ============ Key 列表 ============

/** 默认 Key 合成成列表里的一项；没设置明文时不出现 */
function defaultKey(): ProxyApiKey | null {
  const config = getProxyConfig()
  const key = config.apiKey.trim()
  if (!key) return null
  return {
    id: PROXY_DEFAULT_KEY_ID,
    name: config.defaultKeyName.trim() || '默认',
    key,
    creditLimit: normalizeLimit(config.defaultKeyCreditLimit),
    enabled: true,
    createdAt: 0,
    isDefault: true
  }
}

function allKeys(): ProxyApiKey[] {
  const fallback = defaultKey()
  return [...(fallback ? [fallback] : []), ...getProxyApiKeys()]
}

export function listProxyKeys(): ProxyApiKeyView[] {
  return allKeys().map((key) => ({
    ...key,
    total: statsOf(key.id),
    lastUsedAt: usageMap()[key.id]?.lastUsedAt
  }))
}

function normalizeLimit(value: unknown): number {
  const n = Number(value)
  // 空、负数、非数字一律当「不限」，和界面上「不填或填 0 代表不限」一致
  return Number.isFinite(n) && n > 0 ? n : 0
}

export function createProxyKey(input: { name?: string; creditLimit?: number }): ProxyApiKeyView {
  const keys = getProxyApiKeys()
  const name = input.name?.trim() || `key-${Date.now().toString(36).slice(-6)}`
  const entry: ProxyApiKey = {
    id: randomUUID(),
    name,
    key: generateProxyKey(),
    creditLimit: normalizeLimit(input.creditLimit),
    enabled: true,
    createdAt: Date.now()
  }
  setProxyApiKeys([...keys, entry])
  return { ...entry, total: emptyStats() }
}

export function updateProxyKey(
  id: string,
  patch: { name?: string; creditLimit?: number; enabled?: boolean }
): void {
  if (id === PROXY_DEFAULT_KEY_ID) {
    /*
     * 默认 Key 不在自定义列表里，名称与额度存在反代配置上。
     * 不能停用：它是写进各客户端的那一个，停掉等于让所有客户端一起失效，要停就换一个 Key 使用。
     */
    if (patch.enabled === false) throw new Error('当前使用的 Key 不能停用，可以先使用别的 Key')
    const next: { defaultKeyName?: string; defaultKeyCreditLimit?: number } = {}
    if (patch.name !== undefined && patch.name.trim()) next.defaultKeyName = patch.name.trim()
    if (patch.creditLimit !== undefined) next.defaultKeyCreditLimit = normalizeLimit(patch.creditLimit)
    saveProxyConfig(next)
    return
  }
  const keys = getProxyApiKeys()
  const index = keys.findIndex((k) => k.id === id)
  if (index < 0) throw new Error('这个 Key 不存在，可能已被删除')
  const next = { ...keys[index] }
  if (patch.name !== undefined) next.name = patch.name.trim() || next.name
  if (patch.creditLimit !== undefined) next.creditLimit = normalizeLimit(patch.creditLimit)
  if (patch.enabled !== undefined) next.enabled = !!patch.enabled
  keys[index] = next
  setProxyApiKeys(keys)
}

export function deleteProxyKey(id: string): void {
  if (id === PROXY_DEFAULT_KEY_ID) throw new Error('默认 Key 不能删除，可以重新生成')
  setProxyApiKeys(getProxyApiKeys().filter((k) => k.id !== id))
  // 用量一起删：Key 没了，它的统计也没有意义，还白占空间
  resetProxyKeyUsage(id)
}

/**
 * 把一个自定义 Key 设为默认（也就是写进各客户端配置的那一个）。
 *
 * 做法是让两个 Key 互换位置，两串密钥都继续有效，用着它们的客户端不会突然被拒：
 *  - 选中的 Key 成为默认，从自定义列表里移除；
 *  - 原来的默认 Key 变成一个自定义 Key，名为「原默认 Key」。
 * 名称、额度与用量统计都跟着密钥走：默认 Key 的统计挂在固定 id 上，互换时把两边的统计也对调，
 * 否则「默认」这一行会显示另一串密钥攒下的数据。默认 Key 不能停用，所以停用中的不能设为默认。
 */
export function setDefaultProxyKey(id: string): void {
  if (id === PROXY_DEFAULT_KEY_ID) return
  const keys = getProxyApiKeys()
  const target = keys.find((k) => k.id === id)
  if (!target) throw new Error('这个 Key 不存在，可能已被删除')
  if (!target.enabled) throw new Error('已停用的 Key 不能设为默认，请先启用')

  const config = getProxyConfig()
  const oldDefault = config.apiKey.trim()
  const rest = keys.filter((k) => k.id !== id)
  const demotedId = oldDefault ? randomUUID() : null
  if (oldDefault && demotedId) {
    // 原默认 Key 带着自己的名称与额度转成自定义 Key；名称还是出厂的「默认」时改个好认的名字
    const oldName = config.defaultKeyName.trim()
    rest.unshift({
      id: demotedId,
      name: oldName && oldName !== '默认' ? oldName : '原默认 Key',
      key: oldDefault,
      creditLimit: normalizeLimit(config.defaultKeyCreditLimit),
      enabled: true,
      createdAt: Date.now()
    })
  }

  const map = usageMap()
  const defaultUsage = map[PROXY_DEFAULT_KEY_ID]
  const targetUsage = map[id]
  delete map[PROXY_DEFAULT_KEY_ID]
  delete map[id]
  if (targetUsage) map[PROXY_DEFAULT_KEY_ID] = { ...targetUsage, keyId: PROXY_DEFAULT_KEY_ID }
  if (defaultUsage && demotedId) map[demotedId] = { ...defaultUsage, keyId: demotedId }

  setProxyApiKeys(rest)
  // 名称与额度跟着 Key 走，换成当前使用后原样保留
  saveProxyConfig({
    apiKey: target.key,
    defaultKeyName: target.name,
    defaultKeyCreditLimit: normalizeLimit(target.creditLimit)
  })
  flushProxyKeyUsage()
}

// ============ 鉴权 ============

export type KeyCheck =
  | { ok: true; keyId?: string; keyName?: string; keyValue?: string }
  | { ok: false; status: number; message: string }

/** 等长才能比，不等长直接不相等；用恒定时间比较，不给时序侧信道留余地 */
function sameKey(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

/**
 * 按客户端带来的密钥找到对应的 Key，并检查停用与额度。
 *
 * 不要求校验时照样尝试匹配：能对上就记到那个 Key 名下，对不上就不记，
 * 这样关掉校验也不会让统计整个失效。
 */
export function checkProxyKey(given: string, required: boolean): KeyCheck {
  const keys = allKeys()
  const match = given ? keys.find((k) => sameKey(k.key, given)) : undefined

  if (!match) {
    if (!required) return { ok: true }
    if (!keys.length) {
      return {
        ok: false,
        status: 401,
        message: '本地反代要求 API Key，但还没设置，请在「本地反代」页面生成一个'
      }
    }
    return { ok: false, status: 401, message: 'API Key 不正确' }
  }

  if (!match.enabled) {
    return { ok: false, status: 401, message: `API Key「${match.name}」已停用` }
  }

  /*
   * 额度按「已消耗积分 ≥ 上限」判：只能在请求开始前拦，
   * 并发的几个请求可能一起放行、略微超出一点，这是不锁账本换来的简单。
   * 用 429 而不是 401：客户端看到 401 会以为 Key 填错了，让用户去改配置。
   */
  if (match.creditLimit > 0) {
    const used = statsOf(match.id).credits
    if (used >= match.creditLimit) {
      return {
        ok: false,
        status: 429,
        message: `API Key「${match.name}」额度已用完（${used.toFixed(2)} / ${match.creditLimit}）`
      }
    }
  }

  return { ok: true, keyId: match.id, keyName: match.name, keyValue: match.key }
}
