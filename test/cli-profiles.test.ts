import { afterEach, describe, expect, it, vi } from 'vitest'
import { fakeHome } from './helpers.js'
import { cmdProfileAdd, cmdProfileList, cmdProfileRm, cmdProfileUse } from '../src/cli/profiles.js'
import { loadConfig, mutateConfig } from '../src/config/store.js'

// cli/profiles.ts 是 profile 增删改查的 CLI 壳。纪律：
// ① 全部用例用显式参数（--provider/--model/--name/--aliases）驱动，不经 @inquirer 交互；
//   唯一需要确认流的 cmdProfileRm(active) 用 vi.mock 的 confirm 桩控制。
// ② 本文件对 '@inquirer/prompts' 的 mock 只替换 confirm（其余原样）；本文件内用
//    mockImplementationOnce 逐用例翻转。profiles.ts 全仓只有本文件 import，桩只约束本文件的
//    求值；仓库其余测试也不在任何路径上触达真实 confirm（已核），无外溢风险。
// ③ process.exit(1) 用 exit 桩转异常断言（attach-cli.test.ts 同款），绝不真退进程。
vi.mock('@inquirer/prompts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@inquirer/prompts')>()),
  confirm: vi.fn(async () => true),
}))
import { confirm } from '@inquirer/prompts'

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

/** 种一个可用的 provider（file 密钥后端 + plain key 引用，不触 secrets 文件） */
async function seedProvider(): Promise<void> {
  await mutateConfig((c) => {
    c.security = { store: 'file' }
    c.providers['pv'] = {
      name: 'PV',
      base_url: 'https://api.example.com',
      protocol: 'anthropic',
      auth_style: 'bearer',
      key_ref: 'plain:sk-pv',
    }
  })
}

describe('cmdProfileAdd（显式参数驱动，不经交互）', () => {
  it('还没有 provider：exit(1) 并提示先 provider add', async () => {
    const h = fakeHome()
    stubExit()
    captureConsole()
    try {
      await expect(cmdProfileAdd(undefined, {})).rejects.toBeInstanceOf(ExitError)
      expect(errs.join('\n')).toContain('还没有 provider')
    } finally {
      h.restore()
    }
  })

  it('--provider 指向不存在的 provider：exit(1)', async () => {
    const h = fakeHome()
    stubExit()
    captureConsole()
    try {
      await seedProvider()
      await expect(cmdProfileAdd('pn', { provider: 'ghost', model: 'm1' })).rejects.toBeInstanceOf(ExitError)
      expect(errs.join('\n')).toContain('不存在')
    } finally {
      h.restore()
    }
  })

  it('profile 重名：exit(1)', async () => {
    const h = fakeHome()
    stubExit()
    captureConsole()
    try {
      await seedProvider()
      await cmdProfileAdd('p1', { provider: 'pv', model: 'm1' })
      await expect(cmdProfileAdd('p1', { provider: 'pv', model: 'm1' })).rejects.toBeInstanceOf(ExitError)
      expect(errs.join('\n')).toContain('已存在')
    } finally {
      h.restore()
    }
  })

  it('全参数成功创建：别名解析（含格式错误条目告警）、未设 active 时给出 use 指引', async () => {
    const h = fakeHome()
    captureConsole()
    try {
      await seedProvider()
      await cmdProfileAdd('p1', { provider: 'pv', model: 'm1', aliases: 'sonnet*=m1,opus*=m2,bad-entry' })
      const cfg = await loadConfig()
      expect(cfg.profiles['p1']).toMatchObject({ name: 'p1', provider: 'pv', default_model: 'm1' })
      expect(cfg.profiles['p1']!.aliases).toEqual({ 'sonnet*': 'm1', 'opus*': 'm2' })
      expect(errs.join('\n')).toContain('忽略格式错误的别名条目')
      expect(logs.join('\n')).toContain('profile「p1」已创建')
      expect(logs.join('\n')).toContain('设为默认路由') // 无 active_profile 时的指引分支
    } finally {
      h.restore()
    }
  })

  it('别名全部格式错误：忽略全部且不写 aliases 字段', async () => {
    const h = fakeHome()
    captureConsole()
    try {
      await seedProvider()
      await cmdProfileAdd('p2', { provider: 'pv', model: 'm1', aliases: 'bad1,bad2' })
      const cfg = await loadConfig()
      expect(cfg.profiles['p2']!.aliases).toBeUndefined()
      expect(errs.join('\n')).toContain('忽略格式错误的别名条目')
    } finally {
      h.restore()
    }
  })
})

