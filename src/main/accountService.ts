// 账户业务逻辑：凭证校验、状态/积分刷新、Token 刷新、切号
import {
  getUsageAndLimits,
  getUserInfo,
  isAuthScopeError,
  isBannedError,
  listAvailableProfiles,
  parseUsageResponse,
  refreshTokenByMethod,
  type TokenRefreshResult,
  type UsageResponse
} from './kiroApi'
import { errorMessage, isCredentialRejected } from '../shared/errors'
import {
  profileArnCandidates,
  readKiroAuthToken,
  resolveProfileArn,
  writeKiroAuthToken
} from './kiroAuth'
import { sleep } from './utils'
import { syncKiroCliAuth } from './kiroCliAuth'
import { DEFAULT_REGION } from '../shared/regions'
import type {
  Account,
  AccountSnapshot,
  AuthMethod,
  IdpType,
  RefreshTokenResult,
  SwitchAccountInput,
  SwitchAccountResult,
  VerifyCredentialsInput
} from '../shared/types'

/** 接口没给 expiresIn 时的兜底有效期（秒） */
const DEFAULT_EXPIRES_IN = 3600

/** 写盘用的过期时间：从当前时刻推 expiresIn 秒 */
function expiresAtIso(expiresIn: number): string {
  return new Date(Date.now() + expiresIn * 1000).toISOString()
}

/** 封禁错误带 isBanned 标记向上抛，IPC 层据此回传 banned 字段 */
function bannedError(message: string): Error & { isBanned?: boolean } {
  const error = new Error(message) as Error & { isBanned?: boolean }
  error.isBanned = true
  return error
}

/** 记录最近一次通过本应用切换到 IDE 的账号，用于判断"是否为 IDE 当前激活账号" */
let lastSwitchedAccountId: string | null = null

export function setLastSwitchedAccountId(id: string | null): void {
  lastSwitchedAccountId = id
}

/** 删除管理记录后同步清除运行时账号引用，避免后续续期误认已删除账号。 */
export function forgetSwitchedAccounts(ids: string[]): void {
  if (lastSwitchedAccountId && new Set(ids).has(lastSwitchedAccountId)) {
    lastSwitchedAccountId = null
  }
}

/** CBOR/REST 接口的 Idp 头取值 */
function resolveIdp(provider?: string, authMethod?: string, fallback?: string): string {
  if (authMethod === 'social') return provider || fallback || 'Google'
  return provider || fallback || 'BuilderId'
}

function inferAuthMethod(provider?: IdpType, explicit?: AuthMethod): AuthMethod {
  if (explicit) return explicit
  return provider === 'Github' || provider === 'Google' ? 'social' : 'IdC'
}

/**
 * 网络类错误（超时、连接重置、5xx）值得重试；
 * 授权类错误（401/403/scope）重试也是同样结果，不浪费时间。
 */
function isRetryableError(msg: string): boolean {
  if (isAuthScopeError(msg) || isBannedError(msg)) return false
  return /timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket|network|fetch failed|aborted|50\d/i.test(
    msg
  )
}



/** 刷新所需的凭证字段，各调用点的可选值在这里统一兜底 */
interface RefreshCredentials {
  refreshToken: string
  clientId?: string
  clientSecret?: string
  region?: string
  authMethod?: AuthMethod | string
}

/**
 * 校验刷新凭证是否齐全。
 * @param oidcError IdC 账号缺少 clientId / clientSecret 时的错误文案
 */
function assertRefreshCredentials(cred: RefreshCredentials, oidcError: string): void {
  if (!cred.refreshToken) throw new Error('缺少 Refresh Token')
  if (cred.authMethod !== 'social' && (!cred.clientId || !cred.clientSecret)) {
    throw new Error(oidcError)
  }
}

/** 用量接口所需的身份字段 */
interface UsageIdentity {
  profileArn?: string
  authMethod?: AuthMethod | string
  provider?: string
  region?: string
}

/**
 * 用量接口的 profileArn 候选，按成功率排序。
 *
 * 背景：profileArn 是必填，不带会被拒（用量 403、模型列表 400 Invalid profileArn）。
 * 但「补一个」不能瞎补——**Enterprise 必须用它自己 profile 的真实 ARN**，
 * kiroAuth 里那个硬编码兜底 ARN 属于另一个组织，送出去会被判 403 "Invalid token"。
 * 所以 Enterprise 先问一次 ListAvailableProfiles，拿到真实 ARN 再谈兜底。
 *
 * 其余登录方式没有 profile 概念，用固定 ARN 即可：
 * 社交 → 后端认的那个共享 social ARN；Builder ID → Kiro IDE 的硬编码占位符。
 */
