<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { message } from 'ant-design-vue'
import {
  ClearOutlined,
  CloudServerOutlined,
  CopyOutlined,
  DeleteOutlined,
  DownOutlined,
  ExclamationCircleFilled,
  GlobalOutlined,
  PlayCircleOutlined,
  PoweroffOutlined,
  ReloadOutlined,
  RollbackOutlined,
  ThunderboltOutlined,
  UpOutlined
} from '@ant-design/icons-vue'
import { useProxyStore } from '@/stores/proxy'
import { useAccountsStore } from '@/stores/accounts'
import { useSettingsStore } from '@/stores/settings'
import { useKeysStore } from '@/stores/keys'
import { confirmDanger, copyText } from '@/utils/ui'
import { displayEmail, displayKey, maskKey } from '@/utils/display'
import { formatCheckedAt, formatCredits, formatLogTime, maskEmail } from '@/utils/format'
import { withDefaultEffort, type CascaderModel } from '@/utils/models'
import ModelCascader from '@/components/common/ModelCascader.vue'
import ClientIcon from '@/components/proxy/ClientIcon.vue'
import PathMenu from '@/components/common/PathMenu.vue'
import ProxyKeysModal from '@/components/proxy/ProxyKeysModal.vue'
import ProxyEndpointsModal from '@/components/proxy/ProxyEndpointsModal.vue'
import { PAYLOAD_LIMIT_MAX_KB, PAYLOAD_LIMIT_MIN_KB } from '@shared/types'
import { FALLBACK_MODEL_IDS } from '@shared/proxyModels'
import type {
  ProxyClientTarget,
  ProxyConfig,
  ProxyInputType,
  ProxyLogEntry,
  ProxyOutputType
} from '@shared/types'

const store = useProxyStore()
const accountsStore = useAccountsStore()
const settingsStore = useSettingsStore()
const keysStore = useKeysStore()

const privacy = computed(() => settingsStore.settings.privacyMode)
/**
 * 卡片标题栏的按钮组跟随设置里的控件尺寸，口径与两个列表页的工具栏一致
 * （默认尺寸用 small，大尺寸用 middle）；参数里的选择器不写 size，直接跟随全局尺寸。
 */
const toolbarSize = computed(() => settingsStore.toolbarSize)
const config = computed(() => store.config)

/*
 * 风险细则的展开 / 收起。
 * 记在 localStorage：只是一个界面偏好，不值得进主进程的配置；
 * 不记的话每次进页面都得再点一次收起。首次默认展开——没看过的人必须先看到。
 */
const RISK_OPEN_KEY = 'proxy.riskOpen'
const riskOpen = ref(localStorage.getItem(RISK_OPEN_KEY) !== '0')

function toggleRisk(): void {
  riskOpen.value = !riskOpen.value
  localStorage.setItem(RISK_OPEN_KEY, riskOpen.value ? '1' : '0')
}

/** 账号下拉：打码跟随全局隐私开关 */
const accountOptions = computed(() =>
  accountsStore.accounts.map((account) => ({
    value: account.id,
    label: `${displayEmail(account.email, privacy.value)}${account.nickname ? ` · ${account.nickname}` : ''}`,
    disabled: account.status === 'banned'
  }))
)

/**
 * 模型选择：与账号测活同一个级联选择器，一级模型、二级推理档位。
 * 模型与档位都来自「刷新模型」拉回的真实列表（档位是每个模型自己的 schema），
 * 还没拉过时用兜底表，那时没有档位这一层。
 */
const cascaderModels = computed<CascaderModel[]>(() => {
  const list = store.models?.models ?? FALLBACK_MODEL_IDS.map((modelId) => ({ modelId }))
  const models: CascaderModel[] = list.map((model) => ({
    id: model.modelId,
    name: 'modelName' in model ? model.modelName : undefined,
    rate: 'rate' in model ? model.rate : undefined,
    effort: 'effort' in model ? model.effort : undefined
  }))
  // 当前选中的模型不在新列表里（换了账号或上游下架）：保留一项，免得选择器显示成空白
  if (!models.some((m) => m.id === config.value.defaultModel)) {
    models.push({ id: config.value.defaultModel, name: `${config.value.defaultModel}（当前账号不可用）` })
  }
  return models
})

const modelSelection = computed(() =>
  config.value.defaultEffort
    ? [config.value.defaultModel, config.value.defaultEffort]
    : [config.value.defaultModel]
)

/** 选中模型的档位 schema，用于说明文字 */
const selectedEffort = computed(
  () => cascaderModels.value.find((m) => m.id === config.value.defaultModel)?.effort
)

function onModelChange(path: string[]): void {
  const [defaultModel, defaultEffort = ''] = path
  if (!defaultModel) return
  void patch({ defaultModel, defaultEffort })
}

/**
 * 刷新模型后校正档位：新 schema 里不再有这个档位时回落到默认档位，
 * 否则界面显示的档位与实际发出去的对不上（反代会就近取值，但用户看不出来）。
 */
watch(
  () => store.models?.fetchedAt,
  () => {
    const effort = selectedEffort.value
    const current = config.value.defaultEffort
    if (!effort?.options.length) {
      if (current) void patch({ defaultEffort: '' })
      return
    }
    if (current && effort.options.includes(current)) return
    const next = withDefaultEffort(cascaderModels.value, [config.value.defaultModel])
    if ((next[1] ?? '') !== current) void patch({ defaultEffort: next[1] ?? '' })
  }
)

/**
 * 模型列表来自哪个账号、什么时候拉的。
 * 来源邮箱一律打码（不看隐私开关）：这行说明文字常被截图，点一下即可复制明文。
 * 来源是 API Key 时这里可能是备注或已打码的 Key，不是邮箱就原样显示。
 */
const modelSource = computed(() => {
  const cache = store.models
  if (!cache) return null
  const owner = cache.accountEmail
  return {
    count: cache.models.length,
    owner,
    isEmail: owner.includes('@'),
    ownerText: owner.includes('@') ? maskEmail(owner) : owner,
    at: formatCheckedAt(cache.fetchedAt, Date.now())
  }
})

/** 当前来源的叫法，界面文案统一用它 */
const sourceNoun = computed(() => (config.value.accountSource === 'apiKey' ? 'API Key' : '账号'))

/** Key 下拉的展示名：绑定邮箱 > 备注 > Key 本身，打码都跟随隐私开关 */
function keyOptionLabel(entry: { key: string; note?: string; email?: string }): string {
  const key = displayKey(entry.key, privacy.value)
  if (entry.email) return `${displayEmail(entry.email, privacy.value)} · ${key}`
  return entry.note ? `${entry.note} · ${key}` : key
}

/** 指定账号 / 指定 Key 的候选 */
const memberOptions = computed(() =>
  config.value.accountSource === 'apiKey'
    ? keysStore.data.keys.map((entry) => ({ value: entry.id, label: keyOptionLabel(entry) }))
    : accountOptions.value
)

/**
 * 指定分组的候选：账号与 Key 各有一套分组，名字后面带上成员数。
 * 分组数量与成员都直接取自两个 store，在账号管理 / API Key 页增删成员、改分组时这里跟着变；
 * 反代每个请求都现读主进程里的分组成员，所以选中的分组不用重新保存就会按新成员轮询。
 */
const groupOptions = computed(() => {
  const apiKey = config.value.accountSource === 'apiKey'
  const groups = apiKey ? keysStore.groups : accountsStore.groups
  const counts = apiKey ? keysStore.groupCounts : accountsStore.groupCounts
  return groups.map((group) => ({
    value: group.id,
    label: `${group.name}（${counts[group.id] ?? 0}）`
  }))
})

/** 当前来源下还存在的分组 / 成员 id，用来滤掉已被删除的 */
const liveGroupIds = computed(
  () => new Set((config.value.accountSource === 'apiKey' ? keysStore.groups : accountsStore.groups).map((g) => g.id))
)
const liveMemberIds = computed(
  () =>
    new Set(
      (config.value.accountSource === 'apiKey' ? keysStore.data.keys : accountsStore.accounts).map((m) => m.id)
    )
)

/**
 * 两个来源的选择分开存，切换来源时互不覆盖。
 * 已被删除的分组 / 账号不显示：否则下拉框里会出现一串认不出的 id。
 */
const selectedGroupIds = computed(() =>
  (config.value.accountSource === 'apiKey' ? config.value.keyGroupIds : config.value.groupIds).filter((id) =>
    liveGroupIds.value.has(id)
  )
)
const selectedMemberIds = computed(() =>
  (config.value.accountSource === 'apiKey' ? config.value.keyIds : config.value.accountIds).filter((id) =>
    liveMemberIds.value.has(id)
  )
)

/*
 * 分组或账号在别的页面被删了，就把它从反代配置里摘掉，配置与界面保持一致。
 * 只在两个 store 都已加载出数据时做，避免启动瞬间列表还是空的就把选择全清掉。
 */
watch(
  [selectedGroupIds, selectedMemberIds],
  () => {
    const apiKey = config.value.accountSource === 'apiKey'
    const loaded = apiKey ? keysStore.data.keys.length > 0 : accountsStore.accounts.length > 0
    if (!loaded) return
    const rawGroups = apiKey ? config.value.keyGroupIds : config.value.groupIds
    const rawMembers = apiKey ? config.value.keyIds : config.value.accountIds
    const next: Partial<ProxyConfig> = {}
    if (rawGroups.length !== selectedGroupIds.value.length) Object.assign(next, groupPatch(selectedGroupIds.value))
    if (rawMembers.length !== selectedMemberIds.value.length) Object.assign(next, memberPatch(selectedMemberIds.value))
    if (Object.keys(next).length) void patch(next)
  },
  // 进页面时也检查一次：上次关应用前删掉的分组，这里要一并清理
  { immediate: true }
)

function groupPatch(ids: string[]): Partial<ProxyConfig> {
  return config.value.accountSource === 'apiKey' ? { keyGroupIds: ids } : { groupIds: ids }
}

function memberPatch(ids: string[]): Partial<ProxyConfig> {
  return config.value.accountSource === 'apiKey' ? { keyIds: ids } : { accountIds: ids }
}

/**
 * 当前策略圈定的账号 / Key id，与主进程 poolMembers 的范围口径一致
 * （状态过滤只在主进程做，这里只用来显示数量、判断模型列表是否要重拉）。
 */
const scopeIds = computed<string[]>(() => {
  const apiKey = config.value.accountSource === 'apiKey'
  const items: { id: string; groupId?: string }[] = apiKey ? keysStore.data.keys : accountsStore.accounts
  if (config.value.accountMode === 'group') {
    const groups = new Set(selectedGroupIds.value)
    return items.filter((item) => !!item.groupId && groups.has(item.groupId)).map((item) => item.id)
  }
  if (config.value.accountMode === 'selected') {
    const ids = new Set(selectedMemberIds.value)
    return items.filter((item) => ids.has(item.id)).map((item) => item.id)
  }
  return items.map((item) => item.id)
})

const scopeCount = computed(() => scopeIds.value.length)

/**
 * 改了来源 / 策略 / 选择后，模型列表不是来自当前范围里的号就自动重拉：
 * 不同订阅档位能用的模型不一样，继续用旧列表会让下拉里出现当前号根本调不了的模型。
 */
async function changePool(next: Partial<ProxyConfig>): Promise<void> {
  await patch(next)
  const cache = store.models
  if (!scopeIds.value.length) return
  if (!cache || !scopeIds.value.includes(cache.accountId)) await store.refreshModels(true)
}

