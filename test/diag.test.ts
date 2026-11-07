import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, expect, it, vi, afterEach } from 'vitest'
import { fakeHome } from './helpers.js'
import { cmdDoctor, cmdEnv, cmdStatus, cmdTest, collectDoctorFindings, diffFindings, diskUsageFinding, fakeHomeMisconfig, logsPruneFix, runFixes, upstreamAuthProbe, withPruneFix, type DoctorFinding } from '../src/cli/diag.js'
import { __testSetExternalReader, invalidateSecretsCache, verifySecretsStore } from '../src/config/secrets.js'
import { loadConfig, mutateConfig } from '../src/config/store.js'
import { DEFAULT_GATEWAY_PORT, type ProviderConfig } from '../src/config/types.js'
import { configPath, logsDir, modeldockDir } from '../src/util/paths.js'
import { writeGatewayState } from '../src/gateway/state.js'
import { VERSION } from '../src/version.js'
import { AUTOSTART_LAUNCH_FLAG, autostartKind, launchdPlistXml, serviceFilePath, systemdUnitIni, windowsRunCommandLine, windowsRunValueMirrorFile } from '../src/autostart.js'

// cmdDoctor/cmdStatus 是只读体检壳：无网络路径（上游可达性探测指向本地拒绝端口，瞬时失败）。
// cmdTest 完整链经 requireGateway 读状态文件端口（沙箱内指向本地假网关，红线安全），
// 这里只覆盖 requireGateway 拒绝分支。cmdEnv 自 2026-10-29 端口修复后走 gatewayLive 优先、
// 无 live 回落 config——不再经 resolveClientGatewayPort 探测生产默认端口 8687，可在沙箱内
// 完整覆盖（见「cmdEnv 端口来源」用例；假网关一律 listen(0) 随机端口）。
// doctor 的端口占用探测同样要防误连 8687：所有 cmdDoctor 用例一律注入 portProbe fake。
const noProbe = { portProbe: async () => false }
class ExitError extends Error {
  constructor(public code: number | undefined) {
    super(`exit:${code}`)
  }
}

let logs: string[] = []
let errs: string[] = []
function capture(): void {
  logs = []
  errs = []
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    logs.push(a.map(String).join(' '))
  })
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
    errs.push(a.map(String).join(' '))
  })
}

// doctor 以 process.exitCode 表达「存在 bad 项」；singleFork 共进程下必须逐用例还原——
// 恢复到本文件加载时的原值（undefined）而非写死 0：写死 0 会污染后续文件里
// expect(process.exitCode).toBeUndefined() 的断言（update-cli 全量跑红实证）
const savedExitCode = process.exitCode
afterEach(() => {
  vi.mocked(console.log).mockRestore?.()
  vi.mocked(console.error).mockRestore?.()
  vi.mocked(process.exit).mockRestore?.()
  process.exitCode = savedExitCode
})

describe('cmdStatus', () => {
  it('网关未运行：给出启动指引，active_profile 与 harness 表照常输出', async () => {
    const h = fakeHome()
    capture()
    try {
      await cmdStatus()
      const out = logs.join('\n')
      expect(out).toContain('网关未运行')
      expect(out).toContain('active_profile:')
      expect(out).toContain('generic-env')
    } finally {
      h.restore()
    }
  })
})

describe('cmdDoctor', () => {
  it('空配置：可解析 + 网关未运行 + 未设 active_profile 三条提示', async () => {
    const h = fakeHome()
    capture()
    try {
      await cmdDoctor({}, noProbe)
      const out = logs.join('\n')
      expect(out).toContain('config.toml 可解析')
      expect(out).toContain('网关未运行')
      expect(out).toContain('未设置 active_profile')
    } finally {
      h.restore()
    }
  })

  it('激活链路体检：key 可读（env 引用）、上游不可达、模型目录为空、generic-env 已接管、坏 pack 不击穿体检', async () => {
    const h = fakeHome()
    const saved = process.env.MD_DOC_KEY
    process.env.MD_DOC_KEY = 'sk-doctor-secret'
    capture()
    try {
      await mutateConfig((c) => {
        c.security = { store: 'file' }
        c.providers['pv'] = {
          name: 'PV',
          base_url: 'http://127.0.0.1:18999', // 无监听端口：连接拒绝，瞬时失败，不碰外网
          protocol: 'anthropic',
          auth_style: 'bearer',
          key_ref: 'env:MD_DOC_KEY',
        }
        c.profiles['main'] = { name: 'main', provider: 'pv', default_model: 'm1' }
        c.active_profile = 'main'
        c.harness['generic-env'] = { mode: 'gateway', token: 't' }
        c.adapter_packs = { bad: { format: 'xml' as never, config_file: 'x', upsert: {} } }
      })
      await cmdDoctor({}, noProbe)
      const out = logs.join('\n')
      expect(out).toContain('config.toml 可解析')
      expect(out).toContain('上游 key 可读取')
      expect(out).toContain('上游不可达')
      expect(out).toContain('模型目录为空')
      expect(out).toContain('已接管且指向网关')
      expect(out).toContain('pack 配置错误') // 坏 pack 以占位呈现，未中断其余体检项
    } finally {
      if (saved === undefined) delete process.env.MD_DOC_KEY
      else process.env.MD_DOC_KEY = saved
      h.restore()
    }
  })
})

