// finish × 编排器撞窗防护回归（2026-11-22 三连红事故修复）：编排器在 5–9 分钟套件窗口内
// 做卡片流转/worktree 清理，宿主仓 host-guard 哨兵对账 fail-closed 必红。修复两方向
// （全程互斥持锁方案已被否决：编排器 mutation 散布全 run 生命周期，持锁会饿死并发 finish）：
//   ① finish 门禁开跑前预检活跃任务锁 → 秒级拒绝（不白烧套件）；AGENTS_ALLOW_COLLISION_WINDOW=1 豁免；
//   ② host-guard 归因命中时落 marker（worktree 的 node_modules/.orch-collision.flag，机器契约，
//      字面量与 host-guard.mjs 对接）→ finish 门禁红时读到新鲜 marker → 等编排器静默
//      → 自动重跑门禁一次；重跑仍红且 marker 再现 → die 不再重试。
// 子进程跑真实 feature-branch.mjs；场景经 STUB_MODE 驱动的 stub 门禁 + 手工伪造锁文件
// （不真起持锁进程）。stub 门禁 commit 进临时仓 develop，testCmd 以 worktree 为 cwd
// 相对路径可达（同 finish-merge-conflict.test.ts 的 ADVANCE_HELPER 模式）。

import { describe, expect, it } from 'vitest'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { mkRepo, git } from './helpers.js'
import { killTree } from '../../.agents/scripts/orchestrator/kill-tree.mjs'

const norm = (s: string) => s.replace(/\r\n/g, '\n')

// stub 门禁：按 STUB_MODE 驱动撞窗场景；cwd = worktree，marker 落 <wt>/node_modules/
// （契约路径）。attempts 计数也放 node_modules/（gitignored，不脏 worktree 提交检查）。
// 注意整份源码内不用反引号与 ${}（本文件以模板字符串内联，避免转义地狱）。
const STUB_SRC = `// 测试 stub 门禁（finish-collision.test.ts 专用）：行为由 STUB_MODE env 驱动。
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

const nm = path.join(process.cwd(), 'node_modules')
fs.mkdirSync(nm, { recursive: true })
const attemptsFile = path.join(nm, '.stub-attempts')
let prev = 0
try { prev = Number(fs.readFileSync(attemptsFile, 'utf8').trim() || 0) } catch (e) { /* 首跑：计数从 0 起 */ }
const n = prev + 1
fs.writeFileSync(attemptsFile, String(n))

const mode = process.env.STUB_MODE || 'pass'
const marker = path.join(nm, '.orch-collision.flag')

function writeMarker(summary, ageMs) {
  fs.writeFileSync(marker, JSON.stringify({
    at: Date.now() - (ageMs || 0),
    summary,
    sources: [{ taskId: 'stub-task', holder: 'run', pid: process.pid, beatAgeMs: ageMs || 0 }],
  }))
}

if (mode === 'red-with-marker') {
  // 每跑都写新鲜 marker 并 exit 1：重跑仍红且 marker 再现 → die 不再重试
  writeMarker('stub-collision-attempt-' + n)
  process.exit(1)
}
if (mode === 'marker-lock-hold') {
  // 每跑都写新鲜 marker + 持久伪造任务锁（测试侧删锁才算静默）并 exit 1：把 finish 钉在
  // 撞窗等待里，供「等待期间心跳/锁归属」用例观测 .finish.lock
  writeMarker('stub-collision-hold')
  const lockDir = path.join(process.env.STUB_REPO_ROOT, '.agents', 'orchestrator')
  fs.mkdirSync(lockDir, { recursive: true })
  fs.writeFileSync(path.join(lockDir, '.run-stub-task.lock'), JSON.stringify({
    pid: process.pid, task: 'stub-task', cmd: 'run', acquired_at: new Date().toISOString(), beat: Date.now(),
  }))
  process.exit(1)
}
if (mode === 'stale-marker-once') {
  // 首跑写 16min 前的陈旧 marker 并 exit 1：finish 应按现状 die、顺手清理、不重试
  writeMarker('stale-marker', 16 * 60 * 1000)
  process.exit(1)
}
if (mode === 'marker-then-pass' && n === 1) {
  // 首跑写新鲜 marker 并 exit 1；可选伪造新鲜锁 + detached 子进程延时删锁（覆盖等待轮询）
  writeMarker('stub-collision-once')
  if (process.env.STUB_LOCK_LIVE_MS) {
    const lockDir = path.join(process.env.STUB_REPO_ROOT, '.agents', 'orchestrator')
    fs.mkdirSync(lockDir, { recursive: true })
    const lockPath = path.join(lockDir, '.run-stub-task.lock')
    fs.writeFileSync(lockPath, JSON.stringify({
      pid: process.pid, task: 'stub-task', cmd: 'run',
      acquired_at: new Date().toISOString(), beat: Date.now(),
    }))
    spawn(process.execPath, ['-e', "const fs=require('fs');setTimeout(()=>{try{fs.unlinkSync(process.env.STUB_LOCK_PATH)}catch(e){}},Number(process.env.STUB_LOCK_LIVE_MS))"], { detached: true, stdio: 'ignore', env: { ...process.env, STUB_LOCK_PATH: lockPath } }).unref()
  }
  process.exit(1)
}
process.exit(0)
`

