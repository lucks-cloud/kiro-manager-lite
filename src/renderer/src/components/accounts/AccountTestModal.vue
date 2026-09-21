<script setup lang="ts">
/**
 * 账号测活：连 Kiro 官方发一次真实的流式对话。
 * 用量接口能通只代表 token 有效，能不能出字要真的问一句才知道。
 */
import { computed, onUnmounted, ref, watch } from 'vue'
import { message } from 'ant-design-vue'
import {
  CloseCircleFilled,
  SendOutlined,
  StopOutlined,
  SyncOutlined
} from '@ant-design/icons-vue'
import { useSettingsStore } from '@/stores/settings'
import { useAccountsStore } from '@/stores/accounts'
import ModelCascader from '@/components/common/ModelCascader.vue'
import { withDefaultEffort, type CascaderModel } from '@/utils/models'
import { displayEmail } from '@/utils/display'
import { errorMessage } from '@shared/errors'
import { buildModelRequestFields } from '@shared/modelSchema'
import type { Account, ChatTestResult, KiroModelInfo } from '@shared/types'

const props = defineProps<{ account: Account | null }>()
const emit = defineEmits<{ close: [] }>()

const settingsStore = useSettingsStore()
const accountsStore = useAccountsStore()

const DEFAULT_MESSAGE = '你的具体模型名称，以及具体时间，打印出来！'

const models = ref<KiroModelInfo[]>([])
const modelsLoading = ref(false)
const modelsError = ref('')
const input = ref(DEFAULT_MESSAGE)

const running = ref(false)
const output = ref('')
const result = ref<ChatTestResult | null>(null)
const error = ref('')
const requestId = ref('')

const open = computed(() => !!props.account)

const accountLabel = computed(() =>
  props.account ? displayEmail(props.account.email, settingsStore.settings.privacyMode) : ''
)

/** 级联选择器要的形状：一级模型、二级推理档位（档位来自模型自己的 schema） */
const cascaderModels = computed<CascaderModel[]>(() =>
  models.value.map((m) => ({
    id: m.modelId,
    name: m.modelName,
    rate: m.rate,
    effort: m.effort
  }))
)

/** [模型 id] 或 [模型 id, 档位]；只选模型表示用上游默认档位 */
const selection = ref<string[]>([])
const modelId = computed(() => selection.value[0] ?? '')
const effortLevel = computed(() => selection.value[1])

/**
 * 按所选模型的 schema 拼出请求字段。
 * 没选档位就不带这个字段 —— 上游对「本无该选项的模型」带上它会直接 400。
 */
const requestFields = computed(() => {
  const model = models.value.find((m) => m.modelId === modelId.value)
  return buildModelRequestFields(model?.effort, effortLevel.value)
})

/** 模型列表就绪之前只显示加载态，避免用户对着一份还没确认可用的表单操作 */
const ready = computed(() => !modelsLoading.value && !modelsError.value && models.value.length > 0)

// 主进程按 requestId 推流式片段，这里只认自己那一路
const offChunk = window.api.onChatChunk(({ requestId: id, delta }) => {
  if (id === requestId.value) output.value += delta
})
onUnmounted(() => offChunk())

const refreshingToken = ref(false)

/**
 * 拿一个当下可用的 accessToken。
 *
 * 非当前登录的账号缓存里那份 token 基本都过期了（IDE 只会续自己在用的那个），
 * 所以测活前先按需 refresh 一次。refreshAccountToken 只在该账号确实是 IDE
 * 当前账号时才回写磁盘，对其它账号不会动 Kiro IDE 的登录状态。
 */
async function ensureAccessToken(accountId: string): Promise<string> {
  const current = accountsStore.get(accountId)
  const token = current?.credentials.accessToken
  const expiresAt = current?.credentials.expiresAt ?? 0
  // 留 1 分钟余量，避免请求发出途中过期
  if (token && expiresAt - Date.now() > 60_000) return token

  refreshingToken.value = true
  try {
    const res = await accountsStore.refreshToken(accountId)
    if (!res.ok) throw new Error(`刷新密钥失败：${res.error}`)
    const fresh = accountsStore.get(accountId)?.credentials.accessToken
    if (!fresh) throw new Error('刷新后仍然没有拿到 accessToken')
    return fresh
  } finally {
    refreshingToken.value = false
  }
}