describe('cmdDoctor --json', () => {
  it('输出可解析 JSON：findings 带稳定 id/level/msg，fix 元数据齐备', async () => {
    const h = fakeHome()
    capture()
    try {
      await mutateConfig((c) => {
        c.gateway = { port: 18941 }
        c.providers['pv'] = { name: 'PV', base_url: 'http://127.0.0.1:18999', protocol: 'anthropic', auth_style: 'bearer', key_ref: 'plain:sk-doc' }
        c.profiles['main'] = { name: 'main', provider: 'pv', default_model: 'm1' }
        c.profiles['ghost'] = { name: 'ghost', provider: 'gone' }
        c.active_profile = 'main'
      })
      await cmdDoctor({ json: true }, noProbe)
      const j = JSON.parse(logs.join('\n')) as {
        version: number
        ok: boolean
        findings: { id: string; level: string; msg: string; fix?: { kind: string; target?: string; confirm: boolean } }[]
      }
      expect(j.version).toBe(1)
      expect(j.ok).toBe(false) // 上游 18999 拒连 + 悬空 profile → bad
      const ids = j.findings.map((f) => f.id)
      expect(ids).toContain('config.parse')
      expect(ids).toContain('gateway.down')
      expect(ids).toContain('profile.dangling')
      expect(ids).toContain('models.empty')
      const down = j.findings.find((f) => f.id === 'gateway.down')!
      expect(down.level).toBe('warn')
      expect(down.fix?.kind).toBe('start-gateway')
      expect(down.fix?.confirm).toBe(false)
      for (const f of j.findings) {
        expect(typeof f.id).toBe('string')
        expect(typeof f.msg).toBe('string')
      }
    } finally {
      h.restore()
    }
  })

  it('网关未运行且配置端口被占用：port_busy 提示启动将漂移', async () => {
    const h = fakeHome()
    capture()
    try {
      await mutateConfig((c) => {
        c.gateway = { port: 18941 }
      })
      await cmdDoctor({ json: true }, { portProbe: async () => true })
      const j = JSON.parse(logs.join('\n')) as { findings: { id: string; level: string }[] }
      const f = j.findings.find((x) => x.id === 'gateway.port_busy')
      expect(f?.level).toBe('warn')
    } finally {
      h.restore()
    }
  })
})

/** --json 输出解析（capture 期内最近一次 cmdDoctor --json 的 logs） */
function jsonFindings(): {
  version: number
  ok: boolean
  findings: { id: string; level: string; msg: string; hint?: string; fix?: { kind: string; target?: string; confirm: boolean } }[]
} {
  return JSON.parse(logs.join('\n'))
}

/** 按当前平台在沙箱内写一份自启服务文件（登记 argv 经 ARGV_MARK 随文件落盘，doctor 据此核查）；
 *  serviceFilePath 在 FAKE_HOME 下已重定向，落点全在沙箱内 */
function seedAutostartEntry(home: string, argv: string[]): string {
  // Windows 注册表形态（XPLAT-06）：播种 Run 键镜像文件（键值数据 = windowsRunCommandLine），
  // 落点 modeldockDir()/autostart-run-key.txt 在 FAKE_HOME 下全在沙箱内；其余平台写服务文件
  const isWin = autostartKind() === 'windows'
  const file = isWin ? windowsRunValueMirrorFile() : serviceFilePath()
  if (!file) throw new Error('autostart not supported on this platform')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const workDir = path.join(home, '.modeldock')
  const outLog = path.join(workDir, 'logs', 'service-out.log')
  const errLog = path.join(workDir, 'logs', 'service-err.log')
  const content = isWin
    ? windowsRunCommandLine([...argv, AUTOSTART_LAUNCH_FLAG])
    : autostartKind() === 'launchd'
      ? launchdPlistXml(argv, workDir, outLog, errLog)
      : systemdUnitIni(argv, workDir, outLog, errLog)
  fs.writeFileSync(file, content, 'utf8')
  return file
}

describe('doctor 沙箱自启残留核查（CORRECT-05）', () => {
  it('登记指向沙箱路径：warn + autostart-cleanup 修复元数据（confirm 把关）', async () => {
    const h = fakeHome()
    capture()
    try {
      // 残留形态：登记命令指向 dev 沙箱 home（~/.modeldock-dev）内路径，且不在当前测试沙箱内（非自引用）
      const ghost = path.join(os.homedir(), '.modeldock-dev', '.modeldock', 'ghost-entry')
      seedAutostartEntry(h.home, [process.execPath, ghost, '--sea-gateway'])
      await cmdDoctor({ json: true }, noProbe)
      const j = jsonFindings()
      const f = j.findings.find((x) => x.id === 'autostart.residue')
      expect(f?.level).toBe('warn')
      expect(f?.msg).toContain('沙箱路径')
      expect(f?.msg).toContain('.modeldock-dev')
      expect(f?.fix?.kind).toBe('autostart-cleanup')
      expect(f?.fix?.confirm).toBe(true) // 删用户登记必须确认，不自动执行
    } finally {
      h.restore()
    }
  })

  it('登记指向失效路径：warn + 重装修复；--fix 经注入执行重装（不真动 launchctl/systemd）', async () => {
    const h = fakeHome()
    capture()
    try {
      await mutateConfig((c) => {
        c.gateway = { port: 18941 } // 显式 189xx：防 start-gateway 兜底路径碰默认端口
      })
      const file = seedAutostartEntry(h.home, [path.join(h.home, 'no-such-node-xyz'), '--sea-gateway'])
      await cmdDoctor({ json: true }, noProbe)
      const f = jsonFindings().findings.find((x) => x.id === 'autostart.residue')
      expect(f?.level).toBe('warn')
      expect(f?.msg).toContain('不存在的文件')
      expect(f?.fix?.kind).toBe('reinstall-autostart')
      expect(f?.fix?.confirm).toBe(true)
      // startGateway/reinstallAutostart 必须注入：gateway.down 修复 confirm=false 会自动执行；
      // 重装真跑会 spawn launchctl/systemd 并可能拉起网关进程——测试一律 fake
      let reinstalled = 0
      await cmdDoctor(
        { fix: true },
        { ...noProbe, startGateway: async () => 'http://127.0.0.1:18941', confirm: async () => true, reinstallAutostart: async () => { reinstalled++; return file } }
      )
      expect(reinstalled).toBe(1)
      expect(logs.join('\n')).toContain('重装开机自启')
      expect(fs.existsSync(file)).toBe(true) // 重装 ≠ 移除：登记文件仍在
    } finally {
      h.restore()
    }
  })

  it('登记健康：ok，不报残留', async () => {
    const h = fakeHome()
    capture()
    try {
      seedAutostartEntry(h.home, [process.execPath, '--sea-gateway'])
      await cmdDoctor({ json: true }, noProbe)
      const j = jsonFindings()
      expect(j.findings.find((x) => x.id === 'autostart.entry')?.level).toBe('ok')
      expect(j.findings.find((x) => x.id === 'autostart.residue')).toBeUndefined()
    } finally {
      h.restore()
    }
  })
})

