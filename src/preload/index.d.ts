import type {
  Account,
  AccountApiKeyList,
  AccountGroup,
  AccountSnapshot,
  AccountStoreData,
  AccountUsage,
  ApiKeyChatTestInput,
  AppInfo,
  AppSettings,
  AuthMethod,
  BackupScheduleStatus,
  DataBackupSummary,
  BrowserOpenInfo,
  BuilderIdStartInfo,
  ChatTestChunk,
  ChatTestInput,
  ChatTestResult,
  CreateApiKeyResult,
  DeleteApiKeyResult,
  ExportBundle,
  IpcResult,
  KeyGatewayConflict,
  KeyGatewayData,
  GatewayCallPoint,
  KeyGatewayStatus,
  KeyGatewayUsageStats,
  KiroCapability,
  KeyModelInfo,
  KeyTestResult,
  KiroModelInfo,
  LocalKiroCredentials,
  LoginPollResult,
  OnlineLoginCredentials,
  RefreshTokenResult,
  RestartIdeResult,
  IpInfo,
  MachineIdActionResult,
  MachineIdField,
  MachineIdStatus,
  ProxyAccountUsage,
  ProxyApiKeyView,
  ProxyClientState,
  ProxyClientTarget,
  ProxyConfig,
  ProxyKeyUsage,
  ProxyLogEntry,
  ProxyModelCache,
  ProxyStatus,
  SiteTestId,
  SiteTestResult,
  ShellAutoApproveStatus,
  ShellAutoApproveTarget,
  SocialCallbackPayload,
  LogQuery,
  LogQueryResult,
  ProactiveRenewalPayload,
  SubscriptionEntry,
  SwitchAccountInput,
  SwitchAccountResult,
  TrayAction,
  TraySnapshot,
  UpdateCheckResult,
  UsageHistoryEntry,
  VerifyCredentialsInput,
  XlsxSheet
} from '../shared/types'

export interface KiroActiveToken {
  refreshToken: string
  accessToken: string
  expiresAt: string
  authMethod?: string
  provider?: string
}

export interface Api {
  md5: (text: string) => string

  loadAccounts: () => Promise<IpcResult<AccountStoreData>>
  saveAccounts: (data: AccountStoreData) => Promise<IpcResult>
  deleteAccounts: (ids: string[]) => Promise<IpcResult<{
    accounts: AccountStoreData
    removed: number
  }>>

  loadKeys: () => Promise<IpcResult<KeyGatewayData>>
  addKey: (key: string, note?: string, region?: string) => Promise<IpcResult<KeyGatewayData>>
  importKeys: (text: string, region?: string) => Promise<IpcResult<{
    data: KeyGatewayData
    added: number
    skipped: number
    invalid: number
  }>>
  updateKey: (id: string, note: string) => Promise<IpcResult<KeyGatewayData>>
  /** 批量覆盖备注，留空即清空 */
  setKeysNote: (ids: string[], note: string) => Promise<IpcResult<KeyGatewayData>>
  /** 整表替换分组定义（新建 / 改名 / 删除 / 排序共用），顺带清掉悬空的 groupId */
  setKeyGroups: (groups: AccountGroup[]) => Promise<IpcResult<KeyGatewayData>>
  /** 批量设置分组，groupId 传 null 表示移出分组 */
  setKeysGroup: (ids: string[], groupId: string | null) => Promise<IpcResult<KeyGatewayData>>
  /** 修改单个 Key 的区域 */
  setKeyRegion: (
    id: string,
    region: string
  ) => Promise<IpcResult<{ data: KeyGatewayData; status: KeyGatewayStatus }>>
  deleteKey: (id: string) => Promise<IpcResult<KeyGatewayData>>
  selectKey: (id: string | null) => Promise<IpcResult<{ data: KeyGatewayData; status: KeyGatewayStatus }>>
  testKey: (id: string) => Promise<IpcResult<KeyTestResult>>
  listKeyModels: (id: string) => Promise<IpcResult<KeyModelInfo[]>>
  syncKey: (id: string) => Promise<IpcResult<KeyGatewayData>>
  syncAllKeys: (concurrency?: number) => Promise<IpcResult<{
    data: KeyGatewayData
    success: number
    failed: number
    /** 因凭证确定性失效而被跳过的 Key 数量 */
    skipped: number
  }>>
  getKeyGatewayStatus: () => Promise<IpcResult<KeyGatewayStatus>>
  /** 探测当前 Kiro 是否支持 API Key 网关接管 */
  getKiroCapability: () => Promise<IpcResult<KiroCapability>>
  /** 各 Key 经网关产生的真实调用统计，按 keyId 索引 */
  getKeyGatewayStats: () => Promise<IpcResult<Record<string, KeyGatewayUsageStats>>>
  resetKeyGatewayStats: (
    keyId?: string
  ) => Promise<IpcResult<Record<string, KeyGatewayUsageStats>>>
  /** 某个 Key 的网关调用历史，按分钟聚合，用于画曲线 */
  getKeyGatewayHistory: (keyId: string) => Promise<IpcResult<GatewayCallPoint[]>>
  inspectKeyGatewayConflict: () => Promise<IpcResult<KeyGatewayConflict | null>>
  enableKeyGateway: (keyId?: string, force?: boolean) => Promise<IpcResult<KeyGatewayStatus>>
  disableKeyGateway: () => Promise<IpcResult<KeyGatewayStatus>>
  configureKeyGateway: (input: {
    ports?: { krs: number; cps: number }
  }) => Promise<IpcResult<{ data: KeyGatewayData; status: KeyGatewayStatus }>>
  onKeyGatewayChanged: (handler: (status: KeyGatewayStatus) => void) => () => void

