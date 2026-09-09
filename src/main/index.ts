import { app, dialog, nativeImage, screen, shell, BrowserWindow } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { applyRuntimeSettings, registerIpc } from './ipc'
import { getSettings } from './store'
import { normalizePortalLocale } from '../shared/portalLocale'
import { closePortalWindow } from './kiroPortal'
import {
  cancelLogin,
  handleProtocolUrl,
  registerLoginFocusHandler,
  shutdownLoginServers,
  unregisterProtocol
} from './onlineLogin'
import { destroyTray, registerTrayCallbacks, setTrayEnabled } from './tray'
import { setupAppMenu } from './appMenu'
import {
  findAppProtocolUrl,
  handleAppProtocolUrl,
  isAppProtocolUrl,
  registerAppProtocol
} from './appProtocol'
import {
  clearProactiveRenewal,
  initProactiveRenewal,
  scheduleForActiveAccount
} from './proactiveRenewal'
import { flushUsageHistory } from './usageHistory'
import { flushGatewayHistory } from './gatewayHistory'
import { initLogger, installConsoleBridge, log, shutdownLogger } from './logger'
import { sendToRenderer } from './utils'
import { initializeKeyService, shutdownKeyServiceSync } from './keyService'

/*
 * 按设置里的地区指定 Chromium 区域。
 *
 * 会话级的 Accept-Language 只影响请求头，页面内的 navigator.language 跟应用全局
 * locale 走，门户若按前端语言判断就只有这个开关管用。它必须在 app ready 之前设置，
 * ready 之后再调用不生效——所以这里同步读一次设置，也因此改地区需要重启应用。
 */
app.commandLine.appendSwitch('lang', normalizePortalLocale(getSettings().portalLocale))

let mainWindow: BrowserWindow | null = null
/** 是否正在真正退出应用（区别于「关闭按钮最小化到托盘」） */
let isQuitting = false

/**
 * 应用图标：打包后 resources 被 asarUnpack 释放到 app.asar.unpacked，
 * 开发时直接读仓库里的源文件。mac 与 win 用两套不同留白的图。
 */
function appIconPath(name: 'mac-icon' | 'windows-icon'): string {
  const dir = app.isPackaged
    ? join(process.resourcesPath, 'app.asar.unpacked', 'resources', 'icons')
    : join(__dirname, '../../resources/icons')
  return join(dir, `${name}.png`)
}

/**
 * 默认窗口尺寸。1600x1200 在 1080p 等较矮的屏幕上会超出工作区，
 * 因此按当前显示器可用区域收一下，避免窗口一开就被系统裁掉或顶出屏幕。
 */
function defaultWindowSize(): { width: number; height: number } {
  const { width: aw, height: ah } = screen.getPrimaryDisplay().workAreaSize
  return {
    width: Math.min(1600, Math.max(940, aw - 80)),
    height: Math.min(1200, Math.max(620, ah - 80))
  }
}

function createWindow(): void {
  const { width, height } = defaultWindowSize()
  mainWindow = new BrowserWindow({
    width,
    height,
    minWidth: 940,
    minHeight: 620,
    show: false,
    // Windows / Linux 的窗口与任务栏图标；macOS 用的是 Dock 图标，不看这里
    ...(process.platform === 'darwin' ? {} : { icon: appIconPath('windows-icon') }),
    autoHideMenuBar: true,
    backgroundColor: getSettings().darkMode ? '#111318' : '#f5f6fa',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      // 自动刷新的定时器跑在渲染进程里，窗口最小化到托盘后页面转入后台，
      // Chromium 默认会节流甚至冻结定时器，导致刷新迟迟不执行，这里必须关掉
      backgroundThrottling: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  // 渲染进程加载失败时留下线索：dev 模式下最常见的原因是 Vite dev server 已停止
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error(`[Window] 渲染进程加载失败 ${code} ${desc} ${url}`)
  })

  /*
   * 把渲染进程的日志转发到主进程 stdout。
   * 打包后的应用没法随手开 DevTools，自动刷新之类的问题只能靠日志定位，
   * 这里只转发本应用自己打的 [Xxx] 前缀日志与错误，避免第三方库的噪音。
   */
  mainWindow.webContents.on('console-message', (_e, level, message) => {
    // 只关心本应用自己打的 [Xxx] 前缀日志与警告以上级别，避免第三方库刷屏
    if (typeof message !== 'string') return
    if (level < 2 && !message.startsWith('[')) return
    // 直接进日志中心：不走 console 是为了保留渲染层原本的 [Xxx] 分类前缀
    log(level >= 3 ? 'error' : level === 2 ? 'warn' : 'info', message)
  })

  // 关闭按钮：启用托盘时按设置决定最小化到托盘还是退出，实现后台常驻。
  // 隐藏而非销毁可以保留渲染进程状态（路由 / 内存数据），再次打开不会退回主页。
  mainWindow.on('close', (event) => {
    const settings = getSettings()
    if (isQuitting || !settings.trayEnabled) return

    let action = settings.closeAction
    // 「每次询问」：close 事件里同步弹窗，拿到选择后再决定是隐藏还是退出
    if (action === 'ask') {
      const choice = dialog.showMessageBoxSync(mainWindow!, {
        type: 'question',
        buttons: ['最小化到托盘', '退出程序', '取消'],
        defaultId: 0,
        cancelId: 2,
        title: '关闭窗口',
        message: '关闭窗口后要如何处理？',
        detail: '可以在「设置 - 系统托盘」里固定这个行为，不再每次询问。'
      })
      if (choice === 2) {
        event.preventDefault()
        return
      }
      action = choice === 0 ? 'minimize' : 'quit'
    }

    if (action === 'minimize') {
      event.preventDefault()
      mainWindow?.hide()
      // macOS：隐藏窗口的同时隐藏 Dock 图标，彻底常驻到菜单栏
      if (process.platform === 'darwin') app.dock?.hide()
      return
    }

    // 选择退出：置位后走正常退出流程，避免被本监听再次拦截
    isQuitting = true
    app.quit()
  })

  // 窗口真正销毁后清空引用，避免后续访问已销毁对象（Object has been destroyed）
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function focusWindow(): void {
  // 窗口不存在或已被销毁时重新创建
  if (!mainWindow || mainWindow.isDestroyed()) return createWindow()
  if (process.platform === 'darwin') app.dock?.show()
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

// 社交登录的 kiro:// 回调在 Windows/Linux 上以命令行参数唤起第二个实例
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', (_event, commandLine) => {
    const appUrl = findAppProtocolUrl(commandLine)
    if (appUrl) {
      return handleAppProtocolUrl(appUrl, focusWindow, () => mainWindow)
    }
    const url = commandLine.find((arg) => arg.startsWith('kiro://'))
    if (url) handleProtocolUrl(url, mainWindow)
    focusWindow()
  })
}

