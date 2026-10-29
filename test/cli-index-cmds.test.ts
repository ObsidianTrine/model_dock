import { describe, expect, it } from 'vitest'
import type { Command } from 'commander'
import { buildProgram } from '../src/cli/index.js'

// 命令注册层全量断言（reset-cli.test.ts 同款：只查注册，绝不 parseAsync/执行 action——
// action 是动态 import，真正执行会扇出到被其他测试文件 mock 的模块）。src/cli/index.ts 是
// 全仓注册面：每条注册行都在 buildProgram() 内，遍历断言命令名 + 选项 + 非空描述，
// 注册面新增命令忘写描述 / 改命令名即红。

function allCommands(prog: Command): Command[] {
  return [prog, ...prog.commands.flatMap((c) => allCommands(c))]
}

function longOpts(cmd: Command): string[] {
  return cmd.options.map((o) => o.long ?? '').filter((l) => l.length > 0)
}

describe('buildProgram 注册面', () => {
  const prog = buildProgram()

  it('顶层命令齐备', () => {
    const names = prog.commands.map((c) => c.name()).sort()
    expect(names).toEqual(
      [
        'adapter', 'attach', 'config', 'detach', 'doctor', 'env', 'gateway', 'harness',
        'import', 'init', 'mcp', 'model', 'presets', 'profile', 'provider', 'reset', 'restore',
        'status', 'sync', 'test', 'token', 'ui', 'uninstall', 'update', 'usage',
      ].sort()
    )
  })

  it('每个命令（含子命令）都有非空描述', () => {
    for (const cmd of allCommands(prog)) {
      expect(cmd.description().trim().length, `${cmd.name()} 描述为空`).toBeGreaterThan(0)
    }
  })

  it('provider 子命令齐备', () => {
    const provider = prog.commands.find((c) => c.name() === 'provider')!
    expect(provider.commands.map((c) => c.name()).sort()).toEqual(['add', 'list', 'rm', 'set-key'])
  })

  it('model 子命令齐备（含 catalog refresh）', () => {
    const model = prog.commands.find((c) => c.name() === 'model')!
    expect(model.commands.map((c) => c.name()).sort()).toEqual(['catalog', 'list', 'refresh', 'set'])
    expect(model.commands.find((c) => c.name() === 'catalog')!.commands.map((c) => c.name())).toEqual(['refresh'])
  })

  it('profile / gateway / harness / config / sync / mcp 子命令齐备', () => {
    const subs: Record<string, string[]> = {
      profile: ['add', 'list', 'rm', 'use'],
      gateway: ['install', 'log', 'rotate-token', 'start', 'status', 'stop', 'uninstall'],
      harness: ['direct', 'gateway', 'route'],
      config: ['edit', 'export', 'import'],
      mcp: ['list'],
      sync: ['assets', 'enroll', 'pause', 'resume', 'setup', 'status'],
    }
    for (const [top, children] of Object.entries(subs)) {
      const cmd = prog.commands.find((c) => c.name() === top)!
      expect(cmd.commands.map((c) => c.name()).sort(), top).toEqual(children)
    }
  })

  it('attach：--mode 用 choices 约束（gateway | file），非法值解析期报错', () => {
    const attach = prog.commands.find((c) => c.name() === 'attach')!
    const mode = attach.options.find((o) => o.long === '--mode')
    expect(mode).toBeTruthy()
    expect(mode!.argChoices).toEqual(['gateway', 'file'])
    expect(() => mode!.parseArg('bogus')).toThrow() // 非法值在解析期拦截，不透传给 adapter
    expect(longOpts(attach).sort()).toEqual(
      ['--client-profile', '--mode', '--port', '--profile', '--set-default', '--takeover-models', '--yes'].sort()
    )
  })

  it('gateway log：-n 默认 30 条、follow 与 harness 过滤齐备', () => {
    const gw = prog.commands.find((c) => c.name() === 'gateway')!
    const log = gw.commands.find((c) => c.name() === 'log')!
    expect(log.options.find((o) => o.long === '--lines')?.defaultValue).toBe('30')
    expect(log.options.find((o) => o.long === '--lines')?.short).toBe('-n')
    expect(longOpts(log).sort()).toEqual(['--follow', '--harness', '--lines'])
  })

  it('reset / uninstall 选项（托盘联动契约）', () => {
    const reset = prog.commands.find((c) => c.name() === 'reset')!
    expect(longOpts(reset).sort()).toEqual(['--deep', '--yes'])
    const uninstall = prog.commands.find((c) => c.name() === 'uninstall')!
    expect(longOpts(uninstall).sort()).toEqual(['--purge', '--yes'])
  })

  it('update：--check / --yes / --token / --clean 齐备', () => {
    const update = prog.commands.find((c) => c.name() === 'update')!
    expect(longOpts(update).sort()).toEqual(['--check', '--clean', '--token', '--yes'])
  })

  it('config export/import：-o 与 --stdin-pass 齐备', () => {
    const config = prog.commands.find((c) => c.name() === 'config')!
    const exp = config.commands.find((c) => c.name() === 'export')!
    expect(longOpts(exp).sort()).toEqual(['--out', '--stdin-pass'])
    expect(exp.options.find((o) => o.long === '--out')?.short).toBe('-o')
    const imp = config.commands.find((c) => c.name() === 'import')!
    expect(longOpts(imp).sort()).toEqual(['--stdin-pass', '--yes'])
  })

  it('provider add：预设直加与 key 来源选项齐备（--no-fetch 也注册）', () => {
    const provider = prog.commands.find((c) => c.name() === 'provider')!
    const add = provider.commands.find((c) => c.name() === 'add')!
    expect(longOpts(add).sort()).toEqual(
      ['--auth', '--base-url', '--key', '--key-env', '--name', '--no-fetch', '--protocol', '--yes'].sort()
    )
  })

  it('model set：元数据选项齐备', () => {
    const model = prog.commands.find((c) => c.name() === 'model')!
    const set = model.commands.find((c) => c.name() === 'set')!
    expect(longOpts(set).sort()).toEqual(['--cap', '--ctx', '--display', '--max-out'])
  })

  it('sync setup：目标参数与 stdin-pass 齐备', () => {
    const sync = prog.commands.find((c) => c.name() === 'sync')!
    const setup = sync.commands.find((c) => c.name() === 'setup')!
    expect(longOpts(setup).sort()).toEqual(
      ['--dir', '--password', '--stdin-pass', '--target', '--url', '--username'].sort()
    )
  })

  it('doctor：--fix / --yes / --json 齐备', () => {
    const doctor = prog.commands.find((c) => c.name() === 'doctor')!
    expect(longOpts(doctor).sort()).toEqual(['--fix', '--json', '--yes'])
  })

  it('test：-m/--model 与 -t/--timeout（默认 90s）齐备', () => {
    const test = prog.commands.find((c) => c.name() === 'test')!
    expect(test.options.find((o) => o.long === '--timeout')?.defaultValue).toBe('90')
    expect(test.options.find((o) => o.long === '--timeout')?.short).toBe('-t')
    expect(test.options.find((o) => o.long === '--model')?.short).toBe('-m')
  })

  it('import：--from choices 覆盖全部来源', () => {
    const imp = prog.commands.find((c) => c.name() === 'import')!
    expect(longOpts(imp).sort()).toEqual(['--from', '--no-with-profiles', '--token', '--url', '--yes'])
  })
})
