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

/** 关于页展示的功能清单，与 README 的功能特性保持一致 */
const features = [
  { name: '多账号管理', desc: '添加、编辑、删除多个 Kiro 账号，支持搜索、多维筛选（含导入时间范围）与排序' },
  { name: '五种添加方式', desc: '在线登录（Google / GitHub / Builder ID / Enterprise SSO）、OIDC 凭证、读取本地 Kiro 登录态' },
  { name: '自定义分组', desc: '账号与 API Key 共用一套分组：新建、改名、拖动排序、按分组筛选与批量归组' },
  { name: '三种展示形态', desc: '卡片、卡片紧凑、列表可随时切换并各自记住选择，列表模式按卡片实际宽度自动重排' },
  { name: '一键切号', desc: '写入 IDE 凭证前强制刷新 Token，避免 IDE 被强制登出，可一键重启 IDE 生效' },
  { name: '自动刷新', desc: 'Token 与积分用量各自独立的开关与间隔，冷启动会补跑一轮' },
  { name: '主动续期', desc: '在 IDE 当前账号的 Token 即将过期前抢先刷新并写盘，保持登录态不掉线' },
  { name: '账号测活', desc: '拉取真实可用模型并发起一次流式对话，模型可搜索、二级可选推理档位' },
  { name: '积分与用量', desc: '订阅等级、积分明细、重置时间，并记录每次采样生成变化趋势' },
  { name: '订阅管理', desc: '点订阅标签即用内置浏览器进 Stripe 账单页，未订阅则列出可开通档位并生成支付链接' },
  { name: 'API Key 管理', desc: '管理 ksk_ 开头的 Kiro API Key，同步订阅额度、测活、查看积分历史' },
  { name: '本地网关', desc: '把 Kiro IDE 的 AI 请求接管到本地代理并改用 API Key，运行期间可随时换 Key' },
  { name: '常用工具', desc: '一键放行 Kiro 的终端命令确认框，关闭时还原开启前的配置' },
  { name: '系统日志', desc: '按级别、分类、关键字与时间筛选，可导出，打包版同样可诊断' },
  { name: '导入导出', desc: '卡密、JSON、CSV、TXT 互通，支持拖拽多个文件按顺序批量导入' },
  { name: '隐私打码', desc: '一键隐藏邮箱、昵称与 API Key 等敏感信息' },
  { name: '桌面端体验', desc: '系统托盘常驻、关闭行为可配、自定义协议唤起、单实例锁' },
  { name: '网络代理', desc: '支持 HTTP 代理，留空时回退系统环境变量' },
  { name: '主题定制', desc: '自定义主题色，深色 / 浅色模式' }
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

const links = [
  { label: '参考项目 Kiro-account-manager', url: 'https://github.com/chaogei/Kiro-account-manager' },
  { label: 'Kiro 官网', url: 'https://github.com/kirodotdev/Kiro' }
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
        Kiro Manager Lite 是一个 Kiro IDE 的多账号与 API Key 管理工具。支持多账号快速切换、
        Token 自动刷新与主动续期、积分用量跟踪、账号测活与订阅开通，以及自定义分组、
        Kiro API Key 管理和本地网关接管，帮你在多个账号与订阅之间省去反复登录退出的力气。
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
      <p class="muted" style="margin: 0 0 14px">
        账户管理相关的接口实现参考了开源项目 Kiro-account-manager（AGPL-3.0），本项目在其基础上重写为
        Vue 技术栈并裁剪为纯账户管理。
      </p>
      <a-space wrap>
        <a-button v-for="link in links" :key="link.url" @click="open(link.url)">
          <template #icon><GithubOutlined /></template>
          {{ link.label }}
        </a-button>
      </a-space>
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

/* small 卡片默认 12px 内边距，大号按钮在其中显得贴边，单独放宽上下留白 */
.credits-card :deep(.ant-card-body) {
  padding: 16px 12px 20px;
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

.check-icon.new {
  color: var(--kal-primary);
}

.check-title {
  margin: 10px 0 6px;
  font-size: 16px;
  font-weight: 600;
}

.version-flow {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
}

.version-chip {
  padding: 2px 10px;
  border-radius: 6px;
  font-size: 13px;
  background: var(--kal-block-bg);
}

.version-chip.new {
  color: #fff;
  background: var(--kal-primary);
}

.release-time {
  margin-top: 8px;
  font-size: 12px;
}

.release-notes {
  margin-top: 16px;
  padding: 12px;
  border-radius: 8px;
  background: var(--kal-block-bg);
}

.release-notes-title {
  font-size: 12px;
  margin-bottom: 6px;
}

/* 更新说明可能很长，限高滚动 */
.release-notes-body {
  max-height: 260px;
  overflow: auto;
  font-size: 13px;
  line-height: 1.75;
  word-break: break-word;
}

/* ============ Markdown 正文（v-html，需要 deep 穿透）============ */
.markdown :deep(> *:first-child) {
  margin-top: 0;
}

.markdown :deep(> *:last-child) {
  margin-bottom: 0;
}

.markdown :deep(h1),
.markdown :deep(h2),
.markdown :deep(h3),
.markdown :deep(h4) {
  margin: 14px 0 6px;
  font-size: 14px;
  font-weight: 600;
  line-height: 1.5;
}

.markdown :deep(h1) {
  font-size: 16px;
}

.markdown :deep(h2) {
  font-size: 15px;
}

.markdown :deep(p) {
  margin: 0 0 8px;
}

.markdown :deep(ul),
.markdown :deep(ol) {
  margin: 0 0 8px;
  padding-left: 20px;
}

.markdown :deep(li) {
  margin: 2px 0;
}

.markdown :deep(li > p) {
  margin: 0;
}

.markdown :deep(a) {
  color: var(--kal-primary);
}

.markdown :deep(code) {
  padding: 1px 5px;
  border-radius: 4px;
  font-size: 12px;
  font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
  background: var(--kal-code-bg);
}

.markdown :deep(pre) {
  margin: 0 0 8px;
  padding: 10px 12px;
  border-radius: 6px;
  overflow: auto;
  background: var(--kal-code-bg);
}

/* 代码块内的 code 不再叠一层底色 */
.markdown :deep(pre code) {
  padding: 0;
  background: none;
}

.markdown :deep(blockquote) {
  margin: 0 0 8px;
  padding: 2px 0 2px 10px;
  border-left: 3px solid var(--kal-border);
  color: var(--kal-muted);
}

.markdown :deep(hr) {
  margin: 12px 0;
  border: none;
  border-top: 1px solid var(--kal-border);
}

.markdown :deep(img) {
  max-width: 100%;
}

.markdown :deep(table) {
  width: 100%;
  margin: 0 0 8px;
  border-collapse: collapse;
  font-size: 12px;
}

.markdown :deep(th),
.markdown :deep(td) {
  padding: 5px 8px;
  border: 1px solid var(--kal-border);
  text-align: left;
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
