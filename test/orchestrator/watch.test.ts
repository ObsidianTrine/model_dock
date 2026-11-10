// watch 连续自治运行测试（mock 后端）：周期闭环（drain → scan）、stop 文件即停、
// drift 降级自动退出、瞬时故障 blocked 卡的一次性有痕重探（投机执行）、
// configPaused（workflow.json 漂移）期间周期跳过 autoapprove sweep（round5）。

import { describe, expect, it } from 'vitest'
import { spawn as spawnProc } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { appendEvent } from '../../.agents/scripts/orchestrator/events.mjs'
import { cardText, eventsOf, mkRepo, readCard, runOrch } from './helpers.js'

function submitCard(repo: string, id: string, overrides: Record<string, unknown> = {}) {
  const cardFile = path.join(repo, `card-${id}.md`)
  fs.writeFileSync(cardFile, cardText({ id, ...overrides }))
  runOrch(repo, `submit "${cardFile}"`)
}

/** 异步 spawn watch 子进程（长跑观察用：测试中途改文件再收尸，runOrch 的 execSync 做不到）。 */
function spawnWatch(repo: string, args: string[]) {
  const orch = path.join(process.cwd(), '.agents', 'scripts', 'orchestrator.mjs')
  const child = spawnProc(process.execPath, [orch, ...args], { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  child.stdout.on('data', (c: Buffer) => (out += c.toString()))
  child.stderr.on('data', (c: Buffer) => (out += c.toString()))
  return { child, output: () => out }
}

/** Windows 上目标文件可能正被周期子进程瞬时打开：EBUSY/EPERM 退避重试写。 */
async function writeRetry(p: string, data: string): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      fs.writeFileSync(p, data)
      return
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? ''
      if (i >= 5 || !['EBUSY', 'EPERM', 'EACCES'].includes(code)) throw e
      await new Promise((r) => setTimeout(r, 100))
    }
  }
}

describe('orchestrator watch > 周期闭环', () => {
  it('周期 1 drain pending 到 awaiting-human；周期 2 队列空走 scan 后退出', () => {
    const repo = mkRepo()
    try {
      submitCard(repo.root, 'w-card')
      const out = runOrch(repo.root, 'watch --max-cycles 2 --interval 0 --backend mock')
      expect(out.status).toBe(0)
      expect(out.stdout).toContain('watch 周期 1')
      expect(out.stdout).toContain('watch 周期 2')
      expect(out.stdout).toContain('已达 --max-cycles 2')
      expect(readCard(repo.root, 'awaiting-human', 'w-card')).toBeTruthy()
    } finally {
      repo.cleanup()
    }
  }, 90_000)

  it('stop 文件即停：首周期检测到即退出并清掉 stop 文件', () => {
    const repo = mkRepo()
    try {
      const stop = path.join(repo.root, '.agents', 'orchestrator', '.watch-stop')
      fs.mkdirSync(path.dirname(stop), { recursive: true })
      fs.writeFileSync(stop, '')
      const out = runOrch(repo.root, 'watch --max-cycles 5 --interval 0 --backend mock')
      expect(out.status).toBe(0)
      expect(out.stdout).toContain('.watch-stop')
      expect(out.stdout).toContain('watch 退出')
      expect(fs.existsSync(stop)).toBe(false)
    } finally {
      repo.cleanup()
    }
  }, 60_000)

  it('drift 降级生效：watch 直接退出（保险丝不允许自己插回去）', () => {
    const repo = mkRepo()
    try {
      fs.mkdirSync(path.join(repo.root, '.agents', 'orchestrator'), { recursive: true })
      fs.writeFileSync(path.join(repo.root, '.agents', 'orchestrator', 'degraded.json'), JSON.stringify({ degraded_at: new Date().toISOString(), reason: '测试注入' }))
      const out = runOrch(repo.root, 'watch --max-cycles 3 --interval 0 --backend mock')
      expect(out.status).toBe(0)
      expect(out.stdout).toContain('drift 降级')
      expect(out.stdout).toContain('watch 退出')
    } finally {
      repo.cleanup()
    }
  }, 60_000)

  it('autopilot 关闭：队列空周期只 scan 不 propose（无 planner 会话）', () => {
    const repo = mkRepo()
    try {
      const out = runOrch(repo.root, 'watch --max-cycles 1 --interval 0 --backend mock')
      expect(out.stdout).not.toContain('propose（autopilot 需求综合）')
    } finally {
      repo.cleanup()
    }
  }, 60_000)
})

