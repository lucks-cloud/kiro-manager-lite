<script setup lang="ts">
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import {
  BarChartOutlined,
  ClockCircleOutlined,
  CheckCircleOutlined,
  ExclamationCircleOutlined,
  LineChartOutlined,
  RightOutlined,
  RiseOutlined,
  SafetyOutlined,
  StopOutlined,
  SwapOutlined,
  TeamOutlined,
  ThunderboltOutlined,
  WarningOutlined
} from '@ant-design/icons-vue'
import kiroLogo from '@/assets/kiro-logo.png'
import { useAccountsStore } from '@/stores/accounts'
import { useSettingsStore } from '@/stores/settings'
import {
  IDP_META,
  subscriptionMeta,
  formatCredits,
  formatCreditsPair,
  formatDate,
  relativeTime,
  subscriptionLabel,
  tokenLife
} from '@/utils/format'
import { displayEmail as maskedEmail, displayName as accountName } from '@/utils/display'
import type { AccountFilter } from '@/stores/accounts'
import type { Account } from '@shared/types'

/** 额度告急阈值（0-1） */
const QUOTA_WARN_RATIO = 0.9
/** 即将到期阈值（天） */
const EXPIRE_WARN_DAYS = 7

const router = useRouter()
const accountsStore = useAccountsStore()
const settingsStore = useSettingsStore()

const precision = computed(() => settingsStore.settings.usagePrecision)
const stats = computed(() => accountsStore.stats)
const active = computed(() => accountsStore.activeAccount)

const statCards = computed(() => [
  {
    key: 'total',
    label: '总账号数',
    value: stats.value.total,
    icon: TeamOutlined,
    color: '#1677ff',
    onClick: () => jumpToAccounts({})
  },
  {
    key: 'active',
    label: '正常账号',
    value: stats.value.byStatus.active,
    icon: CheckCircleOutlined,
    color: '#52c41a',
    onClick: () => jumpToAccounts({ statuses: ['active'] })
  },
  {
    key: 'abnormal',
    label: '异常 / 封禁',
    value: stats.value.byStatus.error + stats.value.byStatus.banned,
    icon: WarningOutlined,
    color: '#ff4d4f',
    onClick: () => jumpToAccounts({ statuses: ['error', 'banned'] })
  },
  {
    key: 'expiring',
    label: `即将到期（≤${EXPIRE_WARN_DAYS}天）`,
    value: stats.value.expiringSoon,
    icon: ClockCircleOutlined,
    color: '#faad14',
    onClick: () => jumpToAccounts({ daysRemainingMax: EXPIRE_WARN_DAYS })
  }
])

/** 告警聚合：一次遍历分出封禁 / 异常 / 即将到期 / 额度告急 */
const warnings = computed(() => {
  const banned: Account[] = []
  const error: Account[] = []
  const expiring: Account[] = []
  const quotaHigh: Account[] = []
  for (const a of accountsStore.accounts) {
    if (a.status === 'banned') {
      banned.push(a)
      continue
    }
    if (a.status === 'error') error.push(a)
    if ((a.subscription.daysRemaining ?? Number.POSITIVE_INFINITY) <= EXPIRE_WARN_DAYS) {
      expiring.push(a)
    }
    if (a.status === 'active' && a.usage.limit > 0 && (a.usage.percentUsed || 0) >= QUOTA_WARN_RATIO) {
      quotaHigh.push(a)
    }
  }
  return { banned, error, expiring, quotaHigh }
})

const warnRows = computed(() =>
  [
    {
      key: 'banned',
      list: warnings.value.banned,
      icon: StopOutlined,
      color: '#ff4d4f',
      label: '已封禁',
      onClick: () => jumpToAccounts({ statuses: ['banned'] })
    },
    {
      key: 'error',
      list: warnings.value.error,
      icon: ExclamationCircleOutlined,
      color: '#ff7a45',
      label: '状态异常',
      onClick: () => jumpToAccounts({ statuses: ['error'] })
    },
    {
      key: 'expiring',
      list: warnings.value.expiring,
      icon: ClockCircleOutlined,
      color: '#faad14',
      label: `即将到期（≤${EXPIRE_WARN_DAYS}天）`,
      onClick: () => jumpToAccounts({ daysRemainingMax: EXPIRE_WARN_DAYS })
    },
    {
      key: 'quota',
      list: warnings.value.quotaHigh,
      icon: ThunderboltOutlined,
      color: '#fa8c16',
      label: `额度告急（≥${Math.round(QUOTA_WARN_RATIO * 100)}%）`,
      onClick: () => jumpToAccounts({ usageMin: QUOTA_WARN_RATIO })
    }
  ].filter((row) => row.list.length > 0)
)

