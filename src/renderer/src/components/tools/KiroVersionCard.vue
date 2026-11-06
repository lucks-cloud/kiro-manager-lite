<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { message } from 'ant-design-vue'
import type { CascaderProps } from 'ant-design-vue'
import {
  ArrowRightOutlined,
  CheckOutlined,
  CloseOutlined,
  EditOutlined,
  ExclamationCircleFilled,
  TagsOutlined,
  UndoOutlined
} from '@ant-design/icons-vue'
import { useSettingsStore } from '@/stores/settings'
import { scrollCascaderToActive } from '@/utils/cascaderScroll'
import {
  DEFAULT_AWS_SDK_VERSION,
  DEFAULT_KIRO_IDE_VERSION,
  KIRO_VERSION_PAIRS,
  compareVersion,
  isKnownPair
} from '@shared/kiroVersion'

const settingsStore = useSettingsStore()

/** 当前已生效的组合 */
const ideVersion = computed(() => settingsStore.settings.kiroIdeVersion || DEFAULT_KIRO_IDE_VERSION)
const sdkVersion = computed(() => settingsStore.settings.awsSdkVersion || DEFAULT_AWS_SDK_VERSION)

/**
 * 级联选项：一级 IDE 版本，二级该版本打包的 SDK 版本。
 * 打包了多份 SDK 时，第一个（版本最高的）标「推荐」。
 */
/** SDK 列顶部的 IDE 版本行，不可选，和模型下拉一样用来确认「正在给哪个 IDE 选 SDK」 */
const HEADER_VALUE = '__ide__'

const cascaderOptions: CascaderProps['options'] = KIRO_VERSION_PAIRS.map((p) => ({
  value: p.ide,
  label: p.ide,
  children: [
    { value: HEADER_VALUE, label: `IDE ${p.ide}`, disabled: true },
    ...p.sdks.map((sdk, i) => ({
      value: sdk,
      label: p.sdks.length > 1 && i === 0 ? `${sdk}（推荐）` : sdk
    }))
  ]
}))

/** 默认只读：点编辑图标解锁，选好后点保存才写入 */
const editing = ref(false)
const draft = ref<string[]>([ideVersion.value, sdkVersion.value])

// 非编辑态时跟随已生效的值；编辑中不覆盖用户正在选的草稿
watch([ideVersion, sdkVersion], ([ide, sdk]) => {
  if (!editing.value) draft.value = [ide, sdk]
})

const draftIde = computed(() => draft.value?.[0] ?? '')
const draftSdk = computed(() => draft.value?.[1] ?? '')
/** 级联必须选到第二级才算完整 */
const draftComplete = computed(() => !!draftIde.value && !!draftSdk.value)
const dirty = computed(
  () => draftIde.value !== ideVersion.value || draftSdk.value !== sdkVersion.value
)

/**
 * 和模型下拉一样：只点了 IDE 版本也算一次选择，自动补上该版本的推荐 SDK（第一个），
 * 不必每次都点两下；想换另一份 SDK 再点第二列即可。
 */
function onCascaderChange(value: unknown): void {
  const [ide, sdk] = ((value as (string | number)[] | undefined) ?? []).map(String)
  if (!ide) return
  const pair = KIRO_VERSION_PAIRS.find((p) => p.ide === ide)
  draft.value = [ide, sdk || pair?.sdks[0] || '']
}

/**
 * 传给级联的值。级联展开时按这个值自动打开对应的二级菜单并滚到该项，
 * 但它只认对照表里存在的路径：当前值不在表里（如默认的 0.12.333）时，
 * 就落到不高于它的最近一个 IDE 版本，保证一展开就停在附近、二级菜单也是打开的。
 * 只影响下拉里的定位，真正的草稿与保存仍以 draft 为准。
 */
const cascaderValue = computed<string[]>(() => {
  const ide = draftIde.value
  const exact = KIRO_VERSION_PAIRS.find((p) => p.ide === ide)
  const pair =
    exact ??
    KIRO_VERSION_PAIRS.find((p) => compareVersion(p.ide, ide) <= 0) ??
    KIRO_VERSION_PAIRS[KIRO_VERSION_PAIRS.length - 1]
  if (!pair) return []
  const sdk = exact && pair.sdks.includes(draftSdk.value) ? draftSdk.value : pair.sdks[0]
  return [pair.ide, sdk]
})

