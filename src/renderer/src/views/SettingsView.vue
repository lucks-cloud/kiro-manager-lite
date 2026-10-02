<script setup lang="ts">
import { computed, h, onMounted, onUnmounted, ref, watch } from 'vue'
import { message } from 'ant-design-vue'
import {
  CloudUploadOutlined,
  DownloadOutlined,
  FolderOpenOutlined,
  ReloadOutlined,
  UploadOutlined
} from '@ant-design/icons-vue'
import {
  BACKUP_CYCLE_OPTIONS,
  BACKUP_KEEP_MAX,
  BACKUP_KEEP_MIN,
  BACKUP_MIN_INTERVAL_MINUTES,
  WEEKDAY_LABELS,
  describeBackupCycle,
  normalizeBackupCycle,
  normalizeBackupKeep,
  type BackupCycle
} from '@shared/backupSchedule'
import { DEFAULT_SETTINGS } from '@shared/types'
import type { AppSettings, BackupScheduleStatus, DataBackupSummary, ThemeMode } from '@shared/types'
import ThemeModeIcon from '@/components/common/ThemeModeIcon.vue'
import {
  PORTAL_LOCALE_CUSTOM,
  PORTAL_LOCALE_PRESETS,
  isPresetPortalLocale,
  normalizePortalLocale
} from '@shared/portalLocale'
import { useSettingsStore } from '@/stores/settings'
import SettingSwitch from '@/components/common/SettingSwitch.vue'
import PathMenu from '@/components/common/PathMenu.vue'
import { useAccountsStore } from '@/stores/accounts'
import { useKeysStore } from '@/stores/keys'
import { formatCheckedAt } from '@/utils/format'
import { now } from '@/utils/now'
import { bodyPopupContainer, confirmDanger } from '@/utils/ui'

const settingsStore = useSettingsStore()
const accountsStore = useAccountsStore()
const keysStore = useKeysStore()

const settings = computed(() => settingsStore.settings)
const proxyDraft = ref(settingsStore.settings.proxyUrl)

/** 各设置卡片共用的表单栅格：左侧固定标签宽度，右侧自适应 */
const FORM_LAYOUT = {
  layout: 'horizontal',
  labelCol: { flex: '0 0 130px' },
  wrapperCol: { flex: '1 1 auto' }
} as const


/** 下次刷新的时间与倒计时，跟着共享时钟每 5 秒重算 */
function nextRefreshText(at: number | null): string {
  if (!at) return '未开启，不会自动执行'
  const remain = at - now.value
  // 到期后到期时间会被立刻往后推，这里还没推说明本轮正在执行或在等手动任务让路
  if (remain <= 0) return '本轮正在执行…'
  const minutes = Math.floor(remain / 60_000)
  const seconds = Math.floor((remain % 60_000) / 1000)
  const countdown = minutes ? `${minutes} 分 ${seconds} 秒后` : `${seconds} 秒后`
  return `下次刷新 ${formatCheckedAt(at, now.value)}（${countdown}）`
}

const nextKeyRefreshText = computed(() => nextRefreshText(accountsStore.nextKeyRefreshAt))
const nextUsageRefreshText = computed(() => nextRefreshText(accountsStore.nextUsageRefreshAt))
const nextApiKeyUsageRefreshText = computed(() => nextRefreshText(keysStore.nextUsageRefreshAt))

watch(
  () => settingsStore.settings.proxyUrl,
  (value) => {
    if (value !== proxyDraft.value) proxyDraft.value = value
  }
)

const themeModeOptions: { value: ThemeMode; label: string }[] = [
  { value: 'auto', label: '自动' },
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' }
]

/** 主题色预设。色值沿用旧版的七个，老用户选过的颜色升级后仍能在这里对上、显示为选中 */
const colorOptions: { value: string; label: string }[] = [
  { value: '#7c3aed', label: '紫罗兰' },
  { value: '#1677ff', label: '天空蓝' },
  { value: '#13c2c2', label: '青碧色' },
  { value: '#52c41a', label: '翡翠绿' },
  { value: '#fa8c16', label: '琥珀橙' },
  { value: '#eb2f96', label: '樱花粉' },
  { value: '#f5222d', label: '朱砂红' }
]


/** 输入框可能给出 null 或越界值，统一夹到 1-100 */
function clampImportConcurrency(value: unknown): number {
  const num = Number(value)
  if (!Number.isFinite(num)) return DEFAULT_SETTINGS.importConcurrency
  return Math.max(1, Math.min(Math.round(num), 100))
}

