<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, type Component } from 'vue'
import { useRouter } from 'vue-router'
import { APP_TAGLINE } from '@/utils/appInfo'
import {
  CheckCircleOutlined,
  KeyOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  TeamOutlined,
  ThunderboltOutlined,
  WarningOutlined
} from '@ant-design/icons-vue'
import kiroLogo from '@/assets/kiro-logo.png'
import { useAccountsStore } from '@/stores/accounts'
import { useSettingsStore } from '@/stores/settings'
import { useKeysStore } from '@/stores/keys'
import {
  IDP_META,
  KEY_STATUS_META,
  STATUS_META,
  formatCheckedAt,
  formatCreditsPair,
  formatDateTime,
  subscriptionLabel,
  subscriptionMeta,
  tokenLife
} from '@/utils/format'
import { groupsOfItem } from '@/utils/groups'
import { now as clock } from '@/utils/now'
import { displayEmail, displayKey, displayName as accountName, displayNote } from '@/utils/display'
import { keyDaysRemaining, keyIssue, keyStatusKey, keyTier, keyUsageRatio } from '@/utils/keyEntry'
import { maskGroupName, usePrivacy } from '@/composables/usePrivacy'
import { regionLabel } from '@shared/regions'
import HomeActiveCard, { type HomeCardData } from '@/components/home/HomeActiveCard.vue'
import QuotaStatsCard, { sumQuota } from '@/components/home/QuotaStatsCard.vue'
import AccountDetailDrawer from '@/components/accounts/AccountDetailDrawer.vue'
import ApiKeyDetailDrawer from '@/components/keys/ApiKeyDetailDrawer.vue'
import ApiKeyTestModal from '@/components/keys/ApiKeyTestModal.vue'
import type { AccountFilter, AccountLoginAction } from '@/stores/accounts'
import type { Account, KeyEntry } from '@shared/types'

const router = useRouter()
const accountsStore = useAccountsStore()
const keysStore = useKeysStore()
const settingsStore = useSettingsStore()

const precision = computed(() => settingsStore.settings.usagePrecision)
const active = computed(() => accountsStore.activeAccount)

/**
 * 凭据统计：账号与 API Key 合在一起算，回收站里的都不计。
 * 正常 / 异常两端口径各自沿用列表页：账号看 status（异常 = 异常 + 封禁），
 * Key 看 keyStatusKey（异常 = 同步或测活报错）；未检查、已过期的两边都不算进这两项。
 */
const credentialStats = computed(() => {
  let accountNormal = 0
  let accountAbnormal = 0
  for (const a of accountsStore.liveAccounts) {
    if (a.status === 'active') accountNormal++
    else if (a.status === 'error' || a.status === 'banned') accountAbnormal++
  }
  let keyNormal = 0
  let keyAbnormal = 0
  for (const entry of keysStore.liveKeys) {
    const s = keyStatusKey(entry)
    if (s === 'normal') keyNormal++
    else if (s === 'error') keyAbnormal++
  }
  const accounts = accountsStore.liveAccounts.length
  const keys = keysStore.liveKeys.length
  return { accounts, keys, accountNormal, accountAbnormal, keyNormal, keyAbnormal }
})

interface StatCard {
  key: string
  label: string
  value: number
  icon: Component
  color: string
  onClick?: () => void
}

const statCards = computed<StatCard[]>(() => {
  const s = credentialStats.value
  return [
    {
      key: 'total',
      label: '凭据总数',
      value: s.accounts + s.keys,
      icon: SafetyCertificateOutlined,
      color: '#722ed1'
    },
    {
      key: 'accounts',
      label: '账号数',
      value: s.accounts,
      icon: TeamOutlined,
      color: '#1677ff',
      onClick: () => jumpToAccounts({})
    },
    {
      key: 'keys',
      label: 'API Key 数',
      value: s.keys,
      icon: KeyOutlined,
      color: '#13c2c2',
      onClick: () => void router.push({ name: 'keys' })
    },
    {
      key: 'normal',
      label: '正常',
      value: s.accountNormal + s.keyNormal,
      icon: CheckCircleOutlined,
      color: '#52c41a'
    },
    {
      key: 'abnormal',
      label: '异常',
      value: s.accountAbnormal + s.keyAbnormal,
      icon: WarningOutlined,
      color: '#ff4d4f'
    }
  ]
})

