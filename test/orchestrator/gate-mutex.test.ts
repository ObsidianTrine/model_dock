// DM-01 回归：人工批示与自动批示共用任务锁（gate mutex，2026-11-25 健康审计）。
// 缺陷：doApprove / doReject / doRetry 与自动批示 sweep 全程不持任务锁、动作前不复查卡位——
//   sweep 判定超时进入 finish 的数分钟里，人工 reject / retry / approve 照常执行：
//   ① reject 把卡迁 failed/，finish 不知情照常合并，随后 moveCard 抛错，本轮 sweep 余卡全跳过；
//   ② 人工 approve 与 sweep 的自动返工撞车，两个进程同写一个 worktree，随后 finish 还会删它。
// 收敛：闸门动作（approve / retry）全程持任务锁（run 闭环内嵌套调用同 pid 重入豁免），
//   reject / approve / retry 动作前查锁（锁活即拒绝并点名持有者）；sweep 逐卡动作前复查卡位；
//   finish 返回后复查卡仍在 awaiting-human/，不在则不记 merged、按失败处理。
// 夹具：手造闸门卡（不跑 mock 闭环）+ 可控 finish 桩。doApprove spawn 的是「被操作仓库自己的」.agents/scripts/feature-branch.mjs——测试在
// （读锁落盘 / 按指令文件改卡位 / 等放行信号），不 vi.mock
// orchestrator.*（runOrchInproc 立规：共享单例）。

import { describe, expect, it } from 'vitest'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { appendEvent } from '../../.agents/scripts/orchestrator/events.mjs'
import { cardText, eventsOf, mkRepo, runOrch, tryOrch } from './helpers.js'

const AA_CFG = { enabled: true, timeoutMinutes: 1, maxAutoRetry: 1 }
const ORCH = path.resolve(process.cwd(), '.agents', 'scripts', 'orchestrator.mjs')

function queueDir(repo: string, state: string): string {
  return path.join(repo, '.agents', 'orchestrator', 'queue', state)
}

const LOCK = (repo: string, id: string) => path.join(repo, '.agents', 'orchestrator', `.run-${id}.lock`)
const SEEN = (repo: string, id: string) => path.join(repo, `gm-lock-seen-${id}.json`)
const HOLD = (repo: string, id: string) => path.join(repo, `gm-finish-hold-${id}`)
const RELEASE = (repo: string, id: string) => path.join(repo, `gm-finish-release-${id}`)
const DIRECTIVE = (repo: string, id: string) => path.join(repo, `gm-finish-directive-${id}`)

function cardIn(repo: string, state: string, id: string): boolean {
  return fs.existsSync(path.join(queueDir(repo, state), `${id}.md`))
}

/**
 * 手造闸门卡（不跑 mock 闭环——单文件 7 次闭环会撞套件 8 分钟悬死看门狗）：提交 → 摆到
 * awaiting-human/ → 建一条带提交的 feature 分支（doApprove 防假合并门要求 commitsAhead>0，
 * finish 已换成桩、不真合并）。
 */
function placeGateCard(repo: string, id: string): void {
  const cardFile = path.join(repo, `card-${id}.md`)
  fs.writeFileSync(cardFile, cardText({ id, gate: 'L3' }))
  runOrch(repo, `submit "${cardFile}"`)
  fs.mkdirSync(queueDir(repo, 'awaiting-human'), { recursive: true })
  fs.renameSync(path.join(queueDir(repo, 'pending'), `${id}.md`), path.join(queueDir(repo, 'awaiting-human'), `${id}.md`))
  const g = (args: string[]) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' })
  g(['checkout', '-q', '-b', `feature/${id}`])
  fs.writeFileSync(path.join(repo, `${id}.txt`), 'x\n')
  g(['add', '-A'])
  g(['commit', '-q', '-m', 'task work'])
  g(['checkout', '-q', 'develop'])
}

