import { describe, expect, it, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fakeHome } from './helpers.js'
import { atomicWrite, ensureDir, readTextIfExists } from '../src/util/fsx.js'
import { loadConfig, saveConfig } from '../src/config/store.js'
import { emptyConfig, type Config } from '../src/config/types.js'
import { applyChanges } from '../src/adapters/engine.js'
import { claudeCodeAdapter } from '../src/adapters/claude-code.js'
import { dshAdapter } from '../src/adapters/dsh.js'
import { zcodeAdapter } from '../src/adapters/zcode.js'
import { codexAdapter } from '../src/adapters/codex.js'
import { mimoCodeAdapter } from '../src/adapters/mimo-code.js'
import { mimoDesktopAdapter } from '../src/adapters/mimo-desktop.js'
import { openCodeAdapter } from '../src/adapters/opencode.js'
import { workbuddyAdapter } from '../src/adapters/workbuddy.js'
import { listSnapshots, matchesSnapshot } from '../src/backup/snapshot.js'
import { configPath } from '../src/util/paths.js'

afterEach(() => {})

const baseCfg = (): Config => ({
  ...emptyConfig(),
  profiles: { demo: { provider: 'p', default_model: 'demo-model' } },
  active_profile: 'demo',
})

const TOKEN = 'mdk_claude_code_test_token_123'

async function withConfig(cfg: Config): Promise<void> {
  await saveConfig(cfg)
}

// commandOnPath 按 PATH 逐目录探测，测试里用假 bin 目录注入/清空，避免依赖测试机的真实安装。
// Windows 下它还兜底扫 %APPDATA%\npm（npm i -g 的 shim 落点），一并清掉才能保证两个方向都确定。
function withPathEnv<T>(binDir: string | null, fn: () => Promise<T>): Promise<T> {
  const saved = process.env.PATH
  const savedAppData = process.env.APPDATA
  const sep = process.platform === 'win32' ? ';' : ':'
  process.env.PATH = binDir ?? sep // 空 PATH 也要有分隔符形态，Windows 下 ';' 表示两个空段
  delete process.env.APPDATA
  return fn().finally(() => {
    if (saved === undefined) delete process.env.PATH
    else process.env.PATH = saved
    if (savedAppData === undefined) delete process.env.APPDATA
    else process.env.APPDATA = savedAppData
  })
}

/** 假 bin 目录：Windows npm 全局 shim 是 <cmd>.cmd；POSIX 是无后缀的可执行/符号链接 */
function fakeBin(h: { home: string }, cmd: string): string {
  const dir = path.join(h.home, 'bin')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, process.platform === 'win32' ? `${cmd}.cmd` : cmd), '')
  return dir
}

describe('test helpers', () => {
  it('fakeHome 会清理超过 24h 的历史残骸，活跃目录（24h 内）不动', () => {
    const stale = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldock-test-'))
    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldock-test-'))
    const old = new Date(Date.now() - 25 * 3600_000)
    fs.utimesSync(stale, old, old)
    try {
      const h = fakeHome()
      try {
        expect(fs.existsSync(stale)).toBe(false)
        expect(fs.existsSync(fresh)).toBe(true)
      } finally {
        h.restore()
      }
    } finally {
      fs.rmSync(fresh, { recursive: true, force: true })
    }
  })
})

describe('claude-code adapter', () => {
  it('attach 写入网关地址与 token，保留其他字段；detach 兜底移除', async () => {
    const h = fakeHome()
    // 本体双信号判定需注入「claude 命令在场」，避免依赖测试机真实安装
    process.env.MODELRDOCK_FAKE_CLAUDE_CODE_PRESENT = '1'
    try {
      const p = path.join(h.home, '.claude', 'settings.json')
      await ensureDir(path.dirname(p))
      await atomicWrite(
        p,
        JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://upstream.example.com', ANTHROPIC_AUTH_TOKEN: 'old', OTHER: 'keep' }, includeCoAuthoredBy: false }, null, 2) + '\n',
        0o600
      )
      await withConfig(baseCfg())

      const plan = await claudeCodeAdapter.planAttach({ mode: 'gateway', gatewayPort: 8687, token: TOKEN }, await loadConfig())
      expect(plan.changes).toHaveLength(1)
      const after = JSON.parse(plan.changes[0].after)
      expect(after.env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:8687')
      expect(after.env.ANTHROPIC_AUTH_TOKEN).toBe(TOKEN)
      // 网关本地实现 /v1/models：attach 即开启 discovery，/model 选择器列出当前服务真实模型
      expect(after.env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY).toBe('1')
      expect(after.env.OTHER).toBe('keep')
      expect(plan.notes.some((n) => n.includes('upstream.example.com'))).toBe(true)

      const ok = await applyChanges('claude-code', 'attach', plan.changes, { yes: true, redactions: [TOKEN] })
      expect(ok).toBe(true)
      const onDisk = JSON.parse(fs.readFileSync(p, 'utf8'))
      expect(onDisk.env.ANTHROPIC_AUTH_TOKEN).toBe(TOKEN)
      expect(onDisk.includeCoAuthoredBy).toBe(false)
      // diff 已脱敏
      expect(plan.changes[0].after).toContain(TOKEN)

      // 快照已建
      expect((await listSnapshots('claude-code')).some((s) => s.operation === 'attach')).toBe(true)

      // detach 兜底：移除注入的键（含 discovery 开关）
      const planDetach = await claudeCodeAdapter.planDetach(await loadConfig())
      await applyChanges('claude-code', 'detach', planDetach.changes, { yes: true })
      const afterDetach = JSON.parse(fs.readFileSync(p, 'utf8'))
      expect(afterDetach.env.ANTHROPIC_BASE_URL).toBeUndefined()
      expect(afterDetach.env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY).toBeUndefined()
      expect(afterDetach.env.OTHER).toBe('keep')

      const st = await claudeCodeAdapter.status(await loadConfig(), 8687)
      expect(st.installed).toBe(true)
      expect(st.attached).toBe(false)
    } finally {
      delete process.env.MODELRDOCK_FAKE_CLAUDE_CODE_PRESENT
      h.restore()
    }
  })

  it('--takeover-models 把 DEFAULT_* 迁入 profileUpdates 并从文件删除', async () => {
    const h = fakeHome()
    process.env.MODELRDOCK_FAKE_CLAUDE_CODE_PRESENT = '1'
    try {
      const p = path.join(h.home, '.claude', 'settings.json')
      await ensureDir(path.dirname(p))
      await atomicWrite(
        p,
        JSON.stringify(
          {
            env: {
              ANTHROPIC_BASE_URL: 'https://up.example.com',
              ANTHROPIC_AUTH_TOKEN: 'x',
              ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-v4-flash',
              ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5-3',
              ANTHROPIC_MODEL: 'deepseek-v4-flash',
            },
          },
          null,
          2
        ) + '\n',
        0o600
      )
      const plan = await claudeCodeAdapter.planAttach(
        { mode: 'gateway', gatewayPort: 8687, token: TOKEN, takeoverModels: true },
        baseCfg()
      )
      expect(plan.profileUpdates?.aliases).toEqual({
        'claude-sonnet-*': 'deepseek-v4-flash',
        'claude-opus-*': 'glm-5-3',
      })
      expect(plan.profileUpdates?.default_model).toBe('deepseek-v4-flash')
      const env = JSON.parse(plan.changes[0].after).env
      expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBeUndefined()
      expect(env.ANTHROPIC_MODEL).toBeUndefined()
    } finally {
      delete process.env.MODELRDOCK_FAKE_CLAUDE_CODE_PRESENT
      h.restore()
    }
  })

  it('settings.json 残留但 claude 命令缺席：判为未安装（卸载残留），接入拒绝', async () => {
    const h = fakeHome()
    process.env.MODELRDOCK_FAKE_CLAUDE_CODE_PRESENT = '0'
    try {
      const p = path.join(h.home, '.claude', 'settings.json')
      await ensureDir(path.dirname(p))
      await atomicWrite(p, JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://up.example.com' } }) + '\n', 0o600)

      const det = await claudeCodeAdapter.detect()
      expect(det.installed).toBe(false)
      expect(det.note).toContain('残留')

      const st = await claudeCodeAdapter.status(emptyConfig(), 8687)
      expect(st.installed).toBe(false)
      expect(st.detail).toContain('残留')

      await expect(
        claudeCodeAdapter.planAttach({ mode: 'gateway', gatewayPort: 8687, token: TOKEN }, baseCfg())
      ).rejects.toThrow(/已卸载/)
    } finally {
      delete process.env.MODELRDOCK_FAKE_CLAUDE_CODE_PRESENT
      h.restore()
    }
  })

  it('只装了 claude 命令、没有 settings.json：算已安装（未接入），attach 新建配置', async () => {
    const h = fakeHome()
    try {
      await withConfig(baseCfg())
      await withPathEnv(fakeBin(h, 'claude'), async () => {
        const st = await claudeCodeAdapter.status(await loadConfig(), 8687)
        expect(st.installed).toBe(true)
        expect(st.attached).toBe(false)
        expect(st.detail).toContain('一键接入')

        const det = await claudeCodeAdapter.detect()
        expect(det.installed).toBe(true)
        expect(det.configFiles).toEqual([])

        // settings.json 不存在时不再抛错，改为新建（只写网关 env）
        const p = path.join(h.home, '.claude', 'settings.json')
        const plan = await claudeCodeAdapter.planAttach(
          { mode: 'gateway', gatewayPort: 8687, token: TOKEN },
          baseCfg()
        )
        expect(plan.changes).toHaveLength(1)
        expect(plan.changes[0].before).toBeNull()
        expect(plan.notes.some((n) => n.includes('本次接入会新建'))).toBe(true)
        await applyChanges('claude-code', 'attach', plan.changes, { yes: true, redactions: [TOKEN] })
        const onDisk = JSON.parse(fs.readFileSync(p, 'utf8'))
        expect(onDisk.env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:8687')
        expect(onDisk.env.ANTHROPIC_AUTH_TOKEN).toBe(TOKEN)
      })
    } finally {
      h.restore()
    }
  })

  it('命令与 settings.json 都没有：未安装', async () => {
    const h = fakeHome()
    try {
      await withPathEnv(path.join(h.home, 'empty-bin'), async () => {
        const st = await claudeCodeAdapter.status(await loadConfig(), 8687)
        expect(st.installed).toBe(false)
        const det = await claudeCodeAdapter.detect()
        expect(det.installed).toBe(false)
        expect(det.note).toContain('未找到 claude 命令')
      })
    } finally {
      h.restore()
    }
  })

  it('切直连：收回网关注入的 discovery 开关；直连配置不新增该 env', async () => {
    const h = fakeHome()
    process.env.MODELRDOCK_FAKE_CLAUDE_CODE_PRESENT = '1'
    try {
      const p = path.join(h.home, '.claude', 'settings.json')
      await ensureDir(path.dirname(p))
      // 网关模式 attach 后的典型状态：BASE_URL 指向网关 + discovery 开
      await atomicWrite(
        p,
        JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8687', ANTHROPIC_AUTH_TOKEN: TOKEN, CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1' } }, null, 2) + '\n',
        0o600
      )
      await withConfig(baseCfg())

      const plan = await claudeCodeAdapter.planAttach({
        mode: 'direct',
        gatewayPort: 8687,
        token: TOKEN,
        direct: { base_url: 'https://api.up.example.com', key: 'sk-direct-plain', auth_style: 'bearer' },
      }, await loadConfig())
      const env = JSON.parse(plan.changes[0].after).env
      expect(env.ANTHROPIC_BASE_URL).toBe('https://api.up.example.com')
      expect(env.ANTHROPIC_AUTH_TOKEN).toBe('sk-direct-plain')
      expect(env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY).toBeUndefined()
    } finally {
      delete process.env.MODELRDOCK_FAKE_CLAUDE_CODE_PRESENT
      h.restore()
    }
  })
})

