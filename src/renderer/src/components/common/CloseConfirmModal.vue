<script setup lang="ts">
/**
 * 点窗口关闭按钮、且「关闭按钮行为」为「每次询问」时的确认框。
 *
 * 主进程拦下 close 后发 app:confirm-close 过来，这里选完再把结果交回去（closeWindowChoice），
 * 由主进程执行最小化到托盘或退出。取消、按 Esc、点蒙层都等于不关。
 */
import { onMounted, onUnmounted, ref } from 'vue'

const open = ref(false)
let off: (() => void) | undefined

onMounted(() => {
  off = window.api.onConfirmClose(() => (open.value = true))
})
onUnmounted(() => off?.())

function choose(choice: 'minimize' | 'quit' | 'cancel'): void {
  open.value = false
  void window.api.closeWindowChoice(choice)
}
</script>

<template>
  <a-modal
    :open="open"
    title="关闭窗口"
    centered
    :width="420"
    @cancel="choose('cancel')"
  >
    <p class="close-question">关闭窗口后要如何处理？</p>
    <p class="close-hint">可以在「设置 - 系统托盘」里固定这个行为，不再每次询问。</p>
    <template #footer>
      <a-button @click="choose('cancel')">取消</a-button>
      <a-button type="primary" danger @click="choose('quit')">退出程序</a-button>
      <a-button type="primary" @click="choose('minimize')">最小化到托盘</a-button>
    </template>
  </a-modal>
</template>

<style scoped>
.close-question {
  margin: 0 0 6px;
}

.close-hint {
  margin: 0;
  font-size: 12px;
  color: var(--kal-muted);
}
</style>
