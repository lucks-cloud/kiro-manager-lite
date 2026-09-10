<script setup lang="ts">
import { computed, h, onMounted, onUnmounted, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { message, Modal } from 'ant-design-vue'
import {
  AppstoreOutlined,
  CheckCircleFilled,
  CopyOutlined,
  DeleteOutlined,
  DownOutlined,
  DownloadOutlined,
  EditOutlined,
  ExclamationCircleFilled,
  EyeInvisibleOutlined,
  EyeOutlined,
  GlobalOutlined,
  KeyOutlined,
  PlusOutlined,
  PoweroffOutlined,
  ReloadOutlined,
  SearchOutlined,
  SettingOutlined,
  CalendarOutlined,
  FilterOutlined,
  SortAscendingOutlined,
  SwapOutlined,
  SyncOutlined,
  ThunderboltOutlined,
  UploadOutlined
} from '@ant-design/icons-vue'
import { useKeysStore } from '@/stores/keys'
import { useSettingsStore } from '@/stores/settings'
import { bodyPopupContainer, confirmDelete, confirmUseApiKey } from '@/utils/ui'
import {
  displayEmail as maskedEmail,
  displayKey as maskedKey,
  displayNote as maskedNote
} from '@/utils/display'
import {
  KEY_STATUS_META,
  formatCreditsPair,
  formatDate,
  formatDateTime,
  subscriptionMeta,
  usageColor
} from '@/utils/format'
import { normalizeSubscriptionType } from '@shared/subscription'
import { keyIssueOf, shouldSkipKeyUsageRefresh } from '@shared/refreshPolicy'
import RegionSelect from '@/components/common/RegionSelect.vue'
import VirtualGrid from '@/components/common/VirtualGrid.vue'
import UsageHistoryModal from '@/components/accounts/UsageHistoryModal.vue'
import GatewayHistoryModal from '@/components/keys/GatewayHistoryModal.vue'
import ApiKeyDetailDrawer from '@/components/keys/ApiKeyDetailDrawer.vue'
import ApiKeyTestModal from '@/components/keys/ApiKeyTestModal.vue'
import ApiKeyBatchTestModal from '@/components/keys/ApiKeyBatchTestModal.vue'
import ApiKeyFilterPanel from '@/components/keys/ApiKeyFilterPanel.vue'
import ExportApiKeysModal from '@/components/keys/ExportApiKeysModal.vue'
import GroupPanel from '@/components/common/GroupPanel.vue'
import GroupPickerModal from '@/components/common/GroupPickerModal.vue'
import BatchNoteModal from '@/components/common/BatchNoteModal.vue'
import DisplayModeSelect from '@/components/common/DisplayModeSelect.vue'
import { UNGROUPED } from '@/utils/groups'
import { keyGroupApi } from '@/utils/groupApi'
import { DEFAULT_REGION, regionLabel } from '@shared/regions'
import type {
  AccountDisplayMode,
  KeyEntry,
  KeyFilter,
  KeyGatewayConflict,
  KeyGatewayUsageStats,
  KeyStatus,
  KiroCapability,
  SubscriptionType
} from '@shared/types'

const store = useKeysStore()
const settingsStore = useSettingsStore()
const { data, status, activeKey, loading } = storeToRefs(store)
const precision = computed(() => settingsStore.settings.usagePrecision)
const privacyMode = computed(() => settingsStore.settings.privacyMode)
const search = ref('')

// 旧版 Kiro 不读端点覆盖，开启网关会「写成功但请求照旧」，加载时探测一次并给出提示
const capability = ref<KiroCapability | null>(null)
const gatewayUnsupported = computed(() => capability.value?.supportsKeyGateway === false)
async function detectCapability(): Promise<void> {
  const res = await window.api.getKiroCapability()
  if (res.success && res.data) capability.value = res.data
}

const addOpen = ref(false)
const addValue = ref('')
const addNote = ref('')
const adding = ref(false)
const importOpen = ref(false)
const importText = ref('')
const importing = ref(false)

const editOpen = ref(false)
const editId = ref('')
const editNote = ref('')
const exportOpen = ref(false)
const detailTarget = ref<KeyEntry | null>(null)
const testTarget = ref<KeyEntry | null>(null)
const batchTestOpen = ref(false)
const usageTarget = ref<KeyEntry | null>(null)
const gatewayHistoryTarget = ref<KeyEntry | null>(null)
const gatewayHistoryMetric = ref<'requests' | 'credits'>('requests')
const selectedIds = ref<string[]>([])
const sortKey = ref<'createdAt' | 'usage' | 'checked' | 'note'>('createdAt')

const filterOpen = ref(false)
/** 筛选条件常驻本页：面板收起后条件仍然生效 */
const filter = ref<KeyFilter>({ subscriptions: [], statuses: [], groupIds: [] })

/** 筛选面板里生效的条件数量，显示在筛选按钮的角标上 */
const activeFilterCount = computed(() => {
  const f = filter.value
  return (
    f.subscriptions.length +
    f.statuses.length +
    // 分组筛选另有独立按钮与角标，这里不重复计入
    // != null：输入框清空时给的是 null，按 !== undefined 判断会把它算成一个生效条件
    (f.usageMin != null ? 1 : 0) +
    (f.usageMax != null ? 1 : 0) +
    (f.daysRemainingMin != null ? 1 : 0) +
    (f.daysRemainingMax != null ? 1 : 0)
  )
})

/** 重置只清筛选面板自己的条件，分组筛选有独立按钮与「清除分组筛选」 */
function resetFilter(): void {
  filter.value = { subscriptions: [], statuses: [], groupIds: filter.value.groupIds }
}

// ============ 分组 ============
const groupOpen = ref(false)
/**
 * 分组面板里正开着改名弹窗或删除确认。
 * 这些弹窗 teleport 到 body，点它们会被 popover 当成「点了外面」而自动收起，
 * 面板连同弹窗一起被卸载。busy 期间按住 popover 不让它关。
 */
const groupBusy = ref(false)
const batchGroupOpen = ref(false)
const batchNoteOpen = ref(false)

function onGroupOpenChange(open: boolean): void {
  if (!open && groupBusy.value) return
  groupOpen.value = open
}

function toggleGroupFilter(id: string): void {
  const list = filter.value.groupIds
  filter.value.groupIds = list.includes(id) ? list.filter((v) => v !== id) : [...list, id]
}

/** 该 Key 所属分组名；分组已被删除时按未分组处理，标签不显示 */
function groupNameOf(entry: KeyEntry): string {
  return entry.groupId ? (store.groupMap.get(entry.groupId)?.name ?? '') : ''
}

// ============ 展示形态 ============
/** 与账号列表同一套三形态，各记一份设置，两边可以不一样 */
const displayMode = computed(() => settingsStore.settings.keyDisplayMode)

function setDisplayMode(mode: AccountDisplayMode): void {
  void settingsStore.update({ keyDisplayMode: mode })
}

/** 分组读写门面，与账号列表共用同一组分组组件 */
const groupApi = keyGroupApi()

/** 批量备注：覆盖式改写所选 Key 的备注，留空即清空 */
const savingNote = ref(false)

async function applyBatchNote(note: string): Promise<void> {
  savingNote.value = true
  try {
    const res = await store.setNoteForKeys(selectedIds.value, note)
    if (res.error) return void message.error(res.error)
    message.success(
      note.trim() ? `已为 ${res.changed ?? 0} 个 Key 设置备注` : `已清空 ${res.changed ?? 0} 个 Key 的备注`
    )
    batchNoteOpen.value = false
  } finally {
    savingNote.value = false
  }
}

/**
 * 每种形态的单元格预估高度与最小列宽。
 * 列表模式给一个不可能满足的列宽，列数就恒为 1，虚拟滚动那边不用开分支。
 */
const gridLayout = computed(() => {
  switch (displayMode.value) {
    case 'compact':
      return { minColumnWidth: 350, estimatedHeight: 250 }
    case 'list':
      return { minColumnWidth: 100000, estimatedHeight: 80 }
    default:
      return { minColumnWidth: 350, estimatedHeight: 320 }
  }
})

/**
 * 一张带报错的卡片比同类卡片高出多少像素 = 报错行本身 + 它上面那道间距。
 * 与下面 .error-line 的样式硬绑定：行高 18 + 上下各 3px padding = 24，
 * 再加 8px 间距（卡片 / 紧凑的 row-gap 与列表的网格行间距都是 8）= 32。
 * 三种形态取值相同，所以用一个常量；改样式要同步改这里。
 */
const ERROR_ROW_EXTRA = 32

function keyItemExtra(entry: KeyEntry): number {
  return keyIssue(entry) ? ERROR_ROW_EXTRA : 0
}

/**
 * 订阅档位：直接从上游返回的标题算，与账号管理共用同一个判定口径。
 * 不读历史的 tier 字段——那套小写分层没有 Pro Max，且早前把 pro max 并进了 pro+。
 */
function keyTier(entry: KeyEntry): SubscriptionType {
  return normalizeSubscriptionType(entry.subscription || '')
}

function keyStatusKey(entry: KeyEntry): KeyStatus {
  if (keyIssue(entry)) return 'error'
  return entry.lastCheckedAt ? 'normal' : 'unchecked'
}

/** 额度重置剩余天数；上游没给重置时间时返回 undefined（该 Key 不参与天数筛选） */
function keyDaysRemaining(entry: KeyEntry): number | undefined {
  if (!entry.nextResetAt) return undefined
  return Math.max(0, Math.ceil((entry.nextResetAt - Date.now()) / 86_400_000))
}

/** 筛选面板的命中计数：按全部 Key 统计，不受当前筛选影响 */
const keyStats = computed(() => {
  const bySubscription: Record<SubscriptionType, number> = {
    Free: 0,
    Pro: 0,
    Pro_Plus: 0,
    Pro_Max: 0,
    Power: 0,
    Teams: 0
  }
  const byStatus: Record<KeyStatus, number> = { normal: 0, error: 0, unchecked: 0 }
  for (const entry of data.value.keys) {
    const tier = keyTier(entry)
    bySubscription[tier] = (bySubscription[tier] ?? 0) + 1
    const status = keyStatusKey(entry)
    byStatus[status] = (byStatus[status] ?? 0) + 1
  }
  return { bySubscription, byStatus }
})
const configOpen = ref(false)
const configKrs = ref(19830)
const configCps = ref(19831)
const savingConfig = ref(false)
/** 添加 / 导入时为本批 Key 选择的区域 */
const addRegion = ref(DEFAULT_REGION)
const importRegion = ref(DEFAULT_REGION)
/** 正在换区的 Key */
const regionTarget = ref<KeyEntry | null>(null)
const regionValue = ref(DEFAULT_REGION)
const savingRegion = ref(false)
const syncingAll = ref(false)
const busyActions = ref(new Set<string>())

/**
 * 刷新按钮的加载态。除了本页发起的批量刷新，还要带上 store 的 syncRunning，
 * 这样自动刷新那一轮也能在按钮上反映出来（自动刷新只调 store，不经过本地 ref）。
 */
const syncing = computed(() => syncingAll.value || store.syncRunning)

type RestartPromptReason = 'gateway-enabled' | 'gateway-disabled' | 'key-selected'
interface RestartPrompt {
  reason: RestartPromptReason
  keyId?: string
  needRestart: boolean
}
const restartPrompt = ref<RestartPrompt | null>(null)
const restartingIde = ref(false)

/** 其它本地网关已接管 IDE 时的强制接管提示 */
const conflictPrompt = ref<{ conflict: KeyGatewayConflict; keyId?: string } | null>(null)
const inspectingConflict = ref(false)
const forcingTakeover = ref(false)
const restartPromptTitle = computed(() => {
  if (restartPrompt.value?.reason === 'gateway-enabled') return 'API Key 接管已开启'
  if (restartPrompt.value?.reason === 'gateway-disabled') return 'API Key 接管已关闭'
  return '当前 API Key 已切换'
})
const restartPromptKeyLabel = computed(() => {
  const keyId = restartPrompt.value?.keyId
  if (!keyId) return undefined
  const entry = data.value.keys.find((item) => item.id === keyId)
  return entry ? keyConfirmationLabel(entry) : undefined
})
const restartPromptMessage = computed(() => {
  const prompt = restartPrompt.value
  if (!prompt) return ''
  const keyLabel = restartPromptKeyLabel.value
  if (prompt.reason === 'key-selected') {
    return `已切换为 ${keyLabel || '新的 API Key'}，后续网关请求会立即使用该 Key。`
  }
  if (prompt.reason === 'gateway-disabled') {
    return prompt.needRestart
      ? 'API Key 网关已关闭。Kiro IDE 需要重启后，才会重新加载恢复后的官方端点。'
      : 'API Key 网关已关闭，Kiro IDE 的官方端点已经恢复。'
  }
  const enabledText = keyLabel
    ? `已开启网关并将 ${keyLabel} 设为当前 API Key。`
    : 'API Key 网关已开启。'
  return prompt.needRestart
    ? `${enabledText} Kiro IDE 需要重启后，才会重新加载本地网关端点。`
    : `${enabledText} 如当前 IDE 会话未重新连接，可重启后继续使用。`
})

const sortOptions = [
  { value: 'createdAt', label: '添加时间' },
  { value: 'usage', label: '用量占比' },
  { value: 'checked', label: '最后同步' },
  { value: 'note', label: '备注' }
] as const
const sortLabel = computed(() => sortOptions.find((item) => item.value === sortKey.value)?.label)

const filteredKeys = computed(() => {
  const needle = search.value.trim().toLowerCase()
  const {
    subscriptions,
    statuses,
    groupIds,
    usageMin,
    usageMax,
    daysRemainingMin,
    daysRemainingMax
  } = filter.value
  const groupSet = groupIds.length ? new Set(groupIds) : null
  return [...data.value.keys]
    .filter((entry) => {
      if (needle) {
        const hit =
          (entry.note || '').toLowerCase().includes(needle) ||
          entry.key.toLowerCase().includes(needle)
        if (!hit) return false
      }
      // 分组已被删除的 Key 一律视为未分组，避免残留 id 让它从列表里消失
      if (groupSet) {
        const key = entry.groupId && store.groupMap.has(entry.groupId) ? entry.groupId : UNGROUPED
        if (!groupSet.has(key)) return false
      }
      if (subscriptions.length && !subscriptions.includes(keyTier(entry))) return false
      if (statuses.length && !statuses.includes(keyStatusKey(entry))) return false
      // 范围条件一律用 != null 判断「是否已设置」：输入框清空后给的是 null，
      // 按 !== undefined 判断会把 null 当成已设置，比较时又转成 0，把列表筛成空
      const used = usageRatio(entry)
      if (usageMin != null && used < usageMin) return false
      if (usageMax != null && used > usageMax) return false
      const days = keyDaysRemaining(entry)
      if (daysRemainingMax != null && (days ?? Number.POSITIVE_INFINITY) > daysRemainingMax) {
        return false
      }
      if (daysRemainingMin != null && (days ?? Number.NEGATIVE_INFINITY) < daysRemainingMin) {
        return false
      }
      return true
    })
    .sort((a, b) => {
      const active = Number(b.id === data.value.activeKeyId) - Number(a.id === data.value.activeKeyId)
      if (active) return active
      if (sortKey.value === 'usage') return usageRatio(b) - usageRatio(a)
      if (sortKey.value === 'checked') return (b.lastCheckedAt || 0) - (a.lastCheckedAt || 0)
      if (sortKey.value === 'note') return (a.note || '').localeCompare(b.note || '')
      return b.createdAt - a.createdAt
    })
})

/**
 * 开启网关时默认使用的 Key：取界面上第一张卡片，保证弹窗里念的 Key 与用户看到的一致。
 * data.keys 是插入顺序（最早添加在前），与卡片的「活跃优先 + 排序 + 搜索」结果不同，
 * 直接用 keys[0] 会选中一个界面上根本不在首位的 Key。
 * 搜索把列表过滤空时回退到原始首个，避免明明有 Key 却提示先添加。
 */
const firstListedKey = computed<KeyEntry | undefined>(
  () => filteredKeys.value[0] ?? data.value.keys[0]
)

/** 虚拟网格使用稳定 ID 复用可见卡片，筛选和排序时不会错位。 */
function keyItemKey(entry: KeyEntry): string {
  return entry.id
}

const selectedSet = computed(() => new Set(selectedIds.value))
const visibleSelectedCount = computed(() => filteredKeys.value.filter((entry) => selectedSet.value.has(entry.id)).length)
/**
 * 批量操作（刷新、测活）的共同目标：有勾选就只处理勾选的，否则处理当前列表全部。
 * 一律从 filteredKeys 里筛，顺序与界面卡片保持一致，也自然排除被搜索过滤掉的。
 */
const batchTargets = computed(() =>
  selectedIds.value.length
    ? filteredKeys.value.filter((entry) => selectedSet.value.has(entry.id))
    : filteredKeys.value
)
/** 批量操作按钮的范围后缀：有勾选时把实际会处理的条数带到按钮上 */
const batchScopeSuffix = computed(() =>
  visibleSelectedCount.value ? `（${visibleSelectedCount.value}个）` : ''
)
const allVisibleSelected = computed(() => filteredKeys.value.length > 0 && visibleSelectedCount.value === filteredKeys.value.length)
const someVisibleSelected = computed(() => visibleSelectedCount.value > 0 && !allVisibleSelected.value)
// 复用筛选面板那一次遍历的结果，口径与状态 chip 完全一致
const normalCount = computed(() => keyStats.value.byStatus.normal)
const errorCount = computed(() => keyStats.value.byStatus.error)

function toggleSelect(id: string, checked: boolean): void {
  const next = new Set(selectedIds.value)
  checked ? next.add(id) : next.delete(id)
  selectedIds.value = [...next]
}

function toggleSelectVisible(checked: boolean): void {
  const next = new Set(selectedIds.value)
  for (const entry of filteredKeys.value) checked ? next.add(entry.id) : next.delete(entry.id)
  selectedIds.value = [...next]
}

/**
 * API Key 是否遮蔽只由全局「隐私打码」决定，本页所有展示位置一律走这里。
 * 此前接管面板与删除确认另用一个无条件打码的实现，关掉开关也看不到完整 Key。
 */
function displayKey(key: string): string {
  return maskedKey(key, privacyMode.value)
}

/** 邮箱跟随全局隐私打码，与账户管理一致 */
function displayEmail(email: string): string {
  return maskedEmail(email, privacyMode.value)
}

/** 备注同样跟随隐私打码：里面常写着用途、渠道等不比邮箱次要的信息 */
function displayNote(note?: string): string {
  return maskedNote(note, privacyMode.value)
}

function togglePrivacy(): void {
  void settingsStore.update({ privacyMode: !privacyMode.value })
}

const BAR_COUNT = 40

function usageRatio(entry: KeyEntry): number {
  if (!entry.totalCredits || !Number.isFinite(entry.totalCredits)) return 0
  return Math.min(1, Math.max(0, (entry.usedCredits || 0) / entry.totalCredits))
}

function usagePercent(entry: KeyEntry): number {
  return usageRatio(entry) * 100
}

function usagePercentText(entry: KeyEntry): string {
  const value = usagePercent(entry)
  if (value <= 0) return '0'
  if (value >= 100) return '100'
  return value.toFixed(2)
}

function filledBars(entry: KeyEntry): number {
  return Math.round(usageRatio(entry) * BAR_COUNT)
}

function keyUsageColor(entry: KeyEntry): string {
  return usageColor(usageRatio(entry))
}

const usageSubject = computed(() => {
  const entry = usageTarget.value
  if (!entry) return null
  return {
    id: `key:${entry.id}`,
    label: displayKey(entry.key),
    percentUsed: usageRatio(entry),
    noun: 'API Key'
  }
})

/**
 * 卡片上要展示的问题原因：管理面同步错误与对话测活错误取并集。
 * 只看 lastError 会漏掉被封禁的 Key —— 它们在 Get-Usage-Limits 上返回 200，
 * 只有真实对话才会暴露 403。
 */
/** 异常原因与跳过判定都走 shared/refreshPolicy，与主进程自动刷新保持同一口径 */
function keyIssue(entry: KeyEntry): string | undefined {
  return keyIssueOf(entry)
}

// ============ 网关调用统计 ============

/** 该 Key 的网关统计；没跑过请求返回 undefined，各模块显示占位符 */
function statsOf(entry: KeyEntry): KeyGatewayUsageStats | undefined {
  const s = store.gatewayStats[entry.id]
  return s && s.requests > 0 ? s : undefined
}

/** 数值型指标的展示：无数据统一用 - 占位 */
function statText(entry: KeyEntry, field: 'requests' | 'rpm'): string {
  const s = statsOf(entry)
  return s ? String(s[field]) : '-'
}

function successRateText(entry: KeyEntry): string {
  const s = statsOf(entry)
  if (!s) return '-'
  return ((s.succeeded / s.requests) * 100).toFixed(2)
}

/**
 * 积分消耗：取响应流里 MeteringEvent 的累计值，这是 Kiro 的计费口径。
 * 上游给的是长浮点（如 2.294253048623549），固定两位小数即可；
 * 上万后压成 k，避免撑破格子。请求跑过但没有计费事件时显示 0，与"从没跑过"的 - 区分。
 */
function creditText(entry: KeyEntry): string {
  const s = statsOf(entry)
  if (!s) return '-'
  if (s.metered >= 10000) return compactNumber(s.metered)
  return s.metered.toFixed(2)
}

function requestTip(entry: KeyEntry): string {
  const s = statsOf(entry)
  if (!s) return '该 Key 尚未经本地网关发出过请求'
  return (
    `对话请求 ${s.requests} 次：成功 ${s.succeeded} / 失败 ${s.failed}` +
    (s.auxRequests
      ? `\n另有辅助请求 ${s.auxRequests} 次（/mcp、模型列表等），失败 ${s.auxFailed} 次，不计入成功率`
      : '')
  )
}

function creditTip(entry: KeyEntry): string {
  const s = statsOf(entry)
  if (!s) return '该 Key 尚未经本地网关发出过请求'
  const unit = s.meteredUnit ? ` ${s.meteredUnit}` : ''
  return (
    `经网关累计消耗 ${s.metered.toFixed(4)}${unit}（来自服务端计费事件）\n` +
    '点击查看积分消耗曲线与明细'
  )
}

function successColor(entry: KeyEntry): string {
  const s = statsOf(entry)
  if (!s) return 'inherit'
  const rate = s.succeeded / s.requests
  if (rate >= 0.95) return '#52c41a'
  if (rate >= 0.8) return '#faad14'
  return '#ff4d4f'
}

/** 打开网关调用历史弹窗，metric 决定默认展示哪条曲线 */
function openGatewayHistory(entry: KeyEntry, metric: 'requests' | 'credits'): void {
  gatewayHistoryMetric.value = metric
  gatewayHistoryTarget.value = entry
}

/** 大数字压成 12.3k / 1.2M，避免撑破卡片上的窄格子 */
function compactNumber(n: number): string {
  if (!n) return '0'
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

function keyStatus(entry: KeyEntry): { color: string; text: string } {
  return KEY_STATUS_META[keyStatusKey(entry)]
}

/** 档位配色与账号管理共用同一张表：同一个订阅在两个页面看到同样的颜色 */
function subscriptionColor(entry: KeyEntry): string {
  return subscriptionMeta(keyTier(entry)).color
}

type BusyAction = 'select' | 'sync'

function actionBusy(id: string, action: BusyAction): boolean {
  return busyActions.value.has(`${id}:${action}`)
}

function setBusy(id: string, action: BusyAction, busy: boolean): void {
  const next = new Set(busyActions.value)
  const key = `${id}:${action}`
  busy ? next.add(key) : next.delete(key)
  busyActions.value = next
}

/** 打开时预填上次用过的区域，连续添加同区域的 Key 不用反复选 */
function openAdd(): void {
  addValue.value = ''
  addNote.value = ''
  addRegion.value = data.value.region || DEFAULT_REGION
  addOpen.value = true
}

function openImport(): void {
  importText.value = ''
  importRegion.value = data.value.region || DEFAULT_REGION
  importOpen.value = true
}

async function submitAdd(): Promise<void> {
  adding.value = true
  try {
    const rawKey = addValue.value.trim()
    const error = await store.add(rawKey, addNote.value, addRegion.value)
    if (error) return void message.error(error)
    const added = data.value.keys.find((entry) => entry.key === rawKey)
    const verifyError = added ? await store.sync(added.id) : null
    addOpen.value = false
    addValue.value = ''
    addNote.value = ''
    if (verifyError) message.warning(`Key 已保存，但远端校验失败：${verifyError}`)
    else message.success('API Key 已添加并校验通过')
  } finally {
    adding.value = false
  }
}

async function submitImport(): Promise<void> {
  importing.value = true
  try {
    const result = await store.importText(importText.value, importRegion.value)
    if (result.error) return void message.error(result.error)
    const synced = result.added ? await store.syncAll(false) : null
    if (synced && !synced.error) store.scheduleUsageRefresh()
    importOpen.value = false
    importText.value = ''
    const syncText = synced && !synced.error
      ? `；校验成功 ${synced.success}，失败 ${synced.failed}`
      : ''
    message.success(`已添加 ${result.added} 个，重复 ${result.skipped} 个，无效 ${result.invalid} 个${syncText}`)
  } finally {
    importing.value = false
  }
}

function openEdit(entry: KeyEntry): void {
  detailTarget.value = null
  editId.value = entry.id
  editNote.value = entry.note || ''
  editOpen.value = true
}

async function submitEdit(): Promise<void> {
  const error = await store.update(editId.value, editNote.value)
  if (error) return void message.error(error)
  editOpen.value = false
  message.success('备注已保存')
}

function clearDeletedKeyUi(ids: string[]): void {
  const deleted = new Set(ids)
  if (detailTarget.value && deleted.has(detailTarget.value.id)) detailTarget.value = null
  if (testTarget.value && deleted.has(testTarget.value.id)) testTarget.value = null
  if (usageTarget.value && deleted.has(usageTarget.value.id)) usageTarget.value = null
  if (gatewayHistoryTarget.value && deleted.has(gatewayHistoryTarget.value.id)) {
    gatewayHistoryTarget.value = null
  }
  if (regionTarget.value && deleted.has(regionTarget.value.id)) regionTarget.value = null
  if (editOpen.value && deleted.has(editId.value)) editOpen.value = false
  if (restartPrompt.value?.keyId && deleted.has(restartPrompt.value.keyId)) {
    restartPrompt.value = null
  }
  if (conflictPrompt.value?.keyId && deleted.has(conflictPrompt.value.keyId)) {
    conflictPrompt.value = null
  }
  busyActions.value = new Set(
    [...busyActions.value].filter((key) => !deleted.has(key.slice(0, key.lastIndexOf(':'))))
  )
}

function remove(entry: KeyEntry): void {
  const doRemove = async (): Promise<void> => {
    const error = await store.remove(entry.id)
    if (error) return void message.error(error)
    selectedIds.value = selectedIds.value.filter((id) => id !== entry.id)
    clearDeletedKeyUi([entry.id])
    message.success('已删除')
  }
  if (!settingsStore.settings.confirmBeforeDeleteApiKey) {
    void doRemove()
    return
  }
  confirmDelete({
    title: '删除 API Key',
    content: `确认删除 ${displayNote(entry.note) || displayKey(entry.key)}？此操作不可撤销。`,
    onOk: doRemove
  })
}

function keyConfirmationLabel(entry: KeyEntry): string {
  const key = displayKey(entry.key)
  const note = displayNote(entry.note)
  return note ? `${note}（${key}）` : key
}

async function applySelection(entry: KeyEntry): Promise<void> {
  if (actionBusy(entry.id, 'select')) return
  setBusy(entry.id, 'select', true)
  try {
    const error = await store.select(entry.id)
    if (error) return void message.error(error)
    restartPrompt.value = {
      reason: 'key-selected',
      keyId: entry.id,
      needRestart: false
    }
  } finally {
    setBusy(entry.id, 'select', false)
  }
}

/**
 * 开启网关前先探测是否已被其它本地网关接管。
 * 返回 true 表示已弹出强制接管弹窗，调用方不要再走常规确认。
 */
async function guardConflict(keyId?: string): Promise<boolean> {
  inspectingConflict.value = true
  try {
    const result = await store.inspectConflict()
    if (result.conflict) {
      conflictPrompt.value = { conflict: result.conflict, keyId }
      return true
    }
    // 探测本身失败不阻断开启：真正冲突时主进程仍会拒绝，并在下方引导强制接管
    if (result.error) message.warning(result.error)
    return false
  } finally {
    inspectingConflict.value = false
  }
}

/** 开启失败时的兜底：竞态下别的网关抢先接管，仍给出强制接管入口 */
async function handleEnableError(error: string, keyId?: string): Promise<boolean> {
  if (error.includes('本地网关') && (await guardConflict(keyId))) return true
  message.error(`开启网关失败：${error}`)
  return false
}

async function enableGatewayAndSelect(entry: KeyEntry): Promise<void> {
  if (actionBusy(entry.id, 'select')) return
  setBusy(entry.id, 'select', true)
  try {
    const error = await store.setEnabled(true, entry.id)
    if (error) {
      if (await handleEnableError(error, entry.id)) return
      throw new Error(error)
    }

    restartPrompt.value = {
      reason: 'gateway-enabled',
      keyId: entry.id,
      needRestart: status.value?.needRestart ?? true
    }
  } finally {
    setBusy(entry.id, 'select', false)
  }
}

async function confirmEnableGatewayAndSelect(entry: KeyEntry): Promise<void> {
  if (await guardConflict(entry.id)) return
  const label = keyConfirmationLabel(entry)
  Modal.confirm({
    title: 'API Key 网关未开启',
    content: `切换到 ${label} 前需要先开启网关。开启后会将 Kiro IDE 的 AI 请求端点切换到本地网关。`,
    okText: '开启网关并使用该 API Key',
    okType: 'primary',
    cancelText: '取消',
    onOk: () => enableGatewayAndSelect(entry)
  })
}

/** 结束占用旧端点的其它本地网关，并把端点强制改写到本应用 */
async function forceTakeover(): Promise<void> {
  const prompt = conflictPrompt.value
  if (!prompt || forcingTakeover.value) return
  forcingTakeover.value = true
  try {
    const error = await store.setEnabled(true, prompt.keyId, true)
    if (error) return void message.error(`强制接管失败：${error}`)
    conflictPrompt.value = null
    message.success('已强制接管 Kiro IDE 的 AI 请求端点')
    restartPrompt.value = {
      reason: 'gateway-enabled',
      keyId: prompt.keyId ?? data.value.activeKeyId ?? undefined,
      needRestart: status.value?.needRestart ?? true
    }
  } finally {
    forcingTakeover.value = false
  }
}

function select(entry: KeyEntry): void {
  if (entry.id === data.value.activeKeyId || actionBusy(entry.id, 'select')) return
  if (gatewayUnsupported.value) {
    showUnsupportedModal()
    return
  }
  if (!data.value.enabled) {
    void confirmEnableGatewayAndSelect(entry)
    return
  }
  confirmUseApiKey(keyConfirmationLabel(entry), () => applySelection(entry))
}

async function sync(entry: KeyEntry): Promise<void> {
  setBusy(entry.id, 'sync', true)
  try {
    const error = await store.sync(entry.id)
    if (error) return void message.error(error)
    message.success('订阅与额度已同步')
  } finally {
    setBusy(entry.id, 'sync', false)
  }
}

async function syncAll(): Promise<void> {
  // 与批量测活共用目标口径：勾选项同样只取界面上可见的那些
  const scope = batchTargets.value
  const isFullRun = !selectedIds.value.length

  // 全量刷新时跳过确定性失败的 Key（凭证被拒、403、封禁），省下必然白跑的请求。
  // 勾选场景不跳过：用户已经明确指定了目标。单个卡片的刷新按钮同样不受影响。
  const targets = isFullRun ? scope.filter((entry) => !shouldSkipKeyUsageRefresh(entry)) : scope
  const skipped = scope.length - targets.length
  if (!targets.length) {
    return void message.info(
      skipped ? `${skipped} 个 API Key 凭证已失效，已全部跳过` : '没有可刷新的 API Key'
    )
  }

  syncingAll.value = true
  try {
    const result = await store.syncMany(targets.map((entry) => entry.id))
    if (result.error) return void message.error(result.error)
    // 只有刷了当前列表全部才算「刷了全量」，据此把自动刷新整轮往后顺延
    if (isFullRun) store.scheduleUsageRefresh()
    const skippedText = skipped ? `，跳过 ${skipped}` : ''
    const text = `用量刷新完成：成功 ${result.success}，失败 ${result.failed}${skippedText}`
    result.failed ? message.warning(text) : message.success(text)
  } finally {
    syncingAll.value = false
  }
}

function test(entry: KeyEntry): void {
  testTarget.value = entry
}

function removeSelected(): void {
  const ids = [...selectedIds.value]
  if (!ids.length) return void message.info('请先选择 API Key')
  const execute = async (): Promise<void> => {
    const deletedIds: string[] = []
    let failed = 0
    for (const id of ids) {
      const error = await store.remove(id)
      if (error) failed++
      else deletedIds.push(id)
    }
    selectedIds.value = selectedIds.value.filter((id) => data.value.keys.some((entry) => entry.id === id))
    clearDeletedKeyUi(deletedIds)
    const text = `已删除 ${deletedIds.length} 个${failed ? `，失败 ${failed} 个` : ''}`
    failed ? message.warning(text) : message.success(text)
  }
  if (!settingsStore.settings.confirmBeforeDeleteApiKey) return void execute()
  confirmDelete({
    title: `删除 ${ids.length} 个 API Key`,
    content: '删除后无法恢复；正在接管中使用的当前 Key 会被保护，不会删除。',
    onOk: execute
  })
}

function copy(entry: KeyEntry): void {
  window.api.writeClipboard(entry.key)
  message.success('完整 API Key 已复制')
}

function exportKeys(): void {
  exportOpen.value = true
}

/** target 由确认弹窗传入，确保最终启用的就是弹窗里确认过的那个 Key */
async function toggleGateway(checked: boolean, target?: KeyEntry): Promise<void> {
  const targetKey = checked ? target ?? firstListedKey.value : undefined
  if (checked && !targetKey) {
    message.warning('请先添加 API Key')
    return
  }
  const error = await store.setEnabled(checked, targetKey?.id)
  if (error) {
    if (checked) await handleEnableError(error, targetKey?.id)
    else message.error(error)
    return
  }
  if (checked) {
    restartPrompt.value = {
      reason: 'gateway-enabled',
      keyId: targetKey?.id,
      needRestart: status.value?.needRestart ?? true
    }
  } else {
    restartPrompt.value = {
      reason: 'gateway-disabled',
      needRestart: status.value?.needRestart ?? true
    }
  }
}

/** 版本不支持弹窗：切换 Key 和开启网关共用 */
function showUnsupportedModal(): void {
  const ver = capability.value?.version
  Modal.warning({
    title: '当前 Kiro 版本不支持本地网关',
    content: h('div', [
      h('p', `检测到 Kiro ${ver || '(未知版本)'}，当前版本不支持本地网关。`),
      h('p', '请升级 Kiro 到 0.12.xxx 及以上版本后再使用。'),
      h(
        'a',
        {
          href: 'https://kiro.dev/downloads/',
          target: '_blank',
          rel: 'noopener noreferrer',
          style: 'display:inline-block;margin-top:8px'
        },
        '前往 Kiro 官网下载最新版本 →'
      )
    ]),
    okText: '我知道了'
  })
}

async function confirmToggleGateway(): Promise<void> {
  const enabling = !data.value.enabled
  const firstKey = firstListedKey.value
  if (enabling && gatewayUnsupported.value) {
    showUnsupportedModal()
    return
  }
  if (enabling && !firstKey) {
    message.warning('请先添加 API Key')
    return
  }
  if (enabling && (await guardConflict(firstKey?.id))) return
  Modal.confirm({
    title: enabling ? '开启 API Key 网关' : '关闭 API Key 网关',
    content: enabling
      ? `开启后会将 Kiro IDE 的 AI 请求端点切换到本地网关，并使用列表最上方的第一个 API Key：${firstKey ? keyConfirmationLabel(firstKey) : ''}`
      : '关闭后会停止接管 Kiro IDE 的 AI 请求，并还原官方端点。',
    okText: enabling ? '开启网关' : '关闭网关',
    okType: 'primary',
    okButtonProps: { danger: !enabling },
    cancelText: '取消',
    onOk: () => toggleGateway(enabling, firstKey)
  })
}

function openConfig(): void {
  configKrs.value = data.value.ports.krs
  configCps.value = data.value.ports.cps
  configOpen.value = true
}

async function saveConfig(): Promise<void> {
  savingConfig.value = true
  try {
    const error = await store.configure(configKrs.value, configCps.value)
    if (error) return void message.error(error)
    configOpen.value = false
    message.success('网关配置已保存')
  } finally {
    savingConfig.value = false
  }
}

// ============ 单个 Key 换区 ============

function openRegion(entry: KeyEntry): void {
  regionTarget.value = entry
  regionValue.value = entry.region
}

async function submitRegion(): Promise<void> {
  const target = regionTarget.value
  if (!target) return
  const next = regionValue.value.trim()
  if (!next) return void message.warning('请选择或填写区域')
  if (next === target.region) {
    regionTarget.value = null
    return
  }
  savingRegion.value = true
  try {
    const error = await store.setRegion(target.id, next)
    if (error) return void message.error(error)
    regionTarget.value = null
    message.success(`区域已改为 ${next}，已重新同步额度`)
  } finally {
    savingRegion.value = false
  }
}

async function restartIde(): Promise<boolean> {
  restartingIde.value = true
  try {
    const result = await window.api.restartKiroIde()
    if (!result.success || !result.data) {
      message.error(result.error || '重启 Kiro IDE 失败')
      return false
    }
    if (!result.data.started) {
      message.warning(result.data.message)
      return false
    }
    message.success(result.data.message)
    if (status.value) status.value = { ...status.value, needRestart: false }
    return true
  } catch (cause) {
    message.error(cause instanceof Error ? cause.message : '重启 Kiro IDE 失败')
    return false
  } finally {
    restartingIde.value = false
  }
}

async function confirmRestart(): Promise<void> {
  if (await restartIde()) restartPrompt.value = null
}

onMounted(() => {
  // Key 数据由 App 统一加载，避免进入本页时重复 IPC 和整表替换。
  void detectCapability()
})

/**
 * 统计已持久化，网关关闭时累计值依然要显示，所以进页面就先拉一次。
 * 但只有网关运行时才需要持续轮询（RPM 与新增请求会变），关闭后停掉定时器。
 */
watch(
  () => data.value.enabled,
  (enabled) => {
    if (enabled) store.startStatsPolling()
    else {
      store.stopStatsPolling()
      void store.refreshStats()
    }
  },
  { immediate: true }
)

onUnmounted(() => store.stopStatsPolling())
</script>

<template>
  <div class="keys-page">
    <a-card class="gateway-card" :bordered="false">
      <div class="gateway-row">
        <div class="gateway-main">
          <div class="gateway-title">
            <KeyOutlined />
            <strong>API Key 接管</strong>
            <a-tag :color="status?.ideTakenOver ? 'success' : data.enabled ? 'warning' : 'default'">
              {{ status?.ideTakenOver ? '运行中' : data.enabled ? '启动中' : '未开启' }}
            </a-tag>
            <a-tooltip
              v-if="status?.endpointsHijacked"
              title="Kiro IDE 把 settings.json 里的端点改回去了，应用已自动改写回本地网关。若该提示长期不消失，请检查该文件是否可写。"
            >
              <a-tag color="warning">端点被回写，已自动恢复</a-tag>
            </a-tooltip>
          </div>
          <div class="gateway-desc">
            当前：{{
              displayNote(activeKey?.note) ||
              (activeKey ? displayKey(activeKey.key) : '未选择 Key')
            }}
            · {{ activeKey?.region || status?.region || DEFAULT_REGION }}
            · KRS {{ data.ports.krs }} / CPS {{ data.ports.cps }}
          </div>
          <div class="gateway-hint">
            API Key 不会替换 IDE 登录账号；开启后仅将 AI 请求额度切换为当前 Key。
            默认端口为 KRS 19830 / CPS 19831。
          </div>
        </div>
        <a-button
          :type="data.enabled ? 'primary' : 'default'"
          :danger="data.enabled"
          :loading="loading || inspectingConflict"
          @click="confirmToggleGateway"
        >
          <template #icon><PoweroffOutlined /></template>
          {{ data.enabled ? '关闭网关' : '开启网关' }}
        </a-button>
        <a-tooltip :title="data.enabled ? '关闭接管后才能修改' : '本地网关端口'">
          <a-button :disabled="data.enabled || loading" @click="openConfig">
            <template #icon><SettingOutlined /></template>
          </a-button>
        </a-tooltip>
      </div>

      <a-alert
        v-if="gatewayUnsupported"
        class="gateway-unsupported"
        type="warning"
        show-icon
        message="当前 Kiro 版本不支持本地网关"
      >
        <template #description>
          <span>
            检测到 Kiro {{ capability?.version || '(未知版本)' }}，当前版本不支持本地网关。请升级 Kiro 到 0.12.xxx 及以上版本后再使用。
          </span>
          <a
            href="https://kiro.dev/downloads/"
            target="_blank"
            rel="noopener noreferrer"
            style="margin-left: 8px"
          >前往下载新版本 →</a>
        </template>
      </a-alert>
    </a-card>

    <div class="keys-header">
      <div class="toolbar">
        <a-input v-model:value="search" allow-clear placeholder="搜索备注或 API Key" class="search-input">
          <template #prefix><SearchOutlined /></template>
        </a-input>
        <span class="spacer" />
        <a-button type="primary" @click="openAdd">
          <template #icon><PlusOutlined /></template>添加 API Key
        </a-button>
        <a-button @click="openImport"><template #icon><UploadOutlined /></template>导入</a-button>
        <a-button :disabled="!data.keys.length" @click="exportKeys">
          <template #icon><DownloadOutlined /></template>导出
        </a-button>
      </div>

      <div class="meta-bar">
        <span class="count-text">共 {{ filteredKeys.length }} 个 API Key</span>
        <a-tag v-if="normalCount" color="green" :bordered="false">正常 {{ normalCount }}</a-tag>
        <a-tag v-if="errorCount" color="red" :bordered="false">异常 {{ errorCount }}</a-tag>
        <a-tag v-if="activeFilterCount" color="purple" closable @close="resetFilter">
          筛选中 {{ activeFilterCount }} 项
        </a-tag>
        <span class="spacer" />

        <a-popover
          v-model:open="filterOpen"
          trigger="click"
          placement="bottomRight"
          :get-popup-container="bodyPopupContainer"
        >
          <template #title>
            <span>筛选条件</span>
          </template>
          <template #content>
            <ApiKeyFilterPanel
              v-if="filterOpen"
              :filter="filter"
              :by-subscription="keyStats.bySubscription"
              :by-status="keyStats.byStatus"
              :matched="filteredKeys.length"
              @reset="resetFilter"
            />
          </template>
          <a-badge :count="activeFilterCount" :offset="[-4, 4]">
            <a-button size="small" :type="activeFilterCount ? 'primary' : 'default'">
              <template #icon><FilterOutlined /></template>
              筛选
            </a-button>
          </a-badge>
        </a-popover>

        <!-- 分组：管理入口 + 按分组筛选，与账号列表同一套交互 -->
        <a-popover
          :open="groupOpen"
          trigger="click"
          placement="bottomRight"
          :get-popup-container="bodyPopupContainer"
          @open-change="onGroupOpenChange"
        >
          <template #title>
            <span>分组</span>
          </template>
          <template #content>
            <GroupPanel
              v-if="groupOpen"
              :api="groupApi"
              :selected="filter.groupIds"
              :matched="filteredKeys.length"
              entity="Key"
              @toggle="toggleGroupFilter"
              @clear="filter.groupIds = []"
              @busy="groupBusy = $event"
            />
          </template>
          <a-badge :count="filter.groupIds.length" :offset="[-4, 4]">
            <a-button size="small" :type="filter.groupIds.length ? 'primary' : 'default'">
              <template #icon><AppstoreOutlined /></template>
              分组
            </a-button>
          </a-badge>
        </a-popover>

        <a-dropdown>
          <a-button size="small">
            <template #icon><SortAscendingOutlined /></template>
            {{ sortLabel }} <DownOutlined />
          </a-button>
          <template #overlay>
            <a-menu :selected-keys="[sortKey]">
              <a-menu-item v-for="item in sortOptions" :key="item.value" @click="sortKey = item.value">
                {{ item.label }}
              </a-menu-item>
            </a-menu>
          </template>
        </a-dropdown>
        <a-divider type="vertical" style="margin: 0 2px" />
        <a-button size="small" :loading="syncing" @click="syncAll">
          <template #icon><SyncOutlined /></template>
          {{ syncing ? `正在刷新${visibleSelectedCount ? visibleSelectedCount + '个API Key' : ''}用量/积分...` : `刷新用量/积分${batchScopeSuffix}` }}
        </a-button>
        <a-button
          size="small"
          :type="privacyMode ? 'primary' : 'default'"
          @click="togglePrivacy"
        >
          <template #icon>
            <EyeInvisibleOutlined v-if="privacyMode" />
            <EyeOutlined v-else />
          </template>
          {{ privacyMode ? '隐私打码中' : '隐私打码' }}
        </a-button>

        <!-- 展示形态：卡片 / 紧凑 / 列表，选择会持久化 -->
        <DisplayModeSelect :value="displayMode" @change="setDisplayMode" />

        <a-button size="small" :disabled="!batchTargets.length" @click="batchTestOpen = true">
          <template #icon><ThunderboltOutlined /></template>
          批量测活{{ batchScopeSuffix }}
        </a-button>
        <!-- 批量操作作用于全部勾选项 -->
        <a-dropdown v-if="selectedIds.length">
          <a-button size="small">
            批量操作（{{ selectedIds.length }}个）
            <DownOutlined />
          </a-button>
          <template #overlay>
            <a-menu>
              <a-menu-item key="note" @click="batchNoteOpen = true">
                <EditOutlined />
                批量设置备注
              </a-menu-item>
              <a-menu-item key="group" @click="batchGroupOpen = true">
                <AppstoreOutlined />
                批量设置分组
              </a-menu-item>
            </a-menu>
          </template>
        </a-dropdown>
        <!-- 删除作用于全部勾选项（不受当前搜索影响），条数与确认弹窗里的数字一致 -->
        <a-button v-if="selectedIds.length" size="small" danger @click="removeSelected">
          <template #icon><DeleteOutlined /></template>
          删除（{{ selectedIds.length }}个）
        </a-button>
        <a-divider type="vertical" style="margin: 0 2px" />
        <a-checkbox
          :checked="allVisibleSelected"
          :indeterminate="someVisibleSelected"
          :disabled="!filteredKeys.length"
          @change="(event: any) => toggleSelectVisible(event.target.checked)"
        >全选</a-checkbox>
        <template v-if="selectedIds.length">
          <span class="count-text">已选 {{ selectedIds.length }}</span>
          <a-button type="link" size="small" @click="selectedIds = []">清空</a-button>
        </template>
      </div>
    </div>

    <!-- API Key 卡片同样使用虚拟网格：无论总数多少，只挂载视口附近的卡片。 -->
    <!--
      key 绑定展示形态：切换形态时行高相差很大，而虚拟滚动量到的高度只允许变高，
      重挂载一次让它重新测量。
    -->
    <VirtualGrid
      v-if="filteredKeys.length"
      :key="displayMode"
      class="key-grid"
      :items="filteredKeys"
      :item-key="keyItemKey"
      :item-extra="keyItemExtra"
      :min-column-width="gridLayout.minColumnWidth"
      :gap="displayMode === 'list' ? 8 : 10"
      :estimated-height="gridLayout.estimatedHeight"
    >
      <template #default="{ item: entry }">
        <a-card
          class="key-card"
        :class="[
          `mode-${displayMode}`,
          { active: entry.id === data.activeKeyId, selected: selectedSet.has(entry.id) }
        ]"
        hoverable
        @click="toggleSelect(entry.id, !selectedSet.has(entry.id))"
      >
        <div class="key-head">
          <div class="key-name">
            <a-checkbox
              :checked="selectedSet.has(entry.id)"
              @click.stop
              @change="(event: any) => toggleSelect(entry.id, event.target.checked)"
            />
            <!--
              整卡点击 = 勾选 / 取消勾选，有自己语义的区域各自 stop：
              这块开详情，用量块开积分变化，统计格开曲线，右下动作区各干各的。
            -->
            <div class="key-identity" @click.stop="detailTarget = entry">
              <span
                class="key-value mono"
                :title="privacyMode ? undefined : entry.key"
              >{{ displayKey(entry.key) }}</span>
              <span
                class="key-email muted"
                :title="entry.email && !privacyMode ? entry.email : undefined"
              >邮箱：{{ entry.email ? displayEmail(entry.email) : '-' }}</span>
              <span
                class="key-note muted"
                :title="entry.note && !privacyMode ? entry.note : undefined"
              >备注：{{ displayNote(entry.note) || '-' }}</span>
            </div>
          </div>
        </div>

        <div class="tag-row">
          <a-tag :color="keyStatus(entry).color" class="status-tag">
            {{ keyStatus(entry).text }}
          </a-tag>
          <a-tag :color="subscriptionColor(entry)" :bordered="false">
            {{ entry.subscription || '等级未知' }}
          </a-tag>
          <!-- 分组标签：没分组就不显示，避免每张卡都多一个空标签 -->
          <a-tag
            v-if="groupNameOf(entry)"
            class="group-tag"
            color="purple"
            :bordered="false"
            :title="`分组：${groupNameOf(entry)}`"
          >
            {{ groupNameOf(entry) }}
          </a-tag>
          <a-tooltip :title="`${regionLabel(entry.region)}，点击修改所属区域`">
            <button class="region-chip mono" @click.stop="openRegion(entry)">
              <GlobalOutlined />
              {{ entry.region }}
            </button>
          </a-tooltip>
        </div>

        <div
          class="usage-block"
          title="点击查看积分变化"
          @click.stop="usageTarget = entry"
        >
          <div class="usage-head">
            <span class="usage-title">
              <span class="muted">使用量</span>
              <span
                class="usage-updated muted"
                :title="entry.lastCheckedAt ? `用量与积分更新于 ${formatDateTime(entry.lastCheckedAt)}` : undefined"
              >
                {{ entry.lastCheckedAt ? formatDateTime(entry.lastCheckedAt) : '尚未同步' }}
              </span>
            </span>
            <strong class="usage-percent" :style="{ color: keyUsageColor(entry) }">
              {{ usagePercentText(entry) }}<small>%</small>
            </strong>
          </div>
          <div
            class="usage-bars"
            :style="{ '--bar-on': keyUsageColor(entry) }"
            role="progressbar"
            aria-valuemin="0"
            aria-valuemax="100"
            :aria-valuenow="Math.round(usagePercent(entry))"
          >
            <span
              v-for="i in BAR_COUNT"
              :key="i"
              class="bar"
              :class="{ on: i <= filledBars(entry) }"
            />
          </div>
          <div class="usage-foot">
            <span class="usage-number">
              {{ formatCreditsPair(entry.usedCredits ?? 0, entry.totalCredits ?? 0, precision) }}
            </span>
            <!-- 与账号卡片同一位置的口径：有重置时间就显示它，否则退回额度说明 -->
            <span v-if="entry.nextResetAt" class="muted" :title="`额度重置剩余 ${keyDaysRemaining(entry)} 天`">
              <CalendarOutlined />
              {{ formatDate(entry.nextResetAt) }} 重置
            </span>
            <span v-else class="muted">已用 / 总额度</span>
          </div>
        </div>

        <!-- 网关实际调用统计：始终占位，没有数据显示 -，保证所有卡片高度一致 -->
        <div class="stat-grid">
          <div
            class="stat-cell clickable"
            :title="requestTip(entry)"
            @click.stop="openGatewayHistory(entry, 'requests')"
          >
            <span class="stat-label">请求</span>
            <strong class="stat-value">{{ statText(entry, 'requests') }}</strong>
          </div>
          <div
            class="stat-cell clickable"
            title="2xx 响应占全部请求的比例，点击查看成功率曲线"
            @click.stop="openGatewayHistory(entry, 'requests')"
          >
            <span class="stat-label">成功率</span>
            <strong class="stat-value" :style="{ color: successColor(entry) }">
              {{ successRateText(entry) }}<small v-if="statsOf(entry)">%</small>
            </strong>
          </div>
          <div
            class="stat-cell clickable"
            title="最近一分钟经网关发出的请求数（重启后重新计算），点击查看请求量曲线"
            @click.stop="openGatewayHistory(entry, 'requests')"
          >
            <span class="stat-label">RPM</span>
            <strong class="stat-value">{{ statText(entry, 'rpm') }}</strong>
          </div>
          <div
            class="stat-cell clickable"
            :title="creditTip(entry)"
            @click.stop="openGatewayHistory(entry, 'credits')"
          >
            <span class="stat-label">积分</span>
            <strong class="stat-value">{{ creditText(entry) }}</strong>
          </div>
        </div>

        <!--
          报错行只在真有问题时渲染。原先这里是个恒定 27px 的占位块（为了让所有卡片等高），
          现在改由虚拟滚动的 itemExtra 只给「同一行里真有报错」的那一行加高，
          没报错的行不必再白留一条。
        -->
        <a-tooltip v-if="keyIssue(entry)" placement="topLeft">
          <template #title>
            <span class="error-tip">{{ keyIssue(entry) }}</span>
          </template>
          <div class="error-line">{{ keyIssue(entry) }}</div>
        </a-tooltip>

        <div class="key-actions" @click.stop>
          <div class="key-switch-action">
            <span v-if="entry.id === data.activeKeyId" class="current-key-label">
              <CheckCircleFilled />
              当前使用
            </span>
            <a-button
              v-else
              type="link"
              size="small"
              class="switch-key-btn"
              :loading="actionBusy(entry.id, 'select')"
              @click.stop="select(entry)"
            >
              <template #icon><SwapOutlined /></template>
              切换到该 Key
            </a-button>
          </div>
          <div class="action-row">
            <a-tooltip title="刷新用量与积分">
              <a-button
                type="text"
                size="small"
                class="action-btn"
                :loading="actionBusy(entry.id, 'sync')"
                @click.stop="sync(entry)"
              >
                <template #icon><SyncOutlined /></template>
              </a-button>
            </a-tooltip>
            <a-tooltip title="测活（发一次真实对话）">
              <a-button type="text" size="small" class="action-btn" @click.stop="test(entry)">
                <template #icon><ThunderboltOutlined /></template>
              </a-button>
            </a-tooltip>
            <a-tooltip title="复制完整 API Key">
              <a-button type="text" size="small" class="action-btn" @click.stop="copy(entry)">
                <template #icon><CopyOutlined /></template>
              </a-button>
            </a-tooltip>
            <a-tooltip title="修改备注">
              <a-button type="text" size="small" class="action-btn" @click.stop="openEdit(entry)">
                <template #icon><EditOutlined /></template>
              </a-button>
            </a-tooltip>
            <a-tooltip title="删除">
              <a-button type="text" size="small" class="action-btn" danger @click.stop="remove(entry)">
                <template #icon><DeleteOutlined /></template>
              </a-button>
            </a-tooltip>
          </div>
        </div>
        </a-card>
      </template>
    </VirtualGrid>
    <a-empty v-else class="empty" :description="data.keys.length ? '没有匹配的 Key' : '还没有 API Key，请先添加'" />

    <a-modal
      v-if="addOpen"
      v-model:open="addOpen"
      title="添加 Kiro API Key"
      centered
      :confirm-loading="adding"
      @ok="submitAdd"
    >
      <a-form layout="vertical">
        <a-form-item label="API Key" required>
          <a-input-password v-model:value="addValue" placeholder="ksk_..." />
        </a-form-item>
        <a-form-item label="区域" required>
          <RegionSelect v-model:value="addRegion" />
          <div class="field-hint muted">不同 Key 可能属于不同区域，选错会导致额度查询与请求失败</div>
        </a-form-item>
        <a-form-item label="备注">
          <a-input v-model:value="addNote" placeholder="例如：主力 Key" @press-enter="submitAdd" />
        </a-form-item>
      </a-form>
    </a-modal>

    <a-modal
      v-if="importOpen"
      v-model:open="importOpen"
      title="批量导入 API Key"
      centered
      :confirm-loading="importing"
      @ok="submitImport"
    >
      <a-form layout="vertical">
        <a-form-item label="区域" required>
          <RegionSelect v-model:value="importRegion" />
          <div class="field-hint muted">本批 Key 共用该区域，导入后可在卡片上逐个调整</div>
        </a-form-item>
        <a-form-item label="API Key" required>
          <a-textarea
            v-model:value="importText"
            :rows="9"
            placeholder="每行一个 ksk_ 开头的 API Key，自动忽略空行和重复项"
          />
        </a-form-item>
      </a-form>
    </a-modal>

    <a-modal
      v-if="regionTarget"
      :open="true"
      title="修改所属区域"
      centered
      :confirm-loading="savingRegion"
      @ok="submitRegion"
      @cancel="regionTarget = null"
    >
      <a-form layout="vertical">
        <a-form-item label="API Key">
          <div class="token-box mono">{{ regionTarget ? displayKey(regionTarget.key) : '' }}</div>
        </a-form-item>
        <a-form-item label="区域" required>
          <RegionSelect v-model:value="regionValue" />
        </a-form-item>
      </a-form>
      <a-alert
        type="warning"
        show-icon
        message="换区后该 Key 已缓存的订阅、额度与积分历史会被清空，需要重新同步。"
      />
    </a-modal>

    <a-modal v-if="editOpen" v-model:open="editOpen" title="修改备注" @ok="submitEdit">
      <a-input v-model:value="editNote" placeholder="留空表示无备注" @press-enter="submitEdit" />
    </a-modal>

    <ExportApiKeysModal v-if="exportOpen" v-model:open="exportOpen" :selected-ids="selectedIds" />

    <BatchNoteModal
      v-if="batchNoteOpen"
      :ids="selectedIds"
      entity="Key"
      placeholder="例如：本地网关 / 待观察 / 某渠道"
      :saving="savingNote"
      @submit="applyBatchNote"
      @close="batchNoteOpen = false"
    />

    <GroupPickerModal
      v-if="batchGroupOpen"
      :api="groupApi"
      :ids="selectedIds"
      entity="Key"
      @close="batchGroupOpen = false"
    />

    <!-- 目标取自 filteredKeys（勾选时只取勾选项）：顺序与内容都跟界面卡片保持一致 -->
    <ApiKeyBatchTestModal
      v-if="batchTestOpen"
      v-model:open="batchTestOpen"
      :keys="batchTargets"
    />

    <ApiKeyDetailDrawer
      v-if="detailTarget"
      :key-entry="detailTarget"
      @close="detailTarget = null"
      @test="(entry) => { detailTarget = null; testTarget = entry }"
      @edit="openEdit"
      @select="select"
    />
    <ApiKeyTestModal
      v-if="testTarget"
      :key-entry="testTarget"
      @close="testTarget = null"
    />
    <UsageHistoryModal
      v-if="usageSubject"
      :subject="usageSubject"
      @close="usageTarget = null"
    />
    <GatewayHistoryModal
      v-if="gatewayHistoryTarget"
      :key-entry="gatewayHistoryTarget"
      :metric="gatewayHistoryMetric"
      @close="gatewayHistoryTarget = null"
    />

    <a-modal
      v-if="restartPrompt"
      :open="true"
      width="520px"
      :footer="null"
      :mask-closable="false"
      :closable="!restartingIde"
      @cancel="restartPrompt = null"
    >
      <template #title>
        <span class="restart-title">
          <CheckCircleFilled style="color: #52c41a" />
          {{ restartPromptTitle }}
        </span>
      </template>

      <p v-if="restartPrompt?.reason === 'key-selected'" class="restart-lead">
        当前凭证切换已完成。
      </p>
      <p v-else-if="restartPrompt?.reason === 'gateway-disabled'" class="restart-lead">
        Kiro IDE 的 AI 请求端点已恢复为官方服务。
      </p>
      <p v-else class="restart-lead">
        Kiro IDE 的 AI 请求端点已配置为本地 API Key 网关。
      </p>

      <a-alert
        :type="restartPrompt?.needRestart ? 'warning' : 'success'"
        show-icon
        :message="restartPromptMessage"
        style="margin-bottom: 14px"
      />

      <p class="muted restart-tip">
        {{
          restartPrompt?.reason === 'key-selected'
            ? '网关会实时读取当前 Key；重启可让 IDE 当前会话重新建立连接。'
            : '已经运行的 Kiro IDE 可能仍缓存旧端点，建议现在重启以确保配置完全生效。'
        }}
      </p>

      <a-space style="width: 100%; justify-content: flex-end">
        <a-button :disabled="restartingIde" @click="restartPrompt = null">稍后手动重启</a-button>
        <a-button type="primary" :loading="restartingIde" @click="confirmRestart">
          <template #icon><ReloadOutlined /></template>
          立即重启 Kiro IDE
        </a-button>
      </a-space>
    </a-modal>

    <a-modal
      v-if="conflictPrompt"
      :open="true"
      width="560px"
      :footer="null"
      :mask-closable="false"
      :closable="!forcingTakeover"
      @cancel="conflictPrompt = null"
    >
      <template #title>
        <span class="restart-title">
          <ExclamationCircleFilled style="color: #faad14" />
          Kiro IDE 已被其它本地网关接管
        </span>
      </template>

      <p class="restart-lead">
        Kiro IDE 的 AI 请求端点当前指向下面的本地地址，说明有其它网关或同类工具正在接管：
      </p>
      <div class="conflict-endpoints">
        <span
          v-for="endpoint in conflictPrompt?.conflict.endpoints || []"
          :key="endpoint"
          class="mono conflict-endpoint"
        >{{ endpoint }}</span>
      </div>

      <a-alert
        type="warning"
        show-icon
        style="margin-bottom: 14px"
        message="强制接管会结束占用这些端口的本地进程，并把端点改写到本应用网关。"
        description="其它工具的接管会立即失效；若它以 Kiro IDE 扩展形式运行，扩展进程会一起结束，建议随后重启 IDE。"
      />

      <p class="muted restart-tip">
        冲突端口：{{ (conflictPrompt?.conflict.ports || []).join('、') || '未识别' }}
        · 本应用网关端口：KRS {{ data.ports.krs }} / CPS {{ data.ports.cps }}
      </p>

      <a-space style="width: 100%; justify-content: flex-end">
        <a-button :disabled="forcingTakeover" @click="conflictPrompt = null">取消</a-button>
        <a-button type="primary" danger :loading="forcingTakeover" @click="forceTakeover">
          <template #icon><PoweroffOutlined /></template>
          强制关闭并接管
        </a-button>
      </a-space>
    </a-modal>

    <a-modal
      v-if="configOpen"
      v-model:open="configOpen"
      title="网关配置"
      centered
      :confirm-loading="savingConfig"
      @ok="saveConfig"
    >
      <a-form layout="vertical">
        <div class="port-row">
          <a-form-item label="KRS 生成面端口" required>
            <a-input-number v-model:value="configKrs" :min="1024" :max="65535" />
          </a-form-item>
          <a-form-item label="CPS 控制面端口" required>
            <a-input-number v-model:value="configCps" :min="1024" :max="65535" />
          </a-form-item>
        </div>
      </a-form>
      <a-alert
        message="建议保持默认端口；端口需为 1024–65535 的整数，且 KRS 与 CPS 不能相同。"
        type="info"
        show-icon
      />
    </a-modal>
  </div>
</template>

<style scoped>
/* 整页占满内容区：头部固定，Key 卡片区独立虚拟滚动。 */
.keys-page { display: flex; flex-direction: column; gap: 16px; height: 100%; min-height: 0; }
.gateway-card { flex: 0 0 auto; border: 1px solid color-mix(in srgb, var(--kal-primary) 35%, var(--kal-border)); background: color-mix(in srgb, var(--kal-primary) 5%, transparent); }
.gateway-row { display: flex; align-items: center; gap: 12px; }
.gateway-main { flex: 1 1 auto; min-width: 0; }
.gateway-title { display: flex; align-items: center; gap: 9px; font-size: 17px; }
.gateway-desc { margin-top: 7px; font-size: 13px; }
.gateway-hint { margin-top: 4px; color: var(--kal-muted); font-size: 12px; }
.gateway-unsupported { margin-top: 14px; }
.keys-header { flex: 0 0 auto; }
.toolbar, .meta-bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.toolbar { margin-bottom: 10px; }
.meta-bar { min-height: 32px; }
.count-text { color: var(--kal-muted); font-size: 12px; }
.search-input { width: 100%; max-width: 480px; }
.spacer { flex: 1 1 auto; }
.key-grid { flex: 1 1 auto; min-height: 0; }
/* 整卡可点选；连着点几十张卡时不留下一片蓝色选中文字，要复制走详情抽屉或复制按钮 */
.key-card { width: 100%; border: 1px solid var(--kal-border); overflow: hidden; cursor: pointer; user-select: none; }
/* 用 padding 简写覆盖 antd 默认的 24px：左右也要收，不然横向留白比纵向大一截 */
.key-card :deep(.ant-card-body) { padding: 6px 14px; }
/*
 * 卡片 / 紧凑形态：卡片体改成纵向 flex 并铺满整卡，动作区用 margin-top: auto
 * 钉在底边，富余高度（虚拟滚动的统一行高减去本卡内容）落在它上方 —— 与账号卡片一致。
 *
 * 块间距随之改由 row-gap 统一给：auto 外边距会把「上一块的 margin-bottom」之外的
 * 空间全吃掉，靠各块自带的 margin-top 撑不出最小间距，而 gap 不受 auto 影响。
 * 所以要把各块原来的 margin-top 清掉，否则会和 gap 叠加。
 */
.key-card:not(.mode-list) { display: flex; flex-direction: column; }
.key-card:not(.mode-list) :deep(.ant-card-body) {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  row-gap: 8px;
}
.key-card:not(.mode-list) .tag-row,
.key-card:not(.mode-list) .usage-block,
.key-card:not(.mode-list) .stat-grid,
.key-card:not(.mode-list) .error-line { margin-top: 0; }
.key-card:not(.mode-list) .key-actions { margin-top: auto; }
.key-card.selected { border-color: var(--kal-primary); box-shadow: 0 0 0 1px var(--kal-primary) inset; }
.key-card.active { border-color: #52c41a; box-shadow: none; }
.key-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
.key-name { display: flex; flex: 1 1 auto; align-items: flex-start; gap: 7px; min-width: 0; }
.key-identity { flex: 1 1 auto; min-width: 0; line-height: 1.4; cursor: pointer; }
.key-switch-action { display: flex; flex: 1 1 auto; align-items: center; min-width: 0; min-height: 24px; }
.current-key-label { display: inline-flex; align-items: center; gap: 5px; color: #52c41a; font-size: 12px; font-weight: 600; }
.switch-key-btn { height: 24px; padding: 0; font-size: 12px; }
.key-value, .key-email, .key-note { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.key-value { font-size: 13px; font-weight: 600; transition: color 0.15s ease; }
/* 悬停 key 区域时高亮 key 值，与账户卡片悬停邮箱一致 */
.key-identity:hover .key-value { color: var(--kal-primary); }
.key-email { margin-top: 2px; font-size: 12px; }
.key-note { margin-top: 2px; font-size: 12px; }
.status-tag { flex: 0 0 auto; margin: 0; }
/* 标签一律排在同一行：不换行，宽度不够时由分组标签让位，区域标签不会被挤到下一行 */
.tag-row { display: flex; flex-wrap: nowrap; align-items: center; gap: 6px; min-height: 22px; min-width: 0; margin-top: 10px; }
.tag-row :deep(.ant-tag) { margin: 0; flex: 0 0 auto; }
/*
 * 分组名是用户自己填的，长度不可控，所以让它独自承担收缩：
 * 能排下就完整显示（剩余宽度全归它用），排不下才截断成省略号，全名看悬停提示。
 */
.tag-row .group-tag { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* 区域靠右对齐，与左侧的状态、等级标签同一行 */
.region-chip { display: inline-flex; flex: 0 0 auto; align-items: center; gap: 4px; margin-left: auto; padding: 1px 8px; border: 1px solid var(--kal-border); border-radius: 10px; background: transparent; color: var(--kal-muted); font-size: 11.5px; line-height: 18px; cursor: pointer; transition: border-color 0.15s ease, color 0.15s ease; }
.region-chip:hover { border-color: var(--kal-primary); color: var(--kal-primary); }
.field-hint { margin-top: 4px; font-size: 12px; line-height: 1.6; }
/* 高度按内容自然撑开：各卡结构相同、高度本来就一致，写死 105px 只会多留几像素空白 */
.usage-block { display: flex; flex-direction: column; gap: 4px; margin-top: 12px; padding: 10px 12px; box-sizing: border-box; border-radius: 12px; background: var(--kal-block-bg); cursor: pointer; transition: background 0.16s ease; }
.usage-block:hover { background: var(--kal-code-bg); }
.usage-head, .usage-foot { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; font-size: 12.5px; }
.usage-title { display: flex; align-items: baseline; gap: 6px; min-width: 0; }
.usage-updated { max-width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; }
.usage-percent { flex: 0 0 auto; font-size: 20px; font-weight: 700; line-height: 1; }
.usage-percent small { margin-left: 1px; font-size: 12px; }
.usage-bars { display: flex; align-items: stretch; gap: 2px; height: 14px; margin: 8px 0 10px; }
.bar { flex: 1 1 0; border-radius: 2px; background: var(--kal-bar-off); transition: background 0.2s ease; }
.bar.on { background: var(--bar-on); }
.usage-number { font-weight: 600; }
/* 右侧的重置日期不允许折行，与账号卡片一致 */
.usage-foot span:last-child { white-space: nowrap; }
/* 网关调用统计：四个等宽圆角小块，无边框，背景与上方使用量区块统一 */
.stat-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; margin-top: 8px; }
.stat-cell {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1px;
  padding: 7px 2px 6px;
  border-radius: 10px;
  background: var(--kal-block-bg);
}
.stat-cell.clickable { cursor: pointer; transition: background 0.16s ease; }
.stat-cell.clickable:hover { background: var(--kal-code-bg); }
.stat-label { color: var(--kal-muted); font-size: 11px; line-height: 1.2; }
/* 成功率带两位小数后字符变长，格子窄时靠 clamp 缩字号，且禁止折行 */
.stat-value { font-size: clamp(11px, 1.1vw, 14px); line-height: 1.25; white-space: nowrap; font-variant-numeric: tabular-nums; }
.stat-value small { margin-left: 1px; font-size: 10px; font-weight: 400; }
/*
 * 报错行。高度钉成确定值：18（行高）+ 3 + 3（上下 padding）= 24px。
 * 加上所在形态的块间距，就是带报错的卡比同类卡高出的部分 ——
 * 与上面 ERROR_ROW_EXTRA 的取值绑定，改这里要同步改那边。
 */
.error-line { padding: 3px 8px; overflow: hidden; color: #ff4d4f; border-radius: 8px; background: rgba(255, 77, 79, 0.08); font-size: 11.5px; line-height: 18px; text-overflow: ellipsis; white-space: nowrap; cursor: help; }
/* 卡片里一行截断，Tooltip 里完整换行展示 */
.error-tip { white-space: pre-wrap; word-break: break-all; }
.key-actions { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 18px; padding: 8px 0 0; border-top: 1px solid var(--kal-border); }
.action-row { display: flex; flex: 0 0 auto; align-items: center; gap: 0; }
.action-btn { width: 24px; min-width: 24px; height: 24px; padding: 0; }
.switch-btn { width: auto; min-width: 0; padding-inline: 8px; gap: 4px; }
.switch-btn.active { color: #52c41a; background: color-mix(in srgb, #52c41a 10%, transparent); }
/* ============ 紧凑卡片 ============ */
/*
 * 去掉网关统计那四个小格；用量块压成两行（柱状条与百分比同排，下面是总额 + 更新时间），
 * 与账号卡片的紧凑模式同一套做法：display: contents 把 .usage-head 从布局里摘掉，
 * 让它的两个子元素直接成为用量块的 flex 项，再用 order 排位。
 */
.key-card.mode-compact .stat-grid { display: none; }
.key-card.mode-compact .usage-block,
.key-card.mode-list .usage-block {
  flex-direction: row;
  flex-wrap: wrap;
  align-items: center;
  column-gap: 8px;
  row-gap: 8px;
}
.key-card.mode-compact .usage-head,
.key-card.mode-list .usage-head { display: contents; }
.key-card.mode-compact .usage-title,
.key-card.mode-list .usage-title { display: none; }
.key-card.mode-compact .usage-bars,
.key-card.mode-list .usage-bars { order: 1; flex: 1 1 auto; min-width: 60px; margin: 0; }
.key-card.mode-compact .usage-percent,
.key-card.mode-list .usage-percent { order: 2; font-size: 16px; }
.key-card.mode-compact .usage-foot,
.key-card.mode-list .usage-foot { order: 3; flex: 1 0 100%; }
/* 内容压得紧，底部那条分隔线与它自身的上内边距都去掉（块间距与卡片模式同为 8px） */
.key-card.mode-compact .key-actions { border-top: none; padding-top: 0; }

/* ============ 列表模式 ============ */
/*
 * 一条 = 四块：Key 信息 | 标签 | 用量 | 操作区，标签那块顺带吃掉全部富余宽度。
 * 与账号列表同一套：网格 + 容器查询按「卡片实际可用宽度」分档，
 * 窄了依次把标签、用量、操作区挪到下一行，不挤压也不横向溢出。
 *
 * 真正的布局容器是 a-card 的 body（卡片自己只是外壳），所以规则打在 :deep 上。
 */
.key-card.mode-list { cursor: pointer; }
.key-card.mode-list :deep(.ant-card-body) {
  display: grid;
  grid-template-columns: 400px minmax(190px, 1fr) 350px 320px;
  align-items: center;
  align-content: center;
  column-gap: 18px;
  row-gap: 8px;
  padding: 8px 14px;
}
/* 每块写死落位：报错行跨整行、自动摆放的游标不能回退，不写死会把操作区顶到下一行 */
.key-card.mode-list .key-head { grid-area: 1 / 1 / 2 / 2; }
.key-card.mode-list .tag-row { grid-area: 1 / 2 / 2 / 3; margin-top: 0; }
.key-card.mode-list .usage-block { grid-area: 1 / 3 / 2 / 4; margin-top: 0; }
.key-card.mode-list .key-actions { grid-area: 1 / 4 / 2 / 5; margin-top: 0; padding-top: 0; border-top: none; }
.key-card.mode-list .stat-grid { display: none; }
.key-card.mode-list .error-line { grid-column: 1 / -1; margin-top: 0; }
/* 区域标签在窄列里不必再靠右顶开 */
.key-card.mode-list .region-chip { margin-left: 0; }
.key-card.mode-list .tag-row { flex-wrap: nowrap; min-width: 0; margin-left: 6px; overflow: hidden; }
.key-card.mode-list .usage-bars { height: 10px; }
/* 「切换到该 Key」在一行里太长，收成图标按钮那一排的同级元素 */
.key-card.mode-list .key-switch-action { flex: 0 0 auto; }

/* 窄一档：标签掉到第二行铺满整宽 */
@container (max-width: 1343px) {
  .key-card.mode-list :deep(.ant-card-body) {
    grid-template-columns: 400px minmax(0, 1fr) 350px 320px;
  }
  .key-card.mode-list .tag-row { grid-area: 2 / 1 / 3 / -1; margin-left: 0; }
}

/* 再窄一档：操作区掉到用量下面，第一行只剩「Key | 富余 | 用量」 */
@container (max-width: 1153px) {
  .key-card.mode-list :deep(.ant-card-body) {
    grid-template-columns: minmax(0, 400px) minmax(0, 1fr) 350px;
  }
  .key-card.mode-list .usage-block { grid-area: 1 / 3 / 2 / 4; }
  .key-card.mode-list .tag-row { grid-area: 2 / 1 / 3 / 3; }
  .key-card.mode-list .key-actions { grid-area: 2 / 3 / 3 / 4; }
}

/* 兜底档：逐块竖排，正常窗口到不了这里 */
@container (max-width: 745px) {
  .key-card.mode-list :deep(.ant-card-body) { grid-template-columns: minmax(0, 1fr); }
  .key-card.mode-list .key-head,
  .key-card.mode-list .tag-row,
  .key-card.mode-list .usage-block,
  .key-card.mode-list .key-actions { grid-area: auto / 1 / auto / -1; }
}

.empty { margin: 70px 0; }
.test-loading { display: grid; place-items: center; min-height: 220px; }
.model-list { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 16px; max-height: 180px; overflow: auto; }
.test-note { margin-top: 16px; }
.port-row { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.port-row :deep(.ant-input-number) { width: 100%; }
.restart-title { display: inline-flex; align-items: center; gap: 8px; }
.restart-lead { margin: 0 0 12px; }
.restart-tip { margin: 0 0 14px; font-size: 12px; }
.conflict-endpoints { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 14px; }
.conflict-endpoint { padding: 3px 8px; border-radius: 6px; background: var(--kal-block-bg); font-size: 12px; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
.muted { color: var(--kal-muted); }
@media (max-width: 900px) {
  .gateway-row { align-items: flex-start; flex-wrap: wrap; }
}
</style>
