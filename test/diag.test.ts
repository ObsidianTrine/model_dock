import { describe, expect, it, vi, afterEach } from 'vitest'
import { fakeHome } from './helpers.js'
import { cmdDoctor, cmdStatus, cmdTest } from '../src/cli/diag.js'
import { loadConfig, mutateConfig } from '../src/config/store.js'

// cmdDoctor/cmdStatus 是只读体检壳：无网络路径（上游可达性探测指向本地拒绝端口，瞬时失败）。
// cmdEnv/cmdTest 完整链会经 resolveClientGatewayPort 无条件探测 8687（开发机=生产实例，红线），
// 因此只覆盖 cmdTest 的 requireGateway 拒绝分支。
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
      await cmdDoctor()
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
      await cmdDoctor()
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
