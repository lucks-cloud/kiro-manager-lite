/**
 * 账号批量任务（批量生成 API Key、批量生成订阅链接）共用的执行框架：
 *  - 按列表顺序逐个执行，跳过已成功的行，重试时只跑失败和没跑到的
 *  - 一行失败只记在它自己身上，不影响后续
 *  - 正在执行的那一行滚进视野，并多露出两行后续项
 *  - 中止要等手上那一个请求回来才停下，期间提示「正在中止」；关弹窗时静默停下
 * 串行而非并发：批量并发请求上游容易被判为异常活动。
 */
import { computed, nextTick, ref, type Ref } from 'vue'
import { message } from 'ant-design-vue'
import { errorMessage } from '@shared/errors'

type BatchRowState = 'pending' | 'running' | 'ok' | 'fail'

export interface BatchRow {
  state: BatchRowState
  error?: string
}

export function useBatchRun<R extends BatchRow>(options: {
  rows: Ref<R[]>
  /** 行列表容器，行元素带 data-row-index */
  listRef: Ref<HTMLElement | null>
  /** 中止提示的 message key，各弹窗各用一个 */
  messageKey: string
  /** 执行一行：成功时把 state 设为 ok，失败设为 fail 并写 error；抛错按失败处理 */
  runOne: (row: R) => Promise<void>
}) {
  const { rows, listRef, messageKey, runOne } = options
  const running = ref(false)
  const aborted = ref(false)
  /** 因关闭弹窗而停下，不再弹提示 */
  let silent = false

  const stat = computed(() => {
    let ok = 0
    let fail = 0
    let pending = 0
    for (const row of rows.value) {
      if (row.state === 'ok') ok++
      else if (row.state === 'fail') fail++
      else if (row.state === 'pending') pending++
    }
    return { total: rows.value.length, ok, fail, pending }
  })
  const started = computed(() => stat.value.ok + stat.value.fail > 0)

  function revealRow(index: number): void {
    const target = listRef.value?.querySelector<HTMLElement>(
      `[data-row-index="${Math.min(index + 2, rows.value.length - 1)}"]`
    )
    // block: 'nearest' 只滚动列表容器自身，不会带动整个弹窗
    target?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }

  async function start(): Promise<void> {
    if (running.value) return
    running.value = true
    aborted.value = false
    silent = false
    for (let index = 0; index < rows.value.length; index++) {
      const row = rows.value[index]
      if (aborted.value) break
      if (row.state === 'ok') continue
      row.state = 'running'
      row.error = undefined
      await nextTick()
      revealRow(index)
      try {
        await runOne(row)
      } catch (cause) {
        row.state = 'fail'
        row.error = errorMessage(cause)
      }
    }
    running.value = false
    if (aborted.value && !silent) message.success({ content: '已中止', key: messageKey, duration: 2 })
  }

  function abort(): void {
    if (aborted.value || !running.value) return
    aborted.value = true
    message.loading({ content: '正在中止，等待当前账号的请求返回…', key: messageKey, duration: 0 })
  }

  /** 关弹窗时调用：还在跑就静默停下 */
  function stopSilently(): void {
    if (!running.value) return
    silent = true
    aborted.value = true
    message.destroy(messageKey)
  }

  return { running, aborted, stat, started, start, abort, stopSilently }
}
