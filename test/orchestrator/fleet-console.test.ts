// 舰队控制台（fleet-console.mjs）单测：临时目录伪造多港口，CLI 子进程跑真实脚本，
// 断言聚合计数、坏港口容错与 --json 结构稳定。
// 走子进程而非 import：脚本是独立 CLI（零共享模块），子进程隔离最接近真实用法，
// 也天然规避 vitest 单进程共享注册表（AGENTS.md「vitest 隔离模型」）。
// os.homedir() 在 POSIX 认 $HOME、Windows 认 USERPROFILE——测试把两者都指进沙箱，
// 让「~/.agents/fleet-console.json」落进临时目录，绝不碰真实用户目录。

import { afterAll, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ROOT = path.resolve(process.cwd()) // vitest 的 cwd = 仓库根（worktree 内）
const SCRIPT = path.join(ROOT, '.agents', 'scripts', 'fleet-console.mjs')
const QUEUE_STATES = ['pending', 'running', 'reviewing', 'awaiting-human', 'merged', 'failed', 'blocked']

// realpath：macOS 的 /var→/private/var 会让子进程 process.cwd() 返回真实路径，
// 测试侧所有路径先归一到同一形态，root 断言才能对上（Linux/Windows 无差别）。
const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-console-test-')))

afterAll(() => {
  // Windows 上异步句柄释放可能让 rmSync 瞬间 EBUSY：退避重试（同 test/helpers.ts 策略）
  const backoffMs = [10, 50, 100, 250, 500, 1000]
  for (let i = 0; ; i++) {
    try {
      fs.rmSync(sandbox, { recursive: true, force: true })
      return
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? ''
      if (!['ENOTEMPTY', 'EBUSY', 'EPERM', 'EACCES'].includes(code) || i >= backoffMs.length) throw e
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, backoffMs[i])
    }
  }
})

function mkdirp(p: string): string {
  fs.mkdirSync(p, { recursive: true })
  return p
}

function touch(p: string): void {
  fs.writeFileSync(p, '')
}

/** 在港口 queue/<state>/ 放 N 张卡。 */
function putCards(port: string, state: string, n: number): void {
  const dir = mkdirp(path.join(port, '.agents', 'orchestrator', 'queue', state))
  for (let i = 0; i < n; i++) touch(path.join(dir, `card-${state}-${i}.md`))
}

/** stats 桩：模拟该仓自带 orchestrator.mjs 的 stats --json 输出（回显 --days 便于断言透传）。 */
function putStatsStub(port: string, body: string): void {
  fs.writeFileSync(path.join(mkdirp(path.join(port, '.agents', 'scripts')), 'orchestrator.mjs'), body)
}

/** 建一个「当前仓库」锚（.git 目录），让脚本的 cwd 向上查找停在沙箱自身。 */
touch(path.join(mkdirp(path.join(sandbox, '.git')), 'HEAD'))

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString()

// ---- 港口 A：全量数据（queue 全状态 + fleet.jsonl + nightly + drift + 健康桩 stats）----
const portA = mkdirp(path.join(sandbox, 'portA'))
putCards(portA, 'pending', 2)
putCards(portA, 'running', 1)
putCards(portA, 'reviewing', 1)
putCards(portA, 'awaiting-human', 1)
putCards(portA, 'merged', 3)
putCards(portA, 'failed', 1)
putCards(portA, 'blocked', 1)
const logsA = mkdirp(path.join(portA, '.agents', 'orchestrator', 'logs'))
const fleetLog = path.join(logsA, 'fleet.jsonl')
fs.writeFileSync(
  fleetLog,
  [
    JSON.stringify({ ts: hoursAgo(1), seq: 1, type: 'weather_hold', count: 3 }),
    JSON.stringify({ ts: hoursAgo(2), seq: 2, type: 'sail_started', minutes: 60 }),
    JSON.stringify({ ts: hoursAgo(24 * 5), seq: 3, type: 'weather_hold', count: 9 }),
    JSON.stringify({ ts: hoursAgo(24 * 40), seq: 4, type: 'weather_hold', count: 2 }), // 窗口外
    '半行垃圾（崩溃残留，应被跳过）',
    '',
  ].join('\n'),
)
fs.writeFileSync(
  path.join(logsA, 'nightly-state.json'),
  JSON.stringify({ startedAt: hoursAgo(25), finishedAt: hoursAgo(24), result: 'ok' }),
)
fs.writeFileSync(
  path.join(portA, '.agents', 'orchestrator', 'degraded.json'),
  JSON.stringify({ degraded_at: '2026-11-01T10:00:00Z', reason: '自动合并回溯失败率 33% 超阈值 20%（1/3）', failed_tasks: ['x'], auto_total: 3 }),
)
putStatsStub(
  portA,
  `const i = process.argv.indexOf('--days')
const days = i >= 0 ? Number(process.argv[i + 1]) : 7
process.stdout.write(JSON.stringify({ generated_at: 'stub', summary: { window_days: days, tasks_started: 5, settled: 4, merged: 3, merge_rate: 0.75, near_miss: { watchdog: 1, retries: 2, xte: 0, incidents: 0 } } }))`,
)