async function usageArnCandidates(
  accessToken: string,
  input: UsageIdentity
): Promise<(string | undefined)[]> {
  const out: (string | undefined)[] = []
  const push = (arn?: string): void => {
    if (!out.includes(arn)) out.push(arn)
  }

  // 账号已存的 ARN 最可信：它要么来自上游，要么是切号时实测过的
  if (input.profileArn) push(input.profileArn)

  if (input.provider === 'Enterprise') {
    const [real] = await listAvailableProfiles(accessToken, input.region).catch(() => [])
    if (real) push(real)
  }

  push(
    resolveProfileArn({
      authMethod: input.authMethod,
      provider: input.provider,
      region: input.region
    })
  )
  // 末位兜底：后端当前要求必填，留着只为它哪天改回去时还有条路
  push(undefined)
  return out
}

/** ARN 不被接受的判据：授权维度的错误，或上游明确点名 profileArn */
function isArnRejection(msg: string): boolean {
  return isAuthScopeError(msg) || /profilearn/i.test(msg)
}

/**
 * 查询用量，profileArn 逐个候选试，并把真正生效的那个回传。
 *
 * 调用方应把返回的 profileArn 写进账号：下次就能一次命中，
 * Enterprise 也不用每轮都再问一遍 ListAvailableProfiles。
 */
async function queryUsage(
  accessToken: string,
  idp: string,
  input: UsageIdentity
): Promise<{ usage: UsageResponse; profileArn?: string }> {
  const candidates = await usageArnCandidates(accessToken, input)
  let lastError: unknown

  for (const candidate of candidates) {
    try {
      // 批量刷新时并发较高，网络抖动很常见，带上有限重试减少「刷新失败」
      const usage = await withRetry('查询用量', () =>
        getUsageAndLimits(accessToken, idp, candidate, input.region)
      )
      return { usage, profileArn: candidate }
    } catch (error) {
      lastError = error
      const msg = errorMessage(error)
      // 封禁与网络类错误换 ARN 也是同样结果，不浪费请求
      if (isBannedError(msg) || !isArnRejection(msg)) throw error
    }
  }
  throw lastError
}

/** 对易受网络波动影响的调用做有限重试，间隔递增 */
async function withRetry<T>(label: string, fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastError: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn()
    } catch (e) {
      lastError = e
      const msg = errorMessage(e)
      // 发起端显式标注过就以它为准，没标注才回落到按错误文案猜
      const retryable = (e as { retryable?: boolean }).retryable ?? isRetryableError(msg)
      if (i === attempts - 1 || !retryable) break
      console.warn(`[AccountService] ${label} 第 ${i + 1} 次失败，准备重试：${msg}`)
      // 退避带抖动：批量刷新时多个通道往往同时失败，固定间隔会让它们再次撞在一起
      await sleep(600 * (i + 1) + Math.floor(Math.random() * 300))
    }
  }
  throw lastError
}

/** 发起一次 token 刷新，补齐可选参数的兜底值 */
function refreshWithCredentials(cred: RefreshCredentials): Promise<TokenRefreshResult> {
  return refreshTokenByMethod(
    cred.refreshToken,
    cred.clientId || '',
    cred.clientSecret || '',
    cred.region || DEFAULT_REGION,
    cred.authMethod
  )
}

/**
 * 带重试的 token 刷新，失败抛错。
 * @param fallbackError 接口没给出失败原因时的兜底文案
 */
async function refreshWithRetry(
  label: string,
  cred: RefreshCredentials,
  fallbackError: string
): Promise<TokenRefreshResult & { accessToken: string }> {
  return withRetry(label, async () => {
    const res = await refreshWithCredentials(cred)
    if (!res.success || !res.accessToken) {
      /*
       * 把发起端按状态码得出的可重试结论挂到 Error 上带给 withRetry。
       * 刷新端点的 403 是限流，而用量接口的 403 是确定性失败，光看错误文案分不开，
       * 只能由知道自己在调哪个接口的那一层来标注。
       */
      const error = new Error(res.error || fallbackError) as Error & { retryable?: boolean }
      error.retryable = res.retryable
      throw error
    }
    // 收窄类型：上面已确保 accessToken 一定存在
    return { ...res, accessToken: res.accessToken }
  })
}

// ============ 校验凭证（添加账号用）============

