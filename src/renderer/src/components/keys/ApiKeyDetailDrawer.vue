<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { message } from 'ant-design-vue'
import {
  CheckCircleFilled,
  CopyOutlined,
  DownloadOutlined,
  EyeInvisibleOutlined,
  EyeOutlined,
  GlobalOutlined,
  SendOutlined,
  SwapOutlined,
  SyncOutlined
} from '@ant-design/icons-vue'
import RegionSelect from '@/components/common/RegionSelect.vue'
import { useKeysStore } from '@/stores/keys'
import { useSettingsStore } from '@/stores/settings'
import { copyText } from '@/utils/ui'
import {
  displayEmail as maskedEmail,
  displayNote as maskedNote,
  displayUserId
} from '@/utils/display'
import { formatCreditsPair, formatDate, formatDateTime, usageColor } from '@/utils/format'
import { regionLabel } from '@shared/regions'
import type { KeyEntry } from '@shared/types'

const props = defineProps<{ keyEntry: KeyEntry | null }>()
const emit = defineEmits<{ close: []; test: [KeyEntry]; edit: [KeyEntry]; select: [KeyEntry] }>()
const keysStore = useKeysStore()
const settingsStore = useSettingsStore()
const showSecret = ref(false)
const busy = ref('')

/**
 * 抽屉宽度：完整 API Key 与 User ID 都是 40+ 字符的长串，560 太窄会挤成多行。
 * 窄窗口下退回视口的 92%，避免抽屉宽过窗口本身。
 */
const drawerWidth = computed(() => Math.min(680, Math.round(window.innerWidth * 0.92)))
/** label 列固定宽度：否则「User ID」这种两字词会被压成两行，和右侧值错位 */
const labelStyle = { width: '92px', whiteSpace: 'nowrap' } as const

const entry = computed(() =>
  props.keyEntry
    ? keysStore.data.keys.find((item) => item.id === props.keyEntry?.id) ?? props.keyEntry
    : null
)
const precision = computed(() => settingsStore.settings.usagePrecision)

/** 已用占比（0-1），用于进度条与配色 */
const percentUsed = computed(() => {
  const e = entry.value
  if (!e || !e.totalCredits) return 0
  return Math.min(1, (e.usedCredits || 0) / e.totalCredits)
})

/** 下次重置剩余天数；无重置时间则不显示 */
const resetDays = computed(() => {
  const at = entry.value?.nextResetAt
  if (!at) return undefined
  const days = Math.ceil((at - Date.now()) / 86_400_000)
  return days >= 0 ? days : undefined
})
/** 邮箱跟随全局隐私打码；上游未返回时占位 */
const emailText = computed(() => {
  const value = entry.value?.email
  return value ? maskedEmail(value, settingsStore.settings.privacyMode) : '-'
})
/** 备注同样跟随隐私打码，否则卡片遮住了、点开详情又露出来 */
const noteMasked = computed(() =>
  maskedNote(entry.value?.note, settingsStore.settings.privacyMode)
)
const noteText = computed(() => noteMasked.value || '-')
/** 标题也用打码后的备注，否则遮了正文却从标题露出去 */
const drawerTitle = computed(() => noteMasked.value || 'API Key 详情')
const maskedKey = computed(() => {
  const key = entry.value?.key || ''
  if (!key) return '-'
  if (!settingsStore.settings.privacyMode || showSecret.value) return key
  return `${key.slice(0, 8)}${'•'.repeat(24)}${key.slice(-8)}`
})
/**
 * 账号唯一标识，来自 Get-Usage-Limits 响应的 userInfo.userId，随刷新用量一起更新。
 * 与邮箱同样跟随全局隐私打码，但不受「显示完整凭证」按钮影响：那个按钮只管 API Key 本身。
 */
const userIdText = computed(() => {
  const value = entry.value?.userId
  return value ? displayUserId(value, settingsStore.settings.privacyMode) : '-'
})
const isCurrent = computed(() => entry.value?.id === keysStore.data.activeKeyId)
/** 与卡片一致：管理面同步错误与对话测活错误取并集 */
const issue = computed(() => entry.value?.lastError || entry.value?.lastChatError)

watch(
  () => [props.keyEntry?.id, settingsStore.settings.privacyMode],
  () => { showSecret.value = false }
)

/** 切换逻辑复用卡片：交给父级 KeysView 处理（含网关未开启时的开启+冲突+重启流程） */
function onSwitch(): void {
  const target = entry.value
  if (!target || isCurrent.value) return
  emit('select', target)
}

// ============ 换区 ============
const regionOpen = ref(false)
const regionValue = ref('')
const savingRegion = ref(false)

function openRegion(): void {
  regionValue.value = entry.value?.region || ''
  regionOpen.value = true
}

async function submitRegion(): Promise<void> {
  const target = entry.value
  if (!target) return
  const next = regionValue.value.trim()
  if (!next) return void message.warning('请选择或填写区域')
  if (next === target.region) {
    regionOpen.value = false
    return
  }
  savingRegion.value = true
  try {
    const error = await keysStore.setRegion(target.id, next)
    if (error) return void message.error(error)
    regionOpen.value = false
    message.success(`区域已改为 ${next}，已重新同步额度`)
  } finally {
    savingRegion.value = false
  }
}

