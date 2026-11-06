<script setup lang="ts">
/**
 * 积分变化日志：复用同一套曲线与列表展示账号或 API Key 的用量快照。
 * 曲线用手写 SVG，不引图表库：数据只有一条线，够用且省一个依赖。
 */
import { computed, ref, watch } from 'vue'
import { message } from 'ant-design-vue'
import {
  DeleteOutlined,
  DownloadOutlined,
  LineChartOutlined,
  SyncOutlined
} from '@ant-design/icons-vue'
import { useSettingsStore } from '@/stores/settings'
import { CHART_HEIGHT, timeTicks, useChartFrame, valueTicks } from '@/composables/useChartFrame'
import { formatCredits, formatCreditsPair, formatDateTime, usageColor } from '@/utils/format'
import { displayEmail } from '@/utils/display'
import { smoothLinePath } from '@/utils/chart'
import { exportStamp, safeNamePart } from '@/utils/transfer'
import type { Account, UsageHistoryEntry, XlsxSheet } from '@shared/types'

interface UsageHistorySubject {
  /** 历史存储主体 ID；API Key 使用 key:<id> 命名空间。 */
  id: string
  label: string
  percentUsed: number
  noun?: string
}

const props = defineProps<{
  account?: Account | null
  subject?: UsageHistorySubject | null
}>()
const emit = defineEmits<{ close: [] }>()

const settingsStore = useSettingsStore()
const precision = computed(() => settingsStore.settings.usagePrecision)

const entries = ref<UsageHistoryEntry[]>([])
const loading = ref(false)

const subjectInfo = computed<UsageHistorySubject | null>(() => {
  if (props.subject) return props.subject
  if (!props.account) return null
  return {
    id: props.account.id,
    label: displayEmail(props.account.email, settingsStore.settings.privacyMode),
    percentUsed: props.account.usage.percentUsed ?? 0,
    noun: '账号'
  }
})
const open = computed(() => !!subjectInfo.value)

async function load(): Promise<void> {
  const subject = subjectInfo.value
  if (!subject) return
  loading.value = true
  try {
    const res = await window.api.getUsageHistory(subject.id)
    entries.value = res.success && res.data ? res.data : []
  } finally {
    loading.value = false
  }
}

watch(
  () => subjectInfo.value?.id,
  (id) => {
    entries.value = []
    if (id) void load()
  },
  { immediate: true }
)

async function clearHistory(): Promise<void> {
  const subject = subjectInfo.value
  if (!subject) return
  const res = await window.api.clearUsageHistory(subject.id)
  if (!res.success) return void message.error(res.error || '清空失败')
  entries.value = []
  message.success(`已清空 ${res.data?.cleared ?? 0} 条记录`)
}

// ============ 汇总 ============

const summary = computed(() => {
  const list = entries.value
  if (!list.length) return null
  const first = list[0]
  const last = list.at(-1) as UsageHistoryEntry
  const consumed = list.reduce((total, e) => total + Math.max(0, e.delta), 0)
  return {
    count: list.length,
    from: first.at,
    current: last.current,
    limit: last.limit,
    consumed
  }
})

// ============ 曲线 ============

const PAD = { top: 14, right: 16, bottom: 26, left: 56 }

// 容器宽度（量的是模板里 ref="chartBox" 的元素）、悬停命中与浮层定位见 useChartFrame
const { chartWidth, hoverIndex, hoverPoint, onMove, tooltipStyle } = useChartFrame(
  () => plot.value.points
)

interface Point {
  x: number
  y: number
  entry: UsageHistoryEntry
}

