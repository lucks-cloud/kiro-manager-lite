// 一键写入桌面 agent 的配置，让它们把请求打到本地反代
//
// 两个目标：
//  - Claude Code：~/.claude/settings.json 的 env 字段（ANTHROPIC_BASE_URL 等）
//  - Codex CLI：~/.codex/config.toml 的自定义 provider + ~/.codex/auth.json 的 key
//
// 写之前把原文件整份存进本应用的 store，「还原」时原样写回；
// 原本不存在的文件在还原时删除，不留下一个空壳配置。
import { execFile, spawn } from 'child_process'
import { existsSync } from 'fs'
import * as http from 'http'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { log } from './logger'
import { findBinary, installLabel, locateCliSync, locateClient } from './proxyClientInstall'
import {
  getProxyClientBackup,
  getProxyCodexTemplate,
  setProxyClientBackup,
  setProxyCodexTemplate,
  type ProxyClientBackupFile
} from './store'
import type { KiroModelInfo, ProxyClientState, ProxyClientTarget } from '../shared/types'

/**
 * Codex 里我们用的 provider 与 profile 名，同时决定文件名
 * （Kiro-Manager-Lite.config.toml），用户在目录里一眼能认出是谁写的。
 *
 * 不叫 kiro：市面上几个 Kiro 反代工具的示例配置都用 `kiro` 这个名字，
 * 撞名会把用户已有的 provider 定义覆盖掉。
 * TOML 裸键允许字母、数字、短横与下划线，这个名字可以直接当表名。
 */
const CODEX_PROVIDER = 'Kiro-Manager-Lite'

/** 早期版本用过的名字：写入时清理它留下的文件与配置段 */
const LEGACY_CODEX_NAMES = ['kml']

function home(): string {
  return os.homedir()
}

/** 代为启动前先定位应用；手动指定过位置的按指定的来，别的地方也有一份时不会开错 */
async function requireApp(target: ProxyClientTarget): Promise<string> {
  const found = (await locateClient(target)).path
  if (!found) throw new Error(`没有找到 ${installLabel(target)}`)
  return found
}

/**
 * 启动命令里怎么调用命令行工具。
 * 手动指定了位置的用完整路径：它多半不在 PATH 里，只写命令名新终端会报 command not found。
 * 带引号是因为路径里可能有空格；macOS 的 shell 与 Windows 的 cmd 都认双引号。
 */
function cliInvoke(target: ProxyClientTarget, name: string): string {
  const located = locateCliSync(target)
  return located.custom && located.path ? `"${located.path}"` : name
}

/** Claude Code 的配置文件；老版本用 claude.json */
function claudeSettingsPath(): string {
  const settings = path.join(home(), '.claude', 'settings.json')
  const legacy = path.join(home(), '.claude', 'claude.json')
  return existsSync(settings) || !existsSync(legacy) ? settings : legacy
}

/** Codex 的配置目录：尊重 CODEX_HOME，ChatGPT 桌面客户端也用这个变量 */
function codexHome(): string {
  return process.env.CODEX_HOME?.trim() || path.join(home(), '.codex')
}

function codexConfigPath(): string {
  return path.join(codexHome(), 'config.toml')
}

/**
 * Codex 0.158 起的 profile 格式：独立文件 $CODEX_HOME/<name>.config.toml，
 * `codex --profile <name>` 时叠加在 config.toml 之上。
 * 旧格式 `[profiles.<name>]` 表写在 config.toml 里，新版会直接拒绝启动。
 */
function codexProfilePath(): string {
  return path.join(codexHome(), `${CODEX_PROVIDER}.config.toml`)
}

/**
 * Kiro 模型的目录文件。
 * 反代的 /v1/models 在 Codex 来要目录时直接返回这份内容，见 proxyServer。
 */
export function codexCatalogPath(): string {
  return path.join(codexHome(), `${CODEX_PROVIDER}.models.json`)
}

function legacyCodexFiles(): string[] {
  return LEGACY_CODEX_NAMES.flatMap((name) => [
    path.join(codexHome(), `${name}.config.toml`),
    path.join(codexHome(), `${name}.models.json`)
  ])
}

export function clientFiles(target: ProxyClientTarget): string[] {
  /*
   * 各目标要备份的文件：
   *  - claudeCode：settings.json
   *  - codex（命令行版）：自己的 profile 与模型目录，外加旧名字留下的 kml.* 残留文件
   *    （写入时会删掉它们，备份里得有，还原才完整）
   *  - codexApp（桌面版）：config.toml 与模型目录。它只认全局默认 provider，没有 profile 可用。
   *    config.toml 是两个 Codex 共用的，而且桌面版自己也会改写它（插件、marketplaces 等），
   *    所以还原采用「只摘掉我们那几行」的方式，不整份覆盖，见 restoreCodexApp。
   * auth.json 一律不碰——那是 Codex 桌面版的 OAuth 登录态。
   */
  if (target === 'claudeCode') return [claudeSettingsPath()]
  if (target === 'codexApp') return [codexConfigPath(), codexCatalogPath()]
  // Cursor：providers 是我们写的，settings.json 只改一个键，但也要备份才能还原
  if (target === 'cursor') return [ccursorProvidersPath(), cursorSettingsPath()]
  if (target === 'claudeApp') return [claude3pModePath(), claude3pConfigPath(), claude3pMetaPath()]
  // dsh：我们自己的 profile 一定归我们；默认 profile 只在是我们写的时候才参与还原
  if (target === 'deepseek') return [dshProfilePath(DSH_PROFILE), dshProfilePath('web')]
  // dsh 桌面版：只动它自己那一份 profile patch，和命令行版互不影响
  if (target === 'deepseekApp') return [dshProfilePath(DSH_DESKTOP_PROFILE)]
  // VS Code：只记它存不存在，还原是外科式的（只摘我们那一组），见 restoreVscode
  if (target === 'vscode') return [vscodeModelsPath()]
  // WorkBuddy：同样外科式还原（只摘我们的条目），快照用来判断原文件在不在、原白名单有哪些
  if (target === 'workbuddy') return [workbuddyModelsPath()]
  return [codexProfilePath(), codexCatalogPath(), ...legacyCodexFiles()]
}

/** 界面上展示的文件：旧名字的残留文件只参与备份，不展示。「打开目录」也按这份下标取 */
export function displayFiles(target: ProxyClientTarget): string[] {
  if (target === 'claudeCode') return [claudeSettingsPath()]
  if (target === 'codexApp') return [codexConfigPath(), codexCatalogPath()]
  if (target === 'cursor') return [ccursorProvidersPath(), cursorSettingsPath()]
  if (target === 'claudeApp') return [claude3pConfigPath()]
  if (target === 'deepseek') return [dshProfilePath(DSH_PROFILE)]
  if (target === 'deepseekApp') return [dshProfilePath(DSH_DESKTOP_PROFILE)]
  if (target === 'vscode') return [vscodeModelsPath()]
  if (target === 'workbuddy') return [workbuddyModelsPath()]
  return [codexProfilePath(), codexCatalogPath()]
}

async function readTextIfExists(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, 'utf-8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function readJsonObject(file: string): Promise<Record<string, unknown>> {
  const text = await readTextIfExists(file)
  if (!text || !text.trim()) return {}
  try {
    const parsed = JSON.parse(text)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // 解析失败时不能覆盖：里面可能是用户手写的带注释配置
    throw new Error(`${file} 不是合法的 JSON，请先手动检查`)
  }
  return {}
}

