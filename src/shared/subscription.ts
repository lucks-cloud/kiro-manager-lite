// 订阅档位的判定口径：主进程解析接口响应、读取历史数据时对齐档位，都走这里
import type { SubscriptionType } from './types'

/**
 * 从接口返回的订阅标题判定档位。
 *
 * 判断链顺序敏感，必须从最具体往最一般排：
 * - PRO MAX 与 PRO+ 都含子串 "PRO"，两者都必须先于 PRO，否则会被 PRO 抢走
 * - PRO MAX 不含 "PRO+"，PRO+ 也不含 "MAX"，两者互不干扰
 * - POWER 不含 "PRO"，位置不敏感
 *
 * 这里没有 Enterprise：它是登录方式（IdpType），不是订阅档位。
 * POWER 单独成档、不与其它档位合并，Power 账号才能显示自己的档位并单独筛选。
 */
export function normalizeSubscriptionType(title: string): SubscriptionType {
  const t = String(title || '').toUpperCase()
  if (t.includes('PRO MAX') || t.includes('PRO_MAX') || t.includes('PROMAX')) return 'Pro_Max'
  if (t.includes('PRO+') || t.includes('PRO PLUS') || t.includes('PRO_PLUS') || t.includes('PROPLUS')) {
    return 'Pro_Plus'
  }
  if (t.includes('POWER')) return 'Power'
  if (t.includes('TEAMS')) return 'Teams'
  // 学生号：教育邮箱认证后的档位，标题形如 KIRO STUDENT，不含 PRO，位置不敏感
  if (t.includes('STUDENT')) return 'Student'
  if (t.includes('PRO')) return 'Pro'
  return 'Free'
}
