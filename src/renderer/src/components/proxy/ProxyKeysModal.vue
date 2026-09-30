<script setup lang="ts">
/**
 * 本地反代的多 API Key 管理。
 *
 * 一个弹窗两层：列表（新建 / 启停 / 删除）→ 点某一行进入详情（总计、每日折线、按模型、明细）。
 * 用同一个弹窗而不是再叠一层：来回看几个 Key 时不用反复开关，
 * 尺寸也固定住，不会因为列表长短忽大忽小。
 *
 * 曲线沿用 UsageHistoryModal 的手写 SVG：只有一条线，引图表库不划算。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { message } from 'ant-design-vue'
import {
  ArrowLeftOutlined,
  CopyOutlined,
  EditOutlined,
  EyeInvisibleOutlined,
  EyeOutlined,
  KeyOutlined,
  LineChartOutlined,
  PlusOutlined,
  ReloadOutlined
} from '@ant-design/icons-vue'
import { useProxyStore } from '@/stores/proxy'
import { smoothLinePath } from '@/utils/chart'
import { formatCredits, formatDateTime } from '@/utils/format'
import { confirmDanger, confirmDelete, copyText } from '@/utils/ui'
import type {
  ProxyApiKeyView,
  ProxyKeyStats,
  ProxyKeyUsage,
  ProxyProtocol
} from '@shared/types'

const emit = defineEmits<{ close: []; changed: [] }>()
const proxyStore = useProxyStore()

const keys = ref<ProxyApiKeyView[]>([])
const loading = ref(false)

async function load(): Promise<void> {
  loading.value = true
  try {
    const res = await window.api.listProxyKeys()
    if (res.success && res.data) keys.value = res.data
    else message.error(res.error || '读取 API Key 失败')
  } finally {
    loading.value = false
  }
}

onMounted(load)

// ============ 新建 ============

const newName = ref('')
/** a-input-number 清空时给 null；null 和 0 都代表不限 */
const newLimit = ref<number | null>(null)
const creating = ref(false)

async function create(): Promise<void> {
  creating.value = true
  try {
    const res = await window.api.createProxyKey({
      name: newName.value.trim() || undefined,
      creditLimit: newLimit.value ?? 0
    })
    if (!res.success || !res.data) return void message.error(res.error || '添加失败')
    newName.value = ''
    newLimit.value = null
    await load()
    // 新建的那条默认露出明文：用户刚建完大概率就要复制
    revealed.value = new Set([...revealed.value, res.data.id])
    message.success(`已添加「${res.data.name}」`)
    emit('changed')
  } finally {
    creating.value = false
  }
}

// ============ 列表 ============

/** 哪些行的明文是露出来的；默认全遮，截图不会一不小心带出去 */
const revealed = ref(new Set<string>())

