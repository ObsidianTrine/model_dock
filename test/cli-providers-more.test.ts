import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import { fakeHome } from './helpers.js'
import {
  cmdModelCatalogRefresh,
  cmdModelList,
  cmdModelRefresh,
  cmdModelSet,
  cmdProviderAdd,
  cmdProviderList,
  cmdProviderRm,
  cmdProviderSetKey,
} from '../src/cli/providers.js'
import { loadConfig, mutateConfig } from '../src/config/store.js'
import { getSecret, setSecret } from '../src/config/secrets.js'
import { secretsPath } from '../src/util/paths.js'

// cli/providers.ts 命令壳补测（cmdProviderAdd 已由 ops-addservice.test.ts 覆盖两条委托路径）：
// 这里补 list/rm/set-key/model 系列与 add 的未知预设分支。纪律：
// ① 零 vi.mock（跨文件雷区）；key 用 'plain:' 引用避开 secrets.json 落盘（deleteSecret 对 plain
//    是 no-op，实测安全），set-key 用例固定 file 后端验证真实 setSecret。
// ② 不触网：cmdModelRefresh 用「provider 不存在」在 fetch 之前抛错；one-api 类网络分支不碰。
// ③ process.exit 桩转异常（attach-cli.test.ts 同款）。
// ④ 跨文件 mock 纪律：uninstall.test.ts 会把 config/secrets.js 的 deleteSecret mock 成桩。
//    本文件按字母序先于 uninstall 加载（c < u，与既有 store.test 等同款顺序依赖），本文件的
//    import 绑定与 providers.js 自身的 deleteSecret 引用均为真实实现，rm 用例的「file 后端
//    密钥真删」断言才成立；本文件不重复 vi.mock 该模块（同一模块禁止双文件 mock）。

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

describe('cmdProviderAdd 未知预设', () => {
  it('预设 id 不存在：exit(1) 并列明可用预设', async () => {
    const h = fakeHome()
    stubExit()
    captureConsole()
    try {
      await expect(cmdProviderAdd('nope', { key: 'k', yes: true, noFetch: true })).rejects.toBeInstanceOf(ExitError)
      expect(errs.join('\n')).toContain('未知预设')
      expect(errs.join('\n')).toContain('可用预设')
    } finally {
      h.restore()
    }
  })
})

describe('cmdProviderList', () => {
  it('空：提示添加入口', async () => {
    const h = fakeHome()
    captureConsole()
    try {
      await cmdProviderList()
      expect(logs.join('\n')).toContain('暂无 provider')
    } finally {
      h.restore()
    }
  })

  it('非空：active 路由的 provider 标 *，key 脱敏', async () => {
    const h = fakeHome()
    captureConsole()
    try {
      await seedProvider()
      await mutateConfig((c) => {
        c.providers['pv2'] = { name: 'PV2', base_url: 'https://api2.example.com', protocol: 'openai', auth_style: 'bearer', key_ref: 'env:MD_LIST_MISSING' }
        c.profiles['p1'] = { name: 'p1', provider: 'pv' }
        c.active_profile = 'p1'
      })
      await cmdProviderList()
      const out = logs.join('\n')
      expect(out).toContain('pv *')
      expect(out).toContain('***') // maskSecret：短凭据整段隐藏
      expect(out).toContain('(未设置)')
    } finally {
      h.restore()
    }
  })
})

describe('cmdProviderRm', () => {
  it('不存在：exit(1)', async () => {
    const h = fakeHome()
    stubExit()
    captureConsole()
    try {
      await expect(cmdProviderRm('ghost')).rejects.toBeInstanceOf(ExitError)
      expect(errs.join('\n')).toContain('不存在')
    } finally {
      h.restore()
    }
  })

  it('被 harness 钉定引用：exit(1) 并提示先解钉', async () => {
    const h = fakeHome()
    stubExit()
    captureConsole()
    try {
      await seedProvider()
      await mutateConfig((c) => {
        c.profiles['p1'] = { name: 'p1', provider: 'pv' }
        c.harness['generic-env'] = { mode: 'gateway', route: 'p1', token: 't' }
      })
      await expect(cmdProviderRm('pv')).rejects.toBeInstanceOf(ExitError)
      expect(errs.join('\n')).toContain('钉定')
    } finally {
      h.restore()
    }
  })

  it('无引用：删除 provider（连带级联清理），file 后端密钥条目一并清除', async () => {
    const h = fakeHome()
    captureConsole()
    try {
      await seedProvider()
      // 换成真实 file 引用：验证 rm 走 deleteSecret 真删（plain 引用是 no-op，覆盖不到）
      await setSecret('pv', 'sk-to-rm', 'file')
      await mutateConfig((c) => {
        c.providers['pv']!.key_ref = 'file:pv'
      })
      await cmdProviderRm('pv')
      const cfg = await loadConfig()
      expect(cfg.providers['pv']).toBeUndefined()
      expect(logs.join('\n')).toContain('已删除')
      // secrets.json 里的条目随 deleteSecret 清除（Windows DPAPI 批量形态同样只是 JSON 表）
      const store = JSON.parse(fs.readFileSync(secretsPath(), 'utf8')) as Record<string, string>
      expect(store).not.toHaveProperty('pv')
    } finally {
      h.restore()
    }
  })
})

