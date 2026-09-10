<script setup lang="ts">
/**
 * 分组网格：一排两个，长按可拖动排序，右侧三点菜单可改名 / 删除。
 *
 * 筛选面板与「批量设置分组」弹窗共用这一个组件，两者只有选中语义不同：
 * 面板里是多选筛选，弹窗里是单选目标分组，靠 multiple 区分。
 */
import { onBeforeUnmount, nextTick, ref } from 'vue'
import { EditOutlined, DeleteOutlined, HolderOutlined, MoreOutlined } from '@ant-design/icons-vue'
import type { AccountGroup } from '@shared/types'

const props = defineProps<{
  groups: AccountGroup[]
  /** 已选中的分组 id 集合（多选）或单个 id（单选） */
  selected: string[]
  /** 各分组的账号数，可选；给了就在名字后面显示计数 */
  counts?: Record<string, number>
  multiple?: boolean
}>()

const emit = defineEmits<{
  select: [id: string]
  rename: [group: AccountGroup]
  remove: [group: AccountGroup]
  reorder: [orderedIds: string[]]
}>()

/** 哪个分组的菜单是打开的：右键与三点两条入口共用 */
const menuOpenId = ref('')

// ---- 长按拖拽排序 ----
/**
 * 全程用指针事件实现，不用 HTML5 的 draggable。
 *
 * 之前那版走的是「长按后把 :draggable 置 true」，行不通：Chromium 在 mousedown
 * 那一刻就决定了这次手势是不是拖拽，等 220ms 之后再改属性，dragstart 根本不触发。
 * 所以这里自己记录按下位置、超时进入拖拽态，位移全部交给 transform。
 *
 * 与横向标签栏的区别只有一处：网格是二维的，让位位移要算 x 和 y 两个方向。
 */
const LONG_PRESS_MS = 220
/** 松手后归位动画的时长，和同伴让位的过渡保持一致 */
const SETTLE_MS = 180

/** 网格根元素；两个实例（筛选面板 / 批量弹窗）可能同时挂载，不能用全局选择器 */
const gridRef = ref<HTMLElement | null>(null)

/** 长按到位、进入拖拽态的分组 */
const dragId = ref('')
/** 被拖分组跟随光标的位移 */
const dragDx = ref(0)
const dragDy = ref(0)
/** 归位阶段：已松手、正在滑向最终格子，此时允许过渡 */
const settling = ref(false)
/** 落点：在「其余分组」里的插入位 */
const dropIndex = ref(-1)
/** 其余分组各自的让位位移 */
const shifts = ref<Record<string, { x: number; y: number }>>({})
/**
 * 提交顺序的那一两帧里禁掉所有格子的过渡。
 *
 * 提交时 Vue 按 key 把 DOM 节点移到新位置（瞬时、无动画），而同一帧
 * transform 要从让位值变回 0 —— 这个变化会被 transition 接管，
 * 于是格子先跳到「新位置 − 让位值」再滑回来，看起来就是「其余分组又动了一下」。
 */
const noAnim = ref(false)

/** 拖拽开始时冻结的几何快照；坐标取自 offsetLeft/Top，与容器滚动无关 */
interface CellGeom {
  id: string
  left: number
  top: number
}

let snapshot: CellGeom[] = []
/** id → 快照下标，避免每帧再 findIndex 扫一遍 */
let snapshotIndex = new Map<string, number>()
/** 被拖分组在快照里的下标 */
let dragFrom = -1
/** 网格行高（含间距），用于判断两个格子是否同一行 */
let rowTol = 20
let startX = 0
let startY = 0

let pressTimer: ReturnType<typeof setTimeout> | undefined
let settleTimer: ReturnType<typeof setTimeout> | undefined
let pressPoint = { x: 0, y: 0 }
/** 本次手势是否已经进入过拖拽：用于抑制 mouseup 后紧跟的那次 click */
let dragSession = false
/** 待提交的新顺序，归位动画结束（或被打断）时由 endDrag 落盘 */
let pendingOrder: string[] | null = null

