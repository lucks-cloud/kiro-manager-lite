<script setup lang="ts">
/**
 * API 端点一览 + 在线调试。
 *
 * 左边是反代支持的全部端点，每行两个图标：复制成 curl、模拟请求。
 * 右边是选中端点的请求面板：可以改请求体、发出去、看原样的响应。
 *
 * 请求由主进程代发（见 proxyServer.tryProxyEndpoint），走的是真实 HTTP：
 * 鉴权、额度、请求日志、统计都和外部客户端完全一样，模拟请求会出现在请求日志里。
 */
import { computed, ref } from 'vue'
import { message } from 'ant-design-vue'
import {
  ApiOutlined,
  CopyOutlined,
  LoadingOutlined,
  PlayCircleOutlined,
  SendOutlined
} from '@ant-design/icons-vue'
import { copyText } from '@/utils/ui'

const props = defineProps<{
  baseUrl: string
  apiKey: string
  /** 示例请求里用的模型；取界面上设的默认模型，保证真能跑通 */
  model: string
  running: boolean
}>()
const emit = defineEmits<{ close: [] }>()

type Method = 'GET' | 'POST'
/** 各家的鉴权头不一样，复制出来的 curl 要用对应那家的写法才能直接粘进文档对照 */
type AuthStyle = 'bearer' | 'anthropic' | 'gemini' | 'none'

interface Endpoint {
  id: string
  method: Method
  /** 列表里展示的路径（Gemini 那条带通配符） */
  path: string
  desc: string
  group: 'api' | 'admin'
  auth: AuthStyle
  /** 实际请求的路径 */
  requestPath: () => string
  sample?: () => Record<string, unknown>
}

const chatMessages = [{ role: 'user', content: '用一句话介绍你自己' }]

const ENDPOINTS: Endpoint[] = [
  {
    id: 'openai',
    method: 'POST',
    path: '/v1/chat/completions',
    desc: 'OpenAI 兼容',
    group: 'api',
    auth: 'bearer',
    requestPath: () => '/v1/chat/completions',
    sample: () => ({ model: props.model, messages: chatMessages, stream: false })
  },
  {
    id: 'responses',
    method: 'POST',
    path: '/v1/responses',
    desc: 'OpenAI Responses',
    group: 'api',
    auth: 'bearer',
    requestPath: () => '/v1/responses',
    sample: () => ({ model: props.model, input: '用一句话介绍你自己', stream: false })
  },
  {
    id: 'messages',
    method: 'POST',
    path: '/v1/messages',
    desc: 'Claude 兼容',
    group: 'api',
    auth: 'anthropic',
    requestPath: () => '/v1/messages',
    sample: () => ({ model: props.model, max_tokens: 1024, messages: chatMessages, stream: false })
  },
  {
    id: 'anthropic',
    method: 'POST',
    path: '/anthropic/v1/messages',
    desc: 'Claude Code',
    group: 'api',
    auth: 'anthropic',
    requestPath: () => '/anthropic/v1/messages',
    sample: () => ({ model: props.model, max_tokens: 1024, messages: chatMessages, stream: false })
  },
  {
    id: 'count',
    method: 'POST',
    path: '/v1/messages/count_tokens',
    desc: 'Token 计数',
    group: 'api',
    auth: 'anthropic',
    requestPath: () => '/v1/messages/count_tokens',
    sample: () => ({ model: props.model, messages: chatMessages })
  },
  {
    id: 'models',
    method: 'GET',
    path: '/v1/models',
    desc: '模型列表',
    group: 'api',
    auth: 'bearer',
    requestPath: () => '/v1/models'
  },
  {
    id: 'gemini',
    method: 'POST',
    path: '/v1beta/models/*:generateContent',
    desc: 'Gemini 兼容',
    group: 'api',
    auth: 'gemini',
    requestPath: () => `/v1beta/models/${props.model}:generateContent`,
    sample: () => ({ contents: [{ role: 'user', parts: [{ text: '用一句话介绍你自己' }] }] })
  },
  {
    id: 'gemini-models',
    method: 'GET',
    path: '/v1beta/models',
    desc: 'Gemini 模型',
    group: 'api',
    auth: 'gemini',
    requestPath: () => '/v1beta/models'
  },
  {
    id: 'health',
    method: 'GET',
    path: '/health',
    desc: '健康检查',
    group: 'api',
    auth: 'none',
    requestPath: () => '/health'
  },
  {
    id: 'admin-stats',
    method: 'GET',
    path: '/admin/stats',
    desc: '详细统计',
    group: 'admin',
    auth: 'bearer',
    requestPath: () => '/admin/stats'
  },
  {
    id: 'admin-accounts',
    method: 'GET',
    path: '/admin/accounts',
    desc: '账号列表',
    group: 'admin',
    auth: 'bearer',
    requestPath: () => '/admin/accounts'
  },
  {
    id: 'admin-logs',
    method: 'GET',
    path: '/admin/logs',
    desc: '请求日志',
    group: 'admin',
    auth: 'bearer',
    requestPath: () => '/admin/logs?limit=20'
  }
]

