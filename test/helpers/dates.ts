// 相对日期夹具工具（E-05 防夹具日期炸弹）——零依赖、纯函数。
//
// 为什么需要它：测试里写死 `2026-11-08` 这类日期，只有「写测试的那几周」与代码里的
// 容忍窗（如调研引用的 7 天陈旧判定）对得上；时间一过测试就无端变红。2026-11-16 已实际
// 炸过一次（test/orchestrator/research.test.ts，写死 2026-11-08 撞 7 天窗口）。
//
// 用法：夹具日期一律相对「现在」生成——
//   import { isoDaysFromNow, todayIso } from './helpers/dates.js'
//   const BRIEF = `- ${todayIso()} https://example.com — 来源`
//   const expiredAt = isoDaysFromNow(-8)   // 8 天前，永远落在 7 天陈旧窗之外
//
// 配套门禁：test/test-fixture-date-guard.test.ts 会拦截「写死日期 + 同文件使用当前时钟」
// 的新组合（存量文件见该门禁的豁免清单）。

export const DAY_MS = 86_400_000

/** 相对 now 偏移 days 天（可为负）的 Date；now 可注入便于断言。 */
export function daysFromNow(days: number, now: number = Date.now()): Date {
  return new Date(now + days * DAY_MS)
}

/** 相对 now 偏移 days 天的 UTC 日期串 `YYYY-MM-DD`。 */
export function isoDaysFromNow(days: number, now: number = Date.now()): string {
  return daysFromNow(days, now).toISOString().slice(0, 10)
}

/** 相对 now 偏移 days 天的完整 UTC ISO 时间戳（含毫秒与 `Z`）。 */
export function isoDateTimeDaysFromNow(days: number, now: number = Date.now()): string {
  return daysFromNow(days, now).toISOString()
}

/** 今天（UTC）`YYYY-MM-DD`；等价 `isoDaysFromNow(0)`。 */
export function todayIso(now: number = Date.now()): string {
  return isoDaysFromNow(0, now)
}
