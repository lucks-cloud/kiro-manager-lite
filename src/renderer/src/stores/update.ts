import { acceptHMRUpdate, defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { UpdateCheckResult } from '@shared/types'

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

  async function initialize(currentVersion: string): Promise<void> {
    if (initialized || !currentVersion) return
    initialized = true
    const cache = readCache(currentVersion)
    if (cache) {
      result.value = cache.result
      if (Date.now() - cache.checkedAt < CACHE_TTL_MS) {
        if (cache.result.hasUpdate) modalOpen.value = true
        return
      }
    }
    const response = await fetchLatest()
    modalOpen.value = response.data?.hasUpdate === true
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
    modalOpen.value = false
  }

  return {
    result,
    checking,
    modalOpen,
    hasUpdate,
    initialize,
    checkNow,
    showModal,
    closeModal
  }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useUpdateStore, import.meta.hot))
}