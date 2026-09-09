import { BrowserWindow, dialog, ipcMain, shell, app, type IpcMainInvokeEvent } from 'electron'
import { readFile, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { dirname } from 'path'
import {
  checkAccountStatus,
  forgetSwitchedAccounts,
  refreshAccountToken,
  setLastSwitchedAccountId,
  switchAccount,
  syncCredentialsToIde,
  verifyCredentials
} from './accountService'
import { createAccountApiKey, deleteAccountApiKey, listAccountApiKeys } from './kiroApiKey'
import { openAccountPortal } from './kiroPortal'
import { clearKiroSsoCache, readKiroAuthToken, readLocalKiroCredentials } from './kiroAuth'
import { isKiroRunning, restartKiroIde } from './kiroProcess'
import { listKiroModels, streamApiKeyChat, streamKiroChat } from './kiroChat'
import {
  cancelLogin,
  completeSocialLogin,
  pollBuilderIdLogin,
  pollEnterpriseLogin,
  startBuilderIdLogin,
  startEnterpriseLogin,
  startSocialLogin
} from './onlineLogin'
import { isHttpUrl, openUrl } from './browser'
import { detectKiroCapability } from './kiroCapability'
import { setGatewayRetryPolicy } from './keyGateway'
import { getGatewayStats, resetGatewayStats } from './gatewayStats'
import { getPoints } from './gatewayHistory'
import { setTraySnapshot, setTrayEnabled } from './tray'
import {
  clearProactiveRenewal,
  scheduleForActiveAccount,
  scheduleProactiveRenewal
} from './proactiveRenewal'
import { setUsageApiType } from './kiroApi'
import { setInAppLocale } from './kiroPortal'
import { setProxyConfig } from './net'
import { checkForUpdate } from './updater'
import {
  disableShellAutoApprove,
  enableShellAutoApprove,
  getShellAutoApproveStatus,
  shellApproveTargetPath
} from './kiroPermissions'
import { clearLogs, exportLogs, getLogDir, queryLogs } from './logger'
import { buildXlsx, buildZip } from './xlsxWriter'
import {
  addKey,
  configureGateway,
  deleteKey,
  disableGateway,
  enableGateway,
  getGatewayStatus,
  importKeys,
  inspectGatewayConflict,
  listKeyModels,
  loadKeys,
  recordChatTestResult,
  selectKey,
  syncAllKeys,
  syncKey,
  testKey,
  updateKey,
  updateKeyRegion
} from './keyService'
import { errorMessage } from '../shared/errors'
import {
  deleteAccountData,
  getAccountData,
  getBackupDir,
  getSettings,
  getStorePath,
  setAccountData,
  setSettings
} from './store'
import {
  appendUsagePoint,
  clearUsageHistory,
  getUsageHistory,
  pruneUsageHistory
} from './usageHistory'
import { DEFAULT_REGION } from '../shared/regions'
import type {
  Account,
  AccountStoreData,
  AccountUsage,
  AppSettings,
  ApiKeyChatTestInput,
  ChatTestInput,
  IpcResult,
  LogQuery,
  ShellAutoApproveTarget,
  SwitchAccountInput,
  TraySnapshot,
  VerifyCredentialsInput,
  ExportBundle,
  XlsxSheet
} from '../shared/types'

function ok<T>(data?: T): IpcResult<T> {
  return { success: true, data }
}

function fail(error: unknown): IpcResult<never> {
  return { success: false, error: errorMessage(error) }
}

/**
 * 注册 IPC 通道：统一把未捕获异常收敛成 { success: false, error }，
 * 各 handler 只负责返回结果，不再逐个写 try/catch。
 */
function handle(
  channel: string,
  handler: (event: IpcMainInvokeEvent, ...args: never[]) => unknown
): void {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      return await handler(event, ...(args as never[]))
    } catch (e) {
      return fail(e)
    }
  })
}

