<script setup lang="ts">
/**
 * API Key 列表的筛选面板。
 *
 * 与账号管理的筛选面板同构（chip 带命中计数 + 范围输入），公共部分在 ItemFilterPanel，
 * 外观样式共用 assets/styles.css 里的 .filter-panel 段。维度上没有「登录方式」——
 * API Key 不涉及登录，取而代之的是额度重置剩余天数。
 *
 * filter 由父级传入并直接就地修改：面板本身不持有状态，关掉再打开条件仍在。
 */
import ItemFilterPanel from '@/components/common/ItemFilterPanel.vue'
import { KEY_STATUS_META } from '@/utils/format'
import type { KeyFilter, KeyStatus, SubscriptionType } from '@shared/types'

const props = defineProps<{
  filter: KeyFilter
  /** 各档位命中数，由父级按当前全部 Key 统计 */
  bySubscription: Record<SubscriptionType, number>
  byStatus: Record<KeyStatus, number>
  /** 当前条件命中的 Key 数，展示在底部 */
  matched: number
}>()
const emit = defineEmits<{ reset: [] }>()
</script>

<template>
  <ItemFilterPanel
    :filter="props.filter"
    :status-meta="KEY_STATUS_META"
    :by-subscription="props.bySubscription"
    :by-status="props.byStatus"
    :matched-text="`命中 ${props.matched} 个 API Key`"
    @reset="emit('reset')"
  />
</template>

<!-- 外观样式在 assets/styles.css 的 .filter-panel 段，与账号筛选面板共用 -->