// ---- 港口 B：stats 退出 0 但输出垃圾（JSON 解析容错）----
const portB = mkdirp(path.join(sandbox, 'portB'))
putCards(portB, 'pending', 1)
putStatsStub(portB, `process.stdout.write('这不是 JSON {{{')`)

// ---- 港口 C：stats 非零退出 ----
const portC = mkdirp(path.join(sandbox, 'portC'))
putCards(portC, 'blocked', 1)
putStatsStub(portC, `process.stderr.write('boom'); process.exit(1)`)

// ---- 港口 D：有 orchestrator/ 但工具链脚本缺失（stats 不可得，queue 照数）----
const portD = mkdirp(path.join(sandbox, 'portD'))
putCards(portD, 'pending', 1)

// ---- 非港口：无 .agents/orchestrator/ ----
const plain = mkdirp(path.join(sandbox, 'plain'))

function runConsole(args: string[]): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: sandbox,
    encoding: 'utf8',
    // HOME/USERPROFILE 同时指进沙箱：~/.agents/fleet-console.json 落临时目录（三平台）
    env: { ...process.env, HOME: sandbox, USERPROFILE: sandbox },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
  })
  return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

function runJson(args: string[]): any {
  const r = runConsole([...args, '--json'])
  expect(r.status).toBe(0)
  return JSON.parse(r.stdout)
}

function findProject(report: any, root: string): any {
  const p = report.projects.find((x: any) => x.root === root)
  expect(p, `报告里应有项目 ${root}`).toBeTruthy()
  return p
}

describe('fleet-console --json 聚合与容错', () => {
  const report = runJson(['--project', portA, '--project', portB, '--project', portC, '--project', portD, '--project', plain])

  it('顶层结构与 days 缺省值', () => {
    expect(Object.keys(report).sort()).toEqual(['days', 'generated_at', 'projects', 'totals'])
    expect(report.days).toBe(7)
    // CLI 5 项 + 当前仓库（沙箱自身，非港口）自动并入
    expect(report.projects).toHaveLength(6)
  })

  it('项目结构稳定：键集合与 queue 状态顺序', () => {
    expect(Object.keys(report.projects[0]).sort()).toEqual(
      ['drift_degraded', 'exists', 'fleet_events', 'kind', 'name', 'nightly', 'queue', 'root', 'stats_error', 'stats_summary'].sort(),
    )
    expect(Object.keys(report.projects[0].queue)).toEqual(QUEUE_STATES)
  })

  it('健康港口 A：queue 七状态卡数、stats summary、fleet 事件、巡检、漂移', () => {
    const a = findProject(report, portA)
    expect(a.kind).toBe('dockmaster')
    expect(a.queue).toEqual({
      pending: 2, running: 1, reviewing: 1, 'awaiting-human': 1, merged: 3, failed: 1, blocked: 1,
    })
    expect(a.stats_error).toBeNull()
    expect(a.stats_summary).toMatchObject({ window_days: 7, merged: 3, settled: 4, merge_rate: 0.75, near_miss: { watchdog: 1, retries: 2 } })
    // 近 7 天：1h/5d 的 weather_hold（2 次）+ 2h 的 sail_started；40 天外的与半行垃圾被剔除
    expect(a.fleet_events).toEqual({ weather_hold: 2, sail_started: 1 })
    expect(a.nightly?.finishedAt).toBeTruthy()
    expect(a.drift_degraded?.reason).toContain('回溯失败率')
  })

  it('坏港口 B/C/D：stats 标不可得并给出原因，queue 计数不受影响，进程不炸', () => {
    const b = findProject(report, portB)
    expect(b.stats_summary).toBeNull()
    expect(b.stats_error).toContain('JSON')
    expect(b.queue.pending).toBe(1)

    const c = findProject(report, portC)
    expect(c.stats_summary).toBeNull()
    expect(c.stats_error).toContain('退出码 1')
    expect(c.queue.blocked).toBe(1)

    const d = findProject(report, portD)
    expect(d.stats_summary).toBeNull()
    expect(d.stats_error).toContain('未找到')
    expect(d.queue.pending).toBe(1)
  })

  it('非港口标记：plain 与当前仓库（沙箱）均为 non-port', () => {
    expect(findProject(report, plain).kind).toBe('non-port')
    expect(findProject(report, sandbox).kind).toBe('non-port')
  })

  it('全队合计：queue 求和、窗口汇总只对 stats 可得的港口求和、风暴与降级计数', () => {
    const t = report.totals
    expect(t.ports).toBe(4)
    expect(t.non_ports).toBe(2)
    expect(t.queue).toEqual({
      pending: 4, running: 1, reviewing: 1, 'awaiting-human': 1, merged: 3, failed: 1, blocked: 2,
    })
    // 只有 A 的 stats 可得：merged 3 / settled 4 / rate 0.75；near_miss 取 A
    expect(t.merged_window).toBe(3)
    expect(t.settled_window).toBe(4)
    expect(t.merge_rate).toBe(0.75)
    expect(t.near_miss).toEqual({ watchdog: 1, retries: 2, xte: 0, incidents: 0 })
    expect(t.weather_hold).toBe(2)
    expect(t.degraded_ports).toBe(1)
    expect(t.stats_ok_ports).toBe(1)
  })
})

