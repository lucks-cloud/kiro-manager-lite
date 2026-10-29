<script setup lang="ts">
/**
 * 账号批量生成订阅链接：顶部选要开通的档位，每个选中账号一行，点「开始生成」后按顺序逐个生成 Stripe 结算链接。
 *
 * 档位列表用勾选的第一个账号向门户的 GetAvailableSubscriptionPlans 查一次。
 * 已有订阅的账号判为生成失败：门户对它们只回现有订阅的账单页，不是新档位的结算链接。
 * 生成后可逐个打开、复制，或下载 txt（邮箱----链接）/ xlsx（邮箱、订阅链接两列，链接可点击）。
 * 逐个执行与中止见 useBatchRun。
 */
import { computed, onMounted, ref } from 'vue'
import { message } from 'ant-design-vue'
import {
  CheckCircleFilled,
  CloseCircleFilled,
  CopyOutlined,
  CrownOutlined,
  DownOutlined,
  DownloadOutlined,
  FileExcelOutlined,
  GlobalOutlined,
  ReloadOutlined,
  StopOutlined
} from '@ant-design/icons-vue'
import { useSettingsStore } from '@/stores/settings'
import { useBatchRun, type BatchRow } from '@/utils/batchRun'
import { displayEmail } from '@/utils/display'
import { subscriptionLabel } from '@/utils/format'
import { freshAccount } from '@/utils/freshAccount'
import { toPlain } from '@/utils/ipc'
import { copyText } from '@/utils/ui'
import { errorMessage } from '@shared/errors'
import type { Account, SubscriptionPlan } from '@shared/types'

/** accounts 由调用方按界面顺序传入 */
const props = defineProps<{ accounts: Account[] }>()
const emit = defineEmits<{ close: [] }>()

const settingsStore = useSettingsStore()

interface Row extends BatchRow {
  account: Account
  url?: string
}

const rows = ref<Row[]>(props.accounts.map((account) => ({ account, state: 'pending' })))
const plans = ref<SubscriptionPlan[]>([])
const planType = ref('')
const plansLoading = ref(true)
const plansError = ref('')
/** 查档位时正在为第一个账号续期 Token，加载文案据此切换 */
const refreshingToken = ref(false)
const listRef = ref<HTMLElement | null>(null)

const { running, aborted, stat, started, start, abort, stopSilently } = useBatchRun({
  rows,
  listRef,
  messageKey: 'batch-subscription-abort',
  async runOne(row) {
    const res = await window.api.createSubscriptionCheckout(
      toPlain(await freshAccount(row.account)),
      planType.value,
      true
    )
    if (res.success && res.data?.url) {
      row.state = 'ok'
      row.url = res.data.url
    } else {
      row.state = 'fail'
      row.error = res.error || '生成订阅链接失败'
    }
  }
})

const got = computed(() => rows.value.filter((row) => row.state === 'ok' && row.url))
/** 没有已生成的链接、或正在生成时不给下载 */
const noDownload = computed(() => !got.value.length || running.value)

/** 「更多」下拉的开合由本组件管（见模板里的说明） */
const moreOpen = ref(false)

function onMorePick(): void {
  moreOpen.value = false
  void download('xlsx')
}
const planTitle = computed(() => plans.value.find((p) => p.subscriptionType === planType.value)?.title ?? '')

function email(account: Account): string {
  return displayEmail(account.email, settingsStore.settings.privacyMode)
}

function priceText(plan: SubscriptionPlan): string {
  if (plan.amount <= 0) return '免费'
  return `${plan.currency === 'USD' ? '$' : ''}${plan.amount}${plan.currency === 'USD' ? '' : ` ${plan.currency}`}`
}

/** 用勾选的第一个账号查一次可开通档位 */
async function loadPlans(): Promise<void> {
  const first = rows.value[0]?.account
  plansError.value = ''
  if (!first) {
    plansLoading.value = false
    plansError.value = '没有选中的账号'
    return
  }
  plansLoading.value = true
  try {
    const account = await freshAccount(first, (v) => (refreshingToken.value = v))
    const res = await window.api.listSubscriptionPlans(toPlain(account))
    if (!res.success || !res.data) {
      plansError.value = res.error || '查询订阅档位失败'
      return
    }
    // 免费档没有结算链接，不列出来
    plans.value = res.data.filter((plan) => plan.amount > 0)
    planType.value = plans.value[0]?.subscriptionType ?? ''
    if (!plans.value.length) plansError.value = '接口没有返回可开通的订阅档位'
  } catch (cause) {
    plansError.value = errorMessage(cause)
  } finally {
    plansLoading.value = false
  }
}

onMounted(loadPlans)

/** 换了档位后，已生成的链接对不上新档位，全部回到待生成 */
function onPlanChange(): void {
  for (const row of rows.value) {
    row.state = 'pending'
    row.url = undefined
    row.error = undefined
  }
}

