<script setup lang="ts">
/**
 * API Key 卡片。原先整段模板内联在 KeysView 的虚拟滚动插槽里：
 * 插槽里任何依赖变了（例如网关统计每轮轮询），所有可见卡片都要整段重算 ——
 * keyStatus / keyIssue / statsOf 之类在一张卡里各被调用好几次，
 * 每个按钮的内联箭头函数也让子组件每次都被判定 props 变了。
 *
 * 抽成组件后派生值都是 computed，只算一次；props 没变的卡片直接跳过渲染。
 * 所有事件都把本卡的 entry 带出去，父组件绑定稳定的方法引用即可。
 */
import { computed } from 'vue'
import {
  ApiOutlined,
  CalendarOutlined,
  CheckCircleFilled,
  CopyOutlined,
  DeleteOutlined,
  EditOutlined,
  GlobalOutlined,
  SwapOutlined,
  SyncOutlined,
  ThunderboltOutlined
} from '@ant-design/icons-vue'
import { useKeysStore } from '@/stores/keys'
import { useSettingsStore } from '@/stores/settings'
import { displayEmail, displayKey, displayNote } from '@/utils/display'
import { maskGroupName, usePrivacy } from '@/composables/usePrivacy'
import {
  KEY_STATUS_META,
  formatCreditsPair,
  formatDate,
  formatDateTime,
  subscriptionMeta,
  usageColor
} from '@/utils/format'
import { groupsOfItem } from '@/utils/groups'
import { keyDaysRemaining, keyIssue, keyTier, keyUsageRatio } from '@/utils/keyEntry'
import { regionLabel } from '@shared/regions'
import type { AccountDisplayMode, KeyEntry, KeyGatewayUsageStats } from '@shared/types'

const props = defineProps<{
  entry: KeyEntry
  /** 该 Key 的网关统计（原样传入，没有就是 undefined） */
  stats?: KeyGatewayUsageStats
  /** 是否为当前使用的 Key */
  active: boolean
  selected: boolean
  /** 右键菜单正作用于这张卡片 */
  contextActive: boolean
  mode: AccountDisplayMode
  /** 「切换到该 Key」进行中 */
  selecting: boolean
  /** 「刷新用量与积分」进行中 */
  syncing: boolean
}>()

const emit = defineEmits<{
  'toggle-select': [id: string, checked: boolean]
  detail: [entry: KeyEntry]
  usage: [entry: KeyEntry]
  region: [entry: KeyEntry]
  history: [entry: KeyEntry, metric: 'requests' | 'credits']
  select: [entry: KeyEntry]
  sync: [entry: KeyEntry]
  test: [entry: KeyEntry]
  copy: [entry: KeyEntry]
  cli: [entry: KeyEntry]
  edit: [entry: KeyEntry]
  remove: [entry: KeyEntry]
  contextmenu: [event: MouseEvent, entry: KeyEntry]
}>()

const store = useKeysStore()
const settingsStore = useSettingsStore()

const BAR_COUNT = 40

/** 隐私打码按字段生效：只遮用户在工具栏勾选的那几项 */
const { maskKey } = usePrivacy()
const maskKeyOn = computed(() => maskKey('apiKey'))
const maskEmailOn = computed(() => maskKey('email'))
const maskNoteOn = computed(() => maskKey('note'))
const precision = computed(() => settingsStore.settings.usagePrecision)

const keyText = computed(() => displayKey(props.entry.key, maskKeyOn.value))
const emailText = computed(() =>
  props.entry.email ? displayEmail(props.entry.email, maskEmailOn.value) : '-'
)
const noteText = computed(() => displayNote(props.entry.note, maskNoteOn.value) || '-')

const issue = computed(() => keyIssue(props.entry))
const status = computed(
  () => KEY_STATUS_META[issue.value ? 'error' : props.entry.lastCheckedAt ? 'normal' : 'unchecked']
)
/** 档位配色与账号管理共用同一张表 */
const subscriptionColor = computed(() => subscriptionMeta(keyTier(props.entry)).color)

