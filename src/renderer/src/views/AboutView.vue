<script setup lang="ts">
import { computed, ref } from 'vue'
import {
  CheckCircleFilled,
  CheckOutlined,
  CloseCircleFilled,
  CommentOutlined,
  GithubOutlined,
  HeartFilled,
  InfoCircleFilled,
  SyncOutlined,
  ThunderboltFilled
} from '@ant-design/icons-vue'
import { useSettingsStore } from '@/stores/settings'
import { useUpdateStore } from '@/stores/update'
import kiroLogo from '@/assets/kiro-logo.png'
import qqGroup from '@/assets/qq-group.jpg'
import authorAvatar from '@/assets/author_avatar.jpg'
import sponsorWechat from '@/assets/sponsor_wechat.jpg'
import sponsorAlipay from '@/assets/sponsor_alipay.jpg'

const settingsStore = useSettingsStore()
const updateStore = useUpdateStore()
const info = computed(() => settingsStore.appInfo)

// ============ 检查更新 ============
const checking = computed(() => updateStore.checking)
const checkResult = computed(() => updateStore.result)
const checkOpen = ref(false)
const checkError = ref('')
const groupOpen = ref(false)

/** 手动检查始终访问 GitHub；先打开状态弹窗，再在弹窗中呈现最终结果。 */
async function checkUpdate(): Promise<void> {
  if (checking.value) return
  checkError.value = ''
  checkOpen.value = true
  const response = await updateStore.checkNow()
  if (response.error) {
    checkError.value = response.error
    return
  }
  // 发现新版本时关闭状态弹窗，由全局 UpdateAvailableModal 接管更新详情。
  if (response.data?.hasUpdate) checkOpen.value = false
  else if (!response.data) checkError.value = '没有收到有效的版本检查结果，请稍后重试'
}

function manualUpdate(): void {
  checkOpen.value = false
  open(REPO_URL)
}

/** 关于页展示的功能清单，按应用的模块顺序排列，与 README 的功能特性保持一致 */
const features = [
  { name: '多账号管理', desc: 'Google / GitHub / Builder ID / Enterprise SSO 在线登录、OIDC 凭证、读取本机登录态五种添加方式，支持搜索、多维筛选、排序与批量操作' },
  { name: '分组与展示', desc: '账号与 API Key 共用一套自定义分组，卡片、卡片紧凑、列表三种形态可切换并记住选择' },
  { name: '一键切号', desc: '把账号凭证写入 Kiro IDE，落盘前实测 profileArn，可一键重启 IDE 生效' },
  { name: '刷新与续期', desc: 'Token 与用量各自定时刷新，IDE 当前账号的 Token 即将过期前主动续期写盘' },
  { name: '流式测活', desc: '真实对话测活，模型可搜索、二级可选推理档位，可查看官方完整原始返回' },
  { name: '订阅与官网', desc: '订阅状态、可开通档位与 Stripe 账单页，内置私密浏览器免登录进 Kiro 官网后台' },
  { name: '账号 API Key', desc: '用账号凭证向 Kiro 申请 API Key 并列出已创建的 Key' },
  { name: 'API Key 管理', desc: '管理 ksk_ 开头的 Kiro API Key，按区域同步额度、测活、查看积分历史' },
  { name: '本地反代', desc: '账号池转成 OpenAI / Anthropic / Gemini 兼容接口，轮询选号、重试换号、托管联网搜索' },
  { name: '一键接入客户端', desc: 'Claude Code、Codex、Cursor、VS Code 等 12 个命令行与桌面客户端一键写入，写入前备份、可一键还原' },
  { name: '本地网关', desc: '把 Kiro IDE 的 AI 请求接管到指定 API Key，运行中可随时换 Key，按真实请求统计' },
  { name: '用量与历史', desc: '记录每次刷新的积分变化，趋势曲线、明细表与 Excel 导出' },
  { name: '导入导出', desc: '卡密、JSON、CSV、TXT 互通，可批量导入多个文件、分割导出为压缩包' },
  { name: '常用工具', desc: '机器码重置与恢复、出口 IP 与网站连通性检测、自动同意 AI 操作' },
  { name: '系统日志', desc: '主进程与界面日志同一时间线，按级别、分类、关键字与时间筛选并可导出' },
  { name: '隐私打码', desc: '一键遮住邮箱、昵称、API Key 与备注，截图录屏更安心' },
  { name: '个性化设置', desc: '主题风格与主题色、控件尺寸、HTTP 代理、内置浏览器地区、定时备份与初始化' },
  { name: '桌面端体验', desc: '系统托盘常驻、关闭行为可配、自定义协议唤起、单实例锁' }
]

