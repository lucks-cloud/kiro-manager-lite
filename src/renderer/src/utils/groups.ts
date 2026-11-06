// 分组相关的公用小工具：账号列表与 API Key 列表共用同一套分组语义
import type { AccountGroup } from '@shared/types'
import { groupIdsOf, isTrashed, type Groupable, type Trashable } from '@shared/itemGroups'

/**
 * 筛选里代表「未分组」的哨兵值。
 * 用一个不可能与 uuid 冲突的字符串，这样「未分组」能和普通分组一样被勾选，
 * 不必再为它单独加一个布尔开关。
 */
export const UNGROUPED = '__none__'

/** 分组名称为空时的提示，新建与改名共用 */
export const EMPTY_GROUP_NAME = '分组名称不能为空'

/** 新建分组时的同名分组：同名直接复用已有的那个，避免建出一堆重名分组 */
export function findGroupByName(
  groups: readonly AccountGroup[],
  label: string
): AccountGroup | undefined {
  return groups.find((group) => group.name === label)
}

/**
 * 改名校验：返回错误文案，通过为 null。label 应已去掉首尾空白。
 * 和别的分组重名时拒绝，否则筛选里会出现两个同名分组。
 */
export function renameGroupError(
  groups: readonly AccountGroup[],
  id: string,
  label: string
): string | null {
  if (!label) return EMPTY_GROUP_NAME
  if (groups.some((group) => group.id !== id && group.name === label)) return `分组「${label}」已存在`
  return null
}

/** 按 order 升序排好的分组列表；order 缺失时按 0 处理 */
export function sortGroups(groups: AccountGroup[] | undefined): AccountGroup[] {
  return [...(groups ?? [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
}

/**
 * 统计各分组下的条目数，外加「未分组」一项，用于面板上的计数。
 * 一个条目属于多个分组时，每个分组各计一次；
 * 分组都已被删除的条目计入未分组，避免残留 id 让计数对不上。
 * 回收站里的条目不计入（它们不出现在正常列表里）。
 */
export function countByGroup<T extends Groupable & Trashable>(
  items: T[],
  groups: AccountGroup[]
): Record<string, number> {
  const counts: Record<string, number> = { [UNGROUPED]: 0 }
  for (const group of groups) counts[group.id] = 0
  for (const item of items) {
    if (isTrashed(item)) continue
    let matched = false
    for (const id of groupIdsOf(item)) {
      if (counts[id] === undefined) continue
      counts[id]++
      matched = true
    }
    if (!matched) counts[UNGROUPED]++
  }
  return counts
}

/**
 * 分组筛选：所选分组里命中任一即可；UNGROUPED 表示「没有任何有效分组」。
 * exists 判断分组是否还存在，被删分组的残留 id 按不存在处理。
 */
export function matchesGroupFilter(
  item: Groupable,
  selected: ReadonlySet<string>,
  exists: (id: string) => boolean
): boolean {
  // 筛选对每个条目都要跑一遍，直接遍历、不分配中间数组
  let hasValid = false
  for (const id of groupIdsOf(item)) {
    if (!exists(id)) continue
    if (selected.has(id)) return true
    hasValid = true
  }
  return !hasValid && selected.has(UNGROUPED)
}

/** 条目的有效分组（按分组顺序），供卡片展示多个分组标签 */
export function groupsOfItem(item: Groupable, groups: AccountGroup[]): AccountGroup[] {
  const ids = new Set(groupIdsOf(item))
  return groups.filter((group) => ids.has(group.id))
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