describe('doctor 钥匙环故障 vs 条目缺失区分（REVIEW-19）', () => {
  it('钥匙环读取失败：warn + 解锁 hint，不与未配置密钥混同', async () => {
    const h = fakeHome()
    __testSetExternalReader(async () => {
      throw new Error('keyring locked (test)')
    })
    capture()
    try {
      await mutateConfig((c) => {
        c.gateway = { port: 18941 }
        c.providers['pv'] = { name: 'PV', base_url: 'http://127.0.0.1:18999', protocol: 'anthropic', auth_style: 'bearer', key_ref: 'keychain:doc-kc-fail' }
        c.profiles['main'] = { name: 'main', provider: 'pv', default_model: 'm1' }
        c.active_profile = 'main'
      })
      await cmdDoctor({ json: true }, noProbe)
      const f = jsonFindings().findings.find((x) => x.id === 'provider.key')
      expect(f?.level).toBe('warn') // 读取故障是瞬时态，降为 warn（条目缺失才是 bad）
      expect(f?.msg).toContain('上游 key 读取失败')
      expect(f?.hint).toContain('与未配置密钥不同')
      expect(f?.hint).toContain('解锁')
    } finally {
      __testSetExternalReader() // 还原真实读取器，避免污染同进程其他用例
      invalidateSecretsCache()
      h.restore()
    }
  })

  it('条目缺失：仍报 bad + set-key hint（与读取失败区分）', async () => {
    const h = fakeHome()
    __testSetExternalReader(async () => null) // 「确认不存在」语义（对应真实后端 44/空输出）
    capture()
    try {
      await mutateConfig((c) => {
        c.gateway = { port: 18941 }
        c.providers['pv'] = { name: 'PV', base_url: 'http://127.0.0.1:18999', protocol: 'anthropic', auth_style: 'bearer', key_ref: 'keychain:doc-kc-missing' }
        c.profiles['main'] = { name: 'main', provider: 'pv', default_model: 'm1' }
        c.active_profile = 'main'
      })
      await cmdDoctor({ json: true }, noProbe)
      const f = jsonFindings().findings.find((x) => x.id === 'provider.key')
      expect(f?.level).toBe('bad')
      expect(f?.msg).toContain('上游 key 不可用')
      expect(f?.hint).toContain('set-key')
    } finally {
      __testSetExternalReader()
      invalidateSecretsCache()
      h.restore()
    }
  })
})

describe('doctor 坏 key_ref 收口（卡 30：700e29f 同根残留，2026-11-02 复查）', () => {
  it('active provider 的 key_ref 非串：报 bad + set-key hint，不落「解锁钥匙环」warn 口径', async () => {
    const h = fakeHome()
    capture()
    try {
      await mutateConfig((c) => {
        c.gateway = { port: 18941 }
        c.providers['pv'] = { name: 'PV', base_url: 'http://127.0.0.1:18999', protocol: 'anthropic', auth_style: 'bearer', key_ref: 123 as unknown as string }
        c.profiles['main'] = { name: 'main', provider: 'pv', default_model: 'm1' }
        c.active_profile = 'main'
      })
      await cmdDoctor({ json: true }, noProbe) // 此前 detectForeignCipherRefs 与 provider.key 路径穿透 SecretsError
      const f = jsonFindings().findings.find((x) => x.id === 'provider.key')
      expect(f?.level).toBe('bad')
      expect(f?.msg).toContain('key_ref 非法')
      expect(f?.hint).toContain('set-key')
    } finally {
      h.restore()
    }
  })

  it('active provider 的 key_ref 缺失（undefined）：不崩、报 bad；其余检查面照常产出', async () => {
    const h = fakeHome()
    capture()
    try {
      await mutateConfig((c) => {
        c.gateway = { port: 18941 }
        c.providers['pv'] = { name: 'PV', base_url: 'http://127.0.0.1:18999', protocol: 'anthropic', auth_style: 'bearer', key_ref: undefined as unknown as string }
        c.profiles['main'] = { name: 'main', provider: 'pv', default_model: 'm1' }
        c.active_profile = 'main'
      })
      await cmdDoctor({ json: true }, noProbe)
      const findings = jsonFindings().findings
      const f = findings.find((x) => x.id === 'provider.key')
      expect(f?.level).toBe('bad')
      expect(f?.msg).toContain('undefined')
      expect(findings.some((x) => x.id === 'profile.active' && x.level === 'ok')).toBe(true) // 其余面照常
    } finally {
      h.restore()
    }
  })
})

