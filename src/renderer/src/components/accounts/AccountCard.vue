<script setup lang="ts">
import { computed, type Component } from 'vue'
import {
  CalendarOutlined,
  ClockCircleOutlined,
  CopyOutlined,
  DeleteOutlined,
  EditOutlined,
  GlobalOutlined,
  KeyOutlined,
  LoginOutlined,
  LogoutOutlined,
  SyncOutlined,
  ThunderboltOutlined
} from '@ant-design/icons-vue'
import { useAccountsStore } from '@/stores/accounts'
import { useSettingsStore } from '@/stores/settings'
import {
  IDP_META,
  STATUS_META,
  subscriptionMeta,
  formatCheckedAt,
  formatCreditsPair,
  formatDate,
  formatDateTime,
  subscriptionLabel,
  tokenLife,
  usageColor
} from '@/utils/format'
import { displayEmail, displayName, displayNote } from '@/utils/display'
import { now } from '@/utils/now'
import type { Account, AccountDisplayMode } from '@shared/types'

const props = withDefaults(
  defineProps<{
    account: Account
    selected: boolean
    /** 正在进行中的操作，只让对应按钮转圈 */
    busyAction?: string | null
    /**
     * 展示形态。三种形态共用同一份 DOM，差异全部交给 CSS：
     * 结构不分叉，改一处文案 / 加一个动作按钮不必在三个模板里各改一遍。
     */
    mode?: AccountDisplayMode
  }>(),
  { busyAction: null, mode: 'card' }
)

const busy = computed(() => !!props.busyAction)

const emit = defineEmits<{
  'toggle-select': [boolean]
  detail: []
  edit: []
  remove: []
  switch: []
  logout: []
  'refresh-key': []
  'refresh-usage': []
  'copy-token': []
  test: []
  /** 用该账号凭证生成一个新的 Kiro API Key */
  'create-api-key': []
  /** 用该账号凭证打开官网后台 */
  portal: []
  /** 点用量区域查看积分变化日志 */
  usage: []
}>()

const accountsStore = useAccountsStore()
const settingsStore = useSettingsStore()

const precision = computed(() => settingsStore.settings.usagePrecision)

const privacy = computed(() => settingsStore.settings.privacyMode)

const email = computed(() => displayEmail(props.account.email, privacy.value))
const nickname = computed(() => displayName(props.account, privacy.value))

/** 备注在隐私模式下整段遮住；留空时显示占位符，保证同排卡片高度一致 */
const note = computed(() => displayNote(props.account.note, privacy.value))

/** 所属分组名；分组已被删除时按未分组处理，标签不显示 */
const groupName = computed(() => {
  const id = props.account.groupId
  return id ? accountsStore.groupMap.get(id)?.name ?? '' : ''
})

/** 使用率百分比原始值，用量条与文案各自再做取整 */
const rawPercent = computed(() => (props.account.usage.percentUsed || 0) * 100)

const percent = computed(() => Math.min(100, Math.round(rawPercent.value)))

/** 百分比文案：0 和 100 取整，其间保留两位小数 */
const percentText = computed(() => {
  const value = Math.min(100, Math.max(0, rawPercent.value))
  if (value <= 0) return '0'
  if (value >= 100) return '100'
  return value.toFixed(2)
})

/** 用量与积分的更新时间：当天显示时分秒，跨天补上年月日 */
const usageUpdatedAt = computed(() => formatCheckedAt(props.account.lastCheckedAt, now.value))

/**
 * 分段用量条：固定竖条数量，按使用率点亮相应根数。
 * 列表模式那一列比卡片窄，同样根数会显得过密，减到 28 根。
 */
const barCount = computed(() => (props.mode === 'list' ? 28 : 40))
const filledBars = computed(() => Math.round((percent.value / 100) * barCount.value))
const barColor = computed(() => usageColor(props.account.usage.percentUsed || 0))

const status = computed(() => STATUS_META[props.account.status])
const idp = computed(() => IDP_META[props.account.idp])
const subscription = computed(() => subscriptionMeta(props.account.subscription.type))
/** 订阅展示名：优先接口给的标题 */
const subscriptionText = computed(() => subscriptionLabel(props.account.subscription))

const daysRemaining = computed(() => props.account.subscription.daysRemaining)

/** 订阅到期时间：优先订阅字段，回退到用量重置日期 */
const expiryDate = computed(() =>
  formatDate(props.account.subscription.expiresAt ?? props.account.usage.nextResetDate)
)

