<script setup lang="ts">
/**
 * 分组面板：挂在列表工具栏「分组」按钮的浮层里。
 * 既是分组管理入口（新建 / 改名 / 删除 / 拖动排序），也是按分组筛选的开关。
 *
 * 账号列表与 API Key 列表共用这一份：读写全部走 GroupApi 门面，
 * 筛选条件由各自的页面持有（两边一个在 store、一个在页面本地），所以用 props / emits 传。
 */
import { computed, ref } from 'vue'
import { message } from 'ant-design-vue'
import { PlusOutlined } from '@ant-design/icons-vue'
import GroupGrid from '@/components/common/GroupGrid.vue'
import { confirmDelete } from '@/utils/ui'
import { UNGROUPED } from '@/utils/groups'
import type { GroupApi } from '@/utils/groupApi'
import type { AccountGroup } from '@shared/types'

const props = defineProps<{
  api: GroupApi
  /** 当前参与筛选的分组 id（含 UNGROUPED） */
  selected: string[]
  /** 命中条数，显示在底部 */
  matched: number
  /** 条目名称，用于文案：账号 / Key */
  entity: string
}>()

const emit = defineEmits<{
  /** 点某个分组：由调用方切换它在筛选里的选中态 */
  toggle: [id: string]
  clear: []
  /** 面板里开着弹窗 / 确认框时置位，外层据此按住 popover 不让它收起 */
  busy: [boolean]
}>()

const newName = ref('')
const saving = ref(false)
/** 正在改名的分组；非空即打开改名弹窗 */
const renaming = ref<AccountGroup | null>(null)
const renameValue = ref('')

const groups = computed(() => props.api.groups)
const counts = computed(() => props.api.counts)
const ungroupedCount = computed(() => counts.value[UNGROUPED] ?? 0)

async function submitNew(): Promise<void> {
  const name = newName.value.trim()
  if (!name || saving.value) return
  saving.value = true
  try {
    const res = await props.api.add(name)
    if (res.error) return void message.error(res.error)
    newName.value = ''
    // 同名会复用已有分组，这时提示一下，否则用户以为没建成功
    message.success(
      res.created ? `已添加分组「${res.group?.name}」` : `分组「${res.group?.name}」已存在`
    )
  } finally {
    saving.value = false
  }
}

function openRename(group: AccountGroup): void {
  renaming.value = group
  renameValue.value = group.name
  emit('busy', true)
}

function closeRename(): void {
  renaming.value = null
  emit('busy', false)
}

async function submitRename(): Promise<void> {
  const target = renaming.value
  if (!target) return
  const error = await props.api.rename(target.id, renameValue.value)
  if (error) return void message.error(error)
  closeRename()
  message.success('已修改分组名称')
}

function remove(group: AccountGroup): void {
  const count = counts.value[group.id] ?? 0
  emit('busy', true)
  confirmDelete({
    title: '删除分组',
    content: count
      ? `确认删除分组「${group.name}」？其下 ${count} 个${props.entity}会变为未分组，${props.entity}本身不会被删除。`
      : `确认删除分组「${group.name}」？`,
    onOk: async () => {
      const error = await props.api.remove(group.id)
      if (error) message.error(error)
    },
    afterClose: () => emit('busy', false)
  })
}

async function reorder(orderedIds: string[]): Promise<void> {
  const error = await props.api.reorder(orderedIds)
  if (error) message.error(error)
}
</script>

<template>
  <div class="group-panel">
    <!-- 输入框与按钮做成一组；不写 size，跟随全局组件尺寸设置（默认 / 大尺寸） -->
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

    <div v-if="groups.length" class="panel-hint muted">
      点击分组按其筛选，长按可拖动排序，右侧三点可改名 / 删除
    </div>

    <GroupGrid
      v-if="groups.length"
      :groups="groups"
      :selected="props.selected"
      :counts="counts"
      multiple
      @select="(id) => emit('toggle', id)"
      @rename="openRename"
      @remove="remove"
      @reorder="reorder"
    />
    <div v-else class="panel-empty muted">还没有分组，先在上面新建一个</div>

    <!-- 未分组单独一行：它不是真实分组，不能改名删除，但要能参与筛选 -->
    <button
      class="ungrouped"
      :class="{ on: props.selected.includes(UNGROUPED) }"
      @click="emit('toggle', UNGROUPED)"
    >
      未分组<span class="muted">（{{ ungroupedCount }}）</span>
    </button>

    <div class="panel-footer">
      <span class="muted">命中 {{ props.matched }} 个{{ props.entity }}</span>
      <a-button type="link" size="small" :disabled="!props.selected.length" @click="emit('clear')">
        清除分组筛选
      </a-button>
    </div>

    <a-modal
      v-if="renaming"
      :open="true"
      title="编辑分组名称"
      centered
      width="420px"
      ok-text="保存"
      cancel-text="取消"
      @ok="submitRename"
      @cancel="closeRename"
    >
      <a-input
        v-model:value="renameValue"
        placeholder="分组名称"
        :maxlength="30"
        allow-clear
        @press-enter="submitRename"
      />
    </a-modal>
  </div>
</template>

<style scoped>
.group-panel {
  display: flex;
  flex-direction: column;
  gap: 10px;
  /* 一排两个分组 + 计数 + 三点，340 太挤，名字很容易被截断 */
  width: 460px;
}

/* 输入框吃掉剩余宽度，按钮按内容宽 */
.panel-add :deep(.ant-input-affix-wrapper),
.panel-add :deep(.ant-input) {
  flex: 1;
  min-width: 0;
}

.panel-hint,
.panel-empty {
  font-size: 12px;
  line-height: 1.5;
}

.panel-empty {
  padding: 10px 0;
  text-align: center;
}

.ungrouped {
  padding: 7px 10px;
  border: 1px dashed var(--kal-border);
  border-radius: 8px;
  background: transparent;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
  transition: border-color 0.15s ease, background 0.15s ease;
}

.ungrouped:hover {
  border-color: var(--kal-primary);
}

.ungrouped.on {
  border-style: solid;
  border-color: var(--kal-primary);
  background: var(--kal-block-bg);
}

.panel-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-top: 4px;
  border-top: 1px solid var(--kal-border);
}

.muted {
  color: var(--kal-muted);
}
</style>
