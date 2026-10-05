<script setup lang="ts">
// 用 API Key 连接 Kiro CLI：一键写入环境变量 KIRO_API_KEY（新开的终端自动生效），或复制命令手动设置
import { computed, ref, watch } from 'vue'
import { message } from 'ant-design-vue'
import {
  CheckCircleFilled,
  CopyOutlined,
  DeleteOutlined,
  ExportOutlined,
  ThunderboltOutlined
} from '@ant-design/icons-vue'
import { useSettingsStore } from '@/stores/settings'
import { displayKey as maskedKey } from '@/utils/display'
import type { KiroCliEnvStatus } from '@shared/types'

const props = defineProps<{
  open: boolean
  /** 完整 Key：用于写入与复制，界面上展示的是 displayKey */
  apiKey: string
  /** 按隐私设置处理过的 Key，用于展示 */
  displayKey: string
}>()
const emit = defineEmits<{ (e: 'update:open', value: boolean): void }>()

const settingsStore = useSettingsStore()
const DOC_URL = 'https://kiro.dev/docs/getting-started/authentication/#use-the-api-key'

const isWindows = /win/i.test(navigator.platform)
const isMac = /mac/i.test(navigator.platform)

// ============ 一键写入 ============

const env = ref<KiroCliEnvStatus | null>(null)
const busy = ref<'' | 'write' | 'remove'>('')

async function loadStatus(): Promise<void> {
  const res = await window.api.getKiroCliEnv()
  env.value = res.success && res.data ? res.data : null
}

/** 当前写着的是不是这张卡片的 Key */
const writtenThis = computed(() => env.value?.value === props.apiKey)
const writtenOther = computed(() => !!env.value?.value && !writtenThis.value)
const otherLabel = computed(() =>
  env.value?.value ? maskedKey(env.value.value, settingsStore.settings.privacyMode) : ''
)

async function writeEnv(): Promise<void> {
  busy.value = 'write'
  const res = await window.api.writeKiroCliEnv(props.apiKey)
  busy.value = ''
  if (!res.success || !res.data) {
    message.error(`写入失败：${res.error || '未知错误'}`)
    return
  }
  env.value = res.data
  message.success('已写入，新开一个终端即可直接使用 kiro-cli')
}

async function removeEnv(): Promise<void> {
  busy.value = 'remove'
  const res = await window.api.removeKiroCliEnv()
  busy.value = ''
  if (!res.success || !res.data) {
    message.error(`移除失败：${res.error || '未知错误'}`)
    return
  }
  env.value = res.data
  message.success('已移除 KIRO_API_KEY')
}

// ============ 手动设置 ============

/** macOS 默认 zsh，Linux 发行版大多默认 bash */
type Shell = 'zsh' | 'bash' | 'powershell' | 'cmd'
const defaultShell = (): Shell => (isWindows ? 'powershell' : isMac ? 'zsh' : 'bash')
const shell = ref<Shell>(defaultShell())

watch(
  () => props.open,
  (open) => {
    if (!open) return
    // 每次打开都回到本机系统对应的写法，并重新读一次写入状态
    shell.value = defaultShell()
    void loadStatus()
  },
  { immediate: true }
)

/**
 * 持久化写法：写进启动文件 / 用户环境变量，以后新开的终端都生效；
 * 第二行顺带让当前这个窗口也立刻生效，不用重开。
 * 同一份命令两种形态：展示用（可能打码）与复制用（完整 Key）。
 */
function command(key: string, kind: Shell): string {
  switch (kind) {
    case 'zsh':
      return `echo 'export KIRO_API_KEY=${key}' >> ~/.zshrc\nsource ~/.zshrc`
    case 'bash':
      return `echo 'export KIRO_API_KEY=${key}' >> ~/.bashrc\nsource ~/.bashrc`
    case 'powershell':
      return (
        `[Environment]::SetEnvironmentVariable('KIRO_API_KEY', '${key}', 'User')\n` +
        `$env:KIRO_API_KEY = '${key}'`
      )
    case 'cmd':
      // setx 只影响以后新开的窗口，当前窗口再 set 一次
      return `setx KIRO_API_KEY ${key}\nset KIRO_API_KEY=${key}`
  }
}

/** 每种写法写到了哪里、怎么撤掉 */
const SHELL_HINT: Record<Shell, string> = {
  zsh: '追加到 ~/.zshrc（macOS 默认终端）。撤销：删掉 ~/.zshrc 里这一行',
  bash: '追加到 ~/.bashrc（多数 Linux 发行版默认终端）。撤销：删掉 ~/.bashrc 里这一行',
  powershell: '写入 Windows 用户环境变量，PowerShell 与 cmd 都能读到。撤销：把第一行的 Key 换成 $null 再执行',
  cmd: '写入 Windows 用户环境变量，cmd 与 PowerShell 都能读到。撤销：在「编辑账户的环境变量」里删掉 KIRO_API_KEY'
}

const shown = computed(() => command(props.displayKey, shell.value))

function copyCommand(): void {
  window.api.writeClipboard(command(props.apiKey, shell.value))
  message.success('命令已复制（含完整 API Key）')
}

function openDoc(): void {
  window.api.openExternal(DOC_URL)
}
</script>

