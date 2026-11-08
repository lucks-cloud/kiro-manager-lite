<script lang="ts">
/** chip 列表：选项来自元数据表，数量由调用方传入已经算好的统计，不为面板单独遍历一遍 */
export function buildChips<K extends string>(
  meta: Record<K, { text: string }>,
  counts: Record<K, number>
): { key: K; label: string; count: number }[] {
  return (Object.keys(meta) as K[]).map((key) => ({
    key,
    label: meta[key].text,
    count: counts[key] || 0
  }))
}

/** 多选 chip 的切换：有就去掉，没有就加上 */
export function toggle<T extends string>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value]
}
</script>

<script setup lang="ts" generic="S extends string">
/**
 * 账号与 API Key 列表共用的筛选面板（chip 带命中计数 + 范围输入）。
 *
 * 两边的差异由调用方传入：状态元数据与各项计数、底部命中文案；
 * 账号多出来的「登录方式」一行通过 extra 插槽放在状态行之后。
 *
 * filter 由调用方传入并直接就地修改：面板本身不持有状态，关掉再打开条件仍在。
 * 外观样式在 assets/styles.css 的 .filter-panel 段。
 */
import { computed } from 'vue'
import DateRangeFilter from '@/components/common/DateRangeFilter.vue'
import { SUBSCRIPTION_META } from '@/utils/format'
import type { SubscriptionType } from '@shared/types'

/** 两边筛选条件里面板会读写的那部分字段 */
interface ItemFilter<K extends string> {
  subscriptions: SubscriptionType[]
  statuses: K[]
  usageMin?: number
  usageMax?: number
  creditMin?: number
  creditMax?: number
  remainingMin?: number
  remainingMax?: number
  daysRemainingMin?: number
  daysRemainingMax?: number
  createdFrom?: number
  createdTo?: number
}

const props = defineProps<{
  filter: ItemFilter<S>
  /** 状态 chip 的选项与文案 */
  statusMeta: Record<S, { text: string }>
  /** 各档位命中数 */
  bySubscription: Record<SubscriptionType, number>
  byStatus: Record<S, number>
  /** 底部的命中文案，如「命中 12 个账号」 */
  matchedText: string
}>()
const emit = defineEmits<{ reset: [] }>()

defineSlots<{
  /** 状态行之后的额外筛选行（账号的「登录方式」） */
  extra?(): unknown
}>()

const filter = computed(() => props.filter)

const subscriptionChips = computed(() =>
  buildChips<SubscriptionType>(SUBSCRIPTION_META, props.bySubscription)
)
const statusChips = computed(() => buildChips<S>(props.statusMeta, props.byStatus))

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
/** 总积分（额度上限）范围，界面与存储同单位，空值收敛成 undefined */
const creditMin = computed<number | null>({
  get: () => filter.value.creditMin ?? null,
  set: (v) => {
    filter.value.creditMin = v == null ? undefined : Math.max(0, v)
  }
})
const creditMax = computed<number | null>({
  get: () => filter.value.creditMax ?? null,
  set: (v) => {
    filter.value.creditMax = v == null ? undefined : Math.max(0, v)
  }
})
/** 剩余积分（总积分 − 已用积分）范围 */
const remainingMin = computed<number | null>({
  get: () => filter.value.remainingMin ?? null,
  set: (v) => {
    filter.value.remainingMin = v == null ? undefined : Math.max(0, v)
  }
})
const remainingMax = computed<number | null>({
  get: () => filter.value.remainingMax ?? null,
  set: (v) => {
    filter.value.remainingMax = v == null ? undefined : Math.max(0, v)
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

function toggleSubscription(value: SubscriptionType): void {
  filter.value.subscriptions = toggle(filter.value.subscriptions, value)
}
function toggleStatus(value: S): void {
  filter.value.statuses = toggle(filter.value.statuses, value)
}

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

    <slot name="extra" />

    <div class="filter-row">
      <span class="filter-label">使用量 (%)</span>
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

    <!-- 按总积分（基础额度 + 奖励额度的上限合计）筛选，不是剩余或已用积分 -->
    <div class="filter-row">
      <span
        class="filter-label"
        title="按总积分筛选：基础额度 + 奖励额度的上限合计，不是剩余积分，也不是已用积分"
      >总积分</span>
      <div class="range">
        <a-input-number
          v-model:value="creditMin"
          :min="0"
          placeholder="min"
          size="small"
          style="width: 88px"
        />
        <span class="muted">-</span>
        <a-input-number
          v-model:value="creditMax"
          :min="0"
          placeholder="max"
          size="small"
          style="width: 88px"
        />
        <span class="muted">积分</span>
      </div>
    </div>

    <!-- 按剩余积分（总积分 − 已用积分）筛选，找还有余量的号用这个 -->
    <div class="filter-row">
      <span class="filter-label" title="按剩余积分筛选：总积分 − 已用积分">剩余积分</span>
      <div class="range">
        <a-input-number
          v-model:value="remainingMin"
          :min="0"
          placeholder="min"
          size="small"
          style="width: 88px"
        />
        <span class="muted">-</span>
        <a-input-number
          v-model:value="remainingMax"
          :min="0"
          placeholder="max"
          size="small"
          style="width: 88px"
        />
        <span class="muted">积分</span>
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
      <span class="muted">{{ props.matchedText }}</span>
      <a-button type="link" size="small" @click="emit('reset')">重置筛选</a-button>
    </div>
  </div>
</template>

<!-- 外观样式在 assets/styles.css 的 .filter-panel 段，账号与 API Key 筛选面板共用 -->