describe('fleet-console --days 透传与窗口过滤', () => {
  it('days 传给各仓 stats（桩回显），fleet 事件按窗口过滤', () => {
    const report = runJson(['--project', portA, '--days', '3'])
    expect(report.days).toBe(3)
    const a = findProject(report, portA)
    expect(a.stats_summary.window_days).toBe(3) // 桩回显：--days 确实透传
    // --days 3：只剩 1h 的 weather_hold；2h 的 sail_started 仍在，5 天前的被窗口剔除
    expect(a.fleet_events).toEqual({ weather_hold: 1, sail_started: 1 })
  })
})

describe('fleet-console 人类可读输出', () => {
  it('表格 + 合计 + 不可得与非港口脚注', () => {
    const r = runConsole(['--project', portA, '--project', portB, '--project', portC, '--project', portD, '--project', plain])
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('⚓ 舰队控制台（近 7 天）')
    expect(r.stdout).toContain('portA')
    expect(r.stdout).toContain('portB')
    expect(r.stdout).toContain('合计')
    expect(r.stdout).toContain('窗口汇总不可得的项目')
    expect(r.stdout).toContain('退出码 1')
    expect(r.stdout).toContain('未找到')
    expect(r.stdout).toContain('非港口（无 .agents/orchestrator/，已跳过）')
    expect(r.stdout).toContain(`  - ${plain}`)
    expect(r.stdout).toContain('降级(') // portA 处于漂移降级期
  })

  it('无任何港口时给可操作指引而不是空表', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-console-empty-'))
    try {
      const r = spawnSync(process.execPath, [SCRIPT, '--project', empty], {
        cwd: empty,
        encoding: 'utf8',
        env: { ...process.env, HOME: empty, USERPROFILE: empty },
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 60_000,
      })
      expect(r.status).toBe(0)
      expect(r.stdout).toContain('没有任何 Dockmaster 港口')
      expect(r.stdout).toContain('--project')
    } finally {
      fs.rmSync(empty, { recursive: true, force: true })
    }
  })
})

describe('fleet-console 配置文件（~/.agents/fleet-console.json）', () => {
  it('CLI + 配置合并去重，相对路径相对 ~/.agents 解析', () => {
    const cfgDir = mkdirp(path.join(sandbox, '.agents'))
    fs.writeFileSync(
      path.join(cfgDir, 'fleet-console.json'),
      JSON.stringify({ projects: [portB, plain, 'relative-x'] }),
    )
    try {
      // portB 同时出现在 CLI 与配置 → 去重只留一份
      const report = runJson(['--project', portA, '--project', portB])
      const roots = report.projects.map((p: any) => p.root)
      expect(roots.filter((r: string) => r === portA)).toHaveLength(1)
      expect(roots.filter((r: string) => r === portB)).toHaveLength(1)
      expect(roots).toContain(plain)
      expect(roots).toContain(path.join(sandbox, '.agents', 'relative-x'))
      expect(roots).toContain(sandbox) // 当前仓库始终并入
    } finally {
      fs.rmSync(path.join(cfgDir, 'fleet-console.json'), { force: true })
    }
  })

  it('配置损坏：告警后忽略（不炸、继续聚合其余来源）', () => {
    const cfgDir = mkdirp(path.join(sandbox, '.agents'))
    fs.writeFileSync(path.join(cfgDir, 'fleet-console.json'), '{ 损坏的 JSON')
    try {
      const r = runConsole(['--project', portA, '--json'])
      expect(r.status).toBe(0)
      expect(r.stderr).toContain('配置文件不是合法 JSON')
      expect(JSON.parse(r.stdout).projects.map((p: any) => p.root)).toContain(portA)
    } finally {
      fs.rmSync(path.join(cfgDir, 'fleet-console.json'), { force: true })
    }
  })
})

describe('fleet-console 参数校验', () => {
  it('--days 非法 → 退出码 1 + 可操作报错；未知参数同样拒收', () => {
    const badDays = runConsole(['--days', '0'])
    expect(badDays.status).toBe(1)
    expect(badDays.stderr).toContain('--days 需要正整数')

    const unknown = runConsole(['--frobnicate'])
    expect(unknown.status).toBe(1)
    expect(unknown.stderr).toContain('未知参数')
  })

  it('--help 输出用法（含配置文件格式）', () => {
    const r = runConsole(['--help'])
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('fleet-console.json')
    expect(r.stdout).toContain('--days')
    expect(r.stdout).toContain('--project')
  })
})
