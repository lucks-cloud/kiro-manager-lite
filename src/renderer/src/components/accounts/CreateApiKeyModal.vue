<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { message } from 'ant-design-vue'
import { CopyOutlined, DeleteOutlined, ReloadOutlined } from '@ant-design/icons-vue'
import { useAccountsStore } from '@/stores/accounts'
import { useSettingsStore } from '@/stores/settings'
import { displayEmail } from '@/utils/display'
import { formatFullDateTime } from '@/utils/format'
import { toPlain } from '@/utils/ipc'
import { confirmDanger, copyText } from '@/utils/ui'
import type { Account, AccountApiKeyItem, CreateApiKeyResult } from '@shared/types'

const props = defineProps<{ account: Account }>()
const emit = defineEmits<{ close: [] }>()

const accountsStore = useAccountsStore()
const settingsStore = useSettingsStore()

const label = ref('')
const creating = ref(false)
const loading = ref(false)
/** 是否已成功加载过一次：首次加载只显示加载态，加载成功后才显示标题与表格 */
const loaded = ref(false)
const listError = ref('')
const keys = ref<AccountApiKeyItem[]>([])
/**
 * 刚生成的 Key，完整明文只存在这里。
 * 它对应的弹窗一关就置空，之后列表里只剩前缀，与上游「只给一次」的行为一致。
 */
const freshKey = ref<CreateApiKeyResult | null>(null)
/** 用户是否已经复制过，未复制时关闭要二次确认 */
const copied = ref(false)

/** 明文弹窗要压在管理弹窗之上，二次确认再压在它之上 */
const FRESH_MODAL_Z_INDEX = 1100

const email = computed(() => displayEmail(props.account.email, settingsStore.settings.privacyMode))

const columns = [
  { title: '名称', dataIndex: 'label', key: 'label', width: 130, ellipsis: true },
  { title: 'API Key（仅前缀）', key: 'key' },
  { title: '创建时间', key: 'createdAt', width: 160 },
  { title: '操作', key: 'action', width: 64, align: 'center' as const }
]

/** 正在删除的 keyId，用于该行按钮的加载态 */
const deletingId = ref('')

/** 生成过程中可能刷新过凭证，不同步回本地会让下一次请求拿着已作废的旧值 */
function applyRefreshed(refreshed?: CreateApiKeyResult['refreshed']): void {
  if (!refreshed) return
  const latest = accountsStore.get(props.account.id) ?? props.account
  accountsStore.updateAccount(props.account.id, {
    credentials: {
      ...latest.credentials,
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
      expiresAt: Date.now() + refreshed.expiresIn * 1000
    }
  })
}

async function loadList(): Promise<void> {
  loading.value = true
  try {
    const res = await window.api.listAccountApiKeys(toPlain(props.account))
    if (!res.success || !res.data) {
      listError.value = res.error || '获取 API Key 列表失败'
      return
    }
    listError.value = ''
    keys.value = res.data.keys
    loaded.value = true
    applyRefreshed(res.data.refreshed)
  } finally {
    loading.value = false
  }
}

/**
 * 名称留空时按时间戳生成一个 8 位随机名（字母数字）。
 * 以毫秒时间戳的 base36 打底，天然递增、不易撞名；不足 8 位时用随机字符补齐。
 */
function randomKeyName(): string {
  let s = Date.now().toString(36)
  while (s.length < 8) s += Math.random().toString(36).slice(2)
  return s.slice(-8)
}

async function submit(): Promise<void> {
  // 名称非必填：留空则用时间戳随机名提交
  const name = label.value.trim() || randomKeyName()

  creating.value = true
  try {
    // 响应式代理无法结构化克隆，过 IPC 前先剥成普通对象
    const res = await window.api.createAccountApiKey(toPlain(props.account), name)
    if (!res.success || !res.data) return void message.error(res.error || '生成失败')

    const data = res.data
    applyRefreshed(data.refreshed)
    label.value = ''
    copied.value = false
    freshKey.value = data

    /*
     * 先把新 Key 插到表格最前面：列表接口偶发有写入延迟，
     * 直接等刷新结果可能让刚生成的 Key 一时看不见。
     */
    const rowId = data.apiKeyId || data.apiKey
    keys.value = [
      {
        keyId: rowId,
        label: data.label,
        keyPrefix: data.keyPrefix || data.apiKey.slice(0, 12),
        createdAt: data.createdAt
      },
      ...keys.value.filter((item) => item.keyId !== rowId)
    ]
    void loadList()
  } finally {
    creating.value = false
  }
}

