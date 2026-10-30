import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fakeHome } from './helpers.js'
import { maxBodyBytes } from '../src/gateway/server.js'
import { loadCalendar, loadCalendarFull, loadHolidayDays } from '../src/gateway/daytype.js'
import { holidaysCachePath } from '../src/util/paths.js'
import type { Config } from '../src/config/types.js'

// 性能收口改动的定点测试（请求体上限换算 / 日历合并加载）：独立成文件（T21 复核：本文件
// 与 gateway / daytype 均零 vi.mock，「避免共享 mock 注册表」的旧理由已不存在，独立文件
// 保留为低耦合组织方式）

describe('maxBodyBytes（请求体上限：默认 16MB，gateway.max_body_mb 可调）', () => {
  const MB = 1024 * 1024
  const cfgOf = (gw: Record<string, unknown> | undefined): Config =>
    ({ gateway: gw } as unknown as Config)

  it('缺省与非法配置回落 16MB；合法值按 MB 换算，小数向下取整', () => {
    expect(maxBodyBytes()).toBe(16 * MB)
    expect(maxBodyBytes(cfgOf(undefined))).toBe(16 * MB)
    expect(maxBodyBytes(cfgOf({}))).toBe(16 * MB)
    expect(maxBodyBytes(cfgOf({ max_body_mb: 0 }))).toBe(16 * MB) // <1 视为非法回落默认
    expect(maxBodyBytes(cfgOf({ max_body_mb: -5 }))).toBe(16 * MB)
    expect(maxBodyBytes(cfgOf({ max_body_mb: 'x' }))).toBe(16 * MB) // 非数值（NaN）回落
    expect(maxBodyBytes(cfgOf({ max_body_mb: 64 }))).toBe(64 * MB)
    expect(maxBodyBytes(cfgOf({ max_body_mb: 1.9 }))).toBe(1 * MB)
  })
})

describe('loadCalendarFull（一次 stat 同取 years/days 两种视图）', () => {
  it('与 loadCalendar / loadHolidayDays 同源一致（共享 mtime memo，引用相等），days 升序', () => {
    const h = fakeHome()
    try {
      const p = holidaysCachePath()
      fs.mkdirSync(path.dirname(p), { recursive: true })
      fs.writeFileSync(
        p,
        JSON.stringify({
          data: {
            '2026': {
              days: [
                { name: '国庆节', date: '2026-10-01', isOffDay: true },
                { name: '国庆节', date: '2026-09-27', isOffDay: false },
              ],
            },
          },
        })
      )
      const full = loadCalendarFull()
      expect(full.years).toBe(loadCalendar()) // memo 命中：与单视图入口同一份数据对象
      expect(full.days).toBe(loadHolidayDays())
      expect(full.years.get('2026')?.get('2026-10-01')).toBe(true)
      expect(full.years.get('2026')?.get('2026-09-27')).toBe(false)
      expect(full.days.map((d) => d.date)).toEqual(['2026-09-27', '2026-10-01'])
    } finally {
      h.restore()
    }
  })
})