/**
 * 客户端元信息。
 *
 * 只留名字和官网：想了解这个 agent 的人直接去官网看，
 * 改哪些文件在详情弹窗的「配置文件」里一目了然，不用再配一段说明。
 */
const clientMeta: Record<ProxyClientTarget, { name: string; site: string }> = {
  claudeCode: {
    name: 'Claude Code CLI',
    site: 'https://claude.com/product/claude-code'
  },
  codex: {
    name: 'Codex CLI',
    site: 'https://developers.openai.com/codex/cli'
  },
  codexApp: {
    name: 'Codex 桌面版',
    site: 'https://developers.openai.com/codex'
  },
  claudeApp: {
    name: 'Claude 桌面版',
    site: 'https://claude.ai/download'
  },
  vscode: {
    name: 'VS Code',
    site: 'https://code.visualstudio.com'
  },
  deepseek: {
    name: 'DeepSeek Harness Web',
    // Web 版就是开源仓库里的 dsh，安装和用法都在 README 里
    site: 'https://github.com/deepseek-ai/deepseek-harness'
  },
  deepseekApp: {
    name: 'DeepSeek Harness 桌面版',
    site: 'https://deepseek.com/harness'
  },
  workbuddy: {
    name: 'WorkBuddy',
    site: 'https://cloud.tencent.com/act/pro/workbuddy'
  },
  cursor: {
    name: 'Cursor',
    site: 'https://cursor.com'
  }
}

/** 官网链接展示成去掉协议的短域名，卡片上不占地方 */
function siteLabel(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\/$/, '')
}

function openSite(url: string): void {
  void window.api.openExternal(url)
}

/**
 * 每个目标的「重启才生效」提示。
 * 三个客户端都只在启动时读一次配置，桌面版还得完全退出（Cmd+Q / 托盘退出）才会重读。
 */
/** 一句话说明重启的必要性，不铺开讲原理 */
const RESTART_HINTS: Record<ProxyClientTarget, string> = {
  claudeCode: '退出当前会话后重新运行 claude 即可生效。',
  codex: '退出当前 codex 会话后重新启动即可生效。',
  codexApp: '配置只在启动时读取，需要完全退出后重新打开。',
  cursor: '配置只在启动时读取，需要完全退出后重新打开。',
  claudeApp: '3P 配置只在启动时读取，需要完全退出后重新打开。',
  vscode: '在 Chat 的模型选择器里选带 Kiro 前缀的模型即可；没出现就重启一下 VS Code。',
  deepseek: '用下面这条命令启动 dsh 即可生效。',
  deepseekApp: '桌面版会自动热重载这份配置，一般无需重启；没生效再用下面的按钮重启。',
  workbuddy: 'WorkBuddy 会自动重新加载，在模型选择器里选带 Kiro 前缀的模型即可；没出现就重启一下。'
}

// ============ 配置保存 ============
const saving = ref('')

async function patch(next: Record<string, unknown>, tip?: string): Promise<void> {
  const key = Object.keys(next)[0] ?? ''
  saving.value = key
  try {
    if (await store.save(next as never)) {
      if (tip) message.success(tip)
      await store.loadClients()
    }
  } finally {
    saving.value = ''
  }
}

// ============ 监听地址与端口 ============
//
// 监听地址只有两种有意义的取值：127.0.0.1（只有本机能连）和 0.0.0.0（局域网也能连），
// 对应配置里的 allowLan。给个自由输入框反而容易填出一个本机根本没有的网卡地址，
// 服务起不来还不好查，所以用单选。

const listenOpen = ref(false)
const listenHost = ref<'127.0.0.1' | '0.0.0.0'>('127.0.0.1')
const listenPort = ref<number | null>(null)
const listenSaving = ref(false)

function openListen(): void {
  listenHost.value = config.value.allowLan ? '0.0.0.0' : '127.0.0.1'
  listenPort.value = config.value.port
  listenOpen.value = true
}

/** 改端口后已写入各客户端的地址会失效，界面要提醒重新写入 */
const listenPortChanged = computed(
  () => listenPort.value !== null && listenPort.value !== config.value.port
)

async function saveListen(): Promise<void> {
  // 清空输入框时 a-input-number 给 null，不能照单全收变成 0
  const raw = listenPort.value
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return void message.warning('请填写端口')
  }
  const port = Math.min(65535, Math.max(1024, Math.round(raw)))
  const allowLan = listenHost.value === '0.0.0.0'
  if (port === config.value.port && allowLan === config.value.allowLan) {
    listenOpen.value = false
    return
  }
  listenSaving.value = true
  try {
    // 主进程的 applyProxyConfig 会判断端口 / 监听范围变了就重启服务
    const ok = await store.save({ port, allowLan })
    if (!ok) return
    listenOpen.value = false
    await store.loadClients()
    message.success(store.running ? '已保存，服务已按新地址重启' : '已保存')
  } finally {
    listenSaving.value = false
  }
}

// ============ API Key ============

const regenerating = ref(false)
/**
 * 默认打码（保留首尾几位，能认出是哪个 Key），点小眼睛才显示完整值；
 * 只影响页面显示，复制按钮始终复制完整 Key。不记忆，每次进页面都回到打码，免得截图时露出来。
 */
const keyRevealed = ref(false)
const keysOpen = ref(false)
const endpointsOpen = ref(false)
/** 自定义 Key 的数量，显示在默认 Key 旁边提醒用户还有别的 */
const extraKeyCount = ref(0)

async function loadKeyCount(): Promise<void> {
  const res = await window.api.listProxyKeys()
  if (res.success && res.data) extraKeyCount.value = res.data.filter((k) => !k.isDefault).length
}

async function doRegenerate(): Promise<void> {
  regenerating.value = true
  try {
    const res = await window.api.regenerateProxyDefaultKey()
    if (!res.success || !res.data) return void message.error(res.error || '生成失败')
    store.config = res.data.config
    store.status = res.data.status
    message.success('API Key 已重新生成')
    // 已写入的客户端里还是旧 Key，卡片状态会变成「未配置」，要刷一下
    await store.loadClients()
  } finally {
    regenerating.value = false
  }
}

/**
 * 重新生成默认 Key。
 * 已经一键写入过的客户端里存的是旧 Key，换掉之后它们全都会 401，
 * 所以有旧 Key 时要先确认；第一次生成（还没有 Key）直接做。
 */
function regenerateKey(): void {
  if (!config.value.apiKey) return void doRegenerate()
  const applied = store.clients.filter((c) => c.applied).map((c) => clientMeta[c.target].name)
  confirmDanger({
    title: '重新生成 API Key？',
    content: applied.length
      ? `旧 Key 会立即失效。${applied.join('、')} 里写的是旧 Key，生成后需要对它们重新「一键写入」。`
      : '旧 Key 会立即失效，用它连接的客户端需要换成新 Key。',
    okText: '重新生成',
    onOk: doRegenerate
  })
}

/** Key 管理弹窗里增删了 Key：刷新计数，有 Key 被删也可能影响客户端状态 */
function onKeysChanged(): void {
  void loadKeyCount()
}

/*
 * 每次手动启动都要先确认一遍风险：页面顶部的风险提示可以收起，看过一次的人很容易忘，
 * 而一旦启动，账号额度和客户端发来的数据就都走这条链路了。
 * 应用启动时的「自动启动」在主进程里直接起，不经过这里，也就不弹这个框。
 */
const startConfirmOpen = ref(false)

function requestStart(): void {
  startConfirmOpen.value = true
}

async function confirmStart(): Promise<void> {
  startConfirmOpen.value = false
  await store.start()
}

function stopProxy(): void {
  void store.stop()
}

// ============ 客户端接入 ============

/**
 * 写入 / 还原之后的「重启客户端」引导。
 *
 * 这两个客户端都只在启动时读一次配置文件，已经开着的会话不会跟着变，
 * 所以完成后必须明确告诉用户去重启，而不是只弹一句 toast 就完事。
 */
interface ClientPrompt {
  target: ProxyClientTarget
  action: 'apply' | 'restore'
  /**
   * confirm：先说清楚要改什么，等用户点确认；
   * running：正在写入（可能要装 CCursor，耗时较长）；
   * done / failed：已有结果。
   */
  stage: 'confirm' | 'running' | 'done' | 'failed'
  command?: string
  warning?: string
  error?: string
}
const clientPrompt = ref<ClientPrompt | null>(null)

/**
 * 写入过程的实时日志。
 * Cursor 首次写入要下载安装 CCursor（33MB + 给 Cursor 的大文件打补丁），
 * 要一两分钟，不显示进度用户会以为卡死了。
 */
const applyProgress = ref<{ target: ProxyClientTarget; lines: string[] } | null>(null)
let stopProgress: (() => void) | null = null

onMounted(() => {
  stopProgress = window.api.onProxyClientProgress(({ target, line }) => {
    if (!applyProgress.value || applyProgress.value.target !== target) {
      applyProgress.value = { target, lines: [] }
    }
    // 只留最近 200 行，安装日志很长
    const lines = applyProgress.value.lines
    lines.push(line)
    if (lines.length > 200) lines.splice(0, lines.length - 200)
  })
})

onUnmounted(() => stopProgress?.())

const promptTitle = computed(() => {
  const prompt = clientPrompt.value
  if (!prompt) return ''
  const name = clientMeta[prompt.target].name
  const verb = prompt.action === 'apply' ? '写入' : '还原'
  if (prompt.stage === 'confirm') return `${verb} ${name} 配置`
  if (prompt.stage === 'running') return `正在${verb} ${name} 配置`
  return `${name} 配置${verb}${prompt.stage === 'failed' ? '失败' : '完成'}`
})

/** Cursor 卡片：CCursor 已就绪（已写入过就说明装好了）时不再提示安装耗时 */
const cursorReady = computed(
  () => !store.clients.find((c) => c.target === 'cursor')?.warning
)

/**
 * 确认这一步要讲清楚的事：改哪些文件、能不能撤销、有没有额外副作用。
 * 只说会影响用户决定的，不铺开讲原理。
 */
const confirmLines = computed<string[]>(() => {
  const prompt = clientPrompt.value
  if (!prompt) return []
  const name = clientMeta[prompt.target].name

  if (prompt.action === 'restore') {
    const lines = [`把 ${name} 的配置恢复成写入前的样子，本应用写入的内容将被撤销。`]
    if (prompt.target === 'codexApp') {
      lines.push('桌面版如果开着，会先让它退出，还原完可以在最后一步启回来。')
    }
    if (prompt.target === 'cursor') {
      lines.push('移除 Cursor++ 里的 Kiro provider 并关闭 BYOK 模式，Cursor 回到官方后端。CCursor 补丁保留，下次写入无需重装；要彻底卸载可在终端运行 npx @cometix/ccursor uninstall。')
    }
    return lines
  }

  const lines = [`修改 ${name} 的本地配置文件，原文会完整备份，随时可以还原。`]
  // 桌面版没有 profile 机制，只能改全局默认；而且运行时它会回写配置，必须先退出
  if (prompt.target === 'codexApp') {
    lines.push(
      '桌面版只认全局默认 provider，所以会改 ~/.codex/config.toml 的 model / model_provider，不带 --profile 的 codex 命令也会跟着走反代。'
    )
    lines.push('它运行时会自己回写这个文件，所以会先让它退出。')
  }
  // Cursor 首次写入会联网装 CCursor 并给 Cursor 的内核文件打补丁，这事得提前讲清楚
  if (prompt.target === 'cursor' && !cursorReady.value) {
    lines.push(
      '首次写入会自动下载安装 CCursor（约 33MB，需要 Node.js 与网络），它会给 Cursor 的程序文件打补丁以支持自定义模型。「还原」只关闭 BYOK、不卸补丁，下次写入就不用再装。约需一两分钟。'
    )
  }
  if (prompt.target === 'claudeApp') {
    lines.push('打开 Claude 桌面版的 3P 模式，推理端点从 api.anthropic.com 换成本地反代。')
  }
  if (prompt.target === 'vscode') {
    lines.push('在 chatLanguageModels.json 里加一组「Kiro Manager Lite」自定义端点，你已有的其它分组原样保留。')
    lines.push('API Key 一并写好，不用再去「管理语言模型」里手动填。')
  }
  // 桌面版和命令行版是两份互不相干的 profile，这点不说清楚用户会以为写一次就都通了
  if (prompt.target === 'deepseekApp') {
    lines.push('桌面版读的是它自己的 desktop profile，和命令行版不共享，需要单独写一次。')
    lines.push('同时把默认模型指到 Kiro，否则它仍走内置路由、发消息会报缺少 API Key。')
    lines.push('这份文件桌面版会热重载，通常不用重启。')
  }
  if (prompt.target === 'workbuddy') {
    lines.push('在 models.json 里加入 Kiro 模型（带 API Key），你在设置页加的自定义模型原样保留。')
  }
  return lines
})

