<script setup lang="ts">
import { computed, h, ref, watch } from 'vue'
import { message } from 'ant-design-vue'
import {
  AppstoreOutlined,
  CodeOutlined,
  DeleteOutlined,
  DownOutlined,
  DownloadOutlined,
  EditOutlined,
  EyeInvisibleOutlined,
  EyeOutlined,
  FilterOutlined,
  InboxOutlined,
  KeyOutlined,
  PlusOutlined,
  SearchOutlined,
  SortAscendingOutlined,
  SyncOutlined,
  UploadOutlined
} from '@ant-design/icons-vue'
import AccountCard from '@/components/accounts/AccountCard.vue'
import AccountFilterPanel from '@/components/accounts/AccountFilterPanel.vue'
import VirtualGrid from '@/components/common/VirtualGrid.vue'
import AddAccountModal from '@/components/accounts/AddAccountModal.vue'
import ImportAccountsFileModal from '@/components/accounts/ImportAccountsFileModal.vue'
import ImportAccountsTextModal from '@/components/accounts/ImportAccountsTextModal.vue'
import ExportAccountsModal from '@/components/accounts/ExportAccountsModal.vue'
import EditAccountModal from '@/components/accounts/EditAccountModal.vue'
import BatchNoteModal from '@/components/common/BatchNoteModal.vue'
import GroupPickerModal from '@/components/common/GroupPickerModal.vue'
import GroupPanel from '@/components/common/GroupPanel.vue'
import DisplayModeSelect from '@/components/common/DisplayModeSelect.vue'
import AccountDetailDrawer from '@/components/accounts/AccountDetailDrawer.vue'
import AccountTestModal from '@/components/accounts/AccountTestModal.vue'
import CreateApiKeyModal from '@/components/accounts/CreateApiKeyModal.vue'
import UsageHistoryModal from '@/components/accounts/UsageHistoryModal.vue'
import SwitchResultModal from '@/components/accounts/SwitchResultModal.vue'
import { useAccountsStore } from '@/stores/accounts'
import { useSettingsStore } from '@/stores/settings'
import { displayEmail as maskedEmail } from '@/utils/display'
import { accountGroupApi } from '@/utils/groupApi'
import { toPlain } from '@/utils/ipc'
import {
  bodyPopupContainer,
  confirmDanger,
  confirmDelete,
  copyText,
  notifyResult
} from '@/utils/ui'
import { shouldSkipAccountUsageRefresh } from '@shared/refreshPolicy'
import type { Account, AccountDisplayMode, SwitchAccountResult } from '@shared/types'

const accountsStore = useAccountsStore()
const settingsStore = useSettingsStore()

const addOpen = ref(false)
/** 导入拆成两个入口：拖拽文件、粘贴文本 */
const importFileOpen = ref(false)
const importTextOpen = ref(false)

/** 「添加账号」弹窗里的导入入口：它会先关掉自己，这里只负责打开对应的导入弹窗 */
function openImport(kind: 'file' | 'text'): void {
  if (kind === 'file') importFileOpen.value = true
  else importTextOpen.value = true
}
const exportOpen = ref(false)
const batchNoteOpen = ref(false)
const batchGroupOpen = ref(false)
const editTarget = ref<Account | null>(null)
const detailTarget = ref<Account | null>(null)
const testTarget = ref<Account | null>(null)
const apiKeyTarget = ref<Account | null>(null)
const usageTarget = ref<Account | null>(null)
/** 每个账号当前进行中的操作 key，用于只给被点的按钮加载态 */
const rowBusy = ref<Record<string, string | undefined>>({})

/** 批量操作的进度文案，配合下面的函数式组件在 message 里实时刷新 */
const batchProgress = ref('')
const BatchProgressText = (): ReturnType<typeof h> => h('span', null, batchProgress.value)

type SortKey = 'createdAt' | 'email' | 'usage' | 'reset' | 'checked'

const sortKey = ref<SortKey>('createdAt')

const busy = computed(() => accountsStore.task.running)
/**
 * 正在跑的批量刷新是哪一条：自动刷新与手动批量刷新共用 runBatch，
 * 因此这里能同时覆盖两种触发方式。给正在跑的那个按钮上加载态，
 * 另一个只置灰（全局任务状态一次只容得下一条批量任务）。
 */
