<script setup lang="ts">
import { computed, h, onMounted, onUnmounted, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { message, Modal } from 'ant-design-vue'
import {
  AppstoreOutlined,
  CheckCircleFilled,
  DeleteOutlined,
  DownOutlined,
  DownloadOutlined,
  EditOutlined,
  ExclamationCircleFilled,
  FileSearchOutlined,
  EyeInvisibleOutlined,
  EyeOutlined,
  KeyOutlined,
  PlusOutlined,
  PoweroffOutlined,
  ReloadOutlined,
  RestOutlined,
  RollbackOutlined,
  SettingOutlined,
  FilterOutlined,
  SyncOutlined,
  ThunderboltOutlined,
  BranchesOutlined,
  UploadOutlined
} from '@ant-design/icons-vue'
import { useKeysStore } from '@/stores/keys'
import { useSettingsStore } from '@/stores/settings'
import { bodyPopupContainer, confirmDelete, confirmUseApiKey } from '@/utils/ui'
import {
  displayKey as maskedKey,
  displayNote as maskedNote
} from '@/utils/display'
import { shouldSkipKeyUsageRefresh } from '@shared/refreshPolicy'
import RegionSelect from '@/components/common/RegionSelect.vue'
import AddApiKeyModal from '@/components/keys/AddApiKeyModal.vue'
import ImportApiKeysModal from '@/components/keys/ImportApiKeysModal.vue'
import VirtualGrid from '@/components/common/VirtualGrid.vue'
import UsageHistoryModal from '@/components/accounts/UsageHistoryModal.vue'
import GatewayHistoryModal from '@/components/keys/GatewayHistoryModal.vue'
import ApiKeyDetailDrawer from '@/components/keys/ApiKeyDetailDrawer.vue'
import ApiKeyTestModal from '@/components/keys/ApiKeyTestModal.vue'
import KiroCliConnectModal from '@/components/keys/KiroCliConnectModal.vue'
import ApiKeyBatchTestModal from '@/components/keys/ApiKeyBatchTestModal.vue'
import ApiKeyFilterPanel from '@/components/keys/ApiKeyFilterPanel.vue'
import ExportApiKeysModal from '@/components/keys/ExportApiKeysModal.vue'
import GroupPanel from '@/components/common/GroupPanel.vue'
import GroupManageModal from '@/components/common/GroupManageModal.vue'
import SortMenu from '@/components/common/SortMenu.vue'
import { useRangeSelect } from '@/utils/rangeSelect'
import { DEFAULT_SORT, SORT_FIELDS, compareBy, type SortField, type SortKey } from '@/utils/listSort'
import GroupPickerModal from '@/components/common/GroupPickerModal.vue'
import BatchNoteModal from '@/components/common/BatchNoteModal.vue'
import DisplayModeSelect from '@/components/common/DisplayModeSelect.vue'
import CardContextMenu, { type ContextMenuItem } from '@/components/common/CardContextMenu.vue'
import TrashToggle from '@/components/common/TrashToggle.vue'
import BatchQueryModal from '@/components/common/BatchQueryModal.vue'
import BatchQueryTag from '@/components/common/BatchQueryTag.vue'
import SearchScopeInput, {
  type SearchScopeOption
} from '@/components/common/SearchScopeInput.vue'
import { useRecentUsage } from '@/composables/useRecentUsage'
import { useCardContextMenu } from '@/composables/useCardContextMenu'
import { matchesGroupFilter } from '@/utils/groups'
import {
  keyDaysRemaining,
  keyIssue,
  keyStatusKey,
  keyTier,
  keyUsageRatio as usageRatio
} from '@/utils/keyEntry'
import KeyCard from '@/components/keys/KeyCard.vue'
import ModelListModal from '@/components/common/ModelListModal.vue'
import BatchKeyModelsModal from '@/components/keys/BatchKeyModelsModal.vue'
import { NO_BATCH_QUERY_HITS, runBatchQuery } from '@/utils/batchQuery'
import { createScopedSearchText } from '@/utils/searchText'
import { isTrashed } from '@shared/itemGroups'
import { keyGroupApi } from '@/utils/groupApi'
import { DEFAULT_REGION } from '@shared/regions'
import type {
  AccountDisplayMode,
  KeyEntry,
  KeyFilter,
  KeyGatewayConflict,
  KeyStatus,
  KiroModelInfo,
  KiroCapability,
  SubscriptionType
} from '@shared/types'

const store = useKeysStore()
const settingsStore = useSettingsStore()

/**
 * 工具栏那一排的控件尺寸：大尺寸下用标准尺寸，默认尺寸下仍用 small。
 * 写死 small 时，选了大尺寸后这排和上方的添加 / 导入 / 导出差两档，看着不像一个页面。
 */
const toolbarSize = computed(() => settingsStore.toolbarSize)
const { data, status, activeKey, loading } = storeToRefs(store)
const privacyMode = computed(() => settingsStore.settings.privacyMode)
const search = ref('')

/** 搜索范围：默认智能搜索（Key + 邮箱 + 备注），也可以只搜某一个字段 */
type SearchScope = 'all' | 'key' | 'email' | 'note'
const SEARCH_SCOPES: SearchScopeOption[] = [
  { value: 'all', label: '智能搜索', placeholder: '搜索 API Key / 邮箱 / 备注' },
  { value: 'key', label: 'API Key', placeholder: '只搜 API Key' },
  { value: 'email', label: '邮箱', placeholder: '只搜邮箱' },
  { value: 'note', label: '备注', placeholder: '只搜备注' }
]
const searchScope = ref<SearchScope>('all')

// 旧版 Kiro 不读端点覆盖，开启网关会「写成功但请求照旧」，加载时探测一次并给出提示
const capability = ref<KiroCapability | null>(null)
const gatewayUnsupported = computed(() => capability.value?.supportsKeyGateway === false)
async function detectCapability(): Promise<void> {
  const res = await window.api.getKiroCapability()
  if (res.success && res.data) capability.value = res.data
}

const addOpen = ref(false)
const importOpen = ref(false)

const editOpen = ref(false)
const editId = ref('')
const editNote = ref('')
const exportOpen = ref(false)
const detailTarget = ref<KeyEntry | null>(null)
const testTarget = ref<KeyEntry | null>(null)
const batchTestOpen = ref(false)
const batchModelsOpen = ref(false)
const usageTarget = ref<KeyEntry | null>(null)
const gatewayHistoryTarget = ref<KeyEntry | null>(null)
const gatewayHistoryMetric = ref<'requests' | 'credits'>('requests')
const selectedIds = ref<string[]>([])
const sortKey = ref<SortKey>(DEFAULT_SORT)

const filterOpen = ref(false)
/** 筛选条件常驻本页：面板收起后条件仍然生效 */
const filter = ref<KeyFilter>({ subscriptions: [], statuses: [], groupIds: [] })

/** 空条件模板：重置时复用，避免漏掉某个新加的字段 */
function emptyFilter(): KeyFilter {
  return { subscriptions: [], statuses: [], groupIds: filter.value.groupIds }
}

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
    (f.daysRemainingMax != null ? 1 : 0) +
    // 导入时间是一个区间，两端一起设置 / 清空，只算一项
    (f.createdFrom != null || f.createdTo != null ? 1 : 0)
  )
})