/**
 * 客户端详情弹窗。
 * 列表卡片只放图标、名字、官网，配置文件路径与写入/还原/启动按钮都收进这里，
 * 免得八个客户端把整页撑成一堵字墙。
 */
const clientDetail = ref<ProxyClientTarget | null>(null)

const detailState = computed(() => {
  const target = clientDetail.value
  if (!target) return null
  return store.clients.find((c) => c.target === target) ?? null
})

/** 开弹窗，停在确认这一步；真正的写入由 runClientAction 触发 */
function applyClient(target: ProxyClientTarget): void {
  if (!config.value.apiKey.trim()) {
    return void message.warning('请先生成 API Key，客户端要靠它连上反代')
  }
  clientDetail.value = null
  clientPrompt.value = { target, action: 'apply', stage: 'confirm' }
}

function restoreClient(target: ProxyClientTarget): void {
  clientDetail.value = null
  clientPrompt.value = { target, action: 'restore', stage: 'confirm' }
}

/**
 * 执行写入 / 还原。
 * 过程与结果都留在同一个弹窗里：Cursor 首次要装 CCursor，
 * 一两分钟的等待必须有进度，结果也不该飘一下就没。
 */
async function runClientAction(): Promise<void> {
  const prompt = clientPrompt.value
  if (!prompt) return
  const { target, action } = prompt

  applyProgress.value = { target, lines: [] }
  clientPrompt.value = { target, action, stage: 'running' }

  const { state, error } =
    action === 'apply' ? await store.applyClient(target) : await store.restoreClient(target)

  clientPrompt.value = {
    target,
    action,
    stage: error ? 'failed' : 'done',
    command: action === 'apply' ? state?.command : undefined,
    warning: state?.warning,
    error
  }
}

/**
 * 客户端分两组展示。
 *
 * Codex / Claude 的命令行版与桌面版是两件不同的事：前者各自读自己的配置文件，
 * 后者只认全局默认或专门的 3P 配置。混在一堆里用户会以为写一个另一个也跟着走反代，
 * 所以按运行形态分组，各自独立写入 / 还原。
 */
const clientGroups = computed(() => {
  const groups: { title: string; hint: string; targets: ProxyClientTarget[] }[] = [
    {
      title: '命令行 Agent',
      hint: '终端运行',
      targets: ['claudeCode', 'codex', 'deepseek']
    },
    {
      title: '桌面应用',
      hint: '可视化图形界面客户端',
      targets: [
        'claudeApp',
        'codexApp',
        'deepseekApp',
        'cursor',
        'vscode',
        'workbuddy'
      ]
    }
  ]
  return groups
    .map((group) => ({
      ...group,
      /*
       * 按 targets 的顺序排，而不是主进程返回的顺序：
       * 只 filter 的话卡片顺序取决于主进程列表，这里改 targets 顺序不会生效。
       */
      items: group.targets
        .map((target) => store.clients.find((item) => item.target === target))
        .filter((item): item is NonNullable<typeof item> => !!item)
    }))
    .filter((group) => group.items.length)
})

/**
 * 代为打开 / 重启客户端。
 * 图形界面的由主进程退出再拉起，命令行的开一个新终端窗口跑对应命令。
 */
const launching = ref(false)

async function openClient(target: ProxyClientTarget): Promise<void> {
  launching.value = true
  try {
    const res = await window.api.openProxyClient(target)
    if (res.success) {
      message.success(`${clientMeta[target].name} 已启动`)
      clientPrompt.value = null
      clientDetail.value = null
    } else {
      message.error(res.error || '启动失败')
    }
  } finally {
    launching.value = false
  }
}

/** 能由本应用代为启动的客户端；dsh 命令行只写配置 */
const OPENABLE: ProxyClientTarget[] = [
  'vscode',
  'claudeCode',
  'codex',
  'claudeApp',
  'codexApp',
  'cursor',
  'deepseekApp',
  'workbuddy'
]

/**
 * 按钮文案。
 * 图形界面客户端能探测进程，据此说「重启」还是「打开」；
 * 命令行客户端没有常驻进程，一律是「打开终端」。
 */
function openVerb(target: ProxyClientTarget): string {
  if (target === 'claudeCode' || target === 'codex') return '打开终端运行'
  const state = store.clients.find((c) => c.target === target)
  return state?.appRunning ? '重启' : '打开'
}

/** 确认这一步展示的文件列表，比一句「本地配置文件」具体 */
const promptPaths = computed(() => {
  const target = clientPrompt.value?.target
  if (!target) return []
  return store.clients.find((c) => c.target === target)?.paths ?? []
})

/** 步骤条：确认 → 执行 → 完成 */
const promptStep = computed(() => {
  const stage = clientPrompt.value?.stage
  if (stage === 'confirm') return 0
  if (stage === 'running') return 1
  return 2
})

/** 弹窗底部按钮：只在写入/还原成功后出现 */
const promptApp = computed(() => {
  const prompt = clientPrompt.value
  if (!prompt || prompt.stage !== 'done') return null
  const target = prompt.target
  if (!OPENABLE.includes(target)) return null
  return { verb: `${openVerb(target)} ${clientMeta[target].name}`, target }
})

/**
 * 手动指定安装位置。选择框由主进程弹出并校验（选错了应用会直接报错、不保存），
 * 这里只负责把刷新后的状态放回 store；用户点取消时 data 为 null，不提示。
 */
async function pickInstallPath(target: ProxyClientTarget): Promise<void> {
  const res = await window.api.pickProxyClientPath(target)
  if (!res.success) return void message.error(res.error || '设置失败')
  if (!res.data) return
  store.clients = res.data
  message.success(`已设置 ${clientMeta[target].name} 的安装位置`)
}

const rechecking = ref(false)

async function recheckInstall(): Promise<void> {
  const target = clientDetail.value
  if (!target) return
  rechecking.value = true
  try {
    await store.loadClients(true)
    const installed = store.clients.find((c) => c.target === target)?.installed
    if (installed) message.success(`已检测到 ${clientMeta[target].name}`)
    else message.warning(`仍未检测到 ${clientMeta[target].name}，装在其它位置可手动设置`)
  } finally {
    rechecking.value = false
  }
}

async function clearInstallPath(target: ProxyClientTarget): Promise<void> {
  const res = await window.api.clearProxyClientPath(target)
  if (!res.success || !res.data) return void message.error(res.error || '操作失败')
  store.clients = res.data
  message.success('已恢复自动检测')
}

async function revealPath(target: ProxyClientTarget, index: number): Promise<void> {
  const res = await window.api.revealProxyClientFile(target, index)
  if (!res.success) message.error(res.error || '打开目录失败')
}

// ============ 日志 ============
const logDetail = ref<ProxyLogEntry | null>(null)

const stateMeta: Record<ProxyLogEntry['state'], { color: string; text: string }> = {
  pending: { color: 'default', text: '排队' },
  streaming: { color: 'processing', text: '输出中' },
  success: { color: 'success', text: '成功' },
  error: { color: 'error', text: '失败' }
}

function accountLabel(entry: ProxyLogEntry): string {
  if (!entry.accountEmail) return '-'
  return displayEmail(entry.accountEmail, privacy.value)
}

/** a-table 的 bodyCell 给的 record 是 any，绕一层函数把类型接回来 */
function logState(entry: ProxyLogEntry): { color: string; text: string } {
  return stateMeta[entry.state]
}

/**
 * 日志表列。
 * 输入 / 输出只写类型（文本、图片、工具调用……），不放内容预览：
 * 内容会把行撑得参差不齐，而且客户端发来的是源码、密钥这类东西，
 * 主进程那边也不采集输出内容。token 数放进详情里。
 */
/*
 * 表格的这几个配置提成常量：写在模板里每次渲染都会生成新对象 / 新函数，
 * 流式期间日志每 150ms 刷一次，a-table 会把它们当成 props 变化重新处理一遍。
 */
const LOG_PAGINATION = { pageSize: 20, size: 'small', showSizeChanger: false, hideOnSinglePage: true } as const
const LOG_SCROLL = { x: 1184, y: 420 }
function logRowProps(record: ProxyLogEntry): { onClick: () => void } {
  return { onClick: () => (logDetail.value = record) }
}
function logRowClass(record: ProxyLogEntry): string {
  return `log-tr ${record.state}`
}

const logColumns = [
  // 时间是 MM-DD HH:mm:ss.SSS 共 18 个等宽字符，约 130px 加单元格内边距，窄了会被截成省略号
  { title: '时间', key: 'at', width: 160 },
  { title: '状态', key: 'state', width: 78 },
  { title: '协议', key: 'kind', width: 132 },
  { title: '模型', key: 'model', width: 210, ellipsis: true },
  { title: '账号', key: 'account', width: 168, ellipsis: true },
  { title: '输入 Tokens', key: 'inputTokens', width: 110, align: 'right' as const },
  { title: '输出 Tokens', key: 'outputTokens', width: 110, align: 'right' as const },
  { title: '耗时', key: 'duration', width: 132 },
  { title: '积分', key: 'credits', width: 84 }
]

const INPUT_LABEL: Record<ProxyInputType, string> = {
  text: '文本',
  image: '图片',
  toolResult: '工具结果'
}

const OUTPUT_LABEL: Record<ProxyOutputType, string> = {
  text: '文本',
  thinking: '推理',
  toolUse: '工具调用',
  webSearch: '联网搜索'
}

/**
 * 日志里的 token 数。
 * 输出 token 要等请求结束才算得出来，还在进行中的显示省略号而不是 0，免得像是「没有输出」。
 * 数字加千分位：几十万的输入 token 在一排数字里才分得清量级。
 */
function tokenCell(entry: ProxyLogEntry, field: 'inputTokens' | 'outputTokens'): string {
  const value = entry[field]
  if (value == null) return entry.state === 'pending' || entry.state === 'streaming' ? '…' : '-'
  return value.toLocaleString('en-US')
}

/** 累计的输入 + 输出；读回旧版本的统计时没有这两个字段，按 0 算 */
const totalTokens = computed(
  () => (store.status.inputTokens ?? 0) + (store.status.outputTokens ?? 0)
)

/** 统计格里空间小，上万用「万」、上亿用「亿」 */
function formatTokens(n: number): string {
  if (n >= 100_000_000) return `${(n / 100_000_000).toFixed(2)}亿`
  if (n >= 10_000) return `${(n / 10_000).toFixed(1)}万`
  return String(n)
}

