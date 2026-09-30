<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { message } from 'ant-design-vue'
import {
  CopyOutlined,
  FolderOpenOutlined,
  IdcardOutlined,
  ReloadOutlined,
  RollbackOutlined,
  SyncOutlined
} from '@ant-design/icons-vue'
import { copyText, confirmDanger } from '@/utils/ui'
import { formatDateTime } from '@/utils/format'
import type { MachineIdActionResult, MachineIdField, MachineIdStatus } from '@shared/types'

const status = ref<MachineIdStatus | null>(null)
const loading = ref(false)
/** 当前正在执行的动作，用于给对应按钮上 loading、同时禁用其它按钮 */
const busy = ref<'' | 'reset' | 'restore'>('')

const backup = computed(() => status.value?.backup ?? null)

/** 顶部状态标签：没备份 / 与原始一致 / 已被改动 */
const stateTag = computed(() => {
  if (!status.value) return { color: 'default', text: '读取中' }
  if (!backup.value) return { color: 'default', text: '未备份' }
  if (status.value.matchesBackup) return { color: 'success', text: '原始机器码' }
  return { color: 'processing', text: '已重置' }
})

const rows = computed(() =>
  (status.value?.locations ?? []).map((loc) => {
    const value = status.value?.current[loc.field]
    const original = backup.value?.ids[loc.field]
    return {
      ...loc,
      value,
      // 有备份时标出和原始值不同的项，一眼看出这次重置改了哪些
      changed: !!backup.value && (value ?? '') !== (original ?? ''),
      // Windows 的共享 deviceid 在注册表里，没有文件可定位
      revealable: !loc.path.startsWith('HKCU\\')
    }
  })
)

async function refresh(): Promise<void> {
  loading.value = true
  try {
    const res = await window.api.getMachineIdStatus()
    if (!res.success || !res.data) return void message.error(res.error || '读取机器码失败')
    status.value = res.data
  } finally {
    loading.value = false
  }
}

async function reveal(field: MachineIdField): Promise<void> {
  const res = await window.api.revealMachineIdLocation(field)
  if (!res.success) message.error(res.error || '打开目录失败')
}

/** 重置 / 恢复共用的结果提示：说明 IDE 被关闭、重启的情况，并逐条列出失败项 */
function reportAction(result: MachineIdActionResult, done: string): void {
  status.value = result.status
  const ide = result.ideClosed
    ? result.ideRestarted
      ? '，Kiro IDE 已重启'
      : '，Kiro IDE 已关闭，请手动打开'
    : '，下次启动 Kiro IDE 时生效'
  if (result.warnings.length) {
    message.warning(`${done}${ide}；部分位置未写入：${result.warnings.join('；')}`, 6)
  } else {
    message.success(`${done}${ide}`)
  }
}

function onReset(): void {
  confirmDanger({
    title: '重置 Kiro 机器码？',
    content:
      (backup.value
        ? '将生成一整套新的设备标识，原始备份保持不变，可随时恢复。'
        : '将生成一整套新的设备标识。首次重置前会自动备份当前机器码，之后可随时恢复。') +
      'Kiro IDE 正在运行时会先关闭它，写入后再重新打开。',
    okText: '重置',
    okButtonProps: { type: 'primary', danger: true },
    onOk: async () => {
      busy.value = 'reset'
      try {
        const res = await window.api.resetMachineId()
        if (!res.success || !res.data) return void message.error(res.error || '重置失败')
        reportAction(res.data, '机器码已重置')
      } finally {
        busy.value = ''
      }
    }
  })
}

function onRestore(): void {
  if (!backup.value) return
  confirmDanger({
    title: '恢复原始机器码？',
    content: `将写回 ${formatDateTime(backup.value.savedAt)} 备份的机器码。Kiro IDE 正在运行时会先关闭它，写入后再重新打开。`,
    okText: '恢复',
    okButtonProps: { type: 'primary' },
    onOk: async () => {
      busy.value = 'restore'
      try {
        const res = await window.api.restoreMachineId()
        if (!res.success || !res.data) return void message.error(res.error || '恢复失败')
        reportAction(res.data, '已恢复原始机器码')
      } finally {
        busy.value = ''
      }
    }
  })
}

onMounted(() => void refresh())
</script>

