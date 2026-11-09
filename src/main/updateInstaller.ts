// 应用内更新：下载安装包、校验 sha256，再交给一个独立的小脚本在本应用退出后安装
//
// 为什么不用 electron-updater：它在 macOS 上走 Squirrel.Mac，装新版前要校验新旧两版的代码签名
// 属于同一开发者，本应用没有 Developer ID 签名，这一步必然失败。三端统一用这一套自己实现的流程：
//
//   1. 下载：走 net.ts（跟随设置里的代理），边下边算 sha256，进度节流后推给界面；可随时取消
//   2. 校验：大小与 GitHub 给附件算好的 sha256 都对上才算完成，否则删掉重来
//   3. 安装：写一个助手脚本并独立拉起，然后本应用走正常退出流程（will-quit 里还原 Kiro IDE 端点、
//      停反代、刷盘），助手等本进程真正退出后再动安装包：
//        macOS   打开 pkg，用系统「安装器」的界面安装；安装器关掉后重新打开应用
//        Windows 运行 NSIS 安装向导；向导最后一页自带「运行 Kiro Manager Lite」
//        Linux   用新 AppImage 替换正在用的那个文件，再启动它
//
// 不在应用运行时直接安装：安装器会原地替换 .app / 程序目录里的文件，进程已加载的旧代码
// 与磁盘上的新文件混在一起，读资源时可能出错。也不直接强杀：会跳过 will-quit 的收尾，
// 网关接管过的 Kiro IDE settings.json 留在指向已停止端口的状态。
import { app } from 'electron'
import { spawn } from 'child_process'
import { createHash } from 'crypto'
import { createWriteStream, existsSync, promises as fsp, constants as fsConstants } from 'fs'
import { tmpdir } from 'os'
import * as path from 'path'
import { httpStream } from './net'
import { resolveUpdateAsset } from './updater'
import { cleanChildEnv } from './childEnv'
import { errorMessage } from '../shared/errors'
import type { UpdateAsset, UpdateProgress } from '../shared/types'

/** 下载目录：系统临时目录下单独一个子目录，启动时清掉上次的残留 */
const UPDATE_DIR = path.join(tmpdir(), 'kiro-manager-lite-update')
/** 连续这么久收不到数据就判定卡住，中断这次下载 */
const STALL_TIMEOUT_MS = 60_000
/** 进度推送间隔：每个分片都推会把 IPC 打满 */
const PROGRESS_INTERVAL_MS = 200
/** 助手等本进程退出的上限：正常退出几秒内就结束，超时说明卡在某处 */
const WAIT_EXIT_SECONDS = 45

type Notify = (progress: UpdateProgress) => void

let notify: Notify = () => undefined
let state: UpdateProgress = idleState()
let controller: AbortController | null = null
/** 校验通过、等待安装的文件 */
let readyFile: string | null = null

function idleState(): UpdateProgress {
  return { phase: 'idle', version: '', fileName: '', received: 0, total: 0, speed: 0 }
}

function update(patch: Partial<UpdateProgress>, force = true): void {
  state = { ...state, ...patch }
  if (force) notify(state)
}

export function initUpdateInstaller(onProgress: Notify): void {
  notify = onProgress
  // 上次留下的安装包（Windows 安装器运行中删不掉，只能下次启动清）与半截下载
  void fsp.rm(UPDATE_DIR, { recursive: true, force: true }).catch(() => undefined)
}

export function getUpdateProgress(): UpdateProgress {
  return state
}

/** 文件名只允许常规字符，防止拼路径时被带出下载目录 */
function safeFileName(name: string): string {
  if (!/^[\w.-]+$/.test(name) || name.includes('..')) throw new Error('安装包文件名不合法')
  return name
}

/**
 * 下载并校验指定版本的安装包。单飞：已在下载就直接返回当前状态。
 * 进度经 notify 推送；返回时 phase 为 ready / error / canceled 之一。
 */