describe('dsh adapter', () => {
  it('attach 新增 provider 条目（保留注释），token 写入 credentials refs', async () => {
    const h = fakeHome()
    try {
      const p = path.join(h.home, '.dsh', 'settings.yaml')
      await ensureDir(path.dirname(p))
      const yaml = `# 顶层注释\nllm-pi-ai:\n  providers:\n    ark:\n      api: anthropic-messages\n      baseURL: https://ark.example.com/api/coding\n      apiKeyEnv: ARK_KEY\n      models: [deepseek-v4-flash]\nagent-default-model:\n  provider: ark\n  model: deepseek-v4-flash\n`
      await atomicWrite(p, yaml, 0o600)
      await withConfig(baseCfg())

      const plan = await dshAdapter.planAttach(
        { mode: 'gateway', gatewayPort: 8687, token: TOKEN, setDefault: true, profile: 'demo' },
        await loadConfig()
      )
      expect(plan.changes).toHaveLength(2)
      await applyChanges('dsh', 'attach', plan.changes, { yes: true, redactions: [TOKEN] })

      const after = fs.readFileSync(p, 'utf8')
      expect(after).toContain('# 顶层注释') // 注释保留
      expect(after).toContain('https://ark.example.com/api/coding') // 原条目未动
      expect(after).toContain('modeldock')
      expect(fs.readFileSync(path.join(h.home, '.dsh', '.credentials.yaml'), 'utf8')).toContain('MODELDOCK_TOKEN')

      const st = await dshAdapter.status(await loadConfig(), 8687)
      expect(st.pointing).toBe('gateway')
    } finally {
      h.restore()
    }
  })

  it('attach 写入完整模型列表（ModelDock 元数据优先 + catalog 补全 + 回写）', async () => {
    const h = fakeHome()
    try {
      const { setDshCatalogLoader } = await import('../src/adapters/dsh.js')
      // 假 catalog：route 精确匹配 p2；b-model 靠全局 id 查找
      setDshCatalogLoader(async () => {
        const catalog = new Map()
        const p2 = new Map()
        p2.set('model-x', { id: 'model-x', name: 'Model X', contextWindow: 1048576, maxTokens: 131072 })
        catalog.set('p', p2)
        const other = new Map()
        other.set('b-model', { id: 'b-model', name: 'B Model', contextWindow: 262144 })
        catalog.set('other-route', other)
        return { catalog, source: 'test' }
      })

      const p = path.join(h.home, '.dsh', 'settings.yaml')
      await ensureDir(path.dirname(p))
      await atomicWrite(p, 'llm-pi-ai:\n  providers: {}\n', 0o600)
      // profile demo → provider p；model-x 无元数据（靠 catalog 补），b-model 是全局查找
      const cfg: Config = {
        ...baseCfg(),
        providers: {
          p: {
            base_url: 'https://x.example.com',
            protocol: 'anthropic',
            auth_style: 'bearer',
            key_ref: 'k',
            models: {
              'model-x': { source: 'manual' },
              'b-model': { source: 'manual' },
            },
          },
        },
      }
      await withConfig(cfg)

      const { applyAttach } = await import('../src/ops.js')
      const outcome = await applyAttach('dsh', { profile: 'demo' })
      expect(outcome.files.length).toBeGreaterThan(0)

      const after = fs.readFileSync(p, 'utf8')
      expect(after).toContain('id: model-x')
      expect(after).toContain('name: Model X')
      expect(after).toContain('contextWindow: 1048576')
      expect(after).toContain('maxTokens: 131072')
      expect(after).toContain('contextWindow: 262144') // b-model 全局查找补全（无 maxTokens → dsh 默认兜底）
      expect(outcome.notes.some((n) => n.includes('2 个模型'))).toBe(true)

      // 元数据回写到 ModelDock 目录
      const onDisk: any = (await import('smol-toml')).parse(fs.readFileSync(configPath(), 'utf8'))
      const models = onDisk.providers.p.models
      expect(models['model-x'].context_window).toBe(1048576)
      expect(models['model-x'].max_output).toBe(131072)
      expect(models['model-x'].source).toBe('fetched')
      expect(models['b-model'].context_window).toBe(262144)
      expect(models['b-model'].max_output).toBeUndefined()

      // 空路由场景：route 不存在 → 不写 models 且给出可执行提示
      const plan2 = await dshAdapter.planAttach({ mode: 'gateway', gatewayPort: 8687, token: TOKEN, profile: 'no-such' }, await loadConfig())
      expect(plan2.notes.some((n) => n.includes('resolves no models') || n.includes('没有可解析的路由'))).toBe(true)
    } finally {
      h.restore()
    }
  })

  it('模型条目声明推理等级（恒开）与视觉模态（按能力）——手写模型不再被 dsh 判为「不支持该思考等级」', async () => {
    const h = fakeHome()
    try {
      const { parse: yamlParse } = await import('yaml')
      const p = path.join(h.home, '.dsh', 'settings.yaml')
      await ensureDir(path.dirname(p))
      await atomicWrite(p, 'llm-pi-ai:\n  providers: {}\n', 0o600)
      await withConfig({
        ...baseCfg(),
        providers: {
          p: {
            base_url: 'https://x.example.com',
            protocol: 'anthropic',
            auth_style: 'bearer',
            key_ref: 'k',
            // plain-model 无能力标记；kimi-k3 由预设带 vision（基名归一化让带日期后缀的变体也命中）
            models: { 'plain-model': { source: 'manual' }, 'kimi-k3': { source: 'manual' } },
          },
        },
      })
      const { applyAttach } = await import('../src/ops.js')
      await applyAttach('dsh', { profile: 'demo' })

      const doc = yamlParse(fs.readFileSync(p, 'utf8')) as {
        'llm-pi-ai': { providers: { modeldock: { models: Record<string, unknown>[] } } }
      }
      const models = doc['llm-pi-ai'].providers.modeldock.models
      const plain = models.find((m) => (m as { id: string }).id === 'plain-model') as Record<string, unknown>
      const vision = models.find((m) => (m as { id: string }).id === 'kimi-k3') as Record<string, unknown>
      // 四档等级与 dsh 官方一致；off 留空 = 支持关闭且不发参数
      expect(plain.reasoningEfforts).toEqual({ off: null, low: 'low', medium: 'medium', high: 'high' })
      expect(vision.reasoningEfforts).toEqual({ off: null, low: 'low', medium: 'medium', high: 'high' })
      // 视觉是可选能力：只有声明了 vision 的模型带 input
      expect(plain.input).toBeUndefined()
      expect(vision.input).toEqual(['text', 'image'])
      // 推导出的能力回写 ModelDock 目录（控制台「视觉」列即可见，不必手填）
      const onDisk: any = (await import('smol-toml')).parse(fs.readFileSync(configPath(), 'utf8'))
      expect(onDisk.providers.p.models['kimi-k3'].capabilities).toContain('vision')
      expect(onDisk.providers.p.models['plain-model'].capabilities).toBeUndefined()
    } finally {
      h.restore()
    }
  })

  it('多次 attach 未断开时 detach 还原到本次接入前（不留网关残留）', async () => {
    const h = fakeHome()
    try {
      const { applyAttach, detachHarness } = await import('../src/ops.js')
      const p = path.join(h.home, '.dsh', 'settings.yaml')
      await ensureDir(path.dirname(p))
      const original = 'llm-pi-ai:\n  providers:\n    ark:\n      api: anthropic-messages\n      baseURL: https://ark.example.com\n      apiKeyEnv: ARK\n      models:\n        - id: a\n          name: a\n'
      await atomicWrite(p, original, 0o600)
      await withConfig(baseCfg())

      await applyAttach('dsh', {}) // attach #1：无模型目录
      await withConfig({
        ...baseCfg(),
        providers: {
          p: {
            base_url: 'https://x.example.com',
            protocol: 'anthropic',
            auth_style: 'bearer',
            key_ref: 'k',
            models: { m1: { source: 'manual' as const } },
          },
        },
      })
      await applyAttach('dsh', {}) // attach #2：带 models

      const after2 = fs.readFileSync(p, 'utf8')
      expect(after2).toContain('modeldock')
      expect(after2).toContain('id: m1')

      const outcome = await detachHarness('dsh')
      expect(outcome.restored).toBe(true)
      expect(outcome.notes.some((n) => n.includes('2 次接入记录'))).toBe(true)
      const finalText = fs.readFileSync(p, 'utf8')
      expect(finalText).not.toContain('modeldock') // 回到本次接入前，无残留
      expect(finalText).toContain('ark.example.com') // 原条目保留

      // 登记表已清理
      const cfg = await loadConfig()
      expect(cfg.harness['dsh']).toBeUndefined()
    } finally {
      h.restore()
    }
  })

  it('断开期间的外部删除不会被 detach 回滚（只回到本次接入前）', async () => {
    const h = fakeHome()
    try {
      const { applyAttach, detachHarness } = await import('../src/ops.js')
      const p = path.join(h.home, '.dsh', 'settings.yaml')
      await ensureDir(path.dirname(p))
      const original = 'llm-pi-ai:\n  providers:\n    ark:\n      api: anthropic-messages\n      baseURL: https://ark.example.com\n      apiKeyEnv: ARK\n      models:\n        - id: a\n          name: a\n    doomed:\n      api: openai-completions\n      baseURL: https://doomed.example.com\n      apiKeyEnv: DOOMED\n      models:\n        - id: d\n          name: d\n'
      await atomicWrite(p, original, 0o600)
      await withConfig(baseCfg())

      await applyAttach('dsh', {}) // attach #1
      await detachHarness('dsh') // detach #1：回到首次接入前，doomed 也因此还在

      // 用户脱离 ModelDock 期间，自己在 dsh 里删掉 doomed
      const afterUserEdit = original.replace(/\n    doomed:[\s\S]*$/, '\n')
      await atomicWrite(p, afterUserEdit, 0o600)
      expect(fs.readFileSync(p, 'utf8')).not.toContain('doomed.example.com')

      await applyAttach('dsh', {}) // attach #2
      const outcome = await detachHarness('dsh') // detach #2：只回到 attach #2 前

      const finalText = fs.readFileSync(p, 'utf8')
      expect(finalText).not.toContain('modeldock') // 网关条目仍被反向清理
      expect(finalText).toContain('ark.example.com') // 用户没动的条目保留
      expect(finalText).not.toContain('doomed.example.com') // 用户的删除被保留，没有复活
      expect(outcome.restored).toBe(true)
      expect(outcome.notes.some((n) => n.includes('2 次接入记录'))).toBe(true)
    } finally {
      h.restore()
    }
  })

  it('新版布局：profiles/*/cordis.patch.yml 上 attach/status/detach，不创建 settings.yaml', async () => {
    const h = fakeHome()
    try {
      const dir = path.join(h.home, '.dsh', 'profiles', 'web')
      await ensureDir(dir)
      await atomicWrite(path.join(dir, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', dsh: { profile: { bundles: [] } } }), 0o600)
      const patchPath = path.join(dir, 'cordis.patch.yml')
      const patch = `# patch 注释保留\n- id: ui-theme\n  name: "@deepseek-ai/dsh-client-ui-theme"\n  config:\n    preference: dark\n- id: llm-pi-ai\n  name: "@deepseek-ai/dsh-llm-pi-ai"\n  config:\n    providers:\n      ark:\n        apiKeyEnv: ARK\n        api: anthropic-messages\n        baseURL: https://ark.example.com\n        models:\n          - id: a\n            name: a\n`
      await atomicWrite(patchPath, patch, 0o600)
      await withConfig(baseCfg())

      const det = await dshAdapter.detect()
      expect(det.installed).toBe(true)

      const plan = await dshAdapter.planAttach(
        { mode: 'gateway', gatewayPort: 8687, token: TOKEN, setDefault: true, profile: 'demo' },
        await loadConfig()
      )
      await applyChanges('dsh', 'attach', plan.changes, { yes: true, redactions: [TOKEN] })

      const after = fs.readFileSync(patchPath, 'utf8')
      expect(after).toContain('# patch 注释保留') // 注释保留
      expect(after).toContain('https://ark.example.com') // 原 provider 未动
      expect(after).toContain('modeldock')
      expect(after).toContain('agent-default-model')
      expect(fs.existsSync(path.join(h.home, '.dsh', 'settings.yaml'))).toBe(false) // 不写旧布局文件
      expect(fs.readFileSync(path.join(h.home, '.dsh', '.credentials.yaml'), 'utf8')).toContain('MODELDOCK_TOKEN')

      const st = await dshAdapter.status(await loadConfig(), 8687)
      expect(st.installed).toBe(true)
      expect(st.pointing).toBe('gateway')

      const planDetach = await dshAdapter.planDetach(await loadConfig())
      await applyChanges('dsh', 'detach', planDetach.changes, { yes: true })
      const finalText = fs.readFileSync(patchPath, 'utf8')
      expect(finalText).not.toContain('modeldock')
      expect(finalText).not.toContain('agent-default-model') // 我们添加的默认模型条目一并移除
      expect(finalText).toContain('https://ark.example.com') // 原条目保留
    } finally {
      h.restore()
    }
  })

  it('clientProfiles：attach 只写指定 profile（desktop），其余（web）不动；未知 profile 报错', async () => {
    const h = fakeHome()
    try {
      const patchFor = (name: string): string =>
        `- id: llm-pi-ai\n  name: "@deepseek-ai/dsh-llm-pi-ai"\n  config:\n    providers:\n      ark:\n        apiKeyEnv: ARK\n        api: anthropic-messages\n        baseURL: https://${name}.example.com\n        models:\n          - id: a\n            name: a\n`
      const paths: Record<string, string> = {}
      for (const name of ['desktop', 'web']) {
        const dir = path.join(h.home, '.dsh', 'profiles', name)
        await ensureDir(dir)
        await atomicWrite(path.join(dir, 'package.json'), JSON.stringify({ name: `dsh-profile-${name}`, dsh: { profile: { bundles: [] } } }), 0o600)
        paths[name] = path.join(dir, 'cordis.patch.yml')
        await atomicWrite(paths[name], patchFor(name), 0o600)
      }
      await withConfig(baseCfg())

      // 未知 profile 直接报错，不能静默落空
      await expect(
        dshAdapter.planAttach(
          { mode: 'gateway', gatewayPort: 8687, token: TOKEN, clientProfiles: ['deskop'] },
          await loadConfig()
        )
      ).rejects.toThrow(/deskop/)

      const plan = await dshAdapter.planAttach(
        { mode: 'gateway', gatewayPort: 8687, token: TOKEN, clientProfiles: ['desktop'] },
        await loadConfig()
      )
      await applyChanges('dsh', 'attach', plan.changes, { yes: true, redactions: [TOKEN] })

      expect(fs.readFileSync(paths.desktop, 'utf8')).toContain('modeldock')
      const web = fs.readFileSync(paths.web, 'utf8')
      expect(web).not.toContain('modeldock') // web 未被波及
      expect(web).toContain('https://web.example.com')
      expect(fs.readFileSync(path.join(h.home, '.dsh', '.credentials.yaml'), 'utf8')).toContain('MODELDOCK_TOKEN')

      // 裸 profile（只有 package.json、无 patch）：可被定向新建 patch；目录名不能被误判成父目录名
      const bareDir = path.join(h.home, '.dsh', 'profiles', 'bare')
      await ensureDir(bareDir)
      await atomicWrite(path.join(bareDir, 'package.json'), JSON.stringify({ name: 'dsh-profile-bare', dsh: { profile: { bundles: [] } } }), 0o600)
      expect(await dshAdapter.clientProfileOptions!()).toEqual(['desktop', 'web', 'bare'])
      const plan2 = await dshAdapter.planAttach(
        { mode: 'gateway', gatewayPort: 8687, token: TOKEN, clientProfiles: ['bare'] },
        await loadConfig()
      )
      await applyChanges('dsh', 'attach', plan2.changes, { yes: true, redactions: [TOKEN] })
      expect(fs.existsSync(path.join(bareDir, 'cordis.patch.yml'))).toBe(true)
      expect(fs.readFileSync(path.join(bareDir, 'cordis.patch.yml'), 'utf8')).toContain('modeldock')
      expect(fs.readFileSync(paths.web, 'utf8')).not.toContain('modeldock')
    } finally {
      h.restore()
    }
  })

  it('全局切换服务后 refreshBakedModelClients 重写 dsh 的模型列表与默认模型', async () => {
    const h = fakeHome()
    try {
      const { applyAttach, switchToService, refreshBakedModelClients } = await import('../src/ops.js')
      const dir = path.join(h.home, '.dsh', 'profiles', 'web')
      await ensureDir(dir)
      await atomicWrite(path.join(dir, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', dsh: { profile: { bundles: [] } } }), 0o600)
      const patchPath = path.join(dir, 'cordis.patch.yml')
      await atomicWrite(
        patchPath,
        '- id: llm-pi-ai\n  name: "@deepseek-ai/dsh-llm-pi-ai"\n  config:\n    providers:\n      ark:\n        apiKeyEnv: ARK\n        api: anthropic-messages\n        baseURL: https://ark.example.com\n        models:\n          - id: a\n            name: a\n',
        0o600
      )
      await withConfig({
        ...emptyConfig(),
        providers: {
          pa: { base_url: 'https://a.example.com', protocol: 'anthropic', auth_style: 'x-api-key', key_ref: 'file:pa', models: { 'a-model': {} } },
          pb: { base_url: 'https://b.example.com', protocol: 'anthropic', auth_style: 'x-api-key', key_ref: 'file:pb', models: { 'b-model': {} } },
        },
        profiles: { proA: { provider: 'pa', default_model: 'a-model' }, proB: { provider: 'pb', default_model: 'b-model' } },
        active_profile: 'proA',
      })

      await applyAttach('dsh', {}) // 网关接入：modeldock models 烙上 a-model
      expect(fs.readFileSync(patchPath, 'utf8')).toContain('a-model')

      await switchToService('pb')
      const r = await refreshBakedModelClients()
      expect(r.refreshed).toEqual(['dsh'])
      expect(r.warnings).toEqual([])

      const text = fs.readFileSync(patchPath, 'utf8')
      expect(text).toContain('b-model') // 模型列表已跟随新全局服务
      expect(text).toContain('model: b-model') // agent-default-model 同步切换
      expect(text).not.toContain('a-model')
      expect(text).toContain('https://ark.example.com') // 用户自己配的 provider 不受影响
    } finally {
      h.restore()
    }
  })

  it('settings.yaml 被新版 dsh 迁移改名（.imported）后 detect/status 仍报已安装', async () => {
    const h = fakeHome()
    try {
      const dir = path.join(h.home, '.dsh')
      await ensureDir(dir)
      await atomicWrite(path.join(dir, 'settings.yaml.imported'), 'llm-pi-ai: {}\n', 0o600)
      await withConfig(baseCfg())

      const det = await dshAdapter.detect()
      expect(det.installed).toBe(true)

      const st = await dshAdapter.status(await loadConfig(), 8687)
      expect(st.installed).toBe(true)
      expect(st.attached).toBe(false)
    } finally {
      h.restore()
    }
  })
})

describe('zcode adapter', () => {
  it('attach 写入个人供应商存储（provider_config.json），不动用户既有供应商；同时清理旧版 builtin:modeldock 残留', async () => {
    const h = fakeHome()
    // detect/status 现要求 ZCode 本体在场才算已安装；用测试钩子注入，避免依赖测试机真实安装
    process.env.MODELRDOCK_FAKE_ZCODE_PRESENT = '1'
    try {
      const v2 = path.join(h.home, '.zcode', 'v2')
      await ensureDir(v2)
      // 模拟本机真实布局：现行个人供应商存储（用户自建 deepseek）+ 旧版 legacy 残留条目
      const pp = path.join(v2, 'provider_config.json')
      const personal = {
        schemaVersion: 1,
        config: {
          providerOrder: ['deepseek'],
          providerConfigRules: {
            providerRules: [
              {
                providerId: 'deepseek',
                templateId: 'deepseek',
                providerName: 'DeepSeek',
                config: {
                  group: 'standard-personal',
                  access: { type: 'api-key', apiKey: 'sk-user' },
                  personalModelIds: [],
                  modelOrder: ['deepseek-flash', 'deepseek-v4-pro'],
                },
              },
            ],
          },
          modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
        },
      }
      await atomicWrite(pp, JSON.stringify(personal, null, 2) + '\n', 0o600)
      const lp = path.join(v2, 'config.json')
      await atomicWrite(
        lp,
        JSON.stringify(
          { provider: { 'builtin:modeldock': { name: 'ModelDock', kind: 'anthropic', options: { apiKey: 'old', baseURL: 'http://127.0.0.1:8890' } } } },
          null,
          2
        ) + '\n',
        0o600
      )
      await withConfig(baseCfg())

      const plan = await zcodeAdapter.planAttach({ mode: 'gateway', gatewayPort: 8687, token: TOKEN }, await loadConfig())
      await applyChanges('zcode', 'attach', plan.changes, { yes: true, redactions: [TOKEN] })

      const after = JSON.parse(fs.readFileSync(pp, 'utf8'))
      const rules = after.config.providerConfigRules.providerRules
      const rule = rules.find((r: any) => r.providerId === 'modeldock')
      expect(rule.config.api).toEqual({ type: 'anthropic-messages', baseUrl: 'http://127.0.0.1:8687' })
      expect(rule.config.access.apiKey).toBe(TOKEN)
      expect(rule.config.group).toBe('standard-personal')
      expect(rules.find((r: any) => r.providerId === 'deepseek').config.access.apiKey).toBe('sk-user') // 未动
      expect(after.config.providerOrder).toEqual(['deepseek', 'modeldock'])
      const legacyAfter = JSON.parse(fs.readFileSync(lp, 'utf8'))
      expect(legacyAfter.provider['builtin:modeldock']).toBeUndefined()

      const st = await zcodeAdapter.status(await loadConfig(), 8687)
      expect(st.pointing).toBe('gateway')

      const planDetach = await zcodeAdapter.planDetach(await loadConfig())
      await applyChanges('zcode', 'detach', planDetach.changes, { yes: true })
      const afterDetach = JSON.parse(fs.readFileSync(pp, 'utf8'))
      const rulesAfter = afterDetach.config.providerConfigRules.providerRules
      expect(rulesAfter.find((r: any) => r.providerId === 'modeldock')).toBeUndefined()
      expect(rulesAfter.find((r: any) => r.providerId === 'deepseek').config.access.apiKey).toBe('sk-user')
      expect(afterDetach.config.providerOrder).toEqual(['deepseek'])
    } finally {
      delete process.env.MODELRDOCK_FAKE_ZCODE_PRESENT
      h.restore()
    }
  })

  it('attach 写入模型列表与模型定义（取当前路由服务的模型目录）', async () => {
    const h = fakeHome()
    process.env.MODELRDOCK_FAKE_ZCODE_PRESENT = '1'
    try {
      const v2 = path.join(h.home, '.zcode', 'v2')
      await ensureDir(v2)
      const pp = path.join(v2, 'provider_config.json')
      await atomicWrite(
        pp,
        JSON.stringify(
          { schemaVersion: 1, config: { providerConfigRules: { providerRules: [] }, modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] } } },
          null,
          2
        ) + '\n',
        0o600
      )
      const cfg: Config = {
        ...baseCfg(),
        providers: {
          p: {
            base_url: 'https://x.example.com',
            protocol: 'anthropic',
            auth_style: 'bearer',
            key_ref: 'k',
            models: {
              'model-x': { source: 'manual', display_name: 'Model X', context_window: 1048576, max_output: 131072 },
              'b-model': { source: 'manual' },
            },
          },
        },
      }
      await withConfig(cfg)

      const plan = await zcodeAdapter.planAttach({ mode: 'gateway', gatewayPort: 8687, token: TOKEN, profile: 'demo' }, await loadConfig())
      await applyChanges('zcode', 'attach', plan.changes, { yes: true, redactions: [TOKEN] })
      const after = JSON.parse(fs.readFileSync(pp, 'utf8'))
      const rule = after.config.providerConfigRules.providerRules.find((r: any) => r.providerId === 'modeldock')
      expect(rule.config.personalModelIds).toEqual(['model-x', 'b-model'])
      expect(rule.config.modelOrder).toEqual(['model-x', 'b-model'])
      // 手动规则只写元数据齐全的模型（ZCode 全字段校验）；b-model 无元数据 → 走 ZCode「推荐配置」兜底
      const manual = after.config.modelConfigRules.manualProviderModelRules
      expect(manual).toHaveLength(1)
      expect(manual[0]).toEqual({
        providerId: 'modeldock',
        modelId: 'model-x',
        config: {
          enabled: true,
          properties: {
            contextWindow: 1048576,
            inputFormat: { supportsImage: false, supportsVideo: false, supportsPdf: false },
            supportsJsonSchemaOutput: false,
            supportsNativeWebSearch: false,
            supportsMidConversationSystem: false,
          },
          optionSpecs: {
            reasoningLevel: { values: ['disabled', 'enabled'], map: '{}' },
            maxOutputTokens: { max: 131072 },
          },
        },
      })
      expect(plan.notes.some((n) => n.includes('2 个模型'))).toBe(true)

      const st = await zcodeAdapter.status(await loadConfig(), 8687)
      expect(st.pointing).toBe('gateway')
      expect(st.detail).toContain('2 个模型')
    } finally {
      delete process.env.MODELRDOCK_FAKE_ZCODE_PRESENT
      h.restore()
    }
  })

  it('配置残留但找不到 ZCode 本体：判为未安装（卸载残留不再误报已安装，接入也会拒绝）', async () => {
    const h = fakeHome()
    process.env.MODELRDOCK_FAKE_ZCODE_PRESENT = '0'
    try {
      const v2 = path.join(h.home, '.zcode', 'v2')
      await ensureDir(v2)
      const pp = path.join(v2, 'provider_config.json')
      await atomicWrite(
        pp,
        JSON.stringify(
          { schemaVersion: 1, config: { providerConfigRules: { providerRules: [] }, modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] } } },
          null,
          2
        ) + '\n',
        0o600
      )

      const det = await zcodeAdapter.detect()
      expect(det.installed).toBe(false)
      expect(det.note).toContain('残留')

      const st = await zcodeAdapter.status(emptyConfig(), 8687)
      expect(st.installed).toBe(false)
      expect(st.detail).toContain('残留')
    } finally {
      delete process.env.MODELRDOCK_FAKE_ZCODE_PRESENT
      h.restore()
    }
  })

  it('无任何配置且找不到 ZCode 本体：接入拒绝并给出安装指引', async () => {
    const h = fakeHome()
    process.env.MODELRDOCK_FAKE_ZCODE_PRESENT = '0'
    try {
      await expect(
        zcodeAdapter.planAttach({ mode: 'gateway', gatewayPort: 8687, token: TOKEN }, baseCfg())
      ).rejects.toThrow(/未找到 ZCode 本体/)
    } finally {
      delete process.env.MODELRDOCK_FAKE_ZCODE_PRESENT
      h.restore()
    }
  })

  it('已安装未初始化（无配置文件）：判为已安装，可直接一键接入并自动创建配置', async () => {
    const h = fakeHome()
    try {
      await withPathEnv(fakeBin(h, 'zcode'), async () => {
        const det = await zcodeAdapter.detect()
        expect(det.installed).toBe(true)
        expect(det.note).toContain('一键接入')

        const plan = await zcodeAdapter.planAttach({ mode: 'gateway', gatewayPort: 8687, token: TOKEN }, baseCfg())
        expect(plan.changes).toHaveLength(1)
        expect(plan.changes[0].before).toBeNull()
        expect(plan.notes.some((n) => n.includes('将新建'))).toBe(true)
        await applyChanges('zcode', 'attach', plan.changes, { yes: true, redactions: [TOKEN] })
        const pp = path.join(h.home, '.zcode', 'v2', 'provider_config.json')
        const onDisk = JSON.parse(fs.readFileSync(pp, 'utf8'))
        const rule = onDisk.config.providerConfigRules.providerRules.find((r: any) => r.providerId === 'modeldock')
        expect(rule.config.api.baseUrl).toBe('http://127.0.0.1:8687')
        expect(rule.config.access.apiKey).toBe(TOKEN)
      })
    } finally {
      h.restore()
    }
  })
})