/** 播种一把「beat 新鲜」的任务锁（taskLockLooksLive 只看心跳；pid 指向本测试进程 = 存活）。 */
function seedLiveLock(repo: string, id: string, cmd: string): void {
  fs.mkdirSync(path.dirname(LOCK(repo, id)), { recursive: true })
  fs.writeFileSync(LOCK(repo, id), JSON.stringify({ pid: process.pid, task: id, cmd, acquired_at: new Date().toISOString(), beat: Date.now() }))
}

/** 可控 finish 桩（替换被操作仓库副本里的 feature-branch.mjs；doApprove 以 cwd=repoRoot spawn 它）。 */
const FINISH_STUB = `import fs from 'node:fs';
import path from 'node:path';
const repo = process.cwd();
const id = process.argv[3];
// 进场即读任务锁并落盘（测试据此断言 doApprove 全程持锁、pid 是编排器进程）
let lock = null;
try { lock = JSON.parse(fs.readFileSync(path.join(repo, '.agents', 'orchestrator', '.run-' + id + '.lock'), 'utf8')); } catch { /* 无锁 */ }
fs.writeFileSync(path.join(repo, 'gm-lock-seen-' + id + '.json'), JSON.stringify(lock));
// 指令文件：模拟 finish 期间的外部状态变化 / 失败
const directive = path.join(repo, 'gm-finish-directive-' + id);
const d = fs.existsSync(directive) ? fs.readFileSync(directive, 'utf8').trim() : '';
const queue = path.join(repo, '.agents', 'orchestrator', 'queue');
if (d === 'move-to-failed') {
  fs.mkdirSync(path.join(queue, 'failed'), { recursive: true });
  fs.renameSync(path.join(queue, 'awaiting-human', id + '.md'), path.join(queue, 'failed', id + '.md'));
}
if (d === 'exit-1') {
  console.error('gm finish stub: failed on directive');
  process.exit(1);
}
// 等放行信号：把 doApprove 钉在 finish 里，测试趁窗口插入人工动作
const hold = path.join(repo, 'gm-finish-hold-' + id);
if (fs.existsSync(hold)) {
  const gate = path.join(repo, 'gm-finish-release-' + id);
  const t0 = Date.now();
  while (!fs.existsSync(gate) && Date.now() - t0 < 120000) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
}
console.log('gm finish stub ok');
`

function installFinishStub(repo: string): void {
  fs.writeFileSync(path.join(repo, '.agents', 'scripts', 'feature-branch.mjs'), FINISH_STUB)
}

interface OrchRun {
  child: ChildProcess
  done: Promise<{ status: number | null; out: string }>
}

/** 异步拉起 orchestrator CLI（stdio:inherit 的孙进程输出不经 pipe，这里只收 CLI 自身输出）。 */
function startOrch(repo: string, args: string[]): OrchRun {
  const child = spawn(process.execPath, [ORCH, ...args], { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  child.stdout?.on('data', (c: Buffer) => (out += c.toString()))
  child.stderr?.on('data', (c: Buffer) => (out += c.toString()))
  const done = new Promise<{ status: number | null; out: string }>((resolve) => child.on('close', (status) => resolve({ status, out })))
  return { child, done }
}

/** 阻塞等待文件出现（子进程独立运行；同步轮询不占事件循环）。 */
function waitForFile(p: string, ms = 240_000): void {
  const t0 = Date.now()
  while (!fs.existsSync(p) || fs.statSync(p).size === 0) { // 存在且非空（writeFileSync 建文件与落内容之间有窗口）
    if (Date.now() - t0 > ms) throw new Error(`等待超时：${p}`)
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)
  }
}

/** 手造「审查通过 + 超时未批示」现场：review_verdict blockers=0 且时间戳回拨（sweep 据此推荐合并）。 */
function placeTimedGateCard(repo: string, id: string): void {
  placeGateCard(repo, id)
  const logsDir = path.join(repo, '.agents', 'orchestrator', 'logs', id)
  fs.mkdirSync(logsDir, { recursive: true })
  appendEvent(logsDir, 'task_accepted', {})
  appendEvent(logsDir, 'review_verdict', { blockers: 0, suggestions: 0, notes: 0 })
  const f = path.join(logsDir, 'events.jsonl')
  const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean)
  const last = JSON.parse(lines[lines.length - 1]) as { seq?: number }
  lines[lines.length - 1] = JSON.stringify({ ...last, ts: new Date(Date.now() - 10 * 60_000).toISOString() })
  lines.push(JSON.stringify({ ts: new Date(Date.now() - 9 * 60_000).toISOString(), seq: (last.seq ?? 0) + 1, type: 'awaiting_human', reason: 'level L3 超出 gate L3 上限或 gate=L3' }))
  fs.writeFileSync(f, `${lines.join('\n')}\n`)
}

