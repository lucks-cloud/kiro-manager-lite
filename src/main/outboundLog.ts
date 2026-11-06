// 出站域名统计
//
// 记录本应用所有对外网络请求的目标域名，按「完整主机名（FQDN）」去重，
// 同时算出可注册域（二级域）用于分组展示。供「常用工具 → 出站域名统计」查看，
// 让用户能核对本应用到底对外访问了哪些域名。
//
// 所有主进程出站都应经过这里登记：net.ts 的 httpRequest / httpStream，
// 以及 keyGateway 里直接用 https.request 的两处（token 刷新、网关对话转发）。
import type { OutboundDomainEntry, OutboundRequestEvent } from '../shared/types'

interface Entry {
  host: string
  apex: string
  count: number
  firstAt: number
  lastAt: number
  sample: string
}

/** 去重后最多保留多少个主机名，超出按最久未命中淘汰，避免无限增长 */
const MAX_HOSTS = 500

/** 明细事件最多保留多少条，超出丢弃最旧的，避免无限增长 */
const MAX_EVENTS = 3000

/** 出站明细事件（最近的在数组末尾） */
const events: OutboundRequestEvent[] = []

/**
 * 常见的多段公共后缀：用于把 `foo.com.cn` 归到 `foo.com.cn` 而不是 `com.cn`。
 * 只列最常见的，取不准也只影响分组展示，不影响按 FQDN 去重。
 */
const MULTI_PART_SUFFIX = new Set([
  'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn',
  'co.uk', 'org.uk', 'gov.uk', 'co.jp', 'com.hk', 'com.tw', 'com.sg'
])

/** host => 记录 */
const domains = new Map<string, Entry>()

/** 取可注册域（二级域）：默认取末两段，命中多段后缀时取末三段 */
function apexOf(host: string): string {
  const labels = host.split('.').filter(Boolean)
  if (labels.length <= 2) return host
  const last2 = labels.slice(-2).join('.')
  if (MULTI_PART_SUFFIX.has(last2) && labels.length >= 3) return labels.slice(-3).join('.')
  return last2
}

/** 是否本机回环地址（本地网关自测等不算对外出站） */
function isLoopback(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.localhost')
}

/**
 * 登记一次出站。入参可为完整 URL（`https://host/path?x=1`）或裸主机名（可带端口）。
 * 查询串会被去掉，只留协议 + 主机 + 路径作为样例，避免把凭据参数写进统计。
 */
export function recordOutbound(urlOrHost: string): void {
  if (!urlOrHost) return

  let host = ''
  let sample = ''
  try {
    if (/^[a-z][a-z0-9+\-.]*:\/\//i.test(urlOrHost)) {
      const u = new URL(urlOrHost)
      host = u.hostname
      sample = `${u.protocol}//${u.host}${u.pathname}`
    } else {
      // 裸主机名（可能带 :443 端口）
      host = urlOrHost.replace(/:\d+$/, '').trim()
      sample = urlOrHost.trim()
    }
  } catch {
    return
  }

  if (!host || isLoopback(host)) return

  const now = Date.now()

  // 明细事件：每次出站都记一条（含完整地址与时间），供明细弹窗查看
  events.push({ at: now, host, url: sample })
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS)

  const existing = domains.get(host)
  if (existing) {
    existing.count += 1
    existing.lastAt = now
    existing.sample = sample
    return
  }

  if (domains.size >= MAX_HOSTS) {
    let oldestKey = ''
    let oldest = Number.POSITIVE_INFINITY
    for (const [key, value] of domains) {
      if (value.lastAt < oldest) {
        oldest = value.lastAt
        oldestKey = key
      }
    }
    if (oldestKey) domains.delete(oldestKey)
  }

  domains.set(host, { host, apex: apexOf(host), count: 1, firstAt: now, lastAt: now, sample })
}

/** 当前去重后的出站域名列表，按最近一次出站时间倒序 */
export function listOutboundDomains(): OutboundDomainEntry[] {
  return [...domains.values()].sort((a, b) => b.lastAt - a.lastAt)
}

/**
 * 出站明细事件，按时间倒序（最近在前）。
 * 传 host 则只返回该主机名的明细；不传返回全部。
 */
export function listOutboundEvents(host?: string): OutboundRequestEvent[] {
  const all = host ? events.filter((e) => e.host === host) : events
  return [...all].reverse()
}

/** 清空统计 */
export function clearOutboundDomains(): void {
  domains.clear()
  events.length = 0
}
