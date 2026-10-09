import fsSync from 'node:fs'
import fsp from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { renderConsolePage } from '../src/cloud/console.js'
import { CloudStore } from '../src/cloud/store.js'
import { createCloudServer } from '../src/cloud/server.js'

const dirs: string[] = []
afterAll(async () => {
  for (const d of dirs) await fsp.rm(d, { recursive: true, force: true }).catch(() => {})
})

const HTML = renderConsolePage()

describe('云端控制台单页（M3c）', () => {
  it('内嵌 JS 语法冒烟（node --check 同源）', () => {
    const blocks = [...HTML.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1])
    expect(blocks.length).toBeGreaterThanOrEqual(1)
    for (const block of blocks) {
      expect(() => new Function(block)).not.toThrow()
    }
  })

  it('data-i18n 键双语齐全（每处都含 || 分隔的两种语言）', () => {
    const attrs = [...HTML.matchAll(/data-i18n="([^"]+)"/g)].map((m) => m[1])
    expect(attrs.length).toBeGreaterThanOrEqual(10)
    for (const a of attrs) {
      expect(a).toMatch(/.+\|\|.*/) // 中文段必填；英文段允许为空（如「版」这类量词在英文句式里省略）
    }
  })

  it('三区结构齐全：登录/设备列表/批量切换/配对码 + 手机优先约束', () => {
    for (const id of ['loginView', 'mainView', 'devList', 'allSvcSel', 'allApplyBtn', 'pairBtn', 'pairCode', 'toast']) {
      expect(HTML).toContain(`id="${id}"`)
    }
    expect(HTML).toContain('max-width:480px')
    expect(HTML).toContain('min-height:44px')
    expect(HTML).toContain('/v1/desire')
    expect(HTML).toContain('/v1/paircode')
    expect(HTML).toContain('/v1/login')
  })

  it('链路：心跳上报服务目录 → devices 返回 → 控制台可用的下拉数据源', async () => {
    const dataDir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'md-console-'))
    dirs.push(dataDir)
    const store = new CloudStore(dataDir)
    const consoleToken = 'mdkcloud_' + 'e'.repeat(32)
    const server = createCloudServer(store, { consoleToken, rateLimitPerMin: 10_000 })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const port = (server.address() as net.AddressInfo).port
    try {
      // 配对入网
      const pc = await fetch(`http://127.0.0.1:${port}/v1/paircode`, { method: 'POST', headers: { authorization: `Bearer ${consoleToken}`, 'content-type': 'application/json' }, body: '{}' })
      const code = ((await pc.json()) as { pairCode: string }).pairCode
      const pair = await fetch(`http://127.0.0.1:${port}/v1/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pairCode: code, devid: 'mdksync_a', deviceName: '笔记本' }) })
      const { deviceToken } = (await pair.json()) as { deviceToken: string }
      // 心跳带服务目录
      const hb = await fetch(`http://127.0.0.1:${port}/v1/heartbeat`, {
        method: 'POST',
        headers: { authorization: `Bearer ${deviceToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          devid: 'mdksync_a',
          version: '1.3.0',
          reportedProfile: 'ark',
          services: [
            { id: 'ark', name: '火山方舟' },
            { id: 'deepseek', name: 'DeepSeek' },
          ],
        }),
      })
      expect(hb.status).toBe(200)
      // devices 返回目录（控制台 render 的数据源）
      const list = await fetch(`http://127.0.0.1:${port}/v1/devices`, { headers: { authorization: `Bearer ${consoleToken}` } })
      const j = (await list.json()) as { devices: Array<{ devid: string; services: Array<{ id: string; name: string }>; reportedProfile: string | null }> }
      expect(j.devices[0].services).toEqual([
        { id: 'ark', name: '火山方舟' },
        { id: 'deepseek', name: 'DeepSeek' },
      ])
      expect(j.devices[0].reportedProfile).toBe('ark')
    } finally {
      server.close()
      store.close()
    }
  })
})
