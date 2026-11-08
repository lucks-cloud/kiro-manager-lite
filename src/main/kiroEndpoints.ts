// Kiro / AWS 端点与请求头常量
//
// token 刷新、用量查询、模型列表、对话测活分散在多个模块里，但它们用的都是
// 同一套 UA、同一套区域映射规则。统一收在这里，避免各处各写一份导致漂移。
import { execFile, execFileSync } from 'child_process'
import { createHash, randomUUID } from 'crypto'
import { readFileSync } from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  DEFAULT_AWS_SDK_VERSION,
  DEFAULT_KIRO_IDE_VERSION,
  normalizeVersion
} from '../shared/kiroVersion'

/**
 * 对齐 Kiro IDE 的版本号与 SDK 版本。**全项目只在这里定义**，也只在本文件里用：
 * 反代、账号测活、模型列表、用量、token 刷新、API Key 网关拼请求头时
 * 一律调用下面的 kiroUserAgent() / kiroAmzUserAgent()，不直接引用这两个常量。
 * 默认值在 shared/kiroVersion，用户可在「常用工具」里改，运行时经 setKiroVersions() 同步。
 *
 * 这不只是「像不像官方客户端」的问题，服务端会按 UA 里的版本号做准入：
 * 实测同一个 Builder ID token，UA 报 KiroIDE-0.6.18 / aws-sdk-js/1.0.18 时
 * ListAvailableModels 与 generateAssistantResponse 一律回
 * 403 "User is not authorized to make this call."；换成新版本即 200。
 * 社交账号（Github / Google）不受该门槛影响——所以该 403 只出现在 Builder ID / IdC 上。
 *
 * 默认值是 Kiro 1.4.0 与它打包的 @aws/codewhisperer-streaming-client 1.0.44，
 * 各版本的对应关系见 shared/data/kiro-sdk-versions.json（由 scripts/kiro-sdk-versions.sh 从官方 dmg 提取）。
 * 升级时两个一起核对：只改版本号、SDK 还停在旧值，就是一个官方从没发过的组合。
 */
let KIRO_IDE_VERSION = DEFAULT_KIRO_IDE_VERSION
let AWS_SDK_VERSION = DEFAULT_AWS_SDK_VERSION

/** 用户在「常用工具 → Kiro UA 请求头版本号」里改过时由 applyRuntimeSettings 同步下来 */
export function setKiroVersions(ideVersion?: string, sdkVersion?: string): void {
  KIRO_IDE_VERSION = normalizeVersion(ideVersion, DEFAULT_KIRO_IDE_VERSION)
  AWS_SDK_VERSION = normalizeVersion(sdkVersion, DEFAULT_AWS_SDK_VERSION)
}

/*
 * ============ UA 里的机器码 ============
 *
 * 官方格式是 `KiroIDE-<版本>-<机器码>`，读自 Kiro 0.12.333 的 kiro-agent 扩展：
 *   `KiroIDE-${vscode.kiroVersion}-${USER_MACHINE_ID}`，USER_MACHINE_ID = getMachineId()，
 *   getMachineId() 先用 node-machine-id 的 machineIdSync()，失败才回落 vscode.env.machineId。
 * 所以一律带上这个后缀，和官方请求头保持一致。
 *
 * 注意：machineIdSync() 取的是**操作系统**的设备标识再做 sha256
 * （macOS 的 IOPlatformUUID、Windows 的 MachineGuid、Linux 的 /etc/machine-id），
 * 不是 storage.json 里的 telemetry.machineId。也就是说「重置机器码」改的那几个值
 * 并不会改变官方 IDE 请求头里的机器码——我们照官方算法算，才和同一台机器上
 * 真实 IDE 发出去的一致；只有系统标识拿不到时，才和官方一样回落到 telemetry.machineId。
 */

/** 靠子进程查系统设备标识的命令、参数与输出解析 */
interface DeviceIdQuery {
  file: string
  args: string[]
  options: { encoding: 'utf-8'; timeout: number; windowsHide?: boolean }
  parse: (out: string) => string | undefined
}

/**
 * macOS / Windows 的设备标识查询；其它平台直接读文件，返回 undefined。
 * 同步取值（osDeviceId）与启动后的异步预热（warmKiroMachineId）共用这一份，保证两边算法一致。
 */
function deviceIdQuery(): DeviceIdQuery | undefined {
  if (process.platform === 'darwin') {
    return {
      file: 'ioreg',
      args: ['-rd1', '-c', 'IOPlatformExpertDevice'],
      options: { encoding: 'utf-8', timeout: 3000 },
      parse: (out) => /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(out)?.[1]?.toLowerCase()
    }
  }
  if (process.platform === 'win32') {
    return {
      file: 'REG',
      args: ['QUERY', 'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'],
      options: { encoding: 'utf-8', timeout: 3000, windowsHide: true },
      parse: (out) => /REG_SZ\s+(\S+)/.exec(out)?.[1]?.toLowerCase()
    }
  }
  return undefined
}

