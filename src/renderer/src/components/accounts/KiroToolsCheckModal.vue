<script setup lang="ts">
/**
 * 登录 Kiro CLI（含 KiroCrew）的弹窗：安装检测、登录、结果都在这一个弹窗里。
 *
 * 点「登录 Kiro CLI / 全部登录」就立刻打开，检测在弹窗里做（与订阅弹窗同一套路）：
 *   - 检测中：居中转圈，告诉用户在查什么；
 *   - 都已就绪（或用户本次已选过「没装 Crew 也继续」）：直接开始登录；
 *   - 缺 kiro-cli：给出当前平台的安装方法，只能「重新检测」或关闭；
 *   - kiro-cli 装了但从没运行过（没有凭证库）：给出初始化方法，同样只能重新检测；
 *   - 只缺 Kiro Crew：提示可选安装，可直接继续登录；
 *   - 检测本身失败：显示原因，可重试或跳过检测继续。
 *
 * 登录本身由调用方通过 run 传入，完成后就地显示成功 / 警告 / 失败结果。
 * Windows 上检测要起 PowerShell 重读 PATH、查注册表，一两秒的等待放在弹窗里，
 * 比点完菜单什么都不发生要好。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { message } from 'ant-design-vue'
import {
  CheckCircleFilled,
  CloseCircleFilled,
  CodeOutlined,
  ExclamationCircleFilled,
  SyncOutlined
} from '@ant-design/icons-vue'
import PathMenu from '@/components/common/PathMenu.vue'
import { copyText } from '@/utils/ui'
import {
  crewGuide,
  detectKiroTools,
  kiroCliGuide,
  skipCrewPrompt,
  toolsReady,
  type CliLoginOutcome,
  type InstallGuide
} from '@/utils/kiroToolsCheck'
import { errorMessage } from '@shared/errors'
import type { KiroToolsInstallInfo } from '@shared/types'

const props = defineProps<{
  /** cli：只登录 Kiro CLI；all：先登录 Kiro IDE 再登录 Kiro CLI */
  mode: 'cli' | 'all'
  /** 真正的登录动作；校验通过后在弹窗里执行，返回要展示的结果 */
  run: () => Promise<CliLoginOutcome>
}>()

const emit = defineEmits<{ close: [] }>()

const title = computed(() =>
  props.mode === 'all' ? '全部登录（Kiro IDE + Kiro CLI）' : '登录 Kiro CLI（含 KiroCrew）'
)

const loading = ref(true)
const error = ref('')
const info = ref<KiroToolsInstallInfo | null>(null)

/** 正在登录 / 登录结果 */
const loggingIn = ref(false)
const outcome = ref<CliLoginOutcome | null>(null)

/**
 * 弹窗已关闭。检测中用户就点了关闭时，检测结束后不能再自动开始登录：
 * 关掉弹窗就是不登录了，而且结果已经没处显示。
 */
let disposed = false
onBeforeUnmount(() => {
  disposed = true
})

async function startLogin(): Promise<void> {
  loggingIn.value = true
  try {
    outcome.value = await props.run()
  } catch (e) {
    outcome.value = {
      status: 'error',
      title: '登录 Kiro CLI 失败',
      alert: { type: 'error', message: errorMessage(e) },
      paths: []
    }
  } finally {
    loggingIn.value = false
  }
}

async function check(fresh: boolean): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const result = await detectKiroTools(fresh)
    if (disposed) return
    info.value = result
    if (toolsReady(result)) void startLogin()
  } catch (e) {
    error.value = errorMessage(e)
  } finally {
    loading.value = false
  }
}

onMounted(() => void check(false))

/** kiro-cli 装了，但从没运行过：还没有凭证库，写不进去 */
const needsInit = computed(() => !!info.value?.kiroCli.installed && !info.value.kiroCli.dbExists)

/**
 * 初始化命令。用检测到的完整路径：Windows 安装器不会把 kiro-cli 加进 PATH，
 * 新开的 PowerShell 里直接敲 kiro-cli 找不到。
 */
function initGuide(current: KiroToolsInstallInfo): InstallGuide {
  const bin = current.kiroCli.path || 'kiro-cli'
  const win = current.platform === 'win32'
  const quoted = /\s/.test(bin) ? `"${bin}"` : bin
  return {
    shell: win ? 'PowerShell' : '终端',
    // PowerShell 里带引号的路径要用 & 才会被当成命令执行
    command: win ? `& "${bin}" login` : `${quoted} login`,
    note: '按提示在浏览器里登录任意一个账号即可，登录完回来点「重新检测」，再写入要用的账号。',
    url: kiroCliGuide(current.platform).url
  }
}

