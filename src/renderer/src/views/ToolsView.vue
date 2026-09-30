<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { message } from 'ant-design-vue'
import {
  CheckCircleFilled,
  ExclamationCircleFilled,
  MinusCircleOutlined,
  ReloadOutlined,
  ThunderboltOutlined
} from '@ant-design/icons-vue'
import PathMenu from '@/components/common/PathMenu.vue'
import { useSettingsStore } from '@/stores/settings'
import MachineIdCard from '@/components/tools/MachineIdCard.vue'
import NetworkCheckCard from '@/components/tools/NetworkCheckCard.vue'
import { RETRYABLE_STATUS_OPTIONS, normalizeRetryStatuses } from '@shared/retryPolicy'
import type { ShellAutoApproveStatus, ShellAutoApproveTarget } from '@shared/types'

const status = ref<ShellAutoApproveStatus | null>(null)
const loading = ref(false)
const busy = ref(false)
const confirmOpen = ref(false)

// ============ 网关错误自动续接 ============
const settingsStore = useSettingsStore()
const savingRetry = ref(false)
const savingStatuses = ref(false)
/** 与主进程 keyGateway 的 RETRY_DELAY_MS 保持一致，仅用于文案展示 */
const statusOptions = RETRYABLE_STATUS_OPTIONS
const maxAttempts = computed(() => settingsStore.settings.gatewayRetryMaxAttempts)
const retryDelay = computed(() => settingsStore.settings.gatewayRetryDelayMs)
const autoRetry = computed(() => settingsStore.settings.gatewayAutoRetryThrottle)
const selectedStatuses = computed(() =>
  normalizeRetryStatuses(settingsStore.settings.gatewayRetryStatuses)
)
/** 推荐项：重试通常有效的那些 */
const recommendedStatuses = statusOptions.filter((o) => o.recommended).map((o) => o.status)

async function onAutoRetry(next: boolean): Promise<void> {
  if (savingRetry.value) return
  savingRetry.value = true
  try {
    // 开启时如果一项都没勾，直接补上推荐项，避免"开了但什么都不重试"
    const patch: Record<string, unknown> = { gatewayAutoRetryThrottle: next }
    if (next && !selectedStatuses.value.length) patch.gatewayRetryStatuses = recommendedStatuses
    await settingsStore.update(patch)
    message.success(
      next ? '已开启：命中所选错误时网关会自动重试，不会更换 Key' : '已关闭：错误会直接透传给 Kiro IDE'
    )
  } finally {
    savingRetry.value = false
  }
}

/** 点一下切换某个状态码的勾选状态 */
async function toggleStatus(status: number): Promise<void> {
  if (savingStatuses.value) return
  const current = selectedStatuses.value
  const next = current.includes(status)
    ? current.filter((s) => s !== status)
    : [...current, status]
  savingStatuses.value = true
  try {
    await settingsStore.update({ gatewayRetryStatuses: normalizeRetryStatuses(next) })
  } finally {
    savingStatuses.value = false
  }
}

async function onMaxAttempts(value: unknown): Promise<void> {
  // 同上：只接受真正的数字，清空输入框不写入
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) return
  await settingsStore.update({ gatewayRetryMaxAttempts: Math.min(100, Math.round(value)) })
}

async function onRetryDelay(value: unknown): Promise<void> {
  // 清空输入框时 a-input-number 会传 null，而 Number(null) 是 0——
  // 若照单全收就会静默变成「0ms 间隔」疯狂重试，所以只接受真正的数字。
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return
  await settingsStore.update({ gatewayRetryDelayMs: Math.min(60_000, Math.round(value)) })
}

async function resetStatuses(): Promise<void> {
  await settingsStore.update({ gatewayRetryStatuses: recommendedStatuses })
  message.success('已恢复为推荐的状态码')
}

const enabled = computed(() => status.value?.enabled === true)
const partial = computed(() => status.value?.partial === true)
/** 已写入放行，但存在优先级更高的拦截规则，命令仍会被拦下 */
const denyConflict = computed(() => status.value?.denyConflict === true)
/** 开关关闭，但用户自己配了放行规则，命令依然不会弹窗 */
const externalAllow = computed(() => status.value?.externalAllow === true)
const blockedReason = computed(() => status.value?.blockedReason)
const targets = computed(() => status.value?.targets ?? [])

async function refresh(): Promise<void> {
  loading.value = true
  try {
    const res = await window.api.getShellAutoApproveStatus()
    if (!res.success || !res.data) return void message.error(res.error || '读取权限配置失败')
    status.value = res.data
  } finally {
    loading.value = false
  }
}