/** 同仓多卡：全部摆好后统一把 finish 换成可控桩（桩不认 start，不能与真实工具链调用并存）。 */
function runToGateStubbed(repo: string, ids: string[], timed: boolean): void {
  for (const id of ids) (timed ? placeTimedGateCard : placeGateCard)(repo, id)
  installFinishStub(repo)
}

describe('gate mutex > 人工动作前查任务锁', () => {
  it('锁被存活进程持有（beat 新鲜）→ reject 拒绝并点名持有者：卡留 awaiting-human/、事件链无 human_gate', () => {
    const repo = mkRepo()
    try {
      placeGateCard(repo.root, 'gm-reject')
      seedLiveLock(repo.root, 'gm-reject', 'approve')
      const r = tryOrch(repo.root, 'reject gm-reject --reason "不行"')
      expect(r.status).not.toBe(0)
      expect(r.stderr).toContain(String(process.pid))
      expect(r.stderr).toContain('approve')
      expect(cardIn(repo.root, 'awaiting-human', 'gm-reject')).toBe(true)
      expect(cardIn(repo.root, 'failed', 'gm-reject')).toBe(false)
      expect(eventsOf(repo.root, 'gm-reject').some((e) => e.type === 'human_gate')).toBe(false)
    } finally {
      repo.cleanup()
    }
  })

  it('陈锁（心跳静默）不拦人：reject 照常落 failed/', () => {
    const repo = mkRepo()
    try {
      placeGateCard(repo.root, 'gm-stale')
      fs.mkdirSync(path.dirname(LOCK(repo.root, 'gm-stale')), { recursive: true })
      fs.writeFileSync(
        LOCK(repo.root, 'gm-stale'),
        JSON.stringify({ pid: process.pid, task: 'gm-stale', cmd: 'run', acquired_at: new Date().toISOString(), beat: Date.now() - 600_000 }),
      )
      const r = tryOrch(repo.root, 'reject gm-stale --reason "不行"')
      expect(r.status).toBe(0)
      expect(cardIn(repo.root, 'failed', 'gm-stale')).toBe(true)
      expect(eventsOf(repo.root, 'gm-stale').some((e) => e.type === 'human_gate' && e.decision === 'rejected')).toBe(true)
    } finally {
      repo.cleanup()
    }
  })

  for (const act of [
    { cmd: 'approve gm-held', label: 'approve' },
    { cmd: 'retry gm-held --note "补充"', label: 'retry' },
  ]) {
    it(`锁被存活进程持有 → CLI ${act.label} 拒绝：卡原位不动、不写 human_gate、不起 finish`, () => {
      const repo = mkRepo()
      try {
        placeGateCard(repo.root, 'gm-held')
        seedLiveLock(repo.root, 'gm-held', 'run')
        const developBefore = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo.root, encoding: 'utf8' }).stdout.trim()
        const r = tryOrch(repo.root, act.cmd)
        expect(r.status).not.toBe(0)
        expect(r.stderr).toContain(String(process.pid))
        expect(r.stderr).toContain('run')
        expect(cardIn(repo.root, 'awaiting-human', 'gm-held')).toBe(true)
        for (const s of ['running', 'merged', 'failed', 'blocked']) expect(cardIn(repo.root, s, 'gm-held')).toBe(false)
        expect(eventsOf(repo.root, 'gm-held').some((e) => e.type === 'human_gate')).toBe(false)
        expect(spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo.root, encoding: 'utf8' }).stdout.trim()).toBe(developBefore)
      } finally {
        repo.cleanup()
      }
    })
  }
})