const plot = computed(() => {
  const list = entries.value
  const innerW = Math.max(80, chartWidth.value - PAD.left - PAD.right)
  const innerH = CHART_HEIGHT - PAD.top - PAD.bottom
  if (list.length === 0) return { points: [] as Point[], line: '', area: '', yTicks: [], xTicks: [], innerW, innerH }

  const values = list.map((e) => e.current)
  const maxValue = Math.max(...values, 0)
  // 上界取一点余量，单点或全 0 时给个兜底刻度，避免除零
  const top = maxValue > 0 ? maxValue * 1.15 : 1
  const times = list.map((e) => e.at)
  const minTime = Math.min(...times)
  const maxTime = Math.max(...times)
  const span = maxTime - minTime || 1

  const points: Point[] = list.map((entry) => ({
    x: PAD.left + ((entry.at - minTime) / span) * innerW,
    // 只有一个点时画在中间，视觉上不至于贴边
    y: PAD.top + innerH - (entry.current / top) * innerH,
    entry
  }))
  if (points.length === 1) points[0].x = PAD.left + innerW / 2

  const line = smoothLinePath(points)
  const baseY = PAD.top + innerH
  const area = points.length
    ? `${line} L${points.at(-1)!.x.toFixed(2)},${baseY} L${points[0].x.toFixed(2)},${baseY} Z`
    : ''

  const yTicks = valueTicks(top, PAD, innerH, (value) => formatCredits(value, precision.value))
  const xTicks = timeTicks(minTime, span, list.length, PAD, innerW)

  return { points, line, area, yTicks, xTicks, innerW, innerH }
})

const lineColor = computed(() => usageColor(subjectInfo.value?.percentUsed ?? 0))

// ============ 列表 ============

/** 最新的排在最前面 */
const rows = computed(() =>
  entries.value
    .map((entry, index) => ({ key: `${entry.at}-${index}`, ...entry }))
    .reverse()
)

const columns = [
  { title: '时间', key: 'at', dataIndex: 'at', width: 170 },
  { title: '已用积分', key: 'current', dataIndex: 'current', width: 110, align: 'right' as const },
  { title: '变化', key: 'delta', dataIndex: 'delta', width: 100, align: 'right' as const },
  { title: '占比', key: 'percentUsed', dataIndex: 'percentUsed', width: 90, align: 'right' as const },
  { title: '额度构成', key: 'breakdown', dataIndex: 'breakdown' }
]

function deltaText(value: number): string {
  if (!value) return '—'
  return `${value > 0 ? '+' : ''}${formatCredits(value, precision.value)}`
}

/** 额度构成列一行要塞下三段，用紧凑写法（不带空格） */
function breakdownText(entry: UsageHistoryEntry): string {
  const parts: string[] = []
  const p = precision.value
  const pair = (current?: number, limit?: number): string =>
    formatCreditsPair(current, limit, p, true)
  if (entry.baseLimit) parts.push(`基础 ${pair(entry.baseCurrent, entry.baseLimit)}`)
  if (entry.freeTrialLimit) parts.push(`试用 ${pair(entry.freeTrialCurrent, entry.freeTrialLimit)}`)
  if (entry.bonusLimit) parts.push(`奖励 ${pair(entry.bonusCurrent, entry.bonusLimit)}`)
  return parts.join(' · ') || '—'
}

// ============ 导出 ============

const exporting = ref(false)

/** 文件名：带上主体名便于辨认，认不出的名字（纯中文、打码串）就只留时间戳 */
function exportFilename(): string {
  const name = safeNamePart(subjectInfo.value?.label || '')
  return `kiro-usage-${name ? `${name}-` : ''}${exportStamp()}.xlsx`
}

/**
 * 导出为 xlsx：列与界面表格保持一致，但写入原始数值而非格式化字符串，
 * 这样在 Excel 里还能直接排序、求和、画图。
 */
async function exportXlsx(): Promise<void> {
  if (!rows.value.length || exporting.value) return
  const decimals = precision.value ? 2 : 0
  const sheet: XlsxSheet = {
    name: '积分变化',
    columns: [
      { title: '时间', width: 21, format: 'datetime' },
      { title: '已用积分', width: 13, format: 'number', decimals },
      { title: '总额度', width: 13, format: 'number', decimals },
      { title: '变化', width: 11, format: 'number', decimals },
      { title: '占比', width: 10, format: 'percent', decimals: 2 },
      { title: '额度构成', width: 46 }
    ],
    rows: rows.value.map((entry) => [
      entry.at,
      entry.current,
      entry.limit,
      entry.delta,
      entry.percentUsed || 0,
      breakdownText(entry)
    ])
  }

  exporting.value = true
  try {
    const res = await window.api.exportToXlsx(sheet, exportFilename())
    if (!res.success) return void message.error(res.error || '导出失败')
    if (res.data?.saved) message.success(`已导出 ${sheet.rows.length} 条记录`)
  } finally {
    exporting.value = false
  }
}
</script>

