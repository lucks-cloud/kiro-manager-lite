<script setup lang="ts">
/**
 * API Key 批量获取模型列表：每个选中 Key 一行，逐个向 Kiro 管理面查询可用模型，
 * 显示每个 Key 可用的模型数量与模型 ID。与账户管理的「批量获取模型」同一套交互。
 *
 * 执行框架复用 useBatchRun：点「开始获取」后串行逐个、单个失败不影响后续、
 * 可中止、可重试失败项、全部完成后可「重新获取」。
 *
 * 获取后按模型数量归类（8 个 / 9 个 / 10 个…），点某一档只看那些 Key；
 * 下载对象都是当前筛选下获取成功的 Key：
 *  - 导出（首选）：打开 API Key 导出弹窗，按所选导出模式导出这批 Key 本身
 *  - txt / xlsx（更多）：导出模型清单，下载前先选字段
 */
import { computed, ref } from 'vue'
import { message } from 'ant-design-vue'
import {
  BranchesOutlined,
  CheckCircleFilled,
  CloseCircleFilled,
  DownOutlined,
  DownloadOutlined,
  FileExcelOutlined,
  FileTextOutlined,
  ReloadOutlined,
  StopOutlined
} from '@ant-design/icons-vue'
import ExportApiKeysModal from '@/components/keys/ExportApiKeysModal.vue'
import { useKeysStore } from '@/stores/keys'
import { useSettingsStore } from '@/stores/settings'
import { useBatchRun, type BatchRow } from '@/utils/batchRun'
import { displayEmail, displayKey } from '@/utils/display'
import { copyText } from '@/utils/ui'
import type { KeyEntry, XlsxCellValue, XlsxColumn } from '@shared/types'

/** keys 由调用方按界面顺序传入 */
const props = defineProps<{ keys: KeyEntry[] }>()
const emit = defineEmits<{ close: [] }>()

const store = useKeysStore()
const settingsStore = useSettingsStore()

interface Row extends BatchRow {
  entry: KeyEntry
  /** 模型 ID，按上游返回顺序 */
  models?: string[]
}

const rows = ref<Row[]>(props.keys.map((entry) => ({ entry, state: 'pending' })))
const listRef = ref<HTMLElement | null>(null)

const { running, aborted, stat, started, start, abort, stopSilently } = useBatchRun({
  rows,
  listRef,
  messageKey: 'batch-key-models-abort',
  async runOne(row) {
    // 按 id 在主进程取 Key，明文不经渲染进程来回传
    const res = await window.api.listKeyModelDetails(row.entry.id)
    if (res.success && res.data?.length) {
      row.state = 'ok'
      row.models = res.data.map((model) => model.modelId)
    } else {
      row.state = 'fail'
      row.error = res.error || '官方没有返回任何可用模型'
    }
  }
})

const got = computed(() => rows.value.filter((row) => row.state === 'ok' && row.models))

/**
 * 右下角主按钮：有失败项就重试失败项；还有没获取的就继续获取；
 * 全部成功则「重新获取」——清空结果，所有 Key 从头再查一遍。
 */
const allDone = computed(() => started.value && !stat.value.pending && !stat.value.fail)
const actionLabel = computed(() => {
  if (started.value && stat.value.fail) return '重试失败项'
  return allDone.value ? '重新获取' : '开始获取'
})

function runAction(): void {
  if (allDone.value) {
    for (const row of rows.value) {
      row.state = 'pending'
      row.models = undefined
      row.error = undefined
    }
  }
  void start()
}

// ============ 按模型数量归类筛选 ============

/** 'all' 全部；数字 = 只看模型数为该值的 Key；'fail' = 只看获取失败的 */
type CountFilter = 'all' | 'fail' | number

/** 成功的 Key 按模型数量归类：[数量, Key 数]，数量从少到多 */
const countGroups = computed(() => {
  const map = new Map<number, number>()
  for (const row of got.value) {
    const n = row.models!.length
    map.set(n, (map.get(n) ?? 0) + 1)
  }
  return [...map.entries()].sort((a, b) => a[0] - b[0])
})

const pickedFilter = ref<CountFilter>('all')

/** 重新获取后选中的那一档可能已不存在，这时退回「全部」，免得列表空着看不出原因 */
const countFilter = computed<CountFilter>(() => {
  const value = pickedFilter.value
  if (value === 'all') return 'all'
  if (value === 'fail') return stat.value.fail ? 'fail' : 'all'
  return countGroups.value.some(([n]) => n === value) ? value : 'all'
})

function matchesFilter(row: Row): boolean {
  const filter = countFilter.value
  if (filter === 'all') return true
  if (filter === 'fail') return row.state === 'fail'
  return row.state === 'ok' && row.models?.length === filter
}

