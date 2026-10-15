// Kiro CLI keeps its session separately from the IDE. On macOS its v1 chat
// engine can use the SQLite session without a Keychain item (verified with
// kiro-cli 2.24.1). The v2 engine currently rejects this synchronized session.
// Remove a legacy social Keychain item so it cannot override the selected
// SQLite account. Never pass tokens to a subprocess or log them.
import { spawn } from 'node:child_process'
import { existsSync, lstatSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { platform } from 'node:process'
import { DatabaseSync } from 'node:sqlite'
import type { AuthMethod, IdpType } from '../shared/types'

const SOCIAL_KEY = 'kirocli:social:token'
const OIDC_KEY = 'kirocli:odic:token' // The CLI spells this key "odic".
const REGISTRATION_KEY = 'kirocli:odic:device-registration'
const PROFILE_KEY = 'api.codewhisperer.profile'

export interface CliAuthInput {
  accessToken: string
  refreshToken: string
  expiresAtIso: string
  authMethod: AuthMethod
  provider: IdpType
  region: string
  profileArn?: string
  clientId?: string
  clientSecret?: string
}

export interface CliSyncResult {
  synced: boolean
  /** A clear reason for a partial IDE/CLI switch; never contains credentials. */
  error?: string
}

/** Injection is used by isolated tests; normal callers use the installed CLI. */
export interface CliAuthStorage {
  dbPath?: string
  clearKeychain?: () => Promise<void>
}

function databasePath(): string | null {
  if (platform === 'darwin')
    return join(homedir(), 'Library', 'Application Support', 'kiro-cli', 'data.sqlite3')
  return null
}

function runSecurity(args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/security', args, { stdio: 'ignore' })
    child.on('error', reject)
    child.on('close', (code) => resolve(code ?? 1))
  })
}

async function clearSocialKeychain(): Promise<void> {
  const code = await runSecurity(['delete-generic-password', '-s', SOCIAL_KEY, '-a', ''])
  // security exits 44 when the item is already absent.
  if (code !== 0 && code !== 44)
    throw new Error('无法清理 Kiro CLI 旧的 macOS 钥匙串凭证')
}

function row(db: DatabaseSync, table: 'auth_kv' | 'state', key: string): string | null {
  const found = db.prepare(`SELECT value FROM ${table} WHERE key = ?`).get(key) as
    | { value: string }
    | undefined
  return found?.value ?? null
}

function upsert(db: DatabaseSync, table: 'auth_kv' | 'state', key: string, value: unknown): void {
  db.prepare(`INSERT OR REPLACE INTO ${table}(key, value) VALUES(?, ?)`).run(key, JSON.stringify(value))
}

function parseToken(value: string | null): Record<string, unknown> | null {
  if (!value) return null
  try {
    const parsed: unknown = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

/**
 * Write exactly the credentials already refreshed for the IDE. When called
 * after background renewal, only update a CLI session that still has the old
 * (or already updated) refresh token; never hijack another CLI account.
 */
export async function syncKiroCliAuth(
  input: CliAuthInput,
  previousRefreshToken?: string,
  storage?: CliAuthStorage
): Promise<CliSyncResult> {
  if (platform !== 'darwin')
    return { synced: false, error: 'CLI 同步目前只支持 macOS' }
  let db: DatabaseSync | undefined
  try {
    const path = storage?.dbPath ?? databasePath()
    if (!path || !existsSync(path) || !lstatSync(path).isFile())
      return { synced: false, error: '未找到 Kiro CLI 的本地会话数据库' }
    if (!input.accessToken || !input.refreshToken)
      return { synced: false, error: '账号缺少 CLI 所需的 Token' }
    if (input.authMethod !== 'social' && (!input.clientId || !input.clientSecret))
      return { synced: false, error: '账号缺少 CLI 所需的客户端注册信息' }

    db = new DatabaseSync(path)
    db.exec('PRAGMA busy_timeout = 5000')
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('auth_kv','state')").all() as { name: string }[]
    if (tables.length !== 2) throw new Error('Kiro CLI 数据库结构不兼容')
    const key = input.authMethod === 'social' ? SOCIAL_KEY : OIDC_KEY
    const old = parseToken(row(db, 'auth_kv', key))
    if (previousRefreshToken) {
      const current = old?.refresh_token ?? old?.refreshToken
      if (current !== previousRefreshToken && current !== input.refreshToken)
        return { synced: false, error: 'CLI 当前不是这个账号，已跳过凭证续期' }
    }

    // Preserve CLI-specific fields from an existing session, but replace all
    // rotated token fields with the same values written to the IDE.
    const token: Record<string, unknown> = { ...old }
    for (const alias of ['accessToken', 'refreshToken', 'expiresAt', 'profileArn', 'profile_arn'])
      delete token[alias]
    Object.assign(token, {
      access_token: input.accessToken,
      refresh_token: input.refreshToken,
      expires_at: input.expiresAtIso,
      provider: input.provider,
      region: input.region
    })
    if (input.profileArn) token.profile_arn = input.profileArn
    db.exec('BEGIN IMMEDIATE')
    try {
      db.prepare('DELETE FROM auth_kv WHERE key IN (?, ?, ?)').run(
        SOCIAL_KEY, OIDC_KEY, 'kirocli:external-idp:token'
      )
      db.prepare('DELETE FROM auth_kv WHERE key = ?').run(REGISTRATION_KEY)
      upsert(db, 'auth_kv', key, token)
      if (input.authMethod !== 'social') {
        upsert(db, 'auth_kv', REGISTRATION_KEY, {
          client_id: input.clientId,
          client_secret: input.clientSecret,
          region: input.region
        })
      }
      if (input.profileArn) {
        upsert(db, 'state', PROFILE_KEY, {
          arn: input.profileArn,
          profile_name: input.authMethod === 'social' ? 'Social_Default_Profile' : 'Default_Profile'
        })
      } else {
        db.prepare('DELETE FROM state WHERE key = ?').run(PROFILE_KEY)
      }
      await (storage?.clearKeychain ?? clearSocialKeychain)()
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
    return { synced: true }
  } catch (error) {
    return { synced: false, error: error instanceof Error ? error.message : 'CLI 凭证同步失败' }
  } finally {
    try { db?.close() } catch { /* A close failure must not discard rotated tokens. */ }
  }
}
