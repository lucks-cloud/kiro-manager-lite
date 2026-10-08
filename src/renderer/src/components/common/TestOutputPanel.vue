<script setup lang="ts">
/**
 * 测活的「响应结果」面板：标题 + 流式回复，测完（成功、失败、中止都算）右上角出现「查看完整响应」，
 * 点开能看到每一次向 Kiro 官方发出的请求拿到的原样返回（状态、响应头、响应体或逐帧事件）。
 * 账号测活与 API Key 测活共用。
 */
import { computed, ref, watch } from 'vue'
import { message } from 'ant-design-vue'
import { CopyOutlined, FileSearchOutlined } from '@ant-design/icons-vue'
import { endpointName } from '@/utils/display'
import type { ChatRawAttempt, ChatRawTrace } from '@shared/types'

const props = defineProps<{
  /** 已收到的回复文本 */
  output: string
  running: boolean
  /** 还没有回复文本时显示的灰色提示 */
  hint: string
  /** 全部尝试的原始返回；没有（还没测、或在发请求前就失败了）时不显示按钮 */
  raw?: ChatRawTrace | null
}>()

const open = ref(false)
type View = 'brief' | 'all'
const view = ref<View>('brief')

const attempts = computed<ChatRawAttempt[]>(() => props.raw?.attempts ?? [])
/** 默认展开最后一次：它决定了这次测活的结论 */
const activeKeys = ref<number[]>([])
watch(open, (value) => {
  if (value) activeKeys.value = attempts.value.length ? [attempts.value.length - 1] : []
})

/** 连续出字的文本帧占绝大多数，精简视图只留前几帧，其余折成一行说明 */
const KEEP_TEXT_FRAMES = 3
const TEXT_TYPE = 'assistantResponseEvent'

interface Row {
  /** 在原始事件流里的序号（从 1 开始）；省略行没有 */
  index?: number
  type: string
  text: string
}

const toLine = (payload: unknown): string =>
  typeof payload === 'string' ? payload : JSON.stringify(payload)

function rowsOf(attempt: ChatRawAttempt): Row[] {
  const frames = attempt.frames
  if (view.value === 'all') {
    return frames.map((f, i) => ({ index: i + 1, type: f.type, text: toLine(f.payload) }))
  }
  const textCount = frames.filter((f) => f.type === TEXT_TYPE).length
  const out: Row[] = []
  let shown = 0
  let skipped = false
  frames.forEach((f, i) => {
    if (f.type === TEXT_TYPE && shown >= KEEP_TEXT_FRAMES) {
      if (!skipped) {
        skipped = true
        // 省略的是哪些字段：官方有没有在文本帧里带模型信息，一眼就能看出来
        const keys = new Set<string>()
        for (const g of frames) {
          if (g.type === TEXT_TYPE && g.payload && typeof g.payload === 'object') {
            Object.keys(g.payload as object).forEach((k) => keys.add(k))
          }
        }
        out.push({
          type: '…',
          text: `省略其余 ${textCount - KEEP_TEXT_FRAMES} 帧 ${TEXT_TYPE}（所有文本帧出现过的字段：${[...keys].join('、') || '无'}）`
        })
      }
      return
    }
    if (f.type === TEXT_TYPE) shown++
    out.push({ index: i + 1, type: f.type, text: toLine(f.payload) })
  })
  return out
}

/** 各类事件各多少帧 */
function countsOf(attempt: ChatRawAttempt): [string, number][] {
  const map = new Map<string, number>()
  for (const f of attempt.frames) map.set(f.type, (map.get(f.type) ?? 0) + 1)
  return [...map.entries()]
}

function headerLines(attempt: ChatRawAttempt): string {
  return Object.entries(attempt.headers)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n')
}

/** 非 2xx 的响应体：是 JSON 就排版一下，否则原样 */
function prettyBody(body: string): string {
  try {
    return JSON.stringify(JSON.parse(body), null, 2)
  } catch {
    return body
  }
}

