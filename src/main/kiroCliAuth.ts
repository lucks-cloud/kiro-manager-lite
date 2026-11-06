// Kiro CLI 凭证写入层
//
// Kiro IDE 把 token 存在 ~/.aws/sso/cache/kiro-auth-token.json（见 kiroAuth.ts），
// 而 Kiro CLI（命令行 `kiro-cli`）用的是另一套存储：
//   - macOS：登录钥匙串里的 generic password（account 为空串），data.sqlite3 的 auth_kv 作镜像
//   - 其它平台：data.sqlite3 的 auth_kv（钥匙串不可用时 CLI 本身就回落到它）
//     Windows 实测（kiro-cli 3.1.0）也是这样：不用凭据管理器，库在 %LOCALAPPDATA%\kiro-cli\data.sqlite3
// 登录方式、当前 profile 这类元信息存在同库的 state 表。
//
// KiroCrew 不保存自己的凭证：它的 Kiro harness 声明 entitlement_source =
// host_identity_store，即「`kiro-cli login` 写入的那套」，登录失败的指引也是让用户去跑
// kiro-cli login。所以写好这里，KiroCrew 一并生效。
//
// 只写 token 不够：切到社交账号时，CLI 读 state 表的 api.codewhisperer.profile 取
// profileArn，缺 profile_name 会让 `kiro-cli chat --list-models` 报
// "missing field `profile_name`"，表现为只能看到 1 个模型。三处都要按 CLI 的格式写到位。
import { execFile } from 'child_process'
import { existsSync } from 'fs'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { DatabaseSync } from 'node:sqlite'
import { log } from './logger'
import { cleanChildEnv } from './childEnv'
import { findBinary } from './proxyClientInstall'
import { KIRO_OIDC_SCOPES, KIRO_START_URL } from './kiroEndpoints'
import { KIRO_SOCIAL_PROFILE_ARN } from './kiroAuth'
import { DEFAULT_REGION } from '../shared/regions'
import type { AuthMethod, IdpType, KiroCliWriteResult } from '../shared/types'

/** 钥匙串 / auth_kv 里的条目名，与 kiro-cli 自身写入的一致 */
const SOCIAL_TOKEN_KEY = 'kirocli:social:token'
const ODIC_TOKEN_KEY = 'kirocli:odic:token'
const ODIC_REG_KEY = 'kirocli:odic:device-registration'
const TOKEN_KEYS = [SOCIAL_TOKEN_KEY, ODIC_TOKEN_KEY, ODIC_REG_KEY]

/** state 表里与登录相关的键 */
const STATE_IDC_START_URL = 'auth.idc.start-url'
const STATE_IDC_REGION = 'auth.idc.region'
const STATE_PROFILE = 'api.codewhisperer.profile'

/** 社交登录在 CLI 侧的固定 profile 名 */
const SOCIAL_PROFILE_NAME = 'Social_Default_Profile'

const SECURITY_BIN = '/usr/bin/security'

/** kiro-cli 数据目录 */
function kiroCliDataDir(): string {
  const home = os.homedir()
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'kiro-cli')
  }
  if (process.platform === 'win32') {
    // 实测 kiro-cli 3.1.0（官方 install.ps1 安装）：程序与 data.sqlite3 都在 %LOCALAPPDATA%\kiro-cli。
    // 只有 %APPDATA%（Roaming）下有、%LOCALAPPDATA% 下没有库时才用前者，兼容可能的旧版本布局。
    const local = path.join(winLocalAppData(), 'kiro-cli')
    const roaming = path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'kiro-cli')
    return existsSync(path.join(local, 'data.sqlite3')) || !existsSync(roaming) ? local : roaming
  }
  return path.join(process.env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'kiro-cli')
}

function winLocalAppData(): string {
  return process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
}

function kiroCliDbPath(): string {
  return path.join(kiroCliDataDir(), 'data.sqlite3')
}

/** 官方安装器的固定落点：GUI 应用继承到的 PATH 里通常没有它们 */
function kiroCliFixedPaths(): string[] {
  if (process.platform === 'win32') {
    // 实测 3.1.0 装在 %LOCALAPPDATA%\kiro-cli\kiro-cli.exe，安装器不会把它加进 PATH；
    // install.ps1 结尾提示的 C:\Program Files\Kiro-Cli\ 作为备选也看一下
    const programFiles = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Kiro-Cli')
    return [
      path.join(winLocalAppData(), 'kiro-cli', 'kiro-cli.exe'),
      path.join(programFiles, 'kiro-cli.exe'),
      path.join(programFiles, 'bin', 'kiro-cli.exe')
    ]
  }
  return [
    path.join(os.homedir(), '.local', 'bin', 'kiro-cli'),
    '/usr/local/bin/kiro-cli',
    '/opt/homebrew/bin/kiro-cli',
    '/Applications/Kiro CLI.app/Contents/MacOS/kiro-cli'
  ]
}

