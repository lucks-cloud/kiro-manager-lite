<script lang="ts">
export interface QuotaStats {
  totalLimit: number
  totalUsed: number
  /** Σ max(0, 额度 − 已用) */
  available: number
  /** 已用超出各自额度的部分合计，仅用于提示 */
  excess: number
  /** 0..100 */
  percentUsed: number
  /** 已用超过当前额度的条目数，多半是降过档 */
  overQuotaCount: number
  /** 参与统计的条目数 */
  validCount: number
}

/**
 * 汇总一批「额度 / 已用」。
 *
 * 可用额度必须**逐条先 clamp 再求和**，不能用「总额度 − 总已用」：
 * 降档后 limit 会跟着变小（比如原本 2000 的号用掉 1900，之后掉成 50 积分的普通号），
 * 这一条就贡献 −1850，直接把汇总值拖成负数——而实际上它的可用额度是 0，不是负的。
 * 同理进度按 min(已用, 额度) 累加，percentUsed 天然落在 0~100，不会出现「已超额」的假象。
 * 额度为 0 的条目不计入。
 */
export function sumQuota(items: Iterable<{ limit: number; used: number }>): QuotaStats {
  let totalLimit = 0
  let totalUsed = 0
  let effectiveUsed = 0
  let available = 0
  let overQuotaCount = 0
  let validCount = 0
  for (const { limit, used } of items) {
    if (!(limit > 0)) continue
    totalLimit += limit
    totalUsed += used
    effectiveUsed += Math.min(used, limit)
    available += Math.max(0, limit - used)
    if (used > limit) overQuotaCount++
    validCount++
  }
  return {
    totalLimit,
    totalUsed,
    available,
    excess: totalUsed - effectiveUsed,
    percentUsed: totalLimit > 0 ? (effectiveUsed / totalLimit) * 100 : 0,
    overQuotaCount,
    validCount
  }
}
</script>

<script setup lang="ts">
/** 首页额度统计卡：账号与 API Key 各用一张，左右排列 */
import { computed, type Component } from 'vue'
import {
  BarChartOutlined,
  LineChartOutlined,
  RiseOutlined,
  ThunderboltOutlined
} from '@ant-design/icons-vue'
import { Empty } from 'ant-design-vue'
import { formatCreditsGrouped } from '@/utils/format'

const simpleImage = Empty.PRESENTED_IMAGE_SIMPLE

const props = defineProps<{
  title: string
  icon: Component
  /** 标题图标的颜色 */
  color: string
  /** 「个有效账号」「个有效 API Key」里的名词 */
  noun: string
  stats: QuotaStats
  precision: boolean
}>()

/** 可用额度见底时标红 */
const noQuotaLeft = computed(() => props.stats.validCount > 0 && props.stats.available <= 0)

/** 使用率文案：开启两位小数时保留 2 位，否则 1 位 */
const percentText = computed(() => props.stats.percentUsed.toFixed(props.precision ? 2 : 1))

const barColor = computed(() => {
  const p = props.stats.percentUsed
  if (p > 100) return '#f5222d'
  if (p >= 80) return '#fa8c16'
  if (p >= 50) return '#fadb14'
  return '#52c41a'
})
</script>

<template>
  <a-card size="small" class="section-card quota-card">
    <template #title>
      <span class="card-title">
        <span class="icon-box sm" :style="{ background: `${color}1f`, color }">
          <component :is="icon" />
        </span>
        {{ title }}
        <span class="muted title-hint">基于 {{ stats.validCount }} 个有效{{ noun }}</span>
      </span>
    </template>

    <template v-if="stats.validCount">
      <div class="tile-grid">
        <div class="tile">
          <div class="tile-head muted"><RiseOutlined style="color: #1677ff" /> 总额度</div>
          <div class="tile-value">{{ formatCreditsGrouped(stats.totalLimit) }}</div>
        </div>
        <div class="tile">
          <div class="tile-head muted"><LineChartOutlined style="color: #fa8c16" /> 已使用</div>
          <div class="tile-value">{{ formatCreditsGrouped(stats.totalUsed, precision) }}</div>
        </div>
        <div class="tile">
          <div class="tile-head muted"><ThunderboltOutlined style="color: #52c41a" /> 可用额度</div>
          <div class="tile-value" :style="{ color: noQuotaLeft ? '#ff4d4f' : '#52c41a' }">
            {{ formatCreditsGrouped(stats.available, precision) }}
          </div>
        </div>
        <div class="tile">
          <div class="tile-head muted"><BarChartOutlined style="color: #722ed1" /> 使用率</div>
          <div class="tile-value">{{ percentText }}%</div>
        </div>
      </div>

      <div class="progress-head">
        <span class="muted">总体使用进度</span>
        <span class="progress-meta">
          <span class="muted">
            {{ formatCreditsGrouped(stats.totalUsed, precision) }} /
            {{ formatCreditsGrouped(stats.totalLimit) }}
          </span>
          <span class="percent-pill" :style="{ background: `${barColor}26`, color: barColor }">
            {{ percentText }}%
          </span>
        </span>
      </div>
      <a-progress :percent="stats.percentUsed" :stroke-color="barColor" :show-info="false" :stroke-width="10" />
      <!--
        降档提示：已用量超过当前额度不是「超额消费」，而是额度变小了
        （原本高档位用掉的积分，掉档后比新额度还多）。这类条目可用额度按 0 计。
      -->
      <a-alert
        v-if="stats.overQuotaCount"
        type="warning"
        show-icon
        style="margin-top: 8px"
        :message="`${stats.overQuotaCount} 个${noun}的已用积分超过当前额度（合计 ${formatCreditsGrouped(stats.excess, precision)}），多为订阅降档所致，其可用额度按 0 计算`"
      />
    </template>
    <a-empty v-else :image="simpleImage" :description="`暂无有额度的${noun}`" class="quota-empty" />
  </a-card>
</template>

<style scoped>
.quota-card { height: 100%; }
/* 标题栏间距与首页其它分区卡一致 */
.section-card :deep(.ant-card-head) { min-height: 52px; padding-top: 10px; padding-bottom: 10px; }
.section-card :deep(.ant-card-body) { padding-top: 16px; }
.card-title { display: flex; align-items: center; gap: 8px; font-weight: 600; }
.title-hint { font-size: 12px; font-weight: 400; }
.icon-box {
  flex: 0 0 auto;
  width: 26px;
  height: 26px;
  border-radius: 8px;
  display: grid;
  place-items: center;
  font-size: 14px;
}
/*
 * 四格只有两种排法：一排四个，或两排各两个，不会出现 3 + 1 的断行。
 * 按卡片自身宽度判断（容器查询），而不是窗口宽度：两张并排、上下排列时卡片宽度差很多。
 */
.quota-card :deep(.ant-card-body) { container-type: inline-size; }
.tile-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
  margin-bottom: 16px;
}
@container (min-width: 715px) {
  .tile-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); }
}
.tile { padding: 10px 12px; border-radius: 10px; background: var(--kal-code-bg); }
.tile-head { display: flex; align-items: center; gap: 6px; font-size: 12px; margin-bottom: 4px; }
.tile-value { font-size: 18px; font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.progress-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 12px;
  margin-bottom: 2px;
}
.progress-meta { display: inline-flex; align-items: center; gap: 8px; }
.percent-pill { padding: 1px 8px; border-radius: 6px; font-weight: 700; }
.quota-empty { margin: 24px 0; }
</style>