/** 账户额度统计：只统计状态正常的账号，回收站里的不计 */
const accountQuota = computed(() =>
  sumQuota(
    accountsStore.liveAccounts
      .filter((a) => a.status === 'active')
      .map((a) => ({ limit: a.usage.limit ?? 0, used: a.usage.current ?? 0 }))
  )
)

/** API Key 额度统计：不算报错的 Key（额度数据不可信），回收站里的不计 */
const keyQuota = computed(() =>
  sumQuota(
    keysStore.liveKeys
      .filter((entry) => keyStatusKey(entry) !== 'error')
      .map((entry) => ({ limit: entry.totalCredits ?? 0, used: entry.usedCredits ?? 0 }))
  )
)

// ============ 当前使用：IDE 账号 / CLI 账号 / 网关 API Key ============
const activeCli = computed(() => accountsStore.activeAccountCli)
/** 网关开启且选中的 Key；网关没开时为空 */
const gatewayKey = computed(() => keysStore.activeKey ?? null)

const { maskAccount, maskKey } = usePrivacy()

/** Token 剩余有效期，与账号卡片同一口径：不足 10 分钟标黄 */
function tokenFoot(account: Account): { text: string; warn: boolean } {
  const life = tokenLife(account.credentials.expiresAt, 'round')
  if (life.state === 'unknown') return { text: 'Token 未知', warn: true }
  if (life.state === 'expired') return { text: 'Token 已过期', warn: true }
  if (life.state === 'minutes') return { text: `Token ${life.minutes} 分钟`, warn: life.minutes < 10 }
  return { text: `Token ${life.hours} 小时`, warn: false }
}

/** 分组标签：跟随打码设置 */
function groupTags(names: string[], masked: boolean): HomeCardData['tags'] {
  return names.map((name) => ({
    text: masked ? maskGroupName() : name,
    color: 'purple',
    title: masked ? undefined : `分组：${name}`
  }))
}

/**
 * 账号卡片的数据，字段与账户管理「卡片紧凑」一一对应。
 * 两端同号时两张卡都挂上 IDE / CLI 两个使用中标签，一眼看出是同一个号。
 */
function accountCard(account: Account | null): HomeCardData | null {
  if (!account) return null
  const usage = account.usage
  const status = STATUS_META[account.status]
  const headTags: HomeCardData['headTags'] = []
  if (account.isActive) headTags.push({ text: 'IDE 使用中', color: 'green' })
  if (account.isActiveCli) headTags.push({ text: 'CLI 使用中', color: 'blue' })
  headTags.push({ text: status.text, color: status.color })
  const foot = tokenFoot(account)
  const days = account.subscription.daysRemaining
  return {
    primary: displayEmail(account.email, maskAccount('email')),
    secondary: accountName(account, maskAccount('nickname')),
    note: displayNote(account.note, maskAccount('note')),
    headTags,
    tags: [
      {
        text: subscriptionLabel(account.subscription),
        color: subscriptionMeta(account.subscription.type).color
      },
      { text: IDP_META[account.idp].text, color: IDP_META[account.idp].color },
      ...groupTags(
        groupsOfItem(account, accountsStore.groups).map((g) => g.name),
        maskAccount('group')
      )
    ],
    ratio: usage.percentUsed || 0,
    usageText: formatCreditsPair(usage.current, usage.limit, precision.value),
    updatedText: formatCheckedAt(account.lastCheckedAt, clock.value),
    updatedTitle: `用量与积分更新于 ${formatDateTime(account.lastCheckedAt)}`,
    footText: foot.text,
    footWarn: foot.warn,
    footExtra: days != null ? `订阅剩 ${days} 天` : undefined,
    // IDE 使用中优先绿边，与账号列表里两端同号时的规则一致
    borderColor: account.isActive ? '#52c41a' : '#1677ff',
    error: account.lastError
  }
}

