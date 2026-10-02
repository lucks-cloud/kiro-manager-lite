// 备份计划：按设置里的周期静默导出全部数据到备份目录，只保留最新的几份
//
// 产物和手动「导出数据」完全一致（同一个 buildBackup），可以直接拿去导入。
// 跑在主进程里而不是渲染层：窗口最小化到托盘、甚至关掉窗口（托盘常驻）时也要照常执行。
import { mkdir, readdir, stat, unlink, writeFile } from 'fs/promises'
import * as path from 'path'
import { powerMonitor } from 'electron'
import { buildBackup } from './dataBackup'
import { ensureBackupDir, getBackupDir, getSettings } from './store'
import { log } from './logger'
import { errorMessage } from '../shared/errors'
import { nextBackupAt, normalizeBackupCycle, normalizeBackupKeep } from '../shared/backupSchedule'
import type { BackupScheduleStatus } from '../shared/types'
import Store from 'electron-store'

/** 自动备份的文件名前缀；清理旧备份时只认这个前缀，用户自己放进目录的文件不碰 */
const AUTO_PREFIX = 'auto-'

/*
 * 上次执行时间单独存一份小文件，不放进设置：
 * 设置会被导出进备份、导入时整体替换，把「上次备份时间」也带过去会让新机器以为刚备份过。
 * 清除全部数据时这份文件在 userData 里，随 wipeLocalData 一起清掉（见 clearBackupState）。
 */
const stateStore = new Store<{ lastAt: number | null; lastError: string | null; anchor: number | null }>({
  name: 'kiro-backup-state',
  defaults: { lastAt: null, lastError: null, anchor: null }
})

let timer: NodeJS.Timeout | null = null
let running = false
let onChange: (status: BackupScheduleStatus) => void = () => undefined

/** 定时器最长只挂这么久：setTimeout 超过 2^31 毫秒会溢出立即触发，月度周期必然超；睡眠唤醒后也要重新对时 */
const MAX_WAIT_MS = 6 * 60 * 60 * 1000

/** 起算点：上次执行和上次改设置，取较晚的那个 */
function anchor(): number {
  return Math.max(stateStore.get('lastAt') ?? 0, stateStore.get('anchor') ?? 0) || Date.now()
}

function computeNext(): number | null {
  const settings = getSettings()
  if (!settings.backupEnabled) return null
  return nextBackupAt(normalizeBackupCycle(settings.backupCycle), anchor())
}

async function autoFiles(): Promise<string[]> {
  try {
    // 文件名带时间戳，字典序就是时间序
    return (await readdir(getBackupDir())).filter((f) => f.startsWith(AUTO_PREFIX) && f.endsWith('.json')).sort()
  } catch {
    return []
  }
}

export async function backupStatus(): Promise<BackupScheduleStatus> {
  return {
    lastAt: stateStore.get('lastAt'),
    lastError: stateStore.get('lastError'),
    nextAt: computeNext(),
    count: (await autoFiles()).length
  }
}

async function notify(): Promise<void> {
  onChange(await backupStatus())
}

function stamp(at: number): string {
  const d = new Date(at)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/** 只保留最新 keep 份自动备份 */
async function prune(keep: number): Promise<void> {
  const files = await autoFiles()
  for (const name of files.slice(0, Math.max(0, files.length - keep))) {
    await unlink(path.join(getBackupDir(), name)).catch(() => undefined)
  }
}

/** 执行一次备份。计划里到点调用；也供「立即备份」按钮用 */
export async function runBackupNow(): Promise<BackupScheduleStatus> {
  if (running) return backupStatus()
  running = true
  const at = Date.now()
  try {
    const dir = getBackupDir()
    await mkdir(dir, { recursive: true })
    const file = path.join(dir, `${AUTO_PREFIX}kiro-manager-lite-${stamp(at)}.json`)
    await writeFile(file, buildBackup(), 'utf8')
    await prune(normalizeBackupKeep(getSettings().backupKeep))
    stateStore.set({ lastAt: at, lastError: null })
    log('info', `[Backup] 自动备份完成：${path.basename(file)}（${((await stat(file)).size / 1024).toFixed(0)} KB）`)
  } catch (error) {
    // 失败也记下时间：否则磁盘满之类的持续性错误会让定时器每次一到点就重试、刷屏
    stateStore.set({ lastAt: at, lastError: errorMessage(error) })
    log('warn', `[Backup] 自动备份失败：${errorMessage(error)}`)
  } finally {
    running = false
  }
  schedule()
  await notify()
  return backupStatus()
}

function schedule(): void {
  if (timer) clearTimeout(timer)
  timer = null
  const next = computeNext()
  if (next === null) return
  const wait = next - Date.now()
  // 已经过点（应用没开、电脑睡眠时错过了）：立即补跑一次，不按错过的次数补
  if (wait <= 0) {
    timer = setTimeout(() => void runBackupNow(), 1_000)
    return
  }
  timer = setTimeout(() => (Date.now() >= next ? void runBackupNow() : schedule()), Math.min(wait, MAX_WAIT_MS))
}

/**
 * 设置里备份相关的项变了：重新排程。
 * 开启计划、改周期都从「现在」重新起算——否则改成 N 分钟时会拿很久以前的上次时间去算，
 * 一保存就立刻跑一次，用户只是在调设置。
 */
export function onBackupSettingsChanged(): void {
  stateStore.set('anchor', Date.now())
  schedule()
  void notify()
}

export function initBackupScheduler(push: (status: BackupScheduleStatus) => void): void {
  onChange = push
  ensureBackupDir()
  if (stateStore.get('anchor') === null) stateStore.set('anchor', Date.now())
  schedule()
  // 睡眠唤醒后定时器可能已经错过，重新对一次时
  powerMonitor.on('resume', schedule)
}

export function stopBackupScheduler(): void {
  if (timer) clearTimeout(timer)
  timer = null
}

/** 清除全部数据时调用：上次备份时间等状态一起回到初始 */
export function clearBackupState(): void {
  stopBackupScheduler()
  stateStore.clear()
}
