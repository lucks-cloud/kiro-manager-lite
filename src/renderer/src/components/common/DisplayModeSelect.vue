<script setup lang="ts">
/**
 * 展示形态下拉：卡片 / 卡片紧凑 / 列表。
 * 账号列表与 API Key 列表共用，两边各自持久化一份取值。
 */
import { computed, type Component } from 'vue'
import {
  AppstoreOutlined,
  BorderlessTableOutlined,
  DownOutlined,
  UnorderedListOutlined
} from '@ant-design/icons-vue'
import type { AccountDisplayMode } from '@shared/types'

const props = defineProps<{ value: AccountDisplayMode }>()
const emit = defineEmits<{ change: [mode: AccountDisplayMode] }>()

const options: { value: AccountDisplayMode; label: string; icon: Component }[] = [
  { value: 'card', label: '卡片模式', icon: AppstoreOutlined },
  { value: 'compact', label: '卡片紧凑模式', icon: BorderlessTableOutlined },
  { value: 'list', label: '列表模式', icon: UnorderedListOutlined }
]

const current = computed(() => options.find((item) => item.value === props.value) ?? options[0])

function pick(mode: AccountDisplayMode): void {
  if (mode !== props.value) emit('change', mode)
}
</script>

<template>
  <a-dropdown>
    <a-button size="small">
      <template #icon><component :is="current.icon" /></template>
      {{ current.label }}
      <DownOutlined />
    </a-button>
    <template #overlay>
      <a-menu :selected-keys="[props.value]">
        <a-menu-item v-for="item in options" :key="item.value" @click="pick(item.value)">
          <component :is="item.icon" />
          {{ item.label }}
        </a-menu-item>
      </a-menu>
    </template>
  </a-dropdown>
</template>
