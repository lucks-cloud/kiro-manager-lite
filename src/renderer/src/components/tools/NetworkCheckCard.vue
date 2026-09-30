<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { message } from 'ant-design-vue'
import { CopyOutlined, GlobalOutlined, ReloadOutlined, ThunderboltOutlined } from '@ant-design/icons-vue'
import { copyText } from '@/utils/ui'
import githubSvg from '@/assets/sites/github.svg?raw'
import googleSvg from '@/assets/sites/google.svg?raw'
import youtubeSvg from '@/assets/sites/youtube.svg?raw'
import kiroSvg from '@/assets/sites/kiro.svg?raw'
import amazonSvg from '@/assets/sites/amazon.svg?raw'
import type { IpInfo, SiteTestId, SiteTestResult } from '@shared/types'

/**
 * 图标以内联 SVG 渲染而不是 <img>：GitHub 图标用 currentColor 填充，
 * 暗色模式下跟着文字变白，否则黑色图标在深色背景上看不见。
 * SVG 是仓库内置的静态资源，不含外部输入，v-html 没有注入风险。
 */
const SITES: { id: SiteTestId; name: string; host: string; icon: string }[] = [
  { id: 'github', name: 'GitHub', host: 'github.com', icon: githubSvg },
  { id: 'google', name: 'Google', host: 'google.com', icon: googleSvg },
  { id: 'youtube', name: 'YouTube', host: 'youtube.com', icon: youtubeSvg },
  { id: 'kiro', name: 'Kiro', host: 'kiro.dev', icon: kiroSvg },
  { id: 'amazon', name: 'Amazon', host: 'amazon.com', icon: amazonSvg }
]

// ============ 出口 IP ============
const ip = ref<IpInfo | null>(null)
const ipError = ref('')
const ipLoading = ref(false)

async function loadIp(): Promise<void> {
  ipLoading.value = true
  ipError.value = ''
  try {
    const res = await window.api.getIpInfo()
    if (!res.success || !res.data) {
      ip.value = null
      ipError.value = res.error || '查询 IP 失败'
      return
    }
    ip.value = res.data
  } finally {
    ipLoading.value = false
  }
}

/** 国家代码转旗帜 emoji：两个字母各自映射到区域指示符 */
function flagOf(code?: string): string {
  if (!code || !/^[a-z]{2}$/i.test(code)) return ''
  return String.fromCodePoint(...[...code.toUpperCase()].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65))
}

const location = computed(() => {
  const info = ip.value
  if (!info) return ''
  const parts = [info.country || info.countryCode, info.region, info.city].filter(Boolean)
  // 城市与省份同名（如新加坡、香港）时去重
  return [...new Set(parts)].join(' · ')
})

// ============ 网站测试 ============
const results = reactive<Partial<Record<SiteTestId, SiteTestResult>>>({})
const testing = reactive<Partial<Record<SiteTestId, boolean>>>({})
const anyTesting = computed(() => SITES.some((s) => testing[s.id]))

async function testOne(id: SiteTestId): Promise<void> {
  if (testing[id]) return
  testing[id] = true
  try {
    const res = await window.api.testSite(id)
    if (res.success && res.data) results[id] = res.data
    else results[id] = { id, url: '', ok: false, error: res.error || '测试失败' }
  } finally {
    testing[id] = false
  }
}

/** 五个站点并行测，各自出结果就各自刷新，不必等最慢的那个 */
function testAll(): void {
  for (const site of SITES) void testOne(site.id)
}

function refreshAll(): void {
  void loadIp()
  testAll()
}

/** 延迟分档着色：绿色流畅、橙色可用但偏慢、红色很慢或不通 */
function latencyLevel(result?: SiteTestResult): 'good' | 'fair' | 'poor' | 'fail' | '' {
  if (!result) return ''
  if (!result.ok) return 'fail'
  const ms = result.latencyMs ?? 0
  if (ms < 500) return 'good'
  if (ms < 1500) return 'fair'
  return 'poor'
}

function copyIp(): void {
  if (ip.value) copyText(ip.value.ip, 'IP 已复制')
  else message.warning('还没有查询到 IP')
}

onMounted(refreshAll)
</script>

