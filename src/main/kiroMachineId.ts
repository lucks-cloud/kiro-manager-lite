// Kiro IDE 机器码：读取、重置、备份与恢复
//
// Kiro 是 VS Code 的 fork，设备标识散落在好几处，只改一处 IDE 下次启动会从别处读回来：
//   1. <数据目录>/User/globalStorage/storage.json
//        telemetry.machineId   64 位 hex，即 vscode.env.machineId，用于遥测与会话标识。
//        注意：官方请求 UA `KiroIDE-<版本>-<机器码>` 里的机器码**不是**它，而是
//        node-machine-id 对系统设备标识（IOPlatformUUID / MachineGuid）做的 sha256，
//        只在取不到系统标识时才回落到它；所以重置这里的值不会改变 UA，见 kiroEndpoints
//        telemetry.devDeviceId UUID，只是下面第 4 项的缓存
//        telemetry.sqmId       仅 Windows 有值
//   2. <数据目录>/machineid                      UUID
//   3. <数据目录>/User/globalStorage/state.vscdb  ItemTable 里的 storage.serviceMachineId
//   4. Microsoft DeveloperTools 共享 deviceid    IDE 每次启动都从这里读 devDeviceId，
//      只改 storage.json 的缓存是无效的。它与 VS Code 等工具共用。
//
// IDE 运行时会在退出前把内存里的值写回 storage.json，并且独占 state.vscdb，
// 所以写入前必须先关掉 IDE，写完再按需拉起。
import { execFile } from 'child_process'
import * as crypto from 'crypto'
import { existsSync } from 'fs'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import type { DatabaseSync } from 'node:sqlite'
import { kiroUserDataDir } from './kiroSettings'
import { closeKiroIde, isKiroRunning, openKiroIde } from './kiroProcess'
import { getMachineIdBackup, setMachineIdBackup } from './store'
import { errorMessage } from '../shared/errors'
import type {
  MachineIdActionResult,
  MachineIdField,
  MachineIdLocation,
  MachineIdSnapshot,
  MachineIdStatus
} from '../shared/types'

const STORAGE_KEYS = {
  machineId: 'telemetry.machineId',
  devDeviceId: 'telemetry.devDeviceId',
  sqmId: 'telemetry.sqmId'
} as const

const SERVICE_MACHINE_ID_KEY = 'storage.serviceMachineId'

/** Windows 上共享 deviceid 所在的注册表项 */
const WIN_DEVICE_ID_KEY = 'HKCU\\SOFTWARE\\Microsoft\\DeveloperTools'
const WIN_DEVICE_ID_VALUE = 'deviceid'

const FIELDS: MachineIdField[] = [
  'machineId',
  'devDeviceId',
  'sqmId',
  'machineIdFile',
  'serviceMachineId',
  'sharedDeviceId'
]

// ============ 路径 ============

function globalStorageDir(): string {
  return path.join(kiroUserDataDir(), 'User', 'globalStorage')
}

function storageJsonPath(): string {
  return path.join(globalStorageDir(), 'storage.json')
}

function stateDbPath(): string {
  return path.join(globalStorageDir(), 'state.vscdb')
}

function machineIdFilePath(): string {
  return path.join(kiroUserDataDir(), 'machineid')
}

/** 共享 deviceid 文件路径（macOS / Linux）；Windows 走注册表，返回 undefined */
function sharedDeviceIdFile(): string | undefined {
  const home = os.homedir()
  if (process.platform === 'win32') return undefined
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Microsoft', 'DeveloperTools', 'deviceid')
  }
  return path.join(
    process.env.XDG_CACHE_HOME || path.join(home, '.cache'),
    'Microsoft',
    'DeveloperTools',
    'deviceid'
  )
}

function locations(): MachineIdLocation[] {
  const storage = storageJsonPath()
  return [
    { field: 'machineId', label: 'telemetry.machineId', path: storage },
    { field: 'devDeviceId', label: 'telemetry.devDeviceId', path: storage },
    { field: 'sqmId', label: 'telemetry.sqmId', path: storage },
    { field: 'machineIdFile', label: 'machineid', path: machineIdFilePath() },
    { field: 'serviceMachineId', label: 'storage.serviceMachineId', path: stateDbPath() },
    {
      field: 'sharedDeviceId',
      label: '共享 deviceid',
      path: sharedDeviceIdFile() ?? `${WIN_DEVICE_ID_KEY}\\${WIN_DEVICE_ID_VALUE}`
    }
  ]
}

// ============ 通用读写 ============