/**
 * 界面上显示的行，带原始下标：执行框架按 data-row-index 把正在跑的那一行滚进视野，
 * 下标必须是它在全部行里的位置，而不是筛选后的位置。
 */
const visibleRows = computed(() =>
  rows.value.flatMap((row, index) => (matchesFilter(row) ? [{ row, index }] : []))
)

/** 当前筛选下可以下载的 Key：只有成功的才有模型可导出 */
const downloadable = computed(() =>
  visibleRows.value.filter(({ row }) => row.state === 'ok').map(({ row }) => row)
)
/** 没有可下载的结果、或正在获取时不给下载 */
const noDownload = computed(() => !downloadable.value.length || running.value)

const privacy = computed(() => settingsStore.settings.privacyMode)
const keyText = (entry: KeyEntry): string => displayKey(entry.key, privacy.value)
const emailText = (entry: KeyEntry): string =>
  entry.email ? displayEmail(entry.email, privacy.value) : '-'

// ============ 下载：先选字段 ============

type FieldKey = 'key' | 'email' | 'count' | 'models'

interface ExportField {
  key: FieldKey
  label: string
  /** txt 里这一段的写法 */
  text: (row: Row) => string
  /** xlsx 里这一列 */
  column: XlsxColumn
  cell: (row: Row) => XlsxCellValue
}

/** Key 与邮箱都写完整值，不做隐私打码：导出的清单是给人核对用的 */
const EXPORT_FIELDS: ExportField[] = [
  {
    key: 'key',
    label: 'API Key',
    text: (row) => row.entry.key,
    column: { title: 'API Key', width: 48 },
    cell: (row) => row.entry.key
  },
  {
    key: 'email',
    label: '邮箱',
    text: (row) => row.entry.email || '',
    column: { title: '邮箱', width: 30 },
    cell: (row) => row.entry.email || null
  },
  {
    key: 'count',
    label: '模型数量',
    text: (row) => String(row.models!.length),
    column: { title: '模型数量', width: 10, format: 'number', decimals: 0 },
    cell: (row) => row.models!.length
  },
  {
    key: 'models',
    label: '模型列表',
    text: (row) => row.models!.join(','),
    column: { title: '模型列表', width: 120 },
    cell: (row) => row.models!.join(', ')
  }
]

/** 正在为哪种格式选字段；null 表示选字段弹窗没开 */
const exportKind = ref<'txt' | 'xlsx' | null>(null)
/** 勾选的字段，默认全选；跨两次下载保留 */
const exportKeys = ref<FieldKey[]>(EXPORT_FIELDS.map((field) => field.key))
const exportOptions = EXPORT_FIELDS.map((field) => ({ label: field.label, value: field.key }))

/** 「更多」下拉的开合 */
const moreOpen = ref(false)

function openExport(kind: 'txt' | 'xlsx'): void {
  if (noDownload.value) return
  exportKind.value = kind
}

function onMorePick({ key }: { key: string | number }): void {
  moreOpen.value = false
  openExport(key as 'txt' | 'xlsx')
}

/**
 * 按勾选的字段导出当前筛选下的成功项；字段顺序固定为
 * API Key → 邮箱 → 模型数量 → 模型列表，与勾选的先后无关。
 */
async function download(): Promise<void> {
  const kind = exportKind.value
  const list = downloadable.value
  const fields = EXPORT_FIELDS.filter((field) => exportKeys.value.includes(field.key))
  if (!kind || !list.length || !fields.length) return

  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  const filename = `key-models-${list.length}个-${stamp}.${kind}`

  const res =
    kind === 'txt'
      ? await window.api.exportToFile(
          `${list.map((row) => fields.map((field) => field.text(row)).join('----')).join('\n')}\n`,
          filename
        )
      : await window.api.exportToXlsx(
          {
            name: '模型列表',
            columns: fields.map((field) => field.column),
            rows: list.map((row) => fields.map((field) => field.cell(row)))
          },
          filename
        )

  if (!res.success) return void message.error(res.error || '下载失败')
  exportKind.value = null
  if (res.data?.saved) message.success(`已导出 ${list.length} 个 Key 的模型列表`)
}

/** 导出：复用 API Key 导出弹窗，范围是当前筛选下获取成功的这批 Key */
const keyExportOpen = ref(false)
const downloadableIds = ref<string[]>([])

/**
 * 只交还仍然存在的 Key：导出弹窗的规则是「勾选为空就导出全部」，
 * 万一这批 Key 在获取期间被删光，传空数组会变成把整个 Key 库导出去。
 */
