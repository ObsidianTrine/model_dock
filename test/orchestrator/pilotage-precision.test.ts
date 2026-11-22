// 引水闸文件级精确口径回归：hintsOverlap 顶层段粗匹配把 src/ 下任何卡判进受限航道、
// drain 永不派出（2026-11-16 夜航实证：性能卡整夜 pending）。hintsIntersectExact 只在
// hint 与 corePaths/releasePaths 清单真重叠时判受限——保护语义零放宽，误伤清零。
// 并行分区互斥（hintsOverlap）的保守粗口径是特性不是 bug，单测仍在 parallel.test.ts。

import { describe, expect, it } from 'vitest'
import { hintsIntersectExact } from '../../.agents/scripts/policy.mjs'
import { pilotageReason } from '../../.agents/scripts/orchestrator.mjs'

// 与生产 workflow.json 同构：corePaths 全文件条目，releasePaths 混目录前缀与文件
const CFG = {
  corePaths: ['src/cli.ts', 'src/gateway/server.ts', 'src/config/store.ts', 'src/util/paths.ts'],
  releasePaths: ['.github/workflows/', 'scripts/build-sea.mjs', 'scripts/build-all.mjs'],
}

describe('pilotage precision > hintsIntersectExact 文件级口径', () => {
  it('清单外文件与清单不相交（粗口径误伤回归）', () => {
    expect(hintsIntersectExact(['src/presets/data.ts'], ['src/cli.ts'])).toBe(false)
    expect(hintsIntersectExact(['src/presets/data.ts'], CFG.corePaths)).toBe(false)
    expect(hintsIntersectExact(['src/gateway/other.ts'], ['src/gateway/server.ts'])).toBe(false) // 同目录不同文件
    expect(hintsIntersectExact(['docs/**'], CFG.corePaths)).toBe(false)
    expect(hintsIntersectExact(['.github/other.yml'], ['.github/workflows/'])).toBe(false) // 目录前缀不外溢到兄弟路径
  })

  it('命中清单（文件/目录前缀/双向通配）仍相交——保护语义零放宽', () => {
    expect(hintsIntersectExact(['src/cli.ts'], ['src/cli.ts'])).toBe(true)
    expect(hintsIntersectExact(['scripts/build-sea.mjs'], ['scripts/build-sea.mjs'])).toBe(true)
    expect(hintsIntersectExact(['.github/workflows/ci.yml'], ['.github/workflows/'])).toBe(true) // 清单是目录前缀
    expect(hintsIntersectExact(['src/gateway/relay.ts'], ['src/gateway/**'])).toBe(true) // 清单侧通配
    expect(hintsIntersectExact(['src/gateway/**'], ['src/gateway/server.ts'])).toBe(true) // hint 侧通配盖到清单文件
    expect(hintsIntersectExact(['src'], ['src/cli.ts'])).toBe(true) // hint 是清单文件的祖先目录
    expect(hintsIntersectExact(['docs/a.md', 'src/config/store.ts'], ['src/config/store.ts'])).toBe(true) // 多 hint 任一命中
  })

  it('完全通配 = 独占；未声明 = 保守相交；空清单 = 航道未设限', () => {
    expect(hintsIntersectExact(['**'], ['src/cli.ts'])).toBe(true)
    expect(hintsIntersectExact(['*.md'], ['docs/a.md'])).toBe(true) // 首段即通配 → 独占
    expect(hintsIntersectExact([], ['src/cli.ts'])).toBe(true) // 与 hintsOverlap「未声明 = 独占」同款
    expect(hintsIntersectExact(['src/presets/data.ts'], [])).toBe(false)
  })
})

describe('pilotage precision > pilotageReason 判定链', () => {
  it('files_hint 为清单外文件 → null 可派发（夜航误伤回归）', () => {
    expect(pilotageReason({ files_hint: ['src/presets/data.ts'] }, CFG)).toBeNull()
    expect(pilotageReason({ files_hint: ['src/util/diff.ts'] }, CFG)).toBeNull()
    expect(pilotageReason({ files_hint: ['src/gateway/other.ts'] }, CFG)).toBeNull()
    expect(pilotageReason({ files_hint: ['docs/**'] }, CFG)).toBeNull()
  })

  it('files_hint 命中 corePaths / releasePaths → 仍判受限（正向保护用例）', () => {
    expect(pilotageReason({ files_hint: ['src/cli.ts'] }, CFG)).toBe('files_hint 命中核心/发布路径')
    expect(pilotageReason({ files_hint: ['scripts/build-sea.mjs'] }, CFG)).toBe('files_hint 命中核心/发布路径')
    expect(pilotageReason({ files_hint: ['.github/workflows/test.yml'] }, CFG)).toBe('files_hint 命中核心/发布路径')
    expect(pilotageReason({ files_hint: ['src/gateway/**'] }, CFG)).toBe('files_hint 命中核心/发布路径')
  })

  it('deps 类型与航道未设限语义不变', () => {
    expect(pilotageReason({ type: 'deps', files_hint: ['docs/**'] }, CFG)).toBe('type: deps（依赖变更）')
    expect(pilotageReason({ files_hint: ['src/cli.ts'] }, {})).toBeNull()
    expect(pilotageReason({ files_hint: ['src/cli.ts'] }, { corePaths: [], releasePaths: [] })).toBeNull()
  })
})