export async function downloadUpdate(version: string): Promise<UpdateProgress> {
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(version)) throw new Error('版本号不合法')
  if (state.phase === 'downloading' || state.phase === 'verifying') return state
  if (state.phase === 'installing') throw new Error('正在安装更新')
  // 同一版本已经下好就不必再下
  if (state.phase === 'ready' && state.version === version && readyFile && existsSync(readyFile)) {
    notify(state)
    return state
  }

  readyFile = null
  controller = new AbortController()
  const signal = controller.signal
  update({ ...idleState(), phase: 'downloading', version })

  let asset: UpdateAsset
  try {
    asset = await resolveUpdateAsset(version)
  } catch (error) {
    controller = null
    update({ phase: 'error', error: errorMessage(error) })
    return state
  }
  if (signal.aborted) {
    controller = null
    update({ phase: 'canceled' })
    return state
  }

  let fileName: string
  try {
    fileName = safeFileName(asset.name)
  } catch (error) {
    controller = null
    update({ phase: 'error', error: errorMessage(error) })
    return state
  }
  update({ fileName, total: asset.size, expectedSha256: asset.sha256, actualSha256: undefined })

  const target = path.join(UPDATE_DIR, fileName)
  const partial = `${target}.part`

  try {
    await fsp.mkdir(UPDATE_DIR, { recursive: true })
    await fsp.rm(partial, { force: true })
    const hash = await streamToFile(asset, partial, signal)

    // 校验结果不论是否一致都带给界面，让用户能对照两边的值
    update({ phase: 'verifying', speed: 0, actualSha256: hash })
    const stat = await fsp.stat(partial)
    if (stat.size !== asset.size) {
      throw new Error(`下载的文件大小不对（${stat.size} / ${asset.size} 字节），可能下载不完整，请重试`)
    }
    if (hash !== asset.sha256) {
      throw new Error('安装包校验失败（sha256 不一致），文件可能损坏或被篡改，已删除，请重试')
    }
    await fsp.rm(target, { force: true })
    await fsp.rename(partial, target)
    if (process.platform !== 'win32') await fsp.chmod(target, 0o755)

    readyFile = target
    update({ phase: 'ready', received: asset.size })
    console.log(`[Update] 安装包已就绪：${target}`)
  } catch (error) {
    await fsp.rm(partial, { force: true }).catch(() => undefined)
    if (signal.aborted) {
      update({ phase: 'canceled', speed: 0 })
      console.log('[Update] 用户取消了下载')
    } else {
      update({ phase: 'error', speed: 0, error: errorMessage(error) })
      console.warn(`[Update] 下载失败：${errorMessage(error)}`)
    }
  } finally {
    controller = null
  }
  return state
}

/** 边下边写边算 sha256；返回十六进制摘要 */
async function streamToFile(asset: UpdateAsset, file: string, signal: AbortSignal): Promise<string> {
  const res = await httpStream(asset.url, {
    method: 'GET',
    headers: { 'User-Agent': `kiro-manager-lite/${app.getVersion()}`, Accept: 'application/octet-stream' },
    signal,
    connectTimeoutMs: 30_000
  })
  if (!res.ok || !res.body) throw new Error(`下载失败：GitHub 返回 ${res.status}`)

  const hash = createHash('sha256')
  const out = createWriteStream(file)
  const reader = res.body.getReader()

  // 卡住检测：一段时间没收到数据就中断。复用同一个 signal 的话会被当成「用户取消」，这里单独记原因
  let stalled = false
  let stallTimer: NodeJS.Timeout | null = null
  const armStall = (): void => {
    if (stallTimer) clearTimeout(stallTimer)
    stallTimer = setTimeout(() => {
      stalled = true
      void reader.cancel().catch(() => undefined)
    }, STALL_TIMEOUT_MS)
  }
  const onAbort = (): void => void reader.cancel().catch(() => undefined)
  signal.addEventListener('abort', onAbort, { once: true })

  let received = 0
  let lastEmit = 0
  // 速度取最近一个窗口的平均值，避免一开始的突发把数字顶得很高
  let windowStart = Date.now()
  let windowBytes = 0

  try {
    armStall()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (signal.aborted) throw new Error('已取消')
      armStall()
      hash.update(value)
      received += value.byteLength
      windowBytes += value.byteLength
      if (!out.write(value)) await new Promise<void>((resolve) => out.once('drain', resolve))

      const now = Date.now()
      if (now - lastEmit >= PROGRESS_INTERVAL_MS) {
        const elapsed = (now - windowStart) / 1000
        const speed = elapsed > 0 ? Math.round(windowBytes / elapsed) : 0
        if (now - windowStart >= 2000) {
          windowStart = now
          windowBytes = 0
        }
        lastEmit = now
        update({ received, speed })
      }
    }
    if (signal.aborted) throw new Error('已取消')
    if (stalled) throw new Error('下载长时间没有进展，已中断，请检查网络或代理后重试')
    update({ received })
  } catch (error) {
    if (stalled && !signal.aborted) {
      throw new Error('下载长时间没有进展，已中断，请检查网络或代理后重试')
    }
    throw error
  } finally {
    if (stallTimer) clearTimeout(stallTimer)
    signal.removeEventListener('abort', onAbort)
    await new Promise<void>((resolve) => out.end(() => resolve()))
  }
  return hash.digest('hex')
}

