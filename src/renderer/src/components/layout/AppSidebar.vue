<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  HomeOutlined,
  TeamOutlined,
  KeyOutlined,
  CloudServerOutlined,
  ToolOutlined,
  FileTextOutlined,
  SettingOutlined,
  InfoCircleOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  BulbOutlined,
  BulbFilled
} from '@ant-design/icons-vue'
import kiroLogo from '@/assets/kiro-logo.png'
import { useSettingsStore } from '@/stores/settings'
import { useAccountsStore } from '@/stores/accounts'
import { useKeysStore } from '@/stores/keys'
import { useUpdateStore } from '@/stores/update'

const route = useRoute()
const router = useRouter()
const settingsStore = useSettingsStore()
const accountsStore = useAccountsStore()
const keysStore = useKeysStore()
const updateStore = useUpdateStore()

const collapsed = computed(() => settingsStore.settings.sidebarCollapsed)
const selectedKeys = computed(() => [route.name as string])

function navigate(info: { key: string | number }): void {
  void router.push({ name: String(info.key) })
}

const accountCount = computed(() => accountsStore.stats.total)

const darkModeLabel = computed(() =>
  settingsStore.settings.darkMode ? '浅色模式' : '深色模式'
)

const items = computed(() => [
  { key: 'home', label: '主页', icon: HomeOutlined },
  {
    key: 'accounts',
    label: accountCount.value ? `账户管理（${accountCount.value}个）` : '账户管理',
    icon: TeamOutlined
  },
  {
    key: 'keys',
    label: keysStore.count ? `API Key 管理（${keysStore.count}个）` : 'API Key 管理',
    icon: KeyOutlined
  },
  { key: 'proxy', label: '本地反代', icon: CloudServerOutlined },
  { key: 'tools', label: '常用工具', icon: ToolOutlined },
  { key: 'logs', label: '系统日志', icon: FileTextOutlined },
  { key: 'settings', label: '设置', icon: SettingOutlined },
  { key: 'about', label: '关于', icon: InfoCircleOutlined }
])
</script>

<template>
  <aside
    class="app-sidebar"
    :class="{ collapsed }"
    :style="{ width: collapsed ? '80px' : '228px' }"
  >
    <div class="sidebar-brand">
      <a-tooltip
        :title="updateStore.hasUpdate ? `发现新版本 v${updateStore.latestVersion}` : 'Kiro Manager Lite'"
        placement="right"
      >
        <div
          class="brand-logo-wrap"
          :class="{ 'has-update': updateStore.hasUpdate }"
          @click="updateStore.showModal"
        >
          <img class="brand-logo" :src="kiroLogo" alt="Kiro Manager Lite" />
          <span v-if="updateStore.hasUpdate" class="brand-update-badge">新版本</span>
        </div>
      </a-tooltip>
    </div>

    <a-menu
      :selected-keys="selectedKeys"
      :inline-collapsed="collapsed"
      mode="inline"
      style="border-inline-end: none; flex: 1 1 auto"
      @click="navigate"
    >
      <a-menu-item v-for="item in items" :key="item.key" :title="item.label">
        <template #icon><component :is="item.icon" /></template>
        <span>{{ item.label }}</span>
      </a-menu-item>
    </a-menu>

    <!-- 自己用 flex 排版，折叠态的居中不依赖 antd 组件的内部结构 -->
    <div class="sidebar-footer">
      <a-tooltip :title="collapsed ? darkModeLabel : ''" placement="right">
        <a-button
          type="text"
          class="footer-btn"
          @click="settingsStore.update({ darkMode: !settingsStore.settings.darkMode })"
        >
          <template #icon>
            <BulbFilled v-if="settingsStore.settings.darkMode" />
            <BulbOutlined v-else />
          </template>
          <span v-if="!collapsed">{{ darkModeLabel }}</span>
        </a-button>
      </a-tooltip>
      <a-tooltip :title="collapsed ? '展开侧栏' : ''" placement="right">
        <a-button
          type="text"
          class="footer-btn"
          @click="settingsStore.update({ sidebarCollapsed: !collapsed })"
        >
          <template #icon>
            <MenuUnfoldOutlined v-if="collapsed" />
            <MenuFoldOutlined v-else />
          </template>
          <span v-if="!collapsed">收起侧栏</span>
        </a-button>
      </a-tooltip>
    </div>
  </aside>
</template>


<style scoped>
.brand-logo-wrap {
  position: relative;
  width: 34px;
  height: 34px;
}

.brand-logo-wrap.has-update {
  cursor: pointer;
}

.brand-update-badge {
  position: absolute;
  top: -7px;
  right: -20px;
  z-index: 1;
  padding: 0 5px;
  border: 2px solid var(--kal-sidebar-bg);
  border-radius: 9px;
  color: #fff;
  background: #ff4d4f;
  font-size: 10px;
  font-weight: 600;
  line-height: 16px;
  white-space: nowrap;
  box-shadow: 0 2px 6px rgba(255, 77, 79, 0.3);
}
</style>