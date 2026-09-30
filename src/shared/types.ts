// ============================================
// 账户管理 —— 主进程 / 渲染进程共享类型
// ============================================
import { DEFAULT_REGION } from './regions'
import { DEFAULT_PORTAL_LOCALE, type PortalLocale } from './portalLocale'
import type { ModelEffort } from './modelSchema'

export type IdpType = 'BuilderId' | 'Github' | 'Google' | 'Enterprise'

/**
 * 订阅档位。不含 Enterprise —— 那是登录方式（见 IdpType），
 * 一个账号可以「订阅 Power + 用 Enterprise 登录」，两者是正交的。
 */
export type SubscriptionType =
  | 'Free'
  | 'Pro'
  | 'Pro_Plus'
  | 'Pro_Max'
  | 'Power'
  | 'Teams'
  /** 学生号：教育邮箱认证后拿到的档位，接口标题形如 KIRO STUDENT */
  | 'Student'

export type AccountStatus = 'active' | 'expired' | 'error' | 'banned' | 'unknown'

export type AuthMethod = 'IdC' | 'social'

/** 账号凭证 */
export interface AccountCredentials {
  accessToken: string
  refreshToken: string
  clientId?: string
  clientSecret?: string
  region?: string
  startUrl?: string
  /** access token 过期时间戳（ms） */
  expiresAt: number
  authMethod?: AuthMethod
  provider?: IdpType
  profileArn?: string
}

/** 奖励额度 */
export interface BonusUsage {
  code: string
  name: string
  current: number
  limit: number
  expiresAt?: string
}

/** 资源（积分）详情 */
export interface ResourceDetail {
  resourceType?: string
  displayName?: string
  displayNamePlural?: string
  currency?: string
  unit?: string
  overageRate?: number
  overageCap?: number
  overageEnabled?: boolean
}

/** 用量 / 积分 */
export interface AccountUsage {
  current: number
  limit: number
  percentUsed: number
  lastUpdated: number
  baseLimit?: number
  baseCurrent?: number
  freeTrialLimit?: number
  freeTrialCurrent?: number
  freeTrialExpiry?: string
  bonuses?: BonusUsage[]
  nextResetDate?: string
  resourceDetail?: ResourceDetail
}

/** 积分变化日志的一条记录（以账号为单位保存） */
export interface UsageHistoryEntry {
  /** 记录时间戳（ms） */
  at: number
  /** 已用积分 */
  current: number
  /** 总额度 */
  limit: number
  /** 使用占比 0-1 */
  percentUsed: number
  /** 与上一条相比的增量，第一条为 0 */
  delta: number
  baseCurrent?: number
  baseLimit?: number
  freeTrialCurrent?: number
  freeTrialLimit?: number
  /** 奖励额度合计 */
  bonusCurrent?: number
  bonusLimit?: number
}

/** 订阅 */
export interface AccountSubscription {
  type: SubscriptionType
  title?: string
  rawType?: string
  /** 下次重置时间戳（ms） */
  expiresAt?: number
  daysRemaining?: number
}

/** 可开通的订阅档位（GetAvailableSubscriptionPlans 的一条） */
export interface SubscriptionPlan {
  /** 内部名，如 KIRO_PRO_PLUS，仅作为列表 key */
  name: string
  /** 下单时要回传的订阅类型，如 Q_DEVELOPER_STANDALONE_PRO_PLUS */
  subscriptionType: string
  /** 展示名，如 KIRO PRO+ */
  title: string
  amount: number
  currency: string
  /** 计费周期文案，如 per month */
  billingInterval: string
  featureHeader: string
  features: string[]
}

/**
 * 点订阅标签后一次问到的结果。
 * 已订阅的账号能拿到 Stripe 账单管理链接；未订阅的账号拿不到（接口回 400），
 * 于是退化成「列出可开通档位」——两种情况合并成一次 IPC，省掉一轮来回。
 */
export interface SubscriptionEntry {
  /** Stripe 账单管理链接；未订阅时为空 */
  manageUrl?: string
  plans: SubscriptionPlan[]
  /** 接口给的免责声明文案 */
  disclaimer: string[]
}

/** 账号实体 */
export interface Account {
  id: string
  email: string
  password?: string
  nickname?: string
  note?: string
  idp: IdpType
  /** 所属分组 id；分组被删除后这里会被清空，界面按「未分组」处理 */
  groupId?: string
  userId?: string
  profileArn?: string
  credentials: AccountCredentials
  subscription: AccountSubscription
  usage: AccountUsage
  status: AccountStatus
  lastError?: string
  isActive: boolean
  createdAt: number
  lastUsedAt: number
  lastCheckedAt?: number
}

/**
 * 分组：用户自定义的归类标签，顺序由 order 决定（拖动排序时重写）。
 * 账号与 API Key 共用这一个结构 —— 字段完全一样，没理由拆成两份。
 */
export interface AccountGroup {
  id: string
  name: string
  /** 展示顺序，越小越靠前 */
  order: number
}

/** 持久化载荷 */
export interface AccountStoreData {
  version: number
  accounts: Account[]
  activeAccountId?: string | null
  /** 分组定义；老数据没有该字段时按空数组处理 */
  groups?: AccountGroup[]
}

/** 导出文件结构 */
export interface AccountExportData {
  app: 'kiro-account-lite'
  version: string
  exportedAt: number
  accounts: Omit<Account, 'isActive'>[]
  /**
   * 被导出账号所引用的分组定义。
   * 账号里只存 groupId，不带上定义的话恢复到另一台机器就只剩悬空 id，
   * 分组标签会全部消失。老备份没有该字段，按空处理。
   */
  groups?: AccountGroup[]
}

/** 简化导入项（卡密 / OIDC JSON / CSV） */
export interface AccountImportItem {
  email?: string
  password?: string
  refreshToken: string
  clientId?: string
  clientSecret?: string
  region?: string
  provider?: string
  nickname?: string
}

export interface BatchResult {
  success: number
  failed: number
  skipped: number
  messages: string[]
}

// ============ IPC 结果 ============

export interface IpcResult<T = undefined> {
  success: boolean
  data?: T
  error?: string
}

/** 校验/查询接口返回的账号快照 */
export interface AccountSnapshot {
  email: string
  userId?: string
  idp?: string
  accessToken?: string
  refreshToken?: string
  expiresIn?: number
  profileArn?: string
  subscription: AccountSubscription
  usage: AccountUsage
}

