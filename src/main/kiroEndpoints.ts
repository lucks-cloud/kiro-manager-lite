// Kiro / AWS 端点与请求头常量
//
// token 刷新、用量查询、模型列表、对话测活分散在多个模块里，但它们用的都是
// 同一套 UA、同一套区域映射规则。统一收在这里，避免各处各写一份导致漂移。
import { randomUUID } from 'crypto'
import * as os from 'os'

/**
 * 对齐 Kiro IDE 的版本号与 SDK 版本。
 *
 * 这不只是「像不像官方客户端」的问题，服务端会按 UA 里的版本号做准入：
 * 实测同一个 Builder ID token，UA 报 KiroIDE-0.6.18 / aws-sdk-js/1.0.18 时
 * ListAvailableModels 与 generateAssistantResponse 一律回
 * 403 "User is not authorized to make this call."；只把版本换成下面这组即 200。
 * 社交账号（Github / Google）不受该门槛影响，两组 UA 都通——所以这个坑只在
 * Builder ID / IdC 上暴露出来。
 *
 * 升级时这三个值要一起动，混搭（新版本号 + 旧 SDK）没有验证过。
 */
const KIRO_IDE_VERSION = '0.12.155'
const AWS_SDK_VERSION = '1.0.34'

/** os / node 指纹按本机真实值填，固定写 windows 反而是个显眼的破绽 */
const UA_OS = (() => {
  if (process.platform === 'win32') return 'win32'
  return process.platform === 'darwin' ? 'macos' : 'linux'
})()

/** Kiro 网页门户站点根地址 */
export const KIRO_PORTAL_ORIGIN = 'https://app.kiro.dev'
/** Kiro 网页门户的 CBOR 接口 */
export const KIRO_PORTAL_BASE = `${KIRO_PORTAL_ORIGIN}/service/KiroWebPortalService/operation`
/** Github / Google 社交登录与 token 刷新共用的 auth service */
export const KIRO_AUTH_BASE = 'https://prod.us-east-1.auth.desktop.kiro.dev'
/** Builder ID 的默认 SSO 入口，同时参与 clientIdHash 计算 */
export const KIRO_START_URL = 'https://view.awsapps.com/start'

/** AWS SSO OIDC 端点：客户端注册、设备码、token 交换、授权页 */
export function oidcEndpoint(region: string): string {
  return `https://oidc.${region}.amazonaws.com`
}

/** 注册 OIDC 客户端与写入 IDE 注册文件时使用的作用域 */
export const KIRO_OIDC_SCOPES = [
  'codewhisperer:completions',
  'codewhisperer:analysis',
  'codewhisperer:conversations',
  'codewhisperer:transformations',
  'codewhisperer:taskassist'
]

/** 接口只在这两个区域有部署，其它区域按地理位置就近归并 */
type ServiceRegion = 'us-east-1' | 'eu-central-1'

/** 把任意 AWS 区域归并到最近的服务区域 */
export function serviceRegion(region?: string): ServiceRegion {
  return region?.startsWith('eu-') ? 'eu-central-1' : 'us-east-1'
}

/** Amazon Q 端点：用量、模型列表 */
export function qEndpoint(region?: string): string {
  return `https://q.${serviceRegion(region)}.amazonaws.com`
}

/** 主端点 403 时换另一个区域再试 */
export function qFallbackEndpoint(region?: string): string {
  return `https://q.${serviceRegion(region) === 'eu-central-1' ? 'us-east-1' : 'eu-central-1'}.amazonaws.com`
}

/** CodeWhisperer Runtime 端点：profile 列表、对话 */
export function codeWhispererEndpoint(region?: string): string {
  return `https://codewhisperer.${serviceRegion(region)}.amazonaws.com`
}

/** 完整 UA，AWS SDK 风格 + Kiro IDE 版本 */
export function kiroUserAgent(): string {
  return (
    `aws-sdk-js/${AWS_SDK_VERSION} ua/2.1 os/${UA_OS}#${os.release()} lang/js ` +
    `md/nodejs#${process.versions.node} api/codewhispererstreaming#${AWS_SDK_VERSION} ` +
    `m/E KiroIDE-${KIRO_IDE_VERSION}`
  )
}

/** x-amz-user-agent 用的短 UA */
export function kiroAmzUserAgent(): string {
  return `aws-sdk-js/${AWS_SDK_VERSION} KiroIDE-${KIRO_IDE_VERSION}`
}

/** AWS SDK 的单次调用标识（uuid v4） */
export function awsInvocationId(): string {
  return randomUUID()
}

/** AWS SDK 通用重试头：本应用不依赖 SDK 重试，固定单次 */
export const AWS_SINGLE_ATTEMPT_HEADERS: Record<string, string> = {
  'amz-sdk-request': 'attempt=1; max=1'
}