async function readTextIfExists(file: string): Promise<string | undefined> {
  try {
    return await fs.readFile(file, 'utf-8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/** 原子写：临时文件 + rename，避免 IDE 读到写入一半的内容 */
async function writeAtomic(file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.kiro-manager.tmp`
  await fs.writeFile(tmp, content, 'utf-8')
  try {
    await fs.rename(tmp, file)
  } catch {
    await fs.writeFile(file, content, 'utf-8')
    await fs.unlink(tmp).catch(() => undefined)
  }
}

/** 值为 undefined 时删除文件，对应「备份时该文件本来就不存在」 */
async function writeOrRemove(file: string, value: string | undefined): Promise<void> {
  if (value === undefined) {
    await fs.unlink(file).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
    })
    return
  }
  await writeAtomic(file, value)
}

function run(cmd: string, args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    // execFile 不经过 shell，参数原样传入，不存在注入问题
    execFile(cmd, args, { timeout: 8000, windowsHide: true }, (error, stdout, stderr) => {
      resolve({ ok: !error, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
    })
  })
}

// ============ storage.json ============

async function readStorageJson(): Promise<Record<string, unknown> | undefined> {
  const text = await readTextIfExists(storageJsonPath())
  if (text === undefined || !text.trim()) return undefined
  try {
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined
  } catch {
    // 解析失败时绝不回写，否则会把 IDE 的窗口状态等其它键一起抹掉
    throw new Error('storage.json 不是合法的 JSON，已停止写入，请先检查该文件')
  }
}

async function writeStorageIds(ids: MachineIdSnapshot): Promise<void> {
  const data = (await readStorageJson()) ?? {}
  for (const [field, key] of Object.entries(STORAGE_KEYS) as [keyof typeof STORAGE_KEYS, string][]) {
    const value = ids[field]
    if (value === undefined) delete data[key]
    else data[key] = value
  }
  // 与 VS Code 自己写盘时的格式一致：4 空格缩进
  await writeAtomic(storageJsonPath(), JSON.stringify(data, null, 4))
}

// ============ state.vscdb ============

type SqliteModule = { DatabaseSync: typeof DatabaseSync }

/**
 * 按需加载 node:sqlite。
 * 走 getBuiltinModule 而不是静态 import：打包器不认识这个较新的内置模块名，
 * 而且只有真正读写 state.vscdb 时才需要它。
 */
function loadSqlite(): SqliteModule | undefined {
  try {
    return process.getBuiltinModule?.('node:sqlite') as SqliteModule | undefined
  } catch {
    return undefined
  }
}

function openStateDb(readOnly: boolean): DatabaseSync | undefined {
  const file = stateDbPath()
  if (!existsSync(file)) return undefined
  const sqlite = loadSqlite()
  if (!sqlite) throw new Error('当前运行环境不支持 SQLite，无法处理 state.vscdb')
  return new sqlite.DatabaseSync(file, { readOnly })
}

function readServiceMachineId(): string | undefined {
  let db: DatabaseSync | undefined
  try {
    db = openStateDb(true)
    if (!db) return undefined
    const row = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(SERVICE_MACHINE_ID_KEY) as
      | { value?: unknown }
      | undefined
    return typeof row?.value === 'string' ? row.value : undefined
  } catch {
    // IDE 运行中数据库可能被锁，读不到就按缺失展示，不影响其它字段
    return undefined
  } finally {
    db?.close()
  }
}

function writeServiceMachineId(value: string | undefined): void {
  const db = openStateDb(false)
  // IDE 从没生成过这个库时不凭空创建，下次启动它会自己建
  if (!db) return
  try {
    if (value === undefined) {
      db.prepare('DELETE FROM ItemTable WHERE key = ?').run(SERVICE_MACHINE_ID_KEY)
    } else {
      db.prepare('INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)').run(
        SERVICE_MACHINE_ID_KEY,
        value
      )
    }
  } finally {
    db.close()
  }
}

// ============ 共享 deviceid ============

async function readSharedDeviceId(): Promise<string | undefined> {
  const file = sharedDeviceIdFile()
  if (file) return (await readTextIfExists(file))?.trim() || undefined

  const res = await run('reg', ['query', WIN_DEVICE_ID_KEY, '/v', WIN_DEVICE_ID_VALUE])
  if (!res.ok) return undefined
  const match = res.stdout.match(/deviceid\s+REG_SZ\s+(\S+)/i)
  return match?.[1]
}

async function writeSharedDeviceId(value: string | undefined): Promise<void> {
  const file = sharedDeviceIdFile()
  if (file) return writeOrRemove(file, value)

  const args =
    value === undefined
      ? ['delete', WIN_DEVICE_ID_KEY, '/v', WIN_DEVICE_ID_VALUE, '/f']
      : ['add', WIN_DEVICE_ID_KEY, '/v', WIN_DEVICE_ID_VALUE, '/t', 'REG_SZ', '/d', value, '/f']
  const res = await run('reg', args)
  // 删除一个本就不存在的值会报错，这种情况视为成功
  if (!res.ok && value !== undefined) {
    throw new Error(res.stderr.trim() || '写入注册表失败')
  }
}

// ============ 快照 ============

async function readSnapshot(): Promise<MachineIdSnapshot> {
  const storage = await readStorageJson().catch(() => undefined)
  const pickString = (key: string): string | undefined => {
    const value = storage?.[key]
    return typeof value === 'string' ? value : undefined
  }
  return {
    machineId: pickString(STORAGE_KEYS.machineId),
    devDeviceId: pickString(STORAGE_KEYS.devDeviceId),
    sqmId: pickString(STORAGE_KEYS.sqmId),
    machineIdFile: (await readTextIfExists(machineIdFilePath()).catch(() => undefined))?.trim() || undefined,
    serviceMachineId: readServiceMachineId(),
    sharedDeviceId: await readSharedDeviceId().catch(() => undefined)
  }
}

function sameSnapshot(a: MachineIdSnapshot, b: MachineIdSnapshot): boolean {
  return FIELDS.every((field) => (a[field] ?? '') === (b[field] ?? ''))
}

/** 一整套新标识：格式与 IDE 自己生成的保持一致 */
function generateSnapshot(current: MachineIdSnapshot): MachineIdSnapshot {
  const devDeviceId = crypto.randomUUID()
  return {
    machineId: crypto.createHash('sha256').update(crypto.randomBytes(32)).digest('hex'),
    // devDeviceId 与共享 deviceid 必须相同，IDE 启动时以后者为准
    devDeviceId,
    sharedDeviceId: devDeviceId,
    // sqmId 只有 Windows 会用，格式是带花括号的大写 GUID；其它平台保持原样（通常是空串）
    sqmId:
      process.platform === 'win32' ? `{${crypto.randomUUID().toUpperCase()}}` : (current.sqmId ?? ''),
    machineIdFile: crypto.randomUUID(),
    serviceMachineId: crypto.randomUUID()
  }
}

// ============ 对外接口 ============

export async function getMachineIdStatus(): Promise<MachineIdStatus> {
  const current = await readSnapshot()
  const backup = getMachineIdBackup()
  return {
    current,
    backup,
    locations: locations(),
    matchesBackup: !!backup && sameSnapshot(current, backup.ids),
    kiroMissing: !existsSync(kiroUserDataDir())
  }
}

/**
 * 写入一整套标识。逐项写，单项失败记进 warnings 而不是整体回滚：
 * 各处彼此独立，已经写成功的部分依然有效，比全部作废更有用。
 * storage.json 例外——它是主存储，失败直接抛出。
 */
async function writeSnapshot(ids: MachineIdSnapshot): Promise<string[]> {
  const warnings: string[] = []
  await writeStorageIds(ids)

  const steps: [string, () => Promise<void> | void][] = [
    ['machineid 文件', () => writeOrRemove(machineIdFilePath(), ids.machineIdFile)],
    ['state.vscdb', () => writeServiceMachineId(ids.serviceMachineId)],
    ['共享 deviceid', () => writeSharedDeviceId(ids.sharedDeviceId)]
  ]
  for (const [label, step] of steps) {
    try {
      await step()
    } catch (error) {
      warnings.push(`${label}写入失败：${errorMessage(error)}`)
    }
  }
  return warnings
}

/** 关 IDE → 写入 → 原本在运行则重新拉起 */
async function withIdeClosed(
  write: () => Promise<string[]>
): Promise<Omit<MachineIdActionResult, 'status'>> {
  const wasRunning = await isKiroRunning()
  if (wasRunning) {
    const closed = await closeKiroIde()
    if (!closed.ok) throw new Error('未能关闭 Kiro IDE，请手动退出后再试')
  }

  const warnings = await write()

  let ideRestarted = false
  if (wasRunning) ideRestarted = (await openKiroIde()).ok
  return { ideClosed: wasRunning, ideRestarted, warnings }
}

/** 生成一整套新机器码。没有备份时先把当前值存为原始备份 */
export async function resetMachineId(): Promise<MachineIdActionResult> {
  if (!existsSync(kiroUserDataDir())) throw new Error('没有找到 Kiro 数据目录，请先安装并启动一次 Kiro IDE')

  const result = await withIdeClosed(async () => {
    // 关掉 IDE 之后再读：IDE 退出时会把内存里的值刷回 storage.json，这时读到的才是最终值
    const current = await readSnapshot()
    if (!getMachineIdBackup()) setMachineIdBackup({ savedAt: Date.now(), ids: current })
    return writeSnapshot(generateSnapshot(current))
  })
  return { ...result, status: await getMachineIdStatus() }
}

/** 把备份的原始机器码写回。备份保留，可重复恢复 */
export async function restoreMachineId(): Promise<MachineIdActionResult> {
  const backup = getMachineIdBackup()
  if (!backup) throw new Error('还没有备份，无法恢复')

  const result = await withIdeClosed(() => writeSnapshot(backup.ids))
  return { ...result, status: await getMachineIdStatus() }
}

/** 某项标识所在的文件，用于「打开所在目录」；注册表项没有文件，返回 undefined */
export function machineIdLocationFile(field: MachineIdField): string | undefined {
  if (field === 'sharedDeviceId') return sharedDeviceIdFile()
  return locations().find((item) => item.field === field)?.path
}