<template>
  <a-modal
    :open="open"
    width="900px"
    :footer="null"
    centered
    :body-style="{
      height: 'clamp(560px, calc(100dvh - 72px), 900px)',
      minHeight: '560px',
      display: 'flex',
      flexDirection: 'column',
      gap: '12px',
      paddingTop: '8px',
      overflow: 'hidden',
      boxSizing: 'border-box'
    }"
    @cancel="emit('close')"
  >
    <template #title>
      <span class="title">
        <LineChartOutlined />
        积分变化
        <a-tag style="margin: 0">{{ subjectInfo?.label }}</a-tag>
      </span>
    </template>

    <div class="toolbar">
      <div class="summary">
        <template v-if="summary">
          <span>
            共 <strong>{{ summary.count }}</strong> 条记录
          </span>
          <span class="muted">
            {{ formatDateTime(summary.from) }} 起
          </span>
          <span>
            期间累计消耗
            <strong :style="{ color: lineColor }">{{ formatCredits(summary.consumed, precision) }}</strong>
          </span>
          <span class="muted">
            最新 {{ formatCreditsPair(summary.current, summary.limit, precision) }}
          </span>
        </template>
        <span v-else class="muted">还没有记录，刷新一次用量后就会开始累积</span>
      </div>
      <a-space>
        <a-tooltip title="导出为 Excel 表格">
          <a-button
            size="small"
            :loading="exporting"
            :disabled="!entries.length"
            @click="exportXlsx"
          >
            <template #icon><DownloadOutlined /></template>
          </a-button>
        </a-tooltip>
        <a-tooltip title="重新读取日志">
          <a-button size="small" :loading="loading" @click="load">
            <template #icon><SyncOutlined /></template>
          </a-button>
        </a-tooltip>
        <a-popconfirm
          :title="`清空该${subjectInfo?.noun || '主体'}的全部积分日志？`"
          ok-text="清空"
          cancel-text="取消"
          @confirm="clearHistory"
        >
          <a-button size="small" danger :disabled="!entries.length">
            <template #icon><DeleteOutlined /></template>
          </a-button>
        </a-popconfirm>
      </a-space>
    </div>

    <div ref="chartBox" class="chart-box">
      <svg
        v-if="entries.length"
        class="chart"
        :viewBox="`0 0 ${chartWidth} ${CHART_HEIGHT}`"
        :style="{ height: `${CHART_HEIGHT}px` }"
        @mousemove="onMove"
        @mouseleave="hoverIndex = null"
      >
        <defs>
          <linearGradient id="usage-area" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" :stop-color="lineColor" stop-opacity="0.28" />
            <stop offset="100%" :stop-color="lineColor" stop-opacity="0.02" />
          </linearGradient>
        </defs>

        <!-- 横向网格与 y 轴刻度 -->
        <g class="grid">
          <template v-for="tick in plot.yTicks" :key="tick.label">
            <line :x1="PAD.left" :y1="tick.y" :x2="PAD.left + plot.innerW" :y2="tick.y" />
            <text :x="PAD.left - 8" :y="tick.y + 3.5" text-anchor="end">{{ tick.label }}</text>
          </template>
        </g>

        <!-- x 轴时间刻度 -->
        <g class="grid">
          <text
            v-for="tick in plot.xTicks"
            :key="tick.label"
            :x="tick.x"
            :y="CHART_HEIGHT - 8"
            :text-anchor="tick.anchor"
          >
            {{ tick.label }}
          </text>
        </g>

        <path :d="plot.area" fill="url(#usage-area)" />
        <path :d="plot.line" fill="none" :stroke="lineColor" stroke-width="1.8" stroke-linejoin="round" />

        <!-- 数据点稀疏时标出来，密集时只靠曲线 -->
        <template v-if="plot.points.length <= 60">
          <circle
            v-for="(p, i) in plot.points"
            :key="i"
            :cx="p.x"
            :cy="p.y"
            r="2.4"
            :fill="lineColor"
          />
        </template>

        <g v-if="hoverPoint">
          <line
            class="kal-chart-cursor"
            :x1="hoverPoint.x"
            :y1="PAD.top"
            :x2="hoverPoint.x"
            :y2="PAD.top + plot.innerH"
          />
          <circle :cx="hoverPoint.x" :cy="hoverPoint.y" r="4" fill="#fff" :stroke="lineColor" stroke-width="2" />
        </g>
      </svg>

      <div v-else class="chart-empty muted">
        <LineChartOutlined />
        暂无积分变化记录
      </div>

      <div v-if="hoverPoint" class="tooltip" :style="tooltipStyle">
        <div class="tooltip-time">{{ formatDateTime(hoverPoint.entry.at) }}</div>
        <div>
          已用 <strong>{{ formatCredits(hoverPoint.entry.current, precision) }}</strong>
          / {{ formatCredits(hoverPoint.entry.limit, precision) }}
        </div>
        <div>
          变化
          <strong :class="hoverPoint.entry.delta > 0 ? 'up' : hoverPoint.entry.delta < 0 ? 'down' : ''">
            {{ deltaText(hoverPoint.entry.delta) }}
          </strong>
        </div>
      </div>
    </div>

    <div class="table-box">
      <a-table
        :columns="columns"
        :data-source="rows"
        :loading="loading"
        size="small"
        :pagination="{ pageSize: 20, size: 'small', showSizeChanger: false, hideOnSinglePage: true }"
        :scroll="{ x: 760, y: '100%' }"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'at'">{{ formatDateTime(record.at) }}</template>
          <template v-else-if="column.key === 'current'">
            {{ formatCredits(record.current, precision) }}
          </template>
          <template v-else-if="column.key === 'delta'">
            <span :class="record.delta > 0 ? 'up' : record.delta < 0 ? 'down' : 'muted'">
              {{ deltaText(record.delta) }}
            </span>
          </template>
          <template v-else-if="column.key === 'percentUsed'">
            {{ ((record.percentUsed || 0) * 100).toFixed(2) }}%
          </template>
          <template v-else-if="column.key === 'breakdown'">
            <span class="muted">{{ breakdownText(record) }}</span>
          </template>
        </template>
      </a-table>
    </div>
  </a-modal>
