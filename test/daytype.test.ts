import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadHolidayDays, localDateKey, upcomingHolidays } from '../src/gateway/daytype.js'
import { holidaysCachePath } from '../src/util/paths.js'
import { fakeHome } from './helpers.js'

/** fakeHome 里预写节假日缓存文件（.modeldock 目录可能尚不存在） */
function seedCache(content: string): void {
  const p = holidaysCachePath()
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, content)
}

describe('upcomingHolidays（纯归组逻辑，注入固定条目）', () => {
  const from = new Date('2026-09-20T12:00:00')

  it('放假日连段取首尾，假期前的调休补班日归入该假期', () => {
    const days = [
      { name: '国庆节', date: '2026-10-01', isOffDay: true },
      { name: '国庆节', date: '2026-10-02', isOffDay: true },
      { name: '国庆节', date: '2026-10-07', isOffDay: true },
      { name: '国庆节', date: '2026-09-27', isOffDay: false }, // 假期前的补班日
    ]
    expect(upcomingHolidays(from, 3, days)).toEqual([
      { name: '国庆节', start: '2026-10-01', end: '2026-10-07', makeup: ['2026-09-27'] },
    ])
  })

  it('跳过 from 之前的日期与未命名的条目', () => {
    const days = [
      { name: '端午', date: '2026-06-01', isOffDay: true }, // 早于 from
      { date: '2026-10-01', isOffDay: true }, // 无名字
      { name: '元旦', date: '2027-01-01', isOffDay: true },
    ]
    expect(upcomingHolidays(from, 3, days)).toEqual([
      { name: '元旦', start: '2027-01-01', end: '2027-01-01', makeup: [] },
    ])
  })

  it('limit 取最近的若干个，组合命名假期按名字整体归组', () => {
    const days = [
      { name: '国庆节、中秋节', date: '2026-10-01', isOffDay: true },
      { name: '国庆节、中秋节', date: '2026-10-08', isOffDay: true },
      { name: '元旦', date: '2027-01-01', isOffDay: true },
      { name: '春节', date: '2027-02-10', isOffDay: true },
    ]
    expect(upcomingHolidays(from, 2, days)).toEqual([
      { name: '国庆节、中秋节', start: '2026-10-01', end: '2026-10-08', makeup: [] },
      { name: '元旦', start: '2027-01-01', end: '2027-01-01', makeup: [] },
    ])
  })

  it('同名但距假期首尾超过 31 天的补班日不计入（跨年同名防误挂）', () => {
    const days = [
      { name: '春节', date: '2027-02-10', isOffDay: true },
      { name: '春节', date: '2026-12-01', isOffDay: false }, // 距离 70 天：脏数据，不算
      { name: '春节', date: '2027-02-06', isOffDay: false }, // 距离 4 天：算
    ]
    expect(upcomingHolidays(from, 3, days)).toEqual([
      { name: '春节', start: '2027-02-10', end: '2027-02-10', makeup: ['2027-02-06'] },
    ])
  })

  it('localDateKey 与 from 的过滤口径一致（当天含在内）', () => {
    const today = localDateKey(from)
    const days = [{ name: '当天开始的假期', date: today, isOffDay: true }]
    expect(upcomingHolidays(from, 3, days)[0]?.start).toBe(today)
  })

  it('今天在假期中段：显示完整原始区间（含假期前的补班日）', () => {
    const mid = new Date('2026-10-04T12:00:00')
    const days = [
      { name: '国庆节', date: '2026-09-27', isOffDay: false },
      { name: '国庆节', date: '2026-10-01', isOffDay: true },
      { name: '国庆节', date: '2026-10-08', isOffDay: true },
    ]
    expect(upcomingHolidays(mid, 3, days)).toEqual([
      { name: '国庆节', start: '2026-10-01', end: '2026-10-08', makeup: ['2026-09-27'] },
    ])
  })

  it('同名假期跨年分成两簇：只输出未结束的那簇', () => {
    const mid = new Date('2026-10-04T12:00:00')
    const days = [
      { name: '春节', date: '2026-02-15', isOffDay: true }, // 已结束
      { name: '春节', date: '2027-02-10', isOffDay: true },
      { name: '春节', date: '2027-02-16', isOffDay: true },
    ]
    expect(upcomingHolidays(mid, 3, days)).toEqual([
      { name: '春节', start: '2027-02-10', end: '2027-02-16', makeup: [] },
    ])
  })
})

describe('loadHolidayDays（读缓存文件，fakeHome 隔离）', () => {
  it('文件缺失返回空表', () => {
    const h = fakeHome()
    try {
      expect(loadHolidayDays()).toEqual([])
    } finally {
      h.restore()
    }
  })

  it('读取带名条目并按日期升序', () => {
    const h = fakeHome()
    try {
      seedCache(
        JSON.stringify({
          fetchedAt: '2026-01-01T00:00:00Z',
          data: {
            2027: {
              year: 2027,
              days: [
                { name: '元旦', date: '2027-01-01', isOffDay: true },
                { name: '元旦', date: '2026-12-31', isOffDay: false },
              ],
            },
          },
        })
      )
      expect(loadHolidayDays()).toEqual([
        { name: '元旦', date: '2026-12-31', isOffDay: false },
        { name: '元旦', date: '2027-01-01', isOffDay: true },
      ])
    } finally {
      h.restore()
    }
  })

  it('损坏文件当作空表（等下次拉取重建）', () => {
    const h = fakeHome()
    try {
      seedCache('{broken')
      expect(loadHolidayDays()).toEqual([])
    } finally {
      h.restore()
    }
  })
})
