// 登录 Kiro CLI 前的安装校验：检测调用、各平台安装方法、本次运行内「不再提示 Crew」的标记
// 界面在 components/accounts/KiroToolsCheckModal.vue
import type { KiroToolsInstallInfo } from '@shared/types'

const DOWNLOADS_URL = 'https://kiro.dev/downloads/'
const CREW_DOCS_URL = 'https://kiro.dev/docs/crew/installation/'

export interface InstallGuide {
  /** 在哪个终端里跑 */
  shell: string
  command?: string
  /** 补充说明；没有一行命令时（Windows 上的 Crew 桌面版）就是唯一的说明 */
  note?: string
  url: string
}

/**
 * kiro-cli 安装方法。macOS / Linux 出自 kiro.dev 下载页；
 * Windows 取自官方脚本 https://cli.kiro.dev/install.ps1 头部的 Usage
 * （下载 MSI 静默安装；实测 3.1.0 落在 %LOCALAPPDATA%\kiro-cli\）。
 */
export function kiroCliGuide(platform: string): InstallGuide {
  if (platform === 'win32') {
    return {
      shell: 'PowerShell',
      command: 'irm https://cli.kiro.dev/install.ps1 | iex',
      note: '官网首页的 curl … | bash 是 macOS / Linux 用的，Windows 请用上面这条。',
      url: DOWNLOADS_URL
    }
  }
  return { shell: '终端', command: 'curl -fsSL https://cli.kiro.dev/install | bash', url: DOWNLOADS_URL }
}

/** Kiro Crew 安装方法，出自 KiroCrew 安装文档 */
export function crewGuide(platform: string): InstallGuide {
  if (platform === 'win32') {
    return { shell: '', note: '在官网下载页下载 Kiro Crew 的 Windows 安装器并安装。', url: DOWNLOADS_URL }
  }
  return { shell: '终端', command: 'curl -fsSL https://download.crew.kiro.dev/cli.sh | sh', url: CREW_DOCS_URL }
}

/** 登录结束后在弹窗里展示的结果，排版与切号结果弹窗（SwitchResultModal）一致 */
export interface CliLoginOutcome {
  status: 'success' | 'warning' | 'error'
  title: string
  /** 标题下的一句话，账号名加粗 */
  lead?: { before: string; strong: string; after: string }
  /** 色块提示条 */
  alert?: { type: 'success' | 'warning' | 'error'; message: string; description?: string }
  /** 明细里的文件路径（凭证库、原凭证备份），可复制或打开所在目录 */
  paths: { label: string; path: string }[]
  /** 底部灰色小字 */
  tip?: string
}

/** 本次运行期间用户已确认「没装 Crew 也继续」，之后不再追问 */
let crewSkipped = false

export function skipCrewPrompt(): void {
  crewSkipped = true
}

/**
 * 检测结果是否可以直接放行登录：kiro-cli 已装且凭证库已初始化，
 * Crew 已装或本次已选过不装也继续。
 */
export function toolsReady(info: KiroToolsInstallInfo): boolean {
  return info.kiroCli.installed && info.kiroCli.dbExists && (info.crew.installed || crewSkipped)
}

/** 调主进程检测；失败时抛出错误原文，由弹窗显示失败态 */
export async function detectKiroTools(fresh: boolean): Promise<KiroToolsInstallInfo> {
  const res = await window.api.getKiroToolsInstall(fresh)
  if (!res.success || !res.data) throw new Error(res.error || '检测 kiro-cli 安装情况失败')
  return res.data
}
