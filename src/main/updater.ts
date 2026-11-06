// 检查更新：只读 GitHub Releases 的最新版本号做对比，不做自动下载安装
import { app } from 'electron'
import { httpRequest } from './net'
import { sleep } from './utils'
import { errorMessage } from '../shared/errors'
import type { UpdateCheckResult } from '../shared/types'

const REPO = 'lucks-cloud/kiro-manager-lite'
const LATEST_API = `https://api.github.com/repos/${REPO}/releases/latest`
const LATEST_PAGE = `https://github.com/${REPO}/releases/latest`
/** 「前往更新」统一落到 Releases 列表页，方便用户自己挑平台安装包与历史版本 */
const RELEASES_PAGE = `https://github.com/${REPO}/releases`

interface GithubRelease {
  tag_name?: string
  name?: string
  body?: string
  published_at?: string
}

/** 去掉 tag 常见前缀，`v1.0.3` / `V1.0.3` / `release-1.0.3` 都归一成 `1.0.3` */
function normalizeVersion(raw: string): string {
  return (raw || '').trim().replace(/^(v|version|release)[-_\s]*/i, '')
}

/**
 * 语义化版本比较，返回 a-b 的符号。
 * 数字段逐位比较；带 -beta 之类预发布标记的一方在数字段相同时视为更旧。
 */
function compareVersions(a: string, b: string): number {
  const split = (v: string): { nums: number[]; pre: string } => {
    const [core, ...rest] = normalizeVersion(v).split('-')
    return {
      nums: core.split('.').map((n) => Number.parseInt(n, 10) || 0),
      pre: rest.join('-')
    }
  }
  const left = split(a)
  const right = split(b)
  const len = Math.max(left.nums.length, right.nums.length)
  for (let i = 0; i < len; i++) {
    const diff = (left.nums[i] ?? 0) - (right.nums[i] ?? 0)
    if (diff !== 0) return diff > 0 ? 1 : -1
  }
  if (left.pre === right.pre) return 0
  if (!left.pre) return 1
  if (!right.pre) return -1
  return left.pre > right.pre ? 1 : -1
}

class UpdateSourceError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    /** false 表示结果是确定性的，不应再尝试页面兜底。 */
    readonly allowFallback = true
  ) {
    super(message)
    this.name = 'UpdateSourceError'
  }
}

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504])
const API_ATTEMPTS = 2
let inFlight: Promise<UpdateCheckResult> | null = null

function resultOf(
  current: string,
  latest: string,
  release?: GithubRelease
): UpdateCheckResult {
  return {
    current,
    latest,
    hasUpdate: compareVersions(latest, current) > 0,
    releaseUrl: RELEASES_PAGE,
    name: release?.name || release?.tag_name || latest,
    notes: (release?.body || '').trim(),
    publishedAt: release?.published_at || ''
  }
}

function nestedErrorCode(error: unknown): string {
  let current = error
  const visited = new Set<unknown>()
  while (current && typeof current === 'object' && !visited.has(current)) {
    visited.add(current)
    const item = current as { code?: unknown; cause?: unknown }
    if (typeof item.code === 'string' && item.code) return item.code
    current = item.cause
  }
  return ''
}

function isRetryableTransport(error: unknown): boolean {
  const text = `${errorMessage(error)} ${nestedErrorCode(error)}`
  return /fetch failed|abort|timeout|timed out|ECONN|ENOTFOUND|EAI_AGAIN|socket|network|TLS|UND_ERR/i.test(text)
}

function friendlyNetworkError(error: unknown): Error {
  const code = nestedErrorCode(error)
  const raw = errorMessage(error)
  if (/abort|timeout|timed out|UND_ERR_CONNECT_TIMEOUT/i.test(`${raw} ${code}`)) {
    return new Error('连接 GitHub 超时，请检查网络或代理设置后重试')
  }
  if (isRetryableTransport(error)) {
    return new Error(`无法连接 GitHub，请检查网络或代理设置${code ? `（${code}）` : ''}`)
  }
  return new Error(raw || '检查更新失败，请稍后重试')
}

