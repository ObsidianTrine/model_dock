import { describe, expect, it, afterEach } from 'vitest'
import { fakeHome } from './helpers.js'
import { withFileLock } from '../src/util/fsx.js'
import { loadConfig, mutateConfig, saveConfig, configLockPath } from '../src/config/store.js'
import { emptyConfig, type Config } from '../src/config/types.js'
import { applySyncdoc, collectSyncdoc } from '../src/sync/collect.js'
import { hashDoc } from '../src/sync/runtime.js'
import type { Syncdoc } from '../src/sync/types.js'

const homes: ReturnType<typeof fakeHome>[] = []
afterEach(() => {
  while (homes.length) homes.pop()!.restore()
})

function mkHome(): string {
  const h = fakeHome()
  homes.push(h)
  return h.home
}

function remoteDoc(defaultModel: string): Syncdoc {
  return {
    fmt: 'modeldock-syncdoc',
    v: 1,
    ts: new Date().toISOString(),
    data: { providers: {}, profiles: { main: { provider: 'x', default_model: defaultModel } }, userPresets: [], scheduleRules: [] },
  }
}

function baseConfig(): Config {
  return { ...emptyConfig(), profiles: { main: { provider: 'x', default_model: 'base' } } }
}

describe('withFileLock 同路径重入（CORRECT-06 的使能原语）', () => {
  it('持有者调用树内嵌套申请同一路径：内联执行，不死锁不串行', async () => {
    mkHome()
    const r = await withFileLock(configLockPath(), undefined, async () => {
      // applySyncdoc 同款形态：持锁期间内部再 mutateConfig（同一把锁）——旧实现会排在自身后面死锁
      await withFileLock(configLockPath(), undefined, async () => undefined)
      return 'inner-ok'
    })
    expect(r).toBe('inner-ok')
  }, 10_000)

  it('不同路径嵌套照常各自排队；并发同路径保持互斥串行', async () => {
    mkHome()
    const order: string[] = []
    await withFileLock(configLockPath(), undefined, async () => {
      await withFileLock(configLockPath() + '.other', undefined, async () => {
        order.push('nested-other-path')
      })
    })
    const first = withFileLock(configLockPath(), undefined, async () => {
      await new Promise((r) => setTimeout(r, 30))
      order.push('first-done')
      return saveConfig(baseConfig())
    })
    const second = withFileLock(configLockPath(), undefined, async () => {
      order.push('second-ran')
      return loadConfig()
    })
    await Promise.all([first, second])
    expect(order.indexOf('first-done')).toBeLessThan(order.indexOf('second-ran'))
    expect(order).toContain('nested-other-path')
  })
})

describe('apply + post-apply 重收集原子性（CORRECT-06 回归守卫）', () => {
  it('持锁期间排队的本地写不会混入 after 基线；锁释放后照常落盘可见', async () => {
    mkHome()
    await saveConfig(baseConfig())
    let queued!: Promise<void>
    await withFileLock(configLockPath(), undefined, async () => {
      await applySyncdoc(remoteDoc('remote-pushed'), { backend: 'file' })
      // 并发本地写「恰好落在 apply 落盘之后、重收集之前」：排队在锁后，此刻尚未执行
      queued = mutateConfig((c) => {
        c.profiles!['main']!.default_model = 'local-concurrent'
      })
      const { doc: after } = await collectSyncdoc()
      // 基线只含远端应用态：并发写没有被吞进 lastSyncedHash（吞掉 = 该改动永不推送的静默丢失）
      expect(after.data.profiles.main?.default_model).toBe('remote-pushed')
    })
    await queued
    expect((await loadConfig()).profiles?.main?.default_model).toBe('local-concurrent')
    // 锁外重收集可见并发写：下一个 tick localHash ≠ lastSyncedHash → 正常推送，不丢失
    const { doc: after } = await collectSyncdoc()
    expect(hashDoc(after)).not.toEqual('') // sanity：collect 可用
    expect(after.data.profiles.main?.default_model).toBe('local-concurrent')
  })
})
