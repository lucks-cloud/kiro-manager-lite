<script setup lang="ts">
/**
 * 账号批量获取模型列表：每个选中账号一行，逐个向 Kiro 官方拉 ListAvailableModels，
 * 显示每个账号可用的模型数量与模型 ID。可下载 txt / xlsx。
 *
 * 和批量生成订阅链接同一套执行框架（useBatchRun）：点「开始获取」后串行逐个、
 * 单个失败不影响后续、可中止、可重试失败项。
 *
 * 获取后按模型数量归类（8 个 / 9 个 / 10 个…），点某一档只看那些账号；
 * 下载对象都是当前筛选下的成功账号：
 *  - JSON（首选）：打开账号导出弹窗，按选的导出模式导出这批账号本身
 *  - txt / xlsx（更多）：导出模型清单，下载前先选字段
 *
 * 列表、筛选、下载等公共部分在 BatchModelsModalBase，这里只给账号特有的拉取方式、行头与文案。
 */
import BatchModelsModalBase, { type BatchModelsField } from '@/components/common/BatchModelsModalBase.vue'
import ExportAccountsModal from '@/components/accounts/ExportAccountsModal.vue'
import { useAccountsStore } from '@/stores/accounts'
import { useSettingsStore } from '@/stores/settings'
import { displayEmail } from '@/utils/display'
import { usePrivacy } from '@/composables/usePrivacy'
import { subscriptionLabel } from '@/utils/format'
import { freshAccount } from '@/utils/freshAccount'
import { copyText } from '@/utils/ui'
import type { Account, IpcResult, KiroModelInfo } from '@shared/types'

/** accounts 由调用方按界面顺序传入 */
const props = defineProps<{ accounts: Account[] }>()
const emit = defineEmits<{ close: [] }>()

const settingsStore = useSettingsStore()

const { maskAccount } = usePrivacy()
const accountsStore = useAccountsStore()

async function fetchModels(row: Account): Promise<IpcResult<KiroModelInfo[]>> {
  // 非 IDE 当前登录的账号 Token 多半已过期，按需续一次再拉
  const account = await freshAccount(row)
  return window.api.listKiroModels({
    accessToken: account.credentials.accessToken ?? '',
    profileArn: account.profileArn || account.credentials.profileArn,
    region: account.credentials.region,
    idp: account.idp,
    authMethod: account.credentials.authMethod
  })
}

/**
 * 只交还仍然存在的账号：导出弹窗的规则是「勾选为空就导出全部」，
 * 万一这批账号在获取期间被删光，传空数组会变成把整个账号库导出去。
 */
function filterAlive(ids: string[]): string[] {
  return ids.filter((id) => accountsStore.get(id))
}

function email(account: Account): string {
  return displayEmail(account.email, maskAccount('email'))
}

/** 邮箱写完整值，不做隐私打码：导出的清单是给人核对用的；其后是模型数量、模型列表 */
const EXPORT_FIELDS: BatchModelsField<Account>[] = [
  {
    key: 'email',
    label: '邮箱',
    text: (row) => row.item.email,
    column: { title: '邮箱', width: 36 },
    cell: (row) => row.item.email
  }
]
</script>

<template>
  <BatchModelsModalBase
    :items="props.accounts"
    noun="账号"
    alert="按列表顺序逐个向 Kiro 官方查询每个账号可用的模型，单个失败不影响后续账号。不同订阅档位能用的模型可能不同。"
    empty-text="这一档下没有账号"
    export-label="下载 JSON"
    gone-text="这些账号已不在账号列表里"
    message-key="batch-models-abort"
    file-prefix="models-"
    :fields="EXPORT_FIELDS"
    :fetch-models="fetchModels"
    :filter-alive="filterAlive"
    @close="emit('close')"
  >
    <!-- 第一排左侧：邮箱 + 订阅档位 -->
    <template #head="{ item }">
      <!-- 点击复制完整邮箱（不受隐私打码影响），悬停高亮提示可点 -->
      <span
        class="row-email"
        title="点击复制邮箱"
        @click="copyText(item.email, '已复制邮箱')"
      >{{ email(item) }}</span>
      <a-tag :bordered="false" class="kal-batch-tier-tag">{{ subscriptionLabel(item.subscription) }}</a-tag>
    </template>

    <!--
      JSON：复用账号管理的导出弹窗（JSON / OIDC / 卡密… 各种导出模式都在里面），
      导出范围是当前筛选下获取成功的这批账号，比如只导出「9 个模型」那一档。
    -->
    <template #export="{ ids, open, update }">
      <ExportAccountsModal :open="open" :selected-ids="ids" @update:open="update" />
    </template>
  </BatchModelsModalBase>
</template>

<style scoped>
/* 邮箱可点复制：悬停变主题色，与账号卡片悬停邮箱的反馈一致 */
.row-email {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  cursor: pointer;
  transition: color 0.15s;
}
.row-email:hover { color: var(--kal-primary); }
</style>
