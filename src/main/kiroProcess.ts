// Kiro IDE 进程控制：检测是否在运行、优雅退出、重新拉起
//
// 切号只是把凭证写到磁盘，已经在运行的 IDE 仍然握着上一个账号的 accessToken，
// 界面上就会出现「明明切了号，IDE 还报 Invalid token」。重启一次 IDE 让它重新读盘
// 是最稳的收尾动作，所以这里提供跨平台的重启能力。
import { execFile, spawn } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { sleep, waitUntil } from './utils'
import type { RestartIdeResult } from '../shared/types'

/** 每轮等待 IDE 退出的间隔 */
const QUIT_POLL_MS = 300

/**
 * Linux 上匹配 Kiro IDE 进程的命令行。
 *
 * 不能用裸的 `kiro`：本应用在 Linux 上的可执行文件叫 kiro-account-lite，
 * `pgrep -f kiro` 会把自己算进去，`pkill -f kiro` 更会把自己一起杀掉。
 * 这里要求 kiro 是一个完整的路径段（/usr/share/kiro/kiro、/opt/Kiro/kiro、AppImage 挂载点下的 kiro），
 * 后面紧跟空格或行尾。故意区分大小写，避免命中「/opt/Kiro Manager Lite/...」这类安装目录。
 */
const LINUX_KIRO_PATTERN = '(^|/)kiro( |$)'

/** execFile 的 promise 版：只关心 stdout，失败不抛 */
function run(cmd: string, args: string[], timeout = 8000): Promise<{ ok: boolean; stdout: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, windowsHide: true }, (error, stdout) => {
      resolve({ ok: !error, stdout: String(stdout ?? '') })
    })
  })
}

/** IDE 是否在运行 */
export async function isKiroRunning(): Promise<boolean> {
  if (process.platform === 'darwin') {
    const res = await run('pgrep', ['-f', 'Kiro.app/Contents/MacOS/'])
    return res.stdout.trim().length > 0
  }
  if (process.platform === 'win32') {
    const res = await run('tasklist', ['/FI', 'IMAGENAME eq Kiro.exe', '/NH'])
    return res.stdout.toLowerCase().includes('kiro.exe')
  }
  const res = await run('pgrep', ['-f', LINUX_KIRO_PATTERN])
  return res.stdout.trim().length > 0
}

/** IDE 已经完全退出 */
const kiroStopped = async (): Promise<boolean> => !(await isKiroRunning())

/** 优雅退出，必要时强杀。返回是否确认已退出 */
async function quitKiro(): Promise<boolean> {
  if (!(await isKiroRunning())) return false

  if (process.platform === 'darwin') {
    await run('osascript', ['-e', 'quit app "Kiro"'])
  } else if (process.platform === 'win32') {
    await run('taskkill', ['/IM', 'Kiro.exe'])
  } else {
    await run('pkill', ['-f', LINUX_KIRO_PATTERN])
  }

  // 给 IDE 一点时间保存状态；超时后强杀，否则新实例会被旧实例接管
  if (await waitUntil(kiroStopped, 20, QUIT_POLL_MS)) return true

  if (process.platform === 'darwin') await run('pkill', ['-f', 'Kiro.app/Contents/MacOS/'])
  else if (process.platform === 'win32') await run('taskkill', ['/F', '/IM', 'Kiro.exe'])
  else await run('pkill', ['-9', '-f', LINUX_KIRO_PATTERN])

  return waitUntil(kiroStopped, 10, QUIT_POLL_MS)
}

/** Windows / Linux 上找 Kiro 可执行文件 */
function findKiroExecutable(): string | undefined {
  const home = os.homedir()
  const candidates =
    process.platform === 'win32'
      ? [
          path.join(home, 'AppData', 'Local', 'Programs', 'kiro', 'Kiro.exe'),
          path.join(process.env.LOCALAPPDATA || '', 'Programs', 'kiro', 'Kiro.exe'),
          path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Kiro', 'Kiro.exe')
        ]
      : [
          '/usr/bin/kiro',
          '/usr/local/bin/kiro',
          // deb / rpm 包的实际安装位置，/usr/bin/kiro 只是指向它的软链，个别发行版不建软链
          '/usr/share/kiro/kiro',
          '/opt/Kiro/kiro',
          '/opt/kiro/kiro',
          '/snap/bin/kiro'
        ]
  return candidates.find((p) => p && fs.existsSync(p))
}

/** 拉起 IDE */
async function startKiro(): Promise<boolean> {
  if (process.platform === 'darwin') {
    const res = await run('open', ['-a', 'Kiro'])
    return res.ok
  }
  const exe = findKiroExecutable()
  if (!exe) return false
  try {
    // detached + unref：管理器自身退出时不会把 IDE 一起带走
    spawn(exe, [], { detached: true, stdio: 'ignore', windowsHide: false }).unref()
    return true
  } catch {
    return false
  }
}

/** 打开 / 关闭 IDE 的结果，供菜单等入口直接拿去提示 */
interface IdeActionResult {
  ok: boolean
  message: string
}

/** 打开 Kiro IDE；已在运行时把它带到前台（macOS `open -a` 的天然行为） */
export async function openKiroIde(): Promise<IdeActionResult> {
  const running = await isKiroRunning()
  if (await startKiro()) {
    return { ok: true, message: running ? 'Kiro IDE 已切换到前台' : 'Kiro IDE 已启动' }
  }
  return { ok: false, message: '没找到 Kiro IDE 可执行文件，请手动打开' }
}

/** 关闭 Kiro IDE；没在运行时直接返回 */
export async function closeKiroIde(): Promise<IdeActionResult> {
  if (!(await isKiroRunning())) return { ok: true, message: 'Kiro IDE 当前没有在运行' }
  return (await quitKiro())
    ? { ok: true, message: 'Kiro IDE 已关闭' }
    : { ok: false, message: '未能关闭 Kiro IDE，请手动退出' }
}

/**
 * 重启 Kiro IDE。IDE 没在运行时直接启动。
 * 任何一步失败都不抛异常，把结论交给界面提示用户手动处理。
 */
export async function restartKiroIde(): Promise<RestartIdeResult> {
  const running = await isKiroRunning()
  const quit = running ? await quitKiro() : false

  if (running && !quit) {
    return {
      quit: false,
      started: false,
      message: '未能退出 Kiro IDE，请手动关闭后再打开，凭证已经写入磁盘'
    }
  }

  // 退出后稍等一下再拉起，避免旧进程的单例锁还没释放
  if (quit) await sleep(800)

  const started = await startKiro()
  if (!started) {
    return {
      quit,
      started: false,
      message: quit
        ? '已关闭 Kiro IDE，但没找到可执行文件，请手动打开'
        : '没找到 Kiro IDE 可执行文件，请手动打开'
    }
  }

  return {
    quit,
    started: true,
    message: quit ? 'Kiro IDE 已重启' : 'Kiro IDE 已启动'
  }
}
