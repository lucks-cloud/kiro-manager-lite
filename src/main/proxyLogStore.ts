// 本地反代的请求日志与累计统计：落盘，应用重启后还在
//
// 和 gatewayHistory 同样的取舍：
//  - 单独一个 store 文件，不进主 store。日志写得很频繁，主 store 是加密的，
//    每次都整份加解密既慢又会和账号数据抢写盘；
//  - 不加密。日志里只有模型名、账号邮箱、token 数、耗时这类元信息，
//    请求和回复的内容从来不采集（见 ProxyLogEntry 的注释）；
//  - 内存里改，防抖合并成一次落盘。流式回复每 150ms 就会更新一次同一条日志，
//    逐次写盘的话一次对话就是几十次 IO。
import Store from 'electron-store'
import type { ProxyLogEntry, ProxyStatus } from '../shared/types'

/** 落盘保留的条数，和内存里的容量一致 */
export const LOG_CAPACITY = 300
const FLUSH_DELAY_MS = 1_500

export type ProxyStats = Pick<
  ProxyStatus,
  'requests' | 'succeeded' | 'failed' | 'credits' | 'inputTokens' | 'outputTokens'
>

interface Schema {
  logs: ProxyLogEntry[]
  stats: ProxyStats
}

export function emptyStats(): ProxyStats {
  return { requests: 0, succeeded: 0, failed: 0, credits: 0, inputTokens: 0, outputTokens: 0 }
}

const store = new Store<Schema>({
  name: 'kiro-proxy-logs',
  defaults: { logs: [], stats: emptyStats() }
})

let flushTimer: NodeJS.Timeout | null = null
/** 由 proxyServer 注册：落盘时现取它手里的最新数组，不在这里另存一份 */
let source: (() => { logs: ProxyLogEntry[]; stats: ProxyStats }) | null = null

export function bindProxyLogSource(
  read: () => { logs: ProxyLogEntry[]; stats: ProxyStats }
): void {
  source = read
}

/**
 * 读回上次的日志。
 *
 * 上次退出时还在排队或输出中的请求，连接早就没了，永远不会再有结果；
 * 原样显示成「输出中」会让人以为它还在跑，所以读回时标成失败并说明原因。
 */
export function loadProxyLogs(): { logs: ProxyLogEntry[]; stats: ProxyStats } {
  const raw = store.get('logs') as ProxyLogEntry[] | undefined
  const logs = (Array.isArray(raw) ? raw : []).slice(0, LOG_CAPACITY).map((entry) => {
    // 已存日志可能缺这两个字段，补上免得界面取 .length 时报错
    const fixed: ProxyLogEntry = {
      ...entry,
      inputTypes: entry.inputTypes ?? [],
      outputTypes: entry.outputTypes ?? [],
      retries: entry.retries ?? []
    }
    if (fixed.state === 'pending' || fixed.state === 'streaming') {
      fixed.state = 'error'
      fixed.error = fixed.error || '应用退出时请求尚未完成'
    }
    return fixed
  })
  const stats = { ...emptyStats(), ...((store.get('stats') as Partial<ProxyStats>) ?? {}) }
  return { logs, stats }
}

export function flushProxyLogs(): void {
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  if (!source) return
  const { logs, stats } = source()
  // 两个键一次写完：分开 set 会把整份文件同步重写两遍
  store.set({ logs: logs.slice(0, LOG_CAPACITY), stats })
}

export function scheduleProxyLogFlush(): void {
  if (flushTimer) return
  flushTimer = setTimeout(flushProxyLogs, FLUSH_DELAY_MS)
  // 不因为一个待写的定时器拖住进程退出；退出路径会显式 flush
  flushTimer.unref?.()
}