interface GuideBlock {
  title: string
  guide: InstallGuide
  /** 做完之后要干什么 */
  after?: string
}

/** 只列还没就绪的那几项的处理方法 */
const guides = computed<GuideBlock[]>(() => {
  const current = info.value
  if (!current) return []
  const blocks: GuideBlock[] = []
  if (!current.kiroCli.installed) {
    blocks.push({
      title: '安装 kiro-cli',
      guide: kiroCliGuide(current.platform),
      after: '装好后回来点「重新检测」。'
    })
  } else if (!current.kiroCli.dbExists) {
    blocks.push({ title: '初始化 kiro-cli', guide: initGuide(current) })
  }
  if (!current.crew.installed) {
    blocks.push({ title: '安装 Kiro Crew（可选）', guide: crewGuide(current.platform) })
  }
  return blocks
})

function continueWithoutCrew(): void {
  skipCrewPrompt()
  void startLogin()
}

function copyCommand(guide: InstallGuide): void {
  if (guide.command) copyText(guide.command, '已复制命令')
}

/** 「打开所在目录」：主进程只放行 kiro-cli 自己目录下的文件 */
async function reveal(file: string): Promise<void> {
  const res = await window.api.revealKiroCliFile(file)
  if (!res.success) message.error(res.error || '打开目录失败')
}

function openGuide(guide: InstallGuide): void {
  void window.api.openExternal(guide.url)
}
</script>

