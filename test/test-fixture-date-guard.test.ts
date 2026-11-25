import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// 防夹具日期炸弹门禁（审计 E-05）。
//
// 为什么：测试里写死一个「靠近今天」的日期，再在同一个文件里读系统时钟（Date.now()/new Date()），
// 就是一颗定时炸弹——今天落在代码容忍窗内所以绿，过几周越窗就无端变红。2026-11-16 已实际炸过：
// test/orchestrator/research.test.ts 写死 2026-11-08，越过调研引用的 7 天陈旧窗后 3 个用例齐红。
// 正确做法是相对日期夹具：`import { isoDaysFromNow, todayIso } from './helpers/dates.js'`。
//
// 规则（纯文本扫描，零 IO mock；三平台一致，换行归一化后再判）：
//   命中 = 文件里有「写死日期字面量 YYYY-MM-DD」且同文件有「无参 Date.now() / new Date()」。
//   排除不构成夹具的行：整行注释、it/test/describe 标题行、`anthropic-version` 等版本串行。
//   门禁自身内嵌坏例夹具（只作静态样例、不执行），从扫描集剔除。
//
// 存量豁免：本仓已有 34 个测试文件在长期演进中形成了「展示/排序用固定日期 + 时钟用于轮询」的组合。
// 这些日期经逐文件核对**不参与当前时钟比较**（多为显式注入的固定 t0、历史元数据或展示字段），
// 一次性登记在下表。豁免按文件登记（不记条数）——豁免文件里新增展示日期不会误红，代价是门禁不再
// 复核这些文件的增量（并行开发下按条数棘轮会频繁撞红无关改动）。迁移某个文件到相对日期后整条删除；
// 不要为新文件再加豁免。
export const EXEMPT: Record<string, string> = {
  'test/backup.test.ts': '2099 未来时间戳只用于快照排序/命名，不参与当前时钟比较',
  'test/cloudserver.test.ts': '文档同步夹具的固定 rev/ts，仅用于 if-match 与回放顺序',
  'test/daemon-lifecycle.test.ts': 'gateway.json / 探活夹具的陈旧 started_at；当前时钟只用于轮询超时',
  'test/debuglog.test.ts': 'pruneExpiredLogs 显式注入固定 now；真实时钟只用于日志文件名',
  'test/diag.test.ts': 'live-state 夹具的固定 started_at 仅作展示；真实时钟用于其他诊断用例',
  'test/gateway-audit1112b.test.ts': '日聚合 dayKey 固定值用于计量夹具；真实时钟用于轮询超时',
  'test/gateway-ephemeral.test.ts': '一次性凭据夹具显式传入固定 t0；Date.now 只用于轮询与相对过期',
  'test/gateway-shared.test.ts': '探活 mock 的固定 started_at 仅作展示；Date.now 只用于超时上界',
  'test/gateway.test.ts': '日志环/节假日缓存夹具的固定 ts 用于展示与聚合',
  'test/modelmeta.test.ts': 'fetchedAt 期望值固定用于目录缓存展示；其他夹具用相对当前时间',
  'test/observability.test.ts': '请求日志 ts 固定用于展示/聚合断言；真实时钟用于其他观测用例',
  'test/relay-concurrency.test.ts': 'ratelimit 头与 now 均显式传入；Date.now 只用于生成 Date 头',
  'test/state-gaps.test.ts': 'STARTED/请求日志 ts 为显式入参；熔断窗口用相对 Date.now 构造',
  'test/sync-engine-gaps.test.ts': 'manifest ts 固定用于版本排序；心跳 desiredTs 用相对当前时间',
  'test/syncagent.test.ts': 'attached_at 历史夹具；相对 Date.now+60s 用于同步状态用例',
  'test/syncdoc-recovery.test.ts': '同步文档固定 ts 排序夹具；remoteDoc.ts 用相对当前时间',
  'test/syncpull.test.ts': 'attached_at 历史夹具；时钟由 vi.setSystemTime 显式控制',
  'test/time.test.ts': '固定日期是 localIsoTs/localDateStr 的期望输出；真实时钟只用于漂移上界',
  'test/usage-cost.test.ts': '日志 ts 固定用于按天聚合；实时计数用例用相对 Date.now',
  'test/webui-dom.test.ts': 'DOM 渲染夹具的展示日期不与当前时钟比较；健康证据用相对时间',
  'test/orchestrator/autoresume.test.ts': '测试固定时钟 NOW=Date.parse(...)，事件 ts 相对它构造；真实时钟只用于锁心跳',
  'test/orchestrator/cost.test.ts': '起止时间为展示夹具；localDate 默认参数不参与该断言',
  'test/orchestrator/drafts-gc.test.ts': 'GC 用固定 NOW 与固定 created_at；CLI e2e 用相对真实时钟构造 20 天前',
  'test/orchestrator/drift.test.ts': 'degraded_at 固定展示夹具；另一用例用真实时钟写入',
  'test/orchestrator/fleet-console.test.ts': 'degraded_at 固定展示夹具；hoursAgo 用相对时间',
  'test/orchestrator/provision.test.ts': 'mock 一次性凭据 expires_at 固定回放；续期用例用相对 Date.now',
  'test/orchestrator/reconcile.test.ts': '按天日志文件名/日期固定用于按日读取断言；midnight 用真实时钟取当天窗口',
  'test/orchestrator/research-multi.test.ts': 'topic.created_at 固定元数据；引用日期用 TODAY（相对当前时间）',
  'test/orchestrator/sail.test.ts': 'startedAt/finishedAt 为成本展示夹具；created_at 用相对当前时间',
  'test/orchestrator/snapshot-quality.test.ts': 'brief.created_at 固定元数据；引用日期用 TODAY（相对当前时间）',
  'test/orchestrator/supply.test.ts': 'mock 凭据 expires_at 固定回放；真实时钟只用于轮询告警超时',
  'test/orchestrator/transient.test.ts': '崩溃窗口 WIN/条目 ts 显式固定；其他用例用真实时钟构造当日窗口',
  'test/orchestrator/weather-sea.test.ts': 'meltdown until 为固定夹具回放；真实时钟只用于轮询超时',
  'test/orchestrator/weather.test.ts': '测试固定时钟 NOW=Date.parse(...)；事件 ts 相对构造',
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SELF = 'test/test-fixture-date-guard.test.ts'

const DATE_LITERAL = /['"`](20\d{2}-\d{2}-\d{2})(?:[T ][^'"`]*)?['"`]/g
const AMBIENT_CLOCK = /\bDate\.now\s*\(\s*\)|\bnew Date\s*\(\s*\)/
// 不算夹具的行：整行注释、用例标题（it/test/describe 的首行）、版本串（anthropic-version / version:）
const SKIP_LINE = /^(\/\/|\*|\/\*|it\s*[.(]|test\s*[.(]|describe\s*[.(])/
const VERSION_LINE = /anthropic-version|\bversion\b\s*[:=]/i

export interface DateBombHit {
  line: number
  literal: string
}

/** 单文件文本里的日期炸弹候选行（不判断文件是否有系统时钟）。 */
export function findDateBombLines(text: string): DateBombHit[] {
  const hits: DateBombHit[] = []
  text.replace(/\r\n/g, '\n').split('\n').forEach((raw, idx) => {
    if (SKIP_LINE.test(raw.trim()) || VERSION_LINE.test(raw)) return
    DATE_LITERAL.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = DATE_LITERAL.exec(raw))) hits.push({ line: idx + 1, literal: m[1] })
  })
  return hits
}

/** 递归收集 test/ 下所有 *.test.ts（posix 相对路径，排序稳定）。 */
export function walkTestFiles(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string, rel: string[]) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(dir, e.name), [...rel, e.name])
      else if (e.name.endsWith('.test.ts')) out.push(['test', ...rel, e.name].join('/'))
    }
  }
  walk(path.join(root, 'test'), [])
  return out.sort()
}

/** 全仓扫描：返回「写死日期 + 同文件系统时钟」的文件 → 命中行。 */
export function scanDateBombs(root: string): Map<string, DateBombHit[]> {
  const result = new Map<string, DateBombHit[]>()
  for (const rel of walkTestFiles(root)) {
    if (rel === SELF) continue
    const text = readFileSync(path.join(root, ...rel.split('/')), 'utf8')
    if (!AMBIENT_CLOCK.test(text)) continue
    const hits = findDateBombLines(text)
    if (hits.length) result.set(rel, hits)
  }
  return result
}

/** 未登记豁免的文件（新文件命中 → 红）。 */
export function unexempted(root: string): { file: string; reason: string; hits: DateBombHit[] }[] {
  const out: { file: string; reason: string; hits: DateBombHit[] }[] = []
  for (const [file, hits] of scanDateBombs(root)) {
    if (EXEMPT[file]) continue
    out.push({ file, reason: '未登记豁免（新文件请改用 test/helpers/dates.ts 的相对日期）', hits })
  }
  return out
}

describe('防夹具日期炸弹：现行测试（develop 基线零违规）', () => {
  it('扫描集非空且确实读到测试文件', () => {
    expect(walkTestFiles(ROOT).length).toBeGreaterThan(100)
  })

  it('没有未登记的「写死日期 + 系统时钟」组合', () => {
    expect(unexempted(ROOT)).toEqual([])
  })

  it('豁免清单里的文件都还存在（迁移后请删除对应条目）', () => {
    const missing = Object.keys(EXEMPT).filter((rel) => !existsSync(path.join(ROOT, ...rel.split('/'))))
    expect(missing).toEqual([])
  })
})

// ---------------------------------------------------------------- 负例：门禁必须能红

const fixtureDirs: string[] = []

function makeFixture(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'date-guard-fixture-'))
  fixtureDirs.push(dir)
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel)
    mkdirSync(path.dirname(abs), { recursive: true })
    writeFileSync(abs, content)
  }
  return dir
}

afterEach(() => {
  while (fixtureDirs.length) {
    const dir = fixtureDirs.pop()!
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

describe('防夹具日期炸弹：负例', () => {
  it('写死日期 + 同文件 Date.now() 能红', () => {
    const dir = makeFixture({
      'test/bomb.test.ts': ["const created = '2026-11-08'", 'const now = Date.now()', ''].join('\n'),
    })
    const v = unexempted(dir)
    expect(v).toHaveLength(1)
    expect(v[0].file).toBe('test/bomb.test.ts')
    expect(v[0].hits[0].literal).toBe('2026-11-08')
  })

  it('写死日期 + 同文件无参 new Date() 也能红', () => {
    const dir = makeFixture({
      'test/bomb2.test.ts': ["const created = '2026-11-08T00:00:00Z'", 'const now = new Date()', ''].join('\n'),
    })
    expect(unexempted(dir).map((x) => x.file)).toEqual(['test/bomb2.test.ts'])
  })

  it('相对日期夹具 + 系统时钟不误报', () => {
    const dir = makeFixture({
      'test/ok.test.ts': ["import { todayIso } from './helpers/dates.js'", 'const created = todayIso()', 'const now = Date.now()', ''].join('\n'),
    })
    expect(unexempted(dir)).toEqual([])
  })

  it('有写死日期但文件不用系统时钟不误报', () => {
    const dir = makeFixture({
      'test/display.test.ts': ["const label = '2026-11-08'", 'export const x = label', ''].join('\n'),
    })
    expect(unexempted(dir)).toEqual([])
  })

  it('注释 / 用例标题 / 版本串里的日期不误报', () => {
    const dir = makeFixture({
      'test/title.test.ts': [
        "// 事故记录：2026-11-08 首跑（行内注释整行跳过）",
        "it('引用防线（2026-11-08 事故）', () => {",
        "  const version = '2023-06-01'",
        '  const now = Date.now()',
        '})',
        '',
      ].join('\n'),
    })
    expect(unexempted(dir)).toEqual([])
  })

  it('豁免文件内的展示日期不误报（豁免按文件登记）', () => {
    const dir = makeFixture({
      'test/orchestrator/autoresume.test.ts': ["const a = '2026-11-01'", 'const now = Date.now()', ''].join('\n'),
    })
    expect(unexempted(dir)).toEqual([])
  })
})
