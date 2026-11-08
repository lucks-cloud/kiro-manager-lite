<script lang="ts">
export interface HomeCardTag {
  text: string
  color: string
  /** 右上角那组标签带描边，与账号卡片一致 */
  bordered?: boolean
  title?: string
}

export interface HomeCardData {
  /** 第一行：邮箱或 Key */
  primary: string
  /** 第二行：昵称或邮箱，没有就不显示 */
  secondary?: string
  /** 第三行：备注（已按打码设置处理），空串显示 - */
  note: string
  /** 右上角：使用中、状态 */
  headTags: HomeCardTag[]
  /** 标签行：订阅、登录方式、分组 */
  tags: HomeCardTag[]
  /** 0..1 */
  ratio: number
  /** 已用 / 总额 */
  usageText: string
  /** 用量更新时间 */
  updatedText: string
  updatedTitle?: string
  /** 底部左侧，如 Token 25 分钟 */
  footText: string
  footWarn?: boolean
  /** 底部右侧，如订阅剩余天数 */
  footExtra?: string
  /** 卡片边框色：IDE 绿、CLI 蓝、网关紫，与列表里「使用中」的边框一致 */
  borderColor: string
  /** 报错原因，有就显示一条红色提示 */
  error?: string
}
</script>

<script setup lang="ts">
/**
 * 首页「当前使用」的一张卡片，复刻账户管理「卡片紧凑」模式的样式：
 * 头部（邮箱 / 昵称 / 备注 + 使用中与状态标签）、标签行、压成两行的分段用量条、底部 Token。
 * 首页只读，不带勾选框和动作按钮；点整卡打开对应的详情抽屉。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { ClockCircleOutlined } from '@ant-design/icons-vue'
import { Empty } from 'ant-design-vue'
import { usageColor } from '@/utils/format'

const props = defineProps<{
  /** 来源，如 Kiro IDE；空状态时显示，也用作悬停提示 */
  title: string
  data: HomeCardData | null
  empty: string
  emptyAction?: string
}>()

const emit = defineEmits<{ open: []; empty: [] }>()

const simpleImage = Empty.PRESENTED_IMAGE_SIMPLE

/*
 * 用量条格子数随实际宽度变化：固定根数时，大窗口每格被拉得很宽，小窗口又细成一条线。
 * 按「每格约 6px + 2px 间距」换算根数，夹在 16 ~ 80 之间；
 * 只在宽度真的变到要增减格子时才更新，拖动窗口时不会每帧重渲染。
 */
const BAR_WIDTH = 6
const BAR_GAP = 2
const MIN_BARS = 16
const MAX_BARS = 80
const barsEl = ref<HTMLElement | null>(null)
const barCount = ref(40)
let observer: ResizeObserver | null = null

function measure(width: number): void {
  const next = Math.min(MAX_BARS, Math.max(MIN_BARS, Math.floor((width + BAR_GAP) / (BAR_WIDTH + BAR_GAP))))
  if (next !== barCount.value) barCount.value = next
}

// 空状态 ↔ 有数据切换时用量条会挂上或卸下，跟着重新观察
watch(barsEl, (el, _old, onCleanup) => {
  if (!el) return
  measure(el.clientWidth)
  observer = new ResizeObserver((entries) => measure(entries[0].contentRect.width))
  observer.observe(el)
  onCleanup(() => {
    observer?.disconnect()
    observer = null
  })
})
onBeforeUnmount(() => observer?.disconnect())

const ratio = computed(() => Math.min(1, Math.max(0, props.data?.ratio ?? 0)))
/** 与账号卡片同一口径：0 和 100 取整，其间保留两位小数 */
const percentText = computed(() => {
  const v = ratio.value * 100
  if (v <= 0) return '0'
  if (v >= 100) return '100'
  return v.toFixed(2)
})
const filledBars = computed(() => Math.round(ratio.value * barCount.value))
const barColor = computed(() => usageColor(ratio.value))

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault()
    emit('open')
  }
}
</script>