/** 本项目仓库地址，头部按钮与检查更新指向同一个仓库 */
const REPO_URL = 'https://github.com/lucks-cloud/kiro-manager-lite'

const author = {
  name: 'lucks-cloud',
  url: 'https://github.com/lucks-cloud',
  avatar: authorAvatar
}

const sponsors = [
  { label: '微信', image: sponsorWechat },
  { label: '支付宝', image: sponsorAlipay }
]

/** 致谢的开源项目：名称点击跳转 GitHub */
const credits = [
  {
    name: 'Kiro-account-manager',
    url: 'https://github.com/chaogei/Kiro-account-manager',
    desc: 'Kiro 多账号管理器，本项目账户管理接口实现的来源（AGPL-3.0）'
  },
  {
    name: 'Kiro-Go',
    url: 'https://github.com/Quorinex/Kiro-Go',
    desc: '把 Kiro 账号转换为 OpenAI / Anthropic 兼容 API 的 Go 服务'
  },
  {
    name: 'kiro.rs',
    url: 'https://github.com/hank9999/kiro.rs',
    desc: 'Rust 编写的 Anthropic Claude API 兼容代理，将请求转换为 Kiro API'
  },
  {
    name: 'new-api',
    url: 'https://github.com/QuantumNous/new-api',
    desc: '连接模型、应用与 Agent 的 AI 网关'
  },
  {
    name: 'sub2api',
    url: 'https://github.com/touwaeriol/sub2api',
    desc: 'AI API 网关平台，订阅配额分发管理'
  },
  {
    name: 'Kiro',
    url: 'https://github.com/kirodotdev/Kiro',
    desc: 'Kiro 官方仓库'
  }
]

function open(url: string): void {
  void window.api.openExternal(url)
}
</script>