const keyRefreshing = computed(
  () => busy.value && accountsStore.task.type === 'account-key-refresh'
)
const usageRefreshing = computed(
  () => busy.value && accountsStore.task.type === 'account-usage-refresh'
)
const refreshing = computed(() => keyRefreshing.value || usageRefreshing.value)

/** 菜单按钮上直接反映正在跑的那条任务，不必展开菜单才知道进度 */
const refreshButtonText = computed(() => {
  if (keyRefreshing.value) return '正在刷新密钥...'
  if (usageRefreshing.value) {
    const scope = visibleSelectedCount.value ? `${visibleSelectedCount.value}个账户` : ''
    return `正在刷新${scope}用量/积分...`
  }
  return `刷新密钥/用量/积分${batchScopeSuffix.value}`
})

const stats = computed(() => accountsStore.stats)

const sortOptions: { value: SortKey; label: string }[] = [
  { value: 'createdAt', label: '添加时间' },
  { value: 'email', label: '邮箱' },
  { value: 'usage', label: '用量占比' },
  { value: 'reset', label: '重置剩余天数' },
  { value: 'checked', label: '最后检查' }
]

const sortLabel = computed(
  () => sortOptions.find((o) => o.value === sortKey.value)?.label ?? '添加时间'
)

const filterOpen = ref(false)
const groupOpen = ref(false)
/**
 * 分组面板里正开着改名弹窗或删除确认。
 * 这些弹窗 teleport 到 body，点它们会被 popover 当成「点了外面」而自动收起，
 * 面板连同弹窗一起被卸载。busy 期间按住 popover 不让它关。
 */
const groupBusy = ref(false)

function onGroupOpenChange(open: boolean): void {
  if (!open && groupBusy.value) return
  groupOpen.value = open
}

/** 筛选面板里生效的条件数量，显示在筛选按钮的角标上 */
const activeFilterCount = computed(() => {
  const f = accountsStore.filter
  return (
    f.statuses.length +
    f.subscriptions.length +
    f.idps.length +
    // 分组筛选另有独立按钮与角标，这里不重复计入，只在「清除筛选」时一并清掉
    // != null：输入框清空时给的是 null，按 !== undefined 判断会把它算成一个生效条件
    (f.usageMin != null ? 1 : 0) +
    (f.usageMax != null ? 1 : 0) +
    (f.daysRemainingMin != null ? 1 : 0) +
    (f.daysRemainingMax != null ? 1 : 0)
  )
})

function clearFilter(): void {
  accountsStore.applyFilter({ search: accountsStore.filter.search })
}

/** 与设置页的「隐私打码」是同一个开关，这里切换会一起持久化 */
const privacyMode = computed(() => settingsStore.settings.privacyMode)

function togglePrivacy(): void {
  void settingsStore.update({ privacyMode: !privacyMode.value })
}

/** 展示形态：卡片 / 紧凑卡片 / 列表，和隐私打码一样持久化在设置里 */
const displayMode = computed(() => settingsStore.settings.accountDisplayMode)

function setDisplayMode(mode: AccountDisplayMode): void {
  void settingsStore.update({ accountDisplayMode: mode })
}

/** 分组读写门面：面板与批量弹窗都用它，屏蔽「账号同步写 / Key 走 IPC」的差异 */
const groupApi = accountGroupApi()

function toggleGroupFilter(id: string): void {
  const list = accountsStore.filter.groupIds
  accountsStore.filter.groupIds = list.includes(id)
    ? list.filter((v) => v !== id)
    : [...list, id]
}

/** 批量备注：覆盖式改写所选账号的备注，留空即清空 */
function applyBatchNote(note: string): void {
  const changed = accountsStore.setNoteForAccounts(accountsStore.selectedIds, note)
  message.success(note.trim() ? `已为 ${changed} 个账号设置备注` : `已清空 ${changed} 个账号的备注`)
  batchNoteOpen.value = false
}