function makeRepoWithStub() {
  const repo = mkRepo({ testCmd: 'node stub-collision-gate.mjs' })
  fs.writeFileSync(path.join(repo.root, 'stub-collision-gate.mjs'), STUB_SRC)
  git(repo.root, 'add -A')
  git(repo.root, 'commit -m stub-gate')
  return repo
}

function runFinish(repo: string, task: string, extraEnv: Record<string, string> = {}, spawnTimeout = 120_000) {
  const script = path.join(repo, '.agents', 'scripts', 'feature-branch.mjs')
  const t0 = Date.now()
  const r = spawnSync(process.execPath, [script, 'finish', task], {
    cwd: repo,
    encoding: 'utf8',
    timeout: spawnTimeout,
    env: { ...process.env, FINISH_LOCK_WAIT_SECONDS: '0', STUB_REPO_ROOT: repo, ...extraEnv },
  })
  return { status: r.status, out: norm(`${r.stdout ?? ''}\n${r.stderr ?? ''}`), elapsedMs: Date.now() - t0 }
}

function startAndCommit(repo: string, id: string) {
  const script = path.join(repo, '.agents', 'scripts', 'feature-branch.mjs')
  const s = spawnSync(process.execPath, [script, 'start', id], {
    cwd: repo,
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env },
  })
  if (s.status !== 0) throw new Error(`start failed: ${s.stdout}\n${s.stderr}`)
  const wt = path.join(repo, '.agents', 'worktrees', id)
  fs.appendFileSync(path.join(wt, 'README.md'), '\nchange\n')
  git(wt, 'add -A')
  git(wt, 'commit -m work')
  return wt
}

// 手工伪造新鲜任务锁（心跳 beat = now → taskLockLooksLive 判活）：不真起持锁进程
function writeLiveLock(repo: string, taskId: string) {
  const dir = path.join(repo, '.agents', 'orchestrator')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `.run-${taskId}.lock`), JSON.stringify({
    pid: process.pid, task: taskId, cmd: 'run', acquired_at: new Date().toISOString(), beat: Date.now(),
  }))
}

const markerOf = (repo: string, task: string) => path.join(repo, '.agents', 'worktrees', task, 'node_modules', '.orch-collision.flag')
const attemptsOf = (repo: string, task: string) => path.join(repo, '.agents', 'worktrees', task, 'node_modules', '.stub-attempts')

// —— 撞窗等待期间 finish 锁的存活与归属（DM-04）——
// 场景：finish A 持 .finish.lock 进入撞窗等待。等待必须让出事件循环（心跳 setInterval 才续得上
// beat），醒来后必须复查锁仍属于自己。时间常量（心跳 15s / 陈锁 60s）不设测试开关：照
// finish-lock.test.ts 的手法直接把锁里的 beat 回拨成陈锁形态。

interface AsyncFinish {
  pid: number
  done: Promise<{ status: number | null; out: string }>
  out: () => string
}

