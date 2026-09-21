<script setup lang="ts">
/**
 * 时间范围筛选控件：对外只认毫秒时间戳，内部用 dayjs 对接 a-range-picker。
 * 账号与 API Key 的筛选面板共用。
 *
 * 精度到秒：同一天里导入好几批时，只按天筛分不开，所以开 show-time。
 * 直接选日期而不碰时间时，默认补成「起点 00:00:00 / 终点 23:59:59」——
 * 否则 antd 两端的时间都给 00:00:00，区间会退化成一个瞬间，什么都筛不出来。
 */
import { computed } from 'vue'
import dayjs, { type Dayjs } from 'dayjs'

const props = defineProps<{ from?: number; to?: number }>()

const emit = defineEmits<{ change: [from: number | undefined, to: number | undefined] }>()

/** 只有两端都设置了才回填给选择器；单边值不是它能表达的状态 */
const range = computed<[Dayjs, Dayjs] | undefined>(() =>
  props.from != null && props.to != null ? [dayjs(props.from), dayjs(props.to)] : undefined
)

/** 只选日期时补上的默认时刻 */
const showTime = {
  defaultValue: [dayjs().startOf('day'), dayjs().endOf('day')]
}

function onChange(value: unknown): void {
  const pair = value as [Dayjs | null, Dayjs | null] | null
  const start = pair?.[0]
  const end = pair?.[1]
  // 清空（点 × 或删掉内容）时两端一起置空，避免留下半个条件
  if (!start || !end) return emit('change', undefined, undefined)
  // 用户选定的时刻原样生效，两端都含
  emit('change', start.valueOf(), end.valueOf())
}
</script>

<template>
  <a-range-picker
    :value="range"
    size="small"
    allow-clear
    :show-time="showTime"
    format="YYYY-MM-DD HH:mm:ss"
    :placeholder="['开始时间', '结束时间']"
    style="width: 100%"
    @change="onChange"
  />
</template>
