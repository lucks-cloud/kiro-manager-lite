// 网关调用历史：按 Key 记录请求数、成功数与积分消耗的时间序列
//
// 与 usageHistory 同样的取舍：单独一个 store 文件，内存缓存整张表，
// 写入合并成一次防抖落盘。区别在于这里按「分钟桶」聚合而不是逐条记录——
// 网关每次对话会打好几个请求，逐条存的话跑一天就上万条，
// 而画曲线只需要分钟级精度，聚合后体积和渲染量都可控。
import Store from 'electron-store'
import type { GatewayCallPoint, KeyGatewayUsageStats } from '../shared/types'

/** 每个 Key 最多保留的分钟桶数：约等于 30 天的活跃分钟数 */
const MAX_POINTS_PER_KEY = 5000
const FLUSH_DELAY_MS = 1000
const MINUTE_MS = 60_000

/** 累计值：跨会话保留，网关重启不归零 */
type TotalsMap = Record<string, KeyGatewayUsageStats>
type PointsMap = Record<string, GatewayCallPoint[]>

interface Schema {
  /** keyId -> 累计统计 */
  totals: TotalsMap
  /** keyId -> 按时间升序的分钟桶 */
  points: PointsMap
}

const store = new Store<Schema>({
  name: 'kiro-gateway-history',
  defaults: { totals: {}, points: {} }
})

let totalsCache: TotalsMap | null = null
let pointsCache: PointsMap | null = null
let flushTimer: NodeJS.Timeout | null = null

function totals(): TotalsMap {
  if (!totalsCache) totalsCache = (store.get('totals') as TotalsMap) ?? {}
  return totalsCache
}

function points(): PointsMap {
  if (!pointsCache) pointsCache = (store.get('points') as PointsMap) ?? {}
  return pointsCache
}

/** 立即落盘并取消待执行的延迟落盘（退出前调一次） */
export function flushGatewayHistory(): void {
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  // 合成一次写入：分开 set 会把整份文件同步重写两遍
  const patch: Partial<Schema> = {}
  if (totalsCache) patch.totals = totalsCache
  if (pointsCache) patch.points = pointsCache
  if (Object.keys(patch).length) store.set(patch)
}

function scheduleFlush(): void {
  if (flushTimer) return
  flushTimer = setTimeout(flushGatewayHistory, FLUSH_DELAY_MS)
  flushTimer.unref?.()
}

function blankStats(): KeyGatewayUsageStats {
  return {
    requests: 0,
    succeeded: 0,
    failed: 0,
    auxRequests: 0,
    auxFailed: 0,
    rpm: 0,
    metered: 0
  }
}

/** 取某个 Key 的累计统计；没有记录时返回全零结构 */
export function getTotals(keyId: string): KeyGatewayUsageStats {
  const hit = totals()[keyId]
  return hit ? { ...blankStats(), ...hit } : blankStats()
}

export function getAllTotals(): TotalsMap {
  const all = totals()
  const out: TotalsMap = {}
  for (const [id, v] of Object.entries(all)) out[id] = { ...blankStats(), ...v }
  return out
}

/** 把累计值整体写回（调用方基于 getTotals 的结果修改） */
export function setTotals(keyId: string, next: KeyGatewayUsageStats): void {
  totals()[keyId] = next
  scheduleFlush()
}

export function getPoints(keyId: string): GatewayCallPoint[] {
  return points()[keyId] ?? []
}

/**
 * 往指定时刻所属的分钟桶累加。
 *
 * `at` 必须传请求**发起**的时间，不能用当前时间：对话是流式的，一次请求
 * 从发出到收到响应经常跨过分钟边界（重试时更明显）。若请求按发起时间归桶、
 * 结果按响应时间归桶，就会出现「成功 3 / 请求 2 / 失败 -1」这种自相矛盾的行。
 *
 * 同一分钟内的多次调用合并进同一条记录。桶可能不是最后一条（响应晚到时
 * 会补写更早的桶），所以这里按时间查找而不是只看末尾。
 */
export function addPoint(
  keyId: string,
  delta: { requests?: number; succeeded?: number; credits?: number },
  at: number = Date.now()
): void {
  if (!keyId) return
  const all = points()
  const list = all[keyId] ?? []
  const bucket = Math.floor(at / MINUTE_MS) * MINUTE_MS

  // 绝大多数情况就是最后一条，先判它，避免每次都遍历
  let target = list.at(-1)
  if (!target || target.at !== bucket) {
    target = list.find((p) => p.at === bucket)
  }

  if (target) {
    target.requests += delta.requests ?? 0
    target.succeeded += delta.succeeded ?? 0
    target.credits = Number((target.credits + (delta.credits ?? 0)).toFixed(6))
  } else {
    const point: GatewayCallPoint = {
      at: bucket,
      requests: delta.requests ?? 0,
      succeeded: delta.succeeded ?? 0,
      credits: Number((delta.credits ?? 0).toFixed(6))
    }
    // 迟到的桶要插到正确位置，保证数组始终按时间升序（曲线依赖这个顺序）
    const last = list.at(-1)
    if (!last || bucket > last.at) list.push(point)
    else {
      const idx = list.findIndex((p) => p.at > bucket)
      list.splice(idx < 0 ? list.length : idx, 0, point)
    }
  }

  // 就地删掉最旧的，到上限后不必每次都复制一份 5000 条的新数组
  if (list.length > MAX_POINTS_PER_KEY) list.splice(0, list.length - MAX_POINTS_PER_KEY)
  all[keyId] = list
  scheduleFlush()
}

/** 清空某个 Key 的统计与历史；不传 keyId 则清全部 */
export function clearGatewayHistory(keyId?: string): void {
  if (keyId) {
    delete totals()[keyId]
    delete points()[keyId]
  } else {
    totalsCache = {}
    pointsCache = {}
  }
  flushGatewayHistory()
}

/** 删除已不存在的 Key 留下的数据 */
export function pruneGatewayHistory(keepKeyIds: string[]): number {
  const keep = new Set(keepKeyIds)
  let removed = 0
  for (const map of [totals(), points()] as Record<string, unknown>[]) {
    for (const id of Object.keys(map)) {
      if (keep.has(id)) continue
      delete map[id]
      removed++
    }
  }
  if (removed) flushGatewayHistory()
  return removed
}