async function sync(): Promise<void> {
  const target = entry.value
  if (!target || busy.value) return
  busy.value = 'sync'
  try {
    const error = await keysStore.sync(target.id)
    if (error) return void message.error(error)
    message.success('订阅与额度已更新')
  } finally {
    busy.value = ''
  }
}

function copyKey(): void {
  const target = entry.value
  if (target) copyText(target.key, '完整 API Key 已复制')
}

/** 复制的始终是完整原值，与界面是否打码无关 */
function copyUserId(): void {
  const value = entry.value?.userId
  if (value) copyText(value, 'User ID 已复制')
}

function copyEmail(): void {
  const value = entry.value?.email
  if (value) copyText(value, '邮箱已复制')
}

async function exportKey(): Promise<void> {
  const target = entry.value
  if (!target) return
  const result = await window.api.exportToFile(target.key + '\n', `kiro-api-key-${target.id}.txt`)
  if (!result.success) message.error(result.error || '导出失败')
  else if (result.data?.saved) message.success('已导出')
}

function subscriptionColor(tier?: string): string {
  if (tier === 'power') return 'gold'
  if (tier === 'pro+') return 'purple'
  if (tier === 'pro') return 'blue'
  if (tier === 'free') return 'default'
  return 'cyan'
}
</script>