describe('doctor 跨机密文引用（REVIEW-18）', () => {
  it('secrets.json 含异平台前缀密文 + key_ref 内嵌密文：报 bad 并点名服务', async () => {
    const h = fakeHome()
    capture()
    try {
      await mutateConfig((c) => {
        c.gateway = { port: 18941 }
        c.providers['pv'] = { name: 'PV', base_url: 'http://127.0.0.1:18999', protocol: 'anthropic', auth_style: 'bearer', key_ref: 'file:k1' }
        c.providers['pv2'] = { name: 'PV2', base_url: 'http://127.0.0.1:18999', protocol: 'anthropic', auth_style: 'bearer', key_ref: 'plain:enc:dpapi:QUJD' }
        c.profiles['main'] = { name: 'main', provider: 'pv', default_model: 'm1' }
        c.active_profile = 'main'
      })
      // 异平台前缀按平台取补集：linux（mach 为本机前缀）用 dpapi，其余平台用 mach——保证任何平台都是「非本平台前缀」
      const foreignPrefix = process.platform === 'linux' ? 'enc:dpapi:' : 'enc:mach:'
      fs.mkdirSync(path.join(h.home, '.modeldock'), { recursive: true })
      fs.writeFileSync(path.join(h.home, '.modeldock', 'secrets.json'), JSON.stringify({ k1: foreignPrefix + 'AAAA' }), 'utf8')
      await cmdDoctor({ json: true }, noProbe)
      const f = jsonFindings().findings.find((x) => x.id === 'secrets.foreign_cipher')
      expect(f?.level).toBe('bad') // 密文本机解不开、发上游必 401
      expect(f?.msg).toContain('他机密文引用')
      expect(f?.msg).toContain('k1') // ① secrets 表内异平台密文条目
      expect(f?.msg).toContain('pv(key_ref→k1)') // ② key_ref 指向该条目的服务被点名
      expect(f?.msg).toContain('pv2(key_ref)') // ② key_ref 内嵌密文的服务被点名
      expect(f?.hint).toContain('set-key')
    } finally {
      h.restore()
    }
  })

  it('无跨机密文（密钥表为空）：不误报', async () => {
    const h = fakeHome()
    capture()
    try {
      await mutateConfig((c) => {
        c.gateway = { port: 18941 }
        c.providers['pv'] = { name: 'PV', base_url: 'http://127.0.0.1:18999', protocol: 'anthropic', auth_style: 'bearer', key_ref: 'env:MD_DOC_KEY' }
        c.profiles['main'] = { name: 'main', provider: 'pv' }
        c.active_profile = 'main'
      })
      await cmdDoctor({ json: true }, noProbe)
      expect(jsonFindings().findings.find((x) => x.id === 'secrets.foreign_cipher')).toBeUndefined()
    } finally {
      h.restore()
    }
  })
})

describe('cmdDoctor --fix', () => {
  // 共用沙箱配置：pv 指向拒绝端口（拉取必失败）、ghost 悬空、active=main
  async function seedSandbox(): Promise<void> {
    await mutateConfig((c) => {
      c.gateway = { port: 18941 }
      c.providers['pv'] = { name: 'PV', base_url: 'http://127.0.0.1:18999', protocol: 'anthropic', auth_style: 'bearer', key_ref: 'plain:sk-doc' }
      c.profiles['main'] = { name: 'main', provider: 'pv', default_model: 'm1' }
      c.profiles['ghost'] = { name: 'ghost', provider: 'gone' }
      c.active_profile = 'main'
    })
  }

  it('安全项自动执行、失败不中断、需确认项默认跳过', async () => {
    const h = fakeHome()
    const savedProxy = process.env.HTTP_PROXY
    process.env.HTTP_PROXY = 'http://127.0.0.1:18998' // 触发 set-proxy 确认项
    capture()
    try {
      await seedSandbox()
      await cmdDoctor(
        { fix: true, yes: false },
        { startGateway: async () => 'http://127.0.0.1:18941', portProbe: async () => false, confirm: async () => false }
      )
      const out = logs.join('\n') + '\n' + errs.join('\n')
      expect(out).toContain('启动网关') // 自动修复：网关（fake）启动成功
      expect(out).toContain('清理悬空 profile') // 自动修复：悬空 profile 已清
      expect(out).toContain('失败') // 模型目录拉取连拒绝端口失败，不中断后续
      expect(out).toContain('已跳过 1 项') // set-proxy 确认被拒
      const cfg2 = await loadConfig()
      expect(cfg2.profiles['ghost']).toBeUndefined()
      expect(cfg2.providers['pv']?.proxy).toBeUndefined() // 确认被拒 → 不动配置
    } finally {
      if (savedProxy === undefined) delete process.env.HTTP_PROXY
      else process.env.HTTP_PROXY = savedProxy
      h.restore()
    }
  })

  it('--yes：确认项不再询问直接执行', async () => {
    const h = fakeHome()
    const savedProxy = process.env.HTTP_PROXY
    process.env.HTTP_PROXY = 'http://127.0.0.1:18998'
    capture()
    try {
      await seedSandbox()
      await cmdDoctor(
        { fix: true, yes: true },
        {
          startGateway: async () => 'http://127.0.0.1:18941',
          portProbe: async () => false,
          confirm: async () => {
            throw new Error('should not ask')
          },
        }
      )
      const cfg2 = await loadConfig()
      expect(cfg2.providers['pv']?.proxy).toBe('env')
    } finally {
      if (savedProxy === undefined) delete process.env.HTTP_PROXY
      else process.env.HTTP_PROXY = savedProxy
      h.restore()
    }
  })

  it('config 解析失败：无可修复项，只提示不执行任何修复', async () => {
    const h = fakeHome()
    capture()
    try {
      const fs = await import('node:fs')
      const path = await import('node:path')
      fs.mkdirSync(path.join(h.home, '.modeldock'), { recursive: true })
      fs.writeFileSync(path.join(h.home, '.modeldock', 'config.toml'), 'not [valid toml', 'utf8')
      await cmdDoctor({ fix: true }, noProbe)
      expect(logs.join('\n')).toContain('没有可自动执行的修复项')
    } finally {
      h.restore()
    }
  })
})

describe('verifySecretsStore', () => {
  it('secrets.json 损坏：返回可操作错误；doctor 报密钥库不可读且不崩、跳过逐条 key 检查', async () => {
    const h = fakeHome()
    capture()
    try {
      await mutateConfig((c) => {
        c.gateway = { port: 18941 }
        c.providers['pv'] = { name: 'PV', base_url: 'http://127.0.0.1:18999', protocol: 'anthropic', auth_style: 'bearer', key_ref: 'file:k1' }
        c.profiles['main'] = { name: 'main', provider: 'pv' }
        c.active_profile = 'main'
      })
      const fs = await import('node:fs')
      const path = await import('node:path')
      fs.writeFileSync(path.join(h.home, '.modeldock', 'secrets.json'), '{broken', 'utf8')
      const v = await verifySecretsStore()
      expect(v.ok).toBe(false)
      if (!v.ok) expect(v.error).toContain('secrets.json')
      await cmdDoctor({}, noProbe)
      const out = logs.join('\n')
      expect(out).toContain('secrets.json 解析失败')
      expect(out).not.toContain('上游 key 可读取') // 密钥库损坏 → 跳过逐条 key 检查，避免重复报同一根因
    } finally {
      h.restore()
    }
  })
})

