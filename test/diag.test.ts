import { describe, expect, it, vi, afterEach } from 'vitest'
import { fakeHome } from './helpers.js'
import { cmdDoctor, cmdStatus, cmdTest, runFixes, type DoctorFinding } from '../src/cli/diag.js'
import { verifySecretsStore } from '../src/config/secrets.js'
import { loadConfig, mutateConfig } from '../src/config/store.js'

// cmdDoctor/cmdStatus 是只读体检壳：无网络路径（上游可达性探测指向本地拒绝端口，瞬时失败）。
// cmdEnv/cmdTest 完整链会经 resolveClientGatewayPort 无条件探测 8687（开发机=生产实例，红线），
// 因此只覆盖 cmdTest 的 requireGateway 拒绝分支。
// doctor 的端口占用探测同样要防误连 8687：所有 cmdDoctor 用例一律注入 portProbe fake。
const noProbe = { portProbe: async () => false }
class ExitError extends Error {
  constructor(public code: number | undefined) {
    super(`exit:${code}`)
  }
}

let logs: string[] = []
let errs: string[] = []
function capture(): void {
  logs = []
  errs = []
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    logs.push(a.map(String).join(' '))
  })
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
    errs.push(a.map(String).join(' '))
  })
}

afterEach(() => {
  vi.mocked(console.log).mockRestore?.()
  vi.mocked(console.error).mockRestore?.()
  vi.mocked(process.exit).mockRestore?.()
})

describe('cmdStatus', () => {
  it('网关未运行：给出启动指引，active_profile 与 harness 表照常输出', async () => {
    const h = fakeHome()
    capture()
    try {
      await cmdStatus()
      const out = logs.join('\n')
      expect(out).toContain('网关未运行')
      expect(out).toContain('active_profile:')
      expect(out).toContain('generic-env')
    } finally {
      h.restore()
    }
  })
})

describe('cmdDoctor', () => {
  it('空配置：可解析 + 网关未运行 + 未设 active_profile 三条提示', async () => {
    const h = fakeHome()
    capture()
    try {
      await cmdDoctor({}, noProbe)
      const out = logs.join('\n')
      expect(out).toContain('config.toml 可解析')
      expect(out).toContain('网关未运行')
      expect(out).toContain('未设置 active_profile')
    } finally {
      h.restore()
    }
  })

  it('激活链路体检：key 可读（env 引用）、上游不可达、模型目录为空、generic-env 已接管、坏 pack 不击穿体检', async () => {
    const h = fakeHome()
    const saved = process.env.MD_DOC_KEY
    process.env.MD_DOC_KEY = 'sk-doctor-secret'
    capture()
    try {
      await mutateConfig((c) => {
        c.security = { store: 'file' }
        c.providers['pv'] = {
          name: 'PV',
          base_url: 'http://127.0.0.1:18999', // 无监听端口：连接拒绝，瞬时失败，不碰外网
          protocol: 'anthropic',
          auth_style: 'bearer',
          key_ref: 'env:MD_DOC_KEY',
        }
        c.profiles['main'] = { name: 'main', provider: 'pv', default_model: 'm1' }
        c.active_profile = 'main'
        c.harness['generic-env'] = { mode: 'gateway', token: 't' }
        c.adapter_packs = { bad: { format: 'xml' as never, config_file: 'x', upsert: {} } }
      })
      await cmdDoctor({}, noProbe)
      const out = logs.join('\n')
      expect(out).toContain('config.toml 可解析')
      expect(out).toContain('上游 key 可读取')
      expect(out).toContain('上游不可达')
      expect(out).toContain('模型目录为空')
      expect(out).toContain('已接管且指向网关')
      expect(out).toContain('pack 配置错误') // 坏 pack 以占位呈现，未中断其余体检项
    } finally {
      if (saved === undefined) delete process.env.MD_DOC_KEY
      else process.env.MD_DOC_KEY = saved
      h.restore()
    }
  })
})

