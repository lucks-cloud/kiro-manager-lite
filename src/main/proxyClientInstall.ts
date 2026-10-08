// 一键接入的安装检测：找到各客户端装在哪里，macOS 与 Windows 分开处理
//
// 查找顺序：用户手动指定 → 默认安装位置 → 系统索引（macOS Spotlight / Windows 注册表与 MSIX 包）。
// 默认位置只覆盖官方安装器的落点，用户装到别处（外置盘、D:\Apps、便携版）时靠后两步兜底，
// 仍然找不到的，界面上让用户自己选一次，存进 store 以后直接用。
import { execFile } from 'child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'fs'
import * as os from 'os'
import * as path from 'path'
import { getProxyClientPaths, setProxyClientPath } from './store'
import type { ProxyClientTarget } from '../shared/types'

const IS_MAC = process.platform === 'darwin'
const IS_WIN = process.platform === 'win32'

function home(): string {
  return os.homedir()
}

/** Windows 的几个根目录；环境变量缺失时按默认布局拼，不能直接拼出一个 undefined\xxx */
function winDirs(): { local: string; roaming: string; programs: string; pf: string; pf86: string } {
  const local = process.env.LOCALAPPDATA || path.join(home(), 'AppData', 'Local')
  return {
    local,
    roaming: process.env.APPDATA || path.join(home(), 'AppData', 'Roaming'),
    programs: path.join(local, 'Programs'),
    pf: process.env.ProgramFiles || 'C:\\Program Files',
    pf86: process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
  }
}

/**
 * Qoder CN 的 Windows 版自带一个启动器（读自它 0.4.3 的 product.json 与主进程）：
 * 启动器在 %LOCALAPPDATA%\Qoder CN\Qoder CN Launcher\Qoder CN Launcher.exe（全机安装时状态放 %PROGRAMDATA%），
 * 旁边的 state.ini 记着 installDir 和 appExecutable——后者是相对安装目录的路径，
 * 要么直接是 Qoder CN.exe，要么是 .qoder-versions\<版本>\Qoder CN.exe（启动器自己做的版本切换）。
 * 先按它记的位置找，比猜安装目录准；读不到再回落到常规目录和注册表。
 */
function qoderLauncherDirs(): string[] {
  const roots = [winDirs().local, process.env.PROGRAMDATA || 'C:\\ProgramData']
  const out: string[] = []
  for (const root of roots) {
    const launcher = path.join(root, 'Qoder CN', 'Qoder CN Launcher')
    for (const name of ['state.ini', 'state.system.ini']) {
      try {
        const text = readFileSync(path.join(launcher, name), 'utf8').replace(/^\uFEFF/, '')
        const kv = new Map<string, string>()
        for (const line of text.split(/\r?\n/)) {
          const i = line.indexOf('=')
          if (i > 0) kv.set(line.slice(0, i).trim(), line.slice(i + 1).trim())
        }
        const dir = kv.get('installDir')
        if (!dir) continue
        const exe = kv.get('appExecutable')
        if (exe) out.push(path.dirname(path.join(dir, exe)))
        out.push(dir)
      } catch {
        /* 没有这份状态文件就是没用启动器装过 */
      }
    }
  }
  return out
}

function run(command: string, args: string[], timeout: number): Promise<string> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) =>
      // 查找失败一律当「没找到」：这里只是兜底，不该因为 Spotlight 关了或 PowerShell 被禁就报错
      resolve(error ? '' : String(stdout))
    )
  })
}

// ============ 命令行工具 ============

function nvmBinDirs(): string[] {
  const root = path.join(home(), '.nvm', 'versions', 'node')
  if (!existsSync(root)) return []
  try {
    return readdirSync(root)
      .map((v) => path.join(root, v, 'bin'))
      .filter((d) => existsSync(d))
      .reverse() // 版本号倒序，优先用新的
  } catch {
    return []
  }
}

/**
 * 可能放着命令行工具的目录。
 *
 * GUI 应用继承到的 PATH 很短（macOS 上通常只有 /usr/bin:/bin:/usr/sbin:/sbin），
 * 用户用 Homebrew / nvm / FlyEnv / 官方安装脚本装的东西都不在里面，要主动去这些地方翻。
 * Windows 上 npm 全局目录是 %APPDATA%\npm，从开始菜单启动的应用 PATH 里常常没有它。
 */
