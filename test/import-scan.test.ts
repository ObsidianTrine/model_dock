import { describe, expect, it } from 'vitest'
import path from 'node:path'
import { fakeHome } from './helpers.js'
import { atomicWrite, ensureDir } from '../src/util/fsx.js'
import { applyImport, isLocalBaseUrl, normalizeBaseUrl, scanSources, type ImportCandidate } from '../src/import/sources.js'
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
})