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
  DEFAULT_PROXY_CONFIG,
  type KeyGatewayData,
  type MachineIdBackup,
  type ProxyAccountUsage,
  type ProxyApiKey,
  type ProxyConfig,
  type ProxyKeyUsage,
  type ProxyModelCache,
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

/** 写入桌面 agent 配置前的原始文件快照，用于「还原」 */
export interface ProxyClientBackupFile {
  path: string
  /** 写入前文件是否存在；false 表示还原时应删除该文件 */
  existed: boolean
  content: string
}

export interface ProxyClientBackup {
  savedAt: number
  files: ProxyClientBackupFile[]
}

interface Schema {
  accountData: AccountStoreData
  settings: AppSettings
  keyData: KeyGatewayData
  shellApproveBackup: ShellApproveBackup | null
  /** 原始机器码备份：首次重置前自动写入，用户手动备份时覆盖 */
  machineIdBackup: MachineIdBackup | null
  /** 本地反代配置 */
  proxyConfig: ProxyConfig
  /** 本地反代按账号累计的用量 */
  proxyUsage: ProxyAccountUsage[]
  /** 从账号拉回的模型列表 */
  proxyModels: ProxyModelCache | null
  /** Codex 模型目录的模板条目（取自本机 Codex 自带目录） */
  proxyCodexTemplate: Record<string, unknown> | null
  /** 各桌面 agent 被改写前的配置备份，按目标分别保存 */
  proxyClientBackups: Record<string, ProxyClientBackup>
  /** 自定义的反代 API Key（默认 Key 仍在 proxyConfig.apiKey） */
  proxyApiKeys: ProxyApiKey[]
  /** 按 Key 的用量，键是 Key 的 id */
  proxyKeyUsage: Record<string, ProxyKeyUsage>
  /** 一次性迁移标记：载荷上限默认值 900 → 153600，见 migratePayloadDefault */
  proxyPayloadDefault153600: boolean
  /** 一次性迁移标记：强制校验 API Key 统一打开，见 migratePayloadDefault */
  proxyRequireKeyDefault: boolean
}

const EMPTY_DATA: AccountStoreData = { version: 1, accounts: [], activeAccountId: null }

const store = new Store<Schema>({
  name: 'kiro-account-lite',
  encryptionKey: 'kiro-account-lite-local-key',
  defaults: {
    accountData: EMPTY_DATA,
    settings: DEFAULT_SETTINGS,
    keyData: DEFAULT_KEY_GATEWAY_DATA,
    shellApproveBackup: null,
    machineIdBackup: null,
    proxyConfig: DEFAULT_PROXY_CONFIG,
    proxyUsage: [],
    proxyModels: null,
    proxyCodexTemplate: null,
    proxyClientBackups: {},
    proxyApiKeys: [],
    proxyKeyUsage: {},
    proxyPayloadDefault153600: false,
    proxyRequireKeyDefault: false
  }
})

/*
 * 内存快照：electron-store（conf）的每次 get 都会同步读文件、用 pbkdf2 派生密钥、
 * 解密、再整份 JSON.parse；这份文件装着全部账号，反代和 Key 网关每个请求都要读好几次，
 * 直接读会让主线程（界面与 IPC）每次卡上几毫秒。主进程是这个文件唯一的写入方，
 * 所以只在首次读取时解密一次，之后读写都走内存快照，写入照常同步落盘。
 *
 * read 返回深拷贝：调用方拿到的始终是独立对象（语义与 store.get 一致），
 * 就地修改不会悄悄改掉快照，必须经 write 才生效。
 * write 存进快照的是 JSON 往返后的值，与下次从磁盘读回来的内容完全一致。
 */
let snapshot: Schema | null = null

function read<K extends keyof Schema>(key: K): Schema[K] {
  snapshot ??= store.store
  return structuredClone(snapshot[key])
}

function write<K extends keyof Schema>(key: K, value: Schema[K]): void {
  store.set(key, value)
  snapshot ??= store.store
  snapshot[key] = JSON.parse(JSON.stringify(value)) as Schema[K]
}