/** 额度明细行：基础 / 试用 / 奖励，各自带到期时间 */
const quotaRows = computed(() => {
  const usage = props.account.usage
  const p = precision.value
  const rows: { key: string; color: string; label: string; value: string; expiry?: string }[] = []
  if (usage.baseLimit) {
    rows.push({
      key: 'base',
      color: '#1677ff',
      label: '基础',
      value: formatCreditsPair(usage.baseCurrent, usage.baseLimit, p),
      expiry: usage.nextResetDate ? formatDate(usage.nextResetDate) : undefined
    })
  }
  if (usage.freeTrialLimit) {
    rows.push({
      key: 'trial',
      color: '#722ed1',
      label: '试用',
      value: formatCreditsPair(usage.freeTrialCurrent, usage.freeTrialLimit, p),
      expiry: usage.freeTrialExpiry ? formatDate(usage.freeTrialExpiry) : undefined
    })
  }
  for (const bonus of usage.bonuses ?? []) {
    rows.push({
      key: `bonus-${bonus.code}`,
      color: '#13c2c2',
      label: bonus.name,
      value: formatCreditsPair(bonus.current, bonus.limit, p),
      expiry: bonus.expiresAt ? formatDate(bonus.expiresAt) : undefined
    })
  }
  return rows
})

/** Access Token 剩余有效期，不足 10 分钟时标黄提醒 */
const tokenState = computed(() => {
  const life = tokenLife(props.account.credentials.expiresAt, 'round')
  switch (life.state) {
    case 'unknown':
      return { text: '未知', warn: true }
    case 'expired':
      return { text: '已过期', warn: true }
    case 'minutes':
      return { text: `${life.minutes} 分钟`, warn: life.minutes < 10 }
    default:
      return { text: `${life.hours} 小时`, warn: false }
  }
})

type ActionKey =
  | 'switch'
  | 'logout'
  | 'refresh-key'
  | 'refresh-usage'
  | 'copy-token'
  | 'test'
  | 'create-api-key'
  | 'portal'
  | 'edit'
  | 'remove'

interface MenuEntry {
  key: ActionKey
  label: string
  icon: Component
}

interface CardAction {
  /** v-for 用的稳定标识；菜单型按钮自身不对应某个动作 */
  id: string
  title: string
  icon: Component
  /** 普通按钮点击后派发的动作 */
  action?: ActionKey
  /** 菜单型按钮的子项，与 action 互斥 */
  menu?: MenuEntry[]
  danger?: boolean
  color?: string
}

/** 首个按钮随登录状态切换：已登录显示退出登录，未登录显示登录 */
const actions = computed<CardAction[]>(() => [
  props.account.isActive
    ? {
        id: 'logout',
        action: 'logout',
        title: '退出登录（清理 Kiro IDE 凭证）',
        icon: LogoutOutlined,
        color: '#52c41a'
      }
    : {
        id: 'switch',
        action: 'switch',
        title: '登录此账号（写入 Kiro IDE）',
        icon: LoginOutlined
      },
  {
    id: 'refresh',
    title: '刷新',
    icon: SyncOutlined,
    menu: [
      { key: 'refresh-key', label: '刷新密钥', icon: KeyOutlined },
      { key: 'refresh-usage', label: '刷新用量与积分', icon: SyncOutlined }
    ]
  },
  { id: 'copy-token', action: 'copy-token', title: '复制凭证 JSON', icon: CopyOutlined },
  { id: 'test', action: 'test', title: '测活（发一次真实对话）', icon: ThunderboltOutlined },
  { id: 'create-api-key', action: 'create-api-key', title: 'API Key 管理', icon: KeyOutlined },
  { id: 'portal', action: 'portal', title: '前往Kiro.dev官网', icon: GlobalOutlined },
  { id: 'edit', action: 'edit', title: '编辑', icon: EditOutlined },
  { id: 'remove', action: 'remove', title: '删除', icon: DeleteOutlined, danger: true }
])

/** 菜单型按钮的加载态取自其任一子动作 */
function isLoading(item: CardAction): boolean {
  const keys = item.menu ? item.menu.map((entry) => entry.key) : item.action ? [item.action] : []
  return keys.some((key) => props.busyAction === key)
}

/**
 * 动作按钮统一派发。
 * emit 的重载签名不接受联合类型，这里收窄成「无参事件名」的形态再调用；
 * ActionKey 已经限定了取值范围，不会派发出未声明的事件。
 */
