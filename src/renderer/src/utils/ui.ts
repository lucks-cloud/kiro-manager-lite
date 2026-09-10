// 界面交互的通用套路：结果提示、复制、危险操作确认、弹层容器
import { Modal, message } from 'ant-design-vue'
import type { VNode } from 'vue'

/** store 里各操作统一返回的结果形状 */
export interface ActionResult {
  ok: boolean
  error?: string
}

/**
 * 统一处理「成功提示 / 失败提示」。
 * failPrefix 为空时直接展示后端错误原文，保持各调用点原有文案。
 */
export function notifyResult(
  res: ActionResult,
  options: { success: string; failPrefix?: string }
): boolean {
  if (!res.ok) {
    const { failPrefix } = options
    message.error(failPrefix ? `${failPrefix}：${res.error}` : String(res.error))
    return false
  }
  message.success(options.success)
  return true
}

/** 复制到剪贴板并提示 */
export function copyText(text: string, successMessage: string): void {
  window.api.writeClipboard(text)
  message.success(successMessage)
}

/**
 * 危险操作二次确认。默认红色描边确认按钮，
 * 传 okButtonProps 时以它为准（例如需要实心红按钮的场景）。
 *
 * zIndex：从自定义了 z-index 的弹窗里发起确认时必须传。Modal.confirm 固定用
 * 默认层级（1000），比调用方弹窗低就会被盖住，按钮点不到。
 */
export function confirmDanger(options: {
  title: string
  content?: string | VNode
  okText: string
  onOk: () => void | Promise<unknown>
  okButtonProps?: { type?: 'primary'; danger?: boolean }
  zIndex?: number
  /** 关闭动画结束后回调，确认 / 取消都会走到；用于复位调用方的「忙」标记 */
  afterClose?: () => void
}): void {
  const { okButtonProps, ...rest } = options
  Modal.confirm({
    cancelText: '取消',
    ...(okButtonProps ? { okButtonProps } : { okType: 'danger' }),
    ...rest
  })
}

/**
 * 删除类操作的二次确认：统一「确认删除」文案与实心红按钮。
 * 删除不可撤销，用实心而不是默认的红色描边，让确认动作更醒目、也和取消明显区分。
 */
export function confirmDelete(options: {
  title: string
  content?: string | VNode
  onOk: () => void | Promise<unknown>
  afterClose?: () => void
}): void {
  confirmDanger({
    ...options,
    okText: '确认删除',
    okButtonProps: { type: 'primary', danger: true }
  })
}

/** API Key 设为当前：普通 primary 确认，label 必须由调用方按隐私设置处理。 */
export function confirmUseApiKey(label: string, onOk: () => Promise<unknown>): void {
  Modal.confirm({
    title: '使用此 API Key（设为当前）',
    content: `确认使用 ${label} 并设为当前 API Key？`,
    okText: '设为当前',
    okType: 'primary',
    cancelText: '取消',
    onOk
  })
}

/** 弹层挂到 body，避免被顶栏或滚动容器裁剪 */
export const bodyPopupContainer = (): HTMLElement => document.body