const closeActionOptions: { value: AppSettings['closeAction']; label: string }[] = [
  { value: 'ask', label: '每次询问' },
  { value: 'minimize', label: '最小化到托盘' },
  { value: 'quit', label: '退出程序' }
]

const portalLocale = computed(
  () => settings.value.portalLocale ?? DEFAULT_SETTINGS.portalLocale
)

/** 预设与主进程共用同一份，末尾追加「自定义」入口 */
const localeSelectOptions = [
  ...PORTAL_LOCALE_PRESETS,
  { value: PORTAL_LOCALE_CUSTOM, label: '自定义…' }
]

/**
 * 是否处于自定义模式。
 * 初值看当前取值是否落在预设里：手输过 zh-Hant-HK 这类值时，重新进设置页要保持自定义态。
 */
const localeCustomMode = ref(!isPresetPortalLocale(portalLocale.value))

/** 自定义输入走本地草稿，回车或点保存才提交，避免每敲一个字母写一次设置 */
const localeDraft = ref(portalLocale.value)

watch(
  () => settingsStore.settings.portalLocale,
  (value) => {
    if (value !== localeDraft.value) localeDraft.value = value
    // 设置被外部改成非预设值（如恢复默认后再手改）时同步切换模式
    if (!isPresetPortalLocale(value)) localeCustomMode.value = true
  }
)

/** 自定义模式下下拉固定停在「自定义」，否则跟随当前预设 */
const localeSelectValue = computed(() =>
  localeCustomMode.value ? PORTAL_LOCALE_CUSTOM : portalLocale.value
)

/** 支持按地区名或语言标签搜索，输入 ru 或「俄」都能筛到 */
function filterLocaleOption(input: string, option: { value: string; label: string }): boolean {
  const keyword = input.trim().toLowerCase()
  if (!keyword) return true
  return (
    option.value.toLowerCase().includes(keyword) || option.label.toLowerCase().includes(keyword)
  )
}

function onLocaleSelect(value: string): void {
  if (value === PORTAL_LOCALE_CUSTOM) {
    // 只切模式、不动已生效的值：等用户填完再提交，避免中途把地区改成空
    localeCustomMode.value = true
    localeDraft.value = portalLocale.value
    return
  }
  localeCustomMode.value = false
  update({ portalLocale: value })
}

/** 提交前规范化：与主进程同一套实现，避免界面显示的和实际生效的不一致 */
function savePortalLocale(): void {
  const normalized = normalizePortalLocale(localeDraft.value)
  localeDraft.value = normalized
  // 填的正好是预设值时收起输入框，回到下拉直选的状态
  if (isPresetPortalLocale(normalized)) localeCustomMode.value = false
  if (normalized !== portalLocale.value) update({ portalLocale: normalized })
}

/** 设置缺失时回落到默认的「最小化到托盘」，避免下拉显示空白 */
const closeAction = computed(
  () => settings.value.closeAction ?? DEFAULT_SETTINGS.closeAction
)

function update(patch: Parameters<typeof settingsStore.update>[0]): void {
  void settingsStore.update(patch)
}

async function saveProxy(): Promise<void> {
  await settingsStore.update({ proxyUrl: proxyDraft.value.trim() })
  message.success('代理地址已保存')
}

function openPath(target: 'store' | 'backup'): void {
  void window.api.showPath(target)
}

/** 备份范围说明，和主进程 dataBackup 里实际打包的内容一致 */
const BACKUP_SCOPE = '账号、Kiro API Key、账号与 API Key 的用量记录、本地反代的 API Key'

// ============ 备份计划 ============

const cycle = computed(() => normalizeBackupCycle(settings.value.backupCycle))
const cycleOptions = BACKUP_CYCLE_OPTIONS
const weekdayOptions = WEEKDAY_LABELS.map((label, value) => ({ value, label }))
const monthDayOptions = Array.from({ length: 31 }, (_, i) => ({ value: i + 1, label: `${i + 1} 号` }))

/** 每种周期需要填哪几项，和图示一致：选了类型后右侧只出现相关的输入框 */
const cycleFields = computed(() => {
  const t = cycle.value.type
  return {
    n: t === 'nDays' || t === 'nHours' || t === 'nMinutes',
    weekday: t === 'week',
    day: t === 'month',
    hour: t === 'day' || t === 'nDays' || t === 'week' || t === 'month',
    minute: t !== 'nMinutes'
  }
})