export interface VerifyCredentialsInput {
  refreshToken: string
  clientId?: string
  clientSecret?: string
  region?: string
  authMethod?: AuthMethod
  provider?: IdpType
  /**
   * 在线登录已经拿到真实 profileArn 时一并带上（Enterprise 尤其重要）。
   * 调用方本就在运行时传了这个字段，这里补上声明，避免校验时又去猜一遍。
   */
  profileArn?: string
}

export interface RefreshTokenResult {
  accessToken: string
  refreshToken: string
  expiresIn: number
  syncedToIde: boolean
  syncSkipReason?: string
}

/** 用账号凭证向 Kiro 控制面申请到的一个新 API Key */
export interface CreateApiKeyResult {
  /** 完整的 ksk_ 明文，取自上游 rawKey，只在创建时返回一次 */
  apiKey: string
  /** 提交时填写的名称（上游字段名为 label） */
  label: string
  /** 上游返回的 Key 标识（kskid_ 开头），用于和列表对照 */
  apiKeyId?: string
  /** 上游返回的 Key 前缀，仅用于展示 */
  keyPrefix?: string
  /** 创建时间（ms） */
  createdAt: number
  /** 实际生效的区域，决定该 Key 之后查额度用哪个端点 */
  region: string
  /** 本次调用实际使用的 profileArn */
  profileArn?: string
  /** accessToken 过期触发了刷新时带回轮换后的凭证 */
  refreshed?: RefreshTokenResult
}

/** 账号已创建的 API Key，列表接口只返回前缀 */
export interface AccountApiKeyItem {
  keyId: string
  label: string
  /** ksk_ 开头的前缀，不是可用的完整 Key */
  keyPrefix: string
  /** 创建时间（ms） */
  createdAt: number
}

export interface AccountApiKeyList {
  keys: AccountApiKeyItem[]
  region: string
  refreshed?: RefreshTokenResult
}

/** 删除某个 API Key 的结果，refreshed 用于同步刷新过的凭证 */
export interface DeleteApiKeyResult {
  keyId: string
  refreshed?: RefreshTokenResult
}

/** 在线登录拿到的原始凭证 */
export interface OnlineLoginCredentials {
  accessToken: string
  refreshToken: string
  clientId?: string
  clientSecret?: string
  region: string
  startUrl?: string
  expiresIn: number
  authMethod: AuthMethod
  provider: IdpType
  profileArn?: string
}

export type OnlineLoginMethod = 'Google' | 'Github' | 'BuilderId' | 'Enterprise'

// ============ 系统日志 ============

/** 日志级别，按严重程度升序 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export const LOG_LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error']

export interface LogEntry {
  /** 自增序号，同时用作列表 key 与增量拉取的游标 */
  id: number
  at: number
  level: LogLevel
  /** 来源分类，取自日志的 [Xxx] 前缀，如 Net / KiroApi / AutoRefresh */
  category: string
  message: string
}

/** 日志查询条件，全部为可选，未提供即不限制 */
export interface LogQuery {
  keyword?: string
  /** 命中其中任一级别；空数组或不传表示全部 */
  levels?: LogLevel[]
  category?: string
  /** 只看这个时间点之后的日志 */
  since?: number
  /** 最多返回多少条（取最新的） */
  limit?: number
}

export interface LogQueryResult {
  /** 按时间升序返回，便于界面直接追加显示 */
  entries: LogEntry[]
  /** 命中筛选的总条数（可能大于 entries.length） */
  matched: number
  /** 当前保留的日志总条数 */
  total: number
  /** 各级别条数，用于顶部徽章（不受 levels 筛选影响） */
  counts: Record<LogLevel, number>
  /** 出现过的分类，用于下拉选项 */
  categories: string[]
}

/**
 * 主进程主动续期成功后回传给渲染进程的新凭证。
 * refreshToken 是轮换式的，渲染进程必须同步内存，否则会用作废的旧值继续刷新。
 */
export interface ProactiveRenewalPayload {
  accountId: string
  accessToken: string
  refreshToken: string
  expiresIn: number
  /**
   * 新凭证是否已写进 Kiro IDE。
   * false 表示该账号已不是 IDE 当前激活账号，续期让位给渲染进程的自动刷新。
   */
  syncedToIde: boolean
}

/** 托盘菜单动作 */
export type TrayAction = 'refresh' | 'switch-next'

/** 渲染进程推送给托盘的账号摘要 */
export interface TraySnapshot {
  total: number
  /** 可切换的正常账号数 */
  switchable: number
  email?: string
  idp?: string
  subscription?: string
  status?: string
  healthy?: boolean
  usageCurrent?: number
  usageLimit?: number
  daysRemaining?: number
  tokenLife?: string
}

/** 外部浏览器打开结果 */
export interface BrowserOpenInfo {
  /** 是否真的用无痕/隐私窗口打开 */
  privateMode: boolean
  /** 实际使用的浏览器 */
  browser?: string
}

export interface BuilderIdStartInfo extends BrowserOpenInfo {
  userCode: string
  verificationUri: string
  interval: number
  expiresIn: number
}

export interface LoginPollResult {
  completed: boolean
  credentials?: OnlineLoginCredentials
  slowDown?: boolean
}

export interface SocialCallbackPayload {
  code?: string
  state?: string
  error?: string
}

export interface LocalKiroCredentials {
  accessToken: string
  refreshToken: string
  clientId: string
  clientSecret: string
  region: string
  authMethod: AuthMethod
  provider: IdpType
}

export interface SwitchAccountInput {
  accountId: string
  accessToken: string
  refreshToken: string
  clientId?: string
  clientSecret?: string
  region?: string
  startUrl?: string
  authMethod?: AuthMethod
  provider?: IdpType
  profileArn?: string
}

export interface SwitchAccountResult {
  accessToken: string
  refreshToken: string
  expiresIn: number
  tokenPath: string
  /** IdC 账号额外写入的客户端注册文件 */
  clientRegPath?: string
  /** 最终写盘的 profileArn（BuilderId 通常为空） */
  profileArn?: string
  /** 写盘后是否用该 token 实测通过了用量接口 */
  verified: boolean
  /** 校验失败时的原因，仅用于提示，不代表切号失败 */
  verifyError?: string
  /** 过程中的提示信息（如换用了哪个 profileArn、清理了几个陈旧注册文件） */
  notes?: string[]
}

