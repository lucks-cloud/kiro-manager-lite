// Kiro CLI 凭证写入层
//
// Kiro IDE 把 token 存在 ~/.aws/sso/cache/kiro-auth-token.json（见 kiroAuth.ts），
// 而 Kiro CLI（命令行版 `kiro-cli`，KiroCrew 也调它）完全是另一套存储：
//   - macOS：登录钥匙串里的 generic password（account 为空串），data.sqlite3 里的 auth_kv 作镜像
//   - 其它平台：data.sqlite3 的 auth_kv（keychain 不可用时 CLI 本身就回落到它）
// 另外登录方式、当前 profile 这些元信息存在同库的 state 表里。
//
// 只写文件不够：切到社交账号时，CLI 读 state 表的 api.codewhisperer.profile 取 profileArn，
// 缺 profile_name 会让 `kiro-cli chat --list-models` 报 "missing field `profile_name`" →
// KiroCrew 的「加载配置失败 / 只有 1 个模型」。所以三处都要按 CLI 的确切格式写到位。
import { execFile } from 'child_process'
import { existsSync } from 'fs'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { DatabaseSync } from 'node:sqlite'
import { log } from './logger'
import { cleanChildEnv } from './childEnv'
import { KIRO_OIDC_SCOPES, KIRO_START_URL } from './kiroEndpoints'
import { KIRO_SOCIAL_PROFILE_ARN } from './kiroAuth'
import { errorMessage } from '../shared/errors'
import { DEFAULT_REGION } from '../shared/regions'
import type { AuthMethod, IdpType, KiroCliWriteResult } from '../shared/types'

/** CLI 钥匙串 / auth_kv 里的条目名（与 kiro-cli 源码一致） */
const SOCIAL_TOKEN_KEY = 'kirocli:social:token'
const ODIC_TOKEN_KEY = 'kirocli:odic:token'
const ODIC_REG_KEY = 'kirocli:odic:device-registration'
const TOKEN_KEYS = [SOCIAL_TOKEN_KEY, ODIC_TOKEN_KEY, ODIC_REG_KEY]

/** state 表里和登录相关的键 */
const STATE_IDC_START_URL = 'auth.idc.start-url'
const STATE_IDC_REGION = 'auth.idc.region'
const STATE_PROFILE = 'api.codewhisperer.profile'

/** 社交登录在 CLI 侧的固定 profile 名（来自 chat-cli/src/auth/social.rs） */
const SOCIAL_PROFILE_NAME = 'Social_Default_Profile'

const SECURITY_BIN = '/usr/bin/security'

/** kiro-cli 数据目录（各平台约定位置） */
function kiroCliDataDir(): string {
  const home = os.homedir()
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'kiro-cli')
  }
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'kiro-cli')
  }
  return path.join(process.env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'kiro-cli')
}

function kiroCliDbPath(): string {
  return path.join(kiroCliDataDir(), 'data.sqlite3')
}

export interface KiroCliSupportInfo {
  /** 当前平台是否支持写入（仅 macOS / Linux） */
  supported: boolean
  /** 不支持时的原因 */
  reason?: string
  /** data.sqlite3 是否存在（CLI 至少初始化 / 登录过一次） */
  dbExists: boolean
  /** 是否检测到 kiro-cli 可执行文件 */
  cliInstalled: boolean
  /** CLI 数据库路径 */
  dbPath: string
}

/** 可能的 kiro-cli 可执行文件位置，命中第一个存在的 */
function findKiroCliBinary(): string | undefined {
  if (process.platform === 'win32') return undefined
  const home = os.homedir()
  const candidates = [
    path.join(home, '.local', 'bin', 'kiro-cli'),
    '/usr/local/bin/kiro-cli',
    '/opt/homebrew/bin/kiro-cli',
    '/Applications/Kiro CLI.app/Contents/MacOS/kiro-cli'
  ]
  return candidates.find((p) => existsSync(p))
}

