import { describe, expect, it } from 'vitest'
import path from 'node:path'
import { fakeHome } from './helpers.js'
import { atomicWrite, ensureDir } from '../src/util/fsx.js'
import { scanSources } from '../src/import/sources.js'

describe('import scan · dsh', () => {
  it('BUG-10：多份 patch 中单份损坏不丢弃其余合法文件的候选', async () => {
    const h = fakeHome()
    try {
      // bad 占用字符序在前（先被扫描），其 YAML 损坏；good 合法，含可导入 provider
      const badDir = path.join(h.home, '.dsh', 'profiles', 'bad')
      const goodDir = path.join(h.home, '.dsh', 'profiles', 'good')
      await ensureDir(badDir)
      await ensureDir(goodDir)
      await atomicWrite(path.join(badDir, 'cordis.patch.yml'), '- id: llm-pi-ai\n  name: *unresolvedAlias\n', 0o600)
      await atomicWrite(
        path.join(goodDir, 'cordis.patch.yml'),
        '- id: llm-pi-ai\n  name: "@deepseek-ai/dsh-llm-pi-ai"\n  config:\n    providers:\n      ark:\n        api: anthropic-messages\n        baseURL: https://ark.example.com\n        apiKeyEnv: ARK\n        models:\n          - id: a\n            name: a\n',
        0o600
      )

      const out = await scanSources('dsh')
      // 合法文件仍产出候选（回归点：损坏文件不应 return 丢弃已收集结果）
      expect(out.some((c) => c.suggest_id === 'dsh-ark' && !c.skip_reason)).toBe(true)
      // 损坏文件以占位诊断呈现，而非整批消失
      expect(out.some((c) => c.skip_reason && c.skip_reason.includes('解析失败'))).toBe(true)
    } finally {
      h.restore()
    }
  })
})