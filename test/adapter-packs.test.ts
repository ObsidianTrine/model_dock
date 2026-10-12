import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { fakeHome } from './helpers.js'
import { atomicWrite, ensureDir } from '../src/util/fsx.js'
import { modeldockDir } from '../src/util/paths.js'
import { packAdapter } from '../src/adapters/packs.js'
import { allAdapters, requireAdapter } from '../src/adapters/registry.js'
import { craftProviderJsonAdapter } from '../src/adapters/provider-json.js'
import { genericAdapter } from '../src/adapters/generic.js'
import { AdapterError, gatewayBaseOpenAI, type AttachOptions } from '../src/adapters/types.js'
import { loadConfig } from '../src/config/store.js'
import type { AdapterPack, Config } from '../src/config/types.js'

const GW_OPTS = (over: Partial<AttachOptions> = {}): AttachOptions =>
  ({ mode: 'gateway', gatewayPort: 18901, token: 'tok-1', ...over }) as AttachOptions

describe('adapter pack（L2 声明式）', () => {
  it('json：upsert 展开模板变量并保留既有键；direct 模式代入真实 key 与上游地址', async () => {
    const h = fakeHome()
    try {
      const target = path.join(h.home, 'fakeapp', 'config.json')
      await ensureDir(path.dirname(target))
      await atomicWrite(target, '{\n  "provider": {\n    "existing": {}\n  }\n}\n', 0o600)
      const cfg = await loadConfig()
      const a = packAdapter('fakeapp', {
        format: 'json',
        config_file: target,
        upsert: { 'provider.modeldock.baseURL': 'http://127.0.0.1:{port}', 'provider.modeldock.apiKey': '{token}' },
      })

      const gw = await a.planAttach(GW_OPTS(), cfg)
      const after = JSON.parse(gw.changes[0]!.after)
      expect(after.provider.modeldock.baseURL).toBe('http://127.0.0.1:18901')
      expect(after.provider.modeldock.apiKey).toBe('tok-1')
      expect(after.provider.existing).toEqual({})

      // direct 模式：变量值换成上游直连值——模板须用 {base_url}/{token} 才能代入（{port} 模板仍写网关端口）
      const dir = await packAdapter('fakeapp-direct', {
        format: 'json',
        config_file: target,
        upsert: { 'provider.modeldock.baseURL': '{base_url}', 'provider.modeldock.apiKey': '{token}' },
      }).planAttach(
        GW_OPTS({
          direct: { base_url: 'https://up.example.com', key: 'sk-real', protocol: 'anthropic' },
        } as Partial<AttachOptions>),
        cfg
      )
      const dAfter = JSON.parse(dir.changes[0]!.after)
      expect(dAfter.provider.modeldock.baseURL).toBe('https://up.example.com')
      expect(dAfter.provider.modeldock.apiKey).toBe('sk-real')
    } finally {
      h.restore()
    }
  })

  it('yaml / toml：按各自格式 upsert，不破坏原文件其余内容', async () => {
    const h = fakeHome()
    try {
      const cfg = await loadConfig()
      const y = path.join(h.home, 'fakey', 'config.yaml')
      await ensureDir(path.dirname(y))
      await atomicWrite(y, 'provider:\n  existing: 1\n', 0o600)
      const ya = packAdapter('fakey', { format: 'yaml', config_file: y, upsert: { 'provider.modeldock.baseURL': '{base_url_openai}' } })
      const yAfter = (await ya.planAttach(GW_OPTS(), cfg)).changes[0]!.after
      expect(yAfter).toContain('existing: 1')
      expect(yAfter).toContain('baseURL: http://127.0.0.1:18901/v1')

      const t = path.join(h.home, 'faket', 'config.toml')
      await ensureDir(path.dirname(t))
      await atomicWrite(t, 'owner = "x"\n', 0o600)
      const ta = packAdapter('faket', { format: 'toml', config_file: t, upsert: { 'provider.modeldock.baseURL': '{base_url}' } })
      const tAfter = (await ta.planAttach(GW_OPTS(), cfg)).changes[0]!.after
      expect(tAfter).toContain('owner = "x"')
      expect(tAfter).toContain('[provider.modeldock]')
      expect(tAfter).toContain('baseURL = "http://127.0.0.1:18901"')
    } finally {
      h.restore()
    }
  })

  it('错误路径：未知模板变量 / 目标文件缺失 / detect key_path 未命中与坏文件 / 加载期校验', async () => {
    const h = fakeHome()
    try {
      const cfg = await loadConfig()
      const target = path.join(h.home, 'fakeapp', 'config.json')
      await ensureDir(path.dirname(target))
      await atomicWrite(target, '{"a": {"b": 1}}\n', 0o600)

      await expect(
        packAdapter('u', { format: 'json', config_file: target, upsert: { 'a.b': '{nope}' } }).planAttach(GW_OPTS(), cfg)
      ).rejects.toThrow('不支持')

      const missing = path.join(h.home, 'nope', 'config.json')
      await expect(
        packAdapter('m', { format: 'json', config_file: missing, upsert: {} }).planAttach(GW_OPTS(), cfg)
      ).rejects.toThrow('不存在')

      const hit = packAdapter('d', { format: 'json', config_file: target, upsert: {}, detect: { key_path: 'a.b' } })
      expect((await hit.detect()).note).toBeUndefined()
      const miss = packAdapter('d2', { format: 'json', config_file: target, upsert: {}, detect: { key_path: 'x.y' } })
      expect((await miss.detect()).note).toContain('未命中')
      const corrupt = path.join(h.home, 'fakeapp', 'bad.json')
      await atomicWrite(corrupt, 'not json {{', 0o600)
      const bad = packAdapter('d3', { format: 'json', config_file: corrupt, upsert: {}, detect: { key_path: 'a.b' } })
      expect((await bad.detect()).note).toContain('解析失败')
      const absent = packAdapter('d4', { format: 'json', config_file: missing, upsert: {} })
      expect((await absent.detect()).installed).toBe(false)

      expect(() => packAdapter('b1', { format: 'xml' as unknown as 'json', config_file: 'x', upsert: {} })).toThrow(AdapterError)
      expect(() => packAdapter('b2', { format: 'json', config_file: '  ', upsert: {} })).toThrow('config_file')
      // 防自我改写：目标文件不允许落进 ModelDock 自己的数据目录
      expect(() => packAdapter('evil', { format: 'json', config_file: path.join(modeldockDir(), 'evil.json'), upsert: {} })).toThrow(
        '数据目录'
      )
    } finally {
      h.restore()
    }
  })

  it('allAdapters：坏 pack 以错误占位呈现（不拖垮列表），requireAdapter 未知 id 给出可用清单', async () => {
    const h = fakeHome()
    try {
      const cfg = await loadConfig()
      cfg.adapter_packs = { bad: { format: 'xml' as unknown as 'json', config_file: 'x', upsert: {} } }
      const list = allAdapters(cfg)
      const bad = list.find((a) => a.id === 'bad')!
      expect(bad.label).toContain('pack 配置错误')
      const st = await bad.status(cfg)
      expect(st.installed).toBe(false)
      expect(st.detail).toBeTruthy()
      await expect(bad.planAttach(GW_OPTS(), cfg)).rejects.toBeInstanceOf(AdapterError)
      expect(list.some((a) => a.id === 'claude-code')).toBe(true)

      await expect(requireAdapter('nosuch', cfg)).rejects.toThrow('未知 harness')
      await expect(requireAdapter('nosuch', cfg)).rejects.toThrow('bad')
    } finally {
      h.restore()
    }
  })
})

