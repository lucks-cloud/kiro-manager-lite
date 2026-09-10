// API Key 管理与网关编排层
import { randomUUID } from 'crypto'
import { getKeyData, setKeyData } from './store'
import { appendUsagePoint, clearUsageHistory, pruneKeyUsageHistory } from './usageHistory'
import { clearGatewayHistory, pruneGatewayHistory } from './gatewayHistory'
import { discardGatewayStats } from './gatewayStats'
import {
  fetchAccountInfo,
  fetchModels,
  gatewayRunning,
  getGatewayObservation,
  startGateway,
  stopGateway
} from './keyGateway'
import {
  applyEndpointOverride,
  endpointConflict,
  isEndpointBound,
  isKiroInstalled,
  restoreEndpointOverride,
  restoreEndpointOverrideSync,
  watchEndpointOverride,
  type EndpointSnapshot
} from './kiroSettings'
import { assertKeyGatewaySupported } from './kiroCapability'
import { releasePorts } from './localPorts'
import { log } from './logger'
import { shouldSkipKeyUsageRefresh } from '../shared/refreshPolicy'
import type {
  AccountGroup,
  AccountUsage,
  KeyEntry,
  KeyGatewayConflict,
  KeyGatewayData,
  KeyGatewayStatus,
  KeyModelInfo,
  KeyTestResult
} from '../shared/types'

let notify: ((status: KeyGatewayStatus) => void) | null = null

/** 接管期间的端点守护，关闭接管 / 退出时必须摘掉 */
let stopEndpointWatch: (() => void) | null = null

/**
 * 真实转发可作为「IDE 已接管」证据的有效期。
 * IDE 空闲时不发请求，窗口太短会在闲置后误报异常；太长则 IDE 重启并真的失去接管后仍显示正常。
 */
const FORWARD_EVIDENCE_WINDOW_MS = 30 * 60_000

function activeEntry(data = getKeyData()): KeyEntry | undefined {
  return data.keys.find((entry) => entry.id === data.activeKeyId)
}

function activeCredential(): { id: string; key: string } | null {
  const data = getKeyData()
  if (!data.enabled) return null
  const entry = activeEntry(data)
  return entry ? { id: entry.id, key: entry.key } : null
}

/**
 * 网关转发实际使用的区域：跟随当前 Key。
 * 每次请求都重新读取，换 Key 后无需重启网关即可切到新区域。
 */
function region(): string {
  const data = getKeyData()
  return activeEntry(data)?.region || data.region
}

/** 校验并归一区域串；空值回退到调用方给的默认区域 */
function normalizeRegion(value: unknown, fallback: string): string {
  const next = String(value ?? '').trim()
  if (!next) return fallback
  if (next.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(next)) {
    throw new Error('Region 格式无效，仅支持小写字母、数字和连字符')
  }
  return next
}

function historySubjectId(id: string): string {
  return `key:${id}`
}

/**
 * API Key 用量历史由主进程在同步提交时写入，确保同步成功返回时弹窗即可读取。
 * appendUsagePoint 会跳过 current / limit 均未变化的连续快照。
 */
function recordKeyUsage(entry: KeyEntry): boolean {
  if (
    typeof entry.usedCredits !== 'number'
    || !Number.isFinite(entry.usedCredits)
    || typeof entry.totalCredits !== 'number'
    || !Number.isFinite(entry.totalCredits)
  ) return false
  const usage: AccountUsage = {
    current: entry.usedCredits,
    limit: entry.totalCredits,
    percentUsed: entry.totalCredits > 0 ? entry.usedCredits / entry.totalCredits : 0,
    lastUpdated: entry.lastCheckedAt ?? Date.now()
  }
  return appendUsagePoint(historySubjectId(entry.id), usage)
}

function originalSnapshot(data: KeyGatewayData): EndpointSnapshot {
  return data.originalEndpoints ?? { krs: [], cps: [] }
}

function validateKey(value: string): string {
  const key = String(value || '').trim()
  if (!key.startsWith('ksk_')) throw new Error('API Key 必须以 ksk_ 开头')
  if (key.length <= 4) throw new Error('API Key 格式不正确')
  return key
}

function validatePorts(krs: number, cps: number): void {
  for (const [name, value] of [['KRS', krs], ['CPS', cps]] as const) {
    if (!Number.isInteger(value) || value < 1024 || value > 65535) {
      throw new Error(`${name} 端口必须是 1024–65535 的整数`)
    }
  }
  if (krs === cps) throw new Error('KRS 与 CPS 端口不能相同')
}

