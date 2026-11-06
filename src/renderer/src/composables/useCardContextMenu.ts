// 整页共享的右键菜单状态：卡片只派发 contextmenu 事件，菜单本身只有一个实例（见 CardContextMenu）。
//
// 右键作用于哪些条目按 Windows 资源管理器的习惯确定：
//  - 右键的是已勾选的某一项：作用于全部勾选项，它们一起高亮；
//  - 右键的是未勾选的一项：先清掉已有勾选，只作用于这一项。
// 菜单打开期间这些卡片高亮（highlight），关闭即恢复；
// 目标（targetIds）在关闭后保留到下次打开——点菜单项时菜单先关、动作后执行，动作里还要用到它。
import { nextTick, reactive, ref, shallowRef, type Ref } from 'vue'

/** 菜单关闭时的高亮集合：共用一个空集，不必每次关闭都新建 */
const NO_HIGHLIGHT: ReadonlySet<string> = new Set()

export function useCardContextMenu<T extends { id: string }>(options: {
  selectedIds: Ref<string[]>
}): {
  state: { open: boolean; x: number; y: number }
  /** 右键的那一项 */
  target: Ref<T | null>
  /** 本次菜单作用的全部 id */
  targetIds: Ref<string[]>
  /** 菜单打开期间高亮的 id */
  highlight: Ref<ReadonlySet<string>>
  show: (event: MouseEvent, item: T) => void
  hide: () => void
} {
  const state = reactive({ open: false, x: 0, y: 0 })
  const target = shallowRef(null) as Ref<T | null>
  const targetIds = ref<string[]>([])
  // 只整体替换，用浅层响应式：Set 不必再包一层集合代理，卡片判断高亮时也不用逐个追踪
  const highlight = shallowRef<ReadonlySet<string>>(NO_HIGHLIGHT)

  async function show(event: MouseEvent, item: T): Promise<void> {
    event.preventDefault()
    // 菜单开着时又在别处右键：先关掉再在新位置打开，否则弹层不会重新对齐到新落点
    if (state.open) {
      state.open = false
      await nextTick()
    }
    const selected = options.selectedIds.value
    if (selected.includes(item.id)) {
      targetIds.value = [...selected]
    } else {
      if (selected.length) options.selectedIds.value = []
      targetIds.value = [item.id]
    }
    target.value = item
    highlight.value = new Set(targetIds.value)
    state.x = event.clientX
    state.y = event.clientY
    state.open = true
  }

  function hide(): void {
    state.open = false
    highlight.value = NO_HIGHLIGHT
  }

  return { state, target, targetIds, highlight, show: (e, item) => void show(e, item), hide }
}
