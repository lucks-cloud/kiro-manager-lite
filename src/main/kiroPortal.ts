// 用指定账号的凭证打开 Kiro 官网后台（带工具条的内置浏览器）
//
// 为什么不用系统浏览器的无痕窗口：那条路（browser.ts 的 openUrl）没法把凭证塞进去，
// 打开只会停在登录页。这里改用应用内的一次性会话分区，把账号 cookie 注入后再加载页面，
// 于是「用该账号身份进入后台」和「不碰用户自己的浏览器身份」两件事同时成立。
//
// 窗口结构：
//   BaseWindow
//     ├─ WebContentsView  顶部工具条（本地 data: URL 页面 + portalBar preload）
//     └─ WebContentsView  站点内容（一次性分区，无 preload 无 Node）
// 用 BaseWindow + 两个 WebContentsView 而不是「BrowserWindow 里塞 iframe」：
// iframe 会被站点的 X-Frame-Options / CSP 拦掉，也拿不到导航状态。
import {
  app,
  BaseWindow,
  BrowserWindow,
  Menu,
  WebContentsView,
  clipboard,
  screen,
  session as electronSession,
  shell,
  ipcMain
} from 'electron'
import { join } from 'path'
import { acceptLanguageFor } from '../shared/portalLocale'
import { listAvailableProfiles } from './kiroApi'
import type { Account } from '../shared/types'

const PORTAL_ORIGIN = 'https://app.kiro.dev'

/**
 * 私密会话：分区名不带 persist: 前缀，Electron 就只在内存里保存，
 * 应用退出即消失，也不会与主窗口或其它账号共用登录态。
 */
const PARTITION = 'kiro-portal-private'

/** 工具条高度：第一行按钮 + 标题，第二行地址栏 */
const BAR_HEIGHT = 44 + 38

/**
 * 排查出网 IP 用的几个站点。
 * 三家的判定库不一致（尤其是地区归属），结果可疑时能交叉比对。
 */
const IP_LOOKUP_SITES = [
  { label: 'ip.me', url: 'https://ip.me/' },
  { label: 'ip.nchu.edu.cn', url: 'https://ip.nchu.edu.cn/' },
  { label: 'ipip.net', url: 'https://www.ipip.net/' }
]

/**
 * 首屏看门狗：这么久还没 dom-ready 就中止重来。
 *
 * 首次导航偶尔会挂住——主帧请求一直不返回，直到 Chromium 自己 30 秒 ERR_TIMED_OUT，
 * 表现就是「打开后白屏很久」。而挂住之后重新发起一次往往 1 秒内就成功，
 * 所以起作用的是「重试」而不是绕缓存。6 秒足够容忍偏慢但仍在推进的连接。
 */
const LOAD_TIMEOUT_MS = 6000

/** 首屏最多尝试几次，之后交给错误页 */
const LOAD_ATTEMPTS = 4

/**
 * 伪装成普通 Chrome。
 *
 * 默认 UA 会带上应用名与 Electron/<版本>，对站点来说是显眼的自动化特征。
 * 版本号直接取内置 Chromium 的主版本而不是写死一个更新的值：UA 里声称的版本
 * 与实际引擎能力对不上，本身也是可被识别的破绽。
 */
const CHROME_MAJOR = process.versions.chrome.split('.')[0] || '134'

function platformToken(): string {
  if (process.platform === 'darwin') return 'Macintosh; Intel Mac OS X 10_15_7'
  if (process.platform === 'win32') return 'Windows NT 10.0; Win64; x64'
  return 'X11; Linux x86_64'
}

const CHROME_UA =
  `Mozilla/5.0 (${platformToken()}) AppleWebKit/537.36 (KHTML, like Gecko) ` +
  `Chrome/${CHROME_MAJOR}.0.0.0 Safari/537.36`

/**
 * 应用内网页使用的地区，由设置里的「浏览器地区」决定。
 * 主进程启动时读一次设置，之后随设置保存实时更新（无需重启即可生效）。
 */
let acceptLanguage = acceptLanguageFor()

let globalUaApplied = false

/**
 * 把干净的 UA 设成全局默认值。
 *
 * 只设会话级 / webContents 级都不够——window.open 弹出的子窗口，UA 在创建那一刻
 * 就定好了：session.setUserAgent 管不到子窗口的首个请求，在 did-create-window 里
 * 补设也已经太晚，首个请求与 navigator.userAgent 里仍是带 Electron 的那串。
 * 只有 app.userAgentFallback 会被新建的 webContents 在创建时取用。
 *
 * 惰性设置：只在真正打开内置浏览器时才改，主窗口已经创建完毕不受影响；
 * 应用对外的接口请求都在主进程用 undici 显式带 UA 发出，也不走这个值。
 */
function applyGlobalUserAgent(): void {
  if (globalUaApplied) return
  globalUaApplied = true
  app.userAgentFallback = CHROME_UA
}

/**
 * 设置应用内网页的地区。
 *
 * 除了门户那个分区，默认会话也一并更新：这样以后再加别的内嵌网页
 * 不用记得单独设一次，地区口径始终跟着这个设置走。
 * 默认会话只改 Accept-Language、保留原 UA——UA 是给 Kiro 接口用的，不能动。
 */