describe('runFixes（直测）', () => {
  it('confirm=false 直接执行并回显细节；失败计数不中断；confirm 项按注入结果执行/跳过', async () => {
    capture()
    const ran: string[] = []
    const findings: DoctorFinding[] = [
      { id: 'x.a', level: 'warn', msg: 'x', fix: { kind: 'start-gateway', confirm: false, label: 'fakeA', run: async () => { ran.push('a'); return 'detail-a' } } },
      { id: 'x.b', level: 'warn', msg: 'x', fix: { kind: 'model-refresh', confirm: false, label: 'fakeB', run: async () => { throw new Error('boom') } } },
      { id: 'x.c', level: 'warn', msg: 'x', fix: { kind: 'set-proxy', confirm: true, label: 'fakeC', run: async () => { ran.push('c') } } },
      { id: 'x.d', level: 'warn', msg: 'x', fix: { kind: 'attach', confirm: true, label: 'fakeD', run: async () => { ran.push('d') } } },
    ]
    await runFixes(findings, { yes: false }, { confirm: async (m) => m.includes('fakeC') })
    expect(ran).toEqual(['a', 'c'])
    const all = logs.join('\n') + '\n' + errs.join('\n')
    expect(all).toContain('✓ fakeA：detail-a')
    expect(all).toContain('✗ fakeB 失败：boom')
    expect(all).toContain('已跳过 1 项')
    expect(all).toContain('成功 2 / 失败 1')
  })

  it('--yes：confirm 项不再询问全部执行', async () => {
    capture()
    const ran: string[] = []
    const findings: DoctorFinding[] = [
      { id: 'x.c', level: 'warn', msg: 'x', fix: { kind: 'set-proxy', confirm: true, label: 'fakeC', run: async () => { ran.push('c') } } },
    ]
    await runFixes(findings, { yes: true }, {
      confirm: async () => {
        throw new Error('should not ask')
      },
    })
    expect(ran).toEqual(['c'])
    expect(logs.join('\n')).not.toContain('已跳过')
  })
})

describe('cmdTest', () => {
  it('网关未运行：exit(1) 并提示先启动', async () => {
    const h = fakeHome()
    capture()
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new ExitError(code)
    }) as never)
    try {
      await expect(cmdTest(undefined, {})).rejects.toBeInstanceOf(ExitError)
      expect(errs.join('\n')).toContain('网关未运行')
    } finally {
      h.restore()
    }
  })
})

describe('cmdEnv 端口来源（gatewayLive 优先，无 live 回落 config）', () => {
  /** 起一个 health 端点应答的假网关（listen(0) 随机端口），并把状态文件写成它——
   *  started_at 与 health 应答一致，gatewayLive() 的三重校验（pid+health+started_at）全过。 */
  async function startFakeGateway(): Promise<{ port: number; close: () => void }> {
    const startedAt = new Date().toISOString()
    const server = http.createServer((req, res) => {
      if (req.url === '/_modeldock/health') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, started_at: startedAt }))
        return
      }
      res.writeHead(404)
      res.end()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    await writeGatewayState({ pid: process.pid, port, admin_token: 'x', started_at: startedAt })
    return { port, close: () => server.close() }
  }

  it('live 实例存在：用其实际端口，压过 config.gateway.port', async () => {
    const h = fakeHome()
    const fake = await startFakeGateway()
    try {
      // 配置里写另一个端口：live 端口必须赢（修复前 resolveClientGatewayPort 在非沙箱下
      // 会先探测生产默认端口，非默认实例被压掉恒打默认值）
      await mutateConfig((c) => { c.gateway = { port: 18999 } })
      capture()
      await cmdEnv()
      const out = logs.join('\n')
      expect(out).toContain(`export ANTHROPIC_BASE_URL=http://127.0.0.1:${fake.port}`)
      expect(out).toContain(`export OPENAI_BASE_URL=http://127.0.0.1:${fake.port}/v1`)
      expect(out).not.toContain('http://127.0.0.1:18999')
    } finally {
      fake.close()
      h.restore()
    }
  })

  it('无 live 实例：回落 config.gateway.port', async () => {
    const h = fakeHome()
    capture()
    try {
      await mutateConfig((c) => { c.gateway = { port: 18999 } })
      await cmdEnv()
      const out = logs.join('\n')
      expect(out).toContain('export ANTHROPIC_BASE_URL=http://127.0.0.1:18999')
      expect(out).toContain('export OPENAI_BASE_URL=http://127.0.0.1:18999/v1')
    } finally {
      h.restore()
    }
  })

  it('无 live 且 config 未设端口：回落 DEFAULT_GATEWAY_PORT', async () => {
    const h = fakeHome()
    capture()
    try {
      await cmdEnv()
      const out = logs.join('\n')
      expect(out).toContain(`export ANTHROPIC_BASE_URL=http://127.0.0.1:${DEFAULT_GATEWAY_PORT}`)
      expect(out).toContain(`export OPENAI_BASE_URL=http://127.0.0.1:${DEFAULT_GATEWAY_PORT}/v1`)
    } finally {
      h.restore()
    }
  })
})

describe('loadConfig 兜底', () => {
  it('空沙箱 loadConfig 返回可写默认配置（doctor 的前置假设）', async () => {
    const h = fakeHome()
    try {
      const cfg = await loadConfig()
      expect(cfg.version).toBeGreaterThan(0)
      expect(cfg.providers).toEqual({})
    } finally {
      h.restore()
    }
  })
})

