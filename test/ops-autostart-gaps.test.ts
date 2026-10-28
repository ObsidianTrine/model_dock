import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fakeHome } from './helpers.js'
import {
  addService,
  setAutoRoute,
  setRouteNext,
  switchToServiceWithRoute,
  ensureProfileForProvider,
  resyncHarnessToRoute,
  removeProviderCascade,
  migrateSecretsToSecure,
} from '../src/ops.js'
import {
  recordedArgvStale,
  readRecordedArgv,
  autostartStatus,
  windowsRunValueMirrorFile,
  windowsRunValueDisplay,
} from '../src/autostart.js'
import { saveConfig, loadConfig } from '../src/config/store.js'
import { emptyConfig } from '../src/config/types.js'
import { reloadPresets } from '../src/presets/data.js'
import { appendCrashLog } from '../src/util/crash.js'
import { getPath, setPath, toSegments } from '../src/util/jsonpath.js'
import { modeldockDir, logsDir, secretsPath } from '../src/util/paths.js'

// 补 src 根模块（ops.ts / autostart.ts）与 src/util（crash.ts / jsonpath.ts）的分支覆盖盲区。
// 只动 test/；零 vi.mock（autostart.js 在 gateway/syncpull/uninstall 有 spread 型 mock，
// 本文件只用未被替换的纯函数出口）；mock 上游一律 listen(0) + 127.0.0.1。

function listenEphemeral(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (!addr || typeof addr === 'string') reject(new Error('no port'))
      else resolve(addr.port)
    })
  })
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((r) => {
    server.closeAllConnections?.()
    server.close(() => r())
  })
}

/** 在沙箱注册一个无模型目录的自定义预设（用户扩展机制 presets.json），供 addService 走在线拉取分支。
 *  格式须符合 readUserPresets 的顶层形态：数组或 { "presets": [...] }。 */
function registerMockFetchPreset(port: number): void {
  fs.mkdirSync(modeldockDir(), { recursive: true })
  fs.writeFileSync(
    path.join(modeldockDir(), 'presets.json'),
    JSON.stringify({
      presets: [
        {
          id: 'mock-fetch',
          label: 'Mock',
          vendor: 'Mock',
          base_url: `http://127.0.0.1:${port}`,
          protocol: 'openai',
          auth_style: 'bearer',
        },
      ],
    }),
    'utf8'
  )
  reloadPresets()
}

describe('addService：参数校验与重复/ID 冲突（错误路径）', () => {
  it('未知预设 → 可操作报错', async () => {
    const h = fakeHome()
    try {
      await expect(addService('no-such-preset', 'sk-1', { fetch: false })).rejects.toThrow(/未知服务预设|Unknown service preset/)
    } finally {
      h.restore()
    }
  })

  it('空 Key → 可操作报错（不写任何配置）', async () => {
    const h = fakeHome()
    try {
      await expect(addService('deepseek-anthropic', '', { fetch: false })).rejects.toThrow(/Key 不能为空|Key is required/)
      expect(fs.existsSync(path.join(modeldockDir(), 'config.toml'))).toBe(false)
    } finally {
      h.restore()
    }
  })

  it('同地址同 Key 重复提交 → 可操作报错；同地址不同 Key 允许且 ID 递增为 slug-2', async () => {
    const h = fakeHome()
    try {
      const r1 = await addService('deepseek-anthropic', 'sk-dup', { fetch: false })
      expect(r1.providerId).toBe('deepseek')
      await expect(addService('deepseek-anthropic', 'sk-dup', { fetch: false })).rejects.toThrow(/已存在|already exists/)
      // 同地址不同 Key = 同厂商多账号，合法：ID 冲突走 slug-2 递增
      const r2 = await addService('deepseek-anthropic', 'sk-other', { fetch: false })
      expect(r2.providerId).toBe('deepseek-2')
      expect((await loadConfig()).providers['deepseek-2'].key_ref).toBe('file:deepseek-2')
    } finally {
      h.restore()
    }
  })
})

