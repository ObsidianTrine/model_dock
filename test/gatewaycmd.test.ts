import { describe, expect, it } from 'vitest'
import { listProcessLines } from '../src/cli/gatewaycmd.js'

// 冒烟而非精确断言：ps / PowerShell 各平台输出行细节不同，守住的是
// 「命令本身能跑通、能解析出一批 pid+命令行」。自身排除是 sweep 循环的职责
// （Unix ps 原样列出自身）；仅 Windows 的 PS 脚本在枚举时就排除自身，单独守护。
describe('listProcessLines（跨平台进程枚举）', () => {
  it('当前平台可枚举：非空、可解析出 pid+命令行', () => {
    const out = listProcessLines()
    expect(out).toBeTruthy()
    const parsed = (out as string)
      .split('\n')
      .filter((l) => /^\s*\d+\s+\S/.test(l))
    expect(parsed.length).toBeGreaterThan(0)
  })
  it.skipIf(process.platform !== 'win32')('Windows：PS 脚本枚举时已排除自身 pid', () => {
    const out = listProcessLines() as string
    const own = out
      .split('\n')
      .some((l) => Number(l.match(/^\s*(\d+)/)?.[1]) === process.pid)
    expect(own).toBe(false)
  })
})
