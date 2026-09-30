// 本地反代的界面状态
//
// 服务本身跑在主进程，这里只持有它的配置、状态、请求日志与按账号用量，
// 并订阅主进程的推送。日志是高频更新，所以按 id 就地替换，不整表重建。
import { acceptHMRUpdate, defineStore } from 'pinia'
import { computed, ref, shallowRef } from 'vue'
import { message } from 'ant-design-vue'
import { toPlain } from '@/utils/ipc'
import {
  DEFAULT_PROXY_CONFIG,
  type ProxyAccountUsage,
  type ProxyClientState,
  type ProxyClientTarget,
  type ProxyConfig,
  type ProxyLogEntry,
  type ProxyModelCache,
  type ProxyStatus
} from '@shared/types'

/** 界面上最多保留的日志条数，与主进程的容量一致 */
const LOG_LIMIT = 300

export const useProxyStore = defineStore('proxy', () => {
  const config = ref<ProxyConfig>({ ...DEFAULT_PROXY_CONFIG })
  const status = ref<ProxyStatus>({
    running: false,
    port: DEFAULT_PROXY_CONFIG.port,
    baseUrl: `http://127.0.0.1:${DEFAULT_PROXY_CONFIG.port}`,
    requests: 0,
    succeeded: 0,
    failed: 0,
    credits: 0,
    inputTokens: 0,
    outputTokens: 0
  })
  // 流式期间每 150ms 整组替换一次，从不就地修改，用 shallowRef 省掉逐条建代理
  const logs = shallowRef<ProxyLogEntry[]>([])
  const usage = ref<ProxyAccountUsage[]>([])
  const clients = ref<ProxyClientState[]>([])
  /** 从账号拉回的模型列表；null 表示还没拉过 */
  const models = ref<ProxyModelCache | null>(null)
  const modelsLoading = ref(false)
  const loading = ref(false)
  const busy = ref('')

  let unsubscribe: (() => void)[] = []

  const running = computed(() => status.value.running)
  /** Anthropic 客户端（Claude Code）填的就是这个根地址 */
  const baseUrl = computed(() => `http://127.0.0.1:${config.value.port}`)
  /** OpenAI 系客户端（Codex 等）要带 /v1 */
  const openAiBaseUrl = computed(() => `${baseUrl.value}/v1`)

  const successRate = computed(() => {
    const total = status.value.succeeded + status.value.failed
    return total ? (status.value.succeeded / total) * 100 : 0
  })

  async function load(): Promise<void> {
    loading.value = true
    try {
      const res = await window.api.getProxyState()
      if (res.success && res.data) {
        config.value = res.data.config
        status.value = res.data.status
        logs.value = res.data.logs
        usage.value = res.data.usage
        models.value = res.data.models
      }
      await loadClients()
    } finally {
      loading.value = false
    }
  }

  /**
   * 用当前选中的账号重新拉模型列表。
   * silent 用于页面首次打开时的自动拉取：失败不弹错误，免得一进页面就被打断。
   */
  async function refreshModels(silent = false): Promise<boolean> {
    if (modelsLoading.value) return false
    modelsLoading.value = true
    try {
      const res = await window.api.refreshProxyModels()
      if (!res.success || !res.data) {
        if (!silent) message.error(res.error || '拉取模型失败')
        return false
      }
      models.value = res.data
      if (!silent) message.success(`已拉取 ${res.data.models.length} 个模型`)
      return true
    } finally {
      modelsLoading.value = false
    }
  }

  /** fresh：跳过主进程的安装检测缓存，用户点「重新检测」时用 */
  async function loadClients(fresh = false): Promise<void> {
    const res = await window.api.getProxyClientStates(fresh)
    if (res.success && res.data) clients.value = res.data
  }

  /** 订阅主进程推送；返回取消订阅的函数，页面卸载时调用 */
  function subscribe(): () => void {
    unsubscribe.forEach((fn) => fn())
    unsubscribe = [
      window.api.onProxyStatus((next) => {
        status.value = next
      }),
      window.api.onProxyLog((entry) => {
        // null 表示主进程那边清空了日志
        if (!entry) {
          logs.value = []
          return
        }
        const index = logs.value.findIndex((item) => item.id === entry.id)
        if (index >= 0) {
          // 就地换掉这一条，避免整表重建导致列表闪烁
          const next = logs.value.slice()
          next[index] = entry
          logs.value = next
          return
        }
        logs.value = [entry, ...logs.value].slice(0, LOG_LIMIT)
      })
    ]
    return () => {
      unsubscribe.forEach((fn) => fn())
      unsubscribe = []
    }
  }

  async function save(patch: Partial<ProxyConfig>): Promise<boolean> {
    const res = await window.api.saveProxyConfig(toPlain(patch))
    if (!res.success || !res.data) {
      message.error(res.error || '保存失败')
      return false
    }
    config.value = res.data.config
    status.value = res.data.status
    return true
  }

  async function start(): Promise<void> {
    busy.value = 'start'
    try {
      const res = await window.api.startProxy()
      if (!res.success || !res.data) return void message.error(res.error || '启动失败')
      status.value = res.data
      message.success(`本地反代已启动：${baseUrl.value}`)
    } finally {
      busy.value = ''
    }
  }

  async function stop(): Promise<void> {
    busy.value = 'stop'
    try {
      const res = await window.api.stopProxy()
      if (!res.success || !res.data) return void message.error(res.error || '停止失败')
      status.value = res.data
      message.success('本地反代已停止')
    } finally {
      busy.value = ''
    }
  }

  async function clearLogs(): Promise<void> {
    const res = await window.api.clearProxyLogs()
    if (!res.success) return void message.error(res.error || '清空失败')
    logs.value = []
  }

  async function resetStats(): Promise<void> {
    const res = await window.api.resetProxyStats()
    if (!res.success || !res.data) return void message.error(res.error || '重置失败')
    status.value = res.data
    usage.value = []
    message.success('统计已清零')
  }

  /**
   * 写入 / 还原客户端配置。
   *
   * 错误不在这里弹 toast：调用方会把成功和失败都摊在同一个弹窗里显示
   * （写入可能要装 CCursor，过程较长，结果必须留在屏幕上而不是飘一下就没了）。
   */
  async function applyClient(
    target: ProxyClientTarget
  ): Promise<{ state?: ProxyClientState; error?: string }> {
    busy.value = `apply:${target}`
    try {
      const res = await window.api.applyProxyClient(target)
      if (!res.success || !res.data) {
        await loadClients()
        return { error: res.error || '写入失败' }
      }
      clients.value = res.data
      return { state: res.data.find((item) => item.target === target) }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    } finally {
      busy.value = ''
    }
  }

  async function restoreClient(
    target: ProxyClientTarget
  ): Promise<{ state?: ProxyClientState; error?: string }> {
    busy.value = `restore:${target}`
    try {
      const res = await window.api.restoreProxyClient(target)
      if (!res.success || !res.data) {
        // 失败也可能已经改了一部分（比如 Cursor 配置摘掉了、补丁没卸成），重新取一次状态，卡片别停在旧的
        await loadClients()
        return { error: res.error || '还原失败' }
      }
      clients.value = res.data
      return { state: res.data.find((item) => item.target === target) }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    } finally {
      busy.value = ''
    }
  }

  return {
    config,
    status,
    logs,
    usage,
    clients,
    models,
    modelsLoading,
    loading,
    busy,
    running,
    baseUrl,
    openAiBaseUrl,
    successRate,
    load,
    loadClients,
    refreshModels,
    subscribe,
    save,
    start,
    stop,
    clearLogs,
    resetStats,
    applyClient,
    restoreClient
  }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useProxyStore, import.meta.hot))
}
