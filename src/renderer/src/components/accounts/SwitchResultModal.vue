<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { message } from 'ant-design-vue'
import {
  CheckCircleFilled,
  ExclamationCircleFilled,
  ReloadOutlined
} from '@ant-design/icons-vue'
import PathMenu from '@/components/common/PathMenu.vue'
import { useAccountsStore } from '@/stores/accounts'
import { copyText } from '@/utils/ui'
import type { SwitchAccountResult } from '@shared/types'

const props = defineProps<{
  open: boolean
  /** 已打码处理过的账号显示名 */
  accountLabel: string
  result: SwitchAccountResult | null
}>()
const emit = defineEmits<{ 'update:open': [boolean] }>()

const accountsStore = useAccountsStore()

const restarting = ref(false)

/**
 * 校验状态分三种：通过 / 明确失败 / 主进程没给结论。
 * 最后一种出现在主进程版本比界面旧（缺少 verified 字段）时，
 * 报「校验未通过：未知原因」会误导，这里单独提示重启应用。
 */
const verifyState = computed<'ok' | 'failed' | 'unknown'>(() => {
  if (props.result?.verified === true) return 'ok'
  if (props.result?.verified === false) return 'failed'
  return 'unknown'
})

watch(
  () => props.open,
  (open) => {
    if (open) restarting.value = false
  }
)

async function reveal(path: string): Promise<void> {
  const res = await window.api.revealSsoCacheFile(path)
  if (!res.success) message.error(res.error || '打开目录失败')
}

function close(): void {
  emit('update:open', false)
}

async function restart(): Promise<void> {
  restarting.value = true
  try {
    const res = await accountsStore.restartKiroIde()
    if (res.ok) {
      message.success(res.message)
      close()
    } else {
      message.warning(res.message)
    }
  } finally {
    restarting.value = false
  }
}
</script>

<template>
  <a-modal :open="props.open" width="760px" centered :footer="null" @cancel="close">
    <template #title>
      <span class="title">
        <CheckCircleFilled v-if="verifyState === 'ok'" style="color: #52c41a" />
        <ExclamationCircleFilled v-else style="color: #faad14" />
        {{
          verifyState === 'ok'
            ? '切换成功'
            : verifyState === 'failed'
              ? '已写入，但校验未通过'
              : '已写入，未拿到校验结果'
        }}
      </span>
    </template>

    <p class="lead">
      账号 <strong>{{ props.accountLabel }}</strong> 的凭证已写入 Kiro IDE。
    </p>

    <a-alert
      v-if="verifyState === 'ok'"
      type="success"
      show-icon
      message="已用新 Token 实测通过用量接口，凭证可用"
      style="margin-bottom: 12px"
    />
    <a-alert
      v-else-if="verifyState === 'failed'"
      type="warning"
      show-icon
      :message="`校验未通过：${props.result?.verifyError || '用量接口没有返回可识别的结果'}`"
      description="凭证已经落盘，IDE 重启后可能仍然可用。若 IDE 报 Invalid token，请刷新该账号的用量后重试切换。"
      style="margin-bottom: 12px"
    />
    <a-alert
      v-else
      type="warning"
      show-icon
      message="主进程没有返回校验结果"
      description="通常是应用还在运行旧版本的主进程。请完全退出应用（含托盘）后重新启动，再切换一次即可看到实测结论。"
      style="margin-bottom: 12px"
    />

    <a-descriptions :column="1" size="small" class="detail">
      <a-descriptions-item label="Token 文件">
        <PathMenu
          v-if="props.result?.tokenPath"
          :path="props.result.tokenPath"
          @reveal="reveal(props.result.tokenPath)"
        />
        <span v-else class="mono">-</span>
      </a-descriptions-item>
      <a-descriptions-item v-if="props.result?.clientRegPath" label="客户端注册">
        <PathMenu
          :path="props.result.clientRegPath"
          @reveal="reveal(props.result.clientRegPath!)"
        />
      </a-descriptions-item>
      <a-descriptions-item label="profileArn">
        <a-tooltip v-if="props.result?.profileArn" title="点击复制">
          <a
            class="copy-value mono"
            role="button"
            tabindex="0"
            @click="copyText(props.result.profileArn, 'profileArn 已复制')"
          >{{ props.result.profileArn }}</a>
        </a-tooltip>
        <span v-else class="mono">(未写入)</span>
      </a-descriptions-item>
    </a-descriptions>

    <ul v-if="props.result?.notes?.length" class="notes">
      <li v-for="(note, i) in props.result.notes" :key="i">{{ note }}</li>
    </ul>

    <p class="muted tip">
      已经在运行的 IDE 仍握着上一个账号的 Token，需要重启才会重新读取凭证。
    </p>

    <a-space style="width: 100%; justify-content: flex-end">
      <a-button @click="close">稍后手动重启</a-button>
      <a-button type="primary" :loading="restarting" @click="restart">
        <template #icon><ReloadOutlined /></template>
        重启 Kiro IDE
      </a-button>
    </a-space>
  </a-modal>
</template>

<style scoped>
.title {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.lead {
  margin: 0 0 12px;
}

.detail {
  margin-bottom: 4px;
}

/* 可点击复制的值：与 PathMenu 同一套浅色虚线，悬停变主题色 */
.copy-value {
  color: inherit;
  word-break: break-all;
  cursor: pointer;
  border-bottom: 1px dashed var(--kal-muted);
  transition: color 0.15s, border-color 0.15s;
}
.copy-value:hover,
.copy-value:focus-visible {
  color: var(--kal-primary);
  border-bottom-color: var(--kal-primary);
  outline: none;
}

.notes {
  margin: 0 0 10px;
  padding: 8px 12px 8px 26px;
  border-radius: 8px;
  background: var(--kal-block-bg);
  color: var(--kal-muted);
  font-size: 12px;
  line-height: 1.8;
}

.tip {
  margin: 0 0 14px;
  font-size: 12px;
}
</style>
