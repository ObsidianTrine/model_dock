import fs from 'node:fs'
import { atomicWrite } from '../util/fsx.js'
import { t, bi } from '../util/i18n.js'
import { holidaysCachePath } from '../util/paths.js'
import { logAudit, type GatewayRuntime } from './state.js'

/**
 * 法定节假日日历（含调休补班日）自动获取与缓存。
 *
 * 数据源：holiday-cn（开源项目，逐条对照国务院办公厅次年节假日安排公告人工校对；
 * 官方站点只发公文网页没有 API，此项目是该事实数据的通行渠道）。每年一份 {year}.json：
 *   { year, days: [{ name, date: 'YYYY-MM-DD', isOffDay }] }   isOffDay: true=放假, false=调休补班
 * 默认源优先 jsDelivr 国内 CDN，回落 GitHub raw；可用环境变量 MODELRDOCK_HOLIDAY_SOURCES
 * 覆写（逗号分隔，{year} 占位符）。
 *
 * 本模块只负责把今年/明年的日历缓存到 holidays-cn.json——定时切换窗口的生效日
 * （工作日/周末/法定节假日）由 src/gateway/daytype.ts 按这份日历实时判定，缓存落盘即生效。
 */

export interface HolidayDay {
  name?: string
  date: string
  isOffDay: boolean
}
export interface HolidayYearData {
  year: number
  days: HolidayDay[]
}
export interface HolidayCache {
  fetchedAt: string
  data: Record<string, HolidayYearData>
}
export interface CalendarRefreshResult {
  /** 本次成功更新的年份 */
  years: number[]
  /** 本次更新年份的日历条目总数（放假日+补班日） */
  updatedDays: number
  /** 各年份拉取失败原因（次年公告未发布不算失败） */
  failures: string[]
  fetchedAt: string
  /** 公告尚未发布的年份提示 */
  note?: string
}

const DEFAULT_SOURCES = [
  'https://fastly.jsdelivr.net/gh/NateScarlet/holiday-cn@master/{year}.json',
  'https://raw.githubusercontent.com/NateScarlet/holiday-cn/master/{year}.json',
]
const FETCH_TIMEOUT_MS = 10_000

export function holidaySources(): string[] {
  const env = (process.env.MODELRDOCK_HOLIDAY_SOURCES ?? '').trim()
  if (!env) return DEFAULT_SOURCES
  const list = env.split(',').map((s) => s.trim()).filter(Boolean)
  return list.length ? list : DEFAULT_SOURCES
}

function readCache(): HolidayCache {
  try {
    const raw = fs.readFileSync(holidaysCachePath(), 'utf8')
    if (raw) {
      const j = JSON.parse(raw) as HolidayCache
      if (j && typeof j === 'object' && j.data && typeof j.data === 'object') {
        return { fetchedAt: String(j.fetchedAt ?? ''), data: j.data }
      }
    }
  } catch {
    /* 缓存损坏当作空缓存重建 */
  }
  return { fetchedAt: '', data: {} }
}

async function writeCache(cache: HolidayCache): Promise<void> {
  try {
    await atomicWrite(holidaysCachePath(), JSON.stringify(cache, null, 2), 0o600)
  } catch {
    /* 缓存写失败不影响本次结果；下次拉取会再试 */
  }
}

function parseYearJson(year: number, text: string): HolidayYearData {
  const j = JSON.parse(text) as Record<string, unknown>
  const days = j?.days
  if (!Array.isArray(days)) throw new Error(t('days 字段缺失', 'missing "days" field'))
  const parsed: HolidayDay[] = []
  for (const d of days as unknown[]) {
    const date = String((d as HolidayDay)?.date ?? '')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue
    parsed.push({
      name: typeof (d as HolidayDay).name === 'string' ? String((d as HolidayDay).name).slice(0, 40) : undefined,
      date,
      isOffDay: (d as HolidayDay).isOffDay === true,
    })
  }
  return { year, days: parsed }
}

/** 拉取若干年份的数据：单年份逐源尝试（404=公告尚未发布，不算失败），失败年份回落缓存中已有的旧数据 */
export async function fetchHolidayData(
  years: number[],
  cache: HolidayCache
): Promise<{ failures: string[]; notPublished: number[] }> {
  const failures: string[] = []
  const notPublished: number[] = []
  for (const year of years) {
    const key = String(year)
    let done = false
    let lastErr = ''
    for (const tpl of holidaySources()) {
      try {
        const res = await fetch(tpl.replace('{year}', key), { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
        if (res.status === 404) {
          lastErr = t('公告尚未发布', 'announcement not published yet')
          continue
        }
        if (!res.ok) {
          lastErr = `HTTP ${res.status}`
          continue
        }
        cache.data[key] = parseYearJson(year, await res.text())
        done = true
        break
      } catch (e) {
        lastErr = e instanceof Error ? e.message : String(e)
      }
    }
    if (!done) {
      if (lastErr === t('公告尚未发布', 'announcement not published yet')) notPublished.push(year)
      else failures.push(`${year}: ${lastErr || t('全部数据源不可达', 'all data sources unreachable')}`)
    }
  }
  return { failures, notPublished }
}

/** 拉取今年/明年的节假日日历并写缓存（写盘即生效，日类型判定按文件 mtime 自动重读）。
 *  自动模式下未配置定时切换则跳过（用不到日历，不白发请求）。 */
export async function refreshCalendar(rt: GatewayRuntime, opts: { manual?: boolean }): Promise<CalendarRefreshResult> {
  const empty: CalendarRefreshResult = { years: [], updatedDays: 0, failures: [], fetchedAt: new Date().toISOString() }
  // 测试隔离钩子（与 MODELRDOCK_FAKE_*_PRESENT 同属 CI 解耦钩子）：数据源是外网 holiday-cn，
  // 测试环境禁止真实网络请求（2026-10-01 CI 实测踩中节假日外网拉取竞态）。
  if (process.env.MODELRDOCK_DISABLE_HOLIDAY_FETCH === '1') return empty
  const manual = opts?.manual === true
  if (!manual && !rt.config.gateway?.schedule) return empty

  const cache = readCache()
  const year = new Date().getFullYear()
  const years = [year, year + 1]
  const { failures, notPublished } = await fetchHolidayData(years, cache)
  cache.fetchedAt = new Date().toISOString()
  const updated = years.filter((y) => cache.data[String(y)])
  const updatedDays = updated.reduce((n, y) => n + (cache.data[String(y)]?.days.length ?? 0), 0)
  await writeCache(cache)

  if (manual) {
    const op = bi('节假日日历', 'Holiday calendar')
    const tg = updated.length ? bi(updated.join('、') + ' 年', updated.join(', ')) : bi('无更新', 'no updates')
    const detail = updated.length
      ? bi(`更新 ${updated.length} 个年份共 ${updatedDays} 条，手动触发`, `Updated ${updated.length} year(s), ${updatedDays} entries; manual fetch`)
      : bi('数据源无变化，手动触发', 'No changes from data sources; manual fetch')
    logAudit(rt, {
      ts: cache.fetchedAt,
      kind: 'audit',
      op: op.zh,
      op_en: op.en,
      target: tg.zh,
      target_en: tg.en,
      detail: detail.zh,
      detail_en: detail.en,
      ok: true,
      source: 'web',
    })
  }
  return {
    years: updated,
    updatedDays,
    failures,
    fetchedAt: cache.fetchedAt,
    ...(notPublished.length ? { note: t('{list} 年公告尚未发布', "Announcements for {list} aren't published yet", { list: notPublished.join('、') }) } : {}),
  }
}