async function writeFileAtomic(file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.kiro-manager.tmp`
  await fs.writeFile(tmp, content, 'utf-8')
  try {
    await fs.rename(tmp, file)
  } catch {
    await fs.writeFile(file, content, 'utf-8')
    await fs.unlink(tmp).catch(() => undefined)
  }
}

/**
 * 写入前留一份快照。已经备份过的文件不再重记（避免把自己写的值当成用户原值）；
 * 应用升级后新涉及的文件（比如模型目录）补记进同一份备份，
 * 否则「还原」时它会被漏掉，留下一个没人引用的残留文件。
 */
async function snapshot(target: ProxyClientTarget): Promise<void> {
  const existing = getProxyClientBackup(target)
  const recorded = new Set(existing?.files.map((f) => f.path) ?? [])
  const files: ProxyClientBackupFile[] = [...(existing?.files ?? [])]
  let added = false
  for (const file of clientFiles(target)) {
    if (recorded.has(file)) continue
    const content = await readTextIfExists(file)
    files.push({ path: file, existed: content !== null, content: content ?? '' })
    added = true
  }
  if (!existing || added) {
    setProxyClientBackup(target, { savedAt: existing?.savedAt ?? Date.now(), files })
  }
}

// ============ Claude Code ============

interface ProxyTargetInfo {
  /** 反代根地址，如 http://127.0.0.1:8990 */
  baseUrl: string
  apiKey: string
  /** 写进配置的默认模型 */
  model: string
  /** 默认模型的推理档位；空串表示用上游默认 */
  effort: string
  /** 当前账号可用的模型（刷新模型拉回的列表），用于 Codex 目录与 Claude Code 的档位 */
  models: KiroModelInfo[]
}

/*
 * 上下文与输出上限：必须按模型取，不能统一写死。
 * 上游 ListAvailableModels 的 tokenLimits 里实测跨度很大：
 * deepseek-3.2 是 164K，minimax 196K，Claude 4.5 一代 200K，qwen3-coder 256K，
 * 而 opus-4.6 及以上、sonnet-5、gpt-5.6 系列都是 1M。
 * 统一写一个值必然对不上大部分模型：
 * 填小了客户端会提前触发压缩/截断，填大了又会被上游拒。
 * 只有列表还没刷新（拿不到 tokenLimits）时才用下面的保守回落值。
 */
const FALLBACK_INPUT_TOKENS = 200_000
const FALLBACK_OUTPUT_TOKENS = 64_000

function modelInputTokens(m: { modelId: string; maxInputTokens?: number }): number {
  return m.maxInputTokens && m.maxInputTokens > 0 ? m.maxInputTokens : FALLBACK_INPUT_TOKENS
}

function modelOutputTokens(m: { modelId: string; maxOutputTokens?: number }): number {
  return m.maxOutputTokens && m.maxOutputTokens > 0 ? m.maxOutputTokens : FALLBACK_OUTPUT_TOKENS
}

/**
 * 在模型列表里挑某一系列里「最新」的那个，给 Claude Code 的 opus / haiku 快捷档位用。
 * 列表是上游按推荐顺序给的，靠前的通常更新；拿不到时回落到固定名字。
 */
function pickFamily(models: KiroModelInfo[], family: string, fallback: string): string {
  return models.find((m) => m.modelId.startsWith(`claude-${family}`))?.modelId ?? fallback
}

/**
 * 给 Claude Code 借用能力的型号（modelPicker 条目的 behavesAs）。
 *
 * Claude Code 按模型 ID 认能力：认得的才开 /effort 与思考，Kiro 的 ID 用点号（claude-opus-4.7），
 * 和官方的短横（claude-opus-4-7）对不上，不借的话所有模型都没有档位滑块。
 *  - Claude 系：点号换成短横就是它自己，档位集合与默认档位都和真模型一致；
 *  - 其它有档位的（GPT 系）：按档位集合借一个同集合的 Claude 型号。借 opus-5 而不是 opus-4-7：
 *    4-7 的默认档位是 xhigh，一上来就最贵；opus-5 默认 high，和上游 GPT 的默认一致；
 *  - 没有档位的（GLM、Qwen…）不借，Claude Code 当成未知模型，不出滑块，这正是对的。
 * 借来的只是能力与默认档位，请求里发的仍是条目自己的 model。
 */
function claudeBehavesAs(m: KiroModelInfo): string | undefined {
  const options = m.effort?.options ?? []
  if (!options.length) return undefined
  if (m.modelId.startsWith('claude-')) return m.modelId.replace(/\./g, '-')
  if (options.includes('xhigh')) return 'claude-opus-5'
  return 'claude-opus-4-6'
}

/**
 * 写进 Claude Code 的模型名。上下文到 1M 的加 [1m]：走网关时 Claude Code 核实不了 1M，
 * 默认按 200K 算、过早压缩；带上后缀它按 1M 算，发请求前会自己去掉后缀，反代收到的还是原名。
 */
function claudeCodeModel(m: KiroModelInfo): string {
  return modelInputTokens(m) >= 1_000_000 ? `${m.modelId}[1m]` : m.modelId
}

/** 固定档位（opus / sonnet / haiku 别名）的能力声明，Claude Code 认不出 Kiro 的 ID 时靠它开档位 */
function claudeCapabilities(m: KiroModelInfo | undefined): string | undefined {
  const options = m?.effort?.options ?? []
  if (!options.length) return undefined
  return [
    'effort',
    ...(options.includes('xhigh') ? ['xhigh_effort'] : []),
    ...(options.includes('max') ? ['max_effort'] : []),
    'thinking',
    'adaptive_thinking',
    'interleaved_thinking'
  ].join(',')
}

async function applyClaudeCode(info: ProxyTargetInfo): Promise<void> {
  const file = claudeSettingsPath()
  const config = await readJsonObject(file)
  const env =
    config.env && typeof config.env === 'object' && !Array.isArray(config.env)
      ? (config.env as Record<string, unknown>)
      : {}

  // 还没刷新过模型列表时只有默认模型这一条，至少保证它能用
  const models: KiroModelInfo[] = info.models.length ? info.models : [{ modelId: info.model }]
  const byId = (id: string): KiroModelInfo => models.find((m) => m.modelId === id) ?? { modelId: id }
  const main = byId(info.model)

  env.ANTHROPIC_BASE_URL = info.baseUrl
  /*
   * 只写 AUTH_TOKEN，不写 ANTHROPIC_API_KEY：
   * 两个都设置时 Claude Code 会提示凭证冲突，而 AUTH_TOKEN 才是自定义端点该用的那个。
   */
  env.ANTHROPIC_AUTH_TOKEN = info.apiKey
  // 和选择器里那一行写成同一个字符串（含 [1m]），启动后选择器才会把它标成当前模型
  env.ANTHROPIC_MODEL = claudeCodeModel(main)

  /*
   * opus / sonnet / haiku 三个别名各指到对应系列里最新的那个：子代理、后台任务（haiku）
   * 和 opusplan 都按别名取模型。名字与能力一并声明，否则别名那一行显示成裸 ID、没有档位。
   */
  const pins: [string, KiroModelInfo][] = [
    ['OPUS', byId(pickFamily(models, 'opus', info.model))],
    ['SONNET', byId(pickFamily(models, 'sonnet', info.model))],
    ['HAIKU', byId(pickFamily(models, 'haiku', 'claude-haiku-4.5'))]
  ]
  for (const [family, m] of pins) {
    const key = `ANTHROPIC_DEFAULT_${family}_MODEL`
    env[key] = claudeCodeModel(m)
    env[`${key}_NAME`] = kiroLabel(m)
    const caps = claudeCapabilities(m)
    if (caps) env[`${key}_SUPPORTED_CAPABILITIES`] = caps
    else delete env[`${key}_SUPPORTED_CAPABILITIES`]
  }
  config.env = env

  /*
   * /model 选择器列出账号能用的全部模型。只靠上面三个别名，选择器里就只有三行，
   * 其余模型得手敲 /model <id> 才能用。modelPicker 需要 Claude Code v2.1.242+，
   * 更老的版本不认这个键、原样忽略，不影响上面的环境变量生效。
   * replaceBuiltInOptions：内置那几行（官方 Opus / Sonnet / Fable）经反代大多调不通，只留我们的。
   */
  config.modelPicker = {
    replaceBuiltInOptions: true,
    options: models.map((m) => {
      const behavesAs = claudeBehavesAs(m)
      const rate = typeof m.rate === 'number' ? ` · ${m.rate}x 积分` : ''
      return {
        model: claudeCodeModel(m),
        label: kiroLabel(m),
        description: m.modelId === 'auto' ? '由 Kiro 按任务自动选择模型' : `经 Kiro 本地反代${rate}`,
        ...(behavesAs ? { behavesAs } : {})
      }
    })
  }

  await writeFileAtomic(file, `${JSON.stringify(config, null, 2)}\n`)
}

async function claudeCodeApplied(info: ProxyTargetInfo): Promise<boolean> {
  const config: Record<string, unknown> = await readJsonObject(claudeSettingsPath()).catch(() => ({}))
  const env = config.env as Record<string, unknown> | undefined
  return typeof env?.ANTHROPIC_BASE_URL === 'string' && env.ANTHROPIC_BASE_URL === info.baseUrl
}

// ============ DeepSeek Harness (dsh) ============
//
// dsh 的配置在 $DSH_HOME（默认 ~/.dsh）下，每个 profile 一份
// profiles/<profile>/cordis.patch.yml。`dsh web` 用的 profile 叫 web。
//
// 为什么另起一个 profile 而不是改 web：
//   官方文档明确写着「A Cordis config override replaces the complete entry config;
//   preserve other providers and fields when editing an existing override」——
//   也就是说这份 YAML 里的 providers 字典是整体替换的，我们要么完整保留用户
//   已有的 provider，要么就会把它们抹掉。本项目没有 YAML 解析库，
//   手写字符串去合并嵌套 YAML 太容易出错，所以走「自己一个 profile」这条路：
//   文件整份归我们，写入即覆盖，还原就删掉，不可能碰坏用户的配置。
//   用户已有的 web profile 完全不动。
//
// 凭证：dsh 没有明文 apiKey 字段（apiKeyEnv 是「引用」，值从凭证库/环境变量取）。
// 官方对本地服务给的办法是把凭证放在 headers 里的 Authorization，
// 和我们给 Codex 写 http_headers 是同一个思路。
//
// 参考：deepseek-harness docs/user/guide/providers.md 与 packages/llm/llm-pi-ai/README.md

/** 我们自己的 profile 名，同时也是 provider id（必须小写） */
const DSH_PROFILE = 'kiro'
const DSH_PROVIDER = 'kiro-manager-lite'

/** 文件归属标记：还原时据此确认这份文件确实是我们写的 */
const DSH_MARKER = '# 由 Kiro Manager Lite 写入'

function dshHome(): string {
  return process.env.DSH_HOME?.trim() || path.join(home(), '.dsh')
}

function dshProfilePath(profile: string): string {
  return path.join(dshHome(), 'profiles', profile, 'cordis.patch.yml')
}

/** dsh 是否装过（有 $DSH_HOME 就说明跑过一次） */
function dshInstalled(): boolean {
  return existsSync(dshHome())
}

/**
 * 桌面版用的 profile 名。
 *
 * 这不是猜的：桌面版主进程的启动参数里第二个位置参数就是 profile 目录，
 * 实测是 `~/.dsh/profiles/desktop`（ps 里能直接看到）。
 * 它和命令行版完全不共享配置：只写 CLI 的 profile 的话，desktop 那份还是空的 `[]`，
 * 桌面版会报 `llm-deepseek: no API key for provider route "deepseek-official"`。
 */
const DSH_DESKTOP_PROFILE = 'desktop'

/** 桌面版是否装过（目录由它首次启动时创建） */
function dshDesktopReady(): boolean {
  return existsSync(path.join(dshHome(), 'profiles', DSH_DESKTOP_PROFILE))
}

/** YAML 标量：带空格或特殊字符的值一律加引号，省得踩到 YAML 的隐式类型 */
function yamlString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/**
 * dsh 认的推理档位键，是一个**闭集**（schemastery 的字典键枚举）。
 *
 * 踩过的坑：Kiro 的 gpt-5.6 系列档位里有 none，不在这个集合里。直接写进去
 * 整个 llm-pi-ai 插件会校验失败：
 *   ValidationError: $.providers.x.models[4].reasoningEfforts expected
 *   false | { [key: "off" | "minimal" | ... ] } but got {"none":"none",...}
 * 后果不是「少一个档位」，而是该 entry 整个不激活 → 一个路由都不注册 →
 * 模型选择器里我们的模型全部消失，设置页也只剩内置的 deepseek-official。
 * 这种失败只在 dsh 的启动日志里，界面上什么都看不到，非常难查。
 */
const DSH_EFFORT_KEYS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/**
 * 上游档位名 → dsh 的键。
 * 键是选择器里显示的档位名，值是发到线上的拼写，所以 none 可以挂在 minimal 这个槽上，
 * 用户选 minimal，我们照旧把 none 发给上游。
 */
const DSH_EFFORT_KEY_ALIASES: Record<string, string> = { none: 'minimal' }

/**
 * 把上游档位列表映射成 dsh 能接受的 (键, 线上拼写) 对。
 * 映射不到闭集里的一律丢掉——宁可少一个档位，也不能让整个插件不激活。
 * off 由调用方固定输出，这里预占掉避免 YAML 出现重复键。
 */
function dshEfforts(options: string[] | undefined): { key: string; wire: string }[] {
  const used = new Set(['off'])
  const out: { key: string; wire: string }[] = []
  for (const option of options ?? []) {
    const key = DSH_EFFORT_KEY_ALIASES[option] ?? option
    if (!DSH_EFFORT_KEYS.includes(key) || used.has(key)) continue
    used.add(key)
    out.push({ key, wire: option })
  }
  return out
}

/**
 * patch 文件里归我们维护的行 id，其余行一律原样保留。
 *
 * dsh 自己也往这个文件写：界面上改任何设置都会由 config-editor 追加 / 更新一行
 * （实测已经出现过 ui-settings-general 的 welcomeNoticeVersion）。
 * 所以不能整份覆盖，否则每次重新写入都会把用户在 dsh 里的设置清掉。
 */
const DSH_OWNED_IDS = ['agent-default-model', 'llm-pi-ai']

/**
 * 把 patch 文件拆成顶层行。
 *
 * 这个文件是扁平的 YAML 序列，顶层每一行都以行首的 `- ` 开头（缩进的都是子字段），
 * 所以按行首切分就够，不用引入 YAML 解析器（本项目依赖里没有）。
 * 文件开头的注释块和 `[]`（空序列的 flow 写法）都丢掉——头部我们自己重写。
 */
function foreignDshRows(content: string): string[] {
  const rows: string[] = []
  let current: string[] | null = null
  for (const line of content.split(/\r?\n/)) {
    if (/^- /.test(line)) {
      if (current) rows.push(current.join('\n'))
      current = [line]
    } else if (current) {
      current.push(line)
    }
  }
  if (current) rows.push(current.join('\n'))

  return rows
    .map((row) => row.replace(/\s+$/, ''))
    .filter((row) => {
      const id = dshRowId(row)
      // 认不出 id 的行也保留：宁可留一行看不懂的，也不要删掉用户的东西
      return id === null || !DSH_OWNED_IDS.includes(id)
    })
}

/** 取一行 patch 的 id，`- id: x` 和后续缩进行里的 `id: x` 都认 */
function dshRowId(row: string): string | null {
  for (const line of row.split('\n')) {
    const match = /^(?:-\s+)?\s*id:\s*["']?([\w.-]+)/.exec(line)
    if (match) return match[1]
  }
  return null
}

function buildDshConfig(info: ProxyTargetInfo, profile: string, existing?: string | null): string {
  const models = (info.models.length ? info.models : [{ modelId: info.model }])
    .filter((m) => m.modelId !== 'auto')

  const modelLines = models.flatMap((m) => {
    const lines = [
      `          - id: ${yamlString(m.modelId)}`,
      `            name: ${yamlString(kiroLabel(m))}`,
      /*
       * 逐个模型声明，否则全都套用 provider 级的 defaultContextWindow / defaultMaxTokens。
       * maxTokens 在 dsh 里有个副作用（官方字段注释写明）：显式配了它，
       * 它同时就成为该模型的每请求默认输出上限。这正是我们想要的——
       * 值直接来自上游 tokenLimits.maxOutputTokens，就是这个模型的真实能力。
       */
      `            contextWindow: ${modelInputTokens(m)}`,
      `            maxTokens: ${modelOutputTokens(m)}`
    ]
    /*
     * 手写的模型默认不声明档位，Effort 菜单就不出现。
     * off 留空表示「不发这个字段」（官方示例就是这个写法），对我们的反代就是用上游默认。
     */
    const efforts = dshEfforts('effort' in m ? m.effort?.options : undefined)
    if (efforts.length) {
      lines.push('            reasoningEfforts:')
      lines.push('              off:')
      for (const { key, wire } of efforts) {
        lines.push(`              ${key}: ${wire}`)
      }
    }
    return lines
  })

  /*
   * 默认模型指到我们的路由。
   * 不指的话 dsh 仍然用 bundle 层给的 deepseek-official，一发消息就是
   * MISSING_CREDENTIAL（桌面版首次接入最容易踩的就是这个），
   * 用户得自己在模型选择器里翻到 Kiro 那一组才行。
   *
   * agent-default-model 的 config 是 volatile 的：用户在界面上换模型时
   * dsh 会把这一行改掉，属于正常覆盖，不用我们维护。
   */
  const fallbackModel = models[0]
  const defaultModel = models.find((m) => m.modelId === info.model) ?? fallbackModel
  const defaultId = defaultModel ? defaultModel.modelId : info.model
  /*
   * 档位必须是这个模型真的声明过的**键**（不是上游拼写），否则选择器里对不上。
   * 走同一套映射：界面上选了 none 时，写进去的是 minimal。
   */
  const defaultEfforts = dshEfforts(
    defaultModel && 'effort' in defaultModel ? defaultModel.effort?.options : undefined
  )
  const defaultEffort = defaultEfforts.find((e) => e.wire === info.effort)?.key

  return [
    `${DSH_MARKER}，在「本地反代」页面点「还原」即可撤销`,
    profile === DSH_DESKTOP_PROFILE
      ? '# 这是 DeepSeek Harness 桌面版读的 profile，改动会被它热重载，一般不用重启'
      : `# 启动：dsh web --profile ${profile}`,
    '- id: agent-default-model',
    '  config:',
    `    provider: ${yamlString(DSH_PROVIDER)}`,
    `    model: ${yamlString(defaultId)}`,
    ...(defaultEffort ? [`    reasoningEffort: ${yamlString(defaultEffort)}`] : []),
    '- id: llm-pi-ai',
    '  config:',
    '    providers:',
    `      ${DSH_PROVIDER}:`,
    '        displayName: "Kiro Manager Lite"',
    // 反代提供的是 /v1/chat/completions
    '        api: openai-completions',
    `        baseURL: ${yamlString(`${info.baseUrl}/v1`)}`,
    /*
     * 凭证走 headers：dsh 的 apiKeyEnv 只是个引用，值要从凭证库或环境变量里取，
     * 我们没法替用户写进那两处；官方对本地服务给的就是 Authorization 这条路。
     */
    '        headers:',
    `          Authorization: ${yamlString(`Bearer ${info.apiKey}`)}`,
    /*
     * 两个必须纠正的请求形状（官方 troubleshooting 里点名的两条）：
     *  - 声明了推理的模型，系统提示会以 role: "developer" 发出，很多网关不认；
     *  - 输出上限默认发 max_completion_tokens，只认 max_tokens 的服务端会拒。
     */
    '        compat:',
    '          supportsDeveloperRole: false',
    '          maxTokensField: max_tokens',
    // 只是兜底：上面每个模型都带了自己的 contextWindow / maxTokens，会盖掉这两个
    `        defaultContextWindow: ${FALLBACK_INPUT_TOKENS}`,
    `        defaultMaxTokens: ${FALLBACK_OUTPUT_TOKENS}`,
    '        models:',
    ...modelLines,
    // dsh 自己写进来的行原样接在后面，不能整份覆盖掉用户在它界面里改的设置
    ...foreignDshRows(existing ?? ''),
    ''
  ].join('\n')
}

async function applyDeepseek(info: ProxyTargetInfo): Promise<void> {
  // 安装检测统一在 applyProxyClient 里做（见 detectInstall）
  // 我们自己的 profile，llm-pi-ai 与默认模型两行归我们，其余行保留
  await writeDshProfile(info, DSH_PROFILE)

  /*
   * 默认 profile（web）：`dsh web` 不带 --profile 时读的就是它，用户基本都这么启。
   * 但它可能有用户自己配的 provider，而 providers 是整体替换语义，
   * 没有 YAML 解析器我们没法安全合并，所以只在它不存在、或本来就是我们写的时候才动。
   */
  const webPath = dshProfilePath('web')
  const existing = await readTextIfExists(webPath)
  if (existing === null || existing.includes(DSH_MARKER)) {
    await writeDshProfile(info, 'web')
  }
}

/** 读旧内容 → 重建我们那两行 → 写回，保留 dsh 自己追加的行 */
async function writeDshProfile(info: ProxyTargetInfo, profile: string): Promise<void> {
  const file = dshProfilePath(profile)
  const existing = await readTextIfExists(file)
  await writeFileAtomic(file, buildDshConfig(info, profile, existing))
}

/**
 * 桌面版：写它自己那份 profile patch。
 *
 * 和 Codex 桌面版不同，这里**不用先退出应用**：
 *  - dsh-hmr 用 chokidar 盯着 profile.patchPath（带 awaitWriteFinish），
 *    文件一落地就热重载，provider 立刻出现在模型选择器里；
 *  - 它自己的「设置 → 模型」页写回这个文件时走的是 yaml 的 parseDocument +
 *    setIn，只替换对应 id 那一行的 config，不会整份覆盖，所以我们的注释和
 *    另一行 patch 都留得住（对比 Codex 桌面版是整份当状态存档回写，必须先杀）。
 */
async function applyDeepseekApp(info: ProxyTargetInfo): Promise<void> {
  // 「装了没」「启动过没」两道检测统一在 applyProxyClient 里做（见 detectInstall）
  await writeDshProfile(info, DSH_DESKTOP_PROFILE)
}

async function dshProfileApplied(profile: string, info: ProxyTargetInfo): Promise<boolean> {
  const content = (await readTextIfExists(dshProfilePath(profile))) ?? ''
  return content.includes(DSH_MARKER) && content.includes(info.baseUrl)
}

const deepseekApplied = (info: ProxyTargetInfo): Promise<boolean> =>
  dshProfileApplied(DSH_PROFILE, info)

const deepseekAppApplied = (info: ProxyTargetInfo): Promise<boolean> =>
  dshProfileApplied(DSH_DESKTOP_PROFILE, info)

/** 桌面版进程名就是 app 名，带空格 */
async function deepseekAppRunning(): Promise<boolean> {
  if (process.platform !== 'darwin') return false
  try {
    await run('pgrep', ['-x', 'DeepSeek Harness'], 5_000)
    return true
  } catch {
    return false
  }
}

/**
 * 重启 / 打开桌面版。
 * 热重载已经能让配置生效，这里主要是给「还没开」的情况，以及热重载没赶上时的兜底。
 */
async function restartDeepseekApp(): Promise<void> {
  if (process.platform !== 'darwin') {
    throw new Error('代为重启目前只支持 macOS，请手动退出后重新打开 DeepSeek Harness')
  }
  const app = await requireApp('deepseekApp')
  if (await deepseekAppRunning()) {
    await run('osascript', ['-e', 'tell application "DeepSeek Harness" to quit']).catch(
      () => undefined
    )
    for (let i = 0; i < 24; i++) {
      if (!(await deepseekAppRunning())) break
      await new Promise((r) => setTimeout(r, 500))
    }
    if (await deepseekAppRunning()) {
      throw new Error('DeepSeek Harness 没能自动退出，请手动退出后再打开')
    }
  }
  await run('open', [app])
  log('info', '[Proxy] 已重启 DeepSeek Harness 桌面版')
}

/** 启动命令：写过默认 profile 就不用带 --profile */
async function dshCommand(): Promise<string> {
  const web = (await readTextIfExists(dshProfilePath('web'))) ?? ''
  const dsh = cliInvoke('deepseek', 'dsh')
  return web.includes(DSH_MARKER) ? `${dsh} web` : `${dsh} web --profile ${DSH_PROFILE}`
}