const ideCard = computed(() => accountCard(active.value))
const cliCard = computed(() => accountCard(activeCli.value))

/** 网关 Key 卡片：对应 API Key 管理「卡片紧凑」，第一行 Key、第二行邮箱、第三行备注 */
const keyCard = computed<HomeCardData | null>(() => {
  const entry = gatewayKey.value
  if (!entry) return null
  const issue = keyIssue(entry)
  const status = KEY_STATUS_META[issue ? 'error' : entry.lastCheckedAt ? 'normal' : 'unchecked']
  const days = keyDaysRemaining(entry)
  return {
    primary: displayKey(entry.key, maskKey('apiKey')),
    secondary: entry.email ? displayEmail(entry.email, maskKey('email')) : undefined,
    note: displayNote(entry.note, maskKey('note')),
    headTags: [
      { text: '网关使用中', color: 'purple' },
      { text: status.text, color: status.color }
    ],
    tags: [
      { text: entry.subscription || '等级未知', color: subscriptionMeta(keyTier(entry)).color },
      { text: regionLabel(entry.region), color: 'default' },
      ...groupTags(
        groupsOfItem(entry, keysStore.groups).map((g) => g.name),
        maskKey('group')
      )
    ],
    ratio: keyUsageRatio(entry),
    usageText: formatCreditsPair(entry.usedCredits, entry.totalCredits, precision.value),
    updatedText: entry.lastCheckedAt ? formatCheckedAt(entry.lastCheckedAt, clock.value) : '尚未同步',
    updatedTitle: entry.lastCheckedAt
      ? `用量与积分更新于 ${formatDateTime(entry.lastCheckedAt)}`
      : undefined,
    footText: days != null ? `额度 ${days} 天后重置` : '重置时间未知',
    borderColor: '#722ed1',
    error: issue || undefined
  }
})

// ============ 详情抽屉 ============
const accountDetail = ref<Account | null>(null)
const keyDetail = ref<KeyEntry | null>(null)
/** 抽屉里点在线测活：弹窗叠在抽屉上，抽屉保持打开 */
const keyTestTarget = ref<KeyEntry | null>(null)

/** 抽屉里的「修改备注」在首页没有对应弹窗，跳到 API Key 管理页处理 */
/**
 * 首页抽屉里的登录 / 退出：交给账户管理页执行（那里有安装检测、切号结果弹窗与卡片加载态），
 * 两处行为与状态完全一致。
 */
function loginFromHome(action: AccountLoginAction, account: Account): void {
  accountDetail.value = null
  accountsStore.requestAccountLogin(account.id, action)
  void router.push({ name: 'accounts' })
}

function goKeys(): void {
  keyDetail.value = null
  void router.push({ name: 'keys' })
}

/** 两端一起重新检测；CLI 要跑一次 kiro-cli whoami，较慢，所以显示加载态 */
const detecting = ref(false)
async function redetect(): Promise<void> {
  if (detecting.value) return
  detecting.value = true
  try {
    await Promise.all([accountsStore.syncActiveFromIde(), accountsStore.syncActiveFromCli()])
  } finally {
    detecting.value = false
  }
}

// ============ 问候语 ============
/** 按本地时间分段问候；每分钟校一次，窗口挂着跨过时段也会跟着变 */
const now = ref(new Date())
let greetTimer: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  greetTimer = setInterval(() => (now.value = new Date()), 60_000)
})
onUnmounted(() => {
  if (greetTimer) clearInterval(greetTimer)
})
const greeting = computed(() => {
  const h = now.value.getHours()
  if (h < 5) return '夜深了'
  if (h < 9) return '早上好'
  if (h < 12) return '上午好'
  if (h < 14) return '中午好'
  if (h < 18) return '下午好'
  return '晚上好'
})

function jumpToAccounts(patch: Partial<AccountFilter>): void {
  // 从首页点过去是「给我看这批账号」，遗留的分组筛选与批量查询会把结果挡掉，一并清空
  accountsStore.applyFilter({ groupIds: [], queries: [], ...patch })
  void router.push({ name: 'accounts' })
}

