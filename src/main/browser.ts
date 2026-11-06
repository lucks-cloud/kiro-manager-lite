// 外部浏览器打开：支持无痕/隐私窗口，找不到可用浏览器时回退到系统默认浏览器
import { app, shell } from 'electron'
import { spawn, spawnSync } from 'child_process'
import * as fs from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { BrowserOpenInfo } from '../shared/types'

/** 只放行 http(s)：自定义协议可能被诱导拉起本地程序 */
export function isHttpUrl(url: string): boolean {
  return /^https?:\/\//i.test(url)
}

type Family = 'chromium' | 'edge' | 'firefox'

interface Candidate {
  name: string
  family: Family
  /** 可执行文件路径（macOS / Windows）或命令名（Linux） */
  bin: string
}

function macCandidates(): Candidate[] {
  const roots = ['/Applications', join(homedir(), 'Applications')]
  const apps: [string, Family, string][] = [
    ['Google Chrome', 'chromium', 'Google Chrome.app/Contents/MacOS/Google Chrome'],
    ['Microsoft Edge', 'edge', 'Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
    ['Brave', 'chromium', 'Brave Browser.app/Contents/MacOS/Brave Browser'],
    ['Chromium', 'chromium', 'Chromium.app/Contents/MacOS/Chromium'],
    ['Firefox', 'firefox', 'Firefox.app/Contents/MacOS/firefox']
  ]
  return roots.flatMap((root) =>
    apps.map(([name, family, relative]) => ({ name, family, bin: join(root, relative) }))
  )
}

function winCandidates(): Candidate[] {
  const dirs = [
    process.env['PROGRAMFILES'],
    process.env['PROGRAMFILES(X86)'],
    process.env['LOCALAPPDATA']
  ].filter((v): v is string => !!v)

  const apps: [string, Family, string][] = [
    ['Google Chrome', 'chromium', 'Google\\Chrome\\Application\\chrome.exe'],
    ['Microsoft Edge', 'edge', 'Microsoft\\Edge\\Application\\msedge.exe'],
    ['Brave', 'chromium', 'BraveSoftware\\Brave-Browser\\Application\\brave.exe'],
    ['Firefox', 'firefox', 'Mozilla Firefox\\firefox.exe']
  ]
  return dirs.flatMap((dir) =>
    apps.map(([name, family, relative]) => ({ name, family, bin: join(dir, relative) }))
  )
}

function linuxCandidates(): Candidate[] {
  return [
    { name: 'Google Chrome', family: 'chromium', bin: 'google-chrome' },
    { name: 'Google Chrome', family: 'chromium', bin: 'google-chrome-stable' },
    { name: 'Chromium', family: 'chromium', bin: 'chromium' },
    { name: 'Chromium', family: 'chromium', bin: 'chromium-browser' },
    { name: 'Brave', family: 'chromium', bin: 'brave-browser' },
    { name: 'Microsoft Edge', family: 'edge', bin: 'microsoft-edge' },
    { name: 'Firefox', family: 'firefox', bin: 'firefox' }
  ]
}

function candidates(): Candidate[] {
  if (process.platform === 'darwin') return macCandidates()
  if (process.platform === 'win32') return winCandidates()
  return linuxCandidates()
}

/**
 * Linux 上 which 已确认能解析的命令名，进程内缓存，免得每次打开浏览器都逐个同步探测。
 * 只记找到的；没找到的下次照样重新探测（用户可能刚装上）。
 * 记住之后浏览器若被卸载，launch 会因 spawn 报错返回 false，照常换下一个候选。
 */
const resolvedCommands = new Set<string>()

/** Linux 下命令名需要先在 PATH 中解析，其它平台直接判断文件是否存在 */
function available(candidate: Candidate): boolean {
  if (process.platform === 'linux') {
    if (resolvedCommands.has(candidate.bin)) return true
    const found = spawnSync('which', [candidate.bin], { stdio: 'ignore' }).status === 0
    if (found) resolvedCommands.add(candidate.bin)
    return found
  }
  return fs.existsSync(candidate.bin)
}

/**
 * 为无痕登录准备一个独立于用户主浏览器的数据目录。
 *
 * 关键点：Chromium 系浏览器已在运行时，直接带 --incognito 启动会被转发给
 * 主实例，而转发路径不尊重 --incognito，于是开出来的是普通窗口。指定一个
 * 独立的 user-data-dir 会强制拉起全新实例（拿到独立的单例锁），--incognito
 * 才真正生效，同时绝不会复用主 profile 里已登录的身份。
 */
function loginProfileDir(family: Family): string {
  const dir = join(app.getPath('userData'), 'login-browser', family)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function privateArgs(candidate: Candidate): string[] {
  switch (candidate.family) {
    case 'edge':
      return ['-inprivate', `--user-data-dir=${loginProfileDir('edge')}`, '--no-first-run']
    case 'firefox':
      // Firefox 的 -private-window 通过 remote 交给已运行实例也能正确开隐私窗
      return ['-private-window']
    default:
      return [
        '--incognito',
        `--user-data-dir=${loginProfileDir('chromium')}`,
        '--no-first-run',
        '--no-default-browser-check'
      ]
  }
}

/**
 * 直接以参数数组启动浏览器可执行文件，不经过 shell，URL 不参与命令拼接。
 */
function launch(candidate: Candidate, url: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const done = (value: boolean): void => {
      if (settled) return
      settled = true
      resolve(value)
    }
    try {
      const child = spawn(candidate.bin, [...privateArgs(candidate), url], {
        detached: true,
        stdio: 'ignore'
      })
      child.once('error', () => done(false))
      child.unref()
      // 独立实例会常驻，短暂等待没报错即视为成功
      setTimeout(() => done(true), 800)
    } catch {
      done(false)
    }
  })
}

/**
 * 打开外部链接。privateMode 为真时依次尝试本机已安装的浏览器的无痕窗口，
 * 全部不可用时回退系统默认浏览器，并在返回值里说明未启用无痕。
 */
export async function openUrl(url: string, privateMode?: boolean): Promise<BrowserOpenInfo> {
  if (!isHttpUrl(url)) throw new Error('仅支持 http/https 链接')

  if (privateMode) {
    for (const candidate of candidates()) {
      if (!available(candidate)) continue
      if (await launch(candidate, url)) {
        console.log(`[Browser] opened in ${candidate.name} private window`)
        return { privateMode: true, browser: candidate.name }
      }
    }
    console.warn('[Browser] no private-capable browser found, falling back to default browser')
  }

  await shell.openExternal(url)
  return { privateMode: false }
}
