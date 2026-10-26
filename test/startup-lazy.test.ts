import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { fakeHome } from './helpers.js'
import { atomicWrite, readTextIfExists } from '../src/util/fsx.js'

// ⚠ 本仓库 isolate:false + singleFork：**不能 vi.mock undici**（跨文件共享模块 mock 注册表，
//   见 AGENTS.md vitest 隔离模型）。upstreamReachable 用真实本地 http 服务做真请求验证。

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// 本次惰性加载改造目标：把这三者移出通用启动链，任何 CLI 命令（含 --help / gateway stop）
// 与网关常驻进程不再为其付出加载成本。
const LAZY_TARGETS: { file: string; spec: string }[] = [
  { file: 'src/cli/diag.ts', spec: "from 'undici'" },
  { file: 'src/cli/diag.ts', spec: "from '../gateway/proxy.js'" },
  { file: 'src/adapters/engine.ts', spec: "from '@inquirer/prompts'" },
]

describe('启动链路惰性加载', () => {
  it('diag.ts / engine.ts 顶层无 undici、gateway/proxy、@inquirer/prompts 的静态 import', () => {
    const topLevelImports = (file: string): string[] => {
      const src = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8')
      // 静态 import 语句以行首 `import` 开头；函数体内的 `await import(...)` 位于表达式、
      // 前面必有缩进/代码，不会被 `^import` 匹配到。
      return src.match(/^import[^\n]*$/gm) ?? []
    }
    for (const { file, spec } of LAZY_TARGETS) {
      const lines = topLevelImports(file)
      expect(
        lines.some((l) => l.includes(spec)),
        `${file} 顶层出现静态 ${spec}（应改为函数体内 await import）`
      ).toBe(false)
    }
  })

  it('结构回归：改动文件确实含动态 import 兜底（通配 spec 覆盖）', () => {
    const diag = fs.readFileSync(path.join(REPO_ROOT, 'src', 'cli', 'diag.ts'), 'utf8')
    expect(diag).toMatch(/await import\('undici'\)/)
    expect(diag).toMatch(/await import\('\.\.\/gateway\/proxy\.js'\)/)
    const engine = fs.readFileSync(path.join(REPO_ROOT, 'src', 'adapters', 'engine.ts'), 'utf8')
    expect(engine).toMatch(/await import\('@inquirer\/prompts'\)/)
  })

  it('gateway/state.ts 顶层无 ./proxy.js 静态 import（undici 不得进 CLI 启动链）', () => {
    // state.ts 是 gatewayLive/运行态的 CLI 侧公共入口（cli/shared、tray、autostart、ops 均静态
    // 引它）：此前它对 ./proxy.js 的静态 import 把 undici（util/net.ts 顶层 new Agent）拖进每条
    // CLI 命令的启动链。dispatcherFor 已下沉 proxy.ts——state.ts 对 undici 只允许 import type。
    const src = fs.readFileSync(path.join(REPO_ROOT, 'src', 'gateway', 'state.ts'), 'utf8')
    const top = src.match(/^import[^\n]*$/gm) ?? []
    expect(top.some((l) => l.includes("from './proxy.js'")), 'state.ts 顶层出现 ./proxy.js 静态 import').toBe(false)
    expect(
      top.some((l) => l.includes("'undici'") && !l.startsWith('import type')),
      'state.ts 对 undici 只允许 import type（运行时 import 会拉进 undici）'
    ).toBe(false)
  })
})

describe('upstreamReachable（真实请求，不 mock undici）', () => {
  it('对本地 listen(0) http 服务返回可达', async () => {
    const { upstreamReachable } = await import('../src/cli/diag.js')
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('ok')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    try {
      const r = await upstreamReachable(`http://127.0.0.1:${port}`)
      expect(r.ok).toBe(true)
    } finally {
      server.close()
    }
  })

  it('对未监听的端口返回不可达', async () => {
    const { upstreamReachable } = await import('../src/cli/diag.js')
    const server = http.createServer(() => {})
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    await new Promise<void>((resolve) => server.close(resolve))
    const r = await upstreamReachable(`http://127.0.0.1:${port}`)
    expect(r.ok).toBe(false)
  })
})

describe('applyChanges yes:true 快路径', () => {
  it('跳过交互、正常写盘并返回 true', async () => {
    const h = fakeHome()
    try {
      const { applyChanges } = await import('../src/adapters/engine.js')
      const p = path.join(h.home, 'cfg.json')
      const v1 = '{"a":1}\n'
      const v2 = '{"a":2}\n'
      await atomicWrite(p, v1, 0o600)
      // yes:true → !opts.yes 为假，完全不触达 confirm（@inquirer/prompts）分支
      const ok = await applyChanges('x', 'attach', [{ path: p, before: v1, after: v2 }], { yes: true, quiet: true })
      expect(ok).toBe(true)
      expect(await readTextIfExists(p)).toBe(v2)
    } finally {
      h.restore()
    }
  })

  it('yes:false 交互路径逻辑保留（取消后不写盘；此处以 no-change 快路径代替）', async () => {
    const h = fakeHome()
    try {
      const { applyChanges } = await import('../src/adapters/engine.js')
      const p = path.join(h.home, 'none.txt')
      // 空 changes：不触达 confirm，走快速返回 true——与既有引擎测试对齐
      const ok = await applyChanges('x', 'attach', [], { yes: false })
      expect(ok).toBe(true)
    } finally {
      h.restore()
    }
  })
})