/**
 * 额度统计：只统计正常且有额度的账号。
 *
 * 可用额度必须**逐账号先 clamp 再求和**，不能用「总额度 − 总已用」：
 * 账号降档后 limit 会跟着变小（比如原本 2000 的号用掉 1900，之后掉成 50 积分的普通号），
 * 这一个号就贡献 −1850，直接把汇总值拖成负数——而实际上它的可用额度是 0，不是负的。
 * 同理进度条按 min(已用, 额度) 累加，percentUsed 天然落在 0~100，不会出现「已超额」的假象。
 */
const usageStats = computed(() => {
  let totalLimit = 0
  let totalUsed = 0
  /** 计入进度的已用量：单账号不超过它自己的额度 */
  let effectiveUsed = 0
  /** 可用额度：Σ max(0, 额度 − 已用) */
  let available = 0
  /** 已用超过当前额度的账号数，多半是降过档 */
  let overQuotaCount = 0
  let validAccountCount = 0

  for (const a of accountsStore.accounts) {
    if (a.status !== 'active') continue
    const limit = a.usage.limit ?? 0
    if (limit <= 0) continue
    const used = a.usage.current ?? 0

    totalLimit += limit
    totalUsed += used
    effectiveUsed += Math.min(used, limit)
    available += Math.max(0, limit - used)
    if (used > limit) overQuotaCount++
    validAccountCount++
  }

  return {
    totalLimit,
    totalUsed,
    available,
    /** 已用超出各自额度的部分合计，仅用于提示 */
    excess: totalUsed - effectiveUsed,
    percentUsed: totalLimit > 0 ? (effectiveUsed / totalLimit) * 100 : 0,
    overQuotaCount,
    validAccountCount
  }
})

/** 可用额度见底时标红 */
const noQuotaLeft = computed(
  () => usageStats.value.validAccountCount > 0 && usageStats.value.available <= 0
)

/** 使用率文案：开启两位小数时保留 2 位，否则 1 位 */
const percentText = computed(() => usageStats.value.percentUsed.toFixed(precision.value ? 2 : 1))

const usageBarColor = computed(() => {
  const p = usageStats.value.percentUsed
  if (p > 100) return '#f5222d'
  if (p >= 80) return '#fa8c16'
  if (p >= 50) return '#fadb14'
  return '#52c41a'
})

/** 当前账号 Token 剩余时间：越紧张颜色越警示 */
const tokenState = computed(() => {
  const life = tokenLife(active.value?.credentials.expiresAt)
  switch (life.state) {
    case 'unknown':
      return { text: '未知', color: 'var(--kal-muted)' }
    case 'expired':
      return { text: '已过期', color: '#ff4d4f' }
    case 'minutes':
      return { text: `${life.minutes} 分钟`, color: '#faad14' }
    default:
      return { text: `${life.hours} 小时`, color: '#52c41a' }
  }
})

const activeUsagePercent = computed(() => {
  const usage = active.value?.usage
  if (!usage || !usage.limit) return 0
  return Math.min((usage.current / usage.limit) * 100, 100)
})

const activeUsageColor = computed(() => {
  const p = (active.value?.usage.percentUsed ?? 0) * 100
  if (p > 80) return '#ff4d4f'
  if (p > 50) return '#faad14'
  return '#52c41a'
})

const quotaDetails = computed(() => {
  const usage = active.value?.usage
  if (!usage) return []
  const rows: { key: string; color: string; label: string; value: string; extra?: string }[] = []
  const p = precision.value
  if (usage.baseLimit) {
    rows.push({
      key: 'base',
      color: '#1677ff',
      label: '基础额度',
      value: formatCreditsPair(usage.baseCurrent ?? 0, usage.baseLimit, p)
    })
  }
  if (usage.freeTrialLimit) {
    rows.push({
      key: 'trial',
      color: '#722ed1',
      label: '试用额度',
      value: formatCreditsPair(usage.freeTrialCurrent ?? 0, usage.freeTrialLimit, p),
      extra: usage.freeTrialExpiry ? `至 ${formatDate(usage.freeTrialExpiry)}` : undefined
    })
  }
  for (const bonus of usage.bonuses ?? []) {
    rows.push({
      key: `bonus-${bonus.code}`,
      color: '#13c2c2',
      label: bonus.name,
      value: formatCreditsPair(bonus.current, bonus.limit, p),
      extra: bonus.expiresAt ? `至 ${formatDate(bonus.expiresAt)}` : undefined
    })
  }
  return rows
})