/** Kiro 官方可用模型 */
export interface KiroModelInfo {
  modelId: string
  modelName?: string
  description?: string
  /** 消耗额度倍率（上游 rateMultiplier）；auto 等模型可能不返回 */
  rate?: number
  /**
   * 推理档位选项，从上游的 additionalModelRequestFieldsSchema 解析而来。
   * 只有部分模型有（Claude 系与 GPT 系），字段路径与枚举各不相同，详见 shared/modelSchema。
   */
  effort?: ModelEffort
  /**
   * 上游 tokenLimits.maxInputTokens：该模型的上下文窗口。
   * 各模型差别很大（实测 164K ~ 1M），写客户端配置时必须按模型取，不能统一写死。
   */
  maxInputTokens?: number
  /** 上游 tokenLimits.maxOutputTokens：单次输出上限（64K / 128K 两档） */
  maxOutputTokens?: number
  /** 上游 supportedInputTypes，如 ['TEXT', 'IMAGE']；/v1/models 据此给出 modalities */
  inputTypes?: string[]
  /** 上游 rateUnit，目前都是 'Credit' */
  rateUnit?: string
  /** 上游 promptCaching.supportsPromptCaching */
  promptCaching?: boolean
}

export interface ApiKeyChatTestInput {
  keyId: string
  modelId: string
  message: string
  /** 同 ChatTestInput.additionalModelRequestFields */
  additionalModelRequestFields?: Record<string, unknown>
}

/** 账号测活：发起一次真实的流式对话 */
export interface ChatTestInput {
  accountId: string
  accessToken: string
  modelId: string
  message: string
  profileArn?: string
  region?: string
  idp?: string
  /** social / IdC：决定 profileArn 兜底策略 */
  authMethod?: AuthMethod
  /**
   * 模型的额外请求字段（推理档位等），由界面按该模型的 schema 拼好。
   * 放在请求体根级；给了不支持的模型或非法值上游会 400，所以只在模型确实有这项时才传。
   */
  additionalModelRequestFields?: Record<string, unknown>
}

export interface ChatTestResult {
  endpoint: string
  text: string
  /** 首字延迟（毫秒） */
  firstByteMs: number
  totalMs: number
  /** 后端回报的实际模型，选 auto 时可看到真正被选中的那个 */
  modelId?: string
  /** 思考内容字数，推理型模型才有 */
  thinkingChars?: number
}

/** 测活过程中推送给界面的流式片段 */
export interface ChatTestChunk {
  requestId: string
  delta: string
}

/** 重启 Kiro IDE 的结果 */
export interface RestartIdeResult {
  /** 是否检测到 IDE 正在运行并成功退出 */
  quit: boolean
  /** 是否已重新拉起 IDE */
  started: boolean
  message: string
}

/** 应用与运行时信息 */
export interface AppInfo {
  version: string
  electron: string
  chrome: string
  node: string
  platform: string
  storePath: string
  backupDir: string
}

// ============================================
// 表格导出（xlsx）
// ============================================

/** 单元格取值：数字走数值格式，字符串走文本，null 留空 */
export type XlsxCellValue = string | number | null

/** 一列的表头与格式；格式按列统一应用，和界面表格的列一一对应 */
export interface XlsxColumn {
  title: string
  /** 列宽（Excel 字符宽度），不填由 Excel 默认 */
  width?: number
  /**
   * 数值呈现方式：
   * - number 普通数值，配合 decimals 控制小数位
   * - percent 百分比，值传 0-1 的小数
   * - datetime 日期时间，值传毫秒时间戳
   * - 不填按常规格式（文本原样、数字通用）
   */
  format?: 'number' | 'percent' | 'datetime'
  /** number / percent 的小数位数，默认 2 */
  decimals?: number
}

/** 导出用的单个工作表数据 */
export interface XlsxSheet {
  /** 工作表名称（Excel 限制 31 字符且不能含 : \ / ? * [ ]） */
  name: string
  columns: XlsxColumn[]
  /** 数据行，顺序与 columns 对应 */
  rows: XlsxCellValue[][]
}

/** 打包导出：把多个文本文件装进一个 zip */
export interface ExportBundle {
  files: { name: string; content: string }[]
}

// ============================================
// 常用工具：Kiro Agent 命令审批配置
// ============================================

/** 「自动同意 AI 操作（命令 / 文件 / 网络）」涉及的一种配置机制 */
export interface ShellAutoApproveTarget {
  /**
   * trustedCommands：Kiro IDE settings.json 的 kiroAgent.trustedCommands，
   *   0.x 版本命令审批的真正入口（列表含字面 "*" 即无条件放行）。
   * permissionsYaml：~/.kiro/settings/permissions.yaml，1.0+ 的权限规则表。
   */
  kind: 'trustedCommands' | 'permissionsYaml'
  label: string
  path: string
  fileExists: boolean
  /** 本应用写入的配置当前是否在位 */
  applied: boolean
  /** 该机制现在是否可写（不可写时给出 blockedReason） */
  writable: boolean
  /** 不可写原因，或需要提醒用户的说明 */
  note?: string
}

/**
 * 「自动同意 AI 操作（命令 / 文件 / 网络）」的当前状态。
 * 一律以配置文件的真实内容为准，不依赖本应用自己记录的开关值。
 */
export interface ShellAutoApproveStatus {
  /** 两种机制都已按预期写入即为开启 */
  enabled: boolean
  /** 部分机制写入成功、部分失败 */
  partial: boolean
  /** 两种机制都是热加载，正常情况下恒为 false */
  requiresRestart: boolean
  /** 是否存有开启前的原始配置，可用于精确还原 */
  hasBackup: boolean
  /** 用户自己已经配置了放行，不属于本应用，关闭开关时不会被改动 */
  externalAllow: boolean
  /** 存在优先级更高的拦截规则，会让放行失效 */
  denyConflict: boolean
  denyConflictReason?: string
  /** 完全无法自动处理时的原因 */
  blockedReason?: string
  targets: ShellAutoApproveTarget[]
}

// ============ 机器码 ============

/**
 * Kiro IDE 用到的各处设备标识。
 * 缺失（文件或键不存在）时字段为 undefined，恢复时据此删除而不是写空串。
 */
export interface MachineIdSnapshot {
  /** storage.json 的 telemetry.machineId：64 位十六进制，请求 UA 里带的就是它 */
  machineId?: string
  /** storage.json 的 telemetry.devDeviceId：UUID，是共享 deviceid 的缓存 */
  devDeviceId?: string
  /** storage.json 的 telemetry.sqmId：仅 Windows 有值，其余平台通常是空串 */
  sqmId?: string
  /** <Kiro 数据目录>/machineid 文件：UUID */
  machineIdFile?: string
  /** state.vscdb 里的 storage.serviceMachineId：UUID，设置同步用 */
  serviceMachineId?: string
  /**
   * Microsoft DeveloperTools 共享 deviceid：VS Code 系 IDE 启动时从这里读 devDeviceId。
   * macOS / Linux 是一个文件，Windows 在注册表 HKCU\SOFTWARE\Microsoft\DeveloperTools。
   */
  sharedDeviceId?: string
}

