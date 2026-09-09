import type {
  Account,
  AccountApiKeyList,
  AccountSnapshot,
  AccountStoreData,
  AccountUsage,
  ApiKeyChatTestInput,
  AppInfo,
  AppSettings,
  AuthMethod,
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
  ShellAutoApproveStatus,
  ShellAutoApproveTarget,
  SocialCallbackPayload,
  LogQuery,
  LogQueryResult,
  ProactiveRenewalPayload,
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

export interface ImportedFile {
  content: string
  format: string
  path: string
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

  readLocalKiroCredentials: () => Promise<IpcResult<LocalKiroCredentials>>
  getActiveKiroToken: () => Promise<IpcResult<KiroActiveToken>>
  switchAccount: (input: SwitchAccountInput) => Promise<IpcResult<SwitchAccountResult>>
  isKiroIdeRunning: () => Promise<IpcResult<{ running: boolean }>>
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
  importFromFile: () => Promise<IpcResult<ImportedFile | null>>
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
  openExternal: (url: string, privateMode?: boolean) => Promise<IpcResult<BrowserOpenInfo>>
  showPath: (target: 'store' | 'backup' | 'logs') => Promise<IpcResult>

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
}

declare global {
  interface Window {
    api: Api
  }
}
