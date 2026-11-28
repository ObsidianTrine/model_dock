import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { REPO_ROOT } from './helpers.js'

/**
 * agents 工具链类型检查的棘轮基线门禁：`tsconfig.agents.json` 覆盖 `.agents/scripts/**` 与
 * `scripts/**` 的纯 JS（allowJs + checkJs + noEmit），`typecheck-agents-baseline.json` 登记
 * 当前错误**总数与逐错误码计数**，只降不升——新增错误 = 本测试红；修好错误后必须同步下调
 * 基线（总数打平但错误码构成变了同样红，防「修 3 个又新加 3 个」静默打平）。基线数字因此
 * 永远是实测值、不会漂成注释里的一串旧数字。
 *
 * 判定逻辑只在 `scripts/typecheck-agents.mjs` 一处（`npm run typecheck:agents`，CI 接线用它），
 * 本测试是它的本地回放：子进程跑同一个入口，非零即红，并把其诊断原样带出来。
 *
 * 测法（调整错误/改基线时按此重新实测，别手写数字）：
 *   node node_modules/@typescript/native7/bin/tsc -p tsconfig.agents.json --noEmit --pretty false
 * 数输出里 `error TS<code>` 的行数（多行错误的续行不含该串，不会重复计数）。
 *
 * 子进程钦定模式：不 import 编译器进测试进程（vitest isolate:false 全进程共享模块注册表，
 * 见 AGENTS.md「vitest 隔离模型」）。
 */
const CONFIG_PATH = path.join(REPO_ROOT, 'tsconfig.agents.json')
const BASELINE_PATH = path.join(REPO_ROOT, 'typecheck-agents-baseline.json')
const GATE_SCRIPT = path.join(REPO_ROOT, 'scripts', 'typecheck-agents.mjs')

/** tsconfig.json / tsconfig.agents.json 是 JSONC：剥掉整行 `//` 注释后再解析。 */
function readJsonc(file: string): Record<string, unknown> {
  const text = fs.readFileSync(file, 'utf8')
  return JSON.parse(
    text
      .split('\n')
      .filter((l) => !l.trim().startsWith('//'))
      .join('\n')
  ) as Record<string, unknown>
}

describe('agents 工具链类型检查棘轮基线', () => {
  it('tsconfig.agents.json 仍守着覆盖面（allowJs + checkJs + noEmit，含两个脚本目录）', () => {
    const cfg = readJsonc(CONFIG_PATH)
    const co = cfg.compilerOptions as Record<string, unknown>
    expect(co.allowJs).toBe(true)
    expect(co.checkJs).toBe(true)
    expect(co.noEmit).toBe(true)

    const include = cfg.include as string[]
    expect(include.some((p) => p.startsWith('.agents/scripts/'))).toBe(true)
    expect(include.some((p) => p.startsWith('scripts/'))).toBe(true)

    // 独立 npm script 是 CI 接线的抓手，被删/改名则本门禁无处可跑
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
    }
    expect(pkg.scripts['typecheck:agents'] ?? '').toContain('typecheck-agents.mjs')
  })

  it(
    'tsc 错误数与 typecheck-agents-baseline.json 一致（新增即红，修好要下调）',
    () => {
      expect(fs.existsSync(GATE_SCRIPT), `门禁脚本缺失：${GATE_SCRIPT}`).toBe(true)
      expect(fs.existsSync(BASELINE_PATH), `基线文件缺失：${BASELINE_PATH}`).toBe(true)
      const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8')) as {
        total: number
        byCode: Record<string, number>
      }
      expect(baseline.total > 0, '基线 total 必须为正数（实测值），不写 0').toBe(true)
      expect(baseline.total, '基线 total 必须等于逐错误码计数之和').toBe(
        Object.values(baseline.byCode).reduce((a, b) => a + b, 0)
      )

      const res = spawnSync(process.execPath, [GATE_SCRIPT], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        maxBuffer: 256 * 1024 * 1024,
        timeout: 120_000,
      })

      expect(
        res.status,
        `typecheck:agents 未通过（基线 ${baseline.total} 处）：\n` +
          `${(res.stdout ?? '').trim()}\n${(res.stderr ?? '').trim()}`
      ).toBe(0)
    },
    120_000
  )
})