export type MachineIdField = keyof MachineIdSnapshot

/** 每个标识的存放位置，供界面展示 */
export interface MachineIdLocation {
  field: MachineIdField
  label: string
  /** 文件路径或注册表路径 */
  path: string
}

export interface MachineIdBackup {
  savedAt: number
  ids: MachineIdSnapshot
}

export interface MachineIdStatus {
  current: MachineIdSnapshot
  /** 原始机器码备份；首次重置前自动生成，之后的重置不会覆盖它 */
  backup: MachineIdBackup | null
  locations: MachineIdLocation[]
  /** 当前与备份完全一致，恢复没有意义 */
  matchesBackup: boolean
  /** 没检测到 Kiro 数据目录，说明本机没装过或没启动过 Kiro */
  kiroMissing: boolean
}

/** 重置 / 恢复的结果 */
export interface MachineIdActionResult {
  status: MachineIdStatus
  /** 操作前 IDE 在运行，已先关闭再写入 */
  ideClosed: boolean
  /** 写入后已重新拉起 IDE */
  ideRestarted: boolean
  /** 个别位置写入失败（例如 Windows 注册表无权限），其余已生效 */
  warnings: string[]
}

// ============ 本地反代 ============

/** 凭证来源：账号管理里的 OAuth 账号，或 API Key 管理里的 Kiro API Key（ksk_） */
export type ProxyAccountSource = 'account' | 'apiKey'
/**
 * 使用策略，三种都在选出的范围里按请求轮询：
 *  - roundRobin：全部可用的账号 / Key
 *  - group：指定分组里的
 *  - selected：指定的那几个（可多选）
 */
export type ProxyAccountMode = 'roundRobin' | 'group' | 'selected'
/** 上游端点：auto 先 CodeWhisperer 失败再 Amazon Q */
export type ProxyEndpoint = 'auto' | 'codewhisperer' | 'amazonq'
/**
 * 模型策略：client 用客户端请求的模型（按映射表转换）。
 * force（一律用默认模型）界面上不提供，读取配置时会被归一成 client，
 * 类型里保留只是为了能读懂旧版本存下的值。
 */
export type ProxyModelMode = 'client' | 'force'

export interface ProxyConfig {
  port: number
  /** 只监听本机；打开后才监听 0.0.0.0，局域网可访问 */
  allowLan: boolean
  /** 客户端访问反代要带的密钥（Authorization: Bearer / x-api-key） */
  apiKey: string
  /** 默认 Key 在「API Key 管理」里显示的名称 */
  defaultKeyName: string
  /** 默认 Key 的积分额度，0 为不限；用完后返回 429，和自定义 Key 一样 */
  defaultKeyCreditLimit: number
  requireApiKey: boolean
  accountSource: ProxyAccountSource
  accountMode: ProxyAccountMode
  /** 来源为账号时：group 策略选中的账号分组 */
  groupIds: string[]
  /** 来源为账号时：selected 策略选中的账号 */
  accountIds: string[]
  /** 来源为 API Key 时：group 策略选中的 Key 分组（与账号分组是两套，分开存，切换来源时互不覆盖） */
  keyGroupIds: string[]
  /** 来源为 API Key 时：selected 策略选中的 Key */
  keyIds: string[]
  defaultModel: string
  /**
   * 默认模型的推理档位（low / medium / high / xhigh / max，GPT 系另有 none）。
   * 空串表示不带该字段、用上游默认档位。取值必须在该模型 schema 的枚举里，见 shared/modelSchema。
   */
  defaultEffort: string
  modelMode: ProxyModelMode
  endpoint: ProxyEndpoint
  /**
   * 工具执行模式：开 = 反代托管执行联网搜索（给模型挂 web_search，调用时由反代打 Kiro 的搜索、结果回灌）；
   * 关 = 纯客户端执行，反代不注入、不代执行任何工具，客户端声明什么模型就只看到什么。
   * 这是我们反代里唯一一个由反代自己执行的工具，所以开关落在它身上才有实际意义。
   */
  managedToolExecution: boolean
  /** 禁用工具调用：去掉请求里全部工具定义（也不注入搜索），只剩纯对话 */
  disableTools: boolean
  /**
   * 记录日志：关掉后请求照常处理、统计照常累计，但不进请求日志、不写逐条请求的应用日志。
   * 失败告警仍然写：出了问题总得有地方能查。
   */
  logRequests: boolean
  /** 流式日志：每个请求结束后往应用日志写一行流式事件摘要（文本块、推理块、工具调用各多少），排查用 */
  logStreamEvents: boolean
  /**
   * 发往 Kiro 的请求体上限（KB）。超了先截断最旧的超长历史消息，还不够再从最旧的历史整条丢。
   * 上游对体积有硬限制，超了直接 400。
   */
  payloadLimitKB: number
  /**
   * 自动重试总开关。关闭时请求失败直接报给客户端，不重发；
   * 额度耗尽、被封、凭证失效这类「这个号本来就用不了」的仍会跳到下一个，那是选号不是重试。
   */
  retryEnabled: boolean
  /**
   * 每个账号（Key）上的重试次数：同一个号先重发这么多次，仍失败再静默换下一个号，
   * 在新号上同样最多重发这么多次，直到池子里的号都试过。0 表示不在同一个号上重发、失败即换号。
   */
  maxRetries: number
  /** 每次重发前的等待（ms） */
  retryDelayMs: number
  /** 应用启动时自动启动反代 */
  autoStart: boolean
}

export const DEFAULT_PROXY_CONFIG: ProxyConfig = {
  port: 8990,
  allowLan: false,
  apiKey: '',
  defaultKeyName: '默认',
  defaultKeyCreditLimit: 0,
  requireApiKey: true,
  accountSource: 'account',
  accountMode: 'roundRobin',
  groupIds: [],
  accountIds: [],
  keyGroupIds: [],
  keyIds: [],
  defaultModel: 'claude-sonnet-4.5',
  defaultEffort: '',
  modelMode: 'client',
  endpoint: 'auto',
  managedToolExecution: true,
  disableTools: false,
  logRequests: true,
  logStreamEvents: false,
  /*
   * 150MB，和 Kiro-account-manager 代码里实际生效的默认值一致（它的界面默认值也是这个）。
   * 这么大基本不会触发裁剪，大图片、长上下文原样发给上游；
   * 真遇到上游因体积 400，再调小（900KB 是实测一直稳定的保守值）。
   */
  payloadLimitKB: 153_600,
  retryEnabled: true,
  maxRetries: 3,
  retryDelayMs: 500,
  autoStart: false
}