/**
 * 拉取模型列表。
 *
 * 拉不到就直接把异常抛到界面上，不再拿一份硬编码的常用模型顶上去：
 * 那份兜底列表并不代表该账号真的有这些模型的权限，测出来的结论会有误导。
 */
async function loadModels(): Promise<void> {
  const account = props.account
  if (!account) return
  modelsLoading.value = true
  modelsError.value = ''
  models.value = []
  try {
    const accessToken = await ensureAccessToken(account.id)
    const res = await window.api.listKiroModels({
      accessToken,
      profileArn: account.profileArn || account.credentials.profileArn,
      region: account.credentials.region,
      idp: account.idp,
      authMethod: account.credentials.authMethod
    })
    if (res.success && res.data?.length) {
      models.value = res.data
      // 保持已选模型，否则落到第一个候选（官方列表首项是 auto）
      const kept = models.value.find((m) => m.modelId === modelId.value)
      if (!kept) {
        const first = models.value[0]
        // 首个候选同样要补上默认档位，保证「显示的」就是「发出去的」
        selection.value = first
          ? withDefaultEffort(cascaderModels.value, [first.modelId])
          : []
      } else if (effortLevel.value && !kept.effort?.options.includes(effortLevel.value)) {
        // 重新拉回来的 schema 可能不再有这个档位，回落到新的默认档位
        selection.value = withDefaultEffort(cascaderModels.value, [kept.modelId])
      }
    } else {
      modelsError.value = res.error || '官方没有返回任何可用模型'
    }
  } catch (e) {
    modelsError.value = errorMessage(e)
  } finally {
    modelsLoading.value = false
  }
}

watch(
  () => props.account?.id,
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
  const account = props.account
  if (!account) return
  const text = input.value.trim()
  if (!text) return void message.warning('请输入要发送的内容')
  if (!modelId.value) return void message.warning('请选择模型')

  running.value = true
  output.value = ''
  result.value = null
  error.value = ''
  requestId.value = `${account.id}-${Date.now()}`

  try {
    // 任意账号都能测：token 过期就先续一次，不影响 IDE 当前登录的账号
    const accessToken = await ensureAccessToken(account.id)
    const res = await window.api.chatTest(requestId.value, {
      accountId: account.id,
      accessToken,
      modelId: modelId.value,
      message: text,
      profileArn: account.profileArn || account.credentials.profileArn,
      region: account.credentials.region,
      idp: account.idp,
      authMethod: account.credentials.authMethod,
      additionalModelRequestFields: requestFields.value
    })
    if (res.success && res.data) result.value = res.data
    else error.value = res.error || '测试失败'
  } catch (e) {
    error.value = errorMessage(e)
  } finally {
    running.value = false
  }
}

const resultSummary = computed(() => {
  const r = result.value
  if (!r) return ''
  const parts = [
    `账号可用：${r.endpoint}`,
    `首字 ${r.firstByteMs} ms`,
    `总耗时 ${r.totalMs} ms`,
    `共 ${r.text.length} 字`
  ]
  if (r.thinkingChars) parts.push(`思考 ${r.thinkingChars} 字`)
  return parts.join(' · ')
})


function cancel(): void {
  if (!requestId.value) return
  void window.api.cancelChatTest(requestId.value)
}

function close(): void {
  if (running.value) cancel()
  emit('close')
}
</script>

