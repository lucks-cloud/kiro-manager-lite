// 账号凭证的公用小工具
import type { AccountCredentials } from '@shared/types'

/** 刷新 / 切号 / 续期接口带回的新凭证，expiresIn 单位为秒 */
interface RenewedToken {
  accessToken: string
  refreshToken: string
  expiresIn: number
}

/**
 * 用轮换出的新 token 更新凭证：其余字段沿用，到期时刻从现在起算。
 * 各处回写新凭证都走这里，免得有一处漏改到期时间。
 */
export function renewCredentials(
  credentials: AccountCredentials,
  renewed: RenewedToken
): AccountCredentials {
  return {
    ...credentials,
    accessToken: renewed.accessToken,
    refreshToken: renewed.refreshToken,
    expiresAt: Date.now() + renewed.expiresIn * 1000
  }
}