/** 载荷上限的可调范围（KB）：太小连系统提示都放不下，太大上游一样会拒 */
export const PAYLOAD_LIMIT_MIN_KB = 256
export const PAYLOAD_LIMIT_MAX_KB = 204_800

export interface ProxyStatus {
  running: boolean
  port: number
  /** 给客户端用的根地址，如 http://127.0.0.1:8990 */
  baseUrl: string
  startedAt?: number
  error?: string
  requests: number
  succeeded: number
  failed: number
  credits: number
  /** 成功请求的输入 / 输出 token 累计；界面上的「消耗 Tokens」是两者之和 */
  inputTokens: number
  outputTokens: number
}

export type ProxyProtocol = 'anthropic' | 'openai' | 'responses' | 'gemini'

/** 一条请求日志；流式期间会多次推送同一 id 的更新 */
/** 请求输入里出现的内容类型 */
export type ProxyInputType = 'text' | 'image' | 'toolResult'

/** 模型输出里出现的内容类型；webSearch 是反代代为执行的搜索 */
export type ProxyOutputType = 'text' | 'thinking' | 'toolUse' | 'webSearch'

export interface ProxyLogEntry {
  id: number
  at: number
  protocol: ProxyProtocol
  path: string
  stream: boolean
  /** 客户端请求的模型 */
  model: string
  /** 实际发给 Kiro 的模型 */
  kiroModel: string
  /** 实际使用的推理档位；没带该字段（用上游默认）时为空 */
  effort?: string
  accountId?: string
  accountEmail?: string
  /** 客户端用的是哪个反代 API Key（名称）；关掉校验且没带 Key 时为空 */
  keyName?: string
  /** 客户端带来的完整 Key 值：详情里要能认出、复制实际用的是哪串，名称可能被改过或重名 */
  keyValue?: string
  state: 'pending' | 'streaming' | 'success' | 'error'
  httpStatus?: number
  /** 总尝试次数（含首次） */
  attempts: number
  durationMs?: number
  firstTokenMs?: number
  inputTokens?: number
  outputTokens?: number
  /** 服务端 meteringEvent 给出的积分消耗 */
  credits?: number
  toolCalls?: number
  /** 反代代为执行的联网搜索次数（Codex 的 web_search 是托管工具，由反代自己搜） */
  webSearches?: number
  /**
   * 这一轮客户端发来的内容类型（取最后一条 user 消息）。
   * 只记类型不记内容：源码、密钥这些不该因为一条日志落到本地磁盘上。
   */
  inputTypes: ProxyInputType[]
  /** 模型这一轮产出的内容类型 */
  outputTypes: ProxyOutputType[]
  error?: string
  /** 重试过程说明，如「账号 A 403，换账号 B」 */
  retries: string[]
}

// ============ 反代的多 API Key ============

/** 默认 Key 在列表与用量里用的固定 id；它的明文存在 ProxyConfig.apiKey */
export const PROXY_DEFAULT_KEY_ID = 'default'

/**
 * 自定义的反代 API Key。
 *
 * 和 ProxyConfig.apiKey（默认 Key）的分工：默认 Key 是「一键写入」写进各客户端的那一个，
 * 自定义 Key 用来分给别的工具 / 别人，各自限额、各自统计。
 */
export interface ProxyApiKey {
  id: string
  name: string
  /** 明文。只存在本机加密的 electron-store 里，所以列表里可以随时查看与复制 */
  key: string
  /** 积分额度上限；0 表示不限 */
  creditLimit: number
  /** 停用后请求一律 401，但保留统计 */
  enabled: boolean
  createdAt: number
  /** 默认 Key 为 true：不能删除、不设额度 */
  isDefault?: boolean
}

/** 一组累计量 */
export interface ProxyKeyStats {
  requests: number
  failed: number
  credits: number
  inputTokens: number
  outputTokens: number
}

/** 一条用量明细 */
export interface ProxyKeyUsageRecord {
  at: number
  model: string
  protocol: ProxyProtocol
  ok: boolean
  credits: number
  inputTokens: number
  outputTokens: number
  durationMs: number
}

/** 某个 Key 的完整用量 */
export interface ProxyKeyUsage {
  keyId: string
  total: ProxyKeyStats
  /** 按实际发给 Kiro 的模型汇总 */
  byModel: Record<string, ProxyKeyStats>
  /** 按本地日期（YYYY-MM-DD）汇总，画每日折线用 */
  byDay: Record<string, ProxyKeyStats>
  /** 最近的明细，新的在前，有上限 */
  recent: ProxyKeyUsageRecord[]
  lastUsedAt?: number
}

/** 列表里的一行：Key 本身 + 总计，不带明细，避免列表一刷就搬几千条记录过 IPC */
export interface ProxyApiKeyView extends ProxyApiKey {
  total: ProxyKeyStats
  lastUsedAt?: number
}

/** 按账号累计的反代用量，持久化 */
export interface ProxyAccountUsage {
  accountId: string
  email: string
  requests: number
  failed: number
  credits: number
  lastUsedAt: number
  /** 以下三项可选：旧版本存下的用量没有它们，读的时候按 0 算 */
  inputTokens?: number
  outputTokens?: number
  /** 所有请求的耗时之和，/admin/stats 用它算平均响应时间 */
  totalResponseMs?: number
}

/**
 * 从账号拉回来的模型列表缓存。
 * 反代的 /v1/models、模型映射、Codex 模型目录、界面下拉都以它为准，不要写死。
 */
export interface ProxyModelCache {
  models: KiroModelInfo[]
  fetchedAt: number
  /** 用哪个账号拉的；不同账号（订阅档位）能用的模型可能不同 */
  accountId: string
  accountEmail: string
}

/**
 * 可一键接入的桌面 agent。
 * codex 是命令行版（走独立 profile），codexApp 是桌面版（只认全局默认 provider）。
 * cursor 不写入文件（它的配置在 UI 里手动填），只提供复制信息的卡片。
 */
export type ProxyClientTarget =
  | 'claudeCode'
  | 'claudeApp'
  | 'codex'
  | 'codexApp'
  | 'cursor'
  | 'vscode'
  /** DeepSeek Harness 命令行版（dsh web），用我们自己的 profile */
  | 'deepseek'
  /** DeepSeek Harness 桌面版，读的是它固定的 desktop profile */
  | 'deepseekApp'
  /** 腾讯 WorkBuddy 桌面版，读 ~/.workbuddy/models.json 里的自定义模型 */
  | 'workbuddy'

