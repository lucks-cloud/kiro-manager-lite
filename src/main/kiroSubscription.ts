// 订阅：查可开通档位、生成 Stripe 账单管理 / 结算链接
//
// 这两个接口和 kiroApi 里的 CBOR 门户接口同属 KiroWebPortalService，但认证方式不同：
// 用量那几个操作只看 Bearer token，而订阅相关操作**强制 CSRF 双提交**——
// 必须同时带上 x-csrf-token 头和与之配对的 UserId cookie，少一个就是
//   401 UnauthorizedException: Invalid CSRF token   （只给头、没带 UserId）
//   400 BadRequestException:  CSRF token is required（头都没给）
// 实测记录（marynelsone826=Free / prakashchanderpk780=Pro+）：
//   - token 从 https://app.kiro.dev/ 的 <meta name="csrf-token"> 取，
//     UserId 从同一次响应的 Set-Cookie 取，两者是一对，分开用会被拒；
//   - Bearer、origin/referer、amz-sdk-* 头一概不影响结果，因此不发；
//   - profileArn 可有可无（换成别的账号 ARN 甚至不带都照样 200），所以不发；
//   - GenerateSubscriptionManagementUrl 不带 subscriptionType 时只对「已订阅」
//     账号返回 billing.stripe.com 的账单管理链接，未订阅账号回
//     400 The request contains invalid parameters.，这是正常信号而不是故障；
//   - 带上 subscriptionType 时返回 checkout.stripe.com 的结算链接（未订阅账号），
//     已订阅账号则仍然返回账单管理链接，由 Stripe 侧负责改套餐。
import { encode, decode } from 'cbor-x'
import { KIRO_PORTAL_BASE, KIRO_PORTAL_ORIGIN } from './kiroEndpoints'
import { httpRequest } from './net'
import { inAppChromeUserAgent } from './kiroPortal'
import type { Account, SubscriptionEntry, SubscriptionPlan } from '../shared/types'

/** 一次 CSRF 会话：token 与它配对的 cookie 串 */
interface PortalCsrfSession {
  csrfToken: string
  cookie: string
}

/**
 * 取一次 CSRF 会话。
 *
 * 首页返回的 HTML 里带 <meta name="csrf-token">，同一次响应的 Set-Cookie 里带 UserId，
 * 服务端校验的正是这两者的配对关系，所以必须同一次请求一起取出来。
 */
async function openCsrfSession(account: Account): Promise<PortalCsrfSession> {
  const { accessToken } = account.credentials
  if (!accessToken) throw new Error('账号缺少 AccessToken，无法查询订阅')

  const authCookie = [
    `Idp=${account.idp}`,
    `AccessToken=${accessToken}`,
    account.credentials.refreshToken ? `RefreshToken=${account.credentials.refreshToken}` : ''
  ]
    .filter(Boolean)
    .join('; ')

  const res = await httpRequest(KIRO_PORTAL_ORIGIN, {
    headers: {
      accept: 'text/html',
      'user-agent': inAppChromeUserAgent(),
      cookie: authCookie
    }
  })
  if (!res.ok) throw new Error(`打开门户首页失败：HTTP ${res.status}`)

  const html = await res.text()
  const csrfToken = html.match(/<meta name="csrf-token" content="([^"]+)"/)?.[1] ?? ''
  if (!csrfToken) throw new Error('门户首页没有返回 CSRF token，凭证可能已失效')

  // 只回传 UserId：其余 Set-Cookie 与校验无关，全塞进去只会让请求头变长
  const userId = res.headers
    .getSetCookie()
    .find((item) => item.startsWith('UserId='))
    ?.split(';')[0]
  if (!userId) throw new Error('门户首页没有下发 UserId，凭证可能已失效')

  return { csrfToken, cookie: `${authCookie}; ${userId}` }
}

/** 带 CSRF 的门户 CBOR 调用；失败时把服务端异常名与文案原样带出来 */
async function csrfOperation<T>(
  operation: string,
  body: Record<string, unknown>,
  session: PortalCsrfSession
): Promise<T> {
  const res = await httpRequest(`${KIRO_PORTAL_BASE}/${operation}`, {
    method: 'POST',
    headers: {
      accept: 'application/cbor',
      'content-type': 'application/cbor',
      'smithy-protocol': 'rpc-v2-cbor',
      'x-csrf-token': session.csrfToken,
      'user-agent': inAppChromeUserAgent(),
      cookie: session.cookie
    },
    body: Buffer.from(encode(body))
  })

  const buffer = Buffer.from(await res.arrayBuffer())
  // 只记操作名与状态码：这里的 cookie / 链接都算凭证，不能进日志
  console.debug(`[KiroSubscription] ${operation} → ${res.status}`)
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

interface RawPlan {
  name?: string
  qSubscriptionType?: string
  pricing?: { amount?: number; currency?: string }
  description?: {
    title?: string
    billingInterval?: string
    featureHeader?: string
    features?: string[]
  }
}

function parsePlans(raw: RawPlan[] | undefined): SubscriptionPlan[] {
  return (raw ?? [])
    .filter((plan) => !!plan.qSubscriptionType)
    .map((plan) => ({
      name: plan.name || plan.qSubscriptionType || '',
      subscriptionType: plan.qSubscriptionType as string,
      title: plan.description?.title || plan.name || '',
      amount: plan.pricing?.amount ?? 0,
      currency: plan.pricing?.currency || 'USD',
      billingInterval: plan.description?.billingInterval || '',
      featureHeader: plan.description?.featureHeader || '',
      features: plan.description?.features ?? []
    }))
}

/** 账号已订阅时才有账单管理链接；未订阅接口回 400，这里归一成 undefined */
async function tryManageUrl(session: PortalCsrfSession): Promise<string | undefined> {
  try {
    const res = await csrfOperation<{ encodedVerificationUrl?: string }>(
      'GenerateSubscriptionManagementUrl',
      {},
      session
    )
    return res.encodedVerificationUrl || undefined
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // 「没有可管理的订阅」就是这条 400，属于预期分支，不该当异常抛给界面
    if (message.includes('400') && message.includes('BadRequestException')) return undefined
    throw error
  }
}

/**
 * 点订阅标签后的一次查询：先要账单管理链接，拿不到就退回可开通档位列表。
 * 两件事合成一次 IPC，界面只等一轮。
 */
export async function getSubscriptionEntry(account: Account): Promise<SubscriptionEntry> {
  const session = await openCsrfSession(account)

  const manageUrl = await tryManageUrl(session)
  if (manageUrl) return { manageUrl, plans: [], disclaimer: [] }

  const res = await csrfOperation<{ subscriptionPlans?: RawPlan[]; disclaimer?: string[] }>(
    'GetAvailableSubscriptionPlans',
    {},
    session
  )
  return { plans: parsePlans(res.subscriptionPlans), disclaimer: res.disclaimer ?? [] }
}

/** 为指定档位生成 Stripe 结算链接 */
export async function createSubscriptionCheckout(
  account: Account,
  subscriptionType: string
): Promise<{ url: string }> {
  if (!subscriptionType) throw new Error('缺少订阅类型')
  const session = await openCsrfSession(account)
  const res = await csrfOperation<{ encodedVerificationUrl?: string }>(
    'GenerateSubscriptionManagementUrl',
    { subscriptionType },
    session
  )
  if (!res.encodedVerificationUrl) throw new Error('接口没有返回支付链接')
  return { url: res.encodedVerificationUrl }
}
