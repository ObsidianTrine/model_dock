import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fakeHome } from './helpers.js'
import { loadConfig, saveConfig } from '../src/config/store.js'
import { getSecret, makeKeyRef } from '../src/config/secrets.js'
import { atomicWrite, readTextIfExists } from '../src/util/fsx.js'
import { presetsJsonPath } from '../src/util/paths.js'
import { applySyncdoc, collectSyncdoc } from '../src/sync/collect.js'
import { SYNCDOC_FMT, type Syncdoc } from '../src/sync/types.js'
import type { Config } from '../src/config/types.js'

/**
 * 测试盲区补齐：src/sync/collect.ts 分支缺口（2026-10-29 全量 coverage 实测圈出）。
 * 收集侧：presets.json 读错误（目录）、{presets:[...]} 形态透传与计数、file: 引用解析不到的
 * missingKeys 路径；应用侧：backend 三级回退的 defaultStore 一级（沙箱内恒为 file，安全）、
 * scheduleRules / userPresets 缺省分支、apply 侧 missingKeys 统计。
 * 全部显式 fakeHome；不传 keychain 类后端，绝不触碰真实钥匙串。
 */

function makeDoc(): Syncdoc {
  return {
    fmt: SYNCDOC_FMT,
    v: 1,
    ts: '2026-10-29T00:00:00.000Z',
    data: {
      providers: {
        ark: { base_url: 'https://ark.example.com/api', protocol: 'anthropic', auth_style: 'bearer', key: 'sk-ark' },
        envprov: { base_url: 'https://env.example.com', protocol: 'openai', auth_style: 'bearer', key_ref: 'env:ARK_KEY' },
      },
      profiles: { main: { provider: 'ark', default_model: 'auto' } },
      userPresets: [
        { id: 'corp', label: 'Corp', vendor: 'Corp', base_url: 'https://corp.example.com', protocol: 'openai', auth_style: 'bearer' },
      ],
      scheduleRules: [{ start: '09:00', end: '18:00', target: 'ark' }],
    },
  }
}

async function seedEmpty(): Promise<void> {
  await saveConfig({ version: 1, providers: {}, profiles: {}, harness: {} })
}

/** 机器态种子：带 schedule 启用开关与本地 presets（应用后必须保留/替换的对照物） */
async function seedMachineState(): Promise<void> {
  await saveConfig({
    version: 1,
    language: 'en',
    active_profile: 'old-route',
    security: { store: 'file' },
    providers: {},
    profiles: { 'old-route': { provider: 'stale' } },
    harness: { dsh: { mode: 'file', attached_at: '2026-02-02T00:00:00.000Z', files: ['/y'] } },
    gateway: { port: 4321, schedule: { enabled: true, windows: [{ start: '00:00', end: '23:59', target: 'stale' }] } },
  } as Config)
  await atomicWrite(presetsJsonPath(), JSON.stringify([{ id: 'old-local-preset', label: 'Old', vendor: 'Old', base_url: 'https://old.example.com', protocol: 'openai', auth_style: 'bearer' }], null, 2) + '\n')
}

describe('collectSyncdoc 收集侧缺口', () => {
  it('presets.json 是目录（读错误非 ENOENT）：抛「读取自定义预设失败（修复后重试导出）」', async () => {
    const h = fakeHome()
    try {
      await seedEmpty()
      fs.mkdirSync(presetsJsonPath(), { recursive: true })
      await expect(collectSyncdoc()).rejects.toThrow(/读取自定义预设|Failed to read the custom presets/)
      // 报错必须带文件路径与底层原因（EISDIR），可操作
      await expect(collectSyncdoc()).rejects.toThrow(/presets\.json/)
      await expect(collectSyncdoc()).rejects.toThrow(/EISDIR|directory/)
    } finally {
      h.restore()
    }
  })

  it('presets.json 为 {presets:[...]} 形态：原样随包保真 + presetCount 按内层数组计', async () => {
    const h = fakeHome()
    try {
      await seedEmpty()
      const preset = { id: 'corp', label: 'Corp', vendor: 'Corp', base_url: 'https://corp.example.com', protocol: 'openai', auth_style: 'bearer' }
      await atomicWrite(presetsJsonPath(), JSON.stringify({ presets: [preset] }, null, 2) + '\n')
      const { doc, report } = await collectSyncdoc()
      // 保真：不归一化为数组
      expect(doc.data.userPresets).toEqual({ presets: [preset] })
      expect(report.presetCount).toBe(1)
    } finally {
      h.restore()
    }
  })

  it('file: 引用解析不到（secrets 无此 id）：key 原样保留、计入 missingKeys', async () => {
    const h = fakeHome()
    try {
      await saveConfig({
        version: 1,
        providers: {
          ghost: { base_url: 'https://g.example.com', protocol: 'openai', auth_style: 'bearer', key_ref: 'file:ghost' },
        },
        profiles: { main: { provider: 'ghost' } },
        harness: {},
      } as Config)
      const { doc, report } = await collectSyncdoc()
      expect(report.missingKeys).toEqual(['ghost'])
      const g = doc.data.providers.ghost!
      expect(g.key).toBeUndefined()
      expect(g.key_ref).toBe('file:ghost')
    } finally {
      h.restore()
    }
  })

  it('presets.json 顶层对象无 presets 数组：collect 侧同样报「顶层应为数组」', async () => {
    const h = fakeHome()
    try {
      await seedEmpty()
      await atomicWrite(presetsJsonPath(), '{"foo":1}')
      await expect(collectSyncdoc()).rejects.toThrow(/顶层应为数组|must be an array at top level/)
    } finally {
      h.restore()
    }
  })
})