/** 没有内容时给个短横，比空格子好认 */
function inputLabel(entry: ProxyLogEntry): string {
  return entry.inputTypes?.length ? entry.inputTypes.map((t) => INPUT_LABEL[t]).join(' · ') : '-'
}

/** 还在排队 / 刚开始流式时输出类型为空，用省略号表示「还没出来」而不是「没有」 */
function outputLabel(entry: ProxyLogEntry): string {
  if (entry.outputTypes?.length) return entry.outputTypes.map((t) => OUTPUT_LABEL[t]).join(' · ')
  return entry.state === 'pending' || entry.state === 'streaming' ? '…' : '-'
}

const PROTOCOL_LABEL: Record<ProxyLogEntry['protocol'], string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  responses: 'Responses',
  gemini: 'Gemini'
}

/** 协议 + 流式与否，就是这条请求的「输入输出类型」 */
function kindLabel(entry: ProxyLogEntry): string {
  return `${PROTOCOL_LABEL[entry.protocol]} · ${entry.stream ? '流式' : '非流式'}`
}


let stop: (() => void) | null = null

onMounted(async () => {
  await store.load()
  stop = store.subscribe()
  void loadKeyCount()
  // 第一次打开且从没拉过模型：静默拉一次，用户不用先去点刷新
  if (!store.models && accountsStore.accounts.length) void store.refreshModels(true)
})

onUnmounted(() => stop?.())
</script>