async function reveal(target: ShellAutoApproveTarget): Promise<void> {
  const res = await window.api.revealShellApproveTarget(target.kind)
  if (!res.success) return void message.error(res.error || '打开目录失败')
  if (!target.fileExists) message.info('该文件还不存在，已打开它所在的目录')
}

function onSwitch(next: boolean): void {
  if (busy.value) return
  if (next) {
    if (blockedReason.value) return void message.warning(blockedReason.value)
    confirmOpen.value = true
    return
  }
  void disable()
}

async function enable(): Promise<void> {
  busy.value = true
  try {
    const res = await window.api.enableShellAutoApprove()
    if (!res.success || !res.data) return void message.error(res.error || '开启失败')
    status.value = res.data
    confirmOpen.value = false
    // Kiro 实时读取设置并监听权限文件，两套机制都是热加载
    message.success('已开启，Kiro 会立即生效，无需重启')
  } finally {
    busy.value = false
  }
}

async function disable(): Promise<void> {
  busy.value = true
  try {
    const restored = status.value?.hasBackup === true
    const res = await window.api.disableShellAutoApprove()
    if (!res.success || !res.data) return void message.error(res.error || '关闭失败')
    status.value = res.data
    message.success(
      restored ? '已关闭并还原开启前的配置' : '已关闭，已移除本应用写入的放行项'
    )
  } finally {
    busy.value = false
  }
}

onMounted(() => void refresh())
</script>

