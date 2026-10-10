<script setup lang="ts">
import { computed, ref } from 'vue'
import { message } from 'ant-design-vue'
import {
  CopyOutlined,
  DownloadOutlined,
  EyeInvisibleOutlined,
  EyeOutlined,
  GlobalOutlined
} from '@ant-design/icons-vue'
import ExportAccountsModal from '@/components/accounts/ExportAccountsModal.vue'
import { useAccountsStore } from '@/stores/accounts'
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
import { displayEmail, displayNote } from '@/utils/display'
import { toPlain } from '@/utils/ipc'
import { copyText, notifyResult } from '@/utils/ui'
import { regionLabel } from '@shared/regions'
import type { Account } from '@shared/types'

const props = defineProps<{ account: Account | null }>()
const emit = defineEmits<{ close: [] }>()

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

const email = computed(() =>
  displayEmail(account.value?.email ?? '', settingsStore.settings.privacyMode)
)

/** 备注同样跟随隐私打码，否则卡片遮住了、点开详情又露出来 */
const note = computed(() =>
  displayNote(account.value?.note, settingsStore.settings.privacyMode)
)

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
    { label: 'Profile ARN', value: target.profileArn || target.credentials.profileArn },
    { label: '注册密码', value: target.password }
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

async function act(kind: 'refresh' | 'check' | 'switch'): Promise<void> {
  const target = account.value
  if (!target) return
  busy.value = true
  try {
    if (kind === 'refresh') {
      notifyResult(await accountsStore.refreshToken(target.id), { success: '密钥已刷新' })
    } else if (kind === 'check') {
      notifyResult(await accountsStore.checkStatus(target.id), { success: '用量已更新' })
    } else {
      const switched = await accountsStore.switchTo(target.id)
      if (switched.ok && !switched.result?.cliSync?.synced)
        message.warning(`IDE 已切换，CLI 未同步：${switched.result?.cliSync?.error || '未知原因'}`)
      else notifyResult(switched, { success: '已写入 Kiro IDE 和 CLI 凭证' })
    }
  } finally {
    busy.value = false
  }
}
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
      <a-space style="margin-bottom: 16px" wrap>
        <a-button type="primary" :loading="busy" @click="act('switch')">切换到此账号</a-button>
        <a-button :loading="busy" @click="act('refresh')">刷新密钥</a-button>
        <a-button :loading="busy" @click="act('check')">刷新用量</a-button>
        <a-tooltip title="用该账号凭证在私密窗口登录 Kiro 官网后台">
          <a-button :loading="portalOpening" @click="openPortal">
            <template #icon><GlobalOutlined /></template>
            前往官网
          </a-button>
        </a-tooltip>
        <a-button @click="exportOpen = true">
          <template #icon><DownloadOutlined /></template>
          导出
        </a-button>
      </a-space>

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
          <a-tag v-if="account.isActive" color="green">IDE 当前</a-tag>
        </a-descriptions-item>
        <a-descriptions-item label="登录方式">
          <a-tag :color="IDP_META[account.idp].color">{{ IDP_META[account.idp].text }}</a-tag>
          <span class="muted">{{ account.credentials.authMethod }}</span>
        </a-descriptions-item>
        <a-descriptions-item label="昵称">{{ account.nickname || '-' }}</a-descriptions-item>
        <a-descriptions-item label="备注">{{ note || '-' }}</a-descriptions-item>
        <a-descriptions-item label="User ID">
          <span class="mono">{{ account.userId || '-' }}</span>
        </a-descriptions-item>
        <a-descriptions-item label="区域">
          {{ regionLabel(account.credentials.region) }}
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

      <a-descriptions :column="1" size="small" bordered style="margin-bottom: 12px">
        <a-descriptions-item label="基础额度">
          {{ formatCreditsPair(account.usage.baseCurrent, account.usage.baseLimit, precision) }}
        </a-descriptions-item>
        <a-descriptions-item v-if="account.usage.freeTrialLimit" label="试用额度">
          {{ formatCreditsPair(account.usage.freeTrialCurrent, account.usage.freeTrialLimit, precision) }}
          <span v-if="account.usage.freeTrialExpiry" class="muted">
            （{{ formatDate(account.usage.freeTrialExpiry) }} 到期）
          </span>
        </a-descriptions-item>
        <a-descriptions-item v-if="account.usage.resourceDetail?.overageRate" label="超额费率">
          {{ account.usage.resourceDetail.currency }} {{ account.usage.resourceDetail.overageRate }} /
          {{ account.usage.resourceDetail.unit }}
          <a-tag :color="account.usage.resourceDetail.overageEnabled ? 'orange' : 'default'">
            {{ account.usage.resourceDetail.overageEnabled ? '已开启' : '未开启' }}
          </a-tag>
        </a-descriptions-item>
      </a-descriptions>

      <template v-if="account.usage.bonuses?.length">
        <div class="muted" style="margin-bottom: 6px">奖励额度</div>
        <a-list size="small" bordered :data-source="account.usage.bonuses" style="margin-bottom: 18px">
          <template #renderItem="{ item }">
            <a-list-item>
              <span>{{ item.name || item.code }}</span>
              <span class="muted">
                {{ formatCreditsPair(item.current, item.limit, precision) }}
                <template v-if="item.expiresAt"> · {{ formatDate(item.expiresAt) }} 到期</template>
              </span>
            </a-list-item>
          </template>
        </a-list>
      </template>

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
  </a-drawer>
</template>