/** 所属分组（可多个，按分组顺序）；已被删除的分组不显示 */
const groupNames = computed(() =>
  groupsOfItem(props.entry, store.groups).map((group) =>
    maskKey('group') ? maskGroupName() : group.name
  )
)

const ratio = computed(() => keyUsageRatio(props.entry))
const percentText = computed(() => {
  const value = ratio.value * 100
  if (value <= 0) return '0'
  if (value >= 100) return '100'
  return value.toFixed(2)
})
const filledBars = computed(() => Math.round(ratio.value * BAR_COUNT))
const barColor = computed(() => usageColor(ratio.value))

const updatedTitle = computed(() =>
  props.entry.lastCheckedAt
    ? `用量与积分更新于 ${formatDateTime(props.entry.lastCheckedAt)}`
    : undefined
)
const updatedText = computed(() =>
  props.entry.lastCheckedAt ? formatDateTime(props.entry.lastCheckedAt) : '尚未同步'
)

// ============ 网关调用统计 ============

/** 没跑过请求视为无数据，各模块显示占位符 */
const stats = computed(() => (props.stats && props.stats.requests > 0 ? props.stats : undefined))

/** 大数字压成 12.3k / 1.2M，避免撑破卡片上的窄格子 */
function compactNumber(n: number): string {
  if (!n) return '0'
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

const statView = computed(() => {
  const s = stats.value
  if (!s) {
    const none = '该 Key 尚未经本地网关发出过请求'
    return {
      requests: '-',
      rpm: '-',
      successRate: '-',
      successColor: 'inherit',
      credit: '-',
      requestTip: none,
      creditTip: none
    }
  }
  const rate = s.succeeded / s.requests
  const unit = s.meteredUnit ? ` ${s.meteredUnit}` : ''
  return {
    requests: String(s.requests),
    rpm: String(s.rpm),
    successRate: (rate * 100).toFixed(2),
    successColor: rate >= 0.95 ? '#52c41a' : rate >= 0.8 ? '#faad14' : '#ff4d4f',
    /*
     * 积分消耗：取响应流里 MeteringEvent 的累计值，这是 Kiro 的计费口径。
     * 上游给的是长浮点，固定两位小数即可；上万后压成 k。
     * 请求跑过但没有计费事件时显示 0，与"从没跑过"的 - 区分。
     */
    credit: s.metered >= 10000 ? compactNumber(s.metered) : s.metered.toFixed(2),
    requestTip:
      `对话请求 ${s.requests} 次：成功 ${s.succeeded} / 失败 ${s.failed}` +
      (s.auxRequests
        ? `\n另有辅助请求 ${s.auxRequests} 次（/mcp、模型列表等），失败 ${s.auxFailed} 次，不计入成功率`
        : ''),
    creditTip:
      `经网关累计消耗 ${s.metered.toFixed(4)}${unit}（来自服务端计费事件）\n` +
      '点击查看积分消耗曲线与明细'
  }
})

// ============ 事件 ============

type EntryEvent =
  | 'detail'
  | 'usage'
  | 'region'
  | 'select'
  | 'sync'
  | 'test'
  | 'copy'
  | 'cli'
  | 'edit'
  | 'remove'

/** emit 的重载签名不接受联合类型，这里收窄成统一形态再调用 */
const emitEntry = emit as (event: EntryEvent, entry: KeyEntry) => void

function fire(event: EntryEvent): void {
  emitEntry(event, props.entry)
}

function openHistory(metric: 'requests' | 'credits'): void {
  emit('history', props.entry, metric)
}

/** 整卡点击 = 勾选 / 取消勾选；有自己语义的区域各自 stop */
function onCardClick(): void {
  emit('toggle-select', props.entry.id, !props.selected)
}

function onCheckChange(e: { target: { checked: boolean } }): void {
  emit('toggle-select', props.entry.id, e.target.checked)
}

function onContextMenu(e: MouseEvent): void {
  emit('contextmenu', e, props.entry)
}
</script>

<template>
  <a-card
    class="key-card"
    :class="[
      `mode-${props.mode}`,
      {
        active: props.active,
        selected: props.selected,
        'context-active': props.contextActive
      }
    ]"
    @click="onCardClick"
    @contextmenu="onContextMenu"
  >
    <div class="key-head">
      <div class="key-name">
        <a-checkbox :checked="props.selected" @click.stop @change="onCheckChange" />
        <!--
          整卡点击 = 勾选 / 取消勾选，有自己语义的区域各自 stop：
          这块开详情，用量块开积分变化，统计格开曲线，右下动作区各干各的。
        -->
        <div class="key-identity" @click.stop="fire('detail')">
          <span class="key-value mono" :title="maskKeyOn ? undefined : props.entry.key">{{ keyText }}</span>
          <span
            class="key-email muted"
            :title="props.entry.email && !maskEmailOn ? props.entry.email : undefined"
          >邮箱：{{ emailText }}</span>
          <span
            class="key-note muted"
            :title="props.entry.note && !maskNoteOn ? props.entry.note : undefined"
          >备注：{{ noteText }}</span>
        </div>
      </div>
    </div>

    <!-- data-vg-grow：标签折行时只让所在行加高，见 VirtualGrid 的 grown -->
    <div class="tag-row" data-vg-grow>
      <a-tag :color="status.color" class="status-tag">
        {{ status.text }}
      </a-tag>
      <a-tag :color="subscriptionColor" :bordered="false">
        {{ props.entry.subscription || '等级未知' }}
      </a-tag>
      <!-- 分组标签：没分组就不显示，避免每张卡都多一个空标签；多个分组各占一个标签 -->
      <a-tag
        v-for="(groupName, i) in groupNames"
        :key="i"
        class="group-tag"
        color="purple"
        :bordered="false"
        :title="maskKey('group') ? undefined : `分组：${groupName}`"
      >
        {{ groupName }}
      </a-tag>
      <a-tooltip :title="`${regionLabel(props.entry.region)}，点击修改所属区域`">
        <button class="region-chip mono" @click.stop="fire('region')">
          <GlobalOutlined />
          {{ props.entry.region }}
        </button>
      </a-tooltip>
    </div>

    <div class="usage-block" title="点击查看积分变化" @click.stop="fire('usage')">
      <div class="usage-head">
        <span class="usage-title">
          <span class="muted">使用量</span>
          <span class="usage-updated muted" :title="updatedTitle">
            {{ updatedText }}
          </span>
        </span>
        <strong class="usage-percent" :style="{ color: barColor }">
          {{ percentText }}<small>%</small>
        </strong>
      </div>
      <div
        class="usage-bars"
        :style="{ '--bar-on': barColor }"
        role="progressbar"
        aria-valuemin="0"
        aria-valuemax="100"
        :aria-valuenow="Math.round(ratio * 100)"
      >
        <span v-for="i in BAR_COUNT" :key="i" class="bar" :class="{ on: i <= filledBars }" />
      </div>
      <div class="usage-foot">
        <span class="usage-number">
          {{ formatCreditsPair(props.entry.usedCredits ?? 0, props.entry.totalCredits ?? 0, precision) }}
        </span>
        <!-- 与账号卡片同一位置的口径：有重置时间就显示它，否则退回额度说明 -->
        <span
          v-if="props.entry.nextResetAt"
          class="muted"
          :title="`额度重置剩余 ${keyDaysRemaining(props.entry)} 天`"
        >
          <CalendarOutlined />
          {{ formatDate(props.entry.nextResetAt) }} 重置
        </span>
        <span v-else class="muted">已用 / 总额度</span>
      </div>
    </div>

    <!-- 网关实际调用统计：始终占位，没有数据显示 -，保证所有卡片高度一致 -->
    <div class="stat-grid">
      <div class="stat-cell clickable" :title="statView.requestTip" @click.stop="openHistory('requests')">
        <span class="stat-label">请求</span>
        <strong class="stat-value">{{ statView.requests }}</strong>
      </div>
      <div
        class="stat-cell clickable"
        title="2xx 响应占全部请求的比例，点击查看成功率曲线"
        @click.stop="openHistory('requests')"
      >
        <span class="stat-label">成功率</span>
        <strong class="stat-value" :style="{ color: statView.successColor }">
          {{ statView.successRate }}<small v-if="stats">%</small>
        </strong>
      </div>
      <div
        class="stat-cell clickable"
        title="最近一分钟经网关发出的请求数（重启后重新计算），点击查看请求量曲线"
        @click.stop="openHistory('requests')"
      >
        <span class="stat-label">RPM</span>
        <strong class="stat-value">{{ statView.rpm }}</strong>
      </div>
      <div class="stat-cell clickable" :title="statView.creditTip" @click.stop="openHistory('credits')">
        <span class="stat-label">积分</span>
        <strong class="stat-value">{{ statView.credit }}</strong>
      </div>
    </div>

    <!--
      报错行只在真有问题时渲染。卡片等高由虚拟滚动的 itemExtra 保证：
      只给「同一行里真有报错」的那一行加高，没报错的行不留空白。
    -->
    <a-tooltip v-if="issue" placement="topLeft">
      <template #title>
        <span class="error-tip">{{ issue }}</span>
      </template>
      <div class="error-line">{{ issue }}</div>
    </a-tooltip>

    <!--
      底部动作区的空白（切换按钮与右侧图标之间）照样落到整卡点击、切换勾选；
      只拦按钮本身：切换按钮自带 .stop，右侧图标整排在 action-row 上拦
    -->
    <div class="key-actions">
      <div class="key-switch-action">
        <span v-if="props.active" class="current-key-label">
          <CheckCircleFilled />
          当前使用
        </span>
        <a-button
          v-else
          type="link"
          size="small"
          class="switch-key-btn"
          :loading="props.selecting"
          @click.stop="fire('select')"
        >
          <template #icon><SwapOutlined /></template>
          切换到该 Key
        </a-button>
      </div>
      <div class="action-row" @click.stop>
        <a-tooltip title="刷新用量与积分">
          <a-button
            type="text"
            size="small"
            class="action-btn"
            :loading="props.syncing"
            @click.stop="fire('sync')"
          >
            <template #icon><SyncOutlined /></template>
          </a-button>
        </a-tooltip>
        <a-tooltip title="测活（发一次真实对话）">
          <a-button type="text" size="small" class="action-btn" @click.stop="fire('test')">
            <template #icon><ThunderboltOutlined /></template>
          </a-button>
        </a-tooltip>
        <a-tooltip title="复制完整 API Key">
          <a-button type="text" size="small" class="action-btn" @click.stop="fire('copy')">
            <template #icon><CopyOutlined /></template>
          </a-button>
        </a-tooltip>
        <a-tooltip title="使用此 API Key 连接 Kiro CLI">
          <a-button type="text" size="small" class="action-btn" @click.stop="fire('cli')">
            <template #icon><ApiOutlined /></template>
          </a-button>
        </a-tooltip>
        <a-tooltip title="修改备注">
          <a-button type="text" size="small" class="action-btn" @click.stop="fire('edit')">
            <template #icon><EditOutlined /></template>
          </a-button>
        </a-tooltip>
        <a-tooltip title="删除">
          <a-button type="text" size="small" class="action-btn" danger @click.stop="fire('remove')">
            <template #icon><DeleteOutlined /></template>
          </a-button>
        </a-tooltip>
      </div>
    </div>
  </a-card>