<template>
  <a-card class="tool-card" :bordered="false">
    <div class="tool-title">
      <IdcardOutlined />
      <strong>机器码重置与恢复</strong>
      <a-tag :color="stateTag.color">{{ stateTag.text }}</a-tag>
      <span class="spacer" />
      <!-- 操作按钮与标题同一行、靠右：卡片下方只留参数，整体更紧凑 -->
      <a-space :size="8" wrap>
        <a-button size="small" :loading="loading" :disabled="!!busy" @click="refresh">
          <template #icon><ReloadOutlined /></template>
          重新读取
        </a-button>
        <a-button
          size="small"
          :loading="busy === 'restore'"
          :disabled="!!busy || !backup || status?.matchesBackup"
          @click="onRestore"
        >
          <template #icon><RollbackOutlined /></template>
          恢复原始
        </a-button>
        <a-button
          size="small"
          type="primary"
          danger
          :loading="busy === 'reset'"
          :disabled="!!busy || status?.kiroMissing"
          @click="onReset"
        >
          <template #icon><SyncOutlined /></template>
          重置机器码
        </a-button>
      </a-space>
    </div>
    <div class="tool-desc">
      为 Kiro IDE 生成一整套新的设备标识，或写回备份的原始机器码。
      <span class="muted backup-note">
        {{ backup ? `原始备份：${formatDateTime(backup.savedAt)}` : '暂无备份，首次重置前会自动备份' }}
      </span>
    </div>
    <div class="tool-hint">
      Kiro 的设备标识分散在 <span class="mono">storage.json</span>、<span class="mono">machineid</span> 文件、
      <span class="mono">state.vscdb</span> 与 Microsoft DeveloperTools 的共享 <span class="mono">deviceid</span>
      四处，只改一处 IDE 启动时会从别处读回来，所以这里一起改。共享 deviceid 同时被 VS Code 等工具使用，
      重置后它们的设备标识也会跟着变。IDE 退出时会把内存里的值写回磁盘，因此写入前会先关闭正在运行的 Kiro IDE。
    </div>

    <a-alert
      v-if="status?.kiroMissing"
      class="tool-alert"
      type="warning"
      show-icon
      message="没有找到 Kiro 数据目录，请先安装并启动一次 Kiro IDE"
    />

    <!-- 每项一个圆角块，按内容宽度自动换行排布 -->
    <div class="id-list">
      <div v-for="row in rows" :key="row.field" class="id-chip" :class="{ changed: row.changed }">
        <span class="id-label mono">{{ row.label }}</span>
        <span v-if="row.value" class="mono value-text">{{ row.value }}</span>
        <span v-else class="muted value-text">{{ row.value === '' ? '（空）' : '（不存在）' }}</span>
        <a-tooltip v-if="row.changed" title="与原始备份不同">
          <span class="changed-dot" />
        </a-tooltip>
        <a-tooltip v-if="row.value" title="复制">
          <a-button type="text" size="small" @click="copyText(row.value, '已复制')">
            <template #icon><CopyOutlined /></template>
          </a-button>
        </a-tooltip>
        <a-tooltip v-if="row.revealable" :title="row.path">
          <a-button type="text" size="small" @click="reveal(row.field)">
            <template #icon><FolderOpenOutlined /></template>
          </a-button>
        </a-tooltip>
        <a-tooltip v-else :title="row.path">
          <span class="muted reg-hint">注册表</span>
        </a-tooltip>
      </div>
    </div>
  </a-card>
</template>

<style scoped>
.tool-card { border: 1px solid var(--kal-border); }
.tool-title { display: flex; align-items: center; flex-wrap: wrap; gap: 9px; font-size: 16px; }
.tool-desc { margin-top: 8px; font-size: 13px; }
.backup-note { margin-left: 8px; font-size: 12px; }
.tool-hint { margin-top: 6px; color: var(--kal-muted); font-size: 12px; line-height: 1.7; }
.tool-alert { margin-top: 14px; }
.id-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 14px;
  padding-top: 14px;
  border-top: 1px solid var(--kal-border);
}
.id-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  padding: 3px 4px 3px 10px;
  border: 1px solid var(--kal-border);
  border-radius: 8px;
  background: var(--kal-block-bg);
  font-size: 12px;
}
/* 和原始备份不同的项：描边换成主题色，一眼看出这次重置改了哪些 */
.id-chip.changed { border-color: color-mix(in srgb, var(--kal-primary) 45%, var(--kal-border)); }
.id-label { flex: 0 0 auto; color: var(--kal-muted); }
/* 64 位 hex 在窄窗口下允许断行，不撑破卡片 */
.value-text { min-width: 0; word-break: break-all; }
.changed-dot {
  flex: 0 0 auto;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--kal-primary);
}
.id-chip :deep(.ant-btn) { flex: 0 0 auto; width: 22px; height: 22px; min-width: 22px; padding: 0; font-size: 12px; }
.reg-hint { flex: 0 0 auto; padding-right: 6px; cursor: help; }
.spacer { flex: 1 1 auto; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
.muted { color: var(--kal-muted); }
</style>
