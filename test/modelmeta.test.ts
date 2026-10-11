import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { once } from 'node:events'
import { describe, expect, it } from 'vitest'
import { fakeHome } from './helpers.js'
import { fetchModelIds, parseUpstreamModelMeta } from '../src/providers/fetch.js'
import { catalogModelMeta, clearCatalogMemo, normalizeApiCatalog, readCatalogCache, refreshCatalog } from '../src/providers/catalog.js'
import { fullKnownTable, resolveModelMeta } from '../src/providers/resolve.js'
import { EXTRA, baseModelIds, knownByIdTable, knownModelMeta, knownMetaTable } from '../src/providers/known.js'
import { setSecret } from '../src/config/secrets.js'
import type { ProviderConfig } from '../src/config/types.js'

/** 在 fakeHome 里写目录缓存文件并清 memo（写盘后 stat mtime 变化会自然失效，双保险） */
function writeCache(home: string, data: unknown): void {
  const dir = path.join(home, '.modeldock')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'model-catalog.json'), JSON.stringify(data))
  clearCatalogMemo()
}

describe('parseUpstreamModelMeta（上游 /models 自带元数据归一化）', () => {
  it('DeepSeek 字段：context_window / max_output_tokens', () => {
    expect(parseUpstreamModelMeta({ id: 'deepseek-chat', context_window: 131072, max_output_tokens: 8192 }, 'openai'))
      .toEqual({ context_window: 131072, max_output: 8192 })
  })

  it('Kimi 只报上下文（context_length），最大输出落到更低层', () => {
    expect(parseUpstreamModelMeta({ id: 'k2', context_length: 262144 }, 'openai')).toEqual({ context_window: 262144 })
  })

  it('Gemini camelCase：inputTokenLimit / outputTokenLimit', () => {
    expect(parseUpstreamModelMeta({ id: 'gem', inputTokenLimit: 1_000_000, outputTokenLimit: 8192 }, 'openai'))
      .toEqual({ context_window: 1_000_000, max_output: 8192 })
  })

  it('Fireworks contextLength；Together context_length 不混入 max_tokens 字段', () => {
    expect(parseUpstreamModelMeta({ id: 'fw', contextLength: 4096, max_tokens: 999 }, 'openai')).toEqual({ context_window: 4096 })
  })

  it('anthropic 协议下 max_tokens 视为最大输出；openai 协议下该键不采信', () => {
    const item = { id: 'claude-x', max_input_tokens: 200_000, max_tokens: 64_000 }
    expect(parseUpstreamModelMeta(item, 'anthropic')).toEqual({ context_window: 200_000, max_output: 64_000 })
    expect(parseUpstreamModelMeta(item, 'openai')).toEqual({ context_window: 200_000 })
  })

  it('OpenRouter 风格嵌套 top_provider.max_completion_tokens', () => {
    expect(parseUpstreamModelMeta({ id: 'or', context_length: 128_000, top_provider: { max_completion_tokens: 32_768 } }, 'openai'))
      .toEqual({ context_window: 128_000, max_output: 32_768 })
  })

  it('脏值过滤：0 / 负数 / 浮点 / 字符串 / 超界 / 非对象', () => {
    expect(parseUpstreamModelMeta({ id: 'x', context_window: 0, max_output_tokens: -1 }, 'openai')).toEqual({})
    expect(parseUpstreamModelMeta({ id: 'x', context_window: 999.5 }, 'openai')).toEqual({})
    expect(parseUpstreamModelMeta({ id: 'x', context_window: '200000' }, 'openai')).toEqual({})
    expect(parseUpstreamModelMeta({ id: 'x', context_window: 99_999_999 }, 'openai')).toEqual({})
    expect(parseUpstreamModelMeta({ id: 'x', max_output_tokens: 100 }, 'openai')).toEqual({})
    expect(parseUpstreamModelMeta('not-an-object', 'openai')).toEqual({})
    expect(parseUpstreamModelMeta(null, 'openai')).toEqual({})
  })
})

