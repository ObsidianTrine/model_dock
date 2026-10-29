import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { parse } from 'smol-toml'
import { describe, expect, it } from 'vitest'
import { fakeHome } from './helpers.js'

// ⚠ 与 test/reset.test.ts 同一配方：CLI 行为测试走子进程 + 独立沙箱（isolate:false + singleFork 下
//   同进程执行 CLI 会触达被其他文件 mock 的模块）。profile rm 的钉定保护 / file 模式 route 复位 /
//   别名解析容错是 503 回归的关键防线，值得端到端钉住。

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CLI_ENTRY = path.join(REPO_ROOT, 'src', 'cli.ts')
/** tsx 的 ESM loader：经 node --import 直跑 .ts 源码，免 shell、三平台一致 */
const TSX_LOADER = pathToFileURL(createRequire(path.join(REPO_ROOT, 'package.json')).resolve('tsx/esm')).href

const SEED_TOML = [
  'version = 1',
  'active_profile = "main"',
  '',
  '[security]',
  'store = "file"',
  '',
  '[providers.ark]',
  'base_url = "https://ark.example.com"',
  'protocol = "anthropic"',
  'auth_style = "bearer"',
  'key_ref = "file:ark"',
  '',
  '[profiles.main]',
  'provider = "ark"',
  'default_model = "m1"',
  '',
  '[profiles.extra]',
  'provider = "ark"',
  'default_model = "m2"',
  '',
  '[profiles.filepinned]',
  'provider = "ark"',
  'default_model = "m3"',
  '',
  '[harness.claude-code]',
  'mode = "gateway"',
  'route = "extra"',
  'files = []',
  '',
  '[harness.codex]',
  'mode = "file"',
  'route = "filepinned"',
  'files = []',
].join('\n')

function runProfileCli(sandbox: string, args: string[]): { status: number; output: string } {
  const env = { ...process.env, MODELRDOCK_FAKE_HOME: sandbox, MODELRDOCK_LANG: 'zh' }
  delete env.MODELRDOCK_HOME
  const r = spawnSync(process.execPath, ['--import', TSX_LOADER, CLI_ENTRY, ...args], {
    cwd: sandbox, // cwd 绝不落在 ~/.modeldock 内（Windows 上被占用会删不掉沙箱）
    env,
    encoding: 'utf8',
    timeout: 120_000,
  })
  return { status: r.status ?? -1, output: `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? String(r.error) : ''}` }
}

function seedSandbox(sandbox: string): void {
  const dir = path.join(sandbox, '.modeldock')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'config.toml'), SEED_TOML + '\n')
}

function readCfg(sandbox: string): any {
  return parse(fs.readFileSync(path.join(sandbox, '.modeldock', 'config.toml'), 'utf8'))
}

describe('modeldock profile（真实 CLI 子进程 + 独立沙箱）', () => {
  it('add：全 flag 非交互创建；别名条目容错（坏条目忽略并提示）', () => {
    const h = fakeHome()
    try {
      seedSandbox(h.home)
      const { status, output } = runProfileCli(h.home, [
        'profile', 'add', 'p2', '--provider', 'ark', '--model', 'm9', '--aliases', 'a1=m1, badentry',
      ])
      expect(status, output).toBe(0)
      expect(output).toContain('已创建')
      expect(output).toContain('忽略格式错误的别名条目')
      const cfg = readCfg(h.home)
      expect(cfg.profiles.p2).toMatchObject({ name: 'p2', provider: 'ark', default_model: 'm9' })
      expect(cfg.profiles.p2.aliases).toEqual({ a1: 'm1' })
    } finally {
      h.restore()
    }
  })

  it('add：重名与不存在的 provider 都拒绝且 exit 1', () => {
    const h = fakeHome()
    try {
      seedSandbox(h.home)
      const dup = runProfileCli(h.home, ['profile', 'add', 'main', '--provider', 'ark', '--model', 'm1'])
      expect(dup.status).toBe(1)
      expect(dup.output).toContain('已存在')
      const noProv = runProfileCli(h.home, ['profile', 'add', 'p3', '--provider', 'nope', '--model', 'm1'])
      expect(noProv.status).toBe(1)
      expect(noProv.output).toContain('不存在')
      expect(readCfg(h.home).profiles.p3).toBeUndefined()
    } finally {
      h.restore()
    }
  })

  it('rm：被 gateway 模式客户端钉定的 profile 拒绝删除（防悬空 route 503）', () => {
    const h = fakeHome()
    try {
      seedSandbox(h.home)
      const { status, output } = runProfileCli(h.home, ['profile', 'rm', 'extra'])
      expect(status).toBe(1)
      expect(output).toContain('钉定')
      expect(output).toContain('claude-code')
      expect(readCfg(h.home).profiles.extra).toBeDefined()
    } finally {
      h.restore()
    }
  })

  it('rm：file 模式客户端登记的 route 随删除一并复位为 default', () => {
    const h = fakeHome()
    try {
      seedSandbox(h.home)
      const { status, output } = runProfileCli(h.home, ['profile', 'rm', 'filepinned'])
      expect(status, output).toBe(0)
      expect(output).toContain('已删除')
      const cfg = readCfg(h.home)
      expect(cfg.profiles.filepinned).toBeUndefined()
      expect(cfg.harness.codex.route).toBe('default')
    } finally {
      h.restore()
    }
  })

  it('rm：不存在的 profile exit 1；list 展示全部并标出 active', () => {
    const h = fakeHome()
    try {
      seedSandbox(h.home)
      const miss = runProfileCli(h.home, ['profile', 'rm', 'nosuch'])
      expect(miss.status).toBe(1)
      expect(miss.output).toContain('不存在')
      const list = runProfileCli(h.home, ['profile', 'list'])
      expect(list.status).toBe(0)
      expect(list.output).toContain('main *')
      expect(list.output).toContain('extra')
      expect(list.output).toContain('filepinned')
    } finally {
      h.restore()
    }
  })
})