<template>
  <div class="proxy-page">
    <!--
      风险提示放在整个页面最上面、所有卡片之外：反代是非官方用法，账号、额度、数据都在用户自己身上，
      这些事必须在他打开开关之前就看到。标题常驻，细则可以收起——看过一次的人不用每次都被这一大段占掉半屏。
    -->
    <a-alert class="risk-alert" type="error" show-icon message="反代有风险，使用需谨慎">
      <template #action>
        <a-button type="link" size="small" class="risk-toggle" @click="toggleRisk">
          {{ riskOpen ? '收起' : '展开' }}
          <UpOutlined v-if="riskOpen" />
          <DownOutlined v-else />
        </a-button>
      </template>
      <template v-if="riskOpen" #description>
        <ol class="risk-list">
          <li>
            <b>账号风险</b>：反代把 Kiro 的内部对话接口包装成 Anthropic / OpenAI 协议给第三方客户端用，
            属于非官方用法，可能违反服务条款。请求量、并发、模型全由客户端决定，
            异常流量容易触发风控，账号有被限流甚至封禁的可能，账号池里的其他账号也会被连带牵扯。
          </li>
          <li>
            <b>额度风险</b>：调用消耗的是你自己账号的积分。agent 类客户端会自动多轮调用、
            反复读写文件与联网搜索，一次任务就可能烧掉大量额度。
          </li>
          <li>
            <b>暴露风险</b>：服务默认只监听本机。关掉 API Key 校验后本机任何程序都能白用你的额度；
            把监听地址改成 0.0.0.0 后，同一网络下的任意设备都能直接调用，务必保持校验开启。
          </li>
          <li>
            <b>数据风险</b>：客户端发出的全部内容（源码、配置、密钥等敏感信息）都会原样转发给上游，
            请求元信息（模型、账号、token 数、内容类型）会留在本地日志里。
          </li>
          <li>
            <b>配置风险</b>：一键接入会改写客户端的本地配置文件。本应用会先完整备份、支持一键还原，
            但仍建议你自己也留一份。
          </li>
        </ol>
      </template>
    </a-alert>

    <!-- 状态与开关 -->
    <a-card class="tool-card" :bordered="false">
      <div class="tool-row">
        <div class="tool-main">
          <div class="tool-title">
            <CloudServerOutlined />
            <strong>本地反代</strong>
            <a-tag :color="store.running ? 'success' : 'default'">
              {{ store.running ? '运行中' : '未启动' }}
            </a-tag>
            <a-tag v-if="store.status.error" color="error">{{ store.status.error }}</a-tag>
          </div>
          <div class="tool-desc">
            用本地账号池给 Claude Code、Codex 这类桌面 agent 供能：它们按 Anthropic / OpenAI
            协议请求本机地址，反代转成 Kiro 的对话接口，额度走你自己的账号。
          </div>
          <div class="tool-hint">
            支持 <span class="mono">/v1/messages</span>（Anthropic）、
            <span class="mono">/v1/chat/completions</span>（OpenAI）、
            <span class="mono">/v1/models</span> 与
            <span class="mono">/v1/messages/count_tokens</span>。
            流式与非流式、工具调用、图片、推理内容都已转换。
          </div>
        </div>
        <!-- 按钮比开关更像一个「动作」：启动要先过风险确认，开关一拨就生效的观感不合适 -->
        <!-- 不写 size，直接跟随全局控件尺寸（默认 / 大）；工具栏那套会再降一档，这里是主操作，不降 -->
        <a-button
          v-if="store.running"
          type="primary"
          danger
          :loading="store.busy === 'stop'"
          @click="stopProxy"
        >
          <template #icon><PoweroffOutlined /></template>
          关闭反代
        </a-button>
        <a-button
          v-else
          type="primary"
          :loading="store.busy === 'start'"
          @click="requestStart"
        >
          <template #icon><PlayCircleOutlined /></template>
          启动反代
        </a-button>
      </div>

      <div class="addr-grid">
        <!-- 上：标题 + 编辑；下：两种协议的地址。和右边 API Key 块同一种结构 -->
        <div class="key-block">
          <div class="key-head">
            <span class="muted">本地反代 URL</span>
            <a-tag v-if="config.allowLan" :bordered="false" color="warning" class="mini-tag">
              局域网可访问
            </a-tag>
            <!-- 纯文字按钮：一排图标认不出各是什么，写成字一眼就懂 -->
            <span class="key-actions text-actions">
              <a-button type="link" size="small" @click="endpointsOpen = true">API 端点</a-button>
              <a-button type="link" size="small" @click="openListen">修改地址</a-button>
            </span>
          </div>
          <!-- 两行共用一套列：标签列按较长的那个自动定宽，两个冒号上下对齐 -->
          <div class="addr-list">
          <div class="addr-row">
            <span class="muted addr-label">Anthropic 客户端 URL：</span>
            <span class="addr-value mono">{{ store.baseUrl }}</span>
            <a-button
              type="link"
              size="small"
              class="text-btn"
              @click="copyText(store.baseUrl, '地址已复制')"
            >
              复制
            </a-button>
          </div>
          <div class="addr-row">
            <span class="muted addr-label">OpenAI 客户端 URL：</span>
            <span class="addr-value mono">{{ store.openAiBaseUrl }}</span>
            <a-button
              type="link"
              size="small"
              class="text-btn"
              @click="copyText(store.openAiBaseUrl, '地址已复制')"
            >
              复制
            </a-button>
          </div>
          </div>
        </div>
        <!-- 上：标题 + 操作；下：密钥本身。密钥很长，横排会把按钮挤到换行 -->
        <div class="key-block">
          <div class="key-head">
            <span class="muted">API Key</span>
            <span v-if="extraKeyCount" class="muted key-count">另有 {{ extraKeyCount }} 个自定义 Key</span>
            <span class="key-actions text-actions">
              <a-button
                type="link"
                size="small"
                :disabled="!config.apiKey"
                @click="keyRevealed = !keyRevealed"
              >
                {{ keyRevealed ? '隐藏' : '显示' }}
              </a-button>
              <a-button type="link" size="small" :loading="regenerating" @click="regenerateKey">
                重新生成
              </a-button>
              <a-button type="link" size="small" @click="keysOpen = true">管理 Key</a-button>
            </span>
          </div>
          <div class="key-value mono">
            <!-- 与「模型列表」里的来源邮箱同一种交互：虚线下划线、悬停提示、点击复制完整 Key -->
            <a-tooltip v-if="config.apiKey" title="点击复制完整 API Key">
              <a class="copy-owner" @click="copyText(config.apiKey, 'API Key 已复制')">
                {{ keyRevealed ? config.apiKey : maskKey(config.apiKey) }}
              </a>
            </a-tooltip>
            <template v-else>未设置，点右上角「重新生成」生成一个</template>
          </div>
        </div>
      </div>

    </a-card>

    <!-- 参数 -->
    <a-card class="tool-card" :bordered="false" title="参数">
      <div class="form-grid">
        <div class="field">
          <span class="field-label">账号来源</span>
          <a-radio-group
            :value="config.accountSource"
            button-style="solid"
            @change="(e: any) => changePool({ accountSource: e.target.value })"
          >
            <a-radio-button value="account">账户</a-radio-button>
            <a-radio-button value="apiKey">API Key</a-radio-button>
          </a-radio-group>
          <span class="field-hint muted">
            {{
              config.accountSource === 'apiKey'
                ? '从「API Key」里取 Kiro API Key（ksk_）发请求'
                : '从「账号管理」里取账号发请求'
            }}
          </span>
        </div>

        <div class="field">
          <span class="field-label">使用策略</span>
          <a-radio-group
            :value="config.accountMode"
            button-style="solid"
            @change="(e: any) => changePool({ accountMode: e.target.value })"
          >
            <a-radio-button value="roundRobin">轮询</a-radio-button>
            <a-radio-button value="group">指定分组</a-radio-button>
            <a-radio-button value="selected">指定{{ sourceNoun }}</a-radio-button>
          </a-radio-group>
          <a-select
            v-if="config.accountMode === 'group'"
            :value="selectedGroupIds"
            :options="groupOptions"
            mode="multiple"
            show-search
            option-filter-prop="label"
            :placeholder="`选择${sourceNoun}分组`"
            :not-found-content="`还没有${sourceNoun}分组`"
            style="width: 320px"
            max-tag-count="responsive"
            @change="(v: any) => changePool(groupPatch(v))"
          />
          <a-select
            v-else-if="config.accountMode === 'selected'"
            :value="selectedMemberIds"
            :options="memberOptions"
            mode="multiple"
            show-search
            option-filter-prop="label"
            :placeholder="`选择一个或多个${sourceNoun}`"
            style="width: 420px"
            max-tag-count="responsive"
            @change="(v: any) => changePool(memberPatch(v))"
          />
          <span class="field-hint muted">
            当前参与轮询 {{ scopeCount }} 个{{ sourceNoun }}，请求依次分给它们；{{
              config.accountSource === 'apiKey' ? '额度用尽的 Key 会排到最后' : '封禁与凭证失效的账号会自动跳过'
            }}
          </span>
        </div>

        <div class="field">
          <span class="field-label">模型</span>
          <div class="model-picker">
            <ModelCascader
              :models="cascaderModels"
              :value="modelSelection"
              :disabled="store.modelsLoading"
              placeholder="选择模型与推理档位"
              @change="onModelChange"
            />
          </div>
          <a-tooltip title="用当前选中的账号重新拉取模型列表">
            <a-button :loading="store.modelsLoading" @click="store.refreshModels()">
              <template #icon><ReloadOutlined /></template>
              刷新模型
            </a-button>
          </a-tooltip>
          <span class="field-hint muted">
            模型列表：<template v-if="modelSource">
              {{ modelSource.count }} 个，来自
              <a-tooltip :title="modelSource.isEmail ? '点击复制完整邮箱' : '点击复制'">
                <a
                  class="copy-owner"
                  @click="copyText(modelSource.owner, modelSource.isEmail ? '邮箱已复制' : '已复制')"
                >{{ modelSource.ownerText }}</a>
              </a-tooltip>
              · {{ modelSource.at }}
            </template>
            <template v-else>还没有从账号拉取过，暂用内置的常用模型</template>。客户端点名的模型在列表里就直接用；
            claude-sonnet-4-5-20250929 这类带日期或短横的写法会自动对上；认不出来的回落到上面选的模型
          </span>
          <span class="field-hint muted">
            推理档位：{{
              selectedEffort?.options.length
                ? `该模型可选 ${selectedEffort.options.join(' / ')}，悬停模型在右侧选择；只选模型即用上游默认（${selectedEffort.default ?? '未标注'}）`
                : '该模型没有可调的推理档位'
            }}。客户端自己点名档位时以客户端为准（Codex 的 /model、Claude Code 的 thinking 预算），
            模型不支持该档位时就近取值
          </span>
        </div>

        <div class="field">
          <span class="field-label">上游端点</span>
          <a-radio-group
            class="boxed-radio"
            :value="config.endpoint"
            @change="(e: any) => patch({ endpoint: e.target.value })"
          >
            <a-radio value="auto">自动</a-radio>
            <a-radio value="codewhisperer">CodeWhisperer</a-radio>
            <a-radio value="amazonq">Amazon Q</a-radio>
          </a-radio-group>
          <span class="field-hint muted">自动 = 先 CodeWhisperer，失败再试 Amazon Q</span>
        </div>

        <div class="field">
          <span class="field-label">自动重试</span>
          <span class="switch-item">
            <a-switch
              size="small"
              :checked="config.retryEnabled"
              @change="(v: any) => patch({ retryEnabled: !!v })"
            />
            <a-tooltip
              :title="`开：失败后先在同一个${sourceNoun}上按间隔重试，仍失败就静默换下一个${sourceNoun}继续重试，直到都试过。关：失败直接报给客户端，不重发。额度耗尽、被封、凭证失效的${sourceNoun}不管开关都会直接跳过。`"
            >
              <span class="switch-label">失败自动重试</span>
            </a-tooltip>
          </span>
          <!-- 次数与间隔单独一行，只在开启时出现：关闭时它们不起作用，留着只会让人以为还在重试 -->
          <div v-if="config.retryEnabled" class="field-sub">
            <span class="muted">每个{{ sourceNoun }}重试</span>
            <a-input-number
              :value="config.maxRetries"
              :min="0"
              :max="10"
              style="width: 110px"
              @change="(v: any) => typeof v === 'number' && patch({ maxRetries: Math.round(v) })"
            />
            <span class="muted">次</span>
            <a-divider type="vertical" style="margin: 0 4px" />
            <span class="muted">间隔</span>
            <a-input-number
              :value="config.retryDelayMs"
              :min="0"
              :max="10000"
              :step="100"
              style="width: 120px"
              @change="(v: any) => typeof v === 'number' && patch({ retryDelayMs: Math.round(v) })"
            />
            <span class="muted">ms</span>
          </div>
          <span class="field-hint muted">
            {{
              config.retryEnabled
                ? `失败后在同一个${sourceNoun}上重试 ${config.maxRetries} 次，仍失败就换下一个${sourceNoun}再重试 ${config.maxRetries} 次，直到都试过`
                : `失败直接报给客户端；额度耗尽、被封的${sourceNoun}仍会跳到下一个`
            }}。已经开始输出就不会重发，避免出现两段拼接的回复
          </span>
        </div>

        <!--
          高级：工具、日志、载荷。参考的是 Kiro-account-manager 的同名选项，
          但每一项都落在我们反代里真实存在的行为上（见 ProxyConfig 各字段的注释）。
        -->
        <div class="field">
          <span class="field-label">工具</span>
          <span class="switch-item">
            <a-switch
              size="small"
              :checked="config.managedToolExecution"
              :disabled="config.disableTools"
              @change="(v: any) => patch({ managedToolExecution: !!v })"
            />
            <a-tooltip
              title="开：给模型挂上联网搜索，模型要搜时由反代调用 Kiro 自带的搜索并把结果交回（Codex 等客户端联网靠它）。关：反代不注入也不代执行任何工具，全部交给客户端。"
            >
              <span class="switch-label">工具执行模式</span>
            </a-tooltip>
          </span>
          <span class="switch-item">
            <a-switch
              size="small"
              :checked="config.disableTools"
              @change="(v: any) => patch({ disableTools: !!v })"
            />
            <a-tooltip title="开启后去掉请求里的全部工具定义，模型只能纯文本作答，适合纯聊天">
              <span class="switch-label">禁用工具调用</span>
            </a-tooltip>
          </span>
          <span v-if="config.disableTools" class="field-hint warn">
            已禁用工具：Claude Code、Codex 这类 agent 将无法读写文件或执行命令
          </span>
        </div>

        <div class="field">
          <span class="field-label">日志</span>
          <span class="switch-item">
            <a-switch
              size="small"
              :checked="config.logRequests"
              @change="(v: any) => patch({ logRequests: !!v })"
            />
            <a-tooltip title="关掉后请求照常处理、统计照常累计，但不再进下面的请求日志，也不写逐条请求的应用日志（失败告警仍会写）">
              <span class="switch-label">记录日志</span>
            </a-tooltip>
          </span>
          <span class="switch-item">
            <a-switch
              size="small"
              :checked="config.logStreamEvents"
              @change="(v: any) => patch({ logStreamEvents: !!v })"
            />
            <a-tooltip title="每个请求结束后往应用日志写一行流式摘要：文本块、推理块、工具调用、托管搜索各多少，首字耗时与请求体大小。排查问题时再开">
              <span class="switch-label">流式日志</span>
            </a-tooltip>
          </span>
        </div>

        <div class="field">
          <span class="field-label">载荷 (KB)</span>
          <a-input-number
            :value="config.payloadLimitKB"
            :min="PAYLOAD_LIMIT_MIN_KB"
            :max="PAYLOAD_LIMIT_MAX_KB"
            :step="128"
            :precision="0"
            style="width: 140px"
            @change="
              (v: any) =>
                typeof v === 'number' &&
                patch({
                  payloadLimitKB: Math.min(PAYLOAD_LIMIT_MAX_KB, Math.max(PAYLOAD_LIMIT_MIN_KB, Math.round(v)))
                })
            "
          />
          <span class="field-hint muted">
            发往 Kiro 的请求体上限，默认 153600（150MB）。超了先截断最旧的超长历史消息（通常是大段工具输出），
            还不够再丢最旧的历史；系统提示和最近 4 条始终保留。遇到上游因请求体过大报 400 时调小，900 是稳定值
          </span>
        </div>

        <div class="field">
          <span class="field-label">其它</span>
          <a-checkbox
            :checked="config.autoStart"
            @change="(e: any) => patch({ autoStart: e.target.checked })"
          >
            应用启动时自动启动反代
          </a-checkbox>
          <a-checkbox
            :checked="config.requireApiKey"
            @change="(e: any) => patch({ requireApiKey: e.target.checked })"
          >
            强制校验 API Key
          </a-checkbox>
          <span v-if="!config.requireApiKey" class="field-hint warn">
            关掉校验等于本机任何程序都能白用你的账号额度
          </span>
        </div>
      </div>
    </a-card>

    <!-- 客户端接入 -->
    <a-card class="tool-card" :bordered="false" title="一键接入桌面 agent">
      <div v-for="group in clientGroups" :key="group.title" class="client-group">
        <div class="client-group-head">
          <span class="client-group-title">{{ group.title }}</span>
          <span class="muted client-group-hint">{{ group.hint }}</span>
        </div>
        <!-- 卡片只回答「这是谁、配了没」，改什么文件、怎么写都在点开后的弹窗里 -->
        <div class="client-grid">
          <div
            v-for="item in group.items"
            :key="item.target"
            class="client-tile"
            :class="{ applied: item.applied, off: !item.installed }"
            role="button"
            tabindex="0"
            @click="clientDetail = item.target"
            @keydown.enter.prevent="clientDetail = item.target"
            @keydown.space.prevent="clientDetail = item.target"
          >
            <!-- 状态角标：钉在右上角，不跟名字抢一行，名字长了也不会把它挤掉 -->
            <a-tag v-if="!item.installed" :bordered="false" color="default" class="tile-badge">
              未安装
            </a-tag>
            <a-tag
              v-else
              :bordered="false"
              :color="item.applied ? 'success' : 'default'"
              class="tile-badge"
            >
              {{ item.applied ? '已接入' : '未配置' }}
            </a-tag>
            <span class="tile-icon"><ClientIcon :target="item.target" :size="36" /></span>
            <span class="tile-main">
              <span class="tile-head">
                <strong class="tile-name">{{ clientMeta[item.target].name }}</strong>
              </span>
              <!--
                卡片上的官网只展示、不可点：整张卡片本身是打开详情的点击区，
                里面再嵌一个跳外链的热区很容易误触。要访问官网去详情弹窗里点。
              -->
              <span class="tile-site" :title="clientMeta[item.target].site">
                {{ siteLabel(clientMeta[item.target].site) }}
              </span>
            </span>
          </div>
        </div>
      </div>
      <div class="tool-hint">
        点卡片查看配置文件位置与写入 / 还原操作。其它 OpenAI 兼容客户端（Cherry Studio、Cline、Continue 等）
        手动填上面的 <span class="mono">{{ store.openAiBaseUrl }}</span> 与 API Key 即可。
      </div>
    </a-card>

    <!-- 请求日志 -->
    <a-card class="tool-card log-card" :bordered="false">
      <template #title>
        <span class="card-title">
          请求日志
          <span class="muted">（{{ store.logs.length }} 条，实时更新）</span>
        </span>
      </template>
      <template #extra>
        <a-space>
          <a-button :size="toolbarSize" :loading="store.loading" @click="store.load()">
            <template #icon><ReloadOutlined /></template>
            刷新
          </a-button>
          <a-button :size="toolbarSize" :disabled="!store.logs.length" @click="store.clearLogs()">
            <template #icon><DeleteOutlined /></template>
            清空日志
          </a-button>
          <a-button :size="toolbarSize" @click="store.resetStats()">
            <template #icon><ClearOutlined /></template>
            清零统计
          </a-button>
        </a-space>
      </template>

      <!-- 本次运行的累计：和下面的日志是同一批请求，放在一起看 -->
      <div class="stat-grid">
        <div class="stat-cell">
          <span class="stat-num">{{ store.status.requests }}</span>
          <span class="muted">请求</span>
        </div>
        <div class="stat-cell">
          <span class="stat-num ok">{{ store.status.succeeded }}</span>
          <span class="muted">成功</span>
        </div>
        <div class="stat-cell">
          <span class="stat-num bad">{{ store.status.failed }}</span>
          <span class="muted">失败</span>
        </div>
        <div class="stat-cell">
          <span class="stat-num">{{ store.successRate.toFixed(1) }}<small>%</small></span>
          <span class="muted">成功率</span>
        </div>
        <div class="stat-cell">
          <span class="stat-num">{{ formatTokens(totalTokens) }}</span>
          <span class="muted">消耗 Tokens</span>
        </div>
        <div class="stat-cell">
          <span class="stat-num">{{ formatCredits(store.status.credits, true) }}</span>
          <span class="muted">消耗积分</span>
        </div>
      </div>
      <a-table
        class="log-table"
        :columns="logColumns"
        :data-source="store.logs"
        :bordered="false"
        row-key="id"
        size="small"
        :pagination="LOG_PAGINATION"
        :scroll="LOG_SCROLL"
        :custom-row="logRowProps"
        :row-class-name="logRowClass"
      >
        <template #emptyText>
          <div class="empty muted">
            还没有请求。启动反代并在客户端里发一条消息就能看到这里的记录。
          </div>
        </template>
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'at'">
            <span class="mono muted">{{ formatLogTime(record.at) }}</span>
          </template>
          <template v-else-if="column.key === 'state'">
            <a-tag :color="logState(record).color" :bordered="false">
              {{ logState(record).text }}
            </a-tag>
          </template>
          <template v-else-if="column.key === 'kind'">
            <span class="muted">{{ kindLabel(record) }}</span>
          </template>
          <template v-else-if="column.key === 'model'">
            <span class="mono log-model">{{ record.kiroModel }}</span>
            <span v-if="record.effort" class="log-effort mono"> · {{ record.effort }}</span>
          </template>
          <template v-else-if="column.key === 'account'">{{ accountLabel(record) }}</template>
          <template v-else-if="column.key === 'inputTokens'">
            <span class="num">{{ tokenCell(record, 'inputTokens') }}</span>
          </template>
          <template v-else-if="column.key === 'outputTokens'">
            <span class="num">{{ tokenCell(record, 'outputTokens') }}</span>
          </template>
          <template v-else-if="column.key === 'duration'">
            <span class="num">{{ record.durationMs != null ? `${record.durationMs}ms` : '…' }}</span>
            <span v-if="record.firstTokenMs != null" class="muted num">
              （首字 {{ record.firstTokenMs }}ms）
            </span>
          </template>
          <template v-else-if="column.key === 'credits'">
            <span v-if="record.credits" class="credit num">
              {{ formatCredits(record.credits, true) }}
            </span>
            <span v-else class="muted">-</span>
          </template>
        </template>
      </a-table>
    </a-card>

    <!-- 按账号用量 -->
    <a-card v-if="store.usage.length" class="tool-card" :bordered="false" title="按账号消耗">
      <div class="usage-list">
        <div v-for="item in store.usage" :key="item.accountId" class="usage-row">
          <span class="usage-email">{{ displayEmail(item.email, privacy) }}</span>
          <span class="muted">{{ item.requests }} 次请求</span>
          <span v-if="item.failed" class="warn">{{ item.failed }} 次失败</span>
          <span class="credit">{{ formatCredits(item.credits, true) }} 积分</span>
        </div>
      </div>
    </a-card>

    <!--
      客户端详情：状态 + 官网 + 配置文件目录 + 写入/还原/启动。
      列表上只留图标、名字和官网，这些细节等用户真要动手时再给。
    -->
    <a-modal
      :open="!!detailState"
      :width="640"
      centered
      :footer="null"
      @cancel="clientDetail = null"
    >
      <template #title>
        <span class="modal-title">
          <ClientIcon v-if="detailState" :target="detailState.target" :size="18" />
          {{ detailState ? clientMeta[detailState.target].name : '' }}
        </span>
      </template>

      <div v-if="detailState" class="client-detail">
        <div class="cd-top">
          <a-tag v-if="!detailState.installed" :bordered="false" color="default">未安装</a-tag>
          <a-tag v-else :bordered="false" :color="detailState.applied ? 'success' : 'default'">
            {{ detailState.applied ? '已指向本反代' : '未配置' }}
          </a-tag>
          <!-- 和左边的状态 tag 同一种 a-tag（无边框、default 色），只多一个地球图标和点击 -->
          <a-tag
            :bordered="false"
            color="default"
            class="cd-site"
            :title="clientMeta[detailState.target].site"
            @click="openSite(clientMeta[detailState.target].site)"
          >
            <template #icon><GlobalOutlined /></template>
            {{ siteLabel(clientMeta[detailState.target].site) }}
          </a-tag>
        </div>

        <a-alert
          v-if="detailState.warning"
          :type="detailState.installed ? 'info' : 'warning'"
          show-icon
        >
          <template #message>
            {{ detailState.warning }}
            <!-- 装在非默认位置时自动检测会漏，让用户自己指一次 -->
            <template v-if="!detailState.installed">
            如您已安装，请<a
              class="pick-link"
              role="button"
              tabindex="0"
              @click="pickInstallPath(detailState.target)"
              @keydown.enter="pickInstallPath(detailState.target)"
            >点击此处设置</a>
            </template>
          </template>
        </a-alert>

        <!-- 认的是哪一份：同一台机器上装了多份（或便携版）时，用户得能看出来、能改 -->
        <div v-if="detailState.installPath" class="cd-sect">
          <div class="cd-title">
            安装位置
            <a-tag v-if="detailState.customPath" :bordered="false" color="processing" class="mini-tag">
              手动指定
            </a-tag>
          </div>
          <div class="client-path">
            <span class="mono">{{ detailState.installPath }}</span>
            <a-button type="link" size="small" @click="pickInstallPath(detailState.target)">
              {{ detailState.customPath ? '重新选择' : '更改' }}
            </a-button>
            <a-button
              v-if="detailState.customPath"
              type="link"
              size="small"
              @click="clearInstallPath(detailState.target)"
            >
              恢复自动检测
            </a-button>
          </div>
        </div>

        <!-- Codex 走 profile，不带参数不会用到我们的配置，这行必须给出来 -->
        <div v-if="detailState.command" class="cd-sect">
          <div class="cd-title">启动命令</div>
          <div class="restart-cmd">
            <span class="mono">{{ detailState.command }}</span>
            <a-button
              type="text"
              size="small"
              @click="copyText(detailState.command, '命令已复制')"
            >
              <template #icon><CopyOutlined /></template>
            </a-button>
          </div>
        </div>

        <div v-if="detailState.paths.length" class="cd-sect">
          <div class="cd-title">配置文件</div>
          <div v-for="(path, index) in detailState.paths" :key="path" class="client-path">
            <PathMenu :path="path" @reveal="revealPath(detailState.target, index)" />
          </div>
        </div>

        <!-- 要不要重启在写入成功那一步再说，这里只放操作 -->
        <div class="cd-actions">
          <!-- 刚装完不用关弹窗再开：点一下重新查。已装的用不上，不显示 -->
          <a-button
            v-if="!detailState.installed"
            class="cd-recheck"
            :loading="rechecking"
            @click="recheckInstall"
          >
            <template #icon><ReloadOutlined /></template>
            重新检测
          </a-button>
          <!-- 没装就禁掉：写下去只会给不存在的客户端造出配置文件 -->
          <a-tooltip :title="detailState.installed ? '' : detailState.warning">
            <a-button
              type="primary"
              :disabled="!detailState.installed"
              :loading="store.busy === `apply:${detailState.target}`"
              @click="applyClient(detailState.target)"
            >
              <template #icon><ThunderboltOutlined /></template>
              一键写入
            </a-button>
          </a-tooltip>
          <a-button
            :disabled="!detailState.hasBackup"
            :loading="store.busy === `restore:${detailState.target}`"
            @click="restoreClient(detailState.target)"
          >
            <template #icon><RollbackOutlined /></template>
            还原
          </a-button>
          <!-- 代为打开 / 重启：图形界面退出再拉起，命令行开新终端 -->
          <a-button
            v-if="OPENABLE.includes(detailState.target)"
            :disabled="!detailState.installed"
            :loading="launching"
            @click="openClient(detailState.target)"
          >
            <template #icon><PlayCircleOutlined /></template>
            {{ openVerb(detailState.target) }}
          </a-button>
        </div>
      </div>
    </a-modal>

    <!--
      写入 / 还原的过程与结果。
      尺寸、居中、固定高度都与「订阅管理」弹窗一致：加载完不会整块跳一下。
    -->
    <a-modal
      v-if="clientPrompt"
      :open="true"
      centered
      width="820px"
      :footer="null"
      :mask-closable="clientPrompt.stage !== 'running'"
      :closable="clientPrompt.stage !== 'running'"
      @cancel="clientPrompt = null"
    >
      <template #title>
        <span class="modal-title">
          <ClientIcon :target="clientPrompt.target" :size="18" />
          {{ promptTitle }}
        </span>
      </template>

      <div class="modal-body">
        <a-steps
          class="prompt-steps"
          size="small"
          :current="promptStep"
          :status="clientPrompt.stage === 'failed' ? 'error' : 'process'"
          :items="[
            { title: '确认改动' },
            { title: clientPrompt.action === 'apply' ? '写入配置' : '还原配置' },
            { title: '完成' }
          ]"
        />

        <!-- 第一步：说清楚要改什么、能不能撤销，再让用户点 -->
        <div v-if="clientPrompt.stage === 'confirm'" class="stage">
          <a-result
            status="warning"
            :title="promptTitle"
            :sub-title="`将要修改的文件：${clientMeta[clientPrompt.target].name}`"
          >
            <template #extra>
              <div class="result-extra">
                <ul class="confirm-list">
                  <li v-for="(line, i) in confirmLines" :key="i">{{ line }}</li>
                </ul>

                <!-- 把实际会动到的文件列出来，比一句「本地配置文件」具体得多 -->
                <div v-if="promptPaths.length" class="confirm-paths">
                  <div v-for="p in promptPaths" :key="p" class="mono">{{ p }}</div>
                </div>

                <a-space>
                  <a-button @click="clientPrompt = null">取消</a-button>
                  <a-button
                    type="primary"
                    :danger="clientPrompt.action === 'restore'"
                    @click="runClientAction()"
                  >
                    <template #icon><ThunderboltOutlined /></template>
                    {{ clientPrompt.action === 'apply' ? '开始写入' : '开始还原' }}
                  </a-button>
                </a-space>
              </div>
            </template>
          </a-result>
        </div>

        <!-- 进行中：转圈 + 实时日志，Cursor 首次要装 CCursor，这段可能一两分钟 -->
        <div v-else-if="clientPrompt.stage === 'running'" class="stage">
          <a-spin size="large" />
          <span class="stage-text muted">
            {{
              applyProgress && applyProgress.lines.length
                ? applyProgress.lines[applyProgress.lines.length - 1]
                : '正在写入配置文件…'
            }}
          </span>
          <div v-if="applyProgress && applyProgress.lines.length > 1" class="stage-log">
            <div v-for="(line, i) in applyProgress.lines.slice(-8)" :key="i" class="mono">
              {{ line }}
            </div>
          </div>
        </div>

        <!-- 失败：原始报错留在屏幕上，给关闭 / 重试 -->
        <div v-else-if="clientPrompt.stage === 'failed'" class="stage">
          <a-result
            status="error"
            :title="`${clientMeta[clientPrompt.target].name} 配置${clientPrompt.action === 'apply' ? '写入' : '还原'}失败`"
            :sub-title="clientPrompt.error"
          >
            <template #extra>
              <a-space>
                <a-button @click="clientPrompt = null">关闭</a-button>
                <a-button
                  type="primary"
                  @click="
                    clientPrompt.action === 'apply'
                      ? applyClient(clientPrompt.target)
                      : restoreClient(clientPrompt.target)
                  "
                >
                  <template #icon><ReloadOutlined /></template>
                  重试
                </a-button>
              </a-space>
            </template>
          </a-result>
        </div>

        <!-- 成功：图标 + 标题 + 说明 + 打开/重启 -->
        <div v-else class="stage">
          <a-result
            status="success"
            :title="`${clientMeta[clientPrompt.target].name} 配置${clientPrompt.action === 'apply' ? '已写入' : '已还原'}`"
            :sub-title="RESTART_HINTS[clientPrompt.target]"
          >
            <template #extra>
              <div class="result-extra">
                <!-- 命令行版靠 --profile 生效，这条命令必须给出来 -->
                <div v-if="clientPrompt.action === 'apply' && clientPrompt.command" class="restart-cmd">
                  <span class="mono">{{ clientPrompt.command }}</span>
                  <a-button
                    type="text"
                    size="small"
                    @click="copyText(clientPrompt.command, '命令已复制')"
                  >
                    <template #icon><CopyOutlined /></template>
                  </a-button>
                </div>

                <!-- 只有真正会导致连不上的问题才提示 -->
                <a-alert
                  v-if="clientPrompt.warning"
                  type="warning"
                  show-icon
                  :message="clientPrompt.warning"
                />

                <a-space>
                  <template v-if="promptApp">
                    <a-button :disabled="launching" @click="clientPrompt = null">稍后自己来</a-button>
                    <a-button
                      type="primary"
                      :loading="launching"
                      @click="openClient(promptApp.target)"
                    >
                      <template #icon><PlayCircleOutlined /></template>
                      立即{{ promptApp.verb }}
                    </a-button>
                  </template>
                  <a-button v-else type="primary" @click="clientPrompt = null">我知道了</a-button>
                </a-space>
              </div>
            </template>
          </a-result>
        </div>
      </div>
    </a-modal>

    <!-- API 端点与在线调试 -->
    <ProxyEndpointsModal
      v-if="endpointsOpen"
      :base-url="store.baseUrl"
      :api-key="config.apiKey"
      :model="config.defaultModel"
      :running="store.running"
      @close="endpointsOpen = false"
    />

    <!-- 多 API Key 管理 -->
    <ProxyKeysModal v-if="keysOpen" @close="keysOpen = false" @changed="onKeysChanged" />

    <!-- 监听地址与端口 -->
    <a-modal
      :open="listenOpen"
      centered
      width="520px"
      title="本地反代 URL"
      ok-text="保存"
      cancel-text="取消"
      :confirm-loading="listenSaving"
      @ok="saveListen"
      @cancel="listenOpen = false"
    >
      <a-form layout="vertical" class="listen-form">
        <a-form-item label="监听地址">
          <a-radio-group v-model:value="listenHost" class="listen-hosts">
            <a-radio value="127.0.0.1">
              <span class="mono">127.0.0.1</span>
              <span class="muted">　只有本机能连（推荐）</span>
            </a-radio>
            <a-radio value="0.0.0.0">
              <span class="mono">0.0.0.0</span>
              <span class="muted">　同一局域网的设备也能连</span>
            </a-radio>
          </a-radio-group>
        </a-form-item>
        <a-form-item label="端口">
          <a-input-number
            v-model:value="listenPort"
            :min="1024"
            :max="65535"
            :step="1"
            :precision="0"
            style="width: 160px"
          />
        </a-form-item>
      </a-form>
      <!-- 只在真会出问题的时候提示 -->
      <a-alert
        v-if="listenHost === '0.0.0.0' && !config.requireApiKey"
        type="error"
        show-icon
        message="局域网可访问但没开 API Key 校验，同网络的任何设备都能直接用你的额度"
      />
      <a-alert
        v-else-if="listenPortChanged && store.clients.some((c) => c.applied)"
        type="warning"
        show-icon
        message="改端口后，已一键写入的客户端里还是旧地址，需要对它们重新写入"
      />
    </a-modal>

    <!-- 手动启动前的风险确认；应用启动时的自动启动不走这里 -->
    <a-modal
      v-model:open="startConfirmOpen"
      centered
      :width="480"
      :mask-closable="true"
    >
      <template #title>
        <span class="modal-title start-risk-title">
          <ExclamationCircleFilled />
          反代有风险，使用需谨慎
        </span>
      </template>
      <ul class="start-risk-list">
        <li>属于非官方用法，异常流量可能触发风控，账号有被限流甚至封禁的可能。</li>
        <li>调用消耗的是你自己账号的积分，agent 自动多轮调用时消耗很快。</li>
        <li>客户端发出的内容（源码、密钥等）会原样转发给上游，请保持 API Key 校验开启。</li>
      </ul>
      <template #footer>
        <a-button @click="startConfirmOpen = false">取消</a-button>
        <a-button type="primary" :loading="store.busy === 'start'" @click="confirmStart">
          我已知晓，确认启用
        </a-button>
      </template>
    </a-modal>

    <!-- 单条日志详情 -->
    <a-modal
      :open="!!logDetail"
      :width="720"
      :footer="null"
      title="请求详情"
      @cancel="logDetail = null"
    >
      <a-descriptions v-if="logDetail" :column="2" size="small" bordered>
        <a-descriptions-item label="时间">
          {{ formatLogTime(logDetail.at) }}
        </a-descriptions-item>
        <a-descriptions-item label="状态">
          {{ stateMeta[logDetail.state].text }}（HTTP {{ logDetail.httpStatus ?? '-' }}）
        </a-descriptions-item>
        <a-descriptions-item label="协议">
          {{ logDetail.protocol }} {{ logDetail.stream ? '流式' : '非流式' }}
        </a-descriptions-item>
        <a-descriptions-item label="路径">
          <span class="mono">{{ logDetail.path }}</span>
        </a-descriptions-item>
        <a-descriptions-item label="客户端模型">
          <span class="mono">{{ logDetail.model }}</span>
        </a-descriptions-item>
        <a-descriptions-item label="实际模型">
          <span class="mono">{{ logDetail.kiroModel }}</span>
          <span class="muted"> · {{ logDetail.effort || '上游默认档位' }}</span>
        </a-descriptions-item>
        <a-descriptions-item label="账号">{{ accountLabel(logDetail) }}</a-descriptions-item>
        <a-descriptions-item label="尝试次数">{{ logDetail.attempts }}</a-descriptions-item>
        <a-descriptions-item label="耗时">
          {{ logDetail.durationMs != null ? `${logDetail.durationMs}ms` : '-' }}
        </a-descriptions-item>
        <a-descriptions-item label="首字">
          {{ logDetail.firstTokenMs != null ? `${logDetail.firstTokenMs}ms` : '-' }}
        </a-descriptions-item>
        <a-descriptions-item label="输入类型">{{ inputLabel(logDetail) }}</a-descriptions-item>
        <a-descriptions-item label="输出类型">{{ outputLabel(logDetail) }}</a-descriptions-item>
        <a-descriptions-item label="Token">
          入 {{ logDetail.inputTokens ?? '-' }} / 出 {{ logDetail.outputTokens ?? '-' }}
        </a-descriptions-item>
        <a-descriptions-item label="积分">
          {{ logDetail.credits != null ? formatCredits(logDetail.credits, true) : '-' }}
        </a-descriptions-item>
        <!-- 独占最后一行（标签 + 3 格值）：显示完整密钥而不是名称，名称可改、可能重名，认不准；排查时要能直接比对整串 -->
        <a-descriptions-item label="使用 Key" :span="2">
          <a-tooltip
            v-if="logDetail.keyValue"
            :title="logDetail.keyName ? `「${logDetail.keyName}」· 点击复制` : '点击复制'"
          >
            <a class="copy-owner mono" @click="copyText(logDetail.keyValue, 'API Key 已复制')">
              {{ logDetail.keyValue }}
            </a>
          </a-tooltip>
          <span v-else-if="logDetail.keyName">{{ logDetail.keyName }}</span>
          <span v-else class="muted">未带 Key（未开启强制校验时允许）</span>
        </a-descriptions-item>
      </a-descriptions>

      <div v-if="logDetail?.retries.length" class="detail-block">
        <div class="detail-title">重试过程</div>
        <div v-for="(line, index) in logDetail.retries" :key="index" class="detail-line warn">
          {{ line }}
        </div>
      </div>

      <div v-if="logDetail?.error" class="detail-block">
        <div class="detail-title">错误</div>
        <div class="detail-line bad">{{ logDetail.error }}</div>
      </div>

    </a-modal>
  </div>
