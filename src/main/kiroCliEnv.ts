// 把 API Key 写成 Kiro CLI 认的环境变量 KIRO_API_KEY，免得用户每次开终端都手动 export
//
// 各平台写到「新开的终端会自动读取」的位置：
//  - macOS / Linux：shell 启动文件里追加一段带标记的 export（zsh / bash / sh 的 rc 文件，fish 单独一个文件）
//  - Windows：用户级环境变量（注册表 HKCU\Environment）。PowerShell、cmd、Git Bash 新开的窗口都会继承
//
// 只动带标记的那一段 / 那一个变量，移除时原样拿掉；Windows 上原来就有值的，移除时写回原值。
// 已经开着的终端不会自动生效，要新开一个（Windows 上从已运行的 IDE 里开的终端，要先重启那个 IDE）。
import { execFile } from 'child_process'
import { existsSync } from 'fs'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { log } from './logger'
import { cleanChildEnv } from './childEnv'
import { getKiroCliEnvBackup, setKiroCliEnvBackup, type KiroCliEnvBackup } from './store'
import type { KiroCliEnvStatus } from '../shared/types'

const VAR = 'KIRO_API_KEY'
const BEGIN = '# >>> Kiro Manager Lite: KIRO_API_KEY >>>'
const END = '# <<< Kiro Manager Lite: KIRO_API_KEY <<<'
/** fish 的语法不同，单独放一个它启动时会自动加载的文件，移除时整个删掉 */
const FISH_FILE = path.join(os.homedir(), '.config', 'fish', 'conf.d', 'kiro-manager-lite.fish')

/** Kiro 的 API Key 只含字母数字、下划线和短横；别的字符一律拒绝，避免拼进 shell / 注册表出事 */
function assertKey(key: string): string {
  const value = key.trim()
  if (!/^[A-Za-z0-9_\-.]{8,512}$/.test(value)) throw new Error('API Key 格式不对，没有写入')
  return value
}

// ============ macOS / Linux ============

/**
 * 要写的启动文件：已经存在的都写（用户可能在 zsh 和 bash 之间切换），
 * 一个都没有时按当前默认 shell 新建一个。
 * macOS 的 bash 打开终端走的是登录 shell，读 .bash_profile 而不是 .bashrc。
 */
function unixRcFiles(): string[] {
  const home = os.homedir()
  // zsh 设了 ZDOTDIR 时只读那个目录下的 .zshrc
  const zshrc = path.join(process.env.ZDOTDIR || home, '.zshrc')
  const candidates = [zshrc, ...['.bashrc', '.bash_profile', '.profile'].map((f) => path.join(home, f))]
  const existing = candidates.filter((f) => existsSync(f))
  if (existing.length) return existing
  const shell = path.basename(process.env.SHELL || '')
  if (shell === 'zsh') return [zshrc]
  if (shell === 'bash') return [path.join(home, process.platform === 'darwin' ? '.bash_profile' : '.bashrc')]
  return [path.join(home, '.profile')]
}

/** 去掉我们写过的那一段（含前后空行），其余内容一字不动 */
function stripBlock(content: string): string {
  const start = content.indexOf(BEGIN)
  if (start < 0) return content
  const endAt = content.indexOf(END, start)
  if (endAt < 0) return content
  const before = content.slice(0, start).replace(/\n+$/, '\n')
  const after = content.slice(endAt + END.length).replace(/^\n+/, '')
  const joined = before + after
  return joined.trim() ? joined : ''
}

/** 从启动文件里读出我们写的值 */
function readBlockValue(content: string): string | null {
  const start = content.indexOf(BEGIN)
  if (start < 0) return null
  const block = content.slice(start, content.indexOf(END, start) + 1 || undefined)
  const match = /export KIRO_API_KEY='([^']*)'/.exec(block)
  return match ? match[1] : null
}

async function writeUnix(key: string): Promise<KiroCliEnvBackup['files']> {
  const files: KiroCliEnvBackup['files'] = []
  const block = `${BEGIN}\nexport ${VAR}='${key}'\n${END}\n`
  const previous = getKiroCliEnvBackup()?.files ?? []

  for (const file of unixRcFiles()) {
    const existed = existsSync(file)
    const content = existed ? await fs.readFile(file, 'utf-8') : ''
    const base = stripBlock(content)
    const next = base ? `${base.replace(/\n*$/, '\n')}\n${block}` : block
    await fs.writeFile(file, next, 'utf-8')
    // 之前就是我们新建的文件，覆盖写入后仍算「我们建的」，移除时才会删掉
    const createdBefore = previous.find((f) => f.path === file)?.created
    files.push({ path: file, created: createdBefore ?? !existed })
  }

  // fish 不读上面那些文件；装了 fish（有配置目录）才写
  if (existsSync(path.dirname(path.dirname(FISH_FILE)))) {
    await fs.mkdir(path.dirname(FISH_FILE), { recursive: true })
    await fs.writeFile(FISH_FILE, `${BEGIN}\nset -gx ${VAR} '${key}'\n${END}\n`, 'utf-8')
    files.push({ path: FISH_FILE, created: true })
  }
  return files
}

