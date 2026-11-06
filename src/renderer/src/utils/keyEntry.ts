/**
 * API Key 条目的派生计算：列表页（筛选、排序、统计）与 Key 卡片共用，保证两边口径一致。
 */
import { normalizeSubscriptionType } from '@shared/subscription'
import { keyIssueOf } from '@shared/refreshPolicy'
import type { KeyEntry, KeyStatus, SubscriptionType } from '@shared/types'

/** 已用 / 总额度，夹在 0..1；没查到过额度时为 0 */
export function keyUsageRatio(entry: KeyEntry): number {
  if (!entry.totalCredits || !Number.isFinite(entry.totalCredits)) return 0
  return Math.min(1, Math.max(0, (entry.usedCredits || 0) / entry.totalCredits))
}

/**
 * 订阅档位：直接从上游返回的标题算，与账号管理共用同一个判定口径。
 * 不读历史的 tier 字段——那套小写分层没有 Pro Max，存量数据里 Pro Max 记成了 pro+。
 */
export function keyTier(entry: KeyEntry): SubscriptionType {
  return normalizeSubscriptionType(entry.subscription || '')
}

/**
 * 卡片上要展示的问题原因：管理面同步错误与对话测活错误取并集。
 * 只看 lastError 会漏掉被封禁的 Key —— 它们在 Get-Usage-Limits 上返回 200，
 * 只有真实对话才会暴露 403。口径与主进程自动刷新共用 shared/refreshPolicy，
 * 这里直接转出那边的实现，渲染层沿用 keyIssue 这个名字。
 */
export { keyIssueOf as keyIssue } from '@shared/refreshPolicy'

export function keyStatusKey(entry: KeyEntry): KeyStatus {
  if (keyIssueOf(entry)) return 'error'
  return entry.lastCheckedAt ? 'normal' : 'unchecked'
}

/** 额度重置剩余天数；上游没给重置时间时返回 undefined（该 Key 不参与天数筛选） */
export function keyDaysRemaining(entry: KeyEntry): number | undefined {
  if (!entry.nextResetAt) return undefined
  return Math.max(0, Math.ceil((entry.nextResetAt - Date.now()) / 86_400_000))
}
