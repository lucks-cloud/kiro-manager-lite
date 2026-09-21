// 模型选择相关的公用形状与逻辑：账号测活与 API Key 测活共用
import { formatRate } from '@/utils/format'
import type { ModelEffort } from '@shared/modelSchema'

/**
 * 两侧模型结构归一后的形状。
 * 账号侧是 KiroModelInfo（modelId/modelName），Key 侧是 KeyModelInfo（id/name），
 * 调用方各自映射成这个形状再交给选择器。
 */
export interface CascaderModel {
  id: string
  name?: string
  rate?: number
  effort?: ModelEffort
}

/** 选择器里一个模型显示成什么：名称（id）+ 倍率，倍率也参与搜索匹配 */
export function modelLabel(model: CascaderModel): string {
  const base = model.name && model.name !== model.id ? `${model.name}（${model.id}）` : model.id
  const rate = formatRate(model.rate)
  return rate ? `${base} ${rate}` : base
}

/**
 * 补齐档位：只点了模型、没点档位时，自动选上 schema 里标注的默认档位。
 *
 * 这样「选了什么」和「实际发出去什么」始终一致 —— 否则输入框只显示模型名，
 * 请求里不带该字段（跑的是上游默认），用户无从知道自己用的是哪一档。
 * schema 没给默认值时保持不选，不擅自替上游决定。
 */
export function withDefaultEffort(models: CascaderModel[], path: string[]): string[] {
  if (path.length !== 1) return path
  const fallback = models.find((m) => m.id === path[0])?.effort?.default
  return fallback ? [path[0], fallback] : path
}
