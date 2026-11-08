<script setup lang="ts">
/**
 * 列表工具栏上的「隐私打码」开关，账号与 API Key 两页共用。
 * 与设置页的「隐私打码」是同一个开关，这里切换会一起持久化。
 *
 * 右侧的设置图标打开打码范围面板（与「筛选」同一种弹层），按页面分别勾选要遮住的字段。
 */
import { computed, ref } from 'vue'
import { EyeInvisibleOutlined, EyeOutlined, SettingOutlined } from '@ant-design/icons-vue'
import { useSettingsStore } from '@/stores/settings'
import { bodyPopupContainer } from '@/utils/ui'
import {
  ACCOUNT_PRIVACY_OPTIONS,
  DEFAULT_ACCOUNT_PRIVACY_FIELDS,
  DEFAULT_KEY_PRIVACY_FIELDS,
  KEY_PRIVACY_OPTIONS,
  LOCKED_ACCOUNT_PRIVACY_FIELDS,
  LOCKED_KEY_PRIVACY_FIELDS
} from '@shared/privacyFields'

const props = withDefaults(
  defineProps<{ size?: 'small' | 'middle' | 'large'; scope?: 'account' | 'key' }>(),
  { scope: 'account' }
)

const settingsStore = useSettingsStore()
const privacyMode = computed(() => settingsStore.settings.privacyMode)

function togglePrivacy(): void {
  void settingsStore.update({ privacyMode: !privacyMode.value })
}

// ============ 打码范围 ============
const settingsOpen = ref(false)
const isAccount = computed(() => props.scope === 'account')
const options = computed(() => (isAccount.value ? ACCOUNT_PRIVACY_OPTIONS : KEY_PRIVACY_OPTIONS))
const defaults = computed<string[]>(() =>
  isAccount.value ? DEFAULT_ACCOUNT_PRIVACY_FIELDS : DEFAULT_KEY_PRIVACY_FIELDS
)
/** 锁定项：始终勾选、禁用，不可取消（账号的邮箱、API Key 的 Key） */
const locked = computed<string[]>(() =>
  isAccount.value ? LOCKED_ACCOUNT_PRIVACY_FIELDS : LOCKED_KEY_PRIVACY_FIELDS
)
const selected = computed<string[]>(() => {
  const s = settingsStore.settings
  const saved = (isAccount.value ? s.accountPrivacyFields : s.keyPrivacyFields) ?? defaults.value
  return [...new Set([...locked.value, ...saved])]
})
const isDefault = computed(
  () =>
    selected.value.length === defaults.value.length &&
    defaults.value.every((f) => selected.value.includes(f))
)

/** 写回时按选项顺序排好，存下来的值稳定，便于比较 */
function save(next: string[]): void {
  const wanted = new Set([...locked.value, ...next])
  const ordered = options.value.map((o) => o.value).filter((v) => wanted.has(v))
  void settingsStore.update(
    isAccount.value
      ? { accountPrivacyFields: ordered as typeof DEFAULT_ACCOUNT_PRIVACY_FIELDS }
      : { keyPrivacyFields: ordered as typeof DEFAULT_KEY_PRIVACY_FIELDS }
  )
}
</script>

<template>
  <a-button-group :size="size">
    <a-button :size="size" :type="privacyMode ? 'primary' : 'default'" @click="togglePrivacy">
      <template #icon>
        <EyeInvisibleOutlined v-if="privacyMode" />
        <EyeOutlined v-else />
      </template>
      {{ privacyMode ? '隐私打码中' : '隐私打码' }}
    </a-button>
    <a-popover
      v-model:open="settingsOpen"
      trigger="click"
      placement="bottomRight"
      :get-popup-container="bodyPopupContainer"
    >
      <template #title>
        <span>打码内容</span>
      </template>
      <template #content>
        <div class="privacy-panel">
          <a-checkbox-group
            class="privacy-options"
            :value="selected"
            @change="(v: any) => save(v as string[])"
          >
            <a-checkbox
              v-for="o in options"
              :key="o.value"
              :value="o.value"
              :disabled="locked.includes(o.value)"
              :title="locked.includes(o.value) ? '始终打码，不可取消' : undefined"
            >
              {{ o.label }}
            </a-checkbox>
          </a-checkbox-group>
          <div class="privacy-footer">
            <span class="muted">{{ privacyMode ? '修改后立即生效' : '开启打码后生效' }}</span>
            <a-button type="link" size="small" :disabled="isDefault" @click="save(defaults)">
              恢复默认
            </a-button>
          </div>
        </div>
      </template>
      <a-button
        :size="size"
        :type="privacyMode ? 'primary' : 'default'"
        title="设置打码内容"
        aria-label="设置打码内容"
      >
        <template #icon><SettingOutlined /></template>
      </a-button>
    </a-popover>
  </a-button-group>
</template>

<style scoped>
.privacy-panel { width: 180px; }
/* 纵向排列，每项一行 */
.privacy-options { display: flex; flex-direction: column; gap: 10px; }
.privacy-options :deep(.ant-checkbox-wrapper) { margin-inline-start: 0; }
.privacy-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 12px;
  padding-top: 8px;
  border-top: 1px solid var(--kal-border);
  font-size: 12px;
}
.privacy-footer :deep(.ant-btn-link) { padding: 0 4px; }
.muted { color: var(--kal-muted); }
</style>