/** 展开时把一级菜单滚到当前 IDE 版本（antd 默认常停在列表顶部） */
function onDropdownVisibleChange(open: boolean): void {
  if (open) scrollCascaderToActive('kiro-version-cascader-dropdown', cascaderValue.value[0])
}

/** 输入框始终显示真实的草稿值，不显示上面为定位换算出来的近似值 */
function displayRender(): string {
  const pair = KIRO_VERSION_PAIRS.find((p) => p.ide === draftIde.value)
  const recommended = !!pair && pair.sdks.length > 1 && pair.sdks[0] === draftSdk.value
  return `${draftIde.value} / ${draftSdk.value}${recommended ? '（推荐）' : ''}`
}

function startEdit(): void {
  draft.value = [ideVersion.value, sdkVersion.value]
  editing.value = true
}

function cancelEdit(): void {
  draft.value = [ideVersion.value, sdkVersion.value]
  editing.value = false
}

// ============ 保存前二次确认 ============
const confirmOpen = ref(false)
const acknowledged = ref(false)
const saving = ref(false)

/** 确认框里逐项列出有变化的部分 */
const changes = computed(() =>
  [
    { key: 'ide', label: 'Kiro IDE 版本', from: ideVersion.value, to: draftIde.value },
    { key: 'sdk', label: 'AWS SDK 版本', from: sdkVersion.value, to: draftSdk.value }
  ].filter((c) => c.from !== c.to)
)

function requestSave(): void {
  if (!draftComplete.value) return void message.warning('请选择到 AWS SDK 版本')
  if (!dirty.value) {
    editing.value = false
    return
  }
  acknowledged.value = false
  confirmOpen.value = true
}

async function confirmSave(): Promise<void> {
  if (!acknowledged.value) return
  const [ide, sdk] = [draftIde.value, draftSdk.value]
  saving.value = true
  try {
    await settingsStore.update({ kiroIdeVersion: ide, awsSdkVersion: sdk })
    editing.value = false
    confirmOpen.value = false
    message.success(`已更换为 KiroIDE ${ide} / aws-sdk-js ${sdk}，后续请求立即生效`)
  } finally {
    saving.value = false
  }
}

/** 拼出某组版本对应的 UA，供卡片与确认框展示 */
function uaOf(ide: string, sdk: string): string {
  return `aws-sdk-js/${sdk} KiroIDE-${ide}-<机器码>`
}

const preview = computed(() => uaOf(ideVersion.value, sdkVersion.value))

/** 降级（新 IDE 版本小于旧版本）时额外提示 403 风险 */
const isDowngrade = computed(() => compareVersion(draftIde.value, ideVersion.value) < 0)
/** 同一 IDE 有多份 SDK 时，选了非推荐那份 */
const notRecommended = computed(() => {
  const pair = KIRO_VERSION_PAIRS.find((p) => p.ide === draftIde.value)
  return !!pair && pair.sdks.length > 1 && pair.sdks[0] !== draftSdk.value
})

// ============ 恢复默认（同样需要确认） ============
const resetOpen = ref(false)
const resetting = ref(false)
const isDefault = computed(
  () => ideVersion.value === DEFAULT_KIRO_IDE_VERSION && sdkVersion.value === DEFAULT_AWS_SDK_VERSION
)
const resetChanges = computed(() =>
  [
    { key: 'ide', label: 'Kiro IDE 版本', from: ideVersion.value, to: DEFAULT_KIRO_IDE_VERSION },
    { key: 'sdk', label: 'AWS SDK 版本', from: sdkVersion.value, to: DEFAULT_AWS_SDK_VERSION }
  ].filter((c) => c.from !== c.to)
)
/** 默认组合不在 26 个对照版本里，文案里如实说明来源 */
const defaultIsListed = isKnownPair(DEFAULT_KIRO_IDE_VERSION, DEFAULT_AWS_SDK_VERSION)

async function confirmReset(): Promise<void> {
  resetting.value = true
  try {
    await settingsStore.update({
      kiroIdeVersion: DEFAULT_KIRO_IDE_VERSION,
      awsSdkVersion: DEFAULT_AWS_SDK_VERSION
    })
    // 正在编辑的草稿一并作废，回到只读态
    editing.value = false
    draft.value = [DEFAULT_KIRO_IDE_VERSION, DEFAULT_AWS_SDK_VERSION]
    resetOpen.value = false
    message.success('已恢复默认版本号，后续请求立即生效')
  } finally {
    resetting.value = false
  }
}
</script>

