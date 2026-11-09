<script setup lang="ts">
import { computed } from 'vue'
import { message } from 'ant-design-vue'
import {
  CheckCircleFilled,
  CloseCircleFilled,
  CloudDownloadOutlined,
  GithubOutlined,
  LoadingOutlined,
  RocketFilled
} from '@ant-design/icons-vue'
import { useUpdateStore } from '@/stores/update'
import { formatDate } from '@/utils/format'
import { handleMarkdownClick, renderMarkdown } from '@/utils/markdown'
import { copyText } from '@/utils/ui'

const updateStore = useUpdateStore()
const update = computed(() => updateStore.result)

/**
 * 只保留更新内容，去掉 Release 说明末尾的下载部分。
 *
 * 那部分由 release.yml 统一追加在 CHANGELOG 条目之后，固定以「## 📦 下载」标题开头，
 * 后面是平台表格、macOS 安装说明与安装问题链接。弹窗里已有「开始更新」，不必再列一遍平台。
 * 没找到这个标题（旧版本的说明）时原样显示。
 */
function stripDownloadSection(notes: string): string {
  const match = /^#{1,6}\s*(?:📦\s*)?下载\s*$/m.exec(notes)
  if (!match) return notes
  // 截断后可能残留分隔线与空行
  return notes.slice(0, match.index).replace(/(\s*\n)?\s*-{3,}\s*$/, '').trimEnd()
}

const notesHtml = computed(() => renderMarkdown(stripDownloadSection(update.value?.notes ?? '')))

/** 打开 GitHub 的 Releases 页（原来「前往更新」的地址），想手动挑安装包时用 */
function openGithub(): void {
  const url = update.value?.releaseUrl
  if (url) void window.api.openExternal(url)
}

// ============ 下载进度蒙层 ============
const progress = computed(() => updateStore.progress)
const phase = computed(() => updateStore.phase)