<template>
  <a-modal
    :open="open"
    title="用 API Key 连接 Kiro CLI"
    centered
    :width="640"
    :footer="null"
    @cancel="emit('update:open', false)"
  >
    <p class="lead">
      Kiro CLI 读取环境变量 <code>KIRO_API_KEY</code> 登录，不用浏览器，适合 CI/CD 与自动化脚本。
    </p>

    <!-- 一键写入：写到新开终端会自动读取的位置 -->
    <section class="block">
      <div class="block-head">
        <span class="block-title">一键写入</span>
        <span class="muted">
          {{
            isWindows
              ? '写入 Windows 用户环境变量，PowerShell、cmd 新开的窗口都能用'
              : '写入终端启动文件（zsh / bash / fish），新开的终端窗口都能用'
          }}
        </span>
      </div>

      <div class="env-state">
        <template v-if="writtenThis">
          <CheckCircleFilled class="ok" />
          <span>已写入这个 Key</span>
        </template>
        <template v-else-if="writtenOther">
          <span class="warn">当前写着另一个 Key：<span class="mono">{{ otherLabel }}</span></span>
        </template>
        <span v-else class="muted">尚未写入</span>
      </div>
      <div v-if="env?.locations.length" class="locations muted">
        <div v-for="loc in env.locations" :key="loc" class="mono">{{ loc }}</div>
      </div>

      <a-space :size="10" class="block-actions">
        <a-button
          type="primary"
          :loading="busy === 'write'"
          :disabled="writtenThis || busy === 'remove'"
          @click="writeEnv"
        >
          <template #icon><ThunderboltOutlined /></template>
          {{ writtenOther ? '改为这个 Key' : '写入' }}
        </a-button>
        <a-button
          v-if="env?.managed"
          danger
          :loading="busy === 'remove'"
          :disabled="busy === 'write'"
          @click="removeEnv"
        >
          <template #icon><DeleteOutlined /></template>
          移除
        </a-button>
      </a-space>
      <div class="hint muted">
        已经开着的终端不会自动生效，要新开一个；
        {{
          isWindows
            ? '从已运行的 VS Code 等编辑器里开的终端，要先重启编辑器。'
            : '或者在当前终端执行 source ~/.zshrc（bash 为 ~/.bashrc）。'
        }}
      </div>
    </section>

    <!-- 手动设置：只在当前终端窗口生效，不改任何文件 -->
    <section class="block">
      <div class="block-head">
        <span class="block-title">手动设置</span>
        <span class="muted">复制到终端执行一次，以后新开的终端也都生效</span>
      </div>
      <a-segmented
        v-model:value="shell"
        size="small"
        :options="[
          { label: 'macOS（zsh）', value: 'zsh' },
          { label: 'Linux（bash）', value: 'bash' },
          { label: 'PowerShell', value: 'powershell' },
          { label: 'cmd', value: 'cmd' }
        ]"
      />
      <div class="cmd-box">
        <pre class="mono">{{ shown }}</pre>
        <a-button size="small" class="cmd-copy" @click="copyCommand">
          <template #icon><CopyOutlined /></template>
          复制
        </a-button>
      </div>
      <div class="hint muted">{{ SHELL_HINT[shell] }}</div>
    </section>

    <ul class="notes muted">
      <li>API Key 只支持非交互模式（<code>kiro-cli chat --no-interactive</code>），交互对话仍需浏览器登录</li>
      <li>
        已经用 <code>kiro-cli login</code> 登录过时，CLI 优先用登录会话，不会用这个 Key；
        可运行 <code>kiro-cli whoami</code> 查看当前生效的方式
      </li>
      <li>仅 Kiro Pro、Pro+、Pro Max、Power 订阅可用，消耗的是该订阅的积分</li>
      <li>Key 以明文保存在上述位置，是长期有效的凭证，别提交到代码仓库；泄露后请到 Kiro 网页控制台撤销</li>
    </ul>

    <div class="footer">
      <a-button type="link" size="small" class="doc-link" @click="openDoc">
        <template #icon><ExportOutlined /></template>
        查看 Kiro 官方文档
      </a-button>
      <a-button @click="emit('update:open', false)">关闭</a-button>
    </div>
  </a-modal>
</template>

<style scoped>
.lead { margin: 0 0 12px; line-height: 1.7; }
code {
  padding: 0 4px;
  border-radius: 4px;
  background: var(--kal-block-bg);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 12px;
}
.block {
  margin-bottom: 14px;
  padding: 12px 14px;
  border: 1px solid var(--kal-border, rgba(0, 0, 0, 0.08));
  border-radius: 10px;
}
.block-head { display: flex; align-items: baseline; flex-wrap: wrap; gap: 4px 10px; margin-bottom: 10px; font-size: 12px; }
.block-title { font-size: 13px; font-weight: 600; }
.env-state { display: flex; align-items: center; gap: 6px; font-size: 13px; }
.env-state .ok { color: #52c41a; }
.env-state .warn { color: #d48806; }
.locations { margin-top: 6px; font-size: 12px; line-height: 1.7; word-break: break-all; }
.block-actions { margin-top: 10px; }
.hint { margin-top: 8px; font-size: 12px; line-height: 1.7; }
.cmd-box {
  position: relative;
  margin-top: 10px;
  padding: 12px 84px 12px 12px;
  border-radius: 8px;
  background: var(--kal-block-bg);
}
.cmd-box pre {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-all;
  font-size: 12.5px;
  line-height: 1.7;
}
.cmd-copy { position: absolute; top: 10px; right: 10px; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
.notes { margin: 0; padding-left: 18px; font-size: 12px; line-height: 1.8; }
.footer { display: flex; align-items: center; justify-content: space-between; margin-top: 14px; }
.doc-link { padding: 0; }
</style>