</template>

<style scoped>
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
/* 整卡可点选；连着点几十张卡时不留下一片蓝色选中文字，要复制走详情抽屉或复制按钮 */
.key-card {
  width: 100%;
  border: 1px solid var(--kal-border);
  overflow: hidden;
  cursor: pointer;
  user-select: none;
  transition: border-color 0.16s ease, background-color 0.16s ease, box-shadow 0.16s ease, transform 0.16s ease;
}
/*
 * 悬停反馈与账号卡片（AccountCard）一致：浅阴影 + 上浮 1px。
 * 不用 a-card 的 hoverable，它的默认阴影明显更深，两页放在一起看很不统一。
 * 写在 selected / active 之前：同优先级时后者覆盖，选中态的描边阴影不被悬停冲掉。
 */
.key-card:hover { box-shadow: 0 6px 20px rgba(0, 0, 0, 0.08); transform: translateY(-1px); }
/* 列表模式不上浮：几十行同时排着，逐行抬起会显得很闹 */
.key-card.mode-list:hover { transform: none; box-shadow: 0 2px 10px rgba(0, 0, 0, 0.06); }
/* 用 padding 简写覆盖 antd 默认的 24px：左右也要收，不然横向留白比纵向大一截 */
.key-card :deep(.ant-card-body) { padding: 6px 14px; }
/*
 * 卡片 / 紧凑形态：卡片体改成纵向 flex 并铺满整卡，动作区用 margin-top: auto
 * 钉在底边，富余高度（虚拟滚动的统一行高减去本卡内容）落在它上方 —— 与账号卡片一致。
 *
 * 块间距随之改由 row-gap 统一给：auto 外边距会把「上一块的 margin-bottom」之外的
 * 空间全吃掉，靠各块自带的 margin-top 撑不出最小间距，而 gap 不受 auto 影响。
 * 所以子块不要再设 margin-top，否则会和 gap 叠加。
 */