<template>
  <a-drawer
    :open="!!entry"
    :title="drawerTitle"
    :width="drawerWidth"
    placement="right"
    @close="emit('close')"
  >
    <template v-if="entry" #footer>
      <a-button
        block
        :type="isCurrent ? 'default' : 'primary'"
        :style="isCurrent ? { color: '#52c41a', borderColor: '#52c41a' } : undefined"
        :disabled="isCurrent || !!busy"
        @click="onSwitch"
      >
        <template #icon>
          <CheckCircleFilled v-if="isCurrent" />
          <SwapOutlined v-else />
        </template>
        {{ isCurrent ? '当前使用' : '切换到该 Key' }}
      </a-button>
    </template>

    <template v-if="entry">
      <a-space style="margin-bottom: 16px" wrap>
        <a-button
          :loading="busy === 'sync'"
          :disabled="!!busy && busy !== 'sync'"
          @click="sync"
        >
          <template #icon><SyncOutlined /></template>刷新用量
        </a-button>
        <a-button @click="emit('test', entry)">
          <template #icon><SendOutlined /></template>在线测活
        </a-button>
        <a-button @click="emit('edit', entry)">修改备注</a-button>
        <a-button @click="exportKey">
          <template #icon><DownloadOutlined /></template>导出
        </a-button>
      </a-space>

      <a-alert
        v-if="issue"
        class="issue-alert"
        type="error"
        show-icon
        :message="issue"
        style="margin-bottom: 16px"
      />

      <a-alert
        message="API Key 可直接调用 Kiro 官方服务，请勿分享给他人。"
        type="warning"
        show-icon
        style="margin-bottom: 16px"
      />

      <div class="section-title">
        API Key
        <a-button
          v-if="settingsStore.settings.privacyMode"
          type="link"
          size="small"
          @click="showSecret = !showSecret"
        >
          <template #icon>
            <EyeInvisibleOutlined v-if="showSecret" />
            <EyeOutlined v-else />
          </template>
          {{ showSecret ? '隐藏' : '显示' }}
        </a-button>
      </div>
      <a-descriptions
        :column="1"
        size="small"
        bordered
        :label-style="labelStyle"
        style="margin-bottom: 18px"
      >
        <a-descriptions-item label="完整凭证">
          <div class="cell-row">
            <span class="mono cell-key" :title="showSecret || !settingsStore.settings.privacyMode ? entry.key : undefined">
              {{ maskedKey }}
            </span>
            <a-button type="link" size="small" class="cell-action" @click="copyKey">
              <template #icon><CopyOutlined /></template>
              复制
            </a-button>
          </div>
        </a-descriptions-item>
        <a-descriptions-item label="邮箱">
          <div v-if="entry.email" class="cell-row">
            <span
              class="cell-key"
              :title="settingsStore.settings.privacyMode ? undefined : entry.email"
            >{{ emailText }}</span>
            <a-button type="link" size="small" class="cell-action" @click="copyEmail">
              <template #icon><CopyOutlined /></template>
              复制
            </a-button>
          </div>
          <span v-else class="muted">-</span>
        </a-descriptions-item>
        <a-descriptions-item label="User ID">
          <div v-if="entry.userId" class="cell-row">
            <span
              class="mono cell-key"
              :title="settingsStore.settings.privacyMode ? undefined : entry.userId"
            >{{ userIdText }}</span>
            <a-button type="link" size="small" class="cell-action" @click="copyUserId">
              <template #icon><CopyOutlined /></template>
              复制
            </a-button>
          </div>
          <span v-else class="muted">-</span>
        </a-descriptions-item>
      </a-descriptions>

      <div class="section-title">基本信息</div>
      <a-descriptions
        :column="1"
        size="small"
        bordered
        :label-style="labelStyle"
        style="margin-bottom: 18px"
      >
        <a-descriptions-item label="状态">
          <a-tag :color="issue ? 'red' : entry.lastCheckedAt ? 'green' : 'default'">
            {{ issue ? '异常' : entry.lastCheckedAt ? '正常' : '未检查' }}
          </a-tag>
          <a-tag v-if="entry.id === keysStore.data.activeKeyId" color="green">当前使用</a-tag>
        </a-descriptions-item>
        <a-descriptions-item label="备注">{{ noteText }}</a-descriptions-item>
        <a-descriptions-item label="区域">
          <div class="cell-row">
            <span>{{ regionLabel(entry.region) }}</span>
            <a-button type="link" size="small" class="cell-action" @click="openRegion">
              <template #icon><GlobalOutlined /></template>
              修改
            </a-button>
          </div>
        </a-descriptions-item>
        <a-descriptions-item label="添加时间">{{ formatDateTime(entry.createdAt) }}</a-descriptions-item>
        <a-descriptions-item label="最后同步">{{ formatDateTime(entry.lastCheckedAt) }}</a-descriptions-item>
      </a-descriptions>

      <div class="section-title">订阅</div>
      <a-descriptions
        :column="1"
        size="small"
        bordered
        :label-style="labelStyle"
        style="margin-bottom: 18px"
      >
        <a-descriptions-item label="套餐">
          <a-tag :color="subscriptionColor(entry.tier)">{{ entry.subscription || '未知' }}</a-tag>
        </a-descriptions-item>
        <a-descriptions-item label="下次重置">
          {{ entry.nextResetAt ? formatDate(entry.nextResetAt) : '-' }}
          <span v-if="resetDays !== undefined" class="muted">（{{ resetDays }} 天后）</span>
        </a-descriptions-item>
      </a-descriptions>

      <div class="section-title">积分与用量</div>
      <a-progress
        :percent="Math.min(100, Math.round(percentUsed * 1000) / 10)"
        :stroke-color="usageColor(percentUsed)"
      />
      <p class="muted" style="margin: 4px 0 12px">
        总计 {{ formatCreditsPair(entry.usedCredits, entry.totalCredits, precision) }} Credits
      </p>

      <a-descriptions
        :column="1"
        size="small"
        bordered
        :label-style="labelStyle"
        style="margin-bottom: 12px"
      >
        <a-descriptions-item
          v-if="entry.baseTotalCredits !== undefined"
          label="基础额度"
        >
          {{ formatCreditsPair(entry.baseUsedCredits, entry.baseTotalCredits, precision) }}
        </a-descriptions-item>
        <!-- 旧数据没有基础 / 奖励拆分时，退回只显示总额度 -->
        <a-descriptions-item
          v-else-if="!entry.bonuses?.length"
          label="额度"
        >
          {{ formatCreditsPair(entry.usedCredits, entry.totalCredits, precision) }}
        </a-descriptions-item>
        <!-- 奖励额度：各条奖励一行，第二行显示「bonusType • description」 -->
        <a-descriptions-item
          v-for="bonus in entry.bonuses || []"
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
      </a-descriptions>

      <a-modal
        v-if="regionOpen"
        v-model:open="regionOpen"
        title="修改所属区域"
        centered
        :confirm-loading="savingRegion"
        @ok="submitRegion"
      >
        <a-form layout="vertical">
          <a-form-item label="区域" required>
            <RegionSelect v-model:value="regionValue" />
          </a-form-item>
        </a-form>
        <a-alert
          type="warning"
          show-icon
          message="换区后该 Key 已缓存的订阅、额度与积分历史会被清空，需要重新同步。"
        />
      </a-modal>
    </template>
  </a-drawer>
</template>

<style scoped>
.section-title { display: flex; align-items: center; margin: 4px 0 8px; font-weight: 600; }
/*
 * 表格单元格里值占满、右侧操作按钮对齐（区域与凭证复用同一布局）。
 * 值与右侧「复制/修改」按钮垂直居中，和左侧 label 落在同一条水平轴上。
 */
.cell-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
/* label 与 content 同为垂直居中，避免 label 顶对齐、值居中造成的错位 */
:deep(.ant-descriptions-item-label),
:deep(.ant-descriptions-item-content) { vertical-align: middle; }
/* 完整展示不截断：长串按字符换行，min-width:0 让它能在 flex 里正常收缩 */
.cell-key { flex: 1 1 auto; min-width: 0; word-break: break-all; white-space: normal; line-height: 1.7; }
.cell-action { flex: 0 0 auto; padding: 0; height: auto; line-height: 1.7; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 12px; }
.muted { color: var(--kal-muted); }
/* 上游错误是整段 JSON，里面的长 URL 没有可断行的空格，需要按字符断开才不会溢出容器 */
.issue-alert :deep(.ant-alert-message) { word-break: break-word; overflow-wrap: anywhere; }
</style>
