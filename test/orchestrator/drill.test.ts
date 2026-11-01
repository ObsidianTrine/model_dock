// 弃船演习测试（drill，借鉴清单 B9）：临时港 mock 全链 + 故障注入红灯 + mock-only 守卫。
// 演习跑的是真实 orchestrator 闭环（临时港整目录拷贝脚本），是编排体系的端到端冒烟。

import { describe, expect, it } from 'vitest'
import { runOrch, tryOrch } from './helpers.js'

describe('orchestrator drill > 弃船演习', () => {
  it('mock 临时港全链：闭环落位，演习通过 exit 0', () => {
    const r = runOrch(process.cwd(), 'drill')
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('演习通过')
    expect(r.stdout).toContain('闭环全链')
  }, 240_000)

  it('故障注入：worker spawn 失败 → 演习红灯 exit≠0（环境漂移必须演习先炸）', () => {
    const r = tryOrch(process.cwd(), 'drill', { ORCH_MOCK_SPAWN_ERROR: '1' })
    expect(r.status).not.toBe(0)
    expect(r.stdout + r.stderr).toContain('演习未通过')
  }, 240_000)

  it('只许 mock：显式真引擎拒绝（演习不烧真钱）', () => {
    const r = tryOrch(process.cwd(), 'drill --backend claude-headless')
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('仅用 mock')
  })
})
