// schedule 测试：wrapper/plist/cron/schtasks 纯函数内容 + install --dry-run（绝不真注册系统调度）。
// 调度标识（scheduleId/winTaskName）随项目派生（workflow.json / package.json / 目录名），代码零项目字面量。

import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  cronMarkers,
  scheduleId,
  slugify,
  winTaskName,
  runnerPath,
  nightlyLogPath,
  nightlyArgs,
  sailDurationArgs,
  keychainServiceName,
  buildKeychainSh,
  buildRunnerUnix,
  buildRunnerWin,
  buildPlist,
  buildCronBlock,
  buildSchtasksCreateArgs,
  validHourMinute,
} from '../../.agents/scripts/orchestrator/schedule.mjs'
import { mkRepo, runOrch, tryOrch } from './helpers.js'

const ROOT = '/opt/proj root' // 故意带空格：wrapper/注册命令的引号必须扛得住
// ROOT 下无 workflow.json / package.json → 标识从目录名派生（proj root → proj-root）
const ID = scheduleId(ROOT)

describe('orchestrator schedule > 调度标识派生（可移植核心）', () => {
  function fixture(workflow: Record<string, unknown>, packageJson?: Record<string, unknown>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-id-'))
    fs.mkdirSync(path.join(dir, '.agents'), { recursive: true })
    fs.writeFileSync(path.join(dir, '.agents', 'workflow.json'), JSON.stringify(workflow))
    if (packageJson) fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(packageJson))
    return dir
  }

  it('slugify：非 [a-z0-9] 归并为短横线，首尾修剪，空串兜底 project', () => {
    expect(slugify('ModelDock')).toBe('modeldock')
    expect(slugify('my app!')).toBe('my-app')
    expect(slugify('--a--')).toBe('a')
    expect(slugify('')).toBe('project')
  })

  it('scheduleId：显式配置 > com.<slug(projectName)>.orchestrator-nightly（projectName 派生链生效）', () => {
    const dir = fixture({ scheduleId: 'com.custom.nightly' }, { name: 'my-app' })
    try {
      expect(scheduleId(dir)).toBe('com.custom.nightly')
      fs.writeFileSync(path.join(dir, '.agents', 'workflow.json'), JSON.stringify({ projectName: 'My App' }))
      expect(scheduleId(dir)).toBe('com.my-app.orchestrator-nightly')
      fs.writeFileSync(path.join(dir, '.agents', 'workflow.json'), JSON.stringify({}))
      expect(scheduleId(dir)).toBe('com.my-app.orchestrator-nightly') // package.json name
      fs.rmSync(path.join(dir, 'package.json'))
      expect(scheduleId(dir)).toBe(`com.${slugify(path.basename(dir))}.orchestrator-nightly`) // 目录名兜底（slug 小写化）
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('winTaskName：展示名派生；cronMarkers 成对且随 id 走', () => {
    const dir = fixture({ projectName: 'ModelDock' })
    try {
      expect(winTaskName(dir)).toBe('ModelDock Orchestrator Nightly')
      const { begin, end } = cronMarkers(dir)
      expect(begin).toBe(`# BEGIN com.modeldock.orchestrator-nightly`)
      expect(end).toBe(`# END com.modeldock.orchestrator-nightly`)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('orchestrator schedule > nightlyArgs 组装', () => {
  it('默认仅 nightly；tests/auto/backend 逐项追加', () => {
    expect(nightlyArgs()).toEqual(['nightly'])
    expect(nightlyArgs({ tests: true })).toEqual(['nightly', '--tests'])
    expect(nightlyArgs({ auto: 3, backend: 'mock' })).toEqual(['nightly', '--auto', '3', '--backend', 'mock'])
    expect(nightlyArgs({ auto: 0 })).toEqual(['nightly']) // auto 非正整数忽略
  })

  it('sail 模式：--minutes/--duration 必填其一，不带 nightly 专属的 --tests/--auto', () => {
    expect(nightlyArgs({ mode: 'sail', minutes: 30 })).toEqual(['sail', '--minutes', '30'])
    expect(nightlyArgs({ mode: 'sail', duration: '1h30m' })).toEqual(['sail', '--duration', '1h30m'])
    expect(nightlyArgs({ mode: 'sail', minutes: 45, backend: 'mock', reviewBackend: 'mock' })).toEqual([
      'sail', '--minutes', '45', '--backend', 'mock', '--review-backend', 'mock',
    ])
    // sail 不带 --tests/--auto：传了也忽略（sail CLI 无此参数）
    expect(nightlyArgs({ mode: 'sail', minutes: 30, tests: true, auto: 3 })).toEqual(['sail', '--minutes', '30'])
  })
})

describe('orchestrator schedule > sailDurationArgs 校验', () => {
  it('minutes 正整数优先；duration 合法形态 2h / 90m / 1h30m', () => {
    expect(sailDurationArgs({ minutes: 30 })).toEqual(['--minutes', '30'])
    expect(sailDurationArgs({ duration: '2h' })).toEqual(['--duration', '2h'])
    expect(sailDurationArgs({ duration: '90m' })).toEqual(['--duration', '90m'])
    expect(sailDurationArgs({ duration: '1h30m' })).toEqual(['--duration', '1h30m'])
    expect(sailDurationArgs({ minutes: 0, duration: '45m' })).toEqual(['--duration', '45m']) // minutes 非正回落 duration
  })

  it('两者皆缺 / 非法值抛错（install 时刻拦下，不写坏 wrapper）', () => {
    expect(() => sailDurationArgs()).toThrow(/--minutes/)
    expect(() => sailDurationArgs({ minutes: 0 })).toThrow(/--minutes/)
    expect(() => sailDurationArgs({ minutes: -5, duration: '45m' })).not.toThrow() // 负数回落 duration
    // duration 白名单：防任意字符串进 shell（wrapper 生成时固化为字面量）
    expect(() => sailDurationArgs({ duration: '30; rm -rf /' })).toThrow(/--minutes/)
    expect(() => sailDurationArgs({ duration: '$(whoami)' })).toThrow(/--minutes/)
    expect(() => sailDurationArgs({ duration: 'abc' })).toThrow(/--minutes/)
  })
})

describe('orchestrator schedule > 钥匙串服务名与 wrapper 解析块', () => {
  function fixture(workflow: Record<string, unknown>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-kc-'))
    fs.mkdirSync(path.join(dir, '.agents'), { recursive: true })
    fs.writeFileSync(path.join(dir, '.agents', 'workflow.json'), JSON.stringify(workflow))
    return dir
  }

  it('keychainServiceName：显式 notify.keychainService > ${scheduleId}.webhook 派生', () => {
    expect(keychainServiceName(ROOT)).toBe(`${ID}.webhook`) // ROOT 无 workflow.json → 派生
    const dir = fixture({ notify: { keychainService: 'custom-svc.webhook' } })
    try {
      expect(keychainServiceName(dir)).toBe('custom-svc.webhook')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('buildKeychainSh：security 守卫 + 服务名 + 两个 webhook 变量（env 已设不覆盖）；win wrapper 不含钥匙串', () => {
    const sh = buildKeychainSh(ROOT)
    const svc = `${ID}.webhook`
    expect(sh).toContain('command -v security')
    expect(sh).toContain(`security find-generic-password -s "${svc}" -w`)
    expect(sh).toContain(`AGENTS_NIGHTLY_WEBHOOK="$_mdk_wh"`)
    expect(sh).toContain(`AGENTS_ORCH_WEBHOOK="$_mdk_wh"`)
    // exec 行必须在钥匙串块之后（先解析后启动）
    const runner = buildRunnerUnix(ROOT, '/usr/local/bin/node', ['nightly'])
    expect(runner.indexOf('command -v security')).toBeLessThan(runner.indexOf('exec '))

    const win = buildRunnerWin('C:\\proj x', 'C:\\node\\node.exe', ['nightly'])
    expect(win).not.toContain('security') // win 分支跳过钥匙串（卡片要求）
  })

  it('服务名/前缀含 shell 危险字符 → 整块省略（宁可缺通知，不把任意字符串带进 shell）', () => {
    const dir = fixture({ notify: { keychainService: 'bad name; rm -rf /' } })
    try {
      expect(buildKeychainSh(dir)).toBe('')
      const runner = buildRunnerUnix(dir, '/usr/local/bin/node', ['nightly'])
      expect(runner).not.toContain('security find-generic-password')
      expect(runner).toContain('exec ') // wrapper 本体不受影响
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('orchestrator schedule > wrapper 生成（路径含空格全带引号）', () => {
  it('unix：cd 仓库 + exec node 绝对路径 + 参数 + 日志追加', () => {
    const s = buildRunnerUnix(ROOT, '/usr/local/bin/node', ['nightly', '--auto', '3'])
    expect(s).toContain(`cd "${ROOT}" || exit 1`)
    expect(s).toContain(`exec "/usr/local/bin/node" "${path.join(ROOT, '.agents', 'scripts', 'orchestrator.mjs')}" nightly --auto 3`)
    expect(s).toContain(`>> "${path.join(ROOT, '.agents', 'orchestrator', 'logs', 'nightly.log')}" 2>&1`)
    expect(s.startsWith('#!/bin/sh')).toBe(true)
    expect(s).toContain(ID) // 头注释带调度标识（从目录名派生，无项目字面量）
  })

  it('win：\\r\\n 换行 + cd /d 跨盘符', () => {
    const s = buildRunnerWin('C:\\proj x', 'C:\\node\\node.exe', ['nightly'])
    expect(s).toContain('\r\n')
    expect(s).toContain('cd /d "C:\\proj x"')
    expect(s).toContain('"C:\\node\\node.exe"')
    expect(s.endsWith('\r\n')).toBe(true)
  })
})

describe('orchestrator schedule > 三平台注册内容纯函数', () => {
  it('launchd plist：Label/ProgramArguments(/bin sh 解释 wrapper)/StartCalendarInterval', () => {
    const xml = buildPlist(ROOT, { hour: 2, minute: 30 })
    expect(xml).toContain(`<string>${ID}</string>`)
    expect(xml).toContain('<string>/bin/sh</string>')
    expect(xml).toContain(`<string>${runnerPath(ROOT)}</string>`)
    expect(xml).toContain('<key>Hour</key><integer>2</integer>')
    expect(xml).toContain('<key>Minute</key><integer>30</integer>')
    expect(xml).toContain(`<string>${ROOT}</string>`) // WorkingDirectory
  })

  it('crontab 标记段：BEGIN/END 成对 + 每日 HH:MM', () => {
    const block = buildCronBlock(ROOT, { hour: 2, minute: 30 })
    expect(block.startsWith(`# BEGIN ${ID}`)).toBe(true)
    expect(block.endsWith(`# END ${ID}`)).toBe(true)
    expect(block).toContain(`30 2 * * * /bin/sh "${runnerPath(ROOT)}"`)
  })

  it('schtasks：/ST 补零 + /TN 展示名 + /TR 内层引号包空格路径', () => {
    const args = buildSchtasksCreateArgs(ROOT, { hour: 2, minute: 5 })
    expect(args).toContain('/ST')
    expect(args[args.indexOf('/ST') + 1]).toBe('02:05')
    expect(args[args.indexOf('/TN') + 1]).toBe(winTaskName(ROOT))
    const tr = args[args.indexOf('/TR') + 1]
    expect(tr).toBe(`"${runnerPath(ROOT)}"`)
  })

  it('validHourMinute 边界', () => {
    expect(validHourMinute(0, 0)).toBe(true)
    expect(validHourMinute(23, 59)).toBe(true)
    expect(validHourMinute(24, 0)).toBe(false)
    expect(validHourMinute(2, 60)).toBe(false)
    expect(validHourMinute(2.5, 0)).toBe(false)
  })
})

describe('orchestrator schedule > CLI dry-run（写 wrapper、不碰系统调度）', () => {
  it('schedule install --dry-run：stdout 计划 + wrapper 落盘；--auto 参数透传进 wrapper', () => {
    const repo = mkRepo()
    try {
      const out = runOrch(repo.root, 'schedule install --dry-run --hour 2 --auto 3 --tests')
      expect(out.stdout).toContain('[dry-run] 未触碰系统调度')
      expect(out.stdout).toContain('wrapper 已写入')
      const runner = fs.readFileSync(runnerPath(repo.root), 'utf8')
      expect(runner).toContain('nightly --tests --auto 3')
      expect(runner).toContain(repo.root) // 仓库绝对路径固化
      // 日志目录随 wrapper 一起就位
      expect(fs.existsSync(path.dirname(nightlyLogPath(repo.root)))).toBe(true)
    } finally {
      repo.cleanup()
    }
  })

  it('非法时刻（hour 24）→ exit 1 可操作报错', () => {
    const repo = mkRepo()
    try {
      const r = tryOrch(repo.root, 'schedule install --dry-run --hour 24')
      expect(r.status).toBe(1)
      expect(r.stderr).toContain('hour')
    } finally {
      repo.cleanup()
    }
  })

  it('schedule install --mode sail --dry-run：计划文本 + wrapper 含 sail 参数；sail 不带 --tests', () => {
    const repo = mkRepo()
    try {
      const out = runOrch(repo.root, 'schedule install --mode sail --minutes 30 --hour 23 --dry-run')
      expect(out.stdout).toContain('[dry-run] 未触碰系统调度')
      const runner = fs.readFileSync(runnerPath(repo.root), 'utf8')
      expect(runner).toContain('sail --minutes 30')
      expect(runner).not.toContain('--tests')
      expect(runner).not.toContain('--auto')
      // 钥匙串解析块随 wrapper 生成（darwin 实际生效；其他平台 if 守卫空转）
      expect(runner).toContain('command -v security')
      const win = process.platform === 'win32'
      if (win) expect(runner).not.toContain('security find-generic-password')
    } finally {
      repo.cleanup()
    }
  })

  it('sail --duration 透传；--mode sail 缺时长 → exit 1；未知 --mode → exit 1', () => {
    const repo = mkRepo()
    try {
      runOrch(repo.root, 'schedule install --mode sail --duration 1h30m --dry-run')
      expect(fs.readFileSync(runnerPath(repo.root), 'utf8')).toContain('sail --duration 1h30m')

      const noDur = tryOrch(repo.root, 'schedule install --mode sail --dry-run')
      expect(noDur.status).toBe(1)
      expect(noDur.stderr).toContain('--minutes')

      const badMode = tryOrch(repo.root, 'schedule install --mode nope --dry-run')
      expect(badMode.status).toBe(1)
      expect(badMode.stderr).toContain('nightly | watch | sail')
    } finally {
      repo.cleanup()
    }
  })

  it('缺子命令 → usage 提示 exit 1', () => {
    const repo = mkRepo()
    try {
      const r = tryOrch(repo.root, 'schedule')
      expect(r.status).toBe(1)
      expect(r.stderr).toContain('install|uninstall|status')
    } finally {
      repo.cleanup()
    }
  })
})
