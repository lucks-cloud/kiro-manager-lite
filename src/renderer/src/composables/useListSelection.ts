// 列表勾选：账号列表与 API Key 列表共用的全选 / 半选 / 范围勾选接线。
//
// 勾选的 id 由调用方持有（账号的在 store 里，Key 的在视图里），这里只读写它；
// 「批量操作的目标」两边口径不同，留在各自的视图里算。
import { computed, type ComputedRef, type Ref } from 'vue'
import { useRangeSelect } from '@/utils/rangeSelect'

export function useListSelection<T extends { id: string }>(options: {
  /** 勾选的 id */
  selectedIds: Ref<string[]>
  /** 当前筛选、排序后的列表（界面上的卡片顺序） */
  items: () => readonly T[]
}): {
  /** 勾选集合：条目上千时用 Set 做包含判断，别用 includes 扫数组 */
  selectedSet: ComputedRef<ReadonlySet<string>>
  /** 当前筛选结果里被勾选的数量 */
  visibleSelectedCount: ComputedRef<number>
  allVisibleSelected: ComputedRef<boolean>
  someVisibleSelected: ComputedRef<boolean>
  /** 批量操作按钮的范围后缀：有勾选时带上全部勾选数（含被筛选挡住的） */
  batchScopeSuffix: ComputedRef<string>
  /** 单击勾选；按住 Shift 勾选一段（见 rangeSelect） */
  toggleSelect: (id: string, checked: boolean) => void
  /** 全选 / 取消全选当前筛选结果 */
  toggleSelectVisible: (checked: boolean) => void
} {
  const { selectedIds, items } = options

  const selectedSet = computed<ReadonlySet<string>>(() => new Set(selectedIds.value))

  /** 一次遍历同时支撑全选与半选状态，不为计数分配中间数组 */
  const visibleSelectedCount = computed(() => {
    let count = 0
    for (const item of items()) {
      if (selectedSet.value.has(item.id)) count++
    }
    return count
  })

  const allVisibleSelected = computed(
    () => items().length > 0 && visibleSelectedCount.value === items().length
  )
  const someVisibleSelected = computed(
    () => visibleSelectedCount.value > 0 && !allVisibleSelected.value
  )

  const batchScopeSuffix = computed(() =>
    selectedIds.value.length ? `（${selectedIds.value.length}个）` : ''
  )

  /** 在勾选集合上做增删：条目上千时用 Set 改再回写，避免逐条线性扫描 */
  function updateSelection(mutate: (set: Set<string>) => void): void {
    const set = new Set(selectedIds.value)
    mutate(set)
    selectedIds.value = [...set]
  }

  function toggleSelectVisible(checked: boolean): void {
    updateSelection((set) => {
      for (const item of items()) {
        if (checked) set.add(item.id)
        else set.delete(item.id)
      }
    })
  }

  /** Ctrl / Cmd + A 勾选当前筛选结果 */
  const { toggle } = useRangeSelect({
    order: () => items().map((item) => item.id),
    apply: (ids, checked) =>
      updateSelection((set) => {
        for (const id of ids) checked ? set.add(id) : set.delete(id)
      }),
    selectAll: () => toggleSelectVisible(true)
  })

  return {
    selectedSet,
    visibleSelectedCount,
    allVisibleSelected,
    someVisibleSelected,
    batchScopeSuffix,
    toggleSelect: toggle,
    toggleSelectVisible
  }
}
