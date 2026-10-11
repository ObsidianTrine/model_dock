import { describe, expect, it } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { fakeHome } from './helpers.js'
import type { HarnessAdapter } from '../src/adapters/types.js'
import { emptyConfig } from '../src/config/types.js'
import { saveConfig } from '../src/config/store.js'
import { buildRuntime } from '../src/gateway/state.js'
import { createGatewayServer, runClientInstall, runClientUninstall } from '../src/gateway/server.js'
import { dshAdapter } from '../src/adapters/dsh.js'
import { isNpmGlobalInstall } from '../src/adapters/types.js'
import { commandOnPath, commandOnPathResolved, commandOnPathSandbox } from '../src/util/fsx.js'
import { sandboxNpmCache, sandboxNpmPrefix } from '../src/util/paths.js'
import { getLang, setLang } from '../src/util/i18n.js'

function listenEphemeral(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port))
  })
}

async function setup() {
  const h = fakeHome()
  const cfg = emptyConfig()
  cfg.security = { store: 'file' }
  await saveConfig(cfg)
  const rt = buildRuntime(cfg, 'admin-token-x')
  const server = createGatewayServer(rt, { port: 0 })
  const gwPort = await listenEphemeral(server)
  return {
    gwPort,
    closeAll: () => {
      server.close()
      h.restore()
    },
  }
}

function postInstall(port: number, harness: string) {
  return fetch(`http://127.0.0.1:${port}/_modeldock/install`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-modeldock-admin': 'admin-token-x' },
    body: JSON.stringify({ harness }),
  }).then((r) => r.json())
}

/** 桩命令放行：沙箱 gate 只放行 npm 全局安装，单测的 node -e 桩需要显式豁免（受控环境专用） */
function allowStubCommands(): () => void {
  const prev = process.env.MODELRDOCK_INSTALL_ALLOW_ANY
  process.env.MODELRDOCK_INSTALL_ALLOW_ANY = '1'
  return () => {
    if (prev === undefined) delete process.env.MODELRDOCK_INSTALL_ALLOW_ANY
    else process.env.MODELRDOCK_INSTALL_ALLOW_ANY = prev
  }
}