function binDirs(): string[] {
  const common = [...(process.env.PATH || '').split(path.delimiter), path.join(home(), '.local', 'bin'), path.join(home(), '.bun', 'bin')]
  if (IS_WIN) {
    const { local, roaming, pf } = winDirs()
    return [
      ...common,
      path.join(roaming, 'npm'),
      path.join(local, 'pnpm'),
      path.join(local, 'Volta', 'bin'),
      path.join(home(), 'scoop', 'shims'),
      // nvm-windows 把当前版本软链到 NVM_SYMLINK（默认 C:\Program Files\nodejs）
      process.env.NVM_SYMLINK || '',
      path.join(pf, 'nodejs')
    ].filter(Boolean)
  }
  return [
    ...common,
    '/opt/homebrew/bin',
    '/usr/local/bin',
    path.join(home(), '.npm-global', 'bin'),
    path.join(home(), 'Library', 'FlyEnv', 'env', 'node', 'bin'),
    ...nvmBinDirs()
  ].filter(Boolean)
}

/** Windows 上 npm 装的是 .cmd，原生程序是 .exe，两种都认 */
function binaryNames(name: string): string[] {
  return IS_WIN ? [`${name}.cmd`, `${name}.exe`, name] : [name]
}

/** 找一个命令行工具的绝对路径；找不到返回 null */
export function findBinary(name: string): string | null {
  for (const dir of binDirs()) {
    for (const exe of binaryNames(name)) {
      const full = path.join(dir, exe)
      if (existsSync(full)) return full
    }
  }
  return null
}

// ============ 各客户端的查找规则 ============

interface CliSpec {
  kind: 'cli'
  /** 可执行文件名（不带扩展名） */
  binary: string
  /** PATH 之外、官方安装器会放的位置 */
  extra: () => string[]
}

interface AppSpec {
  kind: 'app'
  mac: {
    /** .app 名 */
    app: string
    /** 知道 bundle id 的用它查 Spotlight，比按名字查准：同名的 .app 可能不止一个 */
    bundleId?: string
  }
  win: {
    /** 主程序 exe 名（大小写不敏感） */
    exe: string[]
    /** 默认安装目录 */
    dirs: () => string[]
    /** 注册表卸载项 DisplayName / MSIX 包名里包含的关键字 */
    keywords: string[]
  }
}

type ClientSpec = CliSpec | AppSpec

