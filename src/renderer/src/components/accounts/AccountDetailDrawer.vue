<script setup lang="ts">
import { computed, ref, type Component } from 'vue'
import { message } from 'ant-design-vue'
import {
  CodeOutlined,
  CopyOutlined,
  DownOutlined,
  UploadOutlined,
  EyeInvisibleOutlined,
  EyeOutlined,
  GlobalOutlined,
  LoginOutlined,
  LogoutOutlined,
  ThunderboltOutlined
} from '@ant-design/icons-vue'
import ExportAccountsModal from '@/components/accounts/ExportAccountsModal.vue'
import { useAccountsStore, type AccountLoginAction } from '@/stores/accounts'
import { useSettingsStore } from '@/stores/settings'
import {
  IDP_META,
  STATUS_META,
  subscriptionMeta,
  formatCreditsPair,
  formatDate,
  formatDateTime,
  subscriptionLabel,
  usageColor
} from '@/utils/format'
import { displayEmail, displayName, displayNote } from '@/utils/display'
import { usePrivacy } from '@/composables/usePrivacy'
import { toPlain } from '@/utils/ipc'
import { copyText, notifyResult } from '@/utils/ui'
import { regionLabel } from '@shared/regions'
import type { Account } from '@shared/types'

const props = defineProps<{
  account: Account | null
  /** 列表页该账号正在进行的操作（与卡片同一份），登录按钮据此转圈 */
  busyAction?: string | null
}>()
const emit = defineEmits<{ close: []; login: [action: AccountLoginAction, account: Account] }>()

const accountsStore = useAccountsStore()
const settingsStore = useSettingsStore()

const showSecrets = ref(false)
const busy = ref(false)
const exportOpen = ref(false)
const portalOpening = ref(false)

// 列表里的行对象在 store 更新后会被替换，这里始终取最新副本
const account = computed(() =>
  props.account ? (accountsStore.get(props.account.id) ?? props.account) : null
)

const precision = computed(() => settingsStore.settings.usagePrecision)
const { maskAccount } = usePrivacy()

const email = computed(() =>
  displayEmail(account.value?.email ?? '', maskAccount('email'))
)

/** 备注同样跟随隐私打码，否则卡片遮住了、点开详情又露出来 */
const note = computed(() =>
  displayNote(account.value?.note, maskAccount('note'))
)

/** 昵称此前在详情里没有跟随打码，这里补上 */
const nickname = computed(() => {
  const a = account.value
  if (!a) return '-'
  if (maskAccount('nickname')) return displayName(a, true)
  return a.nickname || '-'
})

/**
 * 抽屉宽度：与 API Key 详情抽屉同一口径。
 * 窄窗口下退回视口的 92%，避免抽屉宽过窗口本身。
 */
const drawerWidth = computed(() => Math.min(720, Math.round(window.innerWidth * 0.92)))

const tokenExpiry = computed(() => {
  const expiresAt = account.value?.credentials.expiresAt
  if (!expiresAt) return { text: '-', expired: false }
  const expired = expiresAt <= Date.now()
  const minutes = Math.round((expiresAt - Date.now()) / 60_000)
  return {
    text: expired ? `已于 ${formatDateTime(expiresAt)} 过期` : `${formatDateTime(expiresAt)}（约 ${minutes} 分钟后）`,
    expired
  }
})

function mask(value?: string): string {
  if (!value) return '-'
  if (showSecrets.value) return value
  return `${value.slice(0, 8)}${'•'.repeat(24)}${value.slice(-6)}`
}

/** 注册密码单独的显隐开关，与凭证区互不影响 */
const showPassword = ref(false)

/**
 * 遮挡注册密码：只露首尾各一位，中间固定 8 个星号。
 * 中间位数与真实长度无关，避免从展示长度反推出密码位数。
 */
function maskPassword(value?: string): string {
  if (!value) return '-'
  if (showPassword.value) return value
  const first = value.slice(0, 1)
  const last = value.length > 1 ? value.slice(-1) : ''
  return `${first}${'*'.repeat(8)}${last}`
}

