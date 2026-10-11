import { describe, expect, it, vi } from 'vitest'
import { fakeHome } from './helpers.js'
import { atomicWrite, ensureDir } from '../src/util/fsx.js'
import { modeldockDir, secretsPath } from '../src/util/paths.js'
import {
  getSecret,
  setSecret,
  invalidateSecretsCache,
  keychainArgValue,
  __testSetExternalReader,
} from '../src/config/secrets.js'
import { reloadRuntime, buildRuntime } from '../src/gateway/state.js'
import { emptyConfig, type Config } from '../src/config/types.js'

const cfg: Config = {
  ...emptyConfig(),
  providers: {
    demo: { base_url: 'https://demo.example.com', protocol: 'openai', auth_style: 'bearer', key_ref: 'file:demo' },
  },
}

// 直接改写 secrets.json 为指定明文表（非 win/linux 加密格式，三平台解密路径都按「非前缀即明文」透传）
async function writeSecrets(entries: Record<string, string>): Promise<void> {
  await ensureDir(modeldockDir())
  await atomicWrite(secretsPath(), JSON.stringify(entries, null, 2) + '\n', 0o600)
}

describe('secrets cache 失效', () => {
  it('loadFileSecrets 后外部改写 secrets.json，invalidateSecretsCache 后 getSecret 返回新值', async () => {
    const h = fakeHome()
    try {
      const ref = await setSecret('demo', 'sk-v1', 'file')
      expect(await getSecret(ref)).toBe('sk-v1') // 缓存命中
      await writeSecrets({ demo: 'sk-v2' })
      expect(await getSecret(ref)).toBe('sk-v1') // 未失效：仍用旧缓存
      invalidateSecretsCache()
      expect(await getSecret(ref)).toBe('sk-v2') // 失效后重读盘拿到新值
    } finally {
      h.restore()
    }
  })

  it('reloadRuntime 清 secrets 缓存：外部改写后 getSecret 随文件变化', async () => {
    const h = fakeHome()
    try {
      const ref = await setSecret('demo', 'sk-r1', 'file')
      const rt = buildRuntime(emptyConfig(), 'tok')
      await reloadRuntime(rt) // 首次 reload 建立缓存
      expect(await getSecret(ref)).toBe('sk-r1')
      await writeSecrets({ demo: 'sk-r2' })
      expect(await getSecret(ref)).toBe('sk-r1') // 未 reload：旧缓存
      await reloadRuntime(rt) // 文件 watcher 触发 reload 会清 secrets 缓存
      expect(await getSecret(ref)).toBe('sk-r2')
    } finally {
      h.restore()
    }
  })
})

describe('externalCache TTL', () => {
  it('TTL 内命中缓存，过期后重读外部源（桩）拿到新值', async () => {
    const h = fakeHome()
    let calls = 0
    __testSetExternalReader(async (_scheme, id) => {
      calls++
      return `ext-${calls}-${id}` // 每次重读返回新值（反映外部改 key）
    })
    try {
      // 首次读：外部源 1 次调用；TTL 内命中缓存不再读外部源
      expect(await getSecret('keychain:ext1')).toBe('ext-1-ext1')
      expect(await getSecret('keychain:ext1')).toBe('ext-1-ext1')
      expect(calls).toBe(1)
      // 前进 60s+ 模拟 TTL 过期（EXT_TTL = 60_000），过期重读拿第 2 次外部源的新值
      const base = Date.now()
      let now = base
      vi.spyOn(Date, 'now').mockImplementation(() => now)
      now = base + 61_000
      expect(await getSecret('keychain:ext1')).toBe('ext-2-ext1')
      expect(calls).toBe(2)
    } finally {
      vi.mocked(Date.now).mockRestore()
      __testSetExternalReader() // 还原为真实外部读取器
      h.restore()
    }
  })
})

describe('keychainArgValue（darwin 转义纯函数）', () => {
  it('普通值 / 空格 / 引号 / 反斜杠的输出形态', () => {
    expect(keychainArgValue('sk-abc')).toBe('"sk-abc"')
    expect(keychainArgValue('a b c')).toBe('"a b c"')
    expect(keychainArgValue('he"llo')).toBe('"he\\"llo"')
    expect(keychainArgValue('a\\b')).toBe('"a\\\\b"')
  })
  it('含换行 → null（回落 argv 路径标记）', () => {
    expect(keychainArgValue('a\nb')).toBeNull()
    expect(keychainArgValue('a\r\nb')).toBeNull()
    expect(keychainArgValue('a\0b')).toBeNull()
  })
})

describe('reloadRuntime 关闭旧 dispatcher', () => {
  it('proxy dispatcher 被 close、direct 单例不被 close', async () => {
    const h = fakeHome()
    const directClose = vi.fn(() => Promise.resolve())
    const proxyClose = vi.fn(() => Promise.resolve())
    try {
      const rt = buildRuntime(cfg, 'tok')
      const direct = { close: directClose } as never
      const proxy = { close: proxyClose } as never
      rt.dispatchers.set('direct', direct)
      rt.dispatchers.set('http://proxy.example.com:7890', proxy)
      await reloadRuntime(rt)
      expect(proxyClose).toHaveBeenCalledTimes(1)
      expect(directClose).not.toHaveBeenCalled()
      expect(rt.dispatchers.size).toBe(0)
    } finally {
      directClose.mockRestore()
      proxyClose.mockRestore()
      h.restore()
    }
  })
})