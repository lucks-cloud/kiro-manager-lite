/**
 * 结构共享用的严格深相等：主进程每次返回的都是新对象，内容没变时沿用旧对象，
 * 卡片 props、搜索文本缓存这类按对象身份判断的地方就不会白白失效。
 *
 * 比 JSON 序列化后比较更严：键的集合与顺序都要一致（值为 undefined 的键也算），
 * 这样沿用旧对象后，store 里的内容与直接用新对象逐键完全相同。
 * 只认普通对象与数组；遇到其它类型（Date、Map 等）一律当作不相等，交给调用方用新值。
 */
export function sameData(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  const proto = Object.getPrototypeOf(a)
  if (proto !== Object.getPrototypeOf(b)) return false
  if (proto !== Object.prototype && proto !== Array.prototype && proto !== null) return false
  if (Array.isArray(a) && (a as unknown[]).length !== (b as unknown[]).length) return false
  const keysA = Object.keys(a)
  const keysB = Object.keys(b)
  if (keysA.length !== keysB.length) return false
  const recA = a as Record<string, unknown>
  const recB = b as Record<string, unknown>
  for (let i = 0; i < keysA.length; i++) {
    const key = keysA[i]
    if (key !== keysB[i]) return false
    if (!sameData(recA[key], recB[key])) return false
  }
  return true
}

/**
 * 按 id 对应新旧两份列表：内容没变的条目沿用旧对象，其余用新对象。
 * 返回的总是新数组，顺序与 next 一致。
 */
export function shareUnchangedById<T extends { id: string }>(
  prev: readonly T[],
  next: readonly T[]
): T[] {
  if (!prev.length) return [...next]
  const byId = new Map<string, T>()
  for (const item of prev) byId.set(item.id, item)
  return next.map((item) => {
    const old = byId.get(item.id)
    return old !== undefined && sameData(old, item) ? old : item
  })
}
