import { contextBridge, ipcRenderer, clipboard } from 'electron'
import { createHash } from 'crypto'

/**
 * 统一包装 ipcRenderer.invoke：主进程抛出的异常会让 invoke 变成 rejected promise，
 * 渲染层若没逐个 try/catch 就会冒出 "Uncaught (in promise)"。
 * 这里把所有失败都收敛成和主进程一致的 { success: false, error } 结构。
 */
async function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  try {
    return await ipcRenderer.invoke(channel, ...args)
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e)
    // 主进程版本比界面旧时会缺少新通道，给出可操作的提示而不是原始报错
    const error = raw.includes('No handler registered')
      ? `当前运行的主进程没有 ${channel} 这个能力，请完全退出并重新启动应用后再试`
      : raw.replace(/^Error invoking remote method '[^']+':\s*/, '')
    return { success: false, error }
  }
}

/**
 * 订阅主进程推送，返回取消订阅的函数。
 * 组件卸载时必须调用它摘掉监听，否则热更新与反复开关弹窗会不断累积监听器。
 */
function subscribe<T>(channel: string, handler: (payload: T) => void): () => void {
  const listener = (_e: unknown, payload: T): void => handler(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api = {
  /** 同步 md5，供邮箱打码使用（在 preload 内直接算，不走 IPC） */
  md5: (text: string) => createHash('md5').update(text).digest('hex'),

  // 数据
  loadAccounts: () => invoke('accounts:load'),
  saveAccounts: (data: unknown) => invoke('accounts:save', data),
  deleteAccounts: (ids: string[]) => invoke('accounts:delete', ids),

  /** 用账号凭证向 Kiro 控制面申请一个新的 API Key */
  createAccountApiKey: (account: unknown, label: string) =>
    invoke('accounts:create-api-key', account, label),
  /** 列出该账号已创建的 API Key（只有前缀，没有完整明文） */
  listAccountApiKeys: (account: unknown) => invoke('accounts:list-api-keys', account),

  /** 删除该账号的一个 API Key */
  deleteAccountApiKey: (account: unknown, keyId: string) =>
    invoke('accounts:delete-api-key', account, keyId),
  /** 用该账号凭证在私密窗口打开 Kiro 官网后台 */
  openAccountPortal: (account: unknown) => invoke('accounts:open-portal', account),

  // Kiro API Key 管理 / 本地网关
  loadKeys: () => invoke('keys:load'),
  addKey: (key: string, note?: string, region?: string) =>
    invoke('keys:add', key, note, region),
  importKeys: (text: string, region?: string) => invoke('keys:import', text, region),
  updateKey: (id: string, note: string) => invoke('keys:update', id, note),
  setKeysNote: (ids: string[], note: string) => invoke('keys:set-note', ids, note),
  setKeyGroups: (groups: unknown) => invoke('keys:set-groups', groups),
  setKeysGroup: (ids: string[], groupId: string | null) =>
    invoke('keys:set-group', ids, groupId),
  setKeyRegion: (id: string, region: string) => invoke('keys:set-region', id, region),
  deleteKey: (id: string) => invoke('keys:delete', id),
  selectKey: (id: string | null) => invoke('keys:select', id),
  testKey: (id: string) => invoke('keys:test', id),
  listKeyModels: (id: string) => invoke('keys:models', id),
  syncKey: (id: string) => invoke('keys:sync', id),
  syncAllKeys: (concurrency?: number) => invoke('keys:sync-all', concurrency),
  getKeyGatewayStatus: () => invoke('key-gateway:status'),
  getKiroCapability: () => invoke('key-gateway:capability'),
  getKeyGatewayStats: () => invoke('key-gateway:stats'),
  resetKeyGatewayStats: (keyId?: string) => invoke('key-gateway:stats-reset', keyId),
  getKeyGatewayHistory: (keyId: string) => invoke('key-gateway:history', keyId),
  inspectKeyGatewayConflict: () => invoke('key-gateway:inspect-conflict'),
  enableKeyGateway: (keyId?: string, force?: boolean) =>
    invoke('key-gateway:enable', keyId, force),
  disableKeyGateway: () => invoke('key-gateway:disable'),
  configureKeyGateway: (input: unknown) => invoke('key-gateway:configure', input),
  onKeyGatewayChanged: (handler: (payload: unknown) => void) =>
    subscribe('key-gateway:changed', handler),

  // 账号操作
  verifyCredentials: (input: unknown) => invoke('accounts:verify', input),
  refreshAccountToken: (account: unknown) => invoke('accounts:refresh-token', account),
  checkAccountStatus: (account: unknown) => invoke('accounts:check-status', account),

  // 积分变化日志
  getUsageHistory: (accountId: string) => invoke('usage:history', accountId),
  recordUsagePoint: (accountId: string, usage: unknown) =>
    invoke('usage:record', accountId, usage),
  clearUsageHistory: (accountId: string) => invoke('usage:clear-history', accountId),

  // Kiro IDE
  readLocalKiroCredentials: () => invoke('kiro:read-local-credentials'),
  getActiveKiroToken: () => invoke('kiro:get-active-token'),
  switchAccount: (input: unknown) => invoke('kiro:switch', input),
  isKiroIdeRunning: () => invoke('kiro:ide-running'),
  restartKiroIde: () => invoke('kiro:restart-ide'),
  logoutKiro: () => invoke('kiro:logout'),

  // 账号测活
  listKiroModels: (input: unknown) => invoke('kiro:list-models', input),
  chatTest: (requestId: string, input: unknown) => invoke('kiro:chat-test', requestId, input),
  cancelChatTest: (requestId: string) => invoke('kiro:chat-cancel', requestId),
  onChatChunk: (handler: (payload: { requestId: string; delta: string }) => void) =>
    subscribe('kiro:chat-chunk', handler),
  keyChatTest: (requestId: string, input: unknown) => invoke('keys:chat-test', requestId, input),
  cancelKeyChatTest: (requestId: string) => invoke('keys:chat-cancel', requestId),
  onKeyChatChunk: (handler: (payload: { requestId: string; delta: string }) => void) =>
    subscribe('keys:chat-chunk', handler),

  // 在线登录
  startBuilderIdLogin: (region?: string, privateMode?: boolean) =>
    invoke('login:start-builder-id', region, privateMode),
  pollBuilderIdLogin: () => invoke('login:poll-builder-id'),
  startSocialLogin: (provider: 'Google' | 'Github', privateMode?: boolean) =>
    invoke('login:start-social', provider, privateMode),
  completeSocialLogin: (code: string, state: string) =>
    invoke('login:complete-social', code, state),
  startEnterpriseLogin: (startUrl: string, region?: string, privateMode?: boolean) =>
    invoke('login:start-enterprise', startUrl, region, privateMode),
  pollEnterpriseLogin: () => invoke('login:poll-enterprise'),
  cancelLogin: () => invoke('login:cancel'),
  onSocialCallback: (handler: (payload: unknown) => void) =>
    subscribe('login:social-callback', handler),

  // 文件
  exportToFile: (content: string, filename: string) =>
    invoke('file:export', content, filename),
  exportToXlsx: (sheet: unknown, filename: string) =>
    invoke('file:export-xlsx', sheet, filename),
  /** 打包导出：多个文件装进一个 zip */
  exportToZip: (bundle: unknown, filename: string) =>
    invoke('file:export-zip', bundle, filename),
  importFromFile: () => invoke('file:import'),
  writeClipboard: (text: string) => clipboard.writeText(text),

  // 设置 / 应用
  getSettings: () => invoke('settings:get'),
  saveSettings: (patch: unknown) => invoke('settings:save', patch),
  getAppInfo: () => invoke('app:info'),
  checkUpdate: () => invoke('app:check-update'),

  // 常用工具：Kiro Agent 权限
  getShellAutoApproveStatus: () => invoke('tools:shell-approve-status'),
  enableShellAutoApprove: () => invoke('tools:shell-approve-enable'),
  disableShellAutoApprove: () => invoke('tools:shell-approve-disable'),
  revealShellApproveTarget: (kind: 'trustedCommands' | 'permissionsYaml') =>
    invoke('tools:shell-approve-reveal', kind),

  // 系统日志
  queryLogs: (query: unknown) => invoke('log:query', query),
  clearLogs: () => invoke('log:clear'),
  exportLogs: (query: unknown) => invoke('log:export', query),
  onLogAppended: (handler: (total: number) => void) => subscribe('log:appended', handler),

  openExternal: (url: string, privateMode?: boolean) =>
    invoke('app:open-external', url, privateMode),
  showPath: (target: 'store' | 'backup' | 'logs') => invoke('app:show-path', target),

  // 托盘
  syncTray: (snapshot: unknown) => invoke('tray:sync', snapshot),
  onTrayAction: (handler: (action: string) => void) => subscribe('tray:action', handler),

  // kiro-manager-lite:// 协议唤起时的路由跳转
  onAppNavigate: (handler: (target: string) => void) => subscribe('app:navigate', handler),

  // 主进程主动续期成功后回传新凭证，渲染进程据此同步内存
  onProactiveRenewal: (handler: (payload: unknown) => void) =>
    subscribe('proactive-renewal:done', handler),

  // 托盘「退出程序」触发的退出确认
  quitApp: () => invoke('app:quit'),
  onConfirmQuit: (handler: () => void) => subscribe('app:confirm-quit', () => handler())
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore contextIsolation 关闭时的回退
  window.api = api
}
