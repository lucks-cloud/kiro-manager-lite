// 导入 / 导出格式转换
import { DEFAULT_REGION } from '@shared/regions'
import type {
  Account,
  AccountExportData,
  AccountGroup,
  AccountImportItem,
  ExportBundle,
  IdpType,
  KeyEntry
} from '@shared/types'

export type ExportFormat = 'json' | 'oidc' | 'kami' | 'csv' | 'txt' | 'clipboard'

const VALID_IDPS: IdpType[] = ['BuilderId', 'Github', 'Google', 'Enterprise']

/** 把外部写法归一成内部 IdP 枚举，认不出来的按 BuilderId 处理 */
export function normalizeIdp(value?: string): IdpType {
  if (!value) return 'BuilderId'
  const lower = value.trim().toLowerCase()
  const hit = VALID_IDPS.find((v) => v.toLowerCase() === lower)
  if (hit) return hit
  // 别名：标准名已在上面命中，这里只处理简写
  if (lower === 'gh') return 'Github'
  if (lower === 'gmail') return 'Google'
  return 'BuilderId'
}

/** 社交登录（GitHub / Google）只有 refreshToken，IdC 才需要 clientId/secret */
export function isSocialIdp(idp: IdpType): boolean {
  return idp === 'Github' || idp === 'Google'
}

/** 卡密行分隔符自动识别：----、Tab、连续空格、逗号 */
function splitCredentialLine(line: string): string[] {
  if (line.includes('----')) return line.split('----')
  if (line.includes('\t')) return line.split('\t')
  if (/\s{2,}/.test(line)) return line.split(/\s{2,}/)
  return line.split(',')
}

function parseKamiLines(text: string): AccountImportItem[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((line) => {
      const parts = splitCredentialLine(line).map((p) => p.trim())
      const password = parts[1] && parts[1] !== 'no_password' ? parts[1] : undefined
      const clientId = parts[3] || undefined
      const clientSecret = parts[4] || undefined
      // 第 6 段是登录方式；旧卡密没有该字段时，按有无 clientId/secret 推断：
      // social（GitHub/Google）只有 refreshToken，IdC 才带 clientId/secret
      const provider = parts[5] || (!clientId && !clientSecret ? 'Google' : 'BuilderId')
      return {
        email: parts[0] || undefined,
        password,
        refreshToken: parts[2] || '',
        clientId,
        clientSecret,
        provider
      }
    })
    .filter((item) => !!item.refreshToken)
}

function parseCsvRow(row: string): string[] {
  const out: string[] = []
  let cur = ''
  let quoted = false
  for (let i = 0; i < row.length; i++) {
    const ch = row[i]
    if (quoted) {
      if (ch === '"') {
        if (row[i + 1] === '"') {
          cur += '"'
          i++
        } else quoted = false
      } else cur += ch
    } else if (ch === '"') {
      quoted = true
    } else if (ch === ',') {
      out.push(cur)
      cur = ''
    } else cur += ch
  }
  out.push(cur)
  return out.map((c) => c.trim())
}

const HEADER_ALIASES: Record<string, keyof AccountImportItem> = {
  邮箱: 'email',
  email: 'email',
  昵称: 'nickname',
  nickname: 'nickname',
  登录方式: 'provider',
  idp: 'provider',
  provider: 'provider',
  密码: 'password',
  password: 'password',
  refreshtoken: 'refreshToken',
  'refresh token': 'refreshToken',
  clientid: 'clientId',
  clientsecret: 'clientSecret',
  region: 'region'
}

