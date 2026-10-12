import { describe, expect, it, vi, afterEach } from 'vitest'
import { fakeHome } from './helpers.js'
import { cmdDetach, cmdHarnessRoute, cmdRestore, cmdToken } from '../src/cli/harness.js'
import { loadConfig, mutateConfig } from '../src/config/store.js'

// cli/harness.ts 是 attach/detach 的 CLI 壳。注意两条测试纪律：
// ① cmdAttach 完整链路不能在测试里跑：ops.resolveClientGatewayPort 会无条件探测
//    DEFAULT_GATEWAY_PORT(8687) 的 health——在开发机上就是生产实例，触碰端口红线。
//    因此这里覆盖壳的无网络路径（token/route/detach/restore 错误分支与登记读写），
//    attach 管线本体（planAttach→applyChanges→registerAttach）由 install.test.ts 以显式
//    gatewayPort 覆盖。此探测行为是已知的可测性缺口（见交付说明）。
// ② 这些命令用 process.exit(1) 报错，进程内直接调会杀死 vitest worker——用 exit 桩转成异常断言。
class ExitError extends Error {
  constructor(public code: number | undefined) {
    super(`exit:${code}`)
  }
}

function stubExit(): void {
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new ExitError(code)
  }) as never)
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

afterEach(() => {
  vi.mocked(process.exit).mockRestore?.()
  vi.mocked(console.log).mockRestore?.()
  vi.mocked(console.error).mockRestore?.()
})

async function seedHarness(entry: Record<string, unknown>): Promise<void> {
  await mutateConfig((c) => {
    c.harness['generic-env'] = entry as never
  })
}

describe('cli/harness 壳（token / route / detach / restore）', () => {
  it('cmdToken：未接管 exit(1) 并提示先 attach；已接管原样输出 token', async () => {
    const h = fakeHome()
    stubExit()
    captureConsole()
    try {
      await expect(cmdToken('generic-env')).rejects.toBeInstanceOf(ExitError)
      expect(errs.join('\n')).toContain('未被接管')
      expect(errs.join('\n')).toContain('attach generic-env')

      await seedHarness({ mode: 'gateway', token: 'mdk_generic_env_seed' })
      logs = []
      await cmdToken('generic-env')
      expect(logs.join('\n')).toContain('mdk_generic_env_seed')
    } finally {
      h.restore()
    }
  })

  it('cmdHarnessRoute 只读展示：跟随全局 / 钉定 profile', async () => {
    const h = fakeHome()
    captureConsole()
    try {
      await seedHarness({ mode: 'gateway', token: 't' })
      await cmdHarnessRoute('generic-env')
      expect(logs.join('\n')).toContain('跟随全局')

      await mutateConfig((c) => {
        c.profiles['p1'] = { name: 'p1', provider: 'pv', default_model: 'm1' }
        c.harness['generic-env']!.route = 'p1'
      })
      logs = []
      await cmdHarnessRoute('generic-env')
      expect(logs.join('\n')).toContain('已钉到 profile「p1」')
    } finally {
      h.restore()
    }
  })

  it('cmdHarnessRoute 钉定：写 route 进配置；不存在的 profile / file 模式 exit(1)', async () => {
    const h = fakeHome()
    stubExit()
    captureConsole()
    try {
      await mutateConfig((c) => {
        c.profiles['p1'] = { name: 'p1', provider: 'pv', default_model: 'm1' }
      })
      await seedHarness({ mode: 'gateway', token: 't' })
      await cmdHarnessRoute('generic-env', 'p1')
      const cfg = await loadConfig()
      expect(cfg.harness['generic-env']?.route).toBe('p1')

      await expect(cmdHarnessRoute('generic-env', 'nope')).rejects.toBeInstanceOf(ExitError)
      expect(errs.join('\n')).toContain('不存在')

      await mutateConfig((c) => {
        c.harness['generic-env']!.mode = 'file'
      })
      errs = []
      await expect(cmdHarnessRoute('generic-env', 'p1')).rejects.toBeInstanceOf(ExitError)
      expect(errs.join('\n')).toContain('不支持钉定')
    } finally {
      h.restore()
    }
  })

  it('cmdDetach：未接管 exit(1)；已接管 --yes 走反向清理并删除登记', async () => {
    const h = fakeHome()
    stubExit()
    captureConsole()
    try {
      await expect(cmdDetach('generic-env', { yes: true })).rejects.toBeInstanceOf(ExitError)
      expect(errs.join('\n')).toContain('未被 ModelDock 接管')

      await seedHarness({ mode: 'gateway', token: 't' })
      logs = []
      await cmdDetach('generic-env', { yes: true })
      expect(logs.join('\n')).toContain('已从 ModelDock 分离')
      const cfg = await loadConfig()
      expect(cfg.harness['generic-env']).toBeUndefined()
    } finally {
      h.restore()
    }
  })

  it('cmdRestore：非法 id（路径遍历）直接 exit(1)', async () => {
    const h = fakeHome()
    stubExit()
    captureConsole()
    try {
      await expect(cmdRestore('../evil', undefined, {})).rejects.toBeInstanceOf(ExitError)
      expect(errs.join('\n')).toContain('无效的客户端 id')
    } finally {
      h.restore()
    }
  })
})