/** 当前平台 / 安装情况是否具备写入 kiro-cli 的条件 */
export function kiroCliSupport(): KiroCliSupportInfo {
  const dbPath = kiroCliDbPath()
  const base: Omit<KiroCliSupportInfo, 'supported' | 'reason'> = {
    dbExists: existsSync(dbPath),
    cliInstalled: !!findKiroCliBinary(),
    dbPath
  }
  if (process.platform === 'win32') {
    return { ...base, supported: false, reason: 'Windows 上 kiro-cli 使用凭据管理器存储，暂不支持写入' }
  }
  return { ...base, supported: true }
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
        const code = error && typeof (error as { code?: number }).code === 'number'
          ? (error as { code: number }).code
          : error
            ? 1
            : 0
        resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
      }
    )
  })
}

async function keychainRead(service: string): Promise<string | null> {
  const { code, stdout } = await execCli(SECURITY_BIN, [
    'find-generic-password',
    '-a',
    '',
    '-s',
    service,
    '-w'
  ])
  return code === 0 ? stdout.replace(/\n$/, '') : null
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

async function keychainDelete(service: string): Promise<void> {
  // 不存在（code 44）视为成功
  await execCli(SECURITY_BIN, ['delete-generic-password', '-a', '', '-s', service])
}

// ============ sqlite（auth_kv / state） ============

interface DbSnapshot {
  authKv: Record<string, string>
  state: Record<string, string>
}

/**
 * 打开 CLI 数据库执行一次操作后关闭。
 * data.sqlite3 可能正被运行中的 kiro-cli / KiroCrew 以 WAL 方式打开，
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

/** 读出备份所需的现有凭证镜像与登录 state */
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
  const stamp = new Date()
    .toISOString()
    .replace(/[-:T]/g, '')
    .replace(/\..+/, '')
  const file = path.join(dataDir, `kml-cli-backup-${stamp}.json`)
  await fs.writeFile(file, JSON.stringify(backup, null, 2), { mode: 0o600 })
  await fs.chmod(file, 0o600).catch(() => undefined)
  return file
}

// ============ 校验 ============

/** 运行 kiro-cli 子命令（best-effort），拿不到可执行文件时返回 null */
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
  modelCount?: number
  verifyError?: string
}

/**
 * 写盘后用 kiro-cli 自身校验：
 *  1. whoami 确认身份已被识别（社交登录 email 为 null 属正常）
 *  2. chat --list-models 确认能真正取到模型列表（社交账号缺 profile_name 时这步会失败）
 * 两步都是 best-effort：写盘已完成，校验失败只作提示。
 */
async function verifyWithCli(): Promise<VerifyOutcome> {
  const who = await runKiroCli(['whoami', '-f', 'json'], 25_000)
  if (!who) return { verified: false, verifyError: '未找到 kiro-cli 可执行文件，跳过校验' }

  let accountType: string | undefined
  try {
    accountType = (JSON.parse(who.stdout.trim()) as { accountType?: string }).accountType
  } catch {
    // whoami 没给出可解析的 JSON，继续靠 list-models 判定
  }

  const models = await runKiroCli(['chat', '--list-models'], 40_000)
  if (!models) return { verified: false, accountType, verifyError: '未找到 kiro-cli 可执行文件，跳过校验' }

  const out = `${models.stdout}\n${models.stderr}`
  const modelCount = out.split('\n').filter((l) => /\d+(\.\d+)?x\s+credits/i.test(l)).length
  if (models.code === 0 && modelCount > 0) return { verified: true, accountType, modelCount }

  const errLine =
    out
      .split('\n')
      .map((l) => l.trim())
      .find((l) => /error|unauth|service error|missing field|profilearn/i.test(l)) || ''
  return {
    verified: false,
    accountType,
    modelCount,
    verifyError: errLine.slice(0, 200) || '获取模型列表失败'
  }
}

// ============ 对外：写入 ============

