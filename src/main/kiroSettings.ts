// Kiro IDE settings.json 读写层
//
// Key 网关要接管 Kiro IDE 的内置对话，靠的是把 IDE 用户设置里的
//   codewhisperer.config.krsEndpoints  （生成面）
//   codewhisperer.config.cpsEndpoints  （控制面）
// 指向本应用起的本地代理，让 kiro-agent 透明地走到我们这里。
//
// 本应用位于 IDE 进程之外，无法使用 vscode API 获取当前 profile，
// 因此按平台默认路径定位 <userData>/User/settings.json，并对 profile 进行兜底扫描。
import * as fs from 'fs/promises'
import {
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  mkdirSync,
  watch,
  type FSWatcher
} from 'fs'
import * as path from 'path'
import * as os from 'os'
import { URL } from 'url'
import type { KeyGatewayConflict } from '../shared/types'

/** Kiro IDE 用户数据根目录（跨平台） */
export function kiroUserDataDir(): string {
  const home = os.homedir()
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Kiro')
  }
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Kiro')
  }
  // Linux 及其它
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'Kiro')
}

/**
 * 定位当前生效的 settings.json。
 * 默认返回 <userData>/User/settings.json；若该文件不存在但存在 profile 目录，
 * 则退而取第一个 profile 的 settings.json（多数用户用默认 profile，直接命中第一条）。
 */
export function kiroSettingsPath(): string {
  const base = path.join(kiroUserDataDir(), 'User')
  const defaultPath = path.join(base, 'settings.json')
  if (existsSync(defaultPath)) return defaultPath

  // profile 场景兜底
  const profilesDir = path.join(base, 'profiles')
  if (existsSync(profilesDir)) {
    try {
      const entries = require('fs').readdirSync(profilesDir) as string[]
      for (const name of entries) {
        const p = path.join(profilesDir, name, 'settings.json')
        if (existsSync(p)) return p
      }
    } catch {
      /* ignore */
    }
  }
  return defaultPath
}

/** Kiro IDE 是否已安装（存在用户数据目录） */
export function isKiroInstalled(): boolean {
  return existsSync(kiroUserDataDir())
}

const KRS_KEY = 'codewhisperer.config.krsEndpoints'
const CPS_KEY = 'codewhisperer.config.cpsEndpoints'

/** 我们对外声明会重定向的区域；本地代理统一转发到用户配置的实际区域 */
const REDIRECT_REGIONS = ['us-east-1', 'eu-central-1']

export interface EndpointEntry {
  region: string
  endpoint: string
}

export interface EndpointSnapshot {
  krs: EndpointEntry[]
  cps: EndpointEntry[]
}

/** 生成指向本地端口的端点覆盖列表（含当前区域，避免漏掉正在用的那个） */
function endpointOverride(port: number, activeRegion: string): EndpointEntry[] {
  const regions = [...new Set([activeRegion, ...REDIRECT_REGIONS].map((r) => r.trim()).filter(Boolean))]
  return regions.map((region) => ({ region, endpoint: `http://127.0.0.1:${port}` }))
}

/**
 * 解析可能带注释 / 尾逗号的 JSONC（VSCode 系 settings.json 允许注释）。
 * 简单粗暴地剥掉 // 与 /* *\/ 注释和尾逗号后再 JSON.parse。
 */
function parseJsonc(raw: string): Record<string, unknown> {
  const text = String(raw || '').replace(/^\uFEFF/, '')
  const stripped = text
    .replace(/\\"|"(?:\\"|[^"])*"|(\/\/[^\n\r]*|\/\*[\s\S]*?\*\/)/g, (m, c) => (c ? '' : m))
    .replace(/,(\s*[}\]])/g, '$1')
  return JSON.parse(stripped || '{}')
}

async function readSettings(file: string): Promise<Record<string, unknown>> {
  try {
    const raw = await fs.readFile(file, 'utf-8')
    return parseJsonc(raw)
  } catch {
    return {}
  }
}

/** 原子写回 settings.json（保留一份 .kiro-manager.bak 首次备份） */
async function writeSettings(file: string, obj: Record<string, unknown>): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const backup = file + '.kiro-manager.bak'
  if (existsSync(file) && !existsSync(backup)) {
    await fs.copyFile(file, backup).catch(() => undefined)
  }
  const tmp = file + '.kiro-manager.tmp'
  const text = JSON.stringify(obj, null, 2) + '\n'
  await fs.writeFile(tmp, text, 'utf-8')
  try {
    await fs.rename(tmp, file)
  } catch {
    await fs.writeFile(file, text, 'utf-8')
    await fs.unlink(tmp).catch(() => undefined)
  }
}

/**
 * 供其它模块复用的 settings.json 读写（如「自动同意所有 Shell 命令」需要改 kiroAgent.* 键）。
 * 统一走同一套 JSONC 解析 + 首次备份 + 原子写，避免出现第二套实现。
 */
export async function readKiroSettingsObject(
  file = kiroSettingsPath()
): Promise<Record<string, unknown>> {
  return readSettings(file)
}