<template>
  <a-card class="tool-card" :bordered="false">
    <div class="kal-tool-row">
      <div class="kal-tool-main">
        <div class="kal-tool-title">
          <TagsOutlined />
          <strong>请求头版本号</strong>
        </div>
        <div class="kal-tool-desc">
          自定义对外请求 UA 里上报的 Kiro IDE 版本与 AWS SDK 版本，反代、测活、用量、令牌刷新与网关共用。
        </div>
        <div class="kal-tool-hint">
          先选 IDE 版本，再选该版本官方安装包里实际打包的
          <span class="mono">@aws/codewhisperer-streaming-client</span> 版本，保证两者始终成对，
          不会拼出官方从未发布过的组合。服务端会按 UA 版本号做准入，过旧的版本对 Builder ID / IdC 账号会返回 403。
        </div>
      </div>
      <a-button
        size="small"
        :disabled="isDefault"
        :title="isDefault ? '当前已是默认版本号' : undefined"
        @click="resetOpen = true"
      >
        <template #icon><UndoOutlined /></template>
        恢复默认
      </a-button>
    </div>

    <div class="version-form">
      <span class="version-label">IDE / AWS SDK</span>
      <a-input-group compact class="version-group">
        <a-cascader
          :value="cascaderValue"
          :options="cascaderOptions"
          :disabled="!editing"
          :allow-clear="false"
          :display-render="displayRender"
          expand-trigger="hover"
          change-on-select
          popup-class-name="kiro-version-cascader-dropdown"
          @change="onCascaderChange"
          @dropdown-visible-change="onDropdownVisibleChange"
          placeholder="选择 IDE 版本 / AWS SDK 版本"
          style="width: 260px"
        />
        <a-button v-if="!editing" title="修改" aria-label="修改请求头版本号" @click="startEdit">
          <template #icon><EditOutlined /></template>
        </a-button>
        <template v-else>
          <a-button
            type="primary"
            title="保存"
            aria-label="保存请求头版本号"
            :loading="saving"
            :disabled="!dirty || !draftComplete"
            @click="requestSave"
          >
            <template #icon><CheckOutlined /></template>
          </a-button>
          <a-button title="取消" aria-label="取消修改请求头版本号" :disabled="saving" @click="cancelEdit">
            <template #icon><CloseOutlined /></template>
          </a-button>
        </template>
      </a-input-group>
    </div>
    <div class="preview muted">
      当前生效：<span class="mono">{{ preview }}</span>
    </div>

    <a-modal v-model:open="confirmOpen" :width="560" centered :mask-closable="false" :closable="!saving">
      <template #title>
        <span class="modal-title">
          <ExclamationCircleFilled style="color: #faad14" />
          确认更换请求头版本号
        </span>
      </template>

      <div class="change-list">
        <div v-for="c in changes" :key="c.key" class="change-box">
          <span class="change-label">{{ c.label }}</span>
          <span class="mono change-from">{{ c.from }}</span>
          <ArrowRightOutlined class="change-arrow" />
          <span class="mono change-to">{{ c.to }}</span>
          <a-tag v-if="c.key === 'ide' && isDowngrade" color="orange">降级</a-tag>
          <a-tag v-if="c.key === 'sdk' && notRecommended" color="default">非推荐</a-tag>
        </div>
      </div>
      <div class="ua-line muted">
        更换后 UA：<span class="mono">{{ uaOf(draftIde, draftSdk) }}</span>
      </div>

      <a-alert
        type="warning"
        style="margin: 14px 0"
        message="修改请求头版本号可能导致账号请求失败"
        description="该值会写入反代、账号测活、模型列表、用量查询、令牌刷新与 API Key 网关的全部请求头，保存后立即对后续请求生效。"
      />

      <ul class="modal-points">
        <li>服务端按 UA 版本号做准入：版本过旧时 Builder ID / IdC 账号会被拒绝，返回 403 "User is not authorized to make this call."。</li>
        <li v-if="isDowngrade" class="warn">本次是降级操作，触发上述 403 的可能性更高。</li>
        <li v-if="notRecommended" class="warn">
          该 IDE 版本同时打包了多份 SDK，你选的不是推荐的最高版本。
        </li>
        <li>
          若出现异常，可随时点「恢复默认」回到
          <span class="mono">{{ DEFAULT_KIRO_IDE_VERSION }} / {{ DEFAULT_AWS_SDK_VERSION }}</span>。
        </li>
      </ul>

      <a-checkbox v-model:checked="acknowledged" class="ack">我已了解上述风险，确认更换</a-checkbox>

      <template #footer>
        <a-button :disabled="saving" @click="confirmOpen = false">取消</a-button>
        <a-button type="primary" danger :disabled="!acknowledged" :loading="saving" @click="confirmSave">
          确认更换
        </a-button>
      </template>
    </a-modal>

    <a-modal v-model:open="resetOpen" :width="520" centered :mask-closable="false" :closable="!resetting">
      <template #title>
        <span class="modal-title">
          <ExclamationCircleFilled style="color: #faad14" />
          确认恢复默认版本号
        </span>
      </template>

      <div class="change-list">
        <div v-for="c in resetChanges" :key="c.key" class="change-box">
          <span class="change-label">{{ c.label }}</span>
          <span class="mono change-from">{{ c.from }}</span>
          <ArrowRightOutlined class="change-arrow" />
          <span class="mono change-to">{{ c.to }}</span>
        </div>
      </div>
      <div class="ua-line muted">
        恢复后 UA：<span class="mono">{{ uaOf(DEFAULT_KIRO_IDE_VERSION, DEFAULT_AWS_SDK_VERSION) }}</span>
      </div>

      <ul class="modal-points" style="margin-top: 14px">
        <li>
          默认组合 {{ DEFAULT_KIRO_IDE_VERSION }} / {{ DEFAULT_AWS_SDK_VERSION }} 是本机实测过的官方搭配{{
            defaultIsListed ? '' : '（不在下拉对照表的 26 个版本里，恢复后选择框按原值显示）'
          }}。
        </li>
        <li>保存后立即作用于反代、测活、用量、令牌刷新与网关的后续请求。</li>
        <li>若有正在编辑但未保存的修改，会一并丢弃。</li>
      </ul>

      <template #footer>
        <a-button :disabled="resetting" @click="resetOpen = false">取消</a-button>
        <a-button type="primary" :loading="resetting" @click="confirmReset">确认恢复</a-button>
      </template>
    </a-modal>
  </a-card>