const emitAction = emit as (event: ActionKey) => void

function trigger(key: ActionKey): void {
  emitAction(key)
}

/**
 * 整卡点击 = 勾选 / 取消勾选。
 *
 * 卡片上原本只有那个 16px 的复选框能点，勾几十个账号很折磨。
 * 有自己语义的区域（身份区开详情、用量块开积分变化、右下角动作按钮、复选框本身）
 * 各自 @click.stop 拦下事件，剩下的空白与标签、额度、报错行都落到这里。
 */
function onCardClick(): void {
  emit('toggle-select', !props.selected)
}
</script>

<template>
  <div
    class="account-card"
    :class="[
      `mode-${props.mode}`,
      { 'is-selected': props.selected, 'is-active': props.account.isActive }
    ]"
    @click="onCardClick"
  >
    <div class="card-head">
      <!-- 复选框自己会派发 change，再冒泡给整卡就会连着切两次，这里拦下 -->
      <a-checkbox
        :checked="props.selected"
        @click.stop
        @change="(e: any) => emit('toggle-select', e.target.checked)"
      />
      <div class="identity" @click.stop="emit('detail')">
        <span class="email" :title="privacy ? undefined : props.account.email">{{ email }}</span>
        <span class="nickname">{{ nickname }}</span>
        <span
          class="note"
          :title="props.account.note && !privacy ? props.account.note : undefined"
        >备注：{{ note || '-' }}</span>
      </div>
      <!-- 「使用中」和状态一起摆右上角；状态钉在最外侧，位置在所有卡片上保持一致 -->
      <!-- 带描边：和右边的状态标签一致，无边框的实底块摆在角上显得发虚 -->
      <a-tag v-if="props.account.isActive" color="green" class="head-tag">使用中</a-tag>
      <a-tag :color="status.color" class="status-tag">{{ status.text }}</a-tag>
    </div>

    <div class="tag-row">
      <a-tag :color="subscription.color" :bordered="false">
        {{ subscriptionText }}
      </a-tag>
      <a-tag :color="idp.color" :bordered="false">{{ idp.text }}</a-tag>
      <!-- 分组标签：没分组就不显示，避免每张卡都多一个空标签 -->
      <a-tag
        v-if="groupName"
        class="group-tag"
        color="purple"
        :bordered="false"
        :title="`分组：${groupName}`"
      >
        {{ groupName }}
      </a-tag>
    </div>

    <!-- 更新时间在列表模式里没地方摆，挂到整块的 title 上，鼠标停一下就能看到 -->
    <div
      class="usage-block"
      :title="`点击查看积分变化 · 用量与积分更新于 ${formatDateTime(props.account.lastCheckedAt)}`"
      @click.stop="emit('usage')"
    >
      <div class="usage-head">
        <span class="usage-title">
          <span class="usage-label muted">使用量</span>
          <span class="usage-updated muted" :title="`用量与积分更新于 ${formatDateTime(props.account.lastCheckedAt)}`">
            {{ usageUpdatedAt }}
          </span>
        </span>
        <strong class="usage-percent" :style="{ color: barColor }">
          {{ percentText }}<small>%</small>
        </strong>
      </div>
      <div class="usage-bars" :style="{ '--bar-on': barColor }">
        <span
          v-for="i in barCount"
          :key="i"
          class="bar"
          :class="{ on: i <= filledBars }"
        />
      </div>
      <div class="usage-foot">
        <span class="usage-number">
          {{ formatCreditsPair(props.account.usage.current, props.account.usage.limit, precision) }}
        </span>
        <!--
          紧凑与列表模式都把标题那行整行去掉了，更新时间挪到这里接在总额右侧；
          重置日期在额度明细和详情抽屉里都有，这里让位给更有时效性的更新时间。
        -->
        <span
          v-if="props.mode === 'card'"
          class="usage-reset muted"
        >
          <CalendarOutlined />
          {{ formatDate(props.account.usage.nextResetDate) }} 重置
        </span>
        <span
          v-else
          class="muted"
          :title="`用量与积分更新于 ${formatDateTime(props.account.lastCheckedAt)}`"
        >
          <ClockCircleOutlined />
          {{ usageUpdatedAt }}
        </span>
      </div>
    </div>

    <div class="quota-block">
      <div v-for="row in quotaRows" :key="row.key" class="quota-row">
        <span class="dot" :style="{ background: row.color }" />
        <span class="quota-label muted">{{ row.label }}</span>
        <span class="quota-value">{{ row.value }}</span>
        <span v-if="row.expiry" class="quota-expiry muted">至 {{ row.expiry }}</span>
      </div>
      <div class="quota-row">
        <span class="dot" style="background: #fa8c16" />
        <span class="quota-label muted">订阅</span>
        <span class="quota-value">
          {{ daysRemaining !== undefined ? `剩 ${daysRemaining} 天` : '周期未知' }}
        </span>
        <span class="quota-expiry muted">到期 {{ expiryDate }}</span>
      </div>
    </div>

    <a-tooltip v-if="props.account.lastError" placement="topLeft">
      <template #title>
        <span class="error-tip">{{ props.account.lastError }}</span>
      </template>
      <div class="error-line">{{ props.account.lastError }}</div>
    </a-tooltip>

    <div class="card-foot">
      <div class="meta">
        <span :class="tokenState.warn ? 'warn' : 'muted'">
          <ClockCircleOutlined />
          Token {{ tokenState.text }}
        </span>
      </div>
      <!-- 动作区整块拦下点击：按钮各有各的动作，不该顺带改勾选 -->
      <div class="action-row" @click.stop>
        <template v-for="item in actions" :key="item.id">
          <a-dropdown v-if="item.menu" :disabled="busy && !isLoading(item)">
            <a-button
              type="text"
              size="small"
              class="action-btn"
              :title="item.title"
              :loading="isLoading(item)"
              :disabled="busy && !isLoading(item)"
            >
              <template #icon><component :is="item.icon" /></template>
            </a-button>
            <template #overlay>
              <a-menu>
                <a-menu-item
                  v-for="entry in item.menu"
                  :key="entry.key"
                  @click="trigger(entry.key)"
                >
                  <component :is="entry.icon" />
                  {{ entry.label }}
                </a-menu-item>
              </a-menu>
            </template>
          </a-dropdown>
          <a-tooltip v-else :title="item.title">
            <a-button
              type="text"
              size="small"
              class="action-btn"
              :danger="item.danger"
              :style="item.color ? { color: item.color } : undefined"
              :loading="isLoading(item)"
              :disabled="busy && !isLoading(item)"
              @click="item.action && trigger(item.action)"
            >
              <template #icon><component :is="item.icon" /></template>
            </a-button>
          </a-tooltip>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.account-card {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px 16px 8px;
  border: 1px solid var(--kal-border);
  border-radius: 16px;
  background: var(--kal-card-bg);
  /* 整卡可点选 */
  cursor: pointer;
  /* 连着点几十张卡时不留下一片蓝色选中文字；要复制内容走详情抽屉 */
  user-select: none;
  transition:
    border-color 0.16s ease,
    box-shadow 0.16s ease,
    transform 0.16s ease;
}