const groups = computed(() => [
  { title: 'API 端点', items: ENDPOINTS.filter((e) => e.group === 'api') },
  { title: '管理 API（需要 API Key）', items: ENDPOINTS.filter((e) => e.group === 'admin') }
])

// ============ 复制 curl ============

/** 单引号在 shell 里要写成 '\'' 才能留在单引号字符串里 */
function shellQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`
}

function authHeader(auth: AuthStyle): string[] {
  const key = props.apiKey || 'YOUR_API_KEY'
  if (auth === 'none') return []
  if (auth === 'anthropic') return [`-H ${shellQuote(`x-api-key: ${key}`)}`]
  if (auth === 'gemini') return [`-H ${shellQuote(`x-goog-api-key: ${key}`)}`]
  return [`-H ${shellQuote(`Authorization: Bearer ${key}`)}`]
}

function curlOf(endpoint: Endpoint, body?: string): string {
  const parts = [`curl -X ${endpoint.method} ${shellQuote(`${props.baseUrl}${endpoint.requestPath()}`)}`]
  parts.push(...authHeader(endpoint.auth))
  if (endpoint.method === 'POST') {
    parts.push(`-H ${shellQuote('Content-Type: application/json')}`)
    const payload = body ?? JSON.stringify(endpoint.sample?.() ?? {})
    // 压成一行：多行 JSON 粘到终端里容易被当成多条命令
    let compact = payload
    try {
      compact = JSON.stringify(JSON.parse(payload))
    } catch {
      // 用户改坏了 JSON 就原样给出去，让 curl 自己报错
    }
    parts.push(`-d ${shellQuote(compact)}`)
  }
  return parts.join(' \\\n  ')
}

function copyCurl(endpoint: Endpoint): void {
  const body = selected.value?.id === endpoint.id ? requestBody.value : undefined
  copyText(curlOf(endpoint, body), 'curl 命令已复制')
}

// ============ 模拟请求 ============

const selected = ref<Endpoint | null>(null)
const requestBody = ref('')
const sending = ref(false)
const response = ref<{
  status: number
  statusText: string
  durationMs: number
  contentType: string
  body: string
  raw: string
  formatted: boolean
  truncated: boolean
} | null>(null)
const sendError = ref('')

function select(endpoint: Endpoint): void {
  if (selected.value?.id === endpoint.id) return
  selected.value = endpoint
  requestBody.value = endpoint.sample ? JSON.stringify(endpoint.sample(), null, 2) : ''
  response.value = null
  sendError.value = ''
}

async function send(endpoint?: Endpoint): Promise<void> {
  if (endpoint) select(endpoint)
  const target = selected.value
  if (!target) return
  if (!props.running) return void message.warning('本地反代还没启动，先打开上面的开关')

  if (target.method === 'POST') {
    try {
      JSON.parse(requestBody.value || '{}')
    } catch {
      return void message.error('请求体不是合法的 JSON')
    }
  }

  sending.value = true
  response.value = null
  sendError.value = ''
  try {
    const res = await window.api.tryProxyEndpoint({
      method: target.method,
      path: target.requestPath(),
      body: target.method === 'POST' ? requestBody.value || '{}' : undefined
    })
    if (!res.success || !res.data) sendError.value = res.error || '请求失败'
    else response.value = res.data
  } finally {
    sending.value = false
  }
}

/**
 * 显示用的正文。JSON 在主进程里已经格式化好了（必须在截断之前做，见 formatForDisplay），
 * 这里不做解析——截断过的 JSON 解析不了，在这里解析会退回成一整行原文。
 */
const prettyBody = computed(() => response.value?.body ?? '')

const statusColor = computed(() => {
  const code = response.value?.status ?? 0
  if (code >= 200 && code < 300) return 'success'
  if (code === 429) return 'warning'
  return 'error'
})
</script>

<template>
  <!--
    宽度随窗口走、封顶 1400：响应区要能放下一整行 JSON / SSE，
    写死像素的话小窗口会溢出、大窗口又浪费。92vw 给两侧留出一点遮罩，看得出是弹窗。
  -->
  <a-modal
    :open="true"
    centered
    width="min(1400px, 92vw)"
    :footer="null"
    @cancel="emit('close')"
  >
    <template #title>
      <span class="title"><ApiOutlined />API 端点</span>
    </template>

    <div class="body">
      <!-- 左：端点列表 -->
      <div class="list">
        <template v-for="group in groups" :key="group.title">
          <div class="group-title">{{ group.title }}</div>
          <div
            v-for="endpoint in group.items"
            :key="endpoint.id"
            class="row"
            :class="{ active: selected?.id === endpoint.id }"
            role="button"
            tabindex="0"
            @click="select(endpoint)"
            @keydown.enter.prevent="select(endpoint)"
          >
            <span class="method" :class="endpoint.method.toLowerCase()">{{ endpoint.method }}</span>
            <span class="row-main">
              <span class="mono path">{{ endpoint.path }}</span>
              <span class="muted desc">{{ endpoint.desc }}</span>
            </span>
            <span class="row-actions" @click.stop>
              <a-tooltip title="复制 curl">
                <a-button type="text" size="small" @click="copyCurl(endpoint)">
                  <template #icon><CopyOutlined /></template>
                </a-button>
              </a-tooltip>
              <a-tooltip title="模拟请求">
                <a-button type="text" size="small" :disabled="sending" @click="send(endpoint)">
                  <template #icon>
                    <LoadingOutlined v-if="sending && selected?.id === endpoint.id" />
                    <PlayCircleOutlined v-else />
                  </template>
                </a-button>
              </a-tooltip>
            </span>
          </div>
        </template>
      </div>

      <!-- 右：请求与响应 -->
      <div class="panel">
        <div v-if="!selected" class="placeholder muted">
          <ApiOutlined />
          点左侧任意端点查看请求，点 <PlayCircleOutlined /> 直接发一次
        </div>

        <template v-else>
          <div class="req-line">
            <span class="method" :class="selected.method.toLowerCase()">{{ selected.method }}</span>
            <span class="mono req-url">{{ baseUrl }}{{ selected.requestPath() }}</span>
            <a-button type="primary" size="small" :loading="sending" @click="send()">
              <template #icon><SendOutlined /></template>
              发送
            </a-button>
          </div>

          <template v-if="selected.method === 'POST'">
            <div class="section-title">请求体</div>
            <a-textarea
              v-model:value="requestBody"
              class="mono editor"
              :auto-size="{ minRows: 8, maxRows: 16 }"
              spellcheck="false"
            />
          </template>
          <div v-else class="muted get-hint">GET 请求没有请求体，直接发送即可。</div>

          <div class="section-title">
            响应
            <template v-if="response">
              <a-tag :bordered="false" :color="statusColor" class="mini-tag">
                {{ response.status }} {{ response.statusText }}
              </a-tag>
              <span class="muted">{{ response.durationMs }}ms</span>
              <span v-if="response.contentType" class="muted">· {{ response.contentType.split(';')[0] }}</span>
              <a-button type="text" size="small" class="copy-resp" @click="copyText(response.raw, response.truncated ? '完整响应已复制' : '响应已复制')">
                <template #icon><CopyOutlined /></template>
              </a-button>
            </template>
          </div>
          <div class="response">
            <!-- 和账号 / API Key 测活弹窗同一种加载态：大号转圈在上，说明文字在下 -->
            <div v-if="sending" class="resp-loading">
              <a-spin size="large" />
              <span class="muted">等待响应…</span>
            </div>
            <a-alert v-else-if="sendError" type="error" show-icon :message="sendError" />
            <pre v-else-if="response" class="mono resp-body">{{ prettyBody }}</pre>
            <span v-else class="muted resp-empty">还没有发送</span>
          </div>
          <div v-if="response?.truncated" class="muted trunc">
            响应太长，只显示了前 100 万字符；右上角复制的是完整内容。
          </div>
        </template>
      </div>
    </div>
  </a-modal>
</template>

<style scoped>
.title { display: inline-flex; align-items: center; gap: 8px; }

/* 固定高度：左右两栏各自滚动，切换端点、响应长短都不会让弹窗跳 */
.body {
  display: grid;
  grid-template-columns: 420px minmax(0, 1fr);
  gap: 16px;
  /* 108px 是弹窗标题栏加上下内边距；高度同样跟窗口走，封顶 920 */
  height: clamp(520px, calc(90vh - 108px), 920px);
}

.list { overflow: auto; padding-right: 4px; }
.group-title { margin: 4px 0 6px; font-size: 12px; font-weight: 600; color: var(--kal-muted); }
.group-title:not(:first-child) { margin-top: 14px; }

.row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border: 1px solid transparent;
  border-radius: 8px;
  cursor: pointer;
}
.row:hover, .row:focus-visible { background: var(--kal-block-bg); outline: none; }
.row.active { border-color: var(--kal-primary); background: var(--kal-block-bg); }
.row-main { display: flex; flex: 1; flex-direction: column; min-width: 0; }
.path { font-size: 12px; font-weight: 600; word-break: break-all; }
.desc { font-size: 11px; }
.row-actions { display: inline-flex; gap: 2px; }
.row-actions :deep(.ant-btn) { width: 24px; height: 24px; min-width: 24px; padding: 0; }

/* 方法徽标定宽：GET / POST 两种长度不一，定宽后路径才对得齐 */
.method {
  flex: 0 0 42px;
  padding: 1px 0;
  border-radius: 4px;
  font-size: 10.5px;
  font-weight: 700;
  text-align: center;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}
.method.get { background: color-mix(in srgb, #52c41a 16%, transparent); color: #389e0d; }
.method.post { background: color-mix(in srgb, #1677ff 16%, transparent); color: #0958d9; }

.panel {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  padding: 12px;
  border: 1px solid var(--kal-border);
  border-radius: 10px;
}
.placeholder {
  display: flex;
  flex: 1;
  align-items: center;
  justify-content: center;
  gap: 6px;
  font-size: 13px;
}

.req-line { display: flex; align-items: center; gap: 8px; }
.req-url { flex: 1; min-width: 0; font-size: 12px; word-break: break-all; }

.section-title {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 12px 0 6px;
  font-size: 12px;
  font-weight: 600;
}
.mini-tag { margin: 0; font-size: 11px; line-height: 18px; }
.copy-resp { margin-left: auto; width: 24px; height: 24px; min-width: 24px; padding: 0; }

.editor { font-size: 12px; }
.get-hint { margin-top: 12px; font-size: 12px; }

.response {
  position: relative;
  flex: 1;
  min-height: 120px;
  overflow: auto;
  border-radius: 8px;
  background: var(--kal-code-bg, var(--kal-block-bg));
}
.resp-body {
  margin: 0;
  padding: 10px 12px;
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-all;
}
.resp-loading {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  font-size: 13px;
}
.resp-empty { display: block; padding: 12px; font-size: 12px; }
.response :deep(.ant-alert) { margin: 10px; }
.trunc { margin-top: 6px; font-size: 11px; }

.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
.muted { color: var(--kal-muted); }
</style>
