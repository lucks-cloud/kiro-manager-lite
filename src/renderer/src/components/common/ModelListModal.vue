<script setup lang="ts">
/**
 * 查询可用模型：拉一次该账号 / API Key 在 Kiro 官方能用的模型，用圆角卡片一排多个展示。
 * 每张卡片显示模型名、上下文（输入）上限、输出上限、积分倍率与支持的推理档位。
 *
 * 账号与 API Key 共用：两边拉取方式不同（账号要先续期 Token，Key 走管理面），
 * 由调用方传 load，这里只管加载态、出错重试与展示。
 */
import { computed, onMounted, ref } from 'vue'
import { BranchesOutlined, DownOutlined, ReloadOutlined } from '@ant-design/icons-vue'
import { formatRate } from '@/utils/format'
import { errorMessage } from '@shared/errors'
import type { KiroModelInfo } from '@shared/types'

const props = defineProps<{
  /** 标题里的对象名，如邮箱或打码后的 Key */
  subject: string
  load: () => Promise<KiroModelInfo[]>
}>()

const emit = defineEmits<{ close: [] }>()

const models = ref<KiroModelInfo[]>([])
const loading = ref(true)
const error = ref('')

async function fetchModels(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    models.value = await props.load()
    if (!models.value.length) error.value = '官方没有返回任何可用模型'
  } catch (cause) {
    error.value = errorMessage(cause)
  } finally {
    loading.value = false
  }
}

onMounted(fetchModels)

/** token 数压成 200K / 1M；上游没给就是 - */
function tokens(n?: number): string {
  if (!n) return '-'
  if (n >= 1_000_000) return `${Number((n / 1_000_000).toFixed(2))}M`
  if (n >= 1000) return `${Number((n / 1000).toFixed(1))}K`
  return String(n)
}

/**
 * 倍率的档次，决定右上角徽标的配色：便宜的绿、常规的蓝、贵的橙。
 * 一眼能分出「哪些模型省积分」，不必逐个读数字。
 */
function rateTone(rate?: number): 'none' | 'low' | 'mid' | 'high' {
  if (rate == null || Number.isNaN(rate)) return 'none'
  if (rate < 1) return 'low'
  if (rate < 2) return 'mid'
  return 'high'
}

/** 卡片展示用的派生值，算一次；模型列表只在拉取时整体替换 */
const cards = computed(() =>
  models.value.map((model) => ({
    id: model.modelId,
    name: model.modelName || model.modelId,
    input: tokens(model.maxInputTokens),
    output: tokens(model.maxOutputTokens),
    rate: formatRate(model.rate) || '—',
    tone: rateTone(model.rate),
    efforts: model.effort?.options ?? [],
    defaultEffort: model.effort?.default,
    description: model.description
  }))
)
</script>

<template>
  <!-- 1320px 一排放 6 张卡片；窗口更窄时 antd 会把弹窗收到视口宽度以内，网格随之减列 -->
  <a-modal :open="true" width="1320px" centered @cancel="emit('close')">
    <template #title>
      <span class="title">
        <BranchesOutlined />
        可用模型
        <span class="muted subject" :title="props.subject">{{ props.subject }}</span>
        <a-tag v-if="!loading && !error" color="blue" :bordered="false">{{ models.length }} 个</a-tag>
      </span>
    </template>

    <div v-if="loading" class="stage">
      <a-spin size="large" />
      <span class="muted">正在向 Kiro 官方查询可用模型…</span>
    </div>
    <!-- 出错时只说明原因，重试按钮统一放在底部 footer -->
    <div v-else-if="error" class="stage">
      <a-result status="error" title="查询失败" :sub-title="error" />
    </div>
    <div v-else class="grid">
      <!--
        每张卡片三段，自上而下：
          名称 + 倍率徽标 / 模型 ID
          输入 · 输出 两个规格
          推理档位（钉在卡片底部）
        同一排卡片被网格拉成等高，档位钉底后，各卡的同一段在一条水平线上。
      -->
      <div v-for="card in cards" :key="card.id" class="card" :title="card.description">
        <div class="card-head">
          <div class="card-title">
            <div class="card-name">{{ card.name }}</div>
            <div class="card-id mono">{{ card.id }}</div>
          </div>
          <span class="rate" :class="`tone-${card.tone}`" title="积分倍率">{{ card.rate }}</span>
        </div>

        <div class="specs">
          <div class="spec">
            <span class="spec-label">输入</span>
            <span class="spec-value">{{ card.input }}</span>
          </div>
          <span class="spec-sep" />
          <div class="spec">
            <span class="spec-label">输出</span>
            <span class="spec-value">{{ card.output }}</span>
          </div>
        </div>

        <!--
          推理档位左右排：左标签，右侧只写「N 个档位」，悬停展开下拉看具体档位。
          档位个数各模型不同，平铺会让卡片高度参差不齐；收进下拉后每张卡都是同一行高。
        -->
        <div class="efforts">
          <span class="efforts-label">推理档位</span>
          <a-dropdown v-if="card.efforts.length" placement="bottomRight" :trigger="['hover']">
            <span class="effort-count">
              {{ card.efforts.length }} 个档位
              <DownOutlined class="effort-arrow" />
            </span>
            <template #overlay>
              <a-menu :selectable="false" class="effort-menu">
                <a-menu-item v-for="level in card.efforts" :key="level">
                  <span class="effort-item">
                    <span>{{ level }}</span>
                    <!-- 上游标注的默认档位 -->
                    <a-tag v-if="level === card.defaultEffort" color="processing" :bordered="false" class="effort-default">
                      默认
                    </a-tag>
                  </span>
                </a-menu-item>
              </a-menu>
            </template>
          </a-dropdown>
          <span v-else class="effort-none">不支持</span>
        </div>
      </div>
    </div>

    <template #footer>
      <a-button @click="emit('close')">关闭</a-button>
      <a-button type="primary" :loading="loading" @click="fetchModels">
        <template v-if="!loading" #icon><ReloadOutlined /></template>
        重新获取
      </a-button>
    </template>
  </a-modal>