.account-card:hover {
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.08);
  transform: translateY(-1px);
}

.account-card.is-selected {
  border-color: var(--kal-primary);
  box-shadow: 0 0 0 1px var(--kal-primary) inset;
}

/* 当前使用的账号：只用绿边标识，背景保持和其它卡片一致 */
.account-card.is-active {
  border-color: #52c41a;
}

.card-head {
  display: flex;
  align-items: flex-start;
  gap: 10px;
}

.identity {
  flex: 1 1 auto;
  min-width: 0;
  cursor: pointer;
  line-height: 1.35;
}

.email,
.nickname,
.note {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.email {
  font-weight: 600;
  font-size: 13.5px;
}

.identity:hover .email {
  color: var(--kal-primary);
}

.nickname {
  font-size: 12px;
  color: var(--kal-muted);
}

/* 与昵称同为次要信息，但带「备注：」前缀区分，避免两行灰字看不出差别 */
.note {
  font-size: 12px;
  color: var(--kal-muted);
}

/* 右上角这两个标签：去掉 a-tag 自带的右外边距，间距交给 .card-head 的 gap */
.status-tag,
.head-tag {
  margin: 0;
  flex: 0 0 auto;
}

/* 标签一律排在同一行：不换行，宽度不够时由分组标签让位 */
.tag-row {
  display: flex;
  flex-wrap: nowrap;
  gap: 4px 0;
  min-width: 0;
}

/* 订阅、登录方式这些标签内容固定且短，不参与收缩 */
.tag-row > * {
  flex: 0 0 auto;
}

/*
 * 分组名是用户自己填的，长度不可控，所以让它独自承担收缩：
 * 能排下就完整显示（不设固定上限，剩余宽度全归它用），
 * 排不下才截断成省略号，全名看悬停提示。
 */
.tag-row .group-tag {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.usage-block {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 12px;
  border-radius: 12px;
  background: var(--kal-block-bg);
  cursor: pointer;
  transition: background 0.16s ease;
}

.usage-block:hover {
  background: var(--kal-code-bg);
}

.usage-head,
.usage-foot {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  font-size: 12.5px;
  gap: 8px;
}

.usage-title {
  display: flex;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
}

/* 更新时间是次要信息，字号更小，空间不足时省略 */
.usage-updated {
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.usage-percent {
  font-size: 20px;
  font-weight: 700;
  line-height: 1;
  flex: 0 0 auto;
}

.usage-percent small {
  font-size: 12px;
  font-weight: 700;
  margin-left: 1px;
}

/* 分段用量条 */
.usage-bars {
  display: flex;
  align-items: stretch;
  gap: 2px;
  height: 14px;
  margin: 8px 0 10px;
}

.bar {
  flex: 1 1 0;
  border-radius: 2px;
  background: var(--kal-bar-off);
  transition:
    background 0.2s ease,
    opacity 0.2s ease;
}

.bar.on {
  background: var(--bar-on);
}

.usage-number {
  font-weight: 600;
}

.usage-foot span:last-child {
  white-space: nowrap;
}

/* 额度明细 */
.quota-block {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  border-radius: 12px;
  background: var(--kal-block-bg);
}

.quota-row {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11.5px;
  line-height: 1.4;
}

.quota-label {
  flex: 0 0 auto;
  max-width: 90px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.quota-value {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.quota-expiry {
  flex: 0 0 auto;
  white-space: nowrap;
}

.dot {
  flex: 0 0 auto;
  width: 6px;
  height: 6px;
  border-radius: 50%;
}

/*
 * 报错行。高度被钉死成确定值：18（行高）+ 5 + 5（上下 padding）= 28px，
 * 再加上卡片的竖向间距，就是一张带报错的卡比同类卡高出的部分。
 * AccountsView 的 ERROR_LINE_HEIGHT 用的就是这个 28，改这里务必同步改那边，
 * 否则虚拟滚动算出的行高会和实际差一截。
 */
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
  cursor: help;
}

/* 卡片里一行截断，Tooltip 里要能完整换行展示（接口原始返回可能很长） */
.error-tip {
  white-space: pre-wrap;
  word-break: break-all;
}

.card-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  border-top: 1px solid var(--kal-border);
  padding: 6px 0;
  margin-top: auto;
}

.meta {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 2px 10px;
  font-size: 11.5px;
  line-height: 1.4;
}

.meta > span {
  white-space: nowrap;
}

.warn {
  color: #fa8c16;
}

.action-row {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 0;
}

.action-btn {
  width: 24px;
  min-width: 24px;
  height: 24px;
  padding: 0;
}

.action-btn :deep(.anticon) {
  font-size: 13px;
}

/* ============ 紧凑卡片 ============ */
/* 去掉额度明细那一块 */
.account-card.mode-compact .quota-block {
  display: none;
}

/*
 * 紧凑模式整体收紧竖向间距：12px → 8px。
 *
 * 这么做而不是给底部那排加负 margin：负 margin 会顶掉基类的
 * margin-top: auto，按钮就不再钉在卡片底边，富余高度会掉到按钮下面去。
 * 而 auto 会把新腾出来的空间照单全收，所以「加空间再抵掉」也没用 ——
 * 想缩小按钮上方的间距，只能真的把 gap 调小。
 *
 * 顺带一提：AccountsView 的行高计算按形态取这个 gap，改这里要同步改那边。
 */
.account-card.mode-compact {
  gap: 8px;
}

/* 内容本就压得紧，底部那条分隔线是多余的一道横线；自身上内边距也去掉 */
.account-card.mode-compact .card-foot {
  border-top: none;
  padding-top: 0;
}

/*
 * 用量块压成两行：百分比和柱状条同排，下面一行是总额 + 更新时间。
 * 「使用量」那行标题整行去掉。
 *
 * display: contents 把 .usage-head 这层容器从布局里摘掉，它的两个子元素
 * 直接变成 .usage-block 的 flex 项，再用 order 排位 —— 三种形态因此还是
 * 共用一份 DOM，不必为紧凑模式单写一套结构。
 */
.account-card.mode-compact .usage-block,
.account-card.mode-list .usage-block {
  flex-direction: row;
  flex-wrap: wrap;
  align-items: center;
  column-gap: 8px;
  /* 柱状条那排和下面的总额之间留口气，贴太近显挤 */
  row-gap: 8px;
}

.account-card.mode-compact .usage-head,
.account-card.mode-list .usage-head {
  display: contents;
}

.account-card.mode-compact .usage-title,
.account-card.mode-list .usage-title {
  display: none;
}

.account-card.mode-compact .usage-bars,
.account-card.mode-list .usage-bars {
  order: 1;
  flex: 1 1 auto;
  min-width: 60px;
  /* 竖排时靠外边距和上下拉开距离，横过来后由 column-gap 负责 */
  margin: 0;
}

.account-card.mode-compact .usage-percent,
.account-card.mode-list .usage-percent {
  order: 2;
  font-size: 16px;
}

/* 独占第二行，靠 space-between 让更新时间右对齐 */
.account-card.mode-compact .usage-foot,
.account-card.mode-list .usage-foot {
  order: 3;
  flex: 1 0 100%;
}

/* ============ 列表模式 ============ */
/*
 * 一条 = 四块：邮箱 | 标签 | 用量 | 功能区，标签那块顺带吃掉全部富余宽度。
 *
 * 用网格 + 容器查询，而不是 flex-wrap：
 * flex-wrap 只能从最后一个开始折行（功能区先掉下去），而我们要的顺序是
 * 「先掉标签，再掉用量，最后才掉功能区」—— 折行优先级和 DOM 顺序相反，
 * flex 表达不了。容器查询按卡片实际可用宽度分档，每档给一套网格摆位，
 * 于是各档之间只是重排，不会出现挤压变形或横向溢出。
 *
 * 查询的容器是虚拟滚动的单元格（见 AccountsView 里的 container-type），
 * 不用媒体查询是因为侧栏能折叠 —— 窗口宽度并不等于列表可用宽度。
 *
 * 各块宽度都用与内容无关的定值，只有标签那列是 1fr：
 * 每张卡片各自布局，只有确定值才能让各行的列位对齐，看起来像一张表。
 */
.account-card.mode-list {
  display: grid;
  /*
   * 邮箱 | 标签(吃掉富余) | 用量 | 功能区
   * 邮箱列定死 400px：富余宽度没用完时它不该跟着缩，否则窗口一变窄邮箱先被截。
   * 富余全部落在标签那一列（1fr），标签本身左对齐，多出来的宽度就是留白。
   */
  grid-template-columns: 400px minmax(190px, 1fr) 350px 320px;
  align-items: center;
  /* 块间留白靠列间距，不画分隔线 */
  column-gap: 18px;
  row-gap: 8px;
  padding: 8px 14px;
  border-radius: 12px;
}

/*
 * 每块都写死落位，不靠自动摆放。
 *
 * 这是「窄窗口下出现空白块」的根因：报错行在 DOM 里排在功能区前面，
 * 而它跨满整行、只能落到第二行；自动摆放的游标不允许回退，
 * 于是紧跟其后的功能区被推到了第三行，第一行那格就空成一块底色。
 * 写死落位后只有报错行是自动摆放，落在最后一行，谁都不受它影响。
 */
.account-card.mode-list .card-head {
  grid-area: 1 / 1 / 2 / 2;
}

.account-card.mode-list .tag-row {
  grid-area: 1 / 2 / 2 / 3;
}

.account-card.mode-list .usage-block {
  grid-area: 1 / 3 / 2 / 4;
}

.account-card.mode-list .card-foot {
  grid-area: 1 / 4 / 2 / 5;
}

/*
 * 报错行铺满整宽、自己占一行。
 * 不写 grid-row，交给自动摆放：它横跨所有列，挤不进任何已排满的行，
 * 于是总落在最后一行 —— 这样每档布局都不必单独指定它的行号。
 */
.account-card.mode-list .error-line {
  grid-column: 1 / -1;
  min-width: 0;
  padding: 3px 8px;
}

/*
 * 分档阈值按「单元格宽度」算，卡片内容宽度还要再减去 28px 内边距和 2px 边框。
 * 1344 = 内容 1314（400 + 190 + 350 + 320 + 三道间距 54）+ 30，
 * 再窄第一行就装不下四块，或者标签会被 overflow 裁掉半个。
 */
/* 窄一档：标签掉到第二行铺满整宽，第一行留「邮箱 | 富余 | 用量 | 功能区」 */
@container (max-width: 1343px) {
  .account-card.mode-list {
    grid-template-columns: 400px minmax(0, 1fr) 350px 320px;
  }

  .account-card.mode-list .tag-row {
    grid-area: 2 / 1 / 3 / -1;
    margin-left: 0;
  }
}

/*
 * 再窄一档（内容 1124 = 400 + 350 + 320 + 三道间距 54）：功能区掉到第二行。
 * 右侧那一列变成「用量在上、按钮在下」—— 用量是要读的数据，
 * 按钮是操作，读的东西放上面更顺；标签铺在邮箱 + 富余那两列下面。
 *
 * 邮箱列写成 minmax(0, 400px) 而不是硬 400：宽度够时和上面两档一样是 400，
 * 不够时才让它让步。写死 400 的话，这一档的下限会顶到单元格 786px，
 * 而最窄窗口（940，单元格约 734px）就会掉进最后那个竖排兜底档。
 * 右列仍是 320（够放 Token 文案 + 9 个按钮），不跟着上面的 350 走。
 */
@container (max-width: 1153px) {
  .account-card.mode-list {
    grid-template-columns: minmax(0, 400px) minmax(0, 1fr) 320px;
  }

  /* 用量留在第一行第三列（列宽变成 320，块跟着铺满） */
  .account-card.mode-list .card-foot {
    grid-area: 2 / 3 / 3 / 4;
  }

  .account-card.mode-list .tag-row {
    grid-area: 2 / 1 / 3 / 3;
  }
}

/* 兜底档：窗口 940（主进程 minWidth）时单元格约 734px，正常到不了这里，逐块竖排以防万一 */
@container (max-width: 705px) {
  .account-card.mode-list {
    grid-template-columns: minmax(0, 1fr);
  }

  .account-card.mode-list .card-head,
  .account-card.mode-list .tag-row,
  .account-card.mode-list .usage-block,
  .account-card.mode-list .card-foot {
    grid-area: auto / 1 / auto / -1;
  }
}

/* 长条不做上浮：几十行同时排着，逐行抬起会显得很闹 */
.account-card.mode-list:hover {
  transform: none;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.06);
}

/* 第一块：勾选框 + 邮箱 / 昵称 / 备注 + 使用中 / 状态标签 */
.account-card.mode-list .card-head {
  min-width: 0;
  align-items: center;
  gap: 8px;
}

/*
 * 标签段：一行放不下就截断，不换行撑高整条。
 * 左右各留一点边距，把「身份 + 状态」和「订阅 / 登录方式 / 分组」两组分开，
 * 否则状态标签和订阅标签紧挨着，看起来像同一组。
 */
.account-card.mode-list .tag-row {
  flex-wrap: nowrap;
  min-width: 0;
  margin-left: 6px;
  overflow: hidden;
}

/* 用量段：宽度由所在列决定，内部排布与紧凑模式共用 */
.account-card.mode-list .usage-block {
  min-width: 0;
  flex-direction: row;
  align-items: center;
  gap: 10px;
  padding: 6px 10px;
  border-radius: 10px;
}

/*
 * 柱状条比紧凑模式再矮一点，整条看着更扁。
 * 其余排布（两行、order、display: contents）都走上面和紧凑模式共用的那几条 ——
 * 之前列表模式是「百分比 56px + 柱状条 + 总额 100px」的一行三段定宽，
 * 数值一长就顶到隔壁，换成两行后宽度自适应，不会错位。
 */
.account-card.mode-list .usage-bars {
  height: 10px;
}

.account-card.mode-list .quota-block {
  display: none;
}

/*
 * 第四块：Token 剩余时间 + 动作按钮。列宽定死 320px（Token 文案约 95 + 按钮 216 + 间距），
 * 靠 space-between 把按钮钉在右缘 —— 定宽是为了让每一行的按钮竖着成列，
 * 用内容宽度的话「Token 49 分钟」和「Token 已过期」会让按钮左右错开几像素。
 */
.account-card.mode-list .card-foot {
  border-top: none;
  padding: 0;
  margin-top: 0;
  gap: 10px;
}

.account-card.mode-list .meta {
  flex: 0 0 auto;
}
</style>
