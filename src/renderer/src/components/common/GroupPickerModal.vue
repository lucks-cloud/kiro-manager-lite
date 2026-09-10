<script setup lang="ts">
/**
 * 批量设置分组：选中若干条目后指定它们归属的分组。
 * 弹窗内也能新建分组、拖动排序、改名与删除，不必先去筛选面板建好再回来。
 *
 * 账号列表与 API Key 列表共用这一份，读写走 GroupApi 门面。
 * 没选分组就等于「不设置」，保存按钮置灰；要清空归属走左下角的「移出分组」。
 */
import { computed, ref } from 'vue'
import { message } from 'ant-design-vue'
import { PlusOutlined } from '@ant-design/icons-vue'
import GroupGrid from '@/components/common/GroupGrid.vue'
import { confirmDanger, confirmDelete } from '@/utils/ui'
import type { GroupApi } from '@/utils/groupApi'
import type { AccountGroup } from '@shared/types'

const props = defineProps<{
  api: GroupApi
  ids: string[]
  /** 条目名称，用于文案：账号 / Key */
  entity: string
}>()

const emit = defineEmits<{ close: [] }>()

/** 选中的目标分组；空串表示没选，保存时什么也不做 */
const picked = ref('')
const newName = ref('')
const saving = ref(false)
const renaming = ref<AccountGroup | null>(null)
const renameValue = ref('')

const groups = computed(() => props.api.groups)
/** 单选：GroupGrid 要的是数组，这里包一层 */
const selected = computed(() => (picked.value ? [picked.value] : []))

async function submitNew(): Promise<void> {
  const name = newName.value.trim()
  if (!name || saving.value) return
  saving.value = true
  try {
    const res = await props.api.add(name)
    if (res.error) return void message.error(res.error)
    newName.value = ''
    // 新建后直接选中，省一次点击
    if (res.group) picked.value = res.group.id
  } finally {
    saving.value = false
  }
}

function openRename(group: AccountGroup): void {
  renaming.value = group
  renameValue.value = group.name
}

async function submitRename(): Promise<void> {
  const target = renaming.value
  if (!target) return
  const error = await props.api.rename(target.id, renameValue.value)
  if (error) return void message.error(error)
  renaming.value = null
}

function remove(group: AccountGroup): void {
  const count = props.api.counts[group.id] ?? 0
  confirmDelete({
    title: '删除分组',
    content: count
      ? `确认删除分组「${group.name}」？其下 ${count} 个${props.entity}会变为未分组，${props.entity}本身不会被删除。`
      : `确认删除分组「${group.name}」？`,
    onOk: async () => {
      const error = await props.api.remove(group.id)
      if (error) return void message.error(error)
      if (picked.value === group.id) picked.value = ''
    }
  })
}

async function reorder(orderedIds: string[]): Promise<void> {
  const error = await props.api.reorder(orderedIds)
  if (error) message.error(error)
}

async function submit(): Promise<void> {
  if (!props.ids.length) return void message.info(`没有选中的${props.entity}`)
  // 没选分组就是「不设置」，直接关掉，什么也不改
  if (!picked.value) return void emit('close')
  const res = await props.api.assign(props.ids, picked.value)
  if (res.error) return void message.error(res.error)
  const name = groups.value.find((group) => group.id === picked.value)?.name
  message.success(`已将 ${res.changed} 个${props.entity}移入「${name}」`)
  emit('close')
}

/**
 * 移出分组：把所选条目变回未分组。
 * 二次确认，zIndex 要高于本弹窗，否则确认框会被盖在下面点不到。
 */
function confirmUnassign(): void {
  if (!props.ids.length) return void message.info(`没有选中的${props.entity}`)
  confirmDanger({
    title: '移出分组',
    content: `确认将所选 ${props.ids.length} 个${props.entity}移出分组？${props.entity}本身与分组都不会被删除。`,
    okText: '移出分组',
    zIndex: 1100,
    onOk: async () => {
      const res = await props.api.assign(props.ids, null)
      if (res.error) return void message.error(res.error)
      message.success(`已将 ${res.changed} 个${props.entity}移出分组`)
      emit('close')
    }
  })
}
</script>

<template>
  <a-modal
    :open="true"
    title="批量设置分组"
    centered
    width="520px"
    @cancel="emit('close')"
  >
    <!-- 自定义底栏：左下角放「移出分组」，和右侧的取消 / 保存分开，免得误点 -->
    <template #footer>
      <div class="picker-footer">
        <!-- 用带描边的危险按钮，和右侧取消 / 保存同一视觉量级；文字按钮太轻，看不出可点 -->
        <a-button danger :disabled="!props.ids.length" @click="confirmUnassign">
          移出分组
        </a-button>
        <span class="footer-spacer" />
        <a-button @click="emit('close')">取消</a-button>
        <a-button type="primary" :disabled="!picked" @click="submit">保存</a-button>
      </div>
    </template>

    <p class="muted tip">
      选中一个分组后保存，所选 {{ props.ids.length }} 个{{ props.entity }}都会移入该分组。
    </p>

    <a-space-compact class="panel-add" block>
      <a-input
        v-model:value="newName"
        placeholder="新建分组名称"
        :maxlength="30"
        allow-clear
        @press-enter="submitNew"
      />
      <a-button type="primary" :disabled="!newName.trim()" :loading="saving" @click="submitNew">
        <template #icon><PlusOutlined /></template>
        添加
      </a-button>
    </a-space-compact>

    <div v-if="groups.length" class="panel-hint muted">长按可拖动排序，右侧三点可改名 / 删除</div>

    <GroupGrid
      v-if="groups.length"
      :groups="groups"
      :selected="selected"
      :counts="props.api.counts"
      @select="(id) => (picked = picked === id ? '' : id)"
      @rename="openRename"
      @remove="remove"
      @reorder="reorder"
    />
    <div v-else class="panel-empty muted">还没有分组，先在上面新建一个</div>

    <a-modal
      v-if="renaming"
      :open="true"
      title="编辑分组名称"
      centered
      width="420px"
      :z-index="1100"
      ok-text="保存"
      cancel-text="取消"
      @ok="submitRename"
      @cancel="renaming = null"
    >
      <a-input
        v-model:value="renameValue"
        placeholder="分组名称"
        :maxlength="30"
        allow-clear
        @press-enter="submitRename"
      />
    </a-modal>
  </a-modal>
</template>

<style scoped>
.tip {
  margin: 0 0 12px;
  font-size: 12px;
}

/* 左下角一个、右下角两个，中间由弹性占位撑开 */
.picker-footer {
  display: flex;
  align-items: center;
  gap: 8px;
}

.footer-spacer {
  flex: 1 1 auto;
}

.panel-add {
  margin-bottom: 10px;
}

/* 输入框吃掉剩余宽度，按钮按内容宽 */
.panel-add :deep(.ant-input-affix-wrapper),
.panel-add :deep(.ant-input) {
  flex: 1;
  min-width: 0;
}

.panel-hint,
.panel-empty {
  margin-bottom: 8px;
  font-size: 12px;
}

.panel-empty {
  padding: 10px 0;
  text-align: center;
}

.muted {
  color: var(--kal-muted);
}
</style>