const SPECS: Record<ProxyClientTarget, ClientSpec> = {
  claudeCode: {
    kind: 'cli',
    binary: 'claude',
    // 官方安装器：macOS 早期放 ~/.claude/local，新版和 Windows 都放 ~/.local/bin（已在 binDirs 里）
    extra: () => [path.join(home(), '.claude', 'local', IS_WIN ? 'claude.exe' : 'claude')]
  },
  codex: {
    kind: 'cli',
    binary: 'codex',
    extra: () => {
      if (!IS_MAC) return []
      // Codex 桌面版里自带一份命令行，没单独装 codex 也能用
      const bundled = 'ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex'
      return ['/Applications', path.join(home(), 'Applications')].map((dir) => path.join(dir, bundled))
    }
  },
  deepseek: { kind: 'cli', binary: 'dsh', extra: () => [] },
  claudeApp: {
    kind: 'app',
    mac: { app: 'Claude.app', bundleId: 'com.anthropic.claudefordesktop' },
    win: {
      exe: ['claude.exe'],
      // Squirrel 安装器放 %LOCALAPPDATA%\AnthropicClaude；MSIX 版在 WindowsApps，靠包查询兜底
      dirs: () => [path.join(winDirs().local, 'AnthropicClaude'), path.join(winDirs().programs, 'Claude')],
      keywords: ['Claude']
    }
  },
  codexApp: {
    kind: 'app',
    mac: { app: 'ChatGPT.app', bundleId: 'com.openai.codex' },
    win: {
      exe: ['Codex.exe'],
      // Windows 版从 Microsoft Store 分发（MSIX），默认目录只是给手动解包的情况兜底
      dirs: () => [path.join(winDirs().programs, 'Codex'), path.join(winDirs().pf, 'Codex')],
      keywords: ['Codex']
    }
  },
  cursor: {
    kind: 'app',
    mac: { app: 'Cursor.app', bundleId: 'com.todesktop.230313mzl4w4u92' },
    win: {
      exe: ['Cursor.exe'],
      dirs: () => [path.join(winDirs().programs, 'cursor'), path.join(winDirs().pf, 'Cursor')],
      keywords: ['Cursor']
    }
  },
  vscode: {
    kind: 'app',
    mac: { app: 'Visual Studio Code.app', bundleId: 'com.microsoft.VSCode' },
    win: {
      exe: ['Code.exe'],
      // 用户版装在 %LOCALAPPDATA%\Programs，系统版装在 Program Files
      dirs: () => [
        path.join(winDirs().programs, 'Microsoft VS Code'),
        path.join(winDirs().pf, 'Microsoft VS Code'),
        path.join(winDirs().pf86, 'Microsoft VS Code')
      ],
      keywords: ['Visual Studio Code']
    }
  },
  workbuddy: {
    kind: 'app',
    mac: { app: 'WorkBuddy.app', bundleId: 'com.tencent.workbuddy.mac' },
    win: {
      exe: ['WorkBuddy.exe'],
      dirs: () => [path.join(winDirs().programs, 'WorkBuddy'), path.join(winDirs().pf, 'WorkBuddy')],
      keywords: ['WorkBuddy']
    }
  },
  qoder: {
    kind: 'app',
    mac: { app: 'Qoder CN.app', bundleId: 'com.qodercn.app' },
    win: {
      exe: ['Qoder CN.exe', 'QoderCN.exe'],
      dirs: () => [
        ...qoderLauncherDirs(),
        path.join(winDirs().programs, 'Qoder CN'),
        path.join(winDirs().programs, 'qoder-cn'),
        path.join(winDirs().pf, 'Qoder CN')
      ],
      keywords: ['Qoder CN', 'QoderCN']
    }
  },
  zcode: {
    kind: 'app',
    mac: { app: 'ZCode.app', bundleId: 'dev.zcode.app' },
    win: {
      exe: ['ZCode.exe'],
      dirs: () => [path.join(winDirs().programs, 'ZCode'), path.join(winDirs().pf, 'ZCode')],
      keywords: ['ZCode']
    }
  },
  kimi: {
    kind: 'app',
    mac: { app: 'Kimi Code.app', bundleId: 'com.kimi.code.desktop' },
    win: {
      exe: ['Kimi Code.exe'],
      dirs: () => [path.join(winDirs().programs, 'Kimi Code'), path.join(winDirs().pf, 'Kimi Code')],
      // 不能只写 Kimi：会撞上聊天版 Kimi，那个目录里没有 Kimi Code.exe，靠 exe 名兜住也行，但少查一轮
      keywords: ['Kimi Code']
    }
  },
  deepseekApp: {
    kind: 'app',
    mac: { app: 'DeepSeek Harness.app' },
    win: {
      exe: ['DeepSeek Harness.exe', 'deepseek-harness.exe'],
      dirs: () => [
        path.join(winDirs().programs, 'DeepSeek Harness'),
        path.join(winDirs().programs, 'deepseek-harness'),
        path.join(winDirs().pf, 'DeepSeek Harness')
      ],
      keywords: ['DeepSeek Harness']
    }
  }
}

/** 界面上的叫法：没找到时告诉用户缺的是哪个文件 */
export function installLabel(target: ProxyClientTarget): string {
  const spec = SPECS[target]
  if (spec.kind === 'cli') return `${spec.binary} 命令`
  return IS_WIN ? spec.win.exe[0] : spec.mac.app
}

// ============ macOS ============

const MAC_APP_DIRS = (): string[] => ['/Applications', path.join(home(), 'Applications'), '/Applications/Setapp']

/** 读 .app 的 bundle id；plutil 两种格式（XML / 二进制）的 Info.plist 都能读 */
async function bundleIdOf(appPath: string): Promise<string> {
  const out = await run('plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', path.join(appPath, 'Contents', 'Info.plist')], 3_000)
  return out.trim()
}

/** Spotlight 兜底：应用被拖到外置盘或别的目录时，默认目录找不到，但索引里有 */
async function spotlight(spec: AppSpec['mac']): Promise<string | null> {
  const query = spec.bundleId
    ? `kMDItemCFBundleIdentifier == '${spec.bundleId}'`
    : `kMDItemContentType == 'com.apple.application-bundle' && kMDItemFSName == '${spec.app}'`
  const out = await run('mdfind', [query], 4_000)
  const hit = out
    .split('\n')
    .map((line) => line.trim())
    // 排除回收站与别的应用内嵌的同 id 副本（例如安装包里带的旧版）
    .find((line) => line.endsWith('.app') && !line.includes('/.Trash/') && !line.includes('.app/Contents/'))
  return hit && existsSync(hit) ? hit : null
}

async function locateMacApp(spec: AppSpec['mac']): Promise<string | null> {
  for (const dir of MAC_APP_DIRS()) {
    const full = path.join(dir, spec.app)
    if (existsSync(full)) return full
  }
  return spotlight(spec)
}

// ============ Windows ============

