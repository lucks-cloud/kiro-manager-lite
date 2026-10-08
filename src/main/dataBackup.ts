// 数据导出 / 导入（明文 JSON）与初始化
//
// 导出只带「换台机器也要接着用」的数据，其余（设置、反代监听配置、桌面 agent 写入记录、日志……）一律不带：
//  - accounts：账号（含凭证、分组、当前账号）
//  - apiKeys：Kiro API Key 列表与分组（不含网关开关、端口、IDE 端点原值，那些和本机绑定）
//  - accountUsageHistory：账号的积分变化记录
//  - apiKeyUsageHistory：API Key 的调用统计与分钟曲线
//  - proxyApiKeys：本地反代的 API Key（默认 Key + 自定义 Key）
//
// 兼容性约定（以后增减字段照这个来）：
//  - 顶层 format 固定，用来认文件；schemaVersion 只在「旧版读不懂新格式」时才加一，新增字段、新增分区都不用加。
//  - 每个分区都可以缺：缺了就是这份文件不带这部分，导入时这部分保持本机现状，不会被清空。
//  - 读不认识的分区直接跳过；记录里不认识的字段原样保留（新版本导出、旧版本导入再导出也不会丢）。
//  - 升级格式时在 migrate 里把旧版本转换成当前结构，导入代码只面对最新结构。
//
// 文件是明文，里面有账号凭证与 API Key，界面上会提醒妥善保管。
import { app, session } from 'electron'
import Store from 'electron-store'
import { existsSync, rmSync } from 'fs'
import * as path from 'path'
import {
  getAccountData,
  getBackupDir,
  getKeyData,
  getProxyApiKeys,
  getProxyConfig,
  resetStoreData,
  saveProxyConfig,
  setAccountData,
  setKeyData,
  setProxyApiKeys
} from './store'
import { flushUsageHistory } from './usageHistory'
import { flushGatewayHistory } from './gatewayHistory'
import { flushProxyData } from './proxyServer'
import type { AccountStoreData, DataBackupSummary, KeyGatewayData, ProxyApiKey } from '../shared/types'

const FORMAT = 'kiro-manager-lite-data'
/** 当前写出的结构版本；读到更大的版本仍按已知字段导入，并在摘要里提示 */
const SCHEMA_VERSION = 1

/** 辅助库的 electron-store 名字；和各模块里 new Store({ name }) 保持一致 */
const USAGE_HISTORY_STORE = 'kiro-usage-history'
const GATEWAY_HISTORY_STORE = 'kiro-gateway-history'
/** 初始化时一并清掉的辅助库（含反代请求日志，它不导出） */
const AUX_STORES = [USAGE_HISTORY_STORE, GATEWAY_HISTORY_STORE, 'kiro-proxy-logs', 'kiro-proxy-usage'] as const

type Json = Record<string, unknown>

interface DataSections {
  accounts?: AccountStoreData
  apiKeys?: Pick<KeyGatewayData, 'keys' | 'groups'>
  accountUsageHistory?: Json
  apiKeyUsageHistory?: { totals?: Json; points?: Json }
  proxyApiKeys?: {
    /** 默认 Key 存在反代配置里，不在列表中，单独带出来 */
    defaultKey?: { key: string; name?: string; creditLimit?: number } | null
    keys?: ProxyApiKey[]
  }
}

export interface DataFile {
  format: typeof FORMAT
  schemaVersion: number
  /** 导出时的应用版本 */
  appVersion: string
  /** 导出时间，毫秒时间戳 */
  exportedAt: number
  /** 同一时间的可读形式（本地时区的 ISO），方便直接打开文件看 */
  exportedAtText: string
  platform: string
  sections: DataSections
  /** 留给以后的附加信息，读取时不依赖它 */
  [extra: string]: unknown
}

/** 导入前给用户看的摘要；文件路径由调用方补上 */
export type BackupSummary = Omit<DataBackupSummary, 'file'>

/**
 * 辅助库按名字新开一个实例读写：各模块自己的实例是私有的，
 * electron-store 同名同目录就是同一个文件，多开实例只是多一个读写入口。
 */
function auxStore(name: string): Store<Json> {
  return new Store<Json>({ name })
}