// ============ Claude 桌面版（3P 模式） ============
//
// Claude 桌面版有一个「企业网关」模式（官方文档叫 third-party inference / 3P）：
// 打开后所有推理都走自定义端点，不再发给 api.anthropic.com。
// 官方支持的下发方式是 MDM 描述文件，但它同样会读本地的 bootstrap 配置目录，
// 我们写的就是后者——三个文件：
//
//   Claude-3p/claude_desktop_config.json          {"deploymentMode":"3p"}  打开这个模式
//   Claude-3p/configLibrary/<uuid>.json           网关地址、Key、模型列表
//   Claude-3p/configLibrary/_meta.json            指向当前生效的那份配置
//
// 网关必须实现 Anthropic Messages API（POST /v1/messages 流式 + 工具调用），
// 我们的反代本来就实现了，所以这条路不需要额外转换。
//
// 关于模型：桌面版会拿 GET /v1/models 自动发现，但**只显示 ID 看起来像 Claude 的**，
// 我们账号里的 gpt-* 系列会被它过滤掉。所以这里显式写 inferenceModels，
// 既能带上全部模型，也省掉一次发现请求。
//
// 每个条目能配的就 7 个字段（app.asar 里的条目 schema）：
//   name / labelOverride / supports1m / prefer1m / anthropicFamilyTier /
//   isFamilyDefault / maxEffort
// 也就是说：
//  - 档位**可以**配（maxEffort 封顶 + 顶层 defaultModelEffort 定起始档）；
//  - 上下文**不能**按数值配，只有 supports1m 这个 1M 开关，
//    所以 164K / 196K / 256K 那几个模型没法告诉它真实窗口大小；
//  - 输出上限（max output tokens）**没有任何字段**，整个 3P 配置面里都没有。
//    inferenceMaxTokensPerWindow 不是这个东西，那是按时间窗计的用量软上限。
//
// 参考：claude.com/docs/third-party/claude-desktop/gateway

/**
 * 桌面应用写模型列表时共用：跳过 auto（那是上游的路由档，不是一个真实模型），
 * 界面里设的默认模型排第一个——这几个客户端的选择器都按写入顺序列。
 * 还没刷新过模型列表时，至少把默认模型写进去。
 */
function orderedModels(info: ProxyTargetInfo): KiroModelInfo[] {
  const list = (info.models.length ? info.models : [{ modelId: info.model }]).filter(
    (m) => m.modelId !== 'auto'
  )
  return [
    ...list.filter((m) => m.modelId === info.model),
    ...list.filter((m) => m.modelId !== info.model)
  ]
}

/**
 * 各客户端模型选择器里的展示名，统一带 Kiro 前缀：客户端自带同名的官方模型（Claude、GPT），
 * 不加前缀分不清哪个走反代。上游名字本身已经以 Kiro 开头（如 Kiro Auto）时不重复加。
 */
function kiroLabel(m: { modelId: string; modelName?: string }): string {
  const name = (m.modelName || kiroDisplayName(m.modelId)).trim()
  return /^kiro\b/i.test(name) ? name : `Kiro ${name}`
}

/** 没拉到输入类型（旧缓存）时按支持图片算：Kiro 的对话模型现在都收图 */
function modelTakesImages(m: KiroModelInfo): boolean {
  return m.inputTypes ? m.inputTypes.includes('IMAGE') : true
}

// ============ WorkBuddy（腾讯） ============
//
// WorkBuddy 是 CodeBuddy 同一套内核的办公版，自定义模型读 ~/.workbuddy/models.json
// （CodeBuddy 读 ~/.codebuddy/models.json，同一份格式）。以下规则读自 WorkBuddy 5.6
// 的 app.asar（WorkbuddyCustomModelsProductProvider 与 isValidLocalCustomModel）：
//
//  - 文件两种形态都认：顶层数组，或 { models: [...], availableModels?: [...] }。
//    availableModels 一旦存在就是白名单，不在里面的模型会被滤掉——
//    所以用户写了它的话，我们的 id 也要加进去，否则写了等于没写。
//  - 条目字段：id（必填，就是请求里的 model）/ name / vendor / url / apiKey /
//    maxInputTokens / maxOutputTokens / supportsToolCall / supportsImages /
//    supportsReasoning / onlyReasoning / reasoning{ defaultEffort, supportedEfforts,
//    canDisableThinking }。类型不对的整条会被丢弃，所以数值一律写 number、开关写 boolean。
//  - url：useCustomProtocol 为 false（默认）时会规整成「以 /chat/completions 结尾」，
//    走的是 OpenAI Chat Completions。我们直接写完整路径，不靠它补。
//  - apiKey 可以是明文。它自己的设置页在加密策略打开时会把 apiKey 改写成 WBEV1 开头的密文，
//    读的时候再解开；我们写明文它照样认。
//  - 它用 fs.watch 盯着这个文件，改完约 1 秒自动重新加载，一般不用重启。
//
// 这个文件用户也会在「设置 → 模型 → 自定义模型」里改，所以只增删我们名下的条目
// （vendor 为 WORKBUDDY_VENDOR 的那些），别的条目和字段原样保留。

/** 我们那批条目的 vendor，也是还原时认领的依据；选择器里会作为厂商名显示 */
const WORKBUDDY_VENDOR = 'Kiro Manager Lite'

const WORKBUDDY_APP_NAME = 'WorkBuddy.app'
const WORKBUDDY_BUNDLE_ID = 'com.tencent.workbuddy.mac'

function workbuddyModelsPath(): string {
  // 和它自己的查找顺序一致：WORKBUDDY_CONFIG_DIR 优先
  const dir = process.env.WORKBUDDY_CONFIG_DIR?.trim()
  return path.join(dir || path.join(home(), '.workbuddy'), 'models.json')
}

interface WorkbuddyDoc {
  /** 原文是顶层数组还是对象包裹，写回时保持原样 */
  shape: 'array' | 'object'
  root: Record<string, unknown>
  models: Record<string, unknown>[]
}

/**
 * 读 models.json。空文件（它首次启动会建一个 0 字节的）当成空列表；
 * 解析失败时报错，绝不能当成空列表把用户配的模型覆盖掉。
 */
async function readWorkbuddyDoc(): Promise<WorkbuddyDoc> {
  const file = workbuddyModelsPath()
  const text = await readTextIfExists(file)
  if (!text || !text.trim()) return { shape: 'object', root: {}, models: [] }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`${file} 不是标准 JSON，为了不覆盖你的自定义模型已停止写入，请先检查这个文件`)
  }
  if (Array.isArray(parsed)) {
    return { shape: 'array', root: {}, models: parsed.filter((m) => m && typeof m === 'object') }
  }
  if (parsed && typeof parsed === 'object') {
    const root = parsed as Record<string, unknown>
    const models = Array.isArray(root.models)
      ? (root.models.filter((m) => m && typeof m === 'object') as Record<string, unknown>[])
      : []
    return { shape: 'object', root, models }
  }
  throw new Error(`${file} 的格式不认识（应为数组或 { models: [...] }）`)
}

async function writeWorkbuddyDoc(doc: WorkbuddyDoc): Promise<void> {
  const content = doc.shape === 'array' ? doc.models : { ...doc.root, models: doc.models }
  await writeFileAtomic(workbuddyModelsPath(), `${JSON.stringify(content, null, 2)}\n`)
}

const isWorkbuddyOurs = (m: Record<string, unknown>): boolean => m.vendor === WORKBUDDY_VENDOR

function workbuddyModels(info: ProxyTargetInfo): Record<string, unknown>[] {
  return orderedModels(info).map((m) => {
    const efforts = m.effort?.options ?? []
    return {
      id: m.modelId,
      // 加前缀：WorkBuddy 自带同名的 Claude 模型，选择器里得分得清是哪一个
      name: kiroLabel(m),
      vendor: WORKBUDDY_VENDOR,
      url: `${info.baseUrl}/v1/chat/completions`,
      apiKey: info.apiKey,
      maxInputTokens: modelInputTokens(m),
      maxOutputTokens: modelOutputTokens(m),
      supportsToolCall: true,
      supportsImages: modelTakesImages(m),
      supportsReasoning: efforts.length > 0,
      ...(efforts.length
        ? {
            // Kiro 的推理模型都能不带档位直接调，所以允许关思考
            onlyReasoning: false,
            reasoning: {
              defaultEffort: m.effort?.default && efforts.includes(m.effort.default)
                ? m.effort.default
                : efforts[Math.floor(efforts.length / 2)],
              supportedEfforts: efforts,
              canDisableThinking: true
            }
          }
        : {})
    }
  })
}

async function applyWorkbuddy(info: ProxyTargetInfo): Promise<void> {
  const doc = await readWorkbuddyDoc()
  const ours = workbuddyModels(info)
  const oursIds = new Set(ours.map((m) => m.id as string))
  /*
   * 别人的条目原样留着，只把我们的整批换新。
   * 用户自己加过同 id 的条目（比如也叫 claude-sonnet-4.5）也保留：
   * 它会和我们的在选择器里各占一行，名字前缀能分清。
   */
  doc.models = [...doc.models.filter((m) => !isWorkbuddyOurs(m)), ...ours]
  // 有白名单就把我们的 id 补进去，原因见本段开头
  if (doc.shape === 'object' && Array.isArray(doc.root.availableModels)) {
    const list = doc.root.availableModels.filter((id): id is string => typeof id === 'string')
    doc.root.availableModels = [...list, ...[...oursIds].filter((id) => !list.includes(id))]
  }
  await writeWorkbuddyDoc(doc)
}

/**
 * 还原：只摘掉我们那批条目，白名单里也只摘我们加的 id。
 * 文件原本不存在（或是它建的空文件）、摘完又空了，就恢复成原来的样子。
 */
async function restoreWorkbuddy(backup: ProxyClientBackupFile): Promise<void> {
  const doc = await readWorkbuddyDoc().catch(() => null)
  if (!doc) return
  const oursIds = new Set(doc.models.filter(isWorkbuddyOurs).map((m) => String(m.id)))
  doc.models = doc.models.filter((m) => !isWorkbuddyOurs(m))
  if (doc.shape === 'object' && Array.isArray(doc.root.availableModels)) {
    // 用户原本就列过的 id 不能摘：以写入前的快照为准
    const before = new Set<string>()
    try {
      const old = JSON.parse(backup.content) as Record<string, unknown>
      if (Array.isArray(old?.availableModels)) old.availableModels.forEach((id) => before.add(String(id)))
    } catch {
      // 快照不是 JSON（空文件）就说明原来没有白名单
    }
    doc.root.availableModels = doc.root.availableModels.filter(
      (id) => !oursIds.has(String(id)) || before.has(String(id))
    )
  }
  const untouched = !doc.models.length && Object.keys(doc.root).every((k) => k === 'models')
  if (untouched && !backup.content.trim()) {
    if (backup.existed) await writeFileAtomic(workbuddyModelsPath(), backup.content)
    else await fs.unlink(workbuddyModelsPath()).catch(() => undefined)
    return
  }
  await writeWorkbuddyDoc(doc)
}

async function workbuddyApplied(info: ProxyTargetInfo): Promise<boolean> {
  const doc = await readWorkbuddyDoc().catch(() => null)
  const ours = doc?.models.filter(isWorkbuddyOurs) ?? []
  // 地址和 Key 都对得上才算接入；Key 被它加密成 WBEV1 密文后没法比对，只看地址
  return (
    ours.length > 0 &&
    ours.every((m) => String(m.url ?? '').startsWith(info.baseUrl)) &&
    ours.some((m) => m.apiKey === info.apiKey || String(m.apiKey ?? '').startsWith('WBEV1'))
  )
}

/**
 * 进程探测：WorkBuddy 的可执行文件名就叫 Electron（没改名），pgrep -x 认不出，
 * 只能按 .app 里的路径匹配。
 */
async function workbuddyRunning(): Promise<boolean> {
  if (process.platform !== 'darwin') return false
  try {
    await run('pgrep', ['-f', `${WORKBUDDY_APP_NAME}/Contents/MacOS/`], 5_000)
    return true
  } catch {
    return false
  }
}

/**
 * 重启 / 打开一个按 bundle id 定位的桌面应用。
 * 用 AppleScript 正常退出，让它自己收尾（保存会话、落库），不直接杀进程。
 */
async function restartMacApp(
  label: string,
  target: ProxyClientTarget,
  bundleId: string,
  running: () => Promise<boolean>
): Promise<void> {
  if (process.platform !== 'darwin') {
    throw new Error(`代为重启目前只支持 macOS，请手动退出 ${label} 后重新打开`)
  }
  const app = await requireApp(target)
  if (await running()) {
    await run('osascript', ['-e', `tell application id "${bundleId}" to quit`]).catch(() => undefined)
    for (let i = 0; i < 24; i++) {
      if (!(await running())) break
      await new Promise((r) => setTimeout(r, 500))
    }
    if (await running()) throw new Error(`${label} 没能自动退出，请手动退出后再打开`)
  }
  await run('open', [app])
  log('info', `[Proxy] 已重启 ${label}`)
}

// ============ VS Code（Copilot 的自定义端点） ============
//
// VS Code 1.13x 自带的 Copilot 扩展有一个 vendor = "customendpoint" 的模型提供方，
// 配置写在用户目录的 chatLanguageModels.json：一个数组，每项是一组模型（provider group）。
// 以下规则全部读自 VS Code 自带的 copilot 扩展（dist/extension.js 与 package.json）：
//
//  - url：写到具体路径（/chat/completions、/responses、/v1/messages）就原样用；
//    只写 host 时会补成 host/v1/chat/completions。我们写完整路径，不靠它猜。
//  - apiKey 是 secret 字段，只认 ${input:chat.lm.secret.xxx} 这种引用，真值在 VS Code
//    加密的 SecretStorage（钥匙串）里。**直接写明文不生效**：它会把明文当引用名去查，
//    查不到就当没填。那个存储是 Electron safeStorage 加密的，我们从外面写不进去。
//  - 绕开的办法：模型级的 requestHeaders。customendpoint 专门把 Authorization 从保留头里
//    放开了（_overridableReservedAuthHeaders），设了它就不再加自己的鉴权头
//    （_hasUserAuthHeader）。所以 Key 放进每个模型的 requestHeaders.Authorization，
//    分组上不写 apiKey，整份配置就能全自动写好，用户什么都不用填。
//  - 上下文 / 输出 / 视觉 / 工具 / 推理档位都能按模型配，值全部来自账号拉回的模型列表。
//
// 这个文件 VS Code 自己也会写（用户在「管理语言模型」里加分组时），所以：
// 只增删我们名下的那一组，别的组原样保留；还原也只摘掉我们那一组，不整份覆盖。

/** 我们那一组的名字，也是还原时认领的依据 */
const VSCODE_GROUP = 'Kiro Manager Lite'

function vscodeUserDir(): string {
  if (process.platform === 'darwin') {
    return path.join(home(), 'Library', 'Application Support', 'Code', 'User')
  }
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(home(), 'AppData', 'Roaming'), 'Code', 'User')
  }
  return path.join(home(), '.config', 'Code', 'User')
}

function vscodeModelsPath(): string {
  return path.join(vscodeUserDir(), 'chatLanguageModels.json')
}

/**
 * chatLanguageModels.json 读成数组。
 * VS Code 写的是标准 JSON（带制表符缩进），但用户可能手改加了注释或尾逗号——
 * 那种情况解析失败时报错，绝不能当成空数组把用户的配置覆盖掉。
 */
async function readVscodeGroups(): Promise<Record<string, unknown>[]> {
  const text = await readTextIfExists(vscodeModelsPath())
  if (!text || !text.trim()) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(
      `${vscodeModelsPath()} 不是标准 JSON（可能手动加了注释或尾逗号），为了不覆盖你的配置已停止写入，请先检查这个文件`
    )
  }
  if (!Array.isArray(parsed)) throw new Error(`${vscodeModelsPath()} 应该是一个数组`)
  return parsed.filter((item) => item && typeof item === 'object') as Record<string, unknown>[]
}

async function writeVscodeGroups(groups: Record<string, unknown>[]): Promise<void> {
  // 和 VS Code 自己写出来的格式保持一致（制表符缩进），用户打开对比时不会一整份都是 diff
  await writeFileAtomic(vscodeModelsPath(), `${JSON.stringify(groups, null, '\t')}\n`)
}

