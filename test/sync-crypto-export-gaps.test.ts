import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { fakeHome } from './helpers.js'
import {
  deriveSyncKeys,
  openEnvelope,
  openWithKeys,
  sealEnvelope,
  sealWithKeys,
  verifyHmacWithKeys,
  type SyncKeys,
} from '../src/sync/crypto.js'
import { ENVELOPE_FMT, SYNCDOC_FMT, type Syncdoc } from '../src/sync/types.js'
import { exportFileName, previewImport, reportOfDoc } from '../src/sync/exportImport.js'

/**
 * 测试盲区补齐：src/sync/crypto.ts 与 src/sync/exportImport.ts 错误分支（2026-10-29 全量 coverage 实测圈出）。
 * crypto：openWithKeys / openEnvelope 的入参形状、缺字段、ct 过短、解密后文档调包、HMAC 长度不符；
 * exportImport：previewImport 文件缺失与信封元数据缺省、reportOfDoc 的 userPresets/scheduleRules
 * 缺省与 {presets} 形态、无 key_ref 服务的 missingKeys 归类。
 */

function sampleDoc(): Syncdoc {
  return {
    fmt: SYNCDOC_FMT,
    v: 1,
    ts: '2026-10-29T00:00:00.000Z',
    data: {
      providers: {
        ark: { base_url: 'https://ark.example.com/api', protocol: 'anthropic', auth_style: 'bearer', key: 'sk-test' },
      },
      profiles: { main: { provider: 'ark' } },
      userPresets: [],
      scheduleRules: [],
    },
  }
}

/** 调包文档：结构合法但 fmt 不是 syncdoc（解密成功后 fmt 校验应拦下） */
function swappedDoc(): Syncdoc {
  return { fmt: 'other-fmt', v: 1, ts: 'x', data: sampleDoc().data } as unknown as Syncdoc
}

function fixedKeys(): SyncKeys {
  return deriveSyncKeys('pw-gaps', Buffer.alloc(16, 1), Buffer.alloc(32, 2))
}

describe('openWithKeys 错误分支（缺口补齐）', () => {
  it('入参非对象（null / 字符串 / 数组）拒绝', () => {
    const keys = fixedKeys()
    expect(() => openWithKeys(null, keys)).toThrow(/不是合法的 JSON 对象|not a valid JSON object/)
    expect(() => openWithKeys('str', keys)).toThrow(/不是合法的 JSON 对象/)
    expect(() => openWithKeys([1], keys)).toThrow(/不是合法的 JSON 对象/)
  })

  it('缺信封字段（删 iv）：报「缺少加密封装字段」', () => {
    const keys = fixedKeys()
    const env = sealWithKeys(sampleDoc(), keys) as unknown as Record<string, unknown>
    delete env.iv
    expect(() => openWithKeys(env, keys)).toThrow(/缺少加密封装字段|missing envelope fields/)
  })

  it('ct 少于 17 字节（GCM tag 都放不下）：报「内容校验失败」', () => {
    const keys = fixedKeys()
    const env = sealWithKeys(sampleDoc(), keys)
    const short = { ...env, ct: Buffer.alloc(3, 7).toString('base64') }
    expect(() => openWithKeys(short, keys)).toThrow(/内容校验失败|tampered with or .*corrupted/)
  })

  it('解密成功但文档 fmt 被调包：报「不是 ModelDock 配置文档」', () => {
    const keys = fixedKeys()
    const env = sealWithKeys(swappedDoc(), keys)
    expect(() => openWithKeys(env, keys)).toThrow(/不是 ModelDock 配置文档|may have been swapped/)
  })
})

