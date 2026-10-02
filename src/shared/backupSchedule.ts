// 备份计划的周期定义与「下次执行时间」计算；主进程排程和设置页展示共用这一份

/**
 * 周期类型，对应设置页下拉里的几项：
 *  - day：每天 hour:minute
 *  - nDays：每隔 n 天的 hour:minute
 *  - hour：每小时的第 minute 分
 *  - nHours：每隔 n 小时 minute 分钟
 *  - nMinutes：每隔 n 分钟
 *  - week：每周 weekday 的 hour:minute
 *  - month：每月 day 号的 hour:minute（当月没有这一天时取当月最后一天）
 */
export type BackupCycleType = 'day' | 'nDays' | 'hour' | 'nHours' | 'nMinutes' | 'week' | 'month'

export interface BackupCycle {
  type: BackupCycleType
  /** nDays 的天数 / nHours 的小时数 / nMinutes 的分钟数 */
  n: number
  /** 0 = 周日 … 6 = 周六，和 Date.getDay 一致 */
  weekday: number
  /** 每月几号，1-31 */
  day: number
  hour: number
  minute: number
}

/** 默认每 30 分钟备份一次 */
export const DEFAULT_BACKUP_CYCLE: BackupCycle = {
  type: 'nMinutes',
  n: 30,
  weekday: 1,
  day: 1,
  hour: 12,
  minute: 0
}

export const BACKUP_CYCLE_OPTIONS: { value: BackupCycleType; label: string }[] = [
  { value: 'day', label: '每天' },
  { value: 'nDays', label: 'N天' },
  { value: 'hour', label: '每小时' },
  { value: 'nHours', label: 'N小时' },
  { value: 'nMinutes', label: 'N分钟' },
  { value: 'week', label: '每周' },
  { value: 'month', label: '每月' }
]

export const WEEKDAY_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/** 保留份数的上下限：至少留一份，上限防止误填成几万份把磁盘写满 */
export const BACKUP_KEEP_MIN = 1
export const BACKUP_KEEP_MAX = 500
/** 默认保留最新 3 份 */
export const DEFAULT_BACKUP_KEEP = 3

/** N 分钟周期的下限：每份备份是整库，分钟级太频繁只会白白写盘 */
export const BACKUP_MIN_INTERVAL_MINUTES = 5

function int(value: unknown, min: number, max: number, fallback: number): number {
  const num = Math.round(Number(value))
  if (!Number.isFinite(num)) return fallback
  return Math.min(max, Math.max(min, num))
}

/** 设置里读出来的周期可能来自旧版本或手改，逐项夹到合法范围 */
export function normalizeBackupCycle(raw: Partial<BackupCycle> | undefined): BackupCycle {
  const d = DEFAULT_BACKUP_CYCLE
  const type = BACKUP_CYCLE_OPTIONS.some((o) => o.value === raw?.type) ? (raw!.type as BackupCycleType) : d.type
  const nMax = type === 'nDays' ? 365 : type === 'nHours' ? 720 : 10_080
  const nMin = type === 'nMinutes' ? BACKUP_MIN_INTERVAL_MINUTES : 1
  return {
    type,
    n: int(raw?.n, nMin, nMax, Math.max(nMin, d.n)),
    weekday: int(raw?.weekday, 0, 6, d.weekday),
    day: int(raw?.day, 1, 31, d.day),
    hour: int(raw?.hour, 0, 23, d.hour),
    minute: int(raw?.minute, 0, 59, d.minute)
  }
}

export function normalizeBackupKeep(value: unknown): number {
  return int(value, BACKUP_KEEP_MIN, BACKUP_KEEP_MAX, DEFAULT_BACKUP_KEEP)
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE

function at(base: Date, hour: number, minute: number): Date {
  const d = new Date(base)
  d.setHours(hour, minute, 0, 0)
  return d
}

/** 某年某月的 day 号；当月没有（2 月 30 号）就取当月最后一天 */
function monthDay(year: number, month: number, day: number, hour: number, minute: number): Date {
  const last = new Date(year, month + 1, 0).getDate()
  return new Date(year, month, Math.min(day, last), hour, minute, 0, 0)
}

/**
 * 下一次应当执行的时间（毫秒时间戳）。
 *
 * anchor 是上一次执行的时间；从没执行过时传开启计划（或改周期）的时间。
 * 固定时刻类（每天 / 每周 / 每月 / 每小时）找 anchor 之后最近的那个时刻；
 * 间隔类（N 天 / N 小时 / N 分钟）从 anchor 起算一个间隔。
 * 结果早于当前时间说明错过了（应用没开、电脑睡眠），调用方应立即补跑一次。
 */
export function nextBackupAt(cycle: BackupCycle, anchor: number): number {
  const c = normalizeBackupCycle(cycle)
  const base = new Date(anchor)
  switch (c.type) {
    case 'nMinutes':
      return anchor + c.n * MINUTE
    case 'nHours':
      return anchor + c.n * HOUR + c.minute * MINUTE
    case 'hour': {
      const d = new Date(base)
      d.setMinutes(c.minute, 0, 0)
      if (d.getTime() <= anchor) d.setHours(d.getHours() + 1)
      return d.getTime()
    }
    case 'day': {
      const d = at(base, c.hour, c.minute)
      if (d.getTime() <= anchor) d.setDate(d.getDate() + 1)
      return d.getTime()
    }
    case 'nDays': {
      // 从 anchor 那天起往后数 n 天的 hour:minute；anchor 当天的时刻还没到就算第一天
      const d = at(base, c.hour, c.minute)
      if (d.getTime() <= anchor) d.setDate(d.getDate() + c.n)
      return d.getTime()
    }
    case 'week': {
      const d = at(base, c.hour, c.minute)
      d.setDate(d.getDate() + ((c.weekday - d.getDay() + 7) % 7))
      if (d.getTime() <= anchor) d.setDate(d.getDate() + 7)
      return d.getTime()
    }
    case 'month': {
      let d = monthDay(base.getFullYear(), base.getMonth(), c.day, c.hour, c.minute)
      if (d.getTime() <= anchor) d = monthDay(base.getFullYear(), base.getMonth() + 1, c.day, c.hour, c.minute)
      return d.getTime()
    }
  }
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/** 一句话描述周期，设置页的说明里用 */
export function describeBackupCycle(cycle: BackupCycle): string {
  const c = normalizeBackupCycle(cycle)
  const time = `${pad(c.hour)}:${pad(c.minute)}`
  switch (c.type) {
    case 'day':
      return `每天 ${time} 执行一次`
    case 'nDays':
      return `每隔 ${c.n} 天的 ${time} 执行一次`
    case 'hour':
      return `每小时的第 ${c.minute} 分钟执行一次`
    case 'nHours':
      return `每隔 ${c.n} 小时${c.minute ? ` ${c.minute} 分钟` : ''}执行一次`
    case 'nMinutes':
      return `每隔 ${c.n} 分钟执行一次`
    case 'week':
      return `每${WEEKDAY_LABELS[c.weekday]} ${time} 执行一次`
    case 'month':
      return `每月 ${c.day} 号 ${time} 执行一次${c.day > 28 ? '（当月没有这一天时取最后一天）' : ''}`
  }
}