const nUnit = computed(() => ({ nDays: '天', nHours: '小时', nMinutes: '分钟' })[cycle.value.type as 'nDays'] ?? '')
const nMin = computed(() => (cycle.value.type === 'nMinutes' ? BACKUP_MIN_INTERVAL_MINUTES : 1))

function updateCycle(patch: Partial<BackupCycle>): void {
  update({ backupCycle: normalizeBackupCycle({ ...cycle.value, ...patch }) })
}

/** 换周期类型时把 N 夹进新类型的范围：从 N 小时的 2 换到 N 分钟，2 分钟低于下限 */
function changeCycleType(type: BackupCycle['type']): void {
  updateCycle({ type, n: type === 'nMinutes' ? Math.max(cycle.value.n, 30) : cycle.value.n })
}

const backupState = ref<BackupScheduleStatus | null>(null)
const backingUp = ref(false)
let offBackupStatus: (() => void) | null = null

onMounted(async () => {
  offBackupStatus = window.api.onBackupStatus((status) => (backupState.value = status))
  const res = await window.api.getBackupStatus()
  if (res.success && res.data) backupState.value = res.data
})
onUnmounted(() => offBackupStatus?.())

// 开关、周期一改，主进程会重排并推送新状态；这里再主动拉一次，避免推送比保存先到
watch(
  () => [settings.value.backupEnabled, JSON.stringify(settings.value.backupCycle)],
  async () => {
    const res = await window.api.getBackupStatus()
    if (res.success && res.data) backupState.value = res.data
  }
)

const backupNextText = computed(() => {
  const next = backupState.value?.nextAt
  if (!settings.value.backupEnabled || !next) return '未开启'
  return formatCheckedAt(next, now.value)
})

const backupLastText = computed(() => {
  const s = backupState.value
  if (!s?.lastAt) return '还没有备份过'
  return `${formatCheckedAt(s.lastAt, now.value)}${s.lastError ? '（失败）' : ''}`
})

async function backupNow(): Promise<void> {
  backingUp.value = true
  try {
    const res = await window.api.runBackupNow()
    if (!res.success) return void message.error(res.error || '备份失败')
    backupState.value = res.data ?? backupState.value
    if (res.data?.lastError) message.error(`备份失败：${res.data.lastError}`)
    else message.success('已备份到备份目录')
  } finally {
    backingUp.value = false
  }
}

const exporting = ref(false)
const importing = ref(false)
const resetting = ref(false)

/** 导出数据：保存后主进程会在文件管理器里选中该文件 */
async function exportAll(): Promise<void> {
  exporting.value = true
  try {
    const res = await window.api.exportAllData()
    if (!res.success) return void message.error(res.error || '导出失败')
    if (res.data?.saved) message.success('已导出数据')
  } finally {
    exporting.value = false
  }
}

/** Modal.confirm 渲染在 body 下，组件的 scoped 样式管不到，段落间距只能内联 */
const CONFIRM_LINE = 'margin: 0 0 6px'

function formatBackupTime(at: number): string {
  return new Date(at).toLocaleString('zh-CN', { hour12: false })
}

/** 先选文件、看摘要，确认后再整体替换；替换完成后应用会自行重启 */
async function importAll(): Promise<void> {
  importing.value = true
  let summary: DataBackupSummary | null | undefined
  try {
    const res = await window.api.pickImportData()
    if (!res.success) return void message.error(res.error || '读取备份失败')
    summary = res.data
  } finally {
    importing.value = false
  }
  if (!summary) return
  const parts: string[] = []
  if (summary.accounts !== null) parts.push(`${summary.accounts} 个账号`)
  if (summary.apiKeys !== null) parts.push(`${summary.apiKeys} 个 Kiro API Key`)
  if (summary.proxyKeys !== null) parts.push(`${summary.proxyKeys} 个反代 API Key`)
  if (summary.usageHistory) parts.push('用量记录')
  const lines = [
    `导出时间：${summary.exportedAt ? formatBackupTime(summary.exportedAt) : '未知'}${summary.appVersion ? `（v${summary.appVersion}）` : ''}`,
    `包含：${parts.join('、') || '无可导入的内容'}`,
    '文件里带了的部分会替换本机对应的数据，没带的部分和设置等其他数据保持不变；完成后应用自动重启。'
  ]
  if (summary.newerSchema) {
    lines.push('该文件来自更新版本的应用，本版本认识的部分会照常导入，其余部分会被忽略。')
  }
  confirmDanger({
    title: '导入数据',
    content: h('div', lines.map((line) => h('p', { style: CONFIRM_LINE }, line))),
    okText: '导入并重启',
    okButtonProps: { type: 'primary', danger: true },
    onOk: async () => {
      const res = await window.api.applyImportData()
      // 成功时应用已经重启，走不到这里；能拿到结果就是失败了
      if (!res.success) message.error(res.error || '导入失败')
    }
  })
}