function parseCsv(text: string): AccountImportItem[] {
  const lines = text
    .replace(/^\ufeff/, '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  if (lines.length === 0) return []

  const first = parseCsvRow(lines[0]).map((h) => h.toLowerCase())
  const mapped = first.map((h) => HEADER_ALIASES[h])
  const hasHeader = mapped.filter(Boolean).length >= 2

  if (!hasHeader) return parseKamiLines(text)

  return lines
    .slice(1)
    .map((line) => {
      const cells = parseCsvRow(line)
      const item: AccountImportItem = { refreshToken: '' }
      mapped.forEach((key, i) => {
        if (!key) return
        const value = cells[i]
        if (value) (item as unknown as Record<string, string>)[key] = value
      })
      return item
    })
    .filter((item) => !!item.refreshToken)
}

export interface ParsedImport {
  items: AccountImportItem[]
  /** 完整导出文件（含用量、订阅等），可直接恢复 */
  fullData?: AccountExportData
}

/** 取第一个非空字段，用于兼容各家导出的不同命名 */
function pick(entry: Record<string, unknown>, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = entry[name]
    if (typeof value === 'string' && value.trim()) return value.trim()
    if (typeof value === 'number') return String(value)
  }
  return undefined
}

/**
 * 解析一条精简 JSON 记录。
 *
 * 各家导出的字段命名差别很大：camelCase、snake_case、把登录方式写成 login_provider，
 * 还可能把原始 token 文件整块塞在 kiro_auth_token_raw 里。登录方式认不出来会被当成
 * BuilderId，进而按 IdC 要求 clientId/secret——社交账号本来就没有这两个值，
 * 于是整批导入全部「校验失败」。所以这里把已知别名一次性覆盖掉。
 */
function parseJsonEntry(raw: Record<string, unknown>): AccountImportItem {
  // 有些导出把完整的 kiro-auth-token.json 原样嵌在里面，那份里的字段最权威
  const nested = (raw.kiro_auth_token_raw ?? raw.kiroAuthTokenRaw ?? {}) as Record<string, unknown>
  const entry = { ...nested, ...raw }

  const provider = pick(
    entry,
    'provider',
    'idp',
    'login_provider',
    'loginProvider',
    'login_option',
    'loginOption'
  )
  const authMethod = pick(entry, 'authMethod', 'auth_method')

  return {
    email: pick(entry, 'email', 'login_hint', 'loginHint'),
    password: pick(entry, 'password'),
    refreshToken: pick(entry, 'refreshToken', 'refresh_token') || '',
    clientId: pick(entry, 'clientId', 'client_id'),
    clientSecret: pick(entry, 'clientSecret', 'client_secret'),
    region: pick(entry, 'region', 'authRegion', 'auth_region'),
    /*
     * provider 缺失时按 authMethod 兜底：social 说明是社交登录，
     * 具体是 GitHub 还是 Google 无从判断，取 Google 只为让它走 social 分支
     * （两者刷新都只用 refreshToken，走同一个 Kiro auth service）。
     */
    provider: provider || (authMethod?.toLowerCase() === 'social' ? 'Google' : undefined),
    nickname: pick(entry, 'nickname')
  }
}

/** 统一解析导入内容：完整 JSON / 精简 JSON 数组 / 卡密 / CSV / TXT */
export function parseImportContent(raw: string): ParsedImport {
  const text = raw.trim()
  if (!text) return { items: [] }

  try {
    const parsed = JSON.parse(text)

    // 完整导出文件
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.accounts)) {
      return { items: [], fullData: parsed as AccountExportData }
    }

    // 精简 JSON 数组 / 单对象
    const list = Array.isArray(parsed) ? parsed : [parsed]
    const items = list.map(parseJsonEntry).filter((item) => !!item.refreshToken)
    return { items }
  } catch {
    // 非 JSON：CSV / 卡密 / TXT
    return { items: text.includes(',') && !text.includes('----') ? parseCsv(text) : parseKamiLines(text) }
  }
}

// ============ 导出 ============

