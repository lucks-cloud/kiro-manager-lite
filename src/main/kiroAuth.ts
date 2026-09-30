// Kiro IDE 凭证文件同步层
//
// Kiro IDE 把 token 持久化在 ~/.aws/sso/cache/kiro-auth-token.json 并自行做 refresh loop。
// 切号 / 刷新时必须以这个文件为唯一事实源，否则 IDE 会拿着被服务端轮换作废的旧
// refreshToken 去调 OIDC，拿到 401 后直接把用户登出。
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import * as crypto from 'crypto'
import { KIRO_OIDC_SCOPES, KIRO_START_URL, serviceRegion } from './kiroEndpoints'
import { pushUnique } from './utils'
import { DEFAULT_REGION } from '../shared/regions'
import type { AuthMethod, IdpType, LocalKiroCredentials } from '../shared/types'

const KIRO_SSO_CACHE_DIR = path.join(os.homedir(), '.aws', 'sso', 'cache')
const KIRO_AUTH_TOKEN_FILE = 'kiro-auth-token.json'
const KIRO_AUTH_TOKEN_PATH = path.join(KIRO_SSO_CACHE_DIR, KIRO_AUTH_TOKEN_FILE)

/**
 * Kiro IDE 源码里给 BuilderId 硬编码的占位符 ARN。
 *
 * 两个用途，别混：IDE 内部逻辑依赖 token 文件里存在该字段；
 * 而 runtime 接口（getUsageLimits / ListAvailableModels）也把 profileArn 当必填，
 * BuilderId 账号必须原样带上它才回 200，不带就是
 * 403 "User is not authorized to make this call."。
 */
export const KIRO_BUILDER_ID_PLACEHOLDER_ARN =
  'arn:aws:codewhisperer:us-east-1:638616132270:profile/AAAACCCCXXXX'
// Github / Google 社交登录共用的固定 profileArn
export const KIRO_SOCIAL_PROFILE_ARN =
  'arn:aws:codewhisperer:us-east-1:699475941385:profile/EHGA3GRVQMUK'

const ENTERPRISE_FALLBACK = { accountId: '610548660232', profileId: 'VNECVYCYYAWN' }

function enterpriseFallbackArn(region?: string): string {
  const { accountId, profileId } = ENTERPRISE_FALLBACK
  return `arn:aws:codewhisperer:${serviceRegion(region)}:${accountId}:profile/${profileId}`
}

/** 社交登录（Github / Google）没有 profile 概念，后端认一个固定 ARN */
export function isSocialLogin(input: { authMethod?: string; provider?: string }): boolean {
  return (
    input.authMethod === 'social' || input.provider === 'Github' || input.provider === 'Google'
  )
}

function isPlaceholderArn(arn?: string | null): boolean {
  return arn === KIRO_BUILDER_ID_PLACEHOLDER_ARN
}

/**
 * 决定写入磁盘时该用哪个 profileArn。
 * 取候选里第一个有值的项，优先级规则与 profileArnCandidates 保持同一份实现。
 */
export function resolveProfileArn(input: {
  profileArn?: string
  authMethod?: string
  provider?: string
  region?: string
}): string {
  return (
    profileArnCandidates(input).find((arn): arn is string => !!arn) ??
    KIRO_BUILDER_ID_PLACEHOLDER_ARN
  )
}

/**
 * 按优先级给出「写盘时可以依次尝试」的 profileArn 候选。
 *
 * profileArn 写错是 IDE 报 “Unable to fetch account usage data: Invalid token /
 * User is not authorized” 的常见原因：Enterprise 账号必须用它自己 profile 的 ARN，
 * 而 BuilderId 根本没有 profile 概念，带上任何 ARN 都可能被拒。
 * 所以这里给出多个候选，由调用方逐个实测后再写盘。
 */
export function profileArnCandidates(input: {
  profileArn?: string
  authMethod?: string
  provider?: string
  region?: string
}): (string | undefined)[] {
  const out: (string | undefined)[] = []
  if (input.profileArn && !isPlaceholderArn(input.profileArn)) pushUnique(out, input.profileArn)

  // 社交账号后端固定一个 profile，且该字段必填，没有「不带」这个选项
  if (isSocialLogin(input)) {
    pushUnique(out, KIRO_SOCIAL_PROFILE_ARN)
    return out
  }

  // Enterprise 用兜底 ARN，BuilderId / 其它 IdC 按 IDE 原生行为写占位符；都不行就干脆不带
  pushUnique(
    out,
    input.provider === 'Enterprise'
      ? enterpriseFallbackArn(input.region)
      : KIRO_BUILDER_ID_PLACEHOLDER_ARN
  )
  pushUnique(out, undefined)
  return out
}