/** 我们那一组的模型条目：字段名与取值范围照 customendpoint 的 JSON Schema */
function vscodeModels(info: ProxyTargetInfo): Record<string, unknown>[] {
  const list = (info.models.length ? info.models : [{ modelId: info.model }]).filter(
    (m) => m.modelId !== 'auto'
  )
  // 界面里设的默认模型放第一个：VS Code 选择器里同组按配置顺序列
  const ordered = [
    ...list.filter((m) => m.modelId === info.model),
    ...list.filter((m) => m.modelId !== info.model)
  ]
  return ordered.map((m) => {
    const efforts = 'effort' in m ? (m.effort?.options ?? []) : []
    const inputTypes = 'inputTypes' in m ? m.inputTypes : undefined
    return {
      id: m.modelId,
      name: kiroLabel(m),
      url: `${info.baseUrl}/v1/chat/completions`,
      // 固定走 Chat Completions：反代这条路最成熟，Cursor、Cherry Studio 等都在用
      apiType: 'chat-completions',
      toolCalling: true,
      // 没拉到输入类型（旧缓存）时按支持图片算：Kiro 的对话模型现在都收图
      vision: inputTypes ? inputTypes.includes('IMAGE') : true,
      maxInputTokens: modelInputTokens(m),
      maxOutputTokens: modelOutputTokens(m),
      ...(efforts.length
        ? {
            thinking: true,
            // 选择器里出现 Thinking Effort，选中的值以顶层 reasoning_effort 发给反代，
            // 反代再按该模型的 schema 就近取值（none、xhigh 这些不认的档位不会 400）
            supportsReasoningEffort: efforts,
            reasoningEffortFormat: 'chat-completions'
          }
        : {}),
      // Key 放这里而不是分组的 apiKey，原因见本段开头
      requestHeaders: { Authorization: `Bearer ${info.apiKey}` }
    }
  })
}

async function applyVscode(info: ProxyTargetInfo): Promise<void> {
  const groups = await readVscodeGroups()
  const ours = {
    name: VSCODE_GROUP,
    vendor: 'customendpoint',
    apiType: 'chat-completions',
    models: vscodeModels(info)
  }
  const index = groups.findIndex((g) => g.name === VSCODE_GROUP && g.vendor === 'customendpoint')
  if (index >= 0) groups[index] = ours
  else groups.push(ours)
  await writeVscodeGroups(groups)
}

/** 还原：只摘掉我们那一组。VS Code 自己也会改这个文件，整份覆盖会丢掉用户后来加的分组 */
async function restoreVscode(existedBefore: boolean): Promise<void> {
  const groups = await readVscodeGroups().catch(() => null)
  if (!groups) return
  const rest = groups.filter((g) => !(g.name === VSCODE_GROUP && g.vendor === 'customendpoint'))
  // 原本就没有这个文件、摘完又空了：删掉，不留一个 [] 的空壳
  if (!rest.length && !existedBefore) {
    await fs.unlink(vscodeModelsPath()).catch(() => undefined)
    return
  }
  await writeVscodeGroups(rest)
}

async function vscodeApplied(info: ProxyTargetInfo): Promise<boolean> {
  const groups = await readVscodeGroups().catch(() => [])
  const ours = groups.find((g) => g.name === VSCODE_GROUP && g.vendor === 'customendpoint')
  const models = Array.isArray(ours?.models) ? (ours.models as Record<string, unknown>[]) : []
  // 地址和 Key 都对得上才算接入：换过端口或重新生成过 Key，都要提示重新写入
  return (
    models.length > 0 &&
    models.every((m) => String(m.url ?? '').startsWith(info.baseUrl)) &&
    models.some(
      (m) =>
        (m.requestHeaders as Record<string, unknown> | undefined)?.Authorization ===
        `Bearer ${info.apiKey}`
    )
  )
}

const VSCODE_BUNDLE_ID = 'com.microsoft.VSCode'

async function vscodeRunning(): Promise<boolean> {
  if (process.platform !== 'darwin') return false
  try {
    // 主进程名就叫 Code（Electron 的可执行文件名），不是 Visual Studio Code
    await run('pgrep', ['-x', 'Code'], 5_000)
    return true
  } catch {
    return false
  }
}

/**
 * 重启 / 打开 VS Code。
 * chatLanguageModels.json 改了它一般会自己重新加载；这里给「没出现 / 还是旧的」时兜底。
 * 用 AppleScript 正常退出：有未保存的文件时它会自己弹窗确认，不会丢东西。
 */
async function restartVscode(): Promise<void> {
  if (process.platform !== 'darwin') {
    throw new Error('代为重启目前只支持 macOS，请手动退出 VS Code 后重新打开')
  }
  const app = await requireApp('vscode')
  if (await vscodeRunning()) {
    await run('osascript', ['-e', `tell application id "${VSCODE_BUNDLE_ID}" to quit`]).catch(() => undefined)
    for (let i = 0; i < 24; i++) {
      if (!(await vscodeRunning())) break
      await new Promise((r) => setTimeout(r, 500))
    }
    if (await vscodeRunning()) {
      throw new Error('VS Code 没能自动退出（可能有未保存的文件在等你确认），请手动退出后再打开')
    }
  }
  await run('open', [app])
  log('info', '[Proxy] 已重启 VS Code')
}

/** 3P 配置目录；和主程序的 Application Support/Claude 是两个目录，不要混 */
function claude3pDir(): string {
  if (process.platform === 'darwin') {
    return path.join(home(), 'Library', 'Application Support', 'Claude-3p')
  }
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA || path.join(home(), 'AppData', 'Local'), 'Claude-3p')
  }
  return path.join(home(), '.config', 'Claude-3p')
}

function claude3pModePath(): string {
  return path.join(claude3pDir(), 'claude_desktop_config.json')
}

/*
 * 配置条目的 UUID 固定成这个值：_meta.json 要靠 id 指向它，
 * 每次写入换一个新 UUID 会在 configLibrary 里堆一堆没人引用的旧文件。
 */
const CLAUDE_3P_CONFIG_ID = '00000000-0000-4000-8000-0000000001ff'

function claude3pConfigPath(): string {
  return path.join(claude3pDir(), 'configLibrary', `${CLAUDE_3P_CONFIG_ID}.json`)
}

function claude3pMetaPath(): string {
  return path.join(claude3pDir(), 'configLibrary', '_meta.json')
}

/**
 * Claude 桌面版认的档位，从低到高。
 *
 * 这是它内部的闭集（app.asar 里 `Go=["low","medium","high","xhigh","max"]`），
 * 没有 Kiro 那边的 none。两处会用到：
 *  - 条目的 maxEffort（该模型最高开放到哪一档）
 *  - 顶层 defaultModelEffort（默认模型的起始档位）
 * 两者的 schema 都是 `.catch("low")`：给了它不认的值不会报错，而是**静默降到 low**，
 * 所以宁可不写也不能瞎写。
 */
const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']

/**
 * 取该模型能开放到的最高档。
 *
 * maxEffort 只能封顶，没法做白名单，所以中间缺档的模型（比如 4.6 有
 * low/medium/high/max 但没有 xhigh）仍会在选择器里露出 xhigh。
 * 这不会出错：反代的 resolveEffort → nearestEffort 会把它钳到「不超过的最强档」，
 * 上游收到的是 high。
 */
function claudeMaxEffort(options: string[] | undefined): string | undefined {
  const ranked = (options ?? [])
    .map((option) => CLAUDE_EFFORTS.indexOf(option))
    .filter((rank) => rank >= 0)
  if (!ranked.length) return undefined
  return CLAUDE_EFFORTS[Math.max(...ranked)]
}

async function applyClaudeApp(info: ProxyTargetInfo): Promise<void> {
  // 1. 打开 3P 模式。这个文件可能已有别的字段（用户配过 MCP 等），只加不覆盖
  const mode = await readJsonObject(claude3pModePath()).catch(() => ({}) as Record<string, unknown>)
  mode.deploymentMode = '3p'
  await writeFileAtomic(claude3pModePath(), `${JSON.stringify(mode, null, 2)}\n`)

  /*
   * 2. 网关配置。auth scheme 用 bearer（默认），和我们反代的鉴权方式一致。
   *    显式给 inferenceModels：自动发现只认 ID 像 Claude 的模型，会漏掉 gpt-* 那些。
   */
  const listed = (info.models.length ? info.models : [{ modelId: info.model }]).filter(
    (m) => m.modelId !== 'auto'
  )
  /*
   * 界面里设的默认模型必须排在第一个：桌面版把 inferenceModels 的首项当默认模型，
   * defaultModelEffort 也只作用在它身上。按账号返回的顺序写，默认模型大概率不在首位。
   */
  const ordered = [
    ...listed.filter((m) => m.modelId === info.model),
    ...listed.filter((m) => m.modelId !== info.model)
  ]

  const models = ordered.map((m, index) => {
    const supports1m = modelInputTokens(m) >= 1_000_000
    const cap = claudeMaxEffort('effort' in m ? m.effort?.options : undefined)
    return {
      name: m.modelId,
      labelOverride: kiroLabel(m),
      /*
       * 桌面版没有「填上下文大小」这种字段（条目 schema 就 7 个字段，没有数值项），
       * 只有 supports1m 这个开关：打开后选择器多出一行 1M 上下文的变体，选它才按 1M 走。
       * 所以只有上游确实给到 1M 的模型才加，多加了会让选择器出现用不了的行。
       */
      ...(supports1m ? { supports1m: true } : {}),
      // prefer1m 只对默认模型（首项）有意义：让选择器默认就落在 1M 那一行
      ...(supports1m && index === 0 ? { prefer1m: true } : {}),
      /*
       * 档位上限。它是「最高档」而不是白名单：高于它的档位在选择器里隐藏、也绝不会被请求。
       * 注意 schema 是 .catch("low") —— 写了个它不认的值会**静默**降到 low，
       * 所以只能给 CLAUDE_EFFORTS 里的值，拿不到就整个省掉（交给它内置目录）。
       */
      ...(cap ? { maxEffort: cap } : {})
    }
  })

  // 默认模型的起始档位。同样必须落在它的枚举内，Kiro 的 none 之类一律省掉
  const defaultEffort = CLAUDE_EFFORTS.includes(info.effort) ? info.effort : undefined

  await writeFileAtomic(
    claude3pConfigPath(),
    `${JSON.stringify(
      {
        inferenceProvider: 'gateway',
        inferenceCredentialKind: 'static',
        inferenceGatewayBaseUrl: info.baseUrl,
        inferenceGatewayApiKey: info.apiKey,
        inferenceGatewayAuthScheme: 'bearer',
        inferenceModels: models.length ? models : [{ name: info.model }],
        ...(defaultEffort ? { defaultModelEffort: defaultEffort } : {})
      },
      null,
      2
    )}\n`
  )

  // 3. 注册表：告诉它当前生效的是哪一份
  await writeFileAtomic(
    claude3pMetaPath(),
    `${JSON.stringify(
      {
        appliedId: CLAUDE_3P_CONFIG_ID,
        entries: [{ id: CLAUDE_3P_CONFIG_ID, name: 'Kiro Manager Lite' }]
      },
      null,
      2
    )}\n`
  )
}

async function claudeAppApplied(info: ProxyTargetInfo): Promise<boolean> {
  const mode = await readJsonObject(claude3pModePath()).catch(() => ({}) as Record<string, unknown>)
  if (mode.deploymentMode !== '3p') return false
  const content = (await readTextIfExists(claude3pConfigPath())) ?? ''
  return content.includes(info.baseUrl)
}

/** Claude 桌面版是否在运行 */
async function claudeAppRunning(): Promise<boolean> {
  if (process.platform !== 'darwin') return false
  try {
    await run('pgrep', ['-x', 'Claude'], 5_000)
    return true
  } catch {
    return false
  }
}

/** 退出并重新打开 Claude 桌面版：3P 配置只在启动时读一次 */
export async function restartClaudeApp(): Promise<void> {
  if (process.platform !== 'darwin') {
    throw new Error('代为重启目前只支持 macOS，请手动完全退出后重新打开 Claude')
  }
  const app = await requireApp('claudeApp')
  if (await claudeAppRunning()) {
    await run('osascript', ['-e', 'tell application "Claude" to quit']).catch(() => undefined)
    for (let i = 0; i < 24; i++) {
      if (!(await claudeAppRunning())) break
      await new Promise((r) => setTimeout(r, 500))
    }
    if (await claudeAppRunning()) {
      throw new Error('Claude 没能自动退出，请手动退出后再打开')
    }
  }
  await run('open', [app])
  log('info', '[Proxy] 已重启 Claude 桌面版')
}

// ============ Cursor (CCursor BYOK) ============

/**
 * CCursor（Cursor++）的配置目录和文件。
 *
 * CCursor 是一个给 Cursor 注入 BYOK hook 的开源工具（github.com/CometixSpace/CCursor），
 * 它通过修改 Cursor 的 workbench 文件来拦截请求，让免费版也能用自定义 provider。
 * 配置放在 ~/.ccursor/providers.json，纯 JSON，格式和 Codex 的 config.toml 一样好改。
 */
function ccursorDir(): string {
  return path.join(home(), '.ccursor')
}

function ccursorProvidersPath(): string {
  return path.join(ccursorDir(), 'providers.json')
}

/**
 * Cursor 的程序根目录（CCursor 叫它 appRoot，product.json 所在的那一层）。
 * macOS 是 .app 里的 Contents/Resources/app，Windows 是 exe 旁边的 resources/app。
 */
function cursorAppRoot(installPath: string): string {
  return process.platform === 'darwin'
    ? path.join(installPath, 'Contents', 'Resources', 'app')
    : path.join(path.dirname(installPath), 'resources', 'app')
}

/** CCursor 注入进 workbench 的标记，出自它自己的 status 检查（HOOK_SOURCE_MARKER） */
const CCURSOR_HOOK_MARKER = '/* CURSOR-BYOK-HOOK-START */'

/**
 * Cursor 本体当前是否打着 CCursor 的补丁。
 *
 * 不能拿 ~/.ccursor/routes.json 判断：那是 CCursor 的配置，Cursor 自动更新会整份替换程序文件、
 * 把补丁冲掉，配置却还在。踩过的坑就是这样：更新后界面照样显示「已指向本反代」，
 * 一键写入也因为「已安装」跳过了重新打补丁，Cursor 里只剩官方模型。
 * 这里按 CCursor 自己 status 命令的口径查：扩展目录在，且 workbench 头部有注入标记。
 * 标记只会出现在文件开头（它只扫前 12 万字符），所以只读这一段，不把 38MB 的文件整个读进来。
 */
async function cursorPatched(installPath: string | null): Promise<boolean> {
  if (!installPath) return false
  const root = cursorAppRoot(installPath)
  if (!existsSync(path.join(root, 'extensions', 'cursor2plus', 'package.json'))) return false
  const workbench = path.join(root, 'out', 'vs', 'workbench', 'workbench.desktop.main.js')
  let handle: fs.FileHandle | null = null
  try {
    handle = await fs.open(workbench, 'r')
    const buffer = Buffer.alloc(120_000)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    return buffer.subarray(0, bytesRead).toString('utf8').includes(CCURSOR_HOOK_MARKER)
  } catch {
    return false
  } finally {
    await handle?.close()
  }
}

async function cursorInstallPath(): Promise<string | null> {
  return (await locateClient('cursor')).path
}

/** 写入过程中的进度回调，用来把安装日志实时显示在界面上 */
export type ProgressFn = (line: string) => void

const findNodeBin = (name: 'node' | 'npx'): string | null => findBinary(name)

/**
 * 跑 CCursor 的安装 / 卸载命令，把输出逐行回调出去。
 *
 * 用 npx 而不是把 CCursor 打进我们的安装包：它是 AGPL-3.0 且解包后 33MB，
 * 随包再分发会把 AGPL 传染到本项目，而且内置的版本很快就会落后于 Cursor 的更新。
 */
