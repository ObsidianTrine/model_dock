// orchestrator 测试辅助：构造带最小 .agents 结构的临时 git 仓库，
// 让真实 feature-branch.mjs + orchestrator.mjs（mock 后端）在里面跑完整闭环。
// 注意文件名不是 *.test.ts：vitest 只收集 test/**/*.test.ts（docs 7 章评审项）。

import { execSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const WORKTREE_ROOT = path.resolve(process.cwd()) // vitest 的 cwd = 仓库根（worktree 内）

export function git(repo: string, args: string): string {
  return execSync(`git ${args}`, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

export interface TestRepo {
  root: string
  cleanup: () => void
}

/** 建一个最小可跑 orchestrator 的临时仓库：develop 分支 + 初始 commit。 */
export function mkRepo(opts?: { testCmd?: string; uiCheckCmd?: string; workerBackend?: string; baseBranch?: string; extra?: Record<string, unknown> }): TestRepo {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-test-'))
  const g = (args: string) => git(root, args)
  const baseBranch = opts?.baseBranch ?? 'develop'
  // git init -b 需要 git ≥2.28（本机 2.23）；symbolic-ref 全版本可用
  g('init')
  g(`symbolic-ref HEAD refs/heads/${baseBranch}`)
  g('config user.email test@local')
  g('config user.name test')

  // 真实工具链整目录复制进来：零依赖、可移植（.agents 设计即如此）。
  // 必须含 orchestrator.mjs 及其全部子模块——drain 的 run 子进程按
  // repoRoot/.agents/scripts/orchestrator.mjs 解析，缺文件会退码 1 而任务不动，
  // pickNextCard 下轮再选中它 → 死循环（实测踩中）。
  fs.mkdirSync(path.join(root, '.agents', 'workflows'), { recursive: true })
  fs.cpSync(path.join(WORKTREE_ROOT, '.agents', 'scripts'), path.join(root, '.agents', 'scripts'), { recursive: true })
  const workflow: Record<string, unknown> = { baseBranch, testCmd: opts?.testCmd ?? 'node -e "process.exit(0)"', ...opts?.extra }
  if (opts?.uiCheckCmd) workflow.uiCheckCmd = opts.uiCheckCmd
  if (opts?.workerBackend) workflow.worker = { backend: opts.workerBackend }
  fs.writeFileSync(path.join(root, '.agents', 'workflow.json'), JSON.stringify(workflow))
  fs.writeFileSync(path.join(root, '.agents', 'workflows', 'feature-branch.md'), '# feature-branch（stub）\n\n测试占位。')
  fs.writeFileSync(
    path.join(root, 'AGENTS.md'),
    '# 测试仓库 AGENTS\n\n最小约定：路径走 paths、写盘走 atomicWrite、端口 8687/8890 红线。\n',
  )
  fs.writeFileSync(path.join(root, 'README.md'), '# 测试仓库\n')
  // tsc_build 门禁跑 npm run build：给个空脚本
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'orch-it', version: '0.0.0', scripts: { build: 'node -e "process.exit(0)"' } }))
  // .agents/worktrees/ 与真实仓库的 .gitignore 对齐：漏了它，任何对主仓库的 add -A
  // 都会把 task worktree 当 embedded git repo 收进提交（gitlink），finish 的脏检查随即误报
  fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules/\n.agents/worktrees/\n.agents/orchestrator/queue/\n.agents/orchestrator/logs/\n')
  g('add -A')
  g('commit -m init')
  return { root, cleanup: () => rmRfRetry(root) }
}

/** git 对象落盘/异步收尾可能在 rmSync 瞬间仍在进行：ENOTEMPTY/EBUSY 退避重试
 *  （与主 test/helpers.ts 的 rmRfWithRetry 同策略；CI 实测高负载下偶发 ENOTEMPTY）。 */
function rmRfRetry(p: string): void {
  const backoffMs = [10, 50, 100, 250, 500, 1000]
  for (let i = 0; ; i++) {
    try {
      fs.rmSync(p, { recursive: true, force: true })
      return
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? ''
      if (!['ENOTEMPTY', 'EBUSY', 'EPERM', 'EACCES'].includes(code) || i >= backoffMs.length) throw e
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, backoffMs[i])
    }
  }
}

