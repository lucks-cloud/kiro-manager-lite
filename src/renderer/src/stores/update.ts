import { acceptHMRUpdate, defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { UpdateCheckResult, UpdateProgress } from '@shared/types'

const CACHE_KEY = 'kal:update-check:v1'
const CACHE_TTL_MS = 6 * 60 * 60 * 1000

interface UpdateCache {
  checkedAt: number
  result: UpdateCheckResult
}

function validResult(value: unknown): value is UpdateCheckResult {
  if (!value || typeof value !== 'object') return false
  const item = value as Record<string, unknown>
  return (
    typeof item.current === 'string'
    && typeof item.latest === 'string'
    && typeof item.hasUpdate === 'boolean'
    && typeof item.releaseUrl === 'string'
    && typeof item.name === 'string'
    && typeof item.notes === 'string'
    && typeof item.publishedAt === 'string'
  )
}

function readCache(currentVersion: string): UpdateCache | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null') as Partial<UpdateCache> | null
    if (!parsed || typeof parsed.checkedAt !== 'number' || !validResult(parsed.result)) return null
    if (parsed.result.current !== currentVersion) return null
    return { checkedAt: parsed.checkedAt, result: parsed.result }
  } catch {
    return null
  }
}

/**
 * 用户关掉过「发现新版本」弹窗的版本号。
 * 启动时只对没关过的新版本自动弹一次；关掉后同一版本不再自动弹，
 * 想再看可以点侧栏 / 顶栏的「新版本」角标，或在关于页手动检查更新。出了更新的版本会重新弹。
 */
const DISMISSED_KEY = 'kal:update-dismissed:v1'

function readDismissed(): string {
  try {
    return localStorage.getItem(DISMISSED_KEY) || ''
  } catch {
    return ''
  }
}

function writeDismissed(version: string): void {
  try {
    localStorage.setItem(DISMISSED_KEY, version)
  } catch {
    // 写不进去最多就是下次启动再弹一次
  }
}

function writeCache(result: UpdateCheckResult): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ checkedAt: Date.now(), result }))
  } catch {
    // localStorage 不可写时仍保留本次会话内的检查结果。
  }
}


export const useUpdateStore = defineStore('update', () => {
  const result = ref<UpdateCheckResult | null>(null)
  const checking = ref(false)
  const modalOpen = ref(false)
  /** 本次运行是否已做过启动检查；只在内部判断，不必是响应式状态 */
  let initialized = false
  let request: Promise<{ data?: UpdateCheckResult; error?: string }> | null = null

  const hasUpdate = computed(() => result.value?.hasUpdate === true)

  async function fetchLatest(): Promise<{ data?: UpdateCheckResult; error?: string }> {
    if (request) return request
    checking.value = true
    request = (async () => {
      try {
        const response = await window.api.checkUpdate()
        if (!response.success || !response.data) {
          return { error: response.error || '检查更新失败，请稍后再试' }
        }
        result.value = response.data
        writeCache(response.data)
        return { data: response.data }
      } catch (error) {
        return { error: error instanceof Error ? error.message : '检查更新失败，请稍后再试' }
      } finally {
        checking.value = false
        request = null
      }
    })()
    return request
  }

  /** 启动时是否自动弹窗：有新版本，且用户没关过这个版本的弹窗 */
  function shouldAutoOpen(data?: UpdateCheckResult | null): boolean {
    return data?.hasUpdate === true && readDismissed() !== data.latest
  }

  async function initialize(currentVersion: string): Promise<void> {
    if (initialized || !currentVersion) return
    initialized = true
    const cache = readCache(currentVersion)
    if (cache) {
      result.value = cache.result
      if (Date.now() - cache.checkedAt < CACHE_TTL_MS) {
        if (shouldAutoOpen(cache.result)) modalOpen.value = true
        return
      }
    }
    const response = await fetchLatest()
    modalOpen.value = shouldAutoOpen(response.data)
  }

  async function checkNow(): Promise<{ data?: UpdateCheckResult; error?: string }> {
    const response = await fetchLatest()
    if (response.data) modalOpen.value = response.data.hasUpdate
    return response
  }

  function showModal(): void {
    if (result.value?.hasUpdate) modalOpen.value = true
  }

  function closeModal(): void {
    // 下载或安装进行中不允许关掉，避免进度蒙层没了、下载还在后台跑
    if (busy.value) return
    modalOpen.value = false
    // 关过就记下这个版本，之后启动不再自动弹；手动检查、点角标仍能打开
    if (result.value?.hasUpdate) writeDismissed(result.value.latest)
  }

  // ============ 应用内更新 ============
  const progress = ref<UpdateProgress | null>(null)
  /** 蒙层是否显示：点了「开始更新」到下载结束（成功等安装 / 失败等重试）都显示，取消后收起 */
  const overlayOpen = ref(false)
  let unsubscribe: (() => void) | null = null

  const phase = computed(() => progress.value?.phase ?? 'idle')
  /** 下载、校验、安装中：这时弹窗与蒙层都不能被关掉 */
  const busy = computed(() =>
    phase.value === 'downloading' || phase.value === 'verifying' || phase.value === 'installing'
  )

  function listen(): void {
    if (unsubscribe) return
    unsubscribe = window.api.onUpdateProgress((next) => {
      progress.value = next
      if (next.phase === 'canceled') overlayOpen.value = false
    })
  }

  async function startUpdate(): Promise<void> {
    const version = result.value?.latest
    if (!version || busy.value) return
    listen()
    overlayOpen.value = true
    progress.value = {
      phase: 'downloading',
      version,
      fileName: result.value?.asset?.name ?? '',
      received: 0,
      total: result.value?.asset?.size ?? 0,
      speed: 0
    }
    const res = await window.api.downloadUpdate(version)
    if (res.success && res.data) progress.value = res.data
    else progress.value = { ...progress.value, phase: 'error', error: res.error || '下载失败' }
    if (progress.value?.phase === 'canceled') overlayOpen.value = false
  }

  async function cancelUpdate(): Promise<void> {
    const res = await window.api.cancelUpdate()
    if (!res.success) return
    // 正在下载时主进程会推一条 canceled；已下好未安装的直接收起
    if (res.data) progress.value = res.data
    if (phase.value !== 'downloading' && phase.value !== 'verifying') overlayOpen.value = false
  }

  async function installUpdate(): Promise<{ error?: string; quitting?: boolean }> {
    const res = await window.api.installUpdate()
    if (!res.success) return { error: res.error || '启动安装失败' }
    return { quitting: res.data?.quitting === true }
  }

  /** 错误后收起蒙层，回到弹窗 */
  function dismissOverlay(): void {
    if (!busy.value) overlayOpen.value = false
  }

  return {
    result,
    checking,
    modalOpen,
    hasUpdate,
    initialize,
    checkNow,
    showModal,
    closeModal,
    progress,
    phase,
    busy,
    overlayOpen,
    startUpdate,
    cancelUpdate,
    installUpdate,
    dismissOverlay
  }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useUpdateStore, import.meta.hot))
}