</template>

<style scoped>
.proxy-page { display: flex; flex-direction: column; gap: 16px; }
.tool-card { border: 1px solid var(--kal-border); }
.tool-row { display: flex; align-items: flex-start; gap: 16px; }
.tool-main { flex: 1 1 auto; min-width: 0; }
/* 启动前风险确认：标题用警示色，要点压成三条，不重复页面顶部那份细则 */
.start-risk-title { color: var(--ant-color-error, #ff4d4f); }
.start-risk-list { margin: 4px 0 0; padding-left: 18px; line-height: 1.8; font-size: 13px; }
.tool-title { display: flex; align-items: center; flex-wrap: wrap; gap: 9px; font-size: 16px; }
.tool-desc { margin-top: 8px; font-size: 13px; }
.tool-hint { margin-top: 10px; color: var(--kal-muted); font-size: 12px; line-height: 1.7; }
.card-title { font-size: 15px; }
.card-title .muted { font-size: 12px; font-weight: 400; }

/* 风险提示：整个模块最上面，红底，条目式列开 */
/* 在页面顶层，间距交给 .proxy-page 的 gap */
/* 和下面卡片的间距不单独设，统一用 .proxy-page 的 gap，与卡片之间一致 */
.risk-alert { border-radius: 10px; }
.risk-alert :deep(.ant-alert-action) { margin-left: 12px; }
.risk-toggle { padding: 0 4px; font-size: 12px; }
.risk-alert :deep(.ant-alert-message) { font-weight: 600; }
/*
 * 序号用「1、2、3、」：list-style 的 decimal 只能出「1.」，
 * 所以关掉自带标记，用计数器自己画，并用悬挂缩进让折行和正文对齐。
 */
.risk-list {
  margin: 4px 0 0;
  padding: 0;
  list-style: none;
  counter-reset: risk;
  font-size: 12px;
  line-height: 1.85;
}
.risk-list li {
  position: relative;
  padding-left: 22px;
  counter-increment: risk;
}
.risk-list li::before {
  content: counter(risk) '、';
  position: absolute;
  left: 0;
  font-weight: 600;
}
.risk-list li + li { margin-top: 2px; }

/*
 * 地址区：「本地反代 URL」和「API Key」两块并排，结构一样——
 * 上面一行标题 + 右侧文字按钮，下面是内容。
 */
.addr-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
  gap: 10px;
  margin-top: 16px;
  padding-top: 14px;
  border-top: 1px solid var(--kal-border);
}
.key-block {
  display: flex;
  flex-direction: column;
  padding: 8px 10px;
  border-radius: 10px;
  background: var(--kal-block-bg);
  font-size: 12px;
}
.key-head { display: flex; align-items: center; gap: 8px; min-height: 22px; }
.key-count { font-size: 11px; }
.key-actions { display: inline-flex; gap: 2px; margin-left: auto; }
/* 文字按钮宽度随文字，不能定死：定成图标按钮的 22px 会让几个按钮叠在一起 */
.key-block :deep(.ant-btn) { height: 22px; padding: 0; }
.key-value { margin-top: 6px; font-size: 13.5px; font-weight: 600; word-break: break-all; }
.mini-tag { margin: 0; font-size: 11px; line-height: 17px; }

/*
 * 两行地址对齐：外层定三列（标签 / 地址 / 复制），每一行用 subgrid 继承这三列。
 * 这样标签列宽度 = 两个标签里较长的那个，不用写死一个像素值——
 * 写死的话换字体、改文案都会重新错位。行本身还是一个盒子，分隔线照样画得出来。
 */
.addr-list {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr) auto;
  column-gap: 6px;
  margin-top: 2px;
}
.addr-row {
  display: grid;
  grid-column: 1 / -1;
  grid-template-columns: subgrid;
  align-items: center;
  padding: 5px 0;
}
.addr-row + .addr-row { border-top: 1px solid var(--kal-border); }
.addr-value { min-width: 0; font-weight: 600; word-break: break-all; }

