<script setup lang="ts">
import { computed, ref, watch, type Component } from 'vue'
import { message } from 'ant-design-vue'
import {
  CopyOutlined,
  DownloadOutlined,
  GlobalOutlined,
  KeyOutlined
} from '@ant-design/icons-vue'
import { useKeysStore } from '@/stores/keys'
import {
  apiKeyExportFilename,
  buildApiKeyExportContent,
  type ApiKeyExportFormat
} from '@/utils/transfer'
import { copyText } from '@/utils/ui'

/**
 * selectedIds 为列表当前勾选的 Key。
 * 与账号导出同一条规则：有勾选就导出勾选的，没勾选就导出全部，不给用户选范围。
 */
const props = defineProps<{ open: boolean; selectedIds?: string[] }>()
const emit = defineEmits<{ 'update:open': [boolean] }>()

const keysStore = useKeysStore()

const format = ref<ApiKeyExportFormat>('keyRegion')

const allKeys = computed(() => keysStore.data.keys)

/** 勾选集合，Key 多时用 Set 过滤 */
const selectedSet = computed(() => new Set(props.selectedIds ?? []))

/** 勾选可能包含已被删除的 id，按现有 Key 过滤后才是真实要导出的那批 */
const selected = computed(() => allKeys.value.filter((entry) => selectedSet.value.has(entry.id)))

const targets = computed(() => (selected.value.length ? selected.value : allKeys.value))

const scopeText = computed(
  () => `${selected.value.length ? '已选' : '全部'} ${targets.value.length} 个`
)

const formats = computed<
  { value: ApiKeyExportFormat; label: string; icon: Component; desc: string }[]
>(() => [
  {
    value: 'keyRegion',
    label: 'APIKey-地区',
    icon: GlobalOutlined,
    desc: '每行 apikey----地区，可回导并还原区域'
  },
  {
    value: 'key',
    label: 'APIKey',
    icon: KeyOutlined,
    desc: '每行一个完整 Key，便于直接粘贴使用'
  }
])

watch(
  () => props.open,
  (open) => {
    if (open) format.value = 'keyRegion'
  }
)

function content(): string {
  return buildApiKeyExportContent(format.value, targets.value)
}

function close(): void {
  emit('update:open', false)
}

function copy(): void {
  if (!targets.value.length) return void message.warning('没有可导出的 API Key')
  copyText(content(), `已复制 ${targets.value.length} 个 API Key 到剪贴板`)
  close()
}

async function saveFile(): Promise<void> {
  if (!targets.value.length) return void message.warning('没有可导出的 API Key')
  const res = await window.api.exportToFile(content(), apiKeyExportFilename())
  if (!res.success) return void message.error(res.error || '导出失败')
  if (!res.data?.saved) return
  message.success(`已导出 ${targets.value.length} 个 API Key`)
  close()
}
</script>

<template>
  <a-modal :open="props.open" width="560px" :footer="null" @cancel="close">
    <template #title>
      <span class="kal-export-title">
        <DownloadOutlined />
        导出 API Key
        <a-tag style="margin: 0">{{ scopeText }}</a-tag>
      </span>
    </template>

    <div class="kal-export-formats">
      <button
        v-for="item in formats"
        :key="item.value"
        class="kal-export-format"
        :class="{ selected: format === item.value }"
        @click="format = item.value"
      >
        <span class="kal-export-format-head">
          <component :is="item.icon" />
          {{ item.label }}
        </span>
        <span class="kal-export-format-desc muted">{{ item.desc }}</span>
      </button>
    </div>

    <div class="kal-export-credential muted" style="font-size: 12px">
      两种格式都包含可直接使用的完整 API Key，导出后请妥善保管，不要上传到公开位置。
    </div>

    <a-space style="width: 100%; justify-content: flex-end; margin-top: 16px">
      <a-button @click="close">取消</a-button>
      <a-button @click="copy">
        <template #icon><CopyOutlined /></template>
        复制到剪贴板
      </a-button>
      <a-button type="primary" @click="saveFile">
        <template #icon><DownloadOutlined /></template>
        导出
      </a-button>
    </a-space>
  </a-modal>
</template>

<!-- 格式卡片、说明块等与导出账号共用的样式在 assets/styles.css 的 .kal-export-* 段 -->
<style scoped>
.kal-export-format.selected {
  border-color: var(--kal-primary);
  background: var(--kal-block-bg);
}
</style>