/** 重置只清筛选面板自己的条件，分组筛选有独立按钮与「清除分组筛选」 */
function resetFilter(): void {
  filter.value = emptyFilter()
}

// ============ 分组 ============
const groupOpen = ref(false)
const groupManageOpen = ref(false)
const batchGroupOpen = ref(false)
const batchNoteOpen = ref(false)

/** 打开分组管理弹窗：先收起筛选浮层，免得两层叠在一起 */
function openGroupManage(): void {
  groupOpen.value = false
  groupManageOpen.value = true
}

function toggleGroupFilter(id: string): void {
  const list = filter.value.groupIds
  filter.value.groupIds = list.includes(id) ? list.filter((v) => v !== id) : [...list, id]
}

/**
 * 右键「设置备注 / 设置分组」只作用于那一个 Key，和批量入口共用同一个弹窗。
 * 设置备注沿用卡片上已有的「修改备注」弹窗。
 */
const groupTarget = ref<KeyEntry | null>(null)
const groupPickIds = computed(() => (groupTarget.value ? [groupTarget.value.id] : selectedIds.value))

function closeGroupPicker(): void {
  batchGroupOpen.value = false
  groupTarget.value = null
}

// ============ 回收站 ============
/** 是否正在看回收站：打开时列表、搜索、筛选只作用于回收站里的 Key */
const trashView = ref(false)

