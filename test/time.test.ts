import { describe, expect, it } from 'vitest'
import { localDateStr, localIsoTs } from '../src/util/time.js'

/** 契约（见 src/util/time.ts 头注释）：输出本机时区墙钟时间（不是 UTC），字符布局与 ISO 一致——
 *  调用方靠 slice(0, 10) 取日期、slice(11, 19) 取时分秒。
 *
 *  断言必须「时区无关」：一律用本地构造的 Date（new Date(y, m, d, h, …) 按本机时区解释）
 *  或用回环解析验证，绝不写死 +08:00 / 某天的 07:30——CI 三平台都在 UTC，写死本机时区必红。
 *  同理不靠改 process.env.TZ 来测：vitest 是 singleFork 全进程共享，TZ 一旦被改（含断言失败
 *  导致 finally 之前抛出的情况）会污染后续所有测试文件的日期断言。 */
describe('time · localIsoTs 字符布局', () => {
  it('YYYY-MM-DDTHH:mm:ss.sss±HH:mm，总长 29', () => {
    const ts = localIsoTs(new Date(2024, 0, 1, 8, 5, 6, 78))
    expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/)
    expect(ts).toHaveLength(29)
  })

  it('月/日/时/分/秒两位补零，毫秒三位补零', () => {
    expect(localIsoTs(new Date(2024, 0, 2, 3, 4, 5, 6)).slice(0, 23)).toBe('2024-01-02T03:04:05.006')
  })

  it('取的是本机墙钟时间，不是 UTC（本地构造 → 本地读数逐字段相等）', () => {
    expect(localIsoTs(new Date(2024, 5, 1, 23, 30, 15, 7)).slice(0, 23)).toBe('2024-06-01T23:30:15.007')
  })

  it('尾部偏移如实反映本机时区：与 getTimezoneOffset 取反一致，回环解析回同一毫秒', () => {
    // 取冬/夏两个日期：有夏令时的时区两天偏移不同，写死任何一个都会在另一半机器上失败
    for (const d of [new Date(2024, 0, 15, 12, 0, 0, 0), new Date(2024, 6, 15, 12, 0, 0, 0)]) {
      const off = -d.getTimezoneOffset() // 东半球为正
      const abs = Math.abs(off)
      const tail = `${off >= 0 ? '+' : '-'}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`
      const ts = localIsoTs(d)
      expect(ts.slice(23)).toBe(tail) // 前 23 字符 = YYYY-MM-DDTHH:mm:ss.sss，其后即偏移
      expect(new Date(ts).getTime()).toBe(d.getTime())
    }
  })

  it('回环：格式化后再解析总是回到同一毫秒（覆盖闰日/年末/年初/夏令时切换）', () => {
    const dates = [
      new Date(2024, 0, 1, 0, 0, 0, 0),
      new Date(2024, 1, 29, 12, 34, 56, 789),
      new Date(2024, 2, 10, 2, 30, 0, 1), // 北美夏令时切换当日（跳变区间）
      new Date(2024, 9, 27, 2, 30, 0, 999), // 欧洲夏令时切换当日
      new Date(2023, 11, 31, 23, 59, 59, 999),
      new Date(2024, 11, 31, 23, 59, 59, 999),
      ...Array.from({ length: 12 }, (_, i) => new Date(2024, i, 15, 6, 7, 8, 9)),
    ]
    for (const d of dates) expect(new Date(localIsoTs(d)).getTime()).toBe(d.getTime())
  })

  it('默认参数取当前时刻', () => {
    const before = Date.now()
    const parsed = new Date(localIsoTs()).getTime()
    const after = Date.now()
    expect(parsed).toBeGreaterThanOrEqual(before)
    expect(parsed).toBeLessThanOrEqual(after)
  })
})

describe('time · localDateStr', () => {
  it('等于 localIsoTs 的前 10 个字符（两者口径必须一致，日志文件名与时间戳才不打架）', () => {
    for (const d of [new Date(2024, 0, 1, 0, 0, 0, 0), new Date(2024, 11, 31, 23, 59, 59, 999)]) {
      expect(localDateStr(d)).toBe(localIsoTs(d).slice(0, 10))
    }
  })

  it('按本地日期取日：边界日期跟随本机时区', () => {
    expect(localDateStr(new Date(2024, 0, 1, 0, 0, 0, 0))).toBe('2024-01-01')
    expect(localDateStr(new Date(2023, 11, 31, 23, 59, 59, 999))).toBe('2023-12-31')
    expect(localDateStr(new Date(2024, 1, 29, 12, 0, 0, 0))).toBe('2024-02-29')
  })

  it('默认参数取当前日期', () => {
    const before = new Date()
    const out = localDateStr()
    const after = new Date()
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    // 允许跨零点：取调用前后两个日期之一即可，避免午夜整点跑出假红
    expect([localDateStr(before), localDateStr(after)]).toContain(out)
  })
})
