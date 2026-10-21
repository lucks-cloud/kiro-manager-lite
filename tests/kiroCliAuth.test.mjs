import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { after, afterEach, test } from 'node:test'
import ts from 'typescript'

// Compile the one main-process module without launching Electron or touching
// the user's CLI database/Keychain. Works on the project's Node 22 runtime.
const moduleDir = mkdtempSync(join(tmpdir(), 'kiro-cli-auth-module-'))
const source = readFileSync(fileURLToPath(new URL('../src/main/kiroCliAuth.ts', import.meta.url)), 'utf8')
const output = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
}).outputText
const modulePath = join(moduleDir, 'kiroCliAuth.mjs')
writeFileSync(modulePath, output)
const { syncKiroCliAuth } = await import(pathToFileURL(modulePath).href)
after(() => rmSync(moduleDir, { recursive: true, force: true }))

const dirs = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'kiro-cli-auth-test-'))
  dirs.push(dir)
  const dbPath = join(dir, 'data.sqlite3')
  const db = new DatabaseSync(dbPath)
  db.exec('CREATE TABLE auth_kv (key TEXT PRIMARY KEY, value TEXT); CREATE TABLE state (key TEXT PRIMARY KEY, value TEXT)')
  return { db, dbPath }
}

const social = {
  accessToken: 'test-access',
  refreshToken: 'test-refresh',
  expiresAtIso: '2027-01-01T00:00:00.000Z',
  authMethod: 'social',
  provider: 'Google',
  region: 'us-east-1',
  profileArn: 'arn:aws:codewhisperer:us-east-1:123:profile/test'
}

test('social switch updates CLI database and removes the legacy Keychain item', async () => {
  const { db, dbPath } = fixture()
  db.prepare('INSERT INTO auth_kv VALUES (?, ?)').run('kirocli:odic:token', '{"refresh_token":"old"}')
  db.prepare('INSERT INTO auth_kv VALUES (?, ?)').run('unrelated', 'keep')
  let keychainCleared = false
  const result = await syncKiroCliAuth(social, undefined, {
    dbPath,
    clearKeychain: async () => { keychainCleared = true }
  })
  assert.deepEqual(result, { synced: true })
  const token = JSON.parse(db.prepare("SELECT value FROM auth_kv WHERE key='kirocli:social:token'").get().value)
  assert.equal(token.access_token, social.accessToken)
  assert.equal(token.refresh_token, social.refreshToken)
  assert.equal(token.expires_at, social.expiresAtIso)
  assert.equal(keychainCleared, true)
  assert.equal(db.prepare("SELECT value FROM auth_kv WHERE key='kirocli:odic:token'").get(), undefined)
  assert.equal(db.prepare("SELECT value FROM auth_kv WHERE key='unrelated'").get().value, 'keep')
  const profile = JSON.parse(db.prepare("SELECT value FROM state WHERE key='api.codewhisperer.profile'").get().value)
  assert.equal(profile.profile_name, 'Social_Default_Profile')
  assert.equal(profile.profileName, undefined)
  db.close()
})

test('background refresh skips a different CLI account', async () => {
  const { db, dbPath } = fixture()
  db.prepare('INSERT INTO auth_kv VALUES (?, ?)').run('kirocli:social:token', '{"refresh_token":"other-account"}')
  let keychainCalled = false
  const result = await syncKiroCliAuth(social, 'previous-refresh', {
    dbPath,
    clearKeychain: async () => { keychainCalled = true }
  })
  assert.equal(result.synced, false)
  assert.equal(keychainCalled, false)
  assert.equal(JSON.parse(db.prepare("SELECT value FROM auth_kv WHERE key='kirocli:social:token'").get().value).refresh_token, 'other-account')
  db.close()
})

test('switch removes conflicting camelCase token aliases and a stale profile', async () => {
  const { db, dbPath } = fixture()
  db.prepare('INSERT INTO auth_kv VALUES (?, ?)').run('kirocli:social:token', JSON.stringify({
    accessToken: 'old-access', refreshToken: 'old-refresh',
    profile_arn: 'old-profile', retained: 'cli-field'
  }))
  const result = await syncKiroCliAuth({ ...social, profileArn: undefined }, undefined, {
    dbPath,
    clearKeychain: async () => undefined
  })
  assert.equal(result.synced, true)
  const token = JSON.parse(db.prepare("SELECT value FROM auth_kv WHERE key='kirocli:social:token'").get().value)
  assert.equal(token.accessToken, undefined)
  assert.equal(token.refreshToken, undefined)
  assert.equal(token.profile_arn, undefined)
  assert.equal(token.access_token, social.accessToken)
  assert.equal(token.retained, 'cli-field')
  db.close()
})

test('Keychain cleanup failure rolls back SQLite changes', async () => {
  const { db, dbPath } = fixture()
  db.prepare('INSERT INTO auth_kv VALUES (?, ?)').run('kirocli:social:token', '{"refresh_token":"old"}')
  const result = await syncKiroCliAuth(social, undefined, {
    dbPath,
    clearKeychain: async () => { throw new Error('test Keychain failure') }
  })
  assert.equal(result.synced, false)
  assert.equal(JSON.parse(db.prepare("SELECT value FROM auth_kv WHERE key='kirocli:social:token'").get().value).refresh_token, 'old')
  assert.equal(db.prepare("SELECT value FROM state WHERE key='api.codewhisperer.profile'").get(), undefined)
  db.close()
})

test('OIDC switch writes client registration and clears old social Keychain item', async () => {
  const { db, dbPath } = fixture()
  let keychainCleared = false
  const result = await syncKiroCliAuth({
    ...social,
    authMethod: 'IdC',
    provider: 'BuilderId',
    clientId: 'test-client-id',
    clientSecret: 'test-client-secret'
  }, undefined, {
    dbPath,
    clearKeychain: async () => { keychainCleared = true }
  })
  assert.equal(result.synced, true)
  assert.equal(keychainCleared, true)
  const reg = JSON.parse(db.prepare("SELECT value FROM auth_kv WHERE key='kirocli:odic:device-registration'").get().value)
  assert.equal(reg.client_id, 'test-client-id')
  assert.equal(reg.client_secret, 'test-client-secret')
  db.close()
})
