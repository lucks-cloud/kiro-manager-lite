<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import { message } from 'ant-design-vue'
import {
  CloseCircleFilled,
  SendOutlined,
  StopOutlined,
  SyncOutlined
} from '@ant-design/icons-vue'
import { useKeysStore } from '@/stores/keys'
import { useSettingsStore } from '@/stores/settings'
import ModelCascader from '@/components/common/ModelCascader.vue'
import { withDefaultEffort, type CascaderModel } from '@/utils/models'
import { errorMessage } from '@shared/errors'
import { buildModelRequestFields } from '@shared/modelSchema'
import type { ChatTestResult, KeyEntry, KeyModelInfo } from '@shared/types'

const props = defineProps<{ keyEntry: KeyEntry | null }>()
const emit = defineEmits<{ close: [] }>()
const keysStore = useKeysStore()
const settingsStore = useSettingsStore()
const DEFAULT_MESSAGE = '你的具体模型名称，以及具体时间，打印出来！'

const models = ref<KeyModelInfo[]>([])
const modelsLoading = ref(false)
const modelsError = ref('')
const input = ref(DEFAULT_MESSAGE)
const running = ref(false)
const output = ref('')
const result = ref<ChatTestResult | null>(null)
const error = ref('')
const requestId = ref('')

const open = computed(() => !!props.keyEntry)
const label = computed(() => {
  const key = props.keyEntry?.key || ''
  return settingsStore.settings.privacyMode ? mask(key) : key
})
/** 级联选择器要的形状：一级模型、二级推理档位（档位来自模型自己的 schema） */
const cascaderModels = computed<CascaderModel[]>(() => models.value)

/** [模型 id] 或 [模型 id, 档位]；只选模型表示用上游默认档位 */
const selection = ref<string[]>([])
const modelId = computed(() => selection.value[0] ?? '')
const effortLevel = computed(() => selection.value[1])

/**
 * 按所选模型的 schema 拼出请求字段。
 * 没选档位就不带这个字段 —— 上游对「本无该选项的模型」带上它会直接 400。
 */
const requestFields = computed(() => {
  const model = models.value.find((m) => m.id === modelId.value)
  return buildModelRequestFields(model?.effort, effortLevel.value)
})
const ready = computed(() => !modelsLoading.value && !modelsError.value && models.value.length > 0)

function mask(key: string): string {
  return key ? `${key.slice(0, 8)}…${key.slice(-6)}` : ''
}

const offChunk = window.api.onKeyChatChunk(({ requestId: id, delta }) => {
  if (id === requestId.value) output.value += delta
})
onUnmounted(() => {
  if (running.value && requestId.value) void window.api.cancelKeyChatTest(requestId.value)
  offChunk()
})

async function loadModels(): Promise<void> {
  const target = props.keyEntry
  if (!target) return
  const loadingId = target.id
  modelsLoading.value = true
  modelsError.value = ''
  models.value = []
  try {
    const response = await keysStore.listModels(target.id)
    if (props.keyEntry?.id !== loadingId) return
    if (response.data?.length) {
      models.value = response.data
      const kept = models.value.find((model) => model.id === modelId.value)
      if (!kept) {
        const first = models.value[0]
        // 首个候选同样要补上默认档位，保证「显示的」就是「发出去的」
        selection.value = first ? withDefaultEffort(cascaderModels.value, [first.id]) : []
      } else if (effortLevel.value && !kept.effort?.options.includes(effortLevel.value)) {
        // 重新拉回来的 schema 可能不再有这个档位，回落到新的默认档位
        selection.value = withDefaultEffort(cascaderModels.value, [kept.id])
      }
    } else {
      modelsError.value = response.error || '官方没有返回任何可用模型'
    }
  } catch (cause) {
    modelsError.value = errorMessage(cause)
  } finally {
    if (props.keyEntry?.id === loadingId) modelsLoading.value = false
  }
}

watch(
  () => props.keyEntry?.id,
  (id) => {
    if (!id) return
    output.value = ''
    result.value = null
    error.value = ''
    input.value = DEFAULT_MESSAGE
    selection.value = []
    void loadModels()
  },
  { immediate: true }
)

async function start(): Promise<void> {
  const target = props.keyEntry
  const text = input.value.trim()
  if (!target) return
  if (!text) return void message.warning('请输入要发送的内容')
  if (!modelId.value) return void message.warning('请选择模型')

  running.value = true
  output.value = ''
  result.value = null
  error.value = ''
  requestId.value = `key-${target.id}-${Date.now()}`
  const currentRequest = requestId.value
  try {
    const response = await window.api.keyChatTest(currentRequest, {
      keyId: target.id,
      modelId: modelId.value,
      additionalModelRequestFields: requestFields.value,
      message: text
    })
    if (requestId.value !== currentRequest) return
    // 测活结论同步到卡片：主进程已落库，这里更新本地状态让卡片立即反映
    if (response.success && response.data) {
      result.value = response.data
      keysStore.applyChatResult(target.id)
    } else {
      error.value = response.error || '测试失败'
      keysStore.applyChatResult(target.id, error.value)
    }
  } catch (cause) {
    error.value = errorMessage(cause)
    keysStore.applyChatResult(target.id, error.value)
  } finally {
    if (requestId.value === currentRequest) running.value = false
  }
}

