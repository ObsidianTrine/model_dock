// schedule 测试：wrapper/plist/cron/schtasks 纯函数内容 + install --dry-run（绝不真注册系统调度）。

import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  SCHEDULE_ID,
  runnerPath,
  nightlyLogPath,
  nightlyArgs,
  buildRunnerUnix,
  buildRunnerWin,
  buildPlist,
  buildCronBlock,
  buildSchtasksCreateArgs,
  validHourMinute,
} from '../../.agents/scripts/orchestrator/schedule.mjs'
import { mkRepo, runOrch, tryOrch } from './helpers.js'

const ROOT = '/opt/proj root' // 故意带空格：wrapper/注册命令的引号必须扛得住

describe('orchestrator schedule > nightlyArgs 组装', () => {
  it('默认仅 nightly；tests/auto/backend 逐项追加', () => {
    expect(nightlyArgs()).toEqual(['nightly'])
    expect(nightlyArgs({ tests: true })).toEqual(['nightly', '--tests'])
    expect(nightlyArgs({ auto: 3, backend: 'mock' })).toEqual(['nightly', '--auto', '3', '--backend', 'mock'])
    expect(nightlyArgs({ auto: 0 })).toEqual(['nightly']) // auto 非正整数忽略
  })
})

describe('orchestrator schedule > wrapper 生成（路径含空格全带引号）', () => {
  it('unix：cd 仓库 + exec node 绝对路径 + 参数 + 日志追加', () => {
    const s = buildRunnerUnix(ROOT, '/usr/local/bin/node', ['nightly', '--auto', '3'])
    expect(s).toContain(`cd "${ROOT}" || exit 1`)
    expect(s).toContain(`exec "/usr/local/bin/node" "${path.join(ROOT, '.agents', 'scripts', 'orchestrator.mjs')}" nightly --auto 3`)
    expect(s).toContain(`>> "${path.join(ROOT, '.agents', 'orchestrator', 'logs', 'nightly.log')}" 2>&1`)
    expect(s.startsWith('#!/bin/sh')).toBe(true)
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
    expect(xml).toContain(`<string>${SCHEDULE_ID}</string>`)
    expect(xml).toContain('<string>/bin/sh</string>')
    expect(xml).toContain(`<string>${runnerPath(ROOT)}</string>`)
    expect(xml).toContain('<key>Hour</key><integer>2</integer>')
    expect(xml).toContain('<key>Minute</key><integer>30</integer>')
    expect(xml).toContain(`<string>${ROOT}</string>`) // WorkingDirectory
  })

  it('crontab 标记段：BEGIN/END 成对 + 每日 HH:MM', () => {
    const block = buildCronBlock(ROOT, { hour: 2, minute: 30 })
    expect(block.startsWith(`# BEGIN ${SCHEDULE_ID}`)).toBe(true)
    expect(block.endsWith(`# END ${SCHEDULE_ID}`)).toBe(true)
    expect(block).toContain(`30 2 * * * /bin/sh "${runnerPath(ROOT)}"`)
  })

  it('schtasks：/ST 补零 + /TR 内层引号包空格路径', () => {
    const args = buildSchtasksCreateArgs(ROOT, { hour: 2, minute: 5 })
    expect(args).toContain('/ST')
    expect(args[args.indexOf('/ST') + 1]).toBe('02:05')
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
