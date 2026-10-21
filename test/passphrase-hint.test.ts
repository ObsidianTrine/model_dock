import { describe, expect, it } from 'vitest'
import { passphraseHint } from '../src/cli/sync.js'

describe('passphraseHint（同步口令强度提示，非阻断）', () => {
  it('短于 8 位或纯数字给提示；混合口令不给', () => {
    expect(passphraseHint('1234')).toMatch(/弱|weak/i)
    expect(passphraseHint('abc123')).toMatch(/弱|weak/i)
    expect(passphraseHint('12345678')).toMatch(/弱|weak/i) // 长度够但纯数字
    expect(passphraseHint('abc12345')).toBeNull()
    expect(passphraseHint('abcd123!@#')).toBeNull() // 8 位含符号（原 sync-cli 用例并入）
    expect(passphraseHint('')).toMatch(/弱|weak/i)
  })
})
