import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fakeHome } from './helpers.js'
import { loadConfig, mutateConfig, saveConfig, ConfigError } from '../src/config/store.js'
import { emptyConfig } from '../src/config/types.js'
import {
  getSecret,
  setSecret,
  setSecretsBatch,
  makeKeyRef,
  parseKeyRef,
  verifySecretsStore,
  SecretsError,
  dpapiCipher,
  machCipher,
  pickFileCipher,
  __testSetDpapiBatch,
  __testSetExternalReader,
  invalidateSecretsCache,
} from '../src/config/secrets.js'
import { initLang, LANG_ENV } from '../src/config/lang.js'
import { setLang, getLang } from '../src/util/i18n.js'
import { atomicWrite } from '../src/util/fsx.js'
import { configPath, secretsPath, modeldockDir } from '../src/util/paths.js'

// 补配置持久层（store.ts / secrets.ts / lang.ts）的分支覆盖盲区。
// 只动 test/；零 vi.mock（隔离纪律：secrets.js 在 uninstall.test.ts 有 mock，本文件不使用其
// 替换出口 deleteSecret）；外部读取器/DPAPI 桩注入用模块内 __test 出口，finally 一律还原。

describe('store：migrate 版本与形状守卫（错误路径）', () => {
  it('version 高于当前支持 → ConfigError 且带可操作 hint', async () => {
    const h = fakeHome()
    try {
      await atomicWrite(configPath(), 'version = 99\n')
      const err = await loadConfig().then(
        () => null,
        (e: unknown) => e as ConfigError
      )
      expect(err).toBeInstanceOf(ConfigError)
      expect(err!.message).toMatch(/99/)
      expect(err!.hint).toBeTruthy()
    } finally {
      h.restore()
    }
  })

  it('容器键为数组（providers = []）→ ConfigError 报数组形态，不抛原始 TypeError', async () => {
    const h = fakeHome()
    try {
      await atomicWrite(configPath(), 'providers = []\n')
      await expect(loadConfig()).rejects.toBeInstanceOf(ConfigError)
      await expect(loadConfig()).rejects.toThrow(/providers/)
      await expect(loadConfig()).rejects.toThrow(/数组|array/)
    } finally {
      h.restore()
    }
  })

  it('可选对象键为数组（gateway = []）与标量（backup = 5）→ ConfigError', async () => {
    const h = fakeHome()
    try {
      await atomicWrite(configPath(), 'gateway = []\n')
      await expect(loadConfig()).rejects.toThrow(/gateway/)
      await atomicWrite(configPath(), 'backup = 5\n')
      await expect(loadConfig()).rejects.toBeInstanceOf(ConfigError)
      await expect(loadConfig()).rejects.toThrow(/backup/)
    } finally {
      h.restore()
    }
  })
})

describe('store：normalizeGateway 规范化与 mutateConfig 失败语义', () => {
  it('已退役 tray_lite 键读入即剥除；已带 dayFilter 的窗口原样保留', async () => {
    const h = fakeHome()
    try {
      fs.mkdirSync(path.dirname(configPath()), { recursive: true })
      fs.writeFileSync(
        configPath(),
        `[gateway]
tray_lite = true

[[gateway.schedule.windows]]
start = "09:00"
end = "12:00"
target = "p1"
dayFilter = "holiday"
`
      )
      const cfg = await loadConfig()
      expect((cfg.gateway as unknown as Record<string, unknown>).tray_lite).toBeUndefined()
      // 已带 dayFilter 的窗口不触发 days 简写迁移，原样保留
      expect(cfg.gateway!.schedule!.windows![0]).toEqual({
        start: '09:00',
        end: '12:00',
        target: 'p1',
        dayFilter: 'holiday',
      })
    } finally {
      h.restore()
    }
  })

  it('mutateConfig fn 抛错：不落盘、错误透传、锁释放（后续写可继续）', async () => {
    const h = fakeHome()
    try {
      await saveConfig(emptyConfig())
      await expect(
        mutateConfig(() => {
          throw new Error('boom')
        })
      ).rejects.toThrow('boom')
      // 未落盘：无 active_profile、providers 仍为空
      expect((await loadConfig()).active_profile).toBeUndefined()
      // 锁已释放：同进程后续 mutate 照常工作
      await mutateConfig((c) => {
        c.active_profile = 'ok'
      })
      expect((await loadConfig()).active_profile).toBe('ok')
    } finally {
      h.restore()
    }
  })
})

