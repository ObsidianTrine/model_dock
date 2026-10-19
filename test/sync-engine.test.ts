import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import { CLOUD_POLL_MS, DEFAULT_DEBOUNCE_MS, DEFAULT_POLL_MS, safeSyncTick, syncTickOnce } from '../src/sync/engine.js'
import { syncJsonPath } from '../src/util/paths.js'
import { atomicWrite } from '../src/util/fsx.js'
import { fakeHome } from './helpers.js'

/** 关键不变式（src/sync/engine.ts 头注释）：同步永远不影响网关本职——
 *  参数没配好一律 'skipped' 且不联网；sync.json 坏了只有显式 tick 会抛，safeSyncTick 必须吞掉。
 *  推/拉/冲突(D6) 的端到端路径由 syncagent / synctarget / syncconflict 等文件覆盖，此处不重复。 */
describe('sync engine · 未启用时零副作用', () => {
  it('没有 sync.json → skipped，且不顺手写出一份状态文件', async () => {
    const h = fakeHome()
    try {
      expect(await syncTickOnce()).toBe('skipped')
      expect(await safeSyncTick()).toBe('skipped')
      expect(fs.existsSync(syncJsonPath())).toBe(false)
    } finally {
      h.restore()
    }
  })

  it('sync.json 损坏：手动 tick 抛可操作错误（要告诉用户改哪个文件），safeSyncTick 吞掉返回 skipped', async () => {
    const h = fakeHome()
    try {
      await atomicWrite(syncJsonPath(), '{ this is not json', 0o600)
      await expect(syncTickOnce()).rejects.toThrow(/sync\.json/)
      // 网关进程内的 tick 绝不把异常抛给调用方（同步失败不能拖累转发）
      expect(await safeSyncTick()).toBe('skipped')
    } finally {
      h.restore()
    }
  })

  it('轮询常量：cloud 心跳兼轮询，必然比 target 默认轮询更频繁；即时推防抖又短于轮询周期', () => {
    expect(CLOUD_POLL_MS).toBeLessThan(DEFAULT_POLL_MS)
    expect(DEFAULT_DEBOUNCE_MS).toBeLessThan(DEFAULT_POLL_MS)
  })
})