/** profileArn 只显示末段，完整值放悬停提示里 */
function arnLabel(arn: string | null | undefined): string {
  if (arn === undefined) return ''
  if (arn === null) return '不带 profileArn'
  return `profile/${arn.split('/').pop() ?? arn}`
}

const OUTCOME: Record<ChatRawAttempt['outcome'], { color: string; text: string }> = {
  success: { color: 'success', text: '成功' },
  error: { color: 'error', text: '失败' },
  cancelled: { color: 'default', text: '已中止' }
}

/** 弹窗顶部一句话结论 */
const summary = computed(() => {
  const list = attempts.value
  if (!list.length) return ''
  const last = list[list.length - 1]
  const lead = list.length > 1 ? `共 ${list.length} 次请求，` : ''
  if (last.outcome === 'success') return `${lead}最后一次成功`
  if (last.outcome === 'cancelled') return `${lead}最后一次被中止`
  return `${lead}最后一次失败：${last.error ?? '未知原因'}`
})

function copyAll(): void {
  if (!props.raw) return
  window.api.writeClipboard(JSON.stringify(props.raw, null, 2))
  message.success('完整响应已复制（JSON）')
}
</script>

<template>
  <div class="panel">
    <div class="panel-head">
      <span class="panel-title">响应结果</span>
      <a-button
        v-if="attempts.length && !running"
        type="link"
        size="small"
        class="panel-action"
        @click="open = true"
      >
        <template #icon><FileSearchOutlined /></template>
        查看完整响应
      </a-button>
    </div>
    <div class="panel-body">
      <div v-if="output" class="output-text">{{ output }}</div>
      <div v-else class="muted">{{ hint }}</div>
      <span v-if="running" class="cursor" />
    </div>
  </div>

  <a-modal v-model:open="open" title="官方完整返回" centered :width="900" :footer="null">
    <div class="raw">
      <div class="raw-top">
        <span class="muted">{{ summary }}</span>
        <a-segmented
          v-model:value="view"
          size="small"
          :options="[
            { label: '精简', value: 'brief' },
            { label: '全部', value: 'all' }
          ]"
        />
      </div>

      <a-collapse v-model:active-key="activeKeys" class="raw-collapse">
        <a-collapse-panel v-for="(attempt, i) in attempts" :key="i">
          <template #header>
            <div class="attempt-head">
              <span class="attempt-no">第 {{ i + 1 }} 次</span>
              <a-tag :color="OUTCOME[attempt.outcome].color">{{ OUTCOME[attempt.outcome].text }}</a-tag>
              <span>{{ endpointName(attempt.url) }}</span>
              <a-tooltip v-if="attempt.profileArn" :title="attempt.profileArn">
                <span class="mono muted">{{ arnLabel(attempt.profileArn) }}</span>
              </a-tooltip>
              <span v-else-if="attempt.profileArn === null" class="muted">{{ arnLabel(null) }}</span>
              <span class="mono muted">{{ attempt.status ? `HTTP ${attempt.status}` : '无响应' }}</span>
              <span class="mono muted">{{ attempt.durationMs }}ms</span>
            </div>
          </template>

          <div class="raw-meta mono">POST {{ attempt.url }}</div>
          <a-alert
            v-if="attempt.error && attempt.outcome !== 'success'"
            :type="attempt.outcome === 'cancelled' ? 'info' : 'error'"
            :message="attempt.error"
            show-icon
            class="raw-error"
          />

          <!-- 连接都没建立（网络错误、超时、发出前就中止）：没有任何官方返回可看 -->
          <div v-if="!attempt.status" class="muted raw-note">
            没有收到官方的响应（网络错误、超时，或在响应前就中止了），以上是本地的错误信息。
          </div>

          <template v-else>
            <div class="raw-section">响应头</div>
            <pre class="raw-pre mono">{{ headerLines(attempt) || '（无）' }}</pre>

            <template v-if="attempt.body !== undefined">
              <div class="raw-section">响应体</div>
              <pre class="raw-pre mono">{{ attempt.body ? prettyBody(attempt.body) : '（空）' }}</pre>
            </template>

            <template v-else>
              <div class="raw-section">
                事件帧（共 {{ attempt.frames.length }} 帧{{ attempt.truncated ? '，已截断' : '' }}）
              </div>
              <div v-if="attempt.frames.length" class="raw-counts">
                <a-tag v-for="[type, n] in countsOf(attempt)" :key="type">{{ type }} × {{ n }}</a-tag>
              </div>
              <div v-if="attempt.frames.length" class="raw-frames mono">
                <div
                  v-for="(row, r) in rowsOf(attempt)"
                  :key="r"
                  class="raw-row"
                  :class="{ omitted: row.index === undefined }"
                >
                  <span class="raw-index">{{ row.index ?? '' }}</span>
                  <span class="raw-type">{{ row.type }}</span>
                  <span class="raw-text">{{ row.text }}</span>
                </div>
              </div>
              <div v-else class="muted raw-note">连接成功，但官方一帧事件都没有返回。</div>
              <div v-if="attempt.truncated" class="muted raw-note">
                事件太多，只保留了前面一部分；这不影响上面的回复文本。
              </div>
            </template>
          </template>
        </a-collapse-panel>
      </a-collapse>
    </div>

    <a-space style="width: 100%; justify-content: flex-end; margin-top: 16px">
      <a-button @click="copyAll">
        <template #icon><CopyOutlined /></template>
        复制完整 JSON
      </a-button>
      <a-button type="primary" @click="open = false">关闭</a-button>
    </a-space>
  </a-modal>
