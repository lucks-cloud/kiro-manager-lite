<script setup lang="ts" generic="T">
/**
 * 网格虚拟滚动。
 *
 * 只渲染视口内（外加若干缓冲行）的单元格，DOM 数量与数据量无关，
 * 十万条也只维持几十个节点，滚动开销恒定。
 *
 * 关键点：
 *  - 列数由容器宽度算出；基础行高统一，个别行可以按 itemExtra 加高
 *  - 行顶偏移预先算成前缀和，任意 scrollTop 二分即可定位首行
 *  - 用 transform 平移可见区域，避免逐格 top 触发大量重排
 *  - 基础高度先用预估值，挂载后按真实内容校正一次，不需要调用方写死
 *  - scroll 回调走 rAF 合并，一帧最多计算一次
 */
import { computed, onBeforeUnmount, onMounted, ref, watch, nextTick } from 'vue'

const props = withDefaults(
  defineProps<{
    items: T[]
    /** 单元格预估高度，挂载后会用真实高度校正 */
    estimatedHeight?: number
    /** 单列最小宽度，决定列数 */
    minColumnWidth?: number
    gap?: number
    /** 视口上下各额外渲染的行数，越大滚动越不易见白但 DOM 越多 */
    bufferRows?: number
    /** 单元格 key，缺省用索引（列表会变动时务必传） */
    itemKey?: (item: T, index: number) => string | number
    /**
     * 某个单元格在基础高度之上还需要多少像素（同一行取最大值）。
     *
     * 用于「少数单元格比别人高一截」的情形：卡片多了一行报错时只让它所在的
     * 那一行加高，其余行保持原高。不传则所有行等高，退化成原来的定高网格。
     *
     * 这里要的是调用方能算出的确定值，而不是量出来的 —— 单元格会被同行更高的
     * 兄弟拉伸，量到的是行高而不是自身内容高度，测不出「谁比谁高多少」。
     */
    itemExtra?: (item: T) => number
  }>(),
  {
    estimatedHeight: 320,
    minColumnWidth: 320,
    gap: 14,
    bufferRows: 2,
    itemKey: undefined,
    itemExtra: undefined
  }
)

const viewport = ref<HTMLElement | null>(null)
const grid = ref<HTMLElement | null>(null)

const viewportWidth = ref(0)
const viewportHeight = ref(0)
const scrollTop = ref(0)
const itemHeight = ref(props.estimatedHeight)
/** 首帧还没量到真实高度时不锁定单元格高度，量完再锁 */
const measured = ref(false)

const columns = computed(() => {
  const w = viewportWidth.value
  if (!w) return 1
  return Math.max(1, Math.floor((w + props.gap) / (props.minColumnWidth + props.gap)))
})

const totalRows = computed(() => Math.ceil(props.items.length / columns.value))

/** 每行额外需要的高度：取该行各单元格的最大值，没传 itemExtra 时恒为 0 */
const rowExtras = computed<number[]>(() => {
  const rows = totalRows.value
  const list = new Array<number>(rows).fill(0)
  const extraOf = props.itemExtra
  if (!extraOf) return list

  const cols = columns.value
  const count = props.items.length
  for (let row = 0; row < rows; row++) {
    let max = 0
    const end = Math.min(count, (row + 1) * cols)
    for (let i = row * cols; i < end; i++) max = Math.max(max, extraOf(props.items[i]) || 0)
    list[row] = max
  }
  return list
})

/**
 * 每行顶边的 y 偏移，前缀和。
 * 长度为 rows + 1，最后一项就是画布总高度（末行不带 gap）。
 * 行高不再统一，所以不能用除法反推首行，改成对这张表二分。
 */
const rowOffsets = computed<number[]>(() => {
  const rows = totalRows.value
  const extras = rowExtras.value
  const base = itemHeight.value
  const offsets = new Array<number>(rows + 1)
  let y = 0
  for (let row = 0; row < rows; row++) {
    offsets[row] = y
    y += base + extras[row] + props.gap
  }
  offsets[rows] = Math.max(0, y - props.gap)
  return offsets
})

const totalHeight = computed(() => rowOffsets.value[totalRows.value] ?? 0)

