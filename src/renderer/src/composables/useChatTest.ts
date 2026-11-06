/**
 * 在线测活弹窗的公共状态与流程：账号测活（AccountTestModal）与 API Key 测活（ApiKeyTestModal）共用。
 *
 * 这里管：模型列表与级联选择、输入内容、运行状态、流式片段订阅、
 * 发送前的校验与重置、结果摘要、取消请求。
 * 组件自己管：怎么拉模型（账号要先续 Token，Key 要防串台）、怎么发请求、发完怎么落结论。
 */
import { computed, onUnmounted, ref, type Ref } from 'vue'
import { message } from 'ant-design-vue'
import { withDefaultEffort, type CascaderModel } from '@/utils/models'
import { buildModelRequestFields, type ModelEffort } from '@shared/modelSchema'
import type { ChatRawTrace, ChatTestChunk, ChatTestResult } from '@shared/types'

const DEFAULT_MESSAGE = '你的具体模型名称，以及当前具体时间，打印出来！'

interface ChatTestOptions<M> {
  /** 模型的 id 字段：账号拉回来的是 modelId，Key 拉回来的是 id */
  modelIdOf: (model: M) => string
  /** 级联选择器要的形状：一级模型、二级推理档位（档位来自模型自己的 schema） */
  toCascader: (models: M[]) => CascaderModel[]
  /** 订阅主进程按 requestId 推来的流式片段，返回退订函数 */
  onChunk: (handler: (chunk: ChatTestChunk) => void) => () => void
  /** 取消一次进行中的请求 */
  cancelRequest: (requestId: string) => void
  /** 结果摘要的开头，如「账号可用」 */
  okLabel: string
}

export function useChatTest<M extends { effort?: ModelEffort }>(options: ChatTestOptions<M>) {
  // 泛型模型类型过不了 UnwrapRef 的推导，按 Ref<M[]> 断言；运行时与 ref<M[]>() 相同
  const models = ref([]) as Ref<M[]>
  const modelsLoading = ref(false)
  const modelsError = ref('')
  const input = ref(DEFAULT_MESSAGE)

  const running = ref(false)
  const output = ref('')
  const result = ref<ChatTestResult | null>(null)
  /** 官方原始返回：成功、失败、中止都有，和 result 分开存 */
  const rawTrace = ref<ChatRawTrace | null>(null)
  const error = ref('')
  const requestId = ref('')

  /** 级联选择器要的形状：一级模型、二级推理档位（档位来自模型自己的 schema） */
  const cascaderModels = computed<CascaderModel[]>(() => options.toCascader(models.value))

  /** [模型 id] 或 [模型 id, 档位]；只选模型表示用上游默认档位 */
  const selection = ref<string[]>([])
  const modelId = computed(() => selection.value[0] ?? '')
  const effortLevel = computed(() => selection.value[1])

  /**
   * 按所选模型的 schema 拼出请求字段。
   * 没选档位就不带这个字段 —— 上游对「本无该选项的模型」带上它会直接 400。
   */
  const requestFields = computed(() => {
    const model = models.value.find((m) => options.modelIdOf(m) === modelId.value)
    return buildModelRequestFields(model?.effort, effortLevel.value)
  })

  /** 模型列表就绪之前只显示加载态，避免用户对着一份还没确认可用的表单操作 */
  const ready = computed(() => !modelsLoading.value && !modelsError.value && models.value.length > 0)

  /**
   * 最近一次被取消的 requestId。
   * 发请求前还有准备步骤（账号测活要先续 Token），这期间取消时主进程那边还没有这个请求，
   * 取消通知会落空；调用方在真正发出前用 isCancelled 查一下，取消过就不再发。
   */
  let cancelledId = ''

  function isCancelled(id: string): boolean {
    return !!id && id === cancelledId
  }

  // 主进程按 requestId 推流式片段，这里只认自己那一路
  const offChunk = options.onChunk(({ requestId: id, delta }) => {
    if (id === requestId.value) output.value += delta
  })
  // 弹窗被卸载（关闭、离开页面）时还在跑，就把请求一并取消，不让它在后台继续跑完
  onUnmounted(() => {
    // 点关闭时 close() 已经取消过一次，这里不重复发
    if (running.value && !isCancelled(requestId.value)) cancel()
    offChunk()
  })

  /** 写入拉回来的模型列表，并校正当前选择 */
  function applyModels(list: M[]): void {
    models.value = list
    // 保持已选模型，否则落到第一个候选（官方列表首项是 auto）
    const kept = models.value.find((m) => options.modelIdOf(m) === modelId.value)
    if (!kept) {
      const first = models.value[0]
      // 首个候选同样要补上默认档位，保证「显示的」就是「发出去的」
      selection.value = first ? withDefaultEffort(cascaderModels.value, [options.modelIdOf(first)]) : []
    } else if (effortLevel.value && !kept.effort?.options.includes(effortLevel.value)) {
      // 重新拉回来的 schema 可能不再有这个档位，回落到新的默认档位
      selection.value = withDefaultEffort(cascaderModels.value, [options.modelIdOf(kept)])
    }
  }

  /** 换了测试对象：清掉上一轮的输出、结果与选择，输入框回到默认提示词 */
  function resetForTarget(): void {
    output.value = ''
    result.value = null
    rawTrace.value = null
    error.value = ''
    input.value = DEFAULT_MESSAGE
    selection.value = []
  }

  /**
   * 发送前的校验与重置：没填内容或没选模型就提示并返回 null；
   * 否则进入运行态、清空上一轮结果，生成本次的 requestId（前缀-时间戳），返回要发送的文本。
   */
  function beginRun(requestPrefix: string): string | null {
    const text = input.value.trim()
    if (!text) {
      message.warning('请输入要发送的内容')
      return null
    }
    if (!modelId.value) {
      message.warning('请选择模型')
      return null
    }

    running.value = true
    output.value = ''
    result.value = null
    rawTrace.value = null
    error.value = ''
    requestId.value = `${requestPrefix}-${Date.now()}`
    return text
  }

  const resultSummary = computed(() => {
    const r = result.value
    if (!r) return ''
    const parts = [
      `${options.okLabel}：${r.endpoint}`,
      `首字 ${r.firstByteMs} ms`,
      `总耗时 ${r.totalMs} ms`,
      `共 ${r.text.length} 字`
    ]
    if (r.thinkingChars) parts.push(`思考 ${r.thinkingChars} 字`)
    return parts.join(' · ')
  })

  function cancel(): void {
    if (!requestId.value) return
    cancelledId = requestId.value
    options.cancelRequest(requestId.value)
  }

  return {
    models,
    modelsLoading,
    modelsError,
    input,
    running,
    output,
    result,
    rawTrace,
    error,
    requestId,
    cascaderModels,
    selection,
    modelId,
    requestFields,
    ready,
    resultSummary,
    applyModels,
    resetForTarget,
    beginRun,
    cancel,
    isCancelled
  }
}
