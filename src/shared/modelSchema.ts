/**
 * 解析 ListAvailableModels 返回的 additionalModelRequestFieldsSchema。
 *
 * 上游给的是一份 JSON Schema，推理档位藏在里面，而且**路径按模型不同**：
 *   Claude 系：output_config.effort  枚举 low/medium/high/xhigh/max（4.6 及更早没有 xhigh）
 *   GPT 系：   reasoning.effort      枚举里多一个 none
 * 默认值也不一样（有 high 也有 xhigh），另有一批模型压根没有这一层。
 *
 * 所以枚举、默认值、字段路径三样都必须从 schema 现读，不能在界面里写死一张表 ——
 * 上游加一个档位或换一个字段名，写死的表就开始骗人。
 */

/** 模型的推理档位选项 */
export interface ModelEffort {
  /** 该字段在 additionalModelRequestFields 里的路径，如 ['output_config', 'effort'] */
  path: string[]
  /** 可选档位，顺序保持 schema 里的顺序（由低到高） */
  options: string[]
  /** 上游标注的默认档位 */
  default?: string
}

interface JsonSchemaNode {
  type?: string
  enum?: unknown[]
  default?: unknown
  properties?: Record<string, JsonSchemaNode>
}

/** 是不是「一串字符串枚举」 */
function stringEnum(node: JsonSchemaNode | undefined): string[] | undefined {
  if (!Array.isArray(node?.enum)) return undefined
  const options = node.enum.filter((v): v is string => typeof v === 'string')
  return options.length ? options : undefined
}

/**
 * 从 schema 里找出推理档位。
 *
 * 只认名字叫 effort 的枚举字段，最多下钻一层（上游目前就是
 * `<组名>.effort` 这一种形状）。找不到就返回 undefined，界面据此不显示二级选项。
 */
export function parseModelEffort(schema: unknown): ModelEffort | undefined {
  const root = schema as JsonSchemaNode | null | undefined
  const props = root?.properties
  if (!props) return undefined

  // 顶层直接就是 effort 的情况（目前没见过，留着以防上游拉平结构）
  const flat = stringEnum(props.effort)
  if (flat) {
    return { path: ['effort'], options: flat, default: asString(props.effort?.default) }
  }

  for (const [group, node] of Object.entries(props)) {
    const child = node?.properties?.effort
    const options = stringEnum(child)
    if (options) {
      return { path: [group, 'effort'], options, default: asString(child?.default) }
    }
  }
  return undefined
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/**
 * 按路径拼出 additionalModelRequestFields。
 * 例：path=['output_config','effort'], value='max' → { output_config: { effort: 'max' } }
 */
export function buildModelRequestFields(
  effort: ModelEffort | undefined,
  value: string | undefined
): Record<string, unknown> | undefined {
  if (!effort || !value || !effort.options.includes(value)) return undefined
  const root: Record<string, unknown> = {}
  let cursor = root
  for (const key of effort.path.slice(0, -1)) {
    const next: Record<string, unknown> = {}
    cursor[key] = next
    cursor = next
  }
  cursor[effort.path[effort.path.length - 1]] = value
  return root
}