/**
 * 一张带报错的卡片比同类卡片高出多少像素 = 报错行本身 + 它上面那道间距。
 *
 * 与 AccountCard 里 .error-line 的样式硬绑定，改那边的行高 / padding / 间距
 * 必须同步改这里，否则虚拟滚动算出的行高会和实际差一截：
 *   卡片   28（18 行高 + 上下 5px padding）+ 12（卡片竖向间距）= 40
 *   紧凑   28 + 8（紧凑模式收紧后的间距）= 36
 *   列表   24（padding 收成 3px）+ 8（折行间距，报错独占一行）= 32
 */
const ERROR_ROW_EXTRA: Record<AccountDisplayMode, number> = { card: 40, compact: 36, list: 32 }

/**
 * 有了这个值，虚拟滚动就只给「真的有报错卡片」的那一行加高，
 * 而不是一见到报错就把所有行一起抬高。
 */
function gridItemExtra(item: GridItem): number {
  if (item.kind !== 'account' || !item.account.lastError) return 0
  return ERROR_ROW_EXTRA[displayMode.value]
}

/**
 * 每种形态的单元格预估高度与最小列宽。
 *
 * 列宽给 list 一个不可能满足的值，列数就恒为 1 —— 虚拟滚动那边
 * 「宽度算列数」的逻辑不用为列表模式开分支。
 */
const gridLayout = computed(() => {
  switch (displayMode.value) {
    case 'compact':
      // 用量块压成两行后比卡片模式矮不少，首帧的预估值跟着调低
      return { minColumnWidth: 320, estimatedHeight: 235 }
    case 'list':
      // 用量块改成两行排布后一条约 70px，预估值跟着调高
      return { minColumnWidth: 100000, estimatedHeight: 76 }
    default:
      return { minColumnWidth: 320, estimatedHeight: 330 }
  }
})

const sorted = computed(() => {
  const list = [...accountsStore.filtered]
  switch (sortKey.value) {
    case 'email':
      return list.sort((a, b) => a.email.localeCompare(b.email))
    case 'usage':
      return list.sort((a, b) => (b.usage.percentUsed || 0) - (a.usage.percentUsed || 0))
    case 'reset':
      return list.sort(
        (a, b) => (a.subscription.daysRemaining ?? 9999) - (b.subscription.daysRemaining ?? 9999)
      )
    case 'checked':
      return list.sort((a, b) => (b.lastCheckedAt ?? 0) - (a.lastCheckedAt ?? 0))
    default:
      // 激活账号置顶，其余按添加时间倒序
      return list.sort(
        (a, b) => Number(b.isActive) - Number(a.isActive) || (b.createdAt || 0) - (a.createdAt || 0)
      )
  }
})

/** 网格数据：账号卡片 + 末尾一张「添加账号」卡 */
type GridItem = { kind: 'account'; account: Account } | { kind: 'add' }

const gridItems = computed<GridItem[]>(() => [
  ...sorted.value.map((account) => ({ kind: 'account' as const, account })),
  { kind: 'add' as const }
])

function gridItemKey(item: GridItem): string {
  return item.kind === 'add' ? '__add__' : item.account.id
}

const gridRef = ref<{ scrollToTop: () => void } | null>(null)

/**
 * 回到顶部的触发条件：筛选条件（含搜索词）或排序方式变化。
 *
 * 这里必须用「值快照」而不是把 sorted.length 之类的派生值塞进 watch 源：
 * 自动刷新会整体替换账号数据，派生的计算属性随之重算，
 * 只要 watch 源是每次新建的对象/数组，回调就会被触发，
 * 表现就是滚动中莫名跳回顶部。
 */
const scrollResetKey = computed(() => JSON.stringify([accountsStore.filter, sortKey.value]))

watch(scrollResetKey, () => gridRef.value?.scrollToTop())

/** 账号上千时用 Set 做包含判断，别用 includes 扫数组 */
const selectedIdSet = computed(() => new Set(accountsStore.selectedIds))

/** 当前筛选结果里被勾选的数量，一次遍历同时支撑全选与半选状态 */
const visibleSelectedCount = computed(() => {
  let count = 0
  for (const account of sorted.value) {
    if (selectedIdSet.value.has(account.id)) count++
  }
  return count
})

/**
 * 批量刷新按钮的范围后缀：有勾选时只刷勾选的账号，把数量带到按钮上。
 * 取可见勾选数而非全部勾选数，与 batch() 实际会处理的条数对齐。
 */
