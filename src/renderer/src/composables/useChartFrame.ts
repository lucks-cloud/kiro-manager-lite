/**
 * 手写 SVG 曲线的公共框架：积分变化（UsageHistoryModal）与网关调用历史（GatewayHistoryModal）共用。
 *
 * 这里管：量容器宽度、悬停命中最近的点、浮层定位，以及 x 轴时间刻度、y 轴等分刻度的生成。
 * 曲线怎么取值、怎么上色、刻度标签怎么格式化由各弹窗自己决定；平滑路径见 utils/chart。
 */
import { computed, onBeforeUnmount, ref, useTemplateRef, watch } from 'vue'

/** 图表固定高度；宽度跟着容器走 */
export const CHART_HEIGHT = 220

/** 绘图区四周留给坐标轴标签的边距 */
export interface ChartPad {
  top: number
  right: number
  bottom: number
  left: number
}

/**
 * points 取当前已换算成画布坐标的点，按需读取（图表数据依赖这里给出的宽度，
 * 调用时它还没算出来）。
 * 图表容器由模板里的 ref="chartBox" 绑定（boxRef 可改名）。
 */
export function useChartFrame<P extends { x: number; y: number }>(
  points: () => P[],
  boxRef = 'chartBox'
) {
  const chartBox = useTemplateRef<HTMLElement>(boxRef)
  const chartWidth = ref(760)

  // 容器宽度随窗口变化，用 ResizeObserver 跟着重算，避免曲线被拉伸
  const observer = new ResizeObserver((records) => {
    const width = records[0]?.contentRect.width
    if (width) chartWidth.value = width
  })
  watch(chartBox, (el, prev) => {
    if (prev) observer.unobserve(prev)
    if (el) observer.observe(el)
  })
  onBeforeUnmount(() => observer.disconnect())

  /** 悬停命中的点索引 */
  const hoverIndex = ref<number | null>(null)
  const hoverPoint = computed(() =>
    hoverIndex.value === null ? null : (points()[hoverIndex.value] ?? null)
  )

  function onMove(event: MouseEvent): void {
    const list = points()
    if (!list.length) return
    const rect = (event.currentTarget as SVGElement).getBoundingClientRect()
    // svg 用的是 1:1 的 viewBox，鼠标坐标直接按缩放比换算即可
    const x = ((event.clientX - rect.left) / rect.width) * chartWidth.value
    let best = 0
    for (let i = 1; i < list.length; i++) {
      if (Math.abs(list[i].x - x) < Math.abs(list[best].x - x)) best = i
    }
    hoverIndex.value = best
  }

  /** 浮层贴着命中点，靠右侧时翻到左边免得被裁掉 */
  const tooltipStyle = computed(() => {
    const point = hoverPoint.value
    if (!point) return {}
    const flip = point.x > chartWidth.value * 0.6
    return {
      left: `${point.x}px`,
      top: `${Math.max(0, point.y - 12)}px`,
      transform: flip ? 'translate(calc(-100% - 10px), -100%)' : 'translate(10px, -100%)'
    }
  })

  return { chartWidth, hoverIndex, hoverPoint, onMove, tooltipStyle }
}

/** y 轴 5 条等分刻度，从底到顶；top 是纵轴上界，标签由调用方格式化 */
export function valueTicks(
  top: number,
  pad: ChartPad,
  innerH: number,
  format: (value: number) => string
): { y: number; label: string }[] {
  return Array.from({ length: 5 }, (_, i) => {
    const ratio = i / 4
    return { y: pad.top + innerH - ratio * innerH, label: format(top * ratio) }
  })
}

/** x 轴时间刻度：最多 5 个，在 [minTime, minTime + span] 上等分；count 为数据点个数 */
export function timeTicks(
  minTime: number,
  span: number,
  count: number,
  pad: ChartPad,
  innerW: number
): { x: number; anchor: string; label: string }[] {
  const tickCount = Math.min(5, count)
  return Array.from({ length: tickCount }, (_, i) => {
    // 只有一个刻度时放在正中间；首尾标签朝绘图区内侧展开，避免完整时间被 SVG 边缘裁切。
    const ratio = tickCount === 1 ? 0.5 : i / (tickCount - 1)
    const at = minTime + span * ratio
    return {
      x: pad.left + ratio * innerW,
      anchor:
        tickCount === 1 ? 'middle' : i === 0 ? 'start' : i === tickCount - 1 ? 'end' : 'middle',
      label: new Date(at).toLocaleString('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
      })
    }
  })
}