/**
 * kiro-cli 可执行文件位置：先看官方安装器的固定落点，再按 PATH 与常见 bin 目录找。
 * extraDirs 追加在默认目录之后（安装检测会传入从注册表重新读到的最新 PATH）。
 * 写入后的 whoami 校验与登录前的安装检测共用这一份，两边对「装没装」的判断才一致。
 */
export function findKiroCliBinary(extraDirs: string[] = []): string | undefined {
  return kiroCliFixedPaths().find((p) => existsSync(p)) ?? findBinary('kiro-cli', extraDirs) ?? undefined
}

/**
 * kiro-cli 凭证库的位置与是否已存在。三个平台都写这份 data.sqlite3（macOS 另写钥匙串）；
 * 装了 kiro-cli 但从没运行过时还没有这个库，写入前要先让用户运行一次。
 */
export function kiroCliDb(): { dbPath: string; dbExists: boolean } {
  const dbPath = kiroCliDbPath()
  return { dbPath, dbExists: existsSync(dbPath) }
}

/** 写入前的前置检查：没有凭证库时给出可操作的提示 */
export function assertKiroCliDb(): string {
  const { dbPath, dbExists } = kiroCliDb()
  if (!dbExists) {
    throw new Error('未找到 kiro-cli 数据库，请先安装并至少运行 / 登录过一次 kiro-cli')
  }
  return dbPath
}

/**
 * 渲染层请求「打开所在目录」时的白名单：只放行 kiro-cli 数据目录里的文件（凭证库、备份）
 * 和 kiro-cli 可执行文件，其余返回 null。渲染层传来的路径不可信，不能拿去随便定位。
 */
export function kiroCliRevealablePath(target: string): string | null {
  if (!target || typeof target !== 'string') return null
  const resolved = path.resolve(target)
  const rel = path.relative(path.resolve(kiroCliDataDir()), resolved)
  // 数据目录内的文件：相对路径非空、不往上跳、也不是另一个盘符下的绝对路径
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return resolved
  const bin = findKiroCliBinary()
  if (!bin) return null
  const same =
    process.platform === 'win32'
      ? path.resolve(bin).toLowerCase() === resolved.toLowerCase()
      : path.resolve(bin) === resolved
  return same ? resolved : null
}

// ============ 钥匙串（仅 macOS） ============

/** execFile 的 promise 版，不抛错，返回退出码与输出 */
function execCli(
  cmd: string,
  args: string[],
  timeout = 15_000
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { timeout, windowsHide: true, env: cleanChildEnv(), maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code =
          error && typeof (error as { code?: number }).code === 'number'
            ? (error as { code: number }).code
            : error
              ? 1
              : 0
        resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
      }
    )
  })
}

function keychainRead(service: string): Promise<string | null> {
  return execCli(SECURITY_BIN, ['find-generic-password', '-a', '', '-s', service, '-w']).then(
    ({ code, stdout }) => (code === 0 ? stdout.replace(/\n$/, '') : null)
  )
}

async function keychainWrite(service: string, value: string): Promise<void> {
  // -U：存在则更新；account 用空串，与 kiro-cli 自身写入保持一致
  const { code, stderr } = await execCli(SECURITY_BIN, [
    'add-generic-password',
    '-U',
    '-a',
    '',
    '-s',
    service,
    '-w',
    value
  ])
  if (code !== 0) throw new Error(`写入钥匙串 ${service} 失败：${stderr.trim().slice(0, 200)}`)
}

/** 条目不存在（security 返回 44）也视为成功 */
async function keychainDelete(service: string): Promise<void> {
  await execCli(SECURITY_BIN, ['delete-generic-password', '-a', '', '-s', service])
}

// ============ sqlite（auth_kv / state） ============

interface DbSnapshot {
  authKv: Record<string, string>
  state: Record<string, string>
}

/**
 * 打开 CLI 数据库执行一次操作后关闭。
 * data.sqlite3 可能正被运行中的 kiro-cli / KiroCrew 以 WAL 打开，
 * busy_timeout 让并发写入排队而不是直接报 SQLITE_BUSY。
 */
function withDb<T>(dbPath: string, fn: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(dbPath)
  try {
    db.exec('PRAGMA busy_timeout=5000')
    return fn(db)
  } finally {
    db.close()
  }
}