</template>

<style scoped>
.title { display: inline-flex; align-items: center; gap: 8px; max-width: 100%; }
.title :deep(.ant-tag) { margin: 0; }
.subject { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 400; font-size: 13px; }
.stage { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px; min-height: 360px; font-size: 13px; }

/* 一排放多个，按弹窗宽度自动决定列数（1320px 弹窗约 6 列）；超出在弹窗内滚动 */
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(196px, 1fr));
  gap: 12px;
  max-height: 64vh;
  overflow: auto;
  /* 给悬停描边和滚动条留出位置 */
  padding: 2px 6px 2px 2px;
}

/* 单层卡片：不再在卡片里套小方块，信息靠字号、颜色和留白分层 */
.card {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
  padding: 14px 14px 12px;
  border: 1px solid var(--kal-border);
  border-radius: 12px;
  background: var(--kal-card-bg);
  transition: border-color 0.15s, box-shadow 0.15s;
}
.card:hover {
  border-color: color-mix(in srgb, var(--kal-primary) 45%, var(--kal-border));
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.06);
}

/* —— 第一段：名称 / ID + 倍率徽标 —— */
.card-head { display: flex; align-items: flex-start; gap: 8px; }
.card-title { flex: 1 1 auto; min-width: 0; }
.card-name { font-size: 14px; font-weight: 600; line-height: 1.35; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.card-id { margin-top: 2px; color: var(--kal-muted); font-size: 11px; line-height: 1.4; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.rate {
  flex: 0 0 auto;
  min-width: 40px;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 600;
  line-height: 18px;
  text-align: center;
  font-variant-numeric: tabular-nums;
}
.rate.tone-low { color: #389e0d; background: rgba(82, 196, 26, 0.12); }
.rate.tone-mid { color: var(--kal-primary); background: color-mix(in srgb, var(--kal-primary) 12%, transparent); }
.rate.tone-high { color: #d46b08; background: rgba(250, 140, 22, 0.14); }
.rate.tone-none { color: var(--kal-muted); background: var(--kal-block-bg); }

/* —— 第二段：输入 · 输出 —— */
.specs {
  display: flex;
  align-items: center;
  padding: 8px 0;
  border-top: 1px dashed var(--kal-border);
  border-bottom: 1px dashed var(--kal-border);
}
.spec { flex: 1 1 0; display: flex; flex-direction: column; align-items: center; gap: 2px; }
.spec-sep { flex: 0 0 1px; align-self: stretch; background: var(--kal-border); }
.spec-label { color: var(--kal-muted); font-size: 11px; line-height: 1.2; }
.spec-value { font-size: 15px; font-weight: 600; line-height: 1.3; font-variant-numeric: tabular-nums; }

/* —— 第三段：推理档位，左标签右数量，钉在卡片底部 —— */
.efforts {
  margin-top: auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-height: 22px;
}
.efforts-label { color: var(--kal-muted); font-size: 12px; }
/* 可悬停的入口：浅主题色底，看得出能展开 */
.effort-count {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 8px;
  border-radius: 6px;
  color: var(--kal-primary);
  background: color-mix(in srgb, var(--kal-primary) 10%, transparent);
  font-size: 12px;
  line-height: 20px;
  cursor: default;
  transition: background 0.15s;
}
.effort-count:hover { background: color-mix(in srgb, var(--kal-primary) 18%, transparent); }
.effort-arrow { font-size: 10px; }
.effort-none { color: var(--kal-muted); font-size: 12px; line-height: 22px; }

/* 下拉里每个档位一行，默认档位右侧带「默认」标记 */
.effort-item { display: flex; align-items: center; justify-content: space-between; gap: 16px; min-width: 96px; }
.effort-default { margin: 0; font-size: 11px; line-height: 16px; }

.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
.muted { color: var(--kal-muted); }
</style>