describe('gate mutex > doApprove 全程持锁', () => {
  it('approve 进行期间任务锁的 pid 是编排器进程、cmd=approve、心跳新鲜；结束后锁释放、卡落 merged/', async () => {
    const repo = mkRepo()
    try {
      runToGateStubbed(repo.root, ['gm-lock'], false)
      fs.writeFileSync(HOLD(repo.root, 'gm-lock'), '')
      const run = startOrch(repo.root, ['approve', 'gm-lock'])
      run.done.catch(() => {}) // 仅注册拒绝处理；结果在放行后断言
      try {
        waitForFile(SEEN(repo.root, 'gm-lock'))
        const lock = JSON.parse(fs.readFileSync(SEEN(repo.root, 'gm-lock'), 'utf8')) as { pid?: number; cmd?: string; beat?: number } | null
        expect(lock, 'doApprove 进行期间必须持有任务锁').not.toBeNull()
        expect(lock?.pid).toBe(run.child.pid)
        expect(lock?.cmd).toBe('approve')
        expect(Date.now() - (lock?.beat ?? 0)).toBeLessThan(60_000)
      } finally {
        fs.writeFileSync(RELEASE(repo.root, 'gm-lock'), '')
      }
      const r = await run.done
      expect(r.status, r.out).toBe(0)
      expect(cardIn(repo.root, 'merged', 'gm-lock')).toBe(true)
      expect(fs.existsSync(LOCK(repo.root, 'gm-lock'))).toBe(false)
      expect(eventsOf(repo.root, 'gm-lock').filter((e) => e.type === 'merged')).toHaveLength(1)
    } finally {
      repo.cleanup()
    }
  }, 240_000)

  it('finish 失败（exit 1）→ 任务锁随失败释放，卡留 awaiting-human/ 可重试', async () => {
    const repo = mkRepo()
    try {
      runToGateStubbed(repo.root, ['gm-fail'], false)
      fs.writeFileSync(DIRECTIVE(repo.root, 'gm-fail'), 'exit-1')
      const r = await startOrch(repo.root, ['approve', 'gm-fail']).done
      expect(r.status).not.toBe(0)
      expect(cardIn(repo.root, 'awaiting-human', 'gm-fail')).toBe(true)
      expect(fs.existsSync(LOCK(repo.root, 'gm-fail'))).toBe(false)
      expect(eventsOf(repo.root, 'gm-fail').some((e) => e.type === 'merged')).toBe(false)
    } finally {
      repo.cleanup()
    }
  }, 240_000)
})