describe('addService：默认模型回落与 active_profile 语义', () => {
  it('显式 defaultModel 不在最终目录 → 回落目录第一行；在目录内 → 生效', async () => {
    const h = fakeHome()
    try {
      await addService('deepseek-anthropic', 'sk-1', { fetch: false, defaultModel: 'ghost-model' })
      expect((await loadConfig()).profiles['auto-deepseek'].default_model).toBe('deepseek-flash')
    } finally {
      h.restore()
    }
    const h2 = fakeHome()
    try {
      await addService('bigmodel-openai', 'sk-2', { fetch: false, defaultModel: 'glm-5.3-flash' })
      expect((await loadConfig()).profiles['auto-bigmodel'].default_model).toBe('glm-5.3-flash')
    } finally {
      h2.restore()
    }
  })

  it('setActiveIfEmpty：空配置时设 active，已有 active 不抢', async () => {
    const h = fakeHome()
    try {
      await addService('deepseek-anthropic', 'sk-1', { fetch: false, setActiveIfEmpty: true })
      expect((await loadConfig()).active_profile).toBe('auto-deepseek')
      await addService('bigmodel-openai', 'sk-2', { fetch: false, setActiveIfEmpty: true })
      expect((await loadConfig()).active_profile).toBe('auto-deepseek')
    } finally {
      h.restore()
    }
  })

  it('默认不带 setActiveIfEmpty：空配置保持 active 未设置', async () => {
    const h = fakeHome()
    try {
      await addService('deepseek-anthropic', 'sk-1', { fetch: false })
      expect((await loadConfig()).active_profile).toBeUndefined()
    } finally {
      h.restore()
    }
  })
})

describe('addService：在线拉取分支（自定义预设无目录 → fetchModelIds）', () => {
  it('上游返回 200 模型列表 → 目录填充为 fetched、result.fetched 计数', async () => {
    const h = fakeHome()
    const server = http.createServer((req, res) => {
      if (req.url && (req.url.endsWith('/models') || req.url.endsWith('/v1/models'))) {
        res.writeHead(200, { 'content-type': 'application/json', connection: 'close' })
        res.end(JSON.stringify({ data: [{ id: 'mock-m1', display_name: 'Mock M1', context_window: 131072 }] }))
        return
      }
      res.writeHead(404, { connection: 'close' }).end()
    })
    const port = await listenEphemeral(server)
    try {
      registerMockFetchPreset(port)
      const r = await addService('mock-fetch', 'sk-mock', {})
      expect(r.providerId).toBe('mock-fetch')
      expect(r.fetched).toBe(1)
      expect(r.fetchError).toBeUndefined()
      const cfg = await loadConfig()
      expect(cfg.providers['mock-fetch'].models?.['mock-m1']?.source).toBe('fetched')
      expect(cfg.providers['mock-fetch'].models?.['mock-m1']?.display_name).toBe('Mock M1')
    } finally {
      // 恢复内置预设态：先删自定义预设文件并重载（必须在 h.restore 前——之后 home 已回到真实用户）
      fs.rmSync(path.join(modeldockDir(), 'presets.json'), { force: true })
      reloadPresets()
      await closeServer(server)
      h.restore()
    }
  })

  it('上游全部失败 → addService 照常成功、fetchError 记录原因、fetched=0', async () => {
    const h = fakeHome()
    const server = http.createServer((_req, res) => {
      res.writeHead(500, { connection: 'close' }).end()
    })
    const port = await listenEphemeral(server)
    try {
      registerMockFetchPreset(port)
      const r = await addService('mock-fetch', 'sk-mock', {})
      expect(r.fetched).toBe(0)
      expect(r.fetchError).toBeTruthy()
      // 拉取失败不阻断添加：服务照常入库（目录留空回落内置兜底）
      const cfg = await loadConfig()
      expect(cfg.providers['mock-fetch']).toBeTruthy()
      expect(cfg.providers['mock-fetch'].models).toBeUndefined()
    } finally {
      fs.rmSync(path.join(modeldockDir(), 'presets.json'), { force: true })
      reloadPresets()
      await closeServer(server)
      h.restore()
    }
  })
})