describe('provider-json 工厂（声明式 JSON 客户端引擎）', () => {
  function mkAdapter(h: { home: string }) {
    return craftProviderJsonAdapter({
      id: 'fakecli',
      label: 'FakeCLI',
      configFiles: () => [path.join(h.home, '.fakecli', 'config.json')],
    })
  }

  async function seed(h: { home: string }, text: string): Promise<string> {
    const p = path.join(h.home, '.fakecli', 'config.json')
    await ensureDir(path.dirname(p))
    await atomicWrite(p, text, 0o600)
    return p
  }

  it('detect：缺文件未安装 / 有文件报 current / 坏 JSON 标注解析失败', async () => {
    const h = fakeHome()
    try {
      const ad = mkAdapter(h)
      const none = await ad.detect()
      expect(none.installed).toBe(false)
      expect(none.note).toContain('未找到')

      await seed(h, '{"provider":{"other":{"options":{"baseURL":"https://x.example.com"}}}}')
      const ok = await ad.detect()
      expect(ok.installed).toBe(true)
      expect(ok.current).toBe('https://x.example.com')

      await seed(h, '{oops')
      const bad = await ad.detect()
      expect(bad.note).toContain('无法解析')
    } finally {
      h.restore()
    }
  })

  it('planAttach：网关模式写 modeldock provider + token；setDefault 有 default_model 才烤模型', async () => {
    const h = fakeHome()
    try {
      const cfg: Config = await loadConfig()
      const ad = mkAdapter(h)
      await seed(h, '{"provider":{}}')

      const noModel = await ad.planAttach(GW_OPTS({ setDefault: true }), cfg)
      const nAfter = JSON.parse(noModel.changes[0]!.after)
      expect(nAfter.provider.modeldock.options.baseURL).toBe(gatewayBaseOpenAI(18901))
      expect(nAfter.provider.modeldock.options.apiKey).toBe('tok-1')
      expect(nAfter.model).toBeUndefined()
      expect(noModel.notes.join('\n')).toContain('未改动默认模型')

      cfg.profiles['p1'] = { name: 'p1', provider: 'pv', default_model: 'm1' }
      const withModel = await ad.planAttach(GW_OPTS({ setDefault: true, profile: 'p1' }), cfg)
      const wAfter = JSON.parse(withModel.changes[0]!.after)
      expect(wAfter.model).toBe('modeldock/m1')
    } finally {
      h.restore()
    }
  })

  it('planAttach：direct 模式写上游地址与真实 Key；坏 JSON 中止不动盘', async () => {
    const h = fakeHome()
    try {
      const cfg = await loadConfig()
      const ad = mkAdapter(h)
      await seed(h, '{"provider":{}}')
      const dir = await ad.planAttach(
        GW_OPTS({ direct: { base_url: 'https://up.example.com', key: 'sk-9', protocol: 'anthropic' } } as Partial<AttachOptions>),
        cfg
      )
      const dAfter = JSON.parse(dir.changes[0]!.after)
      expect(dAfter.provider.modeldock.options.baseURL).toBe('https://up.example.com')
      expect(dAfter.provider.modeldock.options.apiKey).toBe('sk-9')
      expect(dir.writtenBaseUrl).toBe('https://up.example.com')

      const badPath = await seed(h, '{oops')
      await expect(ad.planAttach(GW_OPTS(), cfg)).rejects.toThrow('无法解析为 JSON')
      expect(fs.readFileSync(badPath, 'utf8')).toBe('{oops')
    } finally {
      h.restore()
    }
  })

  it('planDetach：ours 移除 modeldock 条目与 modeldock/ 模型前缀；not ours 不动；status 按 baseURL 判指向', async () => {
    const h = fakeHome()
    try {
      const cfg = await loadConfig()
      const ad = mkAdapter(h)
      const p = await seed(
        h,
        JSON.stringify({ model: 'modeldock/m1', provider: { modeldock: { options: { baseURL: gatewayBaseOpenAI(18901), apiKey: 'tok' } }, keep: {} } })
      )
      const det = await ad.planDetach(cfg)
      const after = JSON.parse(det.changes[0]!.after)
      expect(after.provider.modeldock).toBeUndefined()
      expect(after.provider.keep).toEqual({})
      expect(after.model).toBeUndefined()

      await seed(h, JSON.stringify({ provider: { modeldock: { options: { baseURL: 'https://else.example.com' } } } }))
      const notOurs = await ad.planDetach(cfg)
      expect(notOurs.changes).toHaveLength(0)
      expect(notOurs.notes.join()).toContain('无需改动')

      await seed(h, JSON.stringify({ provider: { modeldock: { options: { baseURL: gatewayBaseOpenAI(18901) } } } }))
      expect((await ad.status(cfg, 18901)).pointing).toBe('gateway')
      await seed(h, JSON.stringify({ provider: { modeldock: { options: { baseURL: 'http://127.0.0.1:19999/v1' } } } }))
      expect((await ad.status(cfg, 18901)).pointing).toBe('other')
      await seed(h, '{"provider":{}}')
      const st = await ad.status(cfg, 18901)
      expect(st.pointing).toBe('unknown')
      expect(st.detail).toContain('未注册')
      expect(fs.existsSync(p)).toBe(true)
    } finally {
      h.restore()
    }
  })
})

describe('generic-env 兜底适配器', () => {
  it('不写任何文件；status 随 harness 登记翻转', async () => {
    const h = fakeHome()
    try {
      const cfg = await loadConfig()
      const det = await genericAdapter.detect()
      expect(det.installed).toBe(true)

      const plan = await genericAdapter.planAttach(GW_OPTS(), cfg)
      expect(plan.changes).toHaveLength(0)
      expect(plan.notes.join()).toContain('环境变量')

      const st0 = await genericAdapter.status(cfg)
      expect(st0.attached).toBe(false)
      cfg.harness['generic-env'] = { mode: 'gateway', token: 'tok' }
      const st1 = await genericAdapter.status(cfg)
      expect(st1.attached).toBe(true)
      expect(st1.pointing).toBe('gateway')
    } finally {
      h.restore()
    }
  })
})