export async function writeKiroSettingsObject(
  obj: Record<string, unknown>,
  file = kiroSettingsPath()
): Promise<void> {
  return writeSettings(file, obj)
}

function normalizeList(value: unknown): EndpointEntry[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((e): e is Record<string, unknown> => !!e && typeof e === 'object')
    .map((e) => ({
      region: String(e.region || '').trim(),
      endpoint: String(e.endpoint || '').trim().replace(/\/$/, '')
    }))
    .filter((e) => e.region && e.endpoint)
    .sort((a, b) => a.region.localeCompare(b.region) || a.endpoint.localeCompare(b.endpoint))
}

function listsEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(normalizeList(a)) === JSON.stringify(normalizeList(b))
}

const LOCAL_ENDPOINT_RE = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?/i

function isLocalEndpoint(endpoint: string): boolean {
  return LOCAL_ENDPOINT_RE.test(endpoint)
}

/** 从 http://127.0.0.1:19820 里取出端口；没写端口按协议默认值 */
function endpointPort(endpoint: string): number | null {
  try {
    const url = new URL(endpoint)
    if (url.port) return Number(url.port)
    return url.protocol === 'https:' ? 443 : 80
  } catch {
    return null
  }
}

/** 只保留官方（非本地）端点：恢复时绝不能把 IDE 指回某个本地网关 */
function withoutLocalEntries(list: EndpointEntry[]): EndpointEntry[] {
  return list.filter((entry) => !isLocalEndpoint(entry.endpoint))
}

/**
 * 开启前互斥检查：只要端点已经指向其它本地地址，就不能静默覆盖，
 * 避免多个本地网关同时修改同一份 IDE 配置。
 * 返回结构化冲突信息，界面据此提供「强制接管」；无冲突返回 null。
 */
export async function endpointConflict(
  krsPort: number,
  cpsPort: number,
  activeRegion: string
): Promise<KeyGatewayConflict | null> {
  const obj = await readSettings(kiroSettingsPath())
  const expectedKrs = endpointOverride(krsPort, activeRegion)
  const expectedCps = endpointOverride(cpsPort, activeRegion)
  const local = [...normalizeList(obj[KRS_KEY]), ...normalizeList(obj[CPS_KEY])]
    .filter((entry) => isLocalEndpoint(entry.endpoint))
  if (!local.length) return null
  if (listsEqual(obj[KRS_KEY], expectedKrs) && listsEqual(obj[CPS_KEY], expectedCps)) return null
  const endpoints = [...new Set(local.map((entry) => entry.endpoint))]
  const ports = [
    ...new Set(
      endpoints
        .map((endpoint) => endpointPort(endpoint))
        .filter((port): port is number => port !== null)
    )
  ]
  return {
    message: `Kiro IDE 已被其它本地网关接管（${endpoints.join('、')}）。请先关闭其它本地网关或同类工具。`,
    endpoints,
    ports
  }
}

/**
 * 把端点指向本地代理。已经是目标值则不重复写。
 * 返回原始端点，关闭时必须原样恢复，而不是武断地清空数组。
 */
export async function applyEndpointOverride(
  krsPort: number,
  cpsPort: number,
  activeRegion: string
): Promise<{ changed: boolean; settingsPath: string; original: EndpointSnapshot }> {
  const file = kiroSettingsPath()
  const obj = await readSettings(file)
  // 记录原值时剔除本地网关端点：无论原来指向本应用的残留端口还是别的工具，
  // 关闭接管时都应还原成官方端点，而不是把 IDE 指回一个不再监听的本地端口。
  const original = {
    krs: withoutLocalEntries(normalizeList(obj[KRS_KEY])),
    cps: withoutLocalEntries(normalizeList(obj[CPS_KEY]))
  }
  const krsExpected = endpointOverride(krsPort, activeRegion)
  const cpsExpected = endpointOverride(cpsPort, activeRegion)

  if (listsEqual(obj[KRS_KEY], krsExpected) && listsEqual(obj[CPS_KEY], cpsExpected)) {
    return { changed: false, settingsPath: file, original }
  }
  obj[KRS_KEY] = krsExpected
  obj[CPS_KEY] = cpsExpected
  await writeSettings(file, obj)

  // 写后回读校验，不能把“写文件没抛错”当作接管成功。
  const readBack = await readSettings(file)
  if (!listsEqual(readBack[KRS_KEY], krsExpected) || !listsEqual(readBack[CPS_KEY], cpsExpected)) {
    readBack[KRS_KEY] = original.krs
    readBack[CPS_KEY] = original.cps
    await writeSettings(file, readBack).catch(() => undefined)
    throw new Error(`Kiro 端点写入后校验失败，已恢复原配置：${file}`)
  }
  return { changed: true, settingsPath: file, original }
}