</script>

<template>
  <div class="home">
    <!-- 欢迎横幅 -->
    <section class="hero">
      <span class="hero-blob hero-blob-a" />
      <span class="hero-blob hero-blob-b" />
      <div class="hero-main">
        <img class="hero-logo" :src="kiroLogo" alt="Kiro Manager Lite" />
        <div>
          <h1 class="hero-title">{{ greeting }}，欢迎使用 Kiro Manager Lite</h1>
          <p class="hero-sub muted">{{ APP_TAGLINE }}</p>
        </div>
      </div>
    </section>

    <!-- 统计卡片 -->
    <div class="stat-grid">
      <a-card
        v-for="card in statCards"
        :key="card.key"
        size="small"
        :hoverable="!!card.onClick"
        class="stat-card"
        :class="{ 'is-static': !card.onClick }"
        :body-style="{ padding: '16px' }"
        @click="card.onClick?.()"
      >
        <div class="stat-row">
          <span class="icon-box" :style="{ background: `${card.color}1a`, color: card.color }">
            <component :is="card.icon" />
          </span>
          <div class="stat-text">
            <div class="stat-label muted">{{ card.label }}</div>
            <div class="stat-value">{{ card.value }}</div>
          </div>
        </div>
      </a-card>
    </div>

    <!-- 额度统计：账户与 API Key 左右排列，两边都没有数据时整行不显示 -->
    <div v-if="accountQuota.validCount || keyQuota.validCount" class="quota-grid">
      <QuotaStatsCard
        title="账户额度统计"
        :icon="TeamOutlined"
        color="#1677ff"
        noun="账号"
        :stats="accountQuota"
        :precision="precision"
      />
      <QuotaStatsCard
        title="API Key 额度统计"
        :icon="KeyOutlined"
        color="#13c2c2"
        noun="API Key"
        :stats="keyQuota"
        :precision="precision"
      />
    </div>

    <!-- 当前使用账号 -->
    <a-card size="small" class="active-card section-card">
      <template #title>
        <span class="card-title">
          <span class="icon-box sm" style="background: rgba(124, 58, 237, 0.12); color: #7c3aed">
            <ThunderboltOutlined />
          </span>
          当前使用
        </span>
      </template>

      <template #extra>
        <a-button size="small" :loading="detecting" @click="redetect">
          <template #icon><ReloadOutlined /></template>
          重新检测
        </a-button>
      </template>

      <!-- IDE 与 CLI 各占一栏；同一个号两边都在用时合成一栏，顶部同时显示两个使用中标签 -->
      <!-- 一排固定三张：IDE 账号、CLI 账号、网关 API Key；点卡片打开对应详情抽屉 -->
      <div class="active-grid">
        <HomeActiveCard
          title="Kiro IDE"
          :data="ideCard"
          empty="Kiro IDE 当前登录的不是已管理的账号"
          empty-action="去账户管理"
          @open="accountDetail = active"
          @empty="router.push({ name: 'accounts' })"
        />
        <HomeActiveCard
          title="Kiro CLI · Crew"
          :data="cliCard"
          empty="Kiro CLI / Crew 未登录已管理的账号"
          empty-action="去账户管理"
          @open="accountDetail = activeCli"
          @empty="router.push({ name: 'accounts' })"
        />
        <HomeActiveCard
          title="Kiro API Key（网关）"
          :data="keyCard"
          empty="本地网关未开启，或还没有选中 API Key"
          empty-action="去 API Key 管理"
          @open="keyDetail = gatewayKey"
          @empty="router.push({ name: 'keys' })"
        />
      </div>
    </a-card>

    <AccountDetailDrawer
      v-if="accountDetail"
      :account="accountDetail"
      @close="accountDetail = null"
      @login="loginFromHome"
    />
    <ApiKeyDetailDrawer
      v-if="keyDetail"
      :key-entry="keyDetail"
      @close="keyDetail = null"
      @test="(entry) => (keyTestTarget = entry)"
      @edit="goKeys"
      @select="keyDetail = null"
    />
    <ApiKeyTestModal v-if="keyTestTarget" :key-entry="keyTestTarget" @close="keyTestTarget = null" />
  </div>
