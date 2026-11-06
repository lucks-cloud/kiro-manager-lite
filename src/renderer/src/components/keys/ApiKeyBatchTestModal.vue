<script setup lang="ts">
/**
 * API Key 批量测活。
 *
 * 为什么必须发真实对话：管理面的 Get-Usage-Limits / List-Available-Models 都不校验账号状态，
 * 被封禁的 Key 在这两个接口上照样返回 200，只有 runtime 面的真实对话才会暴露 403。
 *
 * 关于额度：失效或被封禁的 Key 会被上游即时拒绝、不产出内容，因此不计费；
 * 只有真正可用的 Key 才会出字并计一次请求额度。所以这里用尽可能短的提示词。
 *
 * 串行执行而非并发：批量并发容易被上游判为异常活动，反而污染检测结果。
 */
import { computed, nextTick, ref, watch } from 'vue'
import {
  CheckCircleFilled,
  CloseCircleFilled,
  StopOutlined,
  ThunderboltOutlined
} from '@ant-design/icons-vue'
import { useKeysStore } from '@/stores/keys'
import { useSettingsStore } from '@/stores/settings'
import { displayNote as maskedNote } from '@/utils/display'
import { errorMessage } from '@shared/errors'
import type { KeyEntry } from '@shared/types'

/** keys 由调用方传入界面上可见的卡片列表，保证顺序与卡片完全一致 */
const props = defineProps<{ open: boolean; keys: KeyEntry[] }>()
const emit = defineEmits<{ 'update:open': [boolean] }>()

const keysStore = useKeysStore()
const settingsStore = useSettingsStore()

/** 最小提示词：可用的 Key 会计一次请求额度，内容越短消耗越小 */
const PROBE_MESSAGE = '请回复 ok'
/** 交给 Kiro 自行挑模型，避免逐个 Key 拉模型列表 */
const PROBE_MODEL = 'auto'

type RowState = 'pending' | 'testing' | 'ok' | 'fail'
interface Row {
  id: string
  key: string
  note?: string
  state: RowState
  detail: string
}

const rows = ref<Row[]>([])
const running = ref(false)
const aborted = ref(false)
const currentRequestId = ref('')
const listRef = ref<HTMLElement | null>(null)

const stat = computed(() => ({
  total: rows.value.length,
  ok: rows.value.filter((row) => row.state === 'ok').length,
  fail: rows.value.filter((row) => row.state === 'fail').length,
  pending: rows.value.filter((row) => row.state === 'pending').length
}))
const finished = computed(() => !running.value && stat.value.pending === 0 && stat.value.total > 0)

function displayKey(key: string): string {
  if (!settingsStore.settings.privacyMode) return key
  return `${key.slice(0, 8)}…${key.slice(-6)}`
}

/** 备注跟随隐私打码；在渲染时算而不是建行时算，中途切开关也能立即生效 */
function displayNote(note?: string): string {
  return maskedNote(note, settingsStore.settings.privacyMode)
}

function reset(): void {
  rows.value = props.keys.map((entry) => ({
    id: entry.id,
    key: entry.key,
    note: entry.note,
    state: 'pending' as RowState,
    detail: ''
  }))
}

/**
 * 把正在测的那一项滚进视野，并额外多露出 2 个后续项，
 * 这样进度推进时下一批待测的 Key 已经可见，不用等它跳到边缘才滚动。
 */
function revealRow(index: number): void {
  const container = listRef.value
  if (!container) return
  const target = container.querySelector<HTMLElement>(
    `[data-row-index="${Math.min(index + 2, rows.value.length - 1)}"]`
  )
  // block: 'nearest' 只滚动列表容器自身，不会带动整个弹窗
  target?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
}

// 每次打开都重置，避免看到上一轮的结果
watch(
  () => props.open,
  (open) => {
    if (open && !running.value) reset()
  },
  { immediate: true }
)

async function start(): Promise<void> {
  if (running.value || !rows.value.length) return
  running.value = true
  aborted.value = false
  // 重测时把上一轮结果清掉，保持进度可读
  for (const row of rows.value) {
    row.state = 'pending'
    row.detail = ''
  }

  for (let index = 0; index < rows.value.length; index++) {
    const row = rows.value[index]
    if (aborted.value) break
    row.state = 'testing'
    await nextTick()
    revealRow(index)
    const requestId = `batch-${row.id}-${Date.now()}`
    currentRequestId.value = requestId
    try {
      const response = await window.api.keyChatTest(requestId, {
        keyId: row.id,
        modelId: PROBE_MODEL,
        message: PROBE_MESSAGE
      })
      if (aborted.value) {
        // 中止时这一条不算结果，回到未测状态
        row.state = 'pending'
        row.detail = ''
        break
      }
      if (response.success && response.data) {
        row.state = 'ok'
        row.detail = `${response.data.totalMs} ms`
        // 主进程已落库，这里同步本地卡片，让状态立刻反映出来
        keysStore.applyChatResult(row.id)
      } else {
        row.state = 'fail'
        row.detail = response.error || '测活失败'
        keysStore.applyChatResult(row.id, row.detail)
      }
    } catch (cause) {
      if (aborted.value) {
        row.state = 'pending'
        row.detail = ''
        break
      }
      row.state = 'fail'
      row.detail = errorMessage(cause)
      keysStore.applyChatResult(row.id, row.detail)
    }
  }

  currentRequestId.value = ''
  running.value = false
}

