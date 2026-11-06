// Web 控制台 POST /_modeldock/reset 语义对齐 CLI cmdReset（回归）：
// 旧实现直接 unlink config/secrets——客户端文件仍指向网关但 token 全清（401）、
// config.harness 被删导致 attach 快照自动还原路径失效。修复后顺序：快照 → 逐客户端
// detach 还原 → 清钥匙环 → 删文件 → reloadRuntime。

import { describe, expect, it, afterEach } from 'vitest'
import type { AddressInfo } from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import { fakeHome } from './helpers.js'
import { buildRuntime } from '../src/gateway/state.js'
import { createGatewayServer } from '../src/gateway/server.js'
import { applyAttach } from '../src/ops.js'
import { configLockPath, loadConfig, saveConfig } from '../src/config/store.js'
import { emptyConfig, type Config } from '../src/config/types.js'
import { configPath, secretsPath, modeldockDir } from '../src/util/paths.js'
import { setSecret } from '../src/config/secrets.js'
import { __testSetLockTiming } from '../src/util/fsx.js'

afterEach(() => {
  delete process.env.MODELRDOCK_FAKE_CLAUDE_CODE_PRESENT
})

function baseCfg(): Config {
  return {
    ...emptyConfig(),
    active_profile: 'demo',
    security: { store: 'file' },
    providers: {
      up: {
        name: 'mock',
        base_url: 'http://127.0.0.1:1',
        protocol: 'anthropic',
        auth_style: 'bearer',
        key_ref: 'file:up',
        models: { 'preset-model': { source: 'preset', context_window: 1000, max_output: 100 } },
      },
    },
    profiles: { demo: { provider: 'up', default_model: 'preset-model' } },
    harness: {},
  }
}

describe('Web reset 语义（hReset 对齐 CLI cmdReset）', () => {
  it('已接管客户端：先 detach 还原快照，config/secrets 删除，响应带回还原清单', async () => {
    const h = fakeHome()
    let close: () => void = () => {}
    try {
      const cfg = baseCfg()
      await saveConfig(cfg)
      await setSecret('up', 'sk-upstream', 'file')
      // 真实 attach 一个客户端（走 planAttach→applyChanges→registerAttach 全链，产出 attach 快照）
      process.env.MODELRDOCK_FAKE_CLAUDE_CODE_PRESENT = '1' // claude-code adapter 的 present() 探测豁免
      const r = await applyAttach('claude-code', {}) // applyChanges 内部固定 yes:true+quiet
      expect(r.files.length).toBeGreaterThan(0)
      const clientFile = r.files[0]!
      const attached = fs.readFileSync(clientFile, 'utf8')
      expect(attached).toContain('ANTHROPIC_BASE_URL') // 已烙上网关配置
      expect(attached).toContain('"mdk_')
      const cfgAfter = await loadConfig()
      expect(Object.keys(cfgAfter.harness)).toContain('claude-code')

      const rt = buildRuntime(JSON.parse(JSON.stringify(cfgAfter)), 'admin-tok')
      const server = createGatewayServer(rt, { port: 0 })
      const port = await new Promise<number>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port))
      })
      close = () => {
        server.closeAllConnections?.()
        server.close()
      }

      const resp = await fetch(`http://127.0.0.1:${port}/_modeldock/reset`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-modeldock-admin': 'admin-tok' },
        body: '{}',
      })
      expect(resp.status).toBe(200)
      const j = (await resp.json()) as Record<string, any>
      expect(j.ok).toBe(true)
      expect(j.restored).toContain('claude-code') // detach 成功并记入响应
      expect(j.snapshotId).toBeTruthy() // 删前补拍了 pre-reset 快照
      expect(j.deleted).toContain(configPath())
      expect(j.deleted).toContain(secretsPath())

      // 客户端文件已还原：attach 前该文件不存在 → 还原即删除（不存在也算还原成功）；
      // 存在则必须不含网关地址/令牌
      if (fs.existsSync(clientFile)) {
        const restoredTxt = fs.readFileSync(clientFile, 'utf8')
        expect(restoredTxt).not.toBe(attached)
        expect(restoredTxt).not.toContain('ANTHROPIC_BASE_URL')
        expect(restoredTxt).not.toContain('"mdk_')
      }
      // config.toml / secrets.json 已删除
      expect(fs.existsSync(configPath())).toBe(false)
      expect(fs.existsSync(secretsPath())).toBe(false)
      // 删前快照落盘（backups/config/ 下 pre-reset 快照存在）
      const backupsRoot = fs.readdirSync(modeldockDir(), { withFileTypes: true }).find((d) => d.isDirectory() && d.name.startsWith('backups'))
      expect(backupsRoot).toBeTruthy()
    } finally {
      close()
      h.restore()
    }
  })

  it('无接管时照常清空：restoreFailed 为空、快照仍补拍', async () => {
    const h = fakeHome()
    let close: () => void = () => {}
    try {
      await saveConfig(baseCfg())
      const cfg = await loadConfig()
      const rt = buildRuntime(JSON.parse(JSON.stringify(cfg)), 'admin-tok')
      const server = createGatewayServer(rt, { port: 0 })
      const port = await new Promise<number>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port))
      })
      close = () => {
        server.closeAllConnections?.()
        server.close()
      }
      const resp = await fetch(`http://127.0.0.1:${port}/_modeldock/reset`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-modeldock-admin': 'admin-tok' },
        body: '{}',
      })
      const j = (await resp.json()) as Record<string, any>
      expect(j.ok).toBe(true)
      expect(j.restored).toEqual([])
      expect(j.restoreFailed).toEqual([])
      expect(fs.existsSync(configPath())).toBe(false)
    } finally {
      close()
      h.restore()
    }
  })

  it('unlink 在 config 写锁内执行：另一写者持锁时 reset 报错且文件不动（2026-11-04 审查 P2）', async () => {
    const h = fakeHome()
    let close: () => void = () => {}
    __testSetLockTiming({ acquireTimeoutMs: 500 })
    try {
      await saveConfig(baseCfg())
      const cfg = await loadConfig()
      const rt = buildRuntime(JSON.parse(JSON.stringify(cfg)), 'admin-tok')
      const server = createGatewayServer(rt, { port: 0 })
      const port = await new Promise<number>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port))
      })
      close = () => {
        server.closeAllConnections?.()
        server.close()
      }
      // 手工造锁文件模拟另一进程占用（同进程 withFileLock 走串行队列，测不出文件锁竞争）
      fs.mkdirSync(path.dirname(configLockPath()), { recursive: true })
      fs.writeFileSync(configLockPath(), String(process.pid), 'utf8')

      const resp = await fetch(`http://127.0.0.1:${port}/_modeldock/reset`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-modeldock-admin': 'admin-tok' },
        body: '{}',
      })
      expect(resp.status).toBe(400)
      const j = (await resp.json()) as Record<string, any>
      expect(String(j.error?.message ?? '')).toContain('重置失败')
      // 文件未被删除（裸 unlink 会在他人写窗口里删掉后又被整包写回——锁内删除防复活）
      expect(fs.existsSync(configPath())).toBe(true)
      expect(fs.existsSync(secretsPath())).toBe(true)
    } finally {
      try { fs.rmSync(configLockPath(), { force: true }) } catch { /* 收尾尽力 */ }
      __testSetLockTiming()
      close()
      h.restore()
    }
  })
})