describe('doctor 第二轮（doctor-round2 卡）', () => {
  it('FAKE_HOME 误配：指向真实 ~/.modeldock 报 bad；正常沙箱与未设置不报（纯函数 + 全链路）', async () => {
    const h = fakeHome()
    const savedHome = process.env.HOME
    const savedProfile = process.env.USERPROFILE
    const savedFake = process.env.MODELRDOCK_FAKE_HOME
    try {
      // 正常沙箱（fakeHome 指临时目录）→ 不报
      expect(fakeHomeMisconfig(process.env.MODELRDOCK_FAKE_HOME, os.homedir())).toBeNull()
      // 纯函数：把 homedir 注入为临时根，FAKE_HOME 指向其 .modeldock → 命中
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doc2-'))
      process.env.HOME = root
      process.env.USERPROFILE = root
      expect(fakeHomeMisconfig(path.join(root, '.modeldock'), root)).toBe(path.join(root, '.modeldock'))
      expect(fakeHomeMisconfig(undefined, root)).toBeNull()
      expect(fakeHomeMisconfig(root, root)).toBe(root) // 真正写穿形态：FAKE_HOME = 主目录本体
      const info = diskUsageFinding(10 * 1024 * 1024, null, undefined)
      expect(info.level).toBe('info') // statfs 失败是「无数据」，不谎报充足
      expect(fakeHomeMisconfig(path.join(root, 'elsewhere'), root)).toBeNull()
      // 全链路：FAKE_HOME 与 homedir 组合成「真实数据目录」形态 → collectDoctorFindings 报 bad
      process.env.MODELRDOCK_FAKE_HOME = path.join(root, '.modeldock')
      const findings = await collectDoctorFindings()
      const f = findings.find((x) => x.id === 'sandbox.misconfig')
      expect(f?.level).toBe('bad')
      expect(f?.msg).toContain('.modeldock')
      expect(f?.hint).toContain('unset')
    } finally {
      if (savedHome === undefined) delete process.env.HOME
      else process.env.HOME = savedHome
      if (savedProfile === undefined) delete process.env.USERPROFILE
      else process.env.USERPROFILE = savedProfile
      if (savedFake === undefined) delete process.env.MODELRDOCK_FAKE_HOME
      else process.env.MODELRDOCK_FAKE_HOME = savedFake
      h.restore()
    }
  })

  it('config.toml 解析失败：报错带文件路径（可定位到具体文件）', async () => {
    const h = fakeHome()
    try {
      fs.mkdirSync(modeldockDir(), { recursive: true })
      fs.writeFileSync(configPath(), 'not [valid toml ===')
      const findings = await collectDoctorFindings()
      const f = findings.find((x) => x.id === 'config.parse')
      expect(f?.level).toBe('bad')
      expect(f?.msg).toContain('config.toml')
      expect(f?.msg).toContain(configPath())
    } finally {
      h.restore()
    }
  })

  it('日志体积/磁盘余量分级（纯函数注入合成数字）：bad(<1GB) / warn(>512MB) / ok', () => {
    const bad = diskUsageFinding(10 * 1024 * 1024, 0.5 * 1024 ** 3, 14)
    expect(bad.level).toBe('bad')
    expect(bad.msg).toContain('0.5GB')
    expect(bad.hint).toContain('log_retention_days')
    const warn = diskUsageFinding(600 * 1024 * 1024, 50 * 1024 ** 3, 7)
    expect(warn.level).toBe('warn')
    expect(warn.msg).toContain('600MB')
    expect(warn.hint).toContain('7')
    const ok = diskUsageFinding(10 * 1024 * 1024, 50 * 1024 ** 3, undefined)
    expect(ok.level).toBe('ok')
    expect(ok.msg).toContain('10MB')
    expect(ok.msg).toContain('默认')
  })

  it('全链路磁盘检查：日志目录小、盘余充足 → logs.disk ok（真实 statfs 路径）', async () => {
    const h = fakeHome()
    try {
      fs.mkdirSync(modeldockDir(), { recursive: true })
      fs.mkdirSync(logsDir(), { recursive: true })
      fs.writeFileSync(path.join(logsDir(), 'gateway-2026-11-02.jsonl'), '{"tiny":true}\n')
      const findings = await collectDoctorFindings()
      const f = findings.find((x) => x.id === 'logs.disk')
      expect(f?.level).toBe('ok')
      expect(f?.msg).toContain('0MB') // 12 字节文件取整为 0MB
    } finally {
      h.restore()
    }
  })
})

describe('doctor 版本漂移（gateway.version_drift）', () => {
  const liveBase = { pid: process.pid, port: 18941, admin_token: 't', started_at: '2026-11-06T00:00:00Z' }

  it('网关版本 ≠ CLI 版本：warn + restart-gateway 修复元数据（confirm 级）', async () => {
    const h = fakeHome()
    capture()
    try {
      await mutateConfig((c) => { c.gateway = { port: 18941 } })
      await cmdDoctor({ json: true }, { ...noProbe, gatewayLive: async () => ({ ...liveBase, version: '0.0.9' }) })
      const f = jsonFindings().findings.find((x) => x.id === 'gateway.version_drift')
      expect(f?.level).toBe('warn')
      expect(f?.msg).toContain('0.0.9')
      expect(f?.fix?.kind).toBe('restart-gateway')
      expect(f?.fix?.confirm).toBe(true)
    } finally {
      h.restore()
    }
  })

  it('版本一致或旧版状态文件无 version 字段：不报（向后兼容）', async () => {
    const h = fakeHome()
    capture()
    try {
      await mutateConfig((c) => { c.gateway = { port: 18941 } })
      await cmdDoctor({ json: true }, { ...noProbe, gatewayLive: async () => ({ ...liveBase, version: VERSION }) })
      expect(jsonFindings().findings.some((x) => x.id === 'gateway.version_drift')).toBe(false)
      capture()
      await cmdDoctor({ json: true }, { ...noProbe, gatewayLive: async () => ({ ...liveBase }) })
      expect(jsonFindings().findings.some((x) => x.id === 'gateway.version_drift')).toBe(false)
    } finally {
      h.restore()
    }
  })

  it('--fix 重启修复经注入执行；复核显示版本漂移已解决', async () => {
    const h = fakeHome()
    capture()
    try {
      await mutateConfig((c) => { c.gateway = { port: 18941 } })
      let v: string | undefined = '0.0.9'
      await cmdDoctor(
        { fix: true, yes: true },
        {
          ...noProbe,
          gatewayLive: async () => (v ? { ...liveBase, version: v } : null),
          restartGateway: async () => { v = VERSION; return 'http://127.0.0.1:18941' },
        }
      )
      const out = logs.join('\n')
      expect(out).toContain('重启网关')
      expect(out).toContain('复核')
      expect(out).toContain('已解决')
    } finally {
      h.restore()
    }
  })
})

