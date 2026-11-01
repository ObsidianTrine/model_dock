import { describe, expect, it } from 'vitest'
import path from 'node:path'
import http from 'node:http'
import { fakeHome } from './helpers.js'
import { atomicWrite, ensureDir } from '../src/util/fsx.js'
import {
  applyImport,
  ccSwitchCodexRow,
  ccSwitchGeminiRow,
  isLocalBaseUrl,
  normalizeBaseUrl,
  oneApiChannelToCandidate,
  scanOneApi,
  scanSources,
  stripApiEndpoint,
  type ImportCandidate,
} from '../src/import/sources.js'
import { loadConfig } from '../src/config/store.js'
import { getSecret } from '../src/config/secrets.js'
describe('import scan · dsh', () => {
  it('BUG-10：多份 patch 中单份损坏不丢弃其余合法文件的候选', async () => {
    const h = fakeHome()
    try {
      // bad 占用字符序在前（先被扫描），其 YAML 损坏；good 合法，含可导入 provider
      const badDir = path.join(h.home, '.dsh', 'profiles', 'bad')
      const goodDir = path.join(h.home, '.dsh', 'profiles', 'good')
      await ensureDir(badDir)
      await ensureDir(goodDir)
      await atomicWrite(path.join(badDir, 'cordis.patch.yml'), '- id: llm-pi-ai\n  name: *unresolvedAlias\n', 0o600)
      await atomicWrite(
        path.join(goodDir, 'cordis.patch.yml'),
        '- id: llm-pi-ai\n  name: "@deepseek-ai/dsh-llm-pi-ai"\n  config:\n    providers:\n      ark:\n        api: anthropic-messages\n        baseURL: https://ark.example.com\n        apiKeyEnv: ARK\n        models:\n          - id: a\n            name: a\n',
        0o600
      )

      const out = await scanSources('dsh')
      // 合法文件仍产出候选（回归点：损坏文件不应 return 丢弃已收集结果）
      expect(out.some((c) => c.suggest_id === 'dsh-ark' && !c.skip_reason)).toBe(true)
      // 损坏文件以占位诊断呈现，而非整批消失
      expect(out.some((c) => c.skip_reason && c.skip_reason.includes('解析失败'))).toBe(true)
    } finally {
      h.restore()
    }
  })
})

describe('import scan · stripApiEndpoint', () => {
  it('剥掉最后一层请求端点；非端点形态原样返回', () => {
    expect(stripApiEndpoint('https://api.openai.com/v1/chat/completions')).toBe('https://api.openai.com/v1')
    expect(stripApiEndpoint('https://api.deepseek.com/chat/completions')).toBe('https://api.deepseek.com')
    expect(stripApiEndpoint('https://api.anthropic.com/v1/messages')).toBe('https://api.anthropic.com')
    expect(stripApiEndpoint('https://openrouter.ai/api/v1')).toBe('https://openrouter.ai/api/v1')
    expect(stripApiEndpoint('https://x.example.com/v1/responses')).toBe('https://x.example.com/v1')
  })
})