export async function getGatewayStatus(message?: string, needRestart = false): Promise<KeyGatewayStatus> {
  const data = getKeyData()
  const running = gatewayRunning()
  // 端点映射按区域生成，这里必须用与写入时相同的区域（当前 Key 的区域）来比对
  const endpointsBound = data.enabled
    ? await isEndpointBound(data.ports.krs, data.ports.cps, region()).catch(() => false)
    : false
  const observation = getGatewayObservation()
  // observation 在网关启停时都会清空，本身就只包含当前会话的证据，无需再与磁盘状态相与。
  // 这里绝不能要求 endpointsBound：Kiro IDE 启动时会把 settings.json 里我们写的端点回写清空，
  // 而它内存里仍持有本地端点、请求照旧走网关。磁盘一空就否掉真实转发观测，
  // 会把「正在正常转发」误报成接管异常，并连带让界面认不出实际在用的 Key。
  const observedInCurrentSession = running && !!observation.lastForwardedKeyId
  const forwardedRecently =
    observedInCurrentSession
    && typeof observation.lastForwardedAt === 'number'
    && Date.now() - observation.lastForwardedAt <= FORWARD_EVIDENCE_WINDOW_MS
  // 磁盘端点已绑定，或近期确实有请求经过网关，两者任一成立即视为 IDE 已被接管
  const ideTakenOver = running && (endpointsBound || forwardedRecently)
  return {
    enabled: data.enabled,
    running,
    activeKeyId: data.enabled ? (data.activeKeyId ?? null) : null,
    lastForwardedKeyId: observedInCurrentSession ? observation.lastForwardedKeyId : null,
    lastForwardedAt: observedInCurrentSession ? observation.lastForwardedAt : undefined,
    observedInCurrentSession,
    ideTakenOver,
    endpointsHijacked: data.enabled && running && !endpointsBound,
    region: region(),
    ports: { ...data.ports },
    endpointsBound,
    needRestart,
    settingsPath: data.settingsPath,
    message
  }
}

async function emitStatus(message?: string, needRestart = false): Promise<KeyGatewayStatus> {
  const status = await getGatewayStatus(message, needRestart)
  notify?.(status)
  return status
}

/** 状态推送的即发即忘版本：调用方在同步路径上（观测回调、文件守护）用不了 await */
function emitStatusAsync(message?: string): void {
  void emitStatus(message).catch((error) => {
    log('warn', `[KeyGateway] 推送网关状态失败：${error instanceof Error ? error.message : String(error)}`)
  })
}

function emitObservationStatus(): void {
  emitStatusAsync()
}

/**
 * 挂上端点守护：Kiro IDE 启动时会把我们写入的端点回写清空，不修就会在 IDE 下次重启时静默丢掉接管。
 * 区域用 region() 动态取，换 Key / 换区后守护跟着走，无需重挂。
 * 端口只在接管关闭时才允许修改，因此整个会话期间固定。
 */
function startEndpointWatch(ports: { krs: number; cps: number }): void {
  stopEndpointWatch?.()
  stopEndpointWatch = watchEndpointOverride({
    krsPort: ports.krs,
    cpsPort: ports.cps,
    getRegion: region,
    onRepair: ({ settingsPath }) => {
      // 只更新路径。originalEndpoints 必须保持首次接管时记下的官方值：
      // 此刻磁盘上的端点已被清空，重新记录会把还原依据一起清掉。
      const latest = getKeyData()
      latest.settingsPath = settingsPath
      setKeyData(latest)
      log('warn', `[KeyGateway] Kiro 端点被外部改写，已自动改回本地网关：${settingsPath}`)
      emitStatusAsync('检测到 Kiro IDE 端点被改写，已自动恢复为本地网关')
    },
    onError: (message) => log('warn', `[KeyGateway] 端点守护异常：${message}`)
  })
}

function stopEndpointWatcher(): void {
  stopEndpointWatch?.()
  stopEndpointWatch = null
}

