<script setup lang="ts">
/**
 * 账号批量获取模型列表：每个选中账号一行，逐个向 Kiro 官方拉 ListAvailableModels，
 * 显示每个账号可用的模型数量与模型 ID。可下载 txt / xlsx。
 *
 * 和批量生成订阅链接同一套执行框架（useBatchRun）：点「开始获取」后串行逐个、
 * 单个失败不影响后续、可中止、可重试失败项。
 *
 * 获取后按模型数量归类（8 个 / 9 个 / 10 个…），点某一档只看那些账号；
 * 下载对象都是当前筛选下的成功账号：
 *  - JSON（首选）：打开账号导出弹窗，按选的导出模式导出这批账号本身
 *  - txt / xlsx（更多）：导出模型清单，下载前先选字段
 */
import { computed, ref } from 'vue'
import { message } from 'ant-design-vue'
import {
  CheckCircleFilled,
  BranchesOutlined,
  CloseCircleFilled,
  DownOutlined,
  DownloadOutlined,
  FileExcelOutlined,
  FileTextOutlined,
  ReloadOutlined,
  StopOutlined
} from '@ant-design/icons-vue'
import ExportAccountsModal from '@/components/accounts/ExportAccountsModal.vue'
import { useAccountsStore } from '@/stores/accounts'
import { useSettingsStore } from '@/stores/settings'
import { useBatchRun, type BatchRow } from '@/utils/batchRun'
import { displayEmail } from '@/utils/display'
import { subscriptionLabel } from '@/utils/format'
import { freshAccount } from '@/utils/freshAccount'
import { copyText } from '@/utils/ui'
import type { Account, XlsxCellValue, XlsxColumn } from '@shared/types'

/** accounts 由调用方按界面顺序传入 */
const props = defineProps<{ accounts: Account[] }>()
const emit = defineEmits<{ close: [] }>()

const settingsStore = useSettingsStore()

interface Row extends BatchRow {
  account: Account
  /** 模型 ID，按上游返回顺序 */
  models?: string[]
}

const rows = ref<Row[]>(props.accounts.map((account) => ({ account, state: 'pending' })))
const listRef = ref<HTMLElement | null>(null)

