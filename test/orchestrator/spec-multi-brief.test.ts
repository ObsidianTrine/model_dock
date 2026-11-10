// spec --from-brief 多 brief 注入测试：逗号分隔多个调研 id 一次注入 spec prompt（multi-dim 调研 P0 层）。
// mock 后端输出是固定文案（不回显 prompt），brief 注入内容无法从 specs/ 产物断言——
// 用 module load 钩子在测试子进程里包一层 mock 后端的 spawn，把 spec planner 收到的
// promptFile 原文落盘后再断言（不改 mock.mjs / prompt.mjs 任何生产文件；钩子只在本测试
// 拉起的 node --import 子进程生效）。零 vi.mock：singleFork 下无跨文件 mock 冲突。

import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { mkRepo, tryOrch } from './helpers.js'

const WORKTREE_ROOT = path.resolve(process.cwd()) // vitest 的 cwd = 仓库根（worktree 内），同 helpers.ts

/** 在沙箱 repo 手写一个 brief 目录（meta.json + brief.md，与 writeBrief 落盘契约同形）。 */
function writeBriefFixture(repo: string, id: string, body: string): void {
  const dir = path.join(repo, '.agents', 'orchestrator', 'research', id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'meta.json'),
    JSON.stringify({ id, title: `brief ${id}`, question: 'q', backend: 'mock', created_at: '2026-11-09T10:00:00+08:00' }, null, 2),
  )
  fs.writeFileSync(path.join(dir, 'brief.md'), `${body.trim()}\n`)
}

// load 钩子源码：mock.mjs 加载完成后把 mockBackend.spawn 包一层，spawn 时把 promptFile
// 原文拷到 ORCH_SPEC_TEST_CAPTURE 指定路径（仅当该 env 设置时才落盘）。
const CAPTURE_HOOK = `
export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  if (!url.endsWith('/backends/mock.mjs')) return result;
  result.source = String(result.source) + \`
;{
  const __fs = await import('node:fs');
  const __origSpawn = mockBackend.spawn.bind(mockBackend);
  mockBackend.spawn = async (inv) => {
    const cap = process.env.ORCH_SPEC_TEST_CAPTURE;
    if (cap) { try { __fs.writeFileSync(cap, __fs.readFileSync(inv.promptFile, 'utf8')); } catch {} }
    return __origSpawn(inv);
  };
}
\`;
  return { ...result, shortCircuit: true };
}
`

/** 造 load 钩子注册对（临时目录，finally 清理）+ 带 prompt 捕获的 runner。 */
function makePromptCapture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-multi-brief-cap-'))
  const registerFile = path.join(dir, 'register.mjs')
  fs.writeFileSync(registerFile, `import { register } from 'node:module';\nregister('./hook.mjs', import.meta.url);\n`)
  fs.writeFileSync(path.join(dir, 'hook.mjs'), CAPTURE_HOOK)
  return {
    run(repo: string, args: string[]): { status: number; stdout: string; stderr: string; prompt: string | null } {
      const orch = path.join(WORKTREE_ROOT, '.agents', 'scripts', 'orchestrator.mjs')
      const capture = path.join(dir, 'prompt-capture.md')
      const r = spawnSync(process.execPath, ['--import', pathToFileURL(registerFile).href, orch, ...args], {
        cwd: repo,
        encoding: 'utf8',
        env: { ...process.env, ORCH_SPEC_TEST_CAPTURE: capture },
        timeout: 120_000,
      })
      return {
        status: r.status ?? 1,
        stdout: r.stdout ?? '',
        stderr: r.stderr ?? '',
        prompt: fs.existsSync(capture) ? fs.readFileSync(capture, 'utf8') : null,
      }
    },
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  }
}

/** specs/ 目录存在且非空 = 有残留。 */
function specResidue(repo: string): boolean {
  const dir = path.join(repo, '.agents', 'orchestrator', 'specs')
  return fs.existsSync(dir) && fs.readdirSync(dir).length > 0
}