export function loadKeys(): KeyGatewayData {
  const data = getKeyData()
  const keyIds = data.keys.map((entry) => entry.id)
  // 启动时顺手裁掉旧版本或异常退出遗留的孤儿记录。
  pruneKeyUsageHistory(keyIds)
  pruneGatewayHistory(keyIds)
  // 升级兼容：已有额度但尚无历史的旧 Key 会在首次加载时补一条基线。
  for (const entry of data.keys) recordKeyUsage(entry)
  return data
}

export function addKey(value: string, note = '', region?: string): KeyGatewayData {
  const key = validateKey(value)
  const data = getKeyData()
  if (data.keys.some((entry) => entry.key === key)) throw new Error('该 API Key 已存在')
  const entryRegion = normalizeRegion(region, data.region)
  const entry: KeyEntry = {
    id: randomUUID(),
    key,
    note: note.trim() || undefined,
    region: entryRegion,
    createdAt: Date.now()
  }
  data.keys.push(entry)
  // 记住本次选择，作为下次添加 / 导入的预填值
  data.region = entryRegion
  setKeyData(data)
  return data
}

export interface ImportKeysResult {
  data: KeyGatewayData
  added: number
  skipped: number
  invalid: number
}

export function importKeys(text: string, region?: string): ImportKeysResult {
  const data = getKeyData()
  const existing = new Set(data.keys.map((entry) => entry.key))
  const entryRegion = normalizeRegion(region, data.region)
  let added = 0
  let skipped = 0
  let invalid = 0
  for (const raw of String(text || '').split(/\r?\n/)) {
    const key = raw.trim()
    if (!key) continue
    if (!key.startsWith('ksk_') || key.length <= 4) {
      invalid++
      continue
    }
    if (existing.has(key)) {
      skipped++
      continue
    }
    existing.add(key)
    // 本批导入的 Key 共用同一个区域，后续可在卡片上逐个换区
    const entry: KeyEntry = { id: randomUUID(), key, region: entryRegion, createdAt: Date.now() }
    data.keys.push(entry)
    added++
  }
  if (added) data.region = entryRegion
  setKeyData(data)
  return { data, added, skipped, invalid }
}

export function updateKey(id: string, note: string): KeyGatewayData {
  const data = getKeyData()
  const entry = data.keys.find((item) => item.id === id)
  if (!entry) throw new Error('未找到该 API Key')
  entry.note = note.trim() || undefined
  setKeyData(data)
  return data
}

/**
 * 整表替换分组定义（新建 / 改名 / 删除 / 排序都走这一个入口）。
 *
 * 只给一个「整表替换」而不是四个细粒度接口：渲染层本来就持有完整分组列表，
 * 一次提交省掉四套 IPC，也不会出现「删了分组但键上还留着 id」的中间态 ——
 * 这里会顺手把落在已删分组上的 groupId 清掉。
 */
export function setKeyGroups(groups: AccountGroup[]): KeyGatewayData {
  const data = getKeyData()
  const seen = new Set<string>()
  const next: AccountGroup[] = []
  for (const raw of groups ?? []) {
    const name = (raw?.name ?? '').trim()
    const id = raw?.id
    if (!id || !name || seen.has(id)) continue
    seen.add(id)
    // order 一律按下标重排，避免删掉中间项后留下空洞
    next.push({ id, name, order: next.length })
  }
  data.groups = next
  for (const entry of data.keys) {
    if (entry.groupId && !seen.has(entry.groupId)) delete entry.groupId
  }
  setKeyData(data)
  return data
}

/**
 * 批量覆盖备注，留空即清空。
 * 单独开一个批量入口而不是让渲染层循环调 updateKey：那样每条都要落一次盘，
 * 几百个 Key 会把界面卡住。
 */
export function setKeysNote(ids: string[], note: string): KeyGatewayData {
  const data = getKeyData()
  const target = new Set(ids.filter(Boolean))
  const value = note.trim() || undefined
  for (const entry of data.keys) {
    if (target.has(entry.id)) entry.note = value
  }
  setKeyData(data)
  return data
}

/**
 * 批量设置分组：groupId 传 null 表示移出分组。
 * 传了 id 但分组不存在时直接报错，避免把悬空 id 写进存档。
 */
export function setKeysGroup(ids: string[], groupId: string | null): KeyGatewayData {
  const data = getKeyData()
  if (groupId && !(data.groups ?? []).some((group) => group.id === groupId)) {
    throw new Error('未找到该分组')
  }
  const target = new Set(ids.filter(Boolean))
  for (const entry of data.keys) {
    if (!target.has(entry.id)) continue
    if (groupId) entry.groupId = groupId
    // 未分组用「不存在该字段」表示，置 undefined 会把 undefined 写进存档
    else delete entry.groupId
  }
  setKeyData(data)
  return data
}

