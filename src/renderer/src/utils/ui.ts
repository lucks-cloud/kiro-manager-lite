// 界面交互的通用套路：结果提示、复制、危险操作确认、弹层容器
import { Button, Modal, message } from 'ant-design-vue'
import { RestOutlined } from '@ant-design/icons-vue'
import { defineComponent, h, ref, type VNode } from 'vue'

/** store 里各操作统一返回的结果形状 */
interface ActionResult {
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
  /** 点蒙层是否关闭；Modal.confirm 默认不关，叠在可点蒙层关闭的弹窗上时要保持一致 */
  maskClosable?: boolean
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
 *
 * 传了 onTrash 时，底部左侧多一个「放入回收站」：不删除、只冷藏起来，之后可以从回收站移回。
 */
export function confirmDelete(options: {
  title: string
  content?: string | VNode
  onOk: () => void | Promise<unknown>
  /** 放入回收站；不传则没有这个按钮（例如本来就在回收站里，再删就是彻底删除） */
  onTrash?: () => void | Promise<unknown>
  afterClose?: () => void
  /** 从 popover（1030）或自定义层级的弹窗里发起时必须传，否则确认框会被盖住 */
  zIndex?: number
  maskClosable?: boolean
}): void {
  const { onTrash, ...rest } = options
  if (!onTrash) {
    confirmDanger({ ...rest, okText: '确认删除', okButtonProps: { type: 'primary', danger: true } })
    return
  }

  /*
   * 三个按钮的底栏：Modal.confirm 只自带「取消 / 确定」两个，放第三个只能整个替换 footer。
   * 替换后按钮的加载态与关闭都要自己管：执行期间两个动作互斥，完成后关掉确认框。
   */
  const deleting = ref(false)
  const trashing = ref(false)
  let instance: { destroy: () => void } | null = null

  async function run(state: typeof deleting, action: () => void | Promise<unknown>): Promise<void> {
    if (deleting.value || trashing.value) return
    state.value = true
    try {
      await action()
      instance?.destroy()
    } finally {
      state.value = false
    }
  }

  const Footer = defineComponent({
    setup() {
      return () =>
        h('div', { style: 'display:flex;align-items:center;gap:8px;margin-top:24px' }, [
          h(
            Button,
            {
              loading: trashing.value,
              disabled: deleting.value,
              onClick: () => void run(trashing, onTrash)
            },
            { icon: () => h(RestOutlined), default: () => '放入回收站' }
          ),
          h('span', { style: 'flex:1' }),
          h(
            Button,
            { disabled: deleting.value || trashing.value, onClick: () => instance?.destroy() },
            { default: () => '取消' }
          ),
          h(
            Button,
            {
              type: 'primary',
              danger: true,
              loading: deleting.value,
              disabled: trashing.value,
              onClick: () => void run(deleting, rest.onOk)
            },
            { default: () => '确认删除' }
          )
        ])
    }
  })

  instance = Modal.confirm({
    title: rest.title,
    content: rest.content,
    zIndex: rest.zIndex,
    maskClosable: rest.maskClosable,
    afterClose: rest.afterClose,
    // 文案比默认宽一点，三个按钮才不挤
    width: 460,
    footer: () => h(Footer)
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