export function setInAppLocale(locale?: string): void {
  acceptLanguage = acceptLanguageFor(locale)

  electronSession.defaultSession.setUserAgent(
    electronSession.defaultSession.getUserAgent(),
    acceptLanguage
  )
  electronSession.fromPartition(PARTITION).setUserAgent(CHROME_UA, acceptLanguage)
}

/**
 * 配置门户分区：只设 UA 与语言，**不注册任何 webRequest 监听**。
 *
 * 这一点对速度是决定性的：一旦注册 webRequest 监听（哪怕回调里什么都不做），
 * Chromium 就必须把每一个请求都经由主进程 IPC 往返一次并等待回调放行。
 * 一个页面上百个子资源就是上百次阻塞式往返，主进程稍有别的活干就全排在后面——
 * 这正是「同一台机器 Chrome 不卡、内置浏览器卡」的根源，Chrome 没有这一跳。
 *
 * 原先这里挂过 onBeforeSendHeaders 改写 UA / sec-ch-ua 并清理 Electron 字样。
 * UA 改用 session.setUserAgent + app.userAgentFallback 达成同样效果；
 * sec-ch-ua 由 Chromium 按真实内核自动生成，本身与我们声明的主版本一致，
 * 手工改写属于锦上添花，远不值得给所有请求加一跳。
 */
function preparePortalSession(): Electron.Session {
  applyGlobalUserAgent()
  const ses = electronSession.fromPartition(PARTITION)
  ses.setUserAgent(CHROME_UA, acceptLanguage)
  return ses
}

/** 浏览外部站点的视图一律不给 Node 能力，也不注入 preload */
function contentWebPreferences(): Electron.WebPreferences {
  return {
    partition: PARTITION,
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webviewTag: false,
    preload: undefined,
    /*
     * 后台不降频。默认窗口失焦后 Chromium 会把定时器压到 1 秒一次，
     * 切回来时页面要重新追进度，表现就是「卡一下才恢复」。
     */
    backgroundThrottling: false,
    /** 关掉拼写检查：首次会去下载词典，浏览网页用不上 */
    spellcheck: false,
    /** 缓存编译后的字节码，同一站点第二次打开省掉 JS 重新编译 */
    v8CacheOptions: 'code'
  }
}

/**
 * 网页窗口尺寸：目标 1600x1200，但按当前显示器可用区域收一下。
 * 1080p 等较矮的屏幕放不下 1200 高，硬开会被系统裁掉或顶出屏幕。
 */
function portalWindowSize(): { width: number; height: number } {
  const { width: aw, height: ah } = screen.getPrimaryDisplay().workAreaSize
  return {
    width: Math.min(1600, Math.max(900, aw - 80)),
    height: Math.min(1200, Math.max(600, ah - 80))
  }
}

/**
 * 工具条 webContents.id -> 它所属的窗口。
 * failedUrl 记住上一次加载失败的地址：错误页是 data: URL，直接 reload 只会
 * 重新加载错误页本身，所以点刷新时要改成重新访问这个地址。
 */
const bars = new Map<
  number,
  {
    win: BaseWindow
    content: WebContentsView
    /** 工具条自己的 webContents，重试进度要往这里推 */
    bar: Electron.WebContents
    failedUrl?: string
    /**
     * 正在加载的目标地址。
     *
     * content.getURL() 只在导航 commit 之后才有值，而 commit 要等服务端响应——
     * 光靠它，窗口刚打开的头几百毫秒地址栏是空的。发起导航时先把目标地址记下来，
     * 状态推送里用它兜底，地址栏就能立刻显示。
     */
    pendingUrl?: string
    /** 带看门狗重试的加载入口，工具条刷新按钮也走它 */
    load?: (url: string) => void
    /**
     * 当前的临时提示（重试进度）。
     * 必须存下来：重试过程中 stop / loadURL 会触发 did-stop-loading、
     * did-start-loading，pipeStateToBar 紧接着推一条不带 note 的状态，
     * 提示就被「加载中…」冲掉了。
     */
    note?: string
  }
>()

/** 复用同一个官网主窗口：换账号只重写 cookie 再重新加载，不另开窗口 */
let portalWindow: BaseWindow | null = null
/** 主窗口的带看门狗加载入口，换账号时用它重新进入首页 */
let portalLoad: ((url: string) => void) | null = null

/** 本会话开出来的全部窗口（主窗口 + 弹窗），退出时统一收掉 */
const openedWindows = new Set<BaseWindow>()

/**
 * 需要保留 window.opener 的地址：这类登录流程靠 opener.postMessage 把结果
 * 回传给发起页，一旦我们改用自建窗口（deny + 手动开），opener 就断了、登录走不完。
 * 命中时退回原生弹窗——没有工具条，但流程完整，这个取舍必须偏向能用。
 */
const OPENER_SENSITIVE =
  /(accounts\.google\.|appleid\.apple\.com|github\.com\/(login|sessions)|amazoncognito\.com|oauth|openid|\/signin|\/sso|saml)/i

