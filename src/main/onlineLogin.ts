// 在线添加账号：Builder ID 设备码、Google / GitHub 社交登录、Enterprise IAM Identity Center SSO
import { app, BrowserWindow } from 'electron'
import * as crypto from 'crypto'
import * as http from 'http'
import { setProtocolClient } from './appProtocol'
import { openUrl } from './browser'
import { errorMessage } from '../shared/errors'
import { KIRO_AUTH_BASE, KIRO_OIDC_SCOPES, KIRO_START_URL, oidcEndpoint } from './kiroEndpoints'
import { httpRequest, type HttpResponse } from './net'
import { DEFAULT_REGION } from '../shared/regions'
import type {
  BrowserOpenInfo,
  BuilderIdStartInfo,
  IdpType,
  LoginPollResult,
  OnlineLoginCredentials
} from '../shared/types'

const SOCIAL_REDIRECT_URI = 'kiro://kiro.kiroAgent/authenticate-success'
const PROTOCOL = 'kiro'
/** 授权流程的有效期：设备码由服务端下发，其余流程本地限时 10 分钟 */
const LOGIN_TTL_MS = 10 * 60 * 1000
/** 接口没给 expiresIn 时的兜底有效期（秒） */
const DEFAULT_EXPIRES_IN = 3600

// ============ kiro:// 协议（社交登录回调）============
//
// Kiro 的社交登录只接受固定的 kiro:// 回调地址，必须临时接管该协议。
// 为了尽量不影响 Kiro IDE 自身的登录，只在社交登录进行中注册，结束即注销。

let protocolRegistered = false

/**
 * 强制把 kiro:// 的系统默认处理者抢回本应用，并确认真的抢到了。
 *
 * 别的应用（Kiro IDE、甚至微信开发者工具这类也声明了 kiro:// 的工具）可能已经把自己
 * 设成了默认处理者；只调用一次 setAsDefaultProtocolClient 未必能盖过它，表现就是
 * 「浏览器授权成功后打开了别的应用，而不是回到本应用」。
 *
 * 这里每次发起社交登录时都强制重新抢占：先撤销再设置，让 macOS 的
 * LSSetDefaultHandlerForURLScheme（Windows 下写注册表）把默认处理者改回本应用。
 * 之后用 isDefaultProtocolClient 校验是否真的抢到——macOS 上只有 Info.plist 声明过该
 * scheme 才可能成为默认处理者（见 electron-builder.yml 的 protocols），未声明会静默失效。
 *
 * @returns 是否已成为 kiro:// 的默认处理者
 */
function registerProtocol(): boolean {
  // 先撤销自身旧登记再重新设置，强制触发系统把默认处理者改回本应用
  setProtocolClient(PROTOCOL, false)
  setProtocolClient(PROTOCOL, true)
  protocolRegistered = true
  const owned = app.isDefaultProtocolClient(PROTOCOL)
  console.log(`[Login] kiro:// protocol reclaimed (temporary), owned=${owned}`)
  return owned
}

export function unregisterProtocol(): void {
  if (!protocolRegistered) return
  setProtocolClient(PROTOCOL, false)
  protocolRegistered = false
  console.log('[Login] kiro:// protocol unregistered')
}

