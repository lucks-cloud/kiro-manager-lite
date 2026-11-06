// 「近半小时 / 近 1 小时积分用量」排序所需的数据。
//
// 数据来自主进程的积分变化日志（每次刷新用量时记一条快照，带与上一条的增量），
// 只在用户真的选了这两种排序时才去取，平时零开销。
// 用量刷新后（快照变化）与时间流逝（窗口在滑动）都会让结果变化，所以：
//  - 监听 version（调用方传入，用量一变它就变）立即重取；
//  - 另外每分钟重取一次，让已经滑出窗口的旧消耗及时扣掉。
import { onBeforeUnmount, shallowRef, watch, type Ref } from 'vue'
import { RECENT_SORT_FIELDS, parseSortKey, type SortField, type SortKey } from '@/utils/listSort'

const REFRESH_MS = 60_000

interface RecentUsageValue {
  m30: number
  m60: number
}

export function useRecentUsage(options: {
  sortKey: Ref<SortKey>
  /** 参与排序的条目 id（主进程侧的 subject id，API Key 要带 key: 前缀） */
  subjectIds: () => string[]
  /** 用量变化的版本号：变了就重取 */
  version: () => unknown
}): {
  values: Ref<Record<string, RecentUsageValue>>
  /** 取某条目在某个窗口内的消耗；没有记录时返回 undefined（排在最后） */
  valueOf: (subjectId: string, field: SortField) => number | undefined
} {
  // 只整体替换；上千个条目各建代理没必要，排序比较器里每次读都要经过它
  const values = shallowRef<Record<string, RecentUsageValue>>({})
  let timer: ReturnType<typeof setInterval> | null = null
  let seq = 0

  const active = (): boolean => RECENT_SORT_FIELDS.includes(parseSortKey(options.sortKey.value)[0])

  async function load(): Promise<void> {
    if (!active()) return
    const current = ++seq
    const res = await window.api.getRecentUsage(options.subjectIds())
    // 期间又发起了新请求就丢掉旧结果，避免慢请求覆盖新数据
    if (current !== seq || !res.success || !res.data) return
    values.value = res.data
  }

  function stop(): void {
    if (timer) clearInterval(timer)
    timer = null
  }

  watch(
    () => active(),
    (on) => {
      stop()
      if (!on) return
      void load()
      timer = setInterval(() => void load(), REFRESH_MS)
    },
    { immediate: true }
  )

  watch(options.version, () => void load())

  onBeforeUnmount(stop)

  function valueOf(subjectId: string, field: SortField): number | undefined {
    const entry = values.value[subjectId]
    if (!entry) return undefined
    return field === 'recent30' ? entry.m30 : entry.m60
  }

  return { values, valueOf }
}
