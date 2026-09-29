// 本地持久化（electron-store，账号数据加密存放）
import Store from 'electron-store'
import { app } from 'electron'
import * as path from 'path'
import * as fs from 'fs/promises'
import {
  DEFAULT_KEY_GATEWAY_DATA,
  DEFAULT_SETTINGS,
  type AccountStoreData,
  type AppSettings,
  type KeyGatewayData,
  type SubscriptionType
} from '../shared/types'
import { normalizeSubscriptionType } from '../shared/subscription'

/** permissions.yaml 开启前的原始状态 */
export interface ShellApproveYamlBackup {
  /** 备份时文件是否存在；false 表示关闭时应删除该文件 */
  existed: boolean
  content: string
}

/** Kiro IDE settings.json 里命令审批相关键的原值 */
export interface ShellApproveSettingsBackup {
  path: string
  /** 原本是否存在该键；false 表示关闭时应删除该键而不是写空数组 */
  hadTrustedCommands: boolean
  trustedCommands?: unknown
  hadCommandDenylist: boolean
  commandDenylist?: unknown
}

/** 开启「自动同意所有 Shell 命令」前的完整配置快照 */
export interface ShellApproveBackup {
  savedAt: number
  yaml?: ShellApproveYamlBackup
  settings?: ShellApproveSettingsBackup
}

interface Schema {
  accountData: AccountStoreData
  settings: AppSettings
  keyData: KeyGatewayData
  shellApproveBackup: ShellApproveBackup | null
}

const EMPTY_DATA: AccountStoreData = { version: 1, accounts: [], activeAccountId: null }

const store = new Store<Schema>({
  name: 'kiro-account-lite',
  encryptionKey: 'kiro-account-lite-local-key',
  defaults: {
    accountData: EMPTY_DATA,
    settings: DEFAULT_SETTINGS,
    keyData: DEFAULT_KEY_GATEWAY_DATA,
    shellApproveBackup: null
  }
})

/** 权限配置备份：仅在开关开启期间存在，关闭还原后清空 */
export function getShellApproveBackup(): ShellApproveBackup | null {
  const raw = store.get('shellApproveBackup') as Record<string, unknown> | null | undefined
  if (!raw || typeof raw !== 'object') return null

  // 1.0.4 之前只备份 permissions.yaml，字段平铺在顶层，这里做一次形状升级
  if (typeof raw.content === 'string' && !raw.yaml && !raw.settings) {
    return {
      savedAt: Number(raw.savedAt) || Date.now(),
      yaml: { existed: raw.existed === true, content: raw.content }
    }
  }
  if (!raw.yaml && !raw.settings) return null
  return raw as unknown as ShellApproveBackup
}

export function setShellApproveBackup(backup: ShellApproveBackup | null): void {
  store.set('shellApproveBackup', backup)
}

/** 当前有效的订阅档位，用于识别磁盘上遗留的废弃值 */
const VALID_SUBSCRIPTION_TYPES = new Set<string>([
  'Free',
  'Pro',
  'Pro_Plus',
  'Pro_Max',
  'Power',
  'Teams',
  'Student'
] satisfies SubscriptionType[])

/**
 * 按 title 重新对齐订阅档位，就地改写并落盘。
 *
 * subscription.type 是从 title 派生出来的持久化值。早前的判定把 POWER 并进了
 * 'Enterprise'，而 Enterprise 根本不是订阅档位（它是登录方式），于是磁盘上一大批
 * Power 账号至今存着 'Enterprise'。只改判定逻辑不会动到已存的值，
 * 筛选面板里的 Power 会一直是 0，除非把每个账号的用量都重新刷一遍。
 *
 * 放在这个唯一读取入口上做，比放在渲染进程的 store.load() 里可靠：后者只在 load
 * 时跑一次，热重载或 store 状态被保留时根本不会执行。
 * 幂等；title 缺失时无判据，只把已废弃的档位归到 Free，其余保持原值。
 */
function alignSubscriptionTypes(data: AccountStoreData): AccountStoreData {
  let changed = false
  for (const account of data.accounts) {
    const sub = account.subscription
    if (!sub) continue
    if (!sub.title) {
      if (VALID_SUBSCRIPTION_TYPES.has(sub.type)) continue
      sub.type = 'Free'
      changed = true
      continue
    }
    const next = normalizeSubscriptionType(sub.title)
    if (next === sub.type) continue
    sub.type = next
    changed = true
  }
  // 对齐一次就写回，避免每次读取都重算
  if (changed) store.set('accountData', data)
  return data
}

export function getAccountData(): AccountStoreData {
  const data = store.get('accountData') as AccountStoreData | undefined
  if (!data || !Array.isArray(data.accounts)) return EMPTY_DATA
  return alignSubscriptionTypes(data)
}

export async function setAccountData(data: AccountStoreData): Promise<void> {
  store.set('accountData', data)
  await writeBackup(data)
}

/**
 * 从主进程最新快照删除账号，避免渲染进程用旧整表覆盖主动续期刚写入的新凭证。
 * 同时从滚动备份里移除这些账号，保证“删除”不会在历史备份中留下可恢复凭证。
 */