describe('lang：initLang daemon/GUI 路径与损坏配置回落', () => {
  it('无 argv（daemon/GUI 路径）：不动 argv，按 config 设置语言', async () => {
    const h = fakeHome()
    const prevLang = process.env[LANG_ENV]
    delete process.env[LANG_ENV] // 隔离：不依赖其他文件的 env 残留
    try {
      await atomicWrite(configPath(), 'language = "en"\n')
      const rest = await initLang()
      expect(rest).toEqual([])
      expect(getLang()).toBe('en')
    } finally {
      setLang('zh')
      if (prevLang === undefined) delete process.env[LANG_ENV]
      else process.env[LANG_ENV] = prevLang // 还原调用前预置值（如 CI 环境 MODELRDOCK_LANG）
      h.restore()
    }
  })

  it('config 损坏不阻断语言解析：回落 zh（错误由正常加载路径报出）', async () => {
    const h = fakeHome()
    const prevLang = process.env[LANG_ENV]
    delete process.env[LANG_ENV]
    try {
      await atomicWrite(configPath(), 'not [valid toml\nversion = ')
      const rest = await initLang(['node', 'cli', 'status'])
      expect(rest).toEqual(['node', 'cli', 'status'])
      expect(getLang()).toBe('zh')
    } finally {
      setLang('zh')
      if (prevLang === undefined) delete process.env[LANG_ENV]
      else process.env[LANG_ENV] = prevLang
      h.restore()
    }
  })
})

describe('secrets：cipher 描述符错误路径（DUP-07 合并后）', () => {
  it('DPAPI 加密/解密表行数不匹配 → SecretsError（桩注入，行数 0）', async () => {
    __testSetDpapiBatch(async () => [])
    try {
      await expect(dpapiCipher.encryptTable({ a: 'sk-1' })).rejects.toBeInstanceOf(SecretsError)
      await expect(dpapiCipher.encryptTable({ a: 'sk-1' })).rejects.toThrow(/行数|line count/)
      await expect(dpapiCipher.decryptTable({ a: 'enc:dpapi:QUJD' })).rejects.toBeInstanceOf(SecretsError)
    } finally {
      __testSetDpapiBatch() // 还原真实实现，避免污染同进程其他用例
    }
  })

  it('machine cipher 解密无前缀值透传；加密跳过空值与已带前缀值', async () => {
    // 无前缀值 = 存量明文/普通值，原样透传不触发解密
    expect(await machCipher.decryptTable({ a: 'sk-plain' })).toEqual({ a: 'sk-plain' })
    // 加密端：普通明文加前缀加密；空值与已带前缀的值原样保留（不二次加密）
    const enc = await machCipher.encryptTable({ a: 'x', b: '', c: 'enc:mach:already' })
    expect(enc.a).toMatch(/^enc:mach:/)
    expect(enc.b).toBe('')
    expect(enc.c).toBe('enc:mach:already')
    // 往返：加密结果可解回明文（密钥进程内派生，不依赖外部钥匙环）
    expect(await machCipher.decryptTable({ a: enc.a, b: enc.b })).toEqual({ a: 'x', b: '' })
  })

  it('pickFileCipher 平台选择：prefix/enabled 与平台能力一致（含 darwin 明文回落）', async () => {
    const c = pickFileCipher()
    if (process.platform === 'win32') {
      expect(c.prefix).toBe('enc:dpapi:')
      expect(c.enabled).toBe(true)
    } else if (process.platform === 'linux') {
      // 有 machine-id → machCipher；无（罕见）→ 明文回落
      expect(c.prefix === 'enc:mach:' || c.prefix === '').toBe(true)
      expect(c.enabled).toBe(c.prefix === 'enc:mach:')
    } else {
      // darwin 等：无 DPAPI、无 machine-id → 明文后端（enabled=false 触发 warnPlainFileOnce 分支的前提）
      expect(c.prefix).toBe('')
      expect(c.enabled).toBe(false)
      // 明文后端加解密原样透传
      expect(await c.encryptTable({ a: 'x', b: '' })).toEqual({ a: 'x', b: '' })
      expect(await c.decryptTable({ a: 'x' })).toEqual({ a: 'x' })
    }
  })

  it('makeKeyRef / parseKeyRef 全方案往返（keychain / secret-service / file）', () => {
    expect(makeKeyRef('keychain', 'x')).toBe('keychain:x')
    expect(makeKeyRef('secret-service', 'x')).toBe('secret-service:x')
    expect(makeKeyRef('file', 'x')).toBe('file:x')
    expect(parseKeyRef('secret-service:a')).toEqual({ scheme: 'secret-service', id: 'a' })
    expect(parseKeyRef('file:b')).toEqual({ scheme: 'file', id: 'b' })
    expect(parseKeyRef(makeKeyRef('keychain', 'round'))).toEqual({ scheme: 'keychain', id: 'round' })
  })
})