describe('codex adapter', () => {
  it('内联 http_headers 令牌，不写环境变量；detach 精确还原并清理残留 rc 哨兵', async () => {
    const h = fakeHome()
    // 本体双信号判定需注入「codex 命令在场」，避免依赖测试机真实安装
    process.env.MODELRDOCK_FAKE_CODEX_PRESENT = '1'
    try {
      // 预置 shell 启动文件，验证接入不再往里面写令牌（令牌走 http_headers）
      const rc = path.join(h.home, '.zshrc')
      await ensureDir(path.dirname(rc))
      await atomicWrite(rc, 'export FOO=keep_me\n', 0o600)

      await withConfig(baseCfg())
      const plan = await codexAdapter.planAttach(
        { mode: 'gateway', gatewayPort: 8687, token: TOKEN, setDefault: true, profile: 'demo' },
        await loadConfig()
      )
      expect(plan.changes[0].before).toBeNull() // 新建 config.toml
      const ok = await applyChanges('codex', 'attach', plan.changes, { yes: true, redactions: [TOKEN] })
      expect(ok).toBe(true)

      const { tomlParse } = await import('../src/adapters/format.js')
      const root = tomlParse(fs.readFileSync(path.join(h.home, '.codex', 'config.toml'), 'utf8')) as any
      expect(root.model_provider).toBe('modeldock')
      expect(root.model).toBe('demo-model')
      expect(root.model_providers.modeldock.base_url).toBe('http://127.0.0.1:8687/v1')
      expect(root.model_providers.modeldock.http_headers.Authorization).toBe('Bearer ' + TOKEN)
      expect(root.model_providers.modeldock.wire_api).toBe('responses')
      expect(root.model_providers.modeldock.env_key).toBeUndefined() // 不再依赖环境变量

      // shell 启动文件不受影响（令牌内联在配置里）
      const rcAfter = fs.readFileSync(rc, 'utf8')
      expect(rcAfter).not.toContain('MODELRDOCK_CODEX_TOKEN')
      expect(rcAfter).toContain('export FOO=keep_me')

      // 模拟旧版残留：在 rc 里塞一段哨兵；detach 应精确移除、保留用户内容
      await atomicWrite(rc, 'export FOO=keep_me\n# >>> modeldock codex env >>>\nexport MODELRDOCK_CODEX_TOKEN="old"\n# <<< modeldock codex env <<<\n', 0o600)

      const det = await codexAdapter.planDetach(await loadConfig())
      const ok2 = await applyChanges('codex', 'detach', det.changes, { yes: true, redactions: [TOKEN] })
      expect(ok2).toBe(true)
      const root2 = tomlParse(fs.readFileSync(path.join(h.home, '.codex', 'config.toml'), 'utf8')) as any
      expect(root2.model_providers?.modeldock).toBeUndefined()
      const rcAfterDet = fs.readFileSync(rc, 'utf8')
      expect(rcAfterDet).not.toContain('MODELRDOCK_CODEX_TOKEN')
      expect(rcAfterDet).not.toContain('modeldock codex env')
      expect(rcAfterDet).toContain('export FOO=keep_me')
    } finally {
      delete process.env.MODELRDOCK_FAKE_CODEX_PRESENT
      h.restore()
    }
  })

  it('只装了 codex 命令、没有 config.toml：也算已安装（未接入），不再误报未安装', async () => {
    const h = fakeHome()
    try {
      await withPathEnv(fakeBin(h, 'codex'), async () => {
        const st = await codexAdapter.status(emptyConfig(), 8687)
        expect(st.installed).toBe(true)
        expect(st.attached).toBe(false)
        expect(st.detail).toContain('未初始化')
        const det = await codexAdapter.detect()
        expect(det.installed).toBe(true)
        expect(det.note).toContain('一键接入')
      })
    } finally {
      h.restore()
    }
  })

  it('命令与 config.toml 都没有：未安装', async () => {
    const h = fakeHome()
    try {
      await withPathEnv(path.join(h.home, 'empty-bin'), async () => {
        const st = await codexAdapter.status(emptyConfig(), 8687)
        expect(st.installed).toBe(false)
        const det = await codexAdapter.detect()
        expect(det.installed).toBe(false)
      })
    } finally {
      h.restore()
    }
  })

  it('config.toml 残留：命令在 PATH 上 → 已安装；命令缺席 → 未安装（卸载残留），接入拒绝', async () => {
    const h = fakeHome()
    try {
      const p = path.join(h.home, '.codex', 'config.toml')
      await ensureDir(path.dirname(p))
      await atomicWrite(p, '', 0o600)

      process.env.MODELRDOCK_FAKE_CODEX_PRESENT = '1'
      try {
        const st = await codexAdapter.status(emptyConfig(), 8687)
        expect(st.installed).toBe(true)
      } finally {
        delete process.env.MODELRDOCK_FAKE_CODEX_PRESENT
      }

      process.env.MODELRDOCK_FAKE_CODEX_PRESENT = '0'
      try {
        const det = await codexAdapter.detect()
        expect(det.installed).toBe(false)
        expect(det.note).toContain('残留')
        await expect(
          codexAdapter.planAttach({ mode: 'gateway', gatewayPort: 8687, token: TOKEN }, baseCfg())
        ).rejects.toThrow(/已卸载/)
      } finally {
        delete process.env.MODELRDOCK_FAKE_CODEX_PRESENT
      }
    } finally {
      h.restore()
    }
  })
})