export interface ProxyClientState {
  target: ProxyClientTarget
  /** 配置文件路径（多个时用换行连接） */
  paths: string[]
  /** 目标应用当前是否在运行：决定按钮显示「重启」还是「打开」 */
  appRunning?: boolean
  /** 本机是否装了这个客户端。没装时禁掉写入，免得给不存在的客户端造配置文件 */
  installed: boolean
  /** 检测到的安装位置（macOS 图形应用是 .app，Windows 是 exe，命令行版是可执行文件） */
  installPath?: string
  /** 安装位置是用户手动指定的 */
  customPath?: boolean
  /** 已写入本应用的配置 */
  applied: boolean
  /** 有写入前的原始备份，可以还原 */
  hasBackup: boolean
  /** 写入后要用的启动命令，为空表示无需额外参数 */
  command?: string
  /** 检测到的隐患，例如全局配置被别的工具改过 */
  warning?: string
}

// ============ 网络检测 ============

/** 当前出口 IP 信息；请求走应用的代理设置，反映的是 Kiro 请求实际的出口 */
export interface IpInfo {
  ip: string
  country?: string
  countryCode?: string
  region?: string
  city?: string
  /** 运营商 / 机房，如 AS13335 Cloudflare */
  org?: string
  timezone?: string
  /** 数据来源，便于用户判断可信度 */
  source: string
}

/** 网站连通性测试目标；具体地址由主进程决定，渲染层只传标识 */
export type SiteTestId = 'github' | 'google' | 'youtube' | 'kiro' | 'amazon'

export interface SiteTestResult {
  id: SiteTestId
  url: string
  /** 收到任何 HTTP 响应都算连通（403 / 429 也说明网络是通的） */
  ok: boolean
  status?: number
  /** 从发起请求到收到响应头的耗时 */
  latencyMs?: number
  error?: string
}

/** GitHub Release 检查更新结果 */
export interface UpdateCheckResult {
  /** 当前运行版本，如 1.0.3 */
  current: string
  /** 远端最新版本，已去掉 tag 前缀 v */
  latest: string
  /** 远端版本高于当前版本 */
  hasUpdate: boolean
  /** Release 页面地址，用于「前往更新」 */
  releaseUrl: string
  /** Release 名称，缺失时回退成 tag */
  name: string
  /** Release 正文（更新说明），可能为空 */
  notes: string
  /** 发布时间 ISO 字符串，可能为空 */
  publishedAt: string
}

/**
 * 账号列表的展示形态。
 * card：完整卡片（用量 + 额度明细）；
 * compact：卡片去掉额度明细那一块，一屏能多放几行；
 * list：一排一个的横向长条，信息压到一行里。
 */
export type AccountDisplayMode = 'card' | 'compact' | 'list'

/**
 * 账号导出格式，取值与 renderer/utils/transfer 的 ExportFormat 一致。
 * 放在 shared 里是为了把「上次选的格式」持久化进设置。
 */
export type AccountExportFormat = 'json' | 'oidc' | 'kami' | 'csv' | 'txt' | 'clipboard'

export interface AppSettings {
  /** 主题色 */
  primaryColor: string
  darkMode: boolean
  /**
   * 全局控件尺寸。
   * large 是本应用一直以来的默认观感（按钮、输入框都偏大，信息密度低但好点）；
   * default 是 Ant Design 原生尺寸，一屏能放下更多内容。
   */
  componentSize: 'default' | 'large'
  /** 账号列表的展示形态，见 AccountDisplayMode */
  accountDisplayMode: AccountDisplayMode
  /** API Key 列表的展示形态，与账号各记一份，两边可以不一样 */
  keyDisplayMode: AccountDisplayMode
  /**
   * 导出账号时上次选择的格式，下次打开导出弹窗默认选中它。
   * 取值不在当前支持列表里（旧版本遗留）时回落到第一项。
   */
  accountExportFormat: AccountExportFormat
  /** 侧栏折叠 */
  sidebarCollapsed: boolean
  /** 隐私打码：列表与详情中隐藏邮箱、昵称等隐私信息 */
  privacyMode: boolean
  /** 显示两位小数积分 */
  usagePrecision: boolean
  /** 在线登录默认用无痕窗口打开 */
  loginPrivateMode: boolean
  /** 记住上次填写的 Enterprise SSO 地址与区域 */
  enterpriseStartUrl: string
  enterpriseRegion: string
  /** 自动刷新 token */
  autoRefresh: boolean
  /** 自动刷新积分用量：按下面的检查间隔与批量并发，定期拉取账号的用量与订阅 */
  autoRefreshUsage: boolean
  /** 密钥刷新间隔（分钟） */
  keyRefreshInterval: number
  /** 用量刷新间隔（分钟） */
  usageRefreshInterval: number
  /** 批量并发 */
  concurrency: number
  /** 用量接口类型 */
  usageApiType: 'rest' | 'cbor'
  /**
   * 批量导入时同时校验的账号数量。导入几千条时靠这个并发池分批处理，
   * 避免一次性发起全部请求把内存和接口打满。
   */
  importConcurrency: number
  /** 网络代理 */
  proxyEnabled: boolean
  proxyUrl: string
  /** 删除前二次确认 */
  confirmBeforeDelete: boolean
  /** 自动刷新 API Key 的订阅与积分用量 */
  autoRefreshApiKeyUsage: boolean
  /** API Key 用量刷新间隔（分钟） */
  apiKeyUsageRefreshInterval: number
  /** API Key 批量同步并发数 */
  apiKeyRefreshConcurrency: number
  /** 删除 API Key 前二次确认 */
  confirmBeforeDeleteApiKey: boolean
  /**
   * 导出成功后是否在文件管理器里定位该文件。
   * 导出的多是凭证类文件，用户下一步基本都要去拿它，所以默认打开；
   * 批量连续导出时反复弹窗反而干扰，故留出关闭的余地。
   */
  revealExportedFile: boolean
  /** 启用系统托盘 */
  trayEnabled: boolean
  /** 点击窗口关闭按钮时的行为：每次询问 / 最小化到托盘 / 直接退出 */
  closeAction: 'ask' | 'minimize' | 'quit'
  /**
   * IDE 主动续期：开启后账号管理器会在 IDE 当前激活账号的 token 剩 ~15 分钟时
   * 抢先 refresh 并写盘，让 Kiro IDE 永远拿到剩余时间充足的 token，
   * IDE 内部 refresh loop 不会触发，彻底消除双方同时 refresh 撞车的可能。
   */
  proactiveRenewalEnabled: boolean
  /**
   * 网关遇到可恢复错误时自动续接：开启后本地网关碰到指定状态码会自己退避重发，
   * 不把错误抛给 Kiro IDE，对话不会中断、不需要用户手动点继续。
   *
   * 始终使用同一个 Key，不会替换成别的 Key。
   */
  gatewayAutoRetryThrottle: boolean
  /**
   * 哪些 HTTP 状态码触发自动重试，取值见 shared/retryPolicy 的 RETRYABLE_STATUS_OPTIONS。
   *
   * 只能是错误状态码：2xx 一旦开始流式输出就已经有内容写给 IDE，无法重放。
   * 即使勾选了 402 / 429，若响应里的 reason 表明是本周期额度用尽，仍会直接透传——
   * 那种情况重试 100% 失败，只会白等。
   */
  gatewayRetryStatuses: number[]
  /** 单个请求最多尝试几次（含首次），超过就把错误透传给 IDE */
  gatewayRetryMaxAttempts: number
  /** 两次尝试之间的固定间隔（ms） */
  gatewayRetryDelayMs: number
  /**
   * 内置浏览器（前往官网）访问 Kiro 网页端时使用的地区。
   *
   * 同时决定 Accept-Language 请求头与 Chromium 的界面区域，
   * 后者影响页面里 navigator.language 读到的值——门户按前端语言判断时只有它管用。
   */
  portalLocale: PortalLocale
}

