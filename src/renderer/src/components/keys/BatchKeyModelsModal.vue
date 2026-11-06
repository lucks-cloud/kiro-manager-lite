<script setup lang="ts">
/**
 * API Key 批量获取模型列表：每个选中 Key 一行，逐个向 Kiro 管理面查询可用模型，
 * 显示每个 Key 可用的模型数量与模型 ID。与账户管理的「批量获取模型」同一套交互。
 *
 * 执行框架复用 useBatchRun：点「开始获取」后串行逐个、单个失败不影响后续、
 * 可中止、可重试失败项、全部完成后可「重新获取」。
 *
 * 获取后按模型数量归类（8 个 / 9 个 / 10 个…），点某一档只看那些 Key；
 * 下载对象都是当前筛选下获取成功的 Key：
 *  - 导出（首选）：打开 API Key 导出弹窗，按所选导出模式导出这批 Key 本身
 *  - txt / xlsx（更多）：导出模型清单，下载前先选字段
 *
 * 列表、筛选、下载等公共部分在 BatchModelsModalBase，这里只给 Key 特有的拉取方式、行头与文案。
 */
import { computed } from 'vue'
import BatchModelsModalBase, { type BatchModelsField } from '@/components/common/BatchModelsModalBase.vue'
import ExportApiKeysModal from '@/components/keys/ExportApiKeysModal.vue'
import { useKeysStore } from '@/stores/keys'
import { useSettingsStore } from '@/stores/settings'
import { displayEmail, displayKey } from '@/utils/display'
import { copyText } from '@/utils/ui'
import type { IpcResult, KeyEntry, KiroModelInfo } from '@shared/types'

/** keys 由调用方按界面顺序传入 */
const props = defineProps<{ keys: KeyEntry[] }>()
const emit = defineEmits<{ close: [] }>()

const store = useKeysStore()
const settingsStore = useSettingsStore()

/** 按 id 在主进程取 Key，明文不经渲染进程来回传 */
function fetchModels(entry: KeyEntry): Promise<IpcResult<KiroModelInfo[]>> {
  return window.api.listKeyModelDetails(entry.id)
}

/**
 * 只交还仍然存在的 Key：导出弹窗的规则是「勾选为空就导出全部」，
 * 万一这批 Key 在获取期间被删光，传空数组会变成把整个 Key 库导出去。
 */
function filterAlive(ids: string[]): string[] {
  const alive = new Set(store.data.keys.map((item) => item.id))
  return ids.filter((id) => alive.has(id))
}

const privacy = computed(() => settingsStore.settings.privacyMode)
const keyText = (entry: KeyEntry): string => displayKey(entry.key, privacy.value)
const emailText = (entry: KeyEntry): string =>
  entry.email ? displayEmail(entry.email, privacy.value) : '-'

/** Key 与邮箱都写完整值，不做隐私打码：导出的清单是给人核对用的；其后是模型数量、模型列表 */
const EXPORT_FIELDS: BatchModelsField<KeyEntry>[] = [
  {
    key: 'key',
    label: 'API Key',
    text: (row) => row.item.key,
    column: { title: 'API Key', width: 48 },
    cell: (row) => row.item.key
  },
  {
    key: 'email',
    label: '邮箱',
    text: (row) => row.item.email || '',
    column: { title: '邮箱', width: 30 },
    cell: (row) => row.item.email || null
  }
]
</script>

<template>
  <BatchModelsModalBase
    :items="props.keys"
    noun="Key"
    alert="按列表顺序逐个查询每个 API Key 可用的模型，单个失败不影响后续。不同订阅档位能用的模型可能不同。"
    empty-text="这一档下没有 API Key"
    export-label="导出"
    gone-text="这些 API Key 已不在列表里"
    message-key="batch-key-models-abort"
    file-prefix="key-models-"
    :fields="EXPORT_FIELDS"
    :fetch-models="fetchModels"
    :filter-alive="filterAlive"
    @close="emit('close')"
  >
    <!-- 第一排左侧：Key + 邮箱 + 订阅档位 -->
    <template #head="{ item }">
      <span
        class="row-key mono"
        title="点击复制完整 API Key"
        @click="copyText(item.key, '已复制 API Key')"
      >{{ keyText(item) }}</span>
      <span class="row-email muted">{{ emailText(item) }}</span>
      <a-tag v-if="item.subscription" :bordered="false" class="kal-batch-tier-tag">
        {{ item.subscription }}
      </a-tag>
    </template>

    <!-- 导出：复用 API Key 导出弹窗，范围是当前筛选下获取成功的这批 Key -->
    <template #export="{ ids, open, update }">
      <ExportApiKeysModal :open="open" :selected-ids="ids" @update:open="update" />
    </template>
  </BatchModelsModalBase>
</template>

<style scoped>
/* Key 可点复制：悬停变主题色 */
.row-key {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: color 0.15s;
}
.row-key:hover { color: var(--kal-primary); }
.row-email { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }

.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
.muted { color: var(--kal-muted); }
</style>