  verifyCredentials: (input: VerifyCredentialsInput) => Promise<IpcResult<AccountSnapshot>>
  refreshAccountToken: (account: Account) => Promise<IpcResult<RefreshTokenResult>>
  checkAccountStatus: (
    account: Account
  ) => Promise<IpcResult<AccountSnapshot> & { banned?: boolean }>
  /** 用账号凭证生成一个新的 Kiro API Key，label 为密钥名称 */
  createAccountApiKey: (
    account: Account,
    label: string
  ) => Promise<IpcResult<CreateApiKeyResult>>
  /** 列出该账号已创建的 API Key */
  listAccountApiKeys: (account: Account) => Promise<IpcResult<AccountApiKeyList>>
  /** 删除该账号的一个 API Key */
  deleteAccountApiKey: (
    account: Account,
    keyId: string
  ) => Promise<IpcResult<DeleteApiKeyResult>>
  /** 用该账号凭证在私密窗口打开 Kiro 官网后台 */
  openAccountPortal: (account: Account) => Promise<IpcResult<{ url: string }>>
  /** 查订阅入口：已订阅返回 Stripe 账单管理链接，未订阅返回可开通档位 */
  getSubscriptionEntry: (account: Account) => Promise<IpcResult<SubscriptionEntry>>
  /** 为指定档位生成 Stripe 结算链接 */
  createSubscriptionCheckout: (
    account: Account,
    subscriptionType: string
  ) => Promise<IpcResult<{ url: string }>>
  /** 用内置浏览器打开链接 */
  openInAppBrowser: (url: string, title?: string) => Promise<IpcResult<{ url: string }>>

  readLocalKiroCredentials: () => Promise<IpcResult<LocalKiroCredentials>>
  getActiveKiroToken: () => Promise<IpcResult<KiroActiveToken>>
  switchAccount: (input: SwitchAccountInput) => Promise<IpcResult<SwitchAccountResult>>
  restartKiroIde: () => Promise<IpcResult<RestartIdeResult>>
  logoutKiro: () => Promise<IpcResult<{ deleted: number }>>

  getUsageHistory: (accountId: string) => Promise<IpcResult<UsageHistoryEntry[]>>
  recordUsagePoint: (
    accountId: string,
    usage: AccountUsage
  ) => Promise<IpcResult<{ recorded: boolean }>>
  clearUsageHistory: (accountId: string) => Promise<IpcResult<{ cleared: number }>>

  listKiroModels: (input: {
    accessToken: string
    profileArn?: string
    region?: string
    idp?: string
    authMethod?: AuthMethod
  }) => Promise<IpcResult<KiroModelInfo[]>>
  chatTest: (requestId: string, input: ChatTestInput) => Promise<IpcResult<ChatTestResult>>
  cancelChatTest: (requestId: string) => Promise<IpcResult>
  onChatChunk: (handler: (payload: ChatTestChunk) => void) => () => void
  keyChatTest: (
    requestId: string,
    input: ApiKeyChatTestInput
  ) => Promise<IpcResult<ChatTestResult>>
  cancelKeyChatTest: (requestId: string) => Promise<IpcResult>
  onKeyChatChunk: (handler: (payload: ChatTestChunk) => void) => () => void

