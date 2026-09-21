<script setup lang="ts">
/**
 * 订阅入口弹窗。
 *
 * 点订阅标签就立刻开这个弹窗，查询在弹窗里做：
 *   - 已订阅：拿到 Stripe 账单管理链接 → 用内置浏览器打开，弹窗随即关闭；
 *   - 未订阅：列出可开通档位，每个档位两个动作（开通并支付 / 只复制支付链接）；
 *   - 查询失败：就地显示错误并给「重试」，不必关掉重来。
 *
 * 加载态放在弹窗里而不是让标签转圈：接口要先开一次门户首页取 CSRF，
 * 再加一到两次 CBOR 调用，等待期是实打实的，卡片上一个小转圈说明不了发生了什么。
 */
import { computed, onMounted, ref } from 'vue'
import { message } from 'ant-design-vue'
import {
  CopyOutlined,
  CreditCardOutlined,
  ShoppingCartOutlined,
  SyncOutlined
} from '@ant-design/icons-vue'
import { useAccountsStore } from '@/stores/accounts'
import { copyText } from '@/utils/ui'
import { toPlain } from '@/utils/ipc'
import { errorMessage } from '@shared/errors'
import type { Account, SubscriptionPlan } from '@shared/types'

const props = defineProps<{ account: Account }>()

const emit = defineEmits<{ close: [] }>()

const accountsStore = useAccountsStore()

const loading = ref(true)
const refreshingToken = ref(false)
const error = ref('')
const plans = ref<SubscriptionPlan[]>([])
const disclaimer = ref<string[]>([])

/** 正在请求链接的 `档位:动作`，同一时刻只让被点的那个按钮转圈 */
const busy = ref('')

/** 当前套餐：接口回的原始订阅类型能直接对上档位的 subscriptionType */
const currentType = computed(() => props.account.subscription.rawType || '')

/**
 * 取一份 token 还没过期的账号副本。
 *
 * 门户的订阅接口靠 cookie 里的 AccessToken 认身份，过期就是
 * 401 UnauthorizedException: Authentication required or access denied。
 * 非 IDE 当前登录的账号缓存里那份基本都过期了（IDE 只续自己在用的那个），
 * 所以先按需续一次；refreshToken 只在该账号确实是 IDE 当前账号时才回写磁盘。
 */
async function freshAccount(): Promise<Account> {
  const current = accountsStore.get(props.account.id) ?? props.account
  // 留 1 分钟余量，避免请求发出途中过期
  if (current.credentials.accessToken && (current.credentials.expiresAt ?? 0) - Date.now() > 60_000) {
    return current
  }
  refreshingToken.value = true
  try {
    const res = await accountsStore.refreshToken(props.account.id)
    if (!res.ok) throw new Error(`刷新密钥失败：${res.error}`)
    return accountsStore.get(props.account.id) ?? current
  } finally {
    refreshingToken.value = false
  }
}

/**
 * 查订阅入口。已订阅的账号直接开账单页并关掉弹窗，
 * 未订阅的账号留下档位列表。
 */
async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const res = await window.api.getSubscriptionEntry(toPlain(await freshAccount()))
    if (!res.success || !res.data) {
      error.value = res.error || '查询订阅信息失败'
      return
    }

    const entry = res.data
    if (entry.manageUrl) {
      const opened = await window.api.openInAppBrowser(
        entry.manageUrl,
        `订阅管理 - ${props.account.email}`
      )
      if (!opened.success) {
        error.value = opened.error || '打开账单页失败'
        return
      }
      message.success('已在内置浏览器打开 Stripe 账单管理')
      emit('close')
      return
    }

    plans.value = entry.plans
    disclaimer.value = entry.disclaimer
    if (!entry.plans.length) error.value = '接口没有返回可开通的订阅档位'
  } catch (e) {
    // 续期失败也走同一个失败态，用户点重试即可重来
    error.value = errorMessage(e)
  } finally {
    loading.value = false
  }
}

onMounted(load)

function priceText(plan: SubscriptionPlan): string {
  if (plan.amount <= 0) return '免费'
  // 接口给的是 USD / per month 这种拆开的字段，这里拼成一句
  return `${plan.currency === 'USD' ? '$' : ''}${plan.amount}${plan.currency === 'USD' ? '' : ` ${plan.currency}`}`
}

/** 生成结算链接；失败统一提示，成功后交给调用方决定打开还是复制 */
async function checkoutUrl(plan: SubscriptionPlan, action: string): Promise<string> {
  busy.value = `${plan.subscriptionType}:${action}`
  try {
    const res = await window.api.createSubscriptionCheckout(
      toPlain(await freshAccount()),
      plan.subscriptionType
    )
    if (!res.success || !res.data?.url) {
      message.error(res.error || '生成支付链接失败')
      return ''
    }
    return res.data.url
  } catch (e) {
    message.error(errorMessage(e))
    return ''
  } finally {
    busy.value = ''
  }
}

async function openCheckout(plan: SubscriptionPlan): Promise<void> {
  const url = await checkoutUrl(plan, 'open')
  if (!url) return
  const res = await window.api.openInAppBrowser(url, `开通 ${plan.title} - ${props.account.email}`)
  if (!res.success) return void message.error(res.error || '打开支付页失败')
  message.success('已在内置浏览器打开支付页')
}

async function copyCheckout(plan: SubscriptionPlan): Promise<void> {
  const url = await checkoutUrl(plan, 'copy')
  if (!url) return
  copyText(url, '支付链接已复制到剪贴板')
}
</script>