async function removeUnix(files: KiroCliEnvBackup['files']): Promise<void> {
  // 备份丢了也要能清：把可能写过的位置都扫一遍
  const targets = new Map<string, boolean>()
  for (const f of files) targets.set(f.path, f.created)
  for (const f of [...unixRcFiles(), FISH_FILE]) if (!targets.has(f)) targets.set(f, false)

  for (const [file, created] of targets) {
    if (!existsSync(file)) continue
    const content = await fs.readFile(file, 'utf-8')
    if (!content.includes(BEGIN)) continue
    const next = stripBlock(content)
    // 我们新建的文件、拿掉这一段后什么都不剩：整个删掉，不留空壳
    if (!next.trim() && (created || file === FISH_FILE)) await fs.unlink(file)
    else await fs.writeFile(file, next, 'utf-8')
  }
}

async function readUnix(): Promise<{ value: string | null; locations: string[] }> {
  let value: string | null = null
  const locations: string[] = []
  for (const file of [...unixRcFiles(), FISH_FILE]) {
    if (!existsSync(file)) continue
    const content = await fs.readFile(file, 'utf-8').catch(() => '')
    if (!content.includes(BEGIN)) continue
    locations.push(file)
    value ??= readBlockValue(content) ?? (/set -gx KIRO_API_KEY '([^']*)'/.exec(content)?.[1] || null)
  }
  return { value, locations }
}

// ============ Windows ============

/**
 * 用 PowerShell 读写用户级环境变量。
 * 值经子进程环境变量 KML_VALUE 传入，不拼进脚本：脚本里只有固定文本，没有注入面。
 * SetEnvironmentVariable(…, 'User') 会写注册表并广播 WM_SETTINGCHANGE，
 * 资源管理器随后新开的 PowerShell / cmd 窗口都能读到，不用注销。
 */
function powershell(script: string, value?: string): Promise<string> {
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      {
        timeout: 30_000,
        windowsHide: true,
        env: { ...cleanChildEnv(), ...(value !== undefined ? { KML_VALUE: value } : {}) }
      },
      (error, stdout, stderr) => {
        if (error) reject(new Error(String(stderr || error.message).slice(0, 300)))
        else resolve(String(stdout))
      }
    )
  })
}

async function readWindows(): Promise<string | null> {
  const out = await powershell(
    `[Console]::OutputEncoding = [Text.Encoding]::UTF8; [Environment]::GetEnvironmentVariable('${VAR}', 'User')`
  )
  return out.trim() || null
}

async function setWindows(value: string | null): Promise<void> {
  // $null 表示删除这个变量
  await powershell(
    value === null
      ? `[Environment]::SetEnvironmentVariable('${VAR}', $null, 'User')`
      : `[Environment]::SetEnvironmentVariable('${VAR}', $env:KML_VALUE, 'User')`,
    value ?? undefined
  )
}

// ============ 对外 ============

export async function kiroCliEnvStatus(): Promise<KiroCliEnvStatus> {
  if (process.platform === 'win32') {
    const value = await readWindows().catch(() => null)
    return {
      value,
      locations: value ? ['Windows 用户环境变量（PowerShell / cmd 通用）'] : [],
      managed: !!getKiroCliEnvBackup() && !!value
    }
  }
  const { value, locations } = await readUnix()
  return { value, locations, managed: locations.length > 0 }
}

export async function writeKiroCliEnv(rawKey: string): Promise<KiroCliEnvStatus> {
  const key = assertKey(rawKey)
  const backup = getKiroCliEnvBackup()

  if (process.platform === 'win32') {
    // 只在第一次写入时记下用户原来的值；之后换 Key 不覆盖，移除时才能还原到最初的样子
    const original = backup ? backup.previousWindowsValue : await readWindows().catch(() => null)
    await setWindows(key)
    setKiroCliEnvBackup({ writtenAt: Date.now(), files: [], previousWindowsValue: original })
  } else {
    const files = await writeUnix(key)
    setKiroCliEnvBackup({ writtenAt: Date.now(), files, previousWindowsValue: null })
  }
  log('info', `[KiroCLI] 已写入 ${VAR}`)
  return kiroCliEnvStatus()
}

/** 移除我们写的 KIRO_API_KEY；没写过时什么都不做 */
export async function removeKiroCliEnv(): Promise<KiroCliEnvStatus> {
  const backup = getKiroCliEnvBackup()
  if (process.platform === 'win32') {
    // 没有备份说明不是我们写的，不碰用户自己设的值
    if (backup) await setWindows(backup.previousWindowsValue)
  } else {
    await removeUnix(backup?.files ?? [])
  }
  setKiroCliEnvBackup(null)
  log('info', `[KiroCLI] 已移除 ${VAR}`)
  return kiroCliEnvStatus()
}

/** 本应用是否写过（初始化时据此决定要不要还原） */
export function kiroCliEnvWritten(): boolean {
  return !!getKiroCliEnvBackup()
}