/** 删除一个 Key：二次确认后调用控制面，成功再重新拉列表刷新 */
function removeKey(record: AccountApiKeyItem): void {
  confirmDanger({
    title: '删除 API Key',
    content: `确认删除「${record.label || record.keyPrefix}」？删除后使用该 Key 的服务将立即失效，且不可恢复。`,
    okText: '确认删除',
    okButtonProps: { type: 'primary', danger: true },
    onOk: async () => {
      deletingId.value = record.keyId
      try {
        const res = await window.api.deleteAccountApiKey(toPlain(props.account), record.keyId)
        if (!res.success) return void message.error(res.error || '删除失败')
        applyRefreshed(res.data?.refreshed)
        message.success('已删除')
        await loadList()
      } finally {
        deletingId.value = ''
      }
    }
  })
}

function copyFresh(): void {
  if (!freshKey.value) return
  copyText(freshKey.value.apiKey, '已复制完整 API Key')
  copied.value = true
}

/** 关闭明文弹窗即丢弃完整 Key；没复制过就先确认一次 */
function closeFresh(): void {
  if (copied.value) {
    freshKey.value = null
    return
  }
  confirmDanger({
    title: '还没有复制，确认关闭？',
    content: '完整 API Key 关闭后无法再次获取，列表里只会保留前缀。',
    okText: '仍然关闭',
    // 必须高于明文弹窗的 FRESH_MODAL_Z_INDEX，否则确认框被盖住、按钮点不到
    zIndex: FRESH_MODAL_Z_INDEX + 100,
    onOk: () => {
      freshKey.value = null
    }
  })
}

onMounted(loadList)
</script>

<template>
  <a-modal
    :open="true"
    :title="`API Key 管理（${email}）`"
    centered
    width="780px"
    :mask-closable="false"
    :footer="null"
    wrap-class-name="api-key-modal"
    @cancel="emit('close')"
  >
    <div class="modal-body">
      <a-form layout="vertical" class="create-form">
        <a-row :gutter="12" align="bottom">
          <a-col :span="18">
            <a-form-item label="密钥名称">
              <a-input
                v-model:value="label"
                placeholder="例如：本地网关（留空则随机生成密钥名称）"
                :maxlength="64"
                allow-clear
                @press-enter="submit"
              />
            </a-form-item>
          </a-col>
          <a-col :span="6">
            <a-form-item label=" ">
              <a-button type="primary" block :loading="creating" @click="submit">
                生成 API Key
              </a-button>
            </a-form-item>
          </a-col>
        </a-row>
      </a-form>

      <!-- 出错时整块换成结果页：标题栏、计数与表格都不显示，避免「0 个 / 暂无数据」
           这类会被误读成「该账号没有 Key」的信息 -->
      <template v-if="listError">
        <div class="table-area table-area-error">
          <a-result status="error" title="获取 API Key 列表失败" :sub-title="listError">
            <template #extra>
              <a-button type="primary" :loading="loading" @click="loadList">
                <template #icon><ReloadOutlined /></template>
                重试
              </a-button>
            </template>
          </a-result>
        </div>
      </template>

      <!-- 首次加载还没出结果：只显示加载态，不先把标题和空表格摆出来 -->
      <template v-else-if="!loaded">
        <div class="table-area table-area-error">
          <a-spin :spinning="true" tip="加载中..." />
        </div>
      </template>

      <template v-else>
        <div class="list-head">
          <span class="list-title">已创建的 API Key（{{ keys.length }}）</span>
          <a-button type="text" size="small" :loading="loading" @click="loadList">
            <template #icon><ReloadOutlined /></template>
            刷新
          </a-button>
        </div>

        <!-- 表格区域按剩余高度撑满：空列表时同样保留这块高度，弹窗不会忽高忽低 -->
        <div class="table-area">
          <a-table
            :columns="columns"
            :data-source="keys"
            row-key="keyId"
            size="small"
            :loading="loading"
            :pagination="false"
          >
            <template #bodyCell="{ column, record }">
              <template v-if="column.key === 'label'">
                <span :title="record.label">{{ record.label || '-' }}</span>
              </template>
              <template v-else-if="column.key === 'key'">
                <span class="mono key-text">{{ record.keyPrefix }}…</span>
              </template>
              <template v-else-if="column.key === 'createdAt'">
                <span class="muted mono">{{ formatFullDateTime(record.createdAt) }}</span>
              </template>
              <template v-else-if="column.key === 'action'">
                <a-button
                  type="text"
                  size="small"
                  danger
                  :loading="deletingId === record.keyId"
                  title="删除"
                  @click="removeKey(record)"
                >
                  <template #icon><DeleteOutlined /></template>
                </a-button>
              </template>
            </template>
            <template #emptyText>
              <span class="muted">{{ loading ? '加载中...' : '该账号还没有创建过 API Key' }}</span>
            </template>
          </a-table>
        </div>
      </template>

      <div class="modal-foot">
        <a-button type="primary" @click="emit('close')">完成</a-button>
      </div>
    </div>
  </a-modal>

  <!-- 明文只在这个弹窗里出现一次，关掉就只剩前缀 -->
  <a-modal
    v-if="freshKey"
    :open="true"
    title="API Key 已生成"
    centered
    width="560px"
    :mask-closable="false"
    :z-index="FRESH_MODAL_Z_INDEX"
    @cancel="closeFresh"
  >
    <a-alert
      type="warning"
      show-icon
      description="完整 API Key 只显示这一次，关闭本窗口后无法再次获取，列表中只会保留前缀。"
    />
    <div class="fresh-rows">
      <div class="fresh-row">
        <span class="fresh-label muted">名称</span>
        <span class="fresh-value">{{ freshKey.label || '-' }}</span>
      </div>
      <div class="fresh-row">
        <span class="fresh-label muted">创建时间</span>
        <span class="fresh-value mono">{{ formatFullDateTime(freshKey.createdAt) }}</span>
      </div>
      <div class="fresh-row">
        <span class="fresh-label muted">区域</span>
        <span class="fresh-value mono">{{ freshKey.region }}</span>
      </div>
      <div class="fresh-row is-key">
        <span class="fresh-label muted">API Key</span>
        <div class="key-box mono">{{ freshKey.apiKey }}</div>
      </div>
    </div>
    <template #footer>
      <a-button @click="closeFresh">关闭</a-button>
      <a-button type="primary" @click="copyFresh">
        <template #icon><CopyOutlined /></template>
        复制 API Key
      </a-button>
    </template>
  </a-modal>