/** 取消正在进行的下载；已下好等待安装的，一并丢弃 */
export async function cancelUpdate(): Promise<UpdateProgress> {
  if (state.phase === 'installing') throw new Error('已开始安装，无法取消')
  if (controller) {
    controller.abort()
    return state
  }
  if (readyFile) {
    await fsp.rm(readyFile, { force: true }).catch(() => undefined)
    readyFile = null
  }
  update({ ...idleState(), phase: 'canceled' })
  return state
}

// ============ 安装 ============

/** 单引号包裹的 POSIX shell 字面量 */
function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** 单引号包裹的 PowerShell 字面量 */
function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/** 等本进程退出的 shell 片段：超时先礼貌地发 TERM（主进程收到会走正常退出），再不退才放弃等待 */
function shWaitForExit(pid: number): string {
  return [
    `PID=${pid}`,
    'i=0',
    'while kill -0 "$PID" 2>/dev/null; do',
    '  sleep 0.5',
    '  i=$((i+1))',
    `  if [ "$i" -eq ${WAIT_EXIT_SECONDS * 2} ]; then kill -TERM "$PID" 2>/dev/null; fi`,
    `  if [ "$i" -ge ${WAIT_EXIT_SECONDS * 2 + 20} ]; then break; fi`,
    'done'
  ].join('\n')
}

/** macOS：pkg 固定装到 /Applications（见 electron-builder.yml），装完从那里重新打开 */
function macScript(pkg: string): string {
  const installed = '/Applications/Kiro Manager Lite.app'
  /*
   * 安装器被取消、/Applications 里没有装上时，至少把原来那份打开。
   * 开发模式下「原来那份」是 node_modules 里的裸 Electron.app，打开它只会出现一个空的 Electron 窗口，
   * 所以开发模式不做这个兜底，直接回到命令行重新 npm run dev。
   */
  const current = app.isPackaged ? path.resolve(app.getPath('exe'), '../../..') : ''
  const relaunch = current
    ? `if [ -d ${shQuote(installed)} ]; then /usr/bin/open ${shQuote(installed)}; else /usr/bin/open ${shQuote(current)}; fi`
    : `if [ -d ${shQuote(installed)} ]; then /usr/bin/open ${shQuote(installed)}; fi`
  return [
    '#!/bin/sh',
    shWaitForExit(process.pid),
    // 本应用写出的文件本来不带下载隔离属性，再清一次兜底，避免安装器拦截未签名的 pkg
    `/usr/bin/xattr -d com.apple.quarantine ${shQuote(pkg)} 2>/dev/null`,
    // -W：等「安装器」退出（装完或用户取消）再往下走
    `/usr/bin/open -W ${shQuote(pkg)}`,
    relaunch,
    `rm -f ${shQuote(pkg)}`,
    'rm -f "$0"'
  ].join('\n')
}