.stat-grid {
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  gap: 10px;
  margin-bottom: 12px;
}
.stat-cell {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 10px 8px;
  border-radius: 10px;
  background: var(--kal-block-bg);
  font-size: 12px;
}
.stat-num { font-size: 18px; font-weight: 700; font-variant-numeric: tabular-nums; }
.stat-num small { font-size: 11px; }
.stat-num.ok { color: #52c41a; }
.stat-num.bad { color: #ff4d4f; }

/* 参数表单：每行一组，标签定宽，控件后跟灰色说明 */
.form-grid { display: flex; flex-direction: column; gap: 14px; }
.field { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; font-size: 13px; }
.field-label { flex: 0 0 76px; font-weight: 600; }
.field-hint { flex: 1 1 100%; margin-left: 84px; font-size: 12px; line-height: 1.7; }
/* 字段的第二行控件：与 field-hint 同样从标签右侧对齐 */
.field-sub { flex: 1 1 100%; margin-left: 84px; display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
/* 同一行里并排几个开关；说明藏进标签的悬停提示，行里只留名字 */
.switch-item { display: inline-flex; align-items: center; gap: 6px; margin-right: 18px; }
.switch-label { cursor: help; border-bottom: 1px dashed var(--kal-border); }
/* 级联选择器自己是 flex:1，外面包一层给它一个确定的宽度 */
.model-picker { display: flex; width: 420px; max-width: 100%; }
.field-hint.warn { color: #d48806; }
/* 地址 / Key 块里的文字按钮：去掉 link 按钮的内边距，按钮之间用 gap 隔开 */
.text-actions { display: inline-flex; align-items: center; gap: 12px; }
.text-actions :deep(.ant-btn),
.text-btn { padding: 0; height: auto; }
/* 说明文字里可点击复制的邮箱：沿用说明的颜色，悬停才显示为链接 */
/* 下划线用浅色：跟着文字色会是纯黑，太抢眼；悬停时再变成主题色 */
.copy-owner { color: inherit; border-bottom: 1px dashed var(--kal-muted); }
.copy-owner:hover { color: var(--kal-primary); border-bottom-color: var(--kal-primary); }
/*
 * 未安装提示里的「点击此处设置」：在警告色的文字里要能认出是可点的。
 * 没有 href 的 <a> 浏览器不给手型，得自己补；悬停时铺一层浅主题色底，确认是可点的。
 */
.pick-link {
  margin: 0 2px;
  padding: 0 2px;
  border-radius: 3px;
  color: var(--kal-primary);
  font-weight: 500;
  text-decoration: underline;
  text-underline-offset: 2px;
  cursor: pointer;
  transition: background-color 0.15s, color 0.15s;
}
.pick-link:hover,
.pick-link:focus-visible {
  color: var(--kal-primary);
  background: color-mix(in srgb, var(--kal-primary) 12%, transparent);
  outline: none;
}
.cd-title .mini-tag { margin-left: 6px; }

.client-group + .client-group { margin-top: 18px; padding-top: 16px; border-top: 1px solid var(--kal-border); }
.client-group-head { display: flex; align-items: baseline; gap: 8px; margin-bottom: 10px; }
.client-group-title { font-size: 13px; font-weight: 600; }
.client-group-hint { font-size: 12px; }

/* 客户端卡片：左图标右文字，圆角包裹，整块可点 */
.client-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(305px, 1fr));
  gap: 10px;
}
.client-tile {
  position: relative;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
  border: 1px solid var(--kal-border);
  border-radius: 12px;
  background: var(--kal-block-bg);
  cursor: pointer;
  transition: border-color 0.15s, box-shadow 0.15s, transform 0.15s;
}
.client-tile:hover,
.client-tile:focus-visible {
  border-color: var(--kal-primary);
  box-shadow: 0 2px 10px rgb(0 0 0 / 6%);
  outline: none;
  transform: translateY(-1px);
}
/* 已接入的用主色描边，一眼扫得出哪些通了 */
.client-tile.applied { border-color: color-mix(in srgb, #52c41a 45%, transparent); }
.client-tile.off { opacity: 0.68; }
.tile-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  width: 56px;
  height: 56px;
  border-radius: 14px;
  background: var(--kal-card-bg, rgba(255, 255, 255, 0.55));
}
/*
 * 右边这一栏占满卡片剩余宽度（flex: 1），标题和链接都按整宽排、超出省略。
 * 角标只压在第一行的右上角，所以只给标题那一行留出角标的宽度；
 * 不要给整张卡片右侧留白，否则链接那一行也会被白白吃掉一截。
 */
.tile-main { display: flex; flex: 1 1 auto; flex-direction: column; gap: 3px; min-width: 0; }
.tile-head { display: flex; align-items: center; gap: 6px; min-width: 0; padding-right: 44px; }
.tile-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 14px;
}
.listen-form { margin-top: 8px; }
.listen-hosts { display: flex; flex-direction: column; gap: 8px; }
/*
 * 状态角标贴死在卡片右上角，不留间距。
 * 定位参照的是卡片的内边距盒（在 1px 边框里面），所以 0/0 正好落在边框内侧；
 * 右上圆角取 11px = 卡片 12px 圆角减去 1px 边框，和卡片的弧线严丝合缝，
 * 左下给一个小圆角，看起来像从角上长出来的标签。
 */
.tile-badge {
  position: absolute;
  top: 0;
  right: 0;
  margin: 0;
  padding: 0 8px;
  border-radius: 0 11px 0 8px;
  font-size: 11px;
  line-height: 20px;
}
/* 必须是 block：text-overflow 在 inline-flex 上不生效，长链接会被硬切、没有省略号 */
.tile-site {
  display: block;
  min-width: 0;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--kal-muted);
  font-size: 12px;
}

/* 普通单选框，每项用圆角边框包成一块、彼此留间隔；选中项边框与底色跟随主题色 */
.boxed-radio {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 8px;
}
.boxed-radio :deep(.ant-radio-wrapper) {
  margin: 0;
  padding: 3px 12px;
  border: 1px solid var(--kal-border);
  border-radius: 6px;
  transition: border-color 0.2s, background 0.2s;
}
.boxed-radio :deep(.ant-radio-wrapper:hover) {
  border-color: var(--kal-primary);
}
.boxed-radio :deep(.ant-radio-wrapper-checked) {
  border-color: var(--kal-primary);
  background: color-mix(in srgb, var(--kal-primary) 8%, transparent);
}

/* 客户端详情弹窗 */
.client-detail { display: flex; flex-direction: column; gap: 12px; }
.cd-top { display: flex; align-items: center; gap: 10px; min-width: 0; }
.cd-top :deep(.ant-tag) { margin: 0; }
/* 官网 tag：外观交给 a-tag，这里只补可点击的手势、悬停色和长网址省略 */
.cd-site {
  cursor: pointer;
  min-width: 0;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  transition: color 0.2s;
}
.cd-site:hover { color: var(--kal-primary); }
.cd-sect { display: flex; flex-direction: column; gap: 4px; }
.cd-title { font-size: 12px; font-weight: 600; }
.cd-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 4px;
  padding-top: 12px;
  border-top: 1px solid var(--kal-border);
}
/* 重新检测放最左边，和右侧的写入 / 还原 / 打开分开：它只是查一遍，不改任何东西 */
.cd-actions .cd-recheck { margin-right: auto; }
/* ===== 写入 / 还原弹窗：尺寸与「订阅管理」保持一致 ===== */
.modal-title { display: inline-flex; align-items: center; gap: 8px; }

