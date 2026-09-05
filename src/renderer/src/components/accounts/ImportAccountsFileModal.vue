<script setup lang="ts">
/**
 * 从文件导入账号：拖拽 / 点击选择，支持一次选多个文件并按列表顺序依次导入。
 *
 * 文件内容在渲染进程直接用 File.text() 读，不走主进程的单选对话框，
 * 这样才能一次拿到多个文件；解析沿用与文本导入相同的 parseImportContent。
 */
import { computed, nextTick, ref, watch } from 'vue'
import { message } from 'ant-design-vue'
import {
  CopyOutlined,
  DeleteOutlined,
  ImportOutlined,
  InboxOutlined,
  LoadingOutlined
} from '@ant-design/icons-vue'
import { useAccountsStore } from '@/stores/accounts'
import { useSettingsStore } from '@/stores/settings'
import { copyText } from '@/utils/ui'
import { parseImportContent, type ParsedImport } from '@/utils/transfer'
import { DEFAULT_SETTINGS, type BatchResult } from '@shared/types'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ 'update:open': [boolean] }>()

const accountsStore = useAccountsStore()
const settingsStore = useSettingsStore()

interface Entry {
  /** 列表内唯一 key，同名文件也能各自删除 */
  uid: string
  name: string
  size: number
  parsed?: ParsedImport
  /** 读取或解析失败的原因；有值时该文件不参与导入 */
  error?: string
}

const entries = ref<Entry[]>([])
const importing = ref(false)
/** 正在导入第几个文件（1 基），0 表示未开始 */
const currentIndex = ref(0)
const currentName = ref('')
const result = ref<BatchResult | null>(null)

const importConcurrency = computed(
  () => settingsStore.settings.importConcurrency || DEFAULT_SETTINGS.importConcurrency
)

/** 可导入的文件（排除解析失败的） */
const usable = computed(() => entries.value.filter((e) => !e.error && e.parsed))

/** 还在读取中的文件：此时不能开始导入，否则它们会被漏掉 */
const pendingCount = computed(
  () => entries.value.filter((e) => !e.error && !e.parsed).length
)

const totalCount = computed(() => usable.value.reduce((sum, e) => sum + entryCount(e), 0))

/** 是否存在需要联网校验的凭证条目 */
const hasCredentialItems = computed(() =>
  usable.value.some((e) => !e.parsed?.fullData && (e.parsed?.items.length ?? 0) > 0)
)

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

function entryCount(entry: Entry): number {
  const parsed = entry.parsed
  if (!parsed) return 0
  return parsed.fullData ? (parsed.fullData.accounts?.length ?? 0) : parsed.items.length
}

