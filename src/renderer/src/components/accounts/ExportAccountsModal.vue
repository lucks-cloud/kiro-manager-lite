<script setup lang="ts">
import { computed, ref, watch, type Component } from 'vue'
import { message } from 'ant-design-vue'
import {
  CodeOutlined,
  CopyOutlined,
  DownOutlined,
  DownloadOutlined,
  FileOutlined,
  FileTextOutlined,
  FileZipOutlined,
  KeyOutlined,
  SnippetsOutlined,
  TableOutlined
} from '@ant-design/icons-vue'
import { useAccountsStore } from '@/stores/accounts'
import { useSettingsStore } from '@/stores/settings'
import {
  buildExportContent,
  buildSplitBundle,
  bundleFilename,
  exportFilename,
  type ExportFormat
} from '@/utils/transfer'
import { toPlain } from '@/utils/ipc'
import { copyText } from '@/utils/ui'
import type { ExportBundle } from '@shared/types'

/**
 * selectedIds 为调用方当前勾选的账号。
 * 导出范围不给用户选：有勾选就导出勾选的，没勾选就导出全部。
 * 详情抽屉这类单账号入口只要传入该账号的 id，走的是同一条规则。
 */
const props = defineProps<{ open: boolean; selectedIds?: string[] }>()
const emit = defineEmits<{ 'update:open': [boolean] }>()

const accountsStore = useAccountsStore()
const settingsStore = useSettingsStore()

const format = ref<ExportFormat>('json')
const includeCredentials = ref(true)
/** 打包导出进行中：账号多时生成 zip 要一会儿，按钮要有反馈 */
const zipping = ref(false)

/** 勾选集合，账号上千时用 Set 过滤 */
const selectedSet = computed(() => new Set(props.selectedIds ?? []))

/** 勾选可能包含已被删除的 id，按现有账号过滤后才是真实要导出的那批 */
const selected = computed(() => accountsStore.accounts.filter((a) => selectedSet.value.has(a.id)))

/** 有勾选导勾选的，没勾选导全部 */
const targets = computed(() => (selected.value.length ? selected.value : accountsStore.accounts))

/** 标题上只说明这次会导出什么，不提供切换 */
const scopeText = computed(
  () => `${selected.value.length ? '已选' : '全部'} ${targets.value.length} 个`
)

const formats = computed<{ value: ExportFormat; label: string; icon: Component; desc: string }[]>(() => [
  { value: 'json', label: 'JSON', icon: FileOutlined, desc: '完整数据，可用于导入' },
  { value: 'oidc', label: 'OIDC JSON', icon: CodeOutlined, desc: 'OIDC 精简 JSON，可粘贴到批量添加' },
  { value: 'kami', label: '卡密', icon: KeyOutlined, desc: '邮箱----密码----Token----ID----Secret' },
  {
    value: 'txt',
    label: 'TXT',
    icon: FileTextOutlined,
    desc: includeCredentials.value ? '可导入格式：邮箱,Token,昵称,登录方式' : '纯文本摘要，每个账号一段'
  },
  {
    value: 'csv',
    label: 'CSV',
    icon: TableOutlined,
    desc: includeCredentials.value ? '可导入格式，Excel 兼容' : 'Excel 兼容的用量摘要'
  },
  {
    value: 'clipboard',
    label: '剪贴板',
    icon: SnippetsOutlined,
    desc: includeCredentials.value ? '可导入格式：邮箱,Token' : '复制账号摘要到剪贴板'
  }
])

/** oidc / kami 固定携带凭证，其余格式可选 */
const supportsCredentialToggle = computed(
  () => format.value !== 'oidc' && format.value !== 'kami'
)

const effectiveCredentials = computed(() =>
  supportsCredentialToggle.value ? includeCredentials.value : true
)

/** 剪贴板本身就是复制，不需要额外的复制按钮 */
const showCopyButton = computed(() => format.value !== 'clipboard')

/**
 * 打包相关的入口只在「多个账号 + 落盘格式」时出现：
 * 单个账号打包没有意义，剪贴板格式压根不产生文件。
 */
const canBundle = computed(() => targets.value.length > 1 && format.value !== 'clipboard')

watch(
  () => props.open,
  (open) => {
    if (open) {
      format.value = 'json'
      includeCredentials.value = true
    }
  }
)

function content(): string {
  return buildExportContent(format.value, targets.value, {
    includeCredentials: effectiveCredentials.value,
    appVersion: settingsStore.appInfo?.version ?? '1.0.0'
  })
}

function close(): void {
  emit('update:open', false)
}

function copy(): void {
  if (targets.value.length === 0) return void message.warning('没有可导出的账号')
  copyText(content(), `已复制 ${targets.value.length} 个账号到剪贴板`)
  close()
}

async function saveFile(): Promise<void> {
  if (targets.value.length === 0) return void message.warning('没有可导出的账号')
  const filename = exportFilename(format.value, targets.value)
  const res = await window.api.exportToFile(content(), filename)
  if (!res.success) return void message.error(res.error || '导出失败')
  if (!res.data?.saved) return
  message.success(`已导出 ${targets.value.length} 个账号`)
  close()
}

