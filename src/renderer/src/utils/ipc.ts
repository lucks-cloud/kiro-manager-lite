// 与主进程通信时的数据处理
import { isProxy } from 'vue'

/**
 * 转成可结构化克隆的普通对象。
 *
 * store 里的账号是 Vue 响应式代理，直接经 IPC 发送会触发
 * "An object could not be cloned"，所以传参前先剥掉代理。
 */
export function toPlain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value))
}

/**
 * 已确认是纯数据的对象（按对象身份记）。
 * 只用于从不就地修改的数据（如账号对象，见 accounts store 的说明），确认一次就够了。
 */
const plainChecked = new WeakSet<object>()

/** 嵌套过深多半是数据有环，交给 toPlain 按原来的方式处理（报错） */
const MAX_PLAIN_DEPTH = 32

/**
 * 是否是可以原样经 IPC 发送的纯数据：只由普通对象、数组和字符串 / 数字 / 布尔 / null / undefined 组成，
 * 且不含响应式代理。函数、Symbol、BigInt、Date 之类 JSON 与结构化克隆处理方式不同的值一律算否，
 * 由调用方退回 toPlain。
 *
 * 结果为真时，原样发送与先 toPlain 再发送，在对端再做一次 JSON 往返后完全相同。
 */
export function isPlainData(value: unknown, depth = 0): boolean {
  if (value === null) return true
  const type = typeof value
  if (type === 'string' || type === 'number' || type === 'boolean' || type === 'undefined') {
    return true
  }
  if (type !== 'object' || depth > MAX_PLAIN_DEPTH) return false
  const obj = value as object
  if (plainChecked.has(obj)) return true
  if (isProxy(obj)) return false
  const proto = Object.getPrototypeOf(obj)
  if (Array.isArray(obj) ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) {
    return false
  }
  for (const item of Object.values(obj)) {
    if (!isPlainData(item, depth + 1)) return false
  }
  plainChecked.add(obj)
  return true
}