</template>

<style scoped>
/*
 * 弹窗按视口高度固定成 80%：表格行数从 0 到几十条都不会改变弹窗尺寸，
 * 内部只让表格区域滚动，头部表单与底部按钮始终可见。
 */
.modal-body {
  display: flex;
  flex-direction: column;
  height: calc(80vh - 108px);
}

.create-form :deep(.ant-form-item) {
  margin-bottom: 0;
}

.list-head {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: space-between;
  margin: 16px 0 8px;
}

.list-title {
  font-weight: 500;
}

/* min-height: 0 是 flex 子项能正常滚动的前提，否则内容会把容器顶高 */
.table-area {
  flex: 1;
  min-height: 0;
  overflow: auto;
  border: 1px solid var(--kal-border);
  border-radius: 8px;
}

.key-text {
  color: var(--kal-muted);
  word-break: break-all;
}

/* 出错占位：与表格区域同高、居中显示结果页，撑住高度让弹窗尺寸稳定；
   顶掉表格区域的边框与滚动 */
.table-area-error {
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: auto;
  margin-top: 16px;
  border: none;
}

.modal-foot {
  display: flex;
  flex: 0 0 auto;
  justify-content: flex-end;
  margin-top: 16px;
}

.fresh-rows {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 16px;
}

.fresh-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.fresh-row.is-key {
  align-items: flex-start;
}

.fresh-label {
  flex: 0 0 68px;
  font-size: 12px;
}

.fresh-value {
  flex: 1;
  word-break: break-all;
}

/* 完整 Key 很长且没有空格，必须按字符换行，否则会把弹窗顶宽 */
.key-box {
  flex: 1;
  padding: 8px 10px;
  border: 1px solid var(--kal-border);
  border-radius: 8px;
  background: var(--kal-code-bg);
  font-size: 12px;
  line-height: 1.6;
  word-break: break-all;
}
</style>

<style>
/* 表头吸顶：滚动长列表时列名不跟着走 */
.api-key-modal .table-area .ant-table-thead > tr > th {
  position: sticky;
  top: 0;
  z-index: 1;
}
</style>
