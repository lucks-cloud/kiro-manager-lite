/**
 * 账号列表与 API Key 列表共用的筛选判断。
 *
 * 范围条件一律用 != null 判断「是否已设置」：输入框清空后给过来的是 null，
 * 若按 !== undefined 判断，null 会被当成已设置，比较时又被转成 0，
 * 于是 days > 0 / used > 0 把几乎所有条目都滤掉，列表看起来是空的。
 */

/** 数值是否落在 [min, max] 内，两端都含；没设置的一端不限 */
export function inRange(value: number, min?: number | null, max?: number | null): boolean {
  if (min != null && value < min) return false
  if (max != null && value > max) return false
  return true
}

/**
 * 剩余天数是否落在 [min, max] 内，两端都含。
 * 缺值（没有重置时间等）判上限时按 +∞、判下限时按 -∞，即只要设置了任一端就被排除。
 */
export function daysInRange(
  days: number | null | undefined,
  min?: number | null,
  max?: number | null
): boolean {
  if (max != null && (days ?? Number.POSITIVE_INFINITY) > max) return false
  if (min != null && (days ?? Number.NEGATIVE_INFINITY) < min) return false
  return true
}
