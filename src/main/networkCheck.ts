// 常用工具：出口 IP 查询与网站连通性测试
//
// 两者都走 net.ts 的统一请求层，自动套用设置里的代理，
// 看到的就是 Kiro 请求实际经过的出口，而不是系统直连时的结果。
import { httpRequest, httpStream } from './net'
import { errorMessage } from '../shared/errors'
import type { IpInfo, SiteTestId, SiteTestResult } from '../shared/types'

const IP_TIMEOUT_MS = 6000
const SITE_TIMEOUT_MS = 10_000

/** 测试目标只在主进程定义，渲染层传标识，避免被当成任意地址探测工具 */
const SITE_URLS: Record<SiteTestId, string> = {
  github: 'https://github.com',
  google: 'https://www.google.com',
  youtube: 'https://www.youtube.com',
  kiro: 'https://kiro.dev',
  amazon: 'https://www.amazon.com'
}

const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined

/** 各家 IP 服务的字段命名不同，逐个适配成统一结构 */
const IP_PROVIDERS: { source: string; url: string; parse: (d: Record<string, unknown>) => IpInfo | undefined }[] = [
  {
    source: 'ipinfo.io',
    url: 'https://ipinfo.io/json',
    parse: (d) => {
      const ip = str(d.ip)
      if (!ip) return undefined
      return {
        ip,
        countryCode: str(d.country),
        region: str(d.region),
        city: str(d.city),
        org: str(d.org),
        timezone: str(d.timezone),
        source: 'ipinfo.io'
      }
    }
  },
  {
    source: 'ipapi.co',
    url: 'https://ipapi.co/json/',
    parse: (d) => {
      const ip = str(d.ip)
      if (!ip || d.error) return undefined
      const asn = str(d.asn)
      const org = str(d.org)
      return {
        ip,
        country: str(d.country_name),
        countryCode: str(d.country_code),
        region: str(d.region),
        city: str(d.city),
        org: asn && org ? `${asn} ${org}` : org,
        timezone: str(d.timezone),
        source: 'ipapi.co'
      }
    }
  },
  {
    source: 'ip.sb',
    url: 'https://api.ip.sb/geoip',
    parse: (d) => {
      const ip = str(d.ip)
      if (!ip) return undefined
      const asn = typeof d.asn === 'number' ? `AS${d.asn}` : undefined
      const org = str(d.organization) ?? str(d.isp)
      return {
        ip,
        country: str(d.country),
        countryCode: str(d.country_code),
        region: str(d.region),
        city: str(d.city),
        org: asn && org ? `${asn} ${org}` : org,
        timezone: str(d.timezone),
        source: 'ip.sb'
      }
    }
  }
]

/** 按顺序尝试多个服务，单个服务限流或被墙时自动换下一个 */
export async function getIpInfo(): Promise<IpInfo> {
  const errors: string[] = []
  for (const provider of IP_PROVIDERS) {
    try {
      const res = await httpRequest(provider.url, {
        timeoutMs: IP_TIMEOUT_MS,
        headers: { Accept: 'application/json', 'User-Agent': 'curl/8.0' }
      })
      if (!res.ok) {
        errors.push(`${provider.source} HTTP ${res.status}`)
        continue
      }
      const info = provider.parse(await res.json<Record<string, unknown>>())
      if (info) return info
      errors.push(`${provider.source} 返回内容无法识别`)
    } catch (error) {
      errors.push(`${provider.source} ${errorMessage(error)}`)
    }
  }
  throw new Error(`查询 IP 失败：${errors.join('；')}`)
}

/**
 * 测一个网站的连通性与延迟。
 * 只等到响应头就取消读流：YouTube、Amazon 首页动辄几百 KB，下载完整页面测的就不是延迟了。
 */
export async function testSite(id: SiteTestId): Promise<SiteTestResult> {
  const url = SITE_URLS[id]
  if (!url) throw new Error('未知的测试目标')

  const started = Date.now()
  try {
    const res = await httpStream(url, {
      method: 'GET',
      connectTimeoutMs: SITE_TIMEOUT_MS,
      headers: {
        // 带上常规浏览器 UA，部分站点对无 UA 的请求直接拒绝，会被误判成不通
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
        Accept: 'text/html,*/*'
      }
    })
    const latencyMs = Date.now() - started
    await res.body?.cancel().catch(() => undefined)
    return { id, url, ok: true, status: res.status, latencyMs }
  } catch (error) {
    const message = errorMessage(error)
    return {
      id,
      url,
      ok: false,
      latencyMs: Date.now() - started,
      error: /abort|超时/i.test(message) ? `连接超时（${SITE_TIMEOUT_MS / 1000}s）` : message
    }
  }
}
