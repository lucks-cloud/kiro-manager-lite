<script lang="ts">
import type { BatchRow } from '@/utils/batchRun'
import type { XlsxCellValue, XlsxColumn } from '@shared/types'

/** 一行：一个账号或一个 Key，以及它拉到的模型 */
export interface BatchModelsRow<T> extends BatchRow {
  item: T
  /** 模型 ID，按上游返回顺序 */
  models?: string[]
}

/** 下载 txt / xlsx 时可勾选的一个字段 */
export interface BatchModelsField<T> {
  key: string
  label: string
  /** txt 里这一段的写法 */
  text: (row: BatchModelsRow<T>) => string
  /** xlsx 里这一列 */
  column: XlsxColumn
  cell: (row: BatchModelsRow<T>) => XlsxCellValue
}
</script>

<script setup lang="ts" generic="T extends { id: string }">
/**
 * 批量获取模型列表的公共弹窗：账号版（BatchModelsModal）与 API Key 版（BatchKeyModelsModal）
 * 共用这一套，两边只在拉取方式、行头展示、条目导出弹窗和文案上不同，由调用方传入。
 *
 * 执行框架复用 useBatchRun：点「开始获取」后串行逐个、单个失败不影响后续、
 * 可中止、可重试失败项、全部完成后可「重新获取」。
 *
 * 获取后按模型数量归类（8 个 / 9 个 / 10 个…），点某一档只看那些条目；
 * 下载对象都是当前筛选下获取成功的条目：
 *  - 主按钮：打开条目导出弹窗（具名插槽 export），按所选导出模式导出这批条目本身
 *  - txt / xlsx（更多）：导出模型清单，下载前先选字段
 */
import { computed, ref, type Ref } from 'vue'
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
import { useSettingsStore } from '@/stores/settings'
import { useBatchRun } from '@/utils/batchRun'

const props = defineProps<{
  /** 由调用方按界面顺序传入 */
  items: T[]
  /** 条目名词：「账号」或「Key」，拼进「共 N 个账号」「已导出 N 个 Key 的模型列表」等文案 */
  noun: string
  /** 顶部说明 */
  alert: string
  /** 当前档位下一条都没有时的占位文案 */
  emptyText: string
  /** 主按钮文案（不含数量），如「下载 JSON」「导出」 */
  exportLabel: string
  /** 打开条目导出弹窗时，这批条目已全部被删除的提示 */
  goneText: string
  /** 中止提示的 message key，各弹窗各用一个 */
  messageKey: string
  /** txt / xlsx 文件名前缀，如 models- */
  filePrefix: string
  /** 下载 txt / xlsx 时排在「模型数量 → 模型列表」之前的字段 */
  fields: BatchModelsField<T>[]
  /** 拉一个条目的模型列表；抛错按失败处理 */
  fetchModels: (item: T) => Promise<{ success: boolean; data?: { modelId: string }[]; error?: string }>
  /** 只留下仍然存在的 id */
  filterAlive: (ids: string[]) => string[]
}>()
const emit = defineEmits<{ close: [] }>()

defineSlots<{
  /** 行头左侧：邮箱 / Key 与订阅标签，右侧的状态由本组件负责 */
  head(props: { item: T }): unknown
  /** 条目导出弹窗：open 恒为 true（关掉即卸载），update 对应 v-model:open 的写回 */
  export(props: { ids: string[]; open: boolean; update: (open: boolean) => void }): unknown
}>()

const settingsStore = useSettingsStore()

type Row = BatchModelsRow<T>

/** 名词是英文（如 Key）时与中文之间留一个空格，与原有文案的排版一致 */
const nounGap = /^[A-Za-z]/.test(props.noun) ? ' ' : ''
/** 「个」接名词：「个账号」「个 Key」 */
const unit = `个${nounGap}${props.noun}`

// 泛型行类型过不了 UnwrapRef 的推导，按 Ref<Row[]> 断言；运行时与 ref<Row[]>() 相同
const rows = ref(props.items.map((item): Row => ({ item, state: 'pending' }))) as Ref<Row[]>
const listRef = ref<HTMLElement | null>(null)