/** 用内置浏览器打开结算页，窗口标题带上账号，几个账号同时开也分得清 */
async function openUrl(row: Row): Promise<void> {
  if (!row.url) return
  const res = await window.api.openInAppBrowser(row.url, `订阅 ${planTitle.value} - ${row.account.email}`)
  if (!res.success) message.error(res.error || '打开链接失败')
}

/**
 * 下载已生成的链接。
 * - txt：一行一个 `邮箱----链接`，可以直接粘到别处
 * - xlsx：两列「邮箱 / 订阅链接」，链接列是可点击的超链接
 */
async function download(kind: 'txt' | 'xlsx'): Promise<void> {
  const rows = got.value
  if (!rows.length) return

  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  const plan = planTitle.value.replace(/[^\w+]+/g, '_') || 'plan'
  const filename = `subscription-${plan}-${rows.length}个-${stamp}.${kind}`

  const res =
    kind === 'txt'
      ? await window.api.exportToFile(
          `${rows.map((row) => `${row.account.email}----${row.url}`).join('\n')}\n`,
          filename
        )
      : await window.api.exportToXlsx(
          {
            name: '订阅链接',
            columns: [
              { title: '邮箱', width: 36 },
              // Stripe 结算链接很长，列宽给大些，打开就能看到一长段
              { title: '订阅链接', width: 180, format: 'link' }
            ],
            rows: rows.map((row) => [row.account.email, row.url ?? null])
          },
          filename
        )

  if (!res.success) return void message.error(res.error || '下载失败')
  if (res.data?.saved) message.success(`已导出 ${rows.length} 个订阅链接`)
}

function close(): void {
  stopSilently()
  emit('close')
}
</script>

<template>
  <a-modal :open="true" width="760px" centered :footer="null" :mask-closable="!running" @cancel="close">
    <template #title>
      <span class="title"><CrownOutlined />批量生成订阅链接</span>
    </template>

    <!-- 档位查回来之前只显示加载 / 失败态，与单个订阅管理弹窗一致；查到后再显示档位与账号列表 -->
    <div v-if="plansLoading" class="stage">
      <a-spin size="large" />
      <span class="stage-text muted">
        {{ refreshingToken ? '正在为第一个账号续期 Token…' : '正在用第一个账号查询可开通的订阅档位…' }}
      </span>
    </div>
    <div v-else-if="plansError" class="stage">
      <a-result status="error" title="订阅档位查询失败" :sub-title="plansError">
        <template #extra>
          <a-space>
            <a-button @click="close">关闭</a-button>
            <a-button type="primary" @click="loadPlans">
              <template #icon><ReloadOutlined /></template>
              重试
            </a-button>
          </a-space>
        </template>
      </a-result>
    </div>
    <template v-else>
    <a-alert
      type="info"
      show-icon
      style="margin-bottom: 12px"
      message="为每个账号生成所选档位的 Stripe 订阅链接，按列表顺序逐个生成，单个失败不影响后续账号；已有订阅的账号会判为失败。链接需要在浏览器里打开完成支付。"
    />

    <div class="plan-bar">
      <span class="plan-label">订阅类型</span>
      <a-select
        v-model:value="planType"
        :disabled="running"
        style="flex: 1"
        @change="onPlanChange"
      >
        <a-select-option v-for="plan in plans" :key="plan.subscriptionType" :value="plan.subscriptionType">
          {{ plan.title }}<span class="muted">（{{ priceText(plan) }} / {{ plan.billingInterval }}）</span>
        </a-select-option>
      </a-select>
    </div>

    <div class="summary">
      <span class="count-text">共 {{ stat.total }} 个账号</span>
      <a-tag v-if="stat.ok" color="green" :bordered="false">成功 {{ stat.ok }}</a-tag>
      <a-tag v-if="stat.fail" color="red" :bordered="false">失败 {{ stat.fail }}</a-tag>
      <a-tag v-if="stat.pending" :bordered="false">未生成 {{ stat.pending }}</a-tag>
      <span class="spacer" />
      <span v-if="running" class="count-text">
        正在生成 {{ stat.ok + stat.fail + 1 }}/{{ stat.total }}
      </span>
    </div>

    <div ref="listRef" class="row-list">
      <div
        v-for="(row, index) in rows"
        :key="row.account.id"
        :data-row-index="index"
        class="row"
        :class="row.state"
      >
        <div class="row-main">
          <div class="row-email">
            {{ email(row.account) }}
            <a-tag :bordered="false" class="tier-tag">{{ subscriptionLabel(row.account.subscription) }}</a-tag>
          </div>
          <a v-if="row.url" class="row-url mono" :href="row.url" :title="row.url" @click.prevent="openUrl(row)">
            {{ row.url }}
          </a>
        </div>
        <div class="row-state">
          <template v-if="row.state === 'pending'">
            <span class="muted">等待生成</span>
          </template>
          <template v-else-if="row.state === 'running'">
            <a-spin size="small" />
            <span class="running-text">生成中</span>
          </template>
          <template v-else-if="row.state === 'ok'">
            <CheckCircleFilled class="ok-icon" />
            <span class="ok-text">已生成</span>
            <a-tooltip title="用内置浏览器打开">
              <a-button type="text" size="small" class="row-icon" @click="openUrl(row)">
                <template #icon><GlobalOutlined /></template>
              </a-button>
            </a-tooltip>
            <a-tooltip title="复制订阅链接">
              <a-button type="text" size="small" class="row-icon" @click="copyText(row.url!, '已复制订阅链接')">
                <template #icon><CopyOutlined /></template>
              </a-button>
            </a-tooltip>
          </template>
          <template v-else>
            <CloseCircleFilled class="fail-icon" />
            <span class="fail-text" :title="row.error">{{ row.error }}</span>
          </template>
        </div>
      </div>
    </div>

    <div class="footer">
      <!-- 按钮组：主按钮下载 txt，右侧下箭头可改为下载 xlsx（size 见 settings 的 compactSize） -->
      <a-space-compact :size="settingsStore.compactSize">
        <a-button :disabled="noDownload" @click="download('txt')">
          <template #icon><DownloadOutlined /></template>
          下载 txt（{{ got.length }}）
        </a-button>
        <a-dropdown v-model:open="moreOpen" :disabled="noDownload" placement="topRight" :trigger="['click']">
          <a-button :disabled="noDownload" aria-label="选择下载格式">
            <template #icon><DownOutlined /></template>
          </a-button>
          <template #overlay>
            <a-menu @click="onMorePick">
              <a-menu-item key="xlsx">
                <FileExcelOutlined />
                下载 xlsx（{{ got.length }}）
              </a-menu-item>
            </a-menu>
          </template>
        </a-dropdown>
      </a-space-compact>
      <span class="spacer" />
      <a-button @click="close">关闭</a-button>
      <a-button v-if="running" danger :loading="aborted" @click="abort">
        <template v-if="!aborted" #icon><StopOutlined /></template>
        {{ aborted ? '正在中止' : '中止' }}
      </a-button>
      <a-button
        v-else
        type="primary"
        :disabled="!planType || (!stat.pending && !stat.fail)"
        @click="start"
      >
        <template #icon><CrownOutlined /></template>
        {{ started && stat.fail ? '重试失败项' : '开始生成' }}
      </a-button>
    </div>
    </template>
  </a-modal>