export async function verifyCredentials(input: VerifyCredentialsInput): Promise<AccountSnapshot> {
  const { refreshToken, clientId = '', clientSecret = '', region = DEFAULT_REGION } = input
  const provider = input.provider || 'BuilderId'
  const authMethod = inferAuthMethod(provider, input.authMethod)
  const cred = { refreshToken, clientId, clientSecret, region, authMethod }

  assertRefreshCredentials(cred, 'IdC 账号需要同时提供 Client ID 与 Client Secret')

  const refreshed = await refreshWithCredentials(cred)
  if (!refreshed.success || !refreshed.accessToken) {
    throw new Error(`Token 刷新失败：${refreshed.error || '未知错误'}`)
  }

  const idp = resolveIdp(provider, authMethod)
  /*
   * 用量接口必须带 profileArn，不带会让 Builder ID 验活直接 403。
   * 走候选回退而不是单个猜测：Enterprise 补错 ARN 会被判 403 "Invalid token"。
   * 生效的那个随快照返回，账号建好后就带着正确的 ARN，后续不必重新试。
   */
  const { usage, profileArn } = await queryUsage(refreshed.accessToken, idp, {
    profileArn: input.profileArn,
    authMethod,
    provider,
    region
  })
  const parsed = parseUsageResponse(usage)

  return {
    email: parsed.email || '',
    userId: parsed.userId,
    idp,
    profileArn,
    accessToken: refreshed.accessToken,
    refreshToken: refreshed.refreshToken || refreshToken,
    expiresIn: refreshed.expiresIn ?? DEFAULT_EXPIRES_IN,
    subscription: parsed.subscription,
    usage: parsed.usage
  }
}

// ============ 刷新状态 / 积分 ============

/**
 * 查询账号最新的订阅、用量与积分。
 * accessToken 过期（401）时会用 refreshToken 自动续一次并重试。
 */
export async function checkAccountStatus(account: Account): Promise<AccountSnapshot> {
  const { accessToken, refreshToken, clientId, clientSecret, region, authMethod, provider } =
    account.credentials
  const idp = resolveIdp(provider, authMethod, account.idp)

  if (!accessToken && !refreshToken) throw new Error('账号缺少凭证')

  const query = async (token: string): Promise<AccountSnapshot> => {
    const [userInfo, usage] = await Promise.all([
      getUserInfo(token, idp).catch((err: Error) => {
        // 封禁错误必须向上抛，其它错误容忍（CBOR 门户对 IdC 常返回 401）
        if (isBannedError(err.message)) throw err
        return undefined
      }),
      // profileArn 逐个候选试：必填但不能瞎补，Enterprise 补错会被判 Invalid token
      queryUsage(token, idp, {
        profileArn: account.profileArn || account.credentials.profileArn,
        authMethod,
        provider: provider || account.idp,
        region
      })
    ])
    const parsed = parseUsageResponse(usage.usage)
    return {
      email: parsed.email || userInfo?.email || account.email,
      userId: parsed.userId || userInfo?.userId,
      idp: userInfo?.idp || idp,
      // 回传生效的 ARN，让账号记住它，下轮一次命中
      profileArn: usage.profileArn,
      subscription: parsed.subscription,
      usage: parsed.usage
    }
  }

  try {
    if (!accessToken) throw new Error('HTTP 401: missing access token')
    return await query(accessToken)
  } catch (error) {
    const msg = errorMessage(error)
    if (isBannedError(msg)) throw bannedError(msg)

    const canRefresh = !!refreshToken && (authMethod === 'social' || (!!clientId && !!clientSecret))
    if (!msg.includes('401') || !canRefresh) throw error

    const refreshed = await refreshWithCredentials({
      refreshToken,
      clientId,
      clientSecret,
      region,
      authMethod
    })
    if (!refreshed.success || !refreshed.accessToken) {
      throw new Error(`Token 过期且刷新失败：${refreshed.error || '未知错误'}`)
    }

    const snapshot = await query(refreshed.accessToken)
    return {
      ...snapshot,
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
      expiresIn: refreshed.expiresIn ?? DEFAULT_EXPIRES_IN
    }
  }
}

// ============ 刷新 Token ============

/**
 * 刷新账号 accessToken。
 * 仅当该账号确实是 Kiro IDE 当前激活账号时才回写磁盘 token 文件，
 * 否则会把 IDE 正在用的账号覆盖掉。
 */