/**
 * 修改单个 Key 的区域。
 * 网关正在使用该 Key 时无需重启：转发前会重新读取当前 Key 的区域。
 * 已缓存的额度按旧区域查得，换区后置为待同步，避免展示跨区的陈旧数据。
 */
export async function updateKeyRegion(
  id: string,
  region: string
): Promise<{ data: KeyGatewayData; status: KeyGatewayStatus }> {
  const data = getKeyData()
  const entry = data.keys.find((item) => item.id === id)
  if (!entry) throw new Error('未找到该 API Key')
  const next = normalizeRegion(region, '')
  if (!next) throw new Error('Region 不能为空')
  if (entry.region === next) {
    return { data, status: await getGatewayStatus() }
  }

  entry.region = next
  entry.subscription = undefined
  entry.tier = undefined
  entry.usedCredits = undefined
  entry.totalCredits = undefined
  entry.nextResetAt = undefined
  entry.email = undefined
  entry.userId = undefined
  entry.lastCheckedAt = undefined
  entry.lastError = undefined
  // 换区后一切重新检测，上一区查出来的测活结论同样作废
  entry.lastChatError = undefined
  entry.lastChatCheckedAt = undefined
  data.region = next
  setKeyData(data)
  clearUsageHistory(historySubjectId(id))
  clearGatewayHistory(id)
  log('info', `[KeyGateway] Key ${id} 区域已改为 ${next}`)

  const isActive = data.enabled && data.activeKeyId === id
  // 改的正是当前 Key 时，端点映射要补上新区域
  const changed = isActive ? await rebindEndpointsForRegion(next) : false
  return {
    data: getKeyData(),
    status: await emitStatus(
      isActive
        ? `当前 Key 区域已改为 ${next}，后续网关请求立即生效，请重新同步额度`
        : `区域已改为 ${next}，请重新同步该 Key 的额度`,
      changed
    )
  }
}

export function deleteKey(id: string): KeyGatewayData {
  const data = getKeyData()
  if (data.enabled && data.activeKeyId === id) {
    throw new Error('该 Key 已被选为接管 Key，请先选择其它 Key 或关闭接管')
  }
  const before = data.keys.length
  data.keys = data.keys.filter((entry) => entry.id !== id)
  if (data.keys.length === before) throw new Error('未找到该 API Key')
  if (data.activeKeyId === id) data.activeKeyId = null
  setKeyData(data)
  clearUsageHistory(historySubjectId(id))
  // 同时清持久化累计/曲线、RPM 内存窗口，并阻止未结束请求在删除后重新回写。
  discardGatewayStats(id)
  return data
}

/**
 * 区域变化后重写 IDE 的端点映射。
 *
 * settings.json 里存的是「区域 -> 本地端点」列表，由 applyEndpointOverride 按区域生成。
 * 换 Key 或改区域后若不重写，isEndpointBound 会用新区域算出的期望值去比对旧映射而失配，
 * 界面就会误报「IDE 未由本应用网关接管」。
 * 这里不覆盖 originalEndpoints：首次接管记下的官方端点才是还原依据。
 */
async function rebindEndpointsForRegion(nextRegion: string): Promise<boolean> {
  const data = getKeyData()
  if (!data.enabled) return false
  if (await isEndpointBound(data.ports.krs, data.ports.cps, nextRegion).catch(() => false)) {
    return false
  }
  const applied = await applyEndpointOverride(data.ports.krs, data.ports.cps, nextRegion)
  const latest = getKeyData()
  latest.settingsPath = applied.settingsPath
  setKeyData(latest)
  log('info', `[KeyGateway] 端点映射已按区域 ${nextRegion} 重写`)
  return applied.changed
}

/** 网关开启时切换当前 Key；关闭状态不允许保留当前 Key。 */
export async function selectKey(id: string): Promise<{ data: KeyGatewayData; status: KeyGatewayStatus }> {
  const data = getKeyData()
  if (!data.enabled) throw new Error('API Key 网关未开启，请开启网关后再切换')
  const target = data.keys.find((entry) => entry.id === id)
  if (!target) throw new Error('未找到该 API Key')
  data.activeKeyId = id
  setKeyData(data)
  log('info', `[KeyGateway] 接管 Key 已选择为 ${id}`)
  // 新 Key 可能在另一个区域，端点映射要跟着补上该区域
  const changed = await rebindEndpointsForRegion(target.region)
  return {
    data: getKeyData(),
    status: await emitStatus('接管 Key 已更新，下一次网关请求使用新 Key', changed)
  }
}