export function buildExportContent(
  format: ExportFormat,
  accounts: Account[],
  options: { includeCredentials: boolean; appVersion: string; groups?: AccountGroup[] }
): string {
  const { includeCredentials, appVersion, groups } = options

  switch (format) {
    case 'json': {
      // 只带上这批账号真正用到的分组，避免把无关分组塞进别人的备份
      const referenced = new Set(accounts.map((a) => a.groupId).filter(Boolean) as string[])
      const usedGroups = (groups ?? []).filter((g) => referenced.has(g.id))
      const data: AccountExportData = {
        app: 'kiro-account-lite',
        version: appVersion,
        exportedAt: Date.now(),
        accounts: accounts.map(({ isActive: _isActive, ...rest }) =>
          includeCredentials
            ? rest
            : { ...rest, password: undefined, credentials: { ...rest.credentials, accessToken: '', refreshToken: '' } }
        ),
        ...(usedGroups.length ? { groups: usedGroups } : {})
      }
      return JSON.stringify(data, null, 2)
    }

    case 'oidc':
      // 精简 JSON，可直接粘回批量导入框
      return JSON.stringify(
        accounts.map((a) => {
          const item: Record<string, string> = {
            email: a.email,
            refreshToken: a.credentials.refreshToken || '',
            provider: a.idp || 'BuilderId'
          }
          if (a.password) item.password = a.password
          if (a.credentials.clientId) item.clientId = a.credentials.clientId
          if (a.credentials.clientSecret) item.clientSecret = a.credentials.clientSecret
          return item
        }),
        null,
        2
      )

    case 'kami':
      // 邮箱----密码----RefreshToken----ClientId----ClientSecret----登录方式
      return accounts
        .map((a) =>
          [
            a.email,
            a.password || 'no_password',
            a.credentials.refreshToken || '',
            a.credentials.clientId || '',
            a.credentials.clientSecret || '',
            a.idp || 'BuilderId'
          ].join('----')
        )
        .join('\n')

    case 'csv': {
      const headers = includeCredentials
        ? ['邮箱', '昵称', '登录方式', 'refreshToken', 'clientId', 'clientSecret', 'region']
        : ['邮箱', '昵称', '登录方式', '订阅', '已用积分', '总积分', '状态']
      const rows = accounts.map((a) =>
        includeCredentials
          ? [
              a.email,
              a.nickname || '',
              a.idp,
              a.credentials.refreshToken || '',
              a.credentials.clientId || '',
              a.credentials.clientSecret || '',
              a.credentials.region || DEFAULT_REGION
            ]
          : [
              a.email,
              a.nickname || '',
              a.idp,
              a.subscription.title || a.subscription.type,
              String(a.usage.current ?? ''),
              String(a.usage.limit ?? ''),
              a.status
            ]
      )
      // BOM 让 Excel 正确识别 UTF-8
      return (
        '\ufeff' +
        [headers, ...rows]
          .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(','))
          .join('\n')
      )
    }

    case 'txt':
      if (includeCredentials) {
        return accounts
          .map((a) => [a.email, a.credentials.refreshToken || '', a.nickname || '', a.idp].join(','))
          .join('\n')
      }
      return accounts
        .map((a) =>
          [
            `邮箱: ${a.email}`,
            a.nickname ? `昵称: ${a.nickname}` : null,
            `登录方式: ${a.idp}`,
            `订阅: ${a.subscription.title || a.subscription.type}`,
            `积分: ${a.usage.current ?? 0} / ${a.usage.limit ?? 0}`,
            `状态: ${a.status}`
          ]
            .filter(Boolean)
            .join('\n')
        )
        .join('\n\n---\n\n')

    // 已覆盖 ExportFormat 的全部取值，无需 default 兜底
    case 'clipboard':
      // 邮箱,RefreshToken —— 最短的可回导格式，方便直接粘贴
      if (includeCredentials) {
        return accounts.map((a) => `${a.email},${a.credentials.refreshToken || ''}`).join('\n')
      }
      return accounts
        .map(
          (a) =>
            `${a.email}${a.nickname ? ` (${a.nickname})` : ''} - ${a.subscription.title || a.subscription.type}`
        )
        .join('\n')
  }
}

const EXPORT_EXTENSION: Record<ExportFormat, string> = {
  json: 'json',
  oidc: 'json',
  kami: 'txt',
  csv: 'csv',
  txt: 'txt',
  clipboard: 'txt'
}