describe('import scan · codex', () => {
  it('config.toml model_providers → 候选（env_key 取进程环境、wire_api=responses、本地地址跳过）', async () => {
    const h = fakeHome()
    process.env.TEST_CODEX_KEY_X = 'sk-codex-test'
    try {
      const dir = path.join(h.home, '.codex')
      await ensureDir(dir)
      await atomicWrite(
        path.join(dir, 'config.toml'),
        [
          'model_provider = "ark"',
          '',
          '[model_providers.ark]',
          'name = "Ark"',
          'base_url = "https://ark.example.com/api/v3"',
          'env_key = "TEST_CODEX_KEY_X"',
          '',
          '[model_providers.resp]',
          'name = "R"',
          'base_url = "https://resp.example.com/v1"',
          'wire_api = "responses"',
          '',
          '[model_providers.local]',
          'base_url = "http://127.0.0.1:9999/v1"',
        ].join('\n'),
        0o600
      )
      const out = await scanSources('codex')
      const ark = out.find((c) => c.suggest_id === 'codex-ark')
      expect(ark?.protocol).toBe('openai')
      expect(ark?.key).toBe('sk-codex-test')
      expect(ark?.base_url).toBe('https://ark.example.com/api/v3')
      expect(ark?.is_current).toBe(true)
      const resp = out.find((c) => c.suggest_id === 'codex-resp')
      expect(resp?.protocol).toBe('responses')
      expect(resp?.is_current).toBeUndefined()
      expect(out.some((c) => c.suggest_id === 'codex-local')).toBe(false)
    } finally {
      delete process.env.TEST_CODEX_KEY_X
      h.restore()
    }
  })

  it('auth.json 在无自定义 openai 行时给官方通道候选', async () => {
    const h = fakeHome()
    try {
      const dir = path.join(h.home, '.codex')
      await ensureDir(dir)
      await atomicWrite(path.join(dir, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'sk-auth' }), 0o600)
      const out = await scanSources('codex')
      expect(out).toHaveLength(1)
      expect(out[0].suggest_id).toBe('codex-openai')
      expect(out[0].base_url).toBe('https://api.openai.com/v1')
      expect(out[0].key).toBe('sk-auth')
      expect(out[0].is_current).toBe(true)
    } finally {
      h.restore()
    }
  })

  it('config.toml 损坏 → 占位诊断而非崩溃', async () => {
    const h = fakeHome()
    try {
      const dir = path.join(h.home, '.codex')
      await ensureDir(dir)
      await atomicWrite(path.join(dir, 'config.toml'), '[model_providers.x\nbase_url = "https://x"', 0o600)
      const out = await scanSources('codex')
      expect(out[0].skip_reason).toContain('解析失败')
    } finally {
      h.restore()
    }
  })
})

describe('import scan · opencode / mimocode', () => {
  it('opencode.json → 候选（npm 定协议、{env:VAR} 引用、auth.json 兜底、本地地址跳过）', async () => {
    const h = fakeHome()
    process.env.TEST_OPE_ENV_KEY = 'sk-ant-env'
    try {
      const dir = path.join(h.home, '.config', 'opencode')
      await ensureDir(dir)
      await atomicWrite(
        path.join(dir, 'opencode.json'),
        JSON.stringify({
          model: 'ant/claude-x',
          provider: {
            ant: { npm: '@ai-sdk/anthropic', options: { baseURL: 'https://ant.example.com', apiKey: '{env:TEST_OPE_ENV_KEY}' } },
            oai: { npm: '@ai-sdk/openai-compatible', options: { baseURL: 'https://oai.example.com/v1' }, models: { m1: {}, m2: {} } },
            authd: { npm: '@ai-sdk/openai-compatible', options: { baseURL: 'https://authd.example.com' } },
            local: { npm: '@ai-sdk/openai-compatible', options: { baseURL: 'http://127.0.0.1:8687' } },
          },
        }),
        0o600
      )
      const dataDir = path.join(h.home, '.local', 'share', 'opencode')
      await ensureDir(dataDir)
      await atomicWrite(path.join(dataDir, 'auth.json'), JSON.stringify({ authd: { type: 'api', key: 'sk-auth' } }), 0o600)

      const out = await scanSources('opencode')
      const ant = out.find((c) => c.suggest_id === 'opencode-ant')
      expect(ant?.protocol).toBe('anthropic')
      expect(ant?.key).toBe('sk-ant-env')
      expect(ant?.is_current).toBe(true)
      const oai = out.find((c) => c.suggest_id === 'opencode-oai')
      expect(oai?.protocol).toBe('openai')
      expect(oai?.models).toEqual(['m1', 'm2'])
      const authd = out.find((c) => c.suggest_id === 'opencode-authd')
      expect(authd?.key).toBe('sk-auth')
      expect(authd?.key_note).toContain('auth.json')
      expect(out.some((c) => c.suggest_id === 'opencode-local')).toBe(false)
    } finally {
      delete process.env.TEST_OPE_ENV_KEY
      h.restore()
    }
  })

  it('mimocode.jsonc（JSONC 注释宽容）→ mimo 前缀候选', async () => {
    const h = fakeHome()
    try {
      const dir = path.join(h.home, '.config', 'mimocode')
      await ensureDir(dir)
      await atomicWrite(
        path.join(dir, 'mimocode.jsonc'),
        '{\n  // 注释\n  "$schema": "https://mimo.xiaomi.com/mimocode/config.json",\n  "provider": {\n    "ark": { "npm": "@ai-sdk/openai-compatible", "options": { "baseURL": "https://ark.example.com/api/v3", "apiKey": "sk-mimo" } }\n  }\n}\n',
        0o600
      )
      const out = await scanSources('mimocode')
      expect(out).toHaveLength(1)
      expect(out[0].suggest_id).toBe('mimo-ark')
      expect(out[0].key).toBe('sk-mimo')
      expect(out[0].protocol).toBe('openai')
    } finally {
      h.restore()
    }
  })
})