async function checkViaApi(current: string): Promise<UpdateCheckResult> {
  const res = await httpRequest(LATEST_API, {
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      // GitHub API 拒绝没有 UA 的请求
      'User-Agent': `kiro-manager-lite/${current}`
    },
    timeoutMs: 10_000
  })

  if (!res.ok) {
    if (res.status === 404) {
      throw new UpdateSourceError('仓库还没有发布任何版本', false, false)
    }
    if (res.status === 403) {
      throw new UpdateSourceError('GitHub 接口访问频率受限', false)
    }
    throw new UpdateSourceError(
      `GitHub 接口返回 ${res.status}`,
      RETRYABLE_STATUS.has(res.status)
    )
  }

  const release = await res.json<GithubRelease>()
  const latest = normalizeVersion(release.tag_name || '')
  if (!latest) throw new UpdateSourceError('未能解析 GitHub API 返回的版本号', false)
  return resultOf(current, latest, release)
}

/**
 * API 不可用时访问 Releases 的 /latest 跳转地址。
 * GitHub 会把它重定向到 /releases/tag/vX.Y.Z，从最终 URL 即可得到版本号，
 * 不需要脆弱地解析整页 HTML，也不消耗 GitHub API 额度。
 */
async function checkViaReleasePage(current: string): Promise<UpdateCheckResult> {
  const res = await httpRequest(LATEST_PAGE, {
    headers: {
      Accept: 'text/html',
      'User-Agent': `kiro-manager-lite/${current}`
    },
    timeoutMs: 12_000
  })
  if (!res.ok) {
    if (res.status === 404) throw new Error('仓库还没有发布任何版本')
    throw new Error(`GitHub Releases 页面返回 ${res.status}`)
  }

  let tag = ''
  try {
    const match = new URL(res.url).pathname.match(/\/releases\/tag\/([^/]+)/)
    tag = match ? decodeURIComponent(match[1]) : ''
  } catch {
    // URL 异常统一落到下面的可读错误。
  }
  const latest = normalizeVersion(tag)
  if (!latest) throw new Error('未能从 GitHub Releases 页面识别最新版本')
  return resultOf(current, latest, { tag_name: tag })
}

async function runCheck(): Promise<UpdateCheckResult> {
  const current = app.getVersion()
  let apiError: unknown

  for (let attempt = 1; attempt <= API_ATTEMPTS; attempt++) {
    try {
      return await checkViaApi(current)
    } catch (error) {
      apiError = error
      if (error instanceof UpdateSourceError && !error.allowFallback) throw error
      const retryable = error instanceof UpdateSourceError
        ? error.retryable
        : isRetryableTransport(error)
      console.warn(
        `[Updater] GitHub API 第 ${attempt}/${API_ATTEMPTS} 次失败：` +
          `${errorMessage(error)}${nestedErrorCode(error) ? ` (${nestedErrorCode(error)})` : ''}`
      )
      if (!retryable || attempt === API_ATTEMPTS) break
      await sleep(600)
    }
  }

  try {
    console.warn('[Updater] 切换到 GitHub Releases 页面兜底检查')
    return await checkViaReleasePage(current)
  } catch (fallbackError) {
    console.warn(
      `[Updater] Releases 页面兜底失败：${errorMessage(fallbackError)}` +
        `${nestedErrorCode(fallbackError) ? ` (${nestedErrorCode(fallbackError)})` : ''}`
    )
    // 两条链路都失败时优先呈现最终网络原因；若页面返回了明确业务错误则原样保留。
    if (isRetryableTransport(fallbackError)) throw friendlyNetworkError(fallbackError)
    if (fallbackError instanceof Error) throw fallbackError
    throw friendlyNetworkError(apiError)
  }
}

/**
 * 拉取 GitHub 最新 Release 并与当前版本比较。
 * 主进程单飞：冷启动、多窗口和手动点击同时触发时只执行一组远端请求。
 */
export function checkForUpdate(): Promise<UpdateCheckResult> {
  if (!inFlight) {
    inFlight = runCheck().finally(() => {
      inFlight = null
    })
  }
  return inFlight
}