/**
 * 剥掉 BuilderId 占位符 ARN，只保留真实可用的 ARN。
 *
 * 仅供控制面（CreateApiKey / ListApiKeys）挑候选使用。
 *
 * 切勿用在用量接口上：getUsageLimits 把 profileArn 当必填，
 * BuilderId 恰恰要带这个占位符才回 200，剥掉就是
 * 403 "User is not authorized to make this call."。用量那边走 usageProfileArn。
 */
export function arnForApiCall(arn?: string): string | undefined {
  return arn && !isPlaceholderArn(arn) ? arn : undefined
}

export interface KiroAuthTokenFile {
  accessToken: string
  refreshToken: string
  expiresAt: string
  authMethod?: string
  provider?: string
  region?: string
  clientIdHash?: string
  profileArn?: string
}

function computeClientIdHash(startUrl?: string): string {
  return crypto
    .createHash('sha1')
    .update(JSON.stringify({ startUrl: startUrl || KIRO_START_URL }))
    .digest('hex')
}

/** 列出 sso cache 目录下的文件，目录不存在时给空列表 */
function listCacheFiles(): Promise<string[]> {
  return fs.readdir(KIRO_SSO_CACHE_DIR).catch(() => [] as string[])
}

/**
 * 删除 sso cache 里符合条件的文件，返回删除数量。
 * 删不掉的（占用、权限）跳过，不影响其它文件与后续写入。
 */
async function deleteCacheFiles(
  shouldDelete: (fileName: string) => boolean,
  onError?: (fileName: string, error: unknown) => void
): Promise<number> {
  let deleted = 0
  for (const file of await listCacheFiles()) {
    if (!shouldDelete(file)) continue
    try {
      await fs.unlink(path.join(KIRO_SSO_CACHE_DIR, file))
      deleted++
    } catch (e) {
      onError?.(file, e)
    }
  }
  return deleted
}

export interface WriteTokenInput {
  accessToken: string
  refreshToken: string
  expiresAtIso: string
  authMethod: AuthMethod
  provider: IdpType
  region?: string
  startUrl?: string
  clientId?: string
  clientSecret?: string
  profileArn?: string
  /** 写完后删掉 sso cache 里其它陈旧的客户端注册文件 */
  pruneStaleRegistrations?: boolean
}

/**
 * 写入仅本人可读的 JSON 文件。
 * writeFile 的 mode 只在新建时生效，已存在的文件要再 chmod 一次。
 */
async function writePrivateJson(filePath: string, data: unknown): Promise<void> {
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), { mode: 0o600 })
  await fs.chmod(filePath, 0o600).catch(() => undefined)
}

/**
 * 删除 sso cache 里除当前注册文件之外的其它 *.json。
 * 上一个账号留下的客户端注册文件会让 IDE 用错 clientId/secret 去刷新，
 * 刷新失败后 IDE 直接把用户登出，所以切号时顺手清掉。
 */
function pruneStaleClientRegistrations(keepFileName?: string): Promise<number> {
  return deleteCacheFiles(
    (file) =>
      file.endsWith('.json') && file !== KIRO_AUTH_TOKEN_FILE && file !== keepFileName
  )
}