describe('orchestrator watch > configPaused 期间跳过 autoapprove sweep（round5）', () => {
  it('workflow.json 漂移生效后周期不再跑 sweep：超时到期卡留人、被改的 autoApprove 配置不生效', async () => {
    const repo = mkRepo({ workerBackend: 'mock', extra: { autoApprove: { enabled: true, timeoutMinutes: 1, maxAutoRetry: 1 } } })
    try {
      submitCard(repo.root, 'w-cg', { gate: 'L3' })
      runOrch(repo.root, 'run w-cg --backend mock')
      expect(readCard(repo.root, 'awaiting-human', 'w-cg')).toBeTruthy()
      const wf = path.join(repo.root, '.agents', 'workflow.json')

      // 长跑 watch（interval 0 连转）：先让它空转几拍（结论新鲜 → sweep 只报「窗口未过」）
      const w = spawnWatch(repo.root, ['watch', '--max-cycles', '300', '--interval', '0', '--backend', 'mock'])
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
      // 轮询等待而非固定 sleep：组合跑/慢机下周期节奏不可控，等条件成立再进下一步
      const waitUntil = async (cond: () => boolean, timeoutMs = 45_000) => {
        const deadline = Date.now() + timeoutMs
        while (Date.now() < deadline) {
          if (cond()) return
          await sleep(200)
        }
        throw new Error(`waitUntil 超时（${timeoutMs}ms）`)
      }
      await waitUntil(() => w.output().includes('拍板窗口未过')) // 漂移前 sweep 照跑：卡有被 sweep 处理的资格

      // 运行中注入漂移（模拟被改的授权面）：改 workflow.json → configPaused
      const before = JSON.parse(fs.readFileSync(wf, 'utf8')) as Record<string, unknown>
      await writeRetry(wf, JSON.stringify({ ...before, projectName: 'drift-injected' }))
      // 首个 paused 周期含守卫宣布（钥匙串探测最长 5s）：等满两拍 skip 痕再进下一步
      await waitUntil(() => w.output().split('本周期跳过 autoapprove sweep').length - 1 >= 2)

      // 此时才把结论回拨成「超时到期」：若 sweep 未被闸住，下一拍就会自动合并
      const evFile = path.join(repo.root, '.agents', 'orchestrator', 'logs', 'w-cg', 'events.jsonl')
      const lines = fs.readFileSync(evFile, 'utf8').split('\n').filter(Boolean)
      for (let i = lines.length - 1; i >= 0; i--) {
        const e = JSON.parse(lines[i]) as { type?: string; ts?: string }
        if (e.type === 'review_verdict') {
          e.ts = new Date(Date.now() - 10 * 60_000).toISOString()
          lines[i] = JSON.stringify(e)
          break
        }
      }
      await writeRetry(evFile, `${lines.join('\n')}\n`)
      await waitUntil(() => w.output().split('本周期跳过 autoapprove sweep').length - 1 >= 3) // 回拨后至少再跑一拍 paused 周期

      w.child.kill()
      await new Promise<void>((resolve) => {
        w.child.on('close', () => resolve())
        setTimeout(() => {
          try { w.child.kill('SIGKILL') } catch { /* 已退出 */ }
          resolve()
        }, 10_000)
      })

      const out = w.output()
      expect(out).toContain('配置守卫：workflow.json 漂移生效中——本周期跳过 autoapprove sweep')
      // sweep 被闸住：到期卡没有被自动合并（也不自动返工）
      expect(readCard(repo.root, 'awaiting-human', 'w-cg')).toBeTruthy()
      expect(fs.existsSync(path.join(repo.root, '.agents', 'orchestrator', 'queue', 'merged', 'w-cg.md'))).toBe(false)
      expect(eventsOf(repo.root, 'w-cg').some((e) => e.type === 'autoapprove_decision')).toBe(false)
    } finally {
      repo.cleanup()
    }
  }, 120_000)
})