/**
 * 冻结几何快照。
 *
 * 用 offsetLeft / offsetTop 而不是 getBoundingClientRect：前者相对内容盒，
 * 面板滚动时不会变；拖拽期间 DOM 顺序保持不变，所以这份快照始终有效。
 */
function takeSnapshot(): void {
  const cells = gridRef.value
    ? [...gridRef.value.querySelectorAll<HTMLElement>('.group-cell')]
    : []
  snapshot = cells.map((el) => ({
    id: el.dataset.id ?? '',
    left: el.offsetLeft,
    top: el.offsetTop
  }))
  snapshotIndex = new Map(snapshot.map((s, i) => [s.id, i]))
  // 同行的两个格子 top 相同，跨行差一个行高；取半个行高做同行判定的容差
  const height = cells[0]?.offsetHeight ?? 34
  rowTol = height / 2
}

/**
 * 依据快照重算：被拖分组的位移、落点、其余分组的让位量。
 *
 * 全程只读快照、不读实时 DOM —— 这是这套实现的关键。
 * 一边改 DOM 顺序一边用实时坐标算落点会形成反馈环：每次换位后坐标全变，
 * 下一帧拿新布局再算，于是抖动、脱节。快照冻结后落点是拖拽位置的单调函数。
 */
function updateDrag(clientX: number, clientY: number): void {
  if (dragFrom < 0) return
  dragDx.value = clientX - startX
  dragDy.value = clientY - startY

  const dragged = snapshot[dragFrom]
  const cx = dragged.left + dragDx.value
  const cy = dragged.top + dragDy.value
  const others = snapshot.filter((_, i) => i !== dragFrom)

  /*
   * 越过几个其他格子，就插到第几位。
   * 网格按「先行后列」阅读顺序比较：不同行看 y，同一行才看 x。
   * others 本身是阅读顺序，谓词单调，扫前缀即可，不会震荡。
   */
  let to = 0
  while (to < others.length && isBefore(others[to], cx, cy)) to++
  dropIndex.value = to

  // 让位量 = 新格子位置 − 原格子位置，网格里两格等宽等高，格位可以互换
  const next: Record<string, { x: number; y: number }> = {}
  others.forEach((cell, j) => {
    const from = snapshotIndex.get(cell.id) ?? j
    const slot = snapshot[j < to ? j : j + 1] ?? snapshot[from]
    next[cell.id] = { x: slot.left - snapshot[from].left, y: slot.top - snapshot[from].top }
  })
  shifts.value = next
}

/** 格子 cell 是否排在拖拽点 (x, y) 之前 */
function isBefore(cell: CellGeom, x: number, y: number): boolean {
  if (cell.top < y - rowTol) return true
  if (cell.top > y + rowTol) return false
  return cell.left < x
}

/** 拖拽中每个格子的样式：被拖的跟手，其余的让位 */
function cellStyle(id: string): Record<string, string> | undefined {
  if (!dragId.value) return undefined
  if (id === dragId.value) {
    const transform = `translate(${dragDx.value}px, ${dragDy.value}px)`
    // 跟手阶段必须关掉过渡，否则会落在光标后面；归位阶段反过来要有过渡
    return settling.value ? { transform } : { transform, transition: 'none' }
  }
  const s = shifts.value[id]
  return { transform: `translate(${s?.x ?? 0}px, ${s?.y ?? 0}px)` }
}

function onDragMove(e: MouseEvent): void {
  if (!dragId.value) return
  updateDrag(e.clientX, e.clientY)
}

/**
 * 松手：先把被拖的格子滑回它最终该待的位置，落稳后才提交顺序。
 *
 * 不能松手就直接提交 —— 那一刻格子停在光标处而不是目标格位，
 * 提交顺序与清除 transform 同时发生，格子会从光标弹到格位里，看起来就是闪一下。
 * 分两步之后：归位动画结束时带 transform 的视觉布局与重排后的布局逐像素一致，
 * 于是同一帧提交顺序 + 清掉 transform，画面完全不变。
 */