<template>
  <div>
    <!-- 头部：品牌标识 + 版本 + 检查更新 / 交流群 -->
    <section class="hero">
      <span class="hero-blob hero-blob-a" />
      <span class="hero-blob hero-blob-b" />
      <div class="hero-main">
        <img class="hero-logo" :src="kiroLogo" alt="Kiro Manager Lite" />
        <h2 class="hero-title">Kiro Manager Lite</h2>
        <p class="hero-version muted">版本 {{ info?.version || '-' }}</p>
        <a-space :size="12" wrap class="hero-actions">
          <a-button :loading="checking" @click="checkUpdate">
            <template #icon><SyncOutlined /></template>
            检查更新
          </a-button>
          <a-button @click="groupOpen = true">
            <template #icon><CommentOutlined /></template>
            加入交流群
          </a-button>
          <a-button @click="open(REPO_URL)">
            <template #icon><GithubOutlined /></template>
            GitHub
          </a-button>
        </a-space>
      </div>
    </section>

    <a-card size="small" title="版本信息" style="margin-bottom: 16px">
      <a-descriptions :column="2" size="small">
        <a-descriptions-item label="应用版本">{{ info?.version || '-' }}</a-descriptions-item>
        <a-descriptions-item label="平台">{{ info?.platform || '-' }}</a-descriptions-item>
        <a-descriptions-item label="Electron">{{ info?.electron || '-' }}</a-descriptions-item>
        <a-descriptions-item label="Chromium">{{ info?.chrome || '-' }}</a-descriptions-item>
        <a-descriptions-item label="Node">{{ info?.node || '-' }}</a-descriptions-item>
        <a-descriptions-item label="技术栈">Vue 3 · Vite · Pinia · Ant Design Vue · Electron</a-descriptions-item>
      </a-descriptions>
    </a-card>

    <a-card size="small" class="intro-card" style="margin-bottom: 16px">
      <template #title>
        <span class="card-title">
          <InfoCircleFilled class="card-title-icon" />
          关于本应用
        </span>
      </template>
      <p class="intro-text">
        Kiro 多账号一键切换 · 本地反代与客户端一键接入 · 自定义分组与三种展示形态 · 订阅开通与账单管理 · 账号 API Key 管理 · 本地网关与真实调用统计 · 机器码重置与网络检测 · 自动刷新与流式测活 · 内置私密浏览器 · 托盘常驻
      </p>
      <p class="intro-text">
        本应用使用 Electron + Vue 3 + TypeScript 开发，支持 Windows、macOS 和 Linux 平台。
        所有账号数据均加密保存在本机，不会上传到任何服务器。
      </p>
    </a-card>

    <a-card size="small" class="feature-card" style="margin-bottom: 16px">
      <template #title>
        <span class="card-title">
          <ThunderboltFilled class="card-title-icon" />
          主要功能
        </span>
      </template>
      <ul class="feature-list">
        <li v-for="item in features" :key="item.name" class="feature-item">
          <CheckOutlined class="feature-check" />
          <span class="feature-name">{{ item.name }}</span>
          <span class="feature-sep">：</span>
          <span class="feature-desc muted">{{ item.desc }}</span>
        </li>
      </ul>
    </a-card>

    <a-card size="small" title="作者" style="margin-bottom: 16px">
      <div class="author">
        <a-avatar :size="56" :src="author.avatar" alt="作者头像" />
        <div class="author-main">
          <div class="author-name">{{ author.name }}</div>
          <!-- 保留 href 让链接可聚焦，实际跳转交给系统浏览器 -->
          <a
            class="author-link mono"
            :href="author.url"
            @click.prevent="open(author.url)"
          >
            {{ author.url }}
          </a>
        </div>
        <a-button @click="open(author.url)">
          <template #icon><GithubOutlined /></template>
          GitHub 主页
        </a-button>
      </div>
    </a-card>

    <a-card size="small" title="赞助支持" style="margin-bottom: 16px">
      <p class="muted" style="margin: 0 0 14px">
        <HeartFilled style="color: #eb2f96" />
        本项目免费开源，如果它帮你省了力气，可以请作者喝杯咖啡，完全自愿。
      </p>
      <div class="sponsor-grid">
        <div v-for="item in sponsors" :key="item.label" class="sponsor-item">
          <img class="sponsor-qr" :src="item.image" :alt="`${item.label}收款码`" />
          <span class="sponsor-label muted">{{ item.label }}</span>
        </div>
      </div>
    </a-card>

    <a-card size="small" title="致谢与许可" class="credits-card">
      <p class="muted" style="margin: 0 0 12px">
        账户管理相关的接口实现参考了开源项目 Kiro-account-manager（AGPL-3.0），本项目在其基础上重写为
        Vue 技术栈；本地反代的协议转换、工具调用与网关设计参考了以下开源项目。本项目以 AGPL-3.0 许可开源。
      </p>
      <ul class="feature-list">
        <li v-for="item in credits" :key="item.url" class="feature-item">
          <GithubOutlined class="feature-check" />
          <!-- 保留 href 让链接可聚焦，实际跳转交给系统浏览器 -->
          <a class="feature-name credit-link" :href="item.url" @click.prevent="open(item.url)">{{ item.name }}</a>
          <span class="feature-sep">：</span>
          <span class="feature-desc muted">{{ item.desc }}</span>
        </li>
      </ul>
    </a-card>

    <!-- 手动检查状态：点击后立即打开，加载、失败、已是最新版都在同一弹窗内呈现。 -->
    <a-modal
      v-if="checkOpen"
      v-model:open="checkOpen"
      title="检查更新"
      :width="420"
      centered
      :closable="!checking"
      :mask-closable="!checking"
      :keyboard="!checking"
    >
      <div class="check-result" aria-live="polite">
        <template v-if="checking">
          <a-spin size="large" class="check-spinner" />
          <div class="check-title">正在检查更新</div>
          <div class="check-detail muted">正在连接 GitHub 并获取最新版本，请稍候…</div>
        </template>
        <template v-else-if="checkError">
          <CloseCircleFilled class="check-icon error" />
          <div class="check-title">检查更新失败</div>
          <div class="check-error">{{ checkError }}</div>
          <div class="check-detail muted">可以稍后重试，或前往项目主页手动下载最新版本。</div>
        </template>
        <template v-else>
          <CheckCircleFilled class="check-icon ok" />
          <div class="check-title">已是最新版本</div>
          <div class="check-detail muted">
            当前版本 v{{ checkResult?.current || info?.version || '-' }}
          </div>
        </template>
      </div>
      <template #footer>
        <span v-if="checking" class="check-footer-loading muted">正在检查，请勿关闭…</span>
        <template v-else-if="checkError">
          <a-button @click="checkOpen = false">关闭</a-button>
          <a-button @click="checkUpdate">
            <template #icon><SyncOutlined /></template>
            重新检查
          </a-button>
          <a-button type="primary" @click="manualUpdate">
            <template #icon><GithubOutlined /></template>
            手动更新
          </a-button>
        </template>
        <a-button v-else type="primary" @click="checkOpen = false">好的</a-button>
      </template>
    </a-modal>

    <!-- 用户交流群 -->
    <a-modal v-model:open="groupOpen" title="用户交流群" :width="440" centered :footer="null">
      <div class="group-box">
        <img class="group-qr" :src="qqGroup" alt="QQ 交流群二维码" />
        <span class="muted group-tip">用 QQ 扫码加入交流群</span>
      </div>
    </a-modal>
  </div>
</template>