/** 多账号时才有意义：把当前格式的单个文件压成 zip */
async function saveZip(): Promise<void> {
  if (targets.value.length === 0) return void message.warning('没有可导出的账号')
  const bundle: ExportBundle = {
    files: [{ name: exportFilename(format.value, targets.value), content: content() }]
  }
  await sendZip(bundle, `已打包导出 ${targets.value.length} 个账号`)
}

/** 逐个分割：每账号一个 JSON，再加 all.json / all.txt / all.xlsx，一起压成 zip */
async function saveSplitZip(): Promise<void> {
  if (targets.value.length === 0) return void message.warning('没有可导出的账号')
  const bundle = buildSplitBundle(format.value, targets.value, {
    includeCredentials: effectiveCredentials.value,
    appVersion: settingsStore.appInfo?.version ?? '1.0.0'
  })
  await sendZip(bundle, `已分割导出 ${targets.value.length} 个账号`)
}

async function sendZip(bundle: ExportBundle, successText: string): Promise<void> {
  zipping.value = true
  try {
    // 响应式代理无法结构化克隆，过 IPC 前先剥成普通对象
    const res = await window.api.exportToZip(toPlain(bundle), bundleFilename(targets.value))
    if (!res.success) return void message.error(res.error || '导出失败')
    if (!res.data?.saved) return
    message.success(`${successText}（共 ${res.data.count ?? 0} 个文件）`)
    close()
  } finally {
    zipping.value = false
  }
}

function submit(): void {
  if (format.value === 'clipboard') return copy()
  void saveFile()
}
</script>

<template>
  <a-modal :open="props.open" width="560px" :footer="null" @cancel="close">
    <template #title>
      <span class="export-title">
        <DownloadOutlined />
        导出账号
        <a-tag style="margin: 0">{{ scopeText }}</a-tag>
      </span>
    </template>

    <div class="format-grid">
      <button
        v-for="item in formats"
        :key="item.value"
        class="format-card"
        :class="{ selected: format === item.value }"
        @click="format = item.value"
      >
        <span class="format-head">
          <component :is="item.icon" />
          {{ item.label }}
        </span>
        <span class="format-desc muted">{{ item.desc }}</span>
      </button>
    </div>

    <div v-if="supportsCredentialToggle" class="credential-box">
      <a-checkbox v-model:checked="includeCredentials">
        <span class="credential-title">包含凭证信息</span>
        <div class="muted" style="font-size: 12px">
          包含 Token 等敏感数据，可用于完整导入
        </div>
      </a-checkbox>
    </div>
    <div v-else class="credential-box muted" style="font-size: 12px">
      该格式固定包含 Token 等凭证，导出后请妥善保管，不要上传到公开位置。
    </div>

    <a-space style="width: 100%; justify-content: flex-end; margin-top: 16px">
      <a-button @click="close">取消</a-button>
      <a-button v-if="showCopyButton" @click="copy">
        <template #icon><CopyOutlined /></template>
        复制到剪贴板
      </a-button>
      <!-- 多账号时导出按钮右侧挂一个下拉，提供打包与分割两种方式 -->
      <a-button-group v-if="canBundle">
        <a-button type="primary" :loading="zipping" @click="submit">
          <template #icon><DownloadOutlined /></template>
          导出
        </a-button>
        <a-dropdown placement="topRight">
          <a-button type="primary" :loading="zipping">
            <DownOutlined />
          </a-button>
          <template #overlay>
            <a-menu>
              <a-menu-item key="zip" @click="saveZip">
                <FileZipOutlined />
                导出为压缩包
              </a-menu-item>
              <a-menu-item key="split" @click="saveSplitZip">
                <SnippetsOutlined />
                逐个分割导出
              </a-menu-item>
            </a-menu>
          </template>
        </a-dropdown>
      </a-button-group>

      <a-button v-else type="primary" @click="submit">
        <template #icon>
          <SnippetsOutlined v-if="format === 'clipboard'" />
          <DownloadOutlined v-else />
        </template>
        {{ format === 'clipboard' ? '复制到剪贴板' : '导出' }}
      </a-button>
    </a-space>
  </a-modal>
</template>

<style scoped>
.export-title {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.format-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}

.format-card {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 12px 14px;
  text-align: left;
  cursor: pointer;
  border-radius: 10px;
  border: 2px solid var(--kal-border);
  background: transparent;
  transition: border-color 0.15s ease, background 0.15s ease;
}

.format-card:hover {
  border-color: var(--kal-primary);
}

.format-card.selected {
  border-color: var(--kal-primary);
  background: var(--kal-block-bg);
}

.format-head {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
}

.format-card.selected .format-head {
  color: var(--kal-primary);
}

.format-desc {
  font-size: 12px;
  line-height: 1.5;
}

.credential-box {
  margin-top: 14px;
  padding: 10px 12px;
  border-radius: 10px;
  background: var(--kal-block-bg);
}

.credential-title {
  font-weight: 600;
}
</style>
