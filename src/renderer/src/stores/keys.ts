import { acceptHMRUpdate, defineStore } from 'pinia'
import { computed, ref, shallowRef } from 'vue'
import {
  DEFAULT_KEY_GATEWAY_DATA,
  type AccountGroup,
  type KeyGatewayConflict,
  type KeyGatewayData,
  type KeyGatewayStatus,
  type KeyGatewayUsageStats,
  type KeyModelInfo,
  type IpcResult
} from '@shared/types'
import { shouldSkipKeyUsageRefresh } from '@shared/refreshPolicy'
import { isTrashed, sameGroupIds, validGroupIdsOf } from '@shared/itemGroups'
import {
  EMPTY_GROUP_NAME,
  countByGroup,
  findGroupByName,
  renameGroupError,
  reorderGroups as reorderGroupList,
  sortGroups
} from '@/utils/groups'
import { toPlain } from '@/utils/ipc'
import { sameData, shareUnchangedById } from '@/utils/sameData'
import { useSettingsStore } from '@/stores/settings'

/** 网关统计的轮询间隔：RPM 是一分钟窗口，3 秒一刷足够跟手又不浪费 */
const STATS_POLL_MS = 3000

export const useKeysStore = defineStore('keys', () => {
  const settingsStore = useSettingsStore()
  /*
   * 浅层响应式：Key 可能有上千个，深层响应式要给每个 Key 的每个字段建代理并逐个追踪，
   * 筛选、排序、统计每次重算都要经过这些代理。这里的写法一律整体替换（replace / 展开后赋值），
   * 从不就地改某个 Key 的字段；新增写法时也要保持「替换而不是就地修改」。
   */
  const data = shallowRef<KeyGatewayData>({
    ...DEFAULT_KEY_GATEWAY_DATA,
    keys: [],
    ports: { ...DEFAULT_KEY_GATEWAY_DATA.ports }
  })
  const status = ref<KeyGatewayStatus | null>(null)
  const loading = ref(false)
  const detecting = ref(false)
  const syncRunning = ref(false)
  /** 网关调用统计，按 keyId 索引；网关未运行时为空对象。只整体替换，用浅层响应式 */
  const gatewayStats = shallowRef<Record<string, KeyGatewayUsageStats>>({})
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
  /** 正常列表里的 Key（不含回收站） */
  const liveKeys = computed(() => data.value.keys.filter((entry) => !isTrashed(entry)))
  /** 回收站里的 Key 数，显示在回收站按钮的角标上；只计数，不分配数组 */
  const trashedCount = computed(() => {
    let trashed = 0
    for (const entry of data.value.keys) {
      if (isTrashed(entry)) trashed++
    }
    return trashed
  })
  /** 侧栏等处展示的数量只算正常列表 */
  const count = computed(() => data.value.keys.length - trashedCount.value)

  /** 放入 / 移出回收站；接管中使用的当前 Key 由主进程拒绝 */
  async function setTrashed(ids: string[], trashed: boolean): Promise<string | null> {
    const target = [...new Set(ids.filter(Boolean))]
    if (!target.length) return null
    const res = await window.api.setKeysTrashed(target, trashed)
    return applyData(res, trashed ? '放入回收站失败' : '移出回收站失败')
  }

  let statusRevision = 0

  function replace(next: KeyGatewayData): void {
    data.value = {
      ...next,
      activeKeyId: next.enabled ? (next.activeKeyId ?? null) : null,
      /*
       * 结构共享：主进程每次都返回整表新对象，内容没变的 Key 沿用旧对象。
       * 卡片按对象身份判断 props、搜索文本按对象身份缓存，批量刷新（syncMany 每个 Key 回来都整表替换一次）时
       * 只有真正变了的那几张卡会重新渲染。keys 数组本身照旧每次换新，依赖它判断「有同步结果写回」的地方不受影响。
       */
      keys: shareUnchangedById(data.value.keys, next.keys),
      ports: { ...next.ports }
    }
  }

  /**
   * 主进程返回整表的接口统一收尾：失败返回错误文案（接口没给时用 fallback），成功替换本地数据并返回 null。
   */
  function applyData(res: IpcResult<KeyGatewayData>, fallback: string): string | null {
    if (!res.success || !res.data) return res.error || fallback
    replace(res.data)
    return null
  }

  /**
   * 把一次真实对话测活的结论同步到本地卡片。
   * 主进程在 keys:chat-test 里已经落库，这里做本地更新是为了让卡片状态立即变化，
   * 不必为每个 Key 再往返一次 IPC 重新加载整表。
   */
  function applyChatResult(id: string, error?: string): void {
    const index = data.value.keys.findIndex((item) => item.id === id)
    if (index === -1) return
    // data 是浅层响应式，必须换新对象才会通知界面
    const keys = data.value.keys.slice()
    keys[index] = { ...keys[index], lastChatError: error || undefined, lastChatCheckedAt: Date.now() }
    data.value = { ...data.value, keys }
  }

  /** 只同步网关开关与当前 Key；值没变就不换对象，免得整页白白重算 */
  function applyGatewayFlags(enabled: boolean, activeKeyId: string | null): void {
    const nextActive = enabled ? activeKeyId : null
    if (data.value.enabled === enabled && data.value.activeKeyId === nextActive) return
    data.value = { ...data.value, enabled, activeKeyId: nextActive }
  }

  function applyStatus(next: KeyGatewayStatus): void {
    statusRevision++
    status.value = next
    applyGatewayFlags(next.enabled, next.activeKeyId)
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
      applyGatewayFlags(status.value.enabled, status.value.activeKeyId)
    }
  }

  async function add(key: string, note?: string, region?: string): Promise<string | null> {
    return applyData(await window.api.addKey(key, note, region), '添加失败')
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
    return applyData(await window.api.updateKey(id, note), '保存失败')
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
    // 删除前记下完整 Key 写进日志，删完就查不到了；日志不做隐私打码
    const key = data.value.keys.find((entry) => entry.id === id)?.key
    const error = applyData(await window.api.deleteKey(id), '删除失败')
    if (error) return error
    console.warn(`[Key] 已删除 1 个 API Key（${key ?? id}）`)
    const nextStats = { ...gatewayStats.value }
    delete nextStats[id]
    gatewayStats.value = nextStats
    // 本地改过，下次轮询不论内容如何都要以主进程为准
    lastStatsText = ''
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
    const error = applyData(await window.api.setKeysNote([...target], note), '设置备注失败')
    return error ? { error } : { changed }
  }

  // ============ 分组 ============
  /*
   * 分组数据存在主进程的 keyData 里，所以每个动作都是一次 IPC。
   * 主进程只给「整表替换」一个原语（setKeyGroups），新建 / 改名 / 删除 / 排序
   * 都在这里算出新列表再提交 —— 省掉四套通道，也不会出现「分组删了、
   * Key 上还留着 id」的中间态（主进程会顺手清掉悬空 id）。
   */

  /**
   * 按 order 排好的分组列表。
   * 每次整表替换都会排出一个新数组，内容没变时沿用上一次的结果，
   * 下游的 groupMap、分组面板与按分组筛选就不会跟着白白重算。
   */
  const groups = computed<AccountGroup[]>((prev) => {
    const next = sortGroups(data.value.groups)
    return prev && sameData(prev, next) ? prev : next
  })
  /** id -> 分组，供卡片取名与筛选判断已删除分组 */
  const groupMap = computed(() => new Map(groups.value.map((group) => [group.id, group])))
  /** 各分组下的 Key 数，外加「未分组」一项 */
  const groupCounts = computed(() => countByGroup(data.value.keys, groups.value))

  async function commitGroups(next: AccountGroup[]): Promise<string | null> {
    return applyData(await window.api.setKeyGroups(toPlain(next)), '保存分组失败')
  }

  /** 新建分组；同名直接复用已有的那个，避免建出一堆重名分组 */
  async function addGroup(name: string): Promise<{ error?: string; group?: AccountGroup }> {
    const label = name.trim()
    if (!label) return { error: EMPTY_GROUP_NAME }
    const existing = findGroupByName(groups.value, label)
    if (existing) return { group: existing }

    const group: AccountGroup = { id: crypto.randomUUID(), name: label, order: groups.value.length }
    const error = await commitGroups([...groups.value, group])
    return error ? { error } : { group }
  }

  async function renameGroup(id: string, name: string): Promise<string | null> {
    const label = name.trim()
    // 空名称、和别的分组重名时拒绝，否则筛选里会出现两个同名分组
    const error = renameGroupError(groups.value, id, label)
    if (error) return error
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

  /** 批量设置分组：整体替换为 groupIds（可多个），空数组表示移出全部分组；返回实际变化的条数 */
  async function setGroupForKeys(
    ids: string[],
    groupIds: string[]
  ): Promise<{ error?: string; changed?: number }> {
    const target = new Set(ids.filter(Boolean))
    if (!target.size) return { changed: 0 }
    const exists = (id: string): boolean => groupMap.value.has(id)
    const wanted = groupIds.filter(exists)
    const changed = data.value.keys.filter(
      (entry) => target.has(entry.id) && !sameGroupIds(validGroupIdsOf(entry, exists), wanted)
    ).length
    const error = applyData(await window.api.setKeysGroup([...target], toPlain(wanted)), '设置分组失败')
    return error ? { error } : { changed }
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
    // 主进程同样跳过回收站里的 Key，进度总数用 liveKeys 才对得上
    const total = liveKeys.value.filter((entry) => !shouldSkipKeyUsageRefresh(entry)).length
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

  /**
   * 网关调用统计。仅在网关运行期间有意义，关闭后主进程会清空。
   * 用轮询而非推送：这些数字变化很快，界面上没必要逐条实时刷。
   */
  let lastStatsText = ''

  async function refreshStats(): Promise<void> {
    const res = await window.api.getKeyGatewayStats()
    if (!res.success || !res.data) return
    // 每 3 秒轮询一次，空闲时结果几乎总是一样；内容没变就不换对象，免得整页跟着重渲染
    const text = JSON.stringify(res.data)
    if (text === lastStatsText) return
    lastStatsText = text
    gatewayStats.value = reuseUnchangedStats(gatewayStats.value, res.data)
  }

  /**
   * 每份统计对象序列化后的文本，按对象身份记：统计对象拿到后从不修改，旧值的文本算一次就够了，
   * 每轮轮询只需序列化新拿到的那份。按身份而不是按 id 记，整表被重置、删除时也不会对错号。
   */
  const statsTextCache = new WeakMap<KeyGatewayUsageStats, string>()

  function statsTextOf(stats: KeyGatewayUsageStats): string {
    let text = statsTextCache.get(stats)
    if (text === undefined) statsTextCache.set(stats, (text = JSON.stringify(stats)))
    return text
  }

  /**
   * 整表有变化时，逐个 Key 比较：内容没变的沿用旧对象。
   * 卡片按对象身份判断 props 是否变化，这样一轮轮询里只有真正有请求的那几张卡会重新渲染。
   */
  function reuseUnchangedStats(
    prev: Record<string, KeyGatewayUsageStats>,
    next: Record<string, KeyGatewayUsageStats>
  ): Record<string, KeyGatewayUsageStats> {
    const merged: Record<string, KeyGatewayUsageStats> = {}
    for (const [id, stats] of Object.entries(next)) {
      const old = prev[id]
      merged[id] = old && statsTextOf(old) === statsTextOf(stats) ? old : stats
    }
    return merged
  }

  async function resetStats(keyId?: string): Promise<void> {
    const res = await window.api.resetKeyGatewayStats(keyId)
    if (res.success && res.data) {
      gatewayStats.value = res.data
      lastStatsText = ''
    }
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

  /** 查询 Kiro IDE 是否已被其它本地网关接管；无冲突返回 null。 */
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
    liveKeys,
    trashedCount,
    setTrashed,
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