/** OIDC / auth service 的接口一律是 JSON POST，统一在这里拼请求 */
function postJson(url: string, body: Record<string, unknown>): Promise<HttpResponse> {
  return httpRequest(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
}

/** 解析 kiro:// 回调并转交渲染进程 */
export function handleProtocolUrl(url: string, window: BrowserWindow | null): void {
  if (!url.startsWith(`${PROTOCOL}://`)) return
  try {
    const parsed = new URL(url)
    const code = parsed.searchParams.get('code') ?? undefined
    const state = parsed.searchParams.get('state') ?? undefined
    const error = parsed.searchParams.get('error') ?? undefined
    if (!code && !error) return

    window?.webContents.send('login:social-callback', { code, state, error })
    if (window) {
      if (window.isMinimized()) window.restore()
      window.focus()
    }
  } catch (e) {
    console.warn('[Login] failed to parse protocol url:', e)
  }
}

// ============ 登录会话状态 ============

interface BuilderIdSession {
  kind: 'builderId'
  clientId: string
  clientSecret: string
  deviceCode: string
  region: string
  expiresAt: number
}

interface SocialSession {
  kind: 'social'
  provider: 'Google' | 'Github'
  codeVerifier: string
  state: string
  expiresAt: number
}

/**
 * Enterprise 授权码流程的中间状态都由回调服务器的闭包持有，
 * 这里只需要保留轮询与清理要用到的字段。
 */
interface EnterpriseSession {
  kind: 'enterprise'
  expiresAt: number
  server: http.Server
  result?: { success: boolean; credentials?: OnlineLoginCredentials; error?: string }
}

type Session = BuilderIdSession | SocialSession | EnterpriseSession

let session: Session | null = null

// ============ 回调页「返回应用」支持 ============
//
// 回调页上的按钮需要唤起主窗口，因此本地回调服务器在登录结束后不立即关闭，
// 而是多存活一段时间用于响应 /focus 请求。

/** 主窗口唤起回调，由主进程在启动时登记 */
let focusApp: (() => void) | null = null

export function registerLoginFocusHandler(fn: () => void): void {
  focusApp = fn
}

/** 登录结束后回调服务器的额外存活时间 */
const SERVER_LINGER_MS = 2 * 60 * 1000
const lingeringServers = new Map<http.Server, NodeJS.Timeout>()

function closeServer(server: http.Server): void {
  const timer = lingeringServers.get(server)
  if (timer) clearTimeout(timer)
  lingeringServers.delete(server)
  server.close()
}

function lingerServer(server: http.Server): void {
  if (lingeringServers.has(server)) return
  const timer = setTimeout(() => closeServer(server), SERVER_LINGER_MS)
  // 不因为这个定时器阻止进程退出
  timer.unref?.()
  lingeringServers.set(server, timer)
}

/** 应用退出时立刻关掉所有仍在存活的回调服务器 */
export function shutdownLoginServers(): void {
  for (const server of [...lingeringServers.keys()]) closeServer(server)
}

export function cancelLogin(): void {
  if (session?.kind === 'enterprise') lingerServer(session.server)
  if (session?.kind === 'social') unregisterProtocol()
  session = null
}

function expired(): boolean {
  return !!session && Date.now() > session.expiresAt
}

// ============ OIDC 客户端注册 ============

async function registerOidcClient(
  region: string,
  grantTypes: string[],
  issuerUrl: string,
  redirectUris?: string[]
): Promise<{ clientId: string; clientSecret: string }> {
  const res = await postJson(`${oidcEndpoint(region)}/client/register`, {
    clientName: 'Kiro Manager Lite',
    clientType: 'public',
    scopes: KIRO_OIDC_SCOPES,
    grantTypes,
    ...(redirectUris ? { redirectUris } : {}),
    issuerUrl
  })
  if (!res.ok) {
    const text = await res.text()
    if (text.includes('UnauthorizedException') || text.includes('access denied')) {
      throw new Error('授权失败：该组织可能未开通 Amazon Q Developer 权限，请联系 IAM Identity Center 管理员')
    }
    // AWS 只回一句 invalid_request / Invalid request.，原文对用户毫无指导意义。
    // 这个错误在企业版登录里几乎只有一个成因：所选区域没有该 Start URL 对应的 IdC 实例。
    // IAM Identity Center 每个账户只有一个实例，绑定在创建时选定的区域，不能跨区使用；
    // 而登录填的区域正是用来拼 oidc.<region>.amazonaws.com 的，填错就必然 400。
    if (/invalid_request/i.test(text)) {
      if (issuerUrl !== KIRO_START_URL) {
        throw new Error(
          `在 ${region} 没有找到该 Start URL 对应的 IAM Identity Center 实例。` +
            'IdC 实例只存在于创建时选定的那一个区域，请改用目录所在区域后重试' +
            '（该区域与之后使用哪个区域的 Kiro 服务无关）。'
        )
      }
      throw new Error(`注册 OIDC 客户端失败：${region} 拒绝了该请求，请确认所选区域是否正确。`)
    }
    throw new Error(`注册 OIDC 客户端失败：${text.slice(0, 200)}`)
  }
  return res.json<{ clientId: string; clientSecret: string }>()
}

// ============ Builder ID：设备码流程 ============

export async function startBuilderIdLogin(
  region = DEFAULT_REGION,
  privateMode?: boolean
): Promise<BuilderIdStartInfo> {
  cancelLogin()
  const { clientId, clientSecret } = await registerOidcClient(
    region,
    ['urn:ietf:params:oauth:grant-type:device_code', 'refresh_token'],
    KIRO_START_URL
  )

  const res = await postJson(`${oidcEndpoint(region)}/device_authorization`, {
    clientId,
    clientSecret,
    startUrl: KIRO_START_URL
  })
  if (!res.ok) throw new Error(`设备授权失败：${(await res.text()).slice(0, 200)}`)

  const data = await res.json<{
    deviceCode: string
    userCode: string
    verificationUri: string
    verificationUriComplete?: string
    interval?: number
    expiresIn?: number
  }>()

  const interval = data.interval ?? 5
  const expiresIn = data.expiresIn ?? 600

  session = {
    kind: 'builderId',
    clientId,
    clientSecret,
    deviceCode: data.deviceCode,
    region,
    expiresAt: Date.now() + expiresIn * 1000
  }

  const verificationUri = data.verificationUriComplete || data.verificationUri
  const opened = await openUrl(verificationUri, privateMode)

  return {
    userCode: data.userCode,
    verificationUri,
    interval,
    expiresIn,
    privateMode: opened.privateMode,
    browser: opened.browser
  }
}

export async function pollBuilderIdLogin(): Promise<LoginPollResult> {
  if (session?.kind !== 'builderId') throw new Error('没有进行中的 Builder ID 登录')
  if (expired()) {
    cancelLogin()
    throw new Error('授权已超时，请重新开始')
  }

  const { clientId, clientSecret, deviceCode, region } = session
  const res = await postJson(`${oidcEndpoint(region)}/token`, {
    clientId,
    clientSecret,
    grantType: 'urn:ietf:params:oauth:grant-type:device_code',
    deviceCode
  })

  if (res.status === 200) {
    const data = await res.json<{ accessToken: string; refreshToken: string; expiresIn?: number }>()
    cancelLogin()
    return {
      completed: true,
      credentials: {
        accessToken: data.accessToken,
        refreshToken: data.refreshToken,
        clientId,
        clientSecret,
        region,
        expiresIn: data.expiresIn ?? DEFAULT_EXPIRES_IN,
        authMethod: 'IdC',
        provider: 'BuilderId'
      }
    }
  }

  if (res.status === 400) {
    const { error } = await res.json<{ error?: string }>()
    if (error === 'authorization_pending') return { completed: false }
    // 放慢轮询由渲染进程按 slowDown 标记处理
    if (error === 'slow_down') return { completed: false, slowDown: true }
    cancelLogin()
    if (error === 'expired_token') throw new Error('设备码已过期，请重新开始')
    if (error === 'access_denied') throw new Error('用户拒绝了授权')
    throw new Error(`授权失败：${error}`)
  }

  throw new Error(`未预期的响应状态：${res.status}`)
}

// ============ Google / GitHub：社交登录 ============

export async function startSocialLogin(
  provider: 'Google' | 'Github',
  privateMode?: boolean
): Promise<BrowserOpenInfo & { loginUrl: string }> {
  cancelLogin()

  const codeVerifier = crypto.randomBytes(64).toString('base64url').slice(0, 128)
  const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url')
  const state = crypto.randomBytes(32).toString('base64url')

  const loginUrl = new URL(`${KIRO_AUTH_BASE}/login`)
  loginUrl.searchParams.set('idp', provider)
  loginUrl.searchParams.set('redirect_uri', SOCIAL_REDIRECT_URI)
  loginUrl.searchParams.set('code_challenge', codeChallenge)
  loginUrl.searchParams.set('code_challenge_method', 'S256')
  loginUrl.searchParams.set('state', state)

  session = {
    kind: 'social',
    provider,
    codeVerifier,
    state,
    expiresAt: Date.now() + LOGIN_TTL_MS
  }

  /*
   * 抢不到 kiro:// 就别让用户白走一趟：授权会成功，但回调会被别的应用接走，
   * 本应用永远等不到 code，用户只会看到「浏览器授权完了，然后打开了别的应用」。
   * 这里先强制把默认处理者抢回本应用；仍抢不到（通常是开发模式未声明该协议）就提前拦下并说明原因。
   */
  if (!registerProtocol()) {
    cancelLogin()
    throw new Error(
      '无法接管 kiro:// 回调协议，社交登录的回调会被其它应用接走。' +
        '这通常发生在开发模式下（Electron 未声明该协议）；' +
        '请使用正式安装的版本，或改用 Builder ID / 企业版登录。'
    )
  }
  const url = loginUrl.toString()
  const opened = await openUrl(url, privateMode)
  return { loginUrl: url, privateMode: opened.privateMode, browser: opened.browser }
}

export async function completeSocialLogin(
  code: string,
  state: string
): Promise<OnlineLoginCredentials> {
  if (session?.kind !== 'social') throw new Error('没有进行中的社交登录')
  if (state !== session.state) {
    cancelLogin()
    throw new Error('state 参数不匹配，已中止登录')
  }

  const { codeVerifier, provider } = session
  const res = await postJson(`${KIRO_AUTH_BASE}/oauth/token`, {
    code,
    code_verifier: codeVerifier,
    redirect_uri: SOCIAL_REDIRECT_URI
  })

  if (!res.ok) {
    const text = await res.text()
    cancelLogin()
    throw new Error(`Token 交换失败：${text.slice(0, 200)}`)
  }

  const data = await res.json<{
    accessToken: string
    refreshToken: string
    profileArn?: string
    expiresIn?: number
  }>()
  cancelLogin()

  return {
    accessToken: data.accessToken,
    refreshToken: data.refreshToken,
    profileArn: data.profileArn,
    region: DEFAULT_REGION,
    expiresIn: data.expiresIn ?? DEFAULT_EXPIRES_IN,
    authMethod: 'social',
    provider: provider as IdpType
  }
}

// ============ Enterprise：IAM Identity Center 授权码 + PKCE ============

async function pickPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = http.createServer()
    probe.listen(0, '127.0.0.1', () => {
      const addr = probe.address()
      if (addr && typeof addr === 'object') probe.close(() => resolve(addr.port))
      else probe.close(() => reject(new Error('无法分配本地回调端口')))
    })
    probe.on('error', reject)
  })
}