/**
 * 轮换出新凭证后，若该账号确实是 IDE 当前激活账号，就把新凭证写进 IDE 的 token 文件。
 *
 * refreshToken 是轮换式的：任何一次刷新都会让旧值作废。只要新凭证没同步给 IDE，
 * IDE 手里那份就成了废票，之后它自己刷新会被登出，本应用的主动续期也会因为
 * 「磁盘 refreshToken 对不上」而判定不是激活账号并停止调度。
 *
 * @param previousRefreshToken 轮换前的 refreshToken，用来和磁盘上的值比对身份
 */
export async function syncCredentialsToIde(
  account: Account,
  next: { accessToken: string; refreshToken: string; expiresIn: number },
  previousRefreshToken: string
): Promise<{ syncedToIde: boolean; syncSkipReason?: string }> {
  const { clientId, clientSecret, region, authMethod, provider, startUrl } = account.credentials
  try {
    const disk = await readKiroAuthToken()
    // 磁盘上可能已经是轮换后的新值（本次刷新已写过盘），两者都算同一个账号
    const matchByRefresh =
      !!disk && (disk.refreshToken === previousRefreshToken || disk.refreshToken === next.refreshToken)
    const matchBySwitch = lastSwitchedAccountId === account.id
    if (!matchByRefresh && !matchBySwitch) {
      return {
        syncedToIde: false,
        syncSkipReason: disk
          ? '该账号不是 Kiro IDE 当前激活账号，已跳过磁盘同步'
          : '本地未找到 kiro-auth-token.json（IDE 未登录），已跳过磁盘同步'
      }
    }

    const expiresAt = expiresAtIso(next.expiresIn)
    await writeKiroAuthToken({
      accessToken: next.accessToken,
      refreshToken: next.refreshToken,
      expiresAtIso: expiresAt,
      authMethod: authMethod === 'social' ? 'social' : 'IdC',
      provider: provider || (disk?.provider as IdpType) || account.idp || 'BuilderId',
      region: region || disk?.region,
      startUrl,
      clientId,
      clientSecret,
      /*
       * 优先沿用磁盘上已有的 profileArn：切号时那个值是逐个实测过的，
       * 这里再走一遍 resolveProfileArn 会把它覆盖成占位符，
       * IDE 下一次调用用量接口就可能变成 Invalid token。
       */
      profileArn:
        account.profileArn ||
        account.credentials.profileArn ||
        disk?.profileArn ||
        (authMethod === 'social'
          ? resolveProfileArn({ authMethod, provider: provider || account.idp, region })
          : undefined)
    })
    // The IDE and CLI hold independent copies of the rotated refresh token.
    // Update the CLI only when its current token still belongs to this account.
    const cliSync = await syncKiroCliAuth({
      accessToken: next.accessToken,
      refreshToken: next.refreshToken,
      expiresAtIso: expiresAt,
      authMethod: authMethod === 'social' ? 'social' : 'IdC',
      provider: provider || account.idp || 'BuilderId',
      region: region || DEFAULT_REGION,
      profileArn: account.profileArn || account.credentials.profileArn || disk?.profileArn,
      clientId,
      clientSecret
    }, previousRefreshToken)
    if (!cliSync.synced) console.warn(`[AccountService] CLI 续期同步跳过：${cliSync.error}`)
    lastSwitchedAccountId = account.id
    return { syncedToIde: true }
  } catch (e) {
    return { syncedToIde: false, syncSkipReason: `磁盘同步失败：${errorMessage(e)}` }
  }
}

/**
 * 磁盘上可能存着比内存更新的 refreshToken：Kiro IDE 自己的 refresh loop 抢先轮换过时，
 * 应用内存里那一份已经是废票，直接重试还是 Bad credentials。
 *
 * 只有能确认「该账号就是 IDE 当前登录账号」时才允许拿磁盘凭证，否则会用别人的
 * refreshToken 去刷新，既把那个账号的凭证换废，又把结果错记到当前账号上。
 */
async function diskRefreshTokenFor(account: Account, usedToken: string): Promise<string | null> {
  const ownsIde = lastSwitchedAccountId === account.id || account.isActive === true
  if (!ownsIde) return null

  const disk = await readKiroAuthToken().catch(() => null)
  const diskToken = disk?.refreshToken
  // 磁盘上还是刚才那一份，说明作废与 IDE 无关，换它重试没有意义
  if (!diskToken || diskToken === usedToken) return null

  // 登录方式与 provider 对不上时，磁盘上那份属于另一个账号。
  // social 的判定口径与 readLocalKiroCredentials 保持一致：只有显式 social 才算社交登录
  if ((disk?.authMethod === 'social') !== (account.credentials.authMethod === 'social')) return null
  const accountProvider = account.credentials.provider || account.idp
  if (disk?.provider && accountProvider && disk.provider !== accountProvider) return null

  return diskToken
}

