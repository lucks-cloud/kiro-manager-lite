// 外观：主题风格（自动 / 浅色 / 深色）
import { nativeTheme } from 'electron'
import type { ThemeMode } from '../shared/types'

/**
 * 把主题风格同步给 Chromium。
 *
 * 不光是为了窗口：themeSource 决定了渲染进程里 prefers-color-scheme 的取值，
 * 以及系统原生控件（右键菜单、滚动条、文件对话框）的明暗。
 * 选「浅色 / 深色」时强制成对应值，选「自动」交回给系统。
 */
export function applyThemeMode(mode: ThemeMode): void {
  nativeTheme.themeSource = mode === 'auto' ? 'system' : mode
}

/**
 * 窗口创建时的底色，和渲染层的页面底色一致，避免首屏闪一下白 / 黑。
 * 调用前要先 applyThemeMode：「自动」时要按系统当前的明暗取。
 */
export function windowBackground(): string {
  return nativeTheme.shouldUseDarkColors ? '#111318' : '#f5f6fa'
}