function callbackPage(title: string, detail: string, ok = true): string {
  const color = ok ? '#16a34a' : '#dc2626'
  const icon = ok
    ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="72" height="72"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>`
    : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="72" height="72"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · Kiro Manager Lite</title>
<style>
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;
    display: flex; align-items: center; justify-content: center;
    min-height: 100vh; background: #f5f6fa; color: #1f2329;
  }
  .card {
    display: flex; flex-direction: column; align-items: center;
    text-align: center; padding: 48px 40px; max-width: 440px;
  }
  .icon { color: ${color}; margin-bottom: 20px; line-height: 0; }
  h1 { font-size: 24px; margin: 0 0 10px; font-weight: 600; }
  p { margin: 0 0 28px; color: #6b7280; font-size: 15px; line-height: 1.6; }
  button {
    border: none; border-radius: 8px; padding: 10px 22px;
    background: #7c3aed; color: #fff; font-size: 14px; cursor: pointer;
    transition: opacity .15s ease;
  }
  button:hover { opacity: .88; }
  button:disabled { opacity: .6; cursor: default; }
  .hint { margin-top: 14px; font-size: 13px; color: #9ca3af; display: none; }
  .brand { margin-top: 32px; font-size: 13px; color: #9ca3af; letter-spacing: .3px; }
  @media (prefers-color-scheme: dark) {
    body { background: #101216; color: rgba(255,255,255,.9); }
    p { color: rgba(255,255,255,.55); }
    .hint, .brand { color: rgba(255,255,255,.4); }
  }
</style>
</head>
<body>
  <div class="card">
    <div class="icon">${icon}</div>
    <h1>${title}</h1>
    <p>${detail}</p>
    <button id="back" type="button">打开 Kiro Manager Lite</button>
    <div class="hint" id="hint">已唤起 Kiro Manager Lite，可以关闭此标签页了。</div>
    <div class="brand">Kiro Manager Lite</div>
  </div>
</body>
<script>
  var backBtn = document.getElementById('back')
  var hint = document.getElementById('hint')
  backBtn.addEventListener('click', function () {
    backBtn.disabled = true
    // 浏览器禁止脚本关闭非 window.open 打开的标签页，所以只负责唤起应用，
    // 关标签页交给用户。优先走本地回调服务，失败则回退到自定义协议。
    fetch('/focus', { method: 'POST', cache: 'no-store' })
      .catch(function () {
        window.location.href = 'kml://focus'
      })
      .then(function () {
        hint.style.display = 'block'
        backBtn.disabled = false
      })
  })
</script>
</html>`
}