/** 生成任务卡 markdown。plan 非空时追加「# 航次计划」段（缺省不带，兼容旧四段卡用例）。 */
export function cardText(overrides: Record<string, unknown> = {}, body = '', plan = ''): string {
  const meta: Record<string, unknown> = {
    id: 'test-task',
    type: 'bugfix',
    priority: 'normal',
    created_at: '2026-10-01T10:00:00+08:00',
    created_by: 'human',
    files_hint: ['mock-worker-output.txt'],
    workflows: ['feature-branch'],
    gate: 'L3',
    ...overrides,
  }
  const fm: string[] = []
  for (const [k, v] of Object.entries(meta)) {
    if (v === null || typeof v !== 'object') {
      fm.push(`${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
    } else if (Array.isArray(v)) {
      // 内联数组（frontmatter 子集支持 [a, b] 形式）
      fm.push(`${k}: ${JSON.stringify(v)}`)
    } else {
      fm.push(`${k}:`)
      for (const [bk, bv] of Object.entries(v as Record<string, unknown>)) fm.push(`  ${bk}: ${JSON.stringify(bv)}`)
    }
  }
  return (
    `---\n${fm.join('\n')}\n---\n\n# 目标\n${body || '测试任务目标。'}\n\n# 验收标准\n- 通过\n` +
    (plan ? `\n# 航次计划\n${plan}\n` : '')
  )
}

/** 在临时仓库里跑 orchestrator CLI（子进程，行为由 env 注入）。 */
export function runOrch(
  repo: string,
  args: string,
  env: Record<string, string> = {},
): { status: number; stdout: string; stderr: string } {
  const orch = path.join(WORKTREE_ROOT, '.agents', 'scripts', 'orchestrator.mjs')
  const r = execSync(`node "${orch}" ${args}`, {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 240_000, // drain 一条命令跑多个任务（每个含 git worktree + 门禁），60s 不够
    maxBuffer: 32 * 1024 * 1024, // drain 逐任务输出（含 feature-branch start 等），1MB 默认会 ENOBUFS
  })
  return { status: 0, stdout: r ?? '', stderr: '' }
}

/** runOrch 的允许失败版本（orchestrator 用 exit 1 + stderr 报业务错误）。 */
export function tryOrch(repo: string, args: string, env: Record<string, string> = {}): { status: number; stdout: string; stderr: string } {
  try {
    return runOrch(repo, args, env)
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string }
    return { status: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' }
  }
}

export interface NoNodeRun {
  status: number | null
  output: string
  /** spawnSync 顶层的 error.code（如 ETIMEDOUT）；正常退出为 undefined */
  errorCode?: string
}

/**
 * 确定性「node 不可解析」注入（T15③ 根修，2026-11）：不再从 PATH 剔除 node 所在目录——
 * 那依赖真实 PATH 结构（Windows 的进程搜索会先看 node.exe 自身所在目录，剔除可能失效；
 * Linux CI 的 node 又常在 /usr/local/bin 这类不含 "node" 字样的目录，剔除后仍可解析），
 * 两端都造不出确定性 ENOENT。这里反向构造：drain 父进程换成 node 二进制的**临时副本**
 * （改名，任何平台的「应用目录/父进程可执行文件目录」搜索都命中不了 node），PATH 指向
 * os.tmpdir() 造的空目录——内层 spawnSync('node') 在三平台都必然 ENOENT，与机器无关。
 * 副本与空 PATH 目录在返回前清理（spawnSync 同步等子进程退出，Windows 句柄已释放）。
 */
export function runDrainWithoutNode(repo: string, args: string[], timeoutMs = 120_000): NoNodeRun {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-nonode-'))
  const emptyPath = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-nonode-path-'))
  const copyPath = path.join(base, process.platform === 'win32' ? 'nbcopy.exe' : 'nbcopy')
  fs.copyFileSync(process.execPath, copyPath)
  if (process.platform !== 'win32') {
    try { fs.chmodSync(copyPath, 0o755) } catch { /* copyFileSync 通常已保留 mode；失败也照样试跑 */ }
  }
  const orch = path.join(WORKTREE_ROOT, '.agents', 'scripts', 'orchestrator.mjs')
  try {
    const r = spawnSync(copyPath, [orch, ...args], {
      cwd: repo,
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, PATH: emptyPath },
    })
    return { status: r.status, output: `${r.stdout ?? ''}${r.stderr ?? ''}`, errorCode: r.error?.code }
  } finally {
    fs.rmSync(base, { recursive: true, force: true })
    fs.rmSync(emptyPath, { recursive: true, force: true })
  }
}

export function readCard(repo: string, state: string, id: string): string {
  return fs.readFileSync(path.join(repo, '.agents', 'orchestrator', 'queue', state, `${id}.md`), 'utf8')
}

export function eventsOf(repo: string, id: string): Array<Record<string, unknown>> {
  const f = path.join(repo, '.agents', 'orchestrator', 'logs', id, 'events.jsonl')
  if (!fs.existsSync(f)) return []
  return fs
    .readFileSync(f, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
}