describe('gate mutex > 自动批示 sweep × 人工动作', () => {
  it('sweep 自动合并进行中插入人工 reject / approve / retry：全部被锁拒绝，卡留闸门；sweep 正常收敛落 merged/', async () => {
    const repo = mkRepo({ extra: { autoApprove: AA_CFG } })
    try {
      runToGateStubbed(repo.root, ['gm-race'], true)
      fs.writeFileSync(HOLD(repo.root, 'gm-race'), '')
      const sweep = startOrch(repo.root, ['autoapprove'])
      sweep.done.catch(() => {})
      try {
        waitForFile(SEEN(repo.root, 'gm-race'))
        const reject = tryOrch(repo.root, 'reject gm-race --reason "晚到的驳回"')
        const approve = tryOrch(repo.root, 'approve gm-race')
        const retry = tryOrch(repo.root, 'retry gm-race --note "晚到的返工"')
        for (const r of [reject, approve, retry]) {
          expect(r.status).not.toBe(0)
          expect(r.stderr).toContain(String(sweep.child.pid))
        }
        expect(cardIn(repo.root, 'awaiting-human', 'gm-race')).toBe(true)
        expect(eventsOf(repo.root, 'gm-race').some((e) => e.type === 'human_gate')).toBe(false)
      } finally {
        fs.writeFileSync(RELEASE(repo.root, 'gm-race'), '')
      }
      const r = await sweep.done
      expect(r.status, r.out).toBe(0)
      expect(cardIn(repo.root, 'merged', 'gm-race')).toBe(true)
      expect(eventsOf(repo.root, 'gm-race').some((e) => e.type === 'merged' && e.auto === true)).toBe(true)
      expect(fs.existsSync(LOCK(repo.root, 'gm-race'))).toBe(false)
    } finally {
      repo.cleanup()
    }
  }, 240_000)

  it('finish 期间卡离开 awaiting-human/ → 不记 merged、按失败处理，本轮 sweep 余卡照常批示', () => {
    const repo = mkRepo({ extra: { autoApprove: AA_CFG } })
    try {
      runToGateStubbed(repo.root, ['gm-left-a', 'gm-left-b'], true)
      fs.writeFileSync(DIRECTIVE(repo.root, 'gm-left-a'), 'move-to-failed')
      const r = runOrch(repo.root, 'autoapprove')
      expect(r.status).toBe(0)
      expect(cardIn(repo.root, 'failed', 'gm-left-a')).toBe(true)
      expect(eventsOf(repo.root, 'gm-left-a').some((e) => e.type === 'merged')).toBe(false)
      expect(cardIn(repo.root, 'merged', 'gm-left-b')).toBe(true)
      expect(eventsOf(repo.root, 'gm-left-b').some((e) => e.type === 'merged' && e.auto === true)).toBe(true)
      expect(fs.existsSync(LOCK(repo.root, 'gm-left-a'))).toBe(false)
    } finally {
      repo.cleanup()
    }
  }, 240_000)

  it('CLI approve 期间卡离开闸门 → 非零退出、不记 merged', async () => {
    const repo = mkRepo()
    try {
      runToGateStubbed(repo.root, ['gm-left-cli'], false)
      fs.writeFileSync(DIRECTIVE(repo.root, 'gm-left-cli'), 'move-to-failed')
      const r = await startOrch(repo.root, ['approve', 'gm-left-cli']).done
      expect(r.status).not.toBe(0)
      expect(eventsOf(repo.root, 'gm-left-cli').some((e) => e.type === 'merged')).toBe(false)
      expect(fs.existsSync(LOCK(repo.root, 'gm-left-cli'))).toBe(false)
    } finally {
      repo.cleanup()
    }
  }, 240_000)

  it('sweep 快照之后、轮到该卡之前被人工批示 → 动作前复查卡位跳过：不二次批示、不崩本轮 sweep', async () => {
    const repo = mkRepo({ extra: { autoApprove: AA_CFG } })
    try {
      runToGateStubbed(repo.root, ['gm-snap-a', 'gm-snap-b'], true)
      fs.writeFileSync(HOLD(repo.root, 'gm-snap-a'), '') // a 先进 finish 并钉住；b 趁窗口由人工放行
      const sweep = startOrch(repo.root, ['autoapprove'])
      sweep.done.catch(() => {})
      try {
        waitForFile(SEEN(repo.root, 'gm-snap-a'))
        const human = tryOrch(repo.root, 'approve gm-snap-b')
        expect(human.status, human.stderr).toBe(0)
        expect(cardIn(repo.root, 'merged', 'gm-snap-b')).toBe(true)
      } finally {
        fs.writeFileSync(RELEASE(repo.root, 'gm-snap-a'), '')
      }
      const r = await sweep.done
      expect(r.status, r.out).toBe(0)
      const evts = eventsOf(repo.root, 'gm-snap-b')
      expect(evts.filter((e) => e.type === 'merged')).toHaveLength(1)
      expect(evts.some((e) => e.type === 'auto_merge_decision')).toBe(false)
      expect(cardIn(repo.root, 'merged', 'gm-snap-a')).toBe(true)
    } finally {
      repo.cleanup()
    }
  }, 300_000)
})