export async function deleteAccountData(
  ids: string[]
): Promise<{ accounts: AccountStoreData; removed: number }> {
  const remove = new Set(ids.filter(Boolean))
  const current = getAccountData()
  if (!remove.size) return { accounts: current, removed: 0 }

  const remaining = current.accounts.filter((account) => !remove.has(account.id))
  const removed = current.accounts.length - remaining.length
  if (!removed) return { accounts: current, removed: 0 }

  const accounts: AccountStoreData = {
    ...current,
    accounts: remaining,
    activeAccountId:
      current.activeAccountId && remove.has(current.activeAccountId)
        ? null
        : current.activeAccountId
  }
  await setAccountData(accounts)
  await purgeAccountsFromBackups(remove)
  return { accounts, removed }
}

export function getSettings(): AppSettings {
  return { ...DEFAULT_SETTINGS, ...(store.get('settings') as Partial<AppSettings>) }
}

export function setSettings(settings: Partial<AppSettings>): AppSettings {
  const merged = { ...getSettings(), ...settings }
  store.set('settings', merged)
  return merged
}

export function getStorePath(): string {
  return store.path
}

// ============ Key 网关数据 ============

export function getKeyData(): KeyGatewayData {
  const data = store.get('keyData') as Partial<KeyGatewayData> | undefined
  // 用默认值打底，兼容旧数据缺字段
  const merged: KeyGatewayData = { ...DEFAULT_KEY_GATEWAY_DATA, ...(data ?? {}) }
  if (!Array.isArray(merged.keys)) merged.keys = []
  if (!merged.ports || typeof merged.ports.krs !== 'number' || typeof merged.ports.cps !== 'number') {
    merged.ports = { ...DEFAULT_KEY_GATEWAY_DATA.ports }
  }
  // 1.0.6 之前区域是全局一个，迁移到每个 Key 自带：旧 Key 沿用当时的全局值
  const fallbackRegion = String(merged.region || DEFAULT_KEY_GATEWAY_DATA.region).trim()
  merged.region = fallbackRegion || DEFAULT_KEY_GATEWAY_DATA.region
  merged.keys = merged.keys.map((entry) =>
    entry.region ? entry : { ...entry, region: merged.region }
  )
  // 当前 Key 只属于已开启的网关；兼容旧版本关闭后仍保留 activeKeyId 的数据。
  if (!merged.enabled || !merged.keys.some((entry) => entry.id === merged.activeKeyId)) {
    merged.activeKeyId = null
  }
  return merged
}

export function setKeyData(data: KeyGatewayData): void {
  store.set('keyData', {
    ...data,
    activeKeyId: data.enabled ? (data.activeKeyId ?? null) : null
  })
}

// ============ 滚动备份：每次保存留一份，防止 store 损坏丢号 ============

/** 备份最短间隔，避免频繁写盘 */
const BACKUP_INTERVAL_MS = 5 * 60 * 1000
/** 最多保留的备份份数 */
const BACKUP_KEEP = 10

export function getBackupDir(): string {
  return path.join(app.getPath('userData'), 'backups')
}

let lastBackupAt = 0

/** 删除账号时同步净化滚动备份，避免旧备份继续保存已删除账号的凭证与用量快照。 */
async function purgeAccountsFromBackups(remove: Set<string>): Promise<number> {
  if (!remove.size) return 0
  try {
    const dir = getBackupDir()
    const files = (await fs.readdir(dir)).filter((name) => name.startsWith('accounts-'))
    let removed = 0
    for (const name of files) {
      const file = path.join(dir, name)
      try {
        const parsed = JSON.parse(await fs.readFile(file, 'utf-8')) as AccountStoreData
        if (!Array.isArray(parsed.accounts)) continue
        const remaining = parsed.accounts.filter((account) => !remove.has(account.id))
        const count = parsed.accounts.length - remaining.length
        if (!count) continue
        parsed.accounts = remaining
        if (parsed.activeAccountId && remove.has(parsed.activeAccountId)) {
          parsed.activeAccountId = null
        }
        await fs.writeFile(file, JSON.stringify(parsed, null, 2), 'utf-8')
        removed += count
      } catch (error) {
        console.warn(`[Store] 无法净化账号备份 ${name}:`, error)
      }
    }
    return removed
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') console.warn('[Store] purge backups failed:', error)
    return 0
  }
}

async function writeBackup(data: AccountStoreData): Promise<void> {
  if (Date.now() - lastBackupAt < BACKUP_INTERVAL_MS) return
  lastBackupAt = Date.now()
  try {
    const dir = getBackupDir()
    await fs.mkdir(dir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    await fs.writeFile(
      path.join(dir, `accounts-${stamp}.json`),
      JSON.stringify(data, null, 2),
      'utf-8'
    )

    // 文件名带 ISO 时间戳，字典序即时间序，取前面的就是最旧的
    const files = (await fs.readdir(dir)).filter((f) => f.startsWith('accounts-')).sort()
    for (const stale of files.slice(0, Math.max(0, files.length - BACKUP_KEEP))) {
      await fs.unlink(path.join(dir, stale)).catch(() => undefined)
    }
    console.log(`[Store] 已创建账号备份（共 ${data.accounts.length} 个账号）`)
  } catch (e) {
    console.warn('[Store] backup failed:', e)
  }
}
