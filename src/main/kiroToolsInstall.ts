// 登录 Kiro CLI 前的安装检测：kiro-cli（必需）与 Kiro Crew（可选）
//
// kiro-cli 的位置与写入后的 whoami 校验共用 kiroCliAuth.findKiroCliBinary；
// Crew 复用一键接入（本地反代）的查找逻辑：命令行版走 findBinary 的常见 bin 目录，
// 桌面版走 locateApp 的默认目录 + Spotlight / 注册表与 MSIX 包兜底。
//
// Windows 上额外重新读一次注册表里的用户 / 系统 PATH：本应用启动后才装的工具，
// 安装器写进的 PATH 不会出现在本进程继承到的 process.env.PATH 里，不重读的话
// 用户装完点「重新检测」仍然显示未安装，只能重启本应用。
import { execFile } from 'child_process'
import * as os from 'os'
import * as path from 'path'
import { findKiroCliBinary, kiroCliDb } from './kiroCliAuth'
import { findBinary, locateApp, resetInstallCache } from './proxyClientInstall'
import type { KiroToolsInstallInfo } from '../shared/types'

/** 把 %USERPROFILE% 这类写法按当前环境变量展开；注册表里的 PATH 常是 REG_EXPAND_SZ（Windows 的 env 不分大小写） */
function expandWinVars(value: string): string {
  return value.replace(/%([^%]+)%/g, (whole, name: string) => process.env[name] ?? whole)
}

/** 从注册表重新读用户 + 系统 PATH；读不到返回空数组，只是少一层兜底 */
function freshWinPathDirs(): Promise<string[]> {
  if (process.platform !== 'win32') return Promise.resolve([])
  const script =
    "[Console]::OutputEncoding=[Text.Encoding]::UTF8; [Environment]::GetEnvironmentVariable('Path','User') + ';' + [Environment]::GetEnvironmentVariable('Path','Machine')"
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: 8_000, windowsHide: true },
      (error, stdout) => {
        if (error) return resolve([])
        resolve(
          String(stdout)
            .split(';')
            .map((dir) => expandWinVars(dir.trim()))
            .filter(Boolean)
        )
      }
    )
  })
}

/**
 * Kiro Crew 桌面版的查找规则。
 * Crew 文档只写了 macOS 用 DMG、Windows 用 NSIS 安装器、Linux 链到 /usr/bin/kirocrew-desktop，
 * 没写 .app / exe 的确切名字，这里的名字是推测值；注册表关键字兜底能覆盖装到别处的情况。
 */
const CREW_APP: Parameters<typeof locateApp>[0] = {
  mac: { app: 'Kiro Crew.app' },
  win: {
    exe: ['Kiro Crew.exe', 'KiroCrew.exe', 'kirocrew-desktop.exe'],
    dirs: () => {
      const programs = path.join(
        process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
        'Programs'
      )
      const programFiles = process.env.ProgramFiles || 'C:\\Program Files'
      return [
        path.join(programs, 'Kiro Crew'),
        path.join(programs, 'KiroCrew'),
        path.join(programFiles, 'Kiro Crew')
      ]
    },
    keywords: ['Kiro Crew', 'KiroCrew']
  }
}

/**
 * 检测 kiro-cli 与 Kiro Crew 的安装情况。
 * fresh 为 true 时清掉注册表查询缓存（用户点「重新检测」时用），否则 30 秒内复用上次结果。
 */
export async function detectKiroTools(fresh = false): Promise<KiroToolsInstallInfo> {
  if (fresh) resetInstallCache()
  // Windows 上两步各要起一次 PowerShell（重读 PATH / 查注册表与 MSIX），并行跑，等待时间取较长的那个
  const [pathDirs, crewAppFound] = await Promise.all([freshWinPathDirs(), locateApp(CREW_APP)])

  const kiroCliPath = findKiroCliBinary(pathDirs) ?? null

  // Crew：命令行版优先（一行安装脚本装的是它），其次桌面版
  const crewCli = findBinary('kirocrew', pathDirs) ?? findBinary('kirocrew-desktop', pathDirs)
  const crewPath = crewCli ?? crewAppFound

  return {
    platform: process.platform,
    kiroCli: {
      installed: !!kiroCliPath,
      path: kiroCliPath,
      // 装了但从没运行过时还没有凭证库，写入会失败，界面据此提示先初始化
      dbExists: kiroCliDb().dbExists
    },
    crew: { installed: !!crewPath, path: crewPath, kind: crewCli ? 'cli' : crewPath ? 'app' : null }
  }
}