/** 当前账号显示名，模板里多处复用 */
const activeName = computed(() => (active.value ? accountName(active.value, privacy.value) : ''))

const recent = computed(() =>
  [...accountsStore.accounts].sort((a, b) => (b.lastUsedAt || 0) - (a.lastUsedAt || 0)).slice(0, 5)
)

const tips = [
  '点击左侧「账户管理」可以查看和管理所有账号',
  '在账号卡片上点击切换图标可以一键写入 Kiro IDE',
  '开启「自动刷新」后，即将过期的 Token 会自动续期',
  '使用「隐私模式」可以隐藏邮箱等敏感信息'
]

const privacy = computed(() => settingsStore.settings.privacyMode)

function displayEmail(email: string): string {
  return maskedEmail(email, privacy.value)
}

function displayName(account: Account): string {
  return accountName(account, privacy.value)
}

function jumpToAccounts(patch: Partial<AccountFilter>): void {
  accountsStore.applyFilter(patch)
  void router.push({ name: 'accounts' })
}

function previewOf(list: Account[]): string {
  const head = list
    .slice(0, 3)
    .map((a) => displayName(a))
    .join('、')
  return list.length > 3 ? `${head} 等 ${list.length} 个` : head
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
          <h1 class="hero-title">欢迎使用 Kiro Manager Lite</h1>
          <p class="hero-sub muted">管理你的 Kiro IDE 账号，一键切换，高效开发</p>
        </div>
      </div>
    </section>

    <!-- 统计卡片 -->
    <div class="stat-grid">
      <a-card
        v-for="card in statCards"
        :key="card.key"
        size="small"
        hoverable
        class="stat-card"
        :body-style="{ padding: '16px' }"
        @click="card.onClick"
      >
        <div class="stat-row">
          <span class="icon-box" :style="{ background: `${card.color}1a`, color: card.color }">
            <component :is="card.icon" />
          </span>
          <div>
            <div class="stat-value">{{ card.value }}</div>
            <div class="stat-label muted">{{ card.label }}</div>
          </div>
        </div>
      </a-card>
    </div>

    <!-- 需要关注 -->
    <a-card v-if="warnRows.length" size="small" class="warn-card">
      <template #title>
        <span class="card-title">
          <span class="icon-box sm" style="background: rgba(250, 173, 20, 0.12); color: #faad14">
            <WarningOutlined />
          </span>
          需要关注
          <span class="muted title-hint">点击查看受影响的账号</span>
        </span>
      </template>
      <button v-for="row in warnRows" :key="row.key" class="warn-row" type="button" @click="row.onClick">
        <span class="icon-box sm" :style="{ background: `${row.color}1a`, color: row.color }">
          <component :is="row.icon" />
        </span>
        <span class="warn-count">{{ row.list.length }}</span>
        <span class="warn-label">{{ row.label }}</span>
        <span class="warn-preview muted">{{ previewOf(row.list) }}</span>
        <RightOutlined class="muted" />
      </button>
    </a-card>

    <!-- 额度统计 -->
    <a-card v-if="usageStats.validAccountCount" size="small">
      <template #title>
        <span class="card-title">
          <span class="icon-box sm" style="background: rgba(22, 119, 255, 0.12); color: #1677ff">
            <BarChartOutlined />
          </span>
          额度统计
          <span class="muted title-hint">基于 {{ usageStats.validAccountCount }} 个有效账号</span>
        </span>
      </template>

      <div class="tile-grid">
        <div class="tile">
          <div class="tile-head muted"><RiseOutlined style="color: #1677ff" /> 总额度</div>
          <div class="tile-value">{{ usageStats.totalLimit.toLocaleString() }}</div>
        </div>
        <div class="tile">
          <div class="tile-head muted"><LineChartOutlined style="color: #fa8c16" /> 已使用</div>
          <div class="tile-value">{{ formatCredits(usageStats.totalUsed, precision) }}</div>
        </div>
        <div class="tile">
          <div class="tile-head muted"><ThunderboltOutlined style="color: #52c41a" /> 可用额度</div>
          <div class="tile-value" :style="{ color: noQuotaLeft ? '#ff4d4f' : '#52c41a' }">
            {{ formatCredits(usageStats.available, precision) }}
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
            {{ formatCredits(usageStats.totalUsed, precision) }} /
            {{ usageStats.totalLimit.toLocaleString() }}
          </span>
          <span
            class="percent-pill"
            :style="{ background: `${usageBarColor}26`, color: usageBarColor }"
          >
            {{ percentText }}%
          </span>
        </span>
      </div>
      <a-progress
        :percent="usageStats.percentUsed"
        :stroke-color="usageBarColor"
        :show-info="false"
        :stroke-width="10"
      />
      <!--
        降档提示：已用量超过当前额度不是「超额消费」，而是额度变小了
        （原本高档位用掉的积分，掉档后比新额度还多）。这类账号可用额度按 0 计。
      -->
      <a-alert
        v-if="usageStats.overQuotaCount"
        type="warning"
        show-icon
        style="margin-top: 8px"
        :message="`${usageStats.overQuotaCount} 个账号的已用积分超过当前额度（合计 ${formatCredits(usageStats.excess, precision)}），多为订阅降档所致，其可用额度按 0 计算`"
      />
    </a-card>

    <!-- 当前使用账号 -->
    <a-card size="small" class="active-card">
      <template #title>
        <span class="card-title">
          <span class="icon-box sm" style="background: rgba(124, 58, 237, 0.12); color: #7c3aed">
            <ThunderboltOutlined />
          </span>
          当前使用账号
        </span>
      </template>

      <template v-if="active">
        <div class="active-head">
          <div class="active-id">
            <a-avatar :size="40" :style="{ background: 'rgba(124,58,237,0.18)', color: '#7c3aed' }">
              {{ (activeName || '?')[0].toUpperCase() }}
            </a-avatar>
            <div>
              <div class="active-name">{{ activeName }}</div>
              <div class="muted" style="font-size: 13px">{{ displayEmail(active.email) }}</div>
            </div>
          </div>
          <a-tag :color="subscriptionMeta(active.subscription.type).color" :bordered="false">
            {{ subscriptionLabel(active.subscription) }}
          </a-tag>
        </div>

        <div class="info-grid bordered-top">
          <div class="info-cell">
            <div class="info-label muted">本月用量</div>
            <div class="info-value">
              {{ formatCreditsPair(active.usage.current, active.usage.limit, precision) }}
            </div>
            <a-progress
              :percent="activeUsagePercent"
              :stroke-color="activeUsageColor"
              :show-info="false"
              :stroke-width="6"
            />
          </div>
          <div class="info-cell">
            <div class="info-label muted">订阅剩余</div>
            <div class="info-value">
              {{ active.subscription.daysRemaining != null ? `${active.subscription.daysRemaining} 天` : '永久' }}
            </div>
          </div>
          <div class="info-cell">
            <div class="info-label muted">Token 状态</div>
            <div class="info-value" :style="{ color: tokenState.color }">{{ tokenState.text }}</div>
          </div>
          <div class="info-cell">
            <div class="info-label muted">登录方式</div>
            <div class="info-value">{{ IDP_META[active.idp].text }}</div>
          </div>
        </div>

        <div class="bordered-top">
          <div class="block-title muted">订阅详情</div>
          <div class="kv-grid">
            <div class="kv">
              <span class="muted">订阅类型</span>
              <span>{{ subscriptionLabel(active.subscription) }}</span>
            </div>
            <div v-if="active.subscription.rawType" class="kv">
              <span class="muted">原始类型</span>
              <span class="mono">{{ active.subscription.rawType }}</span>
            </div>
            <div v-if="active.subscription.expiresAt" class="kv">
              <span class="muted">下次重置</span>
              <span>{{ formatDate(active.subscription.expiresAt) }}</span>
            </div>
            <div v-if="active.usage.nextResetDate" class="kv">
              <span class="muted">重置日期</span>
              <span>{{ formatDate(active.usage.nextResetDate) }}</span>
            </div>
          </div>
        </div>

        <div v-if="quotaDetails.length" class="bordered-top">
          <div class="block-title muted">额度明细</div>
          <div class="kv-grid">
            <div v-for="row in quotaDetails" :key="row.key" class="kv">
              <span class="dot" :style="{ background: row.color }" />
              <span class="muted">{{ row.label }}</span>
              <span>{{ row.value }}</span>
              <span v-if="row.extra" class="muted" style="font-size: 11px">（{{ row.extra }}）</span>
            </div>
          </div>
        </div>

        <div class="bordered-top">
          <div class="block-title muted">账户信息</div>
          <div class="kv-grid">
            <div v-if="active.userId" class="kv">
              <span class="muted">User ID</span>
              <span class="mono">{{ active.userId }}</span>
            </div>
            <div class="kv">
              <span class="muted">IDP</span>
              <span>{{ active.idp }}</span>
            </div>
            <div class="kv">
              <span class="muted">最后检查</span>
              <span>{{ relativeTime(active.lastCheckedAt) }}</span>
            </div>
          </div>
        </div>
      </template>

      <a-empty v-else description="本地 Kiro 凭证未匹配到已管理的账号">
        <a-space>
          <a-button type="primary" @click="router.push({ name: 'accounts' })">去账户管理</a-button>
          <a-button @click="accountsStore.syncActiveFromIde()">重新检测</a-button>
        </a-space>
      </a-empty>
    </a-card>

    <a-row :gutter="16">
      <a-col :xs="24" :lg="14">
        <a-card size="small" style="height: 100%">
          <template #title>
            <span class="card-title">
              <span class="icon-box sm" style="background: rgba(82, 196, 26, 0.12); color: #52c41a">
                <SafetyOutlined />
              </span>
              快速提示
            </span>
          </template>
          <ul class="tip-list">
            <li v-for="tip in tips" :key="tip">
              <span class="tip-dot">•</span>
              <span class="muted">{{ tip }}</span>
            </li>
          </ul>
        </a-card>
      </a-col>

      <a-col :xs="24" :lg="10">
        <a-card size="small" title="最近使用" style="height: 100%">
          <a-list size="small" :data-source="recent" :split="false">
            <template #renderItem="{ item }">
              <a-list-item style="padding: 5px 0">
                <a-space :size="6">
                  <SwapOutlined v-if="item.isActive" style="color: #52c41a" />
                  <span>{{ displayName(item) }}</span>
                  <span class="muted" style="font-size: 12px">{{ relativeTime(item.lastUsedAt) }}</span>
                </a-space>
              </a-list-item>
            </template>
            <template #empty><span class="muted">暂无记录</span></template>
          </a-list>
        </a-card>
      </a-col>
    </a-row>
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
  margin: 2px 0 0;
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
.stat-card:hover {
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
  font-size: 22px;
  font-weight: 700;
  line-height: 1.2;
}

.stat-label {
  font-size: 12px;
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

/* 告警 */
.warn-card {
  border-color: rgba(250, 173, 20, 0.4);
}

.warn-row {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 9px 12px;
  margin-bottom: 8px;
  border: none;
  border-radius: 10px;
  background: var(--kal-code-bg);
  cursor: pointer;
  text-align: left;
  font: inherit;
  color: inherit;
  transition: background 0.15s ease;
}

.warn-row:last-child {
  margin-bottom: 0;
}

/* 原来写死了默认紫，换主题色后对不上，改成跟随主题色 */
.warn-row:hover {
  background: color-mix(in srgb, var(--kal-primary) 12%, var(--kal-code-bg));
}

.warn-count {
  font-size: 17px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}

.warn-label {
  font-size: 13px;
  font-weight: 500;
  white-space: nowrap;
}

.warn-preview {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 额度统计 */
.tile-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 12px;
  margin-bottom: 16px;
}

.tile {
  padding: 10px 12px;
  border-radius: 10px;
  background: var(--kal-code-bg);
}

.tile-head {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  margin-bottom: 4px;
}

.tile-value {
  font-size: 18px;
  font-weight: 700;
}

.progress-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 12px;
  margin-bottom: 2px;
}

.progress-meta {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.percent-pill {
  padding: 1px 8px;
  border-radius: 6px;
  font-weight: 700;
}

/* 当前账号 */
.active-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 14px;
}

.active-id {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}

.active-name {
  font-weight: 600;
}

.bordered-top {
  border-top: 1px solid var(--kal-border);
  padding-top: 12px;
  margin-top: 12px;
}

.info-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 12px;
}

.info-label {
  font-size: 12px;
  margin-bottom: 2px;
}

.info-value {
  font-size: 14px;
  font-weight: 500;
}

.block-title {
  font-size: 12px;
  font-weight: 600;
  margin-bottom: 8px;
}

.kv-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 6px 16px;
}

.kv {
  display: flex;
  align-items: baseline;
  gap: 6px;
  font-size: 12px;
  min-width: 0;
}

.kv .mono {
  word-break: break-all;
  user-select: all;
}

.dot {
  flex: 0 0 auto;
  width: 7px;
  height: 7px;
  border-radius: 50%;
}

/* 提示 */
.tip-list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 8px;
  font-size: 13px;
}

.tip-list li {
  display: flex;
  gap: 8px;
}

.tip-dot {
  color: var(--kal-primary);
}
</style>