const batchScopeSuffix = computed(() =>
  visibleSelectedCount.value ? `（${visibleSelectedCount.value}个）` : ''
)

const allVisibleSelected = computed(
  () => sorted.value.length > 0 && visibleSelectedCount.value === sorted.value.length
)
const someVisibleSelected = computed(
  () => visibleSelectedCount.value > 0 && !allVisibleSelected.value
)

/** 在勾选集合上做增删：账号上千时用 Set 改再回写，避免逐条线性扫描 */
function updateSelection(mutate: (set: Set<string>) => void): void {
  const set = new Set(accountsStore.selectedIds)
  mutate(set)
  accountsStore.selectedIds = [...set]
}

function toggleSelect(id: string, checked: boolean): void {
  updateSelection((set) => (checked ? set.add(id) : set.delete(id)))
}

/** 全选 / 取消全选当前筛选结果 */
function toggleSelectVisible(checked: boolean): void {
  updateSelection((set) => {
    for (const account of sorted.value) {
      if (checked) set.add(account.id)
      else set.delete(account.id)
    }
  })
}

function displayEmail(email: string): string {
  return maskedEmail(email, privacyMode.value)
}

function setBusy(id: string, action?: string): void {
  rowBusy.value = { ...rowBusy.value, [id]: action }
}

async function withBusy(id: string, action: string, fn: () => Promise<void>): Promise<void> {
  setBusy(id, action)
  try {
    await fn()
  } finally {
    setBusy(id, undefined)
  }
}

async function refreshKey(account: Account): Promise<void> {
  await withBusy(account.id, 'refresh-key', async () => {
    const res = await accountsStore.refreshToken(account.id)
    notifyResult(res, {
      success: res.syncedToIde ? '密钥已刷新并同步到 Kiro IDE' : '密钥已刷新',
      failPrefix: '刷新密钥失败'
    })
  })
}

async function refreshUsage(account: Account): Promise<void> {
  await withBusy(account.id, 'refresh-usage', async () => {
    const res = await accountsStore.checkStatus(account.id)
    notifyResult(res, { success: '用量与积分已更新', failPrefix: '刷新用量失败' })
  })
}

/** 用该账号凭证在私密窗口打开官网后台，与详情抽屉走同一个通道 */
async function openPortal(account: Account): Promise<void> {
  await withBusy(account.id, 'portal', async () => {
    const res = await window.api.openAccountPortal(toPlain(account))
    if (!res.success) message.error(res.error || '打开官网失败')
  })
}

function copyToken(account: Account): void {
  const { accessToken, refreshToken, clientId, clientSecret } = account.credentials
  if (!accessToken && !refreshToken && !clientId && !clientSecret) {
    return void message.warning('该账号没有可复制的凭证')
  }
  const payload = {
    accessToken: accessToken || '',
    refreshToken: refreshToken || '',
    clientId: clientId || '',
    clientSecret: clientSecret || ''
  }
  copyText(JSON.stringify(payload, null, 2), '凭证 JSON 已复制到剪贴板')
}

const switchResult = ref<SwitchAccountResult | null>(null)
const switchLabel = ref('')
const switchModalOpen = ref(false)

async function switchTo(account: Account): Promise<void> {
  await withBusy(account.id, 'switch', async () => {
    const res = await accountsStore.switchTo(account.id)
    if (!res.ok || !res.result) return void message.error(`切换失败：${res.error}`)
    switchResult.value = res.result
    // 打码模式下昵称同样要遮住，只显示打码邮箱
    switchLabel.value = privacyMode.value
      ? displayEmail(account.email)
      : account.nickname
        ? `${account.nickname}（${account.email}）`
        : account.email
    switchModalOpen.value = true
  })
}

function clearDeletedAccountUi(ids: string[]): void {
  const deleted = new Set(ids)
  if (editTarget.value && deleted.has(editTarget.value.id)) editTarget.value = null
  if (detailTarget.value && deleted.has(detailTarget.value.id)) detailTarget.value = null
  if (testTarget.value && deleted.has(testTarget.value.id)) testTarget.value = null
  if (usageTarget.value && deleted.has(usageTarget.value.id)) usageTarget.value = null
  const nextBusy = { ...rowBusy.value }
  for (const id of deleted) delete nextBusy[id]
  rowBusy.value = nextBusy
}

