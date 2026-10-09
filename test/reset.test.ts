import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { fakeHome } from './helpers.js'
import {
  backupsDir,
  configPath,
  holidaysCachePath,
  logsDir,
  modelCatalogCachePath,
  modeldockDir,
  secretsPath,
  syncJsonPath,
} from '../src/util/paths.js'

// ⚠ 本仓库测试是 isolate:false + singleFork（所有文件同进程、模块 mock 注册表共享）：**同进程里测
//   cmdReset 会踩雷**——它经 basic.ts 触达网关/钥匙环/适配器等被别的测试文件 mock 的模块，实测会让
//   uninstall.test 的模块 mock 调用记录随机丢失（假失败）。所以这里改走 CLI 子进程（项目对沙箱手测
//   已是同一套配方）：真实现 + 独立沙箱，进程内零 mock，天然与别的测试文件互不干扰。
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CLI_ENTRY = path.join(REPO_ROOT, 'src', 'cli.ts')
/** tsx 的 ESM loader：经 node --import 直跑 .ts 源码，免 shell、三平台一致 */
const TSX_LOADER = pathToFileURL(createRequire(path.join(REPO_ROOT, 'package.json')).resolve('tsx/esm')).href

/** 在独立沙箱里同步跑一次真实 CLI，返回 { status, output } */
function runResetCli(sandbox: string, args: string[]): { status: number; output: string } {
  const env = { ...process.env, MODELRDOCK_FAKE_HOME: sandbox }
  delete env.MODELRDOCK_HOME
  const r = spawnSync(process.execPath, ['--import', TSX_LOADER, CLI_ENTRY, 'reset', ...args], {
    cwd: sandbox, // cwd 绝不落在 ~/.modeldock 内：清理要删的就是它（Windows 上被占用会删不掉）
    env,
    encoding: 'utf8',
    timeout: 120_000,
  })
  return { status: r.status ?? -1, output: `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? String(r.error) : ''}` }
}

/** 造一份「什么都有一点」的沙箱数据 */
function seedSandbox(sandbox: string): void {
  const dir = path.join(sandbox, '.modeldock')
  fs.mkdirSync(path.join(dir, 'backups', 'claude-code'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'backups', 'claude-code', 'keep-me.json'), '{}\n')
  fs.mkdirSync(path.join(dir, 'logs'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'logs', 'gateway-2026-01-01.jsonl'), '{}\n')
  fs.writeFileSync(path.join(dir, 'config.toml'), 'version = 1\n')
  fs.writeFileSync(path.join(dir, 'secrets.json'), '{}\n')
  for (const f of ['sync.json', 'holidays-cn.json', 'model-catalog.json']) fs.writeFileSync(path.join(dir, f), '{}\n')
}

describe('modeldock reset（真实 CLI 子进程 + 独立沙箱）', () => {
  it('默认：清配置与密钥，保留快照和日志', () => {
    const h = fakeHome()
    try {
      seedSandbox(h.home)
      const { status, output } = runResetCli(h.home, ['--yes'])

      expect(status, output).toBe(0)
      expect(fs.existsSync(configPath())).toBe(false)
      expect(fs.existsSync(secretsPath())).toBe(false)
      expect(fs.existsSync(path.join(backupsDir(), 'claude-code', 'keep-me.json'))).toBe(true)
      // 快照是唯一恢复手段、日志是排查依据：默认都不动
      expect(fs.existsSync(path.join(logsDir(), 'gateway-2026-01-01.jsonl'))).toBe(true)
      expect(fs.existsSync(syncJsonPath())).toBe(true)
    } finally {
      h.restore()
    }
  })

  it('--deep：连日志、同步状态与本机缓存一起清，快照仍保留', () => {
    const h = fakeHome()
    try {
      seedSandbox(h.home)
      const { status, output } = runResetCli(h.home, ['--yes', '--deep'])

      expect(status, output).toBe(0)
      expect(fs.existsSync(configPath())).toBe(false)
      expect(fs.existsSync(secretsPath())).toBe(false)
      expect(fs.existsSync(logsDir())).toBe(false)
      expect(fs.existsSync(syncJsonPath())).toBe(false)
      expect(fs.existsSync(holidaysCachePath())).toBe(false)
      expect(fs.existsSync(modelCatalogCachePath())).toBe(false)
      expect(fs.existsSync(path.join(backupsDir(), 'claude-code', 'keep-me.json'))).toBe(true)
      // 默认中文：提示文案要能让用户看懂发生了什么
      expect(output).toContain('清理')
    } finally {
      h.restore()
    }
  })

  it('未初始化（连目录都没有）时也退出 0，不误建、不误删', () => {
    const h = fakeHome()
    try {
      const { status, output } = runResetCli(h.home, ['--yes', '--deep'])

      expect(status, output).toBe(0)
      expect(fs.existsSync(modeldockDir())).toBe(false)
    } finally {
      h.restore()
    }
  })
})
