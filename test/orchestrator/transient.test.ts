// transient 瞬时故障签名测试：ERA 连接协商失败（zcode CLI，2026-11-03 航行实证）
// 须命中（可退避重试自愈）；既有 429/网络签名不回归；确定性错误不误报。
// B6 扩展：结构化信号优先——网关日志窗口（429/5xx/quota）命中即 transient（source=gateway），
// 无网关数据/未命中/读取失败 fail-open 落回 stderr 正则（source=regex）。

import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  classifyWorkerCrash,
  harnessMatches,
  isCrashStatus,
  isTransientWorkerFailure,
  readGatewayWindowEntries,
  TRANSIENT_RE,
} from '../../.agents/scripts/orchestrator/transient.mjs'

const pad = (n: number, w = 2) => String(n).padStart(w, '0')
const localDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

/** 网关日志条目（LogEntry 子集：分类只认 ts/status/harness）。 */
function gwEntry(status: number, ts: string, harness = 'zcode') {
  return { ts, status, harness, profile: 'glm', model: 'glm-5.3-flash' }
}

describe('orchestrator transient > 瞬时故障签名', () => {
  it('zcode ERA 连接协商失败命中（两种形态与完整堆栈现场）', () => {
    const stack = [
      'at probe (D:\\Programs\\ZCode\\resources\\glm\\zcode.cjs:2217:81178)',
      'at async negotiateEra (D:\\Programs\\ZCode\\resources\\glm\\zcode.cjs:2217:82502)',
      'at async Wyo._connectNegotiated (D:\\Programs\\ZCode\\resources\\glm\\zcode.cjs:2217:105240)',
      'Node.js v24.18.0',
    ].join('\n')
    expect(isTransientWorkerFailure('', stack)).toBe(true)
    expect(TRANSIENT_RE.test('ERA_NEGOTIATION_FAILED: upstream negotiate failed')).toBe(true)
    expect(TRANSIENT_RE.test('era-negotiation timeout')).toBe(true)
  })

  it('既有签名不回归（429/网络码）；确定性错误不误报', () => {
    expect(isTransientWorkerFailure('request failed: 429 too many requests', '')).toBe(true)
    expect(isTransientWorkerFailure('', 'ECONNRESET socket hang up')).toBe(true)
    expect(isTransientWorkerFailure('SyntaxError: Unexpected token', '')).toBe(false)
    expect(isTransientWorkerFailure('', 'command not found: npm')).toBe(false)
  })
})

describe('orchestrator transient > isCrashStatus（崩溃相关状态码）', () => {
  it('429/402/5xx 命中；200/3xx/4xx（非 429/402）/越界不命中', () => {
    expect(isCrashStatus(429)).toBe(true)
    expect(isCrashStatus(402)).toBe(true)
    expect(isCrashStatus(500)).toBe(true)
    expect(isCrashStatus(503)).toBe(true)
    expect(isCrashStatus(599)).toBe(true)
    expect(isCrashStatus(200)).toBe(false)
    expect(isCrashStatus(302)).toBe(false)
    expect(isCrashStatus(401)).toBe(false)
    expect(isCrashStatus(404)).toBe(false)
    expect(isCrashStatus(600)).toBe(false)
    expect(isCrashStatus(undefined)).toBe(false)
  })
})

describe('orchestrator transient > harnessMatches（执行船与日志 harness 宽容匹配）', () => {
  it('-headless 后缀剥离后按词边界匹配；任一侧缺席放行（缺席 ≠ 无辜）', () => {
    expect(harnessMatches('zcode', 'zcode-headless')).toBe(true)
    expect(harnessMatches('zcode-headless', 'zcode-headless')).toBe(true)
    expect(harnessMatches('ZCode', 'zcode-headless')).toBe(true)
    expect(harnessMatches('claude-code', 'claude-headless')).toBe(true)
    expect(harnessMatches('zcode-dev', 'zcode-headless')).toBe(true)
    expect(harnessMatches('claude', 'zcode-headless')).toBe(false)
    // 缺席放行：旧日志无 harness / '-' 占位 / backend 未知
    expect(harnessMatches('-', 'zcode-headless')).toBe(true)
    expect(harnessMatches('', 'zcode-headless')).toBe(true)
    expect(harnessMatches('zcode', '')).toBe(true)
    expect(harnessMatches(undefined, undefined)).toBe(true)
  })
})

