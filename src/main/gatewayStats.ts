// 网关调用统计：按 Key 汇总真实请求数、成功率、RPM 与积分消耗
//
// 数据来源分两类：
//  1. 转发层计数——请求数、状态码，零解析成本
//  2. 响应流解析——积分消耗，来自 generateAssistantResponse 的 event-stream：
//       MeteringEvent → usage / unit / unitPlural（Kiro 的计费口径，服务端权威值）
//
// 不统计 token：实测 CodeWhisperer 的响应流里只有 meteringEvent，
// 没有携带 tokenUsage 的 metadataEvent，token 恒为 0 拿不到有效数据。
// 而 Kiro 本身就是按积分计费的，积分才是有意义的口径。
//
// 累计值与时间序列都持久化（见 gatewayHistory）：这些数字是用户关心的长期用量，
// 不能因为重启应用或重开网关就归零。RPM 是个例外——它只有"最近一分钟"的含义，
// 留在内存里即可，重启后自然为 0。
import { jsonOf, takeFrames, type EventFrame } from './eventStream'
import { log } from './logger'
import {
  addPoint,
  clearGatewayHistory,
  getAllTotals,
  getTotals,
  setTotals
} from './gatewayHistory'
import type { KeyGatewayUsageStats } from '../shared/types'

/** RPM 统计窗口 */
const RPM_WINDOW_MS = 60_000

/** 只有 RPM 需要进程内状态：keyId -> 最近一分钟内的对话请求时间戳 */
const recentByKey = new Map<string, number[]>()
/** 已删除的 Key：阻止删除前尚未结束的流式响应把统计重新写回磁盘。 */
const discardedKeys = new Set<string>()

function recentFor(keyId: string): number[] {
  let list = recentByKey.get(keyId)
  if (!list) {
    list = []
    recentByKey.set(keyId, list)
  }
  return list
}

/** 读改写一次累计值 */
function mutate(keyId: string, fn: (s: KeyGatewayUsageStats) => void): KeyGatewayUsageStats {
  const s = getTotals(keyId)
  fn(s)
  setTotals(keyId, s)
  return s
}

/**
 * 记一次请求发出。
 *
 * 对话请求与辅助请求分开计数：一次 Kiro 对话除了 generateAssistantResponse，
 * 还会顺带打 /mcp 等辅助接口，而 /mcp 在 API Key 鉴权下会稳定回 403。
 * 若混在一起，用户发一次对话会看到「请求 5、成功率 40%」这种既看不懂
 * 又不反映对话质量的数字，所以成功率只按对话请求算。
 */
export function recordRequest(keyId: string, isChat: boolean): void {
  if (discardedKeys.has(keyId)) return
  if (!isChat) {
    mutate(keyId, (s) => void s.auxRequests++)
    return
  }
  const now = Date.now()
  mutate(keyId, (s) => {
    s.requests++
    s.lastRequestAt = now
  })
  const recent = recentFor(keyId)
  recent.push(now)
  trimRecent(recent, now)
  // 时间序列不在这里写：请求与结果必须落在同一个分钟桶，否则会出现
  // 「成功数 > 请求数」。统一等响应回来后按请求发起时间一次写入（见 recordResponse）。
}

/**
 * 记一次响应结果；重试产生的每一次尝试都会各记一次，如实反映真实调用量。
 *
 * @param startedAt 该次尝试发起的时间戳，用于把请求与结果归到同一个分钟桶。
 *   缺省则退回当前时间——只会让归桶偏晚，不会造成计数矛盾。
 */
export function recordResponse(
  keyId: string,
  status: number,
  isChat: boolean,
  startedAt?: number
): void {
  if (discardedKeys.has(keyId)) return
  const ok = status >= 200 && status < 300
  if (!isChat) {
    if (!ok) mutate(keyId, (s) => void s.auxFailed++)
    return
  }
  mutate(keyId, (s) => {
    if (ok) s.succeeded++
    else s.failed++
  })
  // 请求数与成功数一起写，天然保证同桶内 requests >= succeeded
  addPoint(keyId, { requests: 1, succeeded: ok ? 1 : 0 }, startedAt)
}