<style scoped>
/* ============ 关于本应用 / 主要功能 ============ */
.card-title {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.card-title-icon {
  color: var(--kal-primary);
}

.intro-card :deep(.ant-card-body),
.feature-card :deep(.ant-card-body) {
  padding: 16px;
}

.intro-text {
  margin: 0 0 12px;
  font-size: 13px;
  line-height: 1.9;
}

.intro-text:last-child {
  margin-bottom: 0;
}

.feature-list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.feature-item {
  display: flex;
  align-items: baseline;
  gap: 2px;
  padding: 4px 0;
  font-size: 13px;
  line-height: 1.8;
}

.feature-check {
  flex: 0 0 auto;
  margin-right: 6px;
  color: var(--kal-primary);
  font-size: 12px;
}

.feature-name {
  flex: 0 0 auto;
  font-weight: 600;
  color: var(--kal-primary);
}

.feature-sep {
  flex: 0 0 auto;
  color: var(--kal-muted);
}

/* 说明文字占据剩余宽度，长句在窄窗口下正常换行 */
.feature-desc {
  flex: 1 1 auto;
  min-width: 0;
}

.credits-card :deep(.ant-card-body) {
  padding: 16px;
}

/* 项目名是链接：悬停加下划线，与正文里的其它外链一致 */
.credit-link:hover,
.credit-link:focus-visible {
  text-decoration: underline;
  outline: none;
}

/* 最后一张卡片别贴着内容区底边 */
.credits-card {
  margin-bottom: 24px;
}

/* ============ 头部横幅 ============ */
.hero {
  position: relative;
  overflow: hidden;
  margin-bottom: 16px;
  padding: 40px 24px 36px;
  border: 1px solid var(--kal-border);
  border-radius: 12px;
  background: var(--kal-card-bg);
  text-align: center;
}

.hero-blob {
  position: absolute;
  border-radius: 50%;
  filter: blur(40px);
  background: radial-gradient(circle, var(--kal-primary), transparent 70%);
  opacity: 0.18;
  pointer-events: none;
}

.hero-blob-a {
  top: -60px;
  right: -30px;
  width: 180px;
  height: 180px;
}

.hero-blob-b {
  bottom: -60px;
  left: -20px;
  width: 150px;
  height: 150px;
}

.hero-main {
  position: relative;
}

/* 品牌标识：logo 单独居中，应用名放在下方 */
.hero-logo {
  display: block;
  width: 72px;
  height: 72px;
  margin: 0 auto;
  border-radius: 18px;
  object-fit: cover;
}

.hero-title {
  margin: 18px 0 8px;
  font-size: 22px;
  font-weight: 700;
  color: var(--kal-primary);
}

.hero-version {
  margin: 0 0 24px;
  font-size: 13px;
}

/* ============ 检查更新弹窗 ============ */
.check-result {
  text-align: center;
  padding: 8px 0 4px;
}

.check-icon {
  font-size: 40px;
}

.check-icon.ok {
  color: #52c41a;
}

.check-icon.error {
  color: #ff4d4f;
}

.check-spinner {
  display: inline-flex;
  margin: 2px 0 4px;
}

.check-detail {
  max-width: 340px;
  margin: 0 auto;
  font-size: 12.5px;
  line-height: 1.7;
}

.check-error {
  max-width: 350px;
  margin: 0 auto 6px;
  color: #ff4d4f;
  font-size: 12.5px;
  line-height: 1.7;
  overflow-wrap: anywhere;
}

.check-footer-loading {
  display: inline-block;
  padding: 5px 0;
  font-size: 12px;
}

.check-title {
  margin: 10px 0 6px;
  font-size: 16px;
  font-weight: 600;
}

/* ============ 交流群弹窗 ============ */
.group-box {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}

/* 原图是竖长图，宽度撑满弹窗的同时限高，避免小窗口下弹窗超出视口 */
.group-qr {
  width: 100%;
  max-width: 380px;
  height: auto;
  max-height: 62vh;
  object-fit: contain;
  border-radius: 8px;
  background: #fff;
}

.group-tip {
  font-size: 12px;
}

.author {
  display: flex;
  align-items: center;
  gap: 14px;
}

.author-main {
  flex: 1 1 auto;
  min-width: 0;
}

.author-name {
  font-size: 16px;
  font-weight: 600;
}

.author-link {
  font-size: 12px;
  word-break: break-all;
}

.sponsor-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
}

.sponsor-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 10px;
  border-radius: 10px;
  background: var(--kal-block-bg);
}

/* 只固定宽度，高度按原图比例走，避免二维码被压变形 */
.sponsor-qr {
  width: 260px;
  height: auto;
  border-radius: 8px;
  background: #fff;
}

.sponsor-label {
  font-size: 12px;
}
</style>