describe('import scan · workbuddy', () => {
  it('models.json 同上游多模型条目合并为一个候选；本地端点跳过', async () => {
    const h = fakeHome()
    try {
      const dir = path.join(h.home, '.workbuddy-ai')
      await ensureDir(dir)
      await atomicWrite(
        path.join(dir, 'models.json'),
        JSON.stringify([
          { id: 'deepseek-chat', url: 'https://api.deepseek.com/chat/completions', apiKey: 'sk-wb' },
          { id: 'deepseek-reasoner', url: 'https://api.deepseek.com/chat/completions', apiKey: 'sk-wb' },
          { id: 'gateway', url: 'http://127.0.0.1:8687/v1/chat/completions', apiKey: 'tok' },
        ]),
        0o600
      )
      const out = await scanSources('workbuddy')
      expect(out).toHaveLength(1)
      expect(out[0].suggest_id).toBe('workbuddy-deepseek-chat')
      expect(out[0].base_url).toBe('https://api.deepseek.com')
      expect(out[0].models).toEqual(['deepseek-chat', 'deepseek-reasoner'])
      expect(out[0].key).toBe('sk-wb')
    } finally {
      h.restore()
    }
  })
})

describe('import scan · claude-code-router', () => {
  it('Providers 数组 → 候选（全端点剥端点层、Router.default 标记使用中、/v1/messages 判 anthropic）', async () => {
    const h = fakeHome()
    try {
      const dir = path.join(h.home, '.claude-code-router')
      await ensureDir(dir)
      await atomicWrite(
        path.join(dir, 'config.json'),
        JSON.stringify({
          Providers: [
            { name: 'or', api_base_url: 'https://openrouter.ai/api/v1/chat/completions', api_key: 'sk-or', models: ['m1'] },
            { name: 'ant', api_base_url: 'https://api.anthropic.com/v1/messages', api_key: 'sk-ant', models: ['claude-x'] },
          ],
          Router: { default: 'or,m1' },
        }),
        0o600
      )
      const out = await scanSources('ccr')
      const or = out.find((c) => c.suggest_id === 'ccr-or')
      expect(or?.base_url).toBe('https://openrouter.ai/api/v1')
      expect(or?.protocol).toBe('openai')
      expect(or?.key).toBe('sk-or')
      expect(or?.is_current).toBe(true)
      const ant = out.find((c) => c.suggest_id === 'ccr-ant')
      expect(ant?.base_url).toBe('https://api.anthropic.com')
      expect(ant?.protocol).toBe('anthropic')
      expect(ant?.is_current).toBeUndefined()
    } finally {
      h.restore()
    }
  })
})

describe('import scan · crush', () => {
  it('providers 对象 map → 候选；非 OpenAI/Anthropic 类型给 skip_reason', async () => {
    const h = fakeHome()
    try {
      const dir = path.join(h.home, '.config', 'crush')
      await ensureDir(dir)
      await atomicWrite(
        path.join(dir, 'crush.json'),
        JSON.stringify({
          providers: {
            or: { name: 'OR', base_url: 'https://openrouter.ai/api/v1', type: 'openai', api_key: 'sk-c', models: [{ id: 'm1', name: 'M1' }] },
            ant: { base_url: 'https://api.anthropic.com', type: 'anthropic', api_key: 'sk-a' },
            gm: { base_url: 'https://generativelanguage.googleapis.com', type: 'gemini' },
          },
        }),
        0o600
      )
      const out = await scanSources('crush')
      const or = out.find((c) => c.suggest_id === 'crush-or')
      expect(or?.protocol).toBe('openai')
      expect(or?.models).toEqual(['m1'])
      expect(out.find((c) => c.suggest_id === 'crush-ant')?.protocol).toBe('anthropic')
      const gm = out.find((c) => c.suggest_id === 'crush-gm')
      expect(gm?.skip_reason).toBeTruthy()
      expect(gm?.base_url).toBe('')
    } finally {
      h.restore()
    }
  })
})

