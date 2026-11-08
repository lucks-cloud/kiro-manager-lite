<script setup lang="ts">
import { computed, watch } from 'vue'
import {
  CloseCircleFilled,
  SendOutlined,
  StopOutlined,
  SyncOutlined
} from '@ant-design/icons-vue'
import { useKeysStore } from '@/stores/keys'
import { useSettingsStore } from '@/stores/settings'
import { usePrivacy } from '@/composables/usePrivacy'
import ModelCascader from '@/components/common/ModelCascader.vue'
import TestOutputPanel from '@/components/common/TestOutputPanel.vue'
import { useChatTest } from '@/composables/useChatTest'
import { errorMessage } from '@shared/errors'
import type { KeyEntry, KeyModelInfo } from '@shared/types'

const props = defineProps<{ keyEntry: KeyEntry | null }>()
const emit = defineEmits<{ close: [] }>()
const keysStore = useKeysStore()
const settingsStore = useSettingsStore()
const { maskKey } = usePrivacy()

// 模型列表、输入、运行状态、流式片段与结果摘要见 useChatTest
const {
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
  cancel
} = useChatTest<KeyModelInfo>({
  modelIdOf: (m) => m.id,
  // Key 拉回来的模型本身就是级联选择器要的形状
  toCascader: (list) => list,
  onChunk: (handler) => window.api.onKeyChatChunk(handler),
  cancelRequest: (id) => void window.api.cancelKeyChatTest(id),
  okLabel: 'API Key 可用'
})

const open = computed(() => !!props.keyEntry)
const label = computed(() => {
  const key = props.keyEntry?.key || ''
  return maskKey('apiKey') ? mask(key) : key
})

function mask(key: string): string {
  return key ? `${key.slice(0, 8)}…${key.slice(-6)}` : ''
}

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
      // 写入列表并校正已选模型 / 档位
      applyModels(response.data)
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
    resetForTarget()
    void loadModels()
  },
  { immediate: true }
)

async function start(): Promise<void> {
  const target = props.keyEntry
  if (!target) return
  // 校验输入与模型，进入运行态并生成 requestId；不通过时已给出提示
  const text = beginRun(`key-${target.id}`)
  if (text === null) return
  const currentRequest = requestId.value
  try {
    const response = await window.api.keyChatTest(currentRequest, {
      keyId: target.id,
      modelId: modelId.value,
      additionalModelRequestFields: requestFields.value,
      message: text
    })
    if (requestId.value !== currentRequest) return
    rawTrace.value = response.data?.raw ?? response.raw ?? null
    // 测活结论同步到卡片：主进程已落库，这里更新本地状态让卡片立即反映
    if (response.success && response.data) {
      result.value = response.data
      keysStore.applyChatResult(target.id)
    } else {
      error.value = response.error || '测试失败'
      // 用户主动中止不算测活结论：主进程也没落库，卡片不能因此标成异常
      const cancelled = rawTrace.value?.attempts.at(-1)?.outcome === 'cancelled'
      if (!cancelled) keysStore.applyChatResult(target.id, error.value)
    }
  } catch (cause) {
    error.value = errorMessage(cause)
    keysStore.applyChatResult(target.id, error.value)
  } finally {
    if (requestId.value === currentRequest) running.value = false
  }
}

function close(): void {
  if (running.value) cancel()
  emit('close')
}
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

      <TestOutputPanel
        :output="output"
        :running="running"
        :raw="rawTrace"
        :hint="running ? '等待模型返回…' : '点击“开始测试”后，这里会实时显示流式回复'"
      />

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
.muted { color: var(--kal-muted); }
</style>
