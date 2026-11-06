// 批量查询：搜索框一次只能查一个关键字，这里一次查多个。
//
// 规则：
//  - 一行就是一个关键字，行内的空格、逗号都算关键字的一部分（备注里常带空格）
//  - 模糊匹配：和搜索框一样按「包含」判断，不区分大小写
//  - 多个关键字之间是「或」：命中任意一个就显示
// 统一转小写并去重。
import { message } from 'ant-design-vue'

/** 一次最多查这么多个：再多就不是「查询」而是整表导入了，界面也会卡 */
export const BATCH_QUERY_LIMIT = 1000

interface ParsedBatchQuery {
  /** 去重后的关键字（小写），最多 BATCH_QUERY_LIMIT 个 */
  values: string[]
  /** 超出上限被丢掉的个数 */
  overflow: number
}

export function parseBatchQuery(text: string): ParsedBatchQuery {
  const seen = new Set<string>()
  for (const rawLine of text.split(/\r?\n/)) {
    // 整行（去掉首尾空白）就是一个关键字，不做任何拆分
    const value = rawLine.trim().toLowerCase()
    if (value) seen.add(value)
  }
  const all = [...seen]
  return { values: all.slice(0, BATCH_QUERY_LIMIT), overflow: Math.max(0, all.length - BATCH_QUERY_LIMIT) }
}

/** 没在批量查询时给界面的占位结果，省掉每个页面各写一份 */
export const NO_BATCH_QUERY_HITS: { hits: number; missing: string[] } = { hits: 0, missing: [] }

/**
 * 提交批量查询后的结果提示，账号与 API Key 两页共用同一句文案。
 * 有未找到的关键字时用 warning，全部有结果时用 success。
 */
export function notifyBatchQueryResult(
  count: number,
  result: { hits: number; missing: readonly string[] }
): void {
  const { hits, missing } = result
  const text = `批量查询 ${count} 个关键字：${hits} 个有结果${missing.length ? `，${missing.length} 个未找到` : ''}`
  missing.length ? message.warning(text) : message.success(text)
}

export interface BatchQueryResult {
  /** 命中任意一个关键字的条目 id */
  matched: ReadonlySet<string>
  /** 至少命中一个条目的关键字个数 */
  hits: number
  /** 一个条目都没命中的关键字（按输入顺序） */
  missing: string[]
}

/**
 * 对一批条目跑批量查询。items 应当只包含当前所在的一边（正常列表或回收站），
 * 不要先套其它筛选：「未找到」的意思是这里根本没有，而不是被筛选挡住了。
 *
 * textOf 返回该条目可被搜索的小写文本（调用方自行缓存）。
 *
 * 分两步，尽量提前退出，避免关键字数 × 条目数的全量比对：
 *  1. 每个条目从头试关键字，命中第一个就停，同时记下那个关键字已命中；
 *  2. 剩下没被记为命中的关键字再逐个扫一遍条目，找到一个就停 ——
 *     只有真正「未找到」的关键字才会扫满全表。
 */
export function runBatchQuery<T extends { id: string }>(
  items: readonly T[],
  textOf: (item: T) => string,
  queries: readonly string[]
): BatchQueryResult {
  const matched = new Set<string>()
  const hit = new Uint8Array(queries.length)
  for (const item of items) {
    const text = textOf(item)
    for (let i = 0; i < queries.length; i++) {
      if (text.includes(queries[i])) {
        matched.add(item.id)
        hit[i] = 1
        break
      }
    }
  }
  const missing: string[] = []
  for (let i = 0; i < queries.length; i++) {
    if (hit[i]) continue
    const query = queries[i]
    if (!items.some((item) => textOf(item).includes(query))) missing.push(query)
  }
  return { matched, hits: queries.length - missing.length, missing }
}