</template>

<style scoped>
/* 灰底整块是一个面板：顶部一行标题 + 右侧按钮，下面才是滚动的回复正文 */
.panel {
  border-radius: 10px;
  background: var(--kal-block-bg);
  font-size: 13px;
}
.panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 34px;
  padding: 4px 8px 0 12px;
}
.panel-title { font-weight: 600; }
.panel-action { padding: 0 4px; }
.panel-body {
  min-height: 92px;
  max-height: 230px;
  overflow: auto;
  padding: 4px 12px 10px;
  line-height: 1.8;
}
.output-text { white-space: pre-wrap; word-break: break-word; }
.muted { color: var(--kal-muted); }

/* 流式进行中的光标 */
.cursor {
  display: inline-block;
  width: 7px;
  height: 14px;
  vertical-align: text-bottom;
  background: var(--kal-primary);
  animation: blink 1s steps(2, start) infinite;
}
@keyframes blink { to { visibility: hidden; } }

.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
.raw { max-height: 64vh; overflow: auto; padding-right: 4px; }
.raw-top { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 10px; font-size: 13px; }
.attempt-head { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 10px; font-size: 13px; }
.attempt-no { font-weight: 600; }
.attempt-head :deep(.ant-tag) { margin-inline-end: 0; }
.raw-meta { font-size: 12px; word-break: break-all; color: var(--kal-muted); }
.raw-error { margin-top: 8px; }
.raw-section { margin: 12px 0 6px; font-weight: 600; }
.raw-pre {
  margin: 0;
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--kal-block-bg);
  font-size: 12px;
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-all;
}
.raw-counts { margin-bottom: 6px; }
.raw-frames { border-radius: 8px; background: var(--kal-block-bg); padding: 6px 10px; font-size: 12px; line-height: 1.7; }
.raw-row { display: flex; gap: 10px; padding: 1px 0; }
.raw-row.omitted { color: var(--kal-muted); font-style: italic; }
.raw-index { flex: 0 0 34px; text-align: right; color: var(--kal-muted); }
.raw-type { flex: 0 0 170px; color: var(--kal-primary); word-break: break-all; }
.raw-text { flex: 1 1 auto; min-width: 0; white-space: pre-wrap; word-break: break-all; }
.raw-note { margin-top: 8px; font-size: 12px; }
</style>