describe('import scan · gemini', () => {
  const relayEnvVars = ['GOOGLE_GEMINI_BASE_URL', 'GEMINI_BASE_URL', 'GEMINI_API_KEY', 'GOOGLE_GEMINI_API_KEY']

  it('.env 中转配置 → 单候选（openai 协议）；无中转变量无候选', async () => {
    const h = fakeHome()
    const saved: Record<string, string | undefined> = {}
    try {
      for (const k of relayEnvVars) {
        saved[k] = process.env[k]
        delete process.env[k]
      }
      const dir = path.join(h.home, '.gemini')
      await ensureDir(dir)
      await atomicWrite(path.join(dir, '.env'), '# relay\nGOOGLE_GEMINI_BASE_URL=https://relay.example.com\nGEMINI_API_KEY="sk-g"\n', 0o600)
      const out = await scanSources('gemini')
      expect(out).toHaveLength(1)
      expect(out[0].base_url).toBe('https://relay.example.com')
      expect(out[0].key).toBe('sk-g')
      expect(out[0].protocol).toBe('openai')
      expect(out[0].is_current).toBe(true)
      // 没有中转变量 → 无候选（官方 Google 登录没有可收编的上游）
      await atomicWrite(path.join(dir, '.env'), 'GEMINI_API_KEY=sk-official\n', 0o600)
      expect(await scanSources('gemini')).toHaveLength(0)
    } finally {
      for (const k of relayEnvVars) {
        if (saved[k] === undefined) delete process.env[k]
        else process.env[k] = saved[k]!
      }
      h.restore()
    }
  })
})

describe('import scan · cc-switch codex / gemini 行', () => {
  it('codex 行：config TOML 展开 + auth.OPENAI_API_KEY 作为使用中供应商的 Key', () => {
    const rows = ccSwitchCodexRow({
      name: 'Ark',
      is_current: 1,
      settings_config: JSON.stringify({
        auth: { OPENAI_API_KEY: 'sk-cc' },
        config: 'model_provider = "ark"\n\n[model_providers.ark]\nname = "Ark"\nbase_url = "https://ark.example.com/api/v3"\nenv_key = "X"\n',
      }),
    })
    expect(rows).toHaveLength(1)
    expect(rows[0].key).toBe('sk-cc')
    expect(rows[0].is_current).toBe(true)
    expect(rows[0].protocol).toBe('openai')
    expect(rows[0].base_url).toBe('https://ark.example.com/api/v3')
  })

  it('codex 行 config 非 TOML → skip 诊断', () => {
    const rows = ccSwitchCodexRow({ name: 'bad', settings_config: JSON.stringify({ config: '[broken' }) })
    expect(rows[0].skip_reason).toBeTruthy()
  })

  it('gemini 行：env 里的中转 base_url + key', () => {
    const cand = ccSwitchGeminiRow({
      name: 'Relay',
      settings_config: JSON.stringify({ env: { GEMINI_API_KEY: 'sk-g', GOOGLE_GEMINI_BASE_URL: 'https://relay.example.com' } }),
    })
    expect(cand?.base_url).toBe('https://relay.example.com')
    expect(cand?.protocol).toBe('openai')
    expect(cand?.key).toBe('sk-g')
    // 官方用法（无中转 base_url）没有可收编对象
    expect(ccSwitchGeminiRow({ name: 'official', settings_config: JSON.stringify({ env: { GEMINI_API_KEY: 'k' } }) })).toBeNull()
  })
})