// ============ 批量查询 ============
const batchQueryOpen = ref(false)
/**
 * 批量查询的关键字（一行一个，已转小写、去重）；
 * 按 API Key / 绑定邮箱 / 备注模糊匹配，命中任意一个关键字即显示。
 */
const batchQuery = ref<string[]>([])

/** 搜索与批量查询共用的小写文本，各搜索范围对应的字段；取值与缓存见 createScopedSearchText */
const queryTextOf = createScopedSearchText<KeyEntry, SearchScope>({
  all: (entry) => `${entry.key} ${entry.email ?? ''} ${entry.note ?? ''}`,
  key: (entry) => entry.key,
  email: (entry) => entry.email ?? '',
  note: (entry) => entry.note ?? ''
})

/** 批量查询结果：只在当前所在的一边里查，不受其它筛选影响，「未找到」就是真的不在这里 */
const batchQueryResult = computed(() => {
  if (!batchQuery.value.length) return null
  const side = data.value.keys.filter((entry) => isTrashed(entry) === trashView.value)
  // 批量查询固定按「Key + 邮箱 + 备注」匹配，不跟搜索框的范围选择走
  return runBatchQuery(side, (entry) => queryTextOf(entry, 'all'), batchQuery.value)
})

const batchQueryHits = computed(() => batchQueryResult.value ?? NO_BATCH_QUERY_HITS)

function applyBatchQuery(values: string[]): void {
  batchQuery.value = values
  batchQueryOpen.value = false
  const { hits, missing } = batchQueryHits.value
  const text = `批量查询 ${values.length} 个关键字：${hits} 个有结果${missing.length ? `，${missing.length} 个未找到` : ''}`
  missing.length ? message.warning(text) : message.success(text)
}

function toggleTrashView(): void {
  trashView.value = !trashView.value
  // 两边条目互不可见，勾选状态跨视图没有意义
  selectedIds.value = []
}

