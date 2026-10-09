import fs from 'node:fs'
import { holidaysCachePath } from '../util/paths.js'

/**
 * 日类型判定：定时切换的窗口按「日期先定性」引用生效日。
 *
 * 数据源：holiday-cn 缓存文件（src/gateway/holidays.ts 负责拉取，含放假日与调休补班日）。
 * 每个日期四选一：
 *   holiday = 法定放假日；makeup = 调休补班日（周末上班，视同工作日）；
 *   weekend = 周六/周日；workday = 普通工作日（周一至五）。
 * 公布范围外的年份（如次年公告未发布）按星期几降级判定——宁可按普通周历走，也不停用窗口。
 */

export type DayType = 'holiday' | 'makeup' | 'weekend' | 'workday'

export interface HolidayDayLike {
  date: string
  isOffDay: boolean
}

/** 年份 → 日期键（YYYY-MM-DD）→ 是否放假日（false=调休补班） */
export type HolidayCalendar = Map<string, Map<string, boolean>>

/** 进程内缓存：按「路径+mtime」记忆解析结果，拉取落盘后下次读取自动生效 */
let memo: { key: string; years: HolidayCalendar } | null = null

/** 读取 holiday-cn 缓存为日历表；文件缺失/损坏返回空表（全部按星期几降级）。每次调用至多一次 statSync。 */
export function loadCalendar(): HolidayCalendar {
  const p = holidaysCachePath()
  let mtime = 0
  try {
    mtime = fs.statSync(p).mtimeMs
  } catch {
    return new Map()
  }
  const key = p + '\0' + mtime
  if (memo && memo.key === key) return memo.years
  const years: HolidayCalendar = new Map()
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8')) as { data?: Record<string, { days?: HolidayDayLike[] }> }
    for (const [y, yd] of Object.entries(j?.data ?? {})) {
      const m = new Map<string, boolean>()
      for (const d of yd?.days ?? []) {
        if (d && /^\d{4}-\d{2}-\d{2}$/.test(String(d.date))) m.set(String(d.date), d.isOffDay === true)
      }
      if (m.size) years.set(y, m)
    }
  } catch {
    return new Map() // 缓存损坏当作无日历，等待下次拉取重建
  }
  memo = { key, years }
  return years
}

export function localDateKey(d: Date): string {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
}

/** 缓存里的带名日历条目（holiday-cn 每条自带假期名；补班日同样带名） */
export interface HolidayDayNamed extends HolidayDayLike {
  name?: string
}

let daysMemo: { key: string; days: HolidayDayNamed[] } | null = null

/** 读取缓存日历的全部条目（含假期名与调休补班日），按日期升序；文件缺失/损坏返回空表。memo 策略与 loadCalendar 相同。 */
export function loadHolidayDays(): HolidayDayNamed[] {
  const p = holidaysCachePath()
  let mtime = 0
  try {
    mtime = fs.statSync(p).mtimeMs
  } catch {
    return []
  }
  const key = p + '\0' + mtime
  if (daysMemo && daysMemo.key === key) return daysMemo.days
  const days: HolidayDayNamed[] = []
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8')) as { data?: Record<string, { days?: HolidayDayNamed[] }> }
    for (const yd of Object.values(j?.data ?? {})) {
      for (const d of yd?.days ?? []) {
        if (d && /^\d{4}-\d{2}-\d{2}$/.test(String(d.date))) {
          days.push({ date: String(d.date), isOffDay: d.isOffDay === true, name: typeof d.name === 'string' ? d.name : undefined })
        }
      }
    }
  } catch {
    return [] // 缓存损坏当作无日历，等待下次拉取重建
  }
  days.sort((a, b) => a.date.localeCompare(b.date))
  daysMemo = { key, days }
  return days
}

export interface HolidayRange {
  name: string
  start: string
  end: string
  /** 该假期对应的调休补班日（升序） */
  makeup: string[]
}

function diffDays(a: string, b: string): number {
  return Math.round((Date.parse(a) - Date.parse(b)) / 86_400_000)
}

/** 今天（含）起往后最近 limit 个法定假期。
 *  同名条目间隔 ≤31 天视为同一假期（放假日连段取首尾，调休补班日按名字归入；输入顺序不限，内部排序）。
 *  假期进行中显示完整原始区间（start 可早于今天）；已结束的假期不输出。 */
export function upcomingHolidays(from: Date, limit = 3, days: HolidayDayNamed[] = loadHolidayDays()): HolidayRange[] {
  const fromKey = localDateKey(from)
  interface Cluster {
    name: string
    dates: string[]
    makeup: string[]
    last: string
  }
  const clusters: Cluster[] = []
  let cur: Cluster | null = null
  const sorted = days.slice().sort((a, b) => a.date.localeCompare(b.date))
  for (const d of sorted) {
    const name = (d.name ?? '').trim()
    if (!name) continue
    if (!cur || cur.name !== name || diffDays(d.date, cur.last) > 31) {
      cur = { name, dates: [], makeup: [], last: d.date }
      clusters.push(cur)
    }
    cur.last = d.date
    ;(d.isOffDay ? cur.dates : cur.makeup).push(d.date)
  }
  const out: HolidayRange[] = []
  for (const c of clusters) {
    if (!c.dates.length) continue
    const start = c.dates[0]
    const end = c.dates[c.dates.length - 1]
    if (end < fromKey) continue
    // 补班日只归入时间上贴近本假期的（防跨年同名误挂）
    const makeup = c.makeup
      .filter((m) => Math.abs(diffDays(m, start)) <= 31 || Math.abs(diffDays(m, end)) <= 31)
      .sort()
    out.push({ name: c.name, start, end, makeup })
    if (out.length >= limit) break
  }
  return out
}

/** 某日期的日类型。calendar 缺省读缓存文件；测试可注入固定表。 */
export function dayTypeFor(d: Date, calendar: HolidayCalendar = loadCalendar()): DayType {
  const off = calendar.get(String(d.getFullYear()))?.get(localDateKey(d))
  if (off === true) return 'holiday'
  if (off === false) return 'makeup'
  const dow = d.getDay()
  return dow === 0 || dow === 6 ? 'weekend' : 'workday'
}