/* 固定高度：三个阶段（进行中 / 失败 / 成功）切换时弹窗不会先小后大跳一下 */
.modal-body { display: flex; flex-direction: column; min-height: 420px; }
/* 步骤条固定在内容区顶部，不参与下方 stage 的居中 */
.prompt-steps {
  flex: 0 0 auto;
  max-width: 560px;
  margin: 4px auto 18px;
}
.confirm-list {
  max-width: 620px;
  margin: 0;
  padding-left: 18px;
  font-size: 13px;
  line-height: 1.9;
  text-align: left;
  color: var(--kal-text, inherit);
}
/* 会动到的文件：等宽小字，长路径允许断行 */
.confirm-paths {
  width: 100%;
  max-width: 620px;
  padding: 8px 10px;
  border-radius: 6px;
  background: var(--kal-code-bg, rgba(5, 5, 5, 0.04));
  font-size: 11px;
  line-height: 1.8;
  text-align: left;
  color: var(--kal-muted);
  word-break: break-all;
}

.stage {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
}
.stage-text { font-size: 13px; text-align: center; }
/* 安装日志：等宽、限高，只作为「还在动」的证据，不要求用户细读 */
.stage-log {
  width: 100%;
  max-width: 620px;
  max-height: 150px;
  overflow: hidden;
  padding: 8px 10px;
  border-radius: 6px;
  background: var(--kal-code-bg, rgba(5, 5, 5, 0.04));
  font-size: 11px;
  line-height: 1.7;
  color: var(--kal-muted);
}
.stage-log .mono { display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.stage :deep(.ant-result) { padding: 0; }
/* 报错原文可能很长，限宽换行，别把弹窗顶宽 */
.stage :deep(.ant-result-subtitle) {
  max-width: 620px;
  margin: 0 auto;
  word-break: break-word;
}
.stage :deep(.ant-result-extra) { margin-top: 28px; }
/* 成功态里可能叠着启动命令、警告、按钮，竖排居中 */
.result-extra {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
}
.result-extra .restart-cmd { margin: 0; }
.result-extra :deep(.ant-alert) { max-width: 620px; text-align: left; }

.client-path {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 2px 6px;
  margin-top: 2px;
  font-size: 12px;
  color: var(--kal-muted);
}
.client-path .mono { word-break: break-all; }
.client-path :deep(.ant-btn-link) { padding: 0 4px; height: 20px; font-size: 12px; }

/* 日志表：留表头，去掉所有分隔线，整行可点开详情 */
.log-card :deep(.ant-card-body) { padding-top: 12px; }
.empty { padding: 18px 0; text-align: center; font-size: 13px; }
.log-table :deep(.ant-table) { background: transparent; font-size: 12px; }
.log-table :deep(.ant-table-thead > tr > th) {
  border-bottom: none;
  background: var(--kal-block-bg);
  color: var(--kal-muted);
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
}
/* 表头列之间那道竖线 */
.log-table :deep(.ant-table-thead > tr > th::before) { display: none !important; }
.log-table :deep(.ant-table-tbody > tr > td) { border-bottom: none; }
.log-table :deep(.ant-table-tbody > tr) { cursor: pointer; }
.log-table :deep(.ant-table-tbody > tr.log-tr.error > td) {
  background: color-mix(in srgb, #ff4d4f 6%, transparent);
}
.log-table :deep(.ant-table-placeholder > td) { border-bottom: none; }
.log-model { font-weight: 600; }
.log-effort { color: var(--kal-primary); font-weight: 600; }
.num { font-variant-numeric: tabular-nums; }

.usage-list { display: flex; flex-direction: column; gap: 6px; }
.usage-row { display: flex; align-items: center; gap: 12px; font-size: 12.5px; }
.usage-email { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.credit { color: var(--kal-primary); font-weight: 600; }
.warn { color: #d48806; }
.bad { color: #ff4d4f; }

/* 重启引导里的启动命令 */
.restart-cmd {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 6px;
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--kal-code-bg);
  font-size: 13px;
}
.restart-cmd .mono { flex: 1 1 auto; min-width: 0; font-weight: 600; word-break: break-all; }

.detail-block { margin-top: 14px; }
.detail-title { margin-bottom: 4px; font-size: 13px; font-weight: 600; }
.detail-line { font-size: 12px; line-height: 1.7; word-break: break-all; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
.muted { color: var(--kal-muted); }
</style>