function runCcursor(
  action: 'install' | 'uninstall',
  onProgress?: ProgressFn,
  /** Cursor 的 appRoot；装在非默认位置（手动指定）时 CCursor 自己找不到，要显式告诉它 */
  appRoot?: string
): Promise<void> {
  const npx = findNodeBin('npx')
  if (!npx) {
    return Promise.reject(
      new Error(
        '没有找到 Node.js（需要 npx 来安装 CCursor）。请先安装 Node.js 18 以上版本：https://nodejs.org'
      )
    )
  }
  // node 所在目录要进 PATH，否则 npx 拉起的脚本找不到 node
  const nodeDir = path.dirname(findNodeBin('node') ?? npx)

  return new Promise((resolve, reject) => {
    const child = spawn(npx, ['-y', '@cometix/ccursor@latest', action], {
      env: {
        ...process.env,
        PATH: `${nodeDir}${path.delimiter}${process.env.PATH ?? ''}`,
        // 装完不要交互提问
        CI: '1',
        ...(appRoot ? { CCURSOR_CURSOR_ROOT: appRoot } : {})
      },
      windowsHide: true
    })

    const emit = (chunk: Buffer): void => {
      for (const line of chunk.toString().split(/\r?\n/)) {
        const text = line.replace(/\u001b\[[0-9;]*m/g, '').trim() // 去掉颜色转义
        if (text) onProgress?.(text)
      }
    }
    child.stdout?.on('data', emit)
    child.stderr?.on('data', emit)

    // 安装要解包 33MB 并给 Cursor 的大文件打补丁，给足时间
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('CCursor 安装超时（5 分钟），请检查网络后重试'))
    }, 300_000)

    child.on('error', (error) => {
      clearTimeout(timer)
      reject(new Error(`无法启动 npx：${error.message}`))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(`CCursor ${action} 失败（退出码 ${code}），详见上面的日志`))
    })
  })
}

/**
 * Kiro 的模型名转成 CCursor 目录里的写法。
 *
 * CCursor 的内置目录（~/.ccursor/models-catalog.json）里 Claude 系用短横
 * （claude-opus-4-8），Kiro 用点号（claude-opus-4.8）。对齐后面板里能搜到同一个模型。
 * 反代的 mapProxyModel 两种格式都认，所以 apiModel 保持 Kiro 的原始格式。
 */
function kiroIdToCcursorId(kiroId: string): string {
  // claude-sonnet-4.5 → claude-sonnet-4-5（只转 Claude 系的点号）
  return kiroId.replace(
    /^(claude-(?:sonnet|haiku|opus|fable))-(\d+)\.(\d+)/,
    '$1-$2-$3'
  )
}

/**
 * 把我们的模型补进 CCursor 的模型目录。
 *
 * 这份目录只喂 Cursor++ 面板的模型名自动补全，不参与 providers.json 的校验
 * （读的时候只取 limit.context / limit.output / reasoning / tool_call / modalities，
 * 且 limit.context 不是数字的条目会被直接丢掉）。
 * 所以条目必须用 models.dev 那套结构，contextLength/supportsImages 这类字段它不认。
 */
async function ensureCcursorCatalog(models: KiroModelInfo[]): Promise<void> {
  const catalogPath = path.join(ccursorDir(), 'models-catalog.json')
  const raw = await readTextIfExists(catalogPath)
  if (!raw) return
  try {
    const catalog = JSON.parse(raw) as Record<string, { models?: Record<string, unknown> }>
    let changed = false

    for (const m of models) {
      if (m.modelId === 'auto') continue
      const ccId = kiroIdToCcursorId(m.modelId)

      // Claude 系放 anthropic provider，其余放 openai
      const providerKey = m.modelId.startsWith('claude') ? 'anthropic' : 'openai'
      if (!catalog[providerKey]) continue
      if (!catalog[providerKey].models) catalog[providerKey].models = {}
      if (catalog[providerKey].models![ccId]) continue

      catalog[providerKey].models![ccId] = {
        id: ccId,
        name: kiroLabel(m),
        limit: { context: modelInputTokens(m), output: modelOutputTokens(m) },
        reasoning: !!m.effort?.options?.length,
        tool_call: true,
        modalities: { input: ['text', 'image'], output: ['text'] }
      }
      changed = true
    }

    if (changed) {
      await writeFileAtomic(catalogPath, `${JSON.stringify(catalog)}\n`)
    }
  } catch {
    // 目录文件解析失败不影响主流程
  }
}

function buildCcursorProviders(info: ProxyTargetInfo): Record<string, unknown> {
  const models = (info.models.length ? info.models : [{ modelId: info.model }])
    .filter((m) => m.modelId !== 'auto')
    .map((m) => ({
      id: kiroIdToCcursorId(m.modelId),
      apiModel: m.modelId, // 发给反代的真实名字，mapProxyModel 会处理
      // 统一加 Kiro 前缀：Cursor 的模型选择器里混着官方模型，一眼能分出哪些走反代
      displayName: kiroLabel(m),
      thinking: !!(m.effort?.options?.length),
      thinkingLevel: m.effort?.default || 'medium',
      /*
       * 这两个字段 CCursor 都当必填校验（webview 的校验器：缺了报
       * "Context token limit is required" / "Max output tokens is required"）。
       * maxOutputTokens 尤其不能漏：运行时是 `model.maxOutputTokens ?? 8192`，
       * 不写就被压到 8K，长回答会被硬截断。
       * contextTokenLimit 还决定对话框的上下文进度条与自动压缩阈值。
       */
      contextTokenLimit: modelInputTokens(m),
      maxOutputTokens: modelOutputTokens(m),
      defaultOn: true
    }))

  return {
    $schemaVersion: 1,
    providers: [
      {
        id: CCURSOR_PROVIDER_ID,
        name: 'Kiro Manager Lite',
        /*
         * 必须是 openai-chat，不能写成 openai / openai-compatible。
         * CCursor 内部按 type 做 switch 分发（case "anthropic" / "openai-chat" /
         * "openai-responses" / "gemini"），写了它不认识的值就一个分支都匹配不上：
         * 模型列表变成 0 条（日志里 availableModels count:0），
         * 界面上一发消息就报「Cannot read properties of undefined (reading 'name')」
         * —— 因为选中的模型在 provider 里查不到。
         * 我们的反代提供的是 /v1/chat/completions，所以是 openai-chat。
         */
        type: 'openai-chat',
        baseUrl: `${info.baseUrl}/v1`,
        auth: { kind: 'apiKey', value: info.apiKey },
        models
      }
    ]
  }
}

/** Cursor 的用户设置文件 */
function cursorSettingsPath(): string {
  return path.join(
    home(),
    'Library',
    'Application Support',
    'Cursor',
    'User',
    'settings.json'
  )
}

/**
 * 关掉 Cursor 的 HTTP/2。
 *
 * 这一步是必须的，实测踩出来的：CCursor 注入的是 **HTTP/1.1** 白名单路由器，
 * Cursor 默认用 HTTP/2 发请求时那个路由器拦不到，对话请求会直连 Cursor 官方后端，
 * 于是报「An unexpected error occurred on our servers」（带 Request ID，说明是官方返回的）。
 * 表现很容易误判：模型列表能正常显示（走 renderer 的 ConnectRPC dispatcher，已被 hook），
 * 但一发消息就失败，而且 CCursor 的日志里连一条对话请求都看不到。
 */
async function disableCursorHttp2(): Promise<void> {
  const file = cursorSettingsPath()
  const settings = await readJsonObject(file).catch(() => ({}) as Record<string, unknown>)
  if (settings['cursor.general.disableHttp2'] === true) return
  settings['cursor.general.disableHttp2'] = true
  await writeFileAtomic(file, `${JSON.stringify(settings, null, 4)}\n`)
  log('info', '[Proxy] 已为 Cursor 关闭 HTTP/2（CCursor 的路由器只认 HTTP/1.1）')
}

/**
 * 写入 Cursor 配置，一步到位：没装 CCursor 就先装，再写 provider，再关 HTTP/2。
 * 用户只需要点一次「一键写入」，然后按弹窗提示重启 Cursor。
 */
async function applyCursor(info: ProxyTargetInfo, onProgress?: ProgressFn): Promise<void> {
  const installPath = await cursorInstallPath()
  if (!(await cursorPatched(installPath))) {
    onProgress?.('Cursor 上没有 CCursor 补丁（首次使用，或 Cursor 更新后被还原），开始安装…')
    await runCcursor('install', onProgress, installPath ? cursorAppRoot(installPath) : undefined)
    // install 退出码为 0 也不代表补丁真打上了（比如 Cursor 版本太新、锚点没找到），再按实际文件核对一遍
    if (!(await cursorPatched(installPath))) {
      throw new Error('CCursor 安装结束，但 Cursor 上仍检测不到补丁。可能是当前 Cursor 版本还不受支持，详见上面的日志')
    }
    onProgress?.('CCursor 补丁已就绪')
  }
  // 还原时关掉的 BYOK 在这里重新打开；补丁还在就不用重装，几秒完成
  await setCcursorByokMode(1)
  onProgress?.('写入模型目录与 provider 配置…')
  // 先确保目录里有我们的模型，再写 providers
  await ensureCcursorCatalog(info.models)
  await writeFileAtomic(
    ccursorProvidersPath(),
    `${JSON.stringify(buildCcursorProviders(info), null, 2)}\n`
  )
  // 没这一步 CCursor 拦不到对话请求，原因见 disableCursorHttp2
  onProgress?.('关闭 Cursor 的 HTTP/2…')
  await disableCursorHttp2()
  onProgress?.('完成，请完全退出并重新打开 Cursor')
}

/** 我们在 providers.json 里的 provider id，也是还原时认领的依据 */
const CCURSOR_PROVIDER_ID = 'kiro-proxy'

function ccursorRoutesPath(): string {
  return path.join(ccursorDir(), 'routes.json')
}

/**
 * 切换 CCursor 的 BYOK 模式（routes.json 的 byokMode）。
 *
 * 读自 CCursor 扩展源码：0 = 请求直通 Cursor 官方后端，1 = 用 providers.json 里的 provider。
 * 扩展每 2 秒轮询一次这个文件，改完即时生效，不用重启 Cursor。
 * redirect 列表是跟着模式走的（BYOK 下要多拦一批账号类接口），扩展读到空的 redirect 会按模式补默认值，
 * 所以切模式时把它删掉交给扩展重算；照旧留着的话，关掉 BYOK 后它还会继续拦那批接口。
 * 文件不存在（CCursor 没装过）就什么都不做。
 */
async function setCcursorByokMode(mode: 0 | 1): Promise<void> {
  const file = ccursorRoutesPath()
  const routes = await readJsonObject(file).catch(() => null)
  if (!routes || !Object.keys(routes).length) return
  if (routes.byokMode === mode) return
  routes.byokMode = mode
  delete routes.redirect
  await writeFileAtomic(file, `${JSON.stringify(routes, null, 2)}\n`)
  log('info', `[Proxy] CCursor BYOK 模式已${mode ? '开启' : '关闭'}`)
}

async function ccursorByokOn(): Promise<boolean> {
  const routes = await readJsonObject(ccursorRoutesPath()).catch(() => null)
  // 扩展的解析口径：0 / false / "off" 是关，其余都算开
  const mode = routes?.byokMode
  return !!routes && mode !== 0 && mode !== false && mode !== 'off'
}

/**
 * 还原 Cursor：摘掉我们的 provider、关掉 BYOK、回滚 HTTP/2 开关，CCursor 补丁保留。
 *
 * 为什么不卸补丁：卸了下次写入又要联网拉 33MB、给 Cursor 重新打补丁，一两分钟；
 * 关掉 BYOK 后补丁只是把请求原样直通官方后端，Cursor 用起来和没装一样。要彻底卸，
 * 在终端跑 npx @cometix/ccursor uninstall（写入确认里有说明）。
 *
 * 为什么不像别的目标那样整份写回快照：
 *  - providers.json 里可能还有用户自己在 Cursor++ 面板加的 provider；快照也可能早就不准了
 *    （补丁被 Cursor 更新冲掉后重装、或者备份是在我们的 provider 已经在文件里时才补记的），
 *    整份写回会把我们的 provider 原样写回去，表现就是「点了还原，卡片还是已接入」。所以按 id 摘；
 *  - settings.json 是 Cursor 自己一直在写的文件，整份盖回会丢掉这期间用户改过的设置，只回滚我们动过的那一个键。
 */
async function restoreCursor(files: ProxyClientBackupFile[], onProgress?: ProgressFn): Promise<void> {
  onProgress?.('移除 Cursor++ 里的 Kiro provider…')
  const providersFile = ccursorProvidersPath()
  const doc = await readJsonObject(providersFile).catch(() => null)
  let others = 0
  if (doc && Array.isArray(doc.providers)) {
    const rest = (doc.providers as Record<string, unknown>[]).filter((p) => p?.id !== CCURSOR_PROVIDER_ID)
    others = rest.length
    await writeFileAtomic(providersFile, `${JSON.stringify({ ...doc, providers: rest }, null, 2)}\n`)
  }

  // 还有用户自己的 provider 就别关：关了他那些也一起用不了
  if (!others) {
    onProgress?.('关闭 CCursor 的 BYOK 模式，Cursor 回到官方后端…')
    await setCcursorByokMode(0)
  }

  onProgress?.('恢复 Cursor 的 HTTP/2 设置…')
  const settingsFile = cursorSettingsPath()
  const settingsBackup = files.find((f) => f.path === settingsFile)
  let original: Record<string, unknown> = {}
  try {
    original = settingsBackup?.existed ? (JSON.parse(settingsBackup.content) as Record<string, unknown>) : {}
  } catch {
    // 原文带注释解析不了：按「原本没有这个键」处理，删掉我们加的就是最稳的
  }
  const settings = await readJsonObject(settingsFile).catch(() => null)
  const key = 'cursor.general.disableHttp2'
  if (settings && key in settings) {
    if (key in original) settings[key] = original[key]
    else delete settings[key]
    await writeFileAtomic(settingsFile, `${JSON.stringify(settings, null, 4)}\n`)
  }
  onProgress?.('完成，重启 Cursor 后 HTTP/2 设置生效')
}

/** Cursor 的 bundle id：它用 ToDesktop 打包，所以是这么一串看着像乱码的东西 */
const CURSOR_BUNDLE_ID = 'com.todesktop.230313mzl4w4u92'

async function cursorRunning(): Promise<boolean> {
  if (process.platform !== 'darwin') return false
  try {
    await run('pgrep', ['-x', 'Cursor'], 5_000)
    return true
  } catch {
    return false
  }
}

/**
 * 代为重启 Cursor。
 *
 * 写入后必须重启才生效：`cursor.general.disableHttp2` 和 CCursor 注入的 hook
 * 都只在启动时读一次。
 *
 * 请求由 CCursor 在进程内接管后转发到本机反代。
 */
export async function restartCursorApp(): Promise<void> {
  if (process.platform !== 'darwin') {
    throw new Error('代为重启目前只支持 macOS，请手动完全退出 Cursor 后重新打开')
  }
  const app = await requireApp('cursor')

  if (await cursorRunning()) {
    // 用 AppleScript 正常退出，给它保存工作区的机会（有未保存文件时它会自己弹确认框）
    await run('osascript', ['-e', `tell application id "${CURSOR_BUNDLE_ID}" to quit`]).catch(
      () => undefined
    )
    for (let i = 0; i < 24; i++) {
      if (!(await cursorRunning())) break
      await new Promise((r) => setTimeout(r, 500))
    }
    if (await cursorRunning()) {
      throw new Error('Cursor 没能自动退出（可能有未保存的文件在等你确认），请手动退出后再打开')
    }
  }
  await run('open', [app])
  log('info', '[Proxy] 已重启 Cursor')
}

/** provider 写了、Cursor 本体也打着补丁，才算真的指向本反代；缺补丁时 Cursor 根本不读 providers.json */
async function cursorApplied(info: ProxyTargetInfo): Promise<boolean> {
  const content = (await readTextIfExists(ccursorProvidersPath())) ?? ''
  if (!content.includes(info.baseUrl) || !content.includes(CCURSOR_PROVIDER_ID)) return false
  // BYOK 关着时 Cursor 走官方后端，provider 写着也不会被用到
  if (!(await ccursorByokOn())) return false
  return cursorPatched(await cursorInstallPath())
}