describe('doctor --deep：端到端真请求', () => {
  function seedProfile(): Promise<void> {
    return mutateConfig((c) => {
      c.gateway = { port: 18941 }
      c.providers['pv'] = { name: 'PV', base_url: 'http://127.0.0.1:18999', protocol: 'anthropic', auth_style: 'bearer', key_ref: 'env:MD_DOC_KEY' }
      c.profiles['main'] = { name: 'main', provider: 'pv', default_model: 'm1' }
      c.active_profile = 'main'
    })
  }
  const saveEnv = (name: string): { saved: string | undefined } => ({ saved: process.env[name] })

  it('网关在线：经网关 e2e（注入）成功 ok / 失败 bad 带 hint', async () => {
    const h = fakeHome()
    const { saved } = saveEnv('MD_DOC_KEY')
    process.env.MD_DOC_KEY = 'sk-x'
    const live = async () => ({ pid: process.pid, port: 18941, admin_token: 't', started_at: 'x' })
    capture()
    try {
      await seedProfile()
      await cmdDoctor({ json: true, deep: true }, { ...noProbe, gatewayLive: live, gatewayE2E: async () => ({ ok: true, model: 'm1', ms: 42 }) })
      let f = jsonFindings().findings.find((x) => x.id === 'upstream.e2e')
      expect(f?.level).toBe('ok')
      expect(f?.msg).toContain('m1')
      capture()
      await cmdDoctor({ json: true, deep: true }, { ...noProbe, gatewayLive: live, gatewayE2E: async () => ({ ok: false, status: 502, err: 'bad gateway', hint: 'check upstream' }) })
      f = jsonFindings().findings.find((x) => x.id === 'upstream.e2e')
      expect(f?.level).toBe('bad')
      expect(f?.msg).toContain('bad gateway')
      expect(f?.hint).toContain('check upstream')
    } finally {
      if (saved === undefined) delete process.env.MD_DOC_KEY
      else process.env.MD_DOC_KEY = saved
      h.restore()
    }
  })

  it('网关不在线：探针 auth 失败 → bad + set-key hint；ok 但模型不在目录 → model.missing warn；skip → info', async () => {
    const h = fakeHome()
    const { saved } = saveEnv('MD_DOC_KEY')
    process.env.MD_DOC_KEY = 'sk-x'
    capture()
    try {
      await seedProfile()
      await cmdDoctor({ json: true, deep: true }, { ...noProbe, upstreamProbe: async () => ({ kind: 'auth', detail: 'HTTP 401 @ http://x/v1/models' }) })
      let f = jsonFindings().findings.find((x) => x.id === 'upstream.auth')
      expect(f?.level).toBe('bad')
      expect(f?.msg).toContain('401')
      expect(f?.hint).toContain('set-key')
      capture()
      await cmdDoctor({ json: true, deep: true }, { ...noProbe, upstreamProbe: async () => ({ kind: 'ok', detail: 'http://x/v1/models', modelIds: ['other-1', 'other-2'] }) })
      f = jsonFindings().findings.find((x) => x.id === 'upstream.auth')
      expect(f?.level).toBe('ok')
      const miss = jsonFindings().findings.find((x) => x.id === 'model.missing')
      expect(miss?.level).toBe('warn')
      expect(miss?.msg).toContain('m1')
      capture()
      await cmdDoctor({ json: true, deep: true }, { ...noProbe, upstreamProbe: async () => ({ kind: 'skip', detail: 'HTTP 404 @ http://x/models' }) })
      f = jsonFindings().findings.find((x) => x.id === 'upstream.auth')
      expect(f?.level).toBe('info')
      expect(jsonFindings().findings.some((x) => x.id === 'model.missing')).toBe(false)
    } finally {
      if (saved === undefined) delete process.env.MD_DOC_KEY
      else process.env.MD_DOC_KEY = saved
      h.restore()
    }
  })

  it('upstreamAuthProbe 对本地假上游分类：401→auth / 200+data→ok / 全 404→skip（listen(0) 随机端口）', async () => {
    const h = fakeHome()
    const { saved } = saveEnv('MD_DEEP_KEY')
    process.env.MD_DEEP_KEY = 'sk-deep'
    const servers: http.Server[] = []
    try {
      const start = (handler: (res: http.ServerResponse) => void): Promise<number> =>
        new Promise((resolve) => {
          const s = http.createServer((_q, res) => handler(res))
          servers.push(s)
          s.listen(0, '127.0.0.1', () => resolve((s.address() as AddressInfo).port))
        })
      const p401 = await start((res) => { res.writeHead(401); res.end() })
      const p200 = await start((res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data: [{ id: 'm1' }, { id: 'm2' }] })) })
      const p404 = await start((res) => { res.writeHead(404); res.end() })
      const mk = (port: number): ProviderConfig => ({ name: 'X', base_url: `http://127.0.0.1:${port}`, protocol: 'openai', auth_style: 'bearer', key_ref: 'env:MD_DEEP_KEY' })
      const r401 = await upstreamAuthProbe(mk(p401))
      expect(r401.kind).toBe('auth')
      expect(r401.detail).toContain('401')
      const r200 = await upstreamAuthProbe(mk(p200))
      expect(r200.kind).toBe('ok')
      expect(r200.modelIds).toEqual(['m1', 'm2'])
      const r404 = await upstreamAuthProbe(mk(p404))
      expect(r404.kind).toBe('skip')
    } finally {
      for (const s of servers) { s.closeAllConnections?.(); s.close() }
      if (saved === undefined) delete process.env.MD_DEEP_KEY
      else process.env.MD_DEEP_KEY = saved
      h.restore()
    }
  })
})