describe('fetchModelIds（元数据随模型列表带回）', () => {
  it('mock 上游返回自带元数据的列表，逐模型解析进 meta', async () => {
    const h = fakeHome()
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        data: [
          { id: 'm-full', display_name: 'Full', context_window: 131072, max_output_tokens: 8192 },
          { id: 'm-ctx-only', context_length: 262144 },
          { id: 'm-dirty', context_window: 0, max_output_tokens: 'nope' },
        ],
      }))
    })
    try {
      server.listen(0, '127.0.0.1')
      await once(server, 'listening')
      const port = (server.address() as { port: number }).port
      const ref = await setSecret('meta-fetch-test', 'sk-test', 'file')
      const provider: ProviderConfig = {
        name: 't',
        base_url: `http://127.0.0.1:${port}/v1`,
        protocol: 'openai',
        auth_style: 'bearer',
        key_ref: ref,
        proxy: 'direct',
      }
      const f = await fetchModelIds(provider)
      expect(f.ids).toEqual(['m-full', 'm-ctx-only', 'm-dirty'])
      expect(f.meta['m-full']).toEqual({ context_window: 131072, max_output: 8192 })
      expect(f.meta['m-ctx-only']).toEqual({ context_window: 262144 })
      expect(f.meta['m-dirty']).toBeUndefined()
    } finally {
      server.closeAllConnections?.()
      server.close()
      h.restore()
    }
  })
})

describe('resolveModelMeta（分层填充链：配置 > 上游 > 内置表 > 目录）', () => {
  it('配置已有值最优先（只补空、不覆盖）', () => {
    // 能力（vision）随解析链透出：gpt-4o 是内置表里的视觉模型
    expect(resolveModelMeta('gpt-4o', { context_window: 777, max_output: 888, source: 'manual' }))
      .toEqual({ context_window: 777, max_output: 888, capabilities: ['vision'] })
  })

  it('上游返回值盖过内置表', () => {
    expect(resolveModelMeta('gpt-4o', null, { upstream: { context_window: 999_999, max_output: 999_999 } }))
      .toEqual({ context_window: 999_999, max_output: 999_999, capabilities: ['vision'] })
  })

  it('按字段独立下探：配置只填了上下文，最大输出由上游补', () => {
    expect(resolveModelMeta('gpt-4o', { context_window: 555, source: 'manual' }, { upstream: { max_output: 666 } }))
      .toEqual({ context_window: 555, max_output: 666, capabilities: ['vision'] })
  })

  it('内置表兜底（gpt-4o：128K / 16K）', () => {
    expect(resolveModelMeta('gpt-4o')).toEqual({ context_window: 128_000, max_output: 16_384, capabilities: ['vision'] })
  })

  it('目录层兜底（缓存文件）；内置表同 id 优先于目录；四层皆无返回 undefined', () => {
    const h = fakeHome()
    try {
      writeCache(h.home, {
        fetchedAt: new Date().toISOString(),
        providers: {
          testprov: {
            api: null,
            models: {
              'zz-catalog-only': { context_window: 123_456, max_output: 4_096 },
              'gpt-4o': { context_window: 111_111 },
            },
          },
        },
      })
      expect(resolveModelMeta('zz-catalog-only')).toEqual({ context_window: 123_456, max_output: 4_096 })
      expect(resolveModelMeta('gpt-4o')).toEqual({ context_window: 128_000, max_output: 16_384, capabilities: ['vision'] })
      expect(resolveModelMeta('zz-no-such-model-9x')).toBeUndefined()
    } finally {
      h.restore()
      clearCatalogMemo()
    }
  })
})

describe('catalogModelMeta（目录查找：host 匹配优先、字母序确定性兜底）', () => {
  it('baseUrl host 命中厂商 api 地址时优先；未命中按 provider 键字母序首个', () => {
    const h = fakeHome()
    try {
      writeCache(h.home, {
        fetchedAt: new Date().toISOString(),
        providers: {
          zprov: { api: null, models: { 'dual': { context_window: 222_222 } } },
          aprov: { api: 'https://api.alpha.io/v1', models: { 'dual': { context_window: 111_111 }, 'alpha-only': { max_output: 4_096 } } },
        },
      })
      expect(catalogModelMeta('dual', 'https://api.alpha.io/v1/chat/completions')).toEqual({ context_window: 111_111 })
      expect(catalogModelMeta('dual')).toEqual({ context_window: 111_111 })
      expect(catalogModelMeta('dual', 'https://other.example.com/v1')).toEqual({ context_window: 111_111 })
      expect(catalogModelMeta('alpha-only', 'https://other.example.com')).toEqual({ max_output: 4_096 })
    } finally {
      h.restore()
      clearCatalogMemo()
    }
  })
})

describe('normalizeApiCatalog（models.dev api.json 归一化）', () => {
  it('只留通过边界校验的 limit，空厂商/坏条目丢弃，api 字段保留', () => {
    const cat = normalizeApiCatalog(
      {
        goodprov: {
          api: 'https://api.good.io/v1',
          models: {
            m1: { limit: { context: 200_000, output: 64_000 } },
            m2: { limit: { context: 0 } },
            m3: {},
            m4: 'junk',
          },
        },
        emptyprov: { models: { m9: {} } },
        junkprov: 'not-an-object',
      },
      '2026-10-05T00:00:00.000Z'
    )
    expect(Object.keys(cat.providers)).toEqual(['goodprov'])
    expect(cat.providers.goodprov.api).toBe('https://api.good.io/v1')
    expect(cat.providers.goodprov.models.m1).toEqual({ context_window: 200_000, max_output: 64_000 })
    expect(cat.providers.goodprov.models.m2).toBeUndefined()
    expect(cat.providers.goodprov.models.m4).toBeUndefined()
    expect(cat.fetchedAt).toBe('2026-10-05T00:00:00.000Z')
  })
})

