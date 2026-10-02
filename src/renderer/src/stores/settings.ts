import { acceptHMRUpdate, defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import { theme } from 'ant-design-vue'
import { DEFAULT_SETTINGS, type AppInfo, type AppSettings } from '@shared/types'

export const useSettingsStore = defineStore('settings', () => {
  const settings = ref<AppSettings>({ ...DEFAULT_SETTINGS })
  const appInfo = ref<AppInfo | null>(null)

  /*
   * 系统当前是不是深色。主进程把 themeSource 设成 system 时，这个媒体查询跟着系统走；
   * 只在「自动」下用得到（浅色 / 深色时主进程强制了 themeSource，查询结果也会跟着变，但不看它）。
   */
  const darkQuery = window.matchMedia('(prefers-color-scheme: dark)')
  const systemDark = ref(darkQuery.matches)
  darkQuery.addEventListener('change', (e) => (systemDark.value = e.matches))

  /** 实际生效的明暗：自动时看系统 */
  const isDark = computed(() =>
    settings.value.themeMode === 'auto' ? systemDark.value : settings.value.themeMode === 'dark'
  )

  const primaryColor = computed(() => settings.value.primaryColor)

  const themeConfig = computed(() => ({
    algorithm: isDark.value ? theme.darkAlgorithm : theme.defaultAlgorithm,
    token: {
      colorPrimary: primaryColor.value,
      borderRadius: 8
    }
  }))

  /**
   * 列表页工具栏（筛选 / 分组 / 排序 / 刷新 / 批量操作那一排）的控件尺寸。
   *
   * 这一排原先写死 small：默认尺寸下正合适，但选了大尺寸后它和上方的
   * 添加 / 导入 / 导出按钮差了两档，看着像另一个页面的东西。
   * 所以大尺寸时给它标准尺寸（middle），默认尺寸时仍用 small。
   */
  const toolbarSize = computed<'small' | 'middle'>(() =>
    settings.value.componentSize === 'large' ? 'middle' : 'small'
  )

  /** 主题色同时写入 CSS 变量，供 antd 之外的自定义样式使用 */
  function applyTheme(): void {
    const root = document.documentElement
    root.classList.toggle('dark', isDark.value)
    root.style.setProperty('--kal-primary', primaryColor.value)
  }

  watch(() => [isDark.value, primaryColor.value], applyTheme)

  async function load(): Promise<void> {
    const [settingsRes, infoRes] = await Promise.all([
      window.api.getSettings(),
      window.api.getAppInfo()
    ])
    // 用默认值打底：主进程返回的设置可能来自旧版本，缺少新增字段
    if (settingsRes.success && settingsRes.data) {
      settings.value = { ...DEFAULT_SETTINGS, ...settingsRes.data }
    }
    if (infoRes.success && infoRes.data) appInfo.value = infoRes.data
    // watch 是异步刷新的，首屏这里同步应用一次，避免主题闪一下
    applyTheme()
  }

  async function update(patch: Partial<AppSettings>): Promise<void> {
    settings.value = { ...settings.value, ...patch }
    const res = await window.api.saveSettings(patch)
    if (res.success && res.data) settings.value = { ...DEFAULT_SETTINGS, ...res.data }
  }

  return { settings, appInfo, themeConfig, isDark, primaryColor, toolbarSize, load, update }
})

// setup 风格的 store 默认不参与 HMR，改完 store 后运行中的实例会缺少新增方法
if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useSettingsStore, import.meta.hot))
}