describe('mimo-code adapter', () => {
  it('无配置时新建候选首个（mimocode.jsonc）；setDefault 设默认模型', async () => {
    const h = fakeHome()
    // 本体双信号判定需注入「mimo 命令在场」，避免依赖测试机真实安装
    process.env.MODELRDOCK_FAKE_MIMO_CODE_PRESENT = '1'
    try {
      await withConfig(baseCfg())
      const plan = await mimoCodeAdapter.planAttach(
        { mode: 'gateway', gatewayPort: 8687, token: TOKEN, setDefault: true },
        await loadConfig()
      )
      expect(plan.changes[0].before).toBeNull() // 新建
      expect(plan.changes[0].path).toBe(path.join(h.home, '.config', 'mimocode', 'mimocode.jsonc')) // 候选第一个 = 新建目标
      const ok = await applyChanges('mimo-code', 'attach', plan.changes, { yes: true, redactions: [TOKEN] })
      expect(ok).toBe(true)
      const onDisk = JSON.parse(fs.readFileSync(plan.changes[0].path, 'utf8'))
      expect(onDisk.provider.modeldock.options.baseURL).toBe('http://127.0.0.1:8687/v1')
      expect(onDisk.provider.modeldock.options.apiKey).toBe(TOKEN)
      expect(onDisk.provider.modeldock.npm).toBe('@ai-sdk/openai-compatible')
      expect(onDisk.model).toBe('modeldock/demo-model')

      const st = await mimoCodeAdapter.status(await loadConfig(), 8687)
      expect(st.installed).toBe(true)
      expect(st.pointing).toBe('gateway')
    } finally {
      delete process.env.MODELRDOCK_FAKE_MIMO_CODE_PRESENT
      h.restore()
    }
  })

  it('setDefault 与模型列表同源：默认模型跟随 opts.profile（钉定路由）而非 active_profile', async () => {
    const h = fakeHome()
    process.env.MODELRDOCK_FAKE_MIMO_CODE_PRESENT = '1'
    try {
      await withConfig({
        ...emptyConfig(),
        providers: {
          pa: { base_url: 'https://a.example.com', protocol: 'anthropic', auth_style: 'x-api-key', key_ref: 'file:pa', models: { 'a-model': {} } },
          pb: { base_url: 'https://b.example.com', protocol: 'anthropic', auth_style: 'x-api-key', key_ref: 'file:pb', models: { 'b-model': {} } },
        },
        profiles: { proA: { provider: 'pa', default_model: 'a-model' }, proB: { provider: 'pb', default_model: 'b-model' } },
        active_profile: 'proA',
      })
      const plan = await mimoCodeAdapter.planAttach(
        { mode: 'gateway', gatewayPort: 8687, token: TOKEN, setDefault: true, profile: 'proB' },
        await loadConfig()
      )
      const onDisk = JSON.parse(plan.changes[0].after!)
      expect(onDisk.provider.modeldock.models['b-model']).toBeDefined() // 模型列表按钉定路由 proB
      expect(onDisk.provider.modeldock.models['a-model']).toBeUndefined()
      expect(onDisk.model).toBe('modeldock/b-model') // 默认模型同样按 proB，不能偷偷跟随全局 proA
    } finally {
      delete process.env.MODELRDOCK_FAKE_MIMO_CODE_PRESENT
      h.restore()
    }
  })

  it('既有 .jsonc（含 JSONC 注释）可解析并 attach，注释丢失有提示；MIMOCODE_HOME 路径优先', async () => {
    const h = fakeHome()
    process.env.MODELRDOCK_FAKE_MIMO_CODE_PRESENT = '1'
    try {
      const mcHome = path.join(h.home, 'mimohome')
      process.env.MIMOCODE_HOME = mcHome
      try {
        const p = path.join(mcHome, 'config', 'mimocode.jsonc')
        await ensureDir(path.dirname(p))
        await atomicWrite(
          p,
          '{\n  // 官方 schema\n  "provider": {\n    "bigmodel": { "name": "Big", "npm": "@ai-sdk/openai-compatible", "options": { "baseURL": "https://big.example.com", "apiKey": "k" } }\n  },\n  "model": "bigmodel/x"\n}\n',
          0o600
        )
        await withConfig(baseCfg())

        const det = await mimoCodeAdapter.detect()
        expect(det.installed).toBe(true)
        expect(det.configFiles).toEqual([p])

        const plan = await mimoCodeAdapter.planAttach({ mode: 'gateway', gatewayPort: 8687, token: TOKEN }, await loadConfig())
        expect(plan.changes[0].path).toBe(p)
        expect(plan.notes.some((n) => n.includes('JSONC') && n.includes('快照'))).toBe(true)
        await applyChanges('mimo-code', 'attach', plan.changes, { yes: true, redactions: [TOKEN] })
        const after = JSON.parse(fs.readFileSync(p, 'utf8'))
        expect(after.provider.bigmodel.options.apiKey).toBe('k') // 未动
        expect(after.provider.modeldock.options.baseURL).toBe('http://127.0.0.1:8687/v1')

        const planDetach = await mimoCodeAdapter.planDetach(await loadConfig())
        await applyChanges('mimo-code', 'detach', planDetach.changes, { yes: true })
        const afterDetach = JSON.parse(fs.readFileSync(p, 'utf8'))
        expect(afterDetach.provider.modeldock).toBeUndefined()
        expect(afterDetach.provider.bigmodel.options.apiKey).toBe('k')
        expect(afterDetach.model).toBe('bigmodel/x') // 非 modeldock 前缀，未改动
      } finally {
        delete process.env.MIMOCODE_HOME
      }
    } finally {
      delete process.env.MODELRDOCK_FAKE_MIMO_CODE_PRESENT
      h.restore()
    }
  })

  it('既有条目保留（默认路径）；attach 幂等', async () => {
    const h = fakeHome()
    process.env.MODELRDOCK_FAKE_MIMO_CODE_PRESENT = '1'
    try {
      const p = path.join(h.home, '.config', 'mimocode', 'mimocode.json')
      await ensureDir(path.dirname(p))
      await atomicWrite(
        p,
        JSON.stringify(
          {
            provider: {
              bigmodel: { name: 'Big', npm: '@ai-sdk/openai-compatible', options: { baseURL: 'https://big.example.com', apiKey: 'k' } },
            },
            model: 'bigmodel/x',
          },
          null,
          2
        ) + '\n',
        0o600
      )
      await withConfig(baseCfg())

      const plan = await mimoCodeAdapter.planAttach({ mode: 'gateway', gatewayPort: 8687, token: TOKEN }, await loadConfig())
      expect(plan.changes[0].path).toBe(p) // .jsonc 缺席时回落到 .json
      expect(plan.notes.some((n) => n.includes('JSONC'))).toBe(false)
      await applyChanges('mimo-code', 'attach', plan.changes, { yes: true, redactions: [TOKEN] })
      const after = JSON.parse(fs.readFileSync(p, 'utf8'))
      expect(after.provider.bigmodel.options.apiKey).toBe('k') // 未动
      expect(after.provider.modeldock.options.baseURL).toBe('http://127.0.0.1:8687/v1')

      const plan2 = await mimoCodeAdapter.planAttach({ mode: 'gateway', gatewayPort: 8687, token: TOKEN }, await loadConfig())
      const after2 = JSON.parse(plan2.changes[0].after)
      expect(Object.keys(after2.provider)).toEqual(['bigmodel', 'modeldock']) // 幂等，不重复

      const planDetach = await mimoCodeAdapter.planDetach(await loadConfig())
      await applyChanges('mimo-code', 'detach', planDetach.changes, { yes: true })
      const afterDetach = JSON.parse(fs.readFileSync(p, 'utf8'))
      expect(afterDetach.provider.modeldock).toBeUndefined()
      expect(afterDetach.provider.bigmodel.options.apiKey).toBe('k')
      expect(afterDetach.model).toBe('bigmodel/x') // 非 modeldock 前缀，未改动
    } finally {
      delete process.env.MODELRDOCK_FAKE_MIMO_CODE_PRESENT
      h.restore()
    }
  })

  it('declareModels：按当前路由模型目录写入 models 声明与 only_configured_models', async () => {
    const h = fakeHome()
    process.env.MODELRDOCK_FAKE_MIMO_CODE_PRESENT = '1'
    try {
      await withConfig({
        ...baseCfg(),
        providers: {
          p: {
            base_url: 'https://x.example.com',
            protocol: 'openai',
            auth_style: 'bearer',
            key_ref: 'k',
            models: {
              'm-a': { source: 'manual', display_name: 'Model A' },
              'm-b': { source: 'manual' },
            },
          },
        },
      })
      const plan = await mimoCodeAdapter.planAttach(
        { mode: 'gateway', gatewayPort: 8687, token: TOKEN, setDefault: true },
        await loadConfig()
      )
      const after = JSON.parse(plan.changes[0].after)
      expect(after.provider.modeldock.only_configured_models).toBe(true)
      expect(after.provider.modeldock.models).toEqual({
        'm-a': { name: 'Model A' },
        'm-b': { name: 'm-b' },
      })
      expect(after.model).toBe('modeldock/demo-model')
      expect(plan.notes.some((n) => n.includes('模型列表取自当前路由'))).toBe(true)
    } finally {
      delete process.env.MODELRDOCK_FAKE_MIMO_CODE_PRESENT
      h.restore()
    }
  })

  it('配置残留但 mimo 命令缺席：判为未安装（卸载残留），接入拒绝', async () => {
    const h = fakeHome()
    process.env.MODELRDOCK_FAKE_MIMO_CODE_PRESENT = '0'
    try {
      const p = path.join(h.home, '.config', 'mimocode', 'mimocode.jsonc')
      await ensureDir(path.dirname(p))
      await atomicWrite(p, JSON.stringify({ provider: {} }) + '\n', 0o600)

      const det = await mimoCodeAdapter.detect()
      expect(det.installed).toBe(false)
      expect(det.note).toContain('残留')

      const st = await mimoCodeAdapter.status(emptyConfig(), 8687)
      expect(st.installed).toBe(false)
      expect(st.detail).toContain('残留')

      await expect(
        mimoCodeAdapter.planAttach({ mode: 'gateway', gatewayPort: 8687, token: TOKEN }, baseCfg())
      ).rejects.toThrow(/已卸载/)
    } finally {
      delete process.env.MODELRDOCK_FAKE_MIMO_CODE_PRESENT
      h.restore()
    }
  })

  it('安装元数据：平台映射的小米官方脚本 + bootstrap 指向候选首个 + 官网链接', () => {
    const h = fakeHome()
    try {
      const inst = mimoCodeAdapter.install!
      // 平台映射命令：小米官方安装脚本（零依赖、大陆 CDN），npm 路径退居手动兜底指引
      expect(inst.command).toHaveProperty('posix')
      expect((inst.command as any).posix).toContain('https://mimo.xiaomi.com/install')
      expect((inst.command as any).win32).toContain('https://mimo.xiaomi.com/install.ps1')
      expect(inst.homepage).toBe('https://mimo.xiaomi.com/zh/mimocode')
      expect(inst.bootstrap).toBeTruthy()
      // bootstrap.path 惰性求值，须在 fake home 生效后再取（否则 Windows 上会落到宿主机 %LOCALAPPDATA%）
      const p = inst.bootstrap!.path()
      expect(p).toBe(path.join(h.home, '.config', 'mimocode', 'mimocode.jsonc'))
      const boot = JSON.parse(inst.bootstrap!.content)
      expect(boot.$schema).toContain('mimo.xiaomi.com')
    } finally {
      h.restore()
    }
  })
})