function cancel(): void {
  if (requestId.value) void window.api.cancelKeyChatTest(requestId.value)
}

function close(): void {
  if (running.value) cancel()
  emit('close')
}

const resultSummary = computed(() => {
  const value = result.value
  if (!value) return ''
  const parts = [
    `API Key 可用：${value.endpoint}`,
    `首字 ${value.firstByteMs} ms`,
    `总耗时 ${value.totalMs} ms`,
    `共 ${value.text.length} 字`
  ]
  if (value.thinkingChars) parts.push(`思考 ${value.thinkingChars} 字`)
  return parts.join(' · ')
})

</script>

<template>
  <a-modal :open="open" width="640px" :footer="null" @cancel="close">
    <template #title>
      <span class="title"><SendOutlined />API Key 在线测活</span>
    </template>

    <a-alert
      type="info"
      show-icon
      :message="`当前 API Key：${label}`"
      style="margin-bottom: 16px"
    />

    <div v-if="modelsLoading" class="stage">
      <a-spin size="large" />
      <span class="muted">正在从 Kiro 官方拉取该 Key 可用的模型…</span>
    </div>
    <div v-else-if="modelsError" class="stage">
      <a-result status="error" title="模型列表拉取失败" :sub-title="modelsError">
        <template #extra>
          <a-space>
            <a-button @click="close">关闭</a-button>
            <a-button type="primary" @click="loadModels">
              <template #icon><SyncOutlined /></template>重试
            </a-button>
          </a-space>
        </template>
      </a-result>
    </div>

    <template v-else>
      <a-form layout="vertical">
        <!-- 标题带上模型数量：一眼看出这个 Key 拉到了几个主模型（不含二级档位） -->
        <a-form-item :label="`模型（${models.length}个）`">
          <div class="model-row">
            <ModelCascader
              :models="cascaderModels"
              :value="selection"
              :disabled="running"
              @change="selection = $event"
            />
            <a-tooltip title="重新拉取模型列表">
              <a-button :disabled="running" @click="loadModels"><template #icon><SyncOutlined /></template></a-button>
            </a-tooltip>
          </div>
        </a-form-item>
        <a-form-item label="发送内容">
          <a-textarea v-model:value="input" :rows="3" :disabled="running" />
        </a-form-item>
      </a-form>

      <div class="output-box">
        <div v-if="output" class="output-text">{{ output }}</div>
        <div v-else-if="running" class="muted">等待模型返回…</div>
        <div v-else class="muted">点击“开始测试”后，这里会实时显示流式回复</div>
        <span v-if="running" class="cursor" />
      </div>

      <a-alert v-if="result" type="success" style="margin-top: 12px" :message="resultSummary" />
      <a-alert
        v-else-if="error"
        type="error"
        show-icon
        style="margin-top: 12px"
        :message="`测试失败：${error}`"
        description="Key 失效、额度耗尽或模型无权限都会在真实对话中暴露。"
      ><template #icon><CloseCircleFilled /></template></a-alert>

      <a-space style="width: 100%; justify-content: flex-end; margin-top: 16px">
        <a-button @click="close">关闭</a-button>
        <a-button v-if="running" danger @click="cancel"><template #icon><StopOutlined /></template>中止</a-button>
        <a-button v-else type="primary" :disabled="!ready" @click="start">
          <template #icon><SendOutlined /></template>开始测试
        </a-button>
      </a-space>
    </template>
  </a-modal>
</template>

<style scoped>
.title { display: inline-flex; align-items: center; gap: 8px; }
.model-row { display: flex; gap: 8px; }
.stage { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px; min-height: 300px; }
.stage :deep(.ant-result) { padding: 0; }
.output-box { min-height: 120px; max-height: 260px; overflow: auto; padding: 10px 12px; border-radius: 10px; background: var(--kal-block-bg); font-size: 13px; line-height: 1.8; }
.output-text { white-space: pre-wrap; word-break: break-word; }
.cursor { display: inline-block; width: 7px; height: 14px; vertical-align: text-bottom; background: var(--kal-primary); animation: blink 1s steps(2, start) infinite; }
.muted { color: var(--kal-muted); }
@keyframes blink { to { visibility: hidden; } }
</style>
