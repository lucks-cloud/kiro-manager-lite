// 分组相关的公用小工具：账号列表与 API Key 列表共用同一套分组语义
import type { AccountGroup } from '@shared/types'

/**
 * 筛选里代表「未分组」的哨兵值。
 * 用一个不可能与 uuid 冲突的字符串，这样「未分组」能和普通分组一样被勾选，
 * 不必再为它单独加一个布尔开关。
 */
export const UNGROUPED = '__none__'

/** 按 order 升序排好的分组列表；order 缺失时按 0 处理 */
export function sortGroups(groups: AccountGroup[] | undefined): AccountGroup[] {
  return [...(groups ?? [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
}

/**
 * 统计各分组下的条目数，外加「未分组」一项，用于面板上的计数。
 * 分组已被删除的条目一律计入未分组，避免残留 id 让计数对不上。
 */
export function countByGroup<T extends { groupId?: string }>(
  items: T[],
  groups: AccountGroup[]
): Record<string, number> {
  const counts: Record<string, number> = { [UNGROUPED]: 0 }
  for (const group of groups) counts[group.id] = 0
  for (const item of items) {
    const key = item.groupId && counts[item.groupId] !== undefined ? item.groupId : UNGROUPED
    counts[key]++
  }
  return counts
}

/** 按给定顺序重排，order 重新按下标写死；漏掉的按原顺序补在后面 */
export function reorderGroups(groups: AccountGroup[], orderedIds: string[]): AccountGroup[] {
  const byId = new Map(groups.map((group) => [group.id, group]))
  const next: AccountGroup[] = []
  for (const id of orderedIds) {
    const group = byId.get(id)
    if (!group) continue
    byId.delete(id)
    next.push({ ...group, order: next.length })
  }
  for (const group of byId.values()) next.push({ ...group, order: next.length })
  return next
}