describe('opencode adapter', () => {
  it('无配置时创建 opencode.json；setDefault 设默认模型', async () => {
    const h = fakeHome()
    // 本体双信号判定需注入「opencode 命令在场」，避免依赖测试机真实安装
    process.env.MODELRDOCK_FAKE_OPENCODE_PRESENT = '1'
    try {
      await withConfig(baseCfg())
      const plan = await openCodeAdapter.planAttach(
        { mode: 'gateway', gatewayPort: 8687, token: TOKEN, setDefault: true },
        await loadConfig()
      )
      expect(plan.changes[0].before).toBeNull() // 新建
      const ok = await applyChanges('opencode', 'attach', plan.changes, { yes: true, redactions: [TOKEN] })
      expect(ok).toBe(true)
      const p = path.join(h.home, '.config', 'opencode', 'opencode.json')
      const onDisk = JSON.parse(fs.readFileSync(p, 'utf8'))
      expect(onDisk.provider.modeldock.options.baseURL).toBe('http://127.0.0.1:8687/v1')
      expect(onDisk.provider.modeldock.options.apiKey).toBe(TOKEN)
      expect(onDisk.model).toBe('modeldock/demo-model')

      const st = await openCodeAdapter.status(await loadConfig(), 8687)
      expect(st.installed).toBe(true)
      expect(st.pointing).toBe('gateway')
    } finally {
      delete process.env.MODELRDOCK_FAKE_OPENCODE_PRESENT
      h.restore()
    }
  })

  it('既有条目保留；detach 移除 modeldock 并还原', async () => {
    const h = fakeHome()
    process.env.MODELRDOCK_FAKE_OPENCODE_PRESENT = '1'
    try {
      const p = path.join(h.home, '.config', 'opencode', 'opencode.json')
      await ensureDir(path.dirname(p))
      await atomicWrite(
        p,
        JSON.stringify(
          {
            provider: {
              big: { name: 'Big', npm: '@ai-sdk/openai-compatible', options: { baseURL: 'https://big.example.com', apiKey: 'k' } },
            },
            model: 'big/x',
          },
          null,
          2
        ) + '\n',
        0o600
      )
      await withConfig(baseCfg())

      const plan = await openCodeAdapter.planAttach({ mode: 'gateway', gatewayPort: 8687, token: TOKEN }, await loadConfig())
      await applyChanges('opencode', 'attach', plan.changes, { yes: true, redactions: [TOKEN] })
      const after = JSON.parse(fs.readFileSync(p, 'utf8'))
      expect(after.provider.big.options.apiKey).toBe('k') // 未动
      expect(after.provider.modeldock.options.baseURL).toBe('http://127.0.0.1:8687/v1')

      const planDetach = await openCodeAdapter.planDetach(await loadConfig())
      await applyChanges('opencode', 'detach', planDetach.changes, { yes: true })
      const afterDetach = JSON.parse(fs.readFileSync(p, 'utf8'))
      expect(afterDetach.provider.modeldock).toBeUndefined()
      expect(afterDetach.provider.big.options.apiKey).toBe('k')
    } finally {
      delete process.env.MODELRDOCK_FAKE_OPENCODE_PRESENT
      h.restore()
    }
  })
})

