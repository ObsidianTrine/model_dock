/** 本地时区 ISO 风格时间戳：YYYY-MM-DDTHH:mm:ss.sss±HH:mm。
 *  与 Date.prototype.toISOString()（恒为 UTC）不同，此函数输出本机时区时间，
 *  且保持与 ISO 相同的字符布局 —— 调用方可以继续用 slice(0, 10) 取日期、
 *  slice(11, 19) 取 HH:mm:ss，尾部的 ±HH:mm 偏移不影响这些切片。
 *  用途：请求/审计日志时间戳与按天落盘文件名（用户看到的应是本地时间）。 */
export function localIsoTs(d: Date = new Date()): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, '0')
  const off = -d.getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'
  const abs = Math.abs(off)
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `.${pad(d.getMilliseconds(), 3)}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  )
}

/** 本地时区日期（YYYY-MM-DD），用于日志按天落盘的文件名 */
export function localDateStr(d: Date = new Date()): string {
  return localIsoTs(d).slice(0, 10)
}

/** 解析 HH:mm 为当日分钟数（0-1439）：小时 1-2 位均可（9:05 与 09:05 等价），分钟两位；
 *  形状不符或越界（时>23 / 分>59）返回 null。
 *  网关调度窗口求值（state/routing.ts）与 syncdoc 校验（sync/types.ts）共用本实现——
 *  两处口径必须同源，双实现各写一份正则迟早漂移（known-issues CORRECT-10 教训）。 */
export function parseHHmm(s: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s ?? '').trim())
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (h > 23 || min > 59) return null
  return h * 60 + min
}