export async function startEnterpriseLogin(
  startUrl: string,
  region = DEFAULT_REGION,
  privateMode?: boolean
): Promise<BrowserOpenInfo & { authorizeUrl: string; expiresIn: number }> {
  if (!/^https:\/\//i.test(startUrl)) throw new Error('SSO Start URL 必须以 https:// 开头')
  cancelLogin()

  const port = await pickPort()
  const redirectUri = `http://127.0.0.1:${port}/oauth/callback`

  const { clientId, clientSecret } = await registerOidcClient(
    region,
    ['authorization_code', 'refresh_token'],
    startUrl,
    [redirectUri]
  )

  const codeVerifier = crypto.randomBytes(32).toString('base64url')
  const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url')
  const state = crypto.randomUUID()

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '', `http://127.0.0.1:${port}`)

    // 回调页「返回应用」按钮：唤起主窗口。放在会话检查之前，
    // 这样登录流程结束后按钮依然可用。
    if (url.pathname === '/focus') {
      focusApp?.()
      res.writeHead(204)
      return res.end()
    }

    const current = session
    if (current?.kind !== 'enterprise') {
      res.writeHead(410)
      return res.end('Gone')
    }

    if (url.pathname !== '/oauth/callback') {
      res.writeHead(404)
      return res.end('Not Found')
    }

    const finish = (title: string, detail: string, ok = true): void => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(callbackPage(title, detail, ok))
    }

    const error = url.searchParams.get('error')
    if (error) {
      current.result = { success: false, error: `授权失败：${error}` }
      return finish('授权失败', '可以关闭此页面，回到应用查看详情。', false)
    }
    if (url.searchParams.get('state') !== state) {
      current.result = { success: false, error: 'state 参数不匹配，已中止登录' }
      return finish('授权失败', 'state 校验未通过，请回到应用重试。', false)
    }
    const code = url.searchParams.get('code')
    if (!code) {
      current.result = { success: false, error: '回调中没有授权码' }
      return finish('授权失败', '未收到授权码，请回到应用重试。', false)
    }

    finish('授权成功', '正在获取令牌，可以关闭此页面并返回 Kiro Manager Lite。')

    try {
      const tokenRes = await postJson(`${oidcEndpoint(region)}/token`, {
        clientId,
        clientSecret,
        grantType: 'authorization_code',
        redirectUri,
        code,
        codeVerifier
      })
      if (!tokenRes.ok) {
        current.result = {
          success: false,
          error: `获取 Token 失败：${(await tokenRes.text()).slice(0, 200)}`
        }
        return
      }
      const data = await tokenRes.json<{
        accessToken: string
        refreshToken: string
        expiresIn?: number
      }>()
      current.result = {
        success: true,
        credentials: {
          accessToken: data.accessToken,
          refreshToken: data.refreshToken,
          clientId,
          clientSecret,
          region,
          startUrl,
          expiresIn: data.expiresIn ?? DEFAULT_EXPIRES_IN,
          authMethod: 'IdC',
          provider: 'Enterprise'
        }
      }
    } catch (e) {
      current.result = {
        success: false,
        error: errorMessage(e, '获取 Token 失败')
      }
    }
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })

  session = {
    kind: 'enterprise',
    expiresAt: Date.now() + LOGIN_TTL_MS,
    server
  }

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scopes: KIRO_OIDC_SCOPES.join(','),
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256'
  })
  const authorizeUrl = `${oidcEndpoint(region)}/authorize?${params.toString()}`
  const opened = await openUrl(authorizeUrl, privateMode)

  return {
    authorizeUrl,
    expiresIn: LOGIN_TTL_MS / 1000,
    privateMode: opened.privateMode,
    browser: opened.browser
  }
}

export async function pollEnterpriseLogin(): Promise<LoginPollResult> {
  if (session?.kind !== 'enterprise') throw new Error('没有进行中的 Enterprise SSO 登录')
  if (expired()) {
    cancelLogin()
    throw new Error('授权已超时，请重新开始')
  }
  const result = session.result
  if (!result) return { completed: false }

  cancelLogin()
  if (!result.success || !result.credentials) throw new Error(result.error || '授权失败')
  return { completed: true, credentials: result.credentials }
}
