<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { message } from 'ant-design-vue'
import {
  BarChartOutlined,
  DeleteOutlined,
  DownloadOutlined,
  GlobalOutlined,
  ProfileOutlined
} from '@ant-design/icons-vue'
import { formatDateTime } from '@/utils/format'
import { copyText } from '@/utils/ui'
import type { OutboundDomainEntry, OutboundRequestEvent } from '@shared/types'

const list = ref<OutboundDomainEntry[]>([])
let timer: ReturnType<typeof setInterval> | null = null
/** 上一次列表的内容签名：内容没变就不重新赋值，避免 2 秒轮询把整块重渲染 */
let lastSig = ''

async function load(): Promise<void> {
  const res = await window.api.getOutboundDomains()
  if (!res.success || !res.data) return
  // 固定按「首次出现时间」升序：新域名追加到末尾，已有的不随 lastAt 变化而跳位，消除闪烁
  const next = [...res.data].sort((a, b) => a.firstAt - b.firstAt)
  const sig = next.map((d) => `${d.host}:${d.count}`).join('|')
  if (sig === lastSig) return
  lastSig = sig
  list.value = next
}

async function clear(): Promise<void> {
  const res = await window.api.clearOutboundDomains()
  if (!res.success) return void message.error(res.error || '清空失败')
  list.value = []
  lastSig = ''
  message.success('已清空出站域名统计')
}

const totalHosts = computed(() => list.value.length)
const totalRequests = computed(() => list.value.reduce((sum, h) => sum + h.count, 0))

// ============ 明细弹窗 ============
const detailOpen = ref(false)
const detailHost = ref<string>('') // 空串表示查看全部域名
const detailLoading = ref(false)
const events = ref<OutboundRequestEvent[]>([])

async function openDetail(host?: string): Promise<void> {
  detailHost.value = host || ''
  detailOpen.value = true
  detailLoading.value = true
  try {
    const res = await window.api.getOutboundEvents(host)
    events.value = res.success && res.data ? res.data : []
  } finally {
    detailLoading.value = false
  }
}

const detailTitle = computed(() =>
  detailHost.value ? `出站明细 · ${detailHost.value}` : '出站明细 · 全部域名'
)