function toggleReveal(id: string): void {
  const next = new Set(revealed.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  revealed.value = next
}

function maskKey(key: string): string {
  return key.length <= 10 ? '••••••••' : `${key.slice(0, 6)}••••••••${key.slice(-4)}`
}

function limitText(key: ProxyApiKeyView): string {
  return key.creditLimit > 0 ? formatCredits(key.creditLimit, true) : '不限'
}

/** 额度用了多少，进度条用；不限额度返回 null */
function usedPercent(key: ProxyApiKeyView): number | null {
  if (key.creditLimit <= 0) return null
  return Math.min(100, (key.total.credits / key.creditLimit) * 100)
}

const columns = [
  { title: '名称', key: 'name', width: 240, ellipsis: true },
  { title: 'API Key', key: 'key' },
  { title: '额度', key: 'limit', width: 150 },
  { title: '请求', key: 'requests', width: 72, align: 'right' as const },
  { title: '启用', key: 'enabled', width: 64, align: 'center' as const },
  { title: '操作', key: 'action', width: 230, align: 'center' as const }
]

async function toggleEnabled(key: ProxyApiKeyView, enabled: boolean): Promise<void> {
  const res = await window.api.updateProxyKey(key.id, { enabled })
  if (!res.success || !res.data) return void message.error(res.error || '操作失败')
  keys.value = res.data
}

/**
 * 使用该 Key：把它设为默认 Key（页面上显示、一键写入客户端的就是这一个）。
 * 两个 Key 互换位置，两串密钥都继续可用（原默认 Key 转成「原默认 Key」）。
 * 已经写入过客户端的配置里是旧的默认 Key，互换后它们会显示「未配置」，需要重新一键写入，
 * 这点和「重新生成」一样要先说清楚。
 */
function makeDefault(key: ProxyApiKeyView): void {
  confirmDanger({
    title: `使用「${key.name}」？`,
    content:
      '它会成为当前使用的 Key（页面上显示、一键写入客户端的就是它）；原来的 Key 转为自定义 Key「原默认 Key」，仍然可用。' +
      '名称、额度与用量统计都跟着各自的密钥走。' +
      '已一键写入过的客户端需要重新写入一次。',
    okText: '使用该 Key',
    zIndex: 1100,
    maskClosable: true,
    onOk: async () => {
      const res = await window.api.setDefaultProxyKey(key.id)
      if (!res.success || !res.data) return void message.error(res.error || '设置失败')
      keys.value = res.data.keys
      // 外面页面显示的默认 Key 与客户端接入状态都跟着变
      proxyStore.config = res.data.config
      proxyStore.status = res.data.status
      void proxyStore.loadClients()
      if (detailId.value === key.id) detailId.value = null
      message.success(`已切换为使用「${key.name}」`)
      emit('changed')
    }
  })
}

function remove(key: ProxyApiKeyView): void {
  confirmDelete({
    title: `删除「${key.name}」`,
    content: '删除后使用这个 Key 的客户端会立即被拒绝，它的用量统计也会一起删除。',
    // 从弹窗里发起，确认框得压在它上面
    zIndex: 1100,
    maskClosable: true,
    onOk: async () => {
      const res = await window.api.deleteProxyKey(key.id)
      if (!res.success || !res.data) return void message.error(res.error || '删除失败')
      keys.value = res.data
      if (detailId.value === key.id) detailId.value = null
      message.success('已删除')
      emit('changed')
    }
  })
}

// ============ 详情 ============

const detailId = ref<string | null>(null)
const detail = computed(() => keys.value.find((k) => k.id === detailId.value) ?? null)
const usage = ref<ProxyKeyUsage | null>(null)
const usageLoading = ref(false)

async function loadUsage(): Promise<void> {
  const id = detailId.value
  if (!id) return
  usageLoading.value = true
  try {
    const res = await window.api.getProxyKeyUsage(id)
    // 等结果回来时用户可能已经切走了，别把别人的数据填进来
    if (detailId.value !== id) return
    usage.value = res.success && res.data ? res.data : null
  } finally {
    usageLoading.value = false
  }
}

watch(detailId, (id) => {
  usage.value = null
  if (id) void loadUsage()
})

function openDetail(record: ProxyApiKeyView): void {
  detailId.value = record.id
}

const total = computed<ProxyKeyStats>(
  () =>
    usage.value?.total ??
    detail.value?.total ?? { requests: 0, failed: 0, credits: 0, inputTokens: 0, outputTokens: 0 }
)

/** 4 位以上的 token 数用万作单位，否则卡片上一长串数字看不过来 */
function compact(n: number): string {
  if (n >= 100_000_000) return `${(n / 100_000_000).toFixed(2)} 亿`
  if (n >= 10_000) return `${(n / 10_000).toFixed(1)} 万`
  return String(Math.round(n))
}

// ---- 编辑名称 / 额度 ----
// 列表的「编辑」与详情页的「编辑」共用这一个弹窗

/** 正在编辑的 Key；null 表示弹窗关着 */
const editTarget = ref<ProxyApiKeyView | null>(null)
const editName = ref('')
const editLimit = ref<number | null>(null)
const saving = ref(false)

function startEdit(key: ProxyApiKeyView | null | undefined = detail.value): void {
  if (!key) return
  editName.value = key.name
  // 0 表示不限，输入框里留空更直观
  editLimit.value = key.creditLimit || null
  editTarget.value = key
}

async function saveEdit(): Promise<void> {
  const target = editTarget.value
  if (!target) return
  if (!editName.value.trim()) return void message.warning('请填写名称')
  saving.value = true
  try {
    const res = await window.api.updateProxyKey(target.id, {
      name: editName.value,
      creditLimit: editLimit.value ?? 0
    })
    if (!res.success || !res.data) return void message.error(res.error || '保存失败')
    keys.value = res.data
    editTarget.value = null
    message.success('已保存')
    emit('changed')
  } finally {
    saving.value = false
  }
}

function resetUsage(): void {
  const target = detail.value
  if (!target) return
  confirmDanger({
    title: `清空「${target.name}」的用量统计？`,
    content: '总计、按模型、每日统计和明细都会清零；有额度的 Key 会重新从 0 开始计。',
    okText: '清空',
    zIndex: 1100,
    maskClosable: true,
    onOk: async () => {
      const res = await window.api.resetProxyKeyUsage(target.id)
      if (!res.success || !res.data) return void message.error(res.error || '清空失败')
      keys.value = res.data
      await loadUsage()
    }
  })
}

// ---- 按模型 ----

const modelRows = computed(() =>
  Object.entries(usage.value?.byModel ?? {})
    .map(([model, stats]) => ({ model, ...stats }))
    // 按积分排：最花钱的排最上面，这通常就是用户想看的
    .sort((a, b) => b.credits - a.credits || b.requests - a.requests)
)

const modelColumns = [
  { title: '模型', dataIndex: 'model', key: 'model', ellipsis: true },
  { title: '请求', dataIndex: 'requests', key: 'requests', width: 80, align: 'right' as const },
  { title: '失败', dataIndex: 'failed', key: 'failed', width: 70, align: 'right' as const },
  { title: '输入 tokens', key: 'inputTokens', width: 110, align: 'right' as const },
  { title: '输出 tokens', key: 'outputTokens', width: 110, align: 'right' as const },
  { title: '积分', key: 'credits', width: 90, align: 'right' as const }
]

// ---- 明细 ----

const PROTOCOL_LABEL: Record<ProxyProtocol, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  responses: 'Responses',
  gemini: 'Gemini'
}