  startBuilderIdLogin: (
    region?: string,
    privateMode?: boolean
  ) => Promise<IpcResult<BuilderIdStartInfo>>
  pollBuilderIdLogin: () => Promise<IpcResult<LoginPollResult>>
  startSocialLogin: (
    provider: 'Google' | 'Github',
    privateMode?: boolean
  ) => Promise<IpcResult<BrowserOpenInfo & { loginUrl: string }>>
  completeSocialLogin: (
    code: string,
    state: string
  ) => Promise<IpcResult<OnlineLoginCredentials>>
  startEnterpriseLogin: (
    startUrl: string,
    region?: string,
    privateMode?: boolean
  ) => Promise<IpcResult<BrowserOpenInfo & { authorizeUrl: string; expiresIn: number }>>
  pollEnterpriseLogin: () => Promise<IpcResult<LoginPollResult>>
  cancelLogin: () => Promise<IpcResult>
  onSocialCallback: (handler: (payload: SocialCallbackPayload) => void) => () => void

  exportToFile: (
    content: string,
    filename: string
  ) => Promise<IpcResult<{ saved: boolean; path?: string }>>
  /** 导出为 Excel 工作簿；主进程负责生成二进制并弹保存对话框 */
  exportToXlsx: (
    sheet: XlsxSheet,
    filename: string
  ) => Promise<IpcResult<{ saved: boolean; path?: string }>>
  /** 打包导出：把多个文件装进一个 zip 落盘 */
  exportToZip: (
    bundle: ExportBundle,
    filename: string
  ) => Promise<IpcResult<{ saved: boolean; path?: string; count?: number }>>
  writeClipboard: (text: string) => void

  getSettings: () => Promise<IpcResult<AppSettings>>
  saveSettings: (patch: Partial<AppSettings>) => Promise<IpcResult<AppSettings>>
  getAppInfo: () => Promise<IpcResult<AppInfo>>
  checkUpdate: () => Promise<IpcResult<UpdateCheckResult>>
  getShellAutoApproveStatus: () => Promise<IpcResult<ShellAutoApproveStatus>>
  enableShellAutoApprove: () => Promise<IpcResult<ShellAutoApproveStatus>>
  disableShellAutoApprove: () => Promise<IpcResult<ShellAutoApproveStatus>>
  /** 在文件管理器里定位对应机制的配置文件 */
  revealShellApproveTarget: (
    kind: ShellAutoApproveTarget['kind']
  ) => Promise<IpcResult<void>>
  getMachineIdStatus: () => Promise<IpcResult<MachineIdStatus>>
  /** 生成新机器码；IDE 运行中会先关闭、写完再拉起 */
  resetMachineId: () => Promise<IpcResult<MachineIdActionResult>>
  /** 把备份的原始机器码写回 */
  restoreMachineId: () => Promise<IpcResult<MachineIdActionResult>>
  revealMachineIdLocation: (field: MachineIdField) => Promise<IpcResult<void>>
  /** 当前出口 IP，走应用代理设置 */
  getIpInfo: () => Promise<IpcResult<IpInfo>>
  /** 测试单个网站的连通性与延迟 */
  testSite: (id: SiteTestId) => Promise<IpcResult<SiteTestResult>>