describe('cmdProviderSetKey', () => {
  it('不存在：exit(1)', async () => {
    const h = fakeHome()
    stubExit()
    captureConsole()
    try {
      await expect(cmdProviderSetKey('ghost', { key: 'sk-x' })).rejects.toBeInstanceOf(ExitError)
      expect(errs.join('\n')).toContain('不存在')
    } finally {
      h.restore()
    }
  })

  it('成功：key 写入 file 后端，config 只存引用且可读回', async () => {
    const h = fakeHome()
    captureConsole()
    try {
      await seedProvider()
      await cmdProviderSetKey('pv', { key: 'sk-new-key' })
      const cfg = await loadConfig()
      expect(cfg.providers['pv']!.key_ref.startsWith('file:')).toBe(true)
      expect(await getSecret(cfg.providers['pv']!.key_ref)).toBe('sk-new-key')
      expect(logs.join('\n')).toContain('key 已更新')
    } finally {
      h.restore()
    }
  })
})

describe('cmdModelList', () => {
  it('provider 不存在：exit(1)', async () => {
    const h = fakeHome()
    stubExit()
    captureConsole()
    try {
      await expect(cmdModelList('ghost')).rejects.toBeInstanceOf(ExitError)
      expect(errs.join('\n')).toContain('不存在')
    } finally {
      h.restore()
    }
  })

  it('空目录 (空) 行 + 有模型的行同表输出', async () => {
    const h = fakeHome()
    captureConsole()
    try {
      await seedProvider()
      await mutateConfig((c) => {
        c.providers['pv'].models = { m1: { display_name: 'M1', context_window: 100, max_output: 10, capabilities: ['tools'], source: 'manual' } }
        c.providers['pv2'] = { name: 'PV2', base_url: 'https://api2.example.com', protocol: 'openai', auth_style: 'bearer', key_ref: 'plain:' }
      })
      await cmdModelList()
      const out = logs.join('\n')
      expect(out).toContain('m1')
      expect(out).toContain('(空)')
      expect(out).toContain('pv2')
    } finally {
      h.restore()
    }
  })
})

describe('cmdModelRefresh', () => {
  it('provider 不存在：fetch 前即失败，exitWithError 带可操作提示（不触网）', async () => {
    const h = fakeHome()
    stubExit()
    captureConsole()
    try {
      await expect(cmdModelRefresh('ghost')).rejects.toBeInstanceOf(ExitError)
      expect(errs.join('\n')).toContain('不存在')
      expect(errs.join('\n')).toContain('提示')
    } finally {
      h.restore()
    }
  })
})

describe('cmdModelSet 参数校验与写入', () => {
  it('--ctx 非正整数：exit(1) 带示例提示', async () => {
    const h = fakeHome()
    stubExit()
    captureConsole()
    try {
      await expect(cmdModelSet('pv', 'm1', { ctx: 0 })).rejects.toBeInstanceOf(ExitError)
      expect(errs.join('\n')).toContain('正整数')
    } finally {
      h.restore()
    }
  })

  it('--max-out 非法：exit(1)', async () => {
    const h = fakeHome()
    stubExit()
    captureConsole()
    try {
      await expect(cmdModelSet('pv', 'm1', { maxOut: -1 })).rejects.toBeInstanceOf(ExitError)
      expect(errs.join('\n')).toContain('正整数')
    } finally {
      h.restore()
    }
  })

  it('provider 不存在：mutateConfig 内抛错透传（不 exit）', async () => {
    const h = fakeHome()
    captureConsole()
    try {
      await expect(cmdModelSet('ghost', 'm1', { ctx: 100 })).rejects.toThrow('不存在')
    } finally {
      h.restore()
    }
  })

  it('成功：元数据按选项写入，cap 逗号拆分并去空白', async () => {
    const h = fakeHome()
    captureConsole()
    try {
      await seedProvider()
      await cmdModelSet('pv', 'm1', { ctx: 200000, maxOut: 8000, display: 'M One', cap: 'tools, vision,,reasoning ' })
      const cfg = await loadConfig()
      expect(cfg.providers['pv']!.models!['m1']).toMatchObject({
        context_window: 200000,
        max_output: 8000,
        display_name: 'M One',
        capabilities: ['tools', 'vision', 'reasoning'],
        source: 'manual',
      })
      expect(logs.join('\n')).toContain('元数据已更新')
    } finally {
      h.restore()
    }
  })
})

describe('cmdModelCatalogRefresh', () => {
  it('环境变量停用：exit(1) 并提示去开关重试', async () => {
    const h = fakeHome()
    stubExit()
    captureConsole()
    const saved = process.env.MODELRDOCK_DISABLE_CATALOG_FETCH
    process.env.MODELRDOCK_DISABLE_CATALOG_FETCH = '1'
    try {
      await expect(cmdModelCatalogRefresh()).rejects.toBeInstanceOf(ExitError)
      expect(errs.join('\n')).toContain('MODELRDOCK_DISABLE_CATALOG_FETCH')
    } finally {
      if (saved === undefined) delete process.env.MODELRDOCK_DISABLE_CATALOG_FETCH
      else process.env.MODELRDOCK_DISABLE_CATALOG_FETCH = saved
      h.restore()
    }
  })
})
