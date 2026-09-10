<script setup lang="ts">
/**
 * 批量设置备注：覆盖式改写所选条目的备注，留空即清空。
 *
 * 账号列表与 API Key 列表共用这一份。落盘方式两边不同（一个同步写、一个走 IPC），
 * 所以这里只负责收集输入并 emit，具体怎么存、提示什么由调用方决定。
 */
import { ref } from 'vue'
import { message } from 'ant-design-vue'

const props = defineProps<{
  ids: string[]
  /** 条目名称，用于文案：账号 / Key */
  entity: string
  /** 输入框占位示例 */
  placeholder?: string
  /** 调用方正在保存 */
  saving?: boolean
}>()

const emit = defineEmits<{ submit: [note: string]; close: [] }>()

const note = ref('')

function submit(): void {
  if (!props.ids.length) return void message.info(`没有选中的${props.entity}`)
  emit('submit', note.value)
}
</script>

<template>
  <a-modal
    :open="true"
    title="批量设置备注"
    centered
    width="520px"
    ok-text="保存"
    cancel-text="取消"
    :confirm-loading="props.saving"
    @ok="submit"
    @cancel="emit('close')"
  >
    <p class="muted tip">
      将覆盖所选 {{ props.ids.length }} 个{{ props.entity }}的备注；留空则清空这些{{
        props.entity
      }}的备注。
    </p>
    <a-textarea
      v-model:value="note"
      :rows="3"
      :placeholder="props.placeholder ?? '例如：主力号 / 待观察 / 某渠道'"
      allow-clear
      @press-enter="submit"
    />
  </a-modal>
</template>

<style scoped>
.tip {
  margin: 0 0 12px;
  font-size: 12px;
}

.muted {
  color: var(--kal-muted);
}
</style>
