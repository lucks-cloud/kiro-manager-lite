<script setup lang="ts">
/**
 * API Key 列表的筛选面板。
 *
 * 与账号管理的筛选面板同构（chip 带命中计数 + 范围输入），外观样式共用
 * assets/styles.css 里的 .filter-panel 段。维度上没有「登录方式」——
 * API Key 不涉及登录，取而代之的是额度重置剩余天数。
 *
 * filter 由父级传入并直接就地修改：面板本身不持有状态，关掉再打开条件仍在。
 */
import { computed } from 'vue'
import DateRangeFilter from '@/components/common/DateRangeFilter.vue'
import { KEY_STATUS_META, SUBSCRIPTION_META } from '@/utils/format'
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

const filter = computed(() => props.filter)

function buildChips<K extends string>(
  meta: Record<K, { text: string }>,
  counts: Record<K, number>
): { key: K; label: string; count: number }[] {
  return (Object.keys(meta) as K[]).map((key) => ({
    key,
    label: meta[key].text,
    count: counts[key] || 0
  }))
}

const subscriptionChips = computed(() =>
  buildChips<SubscriptionType>(SUBSCRIPTION_META, props.bySubscription)
)
const statusChips = computed(() => buildChips<KeyStatus>(KEY_STATUS_META, props.byStatus))

function toggle<T extends string>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value]
}

function toggleSubscription(value: SubscriptionType): void {
  filter.value.subscriptions = toggle(filter.value.subscriptions, value)
}
function toggleStatus(value: KeyStatus): void {
  filter.value.statuses = toggle(filter.value.statuses, value)
}

/**
 * 数字输入框都要经过中转再写进筛选条件。
 *
 * a-input-number 在内容被删空时给过来的是 null，直接写进 filter 会让「是否已设置」
 * 判断为真（null !== undefined），比较时 null 又被转成 0，列表就被筛成空了。
 * 这里统一收敛成 undefined，界面侧用 null 表示空值。
 */

/** 百分比在界面上按 0-100 展示，存储里是 0-1 */
const usageMinPercent = computed<number | null>({
  get: () => (filter.value.usageMin == null ? null : Math.round(filter.value.usageMin * 100)),
  set: (v) => {
    filter.value.usageMin = v == null ? undefined : Math.max(0, Math.min(100, v)) / 100
  }
})
const usageMaxPercent = computed<number | null>({
  get: () => (filter.value.usageMax == null ? null : Math.round(filter.value.usageMax * 100)),
  set: (v) => {
    filter.value.usageMax = v == null ? undefined : Math.max(0, Math.min(100, v)) / 100
  }
})
const daysRemainingMin = computed<number | null>({
  get: () => filter.value.daysRemainingMin ?? null,
  set: (v) => {
    filter.value.daysRemainingMin = v == null ? undefined : Math.max(0, v)
  }
})
const daysRemainingMax = computed<number | null>({
  get: () => filter.value.daysRemainingMax ?? null,
  set: (v) => {
    filter.value.daysRemainingMax = v == null ? undefined : Math.max(0, v)
  }
})

/** 导入时间范围：控件给的是精确到秒的时间戳，这里只负责写回筛选条件 */
function setCreated(from: number | undefined, to: number | undefined): void {
  filter.value.createdFrom = from
  filter.value.createdTo = to
}
</script>

<template>
  <div class="filter-panel">
    <div class="filter-row">
      <span class="filter-label">订阅</span>
      <div class="chips">
        <button
          v-for="item in subscriptionChips"
          :key="item.key"
          class="chip"
          :class="{ on: filter.subscriptions.includes(item.key), empty: !item.count }"
          @click="toggleSubscription(item.key)"
        >
          {{ item.label }}<span class="chip-count">({{ item.count }})</span>
        </button>
      </div>
    </div>

    <div class="filter-row">
      <span class="filter-label">状态</span>
      <div class="chips">
        <button
          v-for="item in statusChips"
          :key="item.key"
          class="chip"
          :class="{ on: filter.statuses.includes(item.key), empty: !item.count }"
          @click="toggleStatus(item.key)"
        >
          {{ item.label }}<span class="chip-count">({{ item.count }})</span>
        </button>
      </div>
    </div>

    <div class="filter-row">
      <span class="filter-label">使用量</span>
      <div class="range">
        <a-input-number
          v-model:value="usageMinPercent"
          :min="0"
          :max="100"
          placeholder="min"
          size="small"
          style="width: 88px"
        />
        <span class="muted">-</span>
        <a-input-number
          v-model:value="usageMaxPercent"
          :min="0"
          :max="100"
          placeholder="max"
          size="small"
          style="width: 88px"
        />
        <span class="muted">%</span>
      </div>
    </div>

    <div class="filter-row">
      <span class="filter-label">重置剩余</span>
      <div class="range">
        <a-input-number
          v-model:value="daysRemainingMin"
          :min="0"
          placeholder="min"
          size="small"
          style="width: 88px"
        />
        <span class="muted">-</span>
        <a-input-number
          v-model:value="daysRemainingMax"
          :min="0"
          placeholder="max"
          size="small"
          style="width: 88px"
        />
        <span class="muted">天</span>
      </div>
    </div>

    <div class="filter-row">
      <span class="filter-label">导入时间</span>
      <div class="range grow">
        <DateRangeFilter :from="filter.createdFrom" :to="filter.createdTo" @change="setCreated" />
      </div>
    </div>

    <div class="filter-footer">
      <span class="muted">命中 {{ props.matched }} 个 API Key</span>
      <a-button type="link" size="small" @click="emit('reset')">重置筛选</a-button>
    </div>
  </div>
</template>

<!-- 外观样式在 assets/styles.css 的 .filter-panel 段，与账号筛选面板共用 -->