function finishDrag(): void {
  document.removeEventListener('mousemove', onDragMove)
  document.removeEventListener('mouseup', finishDrag)

  if (dragFrom < 0 || dropIndex.value < 0) return endDrag()

  const dragged = snapshot[dragFrom]
  const others = snapshot.filter((_, i) => i !== dragFrom)
  const at = Math.min(dropIndex.value, others.length)
  const slot = snapshot[at] ?? dragged

  pendingOrder = [
    ...others.slice(0, at).map((o) => o.id),
    dragged.id,
    ...others.slice(at).map((o) => o.id)
  ]
  settling.value = true
  dragDx.value = slot.left - dragged.left
  dragDy.value = slot.top - dragged.top
  /*
   * 顺序先存起来由 endDrag 统一提交：归位动画期间用户可能点别处，
   * 那会走到 endDrag 并清掉定时器 —— 放在 endDrag 里，无论从哪条路径结束都不丢排序。
   */
  settleTimer = setTimeout(endDrag, SETTLE_MS)
}

function endDrag(): void {
  if (pressTimer) clearTimeout(pressTimer)
  pressTimer = undefined
  if (settleTimer) clearTimeout(settleTimer)
  settleTimer = undefined
  settling.value = false

  /*
   * 提交顺序和清掉 transform 必须在同一个同步块里，Vue 会合成一次渲染。
   * 此时归位动画已经让视觉布局等于重排后的布局，所以这一帧画面不变 ——
   * 前提是 transform 归零不带过渡，靠 noAnim 保证。
   */
  if (pendingOrder) {
    noAnim.value = true
    emit('reorder', pendingOrder)
    pendingOrder = null
    void nextTick(() => {
      requestAnimationFrame(() => requestAnimationFrame(() => (noAnim.value = false)))
    })
  }

  dragId.value = ''
  dropIndex.value = -1
  dragDx.value = 0
  dragDy.value = 0
  shifts.value = {}
  snapshot = []
  snapshotIndex.clear()
  dragFrom = -1
  document.removeEventListener('mousemove', onPressMove)
  document.removeEventListener('mousemove', onDragMove)
  document.removeEventListener('mouseup', finishDrag)
}

/**
 * 长按判定期间鼠标移动超过阈值就取消长按。
 * 不加这一步的话，想滚动面板或轻微抖手也会被判成拖拽。
 */
function onPressMove(e: MouseEvent): void {
  if (dragId.value) return
  if (Math.hypot(e.clientX - pressPoint.x, e.clientY - pressPoint.y) > 6) endDrag()
}

function startPress(id: string, e: MouseEvent): void {
  // 只响应左键，右键要留给上下文菜单
  if (e.button !== 0) return
  endDrag()
  dragSession = false
  pressPoint = { x: e.clientX, y: e.clientY }
  document.addEventListener('mousemove', onPressMove)

  pressTimer = setTimeout(() => {
    dragSession = true
    // 先冻结快照再进入拖拽态：此刻 DOM 还是原始顺序，量到的就是基准布局
    takeSnapshot()
    dragFrom = snapshot.findIndex((s) => s.id === id)
    startX = e.clientX
    startY = e.clientY
    dragDx.value = 0
    dragDy.value = 0
    dragId.value = id
    updateDrag(e.clientX, e.clientY)

    document.removeEventListener('mousemove', onPressMove)
    // 监听挂在 document 上：鼠标滑出网格时也要继续跟手
    document.addEventListener('mousemove', onDragMove)
    document.addEventListener('mouseup', finishDrag)
  }, LONG_PRESS_MS)
}

function onCellClick(id: string): void {
  if (pressTimer) {
    clearTimeout(pressTimer)
    pressTimer = undefined
  }
  document.removeEventListener('mousemove', onPressMove)
  // 拖动过就不要再当成一次「点击选中」
  if (dragSession) {
    dragSession = false
    return
  }
  emit('select', id)
}

