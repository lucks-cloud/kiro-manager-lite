<script setup lang="ts">
/**
 * 粘贴文本导入账号：JSON / 卡密 / CSV / TXT 任选一种，格式自动识别。
 * 从文件导入走 ImportAccountsFileModal，两者共用 parseImportContent 与 store 的导入 action。
 */
import { computed, ref, watch } from 'vue'
import { message } from 'ant-design-vue'
import { CodeOutlined, CopyOutlined } from '@ant-design/icons-vue'
import { useAccountsStore } from '@/stores/accounts'
import { useSettingsStore } from '@/stores/settings'
import { copyText } from '@/utils/ui'
import { parseImportContent } from '@/utils/transfer'
import { DEFAULT_SETTINGS } from '@shared/types'
import type { BatchResult } from '@shared/types'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ 'update:open': [boolean] }>()

const accountsStore = useAccountsStore()
const settingsStore = useSettingsStore()

const text = ref('')
const importing = ref(false)
const result = ref<BatchResult | null>(null)

const placeholder = `支持以下任意一种格式：

1) 卡密：邮箱----密码----RefreshToken----ClientId----ClientSecret----登录方式
2) 精简 JSON 数组：[{ "email": "a@b.c", "refreshToken": "...", "provider": "BuilderId" }]
3) 本应用导出的完整 JSON（含用量、订阅快照）
4) CSV（带表头）/ TXT（邮箱,RefreshToken,昵称,登录方式）`

/**
 * 解析结果只算一次：预览与提交共用同一个 computed 缓存。
 * 粘贴几千行时，每次按键重新全量解析两遍的开销很可观。
 */
const parsed = computed(() => (text.value.trim() ? parseImportContent(text.value) : null))

const preview = computed(() => {
  const data = parsed.value
  if (!data) return null
  if (data.fullData) {
    return { kind: '完整备份', count: data.fullData.accounts?.length ?? 0 }
  }
  return { kind: '凭证条目', count: data.items.length }
})

/** 导入几千条时日志可能上千行，只渲染前若干条，避免一次性塞入大量 DOM */
const MAX_VISIBLE_MESSAGES = 200
const visibleMessages = computed(() => result.value?.messages.slice(0, MAX_VISIBLE_MESSAGES) ?? [])
const hiddenMessageCount = computed(() =>
  Math.max(0, (result.value?.messages.length ?? 0) - MAX_VISIBLE_MESSAGES)
)

/** 复制完整日志：界面只渲染前 200 条，但排查问题需要全部内容 */
function copyLog(): void {
  const lines = result.value?.messages ?? []
  if (!lines.length) return
  copyText(lines.join('\n'), `已复制 ${lines.length} 条日志`)
}

const importConcurrency = computed(
  () => settingsStore.settings.importConcurrency || DEFAULT_SETTINGS.importConcurrency
)

/** 只展示本次导入自身的校验进度，不显示后台批量刷新之类的其它任务 */
const validationProgress = computed(() => {
  const task = accountsStore.task
  if (!importing.value || !task.running || task.type !== 'import-validation') return null
  return `校验进度 ${task.done}/${task.total}`
})

watch(
  () => props.open,
  (open) => {
    if (open) {
      text.value = ''
      result.value = null
    }
  }
)

function close(): void {
  emit('update:open', false)
}

async function submit(): Promise<void> {
  const data = parsed.value
  if (!data) return void message.warning('请先粘贴要导入的内容')

  importing.value = true
  try {
    if (data.fullData) {
      // 完整备份直接恢复，不再逐个联网校验
      const res = accountsStore.importFullData(data.fullData)
      result.value = res
      message.success(`恢复完成：新增 ${res.success}，跳过 ${res.skipped}`)
      if (!res.failed) close()
      return
    }

    if (data.items.length === 0) {
      return void message.error('没有解析出有效凭证，请检查格式')
    }
    const res = await accountsStore.importItems(data.items)
    result.value = res
    if (res.success) {
      message.success(`导入完成：成功 ${res.success}，跳过 ${res.skipped}，失败 ${res.failed}`)
    } else {
      message.warning(`没有成功导入的账号（跳过 ${res.skipped}，失败 ${res.failed}）`)
    }
    // 全部处理成功则直接关闭；有失败时保留弹窗，方便查看导入日志
    if (res.success && !res.failed) close()
  } finally {
    importing.value = false
  }
}
</script>

<template>
  <a-modal
    :open="props.open"
    width="700px"
    centered
    :confirm-loading="importing"
    ok-text="开始导入"
    cancel-text="关闭"
    :mask-closable="!importing"
    @ok="submit"
    @cancel="close"
  >
    <template #title>
      <span class="modal-title">
        <CodeOutlined />
        粘贴文本导入账号
      </span>
    </template>

    <a-textarea v-model:value="text" :rows="12" :placeholder="placeholder" />

    <div v-if="preview" style="margin-top: 10px">
      <a-tag color="blue">识别为 {{ preview.kind }}</a-tag>
      <span class="muted">共 {{ preview.count }} 条</span>
      <span v-if="preview.kind === '凭证条目'" class="muted">
        · 导入时会联网校验并拉取用量，并发 {{ importConcurrency }}（可在设置里调整）
      </span>
    </div>

    <a-alert
      v-if="validationProgress"
      type="info"
      show-icon
      style="margin-top: 10px"
      :message="validationProgress"
    />

    <template v-if="result?.messages.length">
      <a-divider style="margin: 14px 0 10px" />
      <div class="log-head">
        <span class="section-title">导入日志</span>
        <!-- 复制的是全部日志，不只是界面上截断显示的那 200 条 -->
        <a-button type="text" size="small" @click="copyLog">
          <template #icon><CopyOutlined /></template>
          复制全部
        </a-button>
      </div>
      <div class="token-box mono" style="max-height: 140px">
        <div v-for="(line, i) in visibleMessages" :key="i">{{ line }}</div>
        <div v-if="hiddenMessageCount" class="muted">
          … 另有 {{ hiddenMessageCount }} 条未显示（避免一次渲染过多内容）
        </div>
      </div>
    </template>
  </a-modal>
</template>

<style scoped>
/* 标题与复制按钮同一行：标题左、按钮右 */
.log-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.modal-title {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
</style>