<template>
  <div class="tools-page">
    <a-card class="tool-card" :bordered="false">
      <div class="tool-row">
        <div class="tool-main">
          <div class="tool-title">
            <ThunderboltOutlined />
            <strong>自动同意 AI 操作（命令 / 文件 / 网络）</strong>
            <a-tag :color="enabled ? 'success' : partial ? 'warning' : 'default'">
              {{ enabled ? '已开启' : partial ? '部分生效' : '未开启' }}
            </a-tag>
          </div>
          <div class="tool-desc">
            开启后 Kiro 执行终端命令、读写文件、发起网络请求与网络搜索都不再逐条弹出确认框，直接放行。
          </div>
          <div class="tool-hint">
            Kiro 不同版本用了两套机制，本工具同时写入以覆盖两者：0.x 走 IDE 设置
            <span class="mono">kiroAgent.trustedCommands</span>（加入通配项 <span class="mono">*</span>，
            并临时清空优先级更高的 <span class="mono">commandDenylist</span>，仅对终端命令生效）；1.0+ 走
            <span class="mono">permissions.yaml</span>（追加不带 match 的
            <span class="mono">shell / fs_read / fs_write / web_fetch / web_search</span> allow 规则）。
            你原有的配置会被完整备份，关闭开关即还原。
          </div>
        </div>
        <a-switch
          :checked="enabled || partial"
          :loading="busy || loading"
          :disabled="!!blockedReason && !enabled && !partial"
          @change="(next: any) => onSwitch(!!next)"
        />
      </div>

      <a-alert
        v-if="blockedReason"
        class="tool-alert"
        type="warning"
        show-icon
        :message="blockedReason"
      />
      <a-alert
        v-else-if="denyConflict"
        class="tool-alert"
        type="warning"
        show-icon
        message="存在优先级更高的拒绝规则，命令仍可能被拦下"
        :description="status?.denyConflictReason"
      />
      <a-alert
        v-else-if="externalAllow"
        class="tool-alert"
        type="info"
        show-icon
        message="检测到你自己已配置了放行规则（shell、文件读写、网络请求与搜索均为不带 match 的 allow），这些操作本来就不会弹窗。这些规则不属于本应用，关闭开关时不会改动它们。"
      />

      <div class="target-list">
        <div v-for="item in targets" :key="item.kind" class="target-row">
          <CheckCircleFilled v-if="item.applied" class="ok-icon" />
          <MinusCircleOutlined v-else class="idle-icon" />
          <div class="target-body">
            <div class="target-label">
              {{ item.label }}
              <a-tag v-if="!item.writable" color="default">不可用</a-tag>
              <a-tag v-else-if="item.applied" color="success">已生效</a-tag>
              <a-tag v-else color="default">未写入</a-tag>
            </div>
            <div class="target-path">
              <PathMenu :path="item.path" @reveal="reveal(item)" />
            </div>
            <div v-if="item.note" class="target-note">{{ item.note }}</div>
          </div>
        </div>
      </div>

      <div class="tool-meta">
        <span class="muted">修改后 Kiro 立即生效，无需重启</span>
        <span class="spacer" />
        <a-button size="small" :loading="loading" @click="refresh">
          <template #icon><ReloadOutlined /></template>
          重新检测
        </a-button>
      </div>
    </a-card>

    <a-card class="tool-card" :bordered="false">
      <div class="tool-row">
        <div class="tool-main">
          <div class="tool-title">
            <ThunderboltOutlined />
            <strong>网关错误自动续接</strong>
            <a-tag :color="autoRetry ? 'success' : 'default'">
              {{ autoRetry ? '已开启' : '未开启' }}
            </a-tag>
          </div>
          <div class="tool-desc">
            开启后 API Key 网关遇到 Kiro 限流会自己等待并重发，对话不会中断，无需手动点继续。
          </div>
          <div class="tool-hint">
            Kiro 风控限流时会返回
            <span class="mono">Too many requests, please wait before trying again</span>，
            IDE 收到后就中断当前回答。网关在把响应交给 IDE 之前拦下这类错误，用
            <strong>同一个 API Key</strong> 重发，<strong>不会替换成别的 Key</strong>，
            额度消耗仍然记在当前 Key 上。本周期额度已用尽的情况不会重试，会直接透传让你及时发现。
          </div>
        </div>
        <a-switch :checked="autoRetry" :loading="savingRetry" @change="(v: any) => onAutoRetry(!!v)" />
      </div>

      <div class="retry-picker" :class="{ disabled: !autoRetry }">
        <div class="picker-title">
          <span>最多重试</span>
          <a-input-number
            :value="maxAttempts"
            :min="1"
            :max="100"
            :step="1"
            size="small"
            style="width: 82px"
            :disabled="!autoRetry"
            @change="(v: any) => onMaxAttempts(v)"
          />
          <span class="muted">次</span>
          <a-divider type="vertical" style="margin: 0 4px" />
          <span>间隔</span>
          <a-input-number
            :value="retryDelay"
            :min="0"
            :max="60000"
            :step="50"
            size="small"
            style="width: 96px"
            :disabled="!autoRetry"
            @change="(v: any) => onRetryDelay(v)"
          />
          <span class="muted">ms</span>
          <span class="spacer" />
          <a-button type="link" size="small" :disabled="!autoRetry" @click="resetStatuses">
            恢复推荐
          </a-button>
        </div>

        <div class="picker-title">
          <span>遇到哪些错误时自动重试</span>
          <span class="muted">已选 {{ selectedStatuses.length }} 项</span>
        </div>
        <div class="chips">
          <button
            v-for="opt in statusOptions"
            :key="opt.status"
            type="button"
            class="chip"
            :class="{ on: selectedStatuses.includes(opt.status) }"
            :disabled="!autoRetry || savingStatuses"
            :title="opt.desc"
            @click="toggleStatus(opt.status)"
          >
            <span class="chip-text">
              <span class="chip-code mono">{{ opt.status }}</span>
              <span class="chip-label">{{ opt.label }}</span>
            </span>
            <CheckCircleFilled
              class="chip-check"
              :class="{ hidden: !selectedStatuses.includes(opt.status) }"
            />
          </button>
        </div>
      </div>

    </a-card>

    <MachineIdCard />

    <NetworkCheckCard />

    <a-modal
      :open="confirmOpen"
      :width="560"
      centered
      :mask-closable="false"
      :closable="!busy"
      @cancel="confirmOpen = false"
    >
      <template #title>
        <span class="modal-title">
          <ExclamationCircleFilled style="color: #faad14" />
          开启前请确认风险
        </span>
      </template>

      <p class="modal-lead">
        开启后，Kiro 执行终端命令、读写文件、发起网络请求与网络搜索都不再需要你逐条确认。
      </p>

      <a-alert
        type="error"
        show-icon
        style="margin-bottom: 14px"
        message="这等于把终端、文件系统和网络访问都交给 AI"
        description="包括 rm -rf、del、Remove-Item 等破坏性命令，以及任意文件的读写、任意网址的请求都会直接执行，并且开启期间会临时清空你的命令拒绝名单。若 AI 被网页等外部内容里的指令误导，也没有人工关卡。"
      />

      <ul class="modal-points">
        <li>
          写入 Kiro IDE 设置的 <span class="mono">kiroAgent.trustedCommands</span> 与
          <span class="mono">~/.kiro/settings/permissions.yaml</span>（放行 shell、文件读写、网络请求与搜索），
          均为追加方式，你原有条目保持不变。
        </li>
        <li>开启前的原值会被完整备份，关闭开关时原样还原（原本没有的键或文件会被删除）。</li>
        <li>Kiro 实时读取设置并监听权限文件，<strong>无需重启</strong>。</li>
        <li>建议只在自己信任的项目里临时开启，用完及时关闭。</li>
      </ul>

      <template #footer>
        <a-button :disabled="busy" @click="confirmOpen = false">取消</a-button>
        <a-button type="primary" danger :loading="busy" @click="enable">
          <template #icon><CheckCircleFilled /></template>
          我已了解风险，仍要开启
        </a-button>
      </template>
    </a-modal>
  </div>