export function getProxyApiKeys(): ProxyApiKey[] {
  const raw = read('proxyApiKeys') as ProxyApiKey[] | undefined
  return Array.isArray(raw) ? raw.filter((k) => k && typeof k.key === 'string') : []
}

export function setProxyApiKeys(keys: ProxyApiKey[]): void {
  write('proxyApiKeys', keys)
}

export function getProxyKeyUsage(): Record<string, ProxyKeyUsage> {
  const raw = read('proxyKeyUsage') as Record<string, ProxyKeyUsage> | undefined
  return raw && typeof raw === 'object' ? raw : {}
}

export function setProxyKeyUsage(usage: Record<string, ProxyKeyUsage>): void {
  write('proxyKeyUsage', usage)
}

export function getProxyCodexTemplate(): Record<string, unknown> | null {
  const raw = read('proxyCodexTemplate') as Record<string, unknown> | null | undefined
  return raw && typeof raw === 'object' ? raw : null
}

export function setProxyCodexTemplate(template: Record<string, unknown> | null): void {
  write('proxyCodexTemplate', template)
}

export function getProxyModels(): ProxyModelCache | null {
  const raw = read('proxyModels') as ProxyModelCache | null | undefined
  return raw && Array.isArray(raw.models) && raw.models.length ? raw : null
}

export function setProxyModels(cache: ProxyModelCache): void {
  write('proxyModels', cache)
}

// ============ 本地反代 ============

/**
 * 一次性迁移：把旧版本落盘的载荷上限默认值 900 迁到当前默认值 153600。
 *
 * 只靠 DEFAULT_PROXY_CONFIG 不够：saveProxyConfig 每次都把「默认值 + 改动」整份写回，
 * 所以旧版本里只要保存过任何一项参数，900 就已经作为实值落了盘，新默认值永远盖不上去。
 * 这里把「恰好等于旧默认值」的存值当成没设置过，删掉让它回落到新默认。
 *
 * 只跑一次（用标记记住）：迁移之后用户如果自己把它设成 900，那是有意的，不能再被改掉。
 */
let payloadMigrated = false

function migratePayloadDefault(): void {
  // 每次读配置都会经过这里，查过一次就记在内存里
  if (payloadMigrated) return
  payloadMigrated = true
  migrateRequireKeyDefault()
  if (read('proxyPayloadDefault153600')) return
  const raw = read('proxyConfig') as Partial<ProxyConfig> | undefined
  if (raw && raw.payloadLimitKB === 900) {
    const { payloadLimitKB: _old, ...rest } = raw
    // 存的是缺了这个键的对象，读取时由 DEFAULT_PROXY_CONFIG 补上新默认值
    write('proxyConfig', rest as ProxyConfig)
  }
  write('proxyPayloadDefault153600', true)
}

/**
 * 一次性迁移：强制校验 API Key 默认打开。
 * 与载荷上限同理，旧版本保存过任何参数后 requireApiKey 已作为实值落盘，新默认值盖不上去，
 * 所以对已有配置统一打开一次。之后用户自己关掉是有意的，不再改回来。
 */
function migrateRequireKeyDefault(): void {
  if (read('proxyRequireKeyDefault')) return
  const raw = read('proxyConfig') as Partial<ProxyConfig> | undefined
  if (raw && raw.requireApiKey === false) write('proxyConfig', { ...raw, requireApiKey: true } as ProxyConfig)
  write('proxyRequireKeyDefault', true)
}

export function getProxyConfig(): ProxyConfig {
  migratePayloadDefault()
  const merged = { ...DEFAULT_PROXY_CONFIG, ...(read('proxyConfig') as Partial<ProxyConfig>) }
  /*
   * 界面上没有「一律用默认模型」这个选项，模型一律跟随客户端。
   * 旧版本存过 force 的用户没有地方能改回来，所以在唯一的读取入口上归一掉，
   * 否则他们会一直被锁在默认模型上，客户端里怎么切都没用。
   */
  merged.modelMode = 'client'
  return normalizeAccountStrategy(merged)
}