  // ============ 本地反代 ============
  getProxyState: () => Promise<
    IpcResult<{
      config: ProxyConfig
      status: ProxyStatus
      logs: ProxyLogEntry[]
      usage: ProxyAccountUsage[]
      /** 从账号拉回的模型列表；还没拉过时为 null */
      models: ProxyModelCache | null
    }>
  >
  /** 用反代当前选中的账号重新拉模型列表 */
  refreshProxyModels: () => Promise<IpcResult<ProxyModelCache>>
  saveProxyConfig: (
    patch: Partial<ProxyConfig>
  ) => Promise<IpcResult<{ config: ProxyConfig; status: ProxyStatus }>>
  startProxy: () => Promise<IpcResult<ProxyStatus>>
  stopProxy: () => Promise<IpcResult<ProxyStatus>>
  clearProxyLogs: () => Promise<IpcResult<void>>
  /** 清空统计与按账号的用量累计 */
  resetProxyStats: () => Promise<IpcResult<ProxyStatus>>
  /** 反代的全部 API Key（含默认 Key），带总计 */
  listProxyKeys: () => Promise<IpcResult<ProxyApiKeyView[]>>
  createProxyKey: (input: {
    name?: string
    creditLimit?: number
  }) => Promise<IpcResult<ProxyApiKeyView>>
  updateProxyKey: (
    id: string,
    patch: { name?: string; creditLimit?: number; enabled?: boolean }
  ) => Promise<IpcResult<ProxyApiKeyView[]>>
  deleteProxyKey: (id: string) => Promise<IpcResult<ProxyApiKeyView[]>>
  /** 某个 Key 的完整用量：总计、按模型、按天、最近明细 */
  getProxyKeyUsage: (id: string) => Promise<IpcResult<ProxyKeyUsage>>
  resetProxyKeyUsage: (id: string) => Promise<IpcResult<ProxyApiKeyView[]>>
  /** 对本机反代发一次真实请求（API 端点弹窗的模拟请求） */
  tryProxyEndpoint: (input: {
    method: 'GET' | 'POST'
    path: string
    body?: string
  }) => Promise<
    IpcResult<{
      status: number
      statusText: string
      durationMs: number
      contentType: string
      /** 显示用：JSON 已在主进程格式化，可能被截断 */
      body: string
      /** 原始完整响应，复制用 */
      raw: string
      formatted: boolean
      truncated: boolean
    }>
  >
  /** 把某个自定义 Key 设为默认，原默认 Key 转为自定义 Key */
  setDefaultProxyKey: (
    id: string
  ) => Promise<IpcResult<{ keys: ProxyApiKeyView[]; config: ProxyConfig; status: ProxyStatus }>>
  /** 重新生成默认 Key（写进客户端的那一个） */
  regenerateProxyDefaultKey: () => Promise<
    IpcResult<{ config: ProxyConfig; status: ProxyStatus }>
  >
  /** fresh 为 true 时跳过安装检测的缓存，重新查一遍 */
  getProxyClientStates: (fresh?: boolean) => Promise<IpcResult<ProxyClientState[]>>
  applyProxyClient: (target: ProxyClientTarget) => Promise<IpcResult<ProxyClientState[]>>
  restoreProxyClient: (target: ProxyClientTarget) => Promise<IpcResult<ProxyClientState[]>>
  /** 在文件管理器里定位客户端配置文件 */
  revealProxyClientFile: (
    target: ProxyClientTarget,
    index: number
  ) => Promise<IpcResult<void>>
  /** 代为打开 / 重启客户端（图形界面退出再拉起，命令行开新终端） */
  openProxyClient: (target: ProxyClientTarget) => Promise<IpcResult<void>>
  /** 手动选择客户端安装位置；用户取消时 data 为 null */
  pickProxyClientPath: (target: ProxyClientTarget) => Promise<IpcResult<ProxyClientState[] | null>>
  /** 清掉手动指定的安装位置，回到自动检测 */
  clearProxyClientPath: (target: ProxyClientTarget) => Promise<IpcResult<ProxyClientState[]>>
  /** 写入客户端配置时的进度回调（Cursor 首次要装 CCursor，过程较慢） */
  onProxyClientProgress: (
    handler: (payload: { target: ProxyClientTarget; line: string }) => void
  ) => () => void
  onProxyStatus: (handler: (status: ProxyStatus) => void) => () => void
  onProxyLog: (handler: (entry: ProxyLogEntry | null) => void) => () => void
  openExternal: (url: string, privateMode?: boolean) => Promise<IpcResult<BrowserOpenInfo>>
  showPath: (target: 'store' | 'backup' | 'logs') => Promise<IpcResult>
  /** 导出全部数据为 .kml；用户取消时 saved 为 false */
  exportAllData: () => Promise<IpcResult<{ saved: boolean; path?: string }>>
  /** 选择 .kml 并返回摘要；用户取消时 data 为 null */
  pickImportData: () => Promise<IpcResult<DataBackupSummary | null>>
  /** 用刚选的备份替换全部数据，成功后应用立即重启（这个调用通常等不到返回） */
  applyImportData: () => Promise<IpcResult>
  /** 清除全部数据并还原外部配置，成功后应用立即重启 */
  resetAllData: () => Promise<IpcResult>
  /** 备份计划状态：上次 / 下次执行时间、备份目录里的份数 */
  getBackupStatus: () => Promise<IpcResult<BackupScheduleStatus>>
  /** 立即执行一次备份（和计划到点时完全一样） */
  runBackupNow: () => Promise<IpcResult<BackupScheduleStatus>>
  onBackupStatus: (handler: (status: BackupScheduleStatus) => void) => () => void

  queryLogs: (query: LogQuery) => Promise<IpcResult<LogQueryResult>>
  clearLogs: () => Promise<IpcResult>
  exportLogs: (query: LogQuery) => Promise<IpcResult<{ content: string }>>
  onLogAppended: (handler: (total: number) => void) => () => void

  syncTray: (snapshot: TraySnapshot) => Promise<IpcResult>
  onTrayAction: (handler: (action: TrayAction) => void) => () => void
  onAppNavigate: (handler: (target: string) => void) => () => void
  onProactiveRenewal: (handler: (payload: ProactiveRenewalPayload) => void) => () => void

  quitApp: () => Promise<IpcResult>
  onConfirmQuit: (handler: () => void) => () => void
  onConfirmClose: (handler: () => void) => () => void
  closeWindowChoice: (choice: 'minimize' | 'quit' | 'cancel') => Promise<IpcResult>
}

declare global {
  interface Window {
    api: Api
  }
}
