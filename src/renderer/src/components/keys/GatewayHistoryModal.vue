<script setup lang="ts">
/**
 * 网关调用历史：请求量 / 成功率 / 积分消耗三条曲线 + 明细表。
 *
 * 数据来自主进程按分钟聚合的时间序列（见 gatewayHistory），
 * 与账号积分历史弹窗保持同样的观感与交互。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { message } from 'ant-design-vue'
import { ReloadOutlined } from '@ant-design/icons-vue'
import { useKeysStore } from '@/stores/keys'
import { useSettingsStore } from '@/stores/settings'
import { confirmDanger } from '@/utils/ui'
import { smoothLinePath } from '@/utils/chart'
import { displayNote } from '@/utils/display'
import { formatDateTime } from '@/utils/format'
import type { GatewayCallPoint, KeyEntry } from '@shared/types'

const props = defineProps<{
  keyEntry: KeyEntry | null
  /** 打开时聚焦哪个指标：请求量或积分 */
  metric: 'requests' | 'credits'
}>()
const emit = defineEmits<{ close: [] }>()
const keysStore = useKeysStore()
const settingsStore = useSettingsStore()

const points = ref<GatewayCallPoint[]>([])
const loading = ref(false)
/** 当前展示哪条曲线，打开时取 props.metric，之后可在弹窗内切换 */
const view = ref<'requests' | 'successRate' | 'credits'>('requests')

const title = computed(() => {
  if (!props.keyEntry) return '网关调用历史'
  // 备注同样受隐私打码约束，否则这里会把卡片上遮住的备注原样显示出来
  const label =
    displayNote(props.keyEntry.note, settingsStore.settings.privacyMode) || maskedKey.value
  return `网关调用历史 · ${label}`
})
const maskedKey = computed(() => {
  const key = props.keyEntry?.key || ''
  if (!key) return ''
  return settingsStore.settings.privacyMode ? `${key.slice(0, 8)}…${key.slice(-4)}` : key
})

async function load(): Promise<void> {
  const entry = props.keyEntry
  if (!entry) return
  loading.value = true
  try {
    const res = await window.api.getKeyGatewayHistory(entry.id)
    points.value = res.success && res.data ? res.data : []
  } finally {
    loading.value = false
  }
}

watch(
  () => props.keyEntry?.id,
  (id) => {
    if (!id) return
    view.value = props.metric === 'credits' ? 'credits' : 'requests'
    void load()
  },
  { immediate: true }
)

// ============ 汇总 ============

const summary = computed(() => {
  const list = points.value
  let requests = 0
  let succeeded = 0
  let credits = 0
  for (const p of list) {
    // 与表格同样的钳制，避免旧数据把汇总也算成负失败数
    requests += Math.max(p.requests, p.succeeded)
    succeeded += Math.min(p.succeeded, Math.max(p.requests, p.succeeded))
    credits += p.credits
  }
  return {
    requests,
    succeeded,
    failed: requests - succeeded,
    credits,
    rate: requests ? (succeeded / requests) * 100 : 0,
    /** 有请求的分钟数，用于算平均速率 */
    activeMinutes: list.filter((p) => p.requests > 0).length
  }
})

const avgRpm = computed(() =>
  summary.value.activeMinutes ? summary.value.requests / summary.value.activeMinutes : 0
)

// ============ 曲线 ============

const chartBox = ref<HTMLElement | null>(null)
const chartWidth = ref(760)
const CHART_HEIGHT = 220
// y 轴标签仍在绘图区外，但比通用用量图更紧凑，给曲线留出更多横向空间。
const PAD = { top: 14, right: 16, bottom: 26, left: 44 }

const observer = new ResizeObserver((records) => {
  const width = records[0]?.contentRect.width
  if (width) chartWidth.value = width
})
watch(chartBox, (el, prev) => {
  if (prev) observer.unobserve(prev)
  if (el) observer.observe(el)
})
onBeforeUnmount(() => observer.disconnect())

/** 当前视图下每个点的取值与格式化方式 */
const viewMeta = computed(() => {
  if (view.value === 'credits') {
    return {
      value: (p: GatewayCallPoint) => p.credits,
      format: (v: number) => v.toFixed(2),
      color: '#722ed1',
      label: '积分消耗'
    }
  }
  if (view.value === 'successRate') {
    return {
      // 该分钟没有请求时按 100% 处理，避免曲线掉到 0 造成误读；
      // 同时钳制到 100 以内，旧数据里可能有成功数超过请求数的脏点
      value: (p: GatewayCallPoint) => {
        const total = Math.max(p.requests, p.succeeded)
        return total ? Math.min(100, (p.succeeded / total) * 100) : 100
      },
      format: (v: number) => `${v.toFixed(2)}%`,
      color: '#52c41a',
      label: '成功率'
    }
  }
  return {
    value: (p: GatewayCallPoint) => p.requests,
    format: (v: number) => String(Math.round(v)),
    color: '#1677ff',
    label: '请求数'
  }
})