/*
 * 外部配置（机器码、Kiro IDE 端点、自动同意 AI 操作、桌面 agent）由主进程在初始化时自动还原，
 * 确认框里不逐条列出，只说清楚会删掉什么。
 */
function resetAll(): void {
  confirmDanger({
    title: '初始化',
    content: h('div', [
      h('p', { style: CONFIRM_LINE }, '删除全部账号、API Key、设置、本地反代配置与反代 API Key、日志、历史记录和备份目录里的所有备份，和初次安装时一样。'),
      h('p', { style: CONFIRM_LINE }, '该操作不可撤销，完成后应用自动重启。')
    ]),
    okText: '确认初始化',
    okButtonProps: { type: 'primary', danger: true },
    onOk: async () => {
      resetting.value = true
      const res = await window.api.resetAllData()
      resetting.value = false
      if (!res.success) message.error(res.error || '初始化失败')
    }
  })
}
</script>

<template>
  <div>
    <a-card size="small" title="外观" style="margin-bottom: 16px">
      <a-form v-bind="FORM_LAYOUT">
        <a-form-item label="主题风格">
          <div class="choice-group" role="radiogroup" aria-label="主题风格">
            <button
              v-for="opt in themeModeOptions"
              :key="opt.value"
              type="button"
              role="radio"
              class="choice-card"
              :class="{ selected: settings.themeMode === opt.value }"
              :aria-checked="settings.themeMode === opt.value"
              @click="update({ themeMode: opt.value })"
            >
              <ThemeModeIcon :mode="opt.value" />
              <span class="choice-label">{{ opt.label }}</span>
            </button>
          </div>
          <div class="choice-hint">选择界面主题风格，「自动」跟随系统的浅色 / 深色切换</div>
        </a-form-item>
        <a-form-item label="主题色">
          <div class="choice-group" role="radiogroup" aria-label="主题色">
            <button
              v-for="opt in colorOptions"
              :key="opt.value"
              type="button"
              role="radio"
              class="choice-card"
              :class="{ selected: settings.primaryColor === opt.value }"
              :aria-checked="settings.primaryColor === opt.value"
              @click="update({ primaryColor: opt.value })"
            >
              <span class="swatch" :style="{ background: opt.value }" />
              <span class="choice-label">{{ opt.label }}</span>
            </button>
          </div>
          <div class="choice-hint">选择界面的强调色，用于按钮、链接与选中态</div>
        </a-form-item>
        <a-form-item label="控件尺寸">
          <a-radio-group
            :value="settings.componentSize"
            @change="(e: any) => update({ componentSize: e.target.value })"
          >
            <a-radio value="default">默认尺寸</a-radio>
            <a-radio value="large">大尺寸</a-radio>
          </a-radio-group>
        </a-form-item>
        <a-form-item label="隐私打码" class="field-inline">
          <SettingSwitch field="privacyMode" />
          <span class="muted">列表与详情中隐藏邮箱、昵称、API Key 等隐私信息</span>
        </a-form-item>
        <a-form-item label="积分两位小数">
          <SettingSwitch field="usagePrecision" />
        </a-form-item>
      </a-form>
    </a-card>

    <a-card size="small" title="账号刷新" style="margin-bottom: 16px">
      <a-form v-bind="FORM_LAYOUT">
        <a-form-item label="自动刷新密钥" class="field-inline">
          <SettingSwitch field="autoRefresh" />
          <span class="muted">
            只刷新 30 分钟内即将过期的账号，避免无谓轮换 Refresh Token
          </span>
        </a-form-item>
        <a-form-item label="IDE 主动续期" class="field-inline">
          <SettingSwitch field="proactiveRenewalEnabled" />
          <span class="muted">
            在 IDE 激活账号的 token 剩 ~15 分钟时抢先 refresh，让 Kiro IDE 永远不自己 refresh
          </span>
        </a-form-item>
        <a-form-item label="自动刷新用量" class="field-inline">
          <SettingSwitch field="autoRefreshUsage" />
          <span class="muted">
            按下面的用量刷新间隔与批量并发，定期拉取账号的积分用量与订阅信息
          </span>
        </a-form-item>
        <a-form-item label="密钥刷新间隔" class="field-inline">
          <a-input-number
            :value="settings.keyRefreshInterval"
            :min="1"
            :max="600"
            :step="5"
            addon-after="分钟"
            style="width: 180px"
            :disabled="!settings.autoRefresh"
            @change="(v: unknown) => update({ keyRefreshInterval: Number(v) || DEFAULT_SETTINGS.keyRefreshInterval })"
          />
          <span class="muted">
            多久检查一次即将过期的密钥
            <span class="next-refresh">{{ nextKeyRefreshText }}</span>
          </span>
        </a-form-item>
        <a-form-item label="用量刷新间隔" class="field-inline">
          <a-input-number
            :value="settings.usageRefreshInterval"
            :min="1"
            :max="600"
            :step="5"
            addon-after="分钟"
            style="width: 180px"
            :disabled="!settings.autoRefreshUsage"
            @change="(v: unknown) => update({ usageRefreshInterval: Number(v) || DEFAULT_SETTINGS.usageRefreshInterval })"
          />
          <span class="muted">
            多久拉取一次积分用量与订阅信息
            <span class="next-refresh">{{ nextUsageRefreshText }}</span>
          </span>
        </a-form-item>
        <a-form-item label="批量并发" class="field-inline">
          <a-input-number
            :value="settings.concurrency"
            :min="1"
            :max="20"
            style="width: 180px"
            @change="(v: unknown) => update({ concurrency: Number(v) || 5 })"
          />
          <span class="muted">并发过高容易被限流</span>
        </a-form-item>
        <a-form-item label="删除前确认">
          <SettingSwitch field="confirmBeforeDelete" />
        </a-form-item>
      </a-form>
      <ul class="tips">
        <li>自动刷新密钥只处理 30 分钟内即将过期的账号；自动刷新用量会覆盖全部非封禁账号。</li>
        <li>两个间隔各自独立计时，撞在一起时按「密钥 → 用量」先后串行执行，不会丢轮。</li>
        <li>账号很多时建议把用量刷新间隔调大一些，全量拉取用量的请求量随账号数线性增长。</li>
        <li>手动批量操作进行中时定时任务会等待，操作结束后立即补跑到期的那一轮。</li>
        <li>窗口最小化到托盘、电脑睡眠唤醒后错过的轮次都会自动补跑，不需要重开窗口。</li>
        <li>
          主动续期只对 IDE 当前激活的那一个账号维护定时器，续期成功后写回磁盘并刷新界面；
          该账号一旦不再是 IDE 当前账号就自动停止，交给 IDE 自身兜底。
        </li>
      </ul>
    </a-card>

    <a-card size="small" title="API Key 刷新" style="margin-bottom: 16px">
      <a-form v-bind="FORM_LAYOUT">
        <a-form-item label="自动刷新用量" class="field-inline">
          <SettingSwitch field="autoRefreshApiKeyUsage" />
          <span class="muted">
            定期同步全部 API Key 的订阅类型与积分用量，默认开启
          </span>
        </a-form-item>
        <a-form-item label="用量刷新间隔" class="field-inline">
          <a-input-number
            :value="settings.apiKeyUsageRefreshInterval"
            :min="1"
            :max="600"
            :step="5"
            addon-after="分钟"
            style="width: 180px"
            :disabled="!settings.autoRefreshApiKeyUsage"
            @change="(v: unknown) => update({ apiKeyUsageRefreshInterval: Number(v) || DEFAULT_SETTINGS.apiKeyUsageRefreshInterval })"
          />
          <span class="muted">
            默认每 5 分钟同步一次
            <span class="next-refresh">{{ nextApiKeyUsageRefreshText }}</span>
          </span>
        </a-form-item>
        <a-form-item label="批量并发" class="field-inline">
          <a-input-number
            :value="settings.apiKeyRefreshConcurrency"
            :min="1"
            :max="20"
            style="width: 180px"
            @change="(v: unknown) => update({ apiKeyRefreshConcurrency: Number(v) || DEFAULT_SETTINGS.apiKeyRefreshConcurrency })"
          />
          <span class="muted">每批同时同步的 API Key 数量，并发过高容易被限流</span>
        </a-form-item>
        <a-form-item label="删除前确认" class="field-inline">
          <SettingSwitch field="confirmBeforeDeleteApiKey" />
          <span class="muted">删除 API Key 前弹出二次确认</span>
        </a-form-item>
      </a-form>
      <ul class="tips">
        <li>首次开启或距离上次同步已超过间隔时，会在应用启动后自动补跑一轮。</li>
        <li>窗口最小化到托盘、电脑睡眠唤醒后，错过的轮次会自动补跑。</li>
        <li>同步失败会保留上次成功的订阅与额度，仅更新错误状态。</li>
      </ul>
    </a-card>

    <a-card size="small" title="网络" style="margin-bottom: 16px">
      <a-form v-bind="FORM_LAYOUT">
        <a-form-item label="用量接口">
          <a-radio-group
            :value="settings.usageApiType"
            @change="(e: any) => update({ usageApiType: e.target.value })"
          >
            <a-radio value="rest">REST（q.*.amazonaws.com，推荐）</a-radio>
            <a-radio value="cbor">CBOR（app.kiro.dev 门户）</a-radio>
          </a-radio-group>
        </a-form-item>
        <a-form-item label="启用代理">
          <SettingSwitch field="proxyEnabled" />
        </a-form-item>
        <a-form-item label="代理地址">
          <a-input-group compact>
            <a-input
              v-model:value="proxyDraft"
              placeholder="http://127.0.0.1:7890"
              style="width: 300px"
            />
            <a-button type="primary" @click="saveProxy">保存</a-button>
          </a-input-group>
          <div class="muted" style="font-size: 12px">
            留空则回退到系统环境变量 HTTPS_PROXY / HTTP_PROXY
          </div>
        </a-form-item>
      </a-form>
    </a-card>

    <a-card size="small" title="内置浏览器" style="margin-bottom: 16px">
      <a-form v-bind="FORM_LAYOUT">
        <a-form-item label="浏览器地区" class="field-inline">
          <a-select
            :value="localeSelectValue"
            :options="localeSelectOptions"
            show-search
            :filter-option="filterLocaleOption"
            :get-popup-container="bodyPopupContainer"
            style="width: 260px"
            @change="(v: unknown) => onLocaleSelect(String(v))"
          />
          <span class="restart-hint">修改地区后需要重启应用才能完全生效</span>
        </a-form-item>
        <a-form-item v-if="localeCustomMode" label="自定义标签" class="field-inline">
          <a-input-group compact>
            <a-input
              v-model:value="localeDraft"
              placeholder="例如 zh-Hant-HK"
              style="width: 180px"
              @press-enter="savePortalLocale"
            />
            <a-button type="primary" @click="savePortalLocale">保存</a-button>
          </a-input-group>
          <span class="muted">当前生效：{{ portalLocale }}</span>
        </a-form-item>
      </a-form>
      <ul class="tips">
        <li>作用于应用内打开的所有网页（含「前往官网」及其弹出的窗口），决定 Accept-Language 与页面区域，影响显示的语言与价格币种。</li>
        <li>下拉支持搜索，可按地区名或语言标签筛选；选「自定义」后可填任意 BCP 47 标签。</li>
        <li>Accept-Language 保存后立即生效；页面内 navigator.language 由 Chromium 启动参数决定，需重启应用。</li>
        <li>不改变本应用自身的界面语言，也不影响账号所属的 AWS 区域。</li>
      </ul>
    </a-card>

    <a-card size="small" title="批量导入" style="margin-bottom: 16px">
      <a-form v-bind="FORM_LAYOUT">
        <a-form-item label="并发数" class="field-inline">
          <a-input-number
            :value="settings.importConcurrency"
            :min="1"
            :max="100"
            :step="5"
            style="width: 180px"
            @change="(v: unknown) => update({ importConcurrency: clampImportConcurrency(v) })"
          />
          <span class="muted">
            同时验证的账号数量，过大可能导致 API 限流
          </span>
        </a-form-item>
      </a-form>
      <ul class="tips">
        <li>建议范围 10-100。设置过大可能导致大量「验证失败」，设置过小则导入速度较慢。</li>
        <li>导入几千条时会按这个并发分批校验，不会一次性发起全部请求。</li>
        <li>与「账号刷新」里的批量并发相互独立，互不影响。</li>
      </ul>
    </a-card>

    <a-card size="small" title="系统托盘" style="margin-bottom: 16px">
      <a-form v-bind="FORM_LAYOUT">
        <a-form-item label="启用系统托盘" class="field-inline">
          <SettingSwitch field="trayEnabled" />
          <span class="muted">在系统托盘显示图标</span>
        </a-form-item>
        <a-form-item label="关闭按钮行为" class="field-inline">
          <a-select
            :value="closeAction"
            :options="closeActionOptions"
            :disabled="settings.trayEnabled === false"
            :get-popup-container="bodyPopupContainer"
            style="width: 180px"
            @change="(v: unknown) => update({ closeAction: v as AppSettings['closeAction'] })"
          />
          <span class="muted">点击关闭按钮时的行为</span>
        </a-form-item>
      </a-form>
      <ul class="tips">
        <li>双击托盘图标可以显示主窗口</li>
        <li>右键托盘图标可以显示菜单</li>
        <li>托盘菜单可以查看当前账户信息和用量</li>
      </ul>
    </a-card>

    <a-card size="small" title="数据管理" style="margin-bottom: 16px">
      <a-form v-bind="FORM_LAYOUT">
        <a-form-item label="数据目录">
          <PathMenu
            v-if="settingsStore.appInfo?.dataDir"
            :path="settingsStore.appInfo.dataDir"
            @reveal="openPath('store')"
          />
          <span v-else class="muted">-</span>
        </a-form-item>
        <a-form-item label="导入导出">
          <a-space wrap>
            <a-button :loading="exporting" @click="exportAll">
              <template #icon><DownloadOutlined /></template>
              导出数据
            </a-button>
            <a-button :loading="importing" @click="importAll">
              <template #icon><UploadOutlined /></template>
              导入数据
            </a-button>
            <a-button danger :loading="resetting" @click="resetAll">
              <template #icon><ReloadOutlined /></template>
              初始化
            </a-button>
          </a-space>
        </a-form-item>

      </a-form>
      <ul class="tips">
        <li>导出内容：{{ BACKUP_SCOPE }}。设置项、反代监听配置等不在其中。</li>
        <li>导出为明文 .json 文件，包含账号凭证与各类 API Key，请妥善保管，不要发给他人。</li>
        <li>导入只接受本应用导出的 .json 文件，替换本机对应的账号、API Key、用量记录与反代 API Key，其余数据保持不变；完成后应用自动重启。备份目录里的文件也可以直接导入。</li>
        <li>
          初始化会先还原本应用改过的外部配置（机器码、Kiro IDE 端点、自动同意 AI 操作、已写入的桌面 agent），
          再清掉全部数据、日志、历史记录和备份目录，和初次安装时一样，完成后应用自动重启。
        </li>
      </ul>
    </a-card>

    <a-card size="small" title="备份计划">
      <a-form v-bind="FORM_LAYOUT">
        <a-form-item label="备份计划" class="field-inline">
          <SettingSwitch field="backupEnabled" />
          <span class="muted">开启后按下面的周期静默备份，内容与「导出数据」完全一致</span>
        </a-form-item>
        <a-form-item label="执行周期">
          <div class="cycle-row">
            <a-select
              :value="cycle.type"
              :options="cycleOptions"
              :disabled="!settings.backupEnabled"
              :get-popup-container="bodyPopupContainer"
              style="width: 120px"
              @change="(v: unknown) => changeCycleType(v as BackupCycle['type'])"
            />
            <a-input-number
              v-if="cycleFields.n"
              :value="cycle.n"
              :min="nMin"
              :precision="0"
              :addon-after="nUnit"
              :disabled="!settings.backupEnabled"
              style="width: 150px"
              @change="(v: unknown) => updateCycle({ n: Number(v) || nMin })"
            />
            <a-select
              v-if="cycleFields.weekday"
              :value="cycle.weekday"
              :options="weekdayOptions"
              :disabled="!settings.backupEnabled"
              :get-popup-container="bodyPopupContainer"
              style="width: 100px"
              @change="(v: unknown) => updateCycle({ weekday: Number(v) })"
            />
            <a-select
              v-if="cycleFields.day"
              :value="cycle.day"
              :options="monthDayOptions"
              :disabled="!settings.backupEnabled"
              :get-popup-container="bodyPopupContainer"
              style="width: 100px"
              @change="(v: unknown) => updateCycle({ day: Number(v) })"
            />
            <a-input-number
              v-if="cycleFields.hour"
              :value="cycle.hour"
              :min="0"
              :max="23"
              :precision="0"
              addon-after="时"
              :disabled="!settings.backupEnabled"
              style="width: 130px"
              @change="(v: unknown) => updateCycle({ hour: Number(v) || 0 })"
            />
            <a-input-number
              v-if="cycleFields.minute"
              :value="cycle.minute"
              :min="0"
              :max="59"
              :precision="0"
              addon-after="分"
              :disabled="!settings.backupEnabled"
              style="width: 130px"
              @change="(v: unknown) => updateCycle({ minute: Number(v) || 0 })"
            />
          </div>
          <div class="choice-hint">
            {{ describeBackupCycle(cycle) }}
            <template v-if="settings.backupEnabled">· 下次执行 {{ backupNextText }}</template>
          </div>
        </a-form-item>
        <a-form-item label="保留份数" class="field-inline">
          <a-input-number
            :value="settings.backupKeep"
            :min="BACKUP_KEEP_MIN"
            :max="BACKUP_KEEP_MAX"
            :precision="0"
            addon-before="最新"
            addon-after="份"
            :disabled="!settings.backupEnabled"
            style="width: 180px"
            @change="(v: unknown) => update({ backupKeep: normalizeBackupKeep(v) })"
          />
          <span class="muted">超出的旧备份在下次备份后自动删除</span>
        </a-form-item>
        <a-form-item label="备份目录">
          <PathMenu
            v-if="settingsStore.appInfo?.backupDir"
            :path="settingsStore.appInfo.backupDir"
            @reveal="openPath('backup')"
          />
          <div class="choice-hint">
            上次备份：{{ backupLastText }} · 现有 {{ backupState?.count ?? 0 }} 份
            <span v-if="backupState?.lastError" class="restart-hint">（{{ backupState.lastError }}）</span>
          </div>
        </a-form-item>
        <a-form-item label=" " :colon="false">
          <a-space wrap>
            <a-button :loading="backingUp" @click="backupNow">
              <template #icon><CloudUploadOutlined /></template>
              立即备份
            </a-button>
            <a-button @click="openPath('backup')">
              <template #icon><FolderOpenOutlined /></template>
              打开备份目录
            </a-button>
          </a-space>
        </a-form-item>
      </a-form>
      <ul class="tips">
        <li>备份文件与「导出数据」完全一致（明文 .json），同样包含凭证，请妥善保管。</li>
        <li>应用没开或电脑睡眠时错过的备份，下次启动或唤醒后补一次，不按错过的次数重复补。</li>
      </ul>
    </a-card>

  </div>
