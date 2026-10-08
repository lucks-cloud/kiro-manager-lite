// 本地反代的用量统计（按账号、按反代 Key）：单独一个不加密的小文件，内存累加、合并落盘
//
// 每个请求都会更新统计。主库是加密的整份文件（含全部账号，约 2MB），写一次要整份加密重写，
// 主线程上十几毫秒；统计放在这里，一次落盘只写这一个小文件。
// 内容只有账号邮箱、请求数、积分、token 数这类元信息，和请求日志同一级别，不加密。
// 1.5 秒内的变更合成一次写；停止反代、导出备份、退出应用时会立即 flush，被强杀最多丢最后 1.5 秒。
import Store from 'electron-store'
import { takeLegacyProxyUsage } from './store'
import type { ProxyAccountUsage, ProxyKeyUsage } from '../shared/types'

interface Schema {
  /** 按账号累计 */
  accounts: ProxyAccountUsage[]
  /** 按反代 Key 累计，键是 Key 的 id */
  keys: Record<string, ProxyKeyUsage>
  /** 已从主库搬过来；搬过一次就不再看主库 */
  migrated: boolean
}

const FLUSH_DELAY_MS = 1_500

const store = new Store<Schema>({
  name: 'kiro-proxy-usage',
  defaults: { accounts: [], keys: {}, migrated: false }
})

let cache: { accounts: ProxyAccountUsage[]; keys: Record<string, ProxyKeyUsage> } | null = null
let flushTimer: NodeJS.Timeout | null = null

/** 首次读取时载入；主库里还留着统计的（升级上来的用户）搬到这里并从主库删掉 */
function data(): { accounts: ProxyAccountUsage[]; keys: Record<string, ProxyKeyUsage> } {
  if (cache) return cache
  if (!store.get('migrated')) {
    const legacy = takeLegacyProxyUsage()
    store.set({ accounts: legacy.accounts, keys: legacy.keys, migrated: true })
  }
  const accounts = store.get('accounts')
  const keys = store.get('keys')
  cache = {
    accounts: Array.isArray(accounts) ? accounts : [],
    keys: keys && typeof keys === 'object' ? keys : {}
  }
  return cache
}

/** 按账号的用量，返回的数组可以就地修改，改完调 scheduleUsageFlush */
export function accountUsage(): ProxyAccountUsage[] {
  return data().accounts
}

/** 按反代 Key 的用量，返回的对象可以就地修改，改完调 scheduleUsageFlush */
export function keyUsage(): Record<string, ProxyKeyUsage> {
  return data().keys
}

export function clearAccountUsage(): void {
  data().accounts = []
  flushUsage()
}

/** 两类统计一起写：一次请求两边都会更新，合成一次落盘 */
export function flushUsage(): void {
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  if (cache) store.set({ accounts: cache.accounts, keys: cache.keys })
}

export function scheduleUsageFlush(): void {
  if (flushTimer) return
  flushTimer = setTimeout(flushUsage, FLUSH_DELAY_MS)
  // 不因为一个待写的定时器拖住进程退出；退出路径会显式 flush
  flushTimer.unref?.()
}