function formatBytes(bytes: number): string {
  if (!bytes || bytes < 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i++
  }
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

const percent = computed(() => {
  const p = progress.value
  if (!p?.total) return 0
  return Math.min(100, Math.floor((p.received / p.total) * 1000) / 10)
})

/** 剩余时间：速度为 0（刚开始 / 卡住）时不估算 */
const etaText = computed(() => {
  const p = progress.value
  if (!p || !p.speed || !p.total) return ''
  const seconds = Math.max(0, Math.round((p.total - p.received) / p.speed))
  if (seconds < 60) return `约 ${seconds} 秒`
  return `约 ${Math.ceil(seconds / 60)} 分钟`
})

/** GitHub 给的值与本地算出的值是否一致（都是小写十六进制） */
const hashMatched = computed(() => {
  const p = progress.value
  return !!p?.actualSha256 && p.actualSha256.toLowerCase() === p.expectedSha256?.toLowerCase()
})

const progressStatus = computed(() => {
  if (phase.value === 'error') return 'exception'
  if (phase.value === 'ready' || phase.value === 'installing') return 'success'
  return 'active'
})

const phaseTitle = computed(() => {
  switch (phase.value) {
    case 'downloading':
      return '正在下载更新'
    case 'verifying':
      return '正在校验安装包'
    case 'ready':
      return '下载完成'
    case 'installing':
      return '正在启动安装程序'
    case 'error':
      return '更新失败'
    default:
      return '准备更新'
  }
})

/** 各平台安装时会发生什么，下载完成后告诉用户 */
const installHint = computed(() => {
  const ua = navigator.userAgent
  if (/Mac/i.test(ua)) {
    return '点击「安装并重启」后本应用会先退出，再打开系统安装器；按向导装完关闭安装器，应用会自动重新打开。'
  }
  if (/Windows/i.test(ua)) {
    return '点击「安装并重启」后本应用会先退出，再打开安装向导；装完在最后一页勾选运行即可。'
  }
  return '点击「安装并重启」后本应用会先退出，用新版本替换当前的 AppImage 并自动重新启动。'
})

async function onStart(): Promise<void> {
  await updateStore.startUpdate()
}

async function onInstall(): Promise<void> {
  const res = await updateStore.installUpdate()
  if (res.error) message.error(res.error)
}
</script>

<template>
  <a-modal
    :open="updateStore.modalOpen"
    title="发现新版本"
    :width="720"
    centered
    :mask-closable="!updateStore.busy"
    :closable="!updateStore.busy"
    :keyboard="!updateStore.busy"
    @cancel="updateStore.closeModal"
  >
    <div class="check-result">
      <RocketFilled class="check-icon" />
      <div class="check-title">有新版本可以更新</div>
      <div class="version-flow">
        <span class="version-chip">v{{ update?.current }}</span>
        <span class="muted">→</span>
        <span class="version-chip new">v{{ update?.latest }}</span>
      </div>
      <div v-if="update?.publishedAt" class="muted release-time">
        发布于 {{ formatDate(update.publishedAt) }}
      </div>
    </div>
    <div v-if="notesHtml" class="release-notes">
      <div class="release-notes-title muted">更新说明</div>
      <div class="release-notes-body markdown" v-html="notesHtml" @click="handleMarkdownClick" />
    </div>
    <template #footer>
      <div class="modal-footer">
        <a-tooltip title="在 GitHub 查看发布页并手动下载">
          <a-button aria-label="在 GitHub 查看发布页" @click="openGithub">
            <template #icon><GithubOutlined /></template>
          </a-button>
        </a-tooltip>
        <div class="footer-right">
          <a-button :disabled="updateStore.busy" @click="updateStore.closeModal">稍后再说</a-button>
          <a-button type="primary" :loading="updateStore.busy" @click="onStart">
            <template #icon><CloudDownloadOutlined /></template>
            开始更新
          </a-button>
        </div>
      </div>
    </template>
  </a-modal>

  <!-- 下载进度：盖住整个窗口，期间不能操作别的界面；取消即中断下载 -->
  <Teleport to="body">
    <div v-if="updateStore.overlayOpen && progress" class="update-overlay" role="dialog" aria-modal="true">
      <div class="update-panel">
        <div class="panel-head">
          <CheckCircleFilled v-if="phase === 'ready'" class="panel-icon ok" />
          <CloseCircleFilled v-else-if="phase === 'error'" class="panel-icon err" />
          <LoadingOutlined v-else class="panel-icon" />
          <div>
            <div class="panel-title">{{ phaseTitle }}</div>
            <div class="muted panel-sub">
              v{{ progress.version }}<template v-if="progress.fileName"> · {{ progress.fileName }}</template>
            </div>
          </div>
        </div>

        <a-progress
          :percent="phase === 'ready' || phase === 'installing' ? 100 : percent"
          :status="progressStatus"
          :stroke-width="10"
        />

        <div class="panel-stats">
          <div class="stat">
            <span class="muted">总大小</span>
            <span class="mono">{{ progress.total ? formatBytes(progress.total) : '获取中…' }}</span>
          </div>
          <div class="stat">
            <span class="muted">已下载</span>
            <span class="mono">{{ formatBytes(progress.received) }}</span>
          </div>
          <div class="stat">
            <span class="muted">速度</span>
            <span class="mono">{{ phase === 'downloading' && progress.speed ? `${formatBytes(progress.speed)}/s` : '-' }}</span>
          </div>
          <div class="stat">
            <span class="muted">剩余</span>
            <span class="mono">{{ phase === 'downloading' ? etaText || '-' : '-' }}</span>
          </div>
        </div>

        <!-- 下载完成（含校验失败）后对照两边的 sha256；点值可复制 -->
        <div v-if="progress.actualSha256 && progress.expectedSha256" class="hash-block">
          <div class="hash-head">
            <span>SHA-256 校验</span>
            <a-tag :color="hashMatched ? 'success' : 'error'" class="hash-tag">
              <CheckCircleFilled v-if="hashMatched" />
              <CloseCircleFilled v-else />
              {{ hashMatched ? '一致' : '不一致' }}
            </a-tag>
          </div>
          <div class="hash-row">
            <span class="muted hash-label">GitHub</span>
            <a class="hash-value mono" title="点击复制" @click="copyText(progress.expectedSha256, 'GitHub 的 SHA-256 已复制')">
              {{ progress.expectedSha256 }}
            </a>
          </div>
          <div class="hash-row">
            <span class="muted hash-label">本地文件</span>
            <a
              class="hash-value mono"
              :class="{ mismatch: !hashMatched }"
              title="点击复制"
              @click="copyText(progress.actualSha256, '本地文件的 SHA-256 已复制')"
            >
              {{ progress.actualSha256 }}
            </a>
          </div>
        </div>

        <a-alert v-if="phase === 'error'" type="error" :message="progress.error || '更新失败'" class="panel-alert" />
        <div v-else-if="phase === 'ready'" class="muted panel-hint">{{ installHint }}</div>
        <div v-else-if="phase === 'installing'" class="muted panel-hint">本应用正在退出，请稍候…</div>
        <div v-else-if="phase === 'verifying'" class="muted panel-hint">正在核对安装包的 sha256，确保文件完整、未被篡改。</div>

        <div class="panel-actions">
          <template v-if="phase === 'error'">
            <a-button @click="openGithub">
              <template #icon><GithubOutlined /></template>
              手动下载
            </a-button>
            <a-button @click="updateStore.dismissOverlay">关闭</a-button>
            <a-button type="primary" @click="onStart">重试</a-button>
          </template>
          <template v-else-if="phase === 'ready'">
            <a-button @click="updateStore.cancelUpdate">取消更新</a-button>
            <a-button type="primary" @click="onInstall">安装并重启</a-button>
          </template>
          <a-button v-else-if="phase !== 'installing'" danger @click="updateStore.cancelUpdate">
            取消更新
          </a-button>
        </div>
      </div>
    </div>
  </Teleport>
</template>


<style scoped>
.check-result { text-align: center; padding: 8px 0 4px; }
.check-icon { color: var(--kal-primary); font-size: 40px; }
.check-title { margin: 10px 0 6px; font-size: 16px; font-weight: 600; }
.version-flow { display: flex; align-items: center; justify-content: center; gap: 10px; }
.version-chip { padding: 2px 10px; border-radius: 6px; background: var(--kal-block-bg); font-size: 13px; }
.version-chip.new { color: #fff; background: var(--kal-primary); }
.release-time { margin-top: 8px; font-size: 12px; }
.release-notes { margin-top: 16px; padding: 12px; border-radius: 8px; background: var(--kal-block-bg); }
.release-notes-title { margin-bottom: 6px; font-size: 12px; }
.release-notes-body { max-height: min(420px, 55vh); overflow: auto; font-size: 13px; line-height: 1.75; word-break: break-word; }
.markdown :deep(> *:first-child) { margin-top: 0; }
.markdown :deep(> *:last-child) { margin-bottom: 0; }
.markdown :deep(h1),
.markdown :deep(h2),
.markdown :deep(h3),
.markdown :deep(h4) { margin: 14px 0 6px; font-size: 14px; font-weight: 600; line-height: 1.5; }
.markdown :deep(h1) { font-size: 16px; }
.markdown :deep(h2) { font-size: 15px; }
.markdown :deep(p) { margin: 0 0 8px; }
.markdown :deep(ul),
.markdown :deep(ol) { margin: 0 0 8px; padding-left: 20px; }
.markdown :deep(li) { margin: 2px 0; }
.markdown :deep(li > p) { margin: 0; }
.markdown :deep(a) { color: var(--kal-primary); }
.markdown :deep(code) { padding: 1px 4px; border-radius: 4px; background: var(--kal-code-bg); }

/* 底部：GitHub 图标靠左，稍后再说 / 开始更新靠右 */
.modal-footer { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.footer-right { display: flex; align-items: center; gap: 8px; }

/* 蒙层盖住整个窗口，层级高于 a-modal（1000） */
.update-overlay {
  position: fixed;
  inset: 0;
  z-index: 2000;
  display: grid;
  place-items: center;
  padding: 24px;
  background: rgba(0, 0, 0, 0.55);
  backdrop-filter: blur(2px);
}
.update-panel {
  width: min(520px, 100%);
  padding: 22px 24px 18px;
  border-radius: 14px;
  background: var(--kal-card-bg);
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.3);
}
.panel-head { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; }
.panel-icon { font-size: 28px; color: var(--kal-primary); }
.panel-icon.ok { color: #52c41a; }
.panel-icon.err { color: #ff4d4f; }
.panel-title { font-size: 16px; font-weight: 600; }
.panel-sub { margin-top: 2px; font-size: 12px; word-break: break-all; }
.panel-stats {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px;
  margin-top: 12px;
}
.stat {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--kal-block-bg);
  font-size: 12px;
}
.stat .mono { font-size: 13px; font-weight: 600; font-variant-numeric: tabular-nums; }
.panel-alert { margin-top: 14px; word-break: break-word; }
.hash-block {
  margin-top: 12px;
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--kal-block-bg);
  font-size: 12px;
}
.hash-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; font-weight: 600; }
.hash-tag { margin: 0; }
.hash-row { display: flex; align-items: baseline; gap: 10px; padding: 2px 0; }
.hash-label { flex: 0 0 52px; }
/* 64 位十六进制完整显示，按字符换行 */
.hash-value {
  flex: 1 1 auto;
  min-width: 0;
  color: inherit;
  font-size: 11.5px;
  line-height: 1.6;
  word-break: break-all;
  cursor: pointer;
}
.hash-value:hover { color: var(--kal-primary); }
.hash-value.mismatch { color: #ff4d4f; }
.panel-hint { margin-top: 14px; font-size: 12.5px; line-height: 1.7; }
.panel-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 18px; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
.muted { color: var(--kal-muted); }
</style>
