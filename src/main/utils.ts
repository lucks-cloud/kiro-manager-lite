// 主进程通用小工具
import type { BrowserWindow } from 'electron'

/** 延时 */
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * 轮询等待条件成立。
 * @param check 每次检查，返回 true 即结束
 * @param attempts 最多检查几次
 * @param intervalMs 每次检查前的等待时间
 */
export async function waitUntil(
  check: () => Promise<boolean>,
  attempts: number,
  intervalMs: number
): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    await sleep(intervalMs)
    if (await check()) return true
  }
  return false
}

/** 本机当天日期 YYYY-MM-DD（本机时区），告诉模型今天是哪天 */
export function localDate(): string {
  const now = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/** 往数组尾部追加，已存在则跳过（undefined 也算一个有效取值） */
export function pushUnique<T>(list: T[], value: T): void {
  if (!list.includes(value)) list.push(value)
}

/**
 * 给渲染进程发消息。
 * 页面还在加载时（冷启动经协议唤起、窗口刚创建）等加载完成再发，避免消息丢失。
 */
export function sendToRenderer(
  window: BrowserWindow | null,
  channel: string,
  payload?: unknown
): void {
  if (!window || window.isDestroyed()) return
  if (window.webContents.isLoading()) {
    window.webContents.once('did-finish-load', () => {
      if (!window.isDestroyed()) window.webContents.send(channel, payload)
    })
  } else {
    window.webContents.send(channel, payload)
  }
}
