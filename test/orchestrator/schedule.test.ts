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
