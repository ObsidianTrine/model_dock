import { describe, expect, it } from 'vitest'
import { safeEqual } from '../src/util/safe-equal.js'

// safeEqual 收敛到 src/util 单一实现后（sha256 归一化长度）的判定结果语义与收敛前一致：
// 等值 true、任何不等值 false（含长度不同、等长不同值、空串/单字符等边界）
describe('safeEqual 常数时间字符串比较', () => {
  it('等值返回 true', () => {
    const tok = 'mdkadm_' + 'a'.repeat(40)
    expect(safeEqual(tok, tok)).toBe(true)
  })

  it('等长不等值返回 false', () => {
    expect(safeEqual('mdkadm_aaaa', 'mdkadm_aaab')).toBe(false)
  })

  it('不等长返回 false（归一化后仍比较内容）', () => {
    expect(safeEqual('short', 'a much longer token that differs in length')).toBe(false)
    expect(safeEqual('', 'x')).toBe(false)
    expect(safeEqual('x', '')).toBe(false)
  })
})