</template>

<style scoped>
/*
 * 主题风格 / 主题色的选项卡：图标或色块在上、名称在下。
 * 选中项描边与文字换成主题色，右上角一个实心圆点；未选中的悬停时描边提亮。
 */
.choice-group {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.choice-card {
  position: relative;
  display: inline-flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  width: 76px;
  height: 72px;
  padding: 0;
  /* --kal-border 只有 8% 不透明度，做卡片轮廓太淡，按正文色调一档 */
  border: 1.5px solid color-mix(in srgb, currentColor 16%, transparent);
  border-radius: 10px;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
  transition: border-color 0.15s, color 0.15s;
}

.choice-card:hover {
  border-color: color-mix(in srgb, var(--kal-primary) 50%, transparent);
}

.choice-card:focus-visible {
  outline: 2px solid var(--kal-primary);
  outline-offset: 2px;
}

.choice-card.selected {
  border-color: var(--kal-primary);
  color: var(--kal-primary);
}

.choice-card.selected::after {
  content: '';
  position: absolute;
  top: 6px;
  right: 6px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--kal-primary);
}

.choice-label {
  font-size: 13px;
  line-height: 1;
}

.choice-card.selected .choice-label {
  font-weight: 600;
}

.swatch {
  width: 30px;
  height: 18px;
  border-radius: 5px;
}