/** 落在给定 y 上的行号 */
function rowAt(y: number): number {
  const offsets = rowOffsets.value
  let lo = 0
  let hi = totalRows.value - 1
  let hit = 0
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (offsets[mid] <= y) {
      hit = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return hit
}

const firstVisibleRow = computed(() => rowAt(scrollTop.value))
const startRow = computed(() => Math.max(0, firstVisibleRow.value - props.bufferRows))
const endRow = computed(() => {
  const offsets = rowOffsets.value
  const bottom = scrollTop.value + viewportHeight.value
  let row = firstVisibleRow.value
  // 行高不等，只能顺着偏移表往下走；循环次数就是视口里的行数
  while (row < totalRows.value && offsets[row] < bottom) row++
  return Math.min(totalRows.value, row + props.bufferRows)
})

const startIndex = computed(() => startRow.value * columns.value)
const endIndex = computed(() => Math.min(props.items.length, endRow.value * columns.value))
const visibleItems = computed(() => props.items.slice(startIndex.value, endIndex.value))

const gridStyle = computed(() => ({
  transform: `translateY(${rowOffsets.value[startRow.value] ?? 0}px)`,
  gridTemplateColumns: `repeat(${columns.value}, minmax(0, 1fr))`,
  gap: `${props.gap}px`
}))

function keyOf(item: T, offset: number): string | number {
  const index = startIndex.value + offset
  return props.itemKey ? props.itemKey(item, index) : index
}

/** 可见单元格所在的行号：可见区正好从 startRow 整行开始 */
function rowOfOffset(offset: number): number {
  return startRow.value + Math.floor(offset / columns.value)
}

/**
 * 单元格最小高度 = 基础高度 + 所在行的额外高度。
 * 首帧还没量到真实高度时不锁高，让内容自然铺开，量完再锁。
 */
function cellStyle(offset: number): Record<string, string> | undefined {
  if (!measured.value) return undefined
  const extra = rowExtras.value[rowOfOffset(offset)] ?? 0
  return { minHeight: `${itemHeight.value + extra}px` }
}

// ============ 滚动 ============

let ticking = false
function onScroll(): void {
  if (ticking) return
  ticking = true
  requestAnimationFrame(() => {
    scrollTop.value = viewport.value?.scrollTop ?? 0
    ticking = false
  })
}

function scrollToTop(): void {
  viewport.value?.scrollTo({ top: 0 })
  scrollTop.value = 0
}

defineExpose({ scrollToTop })

// ============ 尺寸测量 ============

/**
 * 校正基础行高。
 *
 * 取可见单元格里内容最高的那个：卡片内容行数可能不同（多一条额度明细就高一截），
 * 只看第一个会让更高的行重叠到下一行。首帧不给单元格 min-height，
 * 这样量到的是内容自然高度；之后只允许变高，避免来回抖动导致滚动位置跳。
 *
 * 量到的是单元格盒子高度，加高行里的单元格会被撑到「基础 + 额外」那么高，
 * 所以要先把所在行的额外高度减掉，否则加高行会把基础高度一路顶上去，
 * 最后所有行都变高 —— 那正是这套 itemExtra 想避免的事。
 */
function measure(): void {
  const el = grid.value
  if (!el || el.children.length === 0) return

  let max = 0
  const children = Array.from(el.children) as HTMLElement[]
  for (let i = 0; i < children.length; i++) {
    const extra = rowExtras.value[rowOfOffset(i)] ?? 0
    max = Math.max(max, children[i].scrollHeight - extra)
  }
  if (max <= 0) return

  if (!measured.value) {
    itemHeight.value = max
    measured.value = true
  } else if (max > itemHeight.value + 1) {
    itemHeight.value = max
  }
}

let viewportObserver: ResizeObserver | null = null
let gridObserver: ResizeObserver | null = null

onMounted(() => {
  const el = viewport.value
  if (!el) return

  viewportObserver = new ResizeObserver(() => {
    viewportWidth.value = el.clientWidth
    viewportHeight.value = el.clientHeight
  })
  viewportObserver.observe(el)
  viewportWidth.value = el.clientWidth
  viewportHeight.value = el.clientHeight

  // 内容变高会带动 grid 尺寸变化，借此触发一次校正
  if (grid.value) {
    gridObserver = new ResizeObserver(() => measure())
    gridObserver.observe(grid.value)
  }
  void nextTick(measure)
})

onBeforeUnmount(() => {
  viewportObserver?.disconnect()
  gridObserver?.disconnect()
})

// 列数变化时卡片宽度变了，内容换行情况可能不同，重新量一次
watch(columns, () => void nextTick(measure))

/*
 * 视口宽度变化后重量一次，并且允许「变矮」。
 *
 * 单元格高度可能是随宽度变的：列表形态的卡片窄屏折行、宽屏收回一行。
 * 而 measure() 平时只允许变高（避免行高来回跳导致滚动位置乱窜），
 * 光调用它的话，窗口拉窄再拉回来，行高会一直卡在最宽的那个值上。
 *
 * 所以这里先把 measured 放掉：那一帧单元格不带 min-height、恢复自然高度，
 * 量到的就是当前宽度下的真实高度。拖动窗口会连续触发，用定时器等它停下来。
 */
let remeasureTimer: ReturnType<typeof setTimeout> | undefined

watch(viewportWidth, () => {
  if (remeasureTimer) clearTimeout(remeasureTimer)
  remeasureTimer = setTimeout(() => {
    measured.value = false
    void nextTick(measure)
  }, 150)
})

onBeforeUnmount(() => {
  if (remeasureTimer) clearTimeout(remeasureTimer)
})
</script>

<template>
  <div ref="viewport" class="vg-viewport" @scroll.passive="onScroll">
    <div class="vg-canvas" :style="{ height: `${totalHeight}px` }">
      <div ref="grid" class="vg-grid" :style="gridStyle">
        <div
          v-for="(item, i) in visibleItems"
          :key="keyOf(item, i)"
          class="vg-cell"
          :style="cellStyle(i)"
        >
          <slot :item="item" :index="startIndex + i" />
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.vg-viewport {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  /* hover 时卡片会上移并带投影，留点内边距免得被裁掉 */
  padding: 3px 3px 8px;
}

.vg-canvas {
  position: relative;
  width: 100%;
}

.vg-grid {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  display: grid;
  /* 平移整块可见区域，比逐格定位省一大截重排 */
  will-change: transform;
}

.vg-cell {
  display: flex;
  min-width: 0;
  /*
   * 单元格同时是尺寸查询容器：插槽里的卡片可以按「自己实际拿到的宽度」分档排版
   * （见账号 / API Key 卡片里的 @container）。
   * 不用媒体查询是因为侧栏能折叠、列数也会变，窗口宽度并不等于单元格宽度。
   */
  container-type: inline-size;
}

/* 让插槽内容撑满单元格，同排卡片高度一致 */
.vg-cell > :deep(*) {
  flex: 1 1 auto;
  min-width: 0;
}
</style>