<template>
  <a-modal :open="true" centered width="820px" :footer="null" @cancel="emit('close')">
    <template #title>
      <span class="modal-title">
        <CreditCardOutlined />
        订阅管理
      </span>
    </template>

    <!-- 三种状态共用同一块区域，高度固定：加载完不会整块跳一下 -->
    <div class="modal-body">
      <div v-if="loading" class="stage">
        <a-spin size="large" />
        <span class="stage-text muted">
          {{ refreshingToken ? '正在为该账号续期 Token…' : '正在查询该账号的订阅状态…' }}
        </span>
      </div>

      <!-- 失败态与测活弹窗同一套：图标 + 标题 + 原始报错 + 关闭 / 重试 -->
      <div v-else-if="error" class="stage">
        <a-result status="error" title="订阅信息查询失败" :sub-title="error">
          <template #extra>
            <a-space>
              <a-button @click="emit('close')">关闭</a-button>
              <a-button type="primary" @click="load">
                <template #icon><SyncOutlined /></template>
                重试
              </a-button>
            </a-space>
          </template>
        </a-result>
      </div>

      <template v-else>
        <p class="tip muted">
          账号 {{ props.account.email }} 当前没有可管理的订阅，可直接开通下列档位。
          支付由 Stripe 承载，链接每次点击时现生成。
        </p>

        <div class="plan-grid">
          <div
            v-for="plan in plans"
            :key="plan.subscriptionType"
            class="plan-card"
            :class="{ 'is-current': plan.subscriptionType === currentType }"
          >
            <div class="plan-head">
              <span class="plan-title">{{ plan.title }}</span>
              <a-tag v-if="plan.subscriptionType === currentType" color="green" :bordered="false">
                当前套餐
              </a-tag>
            </div>

            <div class="plan-price">
              <strong>{{ priceText(plan) }}</strong>
              <span v-if="plan.billingInterval" class="muted">{{ plan.billingInterval }}</span>
            </div>

            <div v-if="plan.featureHeader" class="plan-feature-head muted">
              {{ plan.featureHeader }}
            </div>

            <ul class="plan-features">
              <li v-for="(feature, index) in plan.features" :key="index">{{ feature }}</li>
            </ul>

            <!-- 付款与复制链接放一组：同一件事的两种落地方式，摆在一起最省解释 -->
            <a-space-compact class="plan-actions" block>
              <a-button
                type="primary"
                block
                :disabled="plan.amount <= 0"
                :loading="busy === `${plan.subscriptionType}:open`"
                @click="openCheckout(plan)"
              >
                <template #icon><ShoppingCartOutlined /></template>
                {{ plan.amount <= 0 ? '无需支付' : '开通并支付' }}
              </a-button>
              <a-button
                :disabled="plan.amount <= 0"
                :loading="busy === `${plan.subscriptionType}:copy`"
                title="只生成支付链接并复制，不打开浏览器"
                @click="copyCheckout(plan)"
              >
                <template #icon><CopyOutlined /></template>
              </a-button>
            </a-space-compact>
          </div>
        </div>

        <ul v-if="disclaimer.length" class="plan-disclaimer muted">
          <li v-for="(line, index) in disclaimer" :key="index">{{ line }}</li>
        </ul>
      </template>
    </div>
  </a-modal>
</template>

<style scoped>
.modal-title {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

/*
 * 三种状态（加载 / 失败 / 档位列表）共用这一块，高度固定 560px：
 * 查询快的时候弹窗不会先小后大跳一下，档位列表也正好摆得下两排卡片。
 */
.modal-body {
  display: flex;
  flex-direction: column;
  min-height: 560px;
}

/* 加载与失败都居中一列，占满整块高度 */
.stage {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
}

.stage-text {
  font-size: 13px;
}

.stage :deep(.ant-result) {
  padding: 0;
}

/* 报错原文可能很长，限宽并允许换行，避免把弹窗顶宽 */
.stage :deep(.ant-result-subtitle) {
  max-width: 620px;
  margin: 0 auto;
  word-break: break-word;
}

/* antd 默认 24px，报错文案多行时和按钮贴得太近，这里拉开一些 */
.stage :deep(.ant-result-extra) {
  margin-top: 80px;
}

.tip {
  margin: 0 0 14px;
  font-size: 12px;
}

/* 档位数量由接口决定（现在 5 个），按可用宽度自动排，不写死列数 */
.plan-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));
  gap: 12px;
}

.plan-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 14px;
  border: 1px solid var(--kal-border);
  border-radius: 12px;
  background: var(--kal-card-bg);
}

.plan-card.is-current {
  border-color: #52c41a;
}

.plan-head {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.plan-title {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.plan-price {
  display: flex;
  align-items: baseline;
  gap: 6px;
}

.plan-price strong {
  font-size: 22px;
  line-height: 1.2;
}

.plan-price span {
  font-size: 12px;
}

.plan-feature-head {
  font-size: 12px;
}

/* 特性条数各档位不同，用弹性占位把动作按钮顶到卡片底部，一排卡片按钮对齐 */
.plan-features {
  flex: 1 1 auto;
  margin: 0;
  padding-left: 18px;
  font-size: 12px;
  line-height: 1.8;
}

.plan-actions {
  display: flex;
  margin-top: 2px;
}

/* 主按钮吃掉剩余宽度，复制按钮按图标宽 */
.plan-actions :deep(.ant-btn:first-child) {
  flex: 1 1 auto;
}

.plan-actions :deep(.ant-btn:last-child) {
  flex: 0 0 auto;
}

.plan-disclaimer {
  margin: 14px 0 0;
  padding-left: 18px;
  font-size: 12px;
  line-height: 1.7;
}

.muted {
  color: var(--kal-muted);
}
</style>
