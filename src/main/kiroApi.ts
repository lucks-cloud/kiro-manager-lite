// Kiro / AWS 接口封装：token 刷新、用户信息、用量与积分
import { encode, decode } from 'cbor-x'
import { errorMessage } from '../shared/errors'
import {
  AWS_SINGLE_ATTEMPT_HEADERS,
  KIRO_AUTH_BASE,
  KIRO_PORTAL_BASE,
  awsInvocationId,
  codeWhispererEndpoint,
  kiroAmzUserAgent,
  kiroUserAgent,
  oidcEndpoint,
  qEndpoint,
  qFallbackEndpoint
} from './kiroEndpoints'
import { httpRequest } from './net'
import { DEFAULT_REGION } from '../shared/regions'
import { normalizeSubscriptionType } from '../shared/subscription'
import type {
  AccountSubscription,
  AccountUsage,
  AuthMethod,
  BonusUsage
} from '../shared/types'

// 用量接口类型：rest = 官方 GetUsageLimits，cbor = 网页门户 GetUserUsageAndLimits
let usageApiType: 'rest' | 'cbor' = 'rest'
export function setUsageApiType(type: 'rest' | 'cbor'): void {
  usageApiType = type
}

// ============ Token 刷新 ============

export interface TokenRefreshResult {
  success: boolean
  accessToken?: string
  refreshToken?: string
  expiresIn?: number
  error?: string
  /**
   * 该次失败是否值得重试。由发起端按状态码判定，避免下游只能从错误文案里猜。
   * 同一句 403 在不同接口上含义相反（见 isRetryableRefreshStatus），靠文案分类必然出错。
   */
  retryable?: boolean
}

/**
 * 刷新端点上值得重试的状态码：只认标准的临时故障。
 *
 * 不含 403/401：这两条在刷新端点上意味着凭证真的被拒（AWS OIDC 回 400 invalid_grant，
 * Kiro auth service 回 401 Bad credentials），重试只会得到同样结果。
 */
function isRetryableRefreshStatus(status: number): boolean {
  if (status === 408 || status === 425 || status === 429) return true
  return status >= 500
}

/**
 * 两条刷新链路只有端点、附加请求头和 body 不同，响应解析完全一致。
 * 接口没返回新的 refreshToken 时沿用旧的。
 */
async function postTokenRefresh(
  url: string,
  body: Record<string, string>,
  extraHeaders?: Record<string, string>
): Promise<TokenRefreshResult> {
  try {
    const res = await httpRequest(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...extraHeaders },
      body: JSON.stringify(body)
    })
    if (!res.ok) {
      return {
        success: false,
        error: `HTTP ${res.status}: ${await res.text()}`,
        retryable: isRetryableRefreshStatus(res.status)
      }
    }
    const data = await res.json<{ accessToken: string; refreshToken?: string; expiresIn?: number }>()
    return {
      success: true,
      accessToken: data.accessToken,
      refreshToken: data.refreshToken || body.refreshToken,
      expiresIn: data.expiresIn
    }
  } catch (error) {
    return { success: false, error: errorMessage(error) }
  }
}

/** IdC / BuilderId：走 AWS OIDC */
function refreshOidcToken(
  refreshToken: string,
  clientId: string,
  clientSecret: string,
  region = DEFAULT_REGION
): Promise<TokenRefreshResult> {
  return postTokenRefresh(`${oidcEndpoint(region)}/token`, {
    clientId,
    clientSecret,
    refreshToken,
    grantType: 'refresh_token'
  })
}

/** Github / Google：走 Kiro 自己的 auth service */
function refreshSocialToken(refreshToken: string): Promise<TokenRefreshResult> {
  return postTokenRefresh(
    `${KIRO_AUTH_BASE}/refreshToken`,
    { refreshToken },
    { 'User-Agent': kiroUserAgent() }
  )
}

export async function refreshTokenByMethod(
  refreshToken: string,
  clientId = '',
  clientSecret = '',
  region = DEFAULT_REGION,
  authMethod?: AuthMethod | string
): Promise<TokenRefreshResult> {
  if (authMethod === 'social') return refreshSocialToken(refreshToken)
  return refreshOidcToken(refreshToken, clientId, clientSecret, region)
}

// ============ CBOR 门户接口 ============

async function cborRequest<T>(
  operation: string,
  body: Record<string, unknown>,
  accessToken: string,
  idp = 'BuilderId'
): Promise<T> {
  const res = await httpRequest(`${KIRO_PORTAL_BASE}/${operation}`, {
    method: 'POST',
    headers: {
      accept: 'application/cbor',
      'content-type': 'application/cbor',
      'smithy-protocol': 'rpc-v2-cbor',
      'amz-sdk-invocation-id': awsInvocationId(),
      ...AWS_SINGLE_ATTEMPT_HEADERS,
      'x-amz-user-agent': kiroAmzUserAgent(),
      authorization: `Bearer ${accessToken}`,
      cookie: `Idp=${idp}; AccessToken=${accessToken}`
    },
    body: Buffer.from(encode(body))
  })

  const buffer = Buffer.from(await res.arrayBuffer())
  // 只记操作名与状态码，绝不记 token / 响应体，避免日志泄露凭证
  console.debug(`[KiroApi] CBOR ${operation} ${idp} → ${res.status}`)
  if (!res.ok) {
    let message = `HTTP ${res.status}`
    try {
      const err = decode(buffer) as { __type?: string; message?: string }
      const type = err.__type?.split('#').pop()
      message = `HTTP ${res.status}: ${[type, err.message].filter(Boolean).join(': ')}`
    } catch {
      const text = buffer.toString('utf-8')
      if (text) message = `HTTP ${res.status}: ${text.slice(0, 200)}`
    }
    throw new Error(message)
  }
  return decode(buffer) as T
}

