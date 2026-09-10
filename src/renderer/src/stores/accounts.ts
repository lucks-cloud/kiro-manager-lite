import { acceptHMRUpdate, defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { message } from 'ant-design-vue'
import { v4 as uuidv4 } from 'uuid'
import {
  DEFAULT_SETTINGS,
  type Account,
  type AccountExportData,
  type AccountGroup,
  type AccountImportItem,
  type AccountSnapshot,
  type AccountStatus,
  type AccountStoreData,
  type BatchResult,
  type IdpType,
  type OnlineLoginCredentials,
  type ProactiveRenewalPayload,
  type SubscriptionType,
  type SwitchAccountResult,
  type VerifyCredentialsInput
} from '@shared/types'
import { errorMessage, isCredentialRejected } from '@shared/errors'
import { shouldSkipAccountUsageRefresh } from '@shared/refreshPolicy'
import { DEFAULT_REGION } from '@shared/regions'
import { runPool } from '@/utils/format'
import { UNGROUPED } from '@/utils/groups'
import { toPlain } from '@/utils/ipc'
import { isSocialIdp, normalizeIdp } from '@/utils/transfer'
import { useSettingsStore } from './settings'

export interface AccountFilter {
  search: string
  statuses: AccountStatus[]
  subscriptions: SubscriptionType[]
  idps: IdpType[]
  /** 订阅剩余天数下限（含） */
  daysRemainingMin?: number
  /** 订阅剩余天数上限（含），用于「即将到期」快捷筛选 */
  daysRemainingMax?: number
  /** 用量占比下限（0-1），用于「额度告急」快捷筛选 */
  usageMin?: number
  /** 用量占比上限（0-1） */
  usageMax?: number
  /**
   * 按分组筛选。空数组表示不限；特殊值 __none__ 代表「未分组」，
   * 这样「未分组」能和普通分组一样被勾选，不必再加一个布尔开关。
   */
  groupIds: string[]
}

// 「未分组」哨兵值定义在 utils/groups，账号与 API Key 两边共用；这里转出去兼容既有引用
export { UNGROUPED } from '@/utils/groups'

/** 批量任务的进度状态，全局单例，同一时间只跑一件事 */
export type AccountTaskType =
  | 'import-validation'
  | 'account-key-refresh'
  | 'account-usage-refresh'

interface TaskState {
  running: boolean
  type: AccountTaskType
  label: string
  total: number
  done: number
}

function authMethodOf(idp: IdpType): 'IdC' | 'social' {
  return isSocialIdp(idp) ? 'social' : 'IdC'
}

function emptyUsage(): Account['usage'] {
  return { current: 0, limit: 0, percentUsed: 0, lastUpdated: 0 }
}

/** 统计里「即将重置」的天数阈值 */
const EXPIRING_SOON_DAYS = 7
/** 自动刷新密钥只处理这个时间窗内即将过期的账号 */
const AUTO_REFRESH_WINDOW_MS = 30 * 60_000
/** 接口没给 expiresIn 时的兜底有效期（秒） */
const DEFAULT_EXPIRES_IN = 3600

export const useAccountsStore = defineStore('accounts', () => {
  const settingsStore = useSettingsStore()

  const accounts = ref<Account[]>([])
  /** 分组定义，始终按 order 升序维护，界面直接按数组顺序渲染 */
  const groups = ref<AccountGroup[]>([])
  const activeAccountId = ref<string | null>(null)
  const selectedIds = ref<string[]>([])
  const loading = ref(false)
  const task = ref<TaskState>({
    running: false,
    type: 'import-validation',
    label: '',
    total: 0,
    done: 0
  })
  const filter = ref<AccountFilter>({
    search: '',
    statuses: [],
    subscriptions: [],
    idps: [],
    groupIds: []
  })

  // ============ 持久化 ============

  let saveTimer: ReturnType<typeof setTimeout> | null = null

  function snapshotForStore(): AccountStoreData {
    return {
      version: 1,
      accounts: accounts.value,
      activeAccountId: activeAccountId.value,
      groups: groups.value
    }
  }

  function persist(immediate = false): void {
    if (saveTimer) clearTimeout(saveTimer)
    const write = (): void => {
      saveTimer = null
      void window.api.saveAccounts(toPlain(snapshotForStore()))
    }
    if (immediate) write()
    else saveTimer = setTimeout(write, 600)
  }

  async function load(): Promise<void> {
    loading.value = true
    try {
      // 订阅档位的历史值由主进程在读取时统一对齐，这里拿到的已是规范值
      const res = await window.api.loadAccounts()
      if (res.success && res.data) {
        accounts.value = res.data.accounts ?? []
        activeAccountId.value = res.data.activeAccountId ?? null
        // order 是持久化的排序依据，读回来先归一，界面就能直接按数组顺序渲染
        groups.value = [...(res.data.groups ?? [])].sort((a, b) => a.order - b.order)
      }
      await syncActiveFromIde()
    } finally {
      loading.value = false
    }
  }

  // ============ 查询 ============

  const byId = computed(() => new Map(accounts.value.map((a) => [a.id, a])))

  function get(id: string): Account | undefined {
    return byId.value.get(id)
  }

  const activeAccount = computed(() => accounts.value.find((a) => a.isActive) ?? null)

  // ============ 分组 ============

  /** id -> 分组，供卡片取名与筛选判断已删除分组 */
  const groupMap = computed(() => new Map(groups.value.map((g) => [g.id, g])))

  /** 各分组下的账号数，外加「未分组」一项，用于面板上的计数 */
  const groupCounts = computed(() => {
    const counts: Record<string, number> = { [UNGROUPED]: 0 }
    for (const g of groups.value) counts[g.id] = 0
    for (const a of accounts.value) {
      const key = a.groupId && counts[a.groupId] !== undefined ? a.groupId : UNGROUPED
      counts[key]++
    }
    return counts
  })

  /** 新建分组；同名直接复用已有的那个，避免建出一堆重名分组 */
  function addGroup(name: string): AccountGroup | null {
    const label = name.trim()
    if (!label) return null
    const existing = groups.value.find((g) => g.name === label)
    if (existing) return existing

    const group: AccountGroup = {
      id: uuidv4(),
      name: label,
      // 追加到末尾
      order: groups.value.length ? Math.max(...groups.value.map((g) => g.order)) + 1 : 0
    }
    groups.value = [...groups.value, group]
    persist()
    return group
  }

  function renameGroup(id: string, name: string): boolean {
    const label = name.trim()
    if (!label) return false
    groups.value = groups.value.map((g) => (g.id === id ? { ...g, name: label } : g))
    persist()
    return true
  }

  /** 删除分组：同时把引用它的账号置回未分组，不留悬空 id */
  function removeGroup(id: string): void {
    // 顺手把 order 重排连续，否则删掉中间项后会留下空洞（0、2、3…）
    groups.value = groups.value
      .filter((g) => g.id !== id)
      .map((g, index) => ({ ...g, order: index }))
    let touched = false
    const next = accounts.value.map((a) => {
      if (a.groupId !== id) return a
      touched = true
      const { groupId: _drop, ...rest } = a
      return rest as Account
    })
    if (touched) accounts.value = next
    // 该分组若正被用于筛选，一并摘掉，否则列表会突然空掉
    if (filter.value.groupIds.includes(id)) {
      filter.value.groupIds = filter.value.groupIds.filter((g) => g !== id)
    }
    persist(true)
  }

  /** 按给定顺序重排（拖动排序后调用），order 重新按下标写死 */
  function reorderGroups(orderedIds: string[]): void {
    const byId = new Map(groups.value.map((g) => [g.id, g]))
    const next: AccountGroup[] = []
    orderedIds.forEach((id, index) => {
      const g = byId.get(id)
      if (g) {
        next.push({ ...g, order: index })
        byId.delete(id)
      }
    })
    // 漏掉的（理论上不会有）按原顺序补在后面，避免丢分组
    for (const g of byId.values()) next.push({ ...g, order: next.length })
    groups.value = next
    persist()
  }

  /**
   * 批量设置分组：groupId 传 null 表示移出分组。
   * 一次性换数组引用 + 单次 persist，避免逐个写盘。
   */
  function setGroupForAccounts(ids: string[], groupId: string | null): number {
    const target = new Set(ids.filter(Boolean))
    if (!target.size) return 0
    let changed = 0
    const next = accounts.value.map((account) => {
      if (!target.has(account.id)) return account
      if ((account.groupId ?? null) === groupId) return account
      changed++
      if (groupId === null) {
        // 未分组用「不存在该字段」表示，置 undefined 会把 undefined 写进存档
        const { groupId: _drop, ...rest } = account
        return rest as Account
      }
      return { ...account, groupId }
    })
    if (changed) {
      accounts.value = next
      persist()
    }
    return changed
  }

  const filtered = computed(() => {
    const {
      search,
      statuses,
      subscriptions,
      idps,
      daysRemainingMin,
      daysRemainingMax,
      usageMin,
      usageMax,
      groupIds
    } = filter.value
    const keyword = search.trim().toLowerCase()
    const groupSet = groupIds.length ? new Set(groupIds) : null
    return accounts.value.filter((a) => {
      if (keyword) {
        const haystack = `${a.email} ${a.nickname ?? ''} ${a.note ?? ''}`.toLowerCase()
        if (!haystack.includes(keyword)) return false
      }
      // 分组已被删除的账号一律视为未分组，避免残留 id 让它从列表里消失
      if (groupSet && !groupSet.has(a.groupId && groupMap.value.has(a.groupId) ? a.groupId : UNGROUPED)) {
        return false
      }
      if (statuses.length && !statuses.includes(a.status)) return false
      if (subscriptions.length && !subscriptions.includes(a.subscription.type)) return false
      if (idps.length && !idps.includes(a.idp)) return false
      // 范围条件一律用 != null 判断「是否已设置」：输入框清空后给过来的是 null，
      // 若按 !== undefined 判断，null 会被当成已设置，比较时又被转成 0，
      // 于是 days > 0 / used > 0 把几乎所有条目都滤掉，列表看起来是空的
      const days = a.subscription.daysRemaining
      if (daysRemainingMax != null && (days ?? Number.POSITIVE_INFINITY) > daysRemainingMax) {
        return false
      }
      if (daysRemainingMin != null && (days ?? Number.NEGATIVE_INFINITY) < daysRemainingMin) {
        return false
      }
      const used = a.usage.percentUsed || 0
      if (usageMin != null && used < usageMin) return false
      if (usageMax != null && used > usageMax) return false
      return true
    })
  })

  /**
   * 覆盖式设置筛选条件（首页告警跳转、筛选面板重置用）。
   *
   * groupIds 默认沿用当前值：分组是工具栏上独立的一个按钮，有自己的角标和
   * 「清除分组筛选」，用户点筛选面板的重置并不期待分组选择被顺带清掉。
   * 需要连分组一起清的调用方显式传 `groupIds: []`。
   */
  function applyFilter(patch: Partial<AccountFilter>): void {
    filter.value = {
      search: '',
      statuses: [],
      subscriptions: [],
      idps: [],
      groupIds: filter.value.groupIds,
      daysRemainingMin: undefined,
      daysRemainingMax: undefined,
      usageMin: undefined,
      usageMax: undefined,
      ...patch
    }
  }

  /** 一次遍历产出各维度计数，界面统计与筛选面板共用 */
  const stats = computed(() => {
    const byStatus: Record<AccountStatus, number> = {
      active: 0,
      expired: 0,
      error: 0,
      banned: 0,
      unknown: 0
    }
    const bySubscription: Record<SubscriptionType, number> = {
      Free: 0,
      Pro: 0,
      Pro_Plus: 0,
      Pro_Max: 0,
      Power: 0,
      Teams: 0
    }
    const byIdp: Record<IdpType, number> = { BuilderId: 0, Github: 0, Google: 0, Enterprise: 0 }
    let expiringSoon = 0

    for (const a of accounts.value) {
      // ?? 0 兜底磁盘上可能存在的旧枚举值，避免出现 NaN
      byStatus[a.status] = (byStatus[a.status] ?? 0) + 1
      bySubscription[a.subscription.type] = (bySubscription[a.subscription.type] ?? 0) + 1
      byIdp[a.idp] = (byIdp[a.idp] ?? 0) + 1
      if ((a.subscription.daysRemaining ?? 99) <= EXPIRING_SOON_DAYS) expiringSoon++
    }

    return { total: accounts.value.length, byStatus, bySubscription, byIdp, expiringSoon }
  })

  // ============ 增删改 ============

  function exists(email?: string, userId?: string, idp?: IdpType): boolean {
    return accounts.value.some((a) => {
      if (userId && a.userId && a.userId === userId) return true
      if (email && a.email === email && a.idp === idp) return true
      return false
    })
  }

  /** 用校验结果拼出完整账号对象 */
  type BuildInput = VerifyCredentialsInput & {
    password?: string
    nickname?: string
    note?: string
    startUrl?: string
    profileArn?: string
  }

  /**
   * 一批导入所用的 createdAt 基准。
   *
   * 取「现在」与「库里最大 createdAt」的较大值：批内会按条数往上加偏移，
   * 若只用 Date.now()，上一批很大（比如 5000 条，占掉 5 秒的偏移空间）时，
   * 紧接着导入的第二批会落进上一批的区间里，排序就交叠了。
   * 不用展开运算符求最大值——账号上万时 Math.max(...arr) 会爆栈。
   */
  function importBaseTime(): number {
    let max = Date.now()
    for (const account of accounts.value) {
      if ((account.createdAt || 0) > max) max = account.createdAt
    }
    return max
  }

  function buildAccount(snapshot: AccountSnapshot, input: BuildInput): Account {
    const now = Date.now()
    const idp = (input.provider || 'BuilderId') as IdpType
    const profileArn = snapshot.profileArn || input.profileArn
    return {
      id: uuidv4(),
      email: snapshot.email,
      password: input.password,
      nickname: input.nickname,
      note: input.note,
      idp,
      userId: snapshot.userId,
      profileArn,
      credentials: {
        accessToken: snapshot.accessToken || '',
        refreshToken: snapshot.refreshToken || input.refreshToken,
        clientId: input.clientId,
        clientSecret: input.clientSecret,
        region: input.region || DEFAULT_REGION,
        startUrl: input.startUrl,
        expiresAt: now + (snapshot.expiresIn ?? DEFAULT_EXPIRES_IN) * 1000,
        authMethod: authMethodOf(idp),
        provider: idp,
        profileArn
      },
      subscription: snapshot.subscription,
      usage: snapshot.usage,
      status: 'active',
      isActive: false,
      createdAt: now,
      lastUsedAt: now,
      lastCheckedAt: now
    }
  }

  /** 校验凭证并添加单个账号 */
  async function addByCredentials(
    input: BuildInput
  ): Promise<{ ok: boolean; error?: string; account?: Account }> {
    const res = await window.api.verifyCredentials(input)
    if (!res.success || !res.data) return { ok: false, error: res.error || '校验失败' }

    const idp = (input.provider || 'BuilderId') as IdpType
    if (exists(res.data.email, res.data.userId, idp)) {
      return { ok: false, error: `${res.data.email} 已存在` }
    }

    const account = buildAccount(res.data, input)
    accounts.value = [...accounts.value, account]
    // 入库时记一条基线，之后的变化才有对比对象
    void window.api.recordUsagePoint(account.id, toPlain(account.usage))
    persist()
    return { ok: true, account }
  }

  /** 在线登录成功后拉取账号信息并入库 */
  async function addByOnlineLogin(
    credentials: OnlineLoginCredentials,
    extra?: { nickname?: string; note?: string }
  ): Promise<{ ok: boolean; error?: string; account?: Account }> {
    return addByCredentials({
      refreshToken: credentials.refreshToken,
      clientId: credentials.clientId,
      clientSecret: credentials.clientSecret,
      region: credentials.region,
      authMethod: credentials.authMethod,
      provider: credentials.provider,
      startUrl: credentials.startUrl,
      profileArn: credentials.profileArn,
      nickname: extra?.nickname
    })
  }

  function updateAccount(id: string, patch: Partial<Account>): void {
    const index = accounts.value.findIndex((a) => a.id === id)
    if (index === -1) return
    // 整体换引用触发一次更新即可，避免先改元素再换数组产生两次写入
    const next = accounts.value.slice()
    next[index] = { ...next[index], ...patch }
    accounts.value = next
    persist()
  }

  /**
   * 批量覆盖备注：选中的账号统一改成同一个 note（空串表示清空）。
   * 一次性换数组引用 + 单次 persist，避免逐个 updateAccount 触发 N 次写盘。
   * @returns 实际改动的账号数
   */
  function setNoteForAccounts(ids: string[], note: string): number {
    const target = new Set(ids.filter(Boolean))
    if (!target.size) return 0
    const value = note.trim() || undefined
    let changed = 0
    const next = accounts.value.map((account) => {
      if (!target.has(account.id) || account.note === value) return account
      changed++
      return { ...account, note: value }
    })
    if (changed) {
      accounts.value = next
      persist()
    }
    return changed
  }

  async function removeAccounts(
    ids: string[]
  ): Promise<{ removed: number; error?: string }> {
    const uniqueIds = [...new Set(ids.filter(Boolean))]
    if (!uniqueIds.length) return { removed: 0 }
    // 删除必须以主进程最新快照为准；同时取消尚未发出的旧快照保存，避免删后回写复活。
    if (saveTimer) {
      clearTimeout(saveTimer)
      saveTimer = null
    }
    const res = await window.api.deleteAccounts(uniqueIds)
    if (!res.success || !res.data) {
      return { removed: 0, error: res.error || '删除账号失败' }
    }
    accounts.value = res.data.accounts.accounts ?? []
    activeAccountId.value = res.data.accounts.activeAccountId ?? null
    const removedSet = new Set(uniqueIds)
    selectedIds.value = selectedIds.value.filter((id) => !removedSet.has(id))
    if (res.data.removed) console.warn(`[Account] 已删除 ${res.data.removed} 个账号`)
    return { removed: res.data.removed }
  }

  // ============ 批量导入 ============

  async function importItems(items: AccountImportItem[]): Promise<BatchResult> {
    const result: BatchResult = { success: 0, failed: 0, skipped: 0, messages: [] }
    const valid = items.filter((i) => i.refreshToken)
    if (valid.length === 0) {
      result.messages.push('没有解析到有效的 refreshToken')
      return result
    }

    task.value = {
      running: true,
      type: 'import-validation',
      label: '批量导入校验中',
      total: valid.length,
      done: 0
    }
    const created: Account[] = []
    // 本批已入队的 email|idp，用 Set 查重避免逐个线性扫描（几千条时是 O(n²)）
    const createdKeys = new Set<string>()
    /** 本批统一的时间基准，各条按输入下标偏移，保证列表顺序与文件顺序一致 */
    const baseTime = importBaseTime()
    const total = valid.length
    // 导入并发独立于批量刷新的并发，单独设置更好控速；上下限由 runPool 兜底
    const limit = settingsStore.settings.importConcurrency || DEFAULT_SETTINGS.importConcurrency

    try {
      await runPool(valid, limit, async (item, index) => {
        /*
         * 登录方式认不出来时的兜底：没有 clientId / clientSecret 的账号不可能是 IdC
         * （IdC 刷新必须带这两个值），只能是社交登录。否则会被当成 BuilderId 送去校验，
         * 直接报「IdC 账号需要同时提供 Client ID 与 Client Secret」而整批失败。
         */
        const idp =
          !item.provider && !item.clientId && !item.clientSecret
            ? 'Google'
            : normalizeIdp(item.provider)
        try {
          const res = await window.api.verifyCredentials({
            refreshToken: item.refreshToken,
            clientId: item.clientId,
            clientSecret: item.clientSecret,
            region: item.region || DEFAULT_REGION,
            authMethod: authMethodOf(idp),
            provider: idp
          })
          if (!res.success || !res.data) {
            result.failed++
            result.messages.push(`#${index + 1} ${item.email || ''} 校验失败：${res.error}`)
            return
          }
          const email = res.data.email || item.email || ''
          const key = `${email}|${idp}`
          if (exists(email, res.data.userId, idp) || createdKeys.has(key)) {
            result.skipped++
            result.messages.push(`#${index + 1} ${email} 已存在，跳过`)
            return
          }
          createdKeys.add(key)
          const account = buildAccount(
            { ...res.data, email },
            {
              refreshToken: item.refreshToken,
              clientId: item.clientId,
              clientSecret: item.clientSecret,
              region: item.region,
              provider: idp,
              password: item.password,
              nickname: item.nickname
            }
          )
          /*
           * createdAt 按输入顺序定序，而不是用 buildAccount 里的「此刻」。
           * 导入是并发的，各账号完成校验的先后与文件顺序无关；不定序的话
           * 同一批在列表里的排列是随机的，看着像乱序。
           * 倒序排列下用 total - index，让文件里靠前的排在列表更上方。
           */
          account.createdAt = baseTime + (total - index)
          created.push(account)
          result.success++
        } catch (e) {
          result.failed++
          result.messages.push(`#${index + 1} 异常：${errorMessage(e)}`)
        } finally {
          task.value.done++
        }
      })
    } finally {
      if (created.length) {
        accounts.value = [...accounts.value, ...created]
        for (const account of created) {
          void window.api.recordUsagePoint(account.id, toPlain(account.usage))
        }
        persist(true)
      }
      // 同上：running 一定要复位，否则会把后续的自动刷新全部挡掉
      task.value.running = false
    }
    return result
  }

  /**
   * 恢复备份里的分组定义，返回「备份 id -> 本机 id」映射。
   *
   * 同名分组复用本机已有的（只改映射，不新建），其余按备份顺序追加到末尾。
   * 只换一次数组引用，写盘交给调用方的 persist，避免一组一次 IO。
   */
  function restoreGroups(incoming?: AccountGroup[]): Map<string, string> {
    const map = new Map<string, string>()
    if (!incoming?.length) return map

    const byName = new Map(groups.value.map((g) => [g.name, g]))
    const usedIds = new Set(groups.value.map((g) => g.id))
    const added: AccountGroup[] = []
    let order = groups.value.length ? Math.max(...groups.value.map((g) => g.order)) + 1 : 0

    for (const raw of [...incoming].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))) {
      const name = (raw?.name ?? '').trim()
      if (!name || !raw?.id) continue
      const existing = byName.get(name)
      if (existing) {
        map.set(raw.id, existing.id)
        continue
      }
      // 备份 id 在本机没被占用就沿用，能让同一份备份反复恢复时保持稳定
      const id = usedIds.has(raw.id) ? uuidv4() : raw.id
      const group: AccountGroup = { id, name, order: order++ }
      usedIds.add(id)
      byName.set(name, group)
      added.push(group)
      map.set(raw.id, id)
    }

    if (added.length) groups.value = [...groups.value, ...added]
    return map
  }

  /** 恢复完整导出文件（保留用量、订阅等快照） */
  function importFullData(data: AccountExportData): BatchResult {
    const result: BatchResult = { success: 0, failed: 0, skipped: 0, messages: [] }
    const created: Account[] = []
    // 与 importItems 一致，用 Set 查重避免逐条线性扫描
    const createdKeys = new Set<string>()
    /*
     * createdAt 一律按「导入这一刻」重排，不沿用备份文件里的原值。
     *
     * 列表默认按 createdAt 倒序，沿用原值会让刚恢复的账号按它们的历史时间
     * 散落在列表各处，用户根本找不到自己刚导进来的是哪些。
     * 批内按下标偏移，倒序下用 total - i 让文件里靠前的排在更上方。
     */
    const baseTime = importBaseTime()
    const list = data.accounts ?? []
    const total = list.length
    /*
     * 先把备份里的分组定义落地，得到「备份里的 id -> 本机的 id」映射。
     * 备份文件的 id 在本机可能不存在（换机恢复），直接沿用会变成悬空 id；
     * 同名分组则复用本机已有的那个，不重复建。
     */
    const groupsBefore = groups.value.length
    const groupIdMap = restoreGroups(data.groups)

    for (const [i, raw] of list.entries()) {
      if (!raw?.credentials?.refreshToken) {
        result.failed++
        continue
      }
      const idp = normalizeIdp(raw.idp)
      const key = `${raw.email}|${idp}`
      if (exists(raw.email, raw.userId, idp) || createdKeys.has(key)) {
        result.skipped++
        continue
      }
      createdKeys.add(key)
      /*
       * 分组 id 先走映射；映射不到时若本机正好有这个分组（同机恢复、或老备份
       * 没带 groups 字段）就沿用，否则当未分组处理，不留悬空引用。
       */
      const mappedGroupId = raw.groupId
        ? groupIdMap.get(raw.groupId) ?? (groupMap.value.has(raw.groupId) ? raw.groupId : undefined)
        : undefined
      const { groupId: _dropGroupId, ...restRaw } = raw
      created.push({
        ...restRaw,
        ...(mappedGroupId ? { groupId: mappedGroupId } : {}),
        id: raw.id || uuidv4(),
        idp,
        isActive: false,
        usage: raw.usage ?? emptyUsage(),
        subscription: raw.subscription ?? { type: 'Free' },
        status: raw.status ?? 'unknown',
        createdAt: baseTime + (total - i),
        lastUsedAt: raw.lastUsedAt ?? baseTime
      })
      result.success++
    }

    if (created.length) accounts.value = [...accounts.value, ...created]
    // 只新增了分组（账号全跳过）也要落盘，否则新分组下次启动就丢了
    if (created.length || groups.value.length !== groupsBefore) persist(true)
    if (result.skipped) result.messages.push(`跳过 ${result.skipped} 个已存在的账号`)
    console.info(
      `[Account] 导入备份完成：新增 ${result.success}，跳过 ${result.skipped}，失败 ${result.failed}`
    )
    return result
  }

  // ============ 刷新 Token ============

  function applySnapshot(id: string, snapshot: AccountSnapshot): void {
    const account = get(id)
    if (!account) return
    // 积分变化日志由主进程去重：没变化的刷新不会落记录
    void window.api.recordUsagePoint(id, toPlain(snapshot.usage))
    updateAccount(id, {
      email: snapshot.email || account.email,
      userId: snapshot.userId ?? account.userId,
      // 记住主进程实测生效的 profileArn，下轮一次命中（Enterprise 免去重问 profile）
      profileArn: snapshot.profileArn || account.profileArn,
      subscription: snapshot.subscription,
      usage: snapshot.usage,
      status: 'active',
      lastError: undefined,
      lastCheckedAt: Date.now(),
      credentials: snapshot.accessToken
        ? {
            ...account.credentials,
            accessToken: snapshot.accessToken,
            refreshToken: snapshot.refreshToken || account.credentials.refreshToken,
            expiresAt: Date.now() + (snapshot.expiresIn ?? DEFAULT_EXPIRES_IN) * 1000
          }
        : account.credentials
    })
  }

  async function refreshToken(id: string): Promise<{ ok: boolean; error?: string; syncedToIde?: boolean }> {
    const account = get(id)
    if (!account) return { ok: false, error: '账号不存在' }

    const res = await window.api.refreshAccountToken(toPlain(account))
    if (!res.success || !res.data) {
      // 凭证被拒和网络异常要区分状态，但错误文案一律保留接口原始返回，便于排查
      const raw = res.error || 'Token 刷新失败'
      updateAccount(id, {
        status: isCredentialRejected(raw) ? 'expired' : 'error',
        lastError: raw,
        lastCheckedAt: Date.now()
      })
      return { ok: false, error: raw }
    }

    // 请求期间凭证可能已被主进程主动续期更新过，这里重新取一次，
    // 否则展开的是 await 之前的旧 credentials，会把新值覆盖回去
    const latest = get(id) ?? account
    updateAccount(id, {
      credentials: {
        ...latest.credentials,
        accessToken: res.data.accessToken,
        refreshToken: res.data.refreshToken,
        expiresAt: Date.now() + res.data.expiresIn * 1000
      },
      status: 'active',
      lastError: undefined
    })
    return { ok: true, syncedToIde: res.data.syncedToIde }
  }

  /**
   * 同步主进程主动续期后的新凭证。
   *
   * 主进程只对 IDE 激活账号续期，并且会把新凭证写进磁盘。渲染进程若不同步，
   * 内存里留着的旧 refreshToken 会在下一次 persist 时覆盖磁盘（全量写入），
   * 之后无论谁再拿它去刷新都会 invalid_grant，表现就是自动刷新时不时失败。
   */
  function applyRenewedCredentials(payload: ProactiveRenewalPayload): void {
    const account = get(payload.accountId)
    if (!account) return
    updateAccount(payload.accountId, {
      credentials: {
        ...account.credentials,
        accessToken: payload.accessToken,
        refreshToken: payload.refreshToken,
        expiresAt: Date.now() + payload.expiresIn * 1000
      },
      /*
       * 主进程续期后没能写进 IDE，说明它已不是 IDE 激活账号，续期也随之停止调度。
       * 这里同步清掉 isActive，让 refreshExpiringKeys 重新接管它；
       * 否则它会被主动续期和自动刷新同时排除，一直到 token 过期才被动刷新，
       * 那时 refreshToken 很可能已被 IDE 换废。
       */
      ...(payload.syncedToIde ? {} : { isActive: false }),
      status: 'active',
      lastError: undefined
    })
    console.info(
      payload.syncedToIde
        ? `[ProactiveRenewal] 已同步续期后的凭证：${account.email}`
        : `[ProactiveRenewal] 已同步凭证，但该账号不再由主动续期负责：${account.email}`
    )
  }

  async function checkStatus(id: string): Promise<{ ok: boolean; error?: string }> {
    const account = get(id)
    if (!account) return { ok: false, error: '账号不存在' }

    const res = await window.api.checkAccountStatus(toPlain(account))
    if (!res.success || !res.data) {
      const raw = res.error || '用量刷新失败'
      const credentialGone = !res.banned && isCredentialRejected(raw)
      updateAccount(id, {
        status: res.banned ? 'banned' : credentialGone ? 'expired' : 'error',
        lastError: raw,
        lastCheckedAt: Date.now()
      })
      return { ok: false, error: raw }
    }
    applySnapshot(id, res.data)
    return { ok: true }
  }

  /**
   * 批量刷新密钥或用量。ids 决定入队顺序（并发执行，完成顺序不保证），
   * 调用方按界面排序传入即可让靠前的账号先开始。
   * onProgress 用于实时反馈进度，不传则静默执行。
   */
  async function runBatch(
    ids: string[],
    kind: 'refresh' | 'check',
    onProgress?: (done: number, total: number) => void
  ): Promise<BatchResult> {
    const result: BatchResult = { success: 0, failed: 0, skipped: 0, messages: [] }
    if (ids.length === 0) return result

    task.value = {
      running: true,
      type: kind === 'refresh' ? 'account-key-refresh' : 'account-usage-refresh',
      label: kind === 'refresh' ? '批量刷新密钥' : '批量刷新用量',
      total: ids.length,
      done: 0
    }

    // running 必须在 finally 里复位：池子里任何一个任务抛异常都会让整个 runPool reject，
    // 一旦这里漏掉复位，task.running 会永久为 true，之后所有自动刷新都会被静默跳过
    try {
      await runPool(
        ids,
        settingsStore.settings.concurrency,
        async (id) => {
          // 单个账号的异常必须就地兜住：抛出去会中断所在的并发通道，
          // 该通道排队中的账号会被整批丢掉，表现为「一批里有些账号没刷新」
          try {
            const res = kind === 'refresh' ? await refreshToken(id) : await checkStatus(id)
            if (res.ok) result.success++
            else {
              result.failed++
              result.messages.push(`${get(id)?.email ?? id}：${res.error}`)
            }
          } catch (e) {
            result.failed++
            result.messages.push(`${get(id)?.email ?? id}：${errorMessage(e)}`)
          } finally {
            task.value.done++
            onProgress?.(task.value.done, ids.length)
          }
        },
        // 上游按突发流量限流，通道同帧起跑时一批里总有几个吃 403
        { staggerMs: 400 }
      )
    } finally {
      task.value.running = false
      persist(true)
      console.info(
        `[Account] ${task.value.label}结束：共 ${ids.length}，成功 ${result.success}，失败 ${result.failed}`
      )
    }
    return result
  }

  // ============ 切号 / IDE 同步 ============

  async function switchTo(
    id: string
  ): Promise<{ ok: boolean; error?: string; result?: SwitchAccountResult }> {
    const account = get(id)
    if (!account) return { ok: false, error: '账号不存在' }

    const res = await window.api.switchAccount({
      accountId: id,
      accessToken: account.credentials.accessToken,
      refreshToken: account.credentials.refreshToken,
      clientId: account.credentials.clientId,
      clientSecret: account.credentials.clientSecret,
      region: account.credentials.region,
      startUrl: account.credentials.startUrl,
      authMethod: authMethodOf(account.idp),
      provider: account.idp,
      profileArn: account.profileArn || account.credentials.profileArn
    })
    if (!res.success || !res.data) {
      console.warn(`[Account] 切换到 ${account.email} 失败：${res.error}`)
      return { ok: false, error: res.error }
    }

    const result = res.data
    console.info(
      `[Account] 已切换到 ${account.email}（profileArn 校验${result.verified ? '通过' : '未通过'}）`
    )
    accounts.value = accounts.value.map((a) =>
      a.id === id
        ? {
            ...a,
            isActive: true,
            lastUsedAt: Date.now(),
            status: 'active',
            lastError: undefined,
            // 记住主进程实测可用的 profileArn，下次切号少试一轮
            profileArn: result.profileArn || a.profileArn,
            credentials: {
              ...a.credentials,
              accessToken: result.accessToken,
              refreshToken: result.refreshToken,
              expiresAt: Date.now() + result.expiresIn * 1000
            }
          }
        : { ...a, isActive: false }
    )
    activeAccountId.value = id
    persist(true)
    return { ok: true, result }
  }

  async function restartKiroIde(): Promise<{ ok: boolean; message: string }> {
    const res = await window.api.restartKiroIde()
    if (!res.success || !res.data) {
      return { ok: false, message: res.error || '重启 Kiro IDE 失败' }
    }
    return { ok: res.data.started, message: res.data.message }
  }

  /** 读本地 kiro-auth-token.json，按 refreshToken 反向匹配当前激活账号 */
  async function syncActiveFromIde(): Promise<void> {
    const res = await window.api.getActiveKiroToken()
    const diskRefresh = res.success ? res.data?.refreshToken : undefined
    let matchedId: string | null = null
    if (diskRefresh) {
      matchedId = accounts.value.find((a) => a.credentials.refreshToken === diskRefresh)?.id ?? null
    }
    const changed = accounts.value.some((a) => a.isActive !== (a.id === matchedId))
    if (!changed) {
      activeAccountId.value = matchedId
      return
    }
    accounts.value = accounts.value.map((a) => ({ ...a, isActive: a.id === matchedId }))
    activeAccountId.value = matchedId
    persist()
  }

  async function logoutIde(): Promise<{ ok: boolean; deleted?: number; error?: string }> {
    const res = await window.api.logoutKiro()
    if (!res.success) return { ok: false, error: res.error }
    accounts.value = accounts.value.map((a) => ({ ...a, isActive: false }))
    activeAccountId.value = null
    persist(true)
    return { ok: true, deleted: res.data?.deleted }
  }

  // ============ 自动刷新调度 ============

  // 调度方式：只记「下一轮的绝对到期时间」，再用一个秒级 tick 检查是否越过。
  //
  // 之前是给每条任务开一个 setInterval(间隔分钟数)，实测不按时执行，原因有两个：
  // 1) 窗口最小化到托盘后页面转入后台，Chromium 会节流甚至冻结长间隔定时器，
  //    回调迟迟不来，界面上的倒计时也就一直停在 0 秒；
  // 2) 系统睡眠、进程被挂起期间错过的轮次，setInterval 不会补跑，直接丢掉。
  // 换成到期时间 + 秒级 tick 后，无论被节流或挂起多久，恢复后的第一个 tick 就会补上。
  const AUTO_TICK_MS = 1_000

  let tickTimer: ReturnType<typeof setInterval> | null = null
  /** 自动任务自己的串行锁，两轮同时到期时排队跑，不再互相丢轮 */
  let autoRunning = false

  /** 下一轮密钥 / 用量刷新的时间戳，未启用时为 null，供界面展示 */
  const nextKeyRefreshAt = ref<number | null>(null)
  const nextUsageRefreshAt = ref<number | null>(null)

  // 已生效的间隔（分钟）。设置对象是整体替换的，换主题、折叠侧边栏这类无关改动
  // 也会触发外部的 watch，靠这两个值判断间隔是否真的变了，避免倒计时被无故清零
  let appliedKeyInterval = 0
  let appliedUsageInterval = 0

  /**
   * 上次真正跑完一轮的时间，落 localStorage 跨启动保留。
   * 冷启动时据此判断是否已经欠了一轮，欠了就立刻补跑，不必再等一个完整间隔。
   */
  const LAST_RUN_STORAGE = {
    key: 'kal:auto-key-refresh-at',
    usage: 'kal:auto-usage-refresh-at'
  } as const

  type AutoKind = keyof typeof LAST_RUN_STORAGE

  function readLastRun(kind: AutoKind): number {
    const raw = Number(localStorage.getItem(LAST_RUN_STORAGE[kind]))
    // 缺记录（首次启动）或数据被改坏时返回 0，一律按「欠一轮」处理
    return Number.isFinite(raw) && raw > 0 ? raw : 0
  }

  function markRan(kind: AutoKind): void {
    try {
      localStorage.setItem(LAST_RUN_STORAGE[kind], String(Date.now()))
    } catch {
      // 隐私模式下 localStorage 可能不可写，退化成「每次启动都补跑一轮」
    }
  }

  const keyIntervalMs = (): number => Math.max(1, settingsStore.settings.keyRefreshInterval) * 60_000
  const usageIntervalMs = (): number =>
    Math.max(1, settingsStore.settings.usageRefreshInterval) * 60_000

  /**
   * 只处理即将过期的账号（剩余有效期 < AUTO_REFRESH_WINDOW_MS）。
   *
   * refreshToken 是轮换式的，刷一次旧值立即作废，所以刷得越勤、轮换失败与限流的
   * 面就越大，而 token 本身有 1 小时寿命，没必要每轮都换。
   *
   * IDE 当前激活账号在「主动续期」开启时排除在外：它每次轮换都必须同步写入 IDE 的
   * token 文件，同步失败就会让 IDE 被登出。主进程的主动续期专门负责这个账号
   * （剩 15 分钟时刷 + 写盘 + 失败即停止调度交给 IDE 兜底），两边同时刷同一个账号
   * 反而会互相拿到已作废的旧 token。主动续期关闭时，这里照常覆盖它。
   */
  async function refreshExpiringKeys(): Promise<void> {
    const renewalOn = settingsStore.settings.proactiveRenewalEnabled
    const soon = accounts.value
      .filter(
        (a) =>
          a.status !== 'banned' &&
          !(renewalOn && a.isActive) &&
          a.credentials.expiresAt - Date.now() < AUTO_REFRESH_WINDOW_MS
      )
      .map((a) => a.id)
    if (!soon.length) {
      console.info('[AutoRefresh] 本轮没有即将过期的账号，跳过密钥刷新')
      return
    }
    const res = await runBatch(soon, 'refresh')
    if (res.success) message.success(`自动刷新密钥完成：成功 ${res.success}，失败 ${res.failed}`)
  }

  /**
   * 覆盖全部值得刷的账号，界面上保持静默，只往控制台记录，避免定时弹通知打扰。
   *
   * 跳过封禁与凭证失效的账号：自动刷新是每隔一段时间就跑一轮的，
   * 把必然 401 / 403 的账号一直带着刷，只会白耗时间并在日志里堆无效告警。
   * 临时故障（网络、限流、5xx）不在跳过范围内，下一轮照常重试。
   */
  async function refreshAllUsage(): Promise<void> {
    const runnable = accounts.value.filter((a) => !shouldSkipAccountUsageRefresh(a))
    const ids = runnable.map((a) => a.id)
    const skipped = accounts.value.length - ids.length
    if (!ids.length) return
    const startedAt = Date.now()
    console.info(
      `[AutoRefresh] 开始刷新用量：${ids.length} 个账号` +
        (skipped ? `（跳过 ${skipped} 个封禁或凭证失效账号）` : '')
    )
    const res = await runBatch(ids, 'check')
    // 打印耗时便于对照间隔：耗时接近或超过间隔时下一轮会紧接着开始
    console.info(
      `[AutoRefresh] 用量刷新结束：成功 ${res.success}，失败 ${res.failed}，` +
        `耗时 ${Math.round((Date.now() - startedAt) / 1000)}s`
    )
    if (res.failed) console.warn('[AutoRefresh] 用量刷新失败明细：', res.messages)
  }

  /** 每秒检查两条任务是否到期；到期就跑，跑完从当前时间重新计时 */
  async function autoTick(): Promise<void> {
    if (autoRunning) return
    const at = Date.now()
    const keyDue = nextKeyRefreshAt.value !== null && at >= nextKeyRefreshAt.value
    const usageDue = nextUsageRefreshAt.value !== null && at >= nextUsageRefreshAt.value
    if (!keyDue && !usageDue) return
    // 手动批量操作正占用着全局任务状态：本轮不丢，等它结束后的下一个 tick 立刻补跑
    if (task.value.running) return

    autoRunning = true
    try {
      // 到期时间先往后推一轮再执行：中途异常也不会卡在「一直到期」的状态里反复重试。
      // 执行结束后只在「已经超过下一轮时间」时才顺延，否则每轮都会被本轮耗时顶后一截，
      // 账号多的时候实际间隔会越跑越长
      if (keyDue) {
        const next = at + keyIntervalMs()
        nextKeyRefreshAt.value = next
        await refreshExpiringKeys()
        markRan('key')
        if (Date.now() >= next) nextKeyRefreshAt.value = Date.now() + keyIntervalMs()
      }
      if (usageDue) {
        const next = at + usageIntervalMs()
        nextUsageRefreshAt.value = next
        await refreshAllUsage()
        markRan('usage')
        if (Date.now() >= next) nextUsageRefreshAt.value = Date.now() + usageIntervalMs()
      }
    } catch (e) {
      console.error('[AutoRefresh] 本轮自动刷新异常：', e)
    } finally {
      autoRunning = false
    }
  }

  function ensureTick(): void {
    if (tickTimer) return
    tickTimer = setInterval(() => void autoTick(), AUTO_TICK_MS)
  }

  function stopTick(): void {
    if (tickTimer) clearInterval(tickTimer)
    tickTimer = null
  }

  /**
   * 密钥刷新整轮从现在开始重新计时。
   * 手动全量刷新完也调它，避免刚刷完又马上被自动任务刷一次。
   */
  function scheduleKeyRefresh(): void {
    appliedKeyInterval = settingsStore.settings.keyRefreshInterval
    if (!settingsStore.settings.autoRefresh) {
      nextKeyRefreshAt.value = null
      return
    }
    // 调用方刚刚全量刷过，等价于跑完一轮，记下来供下次启动判断
    markRan('key')
    nextKeyRefreshAt.value = Date.now() + keyIntervalMs()
    ensureTick()
  }

  /** 用量刷新整轮重新计时，同上 */
  function scheduleUsageRefresh(): void {
    appliedUsageInterval = settingsStore.settings.usageRefreshInterval
    if (!settingsStore.settings.autoRefreshUsage) {
      nextUsageRefreshAt.value = null
      return
    }
    markRan('usage')
    nextUsageRefreshAt.value = Date.now() + usageIntervalMs()
    ensureTick()
  }

  /**
   * 按「上次跑完的时间 + 间隔」对齐下一轮，而不是从现在起算。
   *
   * 冷启动、长时间休眠、或把间隔从长调短之后，如果已经越过应刷时间，
   * 这里算出的时间点就落在过去，下一个 tick（1 秒内）立刻补跑一轮，
   * 不必再干等一个完整间隔。
   */
  function alignNextRun(kind: AutoKind): number {
    const interval = kind === 'key' ? keyIntervalMs() : usageIntervalMs()
    const due = readLastRun(kind) + interval
    // 已经欠一轮：统一归到当下，界面显示「本轮正在执行…」而不是一个久远的时间
    return due <= Date.now() ? Date.now() : due
  }

  function alignKeyRefresh(): void {
    appliedKeyInterval = settingsStore.settings.keyRefreshInterval
    if (!settingsStore.settings.autoRefresh) {
      nextKeyRefreshAt.value = null
      return
    }
    nextKeyRefreshAt.value = alignNextRun('key')
    ensureTick()
  }

  function alignUsageRefresh(): void {
    appliedUsageInterval = settingsStore.settings.usageRefreshInterval
    if (!settingsStore.settings.autoRefreshUsage) {
      nextUsageRefreshAt.value = null
      return
    }
    nextUsageRefreshAt.value = alignNextRun('usage')
    ensureTick()
  }

  /**
   * 按当前设置对齐两条任务：开关刚打开或间隔真的改了才重新计时，
   * 其余设置改动（主题、侧边栏、隐私模式……）不影响已经在跑的倒计时。
   *
   * 计时基准是「上次跑完的时间」，所以冷启动时若距上次刷新已超过间隔，
   * 会立刻补跑一轮而不是干等一个完整间隔。
   */
  function startAutoRefresh(): void {
    const { autoRefresh, autoRefreshUsage, keyRefreshInterval, usageRefreshInterval } =
      settingsStore.settings
    // 用 align 而不是 schedule：冷启动或改短间隔后若已欠一轮，会立刻补跑
    if (!autoRefresh) nextKeyRefreshAt.value = null
    else if (nextKeyRefreshAt.value === null || appliedKeyInterval !== keyRefreshInterval) {
      alignKeyRefresh()
    }
    if (!autoRefreshUsage) nextUsageRefreshAt.value = null
    else if (nextUsageRefreshAt.value === null || appliedUsageInterval !== usageRefreshInterval) {
      alignUsageRefresh()
    }

    if (nextKeyRefreshAt.value === null && nextUsageRefreshAt.value === null) stopTick()
    else ensureTick()
  }

  function stopAutoRefresh(): void {
    stopTick()
    nextKeyRefreshAt.value = null
    nextUsageRefreshAt.value = null
  }

  return {
    // 状态
    accounts,
    activeAccount,
    selectedIds,
    loading,
    task,
    filter,
    // 查询
    filtered,
    stats,
    get,
    applyFilter,
    // 增删改
    load,
    addByCredentials,
    addByOnlineLogin,
    updateAccount,
    setNoteForAccounts,
    // 分组
    groups,
    groupMap,
    groupCounts,
    addGroup,
    renameGroup,
    removeGroup,
    reorderGroups,
    setGroupForAccounts,
    removeAccounts,
    importItems,
    importFullData,
    // 刷新 / 切号
    refreshToken,
    checkStatus,
    applyRenewedCredentials,
    runBatch,
    switchTo,
    restartKiroIde,
    syncActiveFromIde,
    logoutIde,
    nextKeyRefreshAt,
    nextUsageRefreshAt,
    scheduleKeyRefresh,
    scheduleUsageRefresh,
    startAutoRefresh,
    stopAutoRefresh
  }
})

// setup 风格的 store 默认不参与 HMR，改完 store 后运行中的实例会缺少新增方法
if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useAccountsStore, import.meta.hot))
}
