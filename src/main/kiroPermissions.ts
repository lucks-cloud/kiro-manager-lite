// Kiro Agent 命令审批配置读写：「自动同意所有 Shell 命令」
//
// Kiro 在不同版本用了两套机制，两套都要写，才能同时覆盖 0.x 与 1.0+：
//
// ── 机制 A：IDE settings.json 的 kiroAgent.trustedCommands（0.x 的真正入口）
// kiro-agent 扩展把 settings 里的 trustedCommands / autoApproveAgentCommands 合成一张
// 白名单交给 agent，匹配函数（@kiro/agent 内 command-approval 相关模块）等价于：
//
//   denylist.some((d) => command.includes(d)) ? false
//     : trusted.includes('*') ? true
//     : trusted.some((s) => s.endsWith(' *')
//         ? command.startsWith(s.slice(0, -2) + ' ') || command === s.slice(0, -2)
//         : command === s)
//
// 三个结论直接决定了本文件的实现：
//   1. 列表里出现字面 "*" 即无条件放行，这就是开启要写的值；
//   2. commandDenylist 优先级最高，且是**子串包含**匹配，只要非空就可能把命令拦下，
//      所以开启时必须一并清空（原值备份，关闭时还原）；
//   3. getTrustedCommands 每次都重新 vscode.workspace.getConfiguration('kiroAgent')，
//      settings.json 改完即时生效，**不需要重启 Kiro**。
//
// ── 机制 B：~/.kiro/settings/permissions.yaml（1.0+ 的权限规则表）
// 规则是 capability + effect(allow/ask/deny) + 可选 match 前缀列表，优先级 deny > ask > allow。
// 对每个 capability 都做一次「无条件放行」判定：只要存在一条**不带 match** 的 allow
// （没有 resource 条件），就直接 allow 并跳过后续逐条匹配。带 match 的规则会转成 resource
// 条件，只能逐个比前缀，没命中就弹窗 —— 所以 match 里写 "*" 无效。
// 「自动同意」不止放行 shell：还包括 fs_read / fs_write（文件读写）与 web_fetch / web_search
// （网络请求与搜索），见 MANAGED_CAPABILITIES。这些文件与网络类能力只能靠机制 B 覆盖，
// 机制 A 的 trustedCommands 只对 shell 命令生效。
// PolicySession.startWatching() 监听该文件，外部修改触发 rebuild，同样不需要重启。
//
// 两边都采用「最小侵入 + 可精确还原」：YAML 用带标记的注释块追加，settings.json 只动
// 那两个键，开启前的原值存进 electron-store，关闭时原样写回（原本没有的键则删除）。
import * as fs from 'fs/promises'
import { existsSync } from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  getShellApproveBackup,
  setShellApproveBackup,
  type ShellApproveSettingsBackup,
  type ShellApproveYamlBackup
} from './store'
import { log } from './logger'
import { writeFileAtomic } from './utils'
import {
  isKiroInstalled,
  kiroSettingsPath,
  readKiroSettingsObject,
  writeKiroSettingsObject
} from './kiroSettings'
import type { ShellAutoApproveStatus, ShellAutoApproveTarget } from '../shared/types'

const BEGIN_MARK = '# >>> kiro-manager-lite:shell-auto-approve'
const END_MARK = '# <<< kiro-manager-lite:shell-auto-approve'

/**
 * 开启「自动同意」时在 permissions.yaml 里放行的能力：
 * shell 命令、文件读取 / 写入、网络请求（web_fetch）与网络搜索（web_search）。
 * 每一项都写成不带 match 的 allow，即对该能力无条件放行。
 * 注意：settings.json 的 kiroAgent.trustedCommands（机制 A）只管 shell 命令，
 *       文件与网络类能力仅由这里的 permissions.yaml（机制 B）覆盖。
 */
const MANAGED_CAPABILITIES = ['shell', 'fs_read', 'fs_write', 'web_fetch', 'web_search'] as const

/** 追加的规则块：注释标记用于识别与移除。列表项顶格，effect 相对 capability 再缩进一级 */
const MANAGED_BLOCK = [
  BEGIN_MARK,
  '# 由 Kiro Manager Lite 添加：不带 match 即无条件放行对应能力。',
  '# 关闭「自动同意」开关会移除本段，请勿手动编辑。',
  ...MANAGED_CAPABILITIES.flatMap((cap) => [`- capability: ${cap}`, '  effect: allow']),
  END_MARK
].join('\n')

