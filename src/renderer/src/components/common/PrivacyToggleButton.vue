<script setup lang="ts">
/**
 * 列表工具栏上的「隐私打码」开关，账号与 API Key 两页共用。
 * 与设置页的「隐私打码」是同一个开关，这里切换会一起持久化。
 */
import { computed } from 'vue'
import { EyeInvisibleOutlined, EyeOutlined } from '@ant-design/icons-vue'
import { useSettingsStore } from '@/stores/settings'

defineProps<{ size?: 'small' | 'middle' | 'large' }>()

const settingsStore = useSettingsStore()
const privacyMode = computed(() => settingsStore.settings.privacyMode)

function togglePrivacy(): void {
  void settingsStore.update({ privacyMode: !privacyMode.value })
}
</script>

<template>
  <a-button :size="size" :type="privacyMode ? 'primary' : 'default'" @click="togglePrivacy">
    <template #icon>
      <EyeInvisibleOutlined v-if="privacyMode" />
      <EyeOutlined v-else />
    </template>
    {{ privacyMode ? '隐私打码中' : '隐私打码' }}
  </a-button>
</template>