function isObject(value: unknown): value is Json {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function localIso(at: number): string {
  const d = new Date(at)
  const offset = -d.getTimezoneOffset()
  const sign = offset >= 0 ? '+' : '-'
  const pad = (n: number): string => String(Math.floor(Math.abs(n))).padStart(2, '0')
  const local = new Date(at + offset * 60_000).toISOString().slice(0, 19)
  return `${local}${sign}${pad(offset / 60)}:${pad(offset % 60)}`
}

/** 生成导出内容（格式化的 JSON 文本）。先把各模块内存里没落盘的数据刷下去，导出的才是最新的 */
export function buildBackup(): string {
  flushUsageHistory()
  flushGatewayHistory()
  flushProxyData()
  const at = Date.now()
  const keyData = getKeyData()
  const proxyConfig = getProxyConfig()
  const defaultKey = proxyConfig.apiKey.trim()
  const gateway = auxStore(GATEWAY_HISTORY_STORE)
  const file: DataFile = {
    format: FORMAT,
    schemaVersion: SCHEMA_VERSION,
    appVersion: app.getVersion(),
    exportedAt: at,
    exportedAtText: localIso(at),
    platform: process.platform,
    sections: {
      accounts: getAccountData(),
      apiKeys: { keys: keyData.keys, groups: keyData.groups ?? [] },
      accountUsageHistory: (auxStore(USAGE_HISTORY_STORE).get('history') as Json) ?? {},
      apiKeyUsageHistory: {
        totals: (gateway.get('totals') as Json) ?? {},
        points: (gateway.get('points') as Json) ?? {}
      },
      proxyApiKeys: {
        defaultKey: defaultKey
          ? { key: defaultKey, name: proxyConfig.defaultKeyName, creditLimit: proxyConfig.defaultKeyCreditLimit }
          : null,
        keys: getProxyApiKeys()
      }
    }
  }
  return `${JSON.stringify(file, null, 2)}\n`
}

/**
 * 旧版本结构转换成当前结构。现在只有 v1；以后改了不兼容的结构，在这里按版本逐级转换，
 * 例如 if (file.schemaVersion < 2) { 把 v1 的写法改成 v2 }。
 */
function migrate(file: DataFile): DataFile {
  return file
}

/** 解析并校验；不是本应用导出的文件一律拒绝 */
export function parseBackup(text: string): DataFile {
  let parsed: unknown
  try {
    // 去掉 BOM：用 Windows 记事本另存过的文件开头会带一个
    parsed = JSON.parse(text.replace(/^\uFEFF/, ''))
  } catch {
    throw new Error('无法读取该文件：不是有效的 JSON，或文件已损坏')
  }
  if (!isObject(parsed) || parsed.format !== FORMAT || !isObject(parsed.sections)) {
    throw new Error('该文件不是 Kiro Manager Lite 导出的数据文件')
  }
  const version = typeof parsed.schemaVersion === 'number' ? parsed.schemaVersion : 1
  return migrate({ ...(parsed as DataFile), schemaVersion: version })
}

function arrayLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0
}

export function summarizeBackup(file: DataFile): BackupSummary {
  const s = file.sections
  const proxyKeys = arrayLength(s.proxyApiKeys?.keys) + (s.proxyApiKeys?.defaultKey?.key ? 1 : 0)
  return {
    exportedAt: typeof file.exportedAt === 'number' ? file.exportedAt : 0,
    appVersion: typeof file.appVersion === 'string' ? file.appVersion : '',
    newerSchema: file.schemaVersion > SCHEMA_VERSION,
    accounts: isObject(s.accounts) ? arrayLength(s.accounts.accounts) : null,
    apiKeys: isObject(s.apiKeys) ? arrayLength(s.apiKeys.keys) : null,
    proxyKeys: isObject(s.proxyApiKeys) ? proxyKeys : null,
    usageHistory: isObject(s.accountUsageHistory) || isObject(s.apiKeyUsageHistory)
  }
}

/**
 * 把文件里带了的分区写进本机，没带的分区保持现状。必须同步执行完、紧接着重启应用：
 * 各模块手里还有内存缓存与延迟落盘的定时器，给它们留出运行的机会，就会把旧数据写回去。
 */
export function applyBackup(file: DataFile): void {
  const s = file.sections

  if (isObject(s.accounts) && Array.isArray(s.accounts.accounts)) {
    const current = getAccountData()
    void setAccountData({
      ...current,
      ...s.accounts,
      version: current.version,
      accounts: s.accounts.accounts,
      groups: Array.isArray(s.accounts.groups) ? s.accounts.groups : []
    })
  }

  if (isObject(s.apiKeys) && Array.isArray(s.apiKeys.keys)) {
    // 网关开关、端口、IDE 端点原值是本机的，只换 Key 和分组；当前 Key 不在新列表里时 getKeyData 会自动置空
    const current = getKeyData()
    setKeyData({
      ...current,
      keys: s.apiKeys.keys,
      groups: Array.isArray(s.apiKeys.groups) ? s.apiKeys.groups : []
    })
  }

  if (isObject(s.accountUsageHistory)) {
    auxStore(USAGE_HISTORY_STORE).set('history', s.accountUsageHistory)
  }

  if (isObject(s.apiKeyUsageHistory)) {
    const gateway = auxStore(GATEWAY_HISTORY_STORE)
    gateway.set('totals', isObject(s.apiKeyUsageHistory.totals) ? s.apiKeyUsageHistory.totals : {})
    gateway.set('points', isObject(s.apiKeyUsageHistory.points) ? s.apiKeyUsageHistory.points : {})
  }

  if (isObject(s.proxyApiKeys)) {
    if (Array.isArray(s.proxyApiKeys.keys)) setProxyApiKeys(s.proxyApiKeys.keys)
    const def = s.proxyApiKeys.defaultKey
    if (isObject(def) && typeof def.key === 'string' && def.key.trim()) {
      saveProxyConfig({
        apiKey: def.key.trim(),
        ...(typeof def.name === 'string' ? { defaultKeyName: def.name } : {}),
        ...(typeof def.creditLimit === 'number' ? { defaultKeyCreditLimit: def.creditLimit } : {})
      })
    }
  }
}

/**
 * 全部数据回到初始状态（同样要紧接着重启）：主库、辅助库、备份目录、内置浏览器登录缓存。
 * 系统日志由调用方先用 clearLogs 清掉；还原外部配置（机器码、Kiro IDE 端点、权限、桌面 agent）也由调用方先做，
 * 这里只管本应用自己的数据。
 */
export function wipeLocalData(): void {
  resetStoreData()
  for (const name of AUX_STORES) auxStore(name).clear()
  const userData = app.getPath('userData')
  for (const dir of [getBackupDir(), path.join(userData, 'login-browser')]) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  }
}

/** 渲染层自己的小状态（定时任务上次执行时间、更新检查缓存等）也一并清掉 */
export async function clearRendererStorage(): Promise<void> {
  await session.defaultSession.clearStorageData({ storages: ['localstorage'] })
}