<template>
  <!-- 写入凭证时不让关：关了结果就没处显示，用户也不知道到底切没切成 -->
  <a-modal
    :open="true"
    centered
    :width="outcome ? '760px' : '600px'"
    :footer="null"
    :closable="!loggingIn"
    :mask-closable="!loggingIn"
    :keyboard="!loggingIn"
    @cancel="emit('close')"
  >
    <template #title>
      <span v-if="outcome" class="modal-title">
        <CheckCircleFilled v-if="outcome.status === 'success'" style="color: #52c41a" />
        <ExclamationCircleFilled v-else-if="outcome.status === 'warning'" style="color: #faad14" />
        <CloseCircleFilled v-else style="color: #ff4d4f" />
        {{ outcome.title }}
      </span>
      <span v-else class="modal-title">
        <CodeOutlined />
        {{ title }}
      </span>
    </template>

    <!-- 结果页：与切号结果弹窗同一套扁平排版（一句话 + 提示条 + 明细 + 灰字 + 右下按钮） -->
    <div v-if="outcome" class="result">
      <p v-if="outcome.lead" class="lead">
        {{ outcome.lead.before }}<strong>{{ outcome.lead.strong }}</strong>{{ outcome.lead.after }}
      </p>

      <a-alert
        v-if="outcome.alert"
        :type="outcome.alert.type"
        show-icon
        :message="outcome.alert.message"
        :description="outcome.alert.description"
        class="result-alert"
      />

      <a-descriptions v-if="outcome.paths.length" :column="1" size="small" class="detail">
        <a-descriptions-item v-for="item in outcome.paths" :key="item.label" :label="item.label">
          <PathMenu :path="item.path" @reveal="reveal(item.path)" />
        </a-descriptions-item>
      </a-descriptions>

      <p v-if="outcome.tip" class="muted result-tip">{{ outcome.tip }}</p>

      <a-space style="width: 100%; justify-content: flex-end">
        <a-button type="primary" @click="emit('close')">完成</a-button>
      </a-space>
    </div>

    <!-- 各状态共用同一块区域并给最小高度，检测完不会整块跳一下 -->
    <div v-else class="modal-body">
      <div v-if="loading || loggingIn" class="stage">
        <a-spin size="large" />
        <span class="stage-text muted">
          {{
            loggingIn
              ? props.mode === 'all'
                ? '正在登录 Kiro IDE 并写入 kiro-cli 凭证…'
                : '正在刷新 Token 并写入 kiro-cli 凭证…'
              : '正在检测本机是否已安装 kiro-cli 与 Kiro Crew…'
          }}
        </span>
      </div>

      <div v-else-if="error" class="stage">
        <a-result status="warning" title="安装检测失败" :sub-title="error">
          <template #extra>
            <a-space>
              <a-button @click="startLogin">跳过检测，继续登录</a-button>
              <a-button type="primary" @click="check(true)">
                <template #icon><SyncOutlined /></template>
                重试
              </a-button>
            </a-space>
          </template>
        </a-result>
      </div>

      <template v-else-if="info">
        <p class="tip">
          <template v-if="!info.kiroCli.installed">
            登录 Kiro CLI 需要先在本机安装 kiro-cli。KiroCrew 也通过 kiro-cli 登录。
          </template>
          <template v-else-if="needsInit">
            kiro-cli 已安装，但还没有运行过，本机还没有它的凭证库。先按下面的方法登录一次完成初始化。
          </template>
          <template v-else>
            kiro-cli 已安装，可以直接登录。Kiro Crew 是可选的，装好后会自动使用同一个登录账号。
          </template>
        </p>

        <div class="status-list">
          <div class="status-row">
            <a-tag
              :color="!info.kiroCli.installed ? 'error' : needsInit ? 'warning' : 'success'"
              :bordered="false"
            >
              {{ !info.kiroCli.installed ? '未安装' : needsInit ? '未初始化' : '已安装' }}
            </a-tag>
            <span class="status-name">kiro-cli（必需）</span>
            <span v-if="info.kiroCli.path" class="status-path muted">{{ info.kiroCli.path }}</span>
          </div>
          <div class="status-row">
            <a-tag :color="info.crew.installed ? 'success' : 'default'" :bordered="false">
              {{ info.crew.installed ? '已安装' : '未安装' }}
            </a-tag>
            <span class="status-name">Kiro Crew（可选）</span>
            <span v-if="info.crew.path" class="status-path muted">{{ info.crew.path }}</span>
          </div>
        </div>

        <div v-for="block in guides" :key="block.title" class="guide">
          <div class="guide-title">{{ block.title }}</div>
          <template v-if="block.guide.command">
            <div class="muted">在{{ block.guide.shell }}中运行：</div>
            <code class="guide-command">{{ block.guide.command }}</code>
          </template>
          <div v-if="block.guide.note" class="muted">{{ block.guide.note }}</div>
          <div v-if="block.after" class="muted">{{ block.after }}</div>
          <a-space :size="4" class="guide-links">
            <a-button v-if="block.guide.command" size="small" type="link" @click="copyCommand(block.guide)">
              复制命令
            </a-button>
            <a-button size="small" type="link" @click="openGuide(block.guide)">打开官网</a-button>
          </a-space>
        </div>

        <div class="footer">
          <a-space>
            <a-button @click="emit('close')">{{ info.kiroCli.installed && !needsInit ? '取消' : '关闭' }}</a-button>
            <a-button v-if="!info.kiroCli.installed" type="primary" @click="check(true)">
              <template #icon><SyncOutlined /></template>
              我已安装，重新检测
            </a-button>
            <a-button v-else-if="needsInit" type="primary" @click="check(true)">
              <template #icon><SyncOutlined /></template>
              已完成初始化，重新检测
            </a-button>
            <a-button v-else type="primary" @click="continueWithoutCrew">
              {{ props.mode === 'all' ? '继续全部登录' : '继续登录 Kiro CLI' }}
            </a-button>
          </a-space>
        </div>
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

.modal-body {
  display: flex;
  flex-direction: column;
  min-height: 320px;
  font-size: 13px;
  line-height: 1.8;
}

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

.stage :deep(.ant-result-subtitle) {
  max-width: 480px;
  margin: 0 auto;
  word-break: break-word;
}

.tip {
  margin: 0 0 10px;
}

/* ---- 结果页，样式取自 SwitchResultModal ---- */
.lead {
  margin: 0 0 12px;
}

.result-alert {
  margin-bottom: 12px;
}

.detail {
  margin-bottom: 4px;
}

.result-tip {
  margin: 0 0 14px;
  font-size: 12px;
}

.status-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 6px;
}

.status-row {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.status-name {
  flex: 0 0 auto;
}

/* 路径可能很长，单行省略：只是佐证「找到了」 */
.status-path {
  overflow: hidden;
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.guide {
  margin-top: 12px;
}

.guide-title {
  font-weight: 600;
}

.guide-command {
  display: block;
  margin: 4px 0;
  padding: 6px 10px;
  border-radius: 6px;
  background: rgba(127, 127, 127, 0.12);
  font-family: Consolas, Menlo, monospace;
  font-size: 12px;
  word-break: break-all;
  user-select: text;
}

/* type=link 的按钮自带左右内边距，第一颗往左收齐文字 */
.guide-links {
  margin-left: -7px;
}

.footer {
  display: flex;
  justify-content: flex-end;
  margin-top: auto;
  padding-top: 16px;
}
</style>