/** 恢复到接管前记录的端点值。 */
export async function restoreEndpointOverride(
  original: EndpointSnapshot = { krs: [], cps: [] },
  file = kiroSettingsPath()
): Promise<{ changed: boolean; settingsPath: string }> {
  const obj = await readSettings(file)
  if (listsEqual(obj[KRS_KEY], original.krs) && listsEqual(obj[CPS_KEY], original.cps)) {
    return { changed: false, settingsPath: file }
  }
  obj[KRS_KEY] = original.krs
  obj[CPS_KEY] = original.cps
  await writeSettings(file, obj)
  return { changed: true, settingsPath: file }
}

/**
 * Electron will-quit 不等待 Promise，退出路径必须同步完成配置还原。
 * 只修改两个端点键，其余设置保留。
 */
export function restoreEndpointOverrideSync(
  original: EndpointSnapshot = { krs: [], cps: [] },
  file = kiroSettingsPath()
): void {
  try {
    const raw = existsSync(file) ? readFileSync(file, 'utf-8') : '{}'
    const obj = parseJsonc(raw)
    obj[KRS_KEY] = original.krs
    obj[CPS_KEY] = original.cps
    mkdirSync(path.dirname(file), { recursive: true })
    const tmp = file + '.kiro-manager.tmp'
    const text = JSON.stringify(obj, null, 2) + '\n'
    writeFileSync(tmp, text, 'utf-8')
    try {
      renameSync(tmp, file)
    } catch {
      writeFileSync(file, text, 'utf-8')
      try {
        unlinkSync(tmp)
      } catch {
        /* ignore */
      }
    }
  } catch {
    // 退出阶段不能抛异常阻断其它清理；主进程下次启动还会再做残留恢复。
  }
}

/** 当前 settings.json 里端点是否已指向指定端口的本地代理 */
export async function isEndpointBound(krsPort: number, cpsPort: number, activeRegion: string): Promise<boolean> {
  const file = kiroSettingsPath()
  const obj = await readSettings(file)
  return (
    listsEqual(obj[KRS_KEY], endpointOverride(krsPort, activeRegion)) &&
    listsEqual(obj[CPS_KEY], endpointOverride(cpsPort, activeRegion))
  )
}

/**
 * 接管期间守护端点配置，被外部改写就自动改回本地网关。
 *
 * 背景：Kiro IDE 启动时会按自己内存里的设置整份回写 settings.json，把我们注入的两个键
 * 刷成空数组（实测本机：15:05:49 应用写入并通过回读校验 → 15:05:52 IDE 启动 →
 * 15:05:54 磁盘上的 127.0.0.1 端点消失）。IDE 已加载到内存的值不受影响，所以当前会话
 * 照旧走网关，但磁盘配置已经丢了，IDE 下次重启就会直连官方端点，接管被静默撤销。
 *
 * 监视的是 settings.json 所在目录而非文件本身：写入方普遍用「写临时文件 + rename」做原子
 * 替换，直接监视文件会因 inode 变更而失效。
 *
 * 不存在写入回环：我们自己的写入同样会触发回调，但那时端点已是目标值，校验通过就不再写。
 */
export function watchEndpointOverride(options: {
  krsPort: number
  cpsPort: number
  /** 动态取当前区域：换 Key / 换区后期望值会变，不能在注册时固化 */
  getRegion: () => string
  onRepair?: (info: { settingsPath: string }) => void
  onError?: (message: string) => void
}): () => void {
  const file = kiroSettingsPath()
  const dir = path.dirname(file)
  const base = path.basename(file)
  let watcher: FSWatcher | null = null
  let timer: NodeJS.Timeout | null = null
  let checking = false
  let stopped = false

  const check = async (): Promise<void> => {
    if (stopped || checking) return
    checking = true
    try {
      const activeRegion = options.getRegion()
      if (await isEndpointBound(options.krsPort, options.cpsPort, activeRegion)) return
      // 读取期间可能已被摘掉（用户正好点了关闭网关）：写下去会把刚还原的官方端点又改回本地
      if (stopped) return
      const applied = await applyEndpointOverride(options.krsPort, options.cpsPort, activeRegion)
      if (!stopped && applied.changed) options.onRepair?.({ settingsPath: applied.settingsPath })
    } catch (error) {
      options.onError?.(error instanceof Error ? error.message : String(error))
    } finally {
      checking = false
    }
  }

  // IDE 回写常是连续多次写入，聚合一小段时间再校验，避免来回抢写
  const schedule = (): void => {
    if (stopped) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      void check()
    }, 400)
  }

  try {
    watcher = watch(dir, (_event, filename) => {
      // 拿不到文件名时保守校验；校验本身只是读一个文件做比对，代价很低
      if (!filename) return schedule()
      const name = path.basename(String(filename))
      if (name !== base && !name.startsWith(base + '.')) return
      schedule()
    })
    watcher.on('error', (error) => {
      options.onError?.(error instanceof Error ? error.message : String(error))
    })
  } catch (error) {
    options.onError?.(error instanceof Error ? error.message : String(error))
  }

  return () => {
    stopped = true
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    try {
      watcher?.close()
    } catch {
      /* ignore */
    }
    watcher = null
  }
}
