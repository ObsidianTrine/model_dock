import { describe, expect, it, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { fakeHome } from './helpers.js'
import { scanMcpServers, findDuplicateNames, type McpScanResult } from '../src/mcp/scan.js'
import { emptyConfig } from '../src/config/types.js'
import { saveConfig } from '../src/config/store.js'
import { buildRuntime } from '../src/gateway/state.js'
import { createGatewayServer } from '../src/gateway/server.js'

// 只读盘点：不触网、不起真实上游。日历/目录拉取禁掉（与 gateway.test.ts 同口径防意外出站）
process.env.MODELRDOCK_DISABLE_HOLIDAY_FETCH = '1'
process.env.MODELRDOCK_DISABLE_CATALOG_FETCH = '1'

const homes: ReturnType<typeof fakeHome>[] = []
afterEach(() => {
  while (homes.length) homes.pop()!.restore()
})

function mkHome(): string {
  const h = fakeHome()
  homes.push(h)
  return h.home
}

/** 在假 home 下写文件（自动建父目录） */
function write(home: string, rel: string[], content: string): string {
  const p = path.join(home, ...rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, content)
  return p
}

function writeJson(home: string, rel: string[], obj: unknown): string {
  return write(home, rel, JSON.stringify(obj, null, 2))
}

async function scan(home: string): Promise<McpScanResult> {
  // scanMcpServers 经 homeDir() 读假 home；显式传 home 只为可读性
  void home
  return scanMcpServers()
}

describe('MCP 盘点扫描（scanMcpServers）', () => {
  it('空 home：无条目无错误', async () => {
    const home = mkHome()
    const r = await scan(home)
    expect(r.entries).toEqual([])
    expect(r.errors).toEqual([])
  })

  it('claude-code：顶层 mcpServers=user，projects.<path>.mcpServers=project；env 只收变量名不收值', async () => {
    const home = mkHome()
    writeJson(home, ['.claude.json'], {
      numStartups: 3,
      mcpServers: {
        fs: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-fs', '/tmp'], env: { FOO: 'sk-secret-value' } },
      },
      projects: {
        '/repo/a': { mcpServers: { gh: { type: 'http', url: 'https://example.com/mcp' } } },
      },
    })
    const r = await scan(home)
    expect(r.errors).toEqual([])
    expect(r.entries).toHaveLength(2)
    const user = r.entries.find((e) => e.name === 'fs')!
    expect(user.harness).toBe('claude-code')
    expect(user.scope).toBe('user')
    expect(user.transport).toBe('stdio')
    expect(user.target).toBe('npx -y @modelcontextprotocol/server-fs /tmp')
    expect(user.envKeys).toEqual(['FOO'])
    const proj = r.entries.find((e) => e.name === 'gh')!
    expect(proj.scope).toBe('project')
    expect(proj.project).toBe('/repo/a')
    expect(proj.transport).toBe('http')
    // 值绝不进结果（控制台与日志都会展示这份 JSON）
    expect(JSON.stringify(r)).not.toContain('sk-secret-value')
  })

  it('claude-code：http 类型缺省 type 也按 http 识别；完全无法识别的形态记错误不中断', async () => {
    const home = mkHome()
    writeJson(home, ['.claude.json'], {
      mcpServers: {
        direct: { url: 'https://example.com/sse' },
        weird: { whatever: 1 },
      },
    })
    const r = await scan(home)
    expect(r.entries.map((e) => e.name)).toEqual(['direct'])
    expect(r.entries[0].transport).toBe('http')
    expect(r.errors).toHaveLength(1)
    expect(r.errors[0].source).toContain('.claude.json · weird')
  })

  it('codex：[mcp_servers.<name>] TOML 解析', async () => {
    const home = mkHome()
    write(
      home,
      ['.codex', 'config.toml'],
      [
        'model = "gpt-5"',
        '[mcp_servers.db]',
        'command = "uvx"',
        'args = ["mcp-server-db"]',
        '',
        '[mcp_servers.db.env]',
        'DB_DSN = "postgres://u:p@h/db"',
      ].join('\n')
    )
    const r = await scan(home)
    expect(r.errors).toEqual([])
    const e = r.entries[0]
    expect(e.harness).toBe('codex')
    expect(e.name).toBe('db')
    expect(e.transport).toBe('stdio')
    expect(e.target).toBe('uvx mcp-server-db')
    expect(e.envKeys).toEqual(['DB_DSN'])
  })

  it('zcode：~/.zcode/cli/config.json 的 mcp.servers 优先；无 MCP 配置时回退 ~/.agents/mcp.json', async () => {
    // ① 主配置有 servers：fallback 整体忽略（同 scope 回退规则）
    let home = mkHome()
    writeJson(home, ['.zcode', 'cli', 'config.json'], { mcp: { servers: { mysql: { command: 'npx', args: ['-y', 'mcp-mysql'] } } } })
    writeJson(home, ['.agents', 'mcp.json'], { mcpServers: { ghost: { command: 'node' } } })
    let r = await scan(home)
    expect(r.entries.map((e) => e.name)).toEqual(['mysql'])
    expect(r.entries[0].harness).toBe('zcode')

    // ② 主配置无 mcp 段：读 fallback
    home = mkHome()
    writeJson(home, ['.zcode', 'cli', 'config.json'], { provider: {} })
    writeJson(home, ['.agents', 'mcp.json'], { mcpServers: { jira: { url: 'https://example.com/mcp' } } })
    r = await scan(home)
    expect(r.entries.map((e) => e.name)).toEqual(['jira'])
    expect(r.entries[0].transport).toBe('http')
  })

  it('opencode：mcp 键 local（command 数组 + environment）/ remote（url）', async () => {
    const home = mkHome()
    writeJson(home, ['.config', 'opencode', 'opencode.json'], {
      mcp: {
        loc: { type: 'local', command: ['npx', '-y', 'pkg'], environment: { TOKEN_ENV: 'tv' } },
        rem: { type: 'remote', url: 'https://r.example/mcp' },
      },
    })
    const r = await scan(home)
    expect(r.errors).toEqual([])
    const loc = r.entries.find((e) => e.name === 'loc')!
    expect(loc.transport).toBe('stdio')
    expect(loc.target).toBe('npx -y pkg')
    expect(loc.envKeys).toEqual(['TOKEN_ENV'])
    const rem = r.entries.find((e) => e.name === 'rem')!
    expect(rem.transport).toBe('http')
    expect(JSON.stringify(r)).not.toContain('tv')
  })

  it('单源损坏不击穿其他来源：错误带文件路径，其余条目照常', async () => {
    const home = mkHome()
    write(home, ['.claude.json'], '{not json')
    write(home, ['.codex', 'config.toml'], '[mcp_servers.x]\ncommand = "node"\n')
    const r = await scan(home)
    expect(r.errors).toHaveLength(1)
    expect(r.errors[0].source).toContain('.claude.json')
    expect(r.entries).toHaveLength(1)
    expect(r.entries[0].harness).toBe('codex')
  })

  it('findDuplicateNames：同名多处才报，返回按名排序', () => {
    const mk = (name: string, harness: string): Parameters<typeof findDuplicateNames>[0][number] => ({
      name,
      harness,
      transport: 'stdio',
      target: 'x',
      scope: 'user',
      envKeys: [],
      sourceFile: 'f',
    })
    expect(findDuplicateNames([mk('b', 'codex'), mk('a', 'zcode'), mk('a', 'codex')])).toEqual(['a'])
    expect(findDuplicateNames([mk('a', 'codex')])).toEqual([])
  })
})

describe('GET /_modeldock/mcp（控制台盘点端点）', () => {
  it('未鉴权 401；鉴权后返回聚合清单', async () => {
    const h = mkHome()
    writeJson(h, ['.claude.json'], { mcpServers: { fs: { command: 'npx', args: ['-y', 'fs'] } } })
    await saveConfig(emptyConfig())
    const rt = buildRuntime(emptyConfig(), 'admin-token-x')
    const server = createGatewayServer(rt, { port: 0 })
    const port = await new Promise<number>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port))
    })
    try {
      const base = `http://127.0.0.1:${port}/_modeldock`
      expect((await fetch(base + '/mcp')).status).toBe(401)
      const res = await fetch(base + '/mcp', { headers: { 'x-modeldock-admin': 'admin-token-x' } })
      expect(res.status).toBe(200)
      const j = (await res.json()) as { ok: boolean; servers: Array<{ name: string; harness: string }>; errors: unknown[] }
      expect(j.ok).toBe(true)
      expect(j.errors).toEqual([])
      expect(j.servers.map((s) => s.name)).toEqual(['fs'])
      expect(j.servers[0].harness).toBe('claude-code')
    } finally {
      server.closeAllConnections?.()
      server.close()
    }
  })
})