.key-card:not(.mode-list) { display: flex; flex-direction: column; }
.key-card:not(.mode-list) :deep(.ant-card-body) {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  row-gap: 8px;
}
.key-card:not(.mode-list) .key-actions { margin-top: auto; }
.key-card.selected { border-color: var(--kal-primary); box-shadow: 0 0 0 1px var(--kal-primary) inset; }
.key-card.active { border-color: #52c41a; box-shadow: none; }
/*
 * 右键菜单作用中的卡片：浅色半透明主题色边框 + 很浅的主题色底，菜单关掉即恢复。
 * 已勾选的卡片保留实心勾选边框，只叠加底色。
 */
.key-card.context-active { border-color: color-mix(in srgb, var(--kal-primary) 45%, transparent); background-color: color-mix(in srgb, var(--kal-primary) 3%, var(--kal-card-bg)); }
.key-card.context-active.selected { border-color: var(--kal-primary); }
.key-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
.key-name { display: flex; flex: 1 1 auto; align-items: flex-start; gap: 7px; min-width: 0; }
.key-identity { flex: 1 1 auto; min-width: 0; line-height: 1.4; cursor: pointer; }
.key-switch-action { display: flex; flex: 1 1 auto; align-items: center; min-width: 0; min-height: 24px; }
.current-key-label { display: inline-flex; align-items: center; gap: 5px; color: #52c41a; font-size: 12px; font-weight: 600; }
.switch-key-btn { height: 24px; padding: 0; font-size: 12px; }
.key-value, .key-email, .key-note { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.key-value { font-size: 13px; font-weight: 600; transition: color 0.15s ease; }
/* 悬停 key 区域时高亮 key 值，与账户卡片悬停邮箱一致 */
.key-identity:hover .key-value { color: var(--kal-primary); }
.key-email, .key-note { margin-top: 2px; font-size: 12px; }
.status-tag { flex: 0 0 auto; margin: 0; }
/*
 * 标签排不下时自动换行：一个 Key 可以属于多个分组，挤在一行只能全部截成省略号。
 * 每个标签保持完整宽度，放不下就整个挪到下一行（列表模式另有单行规则，见下方）。
 */
.tag-row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; min-height: 22px; min-width: 0; }
.tag-row :deep(.ant-tag) { margin: 0; flex: 0 0 auto; }
/*
 * 分组名是用户自己填的，长度不可控：一般完整显示，
 * 只有单个名字长过整行时才截断成省略号，全名看悬停提示。
 */
.tag-row .group-tag { max-width: 100%; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* 区域靠右对齐，与左侧的状态、等级标签同一行 */
.region-chip { display: inline-flex; flex: 0 0 auto; align-items: center; gap: 4px; margin-left: auto; padding: 1px 8px; border: 1px solid var(--kal-border); border-radius: 10px; background: transparent; color: var(--kal-muted); font-size: 11.5px; line-height: 18px; cursor: pointer; transition: border-color 0.15s ease, color 0.15s ease; }
.region-chip:hover { border-color: var(--kal-primary); color: var(--kal-primary); }
/* 高度按内容自然撑开：各卡结构相同、高度本来就一致，写死 105px 只会多留几像素空白 */
.usage-block { display: flex; flex-direction: column; gap: 4px; padding: 10px 12px; box-sizing: border-box; border-radius: 12px; background: var(--kal-block-bg); cursor: pointer; transition: background 0.16s ease; }
.usage-block:hover { background: var(--kal-code-bg); }
.usage-head, .usage-foot { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; font-size: 12.5px; }
/* 底部那行（总额 + 奖励标签 + 重置时间）统一垂直居中，三者落在同一条水平轴上 */
.usage-foot { align-items: center; }
.usage-title { display: flex; align-items: baseline; gap: 6px; min-width: 0; }
.usage-updated { max-width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; }
.usage-percent { flex: 0 0 auto; font-size: 20px; font-weight: 700; line-height: 1; }
.usage-percent small { margin-left: 1px; font-size: 12px; }
.usage-bars { display: flex; align-items: stretch; gap: 2px; height: 14px; margin: 8px 0 10px; }
.bar { flex: 1 1 0; border-radius: 2px; background: var(--kal-bar-off); transition: background 0.2s ease; }
.bar.on { background: var(--bar-on); }
.usage-number { font-weight: 600; display: inline-flex; align-items: center; gap: 6px; line-height: 18px; }
/* 右侧的重置日期不允许折行，与账号卡片一致 */
.usage-foot span:last-child { white-space: nowrap; }
/* 网关调用统计：四个等宽圆角小块，无边框，背景与上方使用量区块统一 */
.stat-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; }
.stat-cell {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1px;
  padding: 7px 2px 6px;
  border-radius: 10px;
  background: var(--kal-block-bg);
}
.stat-cell.clickable { cursor: pointer; transition: background 0.16s ease; }
.stat-cell.clickable:hover { background: var(--kal-code-bg); }
.stat-label { color: var(--kal-muted); font-size: 11px; line-height: 1.2; }
/* 成功率带两位小数后字符变长，格子窄时靠 clamp 缩字号，且禁止折行 */
.stat-value { font-size: clamp(11px, 1.1vw, 14px); line-height: 1.25; white-space: nowrap; font-variant-numeric: tabular-nums; }
.stat-value small { margin-left: 1px; font-size: 10px; font-weight: 400; }
/*
 * 报错行。高度钉成确定值：18（行高）+ 3 + 3（上下 padding）= 24px。
 * 加上所在形态的块间距，就是带报错的卡比同类卡高出的部分 ——
 * 与上面 ERROR_ROW_EXTRA 的取值绑定，改这里要同步改那边。
 */
.error-line { padding: 3px 8px; overflow: hidden; color: #ff4d4f; border-radius: 8px; background: rgba(255, 77, 79, 0.08); font-size: 11.5px; line-height: 18px; text-overflow: ellipsis; white-space: nowrap; cursor: help; }
/* 卡片里一行截断，Tooltip 里完整换行展示 */
.error-tip { white-space: pre-wrap; word-break: break-all; }
.key-actions { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 0 0; border-top: 1px solid var(--kal-border); }
.action-row { display: flex; flex: 0 0 auto; align-items: center; gap: 0; }
.action-btn { width: 24px; min-width: 24px; height: 24px; padding: 0; }
/* ============ 紧凑卡片 ============ */
/*
 * 去掉网关统计那四个小格；用量块压成两行（柱状条与百分比同排，下面是总额 + 更新时间），
 * 与账号卡片的紧凑模式同一套做法：display: contents 把 .usage-head 从布局里摘掉，
 * 让它的两个子元素直接成为用量块的 flex 项，再用 order 排位。
 */
.key-card.mode-compact .stat-grid { display: none; }
.key-card.mode-compact .usage-block,
.key-card.mode-list .usage-block {
  flex-direction: row;
  flex-wrap: wrap;
  align-items: center;
  column-gap: 8px;
  row-gap: 8px;
}
.key-card.mode-compact .usage-head,
.key-card.mode-list .usage-head { display: contents; }
.key-card.mode-compact .usage-title,
.key-card.mode-list .usage-title { display: none; }
.key-card.mode-compact .usage-bars,
.key-card.mode-list .usage-bars { order: 1; flex: 1 1 auto; min-width: 60px; margin: 0; }
.key-card.mode-compact .usage-percent,
.key-card.mode-list .usage-percent { order: 2; font-size: 16px; }
.key-card.mode-compact .usage-foot,
.key-card.mode-list .usage-foot { order: 3; flex: 1 0 100%; }
/* 内容压得紧，底部那条分隔线与它自身的上内边距都去掉（块间距与卡片模式同为 8px） */
.key-card.mode-compact .key-actions { border-top: none; padding-top: 0; }

/* ============ 列表模式 ============ */
/*
 * 一条 = 四块：Key 信息 | 标签 | 用量 | 操作区，标签那块顺带吃掉全部富余宽度。
 * 与账号列表同一套：网格 + 容器查询按「卡片实际可用宽度」分档，
 * 窄了依次把标签、用量、操作区挪到下一行，不挤压也不横向溢出。
 *
 * 真正的布局容器是 a-card 的 body（卡片自己只是外壳），所以规则打在 :deep 上。
 */
.key-card.mode-list :deep(.ant-card-body) {
  display: grid;
  grid-template-columns: 400px minmax(190px, 1fr) 350px 320px;
  align-items: center;
  align-content: center;
  column-gap: 18px;
  row-gap: 8px;
  padding: 8px 14px;
}
/* 每块写死落位：报错行跨整行、自动摆放的游标不能回退，不写死会把操作区顶到下一行 */
.key-card.mode-list .key-head { grid-area: 1 / 1 / 2 / 2; }
.key-card.mode-list .tag-row { grid-area: 1 / 2 / 2 / 3; }
.key-card.mode-list .usage-block { grid-area: 1 / 3 / 2 / 4; }
.key-card.mode-list .key-actions { grid-area: 1 / 4 / 2 / 5; padding-top: 0; border-top: none; }
.key-card.mode-list .stat-grid { display: none; }
.key-card.mode-list .error-line { grid-column: 1 / -1; }
/* 区域标签在窄列里不必再靠右顶开 */
.key-card.mode-list .region-chip { margin-left: 0; }
.key-card.mode-list .tag-row { flex-wrap: nowrap; min-width: 0; margin-left: 6px; overflow: hidden; }
.key-card.mode-list .usage-bars { height: 10px; }
/* 「切换到该 Key」在一行里太长，收成图标按钮那一排的同级元素 */
.key-card.mode-list .key-switch-action { flex: 0 0 auto; }

/* 窄一档：标签掉到第二行铺满整宽 */
@container (max-width: 1343px) {
  .key-card.mode-list :deep(.ant-card-body) {
    grid-template-columns: 400px minmax(0, 1fr) 350px 320px;
  }
  .key-card.mode-list .tag-row { grid-area: 2 / 1 / 3 / -1; margin-left: 0; }
}

/* 再窄一档：操作区掉到用量下面，第一行只剩「Key | 富余 | 用量」 */
@container (max-width: 1153px) {
  .key-card.mode-list :deep(.ant-card-body) {
    grid-template-columns: minmax(0, 400px) minmax(0, 1fr) 350px;
  }
  .key-card.mode-list .tag-row { grid-area: 2 / 1 / 3 / 3; }
  .key-card.mode-list .key-actions { grid-area: 2 / 3 / 3 / 4; }
}

/* 兜底档：逐块竖排，正常窗口到不了这里 */
@container (max-width: 745px) {
  .key-card.mode-list :deep(.ant-card-body) { grid-template-columns: minmax(0, 1fr); }
  .key-card.mode-list .key-head,
  .key-card.mode-list .tag-row,
  .key-card.mode-list .usage-block,
  .key-card.mode-list .key-actions { grid-area: auto / 1 / auto / -1; }
}

</style>