function removeOne(account: Account): void {
  const doRemove = async (): Promise<void> => {
    const result = await accountsStore.removeAccounts([account.id])
    if (result.error) return void message.error(result.error)
    if (!result.removed) return void message.warning('账号已不存在')
    clearDeletedAccountUi([account.id])
    message.success('已删除')
  }
  if (!settingsStore.settings.confirmBeforeDelete) return void doRemove()
  confirmDelete({
    title: '删除账号',
    content: h('span', {}, [`确认删除 ${displayEmail(account.email)}？该操作不可撤销。`]),
    onOk: doRemove
  })
}

function removeSelected(): void {
  const ids = [...accountsStore.selectedIds]
  if (ids.length === 0) return void message.info('请先选择账号')
  confirmDelete({
    title: `删除 ${ids.length} 个账号`,
    content: '删除后无法恢复，建议先导出备份。',
    onOk: async () => {
      const result = await accountsStore.removeAccounts(ids)
      if (result.error) return void message.error(result.error)
      clearDeletedAccountUi(ids)
      message.success(`已删除 ${result.removed} 个账号`)
    }
  })
}

async function batch(kind: 'refresh' | 'check'): Promise<void> {
  // 按界面当前排序取 id，保证从列表第一个账号开始刷，而不是按内部存储顺序
  const selected = new Set(accountsStore.selectedIds)
  const scope = selected.size ? sorted.value.filter((a) => selected.has(a.id)) : sorted.value

  // 没有勾选时才算「刷了全部」，这种情况刷完把自动刷新整轮往后顺延
  const isFullRun = selected.size === 0

  // 全量刷新时跳过确定性失败的账号（封禁、凭证失效），省下必然白跑的请求。
  // 勾选场景不跳过：用户已经明确指定了目标，替他做决定反而困惑；
  // 卡片上的单个刷新按钮同样不受影响，异常账号始终留有手动重试的入口。
  const runnable = isFullRun ? scope.filter((a) => !shouldSkipAccountUsageRefresh(a)) : scope
  const skipped = scope.length - runnable.length
  const ids = runnable.map((a) => a.id)
  if (ids.length === 0) {
    return void message.info(
      skipped ? `${skipped} 个账号处于封禁或凭证失效状态，已全部跳过` : '没有可操作的账号'
    )
  }

  const label = kind === 'refresh' ? '密钥刷新' : '用量刷新'
  const key = `batch-${kind}`

  // message 内容用自带响应式的组件渲染：进度变化时它自己重渲染，
  // 不依赖 message 对同 key 通知的内容更新机制（那条链路不保证及时刷新）
  batchProgress.value = `${label} 0/${ids.length}`
  message.open({ key, type: 'loading', content: h(BatchProgressText), duration: 0 })

  const res = await accountsStore.runBatch(ids, kind, (done, total) => {
    batchProgress.value = `${label} ${done}/${total}`
  })

  // 刚全量刷完，下一轮自动刷新从现在起重新计时，避免紧接着又刷一遍
  if (isFullRun) {
    if (kind === 'refresh') accountsStore.scheduleKeyRefresh()
    else accountsStore.scheduleUsageRefresh()
  }

  // 收尾时销毁进度提示再弹结果，避免复用同 key 带来的更新不确定性
  message.destroy(key)
  const skippedText = skipped ? `，跳过 ${skipped}` : ''
  if (res.failed) {
    message.warning(`${label}完成：成功 ${res.success}，失败 ${res.failed}${skippedText}`)
    console.warn(res.messages)
  } else {
    message.success(`${label}完成：成功 ${res.success}${skippedText}`)
  }
}

/**
 * 退出 IDE 登录。入口只在账号卡片上，因此 account 必传。
 * 实际动作与账号无关（清空整个 sso cache 目录），account 只用于弹窗标题和行级加载态。
 */