/** 时间戳（yyyymmdd-hhmmss），用于导出文件名 */
function stamp(): string {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/** 下载当前明细为 xlsx（时间 / 域名 / 完整地址三列） */
async function downloadDetail(): Promise<void> {
  if (!events.value.length) return
  const sheet = {
    name: '出站明细',
    columns: [
      { title: '时间', width: 22, format: 'datetime' as const },
      { title: '域名', width: 34 },
      { title: '完整地址', width: 90, format: 'link' as const }
    ],
    rows: events.value.map((e) => [e.at, e.host, e.url])
  }
  const scope = detailHost.value ? detailHost.value.replace(/[^\w.-]/g, '_') : 'all'
  const res = await window.api.exportToXlsx(sheet, `outbound-${scope}-${stamp()}.xlsx`)
  if (!res.success) message.error(res.error || '导出失败')
  else if (res.data?.saved) message.success('明细已导出')
}

onMounted(() => {
  void load()
  // 边用边更新：应用发起新请求 / 内置浏览器导航后，这里每 2 秒刷新一次
  timer = setInterval(() => void load(), 2000)
})
onUnmounted(() => {
  if (timer) clearInterval(timer)
})
</script>

<template>
  <a-card class="tool-card" :bordered="false">
    <div class="tool-row">
      <div class="tool-main">
        <div class="tool-title">
          <GlobalOutlined />
          <strong>出站域名统计</strong>
          <a-tag color="blue">{{ totalHosts }} 个域名</a-tag>
        </div>
        <div class="tool-desc">
          记录本应用对外访问过的所有域名，按完整主机名去重。涵盖账号 / 密钥的令牌刷新、积分与用量查询、
          在线登录、对话转发，以及内置浏览器打开的页面（如 Stripe 账单、Kiro 官网后台）。
        </div>
        <div class="tool-hint">
          只要本应用对外发起请求、或内置浏览器打开某个页面，其目标域名就会登记在这里（含二 / 三 / 四级子域各自去重）。
          只记录域名、地址与时间，不记录请求内容与查询参数；统计保存在内存中，重启应用后清零。
        </div>
      </div>
      <a-space>
        <a-button size="small" :disabled="!totalRequests" @click="openDetail()">
          <template #icon><ProfileOutlined /></template>
          明细
        </a-button>
        <a-button size="small" danger :disabled="!totalHosts" @click="clear">
          <template #icon><DeleteOutlined /></template>
          清空
        </a-button>
      </a-space>
    </div>

    <div v-if="totalHosts" class="summary muted">
      共 {{ totalHosts }} 个域名、{{ totalRequests }} 次出站请求
    </div>

    <!-- 一个域名一个标签 -->
    <div v-if="totalHosts" class="domain-tags">
      <span v-for="d in list" :key="d.host" class="domain-tag">
        <span class="dt-host mono" :title="d.sample">{{ d.host }}</span>
        <span class="dt-count">{{ d.count }}</span>
        <a class="dt-stats" title="查看该域名的出站明细" @click="openDetail(d.host)">
          <BarChartOutlined />
        </a>
      </span>
    </div>

    <div v-else class="empty muted">暂无出站记录。应用对外发起请求或内置浏览器打开页面后就会显示在这里。</div>

    <a-modal
      v-model:open="detailOpen"
      :title="detailTitle"
      :width="760"
      centered
    >
      <a-spin :spinning="detailLoading">
        <div class="detail-body">
          <div class="detail-meta muted">
            共 {{ events.length }} 条记录（最近在前）
          </div>
          <div class="detail-list">
            <div v-for="(ev, i) in events" :key="i" class="detail-row">
              <span class="ev-time muted">{{ formatDateTime(ev.at) }}</span>
              <a
                class="ev-url mono"
                role="button"
                tabindex="0"
                :title="`${ev.url}\n（点击复制）`"
                @click="copyText(ev.url, '地址已复制')"
              >{{ ev.url }}</a>
            </div>
            <div v-if="!detailLoading && !events.length" class="empty muted">没有明细记录。</div>
          </div>
        </div>
      </a-spin>

      <template #footer>
        <a-button @click="detailOpen = false">关闭</a-button>
        <a-button type="primary" :disabled="!events.length" @click="downloadDetail">
          <template #icon><DownloadOutlined /></template>
          下载明细
        </a-button>
      </template>
    </a-modal>
  </a-card>
</template>

<style scoped>
.tool-card { border: 1px solid var(--kal-border); box-shadow: none; }
.tool-row { display: flex; align-items: flex-start; gap: 16px; }
.tool-main { flex: 1 1 auto; min-width: 0; }
.tool-title { display: flex; align-items: center; gap: 9px; font-size: 16px; }
.tool-desc { margin-top: 8px; font-size: 13px; }
.tool-hint { margin-top: 6px; color: var(--kal-muted); font-size: 12px; line-height: 1.7; }

.summary { margin-top: 14px; font-size: 12px; }

/* 一个域名一个标签：圆角 chip，内含主机名、次数徽标、统计图标 */
.domain-tags { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
.domain-tag {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  max-width: 100%;
  padding: 4px 8px 4px 10px;
  border: 1px solid var(--kal-border);
  border-radius: 999px;
  background: var(--kal-block-bg);
  font-size: 12.5px;
}
.dt-host { max-width: 420px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dt-count {
  flex: 0 0 auto;
  min-width: 18px;
  padding: 0 6px;
  height: 18px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 9px;
  background: color-mix(in srgb, var(--kal-primary) 14%, transparent);
  color: var(--kal-primary);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.dt-stats {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  color: var(--kal-muted);
  cursor: pointer;
  transition: color 0.15s;
}
.dt-stats:hover { color: var(--kal-primary); }

.empty { margin-top: 16px; font-size: 12px; }

/* 内容区设最小高度：记录很少时弹窗也不会缩成一条 */
.detail-body { min-height: 280px; }
.detail-meta { font-size: 12px; margin-bottom: 8px; }
.detail-list { max-height: 60vh; overflow: auto; }
.detail-row {
  display: flex;
  align-items: baseline;
  gap: 12px;
  padding: 6px 4px;
  font-size: 12.5px;
}
.detail-row + .detail-row { border-top: 1px dashed var(--kal-border); }
.ev-time { flex: 0 0 auto; font-size: 11.5px; white-space: nowrap; }
/* 超出一行省略；整行可点，悬停高亮提示可复制 */
.ev-url {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: inherit;
  cursor: pointer;
  border-radius: 4px;
  padding: 1px 4px;
  transition: background 0.15s, color 0.15s;
}
.ev-url:hover,
.ev-url:focus-visible {
  background: color-mix(in srgb, var(--kal-primary) 12%, transparent);
  color: var(--kal-primary);
  outline: none;
}

.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
.muted { color: var(--kal-muted); }
</style>
