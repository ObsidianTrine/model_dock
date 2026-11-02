import { describe, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fakeHome } from './helpers.js'
import { atomicWrite, ensureDir } from '../src/util/fsx.js'
import { modeldockDir, secretsPath } from '../src/util/paths.js'
import {
  armChildTimeout,
  defaultStore,
  deleteSecret,
  getSecret,
  invalidateSecretsCache,
  keychainArgValue,
  pickFileCipher,
  setSecret,
  __testSetChildTimeoutMs,
  __testSetDpapiBatch,
  __testSetExternalReader,
  __testSetSecretsRawReader,
} from '../src/config/secrets.js'
import { migrateSandboxKeyRefsToLocal } from '../src/config/sandbox.js'
import { loadConfig, mutateConfig } from '../src/config/store.js'
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

describe('沙箱隔离：密钥不落 OS 钥匙环', () => {
  it('沙箱（FAKE_HOME）下 defaultStore 一律 file', async () => {
    const h = fakeHome()
    try {
      expect(await defaultStore()).toBe('file')
    } finally {
      h.restore()
    }
  })

  it('非沙箱 darwin 默认 keychain（生产行为不变）', async () => {
    if (process.platform !== 'darwin') return
    const prev = process.env.MODELRDOCK_FAKE_HOME
    delete process.env.MODELRDOCK_FAKE_HOME
    try {
      expect(await defaultStore()).toBe('keychain')
    } finally {
      if (prev === undefined) delete process.env.MODELRDOCK_FAKE_HOME
      else process.env.MODELRDOCK_FAKE_HOME = prev
    }
  })

  it('沙箱里显式 keychain 后端被强制落 file（secrets.json）', async () => {
    const h = fakeHome()
    try {
      expect(await setSecret('p1', 'sk-sb', 'keychain')).toBe('file:p1')
      expect(await getSecret('file:p1')).toBe('sk-sb')
    } finally {
      h.restore()
    }
  })

  it('沙箱里 deleteSecret 跳过外部条目（不删生产钥匙环），file 条目照常删', async () => {
    const h = fakeHome()
    try {
      const ref = await setSecret('keep-file', 'sk-x', 'file')
      await expect(deleteSecret('keychain:prod-entry')).resolves.toBeUndefined()
      await expect(deleteSecret('secret-service:prod-entry2')).resolves.toBeUndefined()
      await deleteSecret(ref)
      expect(await getSecret(ref)).toBeNull()
    } finally {
      h.restore()
    }
  })

  it('启动迁移：keychain 引用与 security.store 落地为 file，值进沙箱 secrets.json；幂等', async () => {
    const h = fakeHome()
    try {
      // update-token 故意返回 null（模拟外部条目读不到）：按新契约跳过该条——不落空 key、
      // 引用保持原样由守卫兜底（旧行为会把可用的生产引用永久替换成指向空 key 的 file 引用）
      __testSetExternalReader(async (_scheme, id) => (id === 'prod-a' ? 'sk-aaa' : null))
      try {
        await mutateConfig((c) => {
          c.providers['prod-a'] = { base_url: 'https://a.example.com', protocol: 'openai', auth_style: 'bearer', key_ref: 'keychain:prod-a' }
          c.providers['local-p'] = { base_url: 'https://b.example.com', protocol: 'openai', auth_style: 'bearer', key_ref: 'file:local-p' }
          c.security = { store: 'keychain' }
          c.update = { token_ref: 'keychain:update-token' }
        })
        const migrated = await migrateSandboxKeyRefsToLocal()
        expect(migrated).toContain('prod-a')
        expect(migrated).not.toContain('update:update-token')
        const cfg2 = await loadConfig()
        expect(cfg2.providers['prod-a'].key_ref).toBe('file:prod-a')
        expect(cfg2.providers['local-p'].key_ref).toBe('file:local-p')
        expect(cfg2.security?.store).toBe('file')
        // 读不到的条目引用保持原样（deleteSecret 沙箱守卫兜底，不再写坏它）
        expect(cfg2.update?.token_ref).toBe('keychain:update-token')
        expect(await getSecret('file:prod-a')).toBe('sk-aaa')
        expect(await migrateSandboxKeyRefsToLocal()).toEqual([])
      } finally {
        __testSetExternalReader()
      }
    } finally {
      h.restore()
    }
  })

  it('启动迁移：外部值可读时 update token 引用照常落地为 file', async () => {
    const h = fakeHome()
    try {
      // 模拟 daemon 启动的新进程：清掉本文件前一用例经 externalCache 缓存的 null（isolate:false 共享注册表）
      invalidateSecretsCache()
      __testSetExternalReader(async (_scheme, id) => (id === 'update-token' ? 'ghp_xxx' : null))
      try {
        await mutateConfig((c) => {
          c.security = { store: 'keychain' }
          c.update = { token_ref: 'keychain:update-token' }
        })
        const migrated = await migrateSandboxKeyRefsToLocal()
        expect(migrated).toContain('update:update-token')
        const cfg2 = await loadConfig()
        expect(cfg2.update?.token_ref).toBe('file:update-token')
        expect(await getSecret('file:update-token')).toBe('ghp_xxx')
      } finally {
        __testSetExternalReader()
      }
    } finally {
      h.restore()
    }
  })
})