describe('secrets：损坏形态与外部后端错误路径', () => {
  it('secrets.json 根为数组/标量 → SecretsError（含 kind 提示），不抛原始 TypeError', async () => {
    const h = fakeHome()
    try {
      await atomicWrite(secretsPath(), '[]\n')
      invalidateSecretsCache()
      await expect(getSecret('file:a')).rejects.toBeInstanceOf(SecretsError)
      await expect(getSecret('file:a')).rejects.toThrow(/密钥表|key-table/)
      await expect(getSecret('file:a')).rejects.toThrow(/数组|array/)
      await atomicWrite(secretsPath(), '"just-a-string"\n')
      invalidateSecretsCache()
      await expect(getSecret('file:a')).rejects.toBeInstanceOf(SecretsError)
    } finally {
      h.restore()
    }
  })

  it('keychain 读取抛错 → 包成 SecretsError（钥匙环锁定 hint），不进缓存', async () => {
    invalidateSecretsCache()
    __testSetExternalReader(async () => {
      throw new Error('keyring locked')
    })
    try {
      await expect(getSecret('keychain:locked')).rejects.toBeInstanceOf(SecretsError)
      await expect(getSecret('keychain:locked')).rejects.toThrow(/钥匙环|keyring/)
    } finally {
      __testSetExternalReader()
      invalidateSecretsCache()
    }
  })

  it('keychain 条目不存在 → null，且 null 结果进入 TTL 缓存不重读外部源', async () => {
    invalidateSecretsCache()
    let calls = 0
    __testSetExternalReader(async (_scheme, id) => {
      calls++
      return id === 'nope' ? null : `ext-${id}`
    })
    try {
      expect(await getSecret('keychain:nope')).toBeNull()
      expect(await getSecret('keychain:nope')).toBeNull()
      expect(calls).toBe(1) // 「确认不存在」的 null 同样被缓存，未命中条目不重复 spawn
    } finally {
      __testSetExternalReader()
      invalidateSecretsCache()
    }
  })
})

describe('secrets：写路径守卫与体检', () => {
  it('沙箱（FAKE_HOME）下 setSecretsBatch 显式 keychain 被强制落 file', async () => {
    const h = fakeHome()
    try {
      const refs = await setSecretsBatch({ a: 'va', b: 'vb' }, 'keychain')
      expect(refs).toEqual({ a: 'file:a', b: 'file:b' })
      expect(await getSecret('file:a')).toBe('va')
      expect(await getSecret('file:b')).toBe('vb')
    } finally {
      h.restore()
    }
  })

  it('file 后端空串值读为 null', async () => {
    const h = fakeHome()
    try {
      fs.mkdirSync(modeldockDir(), { recursive: true })
      await atomicWrite(secretsPath(), JSON.stringify({ a: '' }, null, 2) + '\n')
      invalidateSecretsCache()
      expect(await getSecret('file:a')).toBeNull()
    } finally {
      h.restore()
    }
  })

  it('verifySecretsStore 健康路径：{ ok: true }（DPAPI 桩避免 win32 真 spawn PowerShell）', async () => {
    const h = fakeHome()
    // 同 store.test.ts 惯例：可逆「保护」变换替换真实 DPAPI 批量进程（ENC/DEC 同一变换构成有效往返），
    // win32 上不依赖外部 PowerShell、mac/linux 上桩不会被调用（mach/明文 cipher 不走 dpapiBatch）
    const protect = (b64: string) => Buffer.from(Buffer.from(b64, 'base64').reverse()).toString('base64')
    __testSetDpapiBatch(async (_script, b64In) => b64In.map(protect))
    try {
      await setSecret('demo', 'sk-healthy', 'file')
      invalidateSecretsCache() // 强制从盘重读，体检走真实读盘+解密路径而非内存缓存
      expect(await verifySecretsStore()).toEqual({ ok: true })
    } finally {
      __testSetDpapiBatch() // 还原真实实现，避免污染同进程其他用例
      h.restore()
    }
  })

  it('verifySecretsStore 损坏文件：{ ok: false, error } 不抛出', async () => {
    const h = fakeHome()
    try {
      await atomicWrite(secretsPath(), 'not json at all')
      invalidateSecretsCache()
      const r = await verifySecretsStore()
      expect(r.ok).toBe(false)
      expect(typeof (r as { error: string }).error).toBe('string')
    } finally {
      h.restore()
    }
  })
})