describe('cmdDoctor --json', () => {
  it('输出可解析 JSON：findings 带稳定 id/level/msg，fix 元数据齐备', async () => {
    const h = fakeHome()
    capture()
    try {
      await mutateConfig((c) => {
        c.gateway = { port: 18941 }
        c.providers['pv'] = { name: 'PV', base_url: 'http://127.0.0.1:18999', protocol: 'anthropic', auth_style: 'bearer', key_ref: 'plain:sk-doc' }
        c.profiles['main'] = { name: 'main', provider: 'pv', default_model: 'm1' }
        c.profiles['ghost'] = { name: 'ghost', provider: 'gone' }
        c.active_profile = 'main'
      })
      await cmdDoctor({ json: true }, noProbe)
      const j = JSON.parse(logs.join('\n')) as {
        version: number
        ok: boolean
        findings: { id: string; level: string; msg: string; fix?: { kind: string; target?: string; confirm: boolean } }[]
      }
      expect(j.version).toBe(1)
      expect(j.ok).toBe(false) // 上游 18999 拒连 + 悬空 profile → bad
      const ids = j.findings.map((f) => f.id)
      expect(ids).toContain('config.parse')
      expect(ids).toContain('gateway.down')
      expect(ids).toContain('profile.dangling')
      expect(ids).toContain('models.empty')
      const down = j.findings.find((f) => f.id === 'gateway.down')!
      expect(down.level).toBe('warn')
      expect(down.fix?.kind).toBe('start-gateway')
      expect(down.fix?.confirm).toBe(false)
      for (const f of j.findings) {
        expect(typeof f.id).toBe('string')
        expect(typeof f.msg).toBe('string')
      }
    } finally {
      h.restore()
    }
  })

  it('网关未运行且配置端口被占用：port_busy 提示启动将漂移', async () => {
    const h = fakeHome()
    capture()
    try {
      await mutateConfig((c) => {
        c.gateway = { port: 18941 }
      })
      await cmdDoctor({ json: true }, { portProbe: async () => true })
      const j = JSON.parse(logs.join('\n')) as { findings: { id: string; level: string }[] }
      const f = j.findings.find((x) => x.id === 'gateway.port_busy')
      expect(f?.level).toBe('warn')
    } finally {
      h.restore()
    }
  })
})

describe('cmdDoctor --fix', () => {
  // 共用沙箱配置：pv 指向拒绝端口（拉取必失败）、ghost 悬空、active=main
  async function seedSandbox(): Promise<void> {
    await mutateConfig((c) => {
      c.gateway = { port: 18941 }
      c.providers['pv'] = { name: 'PV', base_url: 'http://127.0.0.1:18999', protocol: 'anthropic', auth_style: 'bearer', key_ref: 'plain:sk-doc' }
      c.profiles['main'] = { name: 'main', provider: 'pv', default_model: 'm1' }
      c.profiles['ghost'] = { name: 'ghost', provider: 'gone' }
      c.active_profile = 'main'
    })
  }

  it('安全项自动执行、失败不中断、需确认项默认跳过', async () => {
    const h = fakeHome()
    const savedProxy = process.env.HTTP_PROXY
    process.env.HTTP_PROXY = 'http://127.0.0.1:18998' // 触发 set-proxy 确认项
    capture()
    try {
      await seedSandbox()
      await cmdDoctor(
        { fix: true, yes: false },
        { startGateway: async () => 'http://127.0.0.1:18941', portProbe: async () => false, confirm: async () => false }
      )
      const out = logs.join('\n') + '\n' + errs.join('\n')
      expect(out).toContain('启动网关') // 自动修复：网关（fake）启动成功
      expect(out).toContain('清理悬空 profile') // 自动修复：悬空 profile 已清
      expect(out).toContain('失败') // 模型目录拉取连拒绝端口失败，不中断后续
      expect(out).toContain('已跳过 1 项') // set-proxy 确认被拒
      const cfg2 = await loadConfig()
      expect(cfg2.profiles['ghost']).toBeUndefined()
      expect(cfg2.providers['pv']?.proxy).toBeUndefined() // 确认被拒 → 不动配置
    } finally {
      if (savedProxy === undefined) delete process.env.HTTP_PROXY
      else process.env.HTTP_PROXY = savedProxy
      h.restore()
    }
  })

  it('--yes：确认项不再询问直接执行', async () => {
    const h = fakeHome()
    const savedProxy = process.env.HTTP_PROXY
    process.env.HTTP_PROXY = 'http://127.0.0.1:18998'
    capture()
    try {
      await seedSandbox()
      await cmdDoctor(
        { fix: true, yes: true },
        {
          startGateway: async () => 'http://127.0.0.1:18941',
          portProbe: async () => false,
          confirm: async () => {
            throw new Error('should not ask')
          },
        }
      )
      const cfg2 = await loadConfig()
      expect(cfg2.providers['pv']?.proxy).toBe('env')
    } finally {
      if (savedProxy === undefined) delete process.env.HTTP_PROXY
      else process.env.HTTP_PROXY = savedProxy
      h.restore()
    }
  })

  it('config 解析失败：无可修复项，只提示不执行任何修复', async () => {
    const h = fakeHome()
    capture()
    try {
      const fs = await import('node:fs')
      const path = await import('node:path')
      fs.mkdirSync(path.join(h.home, '.modeldock'), { recursive: true })
      fs.writeFileSync(path.join(h.home, '.modeldock', 'config.toml'), 'not [valid toml', 'utf8')
      await cmdDoctor({ fix: true }, noProbe)
      expect(logs.join('\n')).toContain('没有可自动执行的修复项')
    } finally {
      h.restore()
    }
  })
})