function abort(): void {
  aborted.value = true
  if (currentRequestId.value) void window.api.cancelKeyChatTest(currentRequestId.value)
}

function close(): void {
  if (running.value) abort()
  emit('update:open', false)
}
</script>

<template>
  <a-modal
    :open="props.open"
    width="720px"
    centered
    :footer="null"
    :mask-closable="!running"
    @cancel="close"
  >
    <template #title>
      <span class="title"><ThunderboltOutlined />API Key 批量测活</span>
    </template>

    <a-alert type="warning" show-icon style="margin-bottom: 12px">
      <template #message>批量测活会对每个 Key 发起一次真实对话，可能消耗额度</template>
      <template #description>
        额度只会被真正可用的 Key 消耗（每个计一次请求，提示词已压到最短）；
        已失效或被封禁的 Key 会被上游直接拒绝，不产生消耗。
        为避免被判为异常活动，这里按列表顺序逐个测试。
      </template>
    </a-alert>

    <div class="summary">
      <span class="count-text">共 {{ stat.total }} 个</span>
      <a-tag v-if="stat.ok" color="green" :bordered="false">可用 {{ stat.ok }}</a-tag>
      <a-tag v-if="stat.fail" color="red" :bordered="false">失败 {{ stat.fail }}</a-tag>
      <a-tag v-if="stat.pending" :bordered="false">未测 {{ stat.pending }}</a-tag>
      <span class="spacer" />
      <span v-if="running" class="count-text">
        正在测活 {{ stat.total - stat.pending }}/{{ stat.total }}
      </span>
      <span v-else-if="finished" class="count-text">已完成</span>
    </div>

    <div ref="listRef" class="row-list">
      <div
        v-for="(row, index) in rows"
        :key="row.id"
        :data-row-index="index"
        class="row"
        :class="row.state"
      >
        <div class="row-main">
          <div class="row-key mono">{{ displayKey(row.key) }}</div>
          <div v-if="row.note" class="row-note">{{ displayNote(row.note) }}</div>
        </div>
        <div class="row-state">
          <template v-if="row.state === 'pending'">
            <span class="muted">等待测活</span>
          </template>
          <template v-else-if="row.state === 'testing'">
            <a-spin size="small" />
            <span class="testing-text">测活中</span>
          </template>
          <template v-else-if="row.state === 'ok'">
            <CheckCircleFilled class="ok-icon" />
            <span class="ok-text">可用</span>
            <span class="muted">{{ row.detail }}</span>
          </template>
          <template v-else>
            <CloseCircleFilled class="fail-icon" />
            <span class="kal-batch-fail-text" :title="row.detail">{{ row.detail }}</span>
          </template>
        </div>
      </div>
      <a-empty v-if="!rows.length" description="还没有添加 API Key" />
    </div>

    <a-space style="width: 100%; justify-content: flex-end; margin-top: 16px">
      <a-button @click="close">关闭</a-button>
      <a-button v-if="running" danger @click="abort">
        <template #icon><StopOutlined /></template>中止
      </a-button>
      <a-button v-else type="primary" :disabled="!rows.length" @click="start">
        <template #icon><ThunderboltOutlined /></template>
        {{ finished ? '重新测活' : '开始测活' }}
      </a-button>
    </a-space>
  </a-modal>
</template>

<style scoped>
.title { display: inline-flex; align-items: center; gap: 8px; }
.summary { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
.spacer { flex: 1 1 auto; }
.count-text { color: var(--kal-muted); font-size: 12px; }

.row-list { max-height: 46vh; overflow: auto; display: flex; flex-direction: column; gap: 8px; }
/* 每个 Key 一个圆角模块，状态靠右 */
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
.row.testing { border-color: var(--kal-primary); }
.row.ok { border-color: #52c41a33; }
.row.fail { border-color: #ff4d4f33; }

.row-main { min-width: 0; flex: 1 1 auto; }
.row-key { font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.row-note { margin-top: 2px; color: var(--kal-muted); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.row-state { flex: 0 0 auto; max-width: 52%; display: flex; align-items: center; gap: 6px; font-size: 12px; }
.testing-text { color: var(--kal-primary); }
.ok-icon { color: #52c41a; }
.ok-text { color: #52c41a; }
.fail-icon { color: #ff4d4f; flex: 0 0 auto; }

.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
.muted { color: var(--kal-muted); }
</style>