describe('refreshCatalog（拉取 + TTL + 停用开关）', () => {
  it('手动拉取写缓存、目录即刻可查；自动模式缓存新鲜期内跳过', async () => {
    const h = fakeHome()
    let hits = 0
    const server = http.createServer((_req, res) => {
      hits++
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        catprov: {
          id: 'catprov',
          api: 'https://api.cat.io',
          models: {
            'cat-model': { limit: { context: 400_000, output: 32_000 } },
            'bad-model': { limit: { context: 'x' } },
          },
        },
      }))
    })
    const prevUrl = process.env.MODELRDOCK_CATALOG_URL
    // vitest singleFork 共享进程 env：其他测试文件顶层设的停用开关会泄漏进来，用例内显式清掉
    const prevDisable = process.env.MODELRDOCK_DISABLE_CATALOG_FETCH
    delete process.env.MODELRDOCK_DISABLE_CATALOG_FETCH
    try {
      server.listen(0, '127.0.0.1')
      await once(server, 'listening')
      const port = (server.address() as { port: number }).port
      process.env.MODELRDOCK_CATALOG_URL = `http://127.0.0.1:${port}/api.json`
      const r = await refreshCatalog({ manual: true })
      expect(r.ok).toBe(true)
      expect(r.providers).toBe(1)
      expect(r.models).toBe(1)
      expect(readCatalogCache()?.providers.catprov.models['cat-model']).toEqual({ context_window: 400_000, max_output: 32_000 })
      expect(catalogModelMeta('cat-model', 'https://api.cat.io/v4')).toEqual({ context_window: 400_000, max_output: 32_000 })
      const r2 = await refreshCatalog({ manual: false })
      expect(r2.skipped).toBe('fresh')
      expect(hits).toBe(1)
    } finally {
      if (prevUrl === undefined) delete process.env.MODELRDOCK_CATALOG_URL
      else process.env.MODELRDOCK_CATALOG_URL = prevUrl
      if (prevDisable === undefined) delete process.env.MODELRDOCK_DISABLE_CATALOG_FETCH
      else process.env.MODELRDOCK_DISABLE_CATALOG_FETCH = prevDisable
      server.closeAllConnections?.()
      server.close()
      h.restore()
      clearCatalogMemo()
    }
  })

  it('MODELRDOCK_DISABLE_CATALOG_FETCH=1 时跳过且不写缓存', async () => {
    const h = fakeHome()
    const prev = process.env.MODELRDOCK_DISABLE_CATALOG_FETCH
    process.env.MODELRDOCK_DISABLE_CATALOG_FETCH = '1'
    try {
      const r = await refreshCatalog({ manual: true })
      expect(r.ok).toBe(false)
      expect(r.skipped).toBe('disabled')
      expect(readCatalogCache()).toBeUndefined()
    } finally {
      if (prev === undefined) delete process.env.MODELRDOCK_DISABLE_CATALOG_FETCH
      else process.env.MODELRDOCK_DISABLE_CATALOG_FETCH = prev
      h.restore()
      clearCatalogMemo()
    }
  })

  it('拉取失败静默返回 error，不抛出、不写缓存', async () => {
    const h = fakeHome()
    const prevUrl = process.env.MODELRDOCK_CATALOG_URL
    // 同上：清掉其他测试文件泄漏的停用开关，确保真的发起连接
    const prevDisable = process.env.MODELRDOCK_DISABLE_CATALOG_FETCH
    delete process.env.MODELRDOCK_DISABLE_CATALOG_FETCH
    try {
      // 1 号端口保留端口（不可连接），连接立即被拒
      process.env.MODELRDOCK_CATALOG_URL = 'http://127.0.0.1:1/api.json'
      const r = await refreshCatalog({ manual: true })
      expect(r.ok).toBe(false)
      expect(r.error).toBeTruthy()
      expect(readCatalogCache()).toBeUndefined()
    } finally {
      if (prevUrl === undefined) delete process.env.MODELRDOCK_CATALOG_URL
      else process.env.MODELRDOCK_CATALOG_URL = prevUrl
      if (prevDisable === undefined) delete process.env.MODELRDOCK_DISABLE_CATALOG_FETCH
      else process.env.MODELRDOCK_DISABLE_CATALOG_FETCH = prevDisable
      h.restore()
      clearCatalogMemo()
    }
  })
})