export interface UserInfoResponse {
  email?: string
  userId?: string
  idp?: string
  status?: string
}

export function getUserInfo(accessToken: string, idp = 'BuilderId'): Promise<UserInfoResponse> {
  return cborRequest<UserInfoResponse>('GetUserInfo', { origin: 'KIRO_IDE' }, accessToken, idp)
}

// ============ 用量 / 积分 ============

interface RawFreeTrial {
  currentUsage?: number
  currentUsageWithPrecision?: number
  usageLimit?: number
  usageLimitWithPrecision?: number
  freeTrialStatus?: string
  freeTrialExpiry?: number | string
}

interface RawBonus {
  bonusCode?: string
  displayName?: string
  currentUsage?: number
  currentUsageWithPrecision?: number
  usageLimit?: number
  usageLimitWithPrecision?: number
  expiresAt?: number | string
  status?: string
}

interface RawBreakdown {
  type?: string
  resourceType?: string
  displayName?: string
  displayNamePlural?: string
  currentUsage?: number
  currentUsageWithPrecision?: number
  usageLimit?: number
  usageLimitWithPrecision?: number
  currency?: string
  unit?: string
  overageRate?: number
  overageCap?: number
  freeTrialInfo?: RawFreeTrial
  freeTrialUsage?: RawFreeTrial
  bonuses?: RawBonus[]
}

export interface UsageResponse {
  usageBreakdownList?: RawBreakdown[]
  nextDateReset?: number | string
  subscriptionInfo?: {
    subscriptionTitle?: string
    subscriptionType?: string
    type?: string
    status?: string
  }
  overageConfiguration?: { overageEnabled?: boolean; overageStatus?: string }
  overageSettings?: { overageStatus?: string }
  userInfo?: { email?: string; userId?: string }
}

/** 时间字段归一成 ISO 串：数字一律按秒级 Unix 时间戳处理，字符串原样透传 */
function toIso(value: number | string | undefined): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'number') return new Date(value * 1000).toISOString()
  return value
}

/** REST 接口通用的 Bearer 认证头 */
function bearerHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    'User-Agent': kiroUserAgent(),
    'x-amz-user-agent': kiroAmzUserAgent()
  }
}

async function restGetUsageLimits(
  accessToken: string,
  profileArn?: string,
  region?: string
): Promise<UsageResponse> {
  const params = new URLSearchParams({
    origin: 'AI_EDITOR',
    resourceType: 'AGENTIC_REQUEST',
    isEmailRequired: 'true'
  })
  if (profileArn) params.set('profileArn', profileArn)
  const path = `/getUsageLimits?${params.toString()}`
  const headers = { Accept: 'application/json', ...bearerHeaders(accessToken) }

  let res = await httpRequest(`${qEndpoint(region)}${path}`, { headers })
  // 主端点 403 时换另一个区域端点再试
  if (res.status === 403) {
    console.warn(`[KiroApi] REST getUsageLimits 主端点 403，改用备用端点 ${qFallbackEndpoint(region)}`)
    res = await httpRequest(`${qFallbackEndpoint(region)}${path}`, { headers })
  }
  if (!res.ok) {
    const body = (await res.text()).slice(0, 300)
    console.warn(`[KiroApi] REST getUsageLimits → ${res.status}: ${body}`)
    throw new Error(`HTTP ${res.status}: ${body}`)
  }
  console.debug(`[KiroApi] REST getUsageLimits → ${res.status}`)
  return res.json<UsageResponse>()
}

export async function getUsageAndLimits(
  accessToken: string,
  idp = 'BuilderId',
  profileArn?: string,
  region?: string
): Promise<UsageResponse> {
  if (usageApiType === 'rest') {
    return restGetUsageLimits(accessToken, profileArn, region)
  }
  try {
    return await cborRequest<UsageResponse>(
      'GetUserUsageAndLimits',
      { isEmailRequired: true, origin: 'KIRO_IDE' },
      accessToken,
      idp
    )
  } catch (error) {
    const msg = errorMessage(error)
    // CBOR 门户仅支持 BuilderId，Enterprise/IdC 会 401/403，回退 REST
    if (msg.includes('401') || msg.includes('403')) {
      return restGetUsageLimits(accessToken, profileArn, region)
    }
    throw error
  }
}

/**
 * 列出账号可用的 profile（仅 Enterprise / IdC 有意义）。
 * BuilderId 与社交账号没有 profile 概念，接口会返回 403，这里统一当作「没有」。
 */
