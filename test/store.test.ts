import { describe, expect, it, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fakeHome } from './helpers.js'
import { loadConfig, saveConfig, ConfigError, mutateConfig } from '../src/config/store.js'
import { emptyConfig, type Config } from '../src/config/types.js'
import { removeProviderCascade } from '../src/ops.js'
import {
  getSecret,
  parseKeyRef,
  setSecret,
  deleteSecret,
  setSecretsBatch,
  secretsLockPath,
  invalidateSecretsCache,
} from '../src/config/secrets.js'
import { configPath, secretsPath } from '../src/util/paths.js'
import { readTextIfExists, acquireFileLock, withFileLock, sleep } from '../src/util/fsx.js'

afterEach(() => {
  // fakeHome 的 restore 由各用例自行调用（before/after 配对）
})

describe('config store', () => {
  it('空目录返回空配置', async () => {
    const h = fakeHome()
    try {
      expect(await loadConfig()).toEqual(emptyConfig())
    } finally {
      h.restore()
    }
  })

  it('TOML 往返：别名含 * 与连字符、嵌套模型表、中文注释值', async () => {
    const h = fakeHome()
    try {
      const cfg: Config = {
        version: 1,
        active_profile: 'ark-coding',
        providers: {
          ark_coding: {
            name: '火山 Coding',
            base_url: 'https://ark.example.com/api/coding',
            protocol: 'anthropic',
            auth_style: 'bearer',
            key_ref: 'file:ark_coding',
            proxy: 'direct',
            models: {
              'deepseek-v4-flash': {
                display_name: 'DS V4 Flash',
                context_window: 131072,
                max_output: 8192,
                capabilities: ['tools'],
                source: 'preset',
              },
            },
          },
        },
        profiles: {
          'ark-coding': {
            provider: 'ark_coding',
            default_model: 'deepseek-v4-flash',
            aliases: {
              'claude-sonnet-*': 'deepseek-v4-flash',
              'claude-opus-*': 'glm-5-3',
            },
          },
        },
        harness: {
          'claude-code': { mode: 'gateway', route: 'default', token: 'mdk_test', attached_at: '2026-09-19T00:00:00Z' },
        },
      }
      await saveConfig(cfg)
      const loaded = await loadConfig()
      expect(loaded).toEqual(cfg)
    } finally {
      h.restore()
    }
  })

  it('坏 TOML 抛 ConfigError 且提示修复命令', async () => {
    const h = fakeHome()
    try {
      const { atomicWrite } = await import('../src/util/fsx.js')
      const { ensureDir } = await import('../src/util/fsx.js')
      const { modeldockDir } = await import('../src/util/paths.js')
      await ensureDir(modeldockDir())
      await atomicWrite(configPath(), 'not [valid toml\nversion = ', 0o600)
      await expect(loadConfig()).rejects.toBeInstanceOf(ConfigError)
    } finally {
      h.restore()
    }
  })

  it('mutateConfig 读改写', async () => {
    const h = fakeHome()
    try {
      await mutateConfig((c) => {
        c.providers.demo = {
          base_url: 'https://x.example.com',
          protocol: 'openai',
          auth_style: 'bearer',
          key_ref: 'file:demo',
        }
        return null
      })
      const cfg = await loadConfig()
      expect(cfg.providers.demo.base_url).toBe('https://x.example.com')
      // 文件权限 0600
      const fs = await import('node:fs/promises')
      const st = await fs.stat(configPath())
      if (process.platform === 'win32') {
        // Windows NTFS 不支持 Unix 权限位，只验证文件可读写
        expect(st.mode & 0o200).toBeGreaterThan(0)
      } else {
        expect(st.mode & 0o777).toBe(0o600)
      }
    } finally {
      h.restore()
    }
  })
})

describe('secrets', () => {
  it('file 后端写读删，文件权限 0600', async () => {
    const h = fakeHome()
    try {
      const ref = await setSecret('demo', 'sk-abc123', 'file')
      expect(ref).toBe('file:demo')
      expect(await getSecret(ref)).toBe('sk-abc123')
      const fs = await import('node:fs/promises')
      const st = await fs.stat(secretsPath())
      if (process.platform === 'win32') {
        // Windows NTFS 不支持 Unix 权限位，只验证文件可读写
        expect(st.mode & 0o200).toBeGreaterThan(0)
      } else {
        expect(st.mode & 0o777).toBe(0o600)
      }
      await deleteSecret(ref)
      expect(await getSecret(ref)).toBeNull()
    } finally {
      h.restore()
    }
  })

  it('env 与 plain 引用', async () => {
    process.env.MD_TEST_KEY = 'sk-env-1'
    try {
      expect(await getSecret('env:MD_TEST_KEY')).toBe('sk-env-1')
      expect(await getSecret('sk-inline')).toBe('sk-inline')
      expect(parseKeyRef('keychain:foo')).toEqual({ scheme: 'keychain', id: 'foo' })
    } finally {
      delete process.env.MD_TEST_KEY
    }
  })

  it('secrets.json 损坏时抛可操作报错（含文件路径），不再静默当无密钥', async () => {
    const h = fakeHome()
    try {
      const { ensureDir, atomicWrite } = await import('../src/util/fsx.js')
      const { modeldockDir } = await import('../src/util/paths.js')
      await ensureDir(modeldockDir())
      await atomicWrite(secretsPath(), 'not json', 0o600)
      await expect(setSecret('a', 'b', 'file')).rejects.toThrow(/secrets.json 解析失败|Failed to parse secrets.json/)
      // getSecret 命中缓存时仍返回旧值（既定语病）；失效后重读盘应抛同样可操作错
      invalidateSecretsCache()
      await expect(getSecret('file:a')).rejects.toThrow(/secrets\.json/)
    } finally {
      h.restore()
    }
  })

  it('readTextIfExists 对缺失文件返回 null', async () => {
    const h = fakeHome()
    try {
      expect(await readTextIfExists(`${h.home}/nope`)).toBeNull()
    } finally {
      h.restore()
    }
  })
})