/**
 * 旧版本的调度字段换算成现在的策略，保证升级后选号结果不变：
 *  - single + accountId      → selected + [accountId]
 *  - roundRobin + poolIds 非空 → selected + poolIds（原来就是在这几个号里轮询）
 * 换算后删掉旧字段；下次保存时写回的就是新形状，这里不会再命中。
 */
function normalizeAccountStrategy(config: ProxyConfig): ProxyConfig {
  const legacy = config as ProxyConfig & { accountId?: string | null; poolIds?: string[] }
  const mode = legacy.accountMode as string
  if (mode === 'single') {
    config.accountMode = 'selected'
    if (!config.accountIds.length && legacy.accountId) config.accountIds = [legacy.accountId]
  } else if (mode === 'roundRobin' && legacy.poolIds?.length && !config.accountIds.length) {
    config.accountMode = 'selected'
    config.accountIds = [...legacy.poolIds]
  } else if (mode !== 'roundRobin' && mode !== 'group' && mode !== 'selected') {
    config.accountMode = 'roundRobin'
  }
  if (config.accountSource !== 'apiKey') config.accountSource = 'account'
  delete legacy.accountId
  delete legacy.poolIds
  return config
}

export function saveProxyConfig(patch: Partial<ProxyConfig>): ProxyConfig {
  const merged = { ...getProxyConfig(), ...patch }
  write('proxyConfig', merged)
  return merged
}

export function getProxyUsage(): ProxyAccountUsage[] {
  const raw = read('proxyUsage') as ProxyAccountUsage[] | undefined
  return Array.isArray(raw) ? raw : []
}

export function setProxyUsage(usage: ProxyAccountUsage[]): void {
  write('proxyUsage', usage)
}

export function getProxyClientBackup(target: string): ProxyClientBackup | null {
  const all = read('proxyClientBackups') as Record<string, ProxyClientBackup> | undefined
  const entry = all?.[target]
  return entry && Array.isArray(entry.files) ? entry : null
}

export function setProxyClientBackup(target: string, backup: ProxyClientBackup | null): void {
  const all = { ...((read('proxyClientBackups') as Record<string, ProxyClientBackup>) ?? {}) }
  if (backup) all[target] = backup
  else delete all[target]
  write('proxyClientBackups', all)
}

export function getMachineIdBackup(): MachineIdBackup | null {
  const raw = read('machineIdBackup') as MachineIdBackup | null | undefined
  if (!raw || typeof raw !== 'object' || !raw.ids || typeof raw.ids !== 'object') return null
  return raw
}

export function setMachineIdBackup(backup: MachineIdBackup | null): void {
  write('machineIdBackup', backup)
}

/** 权限配置备份：仅在开关开启期间存在，关闭还原后清空 */
export function getShellApproveBackup(): ShellApproveBackup | null {
  const raw = read('shellApproveBackup') as Record<string, unknown> | null | undefined
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
  write('shellApproveBackup', backup)
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
  if (changed) write('accountData', data)
  return data
}

export function getAccountData(): AccountStoreData {
  const data = read('accountData') as AccountStoreData | undefined
  if (!data || !Array.isArray(data.accounts)) return EMPTY_DATA
  return alignSubscriptionTypes(data)
}

export async function setAccountData(data: AccountStoreData): Promise<void> {
  write('accountData', data)
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
  return { ...DEFAULT_SETTINGS, ...(read('settings') as Partial<AppSettings>) }
}

export function setSettings(settings: Partial<AppSettings>): AppSettings {
  const merged = { ...getSettings(), ...settings }
  write('settings', merged)
  return merged
}

export function getStorePath(): string {
  return store.path
}

// ============ Key 网关数据 ============

export function getKeyData(): KeyGatewayData {
  const data = read('keyData') as Partial<KeyGatewayData> | undefined
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
  write('keyData', {
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