const TRUSTED_KEY = 'kiroAgent.trustedCommands'
const DENYLIST_KEY = 'kiroAgent.commandDenylist'
const WILDCARD = '*'

function settingsDir(): string {
  return path.join(os.homedir(), '.kiro', 'settings')
}

function permissionsYamlPath(): string {
  return path.join(settingsDir(), 'permissions.yaml')
}

function permissionsJsonPath(): string {
  return path.join(settingsDir(), 'permissions.json')
}

async function readTextIfExists(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, 'utf-8')
  } catch {
    return null
  }
}

// ============================================
// 机制 A：settings.json 的 kiroAgent.trustedCommands
// ============================================

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((v): v is string => typeof v === 'string')
}

/** denylist 是子串包含匹配，任何非空项都可能把命令拦下 */
function meaningfulDenylist(value: unknown): string[] {
  return asStringList(value)
    .map((v) => v.trim())
    .filter(Boolean)
}

interface TrustedState {
  path: string
  fileExists: boolean
  installed: boolean
  /** 白名单里已有字面 "*" */
  wildcard: boolean
  denylist: string[]
}

async function readTrustedState(): Promise<TrustedState> {
  const file = kiroSettingsPath()
  const installed = isKiroInstalled()
  const fileExists = existsSync(file)
  if (!installed) {
    return { path: file, fileExists, installed, wildcard: false, denylist: [] }
  }
  const obj = await readKiroSettingsObject(file)
  return {
    path: file,
    fileExists,
    installed,
    wildcard: asStringList(obj[TRUSTED_KEY]).some((v) => v.trim() === WILDCARD),
    denylist: meaningfulDenylist(obj[DENYLIST_KEY])
  }
}

function trustedTarget(state: TrustedState): ShellAutoApproveTarget {
  return {
    kind: 'trustedCommands',
    label: 'Kiro IDE 设置：kiroAgent.trustedCommands',
    path: state.path,
    fileExists: state.fileExists,
    applied: state.wildcard && state.denylist.length === 0,
    writable: state.installed,
    note: state.installed
      ? state.wildcard && state.denylist.length > 0
        ? `命令拒绝名单里还有 ${state.denylist.length} 项，它的优先级高于放行`
        : undefined
      : '未检测到 Kiro IDE 的用户数据目录，跳过该项'
  }
}

/** 写入 "*" 并清空 denylist，返回开启前的原值备份 */
async function applyTrustedWildcard(): Promise<ShellApproveSettingsBackup> {
  const file = kiroSettingsPath()
  const obj = await readKiroSettingsObject(file)
  const backup: ShellApproveSettingsBackup = {
    path: file,
    hadTrustedCommands: TRUSTED_KEY in obj,
    trustedCommands: obj[TRUSTED_KEY],
    hadCommandDenylist: DENYLIST_KEY in obj,
    commandDenylist: obj[DENYLIST_KEY]
  }

  const existing = asStringList(obj[TRUSTED_KEY]).map((v) => v.trim()).filter(Boolean)
  // 保留用户原有条目，只补一个 "*"，这样即使还原逻辑失效也不会丢配置
  obj[TRUSTED_KEY] = existing.includes(WILDCARD) ? existing : [WILDCARD, ...existing]
  obj[DENYLIST_KEY] = []
  await writeKiroSettingsObject(obj, file)

  // 写文件没抛错不等于写对了，回读确认
  const readBack = await readKiroSettingsObject(file)
  const ok =
    asStringList(readBack[TRUSTED_KEY]).some((v) => v.trim() === WILDCARD) &&
    meaningfulDenylist(readBack[DENYLIST_KEY]).length === 0
  if (!ok) throw new Error(`Kiro 设置写入后校验失败：${file}`)

  return backup
}