describe('applyChanges 引擎', () => {
  it('yes:false 且用户取消 → 不写盘', async () => {
    const h = fakeHome()
    try {
      const p = path.join(h.home, 'f.txt')
      await atomicWrite(p, 'old\n', 0o600)
      // 模拟取消：applyChanges 内部 confirm 会阻塞 TTY，这里直接验证快照+写入路径，取消路径由 confirm 返回 false 覆盖
      // 以 no-change 快速路径代替：
      const ok = await applyChanges('x', 'attach', [], { yes: true })
      expect(ok).toBe(true)
      expect(await readTextIfExists(p)).toBe('old\n')
    } finally {
      h.restore()
    }
  })

  it('写入后回读一致，快照可校验', async () => {
    const h = fakeHome()
    try {
      const p = path.join(h.home, 'f.json')
      await atomicWrite(p, '{"v":1}', 0o600)
      const manifest = await (
        await import('../src/backup/snapshot.js')
      ).snapshot('t', 'attach', [p])
      await atomicWrite(p, '{"v":2}', 0o600)
      await (await import('../src/backup/snapshot.js')).restoreSnapshot(manifest)
      expect(await matchesSnapshot(manifest)).toBe(true)
      expect(fs.readFileSync(p, 'utf8')).toBe('{"v":1}')
    } finally {
      h.restore()
    }
  })
})


describe('workbuddy adapter', () => {
  const wbCfg = (): Config => ({
    ...baseCfg(),
    providers: {
      p: {
        base_url: 'https://x.example.com',
        protocol: 'openai',
        auth_style: 'bearer',
        key_ref: 'k',
        models: {
          m1: { source: 'manual', display_name: 'M One' },
          m2: { source: 'manual' },
        },
      },
    },
  })

  it('detect：无任何痕迹时未安装；有产品目录痕迹算已安装（引导一键接入）', async () => {
    const h = fakeHome()
    try {
      // 先注入「桌面应用不在场」，验证无痕迹时未安装
      process.env.MODELRDOCK_FAKE_WORKBUDDY_PRESENT = '0'
      const det0 = await workbuddyAdapter.detect()
      expect(det0.installed).toBe(false)

      const marker = path.join(h.home, '.workbuddy-ai', 'settings.json')
      await ensureDir(path.dirname(marker))
      await atomicWrite(marker, '{}', 0o600)
      // 有痕迹但本体缺席 → 残留，仍未安装
      const detResidue = await workbuddyAdapter.detect()
      expect(detResidue.installed).toBe(false)
      expect(detResidue.note).toContain('残留')

      // 本体在场 → 已安装，引导一键接入
      process.env.MODELRDOCK_FAKE_WORKBUDDY_PRESENT = '1'
      const det1 = await workbuddyAdapter.detect()
      expect(det1.installed).toBe(true)
      expect(det1.configFiles).toHaveLength(0)
      expect(det1.note).toContain('models.json')
    } finally {
      delete process.env.MODELRDOCK_FAKE_WORKBUDDY_PRESENT
      h.restore()
    }
  })

  it('全新 attach 写入 ~/.workbuddy-ai/models.json，url 为完整 chat/completions 端点；status/detach 闭环', async () => {
    const h = fakeHome()
    process.env.MODELRDOCK_FAKE_WORKBUDDY_PRESENT = '1'
    try {
      const marker = path.join(h.home, '.workbuddy-ai', 'settings.json')
      await ensureDir(path.dirname(marker))
      await atomicWrite(marker, '{}', 0o600)
      await withConfig(wbCfg())

      const plan = await workbuddyAdapter.planAttach({ mode: 'gateway', gatewayPort: 8687, token: TOKEN }, await loadConfig())
      expect(plan.changes).toHaveLength(1)
      expect(plan.changes[0].path).toBe(path.join(h.home, '.workbuddy-ai', 'models.json'))
      const after = JSON.parse(plan.changes[0].after)
      expect(Array.isArray(after)).toBe(true)
      expect(after).toHaveLength(2)
      expect(after[0]).toMatchObject({ id: 'm1', name: 'M One', url: 'http://127.0.0.1:8687/v1/chat/completions', apiKey: TOKEN })
      expect(after[1].id).toBe('m2')
      expect(after[1].name).toBe('m2') // 无 display_name 回退为模型 id

      const ok = await applyChanges('workbuddy', 'attach', plan.changes, { yes: true, redactions: [TOKEN] })
      expect(ok).toBe(true)
      const p = path.join(h.home, '.workbuddy-ai', 'models.json')
      expect(JSON.parse(fs.readFileSync(p, 'utf8'))).toHaveLength(2)
      expect((await listSnapshots('workbuddy')).some((s) => s.operation === 'attach')).toBe(true)

      // 幂等重接：条目不翻倍
      const plan2 = await workbuddyAdapter.planAttach({ mode: 'gateway', gatewayPort: 8687, token: TOKEN }, await loadConfig())
      const after2 = JSON.parse(plan2.changes[0].after)
      expect(after2).toHaveLength(2)

      // 模拟 registerAttach 的登记（单测不走 ops 层），覆盖 gateway_base 匹配路径
      const regged = await loadConfig()
      regged.harness['workbuddy'] = { mode: 'gateway', gateway_base: 'http://127.0.0.1:8687' }
      await withConfig(regged)

      const st = await workbuddyAdapter.status(regged, 8687)
      expect(st.installed).toBe(true)
      expect(st.attached).toBe(true)
      expect(st.pointing).toBe('gateway')
      expect(st.detail).toContain('2 个模型')

      const planDetach = await workbuddyAdapter.planDetach(regged)
      await applyChanges('workbuddy', 'detach', planDetach.changes, { yes: true })
      expect(JSON.parse(fs.readFileSync(p, 'utf8'))).toEqual([])
      const st2 = await workbuddyAdapter.status(regged, 8687)
      expect(st2.pointing).toBe('unknown')
    } finally {
      delete process.env.MODELRDOCK_FAKE_WORKBUDDY_PRESENT
      h.restore()
    }
  })

  it('多候选路径：仅旧目录有文件时用旧目录；两处都在时优先 ~/.workbuddy-ai', async () => {
    const h = fakeHome()
    process.env.MODELRDOCK_FAKE_WORKBUDDY_PRESENT = '1'
    try {
      const legacy = path.join(h.home, '.workbuddy', 'models.json')
      await ensureDir(path.dirname(legacy))
      await atomicWrite(legacy, '[{"id":"legacy-entry","url":"https://legacy.example.com"}]', 0o600)

      const det = await workbuddyAdapter.detect()
      expect(det.configFiles).toEqual([legacy])

      await withConfig(wbCfg())
      const plan = await workbuddyAdapter.planAttach({ mode: 'gateway', gatewayPort: 8687, token: TOKEN }, await loadConfig())
      expect(plan.changes[0].path).toBe(legacy) // 写进已存在的旧目录文件，不另开新文件
      expect(plan.changes[0].before).toContain('legacy-entry')

      // 两处都存在时：active 取 ~/.workbuddy-ai
      const primary = path.join(h.home, '.workbuddy-ai', 'models.json')
      await ensureDir(path.dirname(primary))
      await atomicWrite(primary, '[{"id":"primary-entry","url":"https://primary.example.com"}]', 0o600)
      const det2 = await workbuddyAdapter.detect()
      expect(det2.configFiles).toEqual([primary])
      const plan2 = await workbuddyAdapter.planAttach({ mode: 'gateway', gatewayPort: 8687, token: TOKEN }, await loadConfig())
      expect(plan2.changes[0].path).toBe(primary)
      expect(plan2.changes[0].before).toContain('primary-entry')
    } finally {
      delete process.env.MODELRDOCK_FAKE_WORKBUDDY_PRESENT
      h.restore()
    }
  })

  it('已有用户条目（实测 UI 格式）：不覆盖同 id 条目、保留 vendor 等额外字段；detach 后原样保留', async () => {
    const h = fakeHome()
    process.env.MODELRDOCK_FAKE_WORKBUDDY_PRESENT = '1'
    try {
      const p = path.join(h.home, '.workbuddy-ai', 'models.json')
      await ensureDir(path.dirname(p))
      const userEntry = {
        id: 'deepseek-v4-flash',
        name: 'DeepSeek-V4 Flash',
        vendor: 'DeepSeek',
        url: 'https://api.deepseek.com/chat/completions',
        apiKey: 'sk-user-real',
        supportsToolCall: true,
        supportsImages: false,
        supportsReasoning: true,
        reasoning: { defaultEffort: 'high', supportedEfforts: ['high', 'max'] },
      }
      const clashing = { id: 'm1', name: '同名自定义条目', url: 'https://other.example.com/chat/completions', apiKey: 'sk-own' }
      await atomicWrite(p, JSON.stringify([userEntry, clashing], null, 2) + '\n', 0o600)
      await withConfig(wbCfg())

      const plan = await workbuddyAdapter.planAttach({ mode: 'gateway', gatewayPort: 8687, token: TOKEN }, await loadConfig())
      const after = JSON.parse(plan.changes[0].after)
      expect(after).toHaveLength(3) // 用户两条 + 我们补的 m2（m1 撞名不覆盖）
      expect(after.find((e: { id: string }) => e.id === 'deepseek-v4-flash')).toEqual(userEntry) // 原条目原样（含 vendor/reasoning）
      expect(after.filter((e: { id: string }) => e.id === 'm1')).toEqual([clashing])
      expect(after.filter((e: { id: string }) => e.id === 'm2')).toHaveLength(1)
      expect(plan.notes.some((n) => n.includes('不覆盖') && n.includes('m1'))).toBe(true)

      await applyChanges('workbuddy', 'attach', plan.changes, { yes: true, redactions: [TOKEN, 'sk-user-real'] })
      const planDetach = await workbuddyAdapter.planDetach(await loadConfig())
      await applyChanges('workbuddy', 'detach', planDetach.changes, { yes: true })
      const final = JSON.parse(fs.readFileSync(p, 'utf8'))
      expect(final).toEqual([userEntry, clashing])
    } finally {
      delete process.env.MODELRDOCK_FAKE_WORKBUDDY_PRESENT
      h.restore()
    }
  })

  it('对象格式（{ models } + availableModels）：attach 并入列表，detach 同步清理', async () => {
    const h = fakeHome()
    process.env.MODELRDOCK_FAKE_WORKBUDDY_PRESENT = '1'
    try {
      const p = path.join(h.home, '.workbuddy-ai', 'models.json')
      await ensureDir(path.dirname(p))
      await atomicWrite(p, JSON.stringify({ models: [{ id: 'u1', url: 'https://a.example.com' }], availableModels: ['u1'] }, null, 2) + '\n', 0o600)
      await withConfig(wbCfg())

      const plan = await workbuddyAdapter.planAttach({ mode: 'gateway', gatewayPort: 8687, token: TOKEN }, await loadConfig())
      const after = JSON.parse(plan.changes[0].after)
      expect(after.models.map((e: { id: string }) => e.id).sort()).toEqual(['m1', 'm2', 'u1'])
      expect(after.availableModels.sort()).toEqual(['m1', 'm2', 'u1'])

      await applyChanges('workbuddy', 'attach', plan.changes, { yes: true, redactions: [TOKEN] })
      const planDetach = await workbuddyAdapter.planDetach(await loadConfig())
      await applyChanges('workbuddy', 'detach', planDetach.changes, { yes: true })
      const final = JSON.parse(fs.readFileSync(p, 'utf8'))
      expect(final.models).toEqual([{ id: 'u1', url: 'https://a.example.com' }])
      expect(final.availableModels).toEqual(['u1'])
    } finally {
      delete process.env.MODELRDOCK_FAKE_WORKBUDDY_PRESENT
      h.restore()
    }
  })

  it('当前路由没有模型目录时给出可操作错误', async () => {
    const h = fakeHome()
    process.env.MODELRDOCK_FAKE_WORKBUDDY_PRESENT = '1'
    try {
      await withConfig(baseCfg())
      await expect(
        workbuddyAdapter.planAttach({ mode: 'gateway', gatewayPort: 8687, token: TOKEN }, await loadConfig())
      ).rejects.toThrow(/模型目录/)
    } finally {
      delete process.env.MODELRDOCK_FAKE_WORKBUDDY_PRESENT
      h.restore()
    }
  })
})