</template>

<style scoped>
.title {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex: 0 0 auto;
}

.summary {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 14px;
  font-size: 12.5px;
  min-width: 0;
}

.chart-box {
  position: relative;
  flex: 0 0 auto;
  padding: 4px 0;
  border-radius: 12px;
  background: var(--kal-block-bg);
}

.chart {
  display: block;
  width: 100%;
}

.chart-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  height: 220px;
  font-size: 13px;
}

.grid line {
  stroke: var(--kal-border);
  stroke-width: 1;
}

.grid text {
  fill: var(--kal-muted);
  font-size: 10.5px;
}

/* 悬停竖线 .kal-chart-cursor 与网关调用历史共用，在 assets/styles.css */

.tooltip {
  position: absolute;
  z-index: 2;
  pointer-events: none;
  padding: 6px 10px;
  border-radius: 8px;
  border: 1px solid var(--kal-border);
  background: var(--kal-card-bg);
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.12);
  font-size: 12px;
  line-height: 1.6;
  white-space: nowrap;
}

.tooltip-time {
  color: var(--kal-muted);
  font-size: 11px;
}

/* 列表至少保留表头和数行数据的空间；窗口不足时由 Modal 外层滚动。 */
.table-box {
  flex: 1 0 260px;
  min-height: 260px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.table-box :deep(.ant-table-wrapper),
.table-box :deep(.ant-spin-nested-loading),
.table-box :deep(.ant-spin-container),
.table-box :deep(.ant-table),
.table-box :deep(.ant-table-container) {
  display: flex;
  flex: 1 1 0;
  min-height: 0;
  flex-direction: column;
}

.table-box :deep(.ant-table-header),
.table-box :deep(.ant-table-pagination) {
  flex: 0 0 auto;
}

/* 表头保持固定高度，只有表体占用剩余空间并滚动。 */
.table-box :deep(.ant-table-body) {
  flex: 1 1 0;
  min-height: 0;
  overflow: auto !important;
}

.table-box :deep(.ant-table-pagination) {
  margin: 8px 0 0;
}

.up {
  color: #ff4d4f;
}

.down {
  color: #52c41a;
}
</style>