describe('import scan · one-api 渠道映射', () => {
  it('类型映射：14 anthropic / 1 OpenAI 官方端点 / 自定义 base_url / 停用与不支持类型跳过', () => {
    const anthropic = oneApiChannelToCandidate({ type: 14, name: 'claude官方', key: 'sk-1', status: 1, base_url: '' })
    expect(anthropic.protocol).toBe('anthropic')
    expect(anthropic.base_url).toBe('https://api.anthropic.com')
    expect(anthropic.skip_reason).toBeUndefined()

    const openai = oneApiChannelToCandidate({ type: 1, name: 'oai', key: 'sk-2', status: 1, base_url: '' })
    expect(openai.base_url).toBe('https://api.openai.com/v1')

    const relay = oneApiChannelToCandidate({ type: 8, name: 'relay', key: 'sk-3', status: 1, base_url: 'https://r.example.com', models: 'a, b' })
    expect(relay.protocol).toBe('openai')
    expect(relay.base_url).toBe('https://r.example.com')
    expect(relay.models).toEqual(['a', 'b'])

    expect(oneApiChannelToCandidate({ type: 1, name: 'd', key: 'k', status: 2 }).skip_reason).toBeTruthy()
    expect(oneApiChannelToCandidate({ type: 3, name: 'azure', key: 'k', status: 1, base_url: 'https://x' }).skip_reason).toBeTruthy()
    expect(oneApiChannelToCandidate({ type: 24, name: 'gemini', key: 'k', status: 1, base_url: 'https://g' }).skip_reason).toBeTruthy()
    expect(oneApiChannelToCandidate({ type: 8, name: 'nokey', key: '', status: 1, base_url: 'https://x' }).skip_reason).toBeTruthy()
    // 未映射类型且未填 base_url：给出可操作原因
    expect(oneApiChannelToCandidate({ type: 99, name: 'odd', key: 'k', status: 1, base_url: '' }).skip_reason).toBeTruthy()
  })

  it('scanOneApi 走本地 mock 站点：分页拉到空页、带 Authorization 头', async () => {
    const seen: string[] = []
    const server = http.createServer((req, res) => {
      const u = new URL(req.url ?? '/', 'http://x')
      seen.push(`${req.method} ${u.pathname}${u.search} auth=${req.headers.authorization}`)
      const page = Number(u.searchParams.get('p') ?? 0)
      const data =
        page === 0
          ? [{ type: 1, name: 'c1', key: 'sk-a', status: 1, base_url: '', models: 'gpt-4o' }]
          : page === 1
            ? [{ type: 14, name: 'c2', key: 'sk-b', status: 1, base_url: 'https://anthropic.example.com' }]
            : []
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ success: true, message: '', data }))
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    try {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      const out = await scanOneApi({ url: `http://127.0.0.1:${port}`, token: 'tok-123' })
      expect(seen[0]).toContain('/api/channel/')
      expect(seen[0]).toContain('auth=tok-123')
      expect(seen.length).toBeGreaterThanOrEqual(3) // 两页数据 + 一页空页
      expect(out.filter((c) => !c.skip_reason)).toHaveLength(2)
      expect(out.find((c) => c.suggest_id === 'oneapi-c1')?.base_url).toBe('https://api.openai.com/v1')
      expect(out.find((c) => c.suggest_id === 'oneapi-c2')?.protocol).toBe('anthropic')
    } finally {
      server.closeAllConnections()
      await new Promise<void>((r) => server.close(() => r()))
    }
  })

  it('令牌无效（401）→ 可操作报错', async () => {
    const server = http.createServer((req, res) => {
      res.statusCode = 401
      res.end(JSON.stringify({ success: false, message: '无权进行此操作，access token 无效' }))
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    try {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      await expect(scanOneApi({ url: `http://127.0.0.1:${port}`, token: 'bad' })).rejects.toThrow(/401/)
    } finally {
      server.closeAllConnections()
      await new Promise<void>((r) => server.close(() => r()))
    }
  })
})

describe('normalizeBaseUrl / isLocalBaseUrl 等价类', () => {
  it('normalizeBaseUrl：小写主机、去默认端口与结尾斜杠；非法输入回落 trim', () => {
    expect(normalizeBaseUrl('https://API.Example.com/')).toBe('https://api.example.com')
    expect(normalizeBaseUrl('https://api.example.com:443/v1/')).toBe('https://api.example.com/v1')
    expect(normalizeBaseUrl('http://api.example.com:8080/v1///')).toBe('http://api.example.com:8080/v1')
    expect(normalizeBaseUrl('https://api.example.com')).toBe('https://api.example.com')
    expect(normalizeBaseUrl('  not a url///')).toBe('not a url')
  })

  it('isLocalBaseUrl：回环段命中；恰含 127.0.0.1 子串的公网域名不误伤', () => {
    for (const u of ['http://localhost:8080', 'http://127.0.0.1:8687', 'http://127.127.0.1', 'https://foo.localhost']) {
      expect(isLocalBaseUrl(u), u).toBe(true)
    }
    for (const u of ['https://127.0.0.1.evil.com', 'https://example.com/127.0.0.1', 'https://api.example.com']) {
      expect(isLocalBaseUrl(u), u).toBe(false)
    }
    // 非法 URL 走 includes 回落分支
    expect(isLocalBaseUrl('not-a-url-but-127.0.0.1-inside')).toBe(true)
    expect(isLocalBaseUrl('not-a-url')).toBe(false)
    // 已知 quirk（钉住现状）：WHATWG hostname 对 IPv6 字面量带方括号（'[::1]'），
    // 代码里的 `h === '::1'` 分支实际不可达 → [::1] 不视为本地。修复时同步改此断言。
    expect(isLocalBaseUrl('http://[::1]:8687')).toBe(false)
  })
})

describe('import scan · claude / zcode / all', () => {
  it('claude：直连上游产出 is_current 候选（key + 模型去上下文后缀）', async () => {
    const h = fakeHome()
    try {
      await ensureDir(path.join(h.home, '.claude'))
      await atomicWrite(
        path.join(h.home, '.claude', 'settings.json'),
        JSON.stringify({
          env: {
            ANTHROPIC_BASE_URL: 'https://Api.Up.example.com/',
            ANTHROPIC_AUTH_TOKEN: 'sk-claude-1',
            ANTHROPIC_MODEL: 'claude-x[1M]',
            ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-y',
          },
        }),
        0o600
      )
      const out = await scanSources('claude')
      expect(out).toHaveLength(1)
      const c = out[0]
      expect(c.suggest_id).toBe('claude-direct')
      expect(c.is_current).toBe(true)
      expect(c.key).toBe('sk-claude-1')
      expect(c.base_url).toBe('https://Api.Up.example.com/')
      expect(c.models).toEqual(expect.arrayContaining(['claude-x', 'claude-y']))
      expect(c.models?.some((m) => m.includes('[1M]'))).toBe(false)
    } finally {
      h.restore()
    }
  })

  it('claude：本地代理 → skip_reason 占位；坏 JSON → 解析失败占位；无文件 → 空数组', async () => {
    const h = fakeHome()
    try {
      expect(await scanSources('claude')).toEqual([])

      await ensureDir(path.join(h.home, '.claude'))
      await atomicWrite(
        path.join(h.home, '.claude', 'settings.json'),
        JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8687' } }),
        0o600
      )
      let out = await scanSources('claude')
      expect(out).toHaveLength(1)
      expect(out[0].skip_reason).toContain('本地代理')
      expect(out[0].key).toBeNull()

      await atomicWrite(path.join(h.home, '.claude', 'settings.json'), '{oops', 0o600)
      out = await scanSources('claude')
      expect(out).toHaveLength(1)
      expect(out[0].skip_reason).toContain('解析失败')
    } finally {
      h.restore()
    }
  })

  it('zcode：apiKey 收编、无 apiKey 记 oauth 占位、本地地址跳过、builtin:/preset: 前缀剥离', async () => {
    const h = fakeHome()
    try {
      await ensureDir(path.join(h.home, '.zcode', 'v2'))
      await atomicWrite(
        path.join(h.home, '.zcode', 'v2', 'config.json'),
        JSON.stringify({
          provider: {
            'builtin:ark': { name: '方舟', options: { baseURL: 'https://ark.example.com', apiKey: 'sk-z1' } },
            'preset:o': { baseURL: 'https://oauth.example.com' },
            local: { options: { baseURL: 'http://127.0.0.1:18999', apiKey: 'sk-local' } },
          },
        }),
        0o600
      )
      const out = await scanSources('zcode')
      const ark = out.find((c) => c.suggest_id === 'zcode-ark')
      expect(ark?.key).toBe('sk-z1')
      expect(ark?.name).toBe('ZCode · 方舟')
      const oauth = out.find((c) => c.suggest_id === 'zcode-o')
      expect(oauth?.skip_reason).toContain('oauth')
      expect(oauth?.base_url).toBe('https://oauth.example.com')
      expect(out.some((c) => c.base_url.includes('127.0.0.1'))).toBe(false)
    } finally {
      h.restore()
    }
  })

  it('all：跨来源同址去重保留「使用中」的候选（claude is_current 压过 zcode）', async () => {
    const h = fakeHome()
    try {
      await ensureDir(path.join(h.home, '.claude'))
      await atomicWrite(
        path.join(h.home, '.claude', 'settings.json'),
        JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://Same.Example.com/v1', ANTHROPIC_AUTH_TOKEN: 'sk-live' } }),
        0o600
      )
      await ensureDir(path.join(h.home, '.zcode', 'v2'))
      await atomicWrite(
        path.join(h.home, '.zcode', 'v2', 'config.json'),
        JSON.stringify({ provider: { bak: { options: { baseURL: 'https://same.example.com/v1///', apiKey: 'sk-old' } } } }),
        0o600
      )
      const out = await scanSources('all')
      const same = out.filter((c) => normalizeBaseUrl(c.base_url) === 'https://same.example.com/v1')
      expect(same).toHaveLength(1)
      expect(same[0].source).toBe('claude')
      expect(same[0].key).toBe('sk-live')
    } finally {
      h.restore()
    }
  })
})

describe('applyImport（候选 → provider/profile/secret）', () => {
  const cand = (over: Partial<ImportCandidate>): ImportCandidate => ({
    source: 'claude',
    suggest_id: 'x',
    name: 'X',
    base_url: 'https://up.example.com',
    protocol: 'anthropic',
    auth_style: 'bearer',
    key: null,
    ...over,
  })

  it('落地 provider+profile、key 批量入 file store、is_current 设 active_profile；本批同址同 key 去重、占位跳过', async () => {
    const h = fakeHome()
    try {
      const cfg = await loadConfig()
      cfg.security = { store: 'file' }
      const report = await applyImport(
        cfg,
        [
          cand({ suggest_id: 'up', name: 'UP', key: 'sk-a', models: ['m1'], is_current: true }),
          // 同址（443 默认端口 + 尾斜杠归一后相同）同 key → 本批去重
          cand({ suggest_id: 'up2', name: 'UP2', base_url: 'https://up.example.com:443/', key: 'sk-a' }),
          // 占位诊断（无 base_url）→ skipped，不落盘
          cand({ suggest_id: 'diag', name: 'd', base_url: '', skip_reason: '无 sqlite3' }),
        ],
        { withProfiles: true }
      )
      expect(report.providers).toEqual(['up'])
      expect(report.profiles).toEqual(['up'])
      expect(report.skipped.map((s) => s.id)).toEqual(['up2', 'diag'])
      expect(cfg.providers['up']?.base_url).toBe('https://up.example.com')
      expect(cfg.profiles['up']?.default_model).toBe('m1')
      expect(cfg.active_profile).toBe('up')
      expect(await getSecret(cfg.providers['up']!.key_ref!)).toBe('sk-a')
    } finally {
      h.restore()
    }
  })

  it('已有服务坏 key_ref（缺失/非串）不卡死导入：该条跳过 key 比对、候选照常落地（卡 30）', async () => {
    const h = fakeHome()
    try {
      const cfg = await loadConfig()
      cfg.security = { store: 'file' }
      cfg.providers['badnum'] = { name: 'BN', base_url: 'https://up.example.com', protocol: 'anthropic', auth_style: 'bearer', key_ref: 123 as unknown as string }
      cfg.providers['badmiss'] = { name: 'BM', base_url: 'https://up.example.com', protocol: 'anthropic', auth_style: 'bearer', key_ref: undefined as unknown as string }
      const report = await applyImport(cfg, [cand({ suggest_id: 'up', name: 'UP', key: 'sk-a' })], { withProfiles: false })
      // 坏条目 key 降级 ''（与候选 key 'sk-a' 不等）→ 不误判重复，候选照常落地
      expect(report.providers).toContain('up')
      expect(report.skipped).toHaveLength(0)
      expect(cfg.providers['up']).toBeDefined()
    } finally {
      h.restore()
    }
  })

  it('与已有服务同址同 key 跳过（env 引用 key 也参与比对）；id 撞名自动加后缀', async () => {
    const h = fakeHome()
    const saved = process.env.MD_TEST_IMP_KEY
    process.env.MD_TEST_IMP_KEY = 'sk-same'
    try {
      const cfg = await loadConfig()
      cfg.security = { store: 'file' }
      cfg.providers['exist'] = {
        name: 'E',
        base_url: 'https://Same.example.com',
        protocol: 'anthropic',
        auth_style: 'bearer',
        key_ref: 'env:MD_TEST_IMP_KEY',
      }
      const report = await applyImport(
        cfg,
        [
          // 同址同 key（key 经 env: 引用解析）→ 跳过
          cand({ suggest_id: 'dup', base_url: 'https://same.example.com/', key: 'sk-same' }),
          // suggest_id 与已有 provider 撞名 → 后缀去重；key 不同 → 正常导入
          cand({ suggest_id: 'exist', base_url: 'https://other.example.com', key: 'sk-b' }),
        ],
        { withProfiles: false }
      )
      expect(report.providers).toEqual(['exist-2'])
      expect(report.skipped).toHaveLength(1)
      expect(report.skipped[0].reason).toContain('exist')
      expect(cfg.profiles).toEqual({})
    } finally {
      if (saved === undefined) delete process.env.MD_TEST_IMP_KEY
      else process.env.MD_TEST_IMP_KEY = saved
      h.restore()
    }
  })

  it('批内 suggest_id 撞车（不同 base_url 同名）→ 各自后缀，不静默覆盖（P1 回归）', async () => {
    const h = fakeHome()
    try {
      const cfg = await loadConfig()
      cfg.security = { store: 'file' }
      const report = await applyImport(
        cfg,
        [
          cand({ suggest_id: 'chan', name: 'chan', base_url: 'https://a.example.com', key: 'sk-a' }),
          // 同名不同址（one-api 同名渠道常见）：撞车兜底须查本批已用 id，否则后者覆盖前者
          cand({ suggest_id: 'chan', name: 'chan', base_url: 'https://b.example.com', key: 'sk-b' }),
        ],
        { withProfiles: false }
      )
      expect(report.providers).toEqual(['chan', 'chan-2'])
      expect(cfg.providers['chan']?.base_url).toBe('https://a.example.com')
      expect(cfg.providers['chan-2']?.base_url).toBe('https://b.example.com')
      expect(await getSecret(cfg.providers['chan']!.key_ref!)).toBe('sk-a')
      expect(await getSecret(cfg.providers['chan-2']!.key_ref!)).toBe('sk-b')
    } finally {
      h.restore()
    }
  })
})
describe('import sources · scanZcode（现行个人供应商存储）', () => {
  it('扫到 provider_config.json 的自定义供应商；跳过 modeldock 条目与停用条目（P2 回归）', async () => {
    const h = fakeHome()
    try {
      const dir = path.join(h.home, '.zcode', 'v2')
      await ensureDir(dir)
      await atomicWrite(
        path.join(dir, 'provider_config.json'),
        JSON.stringify({
          schemaVersion: 1,
          config: {
            providerConfigRules: {
              providerRules: [
                { providerId: 'my-up', providerName: 'My Up', enabled: true, config: { access: { type: 'api-key', apiKey: 'sk-z1' }, api: { type: 'openai-chat-completions', baseUrl: 'https://z.example.com/v1' } } },
                // ModelDock 自己的条目不收编
                { providerId: 'modeldock', providerName: 'ModelDock', enabled: true, config: { access: { type: 'api-key', apiKey: 'mdk' }, api: { type: 'anthropic-messages', baseUrl: 'http://127.0.0.1:8687' } } },
                // 停用条目不收编
                { providerId: 'off-one', providerName: 'Off', enabled: false, config: { access: { type: 'api-key', apiKey: 'sk-off' }, api: { type: 'anthropic-messages', baseUrl: 'https://off.example.com' } } },
                // 无 enabled 字段视为启用
                { providerId: 'anth-one', providerName: 'Anth', config: { access: { type: 'api-key', apiKey: 'sk-anth' }, api: { type: 'anthropic-messages', baseUrl: 'https://anth.example.com' } } },
              ],
            },
          },
        }),
        0o600
      )
      const out = await scanSources('zcode')
      const mine = out.filter((c) => !c.skip_reason)
      expect(mine.map((c) => c.base_url)).toEqual(['https://z.example.com/v1', 'https://anth.example.com'])
      expect(mine[0]).toMatchObject({ protocol: 'openai', key: 'sk-z1' })
      expect(mine[1]).toMatchObject({ protocol: 'anthropic', key: 'sk-anth' })
    } finally {
      h.restore()
    }
  })
})
