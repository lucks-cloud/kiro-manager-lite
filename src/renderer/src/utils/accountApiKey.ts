/**
 * 账号生成 API Key 时单个弹窗与批量弹窗共用的两件事：默认密钥名、凭证回写。
 */
import { useAccountsStore } from '@/stores/accounts'
import { renewCredentials } from '@/utils/credentials'
import type { CreateApiKeyResult } from '@shared/types'

/**
 * 名称留空时按时间戳生成一个 8 位随机名（字母数字）。
 * 以毫秒时间戳的 base36 打底，天然递增、不易撞名；不足 8 位时用随机字符补齐。
 */
export function randomKeyName(): string {
  let s = Date.now().toString(36)
  while (s.length < 8) s += Math.random().toString(36).slice(2)
  return s.slice(-8)
}

/** 请求过程中可能刷新过凭证，不同步回本地会让下一次请求拿着已作废的旧值 */
export function applyRefreshedCredentials(
  accountId: string,
  refreshed?: CreateApiKeyResult['refreshed']
): void {
  if (!refreshed) return
  const store = useAccountsStore()
  const latest = store.get(accountId)
  if (!latest) return
  store.updateAccount(accountId, { credentials: renewCredentials(latest.credentials, refreshed) })
}