export const DEFAULT_SETTINGS: AppSettings = {
  primaryColor: '#7c3aed',
  darkMode: false,
  // 保持既有观感：老用户升级上来不会突然变小
  componentSize: 'large',
  accountDisplayMode: 'card',
  keyDisplayMode: 'card',
  accountExportFormat: 'json',
  sidebarCollapsed: false,
  privacyMode: false,
  usagePrecision: false,
  loginPrivateMode: false,
  enterpriseStartUrl: '',
  enterpriseRegion: DEFAULT_REGION,
  autoRefresh: true,
  autoRefreshUsage: true,
  keyRefreshInterval: 5,
  usageRefreshInterval: 5,
  concurrency: 5,
  usageApiType: 'rest',
  importConcurrency: 50,
  proxyEnabled: false,
  proxyUrl: '',
  confirmBeforeDelete: true,
  autoRefreshApiKeyUsage: true,
  apiKeyUsageRefreshInterval: 5,
  apiKeyRefreshConcurrency: 5,
  confirmBeforeDeleteApiKey: true,
  revealExportedFile: true,
  trayEnabled: true,
  closeAction: 'minimize',
  proactiveRenewalEnabled: true,
  // 默认关闭：自动重试会让请求看起来变慢，且可能掩盖真实的限流问题，交给用户显式开启
  gatewayAutoRetryThrottle: false,
  // 默认只勾选纯粹的临时性故障：限流与服务端 5xx。402 / 403 这类要用户自己决定
  gatewayRetryStatuses: [429, 500, 502, 503, 504],
  // 固定间隔重试，10 次也只多花 1 秒左右，对话不会有明显卡顿
  gatewayRetryMaxAttempts: 10,
  gatewayRetryDelayMs: 100,
  portalLocale: DEFAULT_PORTAL_LOCALE
}

// ============================================
// Key 管理（Kiro API Key / ksk_ 网关）
// ============================================

/**
 * 一条 Kiro API Key（ksk_ 开头）。
 * 除密钥本身外，缓存一份最近查询到的订阅 / 积分信息，用于列表展示，
 * 不必每次进页面都重新拉取。
 */
export interface KeyEntry {
  id: string
  /** 完整密钥，ksk_ 开头 */
  key: string
  note?: string
  /** 所属分组 id，未分组时不存该字段；分组被删除时由主进程清掉 */
  groupId?: string
  /**
   * 该 Key 所属 AWS 区域。不同 Key 可能来自不同区域，
   * 查询额度与网关转发都按各自的区域走。旧数据由 store 迁移时补齐。
   */
  region: string
  /** 该 Key 绑定的注册邮箱，同步时从上游查回；上游未返回则为空 */
  email?: string
  /** 账号唯一标识，形如 d-<目录ID>.<用户UUID> */
  userId?: string
  createdAt: number
  /** 最近一次查询到的订阅名称，如 Kiro Pro */
  subscription?: string
  /**
   * 订阅粗分层：free / pro / pro+ / power / other。
   * 渲染层的档位判定与筛选统一走 shared/subscription 的 normalizeSubscriptionType(subscription)，
   * 这个字段只作为历史数据保留。
   */
  tier?: string
  /** 额度下次重置时间戳（ms），用于算剩余天数 */
  nextResetAt?: number
  /** 已用积分 */
  usedCredits?: number
  /** 总积分额度 */
  totalCredits?: number
  /** 最近一次成功查询时间戳（ms） */
  lastCheckedAt?: number
  /** 最近一次查询的错误信息 */
  lastError?: string
  /**
   * 最近一次真实对话测活失败的原因。
   *
   * 必须与 lastError 分开存：管理面的 Get-Usage-Limits 不校验账号状态，
   * 被封禁的 Key 在那里照样返回 200，而 syncKey 成功后会清空 lastError。
   * 若共用一个字段，测活查出来的 403 会被下一轮自动刷新擦掉。
   */
  lastChatError?: string
  /** 最近一次真实对话测活的时间戳（ms） */
  lastChatCheckedAt?: number
}

/** API Key 的检查状态，与账号的 AccountStatus 不同：Key 只关心「查得通不通」 */
export type KeyStatus = 'normal' | 'error' | 'unchecked'

/** API Key 列表的筛选条件 */
export interface KeyFilter {
  /** 订阅档位，判定口径与账号一致（见 shared/subscription） */
  subscriptions: SubscriptionType[]
  statuses: KeyStatus[]
  /** 按分组筛选，可多选；「未分组」用 UNGROUPED 哨兵值参与 */
  groupIds: string[]
  /** 用量占比下限（0-1） */
  usageMin?: number
  /** 用量占比上限（0-1） */
  usageMax?: number
  /** 额度重置剩余天数下限（含） */
  daysRemainingMin?: number
  /** 额度重置剩余天数上限（含） */
  daysRemainingMax?: number
  /**
   * 导入时间（createdAt）范围，含两端，单位毫秒，精度到秒。
   * 只选日期不碰时间时，界面会补成起点 00:00:00 / 终点 23:59:59。
   */
  createdFrom?: number
  createdTo?: number
}