// ============ Codex CLI ============

/*
 * TOML 一律手写、按行处理，不引第三方库：
 * 我们只需要改两三个根键和一个表，为此加依赖不值得，
 * 而且 toml 库重新序列化会打乱用户原有的注释与排版。
 */

/** 删掉指定的表（含其下所有键），用于重写我们自己那段 */
function removeSection(content: string, section: string): string {
  const newline = content.includes('\r\n') ? '\r\n' : '\n'
  const escaped = section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const header = new RegExp(`^\\s*\\[(${escaped}|"${escaped}")\\]\\s*$`)
  const out: string[] = []
  let skipping = false
  for (const line of content ? content.split(/\r?\n/) : []) {
    if (header.test(line)) {
      skipping = true
      continue
    }
    if (skipping && /^\s*\[/.test(line)) skipping = false
    if (!skipping) out.push(line)
  }
  return out.join(newline).trimEnd()
}

/** TOML 基础字符串转义：路径与 Key 里出现引号或反斜杠时不能直接塞进去 */
function tomlString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/*
 * 两个 Codex 目标共同的硬约束，都是踩出来的：
 *
 *  1. **Key 只能写进 provider 的 `http_headers`**。
 *     `env_key` 指向的环境变量没设置时，Codex 加载 config.toml 直接失败——
 *     桌面版启动时会拉起内置 codex 读启动策略，于是弹「无法加载登录要求」。
 *     这一条曾被误判成「不能改全局 provider」，实际改全局是安全的（见 applyCodexApp）。
 *
 *  2. **不动 auth.json**。那里面是 ChatGPT 桌面客户端的 OAuth 登录态
 *     （auth_mode / tokens / last_refresh），往 OPENAI_API_KEY 里塞我们的 Key
 *     会干扰它的登录判定。
 *
 * 两个目标的区别只在作用范围：命令行版写独立 profile 文件（只在 --profile 时生效），
 * 桌面版没有命令行参数，只能改 config.toml 的全局默认。
 */
// ============ Codex 模型目录 ============
//
// Codex 的 /model 切换菜单只列「模型目录」里的条目。自定义 provider 不给目录时，
// 它只认启动时那一个模型，还会报「Model metadata not found，Defaulting to fallback」。
//
// 目录条目字段很多（系统提示、工具形态、上下文窗口……），而且随 Codex 版本变化。
// 自己手写一份迟早对不上，所以从本机 Codex 自带的目录里取一条当模板，
// 只替换模型名、上下文窗口、身份描述等与 Kiro 相关的字段。

/** 可能的 codex 可执行文件位置，按常见程度排列 */
function codexBinaryCandidates(): string[] {
  const out: string[] = []
  const located = locateCliSync('codex').path
  if (located) out.push(located)
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (dir) out.push(path.join(dir, process.platform === 'win32' ? 'codex.exe' : 'codex'))
  }
  if (process.platform === 'darwin') {
    const bundled = 'ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex'
    out.push(path.join('/Applications', bundled), path.join(home(), 'Applications', bundled))
    out.push('/opt/homebrew/bin/codex', '/usr/local/bin/codex')
  } else if (process.platform !== 'win32') {
    out.push('/usr/local/bin/codex', '/usr/bin/codex')
  }
  out.push(path.join(home(), '.npm-global', 'bin', 'codex'))
  return [...new Set(out)]
}

function runCodex(binary: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    // execFile 不经过 shell，参数原样传入
    execFile(
      binary,
      args,
      { timeout: 20_000, maxBuffer: 32 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) reject(new Error(String(stderr || error.message).slice(0, 300)))
        else resolve(String(stdout))
      }
    )
  })
}

/** 取本机 Codex 自带目录里排序最靠前的可见模型，作为克隆模板 */
async function codexTemplateModel(): Promise<{ binary: string; model: Record<string, unknown> } | null> {
  for (const binary of codexBinaryCandidates()) {
    if (!existsSync(binary)) continue
    try {
      /*
       * 必须显式指定官方 provider：不指定时 codex 会按全局配置走，
       * 而全局配置很可能已经指向我们的反代，于是「模板」抓到的是我们上一次
       * 生成的目录——自己克隆自己，一旦某次生成有问题就会一直沿用下去。
       */
      const parsed = JSON.parse(
        await runCodex(binary, ['debug', 'models', '-c', 'model_provider=openai'])
      ) as {
        models?: Record<string, unknown>[]
      }
      const visible = (parsed.models ?? [])
        .filter((m) => m.visibility === 'list')
        .sort((a, b) => Number(a.priority ?? 99) - Number(b.priority ?? 99))
      /*
       * 优先挑「原生工具调用」的模型当模板，也就是没有 tool_mode 字段的那些。
       *
       * 带 tool_mode = "code_mode_only" 的模型走的是 code mode：Codex 不把
       * shell / apply_patch 作为原生工具发出来，而是让模型在沙箱里写代码调用
       * （请求体里连 tools 字段都没有）。克隆到这种模板，接反代的模型就会
       * 「只有联网搜索、不能执行命令也不能写文件」。
       * buildCodexCatalog 里还会再删一次 tool_mode 兜底。
       */
      const native = visible.find((m) => m.tool_mode === undefined || m.tool_mode === null)
      const picked = native ?? visible[0]
      if (picked) return { binary, model: picked }
    } catch {
      // 这个位置的 codex 太旧（没有 debug models）或者跑不起来，换下一个
    }
  }
  return null
}

/** Kiro 模型的展示名 */
function kiroDisplayName(id: string): string {
  if (id === 'auto') return 'Kiro Auto'
  return id
    .replace(/^claude-/, 'Claude ')
    .replace(/-/g, ' ')
    .replace(/\b([a-z])/g, (c) => c.toUpperCase())
}

/** 模型出自哪家：Kiro 列表里既有 Claude，也有 GPT、DeepSeek、Qwen 等 */
function vendorOf(id: string): string {
  if (id.startsWith('claude')) return 'an Anthropic Claude model'
  if (id.startsWith('gpt')) return 'an OpenAI GPT model'
  if (id === 'auto') return 'automatically selected by Kiro'
  return 'a model'
}

/**
 * 把系统提示里的「based on GPT-x」换成真实模型。
 * 不换的话模型会照着系统提示自称 GPT / o1，用户问「你是什么模型」时得到错误答案。
 */
function rewriteIdentity(text: unknown, id: string, name: string): unknown {
  if (typeof text !== 'string') return text
  // 版本号按「数字段 + 可选后缀」匹配，不能用 [\w.-]+：那样会吞掉句末的句号
  return text.replace(
    /based on GPT-\d+(?:\.\d+)*(?:-[A-Za-z]+)?/g,
    `powered by ${name} (${vendorOf(id)}, served through Kiro)`
  )
}

/**
 * 按模型列表拼 Codex 模型目录。
 * 模型来自「刷新模型」拉回的真实列表；反代的 /v1/models 每次请求都现拼一份。
 */
/** Codex 档位菜单里每一档的说明 */
const EFFORT_DESCRIPTIONS: Record<string, string> = {
  none: '不推理，最快',
  minimal: '极少推理',
  low: '轻量推理，响应快',
  medium: '均衡',
  high: '深入推理',
  xhigh: '更深入的推理',
  max: '最强推理，最慢、消耗最多'
}

/**
 * 该模型在 Codex 里的档位菜单与默认档位。
 *
 * 档位来自模型自己的 schema（与测活弹窗同一份数据），不写死：
 * Claude 系 low…max、GPT 系多一个 none、4.6 及更早没有 xhigh。
 * 默认档位：界面里给默认模型配了档位就用它，否则用 schema 标注的默认值。
 *
 * 没有档位这一层的模型也要给一项：Codex 要求 supported_reasoning_levels 非空。
 * 这时反代收到任何档位都会忽略（resolveEffort 返回 undefined），不会带给上游。
 */
function codexEffort(
  model: KiroModelInfo,
  defaults?: { model: string; effort: string }
): { levels: { effort: string; description: string }[]; level: string; updatable: boolean } {
  const options = model.effort?.options ?? []
  if (!options.length) {
    return { levels: [{ effort: 'medium', description: '该模型没有可调档位' }], level: 'medium', updatable: false }
  }
  const configured =
    defaults && defaults.model === model.modelId && options.includes(defaults.effort)
      ? defaults.effort
      : undefined
  const fallback = model.effort?.default && options.includes(model.effort.default)
    ? model.effort.default
    : options[Math.floor(options.length / 2)]
  return {
    levels: options.map((effort) => ({
      effort,
      description:
        (EFFORT_DESCRIPTIONS[effort] ?? effort) + (effort === model.effort?.default ? '（上游默认）' : '')
    })),
    level: configured ?? fallback,
    updatable: true
  }
}

export function buildCodexCatalog(
  template: Record<string, unknown>,
  list: KiroModelInfo[],
  /** 界面里设的默认模型与档位：该模型在 Codex 里的默认档位跟随它 */
  defaults?: { model: string; effort: string }
): Record<string, unknown> {
  const models = list.map((model, index) => {
    const effort = codexEffort(model, defaults)
    const id = model.modelId
    const name = model.modelName || kiroDisplayName(id)
    const messages =
      template.model_messages && typeof template.model_messages === 'object'
        ? { ...(template.model_messages as Record<string, unknown>) }
        : undefined
    if (messages) {
      messages.instructions_template = rewriteIdentity(messages.instructions_template, id, name)
    }
    const rate = typeof model.rate === 'number' ? `，${model.rate}x 积分` : ''

    return {
      ...template,
      slug: id,
      display_name: kiroLabel(model),
      description:
        id === 'auto' ? '由 Kiro 按任务自动选择模型' : `经 Kiro Manager Lite 本地反代${rate}`,
      visibility: 'list',
      priority: index + 1,
      /*
       * 按模型取，别统一写死：Codex 用这个值算 /status 的剩余上下文和压缩时机。
       * 填小了会在还远没满的时候就压缩，填大了则会一直发到上游拒绝。
       */
      context_window: modelInputTokens(model),
      max_context_window: modelInputTokens(model),
      // 注：Codex 的模型目录里没有输出上限字段（实测 codex debug models 的键里没有），
      // 别自作聪明加 max_output_tokens，它用的是 serde 反序列化，多余的键没好处
      auto_compact_token_limit: null,
      base_instructions: rewriteIdentity(template.base_instructions, id, name),
      ...(messages ? { model_messages: messages } : {}),
      /*
       * 推理档位：来自该模型的 schema，Codex 的 /model 会把它显示成第二步选择。
       * Codex 把选中的档位放在 reasoning.effort 里发来，反代再转成
       * Kiro 的 additionalModelRequestFields。
       */
      supported_reasoning_levels: effort.levels,
      default_reasoning_level: effort.level,
      supports_reasoning_effort_updates: effort.updatable,
      /*
       * 与 OpenAI 专有能力相关的字段一律关掉：
       *  - websocket：本反代只有 HTTP SSE
       *  - 推理摘要：Kiro 侧没有对应参数
       *  - 服务档位、套餐可见性、升级提示：都是 OpenAI 账号体系里的东西
       */
      prefer_websockets: false,
      supports_reasoning_summaries: false,
      supports_reasoning_summary_parameter: false,
      default_reasoning_summary: 'none',
      service_tiers: [],
      additional_speed_tiers: [],
      default_service_tier: null,
      available_in_plans: [],
      availability_nux: null,
      upgrade: null
    }
  })

  /*
   * 强制走原生工具调用：只要条目里带 tool_mode（目前只见过 "code_mode_only"），
   * Codex 就不会把 shell / apply_patch 等工具放进请求的 tools 字段，
   * 而是期望模型在它的代码沙箱里调用。接反代时的表现是模型说
   * 「我只有联网搜索，不能运行命令或写文件」。删掉这个键即可恢复成原生模式。
   */
  for (const model of models) delete (model as Record<string, unknown>).tool_mode

  return { models }
}

/**
 * Codex 目录模板：写入时从本机 Codex 取的那一条，存进应用 store。
 * 反代每次拼目录都要用它，放在 store 里比每次都去跑 codex 可靠也快得多。
 */
export async function readCodexTemplate(): Promise<Record<string, unknown> | null> {
  return getProxyCodexTemplate()
}

/**
 * 生成 Kiro 模型目录并用本机 Codex 校验一遍，校验通过才记下模板。
 * 找不到 Codex 或校验失败时返回 false，反代的 /v1/models 就退回普通列表，
 * 不至于连启动都失败。
 */
async function writeCodexCatalog(
  models: KiroModelInfo[],
  defaults: { model: string; effort: string }
): Promise<boolean> {
  const found = await codexTemplateModel()
  if (!found) return false
  const file = codexCatalogPath()
  await writeFileAtomic(
    file,
    `${JSON.stringify(buildCodexCatalog(found.model, models, defaults), null, 2)}\n`
  )
  try {
    const rendered = JSON.parse(
      await runCodex(found.binary, ['debug', 'models', '-c', `model_catalog_json="${tomlString(file)}"`])
    ) as { models?: { slug?: string }[] }
    if (rendered.models?.some((m) => m.slug === models[0]?.modelId)) {
      setProxyCodexTemplate(found.model)
      return true
    }
  } catch (error) {
    log('warn', `[Proxy] Codex 不接受生成的模型目录，已退回单模型配置：${(error as Error).message}`)
  }
  await fs.unlink(file).catch(() => undefined)
  setProxyCodexTemplate(null)
  return false
}

/**
 * 模型列表刷新后同步更新目录文件。
 * 反代的 /v1/models 本来就是现拼的，这份文件只是给用户看、给 Codex 校验用；
 * 没写入过 Codex（没有模板）时什么也不做。
 */
export async function syncCodexCatalogFile(
  models: KiroModelInfo[],
  defaults: { model: string; effort: string }
): Promise<void> {
  const template = getProxyCodexTemplate()
  if (!template || !existsSync(codexCatalogPath())) return
  await writeFileAtomic(
    codexCatalogPath(),
    `${JSON.stringify(buildCodexCatalog(template, models, defaults), null, 2)}\n`
  )
}

// ============ Codex 桌面版 ============
//
// 桌面版（/Applications/ChatGPT.app，bundle id com.openai.codex）和命令行版共用
// $CODEX_HOME，但它没有命令行参数，`--profile` 用不上，只认 config.toml 里的
// **全局默认** provider。所以这个目标必须改根级 model / model_provider。
//
// 实测（桌面版 26.924.51851）：全局 provider 指向本地反代后，桌面版能正常启动、
// 登录态不受影响。「无法加载登录要求」弹框是 config.toml 本身加载失败导致的——
// 桌面版启动时会拉起内置 codex 的 app-server 读取策略（见 app.asar 里的
// startup-requirements），配置解析不了就会弹那个框。env_key 指向一个没设置的
// 环境变量就会触发，所以 Key 走 http_headers，不依赖环境变量。

const MANAGED_BEGIN = '# >>> Kiro Manager Lite（本地反代）'
const MANAGED_END = '# <<< Kiro Manager Lite'

/**
 * 我们会写进 config.toml 根级的键。
 *
 * 重写和还原都按这份列表清理：桌面版运行时会把自己的值追加到根级区域，
 * 位置正好落在我们的标记块里（根键都排在第一个 [表] 之前），
 * 光靠摘标记块清不干净，必须逐个键删。
 */
const MANAGED_ROOT_KEYS = ['model', 'model_provider', 'web_search'] as const

/** 取根级某个键的整行（含注释），用于记录改之前的值 */
function rootKeyLine(content: string, key: string): string | undefined {
  const root = stripSections(content)
  return root.split(/\r?\n/).find((line) => new RegExp(`^\\s*${key}\\s*=`).test(line))
}