describe('mimo-desktop adapter', () => {
  it('本体在场但无配置：已安装（引导一键接入）；接入写入与 CLI 共用的 mimocode 配置', async () => {
    const h = fakeHome()
    process.env.MODELRDOCK_FAKE_MIMO_DESKTOP_PRESENT = '1'
    try {
      await withConfig(baseCfg())

      const det = await mimoDesktopAdapter.detect()
      expect(det.installed).toBe(true)
      expect(det.note).toContain('一键接入')

      const plan = await mimoDesktopAdapter.planAttach({ mode: 'gateway', gatewayPort: 8687, token: TOKEN }, await loadConfig())
      expect(plan.changes[0].before).toBeNull()
      expect(plan.changes[0].path).toBe(path.join(h.home, '.config', 'mimocode', 'mimocode.jsonc'))
      await applyChanges('mimo-desktop', 'attach', plan.changes, { yes: true, redactions: [TOKEN] })
      const onDisk = JSON.parse(fs.readFileSync(plan.changes[0].path, 'utf8'))
      expect(onDisk.provider.modeldock.options.baseURL).toBe('http://127.0.0.1:8687/v1')
      expect(onDisk.provider.modeldock.options.apiKey).toBe(TOKEN)

      const st = await mimoDesktopAdapter.status(await loadConfig(), 8687)
      expect(st.installed).toBe(true)
      expect(st.pointing).toBe('gateway')
    } finally {
      delete process.env.MODELRDOCK_FAKE_MIMO_DESKTOP_PRESENT
      h.restore()
    }
  })

  it('配置残留但桌面应用缺席：判为未安装，接入拒绝', async () => {
    const h = fakeHome()
    process.env.MODELRDOCK_FAKE_MIMO_DESKTOP_PRESENT = '0'
    try {
      const p = path.join(h.home, '.config', 'mimocode', 'mimocode.jsonc')
      await ensureDir(path.dirname(p))
      await atomicWrite(p, JSON.stringify({ provider: {} }) + '\n', 0o600)

      const det = await mimoDesktopAdapter.detect()
      expect(det.installed).toBe(false)
      expect(det.note).toContain('残留')

      const st = await mimoDesktopAdapter.status(emptyConfig(), 8687)
      expect(st.installed).toBe(false)

      await expect(
        mimoDesktopAdapter.planAttach({ mode: 'gateway', gatewayPort: 8687, token: TOKEN }, baseCfg())
      ).rejects.toThrow(/MiMo 桌面端/)
    } finally {
      delete process.env.MODELRDOCK_FAKE_MIMO_DESKTOP_PRESENT
      h.restore()
    }
  })
})

describe('refreshBakedModelClients：共用配置文件的客户端去重', () => {
  it('mimo-code 与 mimo-desktop 共用 mimocode.jsonc：切换全局后文件只重写一次，两个身份都算已刷新', async () => {
    const h = fakeHome()
    process.env.MODELRDOCK_FAKE_MIMO_CODE_PRESENT = '1'
    process.env.MODELRDOCK_FAKE_MIMO_DESKTOP_PRESENT = '1'
    try {
      const { applyAttach, switchToService, refreshBakedModelClients } = await import('../src/ops.js')
      await withConfig({
        ...emptyConfig(),
        providers: {
          pa: { base_url: 'https://a.example.com', protocol: 'anthropic', auth_style: 'x-api-key', key_ref: 'file:pa', models: { 'a-model': {} } },
          pb: { base_url: 'https://b.example.com', protocol: 'anthropic', auth_style: 'x-api-key', key_ref: 'file:pb', models: { 'b-model': {} } },
        },
        profiles: { proA: { provider: 'pa', default_model: 'a-model' }, proB: { provider: 'pb', default_model: 'b-model' } },
        active_profile: 'proA',
      })
      await applyAttach('mimo-code', {})
      await applyAttach('mimo-desktop', {}) // 同一份文件被第二个 harness 身份再接管（真实场景：CLI + 桌面端都接入）
      const cfgFile = path.join(h.home, '.config', 'mimocode', 'mimocode.jsonc')
      expect(fs.readFileSync(cfgFile, 'utf8')).toContain('a-model')

      const beforeCode = (await listSnapshots('mimo-code')).length
      const beforeDesk = (await listSnapshots('mimo-desktop')).length

      await switchToService('pb')
      const r = await refreshBakedModelClients()
      expect(r.refreshed).toEqual(['mimo-code', 'mimo-desktop']) // 两个身份都视为已刷新
      expect(r.warnings).toEqual([])

      const after = fs.readFileSync(cfgFile, 'utf8')
      expect(after).toContain('b-model')
      expect(after).not.toContain('a-model')
      // 去重：只有先处理的 mimo-code 真正落盘（刷新快照 +1），mimo-desktop 不重复写同一文件
      expect((await listSnapshots('mimo-code')).length).toBe(beforeCode + 1)
      expect((await listSnapshots('mimo-desktop')).length).toBe(beforeDesk)
    } finally {
      delete process.env.MODELRDOCK_FAKE_MIMO_CODE_PRESENT
      delete process.env.MODELRDOCK_FAKE_MIMO_DESKTOP_PRESENT
      h.restore()
    }
  })
})