/**
 * 装在 dir 下的主程序。Squirrel 类安装器（Claude、早期 Electron 应用）把真正的程序放在
 * app-<版本> 子目录里、根目录只有一个启动器；MSIX 包有时放在 app\ 下。都看一层。
 * Qoder CN 的启动器把各版本放在 .qoder-versions\<版本>\ 下，多看这一层。
 */
function exeIn(dir: string, names: string[]): string | null {
  if (!dir || !existsSync(dir)) return null
  const lower = names.map((n) => n.toLowerCase())
  const scan = (d: string): string | null => {
    try {
      const hit = readdirSync(d).find((f) => lower.includes(f.toLowerCase()))
      return hit ? path.join(d, hit) : null
    } catch {
      return null
    }
  }
  const direct = scan(dir)
  if (direct) return direct
  try {
    const subs = readdirSync(dir)
      .filter((f) => f === 'app' || f.startsWith('app-'))
      .sort()
      .reverse()
    for (const sub of subs) {
      const hit = scan(path.join(dir, sub))
      if (hit) return hit
    }
  } catch {
    /* 无权限读取的目录（WindowsApps）当作没有 */
  }
  try {
    const versions = path.join(dir, '.qoder-versions')
    // 版本号按字符串倒序只是近似；拿到任意一个能跑的就够判断「装了」
    for (const sub of readdirSync(versions).sort().reverse()) {
      const hit = scan(path.join(versions, sub))
      if (hit) return hit
    }
  } catch {
    /* 没有这层目录 */
  }
  return null
}

interface WinInstallEntry {
  DisplayName?: string
  InstallLocation?: string
  DisplayIcon?: string
}

/*
 * 注册表卸载项 + MSIX 包一次查完并缓存：PowerShell 冷启动要一两秒，
 * 刷新客户端状态时九个目标各查一次会明显卡顿。
 */
let winEntriesCache: { at: number; entries: WinInstallEntry[] } | null = null
const WIN_CACHE_MS = 30_000

const WIN_QUERY = [
  // 不设成 UTF-8 的话中文路径会按 OEM 代码页输出，解析出来是乱码
  '[Console]::OutputEncoding=[Text.Encoding]::UTF8',
  "$ErrorActionPreference='SilentlyContinue'",
  "$u = Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' | Where-Object { $_.DisplayName } | Select-Object DisplayName,InstallLocation,DisplayIcon",
  "$a = Get-AppxPackage | Select-Object @{n='DisplayName';e={$_.Name}},InstallLocation",
  '@($u) + @($a) | ConvertTo-Json -Compress'
].join('; ')

/** 丢掉安装检测的缓存，下一次检测重新查注册表与 MSIX 包 */
export function resetInstallCache(): void {
  winEntriesCache = null
}

async function winEntries(): Promise<WinInstallEntry[]> {
  if (winEntriesCache && Date.now() - winEntriesCache.at < WIN_CACHE_MS) return winEntriesCache.entries
  const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WIN_QUERY], 15_000)
  let entries: WinInstallEntry[] = []
  try {
    const parsed = JSON.parse(out.trim() || '[]')
    entries = Array.isArray(parsed) ? parsed : [parsed]
  } catch {
    entries = []
  }
  winEntriesCache = { at: Date.now(), entries }
  return entries
}