// 拖拽途中面板被关掉时，document 上的监听要收掉
onBeforeUnmount(endDrag)
</script>

<template>
  <div ref="gridRef" class="group-grid" :class="{ 'no-anim': noAnim }">
    <!--
      整格支持右键唤出菜单，三点图标点击复用同一个浮层（把 menuOpenId 置为该分组），
      这样右键与三点两条入口共用一份菜单定义，不会出现两处菜单项走样。
      拖拽期间 DOM 顺序保持不变，位移全交给 transform，松手才提交真实顺序。
    -->
    <a-dropdown
      v-for="group in props.groups"
      :key="group.id"
      :trigger="['contextmenu']"
      placement="bottomRight"
      :open="menuOpenId === group.id"
      @open-change="(v: boolean) => (menuOpenId = v ? group.id : '')"
    >
      <div
        class="group-cell"
        :data-id="group.id"
        :style="cellStyle(group.id)"
        :class="{
          on: props.selected.includes(group.id),
          dragging: dragId === group.id && !settling,
          settling: dragId === group.id && settling
        }"
        @mousedown="startPress(group.id, $event)"
        @click="onCellClick(group.id)"
      >
        <HolderOutlined class="grip" />
        <span class="group-name" :title="group.name">{{ group.name }}</span>
        <span v-if="props.counts" class="group-count muted">{{ props.counts[group.id] ?? 0 }}</span>

        <!-- 阻止冒泡：点三点不应该连带切换选中，也不该触发长按计时 -->
        <span
          class="group-more"
          title="更多"
          @click.stop="menuOpenId = menuOpenId === group.id ? '' : group.id"
          @mousedown.stop
        >
          <MoreOutlined />
        </span>
      </div>

      <template #overlay>
        <a-menu>
          <a-menu-item key="rename" @click="emit('rename', group)">
            <EditOutlined />
            编辑分组名称
          </a-menu-item>
          <a-menu-item key="remove" danger @click="emit('remove', group)">
            <DeleteOutlined />
            删除分组
          </a-menu-item>
        </a-menu>
      </template>
    </a-dropdown>
  </div>
</template>

<style scoped>
/* 一排两个 */
.group-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}

/*
 * 提交顺序那一帧要把过渡整体关掉，用 !important 是因为跟手阶段的
 * transition: none 写在行内，类选择器的优先级压不过行内。
 */
.group-grid.no-anim .group-cell {
  transition: none !important;
}

.group-cell {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  padding: 7px 8px 7px 6px;
  border: 1px solid var(--kal-border);
  border-radius: 8px;
  background: transparent;
  cursor: pointer;
  /* 长按拖动会选中文字，禁掉更像在拖一个块 */
  user-select: none;
  transition: transform 0.18s ease, border-color 0.15s ease, background 0.15s ease;
}

.group-cell:hover {
  border-color: var(--kal-primary);
}

.group-cell.on {
  border-color: var(--kal-primary);
  background: var(--kal-block-bg);
}

/* 被拖起来的那个：虚线 + 底色，浮在同伴之上跟着光标走 */
.group-cell.dragging,
.group-cell.dragging:hover {
  position: relative;
  z-index: 5;
  border: 1px dashed var(--kal-primary);
  background: rgba(124, 58, 237, 0.12);
  cursor: grabbing;
}

/* 归位途中层级保持抬高，滑动时不会被相邻格子压住 */
.group-cell.settling {
  position: relative;
  z-index: 5;
}

.grip {
  flex: 0 0 auto;
  color: var(--kal-muted);
  font-size: 12px;
}

.group-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
}

.group-count {
  flex: 0 0 auto;
  font-size: 12px;
}

.group-more {
  flex: 0 0 auto;
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  border-radius: 5px;
  color: var(--kal-muted);
}

.group-more:hover {
  background: rgba(0, 0, 0, 0.06);
  color: var(--kal-text);
}
</style>