describe('客户端安装并接入', () => {
  it('status clients[] 携带 install 元数据：npm 类 auto=true，手动类 auto=false', async () => {
    const t = await setup()
    try {
      const j: any = await fetch(`http://127.0.0.1:${t.gwPort}/_modeldock/overview`, {
        headers: { 'x-modeldock-admin': 'admin-token-x' },
      }).then((r) => r.json())
      expect(j.ok).toBe(true)
      const cc = j.clients.find((c: any) => c.id === 'claude-code')
      expect(cc.install.auto).toBe(true)
      expect(cc.install.command).toContain('npm i -g')
      expect(typeof cc.install.guide).toBe('string')
      const mimo = j.clients.find((c: any) => c.id === 'mimo-code')
      expect(mimo.install.auto).toBe(true)
      // 平台映射命令解析后是小米官方安装脚本（零依赖、大陆 CDN），npm 路径退居手动兜底指引
      expect(mimo.install.command).toContain('mimo.xiaomi.com/install')
      expect(mimo.install.homepage).toContain('mimo.xiaomi.com')
      const dsh = j.clients.find((c: any) => c.id === 'dsh')
      expect(dsh.install.auto).toBe(true)
      expect(dsh.install.command).toContain('@deepseek-ai/dsh')
      // 桌面端官网页；download.deepseek.com 根域是聊天 App 下载页（Harness 桌面端不在那里），别指回去
      expect(dsh.install.homepage).toBe('https://www.deepseek.com/harness')
      expect(dsh.install.guide).not.toContain('download.deepseek.com')
    } finally {
      t.closeAll()
    }
  })

  it('手动类客户端：/install 不执行命令、不写文件，仅返回指引', async () => {
    const t = await setup()
    try {
      const r: any = await postInstall(t.gwPort, 'workbuddy')
      expect(r.ok).toBe(true)
      expect(r.auto).toBe(false)
      // 手动安装类客户端不应产生任何配置文件
      const home = process.env.MODELRDOCK_FAKE_HOME!
      expect(fs.existsSync(path.join(home, '.workbuddy-ai'))).toBe(false)
    } finally {
      t.closeAll()
    }
  })

  it('自动安装：命令成功后补写 bootstrap 空配置，re-detect 为已安装', async () => {
    const h = fakeHome()
    const restoreAllow = allowStubCommands()
    try {
      const home = process.env.MODELRDOCK_FAKE_HOME!
      const boot = path.join(home, '.claude', 'settings.json')
      const fake: HarnessAdapter = {
        id: 'fake',
        label: 'Fake',
        install: {
          command: 'node -e ""', // 无副作用：立即成功
          guide: 'x',
          bootstrap: { path: boot, content: '{}\n' },
        },
        detect: async () => ({ installed: false, configFiles: [] }),
        planAttach: async () => ({ changes: [], notes: [] }),
        planDetach: async () => ({ changes: [], notes: [] }),
        status: async () => ({ installed: fs.existsSync(boot), attached: false }),
      }
      const cfg = emptyConfig()
      const r = await runClientInstall(fake, cfg, 8687)
      expect(r.ok).toBe(true)
      expect(r.auto).toBe(true)
      expect(r.installed).toBe(true)
      expect(fs.readFileSync(boot, 'utf8')).toBe('{}\n')
    } finally {
      restoreAllow()
      h.restore()
    }
  })

  it('自动安装：命令失败返回 {ok:false} 且不写配置文件', async () => {
    const h = fakeHome()
    const restoreAllow = allowStubCommands()
    try {
      const home = process.env.MODELRDOCK_FAKE_HOME!
      const boot = path.join(home, '.claude', 'settings.json')
      const fake: HarnessAdapter = {
        id: 'fake-fail',
        label: 'FakeFail',
        install: {
          command: 'node -e "process.exit(3)"',
          guide: 'x',
          bootstrap: { path: boot, content: '{}\n' },
        },
        detect: async () => ({ installed: false, configFiles: [] }),
        planAttach: async () => ({ changes: [], notes: [] }),
        planDetach: async () => ({ changes: [], notes: [] }),
        status: async () => ({ installed: fs.existsSync(boot), attached: false }),
      }
      const cfg = emptyConfig()
      const r = await runClientInstall(fake, cfg, 8687)
      expect(r.ok).toBe(false)
      expect(r.auto).toBe(true)
      expect(fs.existsSync(boot)).toBe(false)
    } finally {
      restoreAllow()
      h.restore()
    }
  })

  it('probe 命中（命令已在 PATH）：跳过安装命令，不重跑 npm 全局安装', async () => {
    const h = fakeHome()
    try {
      const home = process.env.MODELRDOCK_FAKE_HOME!
      const boot = path.join(home, '.claude', 'settings.json')
      // 命令故意写成必然失败：真被执行的话 ok 会是 false，测试即失败
      const fake: HarnessAdapter = {
        id: 'fake-probe',
        label: 'FakeProbe',
        install: {
          command: 'node -e "process.exit(3)"',
          probe: 'claude',
          guide: 'x',
          bootstrap: { path: boot, content: '{}\n' },
        },
        detect: async () => ({ installed: false, configFiles: [] }),
        planAttach: async () => ({ changes: [], notes: [] }),
        planDetach: async () => ({ changes: [], notes: [] }),
        status: async () => ({ installed: fs.existsSync(boot), attached: false }),
      }
      const binDir = path.join(h.home, 'bin')
      fs.mkdirSync(binDir, { recursive: true })
      fs.writeFileSync(path.join(binDir, process.platform === 'win32' ? 'claude.cmd' : 'claude'), '')

      const savedPath = process.env.PATH
      const savedAppData = process.env.APPDATA
      process.env.PATH = binDir
      delete process.env.APPDATA // commandOnPath 在 Windows 还会兜底扫 %APPDATA%\npm
      try {
        const r = await runClientInstall(fake, emptyConfig(), 8687)
        expect(r.ok).toBe(true)
        expect(r.skipped).toBe(true)
        expect(r.output).toContain('跳过安装')
        // 跳过安装也要补写 bootstrap，否则 detect 仍是未安装
        expect(fs.readFileSync(boot, 'utf8')).toBe('{}\n')
      } finally {
        if (savedPath === undefined) delete process.env.PATH
        else process.env.PATH = savedPath
        if (savedAppData === undefined) delete process.env.APPDATA
        else process.env.APPDATA = savedAppData
      }
    } finally {
      h.restore()
    }
  })

  it('bootstrap 文件已存在时原样保留，不覆盖用户已有配置', async () => {
    const h = fakeHome()
    const restoreAllow = allowStubCommands()
    try {
      const home = process.env.MODELRDOCK_FAKE_HOME!
      const boot = path.join(home, '.claude', 'settings.json')
      fs.mkdirSync(path.dirname(boot), { recursive: true })
      fs.writeFileSync(boot, '{"env":{"KEEP":"me"}}\n')
      const fake: HarnessAdapter = {
        id: 'fake-keep',
        label: 'FakeKeep',
        install: {
          command: 'node -e ""',
          guide: 'x',
          bootstrap: { path: boot, content: '{}\n' },
        },
        detect: async () => ({ installed: true, configFiles: [boot] }),
        planAttach: async () => ({ changes: [], notes: [] }),
        planDetach: async () => ({ changes: [], notes: [] }),
        status: async () => ({ installed: true, attached: false }),
      }
      const r = await runClientInstall(fake, emptyConfig(), 8687)
      expect(r.ok).toBe(true)
      expect(r.skipped).toBe(false)
      expect(r.output).toContain('保留不动')
      expect(fs.readFileSync(boot, 'utf8')).toBe('{"env":{"KEEP":"me"}}\n')
    } finally {
      restoreAllow()
      h.restore()
    }
  })

  it('语言即地区策略：zh 注入镜像 registry，en 不注入（保留官方源与用户自有配置）', async () => {
    const h = fakeHome()
    const restoreAllow = allowStubCommands()
    const savedLang = getLang()
    const savedReg = process.env.MODELRDOCK_NPM_REGISTRY
    delete process.env.MODELRDOCK_NPM_REGISTRY
    try {
      const fake: HarnessAdapter = {
        id: 'fake-reg',
        label: 'FakeReg',
        install: {
          command: 'node -e "process.stdout.write(process.env.npm_config_registry||\'\')"',
          guide: 'x',
        },
        detect: async () => ({ installed: false, configFiles: [] }),
        planAttach: async () => ({ changes: [], notes: [] }),
        planDetach: async () => ({ changes: [], notes: [] }),
        status: async () => ({ installed: false, attached: false }),
      }
      setLang('zh')
      const r1 = await runClientInstall(fake, emptyConfig(), 8687)
      expect(r1.ok).toBe(true)
      expect(r1.output).toContain('registry.npmmirror.com')
      setLang('en')
      const r2 = await runClientInstall(fake, emptyConfig(), 8687)
      expect(r2.ok).toBe(true)
      expect(r2.output).not.toContain('npmmirror')
    } finally {
      restoreAllow()
      setLang(savedLang)
      if (savedReg === undefined) delete process.env.MODELRDOCK_NPM_REGISTRY
      else process.env.MODELRDOCK_NPM_REGISTRY = savedReg
      h.restore()
    }
  })

  it('安装子进程剥离 npm_* 环境泄漏（npx 拉起的网关会把宿主 prefix 带进来）', async () => {
    const h = fakeHome()
    const restoreAllow = allowStubCommands()
    const keys = ['npm_config_prefix', 'npm_config_globalconfig', 'npm_execpath', 'npm_config_registry']
    const saved: Record<string, string | undefined> = {}
    for (const k of keys) {
      saved[k] = process.env[k]
      process.env[k] = k === 'npm_config_registry' ? 'http://leaked-registry.example' : '/leaked/nvm-prefix'
    }
    const savedLang = getLang()
    try {
      const fake: HarnessAdapter = {
        id: 'fake-leak',
        label: 'FakeLeak',
        install: {
          command: 'node -e "process.stdout.write([process.env.npm_config_prefix||\'STRIPPED\',process.env.npm_config_globalconfig||\'STRIPPED\',process.env.npm_execpath||\'NOEXEC\',process.env.npm_config_registry||\'NOREG\'].join(\'|\'))"',
          guide: 'x',
        },
        detect: async () => ({ installed: false, configFiles: [] }),
        planAttach: async () => ({ changes: [], notes: [] }),
        planDetach: async () => ({ changes: [], notes: [] }),
        status: async () => ({ installed: false, attached: false }),
      }
      setLang('zh')
      const r = await runClientInstall(fake, emptyConfig(), 8687)
      expect(r.ok).toBe(true)
      // 宿主泄漏全部剥离；registry 由地区策略重新注入（zh=镜像）而非继承泄漏值；
      // npm_config_prefix 在沙箱下被受控重注入为沙箱落点（真机值绝不穿透）
      expect(r.output).toContain(
        `${sandboxNpmPrefix()}|STRIPPED|NOEXEC|https://registry.npmmirror.com`
      )
    } finally {
      restoreAllow()
      setLang(savedLang)
      for (const k of keys) {
        if (saved[k] === undefined) delete process.env[k]
        else process.env[k] = saved[k]!
      }
      h.restore()
    }
  })

  it('needsNode：托管运行时 bin 目录前置到子进程 PATH（FORCE_DOWNLOAD 注入点，不触发下载）', async () => {
    const h = fakeHome()
    const restoreAllow = allowStubCommands()
    const envs = ['MODELRDOCK_NODE_FORCE_DOWNLOAD', 'MODELRDOCK_NODE_VERSION']
    const saved = envs.map((k) => process.env[k])
    try {
      const home = process.env.MODELRDOCK_FAKE_HOME!
      const binDir = process.platform === 'win32'
        ? path.join(home, '.modeldock', 'runtime', 'node', 'v0.0.0-test')
        : path.join(home, '.modeldock', 'runtime', 'node', 'v0.0.0-test', 'bin')
      fs.mkdirSync(binDir, { recursive: true })
      // Windows 无 shebang 回落：cmd 命中 PATH 里的 node.exe 即执行，文本桩会报
      // 「不是有效的 Win32 程序」且不继续搜后续目录——桩必须是真实可执行体（拷当前 node）
      if (process.platform === 'win32') {
        fs.copyFileSync(process.execPath, path.join(binDir, 'node.exe'))
      } else {
        // unix：无执行位的桩会被 shell 跳过，回落 PATH 后续的真实 node
        fs.writeFileSync(path.join(binDir, 'node'), '#!/bin/sh\n')
      }
      process.env.MODELRDOCK_NODE_FORCE_DOWNLOAD = '1'
      process.env.MODELRDOCK_NODE_VERSION = '0.0.0-test'
      const fake: HarnessAdapter = {
        id: 'fake-nrt',
        label: 'FakeNrt',
        install: {
          command: 'node -e "process.stdout.write(process.env.PATH||\'\')"',
          needsNode: true,
          guide: 'x',
        },
        detect: async () => ({ installed: false, configFiles: [] }),
        planAttach: async () => ({ changes: [], notes: [] }),
        planDetach: async () => ({ changes: [], notes: [] }),
        status: async () => ({ installed: false, attached: false }),
      }
      const r = await runClientInstall(fake, emptyConfig(), 8687)
      expect(r.ok).toBe(true)
      expect(r.output).toContain(binDir)
    } finally {
      restoreAllow()
      envs.forEach((k, i) => {
        if (saved[i] === undefined) delete process.env[k]
        else process.env[k] = saved[i]!
      })
      h.restore()
    }
  })

  it('dsh probe 命中：跳过 npm 安装，仍预写 ~/.dsh/settings.yaml 骨架（boot 后 detect 即 installed）', async () => {
    const h = fakeHome()
    try {
      const home = process.env.MODELRDOCK_FAKE_HOME!
      const binDir = path.join(home, 'bin')
      fs.mkdirSync(binDir, { recursive: true })
      fs.writeFileSync(path.join(binDir, process.platform === 'win32' ? 'dsh.cmd' : 'dsh'), '')
      const savedPath = process.env.PATH
      const savedAppData = process.env.APPDATA
      process.env.PATH = binDir
      delete process.env.APPDATA
      try {
        const r = await runClientInstall(dshAdapter, emptyConfig(), 8687)
        expect(r.ok).toBe(true)
        expect(r.skipped).toBe(true)
        expect(r.installed).toBe(true)
        const settings = path.join(home, '.dsh', 'settings.yaml')
        expect(fs.readFileSync(settings, 'utf8')).toContain('llm-pi-ai')
      } finally {
        if (savedPath === undefined) delete process.env.PATH
        else process.env.PATH = savedPath
        if (savedAppData === undefined) delete process.env.APPDATA
        else process.env.APPDATA = savedAppData
      }
    } finally {
      h.restore()
    }
  })

  it('isNpmGlobalInstall：npm 全局安装放行，脚本类/本地安装拒绝', () => {
    expect(isNpmGlobalInstall('npm i -g @anthropic-ai/claude-code')).toBe(true)
    expect(isNpmGlobalInstall('npm install -g @deepseek-ai/dsh')).toBe(true)
    expect(isNpmGlobalInstall('npm i --global opencode-ai')).toBe(true)
    expect(isNpmGlobalInstall('npm i --registry=https://registry.npmmirror.com -g @openai/codex')).toBe(true)
    expect(isNpmGlobalInstall('npm i @scope/pkg')).toBe(false)
    expect(isNpmGlobalInstall('curl -fsSL https://mimo.xiaomi.com/install | bash')).toBe(false)
    expect(isNpmGlobalInstall('powershell -NoProfile -Command "irm https://mimo.xiaomi.com/install.ps1 | iex"')).toBe(false)
    expect(isNpmGlobalInstall('node -e ""')).toBe(false)
    expect(isNpmGlobalInstall('')).toBe(false)
  })

  it('沙箱 gate：脚本类安装拒绝执行（blocked），bootstrap 不写', async () => {
    const h = fakeHome()
    try {
      const home = process.env.MODELRDOCK_FAKE_HOME!
      const boot = path.join(home, '.mimo-mock', 'config.json')
      const fake: HarnessAdapter = {
        id: 'fake-script',
        label: 'FakeScript',
        install: {
          command: 'curl -fsSL https://example.invalid/install | bash',
          guide: '手动装',
          bootstrap: { path: boot, content: '{}\n' },
        },
        detect: async () => ({ installed: false, configFiles: [] }),
        planAttach: async () => ({ changes: [], notes: [] }),
        planDetach: async () => ({ changes: [], notes: [] }),
        status: async () => ({ installed: false, attached: false }),
      }
      const r = await runClientInstall(fake, emptyConfig(), 8687)
      expect(r.ok).toBe(false)
      expect(r.blocked).toBe(true)
      expect(r.output).toContain('不支持自动安装')
      expect(r.output).toContain('example.invalid')
      expect(fs.existsSync(boot)).toBe(false)
    } finally {
      h.restore()
    }
  })

  it('沙箱 env：npm 全局安装子进程注入沙箱 prefix/cache，真机全局零改动', async () => {
    const h = fakeHome()
    const restoreAllow = allowStubCommands()
    try {
      expect(sandboxNpmPrefix()).toBe(path.join(process.env.MODELRDOCK_FAKE_HOME!, '.modeldock', 'npm-global'))
      const fake: HarnessAdapter = {
        id: 'fake-npm',
        label: 'FakeNpm',
        install: {
          command: 'node -e "process.stdout.write([process.env.npm_config_prefix||\'NOPREFIX\',process.env.npm_config_cache||\'NOCACHE\'].join(\'|\'))"',
          guide: 'x',
        },
        detect: async () => ({ installed: false, configFiles: [] }),
        planAttach: async () => ({ changes: [], notes: [] }),
        planDetach: async () => ({ changes: [], notes: [] }),
        status: async () => ({ installed: false, attached: false }),
      }
      const r = await runClientInstall(fake, emptyConfig(), 8687)
      expect(r.ok).toBe(true)
      // 输出尾部还有「已执行安装命令」说明行，断言用 toContain
      expect(r.output).toContain(`${sandboxNpmPrefix()}|${sandboxNpmCache()}`)
      expect(r.output).toContain(path.join('.modeldock', 'npm-global'))
      expect(r.output).toContain(path.join('.modeldock', 'npm-cache'))
    } finally {
      restoreAllow()
      h.restore()
    }
  })

  it('沙箱探测回落：装进沙箱 npm-global 的 shim 能被 commandOnPath 看到（PATH 不含它也命中）', async () => {
    const h = fakeHome()
    const savedPath = process.env.PATH
    const savedAppData = process.env.APPDATA
    try {
      const binDir = sandboxNpmBinDirPath()
      fs.mkdirSync(binDir, { recursive: true })
      // 可执行桩：unix 需真实文件（isFile），win 命中 PATHEXT 后缀
      if (process.platform === 'win32') {
        fs.writeFileSync(path.join(binDir, 'fakecli.cmd'), '@echo ok\r\n')
      } else {
        fs.writeFileSync(path.join(binDir, 'fakecli'), '#!/bin/sh\necho ok\n')
        fs.chmodSync(path.join(binDir, 'fakecli'), 0o755)
      }
      process.env.PATH = '' // 证明命中来自沙箱 bin 目录，而非继承 PATH
      delete process.env.APPDATA
      expect(commandOnPathResolved('fakecli')).toBe(
        path.join(binDir, process.platform === 'win32' ? 'fakecli.cmd' : 'fakecli')
      )
    } finally {
      if (savedPath === undefined) delete process.env.PATH
      else process.env.PATH = savedPath
      if (savedAppData === undefined) delete process.env.APPDATA
      else process.env.APPDATA = savedAppData
      h.restore()
    }
  })

  it('overview install.sandboxInstall：npm 类=redirect、脚本类=unsupported、指引类=null', async () => {
    const t = await setup()
    try {
      const j: any = await fetch(`http://127.0.0.1:${t.gwPort}/_modeldock/overview`, {
        headers: { 'x-modeldock-admin': 'admin-token-x' },
      }).then((r) => r.json())
      const cc = j.clients.find((c: any) => c.id === 'claude-code')
      expect(cc.install.sandboxInstall).toBe('redirect')
      const mimo = j.clients.find((c: any) => c.id === 'mimo-code')
      expect(mimo.install.sandboxInstall).toBe('unsupported')
      const wb = j.clients.find((c: any) => c.id === 'workbuddy')
      expect(wb.install.sandboxInstall).toBeNull()
    } finally {
      t.closeAll()
    }
  })

  it('overview install.uninstall：npm 类携带命令与沙箱标记，指引类为 null', async () => {
    const t = await setup()
    try {
      const j: any = await fetch(`http://127.0.0.1:${t.gwPort}/_modeldock/overview`, {
        headers: { 'x-modeldock-admin': 'admin-token-x' },
      }).then((r) => r.json())
      const cc = j.clients.find((c: any) => c.id === 'claude-code')
      expect(cc.install.uninstall.command).toBe('npm uninstall -g @anthropic-ai/claude-code')
      expect(cc.install.uninstall.sandbox).toBe(true) // setup 走 fakeHome
      const wb = j.clients.find((c: any) => c.id === 'workbuddy')
      expect(wb.install.uninstall).toBeNull()
    } finally {
      t.closeAll()
    }
  })
})

