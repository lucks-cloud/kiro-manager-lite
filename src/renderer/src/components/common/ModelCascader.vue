<script setup lang="ts">
/**
 * 模型选择器：一级选模型，二级选推理档位（只有部分模型有）。
 *
 * 用级联而不是两个下拉：档位是模型的属性，换模型就得换档位集合甚至没有档位，
 * 两个独立控件很容易出现「档位还留着上一个模型的值」这种不合法组合。
 * 级联天然表达「有的模型有第二层、有的没有」，还自带搜索。
 *
 * 档位枚举与默认值一律来自该模型自己的 schema（见 shared/modelSchema）——
 * 上游按模型给的枚举并不相同（Claude 系 5 档、GPT 系多一个 none、4.6 少一个 xhigh），
 * 界面里写死一张表迟早骗人。
 *
 * change-on-select：只点模型不点档位也是合法选择，表示「不带该字段、用上游默认档位」。
 * 否则有档位的模型每次都得点两下，而大多数场景用默认就够了。
 */
import { computed } from 'vue'
// 形状与「补默认档位」的逻辑放在 utils/models：script setup 里不能导出运行时函数，
// 而调用方（两个测活弹窗）在初始化选中项时也要用到同一份逻辑
import { modelLabel, withDefaultEffort, type CascaderModel } from '@/utils/models'

const props = withDefaults(
  defineProps<{
    models: CascaderModel[]
    /** 当前选中的 [模型 id] 或 [模型 id, 档位] */
    value: string[]
    disabled?: boolean
    placeholder?: string
  }>(),
  { disabled: false, placeholder: '选择模型' }
)

const emit = defineEmits<{ change: [path: string[]] }>()

interface Option {
  value: string
  label: string
  /** 空串等于不显示原生悬停提示；选项文字本身已经完整可见，浮层只是挡视线 */
  title: string
  disabled?: boolean
  children?: Option[]
}

/** 档位列顶部的模型名，不可选，仅用来确认「我正在给哪个模型选档位」 */
const HEADER_VALUE = '__model__'

const options = computed<Option[]>(() =>
  props.models.map((model) => {
    const label = modelLabel(model)
    const option: Option = { value: model.id, label, title: '' }
    if (model.effort?.options.length) {
      /*
       * 档位列开头插一行模型名：多个模型的档位集合完全一样，
       * 光看右列分不出正在给谁选，切换模型时很容易以为没切成功。
       */
      option.children = [
        { value: HEADER_VALUE, label: model.name || model.id, title: '', disabled: true },
        ...model.effort.options.map((level) => ({
          value: level,
          label: level === model.effort?.default ? `${level}（默认）` : level,
          title: ''
        }))
      ]
    }
    return option
  })
)

/** 选中后输入框里显示什么：只选模型就显示模型名，选了档位再接上档位 */
const displayText = computed(() => {
  const [modelId, level] = props.value
  if (!modelId) return ''
  const model = props.models.find((m) => m.id === modelId)
  const name = model ? modelLabel(model) : modelId
  return level ? `${name} · ${level}` : name
})

function onChange(value: unknown): void {
  const path = (value as (string | number)[] | undefined)?.map(String) ?? []
  emit('change', withDefaultEffort(props.models, path))
}

/** 级联的搜索按「整条路径的 label」匹配，这样输 opus max 也能命中；表头行不参与 */
function filter(search: string, path: Option[]): boolean {
  if (path[path.length - 1]?.disabled) return false
  const needle = search.toLowerCase()
  return path.some((node) => node.label.toLowerCase().includes(needle))
}
</script>

<template>
  <a-cascader
    :value="props.value"
    :options="options"
    :disabled="props.disabled"
    :placeholder="props.placeholder"
    :show-search="{ filter }"
    :allow-clear="false"
    expand-trigger="hover"
    change-on-select
    dropdown-class-name="model-cascader-dropdown"
    style="flex: 1 1 auto; min-width: 0"
    @change="onChange"
  >
    <template #displayRender>{{ displayText }}</template>
  </a-cascader>
</template>

<!--
  浮层是 teleport 到 body 的，scoped 样式够不着，所以这段不加 scoped，
  靠 dropdownClassName 限定作用范围。
  antd 的级联列默认高 180px（dropdownHeight token），模型有十几个，一屏只能看五六行，
  这里加到 340px，少滚两屏。
-->
<style>
.model-cascader-dropdown .ant-cascader-menu {
  height: 340px;
  max-height: 340px;
}
</style>