describe('跨进程写锁（BUG-06/07）', () => {
  it('acquireFileLock 释放做 pid 归属校验：伪造他者 pid 不删锁，本 pid 才删锁', async () => {
    const h = fakeHome()
    try {
      // 场景 A：本进程持锁后锁内容被改写为他者 pid（模拟超时后被他进程抢占）→ release 不动他者的锁
      const lp1 = path.join(h.home, 'own.lock')
      const release1 = await acquireFileLock(lp1)
      expect(fs.readFileSync(lp1, 'utf8')).toBe(String(process.pid))
      fs.writeFileSync(lp1, '99999') // 伪造他进程 pid
      release1()
      expect(fs.existsSync(lp1)).toBe(true) // 他者的锁不被误删，第三个写者不会误入临界区
      // 清理伪造锁（为场景 B 腾出空位）
      for (let i = 0; i < 5; i++) {
        try {
          fs.unlinkSync(lp1)
          break
        } catch {
          await sleep(10)
        }
      }
      // 场景 B：锁内容仍为本进程 pid → release 正常删锁
      const lp2 = path.join(h.home, 'own2.lock')
      const release2 = await acquireFileLock(lp2)
      expect(fs.readFileSync(lp2, 'utf8')).toBe(String(process.pid))
      release2()
      expect(fs.existsSync(lp2)).toBe(false) // 本进程锁被删除
    } finally {
      h.restore()
    }
  })

  it('secrets 写路径经 withFileLock 互斥调用序（后一个临界区等前一个释放才进入）', async () => {
    const h = fakeHome()
    try {
      const lp = secretsLockPath()
      const order: string[] = []
      let unlock1: () => void = () => {}
      const gate1 = new Promise<void>((r) => (unlock1 = r))
      const p1 = withFileLock(lp, undefined, async () => {
        order.push('job1-start')
        await gate1
        order.push('job1-end')
      }).then(() => order.push('job1-done'))
      await sleep(20) // 让 job1 抢到锁、进入临界区
      const p2 = withFileLock(lp, undefined, async () => {
        order.push('job2')
      })
      await sleep(20)
      expect(order).toEqual(['job1-start']) // job2 被锁串行挡住，未执行
      unlock1()
      await p1
      await p2
      expect(order).toEqual(['job1-start', 'job1-end', 'job1-done', 'job2'])
    } finally {
      h.restore()
    }
  })

  it('并发 setSecret/setSecretsBatch 写入同一 secrets.json，键互不丢失', async () => {
    const h = fakeHome()
    try {
      await Promise.all([
        setSecret('a', 'va', 'file'),
        setSecret('b', 'vb', 'file'),
        setSecretsBatch({ c: 'vc' }, 'file'),
      ])
      expect(await getSecret('file:a')).toBe('va')
      expect(await getSecret('file:b')).toBe('vb')
      expect(await getSecret('file:c')).toBe('vc')
    } finally {
      h.restore()
    }
  })
})

describe('整表加密 cipher 描述符（DUP-07 合并后）', () => {
  it('machine 加密→解密往返无损（加密非空、空值透传、已带前缀不二次加密）', async () => {
    const h = fakeHome()
    try {
      const { machCipher } = await import('../src/config/secrets.js')
      const enc = await machCipher.encryptTable({ a: 'sk-1', b: '', c: 'enc:mach:already' })
      expect(enc.a).toMatch(/^enc:mach:/) // 非空值被整表加密
      expect(enc.b).toBe('') // 空值原样保留
      expect(enc.c).toBe('enc:mach:already') // 已带前缀不二次加密
      // 仅对真实加密的条目做往返（假前缀条目不喂进解密，避免塞无效密文）
      const dec = await machCipher.decryptTable({ a: enc.a, b: enc.b })
      expect(dec.a).toBe('sk-1')
      expect(dec.b).toBe('')
    } finally {
      h.restore()
    }
  })
})