/** Linux：用新 AppImage 覆盖正在用的文件，保留可执行权限后启动 */
function linuxScript(file: string, appImage: string): string {
  return [
    '#!/bin/sh',
    shWaitForExit(process.pid),
    `cp -f ${shQuote(file)} ${shQuote(appImage)}.new && chmod +x ${shQuote(appImage)}.new && mv -f ${shQuote(appImage)}.new ${shQuote(appImage)}`,
    `nohup ${shQuote(appImage)} >/dev/null 2>&1 &`,
    `rm -f ${shQuote(file)}`,
    'rm -f "$0"'
  ].join('\n')
}

/** Windows：等本进程退出后运行 NSIS 安装向导 */
function windowsScript(exe: string): string {
  return [
    `$target = ${process.pid}`,
    `Wait-Process -Id $target -Timeout ${WAIT_EXIT_SECONDS} -ErrorAction SilentlyContinue`,
    // 超时仍在：安装器会提示「程序正在运行」，这里先结束掉，避免向导卡住
    'if (Get-Process -Id $target -ErrorAction SilentlyContinue) { Stop-Process -Id $target -Force -ErrorAction SilentlyContinue; Start-Sleep -Seconds 2 }',
    `Start-Process -FilePath ${psQuote(exe)}`,
    'Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue'
  ].join('\r\n')
}

/** 写助手脚本并独立拉起；返回前确认进程已经起来，否则不退出应用 */
async function launchHelper(file: string): Promise<void> {
  const env = cleanChildEnv()
  if (process.platform === 'darwin') {
    const script = path.join(UPDATE_DIR, 'install.sh')
    await fsp.writeFile(script, macScript(file), { mode: 0o755 })
    await spawnDetached('/bin/sh', [script], env)
    return
  }
  if (process.platform === 'win32') {
    const script = path.join(UPDATE_DIR, 'install.ps1')
    // 带 BOM 的 UTF-8：Windows PowerShell 5 读不带 BOM 的脚本会按本地代码页解析中文路径
    await fsp.writeFile(script, `\ufeff${windowsScript(file)}`, 'utf8')
    await spawnDetached(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', script],
      env
    )
    return
  }
  if (process.platform === 'linux') {
    const appImage = process.env.APPIMAGE
    if (!appImage) throw new Error('当前不是以 AppImage 方式运行，无法自动替换，请前往 GitHub 手动下载')
    // 替换要写 AppImage 所在目录；没权限就别退出应用
    await fsp.access(path.dirname(appImage), fsConstants.W_OK).catch(() => {
      throw new Error(`没有写入 ${path.dirname(appImage)} 的权限，无法替换 AppImage，请手动更新`)
    })
    // AppImage 运行时会自己重设这几个变量，旧值留着反而可能指向已卸载的挂载点
    for (const key of ['APPIMAGE', 'APPDIR', 'OWD', 'ARGV0']) delete env[key]
    const script = path.join(UPDATE_DIR, 'install.sh')
    await fsp.writeFile(script, linuxScript(file, appImage), { mode: 0o755 })
    await spawnDetached('/bin/sh', [script], env)
    return
  }
  throw new Error('当前系统不支持应用内更新')
}

function spawnDetached(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true, env })
    child.once('error', (error) => reject(new Error(`无法启动安装助手：${errorMessage(error)}`)))
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}

/**
 * 安装已下载的更新：拉起助手脚本，然后让应用正常退出。
 *
 * 开发模式同样真实执行，便于完整测试「退出 → 安装 → 重新打开」整条链路：
 * 退出的是开发用的 Electron（electron-vite 随之结束），装的是正式版到 /Applications，
 * 装完打开的也是 /Applications 里的正式版，不是开发版。
 */
export async function installUpdate(): Promise<{ quitting: boolean }> {
  if (state.phase !== 'ready' || !readyFile || !existsSync(readyFile)) {
    throw new Error('安装包还没有下载完成')
  }
  if (!app.isPackaged) console.warn('[Update] 开发模式：将真实退出并安装正式版')
  await launchHelper(readyFile)
  update({ phase: 'installing' })
  console.log('[Update] 安装助手已启动，应用即将退出')
  // 留一点时间让界面收到「正在安装」再退出；before-quit 会置位退出标记，「最小化到托盘」不会拦下
  setTimeout(() => app.quit(), 400)
  return { quitting: true }
}
