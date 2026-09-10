import { acceptHMRUpdate, defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { v4 as uuidv4 } from 'uuid'
import {
  DEFAULT_KEY_GATEWAY_DATA,
  type AccountGroup,
  type KeyGatewayConflict,
  type KeyGatewayData,
  type KeyGatewayStatus,
  type KeyGatewayUsageStats,
  type KeyModelInfo,
  type KeyTestResult
} from '@shared/types'
import { shouldSkipKeyUsageRefresh } from '@shared/refreshPolicy'
import {
  countByGroup,
  reorderGroups as reorderGroupList,
  sortGroups
} from '@/utils/groups'
import { toPlain } from '@/utils/ipc'
import { useSettingsStore } from '@/stores/settings'

/** 网关统计的轮询间隔：RPM 是一分钟窗口，3 秒一刷足够跟手又不浪费 */
const STATS_POLL_MS = 3000

export const useKeysStore = defineStore('keys', () => {
  const settingsStore = useSettingsStore()
  const data = ref<KeyGatewayData>({
    ...DEFAULT_KEY_GATEWAY_DATA,
    keys: [],
    ports: { ...DEFAULT_KEY_GATEWAY_DATA.ports }
  })
  const status = ref<KeyGatewayStatus | null>(null)
  const loading = ref(false)
  const detecting = ref(false)
  const syncRunning = ref(false)
  /** 网关调用统计，按 keyId 索引；网关未运行时为空对象 */
  const gatewayStats = ref<Record<string, KeyGatewayUsageStats>>({})
  let statsTimer: ReturnType<typeof setInterval> | null = null
  const usageTask = ref({
    running: false,
    type: 'api-key-usage-refresh' as const,
    total: 0,
    done: 0
  })
  const nextUsageRefreshAt = ref<number | null>(null)

  const activeKey = computed(() =>
    data.value.enabled
      ? data.value.keys.find((entry) => entry.id === data.value.activeKeyId)
      : undefined
  )
  const effectiveKey = computed(() => {
    const current = status.value
    if (!current?.observedInCurrentSession || !current.lastForwardedKeyId) return undefined
    return data.value.keys.find((entry) => entry.id === current.lastForwardedKeyId)
  })
  const count = computed(() => data.value.keys.length)

  let statusRevision = 0

  function replace(next: KeyGatewayData): void {
    data.value = {
      ...next,
      activeKeyId: next.enabled ? (next.activeKeyId ?? null) : null,
      keys: [...next.keys],
      ports: { ...next.ports }
    }
  }

  /**
   * 把一次真实对话测活的结论同步到本地卡片。
   * 主进程在 keys:chat-test 里已经落库，这里做本地更新是为了让卡片状态立即变化，
   * 不必为每个 Key 再往返一次 IPC 重新加载整表。
   */
  function applyChatResult(id: string, error?: string): void {
    const entry = data.value.keys.find((item) => item.id === id)
    if (!entry) return
    entry.lastChatError = error || undefined
    entry.lastChatCheckedAt = Date.now()
  }

  function applyStatus(next: KeyGatewayStatus): void {
    statusRevision++
    status.value = next
    data.value.enabled = next.enabled
    data.value.activeKeyId = next.enabled ? next.activeKeyId : null
  }

  async function load(): Promise<void> {
    const revisionAtStart = statusRevision
    const [keysRes, statusRes] = await Promise.all([
      window.api.loadKeys(),
      window.api.getKeyGatewayStatus()
    ])
    if (keysRes.success && keysRes.data) replace(keysRes.data)
    // 加载期间若收到主进程推送，保留更新的推送状态，避免旧快照回写覆盖。
    if (statusRes.success && statusRes.data && statusRevision === revisionAtStart) {
      applyStatus(statusRes.data)
    } else if (status.value) {
      data.value.enabled = status.value.enabled
      data.value.activeKeyId = status.value.enabled ? status.value.activeKeyId : null
    }
  }

  async function add(key: string, note?: string, region?: string): Promise<string | null> {
    const res = await window.api.addKey(key, note, region)
    if (!res.success || !res.data) return res.error || '添加失败'
    replace(res.data)
    return null
  }

  async function importText(
    text: string,
    region?: string
  ): Promise<{
    error?: string
    added?: number
    skipped?: number
    invalid?: number
  }> {
    const res = await window.api.importKeys(text, region)
    if (!res.success || !res.data) return { error: res.error || '导入失败' }
    replace(res.data.data)
    return res.data
  }

  async function update(id: string, note: string): Promise<string | null> {
    const res = await window.api.updateKey(id, note)
    if (!res.success || !res.data) return res.error || '保存失败'
    replace(res.data)
    return null
  }

  /**
   * 换区会清空该 Key 的缓存额度与历史，随即按新区域重新同步一次。
   * 同步失败不影响换区本身：sync 内部已持久化 lastError 并回填数据，卡片会展示。
   */
  async function setRegion(id: string, region: string): Promise<string | null> {
    const res = await window.api.setKeyRegion(id, region)
    if (!res.success || !res.data) return res.error || '修改区域失败'
    replace(res.data.data)
    applyStatus(res.data.status)
    await sync(id)
    return null
  }

  async function remove(id: string): Promise<string | null> {
    const res = await window.api.deleteKey(id)
    if (!res.success || !res.data) return res.error || '删除失败'
    replace(res.data)
    const nextStats = { ...gatewayStats.value }
    delete nextStats[id]
    gatewayStats.value = nextStats
    return null
  }

  /**
   * 批量覆盖备注，留空即清空；返回实际变化的条数。
   * 走主进程的批量接口，几百个 Key 也只落一次盘。
   */
  async function setNoteForKeys(
    ids: string[],
    note: string
  ): Promise<{ error?: string; changed?: number }> {
    const target = new Set(ids.filter(Boolean))
    if (!target.size) return { changed: 0 }
    const value = note.trim() || undefined
    const changed = data.value.keys.filter(
      (entry) => target.has(entry.id) && entry.note !== value
    ).length
    const res = await window.api.setKeysNote([...target], note)
    if (!res.success || !res.data) return { error: res.error || '设置备注失败' }
    replace(res.data)
    return { changed }
  }

  // ============ 分组 ============
  /*
   * 分组数据存在主进程的 keyData 里，所以每个动作都是一次 IPC。
   * 主进程只给「整表替换」一个原语（setKeyGroups），新建 / 改名 / 删除 / 排序
   * 都在这里算出新列表再提交 —— 省掉四套通道，也不会出现「分组删了、
   * Key 上还留着 id」的中间态（主进程会顺手清掉悬空 id）。
   */

  /** 按 order 排好的分组列表 */
  const groups = computed(() => sortGroups(data.value.groups))
  /** id -> 分组，供卡片取名与筛选判断已删除分组 */
  const groupMap = computed(() => new Map(groups.value.map((group) => [group.id, group])))
  /** 各分组下的 Key 数，外加「未分组」一项 */
  const groupCounts = computed(() => countByGroup(data.value.keys, groups.value))

  async function commitGroups(next: AccountGroup[]): Promise<string | null> {
    const res = await window.api.setKeyGroups(toPlain(next))
    if (!res.success || !res.data) return res.error || '保存分组失败'
    replace(res.data)
    return null
  }

  /** 新建分组；同名直接复用已有的那个，避免建出一堆重名分组 */
  async function addGroup(name: string): Promise<{ error?: string; group?: AccountGroup }> {
    const label = name.trim()
    if (!label) return { error: '分组名称不能为空' }
    const existing = groups.value.find((group) => group.name === label)
    if (existing) return { group: existing }

    const group: AccountGroup = { id: uuidv4(), name: label, order: groups.value.length }
    const error = await commitGroups([...groups.value, group])
    return error ? { error } : { group }
  }

  async function renameGroup(id: string, name: string): Promise<string | null> {
    const label = name.trim()
    if (!label) return '分组名称不能为空'
    return commitGroups(groups.value.map((g) => (g.id === id ? { ...g, name: label } : g)))
  }

  /** 删除分组：主进程会把引用它的 Key 置回未分组 */
  async function removeGroup(id: string): Promise<string | null> {
    return commitGroups(groups.value.filter((group) => group.id !== id))
  }

  /** 拖动排序后按给定顺序重排 */
  async function reorderGroups(orderedIds: string[]): Promise<string | null> {
    return commitGroups(reorderGroupList(groups.value, orderedIds))
  }

  /** 批量设置分组（groupId 传 null 表示移出分组），返回实际变化的条数 */
  async function setGroupForKeys(
    ids: string[],
    groupId: string | null
  ): Promise<{ error?: string; changed?: number }> {
    const target = new Set(ids.filter(Boolean))
    if (!target.size) return { changed: 0 }
    const changed = data.value.keys.filter(
      (entry) => target.has(entry.id) && (entry.groupId ?? null) !== groupId
    ).length
    const res = await window.api.setKeysGroup([...target], groupId)
    if (!res.success || !res.data) return { error: res.error || '设置分组失败' }
    replace(res.data)
    return { changed }
  }

  async function select(id: string): Promise<string | null> {
    const res = await window.api.selectKey(id)
    if (!res.success || !res.data) return res.error || '切换失败'
    replace(res.data.data)
    applyStatus(res.data.status)
    return null
  }

  async function listModels(id: string): Promise<{ error?: string; data?: KeyModelInfo[] }> {
    const res = await window.api.listKeyModels(id)
    return res.success && res.data ? { data: res.data } : { error: res.error || '模型列表获取失败' }
  }

  async function test(id: string): Promise<{ error?: string; data?: KeyTestResult }> {
    const res = await window.api.testKey(id)
    return res.success && res.data ? { data: res.data } : { error: res.error || '测试失败' }
  }

  async function sync(id: string): Promise<string | null> {
    const res = await window.api.syncKey(id)
    if (!res.success || !res.data) {
      // 主进程失败时仍会保存 lastError；重新载入以保留旧额度并展示错误。
      const latest = await window.api.loadKeys()
      if (latest.success && latest.data) replace(latest.data)
      return res.error || '同步失败'
    }
    replace(res.data)
    return null
  }

  async function syncAll(
    showProgress = true
  ): Promise<{ error?: string; success?: number; failed?: number; skipped?: number }> {
    if (syncRunning.value) return { error: 'API Key 用量正在同步，请稍候' }
    syncRunning.value = true
    // 主进程会跳过凭证已确定失效的 Key，进度总数要用同一套策略算，
    // 否则进度条永远差着被跳过的那几个，看起来像卡住没刷完。
    const total = data.value.keys.filter((entry) => !shouldSkipKeyUsageRefresh(entry)).length
    if (showProgress) usageTask.value = { running: true, type: 'api-key-usage-refresh', total, done: 0 }
    try {
      const res = await window.api.syncAllKeys(settingsStore.settings.apiKeyRefreshConcurrency)
      if (!res.success || !res.data) return { error: res.error || '批量同步失败' }
      replace(res.data.data)
      return { success: res.data.success, failed: res.data.failed, skipped: res.data.skipped }
    } finally {
      if (showProgress) {
        usageTask.value.done = total
        usageTask.value.running = false
      }
      syncRunning.value = false
    }
  }

  /** 手动批量刷新，逐个完成时更新页头进度。 */
  async function syncMany(
    ids: string[]
  ): Promise<{ error?: string; success?: number; failed?: number }> {
    if (syncRunning.value) return { error: 'API Key 用量正在同步，请稍候' }
    if (!ids.length) return { success: 0, failed: 0 }

    syncRunning.value = true
    usageTask.value = {
      running: true,
      type: 'api-key-usage-refresh',
      total: ids.length,
      done: 0
    }
    let success = 0
    let failed = 0
    try {
      const concurrency = Math.max(1, settingsStore.settings.apiKeyRefreshConcurrency)
      for (let i = 0; i < ids.length; i += concurrency) {
        await Promise.all(
          ids.slice(i, i + concurrency).map(async (id) => {
            try {
              const error = await sync(id)
              error ? failed++ : success++
            } catch {
              failed++
            } finally {
              usageTask.value.done++
            }
          })
        )
      }
      return { success, failed }
    } finally {
      usageTask.value.running = false
      syncRunning.value = false
    }
  }

  /** 查询 Kiro IDE 是否已被其它本地网关接管；无冲突返回 null。 */
  /**
   * 网关调用统计。仅在网关运行期间有意义，关闭后主进程会清空。
   * 用轮询而非推送：这些数字变化很快，界面上没必要逐条实时刷。
   */
  async function refreshStats(): Promise<void> {
    const res = await window.api.getKeyGatewayStats()
    if (res.success && res.data) gatewayStats.value = res.data
  }

  async function resetStats(keyId?: string): Promise<void> {
    const res = await window.api.resetKeyGatewayStats(keyId)
    if (res.success && res.data) gatewayStats.value = res.data
  }

  function startStatsPolling(): void {
    if (statsTimer) return
    void refreshStats()
    statsTimer = setInterval(() => void refreshStats(), STATS_POLL_MS)
  }

  function stopStatsPolling(): void {
    if (statsTimer) clearInterval(statsTimer)
    statsTimer = null
  }

  async function inspectConflict(): Promise<{
    error?: string
    conflict?: KeyGatewayConflict | null
  }> {
    const res = await window.api.inspectKeyGatewayConflict()
    if (!res.success) return { error: res.error || '接管状态检测失败' }
    return { conflict: res.data ?? null }
  }

  async function setEnabled(enabled: boolean, keyId?: string, force = false): Promise<string | null> {
    loading.value = true
    try {
      const res = enabled
        ? await window.api.enableKeyGateway(keyId, force)
        : await window.api.disableKeyGateway()
      if (!res.success || !res.data) return res.error || '操作失败'
      applyStatus(res.data)
      return null
    } finally {
      loading.value = false
    }
  }

  async function configure(krs: number, cps: number): Promise<string | null> {
    const res = await window.api.configureKeyGateway({ ports: { krs, cps } })
    if (!res.success || !res.data) return res.error || '保存配置失败'
    replace(res.data.data)
    applyStatus(res.data.status)
    return null
  }

  async function detectCurrentApiKey(): Promise<string | null> {
    detecting.value = true
    try {
      const res = await window.api.getKeyGatewayStatus()
      if (!res.success || !res.data) return res.error || '检测失败'
      applyStatus(res.data)
      return null
    } catch (error) {
      return error instanceof Error ? error.message : '检测失败'
    } finally {
      detecting.value = false
    }
  }

  // ============ API Key 用量自动刷新 ============
  const AUTO_TICK_MS = 1_000
  const LAST_RUN_STORAGE = 'kal:auto-api-key-usage-refresh-at'
  let tickTimer: ReturnType<typeof setInterval> | null = null
  let autoRunning = false
  let appliedInterval = 0

  function intervalMs(): number {
    return Math.max(1, settingsStore.settings.apiKeyUsageRefreshInterval) * 60_000
  }

  function readLastRun(): number {
    const value = Number(localStorage.getItem(LAST_RUN_STORAGE))
    return Number.isFinite(value) && value > 0 ? value : 0
  }

  function markRan(): void {
    try {
      localStorage.setItem(LAST_RUN_STORAGE, String(Date.now()))
    } catch {
      // localStorage 不可写时退化为每次启动补跑一轮
    }
  }

  async function autoTick(): Promise<void> {
    if (
      autoRunning ||
      syncRunning.value ||
      nextUsageRefreshAt.value === null ||
      Date.now() < nextUsageRefreshAt.value
    ) return
    autoRunning = true
    const next = Date.now() + intervalMs()
    nextUsageRefreshAt.value = next
    try {
      if (data.value.keys.length) {
        const result = await syncAll()
        if (result.error) console.warn(`[ApiKeyAutoRefresh] ${result.error}`)
        else
          console.info(
            `[ApiKeyAutoRefresh] 完成：成功 ${result.success}，失败 ${result.failed}` +
              (result.skipped ? `，跳过 ${result.skipped} 个凭证已失效的 Key` : '')
          )
      }
      markRan()
      if (Date.now() >= next) nextUsageRefreshAt.value = Date.now() + intervalMs()
    } catch (error) {
      console.error('[ApiKeyAutoRefresh] 本轮刷新异常：', error)
    } finally {
      autoRunning = false
    }
  }

  function ensureTick(): void {
    if (!tickTimer) tickTimer = setInterval(() => void autoTick(), AUTO_TICK_MS)
  }

  function startAutoRefresh(): void {
    const enabled = settingsStore.settings.autoRefreshApiKeyUsage
    const interval = settingsStore.settings.apiKeyUsageRefreshInterval
    if (!enabled) {
      nextUsageRefreshAt.value = null
      if (tickTimer) clearInterval(tickTimer)
      tickTimer = null
      return
    }
    if (nextUsageRefreshAt.value === null || appliedInterval !== interval) {
      appliedInterval = interval
      const due = readLastRun() + intervalMs()
      nextUsageRefreshAt.value = due <= Date.now() ? Date.now() : due
    }
    ensureTick()
  }

  /** 手工全量同步后从现在重新计算下一轮，避免马上重复请求。 */
  function scheduleUsageRefresh(): void {
    appliedInterval = settingsStore.settings.apiKeyUsageRefreshInterval
    if (!settingsStore.settings.autoRefreshApiKeyUsage) {
      nextUsageRefreshAt.value = null
      return
    }
    markRan()
    nextUsageRefreshAt.value = Date.now() + intervalMs()
    ensureTick()
  }

  function stopAutoRefresh(): void {
    if (tickTimer) clearInterval(tickTimer)
    tickTimer = null
    nextUsageRefreshAt.value = null
  }

  return {
    data,
    status,
    loading,
    detecting,
    syncRunning,
    usageTask,
    nextUsageRefreshAt,
    activeKey,
    effectiveKey,
    count,
    applyChatResult,
    load,
    add,
    importText,
    update,
    setNoteForKeys,
    remove,
    // 分组
    groups,
    groupMap,
    groupCounts,
    addGroup,
    renameGroup,
    removeGroup,
    reorderGroups,
    setGroupForKeys,
    select,
    listModels,
    test,
    sync,
    syncAll,
    syncMany,
    gatewayStats,
    refreshStats,
    resetStats,
    startStatsPolling,
    stopStatsPolling,
    startAutoRefresh,
    scheduleUsageRefresh,
    stopAutoRefresh,
    setEnabled,
    inspectConflict,
    configure,
    setRegion,
    detectCurrentApiKey,
    applyStatus
  }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useKeysStore, import.meta.hot))
}
