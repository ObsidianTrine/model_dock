import { describe, expect, it, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fakeHome } from './helpers.js'
import {
  SERVICE_LABEL,
  serviceLabel,
  AUTOSTART_LAUNCH_FLAG,
  WINDOWS_RUN_KEY,
  WINDOWS_RUN_VALUE,
  launchdPlistPath,
  launchdPlistXml,
  readRecordedArgv,
  gatewayDaemonArgs,
  installAutostart,
  uninstallAutostart,
  autostartStatus,
  serviceFilePath,
  systemdUnitIni,
  systemdUnitPath,
  windowsRunValueDisplay,
  windowsRunCommandLine,
  parseRunCommandLine,
  windowsStartupPath,
  relaunchHiddenIfAutostart,
} from '../src/autostart.js'

describe('autostart 服务文件路径', () => {
  it('launchd plist 落在 home/Library/LaunchAgents（fakeHome 可隔离）', () => {
    const h = fakeHome()
    try {
      expect(launchdPlistPath()).toBe(path.join(h.home, 'Library', 'LaunchAgents', `${serviceLabel()}.plist`))
    } finally {
      h.restore()
    }
  })

  it('systemd user unit 落在 home/.config/systemd/user', () => {
    const h = fakeHome()
    try {
      expect(systemdUnitPath()).toBe(path.join(h.home, '.config', 'systemd', 'user', `${serviceLabel()}.service`))
    } finally {
      h.restore()
    }
  })

  it('旧版 VBS 启动项路径（迁移前形态，仅用于残留检测清理）：沙箱忽略 APPDATA（真机「启动」文件夹不可被沙箱写入）', () => {
    const h = fakeHome()
    const prevAppData = process.env.APPDATA
    process.env.APPDATA = path.join(os.tmpdir(), 'appdata-outside-sandbox')
    try {
      expect(windowsStartupPath()).toBe(
        path.join(h.home, 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'modeldock-gateway.vbs')
      )
    } finally {
      if (prevAppData === undefined) delete process.env.APPDATA
      else process.env.APPDATA = prevAppData
      h.restore()
    }
  })

  it('旧版 VBS 启动项路径：非沙箱以显式 APPDATA 为准', () => {
    const prevFake = process.env.MODELRDOCK_FAKE_HOME
    const prevAppData = process.env.APPDATA
    delete process.env.MODELRDOCK_FAKE_HOME
    process.env.APPDATA = path.join(os.tmpdir(), 'appdata-elsewhere')
    try {
      expect(windowsStartupPath()).toBe(
        path.join(os.tmpdir(), 'appdata-elsewhere', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'modeldock-gateway.vbs')
      )
    } finally {
      if (prevFake === undefined) delete process.env.MODELRDOCK_FAKE_HOME
      else process.env.MODELRDOCK_FAKE_HOME = prevFake
      if (prevAppData === undefined) delete process.env.APPDATA
      else process.env.APPDATA = prevAppData
    }
  })
  it('沙箱用独立服务标识（launchctl/systemctl 操作不与生产同名）', () => {
    const h = fakeHome()
    try {
      expect(serviceLabel()).toBe(`${SERVICE_LABEL}.sandbox`)
    } finally {
      h.restore()
    }
    expect(serviceLabel()).toBe(SERVICE_LABEL)
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
    expect(xml).toContain(`<string>${serviceLabel()}</string>`)
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

  it('Windows Run 键：argv 全 token 带引号拼接，与 parseRunCommandLine 无损往返', () => {
    const argv = ['/opt/My App/modeldock.exe', '--sea-gateway']
    const data = windowsRunCommandLine([...argv, AUTOSTART_LAUNCH_FLAG])
    expect(data).toBe('"/opt/My App/modeldock.exe" "--sea-gateway" "--autostart"')
    expect(parseRunCommandLine(data)).toEqual([...argv, AUTOSTART_LAUNCH_FLAG])
    expect(readRecordedArgv(data)).toBeNull() // Run 键不落 argv 标记，命令行本身即可还原
    expect(parseRunCommandLine('no quotes at all')).toBeNull()
  })

  it('Windows Run 键显示路径：HKCU\\...\\Run\\<值名>', () => {
    expect(windowsRunValueDisplay()).toBe(`${WINDOWS_RUN_KEY}\\${WINDOWS_RUN_VALUE}`)
    expect(WINDOWS_RUN_KEY).toBe('HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run')
  })

  it('relaunchHiddenIfAutostart：非 win32 恒 false；注入 argv 仅在 win32 分离 spawn（子进程即时退出）', { timeout: 10_000 }, async () => {
    // 无 --autostart（vitest 进程 argv 没有该标记）→ 不重拉、不 spawn
    expect(await relaunchHiddenIfAutostart()).toBe(false)
    // 注入 argv（测试约定，与 installAutostart 的 opts.argv 同款）：win32 分离 spawn 后立即 resolve
    const r = await relaunchHiddenIfAutostart({ argv: [process.execPath, '-e', 'process.exit(0)'] })
    expect(r).toBe(process.platform === 'win32')
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
    execFileSync('launchctl', ['print', `gui/${uid}/${serviceLabel()}`], { stdio: 'ignore' })
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
    const out = execFileSync('systemctl', ['--user', 'is-active', `${serviceLabel()}.service`], { encoding: 'utf8' })
    return out.trim() === 'active'
  } catch {
    return false
  }
}

describe.skipIf(process.platform !== 'darwin')('autostart 真实生效 > macOS launchd', () => {
  it('install：plutil 校验 + bootstrap 真实加载（无网关 → 健康等待失败抛错，服务保持已加载）；uninstall：bootout + 移除', { timeout: 30_000 }, async (ctx) => {
    if (launchdLoaded()) {
      ctx.skip() // 用户已注册真实自启服务：绝不碰
      return
    }
    const h = fakeHome()
    try {
      let installError: Error | null = null
      try {
        // 假 daemon 必然不就绪：healthTimeoutMs 注入 2s，断言力不变（bootstrap 成功即已加载）
        await installAutostart({ argv: ['/bin/sleep', '30'], healthTimeoutMs: 2_000 })
      } catch (e) {
        installError = e as Error
      }
      // 无网关 → 健康等待必然失败；但服务必须已被 launchd 真实加载（本测试核心断言）
      expect(installError).not.toBeNull()
      expect(installError!.message).toMatch(/未在 2s 内就绪/)
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
    // 守卫必须查「服务文件是否存在」而不只是 launchd 是否加载：本机装了自启但网关以手动方式
    // 运行时（更新后未走 launchd 拉起），加载态为否——此前守卫漏判，本用例会删掉用户真实
    // 自启文件（2026-10-14 本机实测踩中）。真实文件在 = 用户自有自启，绝不触碰。
    const realFile = serviceFilePath()
    if (launchdLoaded() || (realFile != null && fs.existsSync(realFile))) {
      ctx.skip() // 本机已有该 label 的服务或真实自启文件（用户环境），不碰
      return
    }
    const un = await uninstallAutostart()
    expect(un.wasInstalled).toBe(false)
    expect(launchdLoaded()).toBe(false)
  })
})

describe.skipIf(process.platform !== 'linux')('autostart 真实生效 > Linux systemd', () => {
  it('install：daemon-reload + enable --now 真实激活（无网关 → 健康等待失败抛错，服务保持 active）；uninstall：disable + stop + 移除', { timeout: 30_000 }, async (ctx) => {
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
    const realUnit = path.join(os.homedir(), '.config', 'systemd', 'user', `${serviceLabel()}.service`)
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
        await installAutostart({ argv: ['/bin/sleep', '30'], healthTimeoutMs: 2_000 })
      } catch (e) {
        installError = e as Error
      }
      expect(installError).not.toBeNull()
      expect(installError!.message).toMatch(/未在 2s 内就绪/)
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

describe.skipIf(process.platform !== 'win32')('autostart 真实生效 > Windows 注册表 Run 键（沙箱 stand-in）', () => {
  // 沙箱约定：MODELRDOCK_FAKE_HOME 下绝不碰真机注册表，Run 键值数据落在沙箱内镜像文件
  // （modeldockDir()/autostart-run-key.txt），读写删与真注册表共用同一套代码路径。
  let h: ReturnType<typeof fakeHome> | undefined
  let prevAppData: string | undefined

  const mirrorFile = () => path.join(h!.home, '.modeldock', 'autostart-run-key.txt')

  function sandbox(): void {
    h = fakeHome()
    prevAppData = process.env.APPDATA
    process.env.APPDATA = path.join(h.home, 'AppData', 'Roaming')
  }

  afterEach(() => {
    if (prevAppData === undefined) delete process.env.APPDATA
    else process.env.APPDATA = prevAppData
    prevAppData = undefined
    h?.restore()
    h = undefined
  })

  function writeLegacyVbs(argv: string[]): string {
    const marker = 'modeldock-daemon-argv: ' + Buffer.from(JSON.stringify(argv), 'utf8').toString('base64')
    const legacy = windowsStartupPath()
    fs.mkdirSync(path.dirname(legacy), { recursive: true })
    fs.writeFileSync(legacy, `' 由 modeldock gateway install 生成\r\n' ${marker}\r\n' 旧版 VBS\r\n`)
    return legacy
  }

  it('install：Run 键值落沙箱镜像（命令带 --autostart 标记），status 走镜像判定；uninstall 清除且幂等', async () => {
    sandbox()
    const argv = [process.execPath, '--sea-gateway'] // argv[0] 真实存在 → stale=false
    const result = await installAutostart({ argv })
    expect(result.started).toBe(false) // Windows 启动项无运行态可拉起
    expect(result.file).toBe(windowsRunValueDisplay())
    expect(result.note).not.toContain('VBS') // 无旧残留时不提迁移
    expect(fs.readFileSync(mirrorFile(), 'utf8')).toBe(windowsRunCommandLine([...argv, AUTOSTART_LAUNCH_FLAG]))

    const svc = autostartStatus()
    expect(svc?.kind).toBe('windows')
    expect(svc?.installed).toBe(true)
    expect(svc?.loaded).toBe(true)
    expect(svc?.stale).toBe(false)
    expect(svc?.file).toBe(windowsRunValueDisplay())
    expect(svc?.argv).toEqual([...argv, AUTOSTART_LAUNCH_FLAG])

    const un = await uninstallAutostart()
    expect(un.wasInstalled).toBe(true)
    expect(un.removed).toBe(windowsRunValueDisplay())
    expect(fs.existsSync(mirrorFile())).toBe(false)
    expect(autostartStatus()?.installed).toBe(false)
    // 幂等：再卸一次返回 wasInstalled=false 且不报错
    const un2 = await uninstallAutostart()
    expect(un2.wasInstalled).toBe(false)
  })

  it('迁移：install 顺带清理旧 VBS 残留；仅剩旧 VBS（未迁移）时 status 识别、uninstall 也清理', async () => {
    sandbox()
    // 场景一：旧 VBS 在场 → status 按 VBS 报已安装（升级后自启仍有效），install 新形态并顺带删 VBS
    const legacyArgv = [process.execPath, '--sea-gateway']
    const legacy = writeLegacyVbs(legacyArgv)
    const svc0 = autostartStatus()
    expect(svc0?.installed).toBe(true)
    expect(svc0?.file).toBe(legacy)
    expect(svc0?.argv).toEqual(legacyArgv)
    const result = await installAutostart({ argv: [process.execPath, '--sea-gateway'] })
    expect(result.note).toContain('VBS') // 提及已清理旧版 VBS
    expect(fs.existsSync(legacy)).toBe(false)
    expect(autostartStatus()?.file).toBe(windowsRunValueDisplay())

    // 收掉 Run 键，进入场景二：只有旧 VBS、没有 Run 键（升级后从未重装）→ uninstall 也认账并清理
    await uninstallAutostart()
    expect(fs.existsSync(mirrorFile())).toBe(false)
    const legacy2 = writeLegacyVbs(legacyArgv)
    const un = await uninstallAutostart()
    expect(un.wasInstalled).toBe(true)
    expect(fs.existsSync(legacy2)).toBe(false)
  })

  it('install：reg add 真实写入 HKCU Run 键；uninstall：reg delete 移除（本机已有任何真实自启痕迹则 skip：绝不碰用户环境）', { timeout: 30_000 }, async (ctx) => {
    if (process.env.MODELRDOCK_FAKE_HOME) {
      ctx.skip() // 沙箱环境写不了真注册表（stand-in 接管），上面两条用例已覆盖代码路径
      return
    }
    // 与 launchd/systemd 真实生效用例同一守则：真实系统已有 ModelDock 自启痕迹或网关登记时，
    // 一律 skip——install 的迁移步骤会删旧 VBS、uninstall 会动真注册表，绝不能碰用户环境
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
    const realLegacy = path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'modeldock-gateway.vbs')
    const realRunValue = () => {
      try {
        execFileSync('reg', ['query', WINDOWS_RUN_KEY, '/v', WINDOWS_RUN_VALUE], { stdio: 'ignore' })
        return true
      } catch {
        return false
      }
    }
    if (realRunValue() || fs.existsSync(realLegacy) || fs.existsSync(path.join(os.homedir(), '.modeldock', 'gateway.json'))) {
      ctx.skip()
      return
    }
    try {
      // 本用例是写入门禁豁免开关的首个合法场景（fsx「有意写真实 home」）：刻意脱离沙箱打真
      // 注册表（CI runner 账号可弃、真实用户机器被上方守则 skip），installAutostart 会随之把
      // Run 键镜像文件落真实 home——不豁免即被门禁拒写（v1.5.2 windows CI 首曝）
      process.env.MODELRDOCK_ALLOW_REAL_HOME_WRITE = '1'
      const argv = ['C:\\Windows\\System32\\cmd.exe', '--sea-gateway']
      const result = await installAutostart({ argv })
      expect(result.started).toBe(false)
      expect(realRunValue()).toBe(true)
      const svc = autostartStatus()
      expect(svc?.installed).toBe(true)
      expect(svc?.argv).toEqual([...argv, AUTOSTART_LAUNCH_FLAG])
      const un = await uninstallAutostart()
      expect(un.wasInstalled).toBe(true)
      expect(realRunValue()).toBe(false)
    } finally {
      delete process.env.MODELRDOCK_ALLOW_REAL_HOME_WRITE
      // 兜底清理：本用例创建的 Run 键与镜像文件绝不残留（uninstall 正常路径已删，此处兜崩溃中途）
      try {
        execFileSync('reg', ['delete', WINDOWS_RUN_KEY, '/v', WINDOWS_RUN_VALUE, '/f'], { stdio: 'ignore' })
      } catch {
        /* 本就不存在 */
      }
      try {
        fs.rmSync(path.join(os.homedir(), '.modeldock', 'autostart-run-key.txt'), { force: true })
      } catch {
        /* 本就不存在 */
      }
    }
  })
})