describe('orchestrator spec --from-brief 多 brief 注入', () => {
  it('多 id（容忍逗号两侧空格）：两份 brief 分节注入 prompt（节标题 + 特征内容 + 恰一个 --- 分隔），三件套照常落盘', () => {
    const repo = mkRepo()
    const cap = makePromptCapture()
    try {
      writeBriefFixture(repo.root, 'alpha', 'ALPHA-结论-7f3a：推荐方案甲，配额复用 ModelDock 网关。')
      writeBriefFixture(repo.root, 'beta', 'BETA-结论-9c1e：推荐方案乙，密钥走 secrets.json。')
      const r = cap.run(repo.root, ['spec', 'multi brief spec', '--from-brief', 'alpha, beta', '--backend', 'mock'])
      expect(r.status).toBe(0)
      expect(r.stdout).toContain('规格三件套已生成')
      expect(r.prompt).not.toBeNull()
      const prompt = r.prompt as string
      // 两份 brief 的分节标题与特征内容都注入
      expect(prompt).toContain('# 调研结论（brief：alpha）')
      expect(prompt).toContain('# 调研结论（brief：beta）')
      expect(prompt).toContain('ALPHA-结论-7f3a：推荐方案甲，配额复用 ModelDock 网关。')
      expect(prompt).toContain('BETA-结论-9c1e：推荐方案乙，密钥走 secrets.json。')
      // 节间恰好一个 --- 分隔，最后不追加多余分隔（prompt 其余部分——AGENTS.md/模板——均不含 ---）
      expect(prompt.split('---')).toHaveLength(2)
      // 注入位置在产出契约之前；按 --from-brief 给定顺序 alpha 在 beta 前
      const iAlpha = prompt.indexOf('ALPHA-结论')
      const iBeta = prompt.indexOf('BETA-结论')
      const iContract = prompt.indexOf('# 产出契约')
      expect(iAlpha).toBeGreaterThan(-1)
      expect(iAlpha).toBeLessThan(iBeta)
      expect(iBeta).toBeLessThan(iContract)
      // 端到端不破：三件套照常落盘（mock 固定文案，brief 内容只进 prompt 不进 design.md）
      const specDir = path.join(repo.root, '.agents', 'orchestrator', 'specs', 'multi-brief-spec')
      expect(fs.existsSync(path.join(specDir, 'design.md'))).toBe(true)
    } finally {
      repo.cleanup()
      cap.cleanup()
    }
  })

  it('单 id 向后兼容：body 原文注入不加分节包装（既有注入格式不变）', () => {
    const repo = mkRepo()
    const cap = makePromptCapture()
    try {
      writeBriefFixture(repo.root, 'solo', 'SOLO-唯一特征-abc123：单份调研结论。')
      const r = cap.run(repo.root, ['spec', 'solo brief spec', '--from-brief', 'solo', '--backend', 'mock'])
      expect(r.status).toBe(0)
      const prompt = r.prompt as string
      expect(prompt).toContain('SOLO-唯一特征-abc123：单份调研结论。')
      expect(prompt).not.toContain('# 调研结论（brief：') // 不加包装
      expect(prompt).toContain('## 调研结论（research brief 已产出') // prompt.mjs 既有注入段原样
      expect(prompt.split('---')).toHaveLength(1) // 无分隔符
    } finally {
      repo.cleanup()
      cap.cleanup()
    }
  })

  it('任一 id 缺失：die 报错列出缺失 id 并提示 research list，specs/ 无残留', () => {
    const repo = mkRepo()
    try {
      writeBriefFixture(repo.root, 'alpha', 'ALPHA 结论。')
      const r = tryOrch(repo.root, 'spec "ghost spec" --from-brief "alpha, ghost" --backend mock')
      expect(r.status).not.toBe(0)
      expect(r.stderr).toContain('ghost')
      expect(r.stderr).toContain('research list')
      expect(specResidue(repo.root)).toBe(false) // die 在规划会话之前，specs/ 不产生半成品
    } finally {
      repo.cleanup()
    }
  })

  it('纯逗号/空白值：可操作报错提示用法，specs/ 无残留', () => {
    const repo = mkRepo()
    try {
      const r = tryOrch(repo.root, 'spec "x spec" --from-brief "," --backend mock')
      expect(r.status).not.toBe(0)
      expect(r.stderr).toContain('未解析出任何 brief id')
      expect(specResidue(repo.root)).toBe(false)
    } finally {
      repo.cleanup()
    }
  })
})
