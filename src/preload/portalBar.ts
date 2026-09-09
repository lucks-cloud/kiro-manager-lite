/**
 * 内置浏览器工具条的 preload
 *
 * 工具条本身是一个 data: URL 页面（HTML 内联在 kiroPortal.ts 里），
 * 不需要打包成独立的渲染入口，只靠这个 preload 与主进程通话。
 * 页面里没有任何 Node 能力，只能触发下面这几个动作。
 */
import { contextBridge, ipcRenderer } from 'electron'

/** 主进程推给工具条的状态，用于刷新标题与前进后退按钮的可用性 */
export interface PortalBarState {
  url: string
  title: string
  canGoBack: boolean
  canGoForward: boolean
  loading: boolean
  /** 重试进度这类临时提示，有值时优先于标题显示 */
  note?: string
}

/** 工具条能触发的动作，主进程按名字分发 */
export type PortalBarAction = 'back' | 'forward' | 'reload' | 'stop' | 'menu' | 'navigate'

contextBridge.exposeInMainWorld('portalBar', {
  /** payload 目前只有 navigate 用到，传地址栏里输入的内容 */
  action: (name: PortalBarAction, payload?: string) =>
    ipcRenderer.send('portal-bar:action', name, payload),
  onState: (cb: (state: PortalBarState) => void) => {
    ipcRenderer.on('portal-bar:state', (_e, state: PortalBarState) => cb(state))
  }
})