function openKeyExport(): void {
  const alive = new Set(store.data.keys.map((item) => item.id))
  const ids = downloadable.value.map((row) => row.entry.id).filter((id) => alive.has(id))
  if (!ids.length) return void message.warning('这些 API Key 已不在列表里')
  downloadableIds.value = ids
  keyExportOpen.value = true
}

function close(): void {
  stopSilently()
  emit('close')
}
</script>


<template>
  <a-modal :open="true" width="900px" centered :footer="null" :mask-closable="!running" @cancel="close">
    <template #title>
      <span class="title"><BranchesOutlined />批量获取模型</span>
    </template>

    <a-alert
      type="info"
      show-icon
      style="margin-bottom: 12px"
      message="按列表顺序逐个查询每个 API Key 可用的模型，单个失败不影响后续。不同订阅档位能用的模型可能不同。"
    />

    <div class="summary">
      <span class="count-text">共 {{ stat.total }} 个 Key</span>
      <a-tag v-if="stat.ok" color="green" :bordered="false">成功 {{ stat.ok }}</a-tag>
      <a-tag v-if="stat.fail" color="red" :bordered="false">失败 {{ stat.fail }}</a-tag>
      <a-tag v-if="stat.pending" :bordered="false">未获取 {{ stat.pending }}</a-tag>
      <span class="spacer" />
      <span v-if="running" class="count-text">
        正在获取 {{ stat.ok + stat.fail + 1 }}/{{ stat.total }}
      </span>
    </div>

    <!-- 按模型数量归类：有结果后才出现，点某一档只看那些 Key，下载也只导出这一档 -->
    <div v-if="countGroups.length || stat.fail" class="filter-bar">
      <span class="filter-label">按模型数量</span>
      <a-radio-group
        :value="countFilter"
        size="small"
        button-style="solid"
        @update:value="(v: CountFilter) => (pickedFilter = v)"
      >
        <a-radio-button value="all">全部（{{ stat.total }}）</a-radio-button>
        <a-radio-button v-for="[n, count] in countGroups" :key="n" :value="n">
          {{ n }} 个模型（{{ count }}）
        </a-radio-button>
        <a-radio-button v-if="stat.fail" value="fail">获取失败（{{ stat.fail }}）</a-radio-button>
      </a-radio-group>
    </div>

    <div ref="listRef" class="row-list">
      <div v-if="!visibleRows.length" class="empty muted">这一档下没有 API Key</div>
      <div
        v-for="{ row, index } in visibleRows"
        :key="row.entry.id"
        :data-row-index="index"
        class="row"
        :class="row.state"
      >
        <!-- 第一排：Key + 邮箱，右侧状态 / 模型数量 -->
        <div class="row-head">
          <span
            class="row-key mono"
            title="点击复制完整 API Key"
            @click="copyText(row.entry.key, '已复制 API Key')"
          >{{ keyText(row.entry) }}</span>
          <span class="row-email muted">{{ emailText(row.entry) }}</span>
          <a-tag v-if="row.entry.subscription" :bordered="false" class="tier-tag">
            {{ row.entry.subscription }}
          </a-tag>
          <span class="spacer" />
          <div class="row-state">
            <template v-if="row.state === 'pending'">
              <span class="muted">等待获取</span>
            </template>
            <template v-else-if="row.state === 'running'">
              <a-spin size="small" />
              <span class="running-text">获取中</span>
            </template>
            <template v-else-if="row.state === 'ok'">
              <CheckCircleFilled class="ok-icon" />
              <span class="ok-text">{{ row.models?.length ?? 0 }} 个模型</span>
            </template>
            <template v-else>
              <CloseCircleFilled class="fail-icon" />
              <span class="fail-text" :title="row.error">{{ row.error }}</span>
            </template>
          </div>
        </div>
        <!-- 第二排：模型列表铺满整行，每个模型 ID 自成一段、不在中间断开 -->
        <div v-if="row.models" class="row-models mono">
          <span v-for="(id, i) in row.models" :key="id" class="model-id">{{ id }}{{ i < row.models.length - 1 ? '、' : '' }}</span>
        </div>
      </div>
    </div>

    <div class="footer">
      <!--
        按钮组：主按钮「导出」走 API Key 导出弹窗（导出这批 Key 本身），
        右侧下箭头展开 txt / xlsx（导出模型清单，下载前先选字段）。

        注意：a-space-compact 里不要夹 HTML 注释。它会遍历子节点逐个包装来算首尾圆角，
        注释节点混进去会让它错位，右侧下拉因此收不到点击。说明一律写在组件外面。
      -->
      <a-space-compact :size="settingsStore.compactSize">
        <a-button :disabled="noDownload" @click="openKeyExport">
          <template #icon><DownloadOutlined /></template>
          导出（{{ downloadable.length }}）
        </a-button>
        <a-dropdown v-model:open="moreOpen" :disabled="noDownload" placement="topRight" :trigger="['click']">
          <a-button :disabled="noDownload" aria-label="更多下载格式">
            <template #icon><DownOutlined /></template>
          </a-button>
          <template #overlay>
            <a-menu @click="onMorePick">
              <a-menu-item key="txt">
                <FileTextOutlined />
                下载 txt（{{ downloadable.length }}）
              </a-menu-item>
              <a-menu-item key="xlsx">
                <FileExcelOutlined />
                下载 xlsx（{{ downloadable.length }}）
              </a-menu-item>
            </a-menu>
          </template>
        </a-dropdown>
      </a-space-compact>
      <span class="spacer" />
      <a-button @click="close">关闭</a-button>
      <a-button v-if="running" danger :loading="aborted" @click="abort">
        <template v-if="!aborted" #icon><StopOutlined /></template>
        {{ aborted ? '正在中止' : '中止' }}
      </a-button>
      <a-button v-else type="primary" @click="runAction">
        <template #icon><ReloadOutlined /></template>
        {{ actionLabel }}
      </a-button>
    </div>

    <!-- 下载前选要导出的字段；至少勾一个才能下载 -->
    <a-modal
      :open="!!exportKind"
      :title="`下载 ${exportKind ?? ''}（${downloadable.length}个 Key）`"
      centered
      width="420px"
      ok-text="下载"
      :ok-button-props="{ disabled: !exportKeys.length }"
      @ok="download"
      @cancel="exportKind = null"
    >
      <p class="muted export-tip">
        选择要导出的字段，按 API Key → 邮箱 → 模型数量 → 模型列表 的顺序排列。
      </p>
      <a-checkbox-group v-model:value="exportKeys" :options="exportOptions" class="export-fields" />
    </a-modal>

    <ExportApiKeysModal
      v-if="keyExportOpen"
      v-model:open="keyExportOpen"
      :selected-ids="downloadableIds"
    />
  </a-modal>