/** node-machine-id 同款：取系统设备标识原文，统一小写、去空白 */
function osDeviceId(): string | undefined {
  try {
    const query = deviceIdQuery()
    if (query) return query.parse(execFileSync(query.file, query.args, query.options))
    for (const file of ['/var/lib/dbus/machine-id', '/etc/machine-id']) {
      try {
        const id = readFileSync(file, 'utf-8').split('\n')[0].replace(/\s+/g, '').toLowerCase()
        if (id) return id
      } catch {
        // 换下一个
      }
    }
  } catch {
    // 命令不存在或超时，交给下面的回落
  }
  return undefined
}

/** 官方的回落值：Kiro 数据目录 storage.json 里的 telemetry.machineId（vscode.env.machineId） */
function kiroTelemetryMachineId(): string | undefined {
  const home = os.homedir()
  const dir =
    process.platform === 'darwin'
      ? path.join(home, 'Library', 'Application Support', 'Kiro')
      : process.platform === 'win32'
        ? path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Kiro')
        : path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'Kiro')
  try {
    const json = JSON.parse(
      readFileSync(path.join(dir, 'User', 'globalStorage', 'storage.json'), 'utf-8')
    ) as Record<string, unknown>
    const id = json['telemetry.machineId']
    return typeof id === 'string' && /^[a-f0-9]{64}$/i.test(id) ? id.toLowerCase() : undefined
  } catch {
    return undefined
  }
}

let cachedMachineId: string | undefined

/** 设备标识 → 机器码：node-machine-id 同款 sha256 */
function hashDeviceId(deviceId: string): string {
  return createHash('sha256').update(deviceId).digest('hex')
}

/**
 * UA 后缀用的机器码（64 位 hex）。
 * 系统设备标识在进程生命周期内不会变，算一次缓存住：ioreg 是同步子进程，每个请求都跑太浪费。
 * 两个来源都拿不到（没装 Kiro 的 Linux 容器之类）时，按主机名派生一个稳定值，保证格式不缺段。
 */
function kiroMachineId(): string {
  if (cachedMachineId) return cachedMachineId
  const deviceId = osDeviceId()
  cachedMachineId = deviceId
    ? hashDeviceId(deviceId)
    : (kiroTelemetryMachineId() ??
      createHash('sha256').update(`kiro-manager-lite/${os.hostname()}`).digest('hex'))
  return cachedMachineId
}

/**
 * 启动后用异步子进程预热机器码缓存，免得第一个请求在主线程上同步跑 ioreg / REG（最长 3 秒）。
 * 只在查到设备标识时写缓存，结果与 kiroMachineId 的同步路径完全一致；
 * 查询失败（超时、命令缺失）或其它平台不写，仍由 kiroMachineId 按原逻辑同步取值与回落。
 * 预热期间若同步路径已先算出结果，以先写入的为准，不覆盖。
 */
export function warmKiroMachineId(): void {
  const query = deviceIdQuery()
  if (!query || cachedMachineId) return
  try {
    execFile(query.file, query.args, query.options, (error, stdout) => {
      if (error || cachedMachineId) return
      const deviceId = query.parse(stdout)
      if (deviceId) cachedMachineId = hashDeviceId(deviceId)
    })
  } catch {
    // 起子进程失败就不预热，交给同步路径
  }
}

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

/** `KiroIDE-<版本>-<机器码>`，两种 UA 共用，保证不会一个带机器码一个不带 */
function kiroIdeTag(): string {
  return `KiroIDE-${KIRO_IDE_VERSION}-${kiroMachineId()}`
}

/** 完整 UA，AWS SDK 风格 + Kiro IDE 版本与机器码 */
export function kiroUserAgent(): string {
  return (
    `aws-sdk-js/${AWS_SDK_VERSION} ua/2.1 os/${UA_OS}#${os.release()} lang/js ` +
    `md/nodejs#${process.versions.node} api/codewhispererstreaming#${AWS_SDK_VERSION} ` +
    `m/E ${kiroIdeTag()}`
  )
}

/**
 * x-amz-user-agent 用的短 UA。
 * 用短横连接，和官方 UA 的写法一致；不要写成空格分隔（`KiroIDE 0.12.155 <id>`）。
 */
export function kiroAmzUserAgent(): string {
  return `aws-sdk-js/${AWS_SDK_VERSION} ${kiroIdeTag()}`
}

/** AWS SDK 的单次调用标识（uuid v4） */
export function awsInvocationId(): string {
  return randomUUID()
}

/** AWS SDK 通用重试头：本应用不依赖 SDK 重试，固定单次 */
export const AWS_SINGLE_ATTEMPT_HEADERS: Record<string, string> = {
  'amz-sdk-request': 'attempt=1; max=1'
}
