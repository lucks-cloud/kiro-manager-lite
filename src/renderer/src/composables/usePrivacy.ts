// 隐私打码的字段级判断
//
// 总开关 privacyMode 关闭时一律不遮；开启后按用户在工具栏勾选的范围决定每个字段遮不遮。
// 账号与 API Key 各一份范围，互不影响。函数内部直接读 store，放进 computed / 模板里都是响应式的。
import { useSettingsStore } from '@/stores/settings'
import {
  DEFAULT_ACCOUNT_PRIVACY_FIELDS,
  DEFAULT_KEY_PRIVACY_FIELDS,
  LOCKED_ACCOUNT_PRIVACY_FIELDS,
  LOCKED_KEY_PRIVACY_FIELDS,
  type AccountPrivacyField,
  type KeyPrivacyField
} from '@shared/privacyFields'

export function usePrivacy(): {
  maskAccount: (field: AccountPrivacyField) => boolean
  maskKey: (field: KeyPrivacyField) => boolean
} {
  const settingsStore = useSettingsStore()

  // 锁定字段即使存档里没有（如手改过配置）也照样遮住
  function maskAccount(field: AccountPrivacyField): boolean {
    const s = settingsStore.settings
    if (!s.privacyMode) return false
    if (LOCKED_ACCOUNT_PRIVACY_FIELDS.includes(field)) return true
    return (s.accountPrivacyFields ?? DEFAULT_ACCOUNT_PRIVACY_FIELDS).includes(field)
  }

  function maskKey(field: KeyPrivacyField): boolean {
    const s = settingsStore.settings
    if (!s.privacyMode) return false
    if (LOCKED_KEY_PRIVACY_FIELDS.includes(field)) return true
    return (s.keyPrivacyFields ?? DEFAULT_KEY_PRIVACY_FIELDS).includes(field)
  }

  return { maskAccount, maskKey }
}

/** 分组名打码：固定显示 ***，不随名称长度变化，避免从长度猜出是哪个分组 */
export function maskGroupName(): string {
  return '***'
}