async function moveToTrash(ids: string[], trashed: boolean): Promise<void> {
  const error = await store.setTrashed(ids, trashed)
  if (error) return void message.error(error)
  const moved = new Set(ids)
  selectedIds.value = selectedIds.value.filter((id) => !moved.has(id))
  clearDeletedKeyUi(ids)
  message.success(
    trashed ? `已将 ${ids.length} 个 API Key 放入回收站` : `已将 ${ids.length} 个 API Key 移出回收站`
  )
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

/** 筛选面板的命中计数：按全部 Key 统计，不受当前筛选影响 */
const keyStats = computed(() => {
  const bySubscription: Record<SubscriptionType, number> = {
    Free: 0,
    Pro: 0,
    Pro_Plus: 0,
    Pro_Max: 0,
    Power: 0,
    Teams: 0,
    Student: 0
  }
  const byStatus: Record<KeyStatus, number> = { normal: 0, error: 0, unchecked: 0 }
  // 只统计当前所在的一边（正常列表或回收站），筛选面板上的数字才和列表对得上
  const inTrash = trashView.value
  for (const entry of data.value.keys) {
    if (isTrashed(entry) !== inTrash) continue
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

/** API Key 没有会过期的 Token，排序项里不列 Token 有效期 */
const sortFields = SORT_FIELDS.filter((item) => item.field !== 'token')

/** Key 在积分变化日志里的 id 带 key: 前缀，与账号区分 */
const usageSubjectId = (entry: KeyEntry): string => `key:${entry.id}`

/*
 * 近半小时 / 近 1 小时积分用量：只在选了这两种排序时向主进程批量取。
 * Key 数据整表替换即表示有同步结果写回（用量可能变了），据此重取。
 */
const recentUsage = useRecentUsage({
  sortKey,
  subjectIds: () =>
    data.value.keys.filter((entry) => isTrashed(entry) === trashView.value).map(usageSubjectId),
  version: () => data.value.keys
})

const filteredKeys = computed(() => {
  const needle = search.value.trim().toLowerCase()
  const {
    subscriptions,
    statuses,
    groupIds,
    usageMin,
    usageMax,
    daysRemainingMin,
    daysRemainingMax,
    createdFrom,
    createdTo
  } = filter.value
  const groupSet = groupIds.length ? new Set(groupIds) : null
  // 排序比较器每次比较都会读，先取出来，免得反复经过响应式 getter
  const activeId = data.value.activeKeyId
  // 用量比例算一次记下来：比较器里每次比较要算两遍，n log n 次就是一笔不小的开销
  const ratios = new Map<string, number>()
  const ratioOf = (entry: KeyEntry): number => {
    let value = ratios.get(entry.id)
    if (value === undefined) ratios.set(entry.id, (value = usageRatio(entry)))
    return value
  }
  const compare = compareBy(
    sortKey.value,
    (entry: KeyEntry, field: SortField) => {
      if (field === 'email') return entry.email
      // 没有积分变化记录的 Key 算缺值，排到最后；有记录但这段时间没消耗的是 0
      if (field === 'recent30' || field === 'recent60') {
        return recentUsage.valueOf(usageSubjectId(entry), field)
      }
      // 没查到过额度的 Key 三项积分都算缺值，排到最后
      const total = entry.totalCredits
      if (field === 'usage') return total ? ratioOf(entry) : undefined
      if (field === 'usedCredits') return total ? entry.usedCredits || 0 : undefined
      if (field === 'remainingCredits') return total ? total - (entry.usedCredits || 0) : undefined
      if (field === 'reset') return keyDaysRemaining(entry) ?? undefined
      return field === 'createdAt' ? entry.createdAt : undefined
    },
    (entry: KeyEntry) => entry.createdAt
  )
  // filter 本身就返回新数组，sort 不会动到 store 里的原数组
  const inTrash = trashView.value
  const groupExists = (id: string): boolean => store.groupMap.has(id)
  const queryMatched = batchQueryResult.value?.matched ?? null
  const scope = searchScope.value
  return data.value.keys
    .filter((entry) => {
      // 回收站与正常列表互不可见：搜索与筛选都只作用于当前所在的那一边
      if (isTrashed(entry) !== inTrash) return false
      // 批量查询：命中任意一个关键字（Key / 邮箱 / 备注模糊匹配）
      if (queryMatched && !queryMatched.has(entry.id)) return false
      // 搜索：智能搜索走 Key + 邮箱 + 备注，选了具体字段就只搜那一个
      if (needle && !queryTextOf(entry, scope).includes(needle)) return false
      // 多分组：命中所选任一分组即可；分组都已被删除的 Key 视为未分组
      if (groupSet && !matchesGroupFilter(entry, groupSet, groupExists)) return false
      if (subscriptions.length && !subscriptions.includes(keyTier(entry))) return false
      if (statuses.length && !statuses.includes(keyStatusKey(entry))) return false
      // 范围条件一律用 != null 判断「是否已设置」：输入框清空后给的是 null，
      // 按 !== undefined 判断会把 null 当成已设置，比较时又转成 0，把列表筛成空
      const used = ratioOf(entry)
      if (usageMin != null && used < usageMin) return false
      if (usageMax != null && used > usageMax) return false
      const days = keyDaysRemaining(entry)
      if (daysRemainingMax != null && (days ?? Number.POSITIVE_INFINITY) > daysRemainingMax) {
        return false
      }
      if (daysRemainingMin != null && (days ?? Number.NEGATIVE_INFINITY) < daysRemainingMin) {
        return false
      }
      // 导入时间：两端都含，界面给过来的是精确到秒的时刻
      if (createdFrom != null && entry.createdAt < createdFrom) return false
      if (createdTo != null && entry.createdAt > createdTo) return false
      return true
    })
    .sort((a, b) => {
      const active = Number(b.id === activeId) - Number(a.id === activeId)
      if (active) return active
      return compare(a, b)
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
 * 批量操作（刷新、测活）的共同目标：有勾选就处理全部勾选项，否则处理当前列表全部。
 *
 * 勾选项包括被当前筛选挡住、看不见的那些——与「批量操作（N个）」「删除（N个）」口径一致，
 * 否则会出现「显示勾选了 1 个，点刷新却说没有可刷新的」。
 * 顺序按界面卡片，看不见的排在后面；只取当前所在的一边（正常列表 / 回收站）。
 */
const batchTargets = computed(() => {
  if (!selectedIds.value.length) return filteredKeys.value
  const visible = filteredKeys.value.filter((entry) => selectedSet.value.has(entry.id))
  const shown = new Set(visible.map((entry) => entry.id))
  const hidden = data.value.keys.filter(
    (entry) =>
      selectedSet.value.has(entry.id) && !shown.has(entry.id) && isTrashed(entry) === trashView.value
  )
  return [...visible, ...hidden]
})
/** 批量操作按钮的范围后缀：有勾选时把实际会处理的条数（全部勾选数）带到按钮上 */
const batchScopeSuffix = computed(() =>
  selectedIds.value.length ? `（${selectedIds.value.length}个）` : ''
)
const allVisibleSelected = computed(() => filteredKeys.value.length > 0 && visibleSelectedCount.value === filteredKeys.value.length)
const someVisibleSelected = computed(() => visibleSelectedCount.value > 0 && !allVisibleSelected.value)
// 复用筛选面板那一次遍历的结果，口径与状态 chip 完全一致
const normalCount = computed(() => keyStats.value.byStatus.normal)
const errorCount = computed(() => keyStats.value.byStatus.error)

/** 单击勾选；按住 Shift 勾选一段，Ctrl / Cmd + A 勾选当前筛选结果（见 rangeSelect） */
const { toggle: toggleSelect } = useRangeSelect({
  order: () => filteredKeys.value.map((entry) => entry.id),
  apply: (ids, checked) => {
    const next = new Set(selectedIds.value)
    for (const id of ids) checked ? next.add(id) : next.delete(id)
    selectedIds.value = [...next]
  },
  selectAll: () => toggleSelectVisible(true)
})

function toggleSelectVisible(checked: boolean): void {
  const next = new Set(selectedIds.value)
  for (const entry of filteredKeys.value) checked ? next.add(entry.id) : next.delete(entry.id)
  selectedIds.value = [...next]
}

/**
 * API Key 是否遮蔽只由全局「隐私打码」决定，本页所有展示位置一律走这里。
 * 接管面板、删除确认等处不要另写无条件打码的实现，否则关掉开关也看不到完整 Key。
 */
function displayKey(key: string): string {
  return maskedKey(key, privacyMode.value)
}


/** 备注同样跟随隐私打码：里面常写着用途、渠道等不比邮箱次要的信息 */
function displayNote(note?: string): string {
  return maskedNote(note, privacyMode.value)
}

function togglePrivacy(): void {
  void settingsStore.update({ privacyMode: !privacyMode.value })
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

/** 打开网关调用历史弹窗，metric 决定默认展示哪条曲线 */
function openGatewayHistory(entry: KeyEntry, metric: 'requests' | 'credits'): void {
  gatewayHistoryMetric.value = metric
  gatewayHistoryTarget.value = entry
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
  if (modelsTarget.value && deleted.has(modelsTarget.value.id)) modelsTarget.value = null
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
  const label = displayNote(entry.note) || displayKey(entry.key)
  // 正常列表里多一个「放入回收站」；已在回收站里的再删就是彻底删除
  confirmDelete({
    title: trashView.value ? '彻底删除 API Key' : '删除 API Key',
    content: trashView.value
      ? `确认彻底删除 ${label}？删除后无法恢复。`
      : `确认删除 ${label}？此操作不可撤销；也可以先放入回收站。`,
    onOk: doRemove,
    onTrash: trashView.value ? undefined : () => moveToTrash([entry.id], true)
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

// ============ 右键菜单 ============

/**
 * 生成 API Key / 获取订阅链接要用账号的登录凭证，API Key 本身没有，
 * 所以 Key 卡片的右键菜单没有这两项。
 */
const normalMenu: ContextMenuItem[] = [
  { key: 'note', label: '设置备注', icon: EditOutlined },
  { key: 'group', label: '设置分组', icon: AppstoreOutlined },
  { key: 'models', label: '查询可用模型', icon: BranchesOutlined },
  { key: 'trash', label: '放入回收站', icon: RestOutlined, divided: true },
  { key: 'remove', label: '删除该 API Key', icon: DeleteOutlined, danger: true }
]

/** 只作用于单个条目的菜单项：多选时也只查右键的那一个，文案不带数量 */
const SINGLE_ONLY = new Set(['models'])

/** 「查询可用模型」弹窗对应的 Key；按 id 在主进程取，明文不经渲染进程传 */
const modelsTarget = ref<KeyEntry | null>(null)

async function loadKeyModels(): Promise<KiroModelInfo[]> {
  const target = modelsTarget.value
  if (!target) return []
  const res = await window.api.listKeyModelDetails(target.id)
  if (!res.success) throw new Error(res.error || '查询可用模型失败')
  return res.data ?? []
}

const trashMenu: ContextMenuItem[] = [
  { key: 'restore', label: '移出回收站', icon: RollbackOutlined },
  { key: 'remove', label: '彻底删除', icon: DeleteOutlined, danger: true, divided: true }
]

/** 整页只有一个右键菜单实例；作用目标与高亮规则见 useCardContextMenu */
const contextMenu = useCardContextMenu<KeyEntry>({ selectedIds })
const menuTargetIds = contextMenu.targetIds
const contextIds = contextMenu.highlight

/** 卡片上「打开某个弹窗」类事件的稳定处理器：模板里写内联赋值会让每张可见卡片每次都重新渲染 */
const cardHandlers = {
  detail: (entry: KeyEntry) => (detailTarget.value = entry),
  usage: (entry: KeyEntry) => (usageTarget.value = entry),
  cli: (entry: KeyEntry) => (cliTarget.value = entry)
}

/** 作用于多项时，菜单文案带上数量 */
const contextMenuItems = computed<ContextMenuItem[]>(() => {
  const base = trashView.value ? trashMenu : normalMenu
  const count = menuTargetIds.value.length
  if (count <= 1) return base
  return base.map((item) => {
    if (SINGLE_ONLY.has(item.key)) return item
    return {
      ...item,
      label: item.key === 'remove' ? `${trashView.value ? '彻底删除' : '删除'}所选 API Key（${count}个）` : `${item.label}（${count}个）`
    }
  })
})

function onContextMenu(key: string): void {
  const entry = contextMenu.target.value
  if (!entry) return
  const ids = menuTargetIds.value.length ? menuTargetIds.value : [entry.id]
  // 多项时勾选集合就是这批目标（见 useCardContextMenu），直接复用各个批量入口
  const multi = ids.length > 1
  if (key === 'note') multi ? (batchNoteOpen.value = true) : openEdit(entry)
  else if (key === 'group') multi ? (batchGroupOpen.value = true) : (groupTarget.value = entry)
  else if (key === 'models') modelsTarget.value = entry
  else if (key === 'trash') void moveToTrash([...ids], true)
  else if (key === 'restore') void moveToTrash([...ids], false)
  else if (key === 'remove') multi ? removeSelected() : remove(entry)
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
    const remaining = new Set(data.value.keys.map((entry) => entry.id))
    selectedIds.value = selectedIds.value.filter((id) => remaining.has(id))
    clearDeletedKeyUi(deletedIds)
    const text = `已删除 ${deletedIds.length} 个${failed ? `，失败 ${failed} 个` : ''}`
    failed ? message.warning(text) : message.success(text)
  }
  if (!settingsStore.settings.confirmBeforeDeleteApiKey) return void execute()
  confirmDelete({
    title: trashView.value ? `彻底删除 ${ids.length} 个 API Key` : `删除 ${ids.length} 个 API Key`,
    content: trashView.value
      ? '删除后无法恢复。'
      : '删除后无法恢复；正在接管中使用的当前 Key 会被保护，不会删除。也可以先放入回收站。',
    onOk: execute,
    onTrash: trashView.value ? undefined : () => moveToTrash(ids, true)
  })
}

/** 「连接 Kiro CLI」弹窗对应的 Key */
const cliTarget = ref<KeyEntry | null>(null)

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
        <a-tooltip title="批量查询">
          <a-button
            :type="batchQuery.length ? 'primary' : 'default'"
            aria-label="批量查询"
            @click="batchQueryOpen = true"
          >
            <template #icon><FileSearchOutlined /></template>
          </a-button>
        </a-tooltip>
        <SearchScopeInput
          v-model:value="search"
          v-model:scope="searchScope"
          :options="SEARCH_SCOPES"
        />
        <BatchQueryTag
          v-if="batchQuery.length"
          :total="batchQuery.length"
          :hits="batchQueryHits.hits"
          :missing="batchQueryHits.missing"
          @edit="batchQueryOpen = true"
          @clear="batchQuery = []"
        />
        <span class="spacer" />
        <a-button type="primary" @click="addOpen = true">
          <template #icon><PlusOutlined /></template>添加 API Key
        </a-button>
        <a-button @click="importOpen = true"><template #icon><UploadOutlined /></template>导入</a-button>
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
            <a-button :size="toolbarSize" :type="activeFilterCount ? 'primary' : 'default'">
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
          @open-change="(open: boolean) => (groupOpen = open)"
        >
          <template #content>
            <GroupPanel
              v-if="groupOpen"
              :api="groupApi"
              :selected="filter.groupIds"
              :matched="filteredKeys.length"
              entity="Key"
              @toggle="toggleGroupFilter"
              @clear="filter.groupIds = []"
              @manage="openGroupManage"
            />
          </template>
          <a-badge :count="filter.groupIds.length" :offset="[-4, 4]">
            <a-button :size="toolbarSize" :type="filter.groupIds.length ? 'primary' : 'default'">
              <template #icon><AppstoreOutlined /></template>
              分组
            </a-button>
          </a-badge>
        </a-popover>

        <SortMenu v-model="sortKey" :fields="sortFields" :size="toolbarSize" />
        <a-divider type="vertical" style="margin: 0 2px" />
        <a-button :size="toolbarSize" :loading="syncing" @click="syncAll">
          <template #icon><SyncOutlined /></template>
          {{ syncing ? `正在刷新${selectedIds.length ? selectedIds.length + '个API Key' : ''}用量/积分...` : `刷新用量/积分${batchScopeSuffix}` }}
        </a-button>
        <a-button
          :size="toolbarSize"
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
        <DisplayModeSelect :value="displayMode" :size="toolbarSize" @change="setDisplayMode" />
        <!-- 回收站为空时不显示；正在看回收站时保留，否则清空后就没有返回入口了 -->
        <TrashToggle
          v-if="store.trashedCount || trashView"
          :active="trashView"
          :count="store.trashedCount"
          :size="toolbarSize"
          @toggle="toggleTrashView"
        />

        <!-- 回收站里只有「移出回收站 / 彻底删除」两种批量动作 -->
        <a-button
          v-if="trashView && selectedIds.length"
          :size="toolbarSize"
          @click="moveToTrash([...selectedIds], false)"
        >
          <template #icon><RollbackOutlined /></template>
          移出回收站（{{ selectedIds.length }}个）
        </a-button>

        <!-- 批量操作作用于全部勾选项，没有勾选时不显示 -->
        <a-dropdown v-if="!trashView && selectedIds.length">
          <a-button :size="toolbarSize">
            批量操作（{{ selectedIds.length }}个）
            <DownOutlined />
          </a-button>
          <template #overlay>
            <a-menu>
              <a-menu-item key="test" @click="batchTestOpen = true">
                <ThunderboltOutlined />
                批量测活
              </a-menu-item>
              <a-menu-item key="models" @click="batchModelsOpen = true">
                <BranchesOutlined />
                批量获取模型
              </a-menu-item>
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
        <a-button v-if="selectedIds.length" :size="toolbarSize" danger @click="removeSelected">
          <template #icon><DeleteOutlined /></template>
          {{ trashView ? '彻底删除' : '删除' }}（{{ selectedIds.length }}个）
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
          <a-button type="link" :size="toolbarSize" @click="selectedIds = []">清空</a-button>
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
      <!-- 事件一律绑定稳定的方法引用，props 没变的卡片不会被重新渲染（见 KeyCard） -->
      <template #default="{ item: entry }">
        <KeyCard
          :entry="entry"
          :stats="store.gatewayStats[entry.id]"
          :active="entry.id === data.activeKeyId"
          :selected="selectedSet.has(entry.id)"
          :context-active="contextIds.has(entry.id)"
          :mode="displayMode"
          :selecting="actionBusy(entry.id, 'select')"
          :syncing="actionBusy(entry.id, 'sync')"
          @toggle-select="toggleSelect"
          @detail="cardHandlers.detail"
          @usage="cardHandlers.usage"
          @region="openRegion"
          @history="openGatewayHistory"
          @select="select"
          @sync="sync"
          @test="test"
          @copy="copy"
          @cli="cardHandlers.cli"
          @edit="openEdit"
          @remove="remove"
          @contextmenu="contextMenu.show"
        />
      </template>
    </VirtualGrid>
    <a-empty v-else-if="trashView" class="empty" :description="store.trashedCount ? '回收站里没有符合条件的 Key' : '回收站是空的'">
      <a-button @click="toggleTrashView">返回 API Key 列表</a-button>
    </a-empty>
    <a-empty v-else class="empty" :description="store.liveKeys.length ? '没有匹配的 Key' : '还没有 API Key，请先添加'" />

    <KiroCliConnectModal
      v-if="cliTarget"
      :open="!!cliTarget"
      :api-key="cliTarget.key"
      :display-key="displayKey(cliTarget.key)"
      @update:open="(v) => !v && (cliTarget = null)"
    />

    <AddApiKeyModal v-if="addOpen" @close="addOpen = false" />

    <ImportApiKeysModal v-if="importOpen" @close="importOpen = false" />

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

    <!-- 备注用多行输入，与账号的编辑弹窗、批量设置备注保持一致：备注常写好几件事 -->
    <a-modal v-if="editOpen" v-model:open="editOpen" title="修改备注" @ok="submitEdit">
      <a-textarea
        v-model:value="editNote"
        :rows="3"
        placeholder="留空表示无备注"
        allow-clear
      />
    </a-modal>

    <ExportApiKeysModal v-if="exportOpen" v-model:open="exportOpen" :selected-ids="selectedIds" />

    <ModelListModal
      v-if="modelsTarget"
      :subject="displayKey(modelsTarget.key)"
      :load="loadKeyModels"
      @close="modelsTarget = null"
    />

    <BatchKeyModelsModal
      v-if="batchModelsOpen"
      :keys="batchTargets"
      @close="batchModelsOpen = false"
    />

    <BatchNoteModal
      v-if="batchNoteOpen"
      :ids="selectedIds"
      entity="Key"
      placeholder="例如：本地网关 / 待观察 / 某渠道"
      :saving="savingNote"
      @submit="applyBatchNote"
      @close="batchNoteOpen = false"
    />

    <CardContextMenu
      :open="contextMenu.state.open"
      :x="contextMenu.state.x"
      :y="contextMenu.state.y"
      :items="contextMenuItems"
      @select="onContextMenu"
      @close="contextMenu.hide"
    />
    <BatchQueryModal
      v-if="batchQueryOpen"
      fields="API Key、邮箱、备注"
      :initial="batchQuery"
      placeholder="ksk_xxxxxxxx&#10;a@gmail.com&#10;备注里的关键字"
      @submit="applyBatchQuery"
      @close="batchQueryOpen = false"
    />
    <GroupPickerModal
      v-if="batchGroupOpen || groupTarget"
      :api="groupApi"
      :ids="groupPickIds"
      entity="Key"
      title-entity="API Key"
      @close="closeGroupPicker"
      @manage="groupManageOpen = true"
    />
    <GroupManageModal
      v-if="groupManageOpen"
      :api="groupApi"
      entity="Key"
      @close="groupManageOpen = false"
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
.spacer { flex: 1 1 auto; }
.key-grid { flex: 1 1 auto; min-height: 0; }
.empty { margin: 70px 0; }
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