describe('ops：路由操作层（setAutoRoute / setRouteNext / switch / ensureProfile）', () => {
  const p1 = { base_url: 'https://p1.example.com', protocol: 'anthropic' as const, auth_style: 'bearer' as const, key_ref: 'file:p1' }

  it('setAutoRoute：provider null 删钉定、undefined 保持；failoverOn429 开/关、autoFallback 落盘', async () => {
    const h = fakeHome()
    try {
      await saveConfig({ ...emptyConfig(), providers: { p1 } })
      const r1 = await setAutoRoute(true, 'p1', true, false)
      expect(r1).toEqual({ enabled: true, provider: 'p1' })
      expect((await loadConfig()).gateway).toEqual({
        auto_failover: true,
        auto_route_provider: 'p1',
        failover_status_codes: [429, 503],
        auto_fallback: false,
      })
      const r2 = await setAutoRoute(false, null, false, true)
      expect(r2).toEqual({ enabled: false, provider: undefined })
      expect((await loadConfig()).gateway).toEqual({ auto_failover: false, auto_fallback: true })
      // provider 未传：auto_route_provider 已删、auto_fallback 保持
      await setAutoRoute(true)
      const g = (await loadConfig()).gateway!
      expect(g.auto_failover).toBe(true)
      expect(g.auto_route_provider).toBeUndefined()
      expect(g.auto_fallback).toBe(true)
    } finally {
      h.restore()
    }
  })

  it('setRouteNext：钉定、null 恢复自动、未知服务报错', async () => {
    const h = fakeHome()
    try {
      await saveConfig({ ...emptyConfig(), providers: { p1 } })
      expect(await setRouteNext('p1')).toBe('p1')
      expect((await loadConfig()).gateway!.route_next).toBe('p1')
      expect(await setRouteNext(null)).toBeNull()
      expect((await loadConfig()).gateway!.route_next).toBeUndefined()
      await expect(setRouteNext('ghost')).rejects.toThrow(/不存在|does not exist/)
    } finally {
      h.restore()
    }
  })

  it('switchToServiceWithRoute：复用既有 profile；缺 profile 合成 auto-<id>；gateway 钉定一次落盘', async () => {
    const h = fakeHome()
    try {
      await saveConfig({
        ...emptyConfig(),
        providers: {
          p1,
          p2: { base_url: 'https://p2.example.com', protocol: 'openai', auth_style: 'bearer', key_ref: 'file:p2' },
        },
        profiles: { main: { name: 'main', provider: 'p1' } },
        active_profile: 'main',
      })
      expect(await switchToServiceWithRoute('p1', true)).toBe('main')
      expect((await loadConfig()).gateway!.auto_route_provider).toBe('p1')
      expect(await switchToServiceWithRoute('p2', false)).toBe('auto-p2')
      const cfg = await loadConfig()
      expect(cfg.active_profile).toBe('auto-p2')
      expect(cfg.profiles['auto-p2'].provider).toBe('p2')
      expect(cfg.gateway!.auto_route_provider).toBe('p2')
      expect(cfg.gateway!.auto_failover).toBe(false)
    } finally {
      h.restore()
    }
  })

  it('ensureProfileForProvider：复用已有 profile 不改 active；缺 profile 合成 auto-<id>（目录首个为默认模型）', async () => {
    const h = fakeHome()
    try {
      await saveConfig({
        ...emptyConfig(),
        providers: {
          p1,
          p2: { ...p1, base_url: 'https://p2.example.com', models: { x1: { source: 'manual' as const } } },
        },
        profiles: { main: { name: 'main', provider: 'p1' } },
      })
      expect(await ensureProfileForProvider('p1')).toBe('main')
      expect((await loadConfig()).active_profile).toBeUndefined() // 展示层句柄，不切 active
      expect(await ensureProfileForProvider('p2')).toBe('auto-p2')
      const cfg = await loadConfig()
      expect(cfg.profiles['auto-p2'].default_model).toBe('x1')
      expect(cfg.active_profile).toBeUndefined()
    } finally {
      h.restore()
    }
  })

  it('resyncHarnessToRoute：未接入 / file 模式客户端 → 空结果且不写盘', async () => {
    const h = fakeHome()
    try {
      await saveConfig({ ...emptyConfig(), harness: { dsh: { mode: 'file', route: 'main' } } })
      expect(await resyncHarnessToRoute('ghost', 'x')).toEqual({ refreshed: [], warnings: [] })
      expect(await resyncHarnessToRoute('dsh', 'x')).toEqual({ refreshed: [], warnings: [] })
      expect((await loadConfig()).harness['dsh'].files).toBeUndefined()
    } finally {
      h.restore()
    }
  })

  it('removeProviderCascade：file 模式 harness 的悬空 route 重置 default（gateway 模式不动）', () => {
    const c = emptyConfig()
    c.providers['gone'] = p1
    c.profiles['p1'] = { provider: 'gone' }
    c.harness['dsh'] = { mode: 'file', route: 'p1' }
    c.harness['zcode'] = { mode: 'gateway', route: 'default' }
    const removed = removeProviderCascade(c, 'gone')
    expect(removed).toEqual(['p1'])
    expect(c.harness['dsh'].route).toBe('default')
    expect(c.harness['zcode'].route).toBe('default')
  })

  it('migrateSecretsToSecure：沙箱 defaultStore=file → 提前返回（无写盘无迁移）', async () => {
    // 可达性限制（真实迁移循环 getSecret→setSecret→key_ref 换写→deleteSecret 无法在测试内覆盖）：
    // defaultStore 在 MODELRDOCK_FAKE_HOME 存在时强制返回 file（secrets.ts:56 沙箱守卫），
    // 循环体不可达；去掉 FAKE_HOME 则路径指向真实 ~/.modeldock，且 darwin 会真 spawn `security`
    // 写机器级全局钥匙环——沙箱守卫正是为防测试污染生产密钥而设，绕过它违反隔离红线。
    // 覆盖该循环需要 src 注入出口（如可替换的 defaultStore），任务红线「只动 test/**」禁止，
    // 已写入交付说明留待另立卡。本用例守住可达部分：target=file 时零写盘、config 不动。
    const h = fakeHome()
    try {
      await saveConfig({ ...emptyConfig(), providers: { p1 } })
      await migrateSecretsToSecure()
      expect(fs.existsSync(secretsPath())).toBe(false)
      expect((await loadConfig()).providers['p1'].key_ref).toBe('file:p1')
    } finally {
      h.restore()
    }
  })
})