describe('verifySecretsStore', () => {
  it('secrets.json 损坏：返回可操作错误；doctor 报密钥库不可读且不崩、跳过逐条 key 检查', async () => {
    const h = fakeHome()
    capture()
    try {
      await mutateConfig((c) => {
        c.gateway = { port: 18941 }
        c.providers['pv'] = { name: 'PV', base_url: 'http://127.0.0.1:18999', protocol: 'anthropic', auth_style: 'bearer', key_ref: 'file:k1' }
        c.profiles['main'] = { name: 'main', provider: 'pv' }
        c.active_profile = 'main'
      })
      const fs = await import('node:fs')
      const path = await import('node:path')
      fs.writeFileSync(path.join(h.home, '.modeldock', 'secrets.json'), '{broken', 'utf8')
      const v = await verifySecretsStore()
      expect(v.ok).toBe(false)
      if (!v.ok) expect(v.error).toContain('secrets.json')
      await cmdDoctor({}, noProbe)
      const out = logs.join('\n')
      expect(out).toContain('secrets.json 解析失败')
      expect(out).not.toContain('上游 key 可读取') // 密钥库损坏 → 跳过逐条 key 检查，避免重复报同一根因
    } finally {
      h.restore()
    }
  })
})

describe('runFixes（直测）', () => {
  it('confirm=false 直接执行并回显细节；失败计数不中断；confirm 项按注入结果执行/跳过', async () => {
    capture()
    const ran: string[] = []
    const findings: DoctorFinding[] = [
      { id: 'x.a', level: 'warn', msg: 'x', fix: { kind: 'start-gateway', confirm: false, label: 'fakeA', run: async () => { ran.push('a'); return 'detail-a' } } },
      { id: 'x.b', level: 'warn', msg: 'x', fix: { kind: 'model-refresh', confirm: false, label: 'fakeB', run: async () => { throw new Error('boom') } } },
      { id: 'x.c', level: 'warn', msg: 'x', fix: { kind: 'set-proxy', confirm: true, label: 'fakeC', run: async () => { ran.push('c') } } },
      { id: 'x.d', level: 'warn', msg: 'x', fix: { kind: 'attach', confirm: true, label: 'fakeD', run: async () => { ran.push('d') } } },
    ]
    await runFixes(findings, { yes: false }, { confirm: async (m) => m.includes('fakeC') })
    expect(ran).toEqual(['a', 'c'])
    const all = logs.join('\n') + '\n' + errs.join('\n')
    expect(all).toContain('✓ fakeA：detail-a')
    expect(all).toContain('✗ fakeB 失败：boom')
    expect(all).toContain('已跳过 1 项')
    expect(all).toContain('成功 2 / 失败 1')
  })

  it('--yes：confirm 项不再询问全部执行', async () => {
    capture()
    const ran: string[] = []
    const findings: DoctorFinding[] = [
      { id: 'x.c', level: 'warn', msg: 'x', fix: { kind: 'set-proxy', confirm: true, label: 'fakeC', run: async () => { ran.push('c') } } },
    ]
    await runFixes(findings, { yes: true }, {
      confirm: async () => {
        throw new Error('should not ask')
      },
    })
    expect(ran).toEqual(['c'])
    expect(logs.join('\n')).not.toContain('已跳过')
  })
})

describe('cmdTest', () => {
  it('网关未运行：exit(1) 并提示先启动', async () => {
    const h = fakeHome()
    capture()
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new ExitError(code)
    }) as never)
    try {
      await expect(cmdTest(undefined, {})).rejects.toBeInstanceOf(ExitError)
      expect(errs.join('\n')).toContain('网关未运行')
    } finally {
      h.restore()
    }
  })
})

describe('loadConfig 兜底', () => {
  it('空沙箱 loadConfig 返回可写默认配置（doctor 的前置假设）', async () => {
    const h = fakeHome()
    try {
      const cfg = await loadConfig()
      expect(cfg.version).toBeGreaterThan(0)
      expect(cfg.providers).toEqual({})
    } finally {
      h.restore()
    }
  })
})