</template>

<style scoped>
.title { display: inline-flex; align-items: center; gap: 8px; }
.summary { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin: 0 0 10px; }
.summary :deep(.ant-tag) { margin: 0; }
.spacer { flex: 1 1 auto; }
.count-text { color: var(--kal-muted); font-size: 12px; }

/* 模型数量归类：档位多时自动换行 */
.filter-bar { display: flex; align-items: flex-start; gap: 8px; margin: 0 0 10px; }
.filter-label { flex: 0 0 auto; line-height: 24px; font-size: 12px; color: var(--kal-muted); }
.filter-bar :deep(.ant-radio-group) { display: flex; flex-wrap: wrap; row-gap: 6px; }
.empty { padding: 40px 0; text-align: center; font-size: 13px; }

/* 固定高度：Key 1 个还是几百个，弹窗都一样高，超出在列表内滚动 */
.row-list { height: 46vh; overflow: auto; display: flex; flex-direction: column; gap: 8px; }
/* 每个 Key 上下两排：第一排 Key + 状态，第二排模型列表铺满整行 */
.row {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  border-radius: 10px;
  background: var(--kal-block-bg);
  border: 1px solid transparent;
  transition: border-color 0.2s, background 0.2s;
}
.row.running { border-color: var(--kal-primary); }
.row.ok { border-color: #52c41a33; }
.row.fail { border-color: #ff4d4f33; }

.row-head { display: flex; align-items: center; gap: 8px; min-width: 0; }
/* Key 可点复制：悬停变主题色 */
.row-key {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: color 0.15s;
}
.row-key:hover { color: var(--kal-primary); }
.row-email { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
.tier-tag { flex: 0 0 auto; margin: 0; font-size: 11px; }
/* 模型列表完整显示：每个模型 ID 不在中间断开，放不下就在两个模型之间换行 */
.row-models { color: var(--kal-muted); font-size: 12px; line-height: 1.7; }
.model-id { white-space: nowrap; }

.row-state { flex: 0 0 auto; max-width: 46%; display: flex; align-items: center; gap: 6px; font-size: 12px; }
.running-text { color: var(--kal-primary); }
.ok-icon, .ok-text { color: #52c41a; }
.fail-icon { color: #ff4d4f; flex: 0 0 auto; }
.fail-text { color: #ff4d4f; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.footer { display: flex; align-items: center; gap: 8px; margin-top: 16px; }

.export-tip { margin: 0 0 12px; font-size: 12px; }
.export-fields { display: flex; flex-direction: column; gap: 10px; }

.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
.muted { color: var(--kal-muted); }
</style>