/** 摘掉我们写入的标记块 */
function stripManagedBlock(content: string): string {
  const pattern = new RegExp(
    `\\n*${escapeRegExp(MANAGED_BEGIN)}[\\s\\S]*?${escapeRegExp(MANAGED_END)}[^\\n]*\\n?`,
    'g'
  )
  return content.replace(pattern, '\n')
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 删掉根级某个键（只在第一个 [section] 之前找，不碰表内的同名键） */
function removeRootKey(content: string, key: string): string {
  const lines = content.split(/\r?\n/)
  const sectionIndex = lines.findIndex((line) => /^\s*\[/.test(line))
  const end = sectionIndex === -1 ? lines.length : sectionIndex
  const kept = lines.filter(
    (line, index) => index >= end || !new RegExp(`^\\s*${key}\\s*=`).test(line)
  )
  return kept.join(content.includes('\r\n') ? '\r\n' : '\n')
}

async function applyCodexApp(info: ProxyTargetInfo): Promise<void> {
  const file = codexConfigPath()
  const existing = (await readTextIfExists(file)) ?? ''
  const newline = existing.includes('\r\n') ? '\r\n' : '\n'

  // 先摘掉上一次写的那段与我们设过的根键，再整段重写，避免重复累积
  let content = stripManagedBlock(existing)
  for (const key of MANAGED_ROOT_KEYS) content = removeRootKey(content, key)
  content = removeSection(content, `model_providers.${CODEX_PROVIDER}`)

  /*
   * 根级键必须排在所有 [表] 之前，否则会被算进最后一个表里。
   * 所以这一段整体插到第一个 [section] 之前。
   */
  const lines = content.split(/\r?\n/)
  const sectionIndex = lines.findIndex((line) => /^\s*\[/.test(line))
  const head = (sectionIndex === -1 ? lines : lines.slice(0, sectionIndex)).join(newline).trimEnd()
  const tail = sectionIndex === -1 ? '' : lines.slice(sectionIndex).join(newline)

  const block = [
    MANAGED_BEGIN,
    '# 桌面版只认全局默认 provider，所以这几行是全局生效的；',
    '# 命令行版可以用 --profile 覆盖。在「本地反代」页面点「还原」即可撤销。',
    `model = "${tomlString(info.model)}"`,
    `model_provider = "${CODEX_PROVIDER}"`,
    /*
     * 联网搜索开关。WebSearchMode 的合法值是 live / cached。
     * 注意：开了它 Codex 才会把 web_search 工具挂上去，但真正能不能搜还取决于反代——
     * web_search 是 OpenAI 服务端执行的托管工具，Kiro 上游没有这个能力，
     * 目前 proxyConvert 会把它过滤掉（见那里的注释）。
     * 也就是说这一行是必要条件，不是充分条件。
     */
    'web_search = "live"',
    '',
    `[model_providers.${CODEX_PROVIDER}]`,
    'name = "Kiro Manager Lite"',
    `base_url = "${tomlString(info.baseUrl)}/v1"`,
    'wire_api = "responses"',
    /*
     * 声明这个 provider 支持联网搜索，Codex 才会把 web_search 工具挂进请求。
     * 少了这一行，即使 web_search = "live" 也不会发工具过来，
     * 模型于是回答「这个会话没有联网搜索工具」。
     * 搜索实际由反代执行（打 Kiro 的 MCP 端点），见 kiroWebSearch.ts。
     */
    'supports_standalone_web_search = true',
    `http_headers = { Authorization = "Bearer ${tomlString(info.apiKey)}" }`,
    MANAGED_END
  ].join(newline)

  const body = [head, block, tail].filter((part) => part.trim()).join(`${newline}${newline}`)
  await writeFileAtomic(file, `${body}${newline}`)

  // 目录文件也写一份：桌面版的模型选择器与命令行版共用同一份元数据
  await writeCodexCatalog(info.models, { model: info.model, effort: info.effort })
}

/**
 * 还原桌面版配置。
 *
 * 不整份覆盖 config.toml：这个文件桌面版自己也在写（插件、marketplaces、[desktop] 段），
 * 用几分钟前的快照盖回去会把它这期间的改动一起抹掉。
 * 所以只摘掉我们那段，再把备份里记录的旧根键原样放回去。
 */
async function restoreCodexApp(): Promise<void> {
  const file = codexConfigPath()
  const current = await readTextIfExists(file)
  if (current === null) return

  const snapshot = getProxyClientBackup('codexApp')?.files.find((f) => f.path === file)
  const newline = current.includes('\r\n') ? '\r\n' : '\n'

  let content = stripManagedBlock(current)
  for (const key of MANAGED_ROOT_KEYS) content = removeRootKey(content, key)
  content = removeSection(content, `model_providers.${CODEX_PROVIDER}`)

  // 把写入前的根键原样放回（用户原本可能指向别的反代，也可能自己开过 web_search）
  const previous = snapshot?.existed
    ? MANAGED_ROOT_KEYS.map((key) => rootKeyLine(snapshot.content, key))
        .filter((line): line is string => !!line)
        .join(newline)
    : ''
  if (previous) {
    const lines = content.split(/\r?\n/)
    const sectionIndex = lines.findIndex((line) => /^\s*\[/.test(line))
    const head = (sectionIndex === -1 ? lines : lines.slice(0, sectionIndex)).join(newline).trimEnd()
    const tail = sectionIndex === -1 ? '' : lines.slice(sectionIndex).join(newline)
    content = [head, previous, tail].filter((part) => part.trim()).join(`${newline}${newline}`)
  }

  /*
   * 原本没有 config.toml（用户只用桌面版、从没配过命令行）时，
   * 摘掉我们那段就什么都不剩了，这种情况把文件删掉，别留一个空壳。
   */
  if (!snapshot?.existed && !content.trim()) {
    await fs.unlink(file).catch(() => undefined)
    return
  }
  await writeFileAtomic(file, `${content.trimEnd()}${newline}`)
}

async function codexAppApplied(info: ProxyTargetInfo): Promise<boolean> {
  const content = (await readTextIfExists(codexConfigPath())) ?? ''
  if (!content) return false
  const root = stripSections(content)
  return (
    new RegExp(`^\\s*model_provider\\s*=\\s*"${escapeRegExp(CODEX_PROVIDER)}"`, 'm').test(root) &&
    content.includes(`${info.baseUrl}/v1`)
  )
}

/** 本应用早期版本写进 config.toml 的那一行注释，清理时一并去掉 */
const LEGACY_MARKER = /^# 以下两段由 Kiro Manager Lite 写入.*$\r?\n?/m

async function applyCodex(info: ProxyTargetInfo): Promise<void> {
  /*
   * 1. 清理 config.toml 里旧版遗留的 [profiles.*] 与 [model_providers.*]（新旧两个名字）。
   *    新版 Codex 只要看到 config.toml 里有同名的 [profiles.x]，
   *    `--profile x` 就直接报错退出，所以必须先拿掉。其余内容一字不动。
   */
  const configFile = codexConfigPath()
  const existing = await readTextIfExists(configFile)
  if (existing !== null) {
    let cleaned = existing.replace(LEGACY_MARKER, '')
    for (const name of [CODEX_PROVIDER, ...LEGACY_CODEX_NAMES]) {
      cleaned = removeSection(cleaned, `profiles.${name}`)
      cleaned = removeSection(cleaned, `model_providers.${name}`)
    }
    const newline = existing.includes('\r\n') ? '\r\n' : '\n'
    if (cleaned.trimEnd() !== existing.trimEnd()) {
      await writeFileAtomic(configFile, `${cleaned.trimEnd()}${newline}`)
    }
  }

  /*
   * 2. 写 profile 文件：provider 定义与默认模型都放在这里，
   *    只有 `codex --profile Kiro-Manager-Lite` 时才会生效，不影响全局默认与 ChatGPT 客户端。
   *
   *    wire_api 必须是 responses：Codex 0.158 已移除 chat，写 chat 会启动报错。
   *    Key 写在 http_headers 里：env_key 指向的变量没设置时 Codex 加载即失败，
   *    写 auth.json 又会干扰 ChatGPT 客户端的登录态。
   */
  // 旧名字（kml.*）留下的文件：确认是我们写的才删，别人同名的文件不碰
  for (const file of legacyCodexFiles()) {
    const text = await readTextIfExists(file)
    if (text === null) continue
    const ours = file.endsWith('.json')
      ? text.includes('经 Kiro Manager Lite 本地反代')
      : text.includes('Kiro Manager Lite')
    if (ours) await fs.unlink(file).catch(() => undefined)
  }

  /*
   * 3. 模型目录：有了它 /model 才能在运行中切换 Kiro 的各个模型。
   *
   *    不在 profile 里写 model_catalog_json：实测 Codex 0.159 在 profile 文件里
   *    忽略这个键（只认 config.toml 或命令行 -c），照样报「Model metadata not found」，
   *    模型也照着默认系统提示自称 GPT。所以由反代的 /v1/models 直接返回这份目录——
   *    Codex 本来就会向 provider 要 /v1/models?client_version=…，这条路不需要任何额外参数。
   */
  await writeCodexCatalog(info.models, { model: info.model, effort: info.effort })

  const content = [
    `# 由 Kiro Manager Lite 写入，使用：codex --profile ${CODEX_PROVIDER}`,
    `# 在「本地反代」页面点「还原」即可撤销`,
    `model = "${tomlString(info.model)}"`,
    `model_provider = "${CODEX_PROVIDER}"`,
    // 与桌面版保持一致；能不能真正联网搜索取决于反代，说明见 applyCodexApp 里的注释
    'web_search = "live"',
    '',
    `[model_providers.${CODEX_PROVIDER}]`,
    'name = "Kiro Manager Lite"',
    `base_url = "${tomlString(info.baseUrl)}/v1"`,
    'wire_api = "responses"',
    // 没这一行 Codex 不会把 web_search 工具挂上来，原因见 applyCodexApp 里的注释
    'supports_standalone_web_search = true',
    `http_headers = { Authorization = "Bearer ${tomlString(info.apiKey)}" }`,
    ''
  ].join('\n')
  await writeFileAtomic(codexProfilePath(), content)
}

async function codexApplied(info: ProxyTargetInfo): Promise<boolean> {
  const content = (await readTextIfExists(codexProfilePath())) ?? ''
  return (
    content.includes(`[model_providers.${CODEX_PROVIDER}]`) &&
    content.includes(`${info.baseUrl}/v1`) &&
    content.includes('wire_api = "responses"')
  )
}

// ============ 系统代理 ============
//
// Codex / Cursor 的 HTTP 栈（Rust reqwest、Electron）会读操作系统的代理设置，
// 但不认系统里「忽略这些主机」的例外列表。于是 http://127.0.0.1:<端口> 也被交给代理，
// 代理再按自己的规则把这条连接转发到远端节点，远端当然到不了用户的 localhost，
// 最终拿到 502。表现是反复 Reconnecting、模型列表为空（模型目录也是 HTTP 拉的）。
//
// 正确的解法在代理工具那一侧：把 127.0.0.1/8 设为 DIRECT（直连）。
// 这样所有客户端都不用改环境变量，一次配置永久生效。
// 下面的检测就是替用户确认这条规则到底生效了没有——经系统代理去访问一次
// 本机反代的 /health，通了说明回环流量能到达我们，不通就提示他去加规则。

/** 命令行版的启动命令 */
function codexCommand(): string {
  return `${cliInvoke('codex', 'codex')} --profile ${CODEX_PROVIDER}`
}

/** Codex 桌面版（ChatGPT.app）的可执行文件；找不到返回 null */
async function codexAppBinary(): Promise<string | null> {
  if (process.platform !== 'darwin') return null
  const app = (await locateClient('codexApp')).path
  const binary = app ? path.join(app, 'Contents', 'MacOS', 'ChatGPT') : ''
  return binary && existsSync(binary) ? binary : null
}

function run(command: string, args: string[], timeout = 15_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout, windowsHide: true }, (error, stdout, stderr) => {
      if (error) reject(new Error(String(stderr || error.message).slice(0, 300)))
      else resolve(String(stdout))
    })
  })
}

/** 桌面版是否在跑 */
async function codexAppRunning(): Promise<boolean> {
  if (process.platform !== 'darwin') return false
  try {
    // -x 精确匹配进程名，避免把我们自己或别的 helper 算进来
    await run('pgrep', ['-x', 'ChatGPT'], 5_000)
    return true
  } catch {
    return false
  }
}

/**
 * 让桌面版正常退出，返回它原本是否在运行。
 *
 * **改 config.toml 之前必须做这一步**，实测过的原因：桌面版运行期间把这个文件
 * 当成自己的状态存档，会按自己内存里的值回写根级 model / model_provider
 * （在应用里换个模型就会写一次）。我们在它运行时写入或还原，几秒后就会被它覆盖回去——
 * 表现为「写入成功但配置里没有」或者「还原后 model_provider 又冒出来」。
 *
 * 用 AppleScript 让它自己退出，而不是 kill：给它存盘的机会。
 */