const recentRows = computed(() =>
  (usage.value?.recent ?? []).map((r, i) => ({ rowKey: `${r.at}-${i}`, ...r }))
)

const recentColumns = [
  { title: '时间', key: 'at', width: 150 },
  { title: '模型', dataIndex: 'model', key: 'model', ellipsis: true },
  { title: '协议', key: 'protocol', width: 96 },
  { title: '状态', key: 'ok', width: 64 },
  { title: '输入', key: 'inputTokens', width: 84, align: 'right' as const },
  { title: '输出', key: 'outputTokens', width: 84, align: 'right' as const },
  { title: '积分', key: 'credits', width: 80, align: 'right' as const },
  { title: '耗时', key: 'durationMs', width: 80, align: 'right' as const }
]

// ============ 每日折线 ============

type Metric = 'credits' | 'requests' | 'tokens'
const metric = ref<Metric>('credits')
const metricOptions = [
  { label: '积分', value: 'credits' },
  { label: '请求', value: 'requests' },
  { label: 'Tokens', value: 'tokens' }
]

/** 最多画最近 30 天 */
const DAY_SPAN = 30

function dayKey(at: number): string {
  const d = new Date(at)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/**
 * 按天连续补齐：没用的那天也要有一个 0 点，否则折线会把两次使用之间的空档连成一条斜线，
 * 看起来像那几天也在持续消耗。从有数据的第一天画到今天，最多 30 天。
 */
const days = computed(() => {
  const byDay = usage.value?.byDay ?? {}
  const keysSorted = Object.keys(byDay).sort()
  if (!keysSorted.length) return []
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const [y, m, d] = keysSorted[0].split('-').map(Number)
  const first = new Date(y, m - 1, d).getTime()
  const earliest = today.getTime() - (DAY_SPAN - 1) * 86_400_000
  const out: { day: string; stats: ProxyKeyStats }[] = []
  // 按日期对象步进而不是加 86400000：跨夏令时那天不是 24 小时
  for (const cursor = new Date(Math.max(first, earliest)); cursor <= today; cursor.setDate(cursor.getDate() + 1)) {
    const key = dayKey(cursor.getTime())
    out.push({
      day: key,
      stats: byDay[key] ?? { requests: 0, failed: 0, credits: 0, inputTokens: 0, outputTokens: 0 }
    })
  }
  return out
})

function metricValue(stats: ProxyKeyStats): number {
  if (metric.value === 'requests') return stats.requests
  if (metric.value === 'tokens') return stats.inputTokens + stats.outputTokens
  return stats.credits
}

function metricText(value: number): string {
  if (metric.value === 'credits') return formatCredits(value, true)
  if (metric.value === 'tokens') return compact(value)
  return String(Math.round(value))
}

const chartBox = ref<HTMLElement | null>(null)
const chartWidth = ref(820)
const CHART_HEIGHT = 200
const PAD = { top: 14, right: 16, bottom: 26, left: 52 }

const observer = new ResizeObserver((records) => {
  const width = records[0]?.contentRect.width
  if (width) chartWidth.value = width
})
watch(chartBox, (el, prev) => {
  if (prev) observer.unobserve(prev)
  if (el) observer.observe(el)
})
onBeforeUnmount(() => observer.disconnect())

const plot = computed(() => {
  const list = days.value
  const innerW = Math.max(80, chartWidth.value - PAD.left - PAD.right)
  const innerH = CHART_HEIGHT - PAD.top - PAD.bottom
  if (!list.length) return { points: [], line: '', area: '', yTicks: [], xTicks: [], innerW, innerH }

  const values = list.map((item) => metricValue(item.stats))
  const max = Math.max(...values, 0)
  const top = max > 0 ? max * 1.15 : 1
  const step = list.length > 1 ? innerW / (list.length - 1) : 0

  const points = list.map((item, i) => ({
    x: list.length > 1 ? PAD.left + i * step : PAD.left + innerW / 2,
    y: PAD.top + innerH - (values[i] / top) * innerH,
    day: item.day,
    stats: item.stats,
    value: values[i]
  }))
  const line = smoothLinePath(points)
  const baseY = PAD.top + innerH
  const area = `${line} L${points.at(-1)!.x.toFixed(2)},${baseY} L${points[0].x.toFixed(2)},${baseY} Z`

  const yTicks = Array.from({ length: 5 }, (_, i) => ({
    y: PAD.top + innerH - (i / 4) * innerH,
    label: metricText((top * i) / 4)
  }))
  // 横轴最多 6 个日期，其余靠悬停看
  const every = Math.max(1, Math.ceil(list.length / 6))
  const xTicks = points
    .map((p, i) => ({ ...p, i }))
    .filter((p) => p.i % every === 0 || p.i === points.length - 1)
    .map((p) => ({
      x: p.x,
      label: p.day.slice(5),
      anchor: points.length === 1 ? 'middle' : p.i === 0 ? 'start' : p.i === points.length - 1 ? 'end' : 'middle'
    }))

  return { points, line, area, yTicks, xTicks, innerW, innerH }
})

const hoverIndex = ref<number | null>(null)
const hoverPoint = computed(() =>
  hoverIndex.value === null ? null : (plot.value.points[hoverIndex.value] ?? null)
)

function onMove(event: MouseEvent): void {
  const points = plot.value.points
  if (!points.length) return
  const rect = (event.currentTarget as SVGElement).getBoundingClientRect()
  const x = ((event.clientX - rect.left) / rect.width) * chartWidth.value
  let best = 0
  for (let i = 1; i < points.length; i++) {
    if (Math.abs(points[i].x - x) < Math.abs(points[best].x - x)) best = i
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

const LINE_COLOR = '#1677ff'
const tab = ref<'daily' | 'model' | 'recent'>('daily')
</script>

<template>
  <a-modal
    :open="true"
    centered
    width="min(1160px, 94vw)"
    :footer="null"
    :mask-closable="true"
    wrap-class-name="proxy-keys-modal"
    @cancel="emit('close')"
  >
    <template #title>
      <span class="title">
        <template v-if="detail">
          <a-button type="text" size="small" @click="detailId = null">
            <template #icon><ArrowLeftOutlined /></template>
          </a-button>
          <KeyOutlined />
          {{ detail.name }}
          <a-tag v-if="detail.isDefault" :bordered="false" color="success">当前使用</a-tag>
          <a-tag v-else-if="!detail.enabled" :bordered="false">已停用</a-tag>
        </template>
        <template v-else>
          <KeyOutlined />
          API Key 管理
        </template>
      </span>
    </template>

    <div class="modal-body">
      <!-- ================= 列表 ================= -->
      <template v-if="!detail">
        <a-form layout="vertical" class="create-form">
          <a-row :gutter="12" align="bottom">
            <a-col :span="11">
              <a-form-item label="名称">
                <a-input
                  v-model:value="newName"
                  placeholder="例如：给 Cherry Studio 用（留空自动命名）"
                  :maxlength="40"
                  allow-clear
                  @press-enter="create"
                />
              </a-form-item>
            </a-col>
            <a-col :span="7">
              <a-form-item label="积分额度">
                <a-input-number
                  v-model:value="newLimit"
                  :min="0"
                  :step="10"
                  :precision="2"
                  placeholder="不填或 0 为不限"
                  style="width: 100%"
                />
              </a-form-item>
            </a-col>
            <a-col :span="6">
              <a-form-item label=" ">
                <a-button type="primary" block :loading="creating" @click="create">
                  <template #icon><PlusOutlined /></template>
                  添加 Key
                </a-button>
              </a-form-item>
            </a-col>
          </a-row>
        </a-form>

        <div class="list-head">
          <span class="list-title">全部 API Key（{{ keys.length }}）</span>
          <a-button type="text" size="small" :loading="loading" @click="load">
            <template #icon><ReloadOutlined /></template>
            刷新
          </a-button>
        </div>

        <div class="table-area">
          <a-table
            :columns="columns"
            :data-source="keys"
            row-key="id"
            size="small"
            :loading="loading"
            :pagination="false"
          >
            <template #bodyCell="{ column, record }">
              <template v-if="column.key === 'name'">
                <span class="name-cell">
                  <span class="key-name" :title="record.name">{{ record.name }}</span>
                  <!-- 默认 Key 就是当前在用的那个：页面上显示、一键写入客户端的都是它 -->
                  <a-tag v-if="record.isDefault" :bordered="false" color="success" class="mini-tag">
                    当前使用
                  </a-tag>
                </span>
              </template>
              <template v-else-if="column.key === 'key'">
                <span class="key-cell" @click.stop>
                  <span class="mono key-text">
                    {{ revealed.has(record.id) ? record.key : maskKey(record.key) }}
                  </span>
                  <a-button type="text" size="small" @click="toggleReveal(record.id)">
                    <template #icon>
                      <EyeInvisibleOutlined v-if="revealed.has(record.id)" />
                      <EyeOutlined v-else />
                    </template>
                  </a-button>
                  <a-button type="text" size="small" @click="copyText(record.key, 'API Key 已复制')">
                    <template #icon><CopyOutlined /></template>
                  </a-button>
                </span>
              </template>
              <template v-else-if="column.key === 'limit'">
                <div class="limit-cell">
                  <span class="num">
                    {{ formatCredits(record.total.credits, true) }}
                    <span class="muted">/ {{ limitText(record) }}</span>
                  </span>
                  <a-progress
                    v-if="usedPercent(record) !== null"
                    :percent="usedPercent(record)!"
                    :show-info="false"
                    size="small"
                    :status="usedPercent(record)! >= 100 ? 'exception' : 'normal'"
                  />
                </div>
              </template>
              <template v-else-if="column.key === 'requests'">
                <span class="num">{{ record.total.requests }}</span>
              </template>
              <template v-else-if="column.key === 'enabled'">
                <span @click.stop>
                  <a-switch
                    size="small"
                    :checked="record.enabled"
                    :disabled="record.isDefault"
                    @change="(v: any) => toggleEnabled(record, !!v)"
                  />
                </span>
              </template>
              <template v-else-if="column.key === 'action'">
                <!-- 纯文字按钮：几个动作并排时比一排图标更好认 -->
                <span class="row-actions">
                  <a-button type="link" size="small" @click.stop="openDetail(record)">统计</a-button>
                  <a-button type="link" size="small" @click.stop="startEdit(record)">编辑</a-button>
                  <a-tooltip
                    :title="
                      record.isDefault
                        ? '正在使用这个 Key'
                        : record.enabled
                          ? ''
                          : '已停用的 Key 不能使用，请先启用'
                    "
                  >
                    <a-button
                      type="link"
                      size="small"
                      :disabled="record.isDefault || !record.enabled"
                      @click.stop="makeDefault(record)"
                    >
                      使用该 Key
                    </a-button>
                  </a-tooltip>
                  <a-tooltip :title="record.isDefault ? '当前使用的 Key 不能删除，可以在外面重新生成' : ''">
                    <a-button
                      type="link"
                      size="small"
                      danger
                      :disabled="record.isDefault"
                      @click.stop="remove(record)"
                    >
                      删除
                    </a-button>
                  </a-tooltip>
                </span>
              </template>
            </template>
            <template #emptyText>
              <span class="muted">还没有 API Key，在上面添加一个</span>
            </template>
          </a-table>
        </div>
      </template>

      <!-- ================= 详情 ================= -->
      <template v-else>
        <div class="detail-top">
          <div class="key-cell">
            <span class="mono key-text">
              {{ revealed.has(detail.id) ? detail.key : maskKey(detail.key) }}
            </span>
            <a-button type="text" size="small" @click="toggleReveal(detail.id)">
              <template #icon>
                <EyeInvisibleOutlined v-if="revealed.has(detail.id)" />
                <EyeOutlined v-else />
              </template>
            </a-button>
            <a-button type="text" size="small" @click="copyText(detail.key, 'API Key 已复制')">
              <template #icon><CopyOutlined /></template>
            </a-button>
          </div>
          <a-space>
            <a-button size="small" @click="startEdit(detail)">
              <template #icon><EditOutlined /></template>
              编辑
            </a-button>
            <a-button size="small" :loading="usageLoading" @click="loadUsage">
              <template #icon><ReloadOutlined /></template>
            </a-button>
            <a-button size="small" danger :disabled="!total.requests" @click="resetUsage">
              清空统计
            </a-button>
          </a-space>
        </div>

        <div class="stat-cards">
          <div class="stat-card">
            <span class="muted">总请求</span>
            <strong class="num">{{ total.requests }}</strong>
            <span v-if="total.failed" class="muted sub bad">失败 {{ total.failed }}</span>
          </div>
          <div class="stat-card">
            <span class="muted">总积分</span>
            <strong class="num">{{ formatCredits(total.credits, true) }}</strong>
            <span class="muted sub">额度 {{ limitText(detail) }}</span>
          </div>
          <div class="stat-card">
            <span class="muted">输入 tokens</span>
            <strong class="num">{{ compact(total.inputTokens) }}</strong>
          </div>
          <div class="stat-card">
            <span class="muted">输出 tokens</span>
            <strong class="num">{{ compact(total.outputTokens) }}</strong>
          </div>
        </div>

        <a-tabs v-model:active-key="tab" size="small" class="detail-tabs">
          <a-tab-pane key="daily" tab="每日统计">
            <div class="chart-head">
              <a-segmented v-model:value="metric" size="small" :options="metricOptions" />
              <span class="muted">最近 {{ days.length }} 天</span>
            </div>
            <div ref="chartBox" class="chart-box">
              <svg
                v-if="days.length"
                class="chart"
                :viewBox="`0 0 ${chartWidth} ${CHART_HEIGHT}`"
                :style="{ height: `${CHART_HEIGHT}px` }"
                @mousemove="onMove"
                @mouseleave="hoverIndex = null"
              >
                <defs>
                  <linearGradient id="key-area" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" :stop-color="LINE_COLOR" stop-opacity="0.26" />
                    <stop offset="100%" :stop-color="LINE_COLOR" stop-opacity="0.02" />
                  </linearGradient>
                </defs>
                <g class="grid">
                  <template v-for="(tick, i) in plot.yTicks" :key="`y${i}`">
                    <line :x1="PAD.left" :y1="tick.y" :x2="PAD.left + plot.innerW" :y2="tick.y" />
                    <text :x="PAD.left - 8" :y="tick.y + 3.5" text-anchor="end">{{ tick.label }}</text>
                  </template>
                  <text
                    v-for="tick in plot.xTicks"
                    :key="`x${tick.label}`"
                    :x="tick.x"
                    :y="CHART_HEIGHT - 8"
                    :text-anchor="tick.anchor"
                  >
                    {{ tick.label }}
                  </text>
                </g>
                <path :d="plot.area" fill="url(#key-area)" />
                <path :d="plot.line" fill="none" :stroke="LINE_COLOR" stroke-width="1.8" />
                <circle
                  v-for="(p, i) in plot.points"
                  :key="i"
                  :cx="p.x"
                  :cy="p.y"
                  r="2.4"
                  :fill="LINE_COLOR"
                />
                <g v-if="hoverPoint">
                  <line
                    class="hover-line"
                    :x1="hoverPoint.x"
                    :y1="PAD.top"
                    :x2="hoverPoint.x"
                    :y2="PAD.top + plot.innerH"
                  />
                  <circle :cx="hoverPoint.x" :cy="hoverPoint.y" r="4" fill="#fff" :stroke="LINE_COLOR" stroke-width="2" />
                </g>
              </svg>
              <div v-else class="chart-empty muted">
                <LineChartOutlined />
                还没有用量
              </div>
              <div v-if="hoverPoint" class="tooltip" :style="tooltipStyle">
                <div class="tooltip-time">{{ hoverPoint.day }}</div>
                <div>请求 <strong>{{ hoverPoint.stats.requests }}</strong></div>
                <div>积分 <strong>{{ formatCredits(hoverPoint.stats.credits, true) }}</strong></div>
                <div>
                  tokens 入 {{ compact(hoverPoint.stats.inputTokens) }} / 出
                  {{ compact(hoverPoint.stats.outputTokens) }}
                </div>
              </div>
            </div>
          </a-tab-pane>

          <a-tab-pane key="model" tab="按模型">
            <a-table
              :columns="modelColumns"
              :data-source="modelRows"
              row-key="model"
              size="small"
              :pagination="false"
              :scroll="{ y: 260 }"
              :loading="usageLoading"
            >
              <template #bodyCell="{ column, record }">
                <template v-if="column.key === 'model'">
                  <span class="mono">{{ record.model }}</span>
                </template>
                <template v-else-if="column.key === 'inputTokens'">
                  <span class="num">{{ compact(record.inputTokens) }}</span>
                </template>
                <template v-else-if="column.key === 'outputTokens'">
                  <span class="num">{{ compact(record.outputTokens) }}</span>
                </template>
                <template v-else-if="column.key === 'credits'">
                  <span class="num">{{ formatCredits(record.credits, true) }}</span>
                </template>
              </template>
              <template #emptyText><span class="muted">还没有用量</span></template>
            </a-table>
          </a-tab-pane>

          <a-tab-pane key="recent" :tab="`用量历史（${recentRows.length}）`">
            <a-table
              :columns="recentColumns"
              :data-source="recentRows"
              row-key="rowKey"
              size="small"
              :pagination="{ pageSize: 20, size: 'small', showSizeChanger: false, hideOnSinglePage: true }"
              :scroll="{ y: 230 }"
              :loading="usageLoading"
            >
              <template #bodyCell="{ column, record }">
                <template v-if="column.key === 'at'">
                  <span class="mono muted">{{ formatDateTime(record.at) }}</span>
                </template>
                <template v-else-if="column.key === 'model'">
                  <span class="mono">{{ record.model }}</span>
                </template>
                <template v-else-if="column.key === 'protocol'">
                  <span class="muted">{{ PROTOCOL_LABEL[record.protocol as ProxyProtocol] }}</span>
                </template>
                <template v-else-if="column.key === 'ok'">
                  <a-tag :bordered="false" :color="record.ok ? 'success' : 'error'">
                    {{ record.ok ? '成功' : '失败' }}
                  </a-tag>
                </template>
                <template v-else-if="column.key === 'inputTokens'">
                  <span class="num">{{ compact(record.inputTokens) }}</span>
                </template>
                <template v-else-if="column.key === 'outputTokens'">
                  <span class="num">{{ compact(record.outputTokens) }}</span>
                </template>
                <template v-else-if="column.key === 'credits'">
                  <span class="num">{{ formatCredits(record.credits, true) }}</span>
                </template>
                <template v-else-if="column.key === 'durationMs'">
                  <span class="num muted">{{ (record.durationMs / 1000).toFixed(1) }}s</span>
                </template>
              </template>
              <template #emptyText><span class="muted">还没有用量</span></template>
            </a-table>
            <div class="muted foot-hint">只保留最近 500 条明细；总计与每日统计不受影响。</div>
          </a-tab-pane>
        </a-tabs>
      </template>
    </div>
  </a-modal>

  <!-- 编辑名称与积分额度：叠在管理弹窗上面，zIndex 要比它高 -->
  <a-modal
    :open="!!editTarget"
    centered
    :width="420"
    :z-index="1100"
    :title="editTarget ? `编辑「${editTarget.name}」` : ''"
    ok-text="保存"
    :confirm-loading="saving"
    :mask-closable="true"
    @ok="saveEdit"
    @cancel="editTarget = null"
  >
    <a-form layout="vertical" class="edit-form">
      <a-form-item label="名称" required>
        <a-input v-model:value="editName" :maxlength="40" placeholder="例如：给 Cherry Studio 用" @press-enter="saveEdit" />
      </a-form-item>
      <a-form-item label="积分额度" extra="不填或填 0 表示不限；已用积分达到额度后，这个 Key 的请求返回 429">
        <a-input-number
          v-model:value="editLimit"
          :min="0"
          :step="10"
          :precision="2"
          placeholder="不填或 0 为不限"
          style="width: 100%"
        />
      </a-form-item>
    </a-form>
  </a-modal>

</template>

<style scoped>
/* 名称与「当前使用」标签同一行：名称过长时省略，标签不被挤掉 */
.name-cell { display: inline-flex; align-items: center; gap: 6px; max-width: 100%; }
.name-cell .key-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.name-cell .mini-tag { flex: 0 0 auto; }

/* 操作列的文字按钮紧挨着排，去掉 link 按钮自带的左右内边距 */
.row-actions { display: inline-flex; align-items: center; gap: 10px; }
.row-actions :deep(.ant-btn) { padding: 0; height: auto; }

.title { display: inline-flex; align-items: center; gap: 8px; }

/* 固定高度：列表 0 行到几十行、列表与详情之间切换，弹窗都不跳 */
.modal-body {
  display: flex;
  flex-direction: column;
  height: clamp(520px, calc(80vh - 108px), 720px);
}

.create-form :deep(.ant-form-item) { margin-bottom: 0; }

.list-head {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: space-between;
  margin: 16px 0 8px;
}
.list-title { font-weight: 500; }

.table-area {
  flex: 1;
  min-height: 0;
  overflow: auto;
  border: 1px solid var(--kal-border);
  border-radius: 8px;
}

.key-name { font-weight: 600; }
.mini-tag { margin-left: 6px; font-size: 11px; line-height: 17px; }

.key-cell { display: inline-flex; align-items: center; gap: 2px; min-width: 0; }
.key-cell :deep(.ant-btn) { width: 22px; height: 22px; min-width: 22px; padding: 0; }
.key-text { font-size: 12px; word-break: break-all; }

.limit-cell { display: flex; flex-direction: column; gap: 2px; font-size: 12px; }
.limit-cell :deep(.ant-progress) { margin: 0; line-height: 1; }

.foot-hint { margin-top: 8px; font-size: 12px; }

.detail-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 12px;
  border-radius: 10px;
  background: var(--kal-block-bg);
}


.stat-cards {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 10px;
  margin-top: 12px;
}
.stat-card {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 10px 12px;
  border: 1px solid var(--kal-border);
  border-radius: 10px;
  font-size: 12px;
}
.stat-card strong { font-size: 20px; line-height: 1.3; }
.stat-card .sub { font-size: 11px; }

.detail-tabs { flex: 1; min-height: 0; margin-top: 8px; }

.chart-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
  font-size: 12px;
}
.chart-box {
  position: relative;
  padding: 4px 0;
  border-radius: 12px;
  background: var(--kal-block-bg);
}
.chart { display: block; width: 100%; }
.chart-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  height: 200px;
  font-size: 13px;
}
.grid line { stroke: var(--kal-border); stroke-width: 1; }
.grid text { fill: var(--kal-muted); font-size: 10.5px; }
.hover-line { stroke: var(--kal-muted); stroke-width: 1; stroke-dasharray: 3 3; }
.tooltip {
  position: absolute;
  z-index: 2;
  pointer-events: none;
  padding: 6px 10px;
  border: 1px solid var(--kal-border);
  border-radius: 8px;
  background: var(--kal-card-bg);
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.12);
  font-size: 12px;
  line-height: 1.6;
  white-space: nowrap;
}
.tooltip-time { color: var(--kal-muted); font-size: 11px; }

.num { font-variant-numeric: tabular-nums; }
.bad { color: #ff4d4f; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
.muted { color: var(--kal-muted); }
</style>

<style>
.proxy-keys-modal .table-area .ant-table-thead > tr > th {
  position: sticky;
  top: 0;
  z-index: 1;
}
</style>
