// Kiro IDE 能力探测：判断当前安装的 Kiro 是否支持 API Key 网关接管
//
// 要防的是「提示成功但实际无效」：
// 我们靠写 IDE settings.json 的 codewhisperer.config.krsEndpoints / cpsEndpoints
// 把 AI 请求引到本地网关，写完之后回读同一个文件做校验。但回读只能证明「文件写对了」，
// 不能证明「IDE 认这两个键」。于是在旧版 Kiro 上就会出现写入成功、弹窗报成功、
// 实际请求依然走官方端点的情况。
//
// 实测对比（解包 kiro-agent 扩展 dist/extension.js）：
//
//   Kiro 0.11.133 / agent 0.3.210
//     krsEndpoints、cpsEndpoints              → 不存在
//     runtime.*.kiro.dev、management.*.kiro.dev → 不存在
//     只有 codewhisperer.config.endpoints，端点是 q.<region>.amazonaws.com
//
//   Kiro 0.12.333 / agent 0.3.721
//     krsEndpoints、cpsEndpoints              → 存在，经 getKrsConfig / getCpsConfig 生效
//     runtime.*.kiro.dev、management.*.kiro.dev → 存在
//
// 也就是说 0.11.x 走的还是旧 CodeWhisperer 协议，既不读这两个键，也不会产生
// KRS / CPS 请求，本应用的网关在那个版本上没有可接管的对象。
//
// 判据用「扩展里有没有这两个键」这个事实，而不是版本号大小比较：
// 版本号只有两个样本，无法确定引入的确切版本；字符串存在性是可直接验证的。
import { createReadStream } from 'fs'
import * as fs from 'fs/promises'
import { existsSync } from 'fs'
import * as os from 'os'
import * as path from 'path'
import { log } from './logger'
import type { KiroCapability } from '../shared/types'

export type { KiroCapability }

/** 扩展里出现这个键，说明 IDE 会读取我们写的端点覆盖 */
const CAPABILITY_MARKER = 'krsEndpoints'

/** Kiro 安装目录候选（resources/app 的父级形态各平台不同） */
function appRootCandidates(): string[] {
  const home = os.homedir()
  if (process.platform === 'darwin') {
    return [
      '/Applications/Kiro.app/Contents/Resources/app',
      path.join(home, 'Applications', 'Kiro.app', 'Contents', 'Resources', 'app')
    ]
  }
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local')
    const programFiles = process.env.ProgramFiles || 'C:\\Program Files'
    const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
    return [
      path.join(localAppData, 'Programs', 'kiro', 'resources', 'app'),
      path.join(localAppData, 'Programs', 'Kiro', 'resources', 'app'),
      path.join(programFiles, 'Kiro', 'resources', 'app'),
      path.join(programFilesX86, 'Kiro', 'resources', 'app')
    ]
  }
  return [
    '/opt/Kiro/resources/app',
    '/opt/kiro/resources/app',
    '/usr/share/kiro/resources/app',
    '/usr/lib/kiro/resources/app'
  ]
}

/** 找到第一个存在 product.json 的安装目录 */
function findAppRoot(): string | undefined {
  return appRootCandidates().find((dir) => existsSync(path.join(dir, 'product.json')))
}

async function readJson(file: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf-8')) as Record<string, unknown>
  } catch {
    return null
  }
}

/**
 * 在 extension.js 里流式查找标记字符串。
 * 文件有 40MB 以上，不能整体读进内存；跨块边界靠保留上一块的尾部处理。
 */
function fileContains(file: string, marker: string): Promise<boolean> {
  return new Promise((resolve) => {
    let tail = ''
    let found = false
    const stream = createReadStream(file, { encoding: 'utf-8', highWaterMark: 1 << 20 })
    stream.on('data', (chunk) => {
      const text = tail + String(chunk)
      if (text.includes(marker)) {
        found = true
        stream.destroy()
        return
      }
      // 只留 marker 长度 - 1 的尾巴，保证被切开的标记仍能被拼回来
      tail = text.slice(-(marker.length - 1))
    })
    stream.on('close', () => resolve(found))
    stream.on('error', () => resolve(found))
  })
}

let cached: KiroCapability | null = null
let cacheKey = ''

/** 缓存键取 extension.js 的体积与修改时间：IDE 升级后自动失效 */
async function extensionStamp(file: string): Promise<string> {
  try {
    const st = await fs.stat(file)
    return `${st.size}:${st.mtimeMs}`
  } catch {
    return 'missing'
  }
}

/**
 * 探测当前安装的 Kiro 是否支持 API Key 网关。
 *
 * 探测不到安装目录或扩展文件时一律返回「支持」：
 * 宁可放过一个未知形态的安装（用户仍可通过「等待 IDE 请求确认」自行发现问题），
 * 也不要因为路径没覆盖到就把本来能用的功能拦下来。
 */
export async function detectKiroCapability(force = false): Promise<KiroCapability> {
  const appRoot = findAppRoot()
  if (!appRoot) {
    return {
      supportsKeyGateway: true,
      reason: '未找到 Kiro 安装目录，跳过版本能力检查'
    }
  }

  const extensionFile = path.join(
    appRoot,
    'extensions',
    'kiro.kiro-agent',
    'dist',
    'extension.js'
  )
  const stamp = await extensionStamp(extensionFile)
  const key = `${appRoot}|${stamp}`
  if (!force && cached && cacheKey === key) return cached

  const product = await readJson(path.join(appRoot, 'product.json'))
  const agent = await readJson(path.join(appRoot, 'extensions', 'kiro.kiro-agent', 'package.json'))
  const version = typeof product?.version === 'string' ? product.version : undefined
  const agentVersion = typeof agent?.version === 'string' ? agent.version : undefined

  let result: KiroCapability
  if (stamp === 'missing') {
    result = {
      appRoot,
      version,
      agentVersion,
      supportsKeyGateway: true,
      reason: '未找到 kiro-agent 扩展文件，跳过版本能力检查'
    }
  } else {
    const supported = await fileContains(extensionFile, CAPABILITY_MARKER)
    result = {
      appRoot,
      version,
      agentVersion,
      supportsKeyGateway: supported,
      reason: supported
        ? undefined
        : `当前 Kiro${version ? ` ${version}` : ''} 不读取 krsEndpoints / cpsEndpoints 端点覆盖`
    }
  }

  cached = result
  cacheKey = key
  log(
    result.supportsKeyGateway ? 'info' : 'warn',
    `[KiroCapability] version=${version ?? '未知'} agent=${agentVersion ?? '未知'} ` +
      `支持网关=${result.supportsKeyGateway}${result.reason ? ` (${result.reason})` : ''}`
  )
  return result
}

/** 开启网关前的硬门槛：确认不支持就直接拦下，避免写出一份 IDE 根本不看的配置 */
export async function assertKeyGatewaySupported(): Promise<void> {
  const cap = await detectKiroCapability()
  if (cap.supportsKeyGateway) return
  const label = cap.version ? `Kiro ${cap.version}` : '当前 Kiro 版本'
  throw new Error(
    `检测到 ${label}，当前版本不支持本地网关。请升级 Kiro 到 0.12.xxx 及以上版本后再使用。`
  )
}