describe('orchestrator transient > classifyWorkerCrash（结构化优先，正则兜底）', () => {
  const WIN = { startMs: Date.parse('2026-11-04T10:00:00+08:00'), endMs: Date.parse('2026-11-04T10:05:00+08:00') }
  const mid = '2026-11-04T10:02:30.000+08:00'
  const before = '2026-11-04T09:59:00.000+08:00'
  const after = '2026-11-04T10:06:00.000+08:00'

  it('窗口内本 harness 的 429 → 结构化 transient（上游改文案不再致盲）', () => {
    const entries = [gwEntry(429, mid)]
    const r = classifyWorkerCrash({ output: '', stderrTail: '', entries, window: WIN, backend: 'zcode-headless' })
    expect(r).toEqual({ transient: true, source: 'gateway', hits: 1, reason: '429×1' })
  })

  it('5xx 与 402 同样命中；多状态汇总进 reason', () => {
    const r = classifyWorkerCrash({
      output: '',
      stderrTail: '',
      entries: [gwEntry(503, mid), gwEntry(402, mid), gwEntry(429, mid)],
      window: WIN,
      backend: 'zcode-headless',
    })
    expect(r.transient).toBe(true)
    expect(r.source).toBe('gateway')
    expect(r.hits).toBe(3)
    expect(r.reason).toBe('402×1, 429×1, 503×1') // 状态码升序（确定性输出）
  })

  it('窗口外（前/后）不命中；他 harness 不命中；非崩溃状态不命中', () => {
    const entries = [gwEntry(429, before), gwEntry(429, after), gwEntry(429, mid, 'claude'), gwEntry(200, mid), gwEntry(404, mid)]
    const r = classifyWorkerCrash({ output: '', stderrTail: '', entries, window: WIN, backend: 'zcode-headless' })
    expect(r.transient).toBe(false)
    expect(r.source).toBe('regex')
    expect(r.hits).toBeUndefined()
  })

  it('窗口内命中 + stderr 也带签名：结构化优先（source=gateway）', () => {
    const r = classifyWorkerCrash({
      output: '',
      stderrTail: 'ECONNRESET',
      entries: [gwEntry(429, mid)],
      window: WIN,
      backend: 'zcode-headless',
    })
    expect(r.source).toBe('gateway')
  })

  it('entries=null（无网关数据）→ 正则兜底；窗口非法同样兜底', () => {
    expect(classifyWorkerCrash({ output: '', stderrTail: '429 too many requests', entries: null, window: WIN, backend: 'zcode' })).toEqual({
      transient: true,
      source: 'regex',
    })
    expect(classifyWorkerCrash({ output: '', stderrTail: '', entries: [gwEntry(429, mid)], window: null, backend: 'zcode' })).toEqual({
      transient: false,
      source: 'regex',
    })
    // 网关数据在但零命中：落回正则（worker 可能绕行网关，stderr 仍是有效证据）
    expect(classifyWorkerCrash({ output: '', stderrTail: 'fetch failed', entries: [gwEntry(200, mid)], window: WIN, backend: 'zcode' })).toEqual({
      transient: true,
      source: 'regex',
    })
  })
})

describe('orchestrator transient > readGatewayWindowEntries（落盘读取，fail-open）', () => {
  it('读窗口覆盖的日文件（跨本地午夜自动补足）；gwDir 未配 → null', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gwlog-'))
    try {
      // 窗口跨午夜：d1 23:55 → d2 00:05（本地时区）
      const start = new Date(); start.setHours(23, 55, 0, 0); start.setDate(start.getDate() - 1)
      const end = new Date(start.getTime() + 10 * 60_000)
      const d1 = localDate(start)
      const d2 = localDate(end)
      expect(d1).not.toBe(d2)
      const iso = (base: Date, addMs: number) => new Date(base.getTime() + addMs).toISOString()
      fs.writeFileSync(path.join(dir, `gateway-${d1}.jsonl`), JSON.stringify(gwEntry(429, iso(start, 60_000))) + '\n')
      fs.writeFileSync(path.join(dir, `gateway-${d2}.jsonl`), JSON.stringify(gwEntry(503, iso(start, 9 * 60_000))) + '\n')
      const entries = readGatewayWindowEntries(dir, { startMs: start.getTime(), endMs: end.getTime() })
      expect(entries).not.toBeNull()
      expect(entries!.length).toBe(2)
      // gwDir 缺失 / 窗口非法 → null（= 无网关数据，落回正则）
      expect(readGatewayWindowEntries(null, { startMs: start.getTime(), endMs: end.getTime() })).toBeNull()
      expect(readGatewayWindowEntries(dir, { startMs: NaN, endMs: end.getTime() })).toBeNull()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('日志文件读不了（目录占位文件）→ null（fail-open 落回正则，绝不抛错）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gwlog-bad-'))
    try {
      const now = new Date()
      // 同名**目录**占位：existsSync 命中但 readFileSync 抛 EISDIR
      fs.mkdirSync(path.join(dir, `gateway-${localDate(now)}.jsonl`))
      expect(readGatewayWindowEntries(dir, { startMs: now.getTime() - 60_000, endMs: now.getTime() })).toBeNull()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('无日志文件 → 空数组（目录在、无数据：不算故障，落回正则）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gwlog-empty-'))
    try {
      const now = Date.now()
      const entries = readGatewayWindowEntries(dir, { startMs: now - 60_000, endMs: now })
      expect(entries).toEqual([])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