async function performRefreshAccountToken(account: Account): Promise<RefreshTokenResult> {
  const { refreshToken, clientId, clientSecret, region, authMethod } = account.credentials

  const cred = { refreshToken, clientId, clientSecret, region, authMethod }
  assertRefreshCredentials(cred, '缺少 OIDC 刷新凭证（clientId / clientSecret）')

  // 网络类失败重试几次；invalid_grant 之类的凭证问题不重试，避免白等
  let usedRefreshToken = refreshToken
  let result: TokenRefreshResult & { accessToken: string }
  try {
    result = await refreshWithRetry('刷新 Token', cred, 'Token 刷新失败')
  } catch (error) {
    const message = errorMessage(error)
    const fallback = isCredentialRejected(message)
      ? await diskRefreshTokenFor(account, refreshToken)
      : null
    // 拿不到更新的凭证就把原始错误抛出去，交给界面提示重新登录
    if (!fallback) throw error

    console.warn('[AccountService] 内存中的 refreshToken 已作废，改用 Kiro IDE 磁盘上的最新凭证重试')
    usedRefreshToken = fallback
    result = await refreshWithRetry(
      '用磁盘凭证刷新 Token',
      { ...cred, refreshToken: fallback },
      'Token 刷新失败'
    )
  }

  const accessToken = result.accessToken
  const newRefreshToken = result.refreshToken || usedRefreshToken
  const expiresIn = result.expiresIn ?? DEFAULT_EXPIRES_IN

  const { syncedToIde, syncSkipReason } = await syncCredentialsToIde(
    account,
    { accessToken, refreshToken: newRefreshToken, expiresIn },
    // 身份比对要用本次实际送出去的那一份，兜底重试后它才是磁盘上的旧值
    usedRefreshToken
  )

  return { accessToken, refreshToken: newRefreshToken, expiresIn, syncedToIde, syncSkipReason }
}

/**
 * 同一账号的刷新去重：手动刷新、自动刷新、主动续期可能几乎同时命中同一个账号，
 * 各自带着同一份旧 refreshToken 发请求，先到的成功并轮换，后到的必然 401。
 * 这里让并发调用复用同一个 in-flight 结果。
 */
const refreshInFlight = new Map<string, Promise<RefreshTokenResult>>()

export function refreshAccountToken(account: Account): Promise<RefreshTokenResult> {
  const running = refreshInFlight.get(account.id)
  if (running) return running

  const task = performRefreshAccountToken(account).finally(() => {
    refreshInFlight.delete(account.id)
  })
  refreshInFlight.set(account.id, task)
  return task
}

// ============ 切号 ============

/**
 * 把账号写入 Kiro IDE 的凭证文件。
 *
 * 关键点：
 *  1. 写盘前强制 refresh：OIDC 的 refreshToken 是轮换式的，只更新 accessToken 的话
 *     IDE 一小时后会拿作废的旧 refreshToken 去刷新并被强制登出。refresh 失败直接中止。
 *  2. profileArn 逐个试：写错 ARN 是 IDE 报 “Unable to fetch account usage data:
 *     Invalid token / User is not authorized” 的主因。Enterprise 要用自己 profile 的
 *     真实 ARN，BuilderId 则不该带 ARN。这里先实测再落盘。
 *  3. 清理陈旧客户端注册文件：上一个账号留下的 {hash}.json 会让 IDE 用错
 *     clientId/secret 去刷新，失败后同样把用户登出。
 *  4. 写完再用同一个 accessToken 实测一次用量接口，把结论回传界面，
 *     而不是「写完就算成功」。
 */