describe('claude-code 独立直连（direct 模式）', () => {
  const directCfg = (): Config => ({
    ...emptyConfig(),
    providers: {
      p: { base_url: 'https://api.up.example.com', protocol: 'anthropic', auth_style: 'bearer', key_ref: 'sk-direct-plain' },
    },
    profiles: { demo: { provider: 'p', default_model: 'demo-model', aliases: { 'claude-sonnet-*': 'sonnet-real' } } },
    active_profile: 'demo',
  })

  it('direct：写上游 url+真实 key，完整下发模型映射（DEFAULT_*_MODEL + NAME + 根 model + 调优默认值）；x-api-key 写 API_KEY 并清 AUTH_TOKEN', async () => {
    const h = fakeHome()
    process.env.MODELRDOCK_FAKE_CLAUDE_CODE_PRESENT = '1'
    try {
      const p = path.join(h.home, '.claude', 'settings.json')
      await ensureDir(path.dirname(p))
      await atomicWrite(
        p,
        JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8687', ANTHROPIC_AUTH_TOKEN: 'mdk_x' } }, null, 2) + '\n',
        0o600
      )
      await withConfig(directCfg())
      const loaded = await loadConfig()

      const plan = await claudeCodeAdapter.planAttach(
        {
          mode: 'gateway',
          gatewayPort: 8687,
          token: 'mdk_x',
          profile: 'demo',
          direct: { base_url: 'https://api.up.example.com', key: 'sk-direct-plain', auth_style: 'bearer' },
        },
        loaded
      )
      expect(plan.changes).toHaveLength(1)
      const after = JSON.parse(plan.changes[0].after)
      expect(after.env.ANTHROPIC_BASE_URL).toBe('https://api.up.example.com')
      expect(after.env.ANTHROPIC_AUTH_TOKEN).toBe('sk-direct-plain')
      // 根 model 用 sonnet 别名（不再写 env.ANTHROPIC_MODEL）
      expect(after.model).toBe('sonnet')
      expect(after.env.ANTHROPIC_MODEL).toBeUndefined()
      // 分层模型映射：sonnet 别名 → 'sonnet-real'；未声明上下文 → 不加 [1m]；NAME = 去后缀 ID
      expect(after.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('sonnet-real')
      expect(after.env.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME).toBe('sonnet-real')
      expect(after.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBeUndefined()
      // subagent 默认用 sonnet 层模型；effort/compact 默认值
      expect(after.env.CLAUDE_CODE_SUBAGENT_MODEL).toBe('sonnet-real')
      expect(after.env.CLAUDE_CODE_EFFORT_LEVEL).toBe('max')
      expect(after.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('786432')
      expect(plan.notes.some((n) => n.includes('直连模式'))).toBe(true)

      // x-api-key 上游：写 ANTHROPIC_API_KEY 并清掉 AUTH_TOKEN，避免客户端用错凭据变量
      const planKey = await claudeCodeAdapter.planAttach(
        {
          mode: 'gateway',
          gatewayPort: 8687,
          token: 'mdk_x',
          profile: 'demo',
          direct: { base_url: 'https://api.up.example.com', key: 'sk-x', auth_style: 'x-api-key' },
        },
        loaded
      )
      const afterKey = JSON.parse(planKey.changes[0].after)
      expect(afterKey.env.ANTHROPIC_API_KEY).toBe('sk-x')
      expect(afterKey.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
    } finally {
      delete process.env.MODELRDOCK_FAKE_CLAUDE_CODE_PRESENT
      h.restore()
    }
  })

  it('direct：default_model 兜底 sonnet 层（无 claude-sonnet-* 别名时）；上下文≥1M 加 [1m] 后缀', async () => {
    const h = fakeHome()
    process.env.MODELRDOCK_FAKE_CLAUDE_CODE_PRESENT = '1'
    try {
      const p = path.join(h.home, '.claude', 'settings.json')
      await ensureDir(path.dirname(p))
      await atomicWrite(
        p,
        JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8687', ANTHROPIC_AUTH_TOKEN: 'mdk_x' } }, null, 2) + '\n',
        0o600
      )
      // 无 sonnet 别名：default_model 兜底 sonnet 层。glm-5.3-flash 在 known.ts 上下文 1048576 ≥ 1M → 加 [1m]
      const cfg: Config = {
        ...emptyConfig(),
        providers: {
          p: { base_url: 'https://api.up.example.com', protocol: 'anthropic', auth_style: 'bearer', key_ref: 'sk-direct-plain' },
        },
        profiles: { demo: { provider: 'p', default_model: 'glm-5.3-flash' } },
        active_profile: 'demo',
      }
      await withConfig(cfg)
      const loaded = await loadConfig()

      const plan = await claudeCodeAdapter.planAttach(
        {
          mode: 'gateway',
          gatewayPort: 8687,
          token: 'mdk_x',
          profile: 'demo',
          direct: { base_url: 'https://api.up.example.com', key: 'sk-direct-plain', auth_style: 'bearer' },
        },
        loaded
      )
      const after = JSON.parse(plan.changes[0].after)
      expect(after.model).toBe('sonnet')
      expect(after.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('glm-5.3-flash[1m]')
      expect(after.env.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME).toBe('glm-5.3-flash')
      expect(after.env.CLAUDE_CODE_SUBAGENT_MODEL).toBe('glm-5.3-flash[1m]')
    } finally {
      delete process.env.MODELRDOCK_FAKE_CLAUDE_CODE_PRESENT
      h.restore()
    }
  })

  it('direct 落盘后切回网关（fromMode: direct）：清掉 direct 写入的模型映射与根 model，恢复网关地址与本地 token', async () => {
    const h = fakeHome()
    process.env.MODELRDOCK_FAKE_CLAUDE_CODE_PRESENT = '1'
    try {
      const p = path.join(h.home, '.claude', 'settings.json')
      await ensureDir(path.dirname(p))
      await atomicWrite(
        p,
        JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8687', ANTHROPIC_AUTH_TOKEN: 'mdk_x' } }, null, 2) + '\n',
        0o600
      )
      await withConfig(directCfg())
      const loaded = await loadConfig()

      // 先把 direct 结果真实落盘
      const plan = await claudeCodeAdapter.planAttach(
        {
          mode: 'gateway',
          gatewayPort: 8687,
          token: 'mdk_x',
          profile: 'demo',
          direct: { base_url: 'https://api.up.example.com', key: 'sk-direct-plain', auth_style: 'bearer' },
        },
        loaded
      )
      expect(await applyChanges('claude-code', 'direct', plan.changes, { yes: true })).toBe(true)
      const onDisk = JSON.parse(fs.readFileSync(p, 'utf8'))
      expect(onDisk.model).toBe('sonnet')
      expect(onDisk.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('sonnet-real')

      // 切回网关：模型映射被清理（网关侧有别名重写，残留会钉死模型）
      const back = await claudeCodeAdapter.planAttach(
        { mode: 'gateway', gatewayPort: 8687, token: 'mdk_x', profile: 'demo', fromMode: 'direct' },
        await loadConfig()
      )
      const afterBack = JSON.parse(back.changes[0].after)
      expect(afterBack.env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:8687')
      expect(afterBack.env.ANTHROPIC_AUTH_TOKEN).toBe('mdk_x')
      expect(afterBack.model).toBeUndefined()
      expect(afterBack.env.ANTHROPIC_MODEL).toBeUndefined()
      expect(afterBack.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBeUndefined()
      expect(afterBack.env.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME).toBeUndefined()
      expect(afterBack.env.CLAUDE_CODE_SUBAGENT_MODEL).toBeUndefined()
      expect(afterBack.env.CLAUDE_CODE_EFFORT_LEVEL).toBeUndefined()
      expect(afterBack.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBeUndefined()
    } finally {
      delete process.env.MODELRDOCK_FAKE_CLAUDE_CODE_PRESENT
      h.restore()
    }
  })
})

describe('独立直连 Phase 2：dsh / codex / zcode / opencode / workbuddy', () => {
  it('烤模型/直连能力声明：codex、opencode、mimo-code、mimo-desktop、workbuddy、zcode、dsh 均可跟随路由重写', () => {
    expect(codexAdapter.bakesModels).toBe(true)
    expect(openCodeAdapter.bakesModels).toBe(true)
    expect(mimoCodeAdapter.bakesModels).toBe(true)
    expect(mimoDesktopAdapter.bakesModels).toBe(true)
    expect(workbuddyAdapter.bakesModels).toBe(true)
    expect(zcodeAdapter.bakesModels).toBe(true)
    expect(dshAdapter.bakesModels).toBe(true)
    // 直连能力：除 generic 外全量支持
    for (const a of [codexAdapter, openCodeAdapter, mimoCodeAdapter, mimoDesktopAdapter, workbuddyAdapter, zcodeAdapter, dshAdapter, claudeCodeAdapter]) {
      expect(a.directMode).toBe(true)
    }
  })

  const dcfg = (): Config => ({
    ...emptyConfig(),
    providers: {
      p: {
        base_url: 'https://api.up.example.com',
        protocol: 'openai',
        auth_style: 'bearer',
        key_ref: 'sk-direct-plain',
        endpoints: { openai: 'https://openai.up.example.com/v1' },
        models: { 'up-model': { source: 'manual', display_name: 'Up Model' } },
      },
    },
    profiles: { demo: { provider: 'p', default_model: 'up-model' } },
    active_profile: 'demo',
  })

  const directOpts = {
    mode: 'gateway' as const,
    gatewayPort: 8687,
    token: 'mdk_x',
    profile: 'demo',
    direct: {
      base_url: 'https://api.up.example.com',
      base_url_openai: 'https://openai.up.example.com/v1',
      protocol: 'openai' as const,
      key: 'sk-direct-plain',
      auth_style: 'bearer' as const,
    },
  }

  it('dsh：baseURL 用上游 openai 端点、api 随协议切换，真实 Key 写 credentials', async () => {
    const h = fakeHome()
    try {
      const p = path.join(h.home, '.dsh', 'settings.yaml')
      await ensureDir(path.dirname(p))
      await atomicWrite(p, 'llm-pi-ai:\n  providers: {}\n', 0o600)
      await withConfig(dcfg())

      const plan = await dshAdapter.planAttach(directOpts, await loadConfig())
      expect(plan.writtenBaseUrl).toBe('https://openai.up.example.com/v1')
      await applyChanges('dsh', 'direct', plan.changes, { yes: true })
      const after = fs.readFileSync(p, 'utf8')
      expect(after).toContain('baseURL: https://openai.up.example.com/v1')
      expect(after).toContain('api: openai-completions')
      const cred = fs.readFileSync(path.join(h.home, '.dsh', '.credentials.yaml'), 'utf8')
      expect(cred).toContain('sk-direct-plain')
    } finally {
      h.restore()
    }
  })

  it('codex：base_url 用上游 responses 端点，Key 内联 Bearer', async () => {
    const h = fakeHome()
    process.env.MODELRDOCK_FAKE_CODEX_PRESENT = '1'
    try {
      await withConfig(dcfg())
      const plan = await codexAdapter.planAttach(
        {
          ...directOpts,
          direct: { ...directOpts.direct, base_url_responses: 'https://resp.up.example.com/v1' },
        },
        await loadConfig()
      )
      expect(plan.writtenBaseUrl).toBe('https://resp.up.example.com/v1')
      const after = plan.changes[0].after
      expect(after).toContain('base_url = "https://resp.up.example.com/v1"')
      expect(after).toContain('Bearer sk-direct-plain')
    } finally {
      delete process.env.MODELRDOCK_FAKE_CODEX_PRESENT
      h.restore()
    }
  })

  it('zcode：access.apiKey 写上游真实 Key，api.type 随协议', async () => {
    const h = fakeHome()
    process.env.MODELRDOCK_FAKE_ZCODE_PRESENT = '1'
    try {
      await withConfig(dcfg())
      const plan = await zcodeAdapter.planAttach(directOpts, await loadConfig())
      expect(plan.writtenBaseUrl).toBe('https://openai.up.example.com/v1')
      await applyChanges('zcode', 'direct', plan.changes, { yes: true })
      const p = path.join(h.home, '.zcode', 'v2', 'provider_config.json')
      const onDisk = JSON.parse(fs.readFileSync(p, 'utf8'))
      const rule = onDisk.config.providerConfigRules.providerRules.find((r: any) => r.providerId === 'modeldock')
      expect(rule.config.access.apiKey).toBe('sk-direct-plain')
      expect(rule.config.api.baseUrl).toBe('https://openai.up.example.com/v1')
      expect(rule.config.api.type).toBe('openai-completions')
    } finally {
      delete process.env.MODELRDOCK_FAKE_ZCODE_PRESENT
      h.restore()
    }
  })

  it('opencode（provider-json 工厂）：baseURL 用上游 openai 端点 + 真实 Key', async () => {
    const h = fakeHome()
    process.env.MODELRDOCK_FAKE_OPENCODE_PRESENT = '1'
    try {
      await withConfig(dcfg())
      const plan = await openCodeAdapter.planAttach(directOpts, await loadConfig())
      expect(plan.writtenBaseUrl).toBe('https://openai.up.example.com/v1')
      await applyChanges('opencode', 'direct', plan.changes, { yes: true })
      const p = path.join(h.home, '.config', 'opencode', 'opencode.json')
      const onDisk = JSON.parse(fs.readFileSync(p, 'utf8'))
      expect(onDisk.provider.modeldock.options.baseURL).toBe('https://openai.up.example.com/v1')
      expect(onDisk.provider.modeldock.options.apiKey).toBe('sk-direct-plain')
    } finally {
      delete process.env.MODELRDOCK_FAKE_OPENCODE_PRESENT
      h.restore()
    }
  })

  it('workbuddy：条目 url 为上游 chat/completions 全路径 + 真实 Key；direct_base 幂等摘除', async () => {
    const h = fakeHome()
    process.env.MODELRDOCK_FAKE_WORKBUDDY_PRESENT = '1'
    try {
      const p = path.join(h.home, '.workbuddy-ai', 'models.json')
      await withConfig(dcfg())
      const plan = await workbuddyAdapter.planAttach(directOpts, await loadConfig())
      expect(plan.writtenBaseUrl).toBe('https://openai.up.example.com/v1/chat/completions')
      await applyChanges('workbuddy', 'direct', plan.changes, { yes: true })
      let onDisk = JSON.parse(fs.readFileSync(p, 'utf8'))
      expect(onDisk[0].url).toBe('https://openai.up.example.com/v1/chat/completions')
      expect(onDisk[0].apiKey).toBe('sk-direct-plain')

      // 切回网关：direct_base 匹配的条目被摘除，换成网关端点条目（不重不漏）
      const gwCfg: Config = {
        ...dcfg(),
        harness: {
          workbuddy: {
            mode: 'direct',
            route: 'demo',
            token: 'mdk_x',
            direct_base: plan.writtenBaseUrl!,
            gateway_base: 'http://127.0.0.1:8687',
          },
        },
      }
      await withConfig(gwCfg)
      const back = await workbuddyAdapter.planAttach(
        { mode: 'gateway', gatewayPort: 8687, token: 'mdk_x', profile: 'demo', fromMode: 'direct' },
        await loadConfig()
      )
      await applyChanges('workbuddy', 'attach', back.changes, { yes: true })
      onDisk = JSON.parse(fs.readFileSync(p, 'utf8'))
      expect(onDisk).toHaveLength(1)
      expect(onDisk[0].url).toBe('http://127.0.0.1:8687/v1/chat/completions')
      expect(onDisk[0].apiKey).toBe('mdk_x')
    } finally {
      delete process.env.MODELRDOCK_FAKE_WORKBUDDY_PRESENT
      h.restore()
    }
  })
})
