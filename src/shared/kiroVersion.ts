// 请求头里上报的 Kiro IDE 版本与 AWS SDK 版本
//
// 主进程拼 UA 时读取，渲染层用同一份对照表渲染级联下拉。
import scanned from './data/kiro-sdk-versions.json'

/** 默认组合：Kiro 1.4.0 + 它打包的推荐 SDK 1.0.44（来自 dmg 提取的对照表） */
export const DEFAULT_KIRO_IDE_VERSION = '1.4.0'
export const DEFAULT_AWS_SDK_VERSION = '1.0.44'

/**
 * 1.0.47 及之前的默认组合。存值恰好是它时视为用户没改过，读取设置时迁移到新默认；
 * 用户自己选过的组合不受影响。
 */
export const LEGACY_DEFAULT_KIRO_IDE_VERSION = '0.12.333'
export const LEGACY_DEFAULT_AWS_SDK_VERSION = '1.0.39'

/** 一个 Kiro IDE 版本及其打包的 AWS SDK 版本 */
export interface KiroVersionPair {
  ide: string
  /** 第一个是推荐值（版本最高的那份）；同一 IDE 打包了多份时都列出 */
  sdks: string[]
}

/** kiro-sdk-versions.json 里的一条记录（只用到的字段） */
interface ScannedEntry {
  ide: string
  status: string
  packages?: Record<string, string[]>
}

const STREAMING_CLIENT = '@aws/codewhisperer-streaming-client'

/** 版本号比较：a > b 返回正数 */
export function compareVersion(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((s) => parseInt(s, 10) || 0)
  const pb = b.split(/[.-]/).map((s) => parseInt(s, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d) return d
  }
  return 0
}

/**
 * IDE → SDK 对照表，IDE 版本新的在前，SDK 版本高的在前（第一个即推荐值）。
 *
 * 数据来自 data/kiro-sdk-versions.json，由 scripts/kiro-sdk-versions.sh 逐个挂载官方 dmg，
 * 读取 kiro-agent 扩展里打包的 @aws/codewhisperer-streaming-client 版本生成。
 * 新版本发布后重跑脚本即可，这里不必手改。提取失败（status 不是 ok）的条目会被跳过。
 */
export const KIRO_VERSION_PAIRS: KiroVersionPair[] = (scanned.versions as ScannedEntry[])
  .filter((e) => e.status === 'ok' && e.packages?.[STREAMING_CLIENT]?.length)
  .map((e) => ({
    ide: e.ide,
    sdks: [...(e.packages?.[STREAMING_CLIENT] ?? [])].sort((a, b) => compareVersion(b, a))
  }))
  .sort((a, b) => compareVersion(b.ide, a.ide))

/** 某个组合是否出现在对照表里 */
export function isKnownPair(ide: string, sdk: string): boolean {
  return KIRO_VERSION_PAIRS.some((p) => p.ide === ide && p.sdks.includes(sdk))
}

/**
 * 规范化版本号：只接受 x.y.z（可带 -beta 之类的后缀）。
 * 这个值会直接拼进请求头，放任空格或斜杠进去会把 UA 拆错，非法输入回落到默认值。
 */
export function normalizeVersion(value: string | undefined, fallback: string): string {
  const raw = String(value ?? '').trim().replace(/^v/i, '')
  return /^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(raw) ? raw : fallback
}