</template>

<style scoped>
.home {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

/* 横幅 */
.hero {
  position: relative;
  overflow: hidden;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 20px 24px;
  border: 1px solid var(--kal-border);
  border-radius: 12px;
  background: var(--kal-card-bg);
}

.hero-blob {
  position: absolute;
  border-radius: 50%;
  filter: blur(36px);
  background: radial-gradient(circle, var(--kal-primary), transparent 70%);
  opacity: 0.18;
  pointer-events: none;
}

.hero-blob-a {
  top: -40px;
  right: -20px;
  width: 140px;
  height: 140px;
}

.hero-blob-b {
  bottom: -50px;
  left: -10px;
  width: 120px;
  height: 120px;
}

.hero-main {
  position: relative;
  display: flex;
  align-items: center;
  gap: 16px;
  min-width: 0;
}

.hero-logo {
  height: 48px;
  width: 48px;
  flex: 0 0 auto;
  border-radius: 12px;
  object-fit: cover;
}

.hero-title {
  margin: 0;
  font-size: 20px;
  font-weight: 700;
  color: var(--kal-primary);
}

.hero-sub {
  margin: 3px 0 0;
  line-height: 1.7;
  font-size: 13px;
}

/* 统计卡 */
.stat-card {
  cursor: pointer;
  transition: background 0.16s ease, border-color 0.16s ease;
}

/*
 * hoverable 默认阴影偏重，压淡一档，改用一层很浅的主题色底做可点击反馈。
 * color-mix 让底色随主题色变化，不写死某个具体颜色。
 */
/* 合计类的卡片不跳转，不给可点的手势和悬停反馈 */
.stat-card.is-static {
  cursor: default;
}

.stat-card:not(.is-static):hover {
  box-shadow: var(--kal-hover-shadow);
  border-color: color-mix(in srgb, var(--kal-primary) 32%, var(--kal-border));
  background: color-mix(in srgb, var(--kal-primary) 8%, var(--kal-card-bg));
}

.stat-row {
  display: flex;
  align-items: center;
  gap: 12px;
}

.icon-box {
  flex: 0 0 auto;
  width: 38px;
  height: 38px;
  border-radius: 10px;
  display: grid;
  place-items: center;
  font-size: 18px;
}

.icon-box.sm {
  width: 26px;
  height: 26px;
  border-radius: 8px;
  font-size: 14px;
}

.stat-value {
  font-size: 20px;
  font-weight: 700;
  line-height: 1.1;
  font-variant-numeric: tabular-nums;
}

/* 标题在上、数字在下：标题字号放大一档，数字仍是视觉重点 */
.stat-label {
  font-size: 14px;
  line-height: 1.4;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.stat-text {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

/* 一排五张：首页统计卡固定五列，窗口窄时再退 */
.home .stat-grid {
  grid-template-columns: repeat(5, minmax(0, 1fr));
}
@media (max-width: 900px) {
  .home .stat-grid { grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); }
}

/* 卡片标题 */
.card-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
}

.title-hint {
  font-size: 12px;
  font-weight: 400;
}

/* 额度统计 / 当前使用账号：small 卡片的标题栏默认只有 38px 高、上下几乎贴边，这里放松一点 */
.section-card :deep(.ant-card-head) {
  min-height: 52px;
  padding-top: 10px;
  padding-bottom: 10px;
}
.section-card :deep(.ant-card-body) {
  padding-top: 16px;
}

/* 额度统计：左右两张等宽，窗口窄时上下排列 */
.quota-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}
@media (max-width: 900px) {
  .quota-grid { grid-template-columns: 1fr; }
}

/* 当前使用：一排固定三张，窗口很窄时才退成一列 */
.active-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 16px;
}
@media (max-width: 760px) {
  .active-grid { grid-template-columns: 1fr; }
}
</style>