export async function listKeyModels(id: string): Promise<KeyModelInfo[]> {
  const data = getKeyData()
  const entry = data.keys.find((item) => item.id === id)
  if (!entry) throw new Error('未找到该 API Key')
  const result = await fetchModels(entry.region, entry.key)
  return result.models
}

export async function testKey(id: string): Promise<KeyTestResult> {
  const data = getKeyData()
  const entry = data.keys.find((item) => item.id === id)
  if (!entry) throw new Error('未找到该 API Key')
  const [models, account] = await Promise.all([
    fetchModels(entry.region, entry.key),
    fetchAccountInfo(entry.region, entry.key)
  ])
  return {
    modelCount: models.models.length,
    defaultModel: models.defaultModel,
    subscription: account.subscriptionTitle,
    tier: account.tier,
    used: account.used,
    total: account.total,
    models: models.models
  }
}

/**
 * 记录一次真实对话测活的结论。
 * 单独存在 lastChatError 里，不与管理面同步的 lastError 混用，
 * 否则下一轮 syncKey 成功就会把这里查出来的 403 清掉。
 */
export function recordChatTestResult(id: string, error?: string): KeyGatewayData {
  const data = getKeyData()
  const entry = data.keys.find((item) => item.id === id)
  if (!entry) return data
  entry.lastChatError = error ? String(error).slice(0, 500) : undefined
  entry.lastChatCheckedAt = Date.now()
  setKeyData(data)
  return data
}

export async function syncKey(id: string): Promise<KeyGatewayData> {
  // 网络请求使用不可变快照；提交时重新读取最新数据，避免并发同步整表互相覆盖。
  const snapshot = getKeyData()
  const source = snapshot.keys.find((item) => item.id === id)
  if (!source) throw new Error('未找到该 API Key')

  let info: Awaited<ReturnType<typeof fetchAccountInfo>>
  try {
    info = await fetchAccountInfo(source.region, source.key)
  } catch (error) {
    const latest = getKeyData()
    const current = latest.keys.find((item) => item.id === id)
    if (current && current.key === source.key) {
      current.lastError = error instanceof Error ? error.message : String(error)
      setKeyData(latest)
    }
    throw error
  }

  const latest = getKeyData()
  const current = latest.keys.find((item) => item.id === id)
  if (!current || current.key !== source.key) throw new Error('API Key 已被删除或替换')
  current.subscription = info.subscriptionTitle
  current.tier = info.tier
  current.usedCredits = info.used ?? undefined
  current.totalCredits = info.total ?? undefined
  current.nextResetAt = info.nextResetAt ?? undefined
  // 上游按 isEmailRequired=true 返回的账号信息；查不到时保留旧值，不用 undefined 覆盖
  if (info.email) current.email = info.email
  if (info.userId) current.userId = info.userId
  current.lastCheckedAt = Date.now()
  current.lastError = undefined
  setKeyData(latest)
  // 与额度提交处于同一主进程调用链；首条自动成为 delta=0 的添加基线。
  recordKeyUsage(current)
  return latest
}

/**
 * 批量同步全部 Key 的用量。
 *
 * 会跳过确定性失败的 Key（凭证被拒、403、账号封禁）：这条路径也被自动刷新调用，
 * 每隔一段时间就跑一轮，把必然失败的 Key 一直带着刷只是白耗时间。
 * 临时故障（网络、限流、5xx）不跳过，下一轮照常重试；
 * 单个 Key 的手动刷新走 syncKey，不受这里影响，异常 Key 始终留有重试入口。
 */