describe('orchestrator watch > 瞬时故障 blocked 卡的有痕重探（投机执行）', () => {
  it('blocked+瞬时签名 → speculative_resume 留痕 → resume 续跑到 awaiting-human', () => {
    const repo = mkRepo()
    try {
      submitCard(repo.root, 'w-rescue')
      // 手工把卡摆成「worker 异常结束 + 瞬时签名」的 blocked 现场（伪造事件流：
      // pid 用必死的 999999，防 cleanupOrphanWorker 误杀活进程）
      const logsDir = path.join(repo.root, '.agents', 'orchestrator', 'logs', 'w-rescue')
      fs.mkdirSync(logsDir, { recursive: true })
      appendEvent(logsDir, 'task_accepted', {})
      appendEvent(logsDir, 'worker_spawned', { backend: 'mock', pid: 999999 })
      appendEvent(logsDir, 'worker_stderr_tail', { text: 'request failed: ECONNRESET socket hang up (429 too many requests)' })
      appendEvent(logsDir, 'blocked', { reason: '未产出结果块（worker 异常结束）' })
      fs.renameSync(path.join(repo.root, '.agents', 'orchestrator', 'queue', 'pending', 'w-rescue.md'), path.join(repo.root, '.agents', 'orchestrator', 'queue', 'blocked', 'w-rescue.md'))

      const out = runOrch(repo.root, 'watch --max-cycles 1 --interval 0 --backend mock')
      expect(out.stdout).toContain('有痕重探一次')
      const types = eventsOf(repo.root, 'w-rescue').map((e) => e.type)
      expect(types).toContain('speculative_resume')
      // 重探 = resume 闭环：mock worker done → 门禁 → 审查 → gate L3 落 awaiting-human
      expect(readCard(repo.root, 'awaiting-human', 'w-rescue')).toBeTruthy()

      // 终态卡不再重探（每卡终身一次）：再跑一个周期无新 speculative_resume
      fs.renameSync(path.join(repo.root, '.agents', 'orchestrator', 'queue', 'awaiting-human', 'w-rescue.md'), path.join(repo.root, '.agents', 'orchestrator', 'queue', 'blocked', 'w-rescue.md'))
      runOrch(repo.root, 'watch --max-cycles 1 --interval 0 --backend mock')
      expect(eventsOf(repo.root, 'w-rescue').filter((e) => e.type === 'speculative_resume')).toHaveLength(1)
    } finally {
      repo.cleanup()
    }
  }, 120_000)

  it('熔断卡（circuit_breaker 在案）与自报 stuck 卡不重探', () => {
    const repo = mkRepo()
    try {
      for (const id of ['w-cb', 'w-stuck']) {
        submitCard(repo.root, id)
        const logsDir = path.join(repo.root, '.agents', 'orchestrator', 'logs', id)
        fs.mkdirSync(logsDir, { recursive: true })
        appendEvent(logsDir, 'task_accepted', {})
        appendEvent(logsDir, 'worker_stderr_tail', { text: 'ECONNRESET 429' })
        if (id === 'w-cb') appendEvent(logsDir, 'circuit_breaker', { reason: 'max_test_iterations', detail: '6/5' })
        appendEvent(logsDir, 'blocked', { reason: id === 'w-cb' ? '未产出结果块（worker 异常结束）' : 'worker 自报 stuck' })
        fs.renameSync(path.join(repo.root, '.agents', 'orchestrator', 'queue', 'pending', `${id}.md`), path.join(repo.root, '.agents', 'orchestrator', 'queue', 'blocked', `${id}.md`))
      }
      const out = runOrch(repo.root, 'watch --max-cycles 1 --interval 0 --backend mock')
      expect(out.stdout).not.toContain('有痕重探一次')
      expect(readCard(repo.root, 'blocked', 'w-cb')).toBeTruthy()
      expect(readCard(repo.root, 'blocked', 'w-stuck')).toBeTruthy()
    } finally {
      repo.cleanup()
    }
  }, 90_000)
})