// macOS 上通过 open-url 唤起
app.on('open-url', (event, url) => {
  event.preventDefault()
  if (isAppProtocolUrl(url)) {
    return handleAppProtocolUrl(url, focusWindow, () => mainWindow)
  }
  handleProtocolUrl(url, mainWindow)
})

app.whenReady().then(() => {
  electronApp.setAppUserModelId('dev.kiro.account.lite')

  // 日志中心要最先启动，后面各模块的启动日志才不会漏
  initLogger((total) => sendToRenderer(mainWindow, 'log:appended', total))
  installConsoleBridge()

  // 开发态的 Dock 图标默认是 Electron 的，手动换成应用图标。
  // 打包后由 .app 里的 icns 提供，不再覆盖，避免二次缩放变糊。
  if (process.platform === 'darwin' && !app.isPackaged) {
    const dockIcon = nativeImage.createFromPath(appIconPath('mac-icon'))
    if (!dockIcon.isEmpty()) app.dock?.setIcon(dockIcon)
  }
  app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window))

  // 本应用自有协议，常驻注册（区别于社交登录临时接管的 kiro://）
  registerAppProtocol()

  applyRuntimeSettings(getSettings())
  // 授权回调页的「返回应用」按钮靠这个回调把主窗口带到前台
  registerLoginFocusHandler(focusWindow)
  initProactiveRenewal(() => mainWindow)
  registerIpc(() => mainWindow)
  // 恢复上次的 API Key 接管；状态变化主动推送给渲染进程。
  void initializeKeyService((status) => sendToRenderer(mainWindow, 'key-gateway:changed', status))
  // macOS 顶部菜单栏（中文菜单 + 页面导航），其他平台维持默认
  setupAppMenu({ focusWindow, getWindow: () => mainWindow })
  createWindow()

  // Windows / Linux 冷启动经协议唤起时，URL 挂在命令行参数上
  const launchUrl = findAppProtocolUrl(process.argv)
  if (launchUrl) handleAppProtocolUrl(launchUrl, focusWindow, () => mainWindow)

  // 按上次持久化的激活账号，启动即恢复主动续期调度（若功能已开启）
  scheduleForActiveAccount()

  // 先登记回调，再按设置决定是否真正创建托盘图标
  registerTrayCallbacks({
    onShowWindow: focusWindow,
    // 不直接退出：先把主窗口带到前台，让渲染进程弹确认框，确认后走 app:quit
    onQuit: () => {
      focusWindow()
      sendToRenderer(mainWindow, 'app:confirm-quit')
    },
    onAction: (action) => {
      focusWindow()
      mainWindow?.webContents.send('tray:action', action)
    }
  })
  setTrayEnabled(getSettings().trayEnabled)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
    else focusWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// 兜住所有退出入口（Cmd+Q、应用菜单退出、系统关机等），让 close 拦截失效
app.on('before-quit', () => {
  isQuitting = true
})

// 退出前一定要把临时接管的 kiro:// 协议还给 Kiro IDE，
// 并把还没落盘的积分日志刷出去
app.on('will-quit', () => {
  cancelLogin()
  shutdownLoginServers()
  unregisterProtocol()
  clearProactiveRenewal('app quitting')
  flushUsageHistory()
  flushGatewayHistory()
  // 同步还原 Kiro IDE 端点后再退出，避免 IDE 指向已停止的本地网关。
  shutdownKeyServiceSync()
  // 内置浏览器是 BaseWindow，不受主窗口关闭影响，得显式收掉
  closePortalWindow()
  destroyTray()
  void shutdownLogger()
})