/* 执行周期：类型下拉 + 按类型出现的几个输入框，一行排开、放不下再换行 */
.cycle-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}


.choice-hint {
  margin-top: 8px;
  font-size: 12px;
  color: var(--kal-muted);
}

/*
 * 控件与右侧说明文字默认按基线对齐，说明文字会偏下。
 * 用 flex 居中，让两者垂直对齐。
 */
.field-inline :deep(.ant-form-item-control-input-content) {
  display: flex;
  align-items: center;
}

/* 说明文字与控件间距统一，且可换行、不挤压前面的控件 */
.field-inline :deep(.ant-form-item-control-input-content) > .muted,
.field-inline :deep(.ant-form-item-control-input-content) > .restart-hint {
  min-width: 0;
  margin-left: 10px;
}

/* 需要重启才完全生效的设置，用红色把代价说在前面 */
.restart-hint {
  color: #ff4d4f;
  font-size: 12px;
  line-height: 1.6;
}

/* 下次刷新时间单独占一行，跟在说明文字下方 */
.next-refresh {
  display: block;
  margin-top: 2px;
  font-size: 12px;
}

/* 卡片底部的补充说明 */
.tips {
  margin: 0;
  padding: 10px 12px 10px 26px;
  border-radius: 8px;
  background: var(--kal-block-bg);
  color: var(--kal-muted);
  font-size: 12px;
  line-height: 1.9;
}
</style>