/** 本地时间的紧凑时间戳：20260726-201330，精确到秒避免同一天多次导出重名 */
export function exportStamp(date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  const ymd = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
  const hms = `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  return `${ymd}-${hms}`
}

/** 账号名转文件名片段：只留字母数字与 . _ -，其余折成单个短横 */
export function safeNamePart(value: string): string {
  const cleaned = value
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return cleaned.slice(0, 40)
}

/**
 * 导出文件名。
 * 单个账号带上账号名便于辨认，多个账号用统一前缀，末尾一律带时间戳。
 */
export function exportFilename(format: ExportFormat, accounts: Account[]): string {
  const ext = EXPORT_EXTENSION[format]
  if (accounts.length === 1) {
    const account = accounts[0]
    const name = safeNamePart(account.nickname || account.email.split('@')[0])
    if (name) return `kiro-account-${name}-${exportStamp()}.${ext}`
  }
  return `kiro-accounts-${exportStamp()}.${ext}`
}

// ============ API Key 导出 ============

/**
 * API Key 导出格式。
 * keyRegion 带区域，回导时能还原每个 Key 归属的区域；key 只给裸密钥，便于粘到别处使用。
 */
export type ApiKeyExportFormat = 'keyRegion' | 'key'

/** 分隔符沿用卡密格式的 ----，导入侧已能识别 */
export function buildApiKeyExportContent(
  format: ApiKeyExportFormat,
  keys: Pick<KeyEntry, 'key' | 'region'>[]
): string {
  const lines = keys.map((entry) =>
    format === 'keyRegion' ? `${entry.key}----${entry.region || DEFAULT_REGION}` : entry.key
  )
  return lines.join('\n') + '\n'
}

export function apiKeyExportFilename(): string {
  return `kiro-api-keys-${exportStamp()}.txt`
}

// ============ 分割导出（打包成 zip） ============

/** 压缩包文件名：与多账号导出同一套命名，只是换成 .zip */
export function bundleFilename(accounts: Account[]): string {
  if (accounts.length === 1) {
    const name = safeNamePart(accounts[0].nickname || accounts[0].email.split('@')[0])
    if (name) return `kiro-account-${name}-${exportStamp()}.zip`
  }
  return `kiro-accounts-${exportStamp()}.zip`
}

/**
 * 逐个分割导出：每个账号一个独立文件，外加一个整批的 all 文件，打成一个压缩包。
 *
 * 全部文件都用**当前选中的格式**，不混格式：选 JSON 得到 N 个 .json + all.json，
 * 选 TXT 得到 N 个 .txt + all.txt，以此类推。
 *
 * 单账号文件沿用 exportFilename 的命名，和「只选一个账号导出」时拿到的文件名完全一致，
 * 这样从包里取出单个文件也能直接回导。
 * 同名冲突（两个账号昵称相同）会自动补 -2、-3 后缀，否则 zip 里会出现重复条目。
 */
export function buildSplitBundle(
  format: ExportFormat,
  accounts: Account[],
  options: { includeCredentials?: boolean; appVersion?: string; groups?: AccountGroup[] } = {}
): ExportBundle {
  const { includeCredentials = true, appVersion = '1.0.0', groups } = options
  const build = (list: Account[]): string =>
    buildExportContent(format, list, { includeCredentials, appVersion, groups })

  const used = new Set<string>()
  const uniqueName = (name: string): string => {
    if (!used.has(name)) {
      used.add(name)
      return name
    }
    const dot = name.lastIndexOf('.')
    const base = dot > 0 ? name.slice(0, dot) : name
    const ext = dot > 0 ? name.slice(dot) : ''
    for (let i = 2; ; i++) {
      const candidate = `${base}-${i}${ext}`
      if (!used.has(candidate)) {
        used.add(candidate)
        return candidate
      }
    }
  }

  const files = accounts.map((account) => ({
    name: uniqueName(exportFilename(format, [account])),
    content: build([account])
  }))

  // 整批汇总一份，便于一次性回导或肉眼核对；扩展名跟随所选格式
  files.push({ name: uniqueName(`all.${EXPORT_EXTENSION[format]}`), content: build(accounts) })

  return { files }
}