export async function listAvailableProfiles(accessToken: string, region?: string): Promise<string[]> {
  try {
    const res = await httpRequest(`${codeWhispererEndpoint(region)}/ListAvailableProfiles`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...bearerHeaders(accessToken),
        'amz-sdk-invocation-id': awsInvocationId(),
        ...AWS_SINGLE_ATTEMPT_HEADERS
      },
      body: JSON.stringify({})
    })
    if (!res.ok) return []
    const data = await res.json<{ profiles?: { arn?: string }[] }>()
    return (data.profiles ?? []).map((p) => p.arn).filter((arn): arn is string => !!arn)
  } catch {
    return []
  }
}

/**
 * 判断错误是否属于「token / 授权维度不匹配」。
 * profileArn 写错时接口回的就是 403 User is not authorized 或 invalid bearer token，
 * 这类错误换一个 profileArn 重试有意义；网络错误则没有。
 */
export function isAuthScopeError(message: string): boolean {
  const m = message.toLowerCase()
  return (
    m.includes('403') ||
    m.includes('401') ||
    m.includes('not authorized') ||
    m.includes('invalid token') ||
    m.includes('bearer token') ||
    m.includes('accessdenied')
  )
}

// ============ 响应解析 ============

export interface ParsedUsage {
  email?: string
  userId?: string
  usage: AccountUsage
  subscription: AccountSubscription
}

/** 把 REST / CBOR 两种响应统一解析成账号用量 + 订阅 */
export function parseUsageResponse(res: UsageResponse): ParsedUsage {
  const credit =
    res.usageBreakdownList?.find(
      (b) => (b.resourceType || b.type) === 'CREDIT' || b.displayName === 'Credits'
    ) ?? res.usageBreakdownList?.[0]

  const baseLimit = credit?.usageLimitWithPrecision ?? credit?.usageLimit ?? 0
  const baseCurrent = credit?.currentUsageWithPrecision ?? credit?.currentUsage ?? 0

  const trial = credit?.freeTrialInfo ?? credit?.freeTrialUsage
  let freeTrialLimit = 0
  let freeTrialCurrent = 0
  let freeTrialExpiry: string | undefined
  if (trial?.freeTrialStatus === 'ACTIVE') {
    freeTrialLimit = trial.usageLimitWithPrecision ?? trial.usageLimit ?? 0
    freeTrialCurrent = trial.currentUsageWithPrecision ?? trial.currentUsage ?? 0
    freeTrialExpiry = toIso(trial.freeTrialExpiry)
  }

  // 一次遍历同时产出奖励明细与合计，避免对同一数组反复 reduce
  const bonuses: BonusUsage[] = []
  let bonusLimit = 0
  let bonusCurrent = 0
  for (const b of credit?.bonuses ?? []) {
    if (b.status && b.status !== 'ACTIVE') continue
    const current = b.currentUsageWithPrecision ?? b.currentUsage ?? 0
    const limit = b.usageLimitWithPrecision ?? b.usageLimit ?? 0
    bonusCurrent += current
    bonusLimit += limit
    bonuses.push({
      code: b.bonusCode || '',
      name: b.displayName || '',
      current,
      limit,
      expiresAt: toIso(b.expiresAt)
    })
  }

  const limit = baseLimit + freeTrialLimit + bonusLimit
  const current = baseCurrent + freeTrialCurrent + bonusCurrent
  const nextResetDate = toIso(res.nextDateReset)

  let expiresAt: number | undefined
  let daysRemaining: number | undefined
  if (nextResetDate) {
    expiresAt = new Date(nextResetDate).getTime()
    daysRemaining = Math.max(0, Math.ceil((expiresAt - Date.now()) / 86_400_000))
  }

  const title = res.subscriptionInfo?.subscriptionTitle || 'Free'
  const overageEnabled =
    res.overageConfiguration?.overageStatus === 'ENABLED' ||
    res.overageConfiguration?.overageEnabled === true ||
    res.overageSettings?.overageStatus === 'ENABLED'

  return {
    email: res.userInfo?.email,
    userId: res.userInfo?.userId,
    usage: {
      current,
      limit,
      percentUsed: limit > 0 ? current / limit : 0,
      lastUpdated: Date.now(),
      baseLimit,
      baseCurrent,
      freeTrialLimit,
      freeTrialCurrent,
      freeTrialExpiry,
      bonuses,
      nextResetDate,
      resourceDetail: credit
        ? {
            resourceType: credit.resourceType || credit.type,
            displayName: credit.displayName,
            displayNamePlural: credit.displayNamePlural,
            currency: credit.currency,
            unit: credit.unit,
            overageRate: credit.overageRate,
            overageCap: credit.overageCap,
            overageEnabled
          }
        : undefined
    },
    subscription: {
      type: normalizeSubscriptionType(title),
      title,
      rawType: res.subscriptionInfo?.subscriptionType || res.subscriptionInfo?.type,
      expiresAt,
      daysRemaining
    }
  }
}

/** 判断错误是否代表账号被封禁 */
export function isBannedError(message: string): boolean {
  return message.includes('AccountSuspended') || message.includes('423')
}