<template>
  <a-card class="tool-card" :bordered="false">
    <div class="tool-row">
      <div class="tool-main">
        <div class="tool-title">
          <GlobalOutlined />
          <strong>网络检测</strong>
        </div>
        <div class="tool-desc">查看当前出口 IP，并测试常用网站的连通性与延迟。</div>
        <div class="tool-hint">
          请求走设置里的网络代理（未配置时使用系统环境变量代理），结果反映的是本应用与 Kiro 请求实际经过的出口。
          延迟为发起请求到收到响应头的耗时，包含 DNS、TCP 与 TLS 握手；收到任何 HTTP 响应都算连通。
        </div>
      </div>
      <a-button size="small" :loading="ipLoading || anyTesting" @click="refreshAll">
        <template #icon><ReloadOutlined /></template>
        全部重测
      </a-button>
    </div>

    <!-- 出口 IP -->
    <div class="ip-box">
      <a-spin :spinning="ipLoading" size="small">
        <div v-if="ip" class="ip-body">
          <div class="ip-main">
            <span class="ip-flag">{{ flagOf(ip.countryCode) }}</span>
            <span class="ip-addr mono">{{ ip.ip }}</span>
            <a-button type="link" size="small" @click="copyIp">
              <template #icon><CopyOutlined /></template>
            </a-button>
          </div>
          <div class="ip-meta">
            <span v-if="location">{{ location }}</span>
            <span v-if="ip.org">{{ ip.org }}</span>
            <span v-if="ip.timezone">{{ ip.timezone }}</span>
            <span class="muted">来源 {{ ip.source }}</span>
          </div>
        </div>
        <div v-else-if="ipError" class="ip-error">{{ ipError }}</div>
        <div v-else class="muted ip-placeholder">正在查询出口 IP…</div>
      </a-spin>
    </div>

    <!-- 网站测试 -->
    <div class="site-grid">
      <button
        v-for="site in SITES"
        :key="site.id"
        type="button"
        class="site-tile"
        :class="latencyLevel(results[site.id])"
        :disabled="testing[site.id]"
        :title="results[site.id]?.error || `点击重新测试 ${site.host}`"
        @click="testOne(site.id)"
      >
        <!-- eslint-disable-next-line vue/no-v-html -->
        <span class="site-icon" v-html="site.icon" />
        <span class="site-name">{{ site.name }}</span>
        <span class="site-host muted">{{ site.host }}</span>
        <span class="site-result">
          <template v-if="testing[site.id]">
            <ThunderboltOutlined class="spin" /> 测试中
          </template>
          <template v-else-if="results[site.id]?.ok">
            {{ results[site.id]?.latencyMs }} ms
          </template>
          <template v-else-if="results[site.id]">不可达</template>
          <template v-else>-</template>
        </span>
        <span v-if="results[site.id]?.status && !testing[site.id]" class="site-status muted">
          HTTP {{ results[site.id]?.status }}
        </span>
      </button>
    </div>
  </a-card>
</template>

<style scoped>
.tool-card { border: 1px solid var(--kal-border); }
.tool-row { display: flex; align-items: flex-start; gap: 16px; }
.tool-main { flex: 1 1 auto; min-width: 0; }
.tool-title { display: flex; align-items: center; gap: 9px; font-size: 16px; }
.tool-desc { margin-top: 8px; font-size: 13px; }
.tool-hint { margin-top: 6px; color: var(--kal-muted); font-size: 12px; line-height: 1.7; }

.ip-box {
  margin-top: 16px;
  padding: 12px 14px;
  border-radius: 10px;
  background: var(--kal-block-bg);
}
.ip-main { display: flex; align-items: center; gap: 8px; }
.ip-flag { font-size: 20px; line-height: 1; }
.ip-addr { font-size: 18px; font-weight: 700; word-break: break-all; }
.ip-main :deep(.ant-btn-link) { padding: 0 4px; height: 22px; }
.ip-meta { display: flex; flex-wrap: wrap; gap: 4px 14px; margin-top: 4px; font-size: 12px; }
.ip-error { color: #ff4d4f; font-size: 12px; word-break: break-word; }
.ip-placeholder { font-size: 12px; }

.site-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(130px, 1fr));
  gap: 10px;
  margin-top: 14px;
}
.site-tile {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 12px 8px 10px;
  border: 1px solid var(--kal-border);
  border-radius: 10px;
  background: transparent;
  color: inherit;
  cursor: pointer;
  transition: border-color 0.16s ease, background 0.16s ease;
}
.site-tile:hover:not(:disabled) { border-color: var(--kal-primary); }
.site-tile:disabled { cursor: progress; }
.site-icon { display: inline-flex; width: 28px; height: 28px; margin-bottom: 4px; }
.site-icon :deep(svg) { width: 100%; height: 100%; }
.site-name { font-size: 13px; font-weight: 600; }
.site-host { font-size: 11px; }
.site-result { margin-top: 4px; font-size: 14px; font-weight: 700; font-variant-numeric: tabular-nums; }
.site-status { font-size: 11px; }

/* 延迟分档：数值着色 + 很浅的同色底，扫一眼就能看出哪个站点有问题 */
.site-tile.good .site-result { color: #52c41a; }
.site-tile.fair .site-result { color: #faad14; }
.site-tile.poor .site-result,
.site-tile.fail .site-result { color: #ff4d4f; }
.site-tile.fail { background: color-mix(in srgb, #ff4d4f 6%, transparent); }

.spin { animation: spin 1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
.muted { color: var(--kal-muted); }
</style>