</template>

<style scoped>
.tool-card { border: 1px solid var(--kal-border); box-shadow: none; }
.version-form {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: 16px;
  padding-top: 14px;
  border-top: 1px solid var(--kal-border);
  font-size: 13px;
}
.version-label { font-weight: 600; }
/* 选择框与按钮贴合成一组，宽度按内容收缩 */
.version-group { display: inline-flex !important; width: auto !important; }
.preview { margin-top: 10px; font-size: 12px; }

.modal-title { display: inline-flex; align-items: center; gap: 8px; }
.change-list { display: flex; flex-direction: column; gap: 8px; }
.change-box {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  padding: 12px 14px;
  border: 1px solid var(--kal-border);
  border-radius: 8px;
  background: var(--kal-block-bg);
}
.change-label { font-weight: 600; }
.change-from { color: var(--kal-muted); text-decoration: line-through; font-size: 15px; }
.change-arrow { color: var(--kal-muted); }
.change-to { color: var(--kal-primary); font-weight: 700; font-size: 15px; }
.ua-line { margin-top: 8px; font-size: 12px; word-break: break-all; }
.modal-points { margin: 0 0 14px; padding-left: 20px; color: var(--kal-muted); font-size: 12.5px; line-height: 1.9; }
.modal-points .warn { color: #d48806; }
.ack { font-size: 13px; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
.muted { color: var(--kal-muted); }
</style>

<!--
  浮层 teleport 到 body，scoped 样式够不着，靠 popupClassName 限定作用范围。
  antd 默认每列高 180px，26 个 IDE 版本一屏只能看到 5 行，这里加高、加宽，更好点选。
-->
<style>
.kiro-version-cascader-dropdown .ant-cascader-menu {
  height: 360px;
  max-height: 360px;
}
.kiro-version-cascader-dropdown .ant-cascader-menu:first-child {
  min-width: 150px;
}
.kiro-version-cascader-dropdown .ant-cascader-menu:not(:first-child) {
  min-width: 170px;
}
</style>
