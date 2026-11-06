<script setup lang="ts">
/**
 * 账号列表的筛选面板：公共部分在 ItemFilterPanel，这里接上账号 store，
 * 并在状态行之后补一行 API Key 没有的「登录方式」。
 */
import { computed } from 'vue'
import ItemFilterPanel, { buildChips, toggle } from '@/components/common/ItemFilterPanel.vue'
import { useAccountsStore } from '@/stores/accounts'
import { IDP_META, STATUS_META } from '@/utils/format'
import type { IdpType } from '@shared/types'

const accountsStore = useAccountsStore()

const filter = computed(() => accountsStore.filter)

/**
 * chip 列表：选项来自元数据表，数量直接复用 store 里已经算好的 stats，
 * 不为筛选面板单独遍历一遍账号。
 */
const idpChips = computed(() => buildChips<IdpType>(IDP_META, accountsStore.stats.byIdp))

function toggleIdp(value: IdpType): void {
  filter.value.idps = toggle(filter.value.idps, value)
}

function reset(): void {
  accountsStore.applyFilter({ search: filter.value.search })
}
</script>

<template>
  <ItemFilterPanel
    :filter="filter"
    :status-meta="STATUS_META"
    :by-subscription="accountsStore.stats.bySubscription"
    :by-status="accountsStore.stats.byStatus"
    :matched-text="`命中 ${accountsStore.filtered.length} 个账号`"
    @reset="reset"
  >
    <template #extra>
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
    </template>
  </ItemFilterPanel>
</template>

<!-- 外观样式在 assets/styles.css 的 .filter-panel 段，与 API Key 筛选面板共用 -->