/** 读出备份所需的凭证镜像与登录 state */
function readDbSnapshot(db: DatabaseSync): DbSnapshot {
  const authKv: Record<string, string> = {}
  for (const key of TOKEN_KEYS) {
    const row = db.prepare('SELECT value FROM auth_kv WHERE key = ?').get(key) as
      | { value: string }
      | undefined
    if (row) authKv[key] = row.value
  }
  const state: Record<string, string> = {}
  for (const key of [STATE_IDC_START_URL, STATE_IDC_REGION, STATE_PROFILE]) {
    const row = db.prepare('SELECT value FROM state WHERE key = ?').get(key) as
      | { value: string }
      | undefined
    if (row) state[key] = row.value
  }
  return { authKv, state }
}

function upsertAuthKv(db: DatabaseSync, key: string, value: string): void {
  db.prepare(
    'INSERT INTO auth_kv(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, value)
}

function deleteAuthKv(db: DatabaseSync, key: string): void {
  db.prepare('DELETE FROM auth_kv WHERE key = ?').run(key)
}

/** state 表的值是 JSON 序列化后的字符串（如 "us-east-1" 带引号、profile 为 JSON 对象） */
function upsertState(db: DatabaseSync, key: string, jsonValue: string): void {
  db.prepare(
    'INSERT INTO state(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, jsonValue)
}

function deleteState(db: DatabaseSync, key: string): void {
  db.prepare('DELETE FROM state WHERE key = ?').run(key)
}

// ============ 备份 ============

interface CliAuthBackup {
  writtenAt: number
  account: string
  authKv: Record<string, string>
  state: Record<string, string>
  keychain: Record<string, string | null>
}

/** 改动前把钥匙串 + auth_kv + 相关 state 原样存一份，便于回退 */
async function backupBefore(
  dataDir: string,
  snapshot: DbSnapshot,
  accountLabel: string
): Promise<string> {
  const keychain: Record<string, string | null> = {}
  if (process.platform === 'darwin') {
    for (const key of TOKEN_KEYS) keychain[key] = await keychainRead(key)
  }
  const backup: CliAuthBackup = {
    writtenAt: Date.now(),
    account: accountLabel,
    authKv: snapshot.authKv,
    state: snapshot.state,
    keychain
  }
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').replace(/\..+/, '')
  const file = path.join(dataDir, `kml-cli-backup-${stamp}.json`)
  await fs.writeFile(file, JSON.stringify(backup, null, 2), { mode: 0o600 })
  await fs.chmod(file, 0o600).catch(() => undefined)
  return file
}

// ============ 校验 ============

/** 运行 kiro-cli 子命令（best-effort），没有可执行文件时返回 null */
async function runKiroCli(
  args: string[],
  timeout: number
): Promise<{ code: number; stdout: string; stderr: string } | null> {
  const bin = findKiroCliBinary()
  if (!bin) return null
  return execCli(bin, args, timeout)
}

interface VerifyOutcome {
  verified: boolean
  accountType?: string
  verifyError?: string
}

/**
 * 写盘后用 kiro-cli 的 whoami 确认身份已被识别（社交登录 email 为 null 属正常）。
 *
 * 不跑 `chat --list-models`：那条命令要十几秒到几十秒，而下拉菜单是逐个账号点的，
 * 等待会直接体现在交互上。whoami 足以判断凭证是否被 CLI 接受；
 * 模型列表相关的问题由写入时保证 profile_name 完整来规避。
 */
async function verifyWithCli(): Promise<VerifyOutcome> {
  const who = await runKiroCli(['whoami', '-f', 'json'], 15_000)
  if (!who) return { verified: false, verifyError: '未找到 kiro-cli 可执行文件，跳过校验' }
  if (who.code !== 0) {
    const err = `${who.stdout}\n${who.stderr}`
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 0)
    return { verified: false, verifyError: (err || 'whoami 执行失败').slice(0, 200) }
  }
  try {
    const data = JSON.parse(who.stdout.trim()) as { accountType?: string }
    return { verified: true, accountType: data.accountType }
  } catch {
    // 退出码为 0 即认为凭证被接受，只是输出不是预期的 JSON
    return { verified: true }
  }
}

// ============ 对外：写入 ============

interface WriteKiroCliInput {
  accessToken: string
  refreshToken: string
  /** access token 过期时间（RFC3339） */
  expiresAtIso: string
  authMethod: AuthMethod
  provider: IdpType
  region?: string
  startUrl?: string
  clientId?: string
  clientSecret?: string
  /** 社交登录的固定 profileArn */
  profileArn?: string
}

/** 90 天后的 ISO，去掉毫秒（与 CLI 写客户端注册的格式一致） */
function clientSecretExpiry(): string {
  return new Date(Date.now() + 90 * 24 * 3600 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

/** provider → CLI 社交登录枚举，必须小写，大写会被 serde 判为 unknown variant */
function socialProvider(provider: IdpType): 'github' | 'google' {
  if (provider === 'Github') return 'github'
  if (provider === 'Google') return 'google'
  throw new Error(`社交登录只支持 Github / Google，收到：${provider}`)
}

/**
 * 把一个账号写入本机 kiro-cli 的凭证存储（钥匙串 + data.sqlite3 + state）。
 * 先备份现有凭证，再按登录方式写入对应格式并清掉另一种方式的残留，最后用 whoami 校验。
 */
export async function writeKiroCliAuth(input: WriteKiroCliInput): Promise<KiroCliWriteResult> {
  const dbPath = assertKiroCliDb()
  const dataDir = path.dirname(dbPath)
  const region = input.region || DEFAULT_REGION
  const notes: string[] = []
  const isSocial = input.authMethod === 'social'

  if (!isSocial && (!input.clientId || !input.clientSecret)) {
    throw new Error('IdC / BuilderId 账号需要 clientId 与 clientSecret 才能写入 kiro-cli')
  }

  // 先读快照并备份
  const snapshot = withDb(dbPath, readDbSnapshot)
  const backupPath = await backupBefore(dataDir, snapshot, `${input.provider}/${input.authMethod}`)

  const socialArn = input.profileArn || KIRO_SOCIAL_PROFILE_ARN

  const socialToken = isSocial
    ? {
        access_token: input.accessToken,
        refresh_token: input.refreshToken,
        expires_at: input.expiresAtIso,
        profile_arn: socialArn,
        provider: socialProvider(input.provider),
        auth_method: 'social'
      }
    : null

  const odicToken = isSocial
    ? null
    : {
        access_token: input.accessToken,
        expires_at: input.expiresAtIso,
        refresh_token: input.refreshToken,
        region,
        start_url: null,
        oauth_flow: 'DeviceCode',
        scopes: KIRO_OIDC_SCOPES
      }

  const odicReg = isSocial
    ? null
    : {
        client_id: input.clientId,
        client_secret: input.clientSecret,
        client_secret_expires_at: clientSecretExpiry(),
        region,
        oauth_flow: 'DeviceCode',
        scopes: KIRO_OIDC_SCOPES
      }

  // ---- 钥匙串（macOS）----
  let keychainWritten = false
  if (process.platform === 'darwin') {
    if (isSocial) {
      await keychainWrite(SOCIAL_TOKEN_KEY, JSON.stringify(socialToken))
      await keychainDelete(ODIC_TOKEN_KEY)
      await keychainDelete(ODIC_REG_KEY)
    } else {
      await keychainWrite(ODIC_TOKEN_KEY, JSON.stringify(odicToken))
      await keychainWrite(ODIC_REG_KEY, JSON.stringify(odicReg))
      await keychainDelete(SOCIAL_TOKEN_KEY)
    }
    keychainWritten = true
  } else {
    notes.push('当前平台不写钥匙串，仅写入 data.sqlite3（kiro-cli 会从中读取）')
  }

  // ---- sqlite（auth_kv 镜像 + state）----
  withDb(dbPath, (db) => {
    if (isSocial) {
      upsertAuthKv(db, SOCIAL_TOKEN_KEY, JSON.stringify(socialToken))
      deleteAuthKv(db, ODIC_TOKEN_KEY)
      deleteAuthKv(db, ODIC_REG_KEY)
      // 社交账号取模型列表要靠这条 profile，且 profile_name 必填
      upsertState(
        db,
        STATE_PROFILE,
        JSON.stringify({ arn: socialArn, profile_name: SOCIAL_PROFILE_NAME })
      )
      // 清掉上一个 IdC 登录的激活标记，避免 CLI 仍按 IdC 选凭证
      deleteState(db, STATE_IDC_START_URL)
      deleteState(db, STATE_IDC_REGION)
    } else {
      upsertAuthKv(db, ODIC_TOKEN_KEY, JSON.stringify(odicToken))
      upsertAuthKv(db, ODIC_REG_KEY, JSON.stringify(odicReg))
      deleteAuthKv(db, SOCIAL_TOKEN_KEY)
      // state 的值是 JSON 字符串，字符串本身也要再 JSON 一层
      upsertState(db, STATE_IDC_START_URL, JSON.stringify(input.startUrl || KIRO_START_URL))
      upsertState(db, STATE_IDC_REGION, JSON.stringify(region))
      // 清掉社交账号的固定 profile，让 CLI 对 IdC 自行解析
      deleteState(db, STATE_PROFILE)
    }
  })

  log('info', `[KiroCLI] 已写入账号凭证（${input.provider} / ${input.authMethod}）`)

  const verify = await verifyWithCli()
  if (verify.accountType) notes.push(`kiro-cli 识别为：${verify.accountType}`)
  if (!verify.verified && verify.verifyError) notes.push(`校验未通过：${verify.verifyError}`)

  return {
    dbPath,
    backupPath,
    keychainWritten,
    verified: verify.verified,
    accountType: verify.accountType,
    verifyError: verify.verified ? undefined : verify.verifyError,
    notes
  }
}

/** 读取 kiro-cli 当前登录账号（whoami），用于界面展示；失败返回 null */
async function readKiroCliWhoami(): Promise<{
  accountType?: string
  email?: string
} | null> {
  const res = await runKiroCli(['whoami', '-f', 'json'], 15_000)
  if (!res || res.code !== 0) return null
  try {
    const data = JSON.parse(res.stdout.trim()) as { accountType?: string; email?: string }
    return { accountType: data.accountType, email: data.email ?? undefined }
  } catch {
    return null
  }
}

/** 从一段 token JSON 里取 refresh_token */
function refreshTokenOf(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined
  try {
    const parsed = JSON.parse(raw) as { refresh_token?: string }
    return parsed.refresh_token || undefined
  } catch {
    return undefined
  }
}

/**
 * 读 kiro-cli 当前凭证里的 refresh_token，用于反向匹配到已管理账号。
 * macOS 优先读钥匙串（CLI 的事实源），再回落到 data.sqlite3 的 auth_kv 镜像。
 */
async function readKiroCliRefreshToken(): Promise<string | undefined> {
  const candidates: (string | null | undefined)[] = []
  if (process.platform === 'darwin') {
    candidates.push(await keychainRead(SOCIAL_TOKEN_KEY), await keychainRead(ODIC_TOKEN_KEY))
  }
  const { dbPath, dbExists } = kiroCliDb()
  if (dbExists) {
    const fromDb = withDb(dbPath, (db) => {
      const out: (string | undefined)[] = []
      for (const key of [SOCIAL_TOKEN_KEY, ODIC_TOKEN_KEY]) {
        const row = db.prepare('SELECT value FROM auth_kv WHERE key = ?').get(key) as
          | { value: string }
          | undefined
        out.push(row?.value)
      }
      return out
    })
    candidates.push(...fromDb)
  }
  for (const raw of candidates) {
    const token = refreshTokenOf(raw)
    if (token) return token
  }
  return undefined
}

/**
 * 读取 Kiro CLI / KiroCrew 当前登录账号：whoami（展示）+ 凭证库里的 refresh_token（匹配）。
 * 两者都拿不到时返回 null（未登录或未安装）。
 */
export async function readKiroCliActive(): Promise<{
  accountType?: string
  email?: string
  refreshToken?: string
} | null> {
  const [who, refreshToken] = await Promise.all([readKiroCliWhoami(), readKiroCliRefreshToken()])
  if (!who && !refreshToken) return null
  return { accountType: who?.accountType, email: who?.email, refreshToken }
}

/**
 * 退出 Kiro CLI / KiroCrew 登录：清掉钥匙串里的 token 条目 + data.sqlite3 的
 * auth_kv 镜像与登录相关 state。已运行的 kiro-cli / KiroCrew 下次读取时即为未登录。
 */
export async function logoutKiroCli(): Promise<{ cleared: boolean; keychainCleared: boolean }> {
  const { dbPath, dbExists } = kiroCliDb()
  let keychainCleared = false
  if (process.platform === 'darwin') {
    for (const key of TOKEN_KEYS) await keychainDelete(key)
    keychainCleared = true
  }
  if (dbExists) {
    withDb(dbPath, (db) => {
      for (const key of TOKEN_KEYS) deleteAuthKv(db, key)
      for (const key of [STATE_IDC_START_URL, STATE_IDC_REGION, STATE_PROFILE]) deleteState(db, key)
    })
  }
  log('info', '[KiroCLI] 已退出 kiro-cli 登录（清理钥匙串与 data.sqlite3 凭证）')
  return { cleared: true, keychainCleared }
}
