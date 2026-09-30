<script setup lang="ts">
/**
 * 可操作的文件路径：虚线下划线、悬停高亮，点击弹出「复制路径 / 打开所在目录」。
 *
 * 路径一长，后面再跟两个按钮就会被挤到下一行、和路径错开；收进下拉菜单后一行只剩路径本身。
 * 打开目录由调用方处理（各处走的 IPC 不同，主进程只认目标 + 下标，不接受渲染层传来的任意路径）。
 */
import { CopyOutlined, FolderOpenOutlined } from '@ant-design/icons-vue'
import { copyText } from '@/utils/ui'

const props = defineProps<{ path: string }>()
const emit = defineEmits<{ reveal: [] }>()

function onMenu({ key }: { key: string | number }): void {
  if (key === 'copy') copyText(props.path, '路径已复制')
  else emit('reveal')
}
</script>

<template>
  <a-dropdown :trigger="['click']">
    <a class="path-link mono" role="button" tabindex="0" @click.prevent>{{ props.path }}</a>
    <template #overlay>
      <a-menu @click="onMenu">
        <a-menu-item key="copy">
          <template #icon><CopyOutlined /></template>
          复制路径
        </a-menu-item>
        <a-menu-item key="reveal">
          <template #icon><FolderOpenOutlined /></template>
          打开所在目录
        </a-menu-item>
      </a-menu>
    </template>
  </a-dropdown>
</template>

<style scoped>
/* 与页面里其它可点值（copy-owner）同一套：浅色虚线，悬停变主题色 */
.path-link {
  color: inherit;
  word-break: break-all;
  border-bottom: 1px dashed var(--kal-muted);
  transition: color 0.15s, border-color 0.15s;
}
/*
 * 手型要写死：没有 href 的 <a> 在 Chromium 里默认是文本光标，
 * a-dropdown 包一层后外层样式也可能把它盖掉，所以悬停时再强调一次。
 */
.path-link,
.path-link:hover {
  cursor: pointer !important;
}
.path-link:hover,
.path-link:focus-visible,
.path-link.ant-dropdown-open {
  color: var(--kal-primary);
  border-bottom-color: var(--kal-primary);
  outline: none;
}
</style>