describe('cmdProfileUse', () => {
  it('不存在：exit(1) 并列出现有 profile', async () => {
    const h = fakeHome()
    stubExit()
    captureConsole()
    try {
      await expect(cmdProfileUse('nope')).rejects.toBeInstanceOf(ExitError)
      expect(errs.join('\n')).toContain('不存在')
    } finally {
      h.restore()
    }
  })

  it('成功切换：写 active_profile，无已接入烤模型客户端时静默收场', async () => {
    const h = fakeHome()
    captureConsole()
    try {
      await seedProvider()
      await mutateConfig((c) => {
        c.profiles['p1'] = { name: 'p1', provider: 'pv', default_model: 'm1' }
        c.profiles['p2'] = { name: 'p2', provider: 'pv', default_model: 'm1' }
      })
      await cmdProfileUse('p1')
      const cfg = await loadConfig()
      expect(cfg.active_profile).toBe('p1')
      expect(logs.join('\n')).toContain('默认路由已切换为「p1」')
      expect(logs.join('\n')).toContain('网关模式下立即生效')
    } finally {
      h.restore()
    }
  })
})

describe('cmdProfileList', () => {
  it('空列表：提示创建入口', async () => {
    const h = fakeHome()
    captureConsole()
    try {
      await cmdProfileList()
      expect(logs.join('\n')).toContain('暂无 profile')
    } finally {
      h.restore()
    }
  })

  it('非空：active profile 标 *', async () => {
    const h = fakeHome()
    captureConsole()
    try {
      await seedProvider()
      await mutateConfig((c) => {
        c.profiles['p1'] = { name: 'p1', provider: 'pv' }
        c.active_profile = 'p1'
      })
      await cmdProfileList()
      const out = logs.join('\n')
      expect(out).toContain('p1 *')
      expect(out).toContain('pv')
    } finally {
      h.restore()
    }
  })
})

describe('cmdProfileRm', () => {
  it('不存在：exit(1)', async () => {
    const h = fakeHome()
    stubExit()
    captureConsole()
    try {
      await expect(cmdProfileRm('nope')).rejects.toBeInstanceOf(ExitError)
      expect(errs.join('\n')).toContain('不存在')
    } finally {
      h.restore()
    }
  })

  it('被钉定：exit(1) 并提示先解钉', async () => {
    const h = fakeHome()
    stubExit()
    captureConsole()
    try {
      await seedProvider()
      await mutateConfig((c) => {
        c.profiles['p1'] = { name: 'p1', provider: 'pv' }
        c.harness['generic-env'] = { mode: 'gateway', route: 'p1', token: 't' }
      })
      await expect(cmdProfileRm('p1')).rejects.toBeInstanceOf(ExitError)
      expect(errs.join('\n')).toContain('钉定')
      expect(errs.join('\n')).toContain('route')
    } finally {
      h.restore()
    }
  })

  it('非 active 直接删除；file 模式 harness 的 route 一并复位为 default', async () => {
    const h = fakeHome()
    captureConsole()
    try {
      await seedProvider()
      await mutateConfig((c) => {
        c.profiles['p1'] = { name: 'p1', provider: 'pv' }
        c.harness['generic-env'] = { mode: 'file', route: 'p1', token: 't' }
      })
      await cmdProfileRm('p1')
      const cfg = await loadConfig()
      expect(cfg.profiles['p1']).toBeUndefined()
      expect(cfg.harness['generic-env']!.route).toBe('default')
      expect(logs.join('\n')).toContain('已删除')
    } finally {
      h.restore()
    }
  })

  it('active profile：确认取消则原样保留', async () => {
    const h = fakeHome()
    captureConsole()
    try {
      await seedProvider()
      await mutateConfig((c) => {
        c.profiles['p1'] = { name: 'p1', provider: 'pv' }
        c.active_profile = 'p1'
      })
      vi.mocked(confirm).mockImplementationOnce(async () => false)
      await cmdProfileRm('p1')
      const cfg = await loadConfig()
      expect(cfg.profiles['p1']).toBeDefined()
      expect(cfg.active_profile).toBe('p1')
    } finally {
      h.restore()
    }
  })

  it('active profile：确认通过则删除并清空 active_profile', async () => {
    const h = fakeHome()
    captureConsole()
    try {
      await seedProvider()
      await mutateConfig((c) => {
        c.profiles['p1'] = { name: 'p1', provider: 'pv' }
        c.active_profile = 'p1'
      })
      await cmdProfileRm('p1') // mock confirm 默认 true
      const cfg = await loadConfig()
      expect(cfg.profiles['p1']).toBeUndefined()
      expect(cfg.active_profile).toBeUndefined()
      expect(logs.join('\n')).toContain('已删除')
    } finally {
      h.restore()
    }
  })
})