/**
 * 导航守卫：看门狗重试 + 失败兜底错误页。
 *
 * 两件事必须放在一起做，否则会互相打脸——重试期间 did-fail-load 会先把
 * 错误页顶上来，用户看到的是「报错了又自己好了」的闪烁。
 *
 * 返回的 load() 才是应该用来发起导航的入口：
 *   - dom-ready 之前卡住超过 LOAD_TIMEOUT_MS 就中止重来，最多 LOAD_ATTEMPTS 次
 *   - 次数用尽或遇到明确错误才显示错误页
 *   - 重试进度推给工具条，让用户知道是在重试而不是卡死
 */
function installNavGuard(wc: Electron.WebContents, barId?: number): (url: string) => void {
  /** 正在进行的这一轮加载，用于让旧一轮的回调失效 */
  let round = 0
  let showingError = false

  const note = (text: string, loading: boolean): void => {
    if (barId === undefined) return
    const entry = bars.get(barId)
    if (!entry) return
    entry.note = text || undefined
    if (entry.bar.isDestroyed()) return
    entry.bar.send('portal-bar:state', {
      // 尚未 commit 时用目标地址兜底，避免地址栏空一段时间
      url: wc.getURL() || entry.pendingUrl || '',
      title: wc.getTitle(),
      canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward(),
      loading,
      note: text
    })
  }

  /** 记下即将加载的地址，并立刻推一次状态让地址栏先显示出来 */
  const markPending = (url: string): void => {
    if (barId === undefined) return
    const entry = bars.get(barId)
    if (!entry) return
    entry.pendingUrl = url.startsWith('data:') ? undefined : url
    note(entry.note ?? '', true)
  }

  const setFailed = (url: string | undefined): void => {
    if (barId === undefined) return
    const entry = bars.get(barId)
    if (entry) entry.failedUrl = url
  }

  const showError = (target: string, code: number, desc: string): void => {
    // 错误页本身再失败就不递归了
    if (showingError || wc.isDestroyed()) return
    showingError = true
    setFailed(target)
    wc.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(errorHtml(target, code, desc))}`)
      .catch(() => undefined)
      .finally(() => {
        showingError = false
      })
  }

  const load = (url: string): void => {
    const myRound = ++round
    let attempt = 0
    markPending(url)

    const run = (): void => {
      if (wc.isDestroyed() || myRound !== round) return
      attempt++

      let settled = false
      const finish = (): void => {
        settled = true
        clearTimeout(timer)
        wc.off('dom-ready', onReady)
        wc.off('did-fail-load', onFail)
      }

      const onReady = (): void => {
        if (settled || myRound !== round) return
        finish()
        setFailed(undefined)
        // 清掉重试提示，回到正常状态（后续状态由 pipeStateToBar 推）
        note('', wc.isLoading())
      }

      const retryOrGiveUp = (code: number, desc: string, target = url): void => {
        if (myRound !== round) return
        if (attempt >= LOAD_ATTEMPTS) {
          note('', false)
          showError(target, code, desc)
          return
        }
        note(`连接不上，正在重试（${attempt + 1}/${LOAD_ATTEMPTS}）…`, true)
        run()
      }

      const onFail = (
        _e: Electron.Event,
        code: number,
        desc: string,
        target: string,
        isMainFrame: boolean
      ): void => {
        // 子框架失败（广告位、统计脚本）不该顶掉整个页面
        if (!isMainFrame || settled || myRound !== round) return
        /*
         * -3 是 ERR_ABORTED。重定向、用户中途点别的链接、我们自己 stop()
         * 都会报这个，属于正常流程，不能当失败处理。
         */
        if (code === -3) return
        finish()
        retryOrGiveUp(code, desc, target || url)
      }

      const timer = setTimeout(() => {
        if (settled || wc.isDestroyed() || myRound !== round) return
        finish()
        // 主帧一直不返回，掐掉这次导航再重来
        wc.stop()
        retryOrGiveUp(-7, '连接超时')
      }, LOAD_TIMEOUT_MS)

      wc.on('dom-ready', onReady)
      wc.on('did-fail-load', onFail)
      /*
       * loadURL 的 promise 在导航被中断时会 reject（重定向、我们自己 stop()）。
       * 不接的话就是 unhandled rejection，失败的展示由上面的监听负责。
       */
      wc.loadURL(url, { userAgent: CHROME_UA }).catch(() => undefined)
    }

    run()
  }

  // 渲染进程崩溃后视图会一直空着，这也是白屏的一种
  wc.on('render-process-gone', (_e, details) => {
    showError(wc.getURL(), 0, `页面进程已退出（${details.reason}）`)
  })

  // 用户自己点链接跳走并成功后，清掉失败记录，刷新按钮回归正常语义
  wc.on('did-navigate', (_e, navUrl) => {
    if (navUrl.startsWith('data:')) return
    setFailed(undefined)
    // 真实地址已经 commit，兜底值不再需要，留着会在后续导航里变成陈旧数据
    if (barId !== undefined) {
      const entry = bars.get(barId)
      if (entry) entry.pendingUrl = undefined
    }
  })

  return load
}

/**
 * 给「不是我们发起」的首次导航也套上看门狗。
 *
 * window.open 弹出的窗口，首个地址由 Chromium 直接加载，拿不到 load() 的入口。
 * 只盯第一次导航：那一次必然是 window.open 传进来的 GET 地址，重发安全。
 * 之后的导航（表单提交、登录回调）一律不碰——用 loadURL 重发会丢掉 POST 内容，
 * 那会直接把登录流程搞坏。
 */
function armFirstNavigation(wc: Electron.WebContents, load: (url: string) => void): void {
  let armed = true

  wc.once('did-start-navigation', (_e, url, isInPlace, isMainFrame) => {
    if (!armed || !isMainFrame || isInPlace || !/^https?:\/\//i.test(url)) return
    armed = false

    const timer = setTimeout(() => {
      if (wc.isDestroyed() || !wc.isLoadingMainFrame()) return
      // 首屏还没就绪，改由带重试的通道重新加载
      wc.stop()
      load(url)
    }, LOAD_TIMEOUT_MS)

    wc.once('dom-ready', () => clearTimeout(timer))
    wc.once('destroyed', () => clearTimeout(timer))
  })
}

/** 把导航状态推给工具条，用于更新标题与前进后退按钮 */
function pipeStateToBar(bar: WebContentsView, content: WebContentsView): void {
  const push = (): void => {
    if (bar.webContents.isDestroyed() || content.webContents.isDestroyed()) return
    const history = content.webContents.navigationHistory
    const entry = bars.get(bar.webContents.id)
    bar.webContents.send('portal-bar:state', {
      // 未 commit 时退回目标地址：窗口刚打开那几百毫秒 getURL() 还是空的
      url: content.webContents.getURL() || entry?.pendingUrl || '',
      title: content.webContents.getTitle(),
      canGoBack: history.canGoBack(),
      canGoForward: history.canGoForward(),
      loading: content.webContents.isLoading(),
      // 重试提示要跟着一起带上，否则会被这条状态冲掉
      note: entry?.note
    })
  }

  // 逐个注册而不是遍历事件名数组：webContents.on 是重载签名，
  // 传联合类型的事件名过不了类型检查
  const wc = content.webContents
  wc.on('did-navigate', push)
  wc.on('did-navigate-in-page', push)
  wc.on('page-title-updated', push)
  wc.on('did-start-loading', push)
  wc.on('did-stop-loading', push)
  /*
   * 用户点链接跳走时，地址栏也该立刻跟上，而不是等页面 commit。
   * 只认主框架：子框架（广告位、内嵌 iframe）的导航不该改地址栏。
   */
  wc.on('did-start-navigation', (_e, url, _isInPlace, isMainFrame) => {
    if (!isMainFrame || url.startsWith('data:')) return
    const entry = bars.get(bar.webContents.id)
    if (entry) entry.pendingUrl = url
    push()
  })
  // 工具条本身加载完才收得到消息，首次状态在这里补一发
  bar.webContents.on('did-finish-load', push)
}

/**
 * 把导航留在应用内。
 *
 * 之前只放行 kiro.dev、其余交给系统浏览器，于是点到支付页、AWS 文档这类站外链接
 * 就跳出应用，而系统浏览器里没有这份会话，流程直接断掉。
 * 现在 http(s) 一律用应用内新窗口承载，并对新窗口递归挂上同样的规则。
 *
 * 弹窗保持 action: 'allow'（原生窗口、没有工具条）而不是自己另开一个带工具条的窗口——
 * 换成 deny + 手动开窗会断掉 window.opener，而「用 Google 登录」这类流程
 * 正是靠 opener.postMessage 把结果回传给发起页的。
 */
function keepNavigationInApp(contents: Electron.WebContents): void {
  contents.setWindowOpenHandler(({ url }) => {
    if (!/^https?:\/\//i.test(url)) {
      // 非 http(s)（mailto、itms-apps 等）Electron 渲染不了，交给系统处理
      void shell.openExternal(url)
      return { action: 'deny' }
    }

    /*
     * 登录类地址退回原生弹窗：自建窗口会断掉 window.opener，
     * 而这类流程正是靠 opener.postMessage 回传结果的。
     */
    if (OPENER_SENSITIVE.test(url)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          ...portalWindowSize(),
          autoHideMenuBar: true,
          webPreferences: contentWebPreferences()
        }
      }
    }

    /*
     * 其余弹窗改由自己开：BrowserWindow 的页面不是 contentView 的子视图
     * （实测 contentView 是个空 View），没法把页面下移给工具条腾位置，
     * 只有 BaseWindow + 两个 WebContentsView 的结构才能带上工具条与地址栏。
     */
    const popup = createBrowserShell('Kiro 官网')
    popup.load(url)
    return { action: 'deny' }
  })

  // 原生弹窗里再点 target=_blank 也要有人接管
  contents.on('did-create-window', (child) => {
    applyPopupBehavior(child)
  })
}

/** 原生弹窗（保留 opener 的那类）：同样留在应用内，并补上看门狗与导航快捷键 */
function applyPopupBehavior(win: BrowserWindow): void {
  trackWindow(win)
  keepNavigationInApp(win.webContents)
  armFirstNavigation(win.webContents, installNavGuard(win.webContents))
  bindNavKeys(win, win.webContents)
}

/** 纳入窗口集合，退出时统一收掉 */
function trackWindow(win: BaseWindow): void {
  openedWindows.add(win)
  win.on('closed', () => openedWindows.delete(win))
}

/** 没有菜单栏就没有前进后退入口，补上 ⌘/Ctrl + [ ] 与 R / W */
function bindNavKeys(win: BaseWindow, target: Electron.WebContents): void {
  target.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || (!input.meta && !input.control)) return
    const history = target.navigationHistory
    if (input.key === '[') {
      event.preventDefault()
      if (history.canGoBack()) history.goBack()
    } else if (input.key === ']') {
      event.preventDefault()
      if (history.canGoForward()) history.goForward()
    } else if (input.key.toLowerCase() === 'r') {
      event.preventDefault()
      target.reload()
    } else if (input.key.toLowerCase() === 'w') {
      event.preventDefault()
      win.close()
    }
  })
}

// ---- 工具条的动作分发 ----

let actionBound = false

/**
 * 工具条动作只注册一次全局监听，按 sender.id 找回对应窗口。
 * 每开一个窗口注册一个 ipcMain.on 会不断叠加监听器。
 */
function bindBarActions(): void {
  if (actionBound) return
  actionBound = true

  ipcMain.on('portal-bar:action', (event, name: string, payload?: string) => {
    const entry = bars.get(event.sender.id)
    if (!entry || entry.content.webContents.isDestroyed()) return
    const wc = entry.content.webContents
    const history = wc.navigationHistory

    switch (name) {
      case 'back':
        if (history.canGoBack()) history.goBack()
        break
      case 'forward':
        if (history.canGoForward()) history.goForward()
        break
      case 'reload':
        /*
         * 停在错误页时 reload 只会重刷错误页本身，得重试真实地址；
         * 而且要走带看门狗的通道，否则又是干等 30 秒。
         */
        if (entry.failedUrl && entry.load) entry.load(entry.failedUrl)
        else wc.reload()
        break
      case 'stop':
        wc.stop()
        break
      case 'menu':
        popupBarMenu(entry.win, wc)
        break
      case 'navigate': {
        const target = toNavigableUrl(payload || '')
        if (!target) break
        // 走带看门狗的通道，手输地址同样享受超时重试
        if (entry.load) entry.load(target)
        else void wc.loadURL(target, { userAgent: CHROME_UA })
        break
      }
    }
  })
}

/**
 * 把地址栏里输入的内容转成可导航的地址。
 *
 * 带协议的原样用；看着像域名的（含点、无空格）补上 https://；
 * 其余当搜索词交给百度——这和普通浏览器地址栏的行为一致，
 * 输错一个字母不至于直接跳出个 ERR_NAME_NOT_RESOLVED 错误页。
 */
function toNavigableUrl(input: string): string {
  const text = input.trim()
  if (!text) return ''
  if (/^https?:\/\//i.test(text)) return text
  /*
   * 只拦明确危险或无意义的协议，而不是拦下所有含冒号的输入——
   * 后者会把 localhost:5173、127.0.0.1:19830 这类带端口的地址一起误伤。
   */
  if (/^(about|chrome|devtools|file|javascript|data|blob|view-source):/i.test(text)) return ''
  // 含点的域名，或 host:port 形式，都按网址处理
  if (/^[^\s]+\.[^\s]+$/.test(text) || /^[^\s:]+:\d+(\/[^\s]*)?$/.test(text)) {
    return `https://${text}`
  }
  return `https://www.baidu.com/s?wd=${encodeURIComponent(text)}`
}