export async function syncAllKeys(
  concurrency = 5
): Promise<{ data: KeyGatewayData; success: number; failed: number; skipped: number }> {
  const all = getKeyData().keys
  const ids = all.filter((entry) => !shouldSkipKeyUsageRefresh(entry)).map((entry) => entry.id)
  const skipped = all.length - ids.length
  const batchSize = Math.max(1, Math.min(Math.round(Number(concurrency) || 5), 20))
  let success = 0
  let failed = 0
  for (let i = 0; i < ids.length; i += batchSize) {
    const settled = await Promise.allSettled(ids.slice(i, i + batchSize).map((id) => syncKey(id)))
    for (const result of settled) result.status === 'fulfilled' ? success++ : failed++
  }
  if (skipped) log('info', `[KeyService] 批量同步跳过 ${skipped} 个凭证已失效的 Key`)
  return { data: getKeyData(), success, failed, skipped }
}

/** 查询当前是否被其它本地网关接管；未安装 IDE 时无从判断，按无冲突处理。 */
export async function inspectGatewayConflict(): Promise<KeyGatewayConflict | null> {
  const data = getKeyData()
  if (!isKiroInstalled()) return null
  return endpointConflict(data.ports.krs, data.ports.cps, region())
}

/**
 * 强制接管：停掉仍在监听旧端点的其它本地网关进程。
 * 端点改写由后续 applyEndpointOverride 完成，这里只负责让旧网关不再工作。
 */
async function releaseConflictingGateways(conflict: KeyGatewayConflict): Promise<string> {
  log('warn', `[KeyGateway] 强制接管：原接管端点 ${conflict.endpoints.join('、')}`)
  const results = conflict.ports.length ? await releasePorts(conflict.ports) : []
  const failed = results.filter((item) => !item.stopped)
  if (failed.length) {
    return `已强制接管 Kiro IDE 端点，但 ${failed.map((item) => item.port).join('、')} 端口仍被占用，请手动关闭对应程序`
  }
  const stoppedPorts = results.filter((item) => item.pids.length).map((item) => item.port)
  return stoppedPorts.length
    ? `已关闭其它本地网关（端口 ${stoppedPorts.join('、')}）并强制接管 Kiro IDE 端点`
    : '已强制接管 Kiro IDE 端点，未发现仍在运行的其它本地网关进程'
}

export async function enableGateway(
  keyId?: string,
  options: { force?: boolean } = {}
): Promise<KeyGatewayStatus> {
  const data = getKeyData()
  validatePorts(data.ports.krs, data.ports.cps)
  if (!data.keys.length) throw new Error('请先添加 API Key，再开启网关')
  const selectedId = keyId ?? data.activeKeyId
  const selected = data.keys.find((entry) => entry.id === selectedId)
  if (!selected) throw new Error('请先选择一个 API Key，再开启网关')
  if (!isKiroInstalled()) throw new Error('未找到 Kiro IDE 用户数据目录，请先安装并启动一次 Kiro IDE')
  // 旧版 Kiro 不读端点覆盖，写进去只会得到一个「配置写对了但请求照旧」的假成功
  await assertKeyGatewaySupported()

  const conflict = await endpointConflict(data.ports.krs, data.ports.cps, selected.region)
  if (conflict && !options.force) throw new Error(conflict.message)
  // 强制接管是用户在弹窗里显式确认的操作，会终止其它本地网关进程。
  const forcedNote = conflict ? await releaseConflictingGateways(conflict) : ''

  const pendingCredential = { id: selected.id, key: selected.key }
  let applied: Awaited<ReturnType<typeof applyEndpointOverride>> | null = null
  try {
    // 启用提交前持久态仍为“关闭且无当前 Key”，局部凭证只服务于启动窗口。
    await startGateway(
      data.ports.krs,
      data.ports.cps,
      () => activeCredential() ?? pendingCredential,
      region,
      emitObservationStatus
    )
    applied = await applyEndpointOverride(data.ports.krs, data.ports.cps, selected.region)

    // 异步启动期间 Key 可能被删除，提交前重新读取并复验。
    const latest = getKeyData()
    const latestSelected = latest.keys.find((entry) => entry.id === selected.id)
    if (!latestSelected || latestSelected.key !== selected.key) {
      throw new Error('所选 API Key 已被删除或替换，请重新选择')
    }
    latest.activeKeyId = selected.id
    latest.enabled = true
    if (!latest.originalEndpoints) latest.originalEndpoints = applied.original
    latest.settingsPath = applied.settingsPath
    setKeyData(latest)
    // 端点刚写好就挂守护：Kiro IDE 启动时会把这两个键按自身内存回写清空
    startEndpointWatch(data.ports)
    log('info', `[KeyGateway] 已开启接管，settings=${applied.settingsPath}`)
    const opened = 'API Key 接管已开启，请重启 Kiro IDE 使端点生效'
    return await emitStatus(forcedNote ? `${forcedNote}；${opened}` : opened, applied.changed)
  } catch (error) {
    // 先摘守护再还原，否则还原写入会被守护判为「端点被改」又改回本地端点
    stopEndpointWatcher()
    stopGateway()
    if (applied) {
      await restoreEndpointOverride(applied.original, applied.settingsPath).catch(() => undefined)
    } else if (data.enabled) {
      await restoreEndpointOverride(originalSnapshot(data), data.settingsPath).catch(() => undefined)
    }
    const failed = getKeyData()
    failed.enabled = false
    failed.activeKeyId = null
    failed.originalEndpoints = undefined
    failed.settingsPath = undefined
    setKeyData(failed)
    throw error
  }
}