describe('fullKnownTable（内置表 ∪ 目录，内置优先）', () => {
  it('含内置表条目与目录条目；同 id 内置胜出', () => {
    const h = fakeHome()
    try {
      writeCache(h.home, {
        fetchedAt: new Date().toISOString(),
        providers: {
          testprov: {
            api: null,
            models: {
              'zz-table-only': { context_window: 123_456 },
              'gpt-4o': { context_window: 111_111 },
            },
          },
        },
      })
      const table = fullKnownTable()
      expect(table['gpt-4o']).toEqual({ context_window: 128_000, max_output: 16_384, capabilities: ['vision'] })
      expect(table['zz-table-only']).toEqual({ context_window: 123_456 })
      expect(Object.keys(table).length).toBeGreaterThan(100)
    } finally {
      h.restore()
      clearCatalogMemo()
    }
  })
})

describe('VISION_ID_RE 词边界（BUG-13：envision/revision 不再误判视觉）', () => {
  it('envision-xx / revision-xx 类不带词边界的 id 不判视觉；既有整段 vision/vl 语义 id 仍命中', () => {
    // 裸 /vision/i 会让 envision/revision 误命中；新正则要求 [-_.] 词边界或开头整段匹配
    expect(knownModelMeta('envision-xx')).toBeUndefined()
    expect(knownModelMeta('envision-2026')).toBeUndefined()
    expect(knownModelMeta('revision-xx')).toBeUndefined()
    // 真实词边界整段（-vision / -vl- / 开头 vision/vl）仍识别为视觉能力
    expect(knownModelMeta('my-vision-x')?.capabilities).toEqual(['vision'])
    expect(knownModelMeta('qwen-vl-max')?.capabilities).toEqual(['vision'])
    expect(knownModelMeta('deepseek-v4-flash-vision-exp')?.capabilities).toContain('vision')
  })
})

describe('DUP-10：EXTRA 与预设库 BY_ID 无交集，合并目录总数与改前一致', () => {
  it('EXTRA 无一条 id 落在预设库 BY_ID（杜绝人肉双份维护，数字以 preset 为准）', () => {
    const byId = knownByIdTable()
    expect(Object.keys(EXTRA).filter((id) => id in byId)).toEqual([])
  })
  it('合并目录条目总数与 DUP-10 删除重复前一致（删除的 25 条 EXTRA 全在 BY_ID 中，{ ...EXTRA, ...BY_ID } 合并结果不变）', () => {
    // 改前旧 EXTRA 比现在多 25 条，但那些 id 全被预设库 BY_ID 收录；删后合并表条目数不变，仍为 83
    expect(Object.keys(knownMetaTable()).length).toBe(83)
  })
})

describe('能力标记与基名兜底（视觉可选能力）', () => {
  it('日期后缀 / 版本标签变体按基名命中并带出视觉能力；文本模型不带', () => {
    const h = fakeHome()
    try {
      // 变体命中：方舟日期后缀（-260701 / -ga-260731）、-preview 等标签逐级剥离
      expect(baseModelIds('deepseek-v4-flash-ga-260731')).toContain('deepseek-v4-flash')
      expect(knownModelMeta('kimi-k3-260701')?.capabilities).toContain('vision')
      expect(knownModelMeta('doubao-seed-2-1-turbo-260628')?.capabilities).toContain('vision')
      // id 自带视觉语义（vision / -vl-）：表未收录的新变体也能识别
      expect(knownModelMeta('qwen-vl-max')?.capabilities).toEqual(['vision'])
      // 纯文本模型不标视觉；上下文/输出仍照旧解析
      expect(knownModelMeta('deepseek-v4-flash-ga-260731')?.capabilities ?? []).not.toContain('vision')
      expect(knownModelMeta('deepseek-v4-flash-ga-260731')?.context_window).toBe(1_048_576)
      // 解析链透出能力（控制台「视觉」列与适配器声明共用这一处判断）
      expect(resolveModelMeta('kimi-k3-260701')?.capabilities).toContain('vision')
      expect(resolveModelMeta('glm-5-3-flash-260828')?.capabilities).toContain('vision') // 预设自带 TOOLS_REASON_VISION，基名继承
      expect(resolveModelMeta('qwen3-32b-20250429')?.capabilities ?? []).not.toContain('vision') // 纯文本模型不带
    } finally {
      h.restore()
      clearCatalogMemo()
    }
  })
})