/** 三个点里的菜单，用原生 Menu 而不是自绘下拉：外观与系统一致，也不会被内容视图裁切 */
function popupBarMenu(win: BaseWindow, wc: Electron.WebContents): void {
  const url = wc.getURL()

  /**
   * 排查类入口一律开新窗口，不顶掉当前页面。
   * 当前页面往往是登录后的后台，被替换掉就得重新导航回去；开新窗口还能左右对照。
   * 新窗口共用同一个会话分区，出网路径与当前页面完全一致，IP 查询结果才有参考意义。
   */
  const openInNewWindow = (target: string): void => {
    createBrowserShell('Kiro 官网').load(target)
  }

  Menu.buildFromTemplate([
    { label: '刷新', click: () => wc.reload() },
    { label: '强制重新加载（忽略缓存）', click: () => wc.reloadIgnoringCache() },
    { type: 'separator' },
    {
      /*
       * 排查用：确认这个分区实际出网的 IP 与地区。
       * 三家并列是因为它们的判定库不一致，遇到结果可疑时能交叉比对。
       */
      label: 'IP 查询',
      submenu: IP_LOOKUP_SITES.map(({ label, url: site }) => ({
        label,
        click: () => openInNewWindow(site)
      }))
    },
    {
      // 百度能连上说明基础网络通，用来区分「网络问题」还是「目标站点问题」
      label: '打开百度',
      click: () => openInNewWindow('https://www.baidu.com')
    },
    { type: 'separator' },
    {
      label: '复制链接',
      enabled: !!url && !url.startsWith('data:'),
      click: () => clipboard.writeText(url)
    },
    {
      // 这里是用户显式选择才外跳，和「点链接自动跳到系统浏览器」是两回事。
      // 注意：系统浏览器里没有这份会话，打开后会是未登录状态。
      label: '在默认浏览器中打开（不带登录态）',
      enabled: /^https?:\/\//i.test(url),
      click: () => void shell.openExternal(url)
    },
    { type: 'separator' },
    {
      label: wc.isDevToolsOpened() ? '关闭开发者工具' : '打开开发者工具',
      click: () => (wc.isDevToolsOpened() ? wc.closeDevTools() : wc.openDevTools({ mode: 'right' }))
    }
  ]).popup({ window: win })
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * 加载失败时顶上来的页面。
 * 「重试」用内联脚本改 location，弹窗没有工具条时这是唯一的重试入口。
 */
function errorHtml(url: string, code: number, desc: string): string {
  const safeUrl = escapeHtml(url)
  const reason = escapeHtml(desc || '未知错误')
  const codeText = code ? `错误代码 ${code}` : ''

  return `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'" />
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    height: 100vh; display: flex; flex-direction: column;
    align-items: center; justify-content: center; gap: 10px; padding: 24px;
    font: 14px -apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;
    color: #1f2328; background: #fff; text-align: center;
  }
  h1 { font-size: 17px; font-weight: 600; }
  p { color: #6b7075; font-size: 13px; max-width: 520px; word-break: break-all; }
  code {
    font-family: 'SF Mono', Menlo, Consolas, monospace; font-size: 12px;
    background: #f3f4f6; padding: 2px 6px; border-radius: 5px;
  }
  button {
    margin-top: 6px; padding: 7px 18px; font-size: 13px;
    border: 0; border-radius: 7px; background: #6c5ce7; color: #fff; cursor: pointer;
  }
  button:hover { background: #5b4bd6; }
</style></head>
<body>
  <h1>页面打不开</h1>
  <p>${reason}${codeText ? ` · ${codeText}` : ''}</p>
  <p><code>${safeUrl}</code></p>
  <button id="retry">重试</button>
<script>
  document.getElementById('retry').addEventListener('click', function () {
    location.href = ${JSON.stringify(url)}
  })
</script>
</body></html>`
}

/** 工具条页面：内联在这里，用 data: URL 加载，不占渲染层的构建入口 */
function barHtml(padLeft: number): string {
  return `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8" />
<!--
  显式声明 CSP：内容全部内联在本文件里，不允许任何外部加载。
  不写的话 Electron 会在控制台刷一条 Insecure Content-Security-Policy 警告。
-->
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'" />
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { height: 100%; overflow: hidden; }
  body {
    display: flex; flex-direction: column;
    font: 13px -apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;
    color: #1f2328; background: #f6f7f9;
    border-bottom: 1px solid #e3e5e8;
    -webkit-user-select: none; user-select: none;
  }
  /* 第一行：导航按钮 + 标题 + 更多。空白处可拖动窗口，控件上再单独关掉 */
  #row1 {
    flex: 0 0 44px; display: flex; align-items: center; gap: 4px;
    padding-left: ${padLeft}px; padding-right: 8px;
    -webkit-app-region: drag;
  }
  /* 第二行：地址栏。整行不可拖动，否则点不进输入框 */
  #row2 {
    flex: 0 0 38px; display: flex; align-items: center; gap: 6px;
    padding: 0 8px 6px;
    -webkit-app-region: no-drag;
  }
  #url {
    flex: 1; min-width: 0; height: 28px; padding: 0 10px;
    font: inherit; color: #1f2328;
    border: 1px solid #dcdfe3; border-radius: 7px; background: #fff;
    outline: none;
  }
  #url:focus { border-color: #6c5ce7; }
  #go {
    flex: 0 0 auto; width: auto; height: 28px; padding: 0 12px;
    border-radius: 7px; background: #6c5ce7; color: #fff; font: inherit;
  }
  #go:hover { background: #5b4bd6; }
  button {
    -webkit-app-region: no-drag;
    flex: 0 0 auto; width: 28px; height: 28px;
    display: grid; place-items: center;
    border: 0; border-radius: 7px; background: transparent;
    color: #3c4043; cursor: pointer;
  }
  button:hover:not(:disabled) { background: rgba(0, 0, 0, 0.07); }
  button:disabled { color: #c2c5c9; cursor: default; }
  svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 2;
        stroke-linecap: round; stroke-linejoin: round; }
  #title {
    flex: 1; min-width: 0; margin: 0 6px;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    text-align: center; color: #3c4043;
  }
  #title.loading { color: #8b8f94; }
  /* 加载进度条：站点慢的时候至少让用户看到「在动」，而不是干等一片空白 */
  #progress {
    position: fixed; left: 0; bottom: 0; height: 2px; width: 100%;
    overflow: hidden; opacity: 0; transition: opacity 0.2s;
  }
  #progress.on { opacity: 1; }
  #progress::after {
    content: ''; position: absolute; inset: 0; width: 40%;
    background: linear-gradient(90deg, transparent, #6c5ce7, transparent);
    animation: slide 1.1s linear infinite;
  }
  @keyframes slide { from { transform: translateX(-100%) } to { transform: translateX(350%) } }
</style></head>
<body>
  <div id="row1">
    <button id="back" title="后退 (⌘/Ctrl + [)">
      <svg viewBox="0 0 24 24"><path d="M15 19l-7-7 7-7" /></svg>
    </button>
    <button id="forward" title="前进 (⌘/Ctrl + ])">
      <svg viewBox="0 0 24 24"><path d="M9 5l7 7-7 7" /></svg>
    </button>
    <button id="reload" title="刷新 (⌘/Ctrl + R)">
      <svg viewBox="0 0 24 24"><path d="M20 11a8 8 0 1 0-2.3 5.7" /><path d="M20 5v6h-6" /></svg>
    </button>

    <div id="title"></div>

    <button id="dots" title="更多">
      <svg viewBox="0 0 24 24" style="fill: currentColor; stroke: none">
        <circle cx="5" cy="12" r="1.7" /><circle cx="12" cy="12" r="1.7" /><circle cx="19" cy="12" r="1.7" />
      </svg>
    </button>
  </div>

  <div id="row2">
    <input id="url" type="text" spellcheck="false" autocomplete="off"
           placeholder="输入网址后回车跳转，非网址按百度搜索" />
    <button id="go" title="跳转">跳转</button>
  </div>
  <div id="progress"></div>

<script>
  var $ = function (id) { return document.getElementById(id) }
  var titleEl = $('title')
  var urlEl = $('url')
  var loading = false
  /** 用户是否正在编辑地址栏：编辑期间不让状态推送覆盖输入内容 */
  var editing = false

  $('back').onclick = function () { window.portalBar.action('back') }
  $('forward').onclick = function () { window.portalBar.action('forward') }
  $('reload').onclick = function () { window.portalBar.action(loading ? 'stop' : 'reload') }
  $('dots').onclick = function () { window.portalBar.action('menu') }

  var go = function () {
    var value = urlEl.value.trim()
    if (!value) return
    editing = false
    urlEl.blur()
    window.portalBar.action('navigate', value)
  }
  $('go').onclick = go

  urlEl.addEventListener('focus', function () {
    editing = true
    urlEl.select()
  })
  urlEl.addEventListener('blur', function () { editing = false })
  urlEl.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); go() }
    // Esc 放弃编辑，把地址栏还原成当前页面地址
    else if (e.key === 'Escape') { urlEl.value = urlEl.dataset.current || ''; urlEl.blur() }
  })

  window.portalBar.onState(function (s) {
    loading = s.loading
    // note 是重试进度这类临时提示，比标题更该让用户看到
    titleEl.textContent = s.note || (s.loading ? '加载中…' : (s.title || s.url || ''))
    titleEl.className = s.loading ? 'loading' : ''
    titleEl.title = s.url || ''
    $('back').disabled = !s.canGoBack
    $('forward').disabled = !s.canGoForward
    $('reload').title = s.loading ? '停止加载' : '刷新 (⌘/Ctrl + R)'
    $('progress').className = s.loading ? 'on' : ''

    /*
     * 地址栏跟随当前页面，但正在输入时不覆盖——否则用户打一半就被跳转事件冲掉。
     * data: URL 是我们自己的错误页，不该显示给用户。
     */
    var shown = s.url && s.url.indexOf('data:') !== 0 ? s.url : ''
    urlEl.dataset.current = shown
    if (!editing) urlEl.value = shown
  })
</script>
</body></html>`
}

/**
 * 门户认的会话 cookie。
 *
 * Idp / AccessToken / RefreshToken 三个是社交与 Builder ID 账号进后台的充分条件。
 * Enterprise（IdC / SSO）账号还必须带 ProfileArn，否则门户把会话判为 stale、停在登录页
 * —— 实测同一 token 补上该 cookie，user-status 立刻从 stale 变 active、user-id 也出现。
 * 对其它登录方式带上它无副作用（本就 active，加了仍 active），因此只要账号有 ARN 就一并注入。
 */
function portalCookies(account: Account, profileArn: string): { name: string; value: string }[] {
  const { accessToken, refreshToken } = account.credentials
  return [
    { name: 'Idp', value: account.idp },
    { name: 'AccessToken', value: accessToken },
    { name: 'RefreshToken', value: refreshToken },
    { name: 'ProfileArn', value: profileArn }
  ].filter((item) => !!item.value)
}

/**
 * 定出注入 cookie 用的 profileArn。
 *
 * 优先用账号已存的值。仅当 Enterprise 账号一次都没存过 ARN 时，才现场问一次
 * ListAvailableProfiles 补齐——否则这类账号打开官网只会停在登录页（stale）。
 * 失败或非 Enterprise 一律返回空串，行为与之前一致，不引入回归。
 */
async function resolvePortalArn(account: Account): Promise<string> {
  const stored = account.profileArn || account.credentials.profileArn
  if (stored) return stored
  if (account.idp !== 'Enterprise') return ''

  const { accessToken, region } = account.credentials
  if (!accessToken) return ''
  try {
    const [arn] = await listAvailableProfiles(accessToken, region)
    if (arn) console.info('[KiroPortal] Enterprise 账号缺 profileArn，已现查补齐')
    return arn || ''
  } catch {
    return ''
  }
}

/**
 * 建一个带工具条的浏览器窗口（主窗口与弹窗共用同一套外壳）。
 * 返回 load()：带看门狗重试的导航入口，调用方拿它去加载首个地址。
 */
function createBrowserShell(title: string): { win: BaseWindow; load: (url: string) => void } {
  const { width, height } = portalWindowSize()
  const win = new BaseWindow({
    width,
    height,
    minWidth: 480,
    minHeight: 400,
    title,
    /*
     * macOS 隐藏原生标题栏，红绿灯直接压在工具条上，接近微信那种一体感。
     * 其他平台保留原生边框：Windows / Linux 下自绘还得补最小化最大化关闭三个键。
     */
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: '#ffffff',
    /*
     * 先不显示。两个视图都还没加载完就把窗口摆出来，用户看到的就是一整块空白——
     * 这是「刚打开就白屏」最直接的来源。等工具条就绪再显示，
     * 至少第一眼是个有按钮、有「加载中…」提示的界面。
     */
    show: false
  })

  const bar = new WebContentsView({
    webPreferences: {
      preload: join(__dirname, '../preload/portalBar.js'),
      contextIsolation: true,
      // 工具条是本地页面，preload 需要 require，不开沙箱
      sandbox: false
    }
  })
  const content = new WebContentsView({ webPreferences: contentWebPreferences() })
  // 视图默认背景透明，加载间隙会透出窗口底色甚至闪黑，显式铺白
  bar.setBackgroundColor('#f6f7f9')
  content.setBackgroundColor('#ffffff')

  win.contentView.addChildView(bar)
  win.contentView.addChildView(content)

  const layout = (): void => {
    const [w, h] = win.getContentSize()
    bar.setBounds({ x: 0, y: 0, width: w, height: BAR_HEIGHT })
    content.setBounds({ x: 0, y: BAR_HEIGHT, width: w, height: Math.max(0, h - BAR_HEIGHT) })
  }
  layout()
  win.on('resize', layout)

  bars.set(bar.webContents.id, { win, content, bar: bar.webContents })

  /*
   * WebContentsView 的 webContents 不会随窗口关闭自动销毁，得手动收，
   * 否则关一次窗口漏一对渲染进程。
   */
  win.on('closed', () => {
    bars.delete(bar.webContents.id)
    for (const view of [bar, content]) {
      if (!view.webContents.isDestroyed()) view.webContents.close()
    }
    // 只有主窗口才需要清掉这两个引用，弹窗本来就不占用它们
    if (portalWindow === win) {
      portalWindow = null
      portalLoad = null
    }
  })

  keepNavigationInApp(content.webContents)
  bindNavKeys(win, content.webContents)
  pipeStateToBar(bar, content)

  const load = installNavGuard(content.webContents, bar.webContents.id)
  const entry = bars.get(bar.webContents.id)
  if (entry) entry.load = load

  /*
   * 工具条就绪就显示窗口。
   * 兜底定时器是为了防止 data: URL 万一没触发 did-finish-load——
   * 那种情况下窗口永远不显示，用户会以为「点了没反应」，比白屏更糟。
   */
  let shown = false
  const reveal = (): void => {
    if (shown || win.isDestroyed()) return
    shown = true
    win.show()
  }
  bar.webContents.once('did-finish-load', reveal)
  const revealTimer = setTimeout(reveal, 600)
  win.on('closed', () => clearTimeout(revealTimer))

  // macOS 隐藏标题栏后红绿灯占住左上角，给工具条留出让位空间
  const padLeft = process.platform === 'darwin' ? 78 : 12
  // 工具条是本地 data: URL，不需要看门狗
  bar.webContents
    .loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(barHtml(padLeft))}`)
    .catch(() => undefined)

  trackWindow(win)
  return { win, load }
}

/**
 * 打开官网后台并以该账号身份登录。
 * 已有窗口时复用：换账号只需重写 cookie，不必再开一个窗口。
 */
export async function openAccountPortal(account: Account): Promise<{ url: string }> {
  const { accessToken, refreshToken } = account.credentials
  if (!accessToken && !refreshToken) throw new Error('账号缺少凭证，无法登录官网')

  const profileArn = await resolvePortalArn(account)

  const ses = preparePortalSession()
  /*
   * 每次都先清空：残留的旧账号 cookie 会让门户继续按上一个身份渲染，
   * 表现就是「点了 A 账号却进了 B 账号的后台」。
   */
  await ses.clearStorageData({ storages: ['cookies'] })

  for (const { name, value } of portalCookies(account, profileArn)) {
    await ses.cookies.set({
      url: PORTAL_ORIGIN,
      name,
      value,
      domain: 'app.kiro.dev',
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'lax'
    })
  }

  if (!portalWindow || portalWindow.isDestroyed()) {
    const shellWindow = createBrowserShell(`Kiro 官网 - ${account.email}`)
    portalWindow = shellWindow.win
    portalLoad = shellWindow.load
  }

  const win = portalWindow
  if (!win) throw new Error('无法创建官网窗口')
  win.setTitle(`Kiro 官网 - ${account.email}`)

  // 走带看门狗重试的通道，而不是裸 loadURL：首屏挂住时能自动重来
  portalLoad?.(PORTAL_ORIGIN)

  if (win.isMinimized()) win.restore()
  win.focus()
  console.info(`[KiroPortal] 已以 ${account.email} 的身份打开官网后台`)
  return { url: PORTAL_ORIGIN }
}

/** 应用退出时收掉全部窗口（主窗口 + 弹窗），避免残留窗口挡住退出流程 */
export function closePortalWindow(): void {
  for (const win of [...openedWindows]) {
    if (!win.isDestroyed()) win.close()
  }
  openedWindows.clear()
  portalWindow = null
  portalLoad = null
}

bindBarActions()
