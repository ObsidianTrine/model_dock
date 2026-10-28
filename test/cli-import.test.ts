import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { fakeHome } from './helpers.js'
import { cmdImport } from '../src/cli/import.js'
import { loadConfig, saveConfig } from '../src/config/store.js'
import { emptyConfig } from '../src/config/types.js'

/** 取一个刚释放的随机端口：连接必被拒绝（拒绝端口被环境代理兜走的边界） */
async function justClosedPort(): Promise<number> {
  const server = http.createServer(() => {})
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const port = (server.address() as AddressInfo).port
  server.close()
  return port
}

// cli/import.ts 只读收编壳：扫描层（scanSources/applyImport）本体由 import-scan.test.ts /
// import-sources.test.ts 覆盖，这里补 CLI 编排层——来源守卫、空候选/全跳过分支、one-api 错误
// 透传，以及 claude 种子 + --yes 的端到端落地（profile 自动创建 + is_current 设 active）。
// 纪律：不经 @inquirer 交互（--yes / 显式 url+token 驱动）；零 vi.mock（跨文件雷区）。

class ExitError extends Error {
  constructor(public code: number | undefined) {
    super(`exit:${code}`)
  }
}

let logs: string[] = []
let errs: string[] = []
function captureConsole(): void {
  logs = []
  errs = []
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    logs.push(a.map(String).join(' '))
  })
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
    errs.push(a.map(String).join(' '))
  })
}

function stubExit(): void {
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new ExitError(code)
  }) as never)
}

afterEach(() => {
  vi.mocked(process.exit).mockRestore?.()
  vi.mocked(console.log).mockRestore?.()
  vi.mocked(console.error).mockRestore?.()
})

function writeClaudeSettings(home: string, env: Record<string, string>): void {
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true })
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ env }), 'utf8')
}

describe('cmdImport 来源守卫', () => {
  it('未知来源：exit(1) 并列明可选来源', async () => {
    const h = fakeHome()
    stubExit()
    captureConsole()
    try {
      await expect(cmdImport({ from: 'nope' })).rejects.toBeInstanceOf(ExitError)
      expect(errs.join('\n')).toContain('未知来源')
    } finally {
      h.restore()
    }
  })

  it('one-api 地址不是 http(s)：scan 层报错经 exitWithThrown 透传（不触网）', async () => {
    const h = fakeHome()
    stubExit()
    captureConsole()
    try {
      await expect(cmdImport({ from: 'oneapi', url: 'not-a-url', token: 't' })).rejects.toBeInstanceOf(ExitError)
      expect(errs.join('\n')).toContain('http:// 或 https://')
    } finally {
      h.restore()
    }
  })

  it('one-api 站点不可达：连接失败报可操作错误', async () => {
    const h = fakeHome()
    stubExit()
    captureConsole()
    try {
      const port = await justClosedPort() // 连接必被拒绝，瞬时失败
      await expect(cmdImport({ from: 'oneapi', url: `http://127.0.0.1:${port}`, token: 't' })).rejects.toBeInstanceOf(ExitError)
      expect(errs.join('\n')).toContain('无法访问 one-api 站点')
    } finally {
      h.restore()
    }
  })
})

describe('cmdImport 空结果分支', () => {
  it('空沙箱扫描 dsh：提示未发现可导入项，不落任何配置', async () => {
    const h = fakeHome()
    captureConsole()
    try {
      await cmdImport({ from: 'dsh', yes: true })
      expect(logs.join('\n')).toContain('未发现可导入的 provider 配置')
      const cfg = await loadConfig()
      expect(Object.keys(cfg.providers)).toHaveLength(0)
    } finally {
      h.restore()
    }
  })

  it('发现项全部不可导入（指向本地代理）：表格展示后提示 none importable', async () => {
    const h = fakeHome()
    captureConsole()
    try {
      // 本地代理判定只认 127.0.0.1 主机（isLocalBaseUrl，端口无关）；端口取 18999（沙箱段，
      // 避开生产端口——测试脚本禁止出现生产端口字样），且该 URL 只是扫描数据、绝不发起连接
      writeClaudeSettings(h.home, { ANTHROPIC_BASE_URL: 'http://127.0.0.1:18999' })
      await cmdImport({ from: 'claude', yes: true })
      const out = logs.join('\n')
      expect(out).toContain('所有发现项均不可导入')
      const cfg = await loadConfig()
      expect(Object.keys(cfg.providers)).toHaveLength(0)
    } finally {
      h.restore()
    }
  })
})

describe('cmdImport claude 端到端（--yes 免勾选）', () => {
  it('直连上游候选：导入 provider + 自动建 profile + is_current 设 active_profile', async () => {
    const h = fakeHome()
    captureConsole()
    try {
      await saveConfig({ ...emptyConfig(), security: { store: 'file' } })
      writeClaudeSettings(h.home, {
        ANTHROPIC_BASE_URL: 'https://Api.Up.example.com/',
        ANTHROPIC_AUTH_TOKEN: 'sk-claude-1',
        ANTHROPIC_MODEL: 'claude-x[1M]',
      })
      await cmdImport({ from: 'claude', yes: true })

      const cfg = await loadConfig()
      expect(cfg.providers['claude-direct']).toBeDefined()
      // applyImport 落库走 normalizeBaseUrl：host 小写、尾斜杠剥离
      expect(cfg.providers['claude-direct']!.base_url).toBe('https://api.up.example.com')
      expect(cfg.profiles['claude-direct']).toBeDefined() // withProfiles 默认 true
      expect(cfg.active_profile).toBe('claude-direct') // is_current 候选设 active
      const out = logs.join('\n')
      expect(out).toContain('导入 provider')
      expect(out).toContain('创建 profile')
      expect(out).toContain('下一步')
    } finally {
      h.restore()
    }
  })
})
