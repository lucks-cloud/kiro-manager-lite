<script setup lang="ts">
/**
 * 账号测活：连 Kiro 官方发一次真实的流式对话。
 * 用量接口能通只代表 token 有效，能不能出字要真的问一句才知道。
 */
import { computed, ref, watch } from 'vue'
import {
  CloseCircleFilled,
  SendOutlined,
  StopOutlined,
  SyncOutlined
} from '@ant-design/icons-vue'
import { useSettingsStore } from '@/stores/settings'
import { useAccountsStore } from '@/stores/accounts'
import ModelCascader from '@/components/common/ModelCascader.vue'
import TestOutputPanel from '@/components/common/TestOutputPanel.vue'
import { useChatTest } from '@/composables/useChatTest'
import { displayEmail } from '@/utils/display'
import { errorMessage } from '@shared/errors'
import type { Account, KiroModelInfo } from '@shared/types'

const props = defineProps<{ account: Account | null }>()
const emit = defineEmits<{ close: [] }>()

const settingsStore = useSettingsStore()
const accountsStore = useAccountsStore()

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
  cancel,
  isCancelled
} = useChatTest<KiroModelInfo>({
  modelIdOf: (m) => m.modelId,
  toCascader: (list) =>
    list.map((m) => ({
      id: m.modelId,
      name: m.modelName,
      rate: m.rate,
      effort: m.effort
    })),
  onChunk: (handler) => window.api.onChatChunk(handler),
  cancelRequest: (id) => void window.api.cancelChatTest(id),
  okLabel: '账号可用'
})

const open = computed(() => !!props.account)

const accountLabel = computed(() =>
  props.account ? displayEmail(props.account.email, settingsStore.settings.privacyMode) : ''
)

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
 * 拉不到就直接把异常抛到界面上，不拿硬编码的常用模型顶上去：
 * 兜底列表并不代表该账号真的有这些模型的权限，测出来的结论会有误导。
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
      // 写入列表并校正已选模型 / 档位
      applyModels(res.data)
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
    resetForTarget()
    void loadModels()
  },
  { immediate: true }
)

async function start(): Promise<void> {
  const account = props.account
  if (!account) return
  // 校验输入与模型，进入运行态并生成 requestId；不通过时已给出提示
  const text = beginRun(account.id)
  if (text === null) return
  const currentRequest = requestId.value

  try {
    // 任意账号都能测：token 过期就先续一次，不影响 IDE 当前登录的账号
    const accessToken = await ensureAccessToken(account.id)
    // 续 Token 期间点了停止或关掉了弹窗：请求还没发出去，取消通知落了空，这里直接不发
    if (isCancelled(currentRequest)) {
      error.value = '已取消'
      return
    }
    const res = await window.api.chatTest(currentRequest, {
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
    rawTrace.value = res.data?.raw ?? res.raw ?? null
    if (res.success && res.data) result.value = res.data
    else error.value = res.error || '测试失败'
  } catch (e) {
    error.value = errorMessage(e)
  } finally {
    running.value = false
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

      <TestOutputPanel
        :output="output"
        :running="running"
        :raw="rawTrace"
        :hint="
          refreshingToken
            ? '正在为该账号续期 Token…'
            : running
              ? '等待模型返回…'
              : '点击「开始测试」后这里会实时显示流式回复'
        "
      />

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

</style>