describe('doctor 日志清理修复（prune-logs）', () => {
  it('logsPruneFix 注入：按保留天数执行并回显删除数；confirm 把关', async () => {
    const ran: number[] = []
    const fix = logsPruneFix(30, { pruneLogs: async (d) => { ran.push(d); return 2 } })
    expect(fix.kind).toBe('prune-logs')
    expect(fix.confirm).toBe(true)
    const detail = await fix.run()
    expect(ran).toEqual([30])
    expect(String(detail)).toContain('2')
  })

  it('真实链路：按保留期删过期日文件，今天的不动（落点全在沙箱 logsDir）', async () => {
    const h = fakeHome()
    try {
      const dir = logsDir()
      fs.mkdirSync(dir, { recursive: true })
      const now = new Date()
      const pad = (n: number) => String(n).padStart(2, '0')
      const todayName = `gateway-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.jsonl`
      fs.writeFileSync(path.join(dir, 'gateway-2020-01-01.jsonl'), '{}\n', 'utf8')
      fs.writeFileSync(path.join(dir, todayName), '{}\n', 'utf8')
      const detail = await logsPruneFix(30).run()
      expect(String(detail)).toContain('1')
      expect(fs.existsSync(path.join(dir, 'gateway-2020-01-01.jsonl'))).toBe(false)
      expect(fs.existsSync(path.join(dir, todayName))).toBe(true)
    } finally {
      h.restore()
    }
  })

  it('withPruneFix：warn/bad 且保留期>0 挂修复；ok/info 或 0（禁用清理）不挂', () => {
    const base = { id: 'logs.disk', msg: 'x' }
    expect(withPruneFix({ ...base, level: 'warn' } as DoctorFinding, 7).fix?.kind).toBe('prune-logs')
    expect(withPruneFix({ ...base, level: 'bad' } as DoctorFinding, undefined).fix?.kind).toBe('prune-logs') // 缺省取默认保留期
    expect(withPruneFix({ ...base, level: 'ok' } as DoctorFinding, 7).fix).toBeUndefined()
    expect(withPruneFix({ ...base, level: 'info' } as DoctorFinding, 7).fix).toBeUndefined()
    expect(withPruneFix({ ...base, level: 'warn' } as DoctorFinding, 0).fix).toBeUndefined()
  })
})

describe('doctor 修复后复核与退出码', () => {
  it('diffFindings 纯函数：resolved/remaining/introduced 按 id+msg 对账', () => {
    const before: DoctorFinding[] = [
      { id: 'a', level: 'warn', msg: 'a1' },
      { id: 'b', level: 'bad', msg: 'b1' },
      { id: 'c', level: 'ok', msg: 'c1' },
    ]
    const after: DoctorFinding[] = [
      { id: 'b', level: 'bad', msg: 'b1' },
      { id: 'd', level: 'warn', msg: 'd1' },
      { id: 'a', level: 'ok', msg: 'a1' },
    ]
    const d = diffFindings(before, after)
    expect(d.resolved.map((f) => f.id)).toEqual(['a'])
    expect(d.remaining.map((f) => f.id)).toEqual(['b', 'd'])
    expect(d.introduced.map((f) => f.id)).toEqual(['d'])
  })

  it('fix 全部解决可解决项：打印复核与已解决；无 bad 后退出码不置 1', async () => {
    const h = fakeHome()
    capture()
    try {
      await mutateConfig((c) => {
        c.gateway = { port: 18941 }
        c.profiles['ghost'] = { name: 'ghost', provider: 'gone' }
      })
      await cmdDoctor({ fix: true }, { ...noProbe, startGateway: async () => 'http://127.0.0.1:18941' })
      const out = logs.join('\n')
      expect(out).toContain('清理悬空 profile')
      expect(out).toContain('已解决')
      expect(process.exitCode).not.toBe(1) // ghost（bad）已清，剩余仅 warn
    } finally {
      h.restore()
    }
  })

  it('存在 bad：退出码置 1（--json 同口径；summary 字段随 JSON 输出）', async () => {
    const h = fakeHome()
    capture()
    try {
      await mutateConfig((c) => {
        c.profiles['ghost'] = { name: 'ghost', provider: 'gone' }
      })
      await cmdDoctor({ json: true }, noProbe)
      expect(process.exitCode).toBe(1)
      const j = jsonFindings() as unknown as { ok: boolean; summary: { total: number; bad: number; fixable: number } }
      expect(j.ok).toBe(false)
      expect(j.summary.bad).toBeGreaterThan(0)
      expect(j.summary.fixable).toBeGreaterThan(0) // 悬空 profile 可自动清理
    } finally {
      h.restore()
    }
  })

  it('port_busy 注入占用者身份：msg 带 pid 标识；未注入时保持原口径', async () => {
    const h = fakeHome()
    capture()
    try {
      await mutateConfig((c) => { c.gateway = { port: 18941 } })
      await cmdDoctor({ json: true }, { portProbe: async () => true, portOccupier: async () => 'pid 4321（node）' })
      const f = jsonFindings().findings.find((x) => x.id === 'gateway.port_busy')
      expect(f?.level).toBe('warn')
      expect(f?.msg).toContain('pid 4321（node）')
    } finally {
      h.restore()
    }
  })
})
