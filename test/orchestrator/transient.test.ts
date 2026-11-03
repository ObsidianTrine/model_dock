// transient 瞬时故障签名测试：ERA 连接协商失败（zcode CLI，2026-11-03 航行实证）
// 须命中（可退避重试自愈）；既有 429/网络签名不回归；确定性错误不误报。

import { describe, expect, it } from 'vitest'
import { isTransientWorkerFailure, TRANSIENT_RE } from '../../.agents/scripts/orchestrator/transient.mjs'

describe('orchestrator transient > 瞬时故障签名', () => {
  it('zcode ERA 连接协商失败命中（两种形态与完整堆栈现场）', () => {
    const stack = [
      'at probe (D:\\Programs\\ZCode\\resources\\glm\\zcode.cjs:2217:81178)',
      'at async negotiateEra (D:\\Programs\\ZCode\\resources\\glm\\zcode.cjs:2217:82502)',
      'at async Wyo._connectNegotiated (D:\\Programs\\ZCode\\resources\\glm\\zcode.cjs:2217:105240)',
      'Node.js v24.18.0',
    ].join('\n')
    expect(isTransientWorkerFailure('', stack)).toBe(true)
    expect(TRANSIENT_RE.test('ERA_NEGOTIATION_FAILED: upstream negotiate failed')).toBe(true)
    expect(TRANSIENT_RE.test('era-negotiation timeout')).toBe(true)
  })

  it('既有签名不回归（429/网络码）；确定性错误不误报', () => {
    expect(isTransientWorkerFailure('request failed: 429 too many requests', '')).toBe(true)
    expect(isTransientWorkerFailure('', 'ECONNRESET socket hang up')).toBe(true)
    expect(isTransientWorkerFailure('SyntaxError: Unexpected token', '')).toBe(false)
    expect(isTransientWorkerFailure('', 'command not found: npm')).toBe(false)
  })
})
