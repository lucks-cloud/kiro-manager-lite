// 托盘桥接：把当前账号摘要同步给主进程菜单，并响应菜单里的动作
import { computed, onMounted, onUnmounted, watch } from 'vue'
import { message } from 'ant-design-vue'
import { useAccountsStore } from '@/stores/accounts'
import { useSettingsStore } from '@/stores/settings'
import { IDP_META, STATUS_META, formatCredits, subscriptionLabel, tokenLife } from '@/utils/format'
import { displayEmail } from '@/utils/display'
import { notifyResult } from '@/utils/ui'
import type { Account, TrayAction, TraySnapshot } from '@shared/types'

/** 托盘菜单里的 Token 剩余时间文案 */
function tokenLifeText(account: Account): string {
  const life = tokenLife(account.credentials.expiresAt)
  if (life.state === 'unknown') return '未知'
  if (life.state === 'expired') return '已过期'
  return life.state === 'minutes' ? `剩 ${life.minutes} 分钟` : `剩 ${life.hours} 小时`
}

export function useTrayBridge(): void {
  const accountsStore = useAccountsStore()
  const settingsStore = useSettingsStore()

  /** 只有「正常」账号才允许切换 */
  const usableAccounts = computed(() =>
    accountsStore.accounts.filter((a) => a.status === 'active')
  )

  const snapshot = computed<TraySnapshot>(() => {
    const active = accountsStore.activeAccount
    const base: TraySnapshot = {
      total: accountsStore.accounts.length,
      switchable: usableAccounts.value.filter((a) => !a.isActive).length
    }
    if (!active) return base

    const precision = settingsStore.settings.usagePrecision
    return {
      ...base,
      email: displayEmail(active.email, settingsStore.settings.privacyMode),
      idp: IDP_META[active.idp].text,
      subscription: subscriptionLabel(active.subscription),
      status: STATUS_META[active.status].text,
      healthy: active.status === 'active',
      usageCurrent: Number(formatCredits(active.usage.current, precision)) || 0,
      usageLimit: active.usage.limit,
      daysRemaining: active.subscription.daysRemaining,
      tokenLife: tokenLifeText(active)
    }
  })

  /*
   * 账号列表任何一处变化（批量刷新时每个号一次）都会让 snapshot 重算出一个新对象，
   * 但托盘菜单只关心这几项摘要。内容没变就不发 IPC，免得主进程反复重建菜单。
   * snapshot 每次都是新的扁平对象，不需要 deep。
   */
  let lastSent = ''
  watch(
    snapshot,
    (value) => {
      const text = JSON.stringify(value)
      if (text === lastSent) return
      lastSent = text
      void window.api.syncTray(value)
    },
    { immediate: true }
  )

  async function refreshActive(): Promise<void> {
    const active = accountsStore.activeAccount
    if (!active) return void message.info('当前没有登录中的账号')
    const res = await accountsStore.checkStatus(active.id)
    notifyResult(res, { success: '当前账号信息已刷新', failPrefix: '刷新失败' })
  }

  /** 在正常账号中轮换到下一个 */
  async function switchNext(): Promise<void> {
    const usable = usableAccounts.value
    if (usable.length === 0) return void message.info('没有可切换的正常账号')
    const index = usable.findIndex((a) => a.isActive)
    const next = usable[(index + 1) % usable.length]
    if (!next || next.isActive) return void message.info('没有其它可切换的账号')
    const res = await accountsStore.switchTo(next.id)
    notifyResult(res, {
      success: `已切换到 ${next.email}，重启 Kiro IDE 后生效`,
      failPrefix: '切换失败'
    })
  }

  let unsubscribe: (() => void) | null = null

  onMounted(() => {
    unsubscribe = window.api.onTrayAction((action: TrayAction) => {
      if (action === 'refresh') void refreshActive()
      else if (action === 'switch-next') void switchNext()
    })
  })

  onUnmounted(() => {
    unsubscribe?.()
    unsubscribe = null
  })
}
