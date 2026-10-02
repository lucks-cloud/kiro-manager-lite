<script setup lang="ts">
/**
 * 主题风格的三个图标：自动（显示器里一个太阳）、浅色（太阳）、深色（月亮带星）。
 * antd 图标库里没有太阳、月亮，自己画；线条用 currentColor，选中时跟着变主题色。
 */
import type { ThemeMode } from '@shared/types'

defineProps<{ mode: ThemeMode; size?: number }>()
</script>

<template>
  <svg
    :width="size ?? 22"
    :height="size ?? 22"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.6"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <template v-if="mode === 'auto'">
      <rect x="3" y="4" width="18" height="12.5" rx="1.8" />
      <path d="M9 20.5h6M12 16.5v4" />
      <circle cx="12" cy="10.25" r="2" fill="currentColor" stroke="none" />
      <path d="M12 6.6v.9M12 13v.9M8.4 10.25h.9M14.7 10.25h.9M9.6 7.85l.6.6M13.8 12.05l.6.6M14.4 7.85l-.6.6M10.2 12.05l-.6.6" stroke-width="1.2" />
    </template>
    <template v-else-if="mode === 'light'">
      <circle cx="12" cy="12" r="4" fill="currentColor" stroke="none" />
      <path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.55 1.55M17.15 17.15l1.55 1.55M18.7 5.3l-1.55 1.55M6.85 17.15 5.3 18.7" />
    </template>
    <template v-else>
      <path d="M20 14.2A8.2 8.2 0 1 1 9.8 4a6.6 6.6 0 0 0 10.2 10.2Z" fill="currentColor" stroke="none" />
      <path d="M17.2 3.2v2.6M15.9 4.5h2.6" stroke-width="1.4" />
    </template>
  </svg>
</template>
