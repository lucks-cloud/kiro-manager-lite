/**
 * 账号与 API Key 列表共用的排序。
 *
 * 排序项是「字段 + 方向」。菜单按字段分二级：一级是字段，点它直接按降序排；
 * 展开后的二级里可改选降序或升序（见 SortMenu）。
 * 缺值（没同步过的用量、没有重置时间的免费档等）不论升降序都排在最后，
 * 否则升序时一排空值顶在最前面，真正想看的反而被挤到下面。
 */
export type SortField =
  | 'createdAt'
  | 'email'
  | 'usage'
  | 'usedCredits'
  | 'remainingCredits'
  | 'reset'
  | 'token'
  | 'recent30'
  | 'recent60'
export type SortDir = 'asc' | 'desc'

/** 按最近一段时间实际消耗排序的两个字段，值要另外向主进程批量取 */
export const RECENT_SORT_FIELDS: readonly SortField[] = ['recent30', 'recent60']
export type SortKey = `${SortField}:${SortDir}`

export interface SortFieldOption {
  field: SortField
  label: string
}

/** 菜单里的字段顺序 */
export const SORT_FIELDS: SortFieldOption[] = [
  { field: 'createdAt', label: '添加时间' },
  { field: 'email', label: '邮箱字母' },
  { field: 'usage', label: '用量占比' },
  { field: 'usedCredits', label: '使用积分' },
  { field: 'remainingCredits', label: '剩余积分' },
  { field: 'recent30', label: '近半小时积分用量' },
  { field: 'recent60', label: '近1小时积分用量' },
  { field: 'reset', label: '剩余重置天数' },
  { field: 'token', label: 'Token 有效期' }
]

export const DIR_LABELS: Record<SortDir, string> = { desc: '降序', asc: '升序' }

export const DEFAULT_SORT: SortKey = 'createdAt:desc'

export function parseSortKey(key: SortKey): [SortField, SortDir] {
  return key.split(':') as [SortField, SortDir]
}

/** 按钮上显示的文字，如「用量占比降序」 */
export function sortLabelOf(fields: SortFieldOption[], key: SortKey): string {
  const [field, dir] = parseSortKey(key)
  const label = fields.find((f) => f.field === field)?.label ?? fields[0].label
  return `${label}${DIR_LABELS[dir]}`
}

/** 取字段值的函数：返回 undefined / 空串表示缺值 */
type SortGetter<T> = (item: T, field: SortField) => number | string | undefined

/**
 * 按排序项比较两条记录。缺值固定排最后；邮箱按本地化字母序、不分大小写。
 * 相等时按添加时间降序兜底，保证顺序稳定、刷新后不乱跳。
 */
export function compareBy<T>(
  key: SortKey,
  get: SortGetter<T>,
  createdAt: (item: T) => number
): (a: T, b: T) => number {
  const [field, dir] = parseSortKey(key)
  const sign = dir === 'asc' ? 1 : -1
  return (a, b) => {
    const va = get(a, field)
    const vb = get(b, field)
    const missingA = va === undefined || va === ''
    const missingB = vb === undefined || vb === ''
    if (missingA !== missingB) return missingA ? 1 : -1
    if (!missingA && !missingB) {
      const diff =
        typeof va === 'string' && typeof vb === 'string'
          ? va.localeCompare(vb, undefined, { sensitivity: 'base' })
          : Number(va) - Number(vb)
      if (diff) return diff * sign
    }
    return createdAt(b) - createdAt(a)
  }
}