/** 把设置里与主进程相关的部分同步下去 */
export function applyRuntimeSettings(settings: AppSettings): void {
  setUsageApiType(settings.usageApiType)
  setProxyConfig(settings.proxyEnabled, settings.proxyUrl)
  setInAppLocale(settings.portalLocale)
  setGatewayRetryPolicy(
    settings.gatewayAutoRetryThrottle,
    settings.gatewayRetryStatuses,
    settings.gatewayRetryMaxAttempts,
    settings.gatewayRetryDelayMs
  )
}

export function registerIpc(getWindow: () => BrowserWindow | null): void {
  // ============ 数据持久化 ============
  handle('accounts:load', () => ok(getAccountData()))

  handle('accounts:save', async (_e, data: AccountStoreData) => {
    await setAccountData(data)
    // 账号被删掉后它的积分日志就没人看了，顺手清掉
    pruneUsageHistory((data.accounts ?? []).map((a) => a.id))
    return ok()
  })

  handle('accounts:delete', async (_e, ids: string[]) => {
    const result = await deleteAccountData(Array.isArray(ids) ? ids : [])
    if (result.removed) {
      pruneUsageHistory(result.accounts.accounts.map((account) => account.id))
      forgetSwitchedAccounts(ids)
      // 删除的若是 IDE 激活账号，立即清掉旧续期 timer；否则按剩余激活账号重新对齐。
      scheduleForActiveAccount()
    }
    return ok(result)
  })

  // ============ 积分变化日志 ============
  handle('usage:history', (_e, accountId: string) => ok(getUsageHistory(accountId)))

  handle('usage:record', (_e, accountId: string, usage: AccountUsage) =>
    ok({ recorded: appendUsagePoint(accountId, usage) })
  )

  handle('usage:clear-history', (_e, accountId: string) =>
    ok({ cleared: clearUsageHistory(accountId) })
  )

  // ============ 账号操作 ============
  handle('accounts:verify', async (_e, input: VerifyCredentialsInput) =>
    ok(await verifyCredentials(input))
  )

  handle('accounts:refresh-token', async (_e, account: Account) => {
    const result = await refreshAccountToken(account)
    // 刷新的正是 IDE 当前激活账号时，基于新 expiresAt 重排主动续期
    if (result.syncedToIde) {
      scheduleProactiveRenewal(account.id, Date.now() + result.expiresIn * 1000)
    }
    return ok(result)
  })

  handle('accounts:create-api-key', async (_e, account: Account, label: string) => {
    const result = await createAccountApiKey(account, label)
    // 生成过程中若刷新过凭证，按新的到期时间重排主动续期
    if (result.refreshed?.syncedToIde) {
      scheduleProactiveRenewal(account.id, Date.now() + result.refreshed.expiresIn * 1000)
    }
    return ok(result)
  })

  handle('accounts:open-portal', async (_e, account: Account) =>
    ok(await openAccountPortal(account))
  )

  handle('accounts:list-api-keys', async (_e, account: Account) => {
    const result = await listAccountApiKeys(account)
    if (result.refreshed?.syncedToIde) {
      scheduleProactiveRenewal(account.id, Date.now() + result.refreshed.expiresIn * 1000)
    }
    return ok(result)
  })

  handle('accounts:delete-api-key', async (_e, account: Account, keyId: string) => {
    const result = await deleteAccountApiKey(account, keyId)
    if (result.refreshed?.syncedToIde) {
      scheduleProactiveRenewal(account.id, Date.now() + result.refreshed.expiresIn * 1000)
    }
    return ok(result)
  })

  // 封禁需要额外回传 banned 标记，单独注册以保留该字段
  ipcMain.handle('accounts:check-status', async (_e, account: Account) => {
    try {
      const snapshot = await checkAccountStatus(account)
      /*
       * accessToken 过期时 checkAccountStatus 会顺手刷新一次，refreshToken 随之轮换。
       * 这种轮换必须同步给 IDE 并重排主动续期，否则 IDE 手里的 refreshToken 已作废，
       * 主动续期也会因为磁盘值对不上而判定「不是激活账号」并停止调度。
       */
      const { accessToken, refreshToken } = snapshot
      if (accessToken && refreshToken && refreshToken !== account.credentials.refreshToken) {
        // 接口没给 expiresIn 时按 1 小时兜底，与 accountService 的默认值一致
        const expiresIn = snapshot.expiresIn ?? 3600
        const { syncedToIde } = await syncCredentialsToIde(
          account,
          { accessToken, refreshToken, expiresIn },
          account.credentials.refreshToken
        )
        if (syncedToIde) scheduleProactiveRenewal(account.id, Date.now() + expiresIn * 1000)
      }
      return ok(snapshot)
    } catch (e) {
      const banned = (e as { isBanned?: boolean }).isBanned === true
      return { ...fail(e), banned }
    }
  })

  // ============ Kiro IDE 交互 ============
  handle('kiro:read-local-credentials', async () => {
    const result = await readLocalKiroCredentials()
    if ('error' in result) return fail(result.error)
    return ok(result)
  })

  handle('kiro:get-active-token', async () => {
    const token = await readKiroAuthToken()
    if (!token) return fail('本地没有 Kiro 登录状态')
    return ok({
      refreshToken: token.refreshToken,
      accessToken: token.accessToken,
      expiresAt: token.expiresAt,
      authMethod: token.authMethod,
      provider: token.provider
    })
  })

  handle('kiro:switch', async (_e, input: SwitchAccountInput) => {
    const result = await switchAccount(input)
    // 新账号成为 IDE 激活账号，按其 token expiresAt 重排主动续期
    scheduleProactiveRenewal(input.accountId, Date.now() + result.expiresIn * 1000)
    return ok(result)
  })

  handle('kiro:logout', async () => {
    setLastSwitchedAccountId(null)
    clearProactiveRenewal('logout ide')
    return ok({ deleted: await clearKiroSsoCache() })
  })

  handle('kiro:ide-running', async () => ok({ running: await isKiroRunning() }))

  handle('kiro:restart-ide', async () => ok(await restartKiroIde()))

  // ============ Kiro API Key 管理 / 本地网关 ============
  handle('keys:load', () => ok(loadKeys()))
  handle('keys:add', (_e, key: string, note?: string, region?: string) =>
    ok(addKey(key, note, region))
  )
  handle('keys:import', (_e, text: string, region?: string) => ok(importKeys(text, region)))
  handle('keys:update', (_e, id: string, note: string) => ok(updateKey(id, note)))
  handle('keys:set-region', async (_e, id: string, region: string) =>
    ok(await updateKeyRegion(id, region))
  )
  handle('keys:delete', (_e, id: string) => ok(deleteKey(id)))
  handle('keys:select', async (_e, id: string) => ok(await selectKey(id)))
  handle('keys:test', async (_e, id: string) => ok(await testKey(id)))
  handle('keys:models', async (_e, id: string) => ok(await listKeyModels(id)))
  handle('keys:sync', async (_e, id: string) => ok(await syncKey(id)))
  handle('keys:sync-all', async (_e, concurrency?: number) => ok(await syncAllKeys(concurrency)))

  handle('key-gateway:status', async () => ok(await getGatewayStatus()))
  handle('key-gateway:capability', async () => ok(await detectKiroCapability()))
  handle('key-gateway:stats', () => ok(getGatewayStats()))
  handle('key-gateway:stats-reset', (_e, keyId?: string) => {
    resetGatewayStats(keyId)
    return ok(getGatewayStats())
  })
  /** 某个 Key 的调用历史（按分钟聚合），用于画请求 / 成功率 / 积分曲线 */
  handle('key-gateway:history', (_e, keyId: string) => ok(getPoints(keyId)))
  handle('key-gateway:inspect-conflict', async () => ok(await inspectGatewayConflict()))
  handle('key-gateway:enable', async (_e, keyId?: string, force?: boolean) =>
    ok(await enableGateway(keyId, { force: !!force }))
  )
  handle('key-gateway:disable', async () => ok(await disableGateway()))
  handle('key-gateway:configure', async (_e, input: { ports?: { krs: number; cps: number } }) =>
    ok(await configureGateway(input))
  )

  // ============ 账号测活（真实对话）============

  handle('kiro:list-models', async (_e, input: Parameters<typeof listKiroModels>[0]) =>
    ok(await listKiroModels(input))
  )

  // 一个请求一个 AbortController，账号与 API Key 测活分别管理，避免 requestId 相同时相互取消。
  const accountChatAborters = new Map<string, AbortController>()
  const keyChatAborters = new Map<string, AbortController>()

  handle('kiro:chat-test', async (event, requestId: string, input: ChatTestInput) => {
    const controller = new AbortController()
    accountChatAborters.set(requestId, controller)
    try {
      const result = await streamKiroChat(
        input,
        {
          onDelta: (delta) => {
            // 渲染进程可能已经关闭弹窗，发送前确认还活着
            if (!event.sender.isDestroyed()) {
              event.sender.send('kiro:chat-chunk', { requestId, delta })
            }
          }
        },
        controller.signal
      )
      return ok(result)
    } finally {
      if (accountChatAborters.get(requestId) === controller) accountChatAborters.delete(requestId)
    }
  })

  handle('kiro:chat-cancel', (_e, requestId: string) => {
    accountChatAborters.get(requestId)?.abort(new Error('用户取消'))
    return ok()
  })

  // API Key 在线对话测活：凭证只在主进程读取，不下发到渲染层。
  handle('keys:chat-test', async (event, requestId: string, input: ApiKeyChatTestInput) => {
    const data = loadKeys()
    const entry = data.keys.find((key) => key.id === input.keyId)
    if (!entry) return fail('未找到该 API Key')
    const controller = new AbortController()
    keyChatAborters.set(requestId, controller)
    try {
      const result = await streamApiKeyChat(
        entry.key,
        entry.region,
        { modelId: input.modelId, message: input.message },
        {
          onDelta: (delta) => {
            if (!event.sender.isDestroyed()) {
              event.sender.send('keys:chat-chunk', { requestId, delta })
            }
          }
        },
        controller.signal
      )
      // 真实对话是唯一能查出封禁/失效的途径，结论必须落库，否则卡片仍显示「正常」
      recordChatTestResult(entry.id, undefined)
      return ok(result)
    } catch (error) {
      // 用户主动中止不构成测活结论，不能据此把 Key 标成异常
      if (!controller.signal.aborted) {
        recordChatTestResult(entry.id, errorMessage(error))
      }
      throw error
    } finally {
      if (keyChatAborters.get(requestId) === controller) keyChatAborters.delete(requestId)
    }
  })

  handle('keys:chat-cancel', (_e, requestId: string) => {
    keyChatAborters.get(requestId)?.abort(new Error('用户取消'))
    return ok()
  })

  // ============ 在线登录 ============
  handle('login:start-builder-id', async (_e, region?: string, privateMode?: boolean) =>
    ok(await startBuilderIdLogin(region || DEFAULT_REGION, privateMode))
  )

  handle('login:poll-builder-id', async () => ok(await pollBuilderIdLogin()))

  handle('login:start-social', async (_e, provider: 'Google' | 'Github', privateMode?: boolean) =>
    ok(await startSocialLogin(provider, privateMode))
  )

  handle('login:complete-social', async (_e, code: string, state: string) =>
    ok(await completeSocialLogin(code, state))
  )

  handle(
    'login:start-enterprise',
    async (_e, startUrl: string, region?: string, privateMode?: boolean) =>
      ok(await startEnterpriseLogin(startUrl, region || DEFAULT_REGION, privateMode))
  )

  handle('login:poll-enterprise', async () => ok(await pollEnterpriseLogin()))

  handle('login:cancel', () => {
    cancelLogin()
    return ok()
  })

  // ============ 文件导入导出 ============
  /** 保存对话框的类型筛选：与文件名扩展名一致的那一项排在最前 */
  function exportFilters(filename: string): { name: string; extensions: string[] }[] {
    const known = [
      { name: 'JSON', extensions: ['json'] },
      { name: '日志', extensions: ['log'] },
      { name: '文本', extensions: ['txt'] },
      { name: 'CSV', extensions: ['csv'] },
      { name: 'Excel 工作簿', extensions: ['xlsx'] }
    ]
    const ext = filename.split('.').pop()?.toLowerCase() ?? ''
    const matched = known.filter((f) => f.extensions.includes(ext))
    const rest = known.filter((f) => !f.extensions.includes(ext))
    return [...matched, ...rest, { name: '全部文件', extensions: ['*'] }]
  }

  /**
   * 落盘后在文件管理器里定位该文件，由设置项「导出后」控制。
   *
   * 导出的多是凭证类文件，用户下一步基本都要去拿它，省掉自己翻目录这一步。
   * 用 showItemInFolder 而不是 openPath：后者会直接用默认程序打开文件内容，
   * 凭证文件被自动弹开并不是我们想要的效果。
   *
   * 每次现读设置而不是缓存：这个开关随时可改，且导出本身是低频操作，
   * 读一次 store 的开销可以忽略。
   */
  function revealExported(filePath: string): void {
    if (!getSettings().revealExportedFile) return
    // 定位失败不该让导出本身算失败，文件已经写成功了
    try {
      shell.showItemInFolder(filePath)
    } catch {
      /* ignore */
    }
  }

  handle('file:export', async (_e, content: string, filename: string) => {
    const result = await dialog.showSaveDialog(getWindow()!, {
      title: filename.endsWith('.log') ? '导出日志' : '导出账号数据',
      defaultPath: filename,
      // 匹配文件名扩展名的类型必须排在首位，否则 macOS 会按第一项再追加一次扩展名
      filters: exportFilters(filename)
    })
    if (result.canceled || !result.filePath) return ok({ saved: false })
    await writeFile(result.filePath, content, 'utf-8')
    revealExported(result.filePath)
    return ok({ saved: true, path: result.filePath })
  })

  // 打包导出：把多个文件塞进一个 zip 再落盘
  handle('file:export-zip', async (_e, bundle: ExportBundle, filename: string) => {
    const entries = bundle.files ?? []
    if (!entries.length) throw new Error('没有可打包的内容')

    const result = await dialog.showSaveDialog(getWindow()!, {
      title: '导出压缩包',
      defaultPath: filename,
      filters: [
        { name: '压缩包', extensions: ['zip'] },
        { name: '全部文件', extensions: ['*'] }
      ]
    })
    if (result.canceled || !result.filePath) return ok({ saved: false })
    await writeFile(result.filePath, buildZip(entries))
    revealExported(result.filePath)
    return ok({ saved: true, path: result.filePath, count: entries.length })
  })

  // xlsx 是二进制 zip，走不了上面的 utf-8 通道；渲染层只传结构化数据，落盘前在主进程组装
  handle('file:export-xlsx', async (_e, sheet: XlsxSheet, filename: string) => {
    const result = await dialog.showSaveDialog(getWindow()!, {
      title: '导出表格',
      defaultPath: filename,
      filters: exportFilters(filename)
    })
    if (result.canceled || !result.filePath) return ok({ saved: false })
    await writeFile(result.filePath, buildXlsx(sheet))
    revealExported(result.filePath)
    return ok({ saved: true, path: result.filePath })
  })

  handle('file:import', async () => {
    const result = await dialog.showOpenDialog(getWindow()!, {
      title: '导入账号数据',
      properties: ['openFile'],
      filters: [
        { name: '支持的格式', extensions: ['json', 'txt', 'csv'] },
        { name: '全部文件', extensions: ['*'] }
      ]
    })
    if (result.canceled || result.filePaths.length === 0) return ok(null)
    const filePath = result.filePaths[0]
    const content = await readFile(filePath, 'utf-8')
    return ok({ content, format: filePath.split('.').pop()?.toLowerCase() || 'json', path: filePath })
  })

  // ============ 设置 ============
  handle('settings:get', () => {
    const settings = getSettings()
    applyRuntimeSettings(settings)
    return ok(settings)
  })

  handle('settings:save', (_e, patch: Partial<AppSettings>) => {
    const merged = setSettings(patch)
    applyRuntimeSettings(merged)
    // 托盘开关变化时动态启用 / 关闭托盘图标
    if (patch.trayEnabled !== undefined) setTrayEnabled(patch.trayEnabled)
    // 主动续期开关变化时立即生效：开启则按当前激活账号调度，关闭则清除
    if (patch.proactiveRenewalEnabled !== undefined) {
      if (patch.proactiveRenewalEnabled) scheduleForActiveAccount()
      else clearProactiveRenewal('disabled by user')
    }
    return ok(merged)
  })

  // ============ 应用 ============
  handle('app:info', () =>
    ok({
      version: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      platform: process.platform,
      storePath: getStorePath(),
      backupDir: getBackupDir()
    })
  )

  // 检查更新：对比 GitHub 最新 Release 的版本号，只给结论不做下载
  handle('app:check-update', async () => ok(await checkForUpdate()))

  // ============ 常用工具：Kiro Agent 权限 ============
  handle('tools:shell-approve-status', async () => ok(await getShellAutoApproveStatus()))
  handle('tools:shell-approve-enable', async () => ok(await enableShellAutoApprove()))
  handle('tools:shell-approve-disable', async () => ok(await disableShellAutoApprove()))

  /**
   * 在文件管理器里定位配置文件。
   * 渲染层只能传机制标识，路径一律由主进程自行解析，避免任意路径被打开。
   */
  handle('tools:shell-approve-reveal', async (_e, kind: ShellAutoApproveTarget['kind']) => {
    const target = shellApproveTargetPath(kind)
    // 文件还不存在时退一步打开它所在目录，至少让用户看到位置
    if (existsSync(target)) shell.showItemInFolder(target)
    else await shell.openPath(dirname(target))
    return ok()
  })

  handle('app:open-external', async (_e, url: string, privateMode?: boolean) => {
    // 只放行 http(s)，避免被诱导打开本地程序或自定义协议
    if (!isHttpUrl(url)) return fail(new Error('仅支持 http/https 链接'))
    return ok(await openUrl(url, privateMode))
  })

  handle('tray:sync', (_e, data: TraySnapshot) => {
    setTraySnapshot(data)
    return ok()
  })

  handle('app:show-path', (_e, target: 'store' | 'backup' | 'logs') => {
    const paths = { store: app.getPath('userData'), backup: getBackupDir(), logs: getLogDir() }
    shell.openPath(paths[target] ?? paths.store)
    return ok()
  })

  // ============ 系统日志 ============
  handle('log:query', (_e, query: LogQuery) => ok(queryLogs(query)))

  handle('log:clear', async () => {
    await clearLogs()
    return ok()
  })

  /** 导出当前筛选结果的纯文本，由渲染层再决定存文件还是复制 */
  handle('log:export', (_e, query: LogQuery) => ok({ content: exportLogs(query) }))

  // 渲染进程确认退出后真正退出。before-quit 会先置位退出标记，
  // 所以窗口 close 监听里的「最小化到托盘」不会把这次退出拦下来
  handle('app:quit', () => {
    app.quit()
    return ok()
  })
}