function logoutIde(account: Account): void {
  confirmDanger({
    title: `退出 ${displayEmail(account.email)} 的登录`,
    content: '会清空 ~/.aws/sso/cache 目录下的凭证文件，IDE 需要重新登录或重新切号。',
    okText: '继续',
    onOk: async () => {
      setBusy(account.id, 'logout')
      try {
        const res = await accountsStore.logoutIde()
        notifyResult(res, { success: `已清理 ${res.deleted} 个凭证文件` })
      } finally {
        setBusy(account.id, undefined)
      }
    }
  })
}
</script>

<template>
  <div class="accounts-page">
    <div class="accounts-header">
      <!-- 第一行：搜索 + 主操作 -->
      <div class="toolbar">
        <a-input
          v-model:value="accountsStore.filter.search"
          allow-clear
          placeholder="搜索邮箱 / 昵称 / 备注"
          class="search-input"
        >
          <template #prefix><SearchOutlined /></template>
        </a-input>

        <span class="toolbar-spacer" />

        <a-button type="primary" @click="addOpen = true">
          <template #icon><PlusOutlined /></template>
          添加账号
        </a-button>
        <a-dropdown>
          <a-button>
            <template #icon><UploadOutlined /></template>
            导入
            <DownOutlined />
          </a-button>
          <template #overlay>
            <a-menu>
              <a-menu-item key="file" @click="importFileOpen = true">
                <InboxOutlined />
                从文件导入
              </a-menu-item>
              <a-menu-item key="text" @click="importTextOpen = true">
                <CodeOutlined />
                输入 JSON 导入
              </a-menu-item>
            </a-menu>
          </template>
        </a-dropdown>
        <a-button @click="exportOpen = true">
          <template #icon><DownloadOutlined /></template>
          导出
        </a-button>
      </div>

      <!-- 第二行：统计 + 筛选 / 排序 / 批量 / 选择 -->
      <div class="meta-bar">
        <span class="count-text">共 {{ sorted.length }} 个账号</span>
        <a-tag v-if="stats.byStatus.active" color="green" :bordered="false">
          正常 {{ stats.byStatus.active }}
        </a-tag>
        <a-tag v-if="stats.byStatus.error + stats.byStatus.banned" color="red" :bordered="false">
          异常 {{ stats.byStatus.error + stats.byStatus.banned }}
        </a-tag>
        <a-tag v-if="stats.expiringSoon" color="orange" :bordered="false">
          7 天内重置 {{ stats.expiringSoon }}
        </a-tag>
        <a-tag v-if="activeFilterCount" color="purple" closable @close="clearFilter">
          筛选中 {{ activeFilterCount }} 项
        </a-tag>

        <span class="toolbar-spacer" />

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
            <AccountFilterPanel v-if="filterOpen" />
          </template>
          <a-badge :count="activeFilterCount" :offset="[-4, 4]">
            <a-button size="small" :type="activeFilterCount ? 'primary' : 'default'">
              <template #icon><FilterOutlined /></template>
              筛选
            </a-button>
          </a-badge>
        </a-popover>

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
              :selected="accountsStore.filter.groupIds"
              :matched="accountsStore.filtered.length"
              entity="账号"
              @toggle="toggleGroupFilter"
              @clear="accountsStore.filter.groupIds = []"
              @busy="groupBusy = $event"
            />
          </template>
          <a-badge :count="accountsStore.filter.groupIds.length" :offset="[-4, 4]">
            <a-button
              size="small"
              :type="accountsStore.filter.groupIds.length ? 'primary' : 'default'"
            >
              <template #icon><AppstoreOutlined /></template>
              分组
            </a-button>
          </a-badge>
        </a-popover>

        <a-dropdown>
          <a-button size="small">
            <template #icon><SortAscendingOutlined /></template>
            {{ sortLabel }}
            <DownOutlined />
          </a-button>
          <template #overlay>
            <a-menu :selected-keys="[sortKey]">
              <a-menu-item
                v-for="item in sortOptions"
                :key="item.value"
                @click="sortKey = item.value"
              >
                {{ item.label }}
              </a-menu-item>
            </a-menu>
          </template>
        </a-dropdown>

        <a-divider type="vertical" style="margin: 0 2px" />

        <!-- 两种刷新收进同一个菜单：它们互斥，全局任务状态一次只容得下一条 -->
        <a-dropdown :disabled="busy">
          <a-button size="small" :loading="refreshing">
            <template #icon><SyncOutlined /></template>
            {{ refreshButtonText }}
            <DownOutlined v-if="!refreshing" />
          </a-button>
          <template #overlay>
            <a-menu>
              <a-menu-item key="refresh" @click="batch('refresh')">
                <KeyOutlined />
                刷新密钥{{ batchScopeSuffix }}
              </a-menu-item>
              <a-menu-item key="check" @click="batch('check')">
                <SyncOutlined />
                刷新用量与积分{{ batchScopeSuffix }}
              </a-menu-item>
            </a-menu>
          </template>
        </a-dropdown>
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

        <!-- 展示形态：卡片 / 紧凑卡片 / 列表，选择会持久化 -->
        <DisplayModeSelect :value="displayMode" @change="setDisplayMode" />

        <!-- 批量操作与删除都作用于全部勾选项（不受当前搜索影响） -->
        <a-dropdown v-if="accountsStore.selectedIds.length">
          <a-button size="small">
            批量操作（{{ accountsStore.selectedIds.length }}个）
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

        <a-button
          v-if="accountsStore.selectedIds.length"
          size="small"
          danger
          @click="removeSelected"
        >
          <template #icon><DeleteOutlined /></template>
          删除（{{ accountsStore.selectedIds.length }}个）
        </a-button>

        <a-divider type="vertical" style="margin: 0 2px" />

        <a-checkbox
          :checked="allVisibleSelected"
          :indeterminate="someVisibleSelected"
          :disabled="sorted.length === 0"
          @change="(e: any) => toggleSelectVisible(e.target.checked)"
        >
          全选
        </a-checkbox>
        <template v-if="accountsStore.selectedIds.length">
          <span class="count-text">已选 {{ accountsStore.selectedIds.length }}</span>
          <a-button type="link" size="small" @click="accountsStore.selectedIds = []">
            清空
          </a-button>
        </template>
      </div>
    </div>

    <div v-if="accountsStore.loading" class="grid-placeholder">
      <a-spin />
    </div>

    <!-- 没有任何账号时不铺网格，直接给引导 -->
    <div v-else-if="!accountsStore.accounts.length" class="grid-placeholder">
      <a-empty description="还没有账号，先添加或导入吧">
        <a-button type="primary" @click="addOpen = true">添加账号</a-button>
      </a-empty>
    </div>

    <!-- 全量渲染交给虚拟滚动，上千个账号也只保留视口内的 DOM -->
    <!--
      key 绑定展示形态：切换形态时行高相差很大，而虚拟滚动量到的高度只允许变高，
      重挂载一次让它重新测量，省掉一套「重置测量」的对外接口。
    -->
    <VirtualGrid
      v-else
      ref="gridRef"
      :key="displayMode"
      :items="gridItems"
      :item-key="gridItemKey"
      :item-extra="gridItemExtra"
      :min-column-width="gridLayout.minColumnWidth"
      :gap="displayMode === 'list' ? 8 : 14"
      :estimated-height="gridLayout.estimatedHeight"
    >
      <template #default="{ item }">
        <AccountCard
          v-if="item.kind === 'account'"
          :account="item.account"
          :selected="selectedIdSet.has(item.account.id)"
          :busy-action="rowBusy[item.account.id]"
          :mode="displayMode"
          @toggle-select="(checked) => toggleSelect(item.account.id, checked)"
          @detail="detailTarget = item.account"
          @create-api-key="apiKeyTarget = item.account"
          @portal="openPortal(item.account)"
          @edit="editTarget = item.account"
          @remove="removeOne(item.account)"
          @switch="switchTo(item.account)"
          @logout="logoutIde(item.account)"
          @refresh-key="refreshKey(item.account)"
          @refresh-usage="refreshUsage(item.account)"
          @copy-token="copyToken(item.account)"
          @test="testTarget = item.account"
          @usage="usageTarget = item.account"
        />
        <button
          v-else
          class="add-card"
          :class="{ 'add-card-row': displayMode === 'list' }"
          @click="addOpen = true"
        >
          <PlusOutlined class="add-card-icon" />
          <span class="add-card-title">添加账号</span>
          <span class="add-card-sub muted">在线登录或粘贴凭证</span>
        </button>
      </template>
    </VirtualGrid>

    <div v-if="!sorted.length && accountsStore.accounts.length" class="no-match muted">
      没有匹配筛选条件的账号
    </div>

    <!-- 所有重型弹层仅在用户实际打开时挂载，避免列表首帧执行其 setup 与监听逻辑。 -->
    <AddAccountModal v-if="addOpen" v-model:open="addOpen" @open-import="openImport" />
    <ImportAccountsFileModal v-if="importFileOpen" v-model:open="importFileOpen" />
    <ImportAccountsTextModal v-if="importTextOpen" v-model:open="importTextOpen" />
    <ExportAccountsModal
      v-if="exportOpen"
      v-model:open="exportOpen"
      :selected-ids="accountsStore.selectedIds"
    />
    <EditAccountModal v-if="editTarget" :account="editTarget" @close="editTarget = null" />
    <BatchNoteModal
      v-if="batchNoteOpen"
      :ids="accountsStore.selectedIds"
      entity="账号"
      @submit="applyBatchNote"
      @close="batchNoteOpen = false"
    />
    <GroupPickerModal
      v-if="batchGroupOpen"
      :api="groupApi"
      :ids="accountsStore.selectedIds"
      entity="账号"
      @close="batchGroupOpen = false"
    />
    <AccountDetailDrawer
      v-if="detailTarget"
      :account="detailTarget"
      @close="detailTarget = null"
    />
    <AccountTestModal v-if="testTarget" :account="testTarget" @close="testTarget = null" />
    <CreateApiKeyModal
      v-if="apiKeyTarget"
      :account="apiKeyTarget"
      @close="apiKeyTarget = null"
    />
    <UsageHistoryModal
      v-if="usageTarget"
      :account="usageTarget"
      @close="usageTarget = null"
    />
    <SwitchResultModal
      v-if="switchModalOpen && switchResult"
      v-model:open="switchModalOpen"
      :account-label="switchLabel"
      :result="switchResult"
    />
  </div>
