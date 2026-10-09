import { describe, expect, it } from 'vitest'
import { buildProgram } from '../src/cli/index.js'

// 托盘「清理数据」靠 `reset --yes --deep` 非交互调用：这里只验证选项注册与文案（action 不动、不跑清理）。
// ⚠ 本文件刻意不 parseAsync：同进程里真正执行 reset 会经 basic.ts 触达被别的测试文件 mock 的模块，
//   实测（isolate:false + singleFork）会让那些文件的 mock 调用记录随机丢失。真正的执行路径由
//   test/reset.test.ts 的 CLI 子进程用例覆盖。
describe('CLI 注册：reset --yes --deep', () => {
  it('reset 子命令注册了 --yes 与 --deep，且两者都有非空说明', () => {
    const prog = buildProgram()
    const reset = prog.commands.find((cmd) => cmd.name() === 'reset')
    expect(reset, 'reset 子命令应存在').toBeTruthy()
    expect(reset!.options.map((o) => o.long).sort()).toEqual(['--deep', '--yes'])
    for (const o of reset!.options) expect(o.description.length).toBeGreaterThan(0)
  })
})