export interface WriteKiroCliInput {
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

/** provider → CLI 社交登录枚举（必须小写，大写会被 serde 判为 unknown variant） */
function socialProvider(provider: IdpType): 'github' | 'google' {
  if (provider === 'Github') return 'github'
  if (provider === 'Google') return 'google'
  throw new Error(`社交登录只支持 Github / Google，收到：${provider}`)
}

/**
 * 把一个账号写入本机 kiro-cli 的凭证存储（钥匙串 + data.sqlite3 + state）。
 * 会先备份现有凭证，再按登录方式写入对应格式，并移除另一种登录方式的残留，
 * 最后用 kiro-cli 自身校验。
 */
export async function writeKiroCliAuth(input: WriteKiroCliInput): Promise<KiroCliWriteResult> {
  const support = kiroCliSupport()
  if (!support.supported) throw new Error(support.reason || 'kiro-cli 不支持当前平台')
  if (!support.dbExists) {
    throw new Error('未找到 kiro-cli 数据库，请先安装并至少运行 / 登录过一次 kiro-cli')
  }

  const dbPath = support.dbPath
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

  // 组装两种登录各自的存储内容
  let socialToken: Record<string, unknown> | null = null
  let odicToken: Record<string, unknown> | null = null
  let odicReg: Record<string, unknown> | null = null

  if (isSocial) {
    const arn = input.profileArn || KIRO_SOCIAL_PROFILE_ARN
    socialToken = {
      access_token: input.accessToken,
      refresh_token: input.refreshToken,
      expires_at: input.expiresAtIso,
      profile_arn: arn,
      provider: socialProvider(input.provider),
      auth_method: 'social'
    }
  } else {
    odicToken = {
      access_token: input.accessToken,
      expires_at: input.expiresAtIso,
      refresh_token: input.refreshToken,
      region,
      start_url: null,
      oauth_flow: 'DeviceCode',
      scopes: KIRO_OIDC_SCOPES
    }
    odicReg = {
      client_id: input.clientId,
      client_secret: input.clientSecret,
      client_secret_expires_at: clientSecretExpiry(),
      region,
      oauth_flow: 'DeviceCode',
      scopes: KIRO_OIDC_SCOPES
    }
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
        JSON.stringify({ arn: input.profileArn || KIRO_SOCIAL_PROFILE_ARN, profile_name: SOCIAL_PROFILE_NAME })
      )
      // 清掉上一个 IdC 登录的激活标记，避免 CLI 仍按 IdC 选凭证
      deleteState(db, STATE_IDC_START_URL)
      deleteState(db, STATE_IDC_REGION)
    } else {
      upsertAuthKv(db, ODIC_TOKEN_KEY, JSON.stringify(odicToken))
      upsertAuthKv(db, ODIC_REG_KEY, JSON.stringify(odicReg))
      deleteAuthKv(db, SOCIAL_TOKEN_KEY)
      // state 值是 JSON 字符串，字符串本身也要再 JSON 一层
      upsertState(db, STATE_IDC_START_URL, JSON.stringify(input.startUrl || KIRO_START_URL))
      upsertState(db, STATE_IDC_REGION, JSON.stringify(region))
      // 清掉社交账号的固定 profile，让 CLI 对 IdC 自行解析
      deleteState(db, STATE_PROFILE)
    }
  })

  log('info', `[KiroCLI] 已写入账号凭证到 kiro-cli（${input.provider} / ${input.authMethod}）`)

  // ---- 校验 ----
  const verify = await verifyWithCli()
  if (verify.accountType) notes.push(`kiro-cli 识别为：${verify.accountType}`)
  if (typeof verify.modelCount === 'number' && verify.modelCount > 0) {
    notes.push(`可用模型 ${verify.modelCount} 个`)
  }
  if (!verify.verified && verify.verifyError) notes.push(`校验未通过：${verify.verifyError}`)

  return {
    dbPath,
    backupPath,
    keychainWritten,
    verified: verify.verified,
    accountType: verify.accountType,
    modelCount: verify.modelCount,
    verifyError: verify.verified ? undefined : verify.verifyError,
    notes
  }
}

/** 读取 kiro-cli 当前登录账号（whoami），用于界面展示；失败返回 null */
export async function readKiroCliWhoami(): Promise<{ accountType?: string; email?: string } | null> {
  const res = await runKiroCli(['whoami', '-f', 'json'], 20_000)
  if (!res || res.code !== 0) return null
  try {
    const data = JSON.parse(res.stdout.trim()) as { accountType?: string; email?: string }
    return { accountType: data.accountType, email: data.email ?? undefined }
  } catch (e) {
    void errorMessage(e)
    return null
  }
}