describe('applySyncdoc 应用侧缺口', () => {
  it('无 opts.backend 且 config 无 security.store：回退 defaultStore()（沙箱内恒为 file），key 可解析', async () => {
    const h = fakeHome()
    try {
      // 关键：不写 security.store，让 backend 三级回退走到 defaultStore()
      await saveConfig({ version: 1, providers: {}, profiles: {}, harness: {} })
      const report = await applySyncdoc(makeDoc())
      expect(report.keysRestored).toBe(1)
      const cfg = await loadConfig()
      expect(cfg.providers!.ark!.key_ref).toBe(makeKeyRef('file', 'ark'))
      expect(await getSecret(makeKeyRef('file', 'ark'))).toBe('sk-ark')
    } finally {
      h.restore()
    }
  })

  it('doc 无 scheduleRules 字段：windows 清空、「启用」开关（机器态）保留', async () => {
    const h = fakeHome()
    try {
      await seedMachineState()
      const doc = makeDoc()
      delete (doc.data as unknown as Record<string, unknown>).scheduleRules
      const report = await applySyncdoc(doc, { backend: 'file' })
      expect(report.scheduleRules).toBe(0)
      const cfg = await loadConfig()
      // loadConfig 的 normalizeGateway 会把空 windows 省略（既有行为）：表现为 undefined 视同清空
      expect(cfg.gateway?.schedule?.windows ?? []).toEqual([])
      expect(cfg.gateway?.schedule?.enabled).toBe(true)
    } finally {
      h.restore()
    }
  })

  it('doc 无 userPresets 字段：presets.json 重置为 []、presetCount=0', async () => {
    const h = fakeHome()
    try {
      await seedMachineState()
      const doc = makeDoc()
      delete (doc.data as unknown as Record<string, unknown>).userPresets
      const report = await applySyncdoc(doc, { backend: 'file' })
      expect(report.presetCount).toBe(0)
      expect(await readTextIfExists(presetsJsonPath())).toBe('[]\n')
    } finally {
      h.restore()
    }
  })

  it('doc 带「解析不到的 file: 引用」服务：apply 侧计入 missingKeys、keysRestored 只数有 key 的', async () => {
    const h = fakeHome()
    try {
      await seedMachineState()
      const doc = makeDoc()
      doc.data.providers.ghost = { base_url: 'https://g.example.com', protocol: 'openai', auth_style: 'bearer', key_ref: 'file:ghost' } as never
      // key 与 key_ref 双缺（schema 校验会拦，apply 直调时按 plain 归类、不进 missingKeys）
      doc.data.providers.bare = { base_url: 'https://b.example.com', protocol: 'openai', auth_style: 'bearer' } as never
      const report = await applySyncdoc(doc, { backend: 'file' })
      expect(report.missingKeys).toEqual(['ghost'])
      expect(report.keysRestored).toBe(1) // 只有 ark 有明文 key
      const cfg = await loadConfig()
      // 无 key 条目：key_ref 原样保留，不写 secrets
      expect(cfg.providers!.ghost!.key_ref).toBe('file:ghost')
      expect(await getSecret('file:ghost')).toBeNull()
    } finally {
      h.restore()
    }
  })

  it('userPresets 显式 null：与缺省同义，presets.json 重置为 []、presetCount=0', async () => {
    const h = fakeHome()
    try {
      await seedMachineState()
      const doc = makeDoc()
      ;(doc.data as unknown as Record<string, unknown>).userPresets = null
      const report = await applySyncdoc(doc, { backend: 'file' })
      expect(report.presetCount).toBe(0)
      expect(await readTextIfExists(presetsJsonPath())).toBe('[]\n')
    } finally {
      h.restore()
    }
  })
})