/** 按备份还原两个键；无备份时退化为「移除 * 但保留其它条目」 */
async function restoreTrusted(backup?: ShellApproveSettingsBackup): Promise<void> {
  const file = backup?.path || kiroSettingsPath()
  if (!existsSync(file)) return
  const obj = await readKiroSettingsObject(file)

  if (backup) {
    if (backup.hadTrustedCommands) obj[TRUSTED_KEY] = backup.trustedCommands
    else delete obj[TRUSTED_KEY]
    if (backup.hadCommandDenylist) obj[DENYLIST_KEY] = backup.commandDenylist
    else delete obj[DENYLIST_KEY]
  } else {
    const rest = asStringList(obj[TRUSTED_KEY])
      .map((v) => v.trim())
      .filter((v) => v && v !== WILDCARD)
    if (rest.length) obj[TRUSTED_KEY] = rest
    else delete obj[TRUSTED_KEY]
  }
  await writeKiroSettingsObject(obj, file)
}

// ============================================
// 机制 B：permissions.yaml
// ============================================

/** 去掉本应用写入的标记块，返回剩余文本 */
function stripManagedBlock(text: string): string {
  const pattern = new RegExp(
    `\\n*${escapeRegExp(BEGIN_MARK)}[\\s\\S]*?${escapeRegExp(END_MARK)}[^\\n]*\\n?`,
    'g'
  )
  return text.replace(pattern, '\n')
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

interface RuleBlock {
  capability: string
  effect: string
  hasMatch: boolean
}

/**
 * 极简 YAML 扫描：只识别 `- capability:` 列表项及其块内的 effect / match。
 *
 * 仅用于只读判断（展示状态、检测 deny 冲突），不参与写回，
 * 所以即使遇到不认识的写法也只会漏判，不会损坏用户文件。
 */
function scanRuleBlocks(text: string): RuleBlock[] {
  const lines = text.split(/\r?\n/)
  const blocks: RuleBlock[] = []
  let current: RuleBlock | null = null
  let itemIndent = 0

  const valueOf = (line: string, key: string): string | null => {
    const m = line.match(new RegExp(`^\\s*${key}\\s*:\\s*(.*)$`))
    if (!m) return null
    return m[1].trim().replace(/^["']|["']$/g, '')
  }

  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith('#')) continue
    const itemMatch = line.match(/^(\s*)-\s+capability\s*:\s*(.+)$/)
    if (itemMatch) {
      if (current) blocks.push(current)
      itemIndent = itemMatch[1].length
      current = {
        capability: itemMatch[2].trim().replace(/^["']|["']$/g, ''),
        effect: '',
        hasMatch: false
      }
      continue
    }
    if (!current) continue

    const indent = line.match(/^\s*/)?.[0].length ?? 0
    // 缩进回到列表项层级或更外层，说明当前块结束
    if (indent <= itemIndent && !/^\s*(effect|match|exclude)\s*:/.test(line)) {
      blocks.push(current)
      current = null
      continue
    }

    const effect = valueOf(line, 'effect')
    if (effect !== null) {
      current.effect = effect
      continue
    }
    if (/^\s*match\s*:/.test(line)) {
      const inline = valueOf(line, 'match')
      // `match:` 后接空值表示下面是列表，两种写法都算「带 match」
      current.hasMatch = inline === null || inline === '' ? true : inline !== '[]'
    }
  }
  if (current) blocks.push(current)
  return blocks
}

const MANAGED_CAP_SET = new Set<string>(MANAGED_CAPABILITIES)

/** 某个能力是否已存在不带 match 的 allow：这正是对它无条件放行的判定条件 */
function hasUnconditionalAllow(blocks: RuleBlock[], capability: string): boolean {
  return blocks.some(
    (rule) => rule.capability === capability && rule.effect === 'allow' && !rule.hasMatch
  )
}

/** 所有受管能力是否都已被无条件放行（无论是否本应用写入） */
function hasAllManagedUnconditionalAllow(text: string): boolean {
  const blocks = scanRuleBlocks(text)
  return MANAGED_CAPABILITIES.every((cap) => hasUnconditionalAllow(blocks, cap))
}

/** 受管能力里存在 deny 规则的那些能力：deny 优先级高于 allow，会让放行失效 */
function findManagedDenies(text: string): string[] {
  const denied = new Set<string>()
  for (const rule of scanRuleBlocks(text)) {
    if (rule.effect === 'deny' && MANAGED_CAP_SET.has(rule.capability)) denied.add(rule.capability)
  }
  return [...denied]
}

/** 原子写：临时文件 + rename，避免 Kiro 的 watcher 读到写入一半的内容；临时文件权限 0o644 */
function writeAtomic(file: string, content: string): Promise<void> {
  return writeFileAtomic(file, content, 0o644)
}

/**
 * 判断能否安全追加规则块。
 * 空文件与不存在都可以由我们生成完整内容；有内容但没有 rules 键的属于异常格式，
 * 这时不动文件，交给用户手动处理。
 */
function yamlBlockedReason(yamlText: string | null, jsonText: string | null): string | undefined {
  const yamlEmpty = !yamlText || !yamlText.trim()
  if (yamlEmpty && jsonText && jsonText.trim()) {
    return '当前生效的是 permissions.json；YAML 一旦创建会覆盖它的优先级，请先手动把规则迁移到 permissions.yaml'
  }
  if (!yamlEmpty && !/^\s*rules\s*:/m.test(yamlText as string)) {
    return 'permissions.yaml 缺少 rules 顶层键，格式无法识别，已跳过自动修改'
  }
  return undefined
}

interface YamlState {
  path: string
  text: string
  fileExists: boolean
  managed: boolean
  /** 所有受管能力都已被无条件放行 */
  unconditionalAllow: boolean
  /** 受管能力里存在 deny 规则的那些能力 */
  deniedCaps: string[]
  blockedReason?: string
}

async function readYamlState(): Promise<YamlState> {
  const file = permissionsYamlPath()
  const yamlText = await readTextIfExists(file)
  const jsonText = await readTextIfExists(permissionsJsonPath())
  const text = yamlText ?? ''
  return {
    path: file,
    text,
    fileExists: yamlText !== null,
    managed: text.includes(BEGIN_MARK),
    unconditionalAllow: hasAllManagedUnconditionalAllow(text),
    deniedCaps: findManagedDenies(text),
    blockedReason: yamlBlockedReason(yamlText, jsonText)
  }
}

function yamlTarget(state: YamlState): ShellAutoApproveTarget {
  return {
    kind: 'permissionsYaml',
    label: 'Kiro Agent 权限规则：permissions.yaml',
    path: state.path,
    fileExists: state.fileExists,
    applied: state.managed,
    writable: !state.blockedReason,
    note:
      state.blockedReason ??
      (state.managed && state.deniedCaps.length
        ? `同一份配置里存在 ${state.deniedCaps.join('、')} 的 deny 规则，它的优先级高于放行`
        : undefined)
  }
}

async function applyYamlBlock(state: YamlState): Promise<ShellApproveYamlBackup> {
  const backup: ShellApproveYamlBackup = { existed: state.fileExists, content: state.text }
  const base = state.text.trim() ? `${state.text.replace(/\s*$/, '')}\n` : 'rules:\n'
  await writeAtomic(state.path, `${base}${MANAGED_BLOCK}\n`)
  return backup
}

async function restoreYaml(backup?: ShellApproveYamlBackup): Promise<void> {
  const file = permissionsYamlPath()
  if (backup) {
    if (backup.existed) {
      await writeAtomic(file, backup.content)
    } else {
      // 原本没有这个文件：删掉我们创建的那一份，让 Kiro 回到默认行为
      await fs.unlink(file).catch(() => undefined)
    }
    return
  }

  // 没有备份（换机器、手动改过）：只移除我们的标记块，不动用户其它规则
  const current = await readTextIfExists(file)
  if (!current || !current.includes(BEGIN_MARK)) return
  const stripped = stripManagedBlock(current).replace(/\n{3,}/g, '\n\n').replace(/\s*$/, '\n')
  // 剩下的只有 rules: 空壳时直接删除文件，避免留一个空规则表
  if (/^\s*rules\s*:\s*$/.test(stripped.trim())) {
    await fs.unlink(file).catch(() => undefined)
  } else {
    await writeAtomic(file, stripped)
  }
}

// ============================================
// 对外接口
// ============================================

function buildStatus(trusted: TrustedState, yaml: YamlState): ShellAutoApproveStatus {
  const targets = [trustedTarget(trusted), yamlTarget(yaml)]
  const writable = targets.filter((t) => t.writable)
  const applied = writable.filter((t) => t.applied)

  const denyReasons: string[] = []
  if (trusted.denylist.length) {
    denyReasons.push(
      `kiroAgent.commandDenylist 中有 ${trusted.denylist.length} 项拒绝规则（${trusted.denylist
        .slice(0, 3)
        .join('、')}${trusted.denylist.length > 3 ? '…' : ''}）`
    )
  }
  if (yaml.deniedCaps.length) {
    denyReasons.push(`permissions.yaml 中存在 ${yaml.deniedCaps.join('、')} 的 deny 规则`)
  }

  return {
    enabled: writable.length > 0 && applied.length === writable.length,
    partial: applied.length > 0 && applied.length < writable.length,
    // 两套机制都是热加载：settings 走 vscode 配置实时读取，YAML 由 chokidar 监听重建
    requiresRestart: false,
    hasBackup: getShellApproveBackup() !== null,
    externalAllow: applied.length === 0 && yaml.unconditionalAllow,
    denyConflict: applied.length > 0 && denyReasons.length > 0,
    denyConflictReason: denyReasons.length ? denyReasons.join('；') : undefined,
    blockedReason: writable.length
      ? undefined
      : targets.map((t) => t.note).filter(Boolean).join('；') || '没有可写入的 Kiro 配置',
    targets
  }
}

export async function getShellAutoApproveStatus(): Promise<ShellAutoApproveStatus> {
  const [trusted, yaml] = await Promise.all([readTrustedState(), readYamlState()])
  return buildStatus(trusted, yaml)
}

export async function enableShellAutoApprove(): Promise<ShellAutoApproveStatus> {
  const [trusted, yaml] = await Promise.all([readTrustedState(), readYamlState()])
  const previous = getShellApproveBackup()

  const settingsBackup = previous?.settings
  const yamlBackup = previous?.yaml
  const failures: string[] = []
  let nextSettings = settingsBackup
  let nextYaml = yamlBackup
  let wrote = false

  if (trusted.installed) {
    if (trustedTarget(trusted).applied) {
      // 已是目标状态，不重复写，也不覆盖已有备份
    } else {
      try {
        const fresh = await applyTrustedWildcard()
        // 首次开启才记备份；重复开启时保留最早那份，避免把自己写的值当成用户原值
        nextSettings = settingsBackup ?? fresh
        wrote = true
      } catch (e) {
        failures.push(`写入 Kiro 设置失败：${(e as Error).message}`)
      }
    }
  } else {
    failures.push(trustedTarget(trusted).note as string)
  }

  if (!yaml.blockedReason) {
    if (!yaml.managed) {
      try {
        const fresh = await applyYamlBlock(yaml)
        nextYaml = yamlBackup ?? fresh
        wrote = true
      } catch (e) {
        failures.push(`写入 permissions.yaml 失败：${(e as Error).message}`)
      }
    }
  } else {
    failures.push(yaml.blockedReason)
  }

  const status = await getShellAutoApproveStatus()
  const anyApplied = status.targets.some((t) => t.applied)
  if (!anyApplied) {
    throw new Error(failures[0] || '未能写入任何 Kiro 配置')
  }
  if (wrote || !previous) {
    setShellApproveBackup({ savedAt: previous?.savedAt ?? Date.now(), settings: nextSettings, yaml: nextYaml })
  }
  log(
    failures.length ? 'warn' : 'info',
    `[KiroPermissions] 已开启自动同意 shell 命令${failures.length ? `（部分项跳过：${failures.join('；')}）` : ''}`
  )
  return getShellAutoApproveStatus()
}

export async function disableShellAutoApprove(): Promise<ShellAutoApproveStatus> {
  const backup = getShellApproveBackup()

  await restoreTrusted(backup?.settings)
  await restoreYaml(backup?.yaml)

  setShellApproveBackup(null)
  log(
    'info',
    backup
      ? '[KiroPermissions] 已关闭自动同意 shell 命令，并还原开启前的配置'
      : '[KiroPermissions] 已关闭自动同意 shell 命令（无备份，已移除本应用写入的放行项）'
  )
  return getShellAutoApproveStatus()
}

/**
 * 按机制标识解析配置文件路径。
 * 供 IPC 定位文件用：渲染层只传标识，路径始终在主进程算出来。
 */
export function shellApproveTargetPath(kind: ShellAutoApproveTarget['kind']): string {
  return kind === 'permissionsYaml' ? permissionsYamlPath() : kiroSettingsPath()
}
