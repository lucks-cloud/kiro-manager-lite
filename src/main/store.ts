// 本地持久化（electron-store，账号数据加密存放）
import Store from 'electron-store'
import { app } from 'electron'
import * as path from 'path'
import { copyFileSync, existsSync, mkdirSync } from 'fs'
import {
  DEFAULT_KEY_GATEWAY_DATA,
  DEFAULT_PRIMARY_COLOR,
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
interface ShellApproveBackup {
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

/** 本应用写过 KIRO_API_KEY 的记录，移除时据此还原 */
export interface KiroCliEnvBackup {
  writtenAt: number
  /** macOS / Linux：写过的启动文件；created 表示文件是我们新建的，移除后为空就删掉 */
  files: { path: string; created: boolean }[]
  /** Windows：第一次写入前用户原有的值（没有则为 null），移除时写回 */
  previousWindowsValue: string | null
}

interface ProxyClientBackup {
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
  /** 升级前的反代按账号用量；现存于 proxyUsageStore，这里只在迁移时读一次 */
  proxyUsage?: ProxyAccountUsage[]
  /** 从账号拉回的模型列表 */
  proxyModels: ProxyModelCache | null
  /** Codex 模型目录的模板条目（取自本机 Codex 自带目录） */
  proxyCodexTemplate: Record<string, unknown> | null
  /** 各桌面 agent 被改写前的配置备份，按目标分别保存 */
  proxyClientBackups: Record<string, ProxyClientBackup>
  /** 用户手动指定的客户端安装位置（.app / .exe / 命令行可执行文件），按目标保存 */
  proxyClientPaths: Record<string, string>
  /** 自定义的反代 API Key（默认 Key 仍在 proxyConfig.apiKey） */
  proxyApiKeys: ProxyApiKey[]
  /** 升级前的反代按 Key 用量；现存于 proxyUsageStore，这里只在迁移时读一次 */
  proxyKeyUsage?: Record<string, ProxyKeyUsage>
  /** 一次性迁移标记：载荷上限默认值 900 → 153600，见 migratePayloadDefault */
  proxyPayloadDefault153600: boolean
  /** 一次性迁移标记：强制校验 API Key 统一打开，见 migratePayloadDefault */
  proxyRequireKeyDefault: boolean
  /** 写入 Kiro CLI 环境变量的记录，见 kiroCliEnv */
  kiroCliEnvBackup: KiroCliEnvBackup | null
}

const EMPTY_DATA: AccountStoreData = { version: 1, accounts: [], activeAccountId: null }

const STORE_NAME = 'kiro-account-lite'

/** 升级到 electron-store 12 前的主库副本文件名（不含扩展名），清除全部数据时一并删除 */
export const PRE_UPGRADE_STORE_COPY = `${STORE_NAME}.pre-v1038`

/**
 * 升级到 electron-store 12 之前留一份原文件副本。
 *
 * 新版底层（conf 16）能读旧版（conf 8 / conf 10）写的加密文件，升级没问题；
 * 但它写回时换了密钥派生的 salt，旧版读不回去。用户若把应用退回旧版本，
 * 旧版会在启动时解密失败。副本只做一次（有了就不再覆盖），
 * 退回旧版本时把它改回原名即可继续使用。
 */
function backupBeforeStoreFormatChange(): void {
  try {
    const dir = app.getPath('userData')
    const source = path.join(dir, `${STORE_NAME}.json`)
    const target = path.join(dir, `${PRE_UPGRADE_STORE_COPY}.json`)
    if (existsSync(source) && !existsSync(target)) copyFileSync(source, target)
  } catch {
    // 备份失败不影响启动：正常读写用的是原文件，这份副本只在退回旧版本时才需要
  }
}

backupBeforeStoreFormatChange()

/*
 * 不要加 conf 的 cache 选项：开了之后 store.store 返回的是被冻结的对象，
 * 下面 write() 里的 snapshot[key] = … 会直接抛错。
 * 这个文件本身就是为了省掉重复解密与解析，缓存由下面的 snapshot 负责。
 */
const store = new Store<Schema>({
  name: STORE_NAME,
  encryptionKey: 'kiro-account-lite-local-key',
  defaults: {
    accountData: EMPTY_DATA,
    settings: DEFAULT_SETTINGS,
    keyData: DEFAULT_KEY_GATEWAY_DATA,
    shellApproveBackup: null,
    machineIdBackup: null,
    proxyConfig: DEFAULT_PROXY_CONFIG,
    proxyModels: null,
    proxyCodexTemplate: null,
    proxyClientBackups: {},
    proxyClientPaths: {},
    proxyApiKeys: [],
    proxyPayloadDefault153600: false,
    proxyRequireKeyDefault: false,
    kiroCliEnvBackup: null
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

/**
 * 不拷贝，直接返回快照里的对象，只给只读调用方用。
 * 账号数据约 2MB，深拷贝一次在主线程上要 1ms 多；反代每个请求选号都要读一遍，
 * 走这条路省掉这次拷贝。返回值不能修改，要改的调用方用 read（经 write 才生效）。
 */
function peek<K extends keyof Schema>(key: K): Readonly<Schema[K]> {
  snapshot ??= store.store
  return snapshot[key]
}

/**
 * 写入合并：快照立即更新（之后的读取马上看到新值），落盘攒一小段时间再一次写完。
 *
 * 为什么要合并：conf 的每次 set 都要把整个文件读回来、pbkdf2 派生密钥、解密、JSON.parse，
 * 改完再派生一次密钥、加密、整份写盘。这个文件装着全部账号，上千个账号时一次就是上百毫秒的主线程阻塞；
 * 批量同步 Key、批量测活、反代刷新 Token 时每秒可能写几十次，界面与 IPC 会被卡住。
 * 合并后同一段时间内的多次修改只落一次盘，内容和逐次写完全一致（写的就是最新快照）。
 *
 * 只延迟 STORE_FLUSH_MS：正常退出、导入后重启、清除数据前都会立即 flushStore，
 * 只有进程被强杀时可能丢最后这一小段的修改。
 */
const STORE_FLUSH_MS = 300
const dirtyKeys = new Set<keyof Schema>()
let storeFlushTimer: NodeJS.Timeout | null = null

/** 把待写的键一次写进磁盘；退出、重启、导出前调用 */
export function flushStore(): void {
  if (storeFlushTimer) {
    clearTimeout(storeFlushTimer)
    storeFlushTimer = null
  }
  if (!snapshot || !dirtyKeys.size) return
  const patch: Partial<Schema> = {}
  for (const key of dirtyKeys) (patch as Record<string, unknown>)[key] = snapshot[key]
  dirtyKeys.clear()
  // 对象形式的 set 一次写完全部键：只读一次文件、只加密写一次
  ;(store.set as (patch: Partial<Schema>) => void)(patch)
}

function write<K extends keyof Schema>(key: K, value: Schema[K]): void {
  snapshot ??= store.store
  // 快照里存 JSON 往返后的值，与之后从磁盘读回的内容完全一致，也和调用方的对象断开引用
  snapshot[key] = JSON.parse(JSON.stringify(value)) as Schema[K]
  dirtyKeys.add(key)
  if (storeFlushTimer) return
  storeFlushTimer = setTimeout(flushStore, STORE_FLUSH_MS)
}

// 兜底：任何退出路径（含 app.exit）在进程结束前都把没写的写掉
process.on('exit', flushStore)

// ============ 初始化 ============

/** 主库回到出厂默认值 */
export function resetStoreData(): void {
  // 清空前丢掉待写的修改，否则它会在清空之后把旧数据又写回去
  if (storeFlushTimer) clearTimeout(storeFlushTimer)
  storeFlushTimer = null
  dirtyKeys.clear()
  store.clear()
  snapshot = null
}

/** 有改写前快照的桌面 agent（即当前写入过、还没还原的那些） */
export function proxyClientBackupTargets(): string[] {
  // 只取键名，不必整表深拷贝
  const all = peek('proxyClientBackups') as Readonly<Record<string, ProxyClientBackup>> | undefined
  return Object.keys(all ?? {})
}

export function getProxyApiKeys(): ProxyApiKey[] {
  const raw = read('proxyApiKeys') as ProxyApiKey[] | undefined
  return Array.isArray(raw) ? raw.filter((k) => k && typeof k.key === 'string') : []
}

export function setProxyApiKeys(keys: ProxyApiKey[]): void {
  write('proxyApiKeys', keys)
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
 * 一次性迁移：磁盘上存的载荷上限若是旧默认值 900，迁到当前默认值 153600。
 *
 * 只靠 DEFAULT_PROXY_CONFIG 不够：saveProxyConfig 每次都把「默认值 + 改动」整份写回，
 * 只要保存过任何一项参数，900 就已经作为实值落了盘，默认值盖不上去。
 * 这里把「恰好等于旧默认值」的存值当成没设置过，删掉让它回落到当前默认。
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
 * 与载荷上限同理，保存过任何参数后 requireApiKey 已作为实值落盘，默认值盖不上去，
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
   * 配置里存着 force 的用户没有地方能改回来，所以在唯一的读取入口上归一掉，
   * 否则他们会一直被锁在默认模型上，客户端里怎么切都没用。
   */
  merged.modelMode = 'client'
  return normalizeAccountStrategy(merged)
}

/**
 * 已存配置里的旧调度字段换算成当前策略，保证选号结果不变：
 *  - single + accountId      → selected + [accountId]
 *  - roundRobin + poolIds 非空 → selected + poolIds（旧字段的含义就是在这几个号里轮询）
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

/**
 * 取出主库里残留的反代用量统计并从主库删掉。
 * 统计存在单独的 kiro-proxy-usage 文件（见 proxyUsageStore），这里只在首次载入时调一次，
 * 把主库里残留的数据交过去。
 */
export function takeLegacyProxyUsage(): {
  accounts: ProxyAccountUsage[]
  keys: Record<string, ProxyKeyUsage>
} {
  const accounts = read('proxyUsage') as ProxyAccountUsage[] | undefined
  const keys = read('proxyKeyUsage') as Record<string, ProxyKeyUsage> | undefined
  /*
   * 用内存快照判断有没有残留，不用 store.has：它每次都要同步读文件、pbkdf2 派生密钥、解密。
   * 这两个键没有任何 write 路径，快照里的有无与磁盘上一致。
   */
  snapshot ??= store.store
  if ('proxyUsage' in snapshot || 'proxyKeyUsage' in snapshot) {
    store.delete('proxyUsage')
    store.delete('proxyKeyUsage')
    snapshot = null
  }
  return {
    accounts: Array.isArray(accounts) ? accounts : [],
    keys: keys && typeof keys === 'object' ? keys : {}
  }
}

export function getProxyClientBackup(target: string): ProxyClientBackup | null {
  // 只深拷贝取出的这一项，调用方拿到的仍是独立对象
  const all = peek('proxyClientBackups') as Readonly<Record<string, ProxyClientBackup>> | undefined
  const entry = all?.[target]
  return entry && Array.isArray(entry.files) ? structuredClone(entry) : null
}

export function getProxyClientPaths(): Record<string, string> {
  const raw = read('proxyClientPaths') as Record<string, string> | undefined
  return raw && typeof raw === 'object' ? raw : {}
}

/** 传 null 表示清掉手动指定，回到自动检测 */
export function setProxyClientPath(target: string, value: string | null): void {
  // 浅拷贝即可：值都是字符串，write 内部还会 JSON 往返一次断开引用
  const raw = peek('proxyClientPaths') as Readonly<Record<string, string>> | undefined
  const all: Record<string, string> = { ...(raw && typeof raw === 'object' ? raw : {}) }
  if (value) all[target] = value
  else delete all[target]
  write('proxyClientPaths', all)
}

export function setProxyClientBackup(target: string, backup: ProxyClientBackup | null): void {
  // 浅拷贝后写入：write 内部 JSON 往返，不会改到快照里的原对象
  const all = { ...((peek('proxyClientBackups') as Readonly<Record<string, ProxyClientBackup>>) ?? {}) }
  if (backup) all[target] = backup
  else delete all[target]
  write('proxyClientBackups', all)
}

export function getKiroCliEnvBackup(): KiroCliEnvBackup | null {
  const raw = read('kiroCliEnvBackup') as KiroCliEnvBackup | null | undefined
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.files)) return null
  return raw
}

export function setKiroCliEnvBackup(backup: KiroCliEnvBackup | null): void {
  write('kiroCliEnvBackup', backup)
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

  // 1.0.4 以下版本写的备份只含 permissions.yaml、字段平铺在顶层，读取时换算成当前形状
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
 * subscription.type 是从 title 派生出来的持久化值。磁盘上可能有 Power 账号存着
 * 'Enterprise'，而 Enterprise 不是订阅档位（它是登录方式）。判定逻辑只作用于新算出的值，
 * 不重新对齐的话已存的值不会变，筛选面板里的 Power 会一直是 0，除非把每个账号的用量都重新刷一遍。
 *
 * 放在这个唯一读取入口上做，比放在渲染进程的 store.load() 里可靠：后者只在 load
 * 时跑一次，热重载或 store 状态被保留时根本不会执行。
 * 幂等；title 缺失时无判据，只把已废弃的档位归到 Free，其余保持原值。
 */
/**
 * 已对齐过的账号表（按对象身份记）。快照里的账号表只在写入时整体换新，
 * 同一个对象对齐一次就够了；反代每个请求都经 viewAccountData 读一次，
 * 不记的话上千个账号每个请求都要整表再扫一遍。
 */
const alignedTables = new WeakSet<AccountStoreData>()

function alignSubscriptionTypes(data: AccountStoreData): AccountStoreData {
  if (alignedTables.has(data)) return data
  alignedTables.add(data)
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

/** 账号数据的独立副本：调用方可以修改，改完经 setAccountData 落盘 */
export function getAccountData(): AccountStoreData {
  const data = read('accountData') as AccountStoreData | undefined
  if (!data || !Array.isArray(data.accounts)) return EMPTY_DATA
  return alignSubscriptionTypes(data)
}

/**
 * 账号数据的只读视图（不拷贝），给反代选号、健康检查、IPC 下发这类只读不写的场景。
 * 订阅档位同样会对齐：对齐是在快照上就地改写并落盘，和走 getAccountData 结果一致。
 */
export function viewAccountData(): Readonly<AccountStoreData> {
  const data = peek('accountData') as AccountStoreData | undefined
  if (!data || !Array.isArray(data.accounts)) return EMPTY_DATA
  return alignSubscriptionTypes(data)
}

export async function setAccountData(data: AccountStoreData): Promise<void> {
  write('accountData', data)
}

/** 从主进程最新快照删除账号，避免渲染进程用旧整表覆盖主动续期刚写入的新凭证 */
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
  return { accounts, removed }
}

export function getSettings(): AppSettings {
  const raw = (read('settings') ?? {}) as Partial<AppSettings> & { darkMode?: unknown }
  const { darkMode, ...rest } = raw
  const merged: AppSettings = { ...DEFAULT_SETTINGS, ...rest }
  /*
   * 已存设置里可能只有 darkMode 开关而没有 themeMode，此时按 darkMode 换算，明暗保持不变；
   * 不能直接落到默认的「自动」，否则开着浅色的人会在系统深色时突然变黑。
   * 旧键在下一次保存时自然被丢掉（rest 里已经没有它）。
   */
  if (rest.themeMode === undefined && typeof darkMode === 'boolean') {
    merged.themeMode = darkMode ? 'dark' : 'light'
  }
  // 存值不是十六进制色值（如 system）时回到默认紫
  if (!/^#[0-9a-f]{6}$/i.test(merged.primaryColor)) merged.primaryColor = DEFAULT_PRIMARY_COLOR
  return merged
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

/** Key 网关数据的独立副本：调用方可以修改，改完经 setKeyData 落盘 */
export function getKeyData(): KeyGatewayData {
  return normalizeKeyData(read('keyData') as Partial<KeyGatewayData> | undefined)
}

/**
 * Key 网关数据的只读视图，按快照对象身份缓存，写入后自动失效。
 *
 * 网关每转发一个请求都要读当前 Key 与区域，走 getKeyData 就是整表深拷贝再逐条补默认值；
 * 上千个 Key 时这一步每个请求都要好几毫秒。返回值不能修改，要改的调用方用 getKeyData。
 */
let keyView: { source: unknown; data: KeyGatewayData } | null = null

export function viewKeyData(): Readonly<KeyGatewayData> {
  const source = peek('keyData')
  if (keyView?.source !== source) {
    keyView = { source, data: normalizeKeyData(structuredClone(source) as Partial<KeyGatewayData>) }
  }
  return keyView.data
}

function normalizeKeyData(data: Partial<KeyGatewayData> | undefined): KeyGatewayData {
  // 用默认值打底，兼容旧数据缺字段
  const merged: KeyGatewayData = { ...DEFAULT_KEY_GATEWAY_DATA, ...(data ?? {}) }
  if (!Array.isArray(merged.keys)) merged.keys = []
  if (!merged.ports || typeof merged.ports.krs !== 'number' || typeof merged.ports.cps !== 'number') {
    merged.ports = { ...DEFAULT_KEY_GATEWAY_DATA.ports }
  }
  // 区域按 Key 各存一份；没有 region 的 Key（1.0.6 以下版本写入）沿用顶层的全局区域
  const fallbackRegion = String(merged.region || DEFAULT_KEY_GATEWAY_DATA.region).trim()
  merged.region = fallbackRegion || DEFAULT_KEY_GATEWAY_DATA.region
  merged.keys = merged.keys.map((entry) =>
    entry.region ? entry : { ...entry, region: merged.region }
  )
  // 当前 Key 只属于已开启的网关；网关关闭或 activeKeyId 指向不存在的 Key 时清空。
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

// ============ 备份目录 ============

/** 自动备份（备份计划）的 .kml 存放位置；清除全部数据时整个目录一起删 */
export function getBackupDir(): string {
  return path.join(app.getPath('userData'), 'backups')
}

/**
 * 确保备份目录存在。启动时就建好：设置页上能看到这个路径、能点「打开备份目录」，
 * 不能等第一次备份才出现（目录不存在时打开会静默失败，看起来像按钮坏了）。
 */
export function ensureBackupDir(): string {
  const dir = getBackupDir()
  try {
    mkdirSync(dir, { recursive: true })
  } catch (error) {
    console.warn('[Store] 创建备份目录失败:', error)
  }
  return dir
}