/** Key 网关持久化数据 */
export interface KeyGatewayData {
  version: number
  keys: KeyEntry[]
  /** 分组定义；老数据没有该字段时按空数组处理 */
  groups?: AccountGroup[]
  /** 当前激活（用于连接）的 key id */
  activeKeyId?: string | null
  /** 总开关：开启后接管 Kiro IDE 内置对话 */
  enabled: boolean
  /**
   * 新增 Key 时的默认区域，仅作为添加 / 导入弹窗的预填值。
   * 真正生效的区域记录在每个 KeyEntry.region 上。
   */
  region: string
  /** 本地代理端口，默认 KRS 19830 / CPS 19831 */
  ports: { krs: number; cps: number }
  /** 开启接管前的端点原值；关闭或异常退出时原样恢复 */
  originalEndpoints?: {
    krs: { region: string; endpoint: string }[]
    cps: { region: string; endpoint: string }[]
  }
  /** 本次接管实际改写的 settings.json */
  settingsPath?: string
}

export const DEFAULT_KEY_GATEWAY_DATA: KeyGatewayData = {
  version: 1,
  keys: [],
  activeKeyId: null,
  enabled: false,
  region: 'us-east-1',
  ports: { krs: 19830, cps: 19831 }
}

/** 单个模型信息（Key 网关测活返回） */
export interface KeyModelInfo {
  id: string
  name?: string
  rate?: number
  /** 推理档位选项，来源同 KiroModelInfo.effort */
  effort?: ModelEffort
}

/** 测试一个 API Key 的结果 */
export interface KeyTestResult {
  modelCount: number
  defaultModel: string
  subscription: string
  tier: string
  used: number | null
  total: number | null
  models: KeyModelInfo[]
}

/**
 * 开启网关前检测到的接管冲突：Kiro IDE 的端点已经指向别的本地网关。
 * 结构化返回冲突端点与端口，界面才能给出「强制接管」而不是只报错。
 */
export interface KeyGatewayConflict {
  /** 面向用户的说明文案 */
  message: string
  /** 冲突的本地端点，如 http://127.0.0.1:19820 */
  endpoints: string[]
  /** 冲突端点对应的本地端口，用于强制接管时释放 */
  ports: number[]
}

/** 强制接管时对单个冲突端口的处理结果 */
export interface KeyGatewayReleaseResult {
  port: number
  /** 该端口上监听的进程（不含本应用自身） */
  pids: number[]
  /** 端口是否已不再被其它进程占用 */
  stopped: boolean
  message: string
}

/** 应用当前网关状态后回传给渲染进程的运行时信息 */
export interface KeyGatewayStatus {
  enabled: boolean
  /** 两个本地代理是否都已监听并通过健康检查 */
  running: boolean
  /** 已选择、下一次网关请求将使用的 Key；不代表最近实际使用 */
  activeKeyId: string | null
  /** 当前网关会话最近一次真实转发所使用的 Key */
  lastForwardedKeyId: string | null
  /** 最近一次真实转发准备发送到上游的时间戳（ms） */
  lastForwardedAt?: number
  /** 最近实际使用的 Key 是否来自当前已接管的网关运行会话 */
  observedInCurrentSession: boolean
  /**
   * IDE 的 AI 请求是否确实由本网关接管。
   * 磁盘端点已绑定，或本次网关会话近期有过真实转发（IDE 进程内存里仍持有本地端点）。
   * 判定接管请用这个字段，而不是单看 endpointsBound。
   */
  ideTakenOver: boolean
  /**
   * 接管中但磁盘端点已被外部改写（典型为 Kiro IDE 启动时按自身内存回写清空）。
   * 端点守护会自动改回，持续为真说明守护没能生效，IDE 重启后接管会失效。
   */
  endpointsHijacked: boolean
  /** 当前 Key 的区域，也是网关转发实际使用的区域；未选择 Key 时为默认区域 */
  region: string
  ports: { krs: number; cps: number }
  /** settings.json 端点是否已成功指向本地代理 */
  endpointsBound: boolean
  /** 是否需要重启 / 重载 Kiro IDE 才能生效 */
  needRestart: boolean
  /** Kiro IDE settings.json 路径（用于提示） */
  settingsPath?: string
  /** 过程中的说明信息 */
  message?: string
}

/**
 * 单个 API Key 经本地网关产生的实际调用统计。
 *
 * 全部来自网关对真实请求的观测：请求数与状态码由转发层计数，
 * 积分消耗来自响应流里的 MeteringEvent（服务端权威值，Kiro 的计费口径）。
 * 不统计 token——该协议的响应流里不带 tokenUsage，拿不到有效数据。
 */
/**
 * 网关调用的一条时间序列记录，按分钟聚合。
 * 逐请求存会让长期使用后记录数爆炸，按分钟桶聚合足够画曲线。
 */
export interface GatewayCallPoint {
  /** 该分钟桶的起始时间戳（ms） */
  at: number
  /** 该分钟内的对话请求数 */
  requests: number
  /** 其中成功的次数 */
  succeeded: number
  /** 该分钟内消耗的积分 */
  credits: number
}

export interface KeyGatewayUsageStats {
  /** 对话请求数（generateAssistantResponse），即用户理解的「发了几次对话」 */
  requests: number
  /** 对话请求里的 2xx 响应数 */
  succeeded: number
  /** 对话请求里的非 2xx 响应数（含网络异常） */
  failed: number
  /**
   * 辅助请求总数与失败数：/mcp、模型列表、用量查询这些。
   * 单独统计是因为 /mcp 在 API Key 鉴权下稳定返回 403，
   * 混进成功率会让「对话其实全部成功」显示成 40% 这类误导数字。
   */
  auxRequests: number
  auxFailed: number
  /** 最近一分钟的请求数，即当前 RPM。只在内存中统计，重启后重新计算 */
  rpm: number
  /** MeteringEvent 累计计费用量，即积分消耗 */
  metered: number
  /** 计费单位，来自 MeteringEvent.unitPlural／unit，实测为 credits */
  meteredUnit?: string
  /** 最近一次对话请求的时间戳（ms） */
  lastRequestAt?: number
}

/**
 * 当前安装的 Kiro IDE 是否支持 API Key 网关接管。
 * 判据是扩展 dist 里是否读取 krsEndpoints / cpsEndpoints，而非版本号比较。
 */
export interface KiroCapability {
  /** Kiro 安装目录下的 resources/app；没找到时为 undefined */
  appRoot?: string
  /** product.json 里的 IDE 版本 */
  version?: string
  /** kiro-agent 扩展版本 */
  agentVersion?: string
  /** IDE 是否会读取 krsEndpoints / cpsEndpoints，即能否被本应用接管 */
  supportsKeyGateway: boolean
  /** 判定依据说明，用于日志与界面提示 */
  reason?: string
}