function copy(label: string, value?: string): void {
  if (!value) return void message.warning(`${label} 为空`)
  copyText(value, `${label} 已复制`)
}

/** 凭证区展示的字段，顺序即界面顺序 */
const credentialFields = computed(() => {
  const target = account.value
  if (!target) return []
  return [
    { label: 'Access Token', value: target.credentials.accessToken },
    { label: 'Refresh Token', value: target.credentials.refreshToken },
    { label: 'Client ID', value: target.credentials.clientId },
    { label: 'Client Secret', value: target.credentials.clientSecret },
    { label: 'Profile ARN', value: target.profileArn || target.credentials.profileArn }
  ]
})

/** 用该账号凭证在私密窗口打开官网后台 */
async function openPortal(): Promise<void> {
  const target = account.value
  if (!target) return
  portalOpening.value = true
  try {
    // 响应式代理无法结构化克隆，过 IPC 前先剥成普通对象
    const res = await window.api.openAccountPortal(toPlain(target))
    if (!res.success) return void message.error(res.error || '打开官网失败')
  } finally {
    portalOpening.value = false
  }
}

async function act(kind: 'refresh' | 'check'): Promise<void> {
  const target = account.value
  if (!target) return
  busy.value = true
  try {
    if (kind === 'refresh') {
      notifyResult(await accountsStore.refreshToken(target.id), { success: '密钥已刷新' })
    } else {
      notifyResult(await accountsStore.checkStatus(target.id), { success: '用量已更新' })
    }
  } finally {
    busy.value = false
  }
}

// ============ 登录按钮组 ============
interface LoginButton {
  action: AccountLoginAction
  label: string
  icon: Component
  primary?: boolean
  danger?: boolean
}

/** 规则与账号卡片的「登录 / 退出」下拉一致；状态直接读 store 里的最新账号，登录 / 退出后立即跟着变 */
const loginButtons = computed<LoginButton[]>(() => {
  const a = account.value
  if (!a) return []
  const buttons: LoginButton[] = [
    a.isActive
      ? { action: 'logout', label: '退出 Kiro IDE', icon: LogoutOutlined, danger: true }
      : { action: 'switch', label: '登录 Kiro IDE', icon: LoginOutlined, primary: true },
    a.isActiveCli
      ? { action: 'logout-cli', label: '退出 Kiro CLI（含 KiroCrew）', icon: CodeOutlined, danger: true }
      : { action: 'cli-login', label: '登录 Kiro CLI（含 KiroCrew）', icon: CodeOutlined, primary: true }
  ]
  if (!a.isActive && !a.isActiveCli) {
    buttons.push({ action: 'login-all', label: '全部登录', icon: ThunderboltOutlined, primary: true })
  }
  return buttons
})

function onLoginMenu({ key }: { key: string | number }): void {
  if (account.value) emit('login', String(key) as AccountLoginAction, account.value)
}

/** 任一登录动作进行中时，「快捷登录」转圈并禁用，避免两端同时写 */
const loginBusy = computed(() =>
  ['switch', 'cli-login', 'login-all', 'logout', 'logout-cli'].includes(props.busyAction ?? '')
)
</script>