describe('openEnvelope 错误分支（缺口补齐）', () => {
  it('入参数组拒绝', () => {
    expect(() => openEnvelope([1], 'pw')).toThrow(/不是合法的 JSON 对象|not a valid JSON object/)
  })

  it('fmt 缺失：报错文案 fmt 为空串占位；v 缺失：版本不支持文案 v 为空串占位', () => {
    expect(() => openEnvelope({ v: 1 } as unknown as Record<string, unknown>, 'pw')).toThrow(/fmt=/)
    expect(() => openEnvelope({ fmt: ENVELOPE_FMT } as unknown as Record<string, unknown>, 'pw')).toThrow(/版本不支持|Unsupported package format version/)
  })

  it('缺 kdf：报「缺少加密封装字段」', () => {
    const env = sealEnvelope(sampleDoc(), 'pw-gaps') as unknown as Record<string, unknown>
    delete env.kdf
    expect(() => openEnvelope(env, 'pw-gaps')).toThrow(/缺少加密封装字段|missing envelope fields/)
  })

  it('ct 少于 17 字节（verifier 仍匹配）：报「内容校验失败」', () => {
    const env = sealEnvelope(sampleDoc(), 'pw-gaps')
    const short = { ...env, ct: Buffer.alloc(3, 7).toString('base64') }
    expect(() => openEnvelope(short, 'pw-gaps')).toThrow(/内容校验失败|tampered with or .*corrupted/)
  })

  it('解密成功但文档 fmt 被调包：报「不是 ModelDock 配置文档」', () => {
    const env = sealEnvelope(swappedDoc(), 'pw-gaps')
    expect(() => openEnvelope(env, 'pw-gaps')).toThrow(/不是 ModelDock 配置文档|may have been swapped/)
  })

  it('verifyHmacWithKeys：hmac 长度不符（不足 32 字节）直接判失败', () => {
    const keys = fixedKeys()
    const doc = sampleDoc()
    const env = sealWithKeys(doc, keys)
    expect(() => verifyHmacWithKeys(doc, { ...env, hmac: 'AAAA' }, keys.macKey)).toThrow(/完整性校验失败|integrity check failed/)
    expect(() => verifyHmacWithKeys(doc, env, keys.macKey)).not.toThrow()
  })
})

describe('previewImport / reportOfDoc 缺口补齐', () => {
  it('包文件不存在：报「文件不存在」含路径', async () => {
    const h = fakeHome()
    try {
      const missing = path.join(h.home, 'nope.msync')
      await expect(previewImport(missing, 'pw')).rejects.toThrow(/文件不存在|File not found/)
    } finally {
      h.restore()
    }
  })

  it('信封缺 created_by / created_at：预览 meta 为空串（不崩）', async () => {
    const h = fakeHome()
    try {
      const fp = path.join(h.home, 'meta.msync')
      const env = sealEnvelope(sampleDoc(), 'pw') as unknown as Record<string, unknown>
      delete env.created_by
      delete env.created_at
      fs.writeFileSync(fp, JSON.stringify(env, null, 2))
      const { meta } = await previewImport(fp, 'pw')
      expect(meta.createdBy).toBe('')
      expect(meta.createdAt).toBe('')
    } finally {
      h.restore()
    }
  })

  it('reportOfDoc：无 key 无 key_ref 的服务归 missingKeys；userPresets 缺省 → 0；{presets} 形态计数；scheduleRules 缺省 → 0', () => {
    const doc = sampleDoc()
    doc.data.providers.ghost = { base_url: 'https://g.example.com', protocol: 'openai', auth_style: 'bearer' } as never
    doc.data.providers.envp = { base_url: 'https://e.example.com', protocol: 'openai', auth_style: 'bearer', key_ref: 'env:X' } as never
    delete (doc.data as unknown as Record<string, unknown>).userPresets
    delete (doc.data as unknown as Record<string, unknown>).scheduleRules
    const r = reportOfDoc(doc)
    expect(r.providers.sort()).toEqual(['ark', 'envp', 'ghost'])
    expect(r.missingKeys.sort()).toEqual(['ghost'])
    expect(r.envKeyRefs).toEqual(['envp'])
    expect(r.presetCount).toBe(0)
    expect(r.scheduleRules).toBe(0)

    const doc2 = sampleDoc()
    ;(doc2.data as unknown as Record<string, unknown>).userPresets = { presets: [{ id: 'a' }, { id: 'b' }] }
    expect(reportOfDoc(doc2).presetCount).toBe(2)
  })

  it('exportFileName 冒烟：默认参数（当前时刻）也产出合法文件名', () => {
    expect(exportFileName()).toMatch(/^modeldock-config-\d{8}-\d{6}\.msync$/)
  })
})
