import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fakeHome } from './helpers.js'
import { presetsJsonPath } from '../src/util/paths.js'
import { reloadPresets } from '../src/presets/data.js'
import { presetsView } from '../src/gateway/overview-view.js'

/**
 * 夜航审查（2026-11-13）回归钉：网关进程内同步导入（applyImportedDoc → reloadPresets）后，
 * presetsView 的序列化缓存与 ETag 不失效，控制台「添加服务」目录一路 304 直到重启才翻新。
 * 修复 = 缓存按预设表代数（presetsGenerationNow）判失效；本文件直接驱动 reloadPresets
 * 前后两次取视图断言翻新，代数未变时断言缓存对象同一（不重拼串）。
 */

afterEach(() => {
  // fakeHome 已还原，重载回内置态，不污染同进程后续用例（与 presets-userpresets-gaps 同口径）
  reloadPresets()
})

function writeUserPreset(id: string): void {
  const entry = {
    id,
    label: `夜航测试预设 ${id}`,
    vendor: 'test',
    base_url: 'https://preset-night.example.com',
    protocol: 'anthropic',
    auth_style: 'bearer',
    models: [{ id: 'night-model', display_name: 'Night Model' }],
  }
  fs.mkdirSync(path.dirname(presetsJsonPath()), { recursive: true })
  fs.writeFileSync(presetsJsonPath(), JSON.stringify([entry]))
}

describe('presetsView 缓存按预设表代数失效', () => {
  it('reloadPresets 后旧缓存必须翻新：新自定义预设入串、ETag 变化（回归：导入后 304 到重启）', () => {
    const h = fakeHome()
    try {
      const v1 = presetsView()
      expect(v1.data.includes('preset-night-rev')).toBe(false)
      writeUserPreset('preset-night-rev')
      reloadPresets()
      const v2 = presetsView()
      expect(v2.data.includes('preset-night-rev')).toBe(true)
      expect(v2.etag).not.toBe(v1.etag)
      // 翻新后的视图在「添加服务」表单语义下可用：新预设带模型目录
      expect(v2.data.includes('night-model')).toBe(true)
    } finally {
      h.restore()
    }
  })

  it('代数未变时命中同一缓存对象（串不重拼、ETag 稳定 → 304 语义保持）', () => {
    const h = fakeHome()
    try {
      const a = presetsView()
      const b = presetsView()
      expect(b).toBe(a)
    } finally {
      h.restore()
    }
  })
})