</template>

<style scoped>
/* 整页占满内容区，让顶栏固定、卡片区独立滚动 */
.accounts-page {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

/* 固定顶栏：搜索筛选 + 全选统计 */
.accounts-header {
  flex: 0 0 auto;
  background: var(--kal-body-bg);
}

/* 加载中 / 空状态占位：占满剩余高度并居中 */
.grid-placeholder {
  flex: 1 1 auto;
  min-height: 0;
  display: grid;
  place-items: center;
}

.no-match {
  flex: 0 0 auto;
  padding: 6px 0 2px;
  text-align: center;
  font-size: 13px;
}

/* 搜索框占据左侧剩余空间，但不至于铺满整行 */
.search-input {
  width: 100%;
  max-width: 480px;
}

.toolbar {
  margin-bottom: 10px;
}

/* 统计与工具图标行 */
.meta-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-bottom: 12px;
  font-size: 13px;
}

.meta-bar .count-text {
  color: var(--kal-muted);
  white-space: nowrap;
}

/* 末尾的「添加账号」卡片：虚线框，高度跟着单元格走 */
.add-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 20px;
  cursor: pointer;
  border: 1px dashed var(--kal-border);
  border-radius: 16px;
  /* 和账号卡片同一个底色，只用虚线边框区分 */
  background: var(--kal-card-bg);
  color: inherit;
  transition:
    border-color 0.16s ease,
    box-shadow 0.16s ease;
}

.add-card:hover {
  border-color: var(--kal-primary);
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.08);
}

/* 列表模式下它是一条通栏，图标与文字横排，高度与账号行看齐 */
.add-card-row {
  flex-direction: row;
  gap: 8px;
  padding: 10px;
  border-radius: 12px;
}

.add-card-row .add-card-icon {
  font-size: 18px;
}

.add-card-row .add-card-title {
  font-size: 13.5px;
}

.add-card-icon {
  font-size: 26px;
  color: var(--kal-primary);
}

.add-card-title {
  font-size: 15px;
  font-weight: 600;
}

.add-card-sub {
  font-size: 12px;
}
</style>