export async function switchAccount(input: SwitchAccountInput): Promise<SwitchAccountResult> {
  const {
    refreshToken,
    clientId = '',
    clientSecret = '',
    region = DEFAULT_REGION,
    startUrl,
    provider = 'BuilderId',
    profileArn
  } = input
  const authMethod = inferAuthMethod(provider, input.authMethod)
  const idp = resolveIdp(provider, authMethod)
  const notes: string[] = []

  let accessToken = input.accessToken
  let finalRefreshToken = refreshToken
  let expiresIn = DEFAULT_EXPIRES_IN

  if (refreshToken) {
    /*
     * refresh 是切号的必要前置，网络抖动导致的失败重试几次通常就能过；
     * 但要注意 refreshToken 是轮换式的：一旦服务端已经受理并轮换，
     * 重试用的还是旧 token 就会拿到 invalid_grant，这类错误不重试。
     */
    const refreshed = await refreshWithRetry(
      '切号前刷新 Token',
      { refreshToken, clientId, clientSecret, region, authMethod },
      '未知错误'
    )
      .then((r) => ({ ok: true as const, value: r }))
      .catch((e) => ({ ok: false as const, error: errorMessage(e) }))

    if (!refreshed.ok) {
      throw new Error(
        `刷新 Token 失败，已中止切换以避免 Kiro IDE 被强制登出。原因：${refreshed.error || '未知错误'}`
      )
    }
    accessToken = refreshed.value.accessToken
    finalRefreshToken = refreshed.value.refreshToken || refreshToken
    expiresIn = refreshed.value.expiresIn ?? DEFAULT_EXPIRES_IN
  }

  // Enterprise 账号先问一次真实 profile，拿到就不用猜了
  let knownArn = profileArn
  if (provider === 'Enterprise' && !knownArn) {
    const [firstArn] = await listAvailableProfiles(accessToken, region).catch(() => [])
    if (firstArn) {
      knownArn = firstArn
      notes.push(`已获取企业账号的真实 profileArn：${firstArn}`)
    }
  }

  // 逐个候选做实测，第一个能调通用量接口的就是要写盘的那个
  const candidates = profileArnCandidates({ profileArn: knownArn, authMethod, provider, region })
  /*
   * 用对象而不是裸字符串记录结果：候选里的 undefined 表示「确定不写 ARN」，
   * 和「还没测出可用候选」是两种含义，混在一起会把实测通过的「不写」
   * 又覆盖成占位符 ARN，IDE 下一次调用用量接口就报 Invalid token。
   */
  let chosen: { arn?: string } | null = null
  let verifyError: string | undefined

  for (const candidate of candidates) {
    try {
      /*
       * 候选原样送，不要过 arnForApiCall：用量接口要求带 profileArn，
       * 把 BuilderId 占位符剥成 undefined 会让第一个候选必然 403，
       * 于是每次切号都报「profileArn 校验未通过」。
       */
      await withRetry('校验 profileArn', () =>
        getUsageAndLimits(accessToken, idp, candidate, region)
      )
      chosen = { arn: candidate }
      verifyError = undefined
      break
    } catch (error) {
      const msg = errorMessage(error)
      verifyError = msg || '用量接口没有返回可识别的结果'
      if (isBannedError(msg)) throw bannedError(msg)
      // 只有授权维度的错误才值得换 ARN 再试，网络问题换了也一样
      if (!isAuthScopeError(msg)) break
      notes.push(`profileArn ${candidate ?? '(不写)'} 校验失败，换下一个候选`)
    }
  }

  const verified = chosen !== null
  // 全部候选都没通过时仍然写盘：多数情况是网络波动，IDE 自己也会重试
  const arnToWrite = verified
    ? chosen?.arn
    : resolveProfileArn({ profileArn: knownArn, authMethod, provider, region })
  if (!verified) {
    notes.push(`未能实测通过，按默认规则写入 profileArn：${arnToWrite ?? '(不写)'}`)
  }

  const expiresAt = expiresAtIso(expiresIn)
  const { tokenPath, clientRegPath, prunedRegistrations } = await writeKiroAuthToken({
    accessToken,
    refreshToken: finalRefreshToken,
    expiresAtIso: expiresAt,
    authMethod,
    provider,
    region,
    startUrl,
    clientId,
    clientSecret,
    profileArn: arnToWrite,
    pruneStaleRegistrations: true
  })
  if (prunedRegistrations) {
    notes.push(`清理了 ${prunedRegistrations} 个陈旧的客户端注册文件`)
  }

  const cliSync = await syncKiroCliAuth({
    accessToken,
    refreshToken: finalRefreshToken,
    expiresAtIso: expiresAt,
    authMethod,
    provider,
    region,
    profileArn: arnToWrite,
    clientId,
    clientSecret
  })

  lastSwitchedAccountId = input.accountId
  return {
    accessToken,
    refreshToken: finalRefreshToken,
    expiresIn,
    tokenPath,
    clientRegPath,
    profileArn: arnToWrite,
    verified,
    cliSync,
    verifyError: verified ? undefined : verifyError || '用量接口没有返回可识别的结果',
    notes
  }
}