<template>
  <a-drawer
    :open="!!account"
    :title="email || '账号详情'"
    :width="drawerWidth"
    placement="right"
    @close="emit('close')"
  >
    <template v-if="account">
      <a-alert
        v-if="account.lastError"
        type="error"
        show-icon
        :message="account.lastError"
        style="margin-bottom: 16px"
      />

      <div class="section-title">基本信息</div>
      <a-descriptions :column="1" size="small" bordered style="margin-bottom: 18px">
        <a-descriptions-item label="状态">
          <a-tag :color="STATUS_META[account.status].color">{{ STATUS_META[account.status].text }}</a-tag>
          <a-tag v-if="account.isActive" color="green">IDE 使用中</a-tag>
          <a-tag v-if="account.isActiveCli" color="blue">CLI 使用中</a-tag>
        </a-descriptions-item>
        <a-descriptions-item label="登录方式">
          <a-tag :color="IDP_META[account.idp].color">{{ IDP_META[account.idp].text }}</a-tag>
          <span class="muted">{{ account.credentials.authMethod }}</span>
        </a-descriptions-item>
        <a-descriptions-item label="昵称">{{ nickname }}</a-descriptions-item>
        <a-descriptions-item label="备注">{{ note || '-' }}</a-descriptions-item>
        <a-descriptions-item label="User ID">
          <span class="mono">{{ account.userId || '-' }}</span>
        </a-descriptions-item>
        <a-descriptions-item label="区域">
          {{ regionLabel(account.credentials.region) }}
        </a-descriptions-item>
        <a-descriptions-item label="注册密码">
          <div style="display: flex; align-items: center; justify-content: space-between; gap: 8px">
            <span class="mono">{{ maskPassword(account.password) }}</span>
            <a-space v-if="account.password" :size="0">
              <a-button type="link" size="small" @click="showPassword = !showPassword">
                <template #icon>
                  <EyeInvisibleOutlined v-if="showPassword" />
                  <EyeOutlined v-else />
                </template>
                {{ showPassword ? '隐藏' : '显示' }}
              </a-button>
              <a-button type="link" size="small" @click="copy('注册密码', account.password)">
                <template #icon><CopyOutlined /></template>
                复制
              </a-button>
            </a-space>
          </div>
        </a-descriptions-item>
        <a-descriptions-item label="添加时间">{{ formatDateTime(account.createdAt) }}</a-descriptions-item>
        <a-descriptions-item label="最后检查">{{ formatDateTime(account.lastCheckedAt) }}</a-descriptions-item>
      </a-descriptions>

      <div class="section-title">订阅</div>
      <a-descriptions :column="1" size="small" bordered style="margin-bottom: 18px">
        <a-descriptions-item label="套餐">
          <a-tag :color="subscriptionMeta(account.subscription.type).color">
            {{ subscriptionLabel(account.subscription) }}
          </a-tag>
        </a-descriptions-item>
        <a-descriptions-item label="原始类型">
          <span class="mono">{{ account.subscription.rawType || '-' }}</span>
        </a-descriptions-item>
        <a-descriptions-item label="下次重置">
          {{ formatDate(account.usage.nextResetDate) }}
          <span v-if="account.subscription.daysRemaining !== undefined" class="muted">
            （{{ account.subscription.daysRemaining }} 天后）
          </span>
        </a-descriptions-item>
      </a-descriptions>

      <div class="section-title">积分与用量</div>
      <a-progress
        :percent="Math.min(100, Math.round((account.usage.percentUsed || 0) * 1000) / 10)"
        :stroke-color="usageColor(account.usage.percentUsed || 0)"
      />
      <p class="muted" style="margin: 4px 0 12px">
        总计 {{ formatCreditsPair(account.usage.current, account.usage.limit, precision) }}
        {{ account.usage.resourceDetail?.displayNamePlural || 'Credits' }}
      </p>

      <a-descriptions :column="1" size="small" bordered style="margin-bottom: 18px">
        <a-descriptions-item label="基础额度">
          {{ formatCreditsPair(account.usage.baseCurrent, account.usage.baseLimit, precision) }}
        </a-descriptions-item>
        <a-descriptions-item v-if="account.usage.freeTrialLimit" label="试用额度">
          {{ formatCreditsPair(account.usage.freeTrialCurrent, account.usage.freeTrialLimit, precision) }}
          <span v-if="account.usage.freeTrialExpiry" class="muted">
            （{{ formatDate(account.usage.freeTrialExpiry) }} 到期）
          </span>
        </a-descriptions-item>
        <!-- 奖励额度（试用赠送、首充赠送等）：紧跟在基础 / 试用额度下面，各占一行 -->
        <a-descriptions-item
          v-for="bonus in account.usage.bonuses || []"
          :key="bonus.code || bonus.name"
          :label="bonus.name || '奖励额度'"
        >
          <div>
            {{ formatCreditsPair(bonus.current, bonus.limit, precision) }}
            <span v-if="bonus.expiresAt" class="muted">
              （{{ formatDate(bonus.expiresAt) }} 到期）
            </span>
          </div>
          <div
            v-if="bonus.bonusType || bonus.description"
            class="muted"
            style="font-size: 12px; margin-top: 2px"
          >
            {{ [bonus.bonusType, bonus.description].filter(Boolean).join(' • ') }}
          </div>
        </a-descriptions-item>
        <a-descriptions-item v-if="account.usage.resourceDetail?.overageRate" label="超额费率">
          {{ account.usage.resourceDetail.currency }} {{ account.usage.resourceDetail.overageRate }} /
          {{ account.usage.resourceDetail.unit }}
          <a-tag :color="account.usage.resourceDetail.overageEnabled ? 'orange' : 'default'">
            {{ account.usage.resourceDetail.overageEnabled ? '已开启' : '未开启' }}
          </a-tag>
        </a-descriptions-item>
      </a-descriptions>

      <div class="section-title" style="margin-top: 6px">
        凭证
        <a-button type="link" size="small" @click="showSecrets = !showSecrets">
          <template #icon>
            <EyeInvisibleOutlined v-if="showSecrets" />
            <EyeOutlined v-else />
          </template>
          {{ showSecrets ? '隐藏' : '显示' }}
        </a-button>
      </div>

      <a-alert
        :type="tokenExpiry.expired ? 'warning' : 'info'"
        show-icon
        style="margin-bottom: 10px"
        :message="`Access Token 有效期至：${tokenExpiry.text}`"
      />

      <a-space direction="vertical" style="width: 100%" :size="10">
        <div v-for="field in credentialFields" :key="field.label">
          <div style="display: flex; align-items: center; justify-content: space-between">
            <span class="muted" style="font-size: 12px">{{ field.label }}</span>
            <a-button type="link" size="small" @click="copy(field.label, field.value)">
              <template #icon><CopyOutlined /></template>
              复制
            </a-button>
          </div>
          <div class="token-box mono">{{ mask(field.value) }}</div>
        </div>
      </a-space>

      <!-- 只传当前账号，导出范围即当前账号，不受列表勾选影响 -->
      <ExportAccountsModal
        v-if="exportOpen"
        v-model:open="exportOpen"
        :selected-ids="[account.id]"
      />
    </template>

    <template v-if="account" #footer>
      <div class="drawer-footer">
        <!--
          「快捷登录」下拉：Kiro IDE、Kiro CLI 各一项，按该端当前是否在用此账号显示「登录」或「退出」；
          两端都没登录此账号时再给「全部登录」。和账号卡片的「登录 / 退出」下拉完全同一套规则，
          执行也交给列表页的同一套处理（安装检测、切号结果弹窗、卡片加载态），两边状态同步。
        -->
        <a-dropdown :trigger="['click']" placement="topLeft" :disabled="loginBusy">
            <a-button type="primary" :loading="loginBusy">
              <template #icon><LoginOutlined /></template>
              快捷登录
              <DownOutlined />
            </a-button>
            <template #overlay>
              <a-menu @click="onLoginMenu">
                <a-menu-item v-for="item in loginButtons" :key="item.action" :danger="item.danger">
                  <component :is="item.icon" />
                  {{ item.label }}
                </a-menu-item>
              </a-menu>
            </template>
          </a-dropdown>

        <div class="footer-actions">
          <a-button :loading="busy" @click="act('refresh')">刷新密钥</a-button>
          <a-button :loading="busy" @click="act('check')">刷新用量</a-button>
          <a-tooltip title="用该账号凭证在私密窗口登录 Kiro 官网后台">
            <a-button :loading="portalOpening" @click="openPortal">
              <template #icon><GlobalOutlined /></template>
              前往官网
            </a-button>
          </a-tooltip>
          <a-button @click="exportOpen = true">
            <template #icon><UploadOutlined /></template>
            导出
          </a-button>
        </div>
      </div>
    </template>
  </a-drawer>
</template>

<style scoped>
/* 底部：快捷登录靠左，其余操作靠右；抽屉太窄时右侧一组整体换到下一行并仍靠右 */
.drawer-footer {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
/* 不用 a-space：它的 wrap 模式会给每项加底部间距，和左侧按钮对不齐 */
.footer-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  margin-left: auto;
}
</style>
