import { acceptHMRUpdate, defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import { theme } from 'ant-design-vue'
import {
  DEFAULT_SETTINGS,
  type AppInfo,
  type AppSettings,
  type KiroCliSupportInfo
} from '@shared/types'

export const useSettingsStore = defineStore('settings', () => {
  const settings = ref<AppSettings>({ ...DEFAULT_SETTINGS })
  const appInfo = ref<AppInfo | null>(null)

  /**
   * 本机能否写入 kiro-cli 凭证库。
   * Windows 用凭据管理器存储、或从未运行过 kiro-cli（没有 data.sqlite3）时都不可写，
   * 「登录 Kiro CLI」菜单项据此置灰，避免点下去才报错。
   */
  const kiroCliSupport = ref<KiroCliSupportInfo | null>(null)

  /** 可写入的判据：平台支持且数据库已存在 */
  const canLoginKiroCli = computed(
    () => !!kiroCliSupport.value?.supported && !!kiroCliSupport.value?.dbExists
  )

  /** 不可写时给出的原因，用作菜单项的 tooltip */
  const kiroCliReason = computed(() => {
    const info = kiroCliSupport.value
    if (!info) return ''
    if (!info.supported) return info.reason || ' 当前平台不支持写入 kiro-cli'
    if (!info.dbExists) return '未检测到 kiro-cli，请先安装并登录一次 kiro-cli'
    return ''
  })

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
   * 默认尺寸下用 small；大尺寸时用标准尺寸（middle），
   * 否则它和上方的添加 / 导入 / 导出按钮差两档，看着像另一个页面的东西。
   */
  const toolbarSize = computed<'small' | 'middle'>(() =>
    settings.value.componentSize === 'large' ? 'middle' : 'small'
  )

  /**
   * a-space-compact 的尺寸。
   *
   * 它自带 size 默认 middle，并会覆盖组内控件的尺寸，不显式给的话按钮组在
   * 「大尺寸」设置下会比旁边的普通按钮矮一截 —— 这里把全局尺寸换算成它认的取值。
   */
  const compactSize = computed<'middle' | 'large'>(() =>
    settings.value.componentSize === 'large' ? 'large' : 'middle'
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

    /*
     * kiro-cli 支持情况单独取：它会执行一次 whoami，比读设置慢，
     * 不该拖慢首屏。拿不到就当不可用，菜单项置灰。
     */
    void window.api.getKiroCliSupport().then((res) => {
      if (res.success && res.data) kiroCliSupport.value = res.data
    })
  }

  async function update(patch: Partial<AppSettings>): Promise<void> {
    settings.value = { ...settings.value, ...patch }
    const res = await window.api.saveSettings(patch)
    if (res.success && res.data) settings.value = { ...DEFAULT_SETTINGS, ...res.data }
  }

  return {
    settings,
    appInfo,
    kiroCliSupport,
    canLoginKiroCli,
    kiroCliReason,
    themeConfig,
    isDark,
    primaryColor,
    toolbarSize,
    compactSize,
    load,
    update
  }
})

// setup 风格的 store 默认不参与 HMR，改完 store 后运行中的实例会缺少新增方法
if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useSettingsStore, import.meta.hot))
}