describe('沙箱 presence 隔离', () => {
  it('commandOnPathSandbox：FAKE_HOME 下宿主 PATH 命中不算在场，沙箱 bin 命中才算', async () => {
    const h = fakeHome()
    const savedPath = process.env.PATH
    const savedAppData = process.env.APPDATA
    // fakeHome 之外的目录模拟宿主 PATH（真机 /usr/local/bin 场景）
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldock-outside-'))
    try {
      fs.writeFileSync(path.join(outside, process.platform === 'win32' ? 'fakecli.cmd' : 'fakecli'), 'x')
      process.env.PATH = outside
      delete process.env.APPDATA
      expect(commandOnPath('fakecli')).toBe(true) // 并集探测看得见宿主命中
      expect(commandOnPathSandbox('fakecli')).toBe(false) // 沙箱感知：落点在 fakeHome 外 → 不在场
      // 沙箱 npm-global bin 内命中 → 在场：宿主与沙箱同时有同名命令（PATH 不清）时，
      // 不得因「首命中是宿主」而判负——须扫到沙箱内命中为止（2026-10-11 e2e 实测踩中）
      const sbxBin = sandboxNpmBinDirPath()
      fs.mkdirSync(sbxBin, { recursive: true })
      fs.writeFileSync(path.join(sbxBin, process.platform === 'win32' ? 'fakecli.cmd' : 'fakecli'), 'x')
      expect(commandOnPathSandbox('fakecli')).toBe(true)
      // 卸载沙箱副本（移除沙箱内 shim）后：只剩宿主命中 → 回到不在场
      fs.rmSync(path.join(sbxBin, process.platform === 'win32' ? 'fakecli.cmd' : 'fakecli'))
      expect(commandOnPathSandbox('fakecli')).toBe(false)
    } finally {
      if (savedPath === undefined) delete process.env.PATH
      else process.env.PATH = savedPath
      if (savedAppData === undefined) delete process.env.APPDATA
      else process.env.APPDATA = savedAppData
      fs.rmSync(outside, { recursive: true, force: true })
      h.restore()
    }
  })

  it('沙箱安装 probe 只认沙箱内命中：宿主真机同名命令不再触发跳过', async () => {
    const h = fakeHome()
    const savedPath = process.env.PATH
    const savedAppData = process.env.APPDATA
    const savedReg = process.env.MODELRDOCK_NPM_REGISTRY
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldock-outside-'))
    try {
      fs.writeFileSync(path.join(outside, process.platform === 'win32' ? 'claude.cmd' : 'claude'), 'x')
      process.env.PATH = outside
      delete process.env.APPDATA
      expect(commandOnPath('claude')).toBe(true) // 宿主命中存在（真机已装场景）
      // registry 指向不可达端口：npm 立即失败，用例只断言 probe 是否跳过（离线确定性）
      process.env.MODELRDOCK_NPM_REGISTRY = 'http://127.0.0.1:1'
      const fake: HarnessAdapter = {
        id: 'fake-sbxp',
        label: 'FakeSbxP',
        install: { command: 'npm i -g @example/fake-sbxp', probe: 'claude', guide: 'x' },
        detect: async () => ({ installed: false, configFiles: [] }),
        planAttach: async () => ({ changes: [], notes: [] }),
        planDetach: async () => ({ changes: [], notes: [] }),
        status: async () => ({ installed: false, attached: false }),
      }
      const r = await runClientInstall(fake, emptyConfig(), 8687)
      expect(r.skipped).toBe(false) // 真机命中不再导致跳过，安装确实尝试执行
      expect(r.ok).toBe(false) // registry 不可达如期失败
    } finally {
      if (savedPath === undefined) delete process.env.PATH
      else process.env.PATH = savedPath
      if (savedAppData === undefined) delete process.env.APPDATA
      else process.env.APPDATA = savedAppData
      if (savedReg === undefined) delete process.env.MODELRDOCK_NPM_REGISTRY
      else process.env.MODELRDOCK_NPM_REGISTRY = savedReg
      fs.rmSync(outside, { recursive: true, force: true })
      h.restore()
    }
  })
})