describe('mutateConfig 并发', () => {
  it('同进程并发调用互不丢更新（串行化 + 锁）', async () => {
    const h = fakeHome()
    try {
      await saveConfig(emptyConfig())
      await Promise.all([
        mutateConfig((c) => {
          c.providers['a'] = { base_url: 'https://a.example.com', protocol: 'anthropic', auth_style: 'bearer', key_ref: 'file:a' }
        }),
        mutateConfig((c) => {
          c.providers['b'] = { base_url: 'https://b.example.com', protocol: 'anthropic', auth_style: 'bearer', key_ref: 'file:b' }
        }),
      ])
      const cfg = await loadConfig()
      expect(cfg.providers['a']).toBeTruthy()
      expect(cfg.providers['b']).toBeTruthy()
    } finally {
      h.restore()
    }
  })

  it('removeProviderCascade：删除 provider 级联清理路由/备用链/自动路由/定时窗口', () => {
    const cfg = emptyConfig()
    cfg.providers['gone'] = { base_url: 'https://g.example.com', protocol: 'anthropic', auth_style: 'bearer', key_ref: 'file:g' }
    cfg.providers['keep'] = { base_url: 'https://k.example.com', protocol: 'openai', auth_style: 'bearer', key_ref: 'file:k' }
    cfg.profiles['p1'] = { provider: 'gone', default_model: 'm1', fallback: ['gone:alt', 'keep'] }
    cfg.profiles['p2'] = { provider: 'keep', fallback: ['gone'] }
    cfg.active_profile = 'p1'
    cfg.gateway = {
      auto_route_provider: 'gone',
      schedule: {
        windows: [
          { start: '00:30', end: '08:30', target: 'gone:m1' },
          { start: '09:00', end: '12:00', target: 'gone', mode: 'avoid' },
          { start: '14:00', end: '18:00', target: 'keep:km' },
        ],
      },
    }
    const removed = removeProviderCascade(cfg, 'gone')
    expect(removed).toEqual(['p1'])
    expect(cfg.providers['gone']).toBeUndefined()
    expect(cfg.profiles['p1']).toBeUndefined()
    expect(cfg.active_profile).toBeUndefined()
    expect(cfg.gateway!.auto_route_provider).toBeUndefined()
    // p2 备用链只剩 gone 条目 → 清空后整键删除
    expect(cfg.profiles['p2'].fallback).toBeUndefined()
    // 定时窗口：含 gone 的两条被剔除，keep 的保留
    expect(cfg.gateway!.schedule!.windows).toEqual([{ start: '14:00', end: '18:00', target: 'keep:km' }])
  })

  it('加载规范化（日类型模型）：旧节假日名单丢弃、days 简写迁移为 dayFilter，其余 days 组合保留', async () => {
    const h = fakeHome()
    try {
      // 直接落盘旧版配置文本（含已退役的 holidays 名单与 days 简写），再走 loadConfig 规范化
      fs.mkdirSync(path.dirname(configPath()), { recursive: true })
      fs.writeFileSync(configPath(), `version = 1
active_profile = "demo"
[gateway.schedule]
enabled = true
holidays = ["2026-10-01", "2026-10-02"]

[[gateway.schedule.windows]]
start = "09:00"
end = "12:00"
target = "deepseek"
mode = "avoid"
days = [1, 2, 3, 4, 5]

[[gateway.schedule.windows]]
start = "13:00"
end = "14:00"
target = "deepseek"
days = [6, 7]

[[gateway.schedule.windows]]
start = "20:00"
end = "22:00"
target = "agent"
days = [1, 3]

[[gateway.schedule.windows]]
start = "22:00"
end = "23:00"
target = "agent"
`)
      const cfg = await loadConfig()
      // 旧「节假日名单」退役：键整体消失（名单日语义由 dayFilter 表达）
      expect((cfg.gateway!.schedule as unknown as Record<string, unknown>).holidays).toBeUndefined()
      // days=[1..5]（旧「工作日」简写）→ dayFilter=workday：节假日不再生效（既定迁移语义）
      expect(cfg.gateway!.schedule!.windows![0]).toEqual({ start: '09:00', end: '12:00', target: 'deepseek', mode: 'avoid', dayFilter: 'workday' })
      // days=[6,7]（旧「周末」简写）→ dayFilter=weekend
      expect(cfg.gateway!.schedule!.windows![1]).toEqual({ start: '13:00', end: '14:00', target: 'deepseek', dayFilter: 'weekend' })
      // 非简写的 days 组合与无 days 窗口原样保留
      expect(cfg.gateway!.schedule!.windows![2]).toEqual({ start: '20:00', end: '22:00', target: 'agent', days: [1, 3] })
      expect(cfg.gateway!.schedule!.windows![3]).toEqual({ start: '22:00', end: '23:00', target: 'agent' })
      // 规范化幂等：再保存/加载一轮不再变形
      await saveConfig(cfg)
      const cfg2 = await loadConfig()
      expect(cfg2.gateway!.schedule).toEqual(cfg.gateway!.schedule)
    } finally {
      h.restore()
    }
  })
})
