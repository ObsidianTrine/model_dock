import { describe, expect, it, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fakeHome } from './helpers.js'
import {
  SERVICE_LABEL,
  launchdPlistPath,
  launchdPlistXml,
  readRecordedArgv,
  gatewayDaemonArgs,
  installAutostart,
  uninstallAutostart,
  systemdUnitIni,
  systemdUnitPath,
  windowsStartupPath,
  windowsVbs,
} from '../src/autostart.js'

describe('autostart 服务文件路径', () => {
  it('launchd plist 落在 home/Library/LaunchAgents（fakeHome 可隔离）', () => {
    const h = fakeHome()
    try {
      expect(launchdPlistPath()).toBe(path.join(h.home, 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`))
    } finally {
      h.restore()
    }
  })

  it('systemd user unit 落在 home/.config/systemd/user', () => {
    const h = fakeHome()
    try {
      expect(systemdUnitPath()).toBe(path.join(h.home, '.config', 'systemd', 'user', `${SERVICE_LABEL}.service`))
    } finally {
      h.restore()
    }
  })

  it('Windows 启动项以显式 APPDATA 为准', () => {
    const h = fakeHome()
    const prev = process.env.APPDATA
    process.env.APPDATA = path.join(h.home, 'AppData', 'Roaming')
    try {
      expect(windowsStartupPath()).toBe(
        path.join(h.home, 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'modeldock-gateway.vbs')
      )
    } finally {
      if (prev === undefined) delete process.env.APPDATA
      else process.env.APPDATA = prev
      h.restore()
    }
  })
})

describe('gatewayDaemonArgs：daemon 启动命令按安装形态推导', () => {
  it('SEA：二进制自身 + --sea-gateway', () => {
    expect(gatewayDaemonArgs({ execPath: '/opt/modeldock', entry: '/any/cli.js' })).toEqual([
      '/opt/modeldock',
      '--sea-gateway',
    ])
  })

  it('npm 安装：node + cli 入口 + --sea-gateway', () => {
    expect(gatewayDaemonArgs({ execPath: '/usr/local/bin/node', entry: '/g/lib/node_modules/modeldock/dist/cli.js' })).toEqual([
      '/usr/local/bin/node',
      '/g/lib/node_modules/modeldock/dist/cli.js',
      '--sea-gateway',
    ])
  })

  it('dev：经项目内 tsx 直跑 cli.ts（入口不能是 main.ts——它没有自启动分支）', () => {
    const h = fakeHome()
    try {
      const proj = path.join(h.home, 'proj')
      const tsxCli = path.join(proj, 'node_modules', 'tsx', 'dist', 'cli.mjs')
      fs.mkdirSync(path.dirname(tsxCli), { recursive: true })
      fs.writeFileSync(tsxCli, '// tsx')
      const entry = path.join(proj, 'src', 'cli.ts')
      expect(gatewayDaemonArgs({ execPath: '/usr/local/bin/node', entry })).toEqual([
        '/usr/local/bin/node',
        tsxCli,
        entry,
        '--sea-gateway',
      ])
    } finally {
      h.restore()
    }
  })

  it('dev 但 tsx 缺失 / 无入口信息：退回 --sea-gateway 形态', () => {
    const h = fakeHome()
    try {
      expect(gatewayDaemonArgs({ execPath: '/usr/local/bin/node', entry: path.join(h.home, 'proj', 'src', 'cli.ts') })).toEqual([
        '/usr/local/bin/node',
        '--sea-gateway',
      ])
      expect(gatewayDaemonArgs({ execPath: '/usr/local/bin/node', entry: undefined })).toEqual([
        '/usr/local/bin/node',
        '--sea-gateway',
      ])
    } finally {
      h.restore()
    }
  })
})

describe('服务文件内容生成与登记命令回读', () => {
  it('launchd plist：RunAtLoad + KeepAlive + 参数逐条登记，XML 特殊字符转义', () => {
    const xml = launchdPlistXml(
      ['/usr/local/bin/node', '/a&b/cli.js', '--sea-gateway'],
      '/w',
      '/o.log',
      '/e.log'
    )
    expect(xml).toContain(`<string>${SERVICE_LABEL}</string>`)
    expect(xml).toContain('<key>RunAtLoad</key>\n  <true/>')
    expect(xml).toContain('<key>KeepAlive</key>\n  <true/>')
    expect(xml).toContain('<string>/a&amp;b/cli.js</string>')
    expect(xml).toContain('<string>--sea-gateway</string>')
    expect(xml).toContain('<string>/w</string>')
    expect(readRecordedArgv(xml)).toEqual(['/usr/local/bin/node', '/a&b/cli.js', '--sea-gateway'])
  })

  it('systemd unit：ExecStart 引号包裹含空格路径，%/$ 转义', () => {
    const ini = systemdUnitIni(
      ['/usr/local/bin/node', '/opt/My App/cli.js', '--sea-gateway'],
      '/w%dir',
      '/o.log',
      '/e.log'
    )
    expect(ini).toContain('ExecStart="/usr/local/bin/node" "/opt/My App/cli.js" "--sea-gateway"')
    expect(ini).toContain('WorkingDirectory=/w%%dir')
    expect(ini).toContain('Restart=always')
    expect(ini).toContain('WantedBy=default.target')
    expect(readRecordedArgv(ini)).toEqual(['/usr/local/bin/node', '/opt/My App/cli.js', '--sea-gateway'])
  })

  it('Windows VBS：隐藏窗口启动，VB 字符串内引号翻倍', () => {
    const vbs = windowsVbs(['/opt/My App/modeldock.exe', '--sea-gateway'])
    expect(vbs).toContain(
      'CreateObject("WScript.Shell").Run """/opt/My App/modeldock.exe"" ""--sea-gateway""", 0, False'
    )
    expect(vbs).toContain('\r\n')
    expect(readRecordedArgv(vbs)).toEqual(['/opt/My App/modeldock.exe', '--sea-gateway'])
  })

  it('登记命令标记损坏时返回 null（回退到当前 argv）', () => {
    expect(readRecordedArgv('# modeldock-daemon-argv: !!!not-b64!!!')).toBeNull()
    expect(readRecordedArgv('no marker at all')).toBeNull()
  })
})

// 真实生效层（launchctl / systemctl / 启动文件夹）：此前零覆盖。
// 守则：daemon 用 /bin/sleep 桩（不拉起真实网关、不碰 8687/8890）；KeepAlive/
// Restart 的桩在 bootout/disable 后即死，不残留；测试前探测用户真实服务，
// 已加载则 skip（绝不碰用户已注册的自启服务）。

function launchdLoaded(): boolean {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 501
  try {
    execFileSync('launchctl', ['print', `gui/${uid}/${SERVICE_LABEL}`], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function systemdUserAvailable(): boolean {
  try {
    execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function systemdActive(): boolean {
  try {
    const out = execFileSync('systemctl', ['--user', 'is-active', `${SERVICE_LABEL}.service`], { encoding: 'utf8' })
    return out.trim() === 'active'
  } catch {
    return false
  }
}

describe.skipIf(process.platform !== 'darwin')('autostart 真实生效 > macOS launchd', () => {
  it('install：plutil 校验 + bootstrap 真实加载（无网关 → 10s 健康等待失败抛错，服务保持已加载）；uninstall：bootout + 移除', { timeout: 30_000 }, async (ctx) => {
    if (launchdLoaded()) {
      ctx.skip() // 用户已注册真实自启服务：绝不碰
      return
    }
    const h = fakeHome()
    try {
      let installError: Error | null = null
      try {
        await installAutostart({ argv: ['/bin/sleep', '30'] })
      } catch (e) {
        installError = e as Error
      }
      // 无网关 → 健康等待必然失败；但服务必须已被 launchd 真实加载（本测试核心断言）
      expect(installError).not.toBeNull()
      expect(installError!.message).toMatch(/未在 10s 内就绪/)
      expect(launchdLoaded()).toBe(true)
      expect(fs.existsSync(launchdPlistPath())).toBe(true)

      const un = await uninstallAutostart()
      expect(un.wasInstalled).toBe(true)
      expect(launchdLoaded()).toBe(false)
      expect(fs.existsSync(launchdPlistPath())).toBe(false)
    } finally {
      try { if (launchdLoaded()) uninstallAutostart() } catch { /* 兜底清理失败不影响判定 */ }
      h.restore()
    }
  })

  it('uninstall 幂等：未安装时调用返回 wasInstalled=false 且不动系统', async (ctx) => {
    if (launchdLoaded()) {
      ctx.skip() // 本机已有该 label 的服务（用户真实自启或残留加载），幂等路径不适用
      return
    }
    const un = await uninstallAutostart()
    expect(un.wasInstalled).toBe(false)
    expect(launchdLoaded()).toBe(false)
  })
})

describe.skipIf(process.platform !== 'linux')('autostart 真实生效 > Linux systemd', () => {
  it('install：daemon-reload + enable --now 真实激活（无网关 → 10s 健康等待失败抛错，服务保持 active）；uninstall：disable + stop + 移除', { timeout: 30_000 }, async (ctx) => {
    if (!systemdUserAvailable()) {
      ctx.skip() // CI runner 可能没有 systemd 用户实例
      return
    }
    if (systemdActive()) {
      ctx.skip() // 已有真实服务在跑（用户环境），不碰
      return
    }
    // 注意：不能用 fakeHome——systemd 用户管理器只读真实 ~/.config/systemd/user，
    // 不受测试进程 homeDir 影响（曾因此 enable 报 unit 不存在）。改用真实路径 + 守卫：
    const realUnit = path.join(os.homedir(), '.config', 'systemd', 'user', `${SERVICE_LABEL}.service`)
    if (fs.existsSync(realUnit)) {
      ctx.skip() // 用户已注册真实自启 unit：绝不碰
      return
    }
    const stateFile = path.join(os.homedir(), '.modeldock', 'gateway.json')
    if (fs.existsSync(stateFile)) {
      // 本机有网关登记（可能正在服务真实客户端）：不安全，跳过真实链路测试
      ctx.skip()
      return
    }
    try {
      let installError: Error | null = null
      try {
        await installAutostart({ argv: ['/bin/sleep', '30'] })
      } catch (e) {
        installError = e as Error
      }
      expect(installError).not.toBeNull()
      expect(installError!.message).toMatch(/未在 10s 内就绪/)
      expect(systemdActive()).toBe(true)
      expect(fs.existsSync(systemdUnitPath())).toBe(true)

      const un = await uninstallAutostart()
      expect(un.wasInstalled).toBe(true)
      expect(systemdActive()).toBe(false)
      expect(fs.existsSync(systemdUnitPath())).toBe(false)
    } finally {
      try { if (systemdActive()) uninstallAutostart() } catch { /* 兜底清理 */ }
    }
  })
})

describe.skipIf(process.platform !== 'win32')('autostart 真实生效 > Windows 启动文件夹', () => {
  it('install：VBS 落入 Startup 文件夹（登录执行的注册即生效形态）；uninstall：移除', async () => {
    const h = fakeHome()
    const prev = process.env.APPDATA
    process.env.APPDATA = path.join(h.home, 'AppData', 'Roaming')
    try {
      const result = await installAutostart({ argv: ['C:\\bin\\modeldock.exe', '--sea-gateway'] })
      expect(result.started).toBe(false) // Windows 启动项无运行态可拉起
      expect(fs.existsSync(windowsStartupPath())).toBe(true)
      expect(fs.readFileSync(windowsStartupPath(), 'utf8')).toContain('--sea-gateway')
      const un = await uninstallAutostart()
      expect(un.wasInstalled).toBe(true)
      expect(fs.existsSync(windowsStartupPath())).toBe(false)
    } finally {
      if (prev === undefined) delete process.env.APPDATA
      else process.env.APPDATA = prev
      h.restore()
    }
  })
})