/** 以 Kiro IDE 兼容格式写入 token（IdC 额外写客户端注册文件） */
export async function writeKiroAuthToken(
  input: WriteTokenInput
): Promise<{ tokenPath: string; clientRegPath?: string; prunedRegistrations: number }> {
  await fs.mkdir(KIRO_SSO_CACHE_DIR, { recursive: true })
  const clientIdHash = computeClientIdHash(input.startUrl)

  const tokenData: Record<string, unknown> =
    input.authMethod === 'social'
      ? {
          accessToken: input.accessToken,
          refreshToken: input.refreshToken,
          profileArn: input.profileArn,
          expiresAt: input.expiresAtIso,
          authMethod: input.authMethod,
          provider: input.provider
        }
      : {
          accessToken: input.accessToken,
          refreshToken: input.refreshToken,
          expiresAt: input.expiresAtIso,
          clientIdHash,
          authMethod: input.authMethod,
          provider: input.provider,
          region: input.region || DEFAULT_REGION,
          profileArn: input.profileArn
        }

  // profileArn 为空时不写该字段：BuilderId 带上无效 ARN 会被接口拒掉
  if (!input.profileArn) delete tokenData.profileArn

  await writePrivateJson(KIRO_AUTH_TOKEN_PATH, tokenData)

  let clientRegPath: string | undefined
  let regFileName: string | undefined
  if (input.authMethod !== 'social' && input.clientId && input.clientSecret) {
    regFileName = `${clientIdHash}.json`
    clientRegPath = path.join(KIRO_SSO_CACHE_DIR, regFileName)
    // IDE 客户端注册有效期 90 天，且格式为去掉 Z 的 ISO 字符串
    const expiresAt = new Date(Date.now() + 90 * 24 * 3600 * 1000).toISOString().replace('Z', '')
    await writePrivateJson(clientRegPath, {
      clientId: input.clientId,
      clientSecret: input.clientSecret,
      expiresAt,
      scopes: KIRO_OIDC_SCOPES
    })
  }

  const prunedRegistrations = input.pruneStaleRegistrations
    ? await pruneStaleClientRegistrations(regFileName)
    : 0

  return { tokenPath: KIRO_AUTH_TOKEN_PATH, clientRegPath, prunedRegistrations }
}

export async function readKiroAuthToken(): Promise<KiroAuthTokenFile | null> {
  try {
    const raw = await fs.readFile(KIRO_AUTH_TOKEN_PATH, 'utf-8')
    const parsed = JSON.parse(raw) as KiroAuthTokenFile
    if (!parsed.accessToken || !parsed.refreshToken) return null
    return parsed
  } catch {
    return null
  }
}

interface ClientRegistration {
  clientId?: string
  clientSecret?: string
}

async function readCacheJson(fileName: string): Promise<ClientRegistration | null> {
  try {
    return JSON.parse(await fs.readFile(path.join(KIRO_SSO_CACHE_DIR, fileName), 'utf-8'))
  } catch {
    return null
  }
}

/** 找出 IdC 的客户端注册（clientId / clientSecret）：先按 hash 命中，再扫描兜底 */
async function findClientRegistration(clientIdHash?: string): Promise<ClientRegistration | null> {
  const primary = await readCacheJson(`${clientIdHash || computeClientIdHash()}.json`)
  if (primary?.clientId && primary.clientSecret) return primary

  for (const file of await listCacheFiles()) {
    if (!file.endsWith('.json') || file === KIRO_AUTH_TOKEN_FILE) continue
    const data = await readCacheJson(file)
    if (data?.clientId && data.clientSecret) return data
  }
  return null
}

/** 读取本地 Kiro IDE 已登录的完整凭证（含 IdC 客户端注册） */
export async function readLocalKiroCredentials(): Promise<LocalKiroCredentials | { error: string }> {
  const token = await readKiroAuthToken()
  if (!token) {
    return { error: '找不到 kiro-auth-token.json 或缺少 refreshToken，请先在 Kiro IDE 中登录' }
  }

  const isSocial = token.authMethod === 'social'
  let clientId = ''
  let clientSecret = ''

  if (!isSocial) {
    const reg = await findClientRegistration(token.clientIdHash)
    if (!reg?.clientId || !reg.clientSecret) {
      return { error: '找不到客户端注册文件，请确认已在 Kiro IDE 中完成登录' }
    }
    clientId = reg.clientId
    clientSecret = reg.clientSecret
  }

  return {
    accessToken: token.accessToken,
    refreshToken: token.refreshToken,
    clientId,
    clientSecret,
    region: token.region || DEFAULT_REGION,
    authMethod: isSocial ? 'social' : 'IdC',
    provider: (token.provider as IdpType) || 'BuilderId'
  }
}

/** 清空 SSO 缓存目录（IDE 退出登录） */
export function clearKiroSsoCache(): Promise<number> {
  return deleteCacheFiles(
    () => true,
    (file, e) => console.warn('[KiroAuth] failed to delete', file, e)
  )
}