function trimRecent(recent: number[], now: number): void {
  const cutoff = now - RPM_WINDOW_MS
  // 时间戳天然递增，从头裁到第一个还在窗口内的即可
  let i = 0
  while (i < recent.length && recent[i] < cutoff) i++
  if (i > 0) recent.splice(0, i)
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

/**
 * 从响应流的一帧里提取积分消耗。
 * 只认 meteringEvent，其余帧（正文增量、工具调用等）直接忽略。
 */
function applyFrame(s: KeyGatewayUsageStats, frame: EventFrame): boolean {
  if (frame.headers[':event-type'] !== 'meteringEvent') return false

  const body = jsonOf(frame.payload)
  const used = num(body.usage)
  if (used !== undefined) {
    s.metered += used
    const unit = body.unitPlural ?? body.unit
    if (typeof unit === 'string' && unit.trim()) s.meteredUnit = unit.trim()
    return true
  }
  return false
}

/**
 * 创建一个流式用量收集器。
 *
 * 网关把上游响应同时喂给 IDE 和这里：feed 只做帧切分与数值累加，
 * 不缓存正文，长会话也不会涨内存。跨 chunk 的半个帧留在 rest 里等下一次。
 */
export function createUsageCollector(
  keyId: string,
  label: string,
  /** 该次请求发起的时间，积分要和请求归到同一个分钟桶 */
  startedAt?: number
): {
  feed: (chunk: Buffer) => void
  finish: () => void
  noteEncoding: (encoding: string) => void
} {
  let buffer = Buffer.alloc(0)
  let hit = false
  let frameCount = 0
  let byteCount = 0
  let encoding = ''
  /** 见到过哪些事件类型，解析不出用量时用于定位是"没有该事件"还是"解析失败" */
  const seen = new Set<string>()

  return {
    noteEncoding(value: string): void {
      encoding = value
    },
    feed(chunk: Buffer): void {
      if (discardedKeys.has(keyId)) return
      try {
        byteCount += chunk.length
        buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk
        const { frames, rest } = takeFrames(buffer)
        buffer = rest
        if (!frames.length) return
        frameCount += frames.length
        // 一次 feed 里可能有多帧，合并成一次读改写，避免逐帧落盘
        mutate(keyId, (s) => {
          const before = s.metered
          for (const frame of frames) {
            const type = frame.headers[':event-type']
            if (type) seen.add(type)
            if (applyFrame(s, frame)) hit = true
          }
          const gained = s.metered - before
          // 积分增量单独进时间序列，用于画积分曲线；与请求同桶便于对照
          if (gained > 0) addPoint(keyId, { credits: gained }, startedAt)
        })
      } catch {
        // 解析失败绝不能影响转发：统计是附加功能，丢一帧无所谓
        buffer = Buffer.alloc(0)
      }
    },
    finish(): void {
      if (discardedKeys.has(keyId)) return
      if (hit) {
        const s = getTotals(keyId)
        log(
          'info',
          `[GatewayStats] [${label}] 累计积分 ${s.metered.toFixed(4)}${s.meteredUnit ? ' ' + s.meteredUnit : ''}`
        )
        return
      }
      // 没解析出积分：把线索留在日志里，便于判断是压缩没解开、
      // 还是这条响应里确实不带 meteringEvent
      log(
        'warn',
        `[GatewayStats] [${label}] 未解析到积分计费事件（收到 ${byteCount} 字节 / ${frameCount} 帧` +
          `${encoding ? ` / content-encoding=${encoding}` : ''}` +
          `${seen.size ? ` / 事件类型 ${[...seen].join(',')}` : ''}）`
      )
    }
  }
}

/**
 * 全部 Key 的统计快照，按 keyId 索引。
 * 累计值来自持久化存储，RPM 由内存里的时间戳窗口现算。
 */
export function getGatewayStats(): Record<string, KeyGatewayUsageStats> {
  const out = getAllTotals()
  const now = Date.now()
  // 有 RPM 但还没有累计记录的情况不存在（记请求时一定先写累计），
  // 反过来有累计没 RPM 很常见——重启后累计还在，RPM 归零。
  for (const [id, recent] of recentByKey) {
    trimRecent(recent, now)
    if (out[id]) out[id].rpm = recent.length
  }
  return out
}

/**
 * 删除 Key 时彻底丢弃统计，并把 ID 加入墓碑集合。
 * 墓碑只活到进程退出，用于拦住删除前已经发出的流式响应和延迟重试回写孤儿历史。
 */
export function discardGatewayStats(keyId: string): void {
  if (!keyId) return
  discardedKeys.add(keyId)
  recentByKey.delete(keyId)
  clearGatewayHistory(keyId)
}

/** 清空统计与历史：仅在用户手动重置时调用。关闭网关不清空，累计值要长期保留 */
export function resetGatewayStats(keyId?: string): void {
  if (keyId) recentByKey.delete(keyId)
  else recentByKey.clear()
  clearGatewayHistory(keyId)
}

/** 清掉 RPM 的内存窗口，累计值不动。网关停止时调用 */
export function clearRpmWindows(): void {
  recentByKey.clear()
}