describe('autostart：登记命令失效判定与回读（纯函数）', () => {
  it('recordedArgvStale：argv[0] 缺失 / 非旗标参数文件缺失 → true；健康 → false', () => {
    const h = fakeHome()
    try {
      const missing = path.join(h.home, 'no-such-gateway')
      expect(recordedArgvStale([missing])).toBe(true)
      expect(recordedArgvStale([process.execPath, path.join(h.home, 'no-entry.mjs')])).toBe(true)
      const real = path.join(h.home, 'real.mjs')
      fs.writeFileSync(real, '')
      expect(recordedArgvStale([process.execPath, real, '--sea-gateway'])).toBe(false)
      expect(recordedArgvStale([process.execPath, '--sea-gateway'])).toBe(false)
    } finally {
      h.restore()
    }
  })

  it('readRecordedArgv：base64 合法但非字符串数组（对象/空数组/混型）→ null', () => {
    const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64')
    expect(readRecordedArgv('modeldock-daemon-argv: ' + b64('{"a":1}'))).toBeNull()
    expect(readRecordedArgv('modeldock-daemon-argv: ' + b64('[]'))).toBeNull()
    expect(readRecordedArgv('modeldock-daemon-argv: ' + b64('["x",1]'))).toBeNull()
  })
})

describe.skipIf(process.platform !== 'win32')('autostart：Windows 沙箱镜像的 stale 判定', () => {
  it('镜像命令 argv[0] 已失效 → autostartStatus 报 installed 且 stale（下次登录自启会失败）', () => {
    const h = fakeHome()
    try {
      fs.mkdirSync(modeldockDir(), { recursive: true })
      fs.writeFileSync(
        windowsRunValueMirrorFile(),
        '"C:\\missing\\modeldock.exe" "--sea-gateway" "--autostart"',
        'utf8'
      )
      const st = autostartStatus()
      expect(st?.kind).toBe('windows')
      expect(st?.installed).toBe(true)
      expect(st?.stale).toBe(true)
      expect(st?.file).toBe(windowsRunValueDisplay())
    } finally {
      h.restore()
    }
  })
})

describe('crash：appendCrashLog 写盘失败容错', () => {
  it('日志目录被同名文件占位 → 吞错不抛、原文件不被破坏', () => {
    const h = fakeHome()
    try {
      fs.mkdirSync(modeldockDir(), { recursive: true })
      fs.writeFileSync(logsDir(), 'placeholder', 'utf8')
      expect(() => appendCrashLog('uncaughtException: x')).not.toThrow()
      expect(fs.readFileSync(logsDir(), 'utf8')).toBe('placeholder')
    } finally {
      h.restore()
    }
  })
})

describe('jsonpath：读取边界与写入守卫（setPath/getPath/toSegments）', () => {
  it('getPath：star 段与中途 null 值 → undefined；toSegments 不支持 star', () => {
    const root: any = { a: { b: 1 }, n: null, list: [1] }
    expect(getPath(root, '$.*')).toBeUndefined()
    expect(getPath(root, '$.n.b')).toBeUndefined()
    expect(getPath(root, '$.list[5]')).toBeUndefined()
    expect(() => toSegments('$.*.b')).toThrow(/不支持 \*|does not support \*/)
  })

  it('setPath：数组越界写报错；末尾追加合法；索引下钻创建容器', () => {
    const root: any = { a: [] }
    expect(() => setPath(root, '$.a[1]', 'x')).toThrow(/路径越界|out of bounds/)
    setPath(root, '$.a[0]', 'x')
    setPath(root, '$.a[1]', 'y') // idx === length：末尾追加合法
    expect(root.a).toEqual(['x', 'y'])
    setPath(root, '$.a[2].deep', 1) // 索引下钻：越界前先创建容器
    expect(root.a[2]).toEqual({ deep: 1 })
  })

  it('setPath：star 且无剩余段——对象子节点保留、非对象覆盖、数组根无操作', () => {
    const root2: any = { p1: { kind: 'a' }, p2: 'plain' }
    setPath(root2, '$.*', 'z')
    expect(root2.p1).toEqual({ kind: 'a' }) // 对象子节点跳过（不把服务条目整抹成标量）
    expect(root2.p2).toBe('z')
    const arr: any = ['a']
    setPath(arr, '$.*', 'b')
    expect(arr).toEqual(['a'])
  })
})