describe('secrets 明文迁移竞态（迁移写持锁 + 重读比对）', () => {
  it('迁移窗口内并发写进程落了新 key：跳过迁移写，不覆盖盘上新表', async () => {
    const h = fakeHome()
    try {
      invalidateSecretsCache()
      if (!pickFileCipher().enabled) return // 明文后端（无钥匙环 CI）无迁移语义
      __testSetDpapiBatch(async (_script, b64In) => b64In) // base64 恒等：encryptTable 前缀拼接即往返
      try {
        // 盘上 =「并发写进程」刚写好的新表（两个 key）；注入的 raw 读取器模拟时序：
        // 读进程先读到旧表（只有 demo）→ 写进程写盘（此刻盘上已是新表）→ 读进程持锁重读见新表。
        // 只走读路径（getSecret）触发迁移判断：写路径（mutateFileSecrets）自己持锁重读整表，
        // 不是本卡要修的竞态窗口。
        await writeSecrets({ demo: 'sk-v1', other: 'sk-concurrent' })
        const tables = [{ demo: 'sk-v1' }, { demo: 'sk-v1', other: 'sk-concurrent' }]
        let n = 0
        __testSetSecretsRawReader(async () => tables[Math.min(n++, tables.length - 1)])
        expect(await getSecret('file:demo')).toBe('sk-v1')
        // 盘上未被旧表迁移写覆盖：other key 仍在且保持并发写进程的值（未加密、未丢）
        const onDisk = JSON.parse(readFileSync(secretsPath(), 'utf8'))
        expect(onDisk.other).toBe('sk-concurrent')
        expect(onDisk.demo).toBe('sk-v1')
      } finally {
        __testSetDpapiBatch()
        __testSetSecretsRawReader()
      }
    } finally {
      invalidateSecretsCache()
      h.restore()
    }
  })

  it('无并发写时迁移照常发生：盘上明文变密文，读取往返一致', async () => {
    const h = fakeHome()
    try {
      invalidateSecretsCache()
      const cipher = pickFileCipher()
      if (!cipher.enabled) return
      if (cipher.prefix === 'enc:dpapi:') __testSetDpapiBatch(async (_script, b64In) => b64In)
      try {
        await writeSecrets({ demo: 'sk-plain' })
        expect(await getSecret('file:demo')).toBe('sk-plain')
        const onDisk = JSON.parse(readFileSync(secretsPath(), 'utf8'))
        expect(Object.values(onDisk).every((v) => typeof v === 'string' && (v === '' || v.startsWith(cipher.prefix)))).toBe(true)
        invalidateSecretsCache()
        expect(await getSecret('file:demo')).toBe('sk-plain') // 重读：密文往返一致
      } finally {
        __testSetDpapiBatch()
      }
    } finally {
      invalidateSecretsCache()
      h.restore()
    }
  })
})

describe('外部子进程超时守卫（armChildTimeout）', () => {
  it('到点强杀长睡子进程并翻转 timedOut 标志', async () => {
    __testSetChildTimeoutMs(200)
    try {
      const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' })
      const guard = armChildTimeout(child, 'test-tool')
      let closed = false
      child.on('close', () => { closed = true })
      await new Promise((r) => setTimeout(r, 900))
      expect(guard.timedOut()).toBe(true)
      expect(closed).toBe(true)
      guard.dispose()
    } finally {
      __testSetChildTimeoutMs() // 还原默认 10s，避免污染同进程其他用例（isolate:false 共享注册表）
    }
  })

  it('未到点退出的子进程不误报超时', async () => {
    __testSetChildTimeoutMs(5000)
    try {
      const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' })
      const guard = armChildTimeout(child, 'test-tool')
      await new Promise((r) => setTimeout(r, 400))
      expect(guard.timedOut()).toBe(false)
      guard.dispose()
    } finally {
      __testSetChildTimeoutMs()
    }
  })
})