/** DisplayIcon 形如 "C:\x\Code.exe",0：去掉引号和图标下标 */
function iconDir(icon?: string): string {
  if (!icon) return ''
  const file = icon.replace(/"/g, '').replace(/,\s*-?\d+$/, '').trim()
  return file ? path.dirname(file) : ''
}

async function locateWinApp(spec: AppSpec['win']): Promise<string | null> {
  for (const dir of spec.dirs()) {
    const hit = exeIn(dir, spec.exe)
    if (hit) return hit
  }
  const keywords = spec.keywords.map((k) => k.toLowerCase())
  for (const entry of await winEntries()) {
    const name = String(entry.DisplayName ?? '').toLowerCase()
    // MSIX 包名不带空格（DeepSeekHarness、OpenAI.Codex），两种写法都比一下
    const compact = name.replace(/\s+/g, '')
    if (!keywords.some((k) => name.includes(k) || compact.includes(k.replace(/\s+/g, '')))) continue
    // 名字只是线索，以目录里真有这个 exe 为准：关键字难免会撞上别的软件
    const hit = exeIn(entry.InstallLocation ?? '', spec.exe) ?? exeIn(iconDir(entry.DisplayIcon), spec.exe)
    if (hit) return hit
  }
  return null
}

// ============ 对外 ============

export interface InstallLocation {
  /** 主程序 / 可执行文件的位置（macOS 图形应用是 .app 目录）；没找到为 null */
  path: string | null
  /** 这个位置是用户手动指定的 */
  custom: boolean
}

/** 用户手动指定的位置；文件已被删掉（卸载、换了目录）时视为没有，回落到自动检测 */
function customPath(target: ProxyClientTarget): string | null {
  const saved = getProxyClientPaths()[target]
  return saved && existsSync(saved) ? saved : null
}

/** 同步版，只查手动指定与默认位置；给同步调用点（拼启动命令）用 */
export function locateCliSync(target: ProxyClientTarget): InstallLocation {
  const custom = customPath(target)
  if (custom) return { path: custom, custom: true }
  const spec = SPECS[target]
  if (spec.kind !== 'cli') return { path: null, custom: false }
  const found = findBinary(spec.binary) ?? spec.extra().find((file) => existsSync(file)) ?? null
  return { path: found, custom: false }
}

export async function locateClient(target: ProxyClientTarget): Promise<InstallLocation> {
  const spec = SPECS[target]
  if (spec.kind === 'cli') return locateCliSync(target)
  const custom = customPath(target)
  if (custom) return { path: custom, custom: true }
  if (IS_MAC) return { path: await locateMacApp(spec.mac), custom: false }
  if (IS_WIN) return { path: await locateWinApp(spec.win), custom: false }
  return { path: null, custom: false }
}

/** 选择文件对话框的参数：按平台和目标类型给 */
export function pickDialogOptions(target: ProxyClientTarget): Electron.OpenDialogOptions {
  const spec = SPECS[target]
  if (spec.kind === 'cli') {
    return {
      title: `选择 ${spec.binary} 可执行文件`,
      properties: ['openFile', 'showHiddenFiles'],
      ...(IS_WIN ? { filters: [{ name: '可执行文件', extensions: ['exe', 'cmd', 'bat'] }] } : {})
    }
  }
  if (IS_MAC) {
    // .app 在 macOS 上是目录包，openFile 就能直接选中它，不会钻进去
    return {
      title: `选择 ${spec.mac.app}`,
      defaultPath: '/Applications',
      properties: ['openFile'],
      filters: [{ name: '应用程序', extensions: ['app'] }]
    }
  }
  // Windows 的对话框不能同时选文件和目录；选安装目录更符合直觉，exe 由我们在里面找
  return { title: `选择 ${spec.win.exe[0]} 所在的安装目录`, properties: ['openDirectory'] }
}

/**
 * 校验用户选的位置并存下来，返回规范化后的路径。
 * 选错了（别的应用、目录里没有主程序）直接报错，不存：存下一个错的位置比不存更难排查。
 */
export async function saveCustomPath(target: ProxyClientTarget, picked: string): Promise<string> {
  const spec = SPECS[target]
  if (!existsSync(picked)) throw new Error('选择的位置不存在')
  const isDir = statSync(picked).isDirectory()
  let resolved: string | null = null

  if (spec.kind === 'cli') {
    const names = binaryNames(spec.binary).map((n) => n.toLowerCase())
    if (isDir) {
      resolved = exeIn(picked, binaryNames(spec.binary))
    } else {
      // 允许 claude-code 这类改过名的包装脚本：只要文件名以命令名开头
      const base = path.basename(picked).toLowerCase()
      resolved = names.includes(base) || base.startsWith(spec.binary) ? picked : null
    }
    if (!resolved) throw new Error(`没有在所选位置找到 ${spec.binary} 可执行文件`)
  } else if (IS_MAC) {
    if (!picked.endsWith('.app')) throw new Error('请选择一个 .app 应用')
    if (spec.mac.bundleId) {
      const id = await bundleIdOf(picked)
      // 读不到 id（Info.plist 损坏）时不拦，读到了却对不上才算选错
      if (id && id !== spec.mac.bundleId) {
        throw new Error(`选择的不是 ${spec.mac.app.replace(/\.app$/, '')}（bundle id 为 ${id}）`)
      }
    }
    resolved = picked
  } else {
    resolved = isDir ? exeIn(picked, spec.win.exe) : spec.win.exe.some((n) => n.toLowerCase() === path.basename(picked).toLowerCase()) ? picked : null
    if (!resolved) throw new Error(`没有在所选目录里找到 ${spec.win.exe[0]}`)
  }

  setProxyClientPath(target, resolved)
  return resolved
}

export function clearCustomPath(target: ProxyClientTarget): void {
  setProxyClientPath(target, null)
}