interface Plotted {
  x: number
  y: number
  point: GatewayCallPoint
}

const plot = computed(() => {
  const list = points.value
  const innerW = Math.max(80, chartWidth.value - PAD.left - PAD.right)
  const innerH = CHART_HEIGHT - PAD.top - PAD.bottom
  const empty = { points: [] as Plotted[], line: '', area: '', yTicks: [], xTicks: [], innerW, innerH }
  if (!list.length) return empty

  const meta = viewMeta.value
  const values = list.map(meta.value)
  const maxValue = Math.max(...values, 0)
  // 成功率固定 0-100，其余按数据上界留 15% 余量
  const top = view.value === 'successRate' ? 100 : maxValue > 0 ? maxValue * 1.15 : 1
  const times = list.map((p) => p.at)
  const minTime = Math.min(...times)
  const maxTime = Math.max(...times)
  const span = maxTime - minTime || 1

  const plotted: Plotted[] = list.map((point) => ({
    x: PAD.left + ((point.at - minTime) / span) * innerW,
    y: PAD.top + innerH - (meta.value(point) / top) * innerH,
    point
  }))
  if (plotted.length === 1) plotted[0].x = PAD.left + innerW / 2

  const line = smoothLinePath(plotted)
  const baseY = PAD.top + innerH
  const area = `${line} L${plotted.at(-1)!.x.toFixed(2)},${baseY} L${plotted[0].x.toFixed(2)},${baseY} Z`

  const yTicks = Array.from({ length: 5 }, (_, i) => {
    const ratio = i / 4
    return { y: PAD.top + innerH - ratio * innerH, label: meta.format(top * ratio) }
  })

  const tickCount = Math.min(5, list.length)
  const xTicks = Array.from({ length: tickCount }, (_, i) => {
    const ratio = tickCount === 1 ? 0.5 : i / (tickCount - 1)
    const at = minTime + span * ratio
    return {
      x: PAD.left + ratio * innerW,
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

  return { points: plotted, line, area, yTicks, xTicks, innerW, innerH }
})

const hoverIndex = ref<number | null>(null)
const hoverPoint = computed(() =>
  hoverIndex.value === null ? null : (plot.value.points[hoverIndex.value] ?? null)
)

function onMove(event: MouseEvent): void {
  const list = plot.value.points
  if (!list.length) return
  const rect = (event.currentTarget as SVGElement).getBoundingClientRect()
  const x = ((event.clientX - rect.left) / rect.width) * chartWidth.value
  let best = 0
  for (let i = 1; i < list.length; i++) {
    if (Math.abs(list[i].x - x) < Math.abs(list[best].x - x)) best = i
  }
  hoverIndex.value = best
}

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

// ============ 明细表 ============

/**
 * 1.0.11 之前落盘的数据里，请求按发起时间归桶、结果按响应时间归桶，跨分钟的请求
 * 会让某些桶出现「成功 > 请求」，直接算会得到 -1 的失败数与 150% 的成功率。
 * 所以展示层做钳制：请求数至少取成功数，失败不小于 0，成功率不超过 100%。
 */
const rows = computed(() =>
  points.value
    .map((p, index) => {
      const requests = Math.max(p.requests, p.succeeded)
      const succeeded = Math.min(p.succeeded, requests)
      return {
        key: `${p.at}-${index}`,
        at: p.at,
        credits: p.credits,
        requests,
        succeeded,
        failed: requests - succeeded,
        rate: requests ? (succeeded / requests) * 100 : null
      }
    })
    .reverse()
)

const columns = [
  { title: '时间（按分钟）', key: 'at', dataIndex: 'at', width: 170 },
  { title: '请求', key: 'requests', dataIndex: 'requests', width: 80, align: 'right' as const },
  { title: '成功', key: 'succeeded', dataIndex: 'succeeded', width: 80, align: 'right' as const },
  { title: '失败', key: 'failed', dataIndex: 'failed', width: 80, align: 'right' as const },
  { title: '成功率', key: 'rate', dataIndex: 'rate', width: 100, align: 'right' as const },
  { title: '积分', key: 'credits', dataIndex: 'credits', width: 100, align: 'right' as const }
]

function reset(): void {
  const entry = props.keyEntry
  if (!entry) return
  confirmDanger({
    title: '清空该 Key 的网关统计',
    content: '会同时清掉累计的请求数、成功率与积分消耗，以及全部历史曲线。此操作不可撤销。',
    okText: '清空',
    onOk: async () => {
      await keysStore.resetStats(entry.id)
      points.value = []
      message.success('已清空该 Key 的网关统计')
    }
  })
}
</script>

<template>
  <a-modal
    :open="!!keyEntry"
    :title="title"
    :width="920"
    centered
    :footer="null"
    class="gw-history-modal"
    :body-style="{
      height: 'clamp(520px, calc(100dvh - 104px), 760px)',
      minHeight: '520px',
      display: 'flex',
      flexDirection: 'column',
      gap: '12px',
      paddingTop: '8px',
      overflow: 'hidden',
      boxSizing: 'border-box'
    }"
    @cancel="emit('close')"
  >
    <div class="gw-body">
      <div class="summary">
        <div class="sum-cell">
          <span class="muted">对话请求</span>
          <strong>{{ summary.requests }}</strong>
        </div>
        <div class="sum-cell">
          <span class="muted">成功 / 失败</span>
          <strong>
            <span style="color: #52c41a">{{ summary.succeeded }}</span>
            /
            <span :style="{ color: summary.failed ? '#ff4d4f' : 'inherit' }">{{ summary.failed }}</span>
          </strong>
        </div>
        <div class="sum-cell">
          <span class="muted">成功率</span>
          <strong>{{ summary.requests ? summary.rate.toFixed(2) + '%' : '-' }}</strong>
        </div>
        <div class="sum-cell">
          <span class="muted">累计积分</span>
          <strong>{{ summary.credits.toFixed(2) }}</strong>
        </div>
        <div class="sum-cell">
          <span class="muted">活跃分钟内均值</span>
          <strong>{{ avgRpm ? avgRpm.toFixed(1) : '-' }}<small> 次/分</small></strong>
        </div>
      </div>

      <div class="toolbar">
        <a-radio-group v-model:value="view" size="small" button-style="solid">
          <a-radio-button value="requests">请求数</a-radio-button>
          <a-radio-button value="successRate">成功率</a-radio-button>
          <a-radio-button value="credits">积分消耗</a-radio-button>
        </a-radio-group>
        <span class="spacer" />
        <a-button size="small" :loading="loading" @click="load">
          <template #icon><ReloadOutlined /></template>
          刷新
        </a-button>
        <a-button size="small" danger :disabled="!points.length" @click="reset">清空</a-button>
      </div>

      <div ref="chartBox" class="chart-box">
        <svg
          v-if="plot.points.length"
          class="chart"
          :viewBox="`0 0 ${chartWidth} ${CHART_HEIGHT}`"
          :height="CHART_HEIGHT"
          preserveAspectRatio="none"
          @mousemove="onMove"
          @mouseleave="hoverIndex = null"
        >
          <defs>
            <linearGradient id="gw-area" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" :stop-color="viewMeta.color" stop-opacity="0.26" />
              <stop offset="100%" :stop-color="viewMeta.color" stop-opacity="0.02" />
            </linearGradient>
          </defs>

          <line
            v-for="tick in plot.yTicks"
            :key="`g${tick.y}`"
            :x1="PAD.left"
            :x2="chartWidth - PAD.right"
            :y1="tick.y"
            :y2="tick.y"
            class="grid"
          />
          <text
            v-for="tick in plot.yTicks"
            :key="`yt${tick.y}`"
            :x="PAD.left - 4"
            :y="tick.y + 3"
            class="axis"
            text-anchor="end"
          >{{ tick.label }}</text>
          <text
            v-for="tick in plot.xTicks"
            :key="`xt${tick.x}`"
            :x="tick.x"
            :y="CHART_HEIGHT - 8"
            class="axis"
            :text-anchor="tick.anchor"
          >{{ tick.label }}</text>

          <path :d="plot.area" fill="url(#gw-area)" />
          <path
            :d="plot.line"
            fill="none"
            :stroke="viewMeta.color"
            stroke-width="1.8"
            stroke-linejoin="round"
          />
          <template v-if="hoverPoint">
            <line
              :x1="hoverPoint.x"
              :x2="hoverPoint.x"
              :y1="PAD.top"
              :y2="PAD.top + plot.innerH"
              class="cursor-line"
            />
            <circle :cx="hoverPoint.x" :cy="hoverPoint.y" r="3.5" :fill="viewMeta.color" />
          </template>
        </svg>

        <div v-else class="chart-empty muted">
          {{ loading ? '正在读取…' : '该 Key 还没有经网关产生过调用' }}
        </div>

        <div v-if="hoverPoint" class="chart-tip" :style="tooltipStyle">
          <div class="tip-time">{{ formatDateTime(hoverPoint.point.at) }}</div>
          <div>请求 {{ hoverPoint.point.requests }} · 成功 {{ hoverPoint.point.succeeded }}</div>
          <div>积分 {{ hoverPoint.point.credits.toFixed(2) }}</div>
        </div>
      </div>

      <div class="table-wrap">
        <a-table
          :columns="columns"
          :data-source="rows"
          size="small"
          :pagination="{ pageSize: 20, size: 'small', showSizeChanger: false, hideOnSinglePage: true }"
          :scroll="{ y: '100%' }"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'at'">{{ formatDateTime(record.at) }}</template>
            <template v-else-if="column.key === 'rate'">
              <span v-if="record.rate === null" class="muted">-</span>
              <span v-else :style="{ color: record.rate >= 95 ? '#52c41a' : record.rate >= 80 ? '#faad14' : '#ff4d4f' }">
                {{ record.rate.toFixed(2) }}%
              </span>
            </template>
            <template v-else-if="column.key === 'failed'">
              <span :style="{ color: record.failed ? '#ff4d4f' : 'inherit' }">{{ record.failed }}</span>
            </template>
            <template v-else-if="column.key === 'credits'">{{ record.credits.toFixed(2) }}</template>
          </template>
        </a-table>
      </div>
    </div>
  </a-modal>
</template>

<style scoped>
/*
 * 高度由 modal 的 body-style 限定，这里负责把空间分给三块：
 * 汇总与工具栏固定高度，图表固定高度，表格吃掉剩余空间并在内部滚动。
 * 关键是 min-height: 0——没有它，flex 子项会被内容撑开导致整体溢出弹窗。
 */
.gw-body { display: flex; flex-direction: column; gap: 12px; flex: 1 1 0; min-height: 0; }
.summary { display: grid; grid-template-columns: repeat(5, 1fr); gap: 8px; flex: 0 0 auto; }
.sum-cell {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 10px;
  border-radius: 10px;
  background: var(--kal-block-bg);
  font-size: 12px;
}
.sum-cell strong { font-size: 16px; font-variant-numeric: tabular-nums; }
.sum-cell small { font-size: 11px; font-weight: 400; color: var(--kal-muted); }
.toolbar { display: flex; align-items: center; gap: 8px; flex: 0 0 auto; }
.spacer { flex: 1 1 auto; }
.chart-box { position: relative; flex: 0 0 auto; }
.chart { display: block; width: 100%; }
.grid { stroke: var(--kal-border); stroke-width: 1; }
.axis { fill: var(--kal-muted); font-size: 10px; }
.cursor-line { stroke: var(--kal-muted); stroke-width: 1; stroke-dasharray: 3 3; }
.chart-empty { display: flex; align-items: center; justify-content: center; height: 220px; }
.chart-tip {
  position: absolute;
  z-index: 2;
  padding: 6px 9px;
  border-radius: 8px;
  background: var(--kal-tip-bg, rgba(0, 0, 0, 0.82));
  color: #fff;
  font-size: 12px;
  line-height: 1.6;
  pointer-events: none;
  white-space: nowrap;
}
.tip-time { margin-bottom: 2px; opacity: 0.8; }
/*
 * 表格吃掉剩余高度。整条 flex 链都要 min-height: 0，
 * 否则表体按内容高度撑开，分页会被顶到弹窗外面。
 */
.table-wrap { flex: 1 1 0; min-height: 0; overflow: hidden; display: flex; flex-direction: column; }
.table-wrap :deep(.ant-table-wrapper) { flex: 1 1 0; min-height: 0; display: flex; flex-direction: column; }
.table-wrap :deep(.ant-spin-nested-loading) { flex: 1 1 0; min-height: 0; display: flex; flex-direction: column; }
.table-wrap :deep(.ant-spin-container) { flex: 1 1 0; min-height: 0; display: flex; flex-direction: column; }
.table-wrap :deep(.ant-table) { flex: 1 1 0; min-height: 0; }
.table-wrap :deep(.ant-table-container) { display: flex; flex-direction: column; height: 100%; }
.table-wrap :deep(.ant-table-body) { flex: 1 1 0; min-height: 0; overflow: auto !important; }
/* 表头与分页固定高度，只有表体伸缩并滚动 */
.table-wrap :deep(.ant-table-header),
.table-wrap :deep(.ant-table-pagination) { flex: 0 0 auto; }
.table-wrap :deep(.ant-table-pagination) { margin: 8px 0 0; }
.muted { color: var(--kal-muted); }
</style>