function entryKind(entry: Entry): string {
  if (entry.error) return '无法解析'
  return entry.parsed?.fullData ? '完整备份' : '凭证条目'
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

watch(
  () => props.open,
  (open) => {
    if (open) {
      entries.value = []
      result.value = null
      currentIndex.value = 0
      currentName.value = ''
    }
  }
)

/**
 * a-upload 的钩子：必须同步返回 false 才能稳定阻止它自己发起上传
 * （返回 Promise 会被当成 transformFile 的结果处理）。读文件在后台异步进行。
 * 多选时该钩子会对每个文件各调用一次，加入顺序即为后续导入顺序。
 */
function beforeUpload(file: File): boolean {
  void addFile(file)
  return false
}

async function addFile(file: File): Promise<void> {
  // 同名同大小视为重复选择，避免同一个文件被导入两次
  if (entries.value.some((e) => e.name === file.name && e.size === file.size)) {
    message.info(`${file.name} 已在列表中`)
    return
  }

  const entry: Entry = {
    uid: `${file.name}-${file.size}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: file.name,
    size: file.size
  }
  entries.value = [...entries.value, entry]

  try {
    // 去掉 BOM：带 BOM 的 JSON 会让 JSON.parse 直接抛错
    const text = (await file.text()).replace(/^\ufeff/, '')
    if (!text.trim()) throw new Error('文件内容为空')
    const parsed = parseImportContent(text)
    const count = parsed.fullData ? (parsed.fullData.accounts?.length ?? 0) : parsed.items.length
    if (count === 0) throw new Error('没有解析出有效凭证，请检查格式')
    update(entry.uid, { parsed })
  } catch (e) {
    update(entry.uid, { error: e instanceof Error ? e.message : String(e) })
  }
}

function update(uid: string, patch: Partial<Entry>): void {
  entries.value = entries.value.map((e) => (e.uid === uid ? { ...e, ...patch } : e))
}

function remove(uid: string): void {
  entries.value = entries.value.filter((e) => e.uid !== uid)
}

function clearAll(): void {
  entries.value = []
  result.value = null
}

function close(): void {
  emit('update:open', false)
}

/** 按列表顺序逐个导入，汇总成一份结果 */
async function submit(): Promise<void> {
  if (pendingCount.value) return void message.warning('还有文件正在读取，请稍候')
  const list = usable.value
  if (list.length === 0) return void message.warning('请先添加可导入的文件')

  importing.value = true
  const merged: BatchResult = { success: 0, failed: 0, skipped: 0, messages: [] }
  try {
    for (let i = 0; i < list.length; i++) {
      const entry = list[i]
      currentIndex.value = i + 1
      currentName.value = entry.name

      const parsed = entry.parsed as ParsedImport
      let single: BatchResult
      if (parsed.fullData) {
        // 完整备份含用量与订阅快照，直接本地恢复，不再逐个联网校验。
        // 恢复是同步的，先让出一帧把进度文案渲染出来，否则连续多个备份会看起来卡住。
        await nextTick()
        single = accountsStore.importFullData(parsed.fullData)
      } else {
        single = await accountsStore.importItems(parsed.items)
      }

      merged.success += single.success
      merged.failed += single.failed
      merged.skipped += single.skipped
      merged.messages.push(
        `【${entry.name}】成功 ${single.success}，跳过 ${single.skipped}，失败 ${single.failed}`,
        ...single.messages.map((line) => `  ${line}`)
      )
    }

    result.value = merged
    const summary = `成功 ${merged.success}，跳过 ${merged.skipped}，失败 ${merged.failed}`
    if (merged.success) message.success(`${list.length} 个文件导入完成：${summary}`)
    else message.warning(`没有成功导入的账号（${summary}）`)
    // 全部顺利才自动关闭；有失败时留下弹窗给用户看日志
    if (merged.success && !merged.failed) close()
  } finally {
    importing.value = false
    currentIndex.value = 0
    currentName.value = ''
  }
}
</script>

<template>
  <a-modal
    :open="props.open"
    width="700px"
    centered
    :footer="null"
    :mask-closable="!importing"
    :closable="!importing"
    @cancel="close"
  >
    <template #title>
      <span class="modal-title">
        <ImportOutlined />
        从文件导入账号
        <a-tag v-if="usable.length" color="blue" style="margin: 0">
          {{ usable.length }} 个文件 · 共 {{ totalCount }} 条
        </a-tag>
      </span>
    </template>

    <a-upload-dragger
      class="tool-dragger"
      :multiple="true"
      :show-upload-list="false"
      accept=".json,.txt,.csv"
      :disabled="importing"
      :before-upload="beforeUpload"
    >
      <!-- 自己包一层做撑高与居中，不去改 ant 内部元素的 display -->
      <div class="drop-inner">
        <p class="drop-icon"><InboxOutlined /></p>
        <p class="drop-title">点击选择，或把文件拖到这里</p>
        <p class="drop-hint">
          支持一次选择多个文件，按列表顺序依次导入。
          可用格式：完整备份 JSON、精简 JSON、卡密 TXT、CSV
        </p>
      </div>
    </a-upload-dragger>

    <div v-if="entries.length" class="file-list">
      <div v-for="(entry, index) in entries" :key="entry.uid" class="file-row">
        <span class="file-index">{{ index + 1 }}</span>
        <div class="file-body">
          <div class="file-name">{{ entry.name }}</div>
          <div class="file-meta muted">
            <template v-if="entry.error">
              <span class="file-error">{{ entry.error }}</span>
            </template>
            <template v-else-if="entry.parsed">
              {{ entryKind(entry) }} · {{ entryCount(entry) }} 条 · {{ formatSize(entry.size) }}
            </template>
            <template v-else>
              <LoadingOutlined /> 正在读取…
            </template>
          </div>
        </div>
        <a-tag v-if="entry.error" color="red" style="margin: 0">跳过</a-tag>
        <a-button type="text" size="small" danger :disabled="importing" @click="remove(entry.uid)">
          <template #icon><DeleteOutlined /></template>
        </a-button>
      </div>
    </div>

    <div v-if="hasCredentialItems && !importing" class="hint-line muted">
      凭证条目会在导入时联网校验并拉取用量，并发 {{ importConcurrency }}（可在设置里调整）
    </div>

    <a-alert
      v-if="importing"
      type="info"
      show-icon
      style="margin-top: 12px"
      :message="`正在导入第 ${currentIndex}/${usable.length} 个文件：${currentName}`"
      :description="
        accountsStore.task.running && accountsStore.task.type === 'import-validation'
          ? `校验进度 ${accountsStore.task.done}/${accountsStore.task.total}`
          : undefined
      "
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
      <div class="token-box mono" style="max-height: 160px">
        <div v-for="(line, i) in visibleMessages" :key="i">{{ line }}</div>
        <div v-if="hiddenMessageCount" class="muted">
          … 另有 {{ hiddenMessageCount }} 条未显示（避免一次渲染过多内容）
        </div>
      </div>
    </template>

    <a-space style="width: 100%; justify-content: flex-end; margin-top: 16px">
      <a-button :disabled="importing" @click="close">关闭</a-button>
      <a-button v-if="entries.length" :disabled="importing" @click="clearAll">清空列表</a-button>
      <a-button
        type="primary"
        :loading="importing || pendingCount > 0"
        :disabled="usable.length === 0 || pendingCount > 0"
        @click="submit"
      >
        <template #icon><ImportOutlined /></template>
        开始导入{{ usable.length ? `（${usable.length} 个文件）` : '' }}
      </a-button>
    </a-space>
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

/*
 * 拖拽区加高。ant 的 .ant-upload-wrapper 是 span 且没设 display，
 * dragger 的 height prop 只是往它上面写 inline height，对 inline 元素无效，
 * 所以高度只能由这里的 min-height 撑出来。
 */
.tool-dragger {
  display: block;
}

.tool-dragger :deep(.ant-upload-drag) {
  min-height: 220px;
}

/*
 * 垂直居中交给自己的包裹层：ant 内部是 table + table-cell 布局，
 * 一旦把 .ant-upload-btn 改成 flex，slot 里的元素会变成 flex item 横向排开。
 */
.drop-inner {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 190px;
}

.drop-icon {
  margin: 0 0 12px;
  font-size: 56px;
  line-height: 1;
  color: var(--kal-primary);
}

.drop-title {
  margin: 0 0 6px;
  font-size: 16px;
}

.drop-hint {
  margin: 0 auto;
  max-width: 440px;
  color: var(--kal-muted);
  font-size: 12.5px;
  line-height: 1.8;
}

.file-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 240px;
  overflow-y: auto;
  margin-top: 14px;
}

.file-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-radius: 10px;
  background: var(--kal-block-bg);
}

.file-index {
  flex: 0 0 auto;
  width: 20px;
  text-align: center;
  color: var(--kal-muted);
  font-size: 12px;
}

.file-body {
  flex: 1 1 auto;
  min-width: 0;
}

.file-name {
  font-size: 13px;
  word-break: break-all;
}

.file-meta {
  margin-top: 1px;
  font-size: 12px;
}

.file-error {
  color: #cf1322;
}

.hint-line {
  margin-top: 10px;
  font-size: 12px;
}
</style>
