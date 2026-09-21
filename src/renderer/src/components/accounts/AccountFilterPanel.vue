<script setup lang="ts">
import { computed } from 'vue'
import DateRangeFilter from '@/components/common/DateRangeFilter.vue'
import { useAccountsStore } from '@/stores/accounts'
import { IDP_META, STATUS_META, SUBSCRIPTION_META } from '@/utils/format'
import type { AccountStatus, IdpType, SubscriptionType } from '@shared/types'

const accountsStore = useAccountsStore()

const filter = computed(() => accountsStore.filter)

/**
 * chip 列表：选项来自元数据表，数量直接复用 store 里已经算好的 stats，
 * 不再为筛选面板单独遍历一遍账号。
 */
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
  buildChips<SubscriptionType>(SUBSCRIPTION_META, accountsStore.stats.bySubscription)
)
const statusChips = computed(() =>
  buildChips<AccountStatus>(STATUS_META, accountsStore.stats.byStatus)
)
const idpChips = computed(() => buildChips<IdpType>(IDP_META, accountsStore.stats.byIdp))

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

function toggle<T extends string>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value]
}

function toggleSubscription(value: SubscriptionType): void {
  filter.value.subscriptions = toggle(filter.value.subscriptions, value)
}
function toggleStatus(value: AccountStatus): void {
  filter.value.statuses = toggle(filter.value.statuses, value)
}
function toggleIdp(value: IdpType): void {
  filter.value.idps = toggle(filter.value.idps, value)
}

/** 导入时间范围：控件给的是精确到秒的时间戳，这里只负责写回筛选条件 */
function setCreated(from: number | undefined, to: number | undefined): void {
  filter.value.createdFrom = from
  filter.value.createdTo = to
}

function reset(): void {
  accountsStore.applyFilter({ search: filter.value.search })
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
      <span class="filter-label">登录方式</span>
      <div class="chips">
        <button
          v-for="item in idpChips"
          :key="item.key"
          class="chip"
          :class="{ on: filter.idps.includes(item.key), empty: !item.count }"
          @click="toggleIdp(item.key)"
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
      <span class="muted">命中 {{ accountsStore.filtered.length }} 个账号</span>
      <a-button type="link" size="small" @click="reset">重置筛选</a-button>
    </div>
  </div>
</template>

<!-- 外观样式在 assets/styles.css 的 .filter-panel 段，与 API Key 筛选面板共用 -->