const { running, aborted, stat, started, start, abort, stopSilently } = useBatchRun({
  rows,
  listRef,
  messageKey: props.messageKey,
  async runOne(row) {
    const res = await props.fetchModels(row.item)
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
 * 右下角主按钮：
 * - 有失败项 → 重试失败项（只跑失败和没跑到的）
 * - 还有没获取的 → 开始获取（中途中止后再点就是接着跑）
 * - 全部成功 → 重新获取：清空结果，所有条目从头再查一遍
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

/** 'all' 全部；数字 = 只看模型数为该值的条目；'fail' = 只看获取失败的 */
type CountFilter = 'all' | 'fail' | number

/** 成功的条目按模型数量归类：[数量, 条目数]，数量从少到多 */
const countGroups = computed(() => {
  const map = new Map<number, number>()
  for (const row of got.value) {
    const n = row.models!.length
    map.set(n, (map.get(n) ?? 0) + 1)
  }
  return [...map.entries()].sort((a, b) => a[0] - b[0])
})

const pickedFilter = ref<CountFilter>('all')

/**
 * 实际生效的筛选：重新获取后选中的那一档可能已经不存在（比如原本 9 个模型的账号都变成了 10 个），
 * 这时退回「全部」，免得列表空着却看不出原因。
 */
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

/** 当前筛选下可以下载的条目：只有成功的才有模型可导出 */
const downloadable = computed(() =>
  visibleRows.value.filter(({ row }) => row.state === 'ok').map(({ row }) => row)
)
/** 没有可下载的结果、或正在获取时不给下载 */
const noDownload = computed(() => !downloadable.value.length || running.value)

// ============ 条目导出（主按钮） ============

/** 条目导出弹窗的范围：打开时定下来，之后筛选怎么切都不影响正在进行的导出 */
const downloadableIds = ref<string[]>([])
const itemExportOpen = ref(false)

function setItemExportOpen(open: boolean): void {
  itemExportOpen.value = open
}

/**
 * 只交还仍然存在的条目：导出弹窗的规则是「勾选为空就导出全部」，
 * 万一这批条目在获取期间被删光，传空数组会变成把整个库导出去。
 */
function openItemExport(): void {
  const ids = props.filterAlive(downloadable.value.map((row) => row.item.id))
  if (!ids.length) return void message.warning(props.goneText)
  downloadableIds.value = ids
  itemExportOpen.value = true
}

// ============ 下载：先选字段 ============

/** 模型数量与模型列表两个字段两边一样，排在调用方给的字段之后 */
const MODEL_FIELDS: BatchModelsField<T>[] = [
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

/** 邮箱、Key 都写完整值，不做隐私打码：导出的清单是给人核对用的 */
const EXPORT_FIELDS = [...props.fields, ...MODEL_FIELDS]

/** 正在为哪种格式选字段；null 表示选字段弹窗没开 */
const exportKind = ref<'txt' | 'xlsx' | null>(null)
/** 勾选的字段，默认全选；跨两次下载保留，下次打开还是上次的选择 */
const exportKeys = ref<string[]>(EXPORT_FIELDS.map((field) => field.key))
const exportOptions = EXPORT_FIELDS.map((field) => ({ label: field.label, value: field.key }))
/** 选字段弹窗里的说明，字段顺序与导出顺序一致 */
const exportTip = `选择要导出的字段，按 ${EXPORT_FIELDS.map((field) => field.label).join(' → ')} 的顺序排列。`

function openExport(kind: 'txt' | 'xlsx'): void {
  if (noDownload.value) return
  exportKind.value = kind
}

/** 「更多」下拉的开合由本组件管（见模板里的说明） */
const moreOpen = ref(false)

function onMorePick({ key }: { key: string | number }): void {
  moreOpen.value = false
  openExport(key as 'txt' | 'xlsx')
}

/**
 * 按勾选的字段导出当前筛选下的成功条目；字段顺序固定为 EXPORT_FIELDS 的顺序，
 * 与勾选的先后无关。
 * - txt：一行一个条目，字段之间用 ---- 连接，模型列表用逗号分隔
 * - xlsx：每个字段一列
 */
async function download(): Promise<void> {
  const kind = exportKind.value
  const list = downloadable.value
  const fields = EXPORT_FIELDS.filter((field) => exportKeys.value.includes(field.key))
  if (!kind || !list.length || !fields.length) return

  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  const filename = `${props.filePrefix}${list.length}个-${stamp}.${kind}`

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
  // 保存对话框取消时也关掉选字段弹窗：用户已经做过选择了，不必再停在这里
  exportKind.value = null
  if (res.data?.saved) message.success(`已导出 ${list.length} ${unit}${nounGap}的模型列表`)
}

function close(): void {
  stopSilently()
  emit('close')
}
</script>

<template>
  <!-- 模型列表完整换行显示，弹窗比订阅链接那个宽一些，行不至于折得太高 -->
  <a-modal :open="true" width="900px" centered :footer="null" :mask-closable="!running" @cancel="close">
    <template #title>
      <span class="title"><BranchesOutlined />批量获取模型</span>
    </template>

    <a-alert
      type="info"
      show-icon
      style="margin-bottom: 12px"
      :message="props.alert"
    />

    <div class="summary">
      <span class="count-text">共 {{ stat.total }} {{ unit }}</span>
      <a-tag v-if="stat.ok" color="green" :bordered="false">成功 {{ stat.ok }}</a-tag>
      <a-tag v-if="stat.fail" color="red" :bordered="false">失败 {{ stat.fail }}</a-tag>
      <a-tag v-if="stat.pending" :bordered="false">未获取 {{ stat.pending }}</a-tag>
      <span class="spacer" />
      <span v-if="running" class="count-text">
        正在获取 {{ stat.ok + stat.fail + 1 }}/{{ stat.total }}
      </span>
    </div>

    <!-- 按模型数量归类：有结果后才出现，点某一档只看那些条目，下载也只导出这一档 -->
    <div v-if="countGroups.length || stat.fail" class="filter-bar">
      <span class="filter-label">按模型数量</span>
      <!-- 显示的是生效值（选中的档位消失时会退回全部），写回的是用户的选择 -->
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

    <div ref="listRef" class="kal-batch-row-list">
      <div v-if="!visibleRows.length" class="empty muted">{{ props.emptyText }}</div>
      <div
        v-for="{ row, index } in visibleRows"
        :key="row.item.id"
        :data-row-index="index"
        class="row"
        :class="row.state"
      >
        <!-- 第一排：左侧身份信息（调用方的 head 插槽），右侧状态 / 模型数量 -->
        <div class="row-head">
          <slot name="head" :item="row.item" />
          <span class="spacer" />
          <div class="kal-batch-row-state">
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
              <span class="kal-batch-fail-text" :title="row.error">{{ row.error }}</span>
            </template>
          </div>
        </div>
        <!--
          第二排：模型列表铺满整行完整显示。每个模型 ID 自成一段、不在中间断开，
          放不下就在两个模型之间换行。
        -->
        <div v-if="row.models" class="row-models mono">
          <span v-for="(id, i) in row.models" :key="id" class="model-id">{{ id }}{{ i < row.models.length - 1 ? '、' : '' }}</span>
        </div>
      </div>
    </div>

    <div class="kal-batch-footer">
      <!--
        按钮组：主按钮走条目导出弹窗（导出这批条目本身），
        右侧下箭头展开 txt / xlsx（导出模型清单，下载前先选字段）。

        注意：a-space-compact 里**不要**夹 HTML 注释。它会遍历子节点逐个包装来算
        首尾圆角，注释节点混进去会让它错位，右侧下拉因此收不到点击、点箭头毫无反应。
        说明一律写在组件外面。
      -->
      <a-space-compact :size="settingsStore.compactSize">
        <a-button :disabled="noDownload" @click="openItemExport">
          <template #icon><DownloadOutlined /></template>
          {{ props.exportLabel }}（{{ downloadable.length }}）
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
      :title="`下载 ${exportKind ?? ''}（${downloadable.length}${unit}）`"
      centered
      width="420px"
      ok-text="下载"
      :ok-button-props="{ disabled: !exportKeys.length }"
      @ok="download"
      @cancel="exportKind = null"
    >
      <p class="muted export-tip">{{ exportTip }}</p>
      <a-checkbox-group v-model:value="exportKeys" :options="exportOptions" class="export-fields" />
    </a-modal>

    <!--
      条目导出：复用列表页的导出弹窗（各种导出模式都在里面），
      导出范围是当前筛选下获取成功的这批条目，比如只导出「9 个模型」那一档。
    -->
    <slot
      v-if="itemExportOpen"
      name="export"
      :ids="downloadableIds"
      :open="itemExportOpen"
      :update="setItemExportOpen"
    />
  </a-modal>
</template>

<!-- .kal-batch-row-list / .kal-batch-row-state / .kal-batch-fail-text / .kal-batch-footer 在 assets/styles.css，与其它批量弹窗共用 -->
<style scoped>
.title { display: inline-flex; align-items: center; gap: 8px; }
.summary { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin: 0 0 10px; }
.summary :deep(.ant-tag) { margin: 0; }
.spacer { flex: 1 1 auto; }
.count-text { color: var(--kal-muted); font-size: 12px; }

/* 每个条目上下两排：第一排身份信息 + 状态，第二排模型列表铺满整行 */
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
/* 模型列表完整显示：每个模型 ID 不在中间断开，放不下就在两个模型之间换行 */
.row-models { color: var(--kal-muted); font-size: 12px; line-height: 1.7; }
.model-id { white-space: nowrap; }

.running-text { color: var(--kal-primary); }
.ok-icon, .ok-text { color: #52c41a; }
.fail-icon { color: #ff4d4f; flex: 0 0 auto; }

/* 模型数量归类：档位多时自动换行 */
.filter-bar { display: flex; align-items: flex-start; gap: 8px; margin: 0 0 10px; }
.filter-label { flex: 0 0 auto; line-height: 24px; font-size: 12px; color: var(--kal-muted); }
.filter-bar :deep(.ant-radio-group) { display: flex; flex-wrap: wrap; row-gap: 6px; }
.empty { padding: 40px 0; text-align: center; font-size: 13px; }

.export-tip { margin: 0 0 12px; font-size: 12px; }
.export-fields { display: flex; flex-direction: column; gap: 10px; }

.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
.muted { color: var(--kal-muted); }
</style>