<template>
  <a-modal :open="open" width="640px" :footer="null" @cancel="close">
    <template #title>
      <span class="title">
        <SendOutlined />
        账号测活
      </span>
    </template>

    <a-alert
      type="info"
      show-icon
      :message="`当前账号：${accountLabel}`"
      style="margin-bottom: 16px"
    />

    <!-- 模型列表就绪前只显示加载态；拉取失败直接把异常摆出来，不给半可用的表单 -->
    <div v-if="modelsLoading" class="stage">
      <a-spin size="large" />
      <span class="stage-text muted">
        {{ refreshingToken ? '正在为该账号续期 Token…' : '正在拉取该账号可用的模型…' }}
      </span>
    </div>

    <div v-else-if="modelsError" class="stage">
      <a-result status="error" title="模型列表拉取失败" :sub-title="modelsError">
        <template #extra>
          <a-space>
            <a-button @click="close">关闭</a-button>
            <a-button type="primary" @click="loadModels">
              <template #icon><SyncOutlined /></template>
              重试
            </a-button>
          </a-space>
        </template>
      </a-result>
    </div>

    <template v-else>
      <a-form layout="vertical">
        <!-- 标题带上模型数量：一眼看出这个账号拉到了几个主模型（不含二级档位） -->
        <a-form-item :label="`模型（${models.length}个）`">
          <div class="model-row">
            <ModelCascader
              :models="cascaderModels"
              :value="selection"
              :disabled="running"
              @change="selection = $event"
            />
            <a-tooltip title="重新从 Kiro 官方拉取模型列表">
              <a-button :disabled="running" @click="loadModels">
                <template #icon><SyncOutlined /></template>
              </a-button>
            </a-tooltip>
          </div>
        </a-form-item>

        <a-form-item label="发送内容">
          <a-textarea v-model:value="input" :rows="3" :disabled="running" />
        </a-form-item>
      </a-form>

      <div class="output-box">
        <div v-if="output" class="output-text">{{ output }}</div>
        <div v-else-if="refreshingToken" class="muted">正在为该账号续期 Token…</div>
        <div v-else-if="running" class="muted">等待模型返回…</div>
        <div v-else class="muted">点击「开始测试」后这里会实时显示流式回复</div>
        <span v-if="running" class="cursor" />
      </div>

      <a-alert
        v-if="result"
        type="success"
        style="margin-top: 12px"
        :message="resultSummary"
      />
      <a-alert
        v-else-if="error"
        type="error"
        show-icon
        style="margin-top: 12px"
        :message="`测试失败：${error}`"
        description="额度耗尽、模型无权限、Token 失效都会走到这里。可以先刷新该账号的密钥与用量再试。"
      >
        <template #icon><CloseCircleFilled /></template>
      </a-alert>

      <a-space style="width: 100%; justify-content: flex-end; margin-top: 16px">
        <a-button @click="close">关闭</a-button>
        <a-button v-if="running" danger @click="cancel">
          <template #icon><StopOutlined /></template>
          中止
        </a-button>
        <a-button v-else type="primary" :disabled="!ready" @click="start">
          <template #icon><SendOutlined /></template>
          开始测试
        </a-button>
      </a-space>
    </template>
  </a-modal>
</template>

<style scoped>
.title {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.model-row {
  display: flex;
  gap: 8px;
}

/* 加载 / 失败态：占住和表单差不多的高度，避免弹窗尺寸跳动 */
.stage {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  min-height: 300px;
}

.stage-text {
  font-size: 13px;
}

.stage :deep(.ant-result) {
  padding: 0;
}

.output-box {
  min-height: 120px;
  max-height: 260px;
  overflow: auto;
  padding: 10px 12px;
  border-radius: 10px;
  background: var(--kal-block-bg);
  font-size: 13px;
  line-height: 1.8;
}

.output-text {
  white-space: pre-wrap;
  word-break: break-word;
}

/* 流式进行中的光标 */
.cursor {
  display: inline-block;
  width: 7px;
  height: 14px;
  vertical-align: text-bottom;
  background: var(--kal-primary);
  animation: blink 1s steps(2, start) infinite;
}

@keyframes blink {
  to {
    visibility: hidden;
  }
}
</style>