async function quitCodexApp(): Promise<boolean> {
  if (!(await codexAppRunning())) return false
  await run('osascript', ['-e', 'tell application id "com.openai.codex" to quit']).catch(
    () => undefined
  )
  for (let i = 0; i < 24; i++) {
    if (!(await codexAppRunning())) return true
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error('Codex 桌面版没能自动退出，请手动完全退出（Cmd+Q）后重试')
}

/**
 * 启动 Codex 桌面版。
 *
 * 已经在运行时必须先退出：macOS 对同一个 bundle 只会激活现有实例，
 * 不退出就等于什么都没做，新配置读不进去。
 *
 * 已经在运行时必须先退出：macOS 对同一个 bundle 只会激活现有实例，
 * 我们注入的环境变量就白费了。用 AppleScript 正常退出（而不是 kill），
 * 让它有机会存盘。
 */
export async function launchCodexApp(): Promise<void> {
  const binary = await codexAppBinary()
  if (!binary) {
    throw new Error(
      process.platform === 'darwin'
        ? '没有找到 ChatGPT.app（Codex 桌面版），请确认它安装在「应用程序」里'
        : '代为启动目前只支持 macOS，请手动完全退出后重新打开 Codex 桌面版'
    )
  }
  // 已经在跑的话必须先退出：macOS 对同一个 bundle 只会激活现有实例，注入的变量就白费了
  await quitCodexApp()

  const child = spawn(binary, [], { detached: true, stdio: 'ignore' })
  // 脱离父进程，关掉本应用不会把它带走
  child.unref()
  log('info', `[Proxy] 已启动 Codex 桌面版：${binary}`)
}

// ============ 系统代理检测 ============

interface SystemProxy {
  host: string
  port: number
}

/** 读系统代理；没开返回 null */
async function systemProxy(): Promise<SystemProxy | null> {
  if (process.platform === 'darwin') {
    try {
      const out = await run('scutil', ['--proxy'], 5_000)
      if (!/\bHTTPEnable\s*:\s*1\b/.test(out)) return null
      const host = /\bHTTPProxy\s*:\s*(\S+)/.exec(out)?.[1]
      const port = Number(/\bHTTPPort\s*:\s*(\d+)/.exec(out)?.[1])
      return host && port ? { host, port } : null
    } catch {
      return null
    }
  }
  // 其它平台按环境变量判断，拿不到具体地址就只报「开了代理」
  const raw = process.env.HTTP_PROXY || process.env.http_proxy
  if (!raw) return null
  try {
    const url = new URL(raw)
    return { host: url.hostname, port: Number(url.port) || 80 }
  } catch {
    return null
  }
}

/**
 * 经系统代理访问一次本机反代，确认回环流量能不能到达我们。
 *
 * 用绝对形式的 GET（代理协议里访问 http:// 就是这么发的），
 * 拿到 200 说明代理把这条连接直连回本机了，Codex / Cursor 就能正常工作；
 * 超时或非 200 说明被转发到远端了，需要用户加 127.0.0.1/8 → DIRECT 规则。
 */
function loopbackReachableVia(proxy: SystemProxy, baseUrl: string): Promise<boolean> {
  return new Promise((resolve) => {
    let target: URL
    try {
      target = new URL(`${baseUrl}/health`)
    } catch {
      return resolve(false)
    }
    const req = http.request(
      {
        host: proxy.host,
        port: proxy.port,
        method: 'GET',
        // 绝对形式：告诉代理「帮我取这个地址」
        path: target.toString(),
        headers: { Host: target.host, Connection: 'close' },
        timeout: 5_000
      },
      (res) => {
        res.resume()
        resolve(res.statusCode === 200)
      }
    )
    req.on('error', () => resolve(false))
    req.on('timeout', () => {
      req.destroy()
      resolve(false)
    })
    req.end()
  })
}

/**
 * 给界面用的系统代理结论。
 * 返回 undefined 表示没问题（没开代理，或者开了但回环能直连）。
 */
async function proxyLoopbackWarning(baseUrl: string): Promise<string | undefined> {
  const proxy = await systemProxy()
  if (!proxy) return undefined
  if (await loopbackReachableVia(proxy, baseUrl)) return undefined
  return (
    `系统代理（${proxy.host}:${proxy.port}）把本机请求转发到了远端，客户端会连不上反代。` +
    '请在代理工具的规则里把 127.0.0.1/8 设为 DIRECT（直连）后重试。'
  )
}

/**
 * 在新的终端窗口里跑一条命令，命令行客户端的「打开」就是这个。
 * 用 do script 而不是 spawn：要的是一个用户能继续交互的终端会话，
 * 不是一个后台进程。
 */
async function openInTerminal(command: string): Promise<void> {
  if (process.platform === 'darwin') {
    // 命令里的双引号要转义，否则 AppleScript 的字符串会提前结束
    const escaped = command.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    await run('osascript', [
      '-e',
      `tell application "Terminal" to do script "${escaped}"`,
      '-e',
      'tell application "Terminal" to activate'
    ])
    return
  }
  if (process.platform === 'win32') {
    /*
     * 原样拼参数：命令里可能带引号的完整路径，Node 默认的转义（\"）cmd 不认。
     * start 的第一个带引号参数会被当成窗口标题，所以先给一个空标题 ""。
     */
    const child = spawn('cmd', ['/c', 'start', '""', 'cmd', '/k', command], {
      detached: true,
      stdio: 'ignore',
      windowsVerbatimArguments: true
    })
    child.unref()
    return
  }
  throw new Error(`请手动在终端运行：${command}`)
}

/**
 * 代为打开 / 重启目标客户端。
 * 图形界面的先正常退出再拉起（配置只在启动时读），命令行的开一个新终端窗口。
 */
export async function openProxyClient(target: ProxyClientTarget): Promise<void> {
  if (target === 'claudeApp') return restartClaudeApp()
  if (target === 'codexApp') return launchCodexApp()
  if (target === 'cursor') return restartCursorApp()
  if (target === 'deepseekApp') return restartDeepseekApp()
  if (target === 'vscode') return restartVscode()
  if (target === 'workbuddy') {
    return restartMacApp('WorkBuddy', 'workbuddy', WORKBUDDY_BUNDLE_ID, workbuddyRunning)
  }
  if (target === 'claudeCode') return openInTerminal('claude')
  if (target === 'codex') return openInTerminal(codexCommand())
  throw new Error('这个客户端不支持代为启动')
}

// ============ 安装检测 ============
//
// 为什么写入前一定要先查：这些客户端的配置文件都在它们自己的目录下。
// 没装就写，等于凭空造出一个 ~/.claude、~/.codex，界面上还显示「已指向本反代」，
// 用户以为配好了，实际根本没有这个客户端 —— 比直接报错难查得多。
// 还原时也会把这些空目录留在那里。

interface ClientInstall {
  installed: boolean
  /** 没装时告诉用户怎么装；已装时为 undefined */
  hint?: string
  /** 检测到的位置，界面上展示，方便用户确认认的是哪一份 */
  installPath?: string
  customPath: boolean
}

/** 找不到时的安装指引；手动指定的位置失效（被卸载或挪走）也会走到这里 */
const INSTALL_HINTS: Record<ProxyClientTarget, string> = {
  claudeCode: '没有找到 claude 命令。安装：npm i -g @anthropic-ai/claude-code。',
  codex: '没有找到 codex 命令。安装：npm i -g @openai/codex。',
  claudeApp: '没有找到 Claude 桌面版，可点击上方链接快捷安装。',
  codexApp: '没有找到 Codex 桌面版（ChatGPT），可点击上方链接快捷安装。',
  cursor: '没有找到 Cursor，可点击上方链接快捷安装。',
  vscode: '没有找到 VS Code，可点击上方链接快捷安装。',
  workbuddy: '没有找到 WorkBuddy，可点击上方链接快捷安装。',
  deepseek: '没有找到 dsh。安装：npm i -g @deepseek-ai/dsh，或先跑一次 npx @deepseek-ai/dsh web。',
  deepseekApp: '没有找到 DeepSeek Harness 桌面版，可点击上方链接快捷安装。'
}

async function detectInstall(target: ProxyClientTarget): Promise<ClientInstall> {
  const location = await locateClient(target)
  const base = { installPath: location.path ?? undefined, customPath: location.custom }
  /*
   * dsh 只用 npx 跑过也算装过（那时 ~/.dsh 已经建好），不一定有全局命令。
   */
  if (target === 'deepseek' && !location.path && dshInstalled()) return { installed: true, ...base }
  if (!location.path) return { installed: false, hint: INSTALL_HINTS[target], ...base }
  /*
   * DeepSeek 桌面版装了但没启动过：profile 目录还不存在。
   * 这时也不该写 —— 目录里缺 package.json，bundle 列表得由它首次启动时生成，
   * 我们光放一个 patch 文件不会生效。
   */
  if (target === 'deepseekApp' && !dshDesktopReady()) {
    return { installed: false, hint: '请先把 DeepSeek Harness 桌面版打开一次，让它生成 profile 目录', ...base }
  }
  return { installed: true, ...base }
}

/** 没装就抛错，错误文案直接是给用户看的安装指引 */
async function ensureClientInstalled(target: ProxyClientTarget): Promise<void> {
  const result = await detectInstall(target)
  if (!result.installed) throw new Error(result.hint ?? `没有检测到 ${target} 的安装`)
}

// ============ 对外接口 ============

export async function applyProxyClient(
  target: ProxyClientTarget,
  info: ProxyTargetInfo,
  /** Cursor 可能要先装 CCursor，过程较慢，逐行回传给界面显示 */
  onProgress?: ProgressFn
): Promise<ProxyClientState[]> {
  if (!info.apiKey.trim()) throw new Error('请先设置反代的 API Key，再写入客户端配置')
  // 排在最前面：没装的话后面每一步都是在给不存在的客户端造配置文件
  await ensureClientInstalled(target)

  /*
   * 桌面版必须在它没运行的时候改 config.toml。
   * 退出要排在备份之前：它运行期间随时会把内存里的配置回写到这个文件，
   * 备份读早了就会存下一份即将被覆盖的内容。
   */
  if (target === 'codexApp') await quitCodexApp()

  await snapshot(target)
  if (target === 'claudeCode') await applyClaudeCode(info)
  else if (target === 'claudeApp') await applyClaudeApp(info)
  else if (target === 'codexApp') await applyCodexApp(info)
  else if (target === 'deepseek') await applyDeepseek(info)
  else if (target === 'deepseekApp') await applyDeepseekApp(info)
  else if (target === 'vscode') await applyVscode(info)
  else if (target === 'workbuddy') await applyWorkbuddy(info)
  else if (target === 'cursor') await applyCursor(info, onProgress)
  else await applyCodex(info)
  log('info', `[Proxy] 已写入 ${target} 配置：${clientFiles(target).join('、')}`)

  /*
   * 不自动把桌面版启回来：用户可能只是想先改配置，突然弹出一个应用很打扰。
   * 弹窗里会按当前是否在运行给出「重启 / 打开」按钮，由用户决定什么时候起。
   */
  return proxyClientStates(info)
}

/** 还原成写入前的样子；原本不存在的文件会被删除 */
export async function restoreProxyClient(
  target: ProxyClientTarget,
  info: ProxyTargetInfo,
  /** Cursor 要跑 CCursor 的卸载，过程较慢，逐行回传给界面显示 */
  onProgress?: ProgressFn
): Promise<ProxyClientState[]> {
  const backup = getProxyClientBackup(target)
  if (!backup) throw new Error('没有备份，无法还原')

  // Cursor 的配置和补丁都要按条摘（原因见 restoreCursor），不走下面的整份写回
  if (target === 'cursor') {
    await restoreCursor(backup.files, onProgress)
    setProxyClientBackup(target, null)
    log('info', '[Proxy] 已还原 cursor 写入前的配置')
    return proxyClientStates(info)
  }

  // 同样要先退出，否则还原完几秒后它又把 model_provider 写回来（原因见 quitCodexApp）
  if (target === 'codexApp') await quitCodexApp()

  for (const file of backup.files) {
    /*
     * config.toml 是共用、且桌面版自己也在写的文件，只摘掉我们那段（原因见 restoreCodexApp），
     * 绝不能用快照整份盖回去。
     */
    if (target === 'codexApp' && file.path === codexConfigPath()) {
      await restoreCodexApp()
      continue
    }
    // 同理：VS Code 自己也写这个文件，只摘掉我们那一组
    if (target === 'vscode' && file.path === vscodeModelsPath()) {
      await restoreVscode(file.existed)
      continue
    }
    // 同理：用户会在 WorkBuddy 设置页里增删自定义模型，只摘我们的条目
    if (target === 'workbuddy' && file.path === workbuddyModelsPath()) {
      await restoreWorkbuddy(file)
      continue
    }
    /*
     * 模型目录是两个 Codex 目标共用的产物。还原其中一个时，
     * 另一个还处于已写入状态就把文件留着，否则它那边的界面会显示一个不存在的路径。
     */
    if (
      file.path === codexCatalogPath() &&
      getProxyClientBackup(target === 'codexApp' ? 'codex' : 'codexApp') !== null
    ) {
      continue
    }
    if (file.existed) await writeFileAtomic(file.path, file.content)
    else {
      await fs.unlink(file.path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error
      })
    }
  }
  setProxyClientBackup(target, null)
  log('info', `[Proxy] 已还原 ${target} 写入前的配置`)

  return proxyClientStates(info)
}

/** 各目标「是否已写入」的判定。Cursor 走单独分支，不在表里 */
const APPLIED_CHECKS: Record<ProxyClientTarget, (info: ProxyTargetInfo) => Promise<boolean>> = {
  claudeCode: claudeCodeApplied,
  claudeApp: claudeAppApplied,
  codex: codexApplied,
  codexApp: codexAppApplied,
  cursor: cursorApplied,
  deepseek: deepseekApplied,
  deepseekApp: deepseekAppApplied,
  vscode: vscodeApplied,
  workbuddy: workbuddyApplied
}

/** 能探测进程的（图形界面）才有值，命令行版是 undefined */
const APP_RUNNING_CHECKS: Partial<Record<ProxyClientTarget, () => Promise<boolean>>> = {
  claudeApp: claudeAppRunning,
  codexApp: codexAppRunning,
  cursor: cursorRunning,
  deepseekApp: deepseekAppRunning,
  vscode: vscodeRunning,
  workbuddy: workbuddyRunning
}

/** 需要用户自己敲的启动命令 */
const CLIENT_COMMANDS: Partial<Record<ProxyClientTarget, () => Promise<string>>> = {
  // Claude Code 读的是全局 settings.json，不用带参数；列出来是为了和 Codex 一样能一键复制
  claudeCode: async () => cliInvoke('claudeCode', 'claude'),
  codex: async () => codexCommand(),
  deepseek: dshCommand
}

export async function proxyClientStates(info: ProxyTargetInfo): Promise<ProxyClientState[]> {
  const targets: ProxyClientTarget[] = [
    'claudeCode',
    'codex',
    'claudeApp',
    'codexApp',
    'cursor',
    'deepseek',
    'deepseekApp',
    'vscode',
    'workbuddy'
  ]
  const states: ProxyClientState[] = []
  for (const target of targets) {
    /*
     * Cursor 不写入任何文件（API Key 在它的 UI 里填，存进了钥匙串加密项），
     * 所以没有 applied / hasBackup 状态，卡片只展示复制信息。
     */
    if (target === 'cursor') {
      const cursorInstall = await detectInstall('cursor')
      const applied = await cursorApplied(info).catch(() => false)
      states.push({
        target: 'cursor',
        paths: displayFiles(target),
        appRunning: await cursorRunning().catch(() => false),
        installed: cursorInstall.installed,
        installPath: cursorInstall.installPath,
        customPath: cursorInstall.customPath,
        applied,
        hasBackup: getProxyClientBackup(target) !== null,
        command: undefined,
        /*
         * 没装 Cursor 本体是硬前提，优先提示。
         * 没装 CCursor 不算隐患：点写入时会自动装，这里只说明一下会多花点时间。
         */
        warning:
          cursorInstall.hint ??
          ((await cursorPatched(cursorInstall.installPath ?? null))
            ? undefined
            : existsSync(ccursorProvidersPath())
              ? 'Cursor 更新后 CCursor 补丁被还原了，Cursor 里只剩官方模型。点「一键写入」会重新打补丁（约一两分钟）'
              : '首次写入会自动下载安装 CCursor（约 33MB，需要 Node.js 与网络），耗时一两分钟')
      })
      continue
    }
    const install = await detectInstall(target)
    const applied = await APPLIED_CHECKS[target](info).catch(() => false)
    // 只有图形界面客户端才探测进程，命令行版由用户自己开终端，不显示「重启」
    const probe = APP_RUNNING_CHECKS[target]
    // Claude Code 与各桌面版直接读默认配置；命令行版走 profile，必须显式带参数
    const command = CLIENT_COMMANDS[target]
    states.push({
      target,
      paths: displayFiles(target),
      appRunning: probe ? await probe().catch(() => false) : undefined,
      installed: install.installed,
      installPath: install.installPath,
      customPath: install.customPath,
      applied,
      hasBackup: getProxyClientBackup(target) !== null,
      command: command ? await command().catch(() => undefined) : undefined,
      // 没装是最根本的问题，优先于系统代理等其它提示
      warning: install.hint ?? (await clientWarning(target, info).catch(() => undefined))
    })
  }
  return states
}

/**
 * 各目标的隐患提示。
 * 命令行版：全局 provider 被指到第三方时提醒（会影响桌面版）。
 * 桌面版：写入本身就会改全局默认，提醒它同时影响不带 --profile 的命令行调用。
 */
/** 只保留根级内容（第一个 [section] 之前），用于判断根键 */
function stripSections(content: string): string {
  const lines = content.split(/\r?\n/)
  const index = lines.findIndex((line) => /^\s*\[/.test(line))
  return (index === -1 ? lines : lines.slice(0, index)).join('\n')
}

/**
 * 命令行版的隐患提示：config.toml 里的全局默认 provider 被指到了第三方。
 * 不带 --profile 时 codex 会走它而不是本反代，容易误判成「写入没生效」。
 * 排除我们自己写的那个——那是「Codex 桌面版」目标的正常结果。
 */
async function codexWarning(): Promise<string | undefined> {
  const content = (await readTextIfExists(codexConfigPath())) ?? ''
  if (!content) return undefined
  const provider = /^\s*model_provider\s*=\s*"([^"]+)"/m.exec(stripSections(content))?.[1]
  if (!provider || provider === 'openai' || provider === CODEX_PROVIDER) return undefined
  return `config.toml 里全局 model_provider = "${provider}"，不带 --profile 时会走它而不是本反代。`
}

/**
 * 卡片上的提示，只留真正会让功能不工作的那一条。
 * 系统代理拦回环是唯一「写入成功但一用就报错」的原因，优先级最高。
 */
async function clientWarning(
  target: ProxyClientTarget,
  info: ProxyTargetInfo
): Promise<string | undefined> {
  const proxyIssue = await proxyLoopbackWarning(info.baseUrl)
  if (proxyIssue) return proxyIssue

  // 命令行版：全局默认 provider 被指到第三方时，不带 --profile 会走错地方
  if (target === 'codex') return codexWarning()
  return undefined
}
