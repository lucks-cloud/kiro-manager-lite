<script setup lang="ts">
import { computed } from 'vue'
import { AWS_REGION_GROUPS, DEFAULT_REGION, isKnownRegion } from '@shared/regions'

const props = withDefaults(
  defineProps<{
    value?: string
    disabled?: boolean
  }>(),
  { value: DEFAULT_REGION, disabled: false }
)

const emit = defineEmits<{ 'update:value': [string] }>()

const CUSTOM = '__custom__'

/** 预设分组 + 末尾一个「自定义」占位 */
const selectOptions = computed(() => [
  ...AWS_REGION_GROUPS.map((group) => ({ label: group.label, options: group.options })),
  { label: '自定义', options: [{ value: CUSTOM, label: '-- 自定义 --' }] }
])

/** 值不在预设内时，下拉停在「自定义」，实际值由右侧输入框展示 */
const selectValue = computed(() => (isKnownRegion(props.value) ? props.value : CUSTOM))

function onSelect(value: unknown): void {
  if (value !== CUSTOM) emit('update:value', String(value))
}

function onInput(value: unknown): void {
  emit('update:value', String(value ?? '').trim())
}
</script>

<template>
  <div class="region-select">
    <a-select
      :value="selectValue"
      :options="selectOptions"
      :disabled="props.disabled"
      class="region-preset"
      @change="onSelect"
    />
    <a-input
      :value="props.value"
      :disabled="props.disabled"
      placeholder="自定义区域，如 cn-north-1"
      class="region-custom"
      @update:value="onInput"
    />
  </div>
</template>

<style scoped>
/*
 * 两个控件并排，容器过窄时整体换行而不是互相挤压。
 * 自定义输入框不能定死 160px 且不许收缩，否则放进窄栅格列里会把下拉压成几像素宽。
 */
.region-select {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.region-preset {
  flex: 1 1 200px;
  min-width: 0;
}

.region-custom {
  flex: 0 1 160px;
  min-width: 140px;
}
</style>