// 后台起一个真实 finish（非 spawnSync）：本进程持 .finish.lock 期间测试侧并行观测/干预
function startFinishAsync(repo: string, task: string, extraEnv: Record<string, string> = {}): AsyncFinish {
  const script = path.join(repo, '.agents', 'scripts', 'feature-branch.mjs')
  const child = spawn(process.execPath, [script, 'finish', task], {
    cwd: repo,
    env: { ...process.env, FINISH_LOCK_WAIT_SECONDS: '0', STUB_REPO_ROOT: repo, STUB_MODE: 'marker-lock-hold', FINISH_COLLISION_POLL_MS: '1000', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let buf = ''
  child.stdout.on('data', (d) => { buf += String(d) })
  child.stderr.on('data', (d) => { buf += String(d) })
  const done = new Promise<{ status: number | null; out: string }>((resolve) => {
    child.on('close', (code) => resolve({ status: code, out: norm(buf) }))
  })
  return { pid: child.pid, done, out: () => norm(buf) }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

async function waitUntil(what: string, pred: () => boolean, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs
  while (!pred()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for: ${what}`)
    await sleep(100)
  }
}

const finishLockPath = (repo: string) => path.join(repo, '.agents', 'worktrees', '.finish.lock')
const stubTaskLockPath = (repo: string) => path.join(repo, '.agents', 'orchestrator', '.run-stub-task.lock')

function readFinishLock(repo: string): { pid?: number; beat?: number } | null {
  try {
    return JSON.parse(fs.readFileSync(finishLockPath(repo), 'utf8'))
  } catch {
    return null // 不在 / 读窗口撞上半个 JSON：按无锁计
  }
}

// 等 finish 持锁并真正进入撞窗等待。不能只看 stub 落下任务锁就返回——那一刻 finish 可能还没复扫，
// 测试抢先删锁会让首轮扫描即静默、根本没等过。确定性信号：finish 读到 marker 后「读后即删」
// （marker 消失 = 已过撞窗判定、马上复扫任务锁），再让出 500ms 确保复扫已发生
async function waitUntilInCollisionWait(repo: string, task: string, a: AsyncFinish) {
  await waitUntil('finish 持锁且 stub 已落下任务锁', () => fs.existsSync(stubTaskLockPath(repo)) && readFinishLock(repo)?.pid === a.pid, 40_000)
  await waitUntil('finish 读到 marker 并进入等待', () => !fs.existsSync(markerOf(repo, task)), 40_000)
  await sleep(500)
}

// 收尾：删掉伪造任务锁让等待中的 finish 自然醒来退出；超时（如仍在同步长睡）则按进程树收割
async function stopFinish(repo: string, a: AsyncFinish) {
  try { fs.rmSync(stubTaskLockPath(repo), { force: true }) } catch { /* 尽力而为 */ }
  const settled = await Promise.race([a.done.then((r) => r), sleep(5_000).then(() => null)])
  if (!settled) killTree(a.pid) // 本用例自己拉起的 finish
}

describe('finish × 编排器撞窗防护', () => {
  it('预检：活跃任务锁 → 开测前秒级拒绝（门禁零跑），报错含 taskId 与豁免键提示', () => {
    const repo = makeRepoWithStub()
    try {
      startAndCommit(repo.root, 'precheck-probe')
      writeLiveLock(repo.root, 'fake-task')
      const r = runFinish(repo.root, 'precheck-probe')
      expect(r.status).toBe(1)
      expect(r.out).toContain('finish 预检发现编排器正在活跃')
      expect(r.out).toContain('fake-task')
      expect(r.out).toContain('AGENTS_ALLOW_COLLISION_WINDOW')
      expect(r.out).toContain('等编排器静默后重跑 finish')
      expect(r.out).not.toContain('Running verification') // 预检在门禁前拦截：一步都没跑
      expect(r.elapsedMs).toBeLessThan(20_000) // 秒级拒绝，不是白烧完门禁再死
    } finally {
      repo.cleanup()
    }
  }, 60_000)

  it('无活跃锁 → 预检放行，门禁绿、正常合并（既有行为零回归）', () => {
    const repo = makeRepoWithStub()
    try {
      startAndCommit(repo.root, 'clean-probe')
      const r = runFinish(repo.root, 'clean-probe', { STUB_MODE: 'pass' })
      expect(r.status).toBe(0)
      expect(r.out).toContain('Merged')
    } finally {
      repo.cleanup()
    }
  }, 60_000)

  it('豁免键 + 新鲜锁 → 跳过预检走到门禁（stub 绿灯合并）', () => {
    const repo = makeRepoWithStub()
    try {
      startAndCommit(repo.root, 'allow-probe')
      writeLiveLock(repo.root, 'fake-task')
      const r = runFinish(repo.root, 'allow-probe', { STUB_MODE: 'pass', AGENTS_ALLOW_COLLISION_WINDOW: '1' })
      expect(r.status).toBe(0)
      expect(r.out).toContain('Running verification') // 预检被豁免：门禁真跑了
      expect(r.out).toContain('Merged')
    } finally {
      repo.cleanup()
    }
  }, 60_000)

  it('marker 新鲜 + 锁本就静默 → 等待立即通过、自动重跑一次后合并成功', () => {
    const repo = makeRepoWithStub()
    try {
      startAndCommit(repo.root, 'retry-probe')
      const r = runFinish(repo.root, 'retry-probe', { STUB_MODE: 'marker-then-pass' })
      expect(r.status).toBe(0)
      expect(r.out).toContain('检测到撞窗签名')
      expect(r.out).toContain('编排器已静默，重跑验证')
      expect(r.out).toContain('Merged')
    } finally {
      repo.cleanup()
    }
  }, 60_000)

  it('marker 新鲜 + 活跃锁在等待期静默（30s 轮询）→ 打印等待提示、重跑成功合并', () => {
    const repo = makeRepoWithStub()
    try {
      startAndCommit(repo.root, 'wait-probe')
      // stub 首跑伪造新鲜锁 + detached 子进程 8s 后删锁：等待循环首轮扫到锁在（打印提示），
      // 30s 轮询次轮锁已静默 → 通过 → 重跑
      const r = runFinish(repo.root, 'wait-probe', { STUB_MODE: 'marker-then-pass', STUB_LOCK_LIVE_MS: '8000' }, 150_000)
      expect(r.status).toBe(0)
      expect(r.out).toContain('检测到活跃编排器任务锁')
      expect(r.out).toContain('等待静默…（已等')
      expect(r.out).toContain('编排器已静默，重跑验证')
      expect(r.out).toContain('Merged')
    } finally {
      repo.cleanup()
    }
  }, 150_000)

  it('marker 陈旧（≥15min 上次会话残留）→ 顺手清理、按现状 die、不重试', () => {
    const repo = makeRepoWithStub()
    try {
      startAndCommit(repo.root, 'stale-probe')
      const r = runFinish(repo.root, 'stale-probe', { STUB_MODE: 'stale-marker-once' })
      expect(r.status).toBe(1)
      expect(r.out).toContain('verification failed') // 完全现状的 die 文案（真失败不陪葬）
      expect(r.out).not.toContain('检测到撞窗签名')
      expect(r.out).not.toContain('编排器已静默，重跑验证')
      expect(fs.existsSync(markerOf(repo.root, 'stale-probe'))).toBe(false) // 陈旧 marker 被顺手清理
      expect(fs.readFileSync(attemptsOf(repo.root, 'stale-probe'), 'utf8').trim()).toBe('1') // 门禁只跑一次：无重试
    } finally {
      repo.cleanup()
    }
  }, 60_000)

  it('marker 新鲜但重跑仍红且 marker 再现 → 带第二次归因摘要 die、不再重试', () => {
    const repo = makeRepoWithStub()
    try {
      startAndCommit(repo.root, 'twice-probe')
      const r = runFinish(repo.root, 'twice-probe', { STUB_MODE: 'red-with-marker' })
      expect(r.status).toBe(1)
      expect(r.out).toContain('重跑验证仍失败')
      expect(r.out).toContain('不再自动重试')
      expect(r.out).toContain('stub-collision-attempt-2') // 第二次的归因摘要进报错
      expect(fs.readFileSync(attemptsOf(repo.root, 'twice-probe'), 'utf8').trim()).toBe('2') // 恰好两次尝试
    } finally {
      repo.cleanup()
    }
  }, 60_000)

  it('撞窗等待期间持锁者心跳持续刷新（beat 不冻结）、第二个 finish 不会接管', async () => {
    const repo = makeRepoWithStub()
    let a: AsyncFinish | null = null
    try {
      startAndCommit(repo.root, 'heartbeat-probe')
      a = startFinishAsync(repo.root, 'heartbeat-probe')
      await waitUntilInCollisionWait(repo.root, 'heartbeat-probe', a)

      // 照 finish-lock.test.ts 手法：把持锁者的 beat 回拨 120s（陈锁形态）。等待期间心跳若在续，
      // 下一拍（15s）就会把 beat 刷回新鲜；同步睡眠冻结事件循环则永远停在陈旧值
      const forgedAt = Date.now()
      const held = readFinishLock(repo.root)
      fs.writeFileSync(finishLockPath(repo.root), JSON.stringify({ ...held, beat: forgedAt - 120_000 }))
      let refreshed = false
      try {
        await waitUntil('持锁者 beat 刷新', () => {
          const cur = readFinishLock(repo.root)
          return cur?.pid === a!.pid && Number.isFinite(cur?.beat) && (cur?.beat ?? 0) >= forgedAt
        }, 40_000) // 心跳间隔 15s + 并行负载余量
        refreshed = true
      } catch {
        refreshed = false
      }

      // 第二个 finish（无 worktree 的任务名当锁后探针）：锁新鲜 → 拒绝；锁陈旧 → 接管后死在 no worktree
      const b = runFinish(repo.root, 'heartbeat-other-probe')
      const afterB = readFinishLock(repo.root)

      expect(a.out()).toContain('等待静默…') // 确实停在撞窗等待里（场景前提）
      expect(refreshed).toBe(true) // 等待期间 beat 持续刷新
      expect(b.out).toContain('another finish is already running') // 第二个 finish 不接管
      expect(afterB?.pid).toBe(a.pid) // 锁仍属第一个 finish
    } finally {
      if (a) await stopFinish(repo.root, a)
      repo.cleanup()
    }
  }, 120_000)

  it('撞窗等待期间锁已易主 → 醒来后 die（不合并、不误删接管者的锁）', async () => {
    const repo = makeRepoWithStub()
    let a: AsyncFinish | null = null
    try {
      startAndCommit(repo.root, 'usurped-probe')
      a = startFinishAsync(repo.root, 'usurped-probe')
      await waitUntilInCollisionWait(repo.root, 'usurped-probe', a)

      // 等待期间锁被别的 finish 接管（此处由测试冒充接管者），随后编排器静默（删伪造任务锁）
      fs.writeFileSync(finishLockPath(repo.root), JSON.stringify({
        pid: process.pid, task: 'usurper', time: new Date().toISOString(), beat: Date.now(),
      }))
      try { fs.rmSync(stubTaskLockPath(repo.root), { force: true }) } catch { /* 尽力而为 */ }

      // 轮询间隔已收缩到 1s：静默后应很快醒来。上限放到 45s——超过生产一轮 30s，留足并行负载余量
      const r = await Promise.race([a.done, sleep(45_000).then(() => null)])
      expect(r, 'finish 未在等待结束后及时退出').not.toBeNull()
      expect(r!.status).toBe(1)
      expect(r!.out).toContain('等待静默…') // 场景前提：确实经历过撞窗等待
      expect(r!.out).toContain('锁已易主')
      expect(r!.out).not.toContain('编排器已静默') // 醒来先复查归属：没走到"重跑验证"那一步
      expect(r!.out).not.toContain('Merged') // 没有合并
      const lock = readFinishLock(repo.root)
      expect(lock?.pid).toBe(process.pid) // 接管者的锁原样保留（exit handler 只清自己的锁）
    } finally {
      if (a) {
        const alive = await Promise.race([a.done.then(() => false), sleep(2_000).then(() => true)])
        if (alive) killTree(a.pid) // 本用例自己拉起的 finish
      }
      repo.cleanup()
    }
  }, 90_000)
})