</template>

<style scoped>
.tools-page { display: flex; flex-direction: column; gap: 16px; }
.tool-card { border: 1px solid var(--kal-border); }
.tool-row { display: flex; align-items: flex-start; gap: 16px; }
.tool-main { flex: 1 1 auto; min-width: 0; }
.tool-title { display: flex; align-items: center; gap: 9px; font-size: 16px; }
.tool-desc { margin-top: 8px; font-size: 13px; }
.tool-hint { margin-top: 6px; color: var(--kal-muted); font-size: 12px; line-height: 1.7; }
.tool-alert { margin-top: 14px; }

/* 状态码选择：紧凑的圆角块，两行（代码 + 标题），选中高亮紫色 */
.retry-picker { margin-top: 16px; padding-top: 14px; border-top: 1px solid var(--kal-border); }
.retry-picker.disabled { opacity: 0.55; }
.picker-title {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
  font-size: 13px;
  font-weight: 600;
}
.picker-title .muted { font-weight: 400; font-size: 12px; }
.chips { display: flex; flex-wrap: wrap; gap: 8px; }
/* 数字与标题左对齐成一列，勾选图标贴在右侧，不挤压文字 */
.chip {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border: 1px solid var(--kal-border);
  border-radius: 10px;
  background: var(--kal-block-bg);
  color: inherit;
  cursor: pointer;
  transition: border-color 0.16s ease, background 0.16s ease, color 0.16s ease;
}
.chip:hover:not(:disabled) { border-color: var(--kal-primary); }
.chip:disabled { cursor: not-allowed; }
.chip-text { display: flex; flex-direction: column; align-items: flex-start; gap: 1px; }
.chip-code { font-size: 16px; font-weight: 700; line-height: 1.2; font-variant-numeric: tabular-nums; }
.chip-label { font-size: 11px; line-height: 1.3; color: var(--kal-muted); }
/* 图标始终占位，未选中时只是隐藏：否则点击后整块宽度会变，一排 chip 跟着抖 */
.chip-check { flex: 0 0 auto; font-size: 14px; color: var(--kal-primary); }
.chip-check.hidden { visibility: hidden; }
/* 选中态：紫色描边 + 淡紫底，文字跟着变主色 */
.chip.on {
  border-color: var(--kal-primary);
  background: color-mix(in srgb, var(--kal-primary) 12%, transparent);
  color: var(--kal-primary);
}
.chip.on .chip-label { color: var(--kal-primary); }
.target-list { display: flex; flex-direction: column; gap: 12px; margin-top: 16px; padding-top: 14px; border-top: 1px solid var(--kal-border); }
.target-row { display: flex; align-items: flex-start; gap: 10px; }
.ok-icon { margin-top: 3px; color: #52c41a; }
.idle-icon { margin-top: 3px; color: var(--kal-muted); }
.target-body { flex: 1 1 auto; min-width: 0; }
.target-label { display: flex; align-items: center; gap: 8px; font-size: 13px; }
/* 路径完整展示，不做省略：窄窗口下允许整体换行，按钮跟着走 */
.target-path { display: flex; align-items: center; flex-wrap: wrap; gap: 2px 6px; margin-top: 2px; font-size: 12px; color: var(--kal-muted); }
.target-note { margin-top: 2px; font-size: 12px; color: #d48806; }
.path-text { word-break: break-all; }
.target-path :deep(.ant-btn-link) { flex: 0 0 auto; padding: 0 4px; height: 20px; font-size: 12px; }
.tool-meta { display: flex; align-items: center; gap: 8px; margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--kal-border); font-size: 12px; }
.spacer { flex: 1 1 auto; }
.modal-title { display: inline-flex; align-items: center; gap: 8px; }
.modal-lead { margin: 0 0 12px; }
.modal-points { margin: 0; padding-left: 20px; color: var(--kal-muted); font-size: 12.5px; line-height: 1.9; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
.muted { color: var(--kal-muted); }
</style>