<template>
  <div
    v-if="data"
    class="home-card"
    :style="{ borderColor: data.borderColor }"
    role="button"
    tabindex="0"
    :title="`查看${title}详情`"
    @click="emit('open')"
    @keydown="onKey"
  >
    <div class="card-head">
      <div class="identity">
        <span class="primary">{{ data.primary }}</span>
        <span v-if="data.secondary" class="secondary">{{ data.secondary }}</span>
        <span class="note">备注：{{ data.note || '-' }}</span>
      </div>
      <a-tag
        v-for="(t, i) in data.headTags"
        :key="i"
        :color="t.color"
        class="head-tag"
      >{{ t.text }}</a-tag>
    </div>

    <div class="tag-row">
      <a-tag
        v-for="(t, i) in data.tags"
        :key="i"
        :color="t.color"
        :bordered="false"
        :title="t.title"
      >{{ t.text }}</a-tag>
    </div>

    <div class="usage-block" :title="data.updatedTitle">
      <div ref="barsEl" class="usage-bars" :style="{ '--bar-on': barColor }">
        <span v-for="i in barCount" :key="i" class="bar" :class="{ on: i <= filledBars }" />
      </div>
      <strong class="usage-percent" :style="{ color: barColor }">
        {{ percentText }}<small>%</small>
      </strong>
      <div class="usage-foot">
        <span class="usage-number">{{ data.usageText }}</span>
        <span class="muted"><ClockCircleOutlined /> {{ data.updatedText }}</span>
      </div>
    </div>

    <div v-if="data.error" class="error-line" :title="data.error">{{ data.error }}</div>

    <div class="card-foot">
      <span :class="data.footWarn ? 'warn' : 'muted'">
        <ClockCircleOutlined /> {{ data.footText }}
      </span>
      <span v-if="data.footExtra" class="muted">{{ data.footExtra }}</span>
    </div>
  </div>

  <div v-else class="home-card is-empty">
    <div class="empty-title muted">{{ title }}</div>
    <a-empty :image="simpleImage" :description="empty" class="card-empty">
      <a-button v-if="emptyAction" size="small" type="primary" @click="emit('empty')">
        {{ emptyAction }}
      </a-button>
    </a-empty>
  </div>
</template>

<style scoped>
/* 尺寸、圆角、间距与 AccountCard 的 mode-compact 保持一致 */
.home-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  height: 100%;
  padding: 16px 16px 8px;
  border: 1px solid var(--kal-border);
  border-radius: 16px;
  background: var(--kal-card-bg);
  cursor: pointer;
  user-select: none;
  transition: box-shadow 0.16s ease, transform 0.16s ease;
}
.home-card:not(.is-empty):hover,
.home-card:not(.is-empty):focus-visible {
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.08);
  transform: translateY(-1px);
  outline: none;
}
.home-card.is-empty { cursor: default; padding-bottom: 16px; }

.card-head { display: flex; align-items: flex-start; gap: 10px; }
.identity { flex: 1 1 auto; min-width: 0; line-height: 1.35; }
.primary,
.secondary,
.note {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.primary { font-weight: 600; font-size: 13.5px; }
.home-card:hover .primary { color: var(--kal-primary); }
.secondary,
.note { font-size: 12px; color: var(--kal-muted); }
.head-tag { margin: 0; flex: 0 0 auto; }

.tag-row { display: flex; flex-wrap: wrap; gap: 6px 0; min-width: 0; }
.tag-row > * { flex: 0 0 auto; }

/* 紧凑模式的用量块：柱状条与百分比同排，下面一行是总额 + 更新时间 */
.usage-block {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  column-gap: 8px;
  row-gap: 8px;
  padding: 12px;
  border-radius: 12px;
  background: var(--kal-block-bg);
}
.usage-bars {
  flex: 1 1 auto;
  min-width: 60px;
  display: flex;
  align-items: stretch;
  gap: 2px;
  height: 14px;
}
.bar { flex: 1 1 0; border-radius: 2px; background: var(--kal-bar-off); }
.bar.on { background: var(--bar-on); }
.usage-percent { flex: 0 0 auto; font-size: 16px; font-weight: 700; line-height: 1; }
.usage-percent small { font-size: 12px; font-weight: 700; margin-left: 1px; }
.usage-foot {
  flex: 1 0 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 12.5px;
}
.usage-number { font-weight: 600; }
.usage-foot span:last-child { white-space: nowrap; }

.error-line {
  font-size: 11.5px;
  line-height: 18px;
  color: #ff4d4f;
  background: rgba(255, 77, 79, 0.08);
  border-radius: 8px;
  padding: 5px 8px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.card-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: auto;
  padding: 6px 0;
  font-size: 11.5px;
  line-height: 1.4;
}
.card-foot span { white-space: nowrap; }
.warn { color: #faad14; }

.empty-title { font-size: 12px; font-weight: 600; }
.card-empty { margin: auto 0; padding: 12px 0; }
</style>