export async function disableGateway(): Promise<KeyGatewayStatus> {
  const snapshot = getKeyData()
  // 必须先摘守护：否则还原官方端点的写入会被守护判为「端点被改」，立刻又改回本地网关，网关根本关不掉
  stopEndpointWatcher()
  const original = originalSnapshot(snapshot)
  const result = await restoreEndpointOverride(original, snapshot.settingsPath)
  stopGateway()
  // 兜底：摘守护是同步的，但它可能有一次修复正卡在写盘途中，写入会在还原之后才落地。
  // 回读确认端点没有又被指回本地，否则再还原一次，避免 IDE 永久指向已停止的端口。
  if (await isEndpointBound(snapshot.ports.krs, snapshot.ports.cps, region()).catch(() => false)) {
    log('warn', '[KeyGateway] 还原后端点又被指回本地网关，重新还原一次')
    await restoreEndpointOverride(original, snapshot.settingsPath).catch(() => undefined)
  }
  // 恢复端点期间其它 Key 数据可能更新，提交时只修改网关相关字段。
  const latest = getKeyData()
  latest.enabled = false
  latest.activeKeyId = null
  latest.originalEndpoints = undefined
  latest.settingsPath = undefined
  setKeyData(latest)
  log('info', '[KeyGateway] 已关闭接管、清除当前 Key 并恢复 Kiro 官方端点')
  return await emitStatus('API Key 接管已关闭，当前 Key 已清除；请重启 Kiro IDE 恢复官方服务', result.changed)
}

/** 网关配置只剩本地端口；区域由每个 Key 自己带 */
export async function configureGateway(input: {
  ports?: { krs: number; cps: number }
}): Promise<{ data: KeyGatewayData; status: KeyGatewayStatus }> {
  const data = getKeyData()
  const nextPorts = input.ports ?? data.ports
  validatePorts(Number(nextPorts.krs), Number(nextPorts.cps))
  if (data.enabled) throw new Error('请先关闭接管，再修改端口')
  data.ports = { krs: Number(nextPorts.krs), cps: Number(nextPorts.cps) }
  setKeyData(data)
  return { data, status: await emitStatus('网关配置已保存') }
}

/** 应用启动时恢复上次的接管状态；启动失败则安全还原并关闭开关。 */
export async function initializeKeyService(
  onStatus?: (status: KeyGatewayStatus) => void
): Promise<void> {
  notify = onStatus ?? null
  const data = getKeyData()
  if (!data.enabled) {
    await emitStatus()
    return
  }
  try {
    await enableGateway()
  } catch (error) {
    stopEndpointWatcher()
    stopGateway()
    await restoreEndpointOverride(originalSnapshot(data), data.settingsPath).catch(() => undefined)
    data.enabled = false
    data.originalEndpoints = undefined
    data.settingsPath = undefined
    setKeyData(data)
    const message = error instanceof Error ? error.message : String(error)
    log('error', `[KeyGateway] 启动恢复失败：${message}`)
    await emitStatus(`上次的 API Key 接管恢复失败：${message}`)
  }
}

/** 退出前同步还原端点，避免 IDE 永久指向已经停止的本地端口。 */
export function shutdownKeyServiceSync(): void {
  // 同上：守护还挂着的话，同步还原写入会被它改回本地端点，IDE 就会永久指向已停止的端口
  stopEndpointWatcher()
  const data = getKeyData()
  if (data.enabled) {
    restoreEndpointOverrideSync(originalSnapshot(data), data.settingsPath)
  }
  stopGateway()
}