describe('客户端卸载', () => {
  const bootOf = (h: { home: string }) => path.join(h.home, '.claude', 'settings.json')
  const fakeAdapter = (h: { home: string }, opts: { probe?: string; uninstall?: string; content?: string }): HarnessAdapter => ({
    id: 'fake-un',
    label: 'FakeUn',
    install: {
      command: 'npm i -g @example/fake',
      ...(opts.uninstall !== undefined ? { uninstall: opts.uninstall } : {}),
      ...(opts.probe ? { probe: opts.probe } : {}),
      guide: 'x',
      bootstrap: { path: bootOf(h), content: opts.content ?? '{}\n' },
    },
    detect: async () => ({ installed: fs.existsSync(bootOf(h)), configFiles: [] }),
    planAttach: async () => ({ changes: [], notes: [] }),
    planDetach: async () => ({ changes: [], notes: [] }),
    status: async () => ({ installed: fs.existsSync(bootOf(h)), attached: false }),
  })

  it('probe 未命中（命令已不在 PATH）：跳过执行，bootstrap 空配置一并清理', async () => {
    const h = fakeHome()
    const savedPath = process.env.PATH
    const savedAppData = process.env.APPDATA
    try {
      fs.mkdirSync(path.dirname(bootOf(h)), { recursive: true })
      fs.writeFileSync(bootOf(h), '{}\n')
      process.env.PATH = path.join(h.home, 'empty-bin') // 空目录：claude 探不到
      delete process.env.APPDATA
      const r = await runClientUninstall(fakeAdapter(h, { probe: 'claude', uninstall: 'npm uninstall -g @example/fake' }), emptyConfig(), 8687)
      expect(r.ok).toBe(true)
      expect(r.skipped).toBe(true)
      expect(r.output).toContain('无需卸载')
      expect(fs.existsSync(bootOf(h))).toBe(false) // 空配置随卸载清理
    } finally {
      if (savedPath === undefined) delete process.env.PATH
      else process.env.PATH = savedPath
      if (savedAppData === undefined) delete process.env.APPDATA
      else process.env.APPDATA = savedAppData
      h.restore()
    }
  })

  it('probe 命中：执行声明命令；bootstrap 已含其他内容则保留', async () => {
    const h = fakeHome()
    const restoreAllow = allowStubCommands()
    try {
      fs.mkdirSync(path.dirname(bootOf(h)), { recursive: true })
      fs.writeFileSync(bootOf(h), '{"env":{"USER":"data"}}\n')
      const r = await runClientUninstall(
        fakeAdapter(h, { uninstall: 'node -e "process.stdout.write(\'ok\')"' }),
        emptyConfig(),
        8687
      )
      expect(r.ok).toBe(true)
      expect(r.skipped).toBe(false)
      expect(r.output).toContain('已执行卸载命令')
      expect(fs.readFileSync(bootOf(h), 'utf8')).toBe('{"env":{"USER":"data"}}\n') // 用户内容保留
    } finally {
      restoreAllow()
      h.restore()
    }
  })

  it('卸载子进程与安装共用沙箱 env：prefix/cache 指进沙箱', async () => {
    const h = fakeHome()
    const restoreAllow = allowStubCommands()
    try {
      const r = await runClientUninstall(
        fakeAdapter(h, { uninstall: 'node -e "process.stdout.write([process.env.npm_config_prefix||\'NOPFX\',process.env.npm_config_cache||\'NOCACHE\'].join(\'|\'))"' }),
        emptyConfig(),
        8687
      )
      expect(r.ok).toBe(true)
      expect(r.output).toContain(`${sandboxNpmPrefix()}|${sandboxNpmCache()}`)
    } finally {
      restoreAllow()
      h.restore()
    }
  })

  it('未声明 uninstall 的客户端：拒绝并提示手动卸载', async () => {
    const h = fakeHome()
    try {
      const r = await runClientUninstall(fakeAdapter(h, { uninstall: undefined as unknown as string }), emptyConfig(), 8687)
      expect(r.ok).toBe(false)
      expect(r.output).toContain('未配置自动卸载')
    } finally {
      h.restore()
    }
  })

  it('卸载端点：已接入的客户端 400 拦截（先断开再卸载）', async () => {
    // harness 必须在建 server 前写进 cfg：端点读运行时内存对象，mutateConfig 只落盘不回填
    const h = fakeHome()
    const cfg = emptyConfig()
    cfg.security = { store: 'file' }
    cfg.harness['claude-code'] = { mode: 'gateway', route: 'default', token: 'mdk_x' }
    await saveConfig(cfg)
    const rt = buildRuntime(cfg, 'admin-token-x')
    const server = createGatewayServer(rt, { port: 0 })
    const gwPort = await listenEphemeral(server)
    try {
      const res = await fetch(`http://127.0.0.1:${gwPort}/_modeldock/uninstall`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-modeldock-admin': 'admin-token-x' },
        body: JSON.stringify({ harness: 'claude-code' }),
      })
      expect(res.status).toBe(400)
      const j: any = await res.json()
      expect(j.error.message).toContain('断开')
    } finally {
      server.close()
      h.restore()
    }
  })
})

/** 测试内取沙箱 npm-global 的 shim 目录（unix=prefix/bin，win=prefix 根） */
function sandboxNpmBinDirPath(): string {
  const prefix = sandboxNpmPrefix()!
  return process.platform === 'win32' ? prefix : path.join(prefix, 'bin')
}
