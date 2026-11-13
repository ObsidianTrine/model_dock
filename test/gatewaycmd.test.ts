import { describe, expect, it } from 'vitest'
import { isGatewayProcessCmd, listProcessLines } from '../src/cli/gatewaycmd.js'

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

// 卸载清扫的杀伤判据（2026-11-12 审查 F5 收紧）：纯函数，喂真实形态的命令行样本。
// 取向「误杀 < 漏杀」：合法网关形态全命中，检索/编辑类进程不误杀。
describe('isGatewayProcessCmd（游离网关命令行判据）', () => {
  it('合法网关形态全命中（SEA / npm 全局 / tsx dev / 裸名 / cmd 包装）', () => {
    expect(isGatewayProcessCmd('C:\\Program Files\\modeldock\\modeldock.exe --sea-gateway')).toBe(true)
    expect(isGatewayProcessCmd('node C:\\Users\\x\\AppData\\Roaming\\npm\\node_modules\\modeldock\\dist\\cli.js gateway start --port 8687')).toBe(true)
    expect(isGatewayProcessCmd('node --import file:///D:/01_Work/Projects/model_dock/node_modules/tsx/dist/esm/index.mjs D:\\01_Work\\Projects\\model_dock\\src\\cli.ts gateway start')).toBe(true)
    expect(isGatewayProcessCmd('/usr/local/bin/modeldock --sea-gateway')).toBe(true)
    expect(isGatewayProcessCmd('modeldock gateway start --daemon')).toBe(true)
    expect(isGatewayProcessCmd('cmd /c modeldock gateway start')).toBe(true)
    expect(isGatewayProcessCmd('modeldock.exe gateway start')).toBe(true)
  })

  it('检索/编辑类进程不误杀（引号内检索词、参数在前的目标路径）', () => {
    // 引号内的检索词不是独立参数位
    expect(isGatewayProcessCmd('rg "gateway start" D:\\01_Work\\Projects\\model_dock\\src')).toBe(false)
    // .modeldock 数据目录是前导点路径，非程序标记
    expect(isGatewayProcessCmd('grep gateway start C:\\Users\\x\\.modeldock\\logs\\gateway-2026-11-13.jsonl')).toBe(false)
    // 参数出现在 modeldock 路径之前（顺序检查兜底）
    expect(isGatewayProcessCmd('grep gateway start D:\\modeldock\\logs\\x')).toBe(false)
    // 同理带 --sea-gateway 的变体
    expect(isGatewayProcessCmd('grep --sea-gateway pattern C:\\Users\\x\\.modeldock\\logs\\x')).toBe(false)
  })

  it('无关进程不命中（缺程序标记或缺网关参数）', () => {
    expect(isGatewayProcessCmd('notepad.exe')).toBe(false)
    expect(isGatewayProcessCmd('node server.js --sea-gateway')).toBe(false) // 有参数无程序标记
    expect(isGatewayProcessCmd('my-modeldock gateway start')).toBe(false) // 连字名非边界命中
    expect(isGatewayProcessCmd('node D:\\01_Work\\Projects\\model_dock\\src\\cli.ts mcp list')).toBe(false) // 非网关子命令
  })
})