</template>

<style scoped>
.title { display: inline-flex; align-items: center; gap: 8px; }
.plan-bar { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.plan-label { flex: 0 0 auto; font-size: 13px; }
.stage { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px; min-height: 360px; }
.stage-text { font-size: 13px; }
.summary { display: flex; align-items: center; gap: 8px; margin: 10px 0; }
.spacer { flex: 1 1 auto; }
.count-text { color: var(--kal-muted); font-size: 12px; }

/* 固定高度：账号 1 个还是几百个，弹窗都一样高，超出在列表内滚动 */
.row-list { height: 46vh; overflow: auto; display: flex; flex-direction: column; gap: 8px; }
.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  border-radius: 10px;
  background: var(--kal-block-bg);
  border: 1px solid transparent;
  transition: border-color 0.2s, background 0.2s;
}
.row.running { border-color: var(--kal-primary); }
.row.ok { border-color: #52c41a33; }
.row.fail { border-color: #ff4d4f33; }

.row-main { min-width: 0; flex: 1 1 auto; }
.row-email { display: flex; align-items: center; gap: 8px; font-size: 13px; overflow: hidden; white-space: nowrap; }
.tier-tag { flex: 0 0 auto; margin: 0; font-size: 11px; }
/* 链接可点：沿用说明的灰色，悬停才变主题色 */
.row-url { display: block; margin-top: 2px; color: var(--kal-muted); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; }
.row-url:hover { color: var(--kal-primary); }
/* 行尾的打开 / 复制图标：悬停时图标与底色都换成主题色 */
.row-icon { transition: color 0.15s, background 0.15s; }
.row-icon:hover,
.row-icon:focus-visible {
  color: var(--kal-primary) !important;
  background: color-mix(in srgb, var(--kal-primary) 12%, transparent) !important;
}

.row-state { flex: 0 0 auto; max-width: 46%; display: flex; align-items: center; gap: 6px; font-size: 12px; }
.running-text { color: var(--kal-primary); }
.ok-icon, .ok-text { color: #52c41a; }
.fail-icon { color: #ff4d4f; flex: 0 0 auto; }
.fail-text { color: #ff4d4f; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.footer { display: flex; align-items: center; gap: 8px; margin-top: 16px; }

.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
.muted { color: var(--kal-muted); }
</style>