const { running, aborted, stat, started, start, abort, stopSilently } = useBatchRun({
  rows,
  listRef,
  messageKey: 'batch-models-abort',
  async runOne(row) {
    // 非 IDE 当前登录的账号 Token 多半已过期，按需续一次再拉
    const account = await freshAccount(row.account)
    const res = await window.api.listKiroModels({
      accessToken: account.credentials.accessToken ?? '',
      profileArn: account.profileArn || account.credentials.profileArn,
      region: account.credentials.region,
      idp: account.idp,
      authMethod: account.credentials.authMethod
    })
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
 * - 全部成功 → 重新获取：清空结果，所有账号从头再查一遍
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

/** 'all' 全部；数字 = 只看模型数为该值的账号；'fail' = 只看获取失败的 */
type CountFilter = 'all' | 'fail' | number

/** 成功账号按模型数量归类：[数量, 账号数]，数量从少到多 */
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

/** 当前筛选下可以下载的账号：只有成功的才有模型可导出 */
const downloadable = computed(() => visibleRows.value.filter(({ row }) => row.state === 'ok').map(({ row }) => row))
/** 账号导出弹窗（下载 JSON）的范围：打开时定下来，之后筛选怎么切都不影响正在进行的导出 */
const downloadableIds = ref<string[]>([])
const accountExportOpen = ref(false)

const accountsStore = useAccountsStore()

/**
 * 只交还仍然存在的账号：导出弹窗的规则是「勾选为空就导出全部」，
 * 万一这批账号在获取期间被删光，传空数组会变成把整个账号库导出去。
 */
function openAccountExport(): void {
  const ids = downloadable.value.map((row) => row.account.id).filter((id) => accountsStore.get(id))
  if (!ids.length) return void message.warning('这些账号已不在账号列表里')
  downloadableIds.value = ids
  accountExportOpen.value = true
}
/** 没有可下载的结果、或正在获取时不给下载 */
const noDownload = computed(() => !downloadable.value.length || running.value)

function email(account: Account): string {
  return displayEmail(account.email, settingsStore.settings.privacyMode)
}

// ============ 下载：先选字段 ============

type FieldKey = 'email' | 'count' | 'models'

interface ExportField {
  key: FieldKey
  label: string
  /** txt 里这一段的写法 */
  text: (row: Row) => string
  /** xlsx 里这一列 */
  column: XlsxColumn
  cell: (row: Row) => XlsxCellValue
}

/** 邮箱写完整值，不做隐私打码：导出的清单是给人核对用的 */
const EXPORT_FIELDS: ExportField[] = [
  {
    key: 'email',
    label: '邮箱',
    text: (row) => row.account.email,
    column: { title: '邮箱', width: 36 },
    cell: (row) => row.account.email
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
/** 勾选的字段，默认全选；跨两次下载保留，下次打开还是上次的选择 */
const exportKeys = ref<FieldKey[]>(EXPORT_FIELDS.map((field) => field.key))
const exportOptions = EXPORT_FIELDS.map((field) => ({ label: field.label, value: field.key }))

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
 * 按勾选的字段导出当前筛选下的成功账号；字段顺序固定为 邮箱 → 数量 → 模型列表，
 * 与勾选的先后无关。
 * - txt：一行一个账号，字段之间用 ---- 连接，模型列表用逗号分隔
 * - xlsx：每个字段一列
 */
async function download(): Promise<void> {
  const kind = exportKind.value
  const list = downloadable.value
  const fields = EXPORT_FIELDS.filter((field) => exportKeys.value.includes(field.key))
  if (!kind || !list.length || !fields.length) return

  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  const filename = `models-${list.length}个-${stamp}.${kind}`

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
  if (res.data?.saved) message.success(`已导出 ${list.length} 个账号的模型列表`)
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
      message="按列表顺序逐个向 Kiro 官方查询每个账号可用的模型，单个失败不影响后续账号。不同订阅档位能用的模型可能不同。"
    />

    <div class="summary">
      <span class="count-text">共 {{ stat.total }} 个账号</span>
      <a-tag v-if="stat.ok" color="green" :bordered="false">成功 {{ stat.ok }}</a-tag>
      <a-tag v-if="stat.fail" color="red" :bordered="false">失败 {{ stat.fail }}</a-tag>
      <a-tag v-if="stat.pending" :bordered="false">未获取 {{ stat.pending }}</a-tag>
      <span class="spacer" />
      <span v-if="running" class="count-text">
        正在获取 {{ stat.ok + stat.fail + 1 }}/{{ stat.total }}
      </span>
    </div>

    <!-- 按模型数量归类：有结果后才出现，点某一档只看那些账号，下载也只导出这一档 -->
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
        <a-radio-button v-for="[n, accounts] in countGroups" :key="n" :value="n">
          {{ n }} 个模型（{{ accounts }}）
        </a-radio-button>
        <a-radio-button v-if="stat.fail" value="fail">获取失败（{{ stat.fail }}）</a-radio-button>
      </a-radio-group>
    </div>

    <div ref="listRef" class="row-list">
      <div v-if="!visibleRows.length" class="empty muted">这一档下没有账号</div>
      <div
        v-for="{ row, index } in visibleRows"
        :key="row.account.id"
        :data-row-index="index"
        class="row"
        :class="row.state"
      >
        <!-- 第一排：邮箱 + 订阅档位，右侧状态 / 模型数量 -->
        <div class="row-head">
          <!-- 点击复制完整邮箱（不受隐私打码影响），悬停高亮提示可点 -->
          <span
            class="row-email"
            title="点击复制邮箱"
            @click="copyText(row.account.email, '已复制邮箱')"
          >{{ email(row.account) }}</span>
          <a-tag :bordered="false" class="tier-tag">{{ subscriptionLabel(row.account.subscription) }}</a-tag>
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
        <!--
          第二排：模型列表铺满整行完整显示。每个模型 ID 自成一段、不在中间断开，
          放不下就在两个模型之间换行。
        -->
        <div v-if="row.models" class="row-models mono">
          <span v-for="(id, i) in row.models" :key="id" class="model-id">{{ id }}{{ i < row.models.length - 1 ? '、' : '' }}</span>
        </div>
      </div>
    </div>

    <div class="footer">
      <!--
        按钮组：主按钮「下载 JSON」走账号导出弹窗（导出这批账号本身），
        右侧下箭头展开 txt / xlsx（导出模型清单，下载前先选字段）。

        注意：a-space-compact 里**不要**夹 HTML 注释。它会遍历子节点逐个包装来算
        首尾圆角，注释节点混进去会让它错位，右侧下拉因此收不到点击、点箭头毫无反应。
        说明一律写在组件外面。
      -->
      <a-space-compact :size="settingsStore.compactSize">
        <a-button :disabled="noDownload" @click="openAccountExport">
          <template #icon><DownloadOutlined /></template>
          下载 JSON（{{ downloadable.length }}）
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
      :title="`下载 ${exportKind ?? ''}（${downloadable.length}个账号）`"
      centered
      width="420px"
      ok-text="下载"
      :ok-button-props="{ disabled: !exportKeys.length }"
      @ok="download"
      @cancel="exportKind = null"
    >
      <p class="muted export-tip">选择要导出的字段，按 邮箱 → 模型数量 → 模型列表 的顺序排列。</p>
      <a-checkbox-group v-model:value="exportKeys" :options="exportOptions" class="export-fields" />
    </a-modal>

    <!--
      JSON：复用账号管理的导出弹窗（JSON / OIDC / 卡密… 各种导出模式都在里面），
      导出范围是当前筛选下获取成功的这批账号，比如只导出「9 个模型」那一档。
    -->
    <ExportAccountsModal
      v-if="accountExportOpen"
      v-model:open="accountExportOpen"
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

/* 固定高度：账号 1 个还是几百个，弹窗都一样高，超出在列表内滚动 */
.row-list { height: 46vh; overflow: auto; display: flex; flex-direction: column; gap: 8px; }
/* 每个账号上下两排：第一排邮箱 + 状态，第二排模型列表铺满整行 */
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
/* 邮箱可点复制：悬停变主题色，与账号卡片悬停邮箱的反馈一致 */
.row-email {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  cursor: pointer;
  transition: color 0.15s;
}
.row-email:hover { color: var(--kal-primary); }
.tier-tag { flex: 0 0 auto; margin: 0; font-size: 11px; }
/* 模型列表完整显示：每个模型 ID 不在中间断开，放不下就在两个模型之间换行 */
.row-models { color: var(--kal-muted); font-size: 12px; line-height: 1.7; }
.model-id { white-space: nowrap; }

/* 状态 / 模型数量靠右，和邮箱同一排 */
.row-state { flex: 0 0 auto; max-width: 46%; display: flex; align-items: center; gap: 6px; font-size: 12px; }
.running-text { color: var(--kal-primary); }
.ok-icon, .ok-text { color: #52c41a; }
.fail-icon { color: #ff4d4f; flex: 0 0 auto; }
.fail-text { color: #ff4d4f; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.footer { display: flex; align-items: center; gap: 8px; margin-top: 16px; }

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
