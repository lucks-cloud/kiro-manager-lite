// 隐私打码的内容范围
//
// 总开关仍是 settings.privacyMode；这里决定开启后具体遮住哪些字段。
// 账号与 API Key 各自一份，用户可在列表工具栏「隐私打码」旁的设置图标里自由组合。

export type AccountPrivacyField = 'email' | 'nickname' | 'note' | 'group'
export type KeyPrivacyField = 'apiKey' | 'email' | 'note' | 'group'

export const ACCOUNT_PRIVACY_OPTIONS: { value: AccountPrivacyField; label: string }[] = [
  { value: 'email', label: '邮箱' },
  { value: 'nickname', label: '昵称' },
  { value: 'note', label: '备注' },
  { value: 'group', label: '分组标签' }
]

export const KEY_PRIVACY_OPTIONS: { value: KeyPrivacyField; label: string }[] = [
  { value: 'apiKey', label: 'API Key' },
  { value: 'email', label: '邮箱' },
  { value: 'note', label: '备注' },
  { value: 'group', label: '分组标签' }
]

/**
 * 始终打码、不可取消的字段：账号的邮箱、API Key 的 Key 本身。
 * 它们是最核心的隐私，开了打码却露出这两项就等于没打码。
 */
export const LOCKED_ACCOUNT_PRIVACY_FIELDS: AccountPrivacyField[] = ['email']
export const LOCKED_KEY_PRIVACY_FIELDS: KeyPrivacyField[] = ['apiKey']

/** 默认与此前的打码范围一致：分组标签默认不遮 */
export const DEFAULT_ACCOUNT_PRIVACY_FIELDS: AccountPrivacyField[] = ['email', 'nickname', 'note']
export const DEFAULT_KEY_PRIVACY_FIELDS: KeyPrivacyField[] = ['apiKey', 'email', 'note']
