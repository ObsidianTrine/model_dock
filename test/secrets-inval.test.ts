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
  invalidateSecretsCacheIfExternal,
  keychainArgValue,
  pickFileCipher,
  setSecret,
  transientSpawnError,
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

  it('reloadRuntime 不再清 secrets 缓存：config 热加载与密钥缓存解耦（保存慢收口：写 config 不再牵连钥匙环重读）', async () => {
    const h = fakeHome()
    try {
      const ref = await setSecret('demo', 'sk-r1', 'file')
      const rt = buildRuntime(emptyConfig(), 'tok')
      await reloadRuntime(rt) // config 热加载：密钥缓存不受牵连
      expect(await getSecret(ref)).toBe('sk-r1')
      await reloadRuntime(rt)
      expect(await getSecret(ref)).toBe('sk-r1') // 旧实现每次 reload 全清缓存 → 下次读取重付解密
    } finally {
      h.restore()
    }
  })

  it('外部改写 secrets.json：watcher 口径 invalidateSecretsCacheIfExternal 失效；自家写不误失效', async () => {
    const h = fakeHome()
    try {
      const ref = await setSecret('demo', 'sk-e1', 'file') // 自家写：缓存与写后指纹都已记录
      expect(await getSecret(ref)).toBe('sk-e1')
      // 自家写的 rename 事件：宽限窗内跳过失效，缓存保持温暖（重读盘注入的读取器不被触达）
      __testSetSecretsRawReader(async () => {
        throw new Error('must not re-read secrets.json after self write')
      })
      try {
        await invalidateSecretsCacheIfExternal()
        expect(await getSecret(ref)).toBe('sk-e1')
      } finally {
        __testSetSecretsRawReader()
      }
      // 宽限窗外指纹仍然命中（盘上没动过）：同样跳过
      const base = Date.now()
      const spy = vi.spyOn(Date, 'now').mockImplementation(() => base + 2000)
      try {
        __testSetSecretsRawReader(async () => {
          throw new Error('must not re-read secrets.json after self write')
        })
        await invalidateSecretsCacheIfExternal()
        expect(await getSecret(ref)).toBe('sk-e1')
      } finally {
        spy.mockRestore()
        __testSetSecretsRawReader()
      }
      // 外部写（另一进程口径）：指纹不符 → 失效 → 重读拿到新值。
      // 时钟前推跳出自家写宽限窗（1.5s）：真实测试节奏跑不到宽限窗之外，会被当自家写跳过
      const base2 = Date.now()
      const spy2 = vi.spyOn(Date, 'now').mockImplementation(() => base2 + 3000)
      try {
        await writeSecrets({ demo: 'sk-e2' })
        await invalidateSecretsCacheIfExternal()
      } finally {
        spy2.mockRestore()
      }
      expect(await getSecret(ref)).toBe('sk-e2')
    } finally {
      h.restore()
    }
  })

  it('外部改写后回验窗口到期（FILE_RECHECK_MS=5s）：getSecret 自动重读拿新值，无需显式失效', async () => {
    const h = fakeHome()
    try {
      const ref = await setSecret('demo', 'sk-t1', 'file')
      expect(await getSecret(ref)).toBe('sk-t1')
      await writeSecrets({ demo: 'sk-t2' })
      expect(await getSecret(ref)).toBe('sk-t1') // 回验窗口内：旧缓存（转发热路径零 I/O 设计）
      const base = Date.now()
      const spy = vi.spyOn(Date, 'now').mockImplementation(() => base + 6000)
      try {
        expect(await getSecret(ref)).toBe('sk-t2') // 窗口到期：stat 回验发现盘已变，重读
      } finally {
        spy.mockRestore()
      }
    } finally {
      h.restore()
    }
  })
})

describe('secrets 写路径免重复解密（perf-secrets-cache）', () => {
  it('缓存命中时 set-key/delete 全程 0 次解密 spawn；未变更条目密文逐字节保留；新值可读回', async () => {
    const h = fakeHome()
    try {
      invalidateSecretsCache()
      const cipher = pickFileCipher()
      let protect = 0
      let unprotect = 0
      // DPAPI 后端注入恒等批量（base64 往返）并数 spawn 次数；明文/mach 后端天然无 PowerShell spawn，
      // 断言「0 次解密 spawn」「未变更条目密文保留」三平台同语义（mach 的 AES 密文也非确定性）
      __testSetDpapiBatch(async (script, b64In) => {
        if (script.includes('Protect')) protect++
        else if (script.includes('Unprotect')) unprotect++
        return b64In
      })
      try {
        const refA = await setSecret('wa', 'sk-wa1', 'file') // 冷缓存：空表无解密，加密仅 wa 一条
        const diskAfterA = JSON.parse(readFileSync(secretsPath(), 'utf8')) as Record<string, string>
        const refB = await setSecret('wb', 'sk-wb1', 'file') // 缓存命中：指纹复用明文，0 解密；只加密 wb
        expect(unprotect).toBe(0) // 全程 0 次解密 spawn（指纹命中，未触发整表解密）
        if (cipher.prefix === 'enc:dpapi:') expect(protect).toBe(2) // 仅两次「新增条目」加密，无整表重加密
        const diskAfterB = JSON.parse(readFileSync(secretsPath(), 'utf8')) as Record<string, string>
        expect(diskAfterB['wa']).toBe(diskAfterA['wa']) // 未变更条目密文逐字节保留（重加密必然变样）
        expect(await getSecret(refA)).toBe('sk-wa1')
        expect(await getSecret(refB)).toBe('sk-wb1')
        const protectBefore = protect
        await deleteSecret(refB) // 删 key：其余条目全部未变 → 复用原密文，0 加密 spawn
        const diskAfterDel = JSON.parse(readFileSync(secretsPath(), 'utf8')) as Record<string, string>
        expect(diskAfterDel['wa']).toBe(diskAfterA['wa'])
        expect(diskAfterDel['wb']).toBeUndefined()
        if (cipher.prefix === 'enc:dpapi:') expect(protect).toBe(protectBefore)
        expect(await getSecret(refA)).toBe('sk-wa1')
      } finally {
        __testSetDpapiBatch()
        invalidateSecretsCache()
      }
    } finally {
      h.restore()
    }
  })

  it('盘上密文被外部改动后指纹失配：写路径强制重读正确重解密，外部条目不丢、新值生效', async () => {
    const h = fakeHome()
    try {
      invalidateSecretsCache()
      const cipher = pickFileCipher()
      if (cipher.prefix === 'enc:dpapi:') __testSetDpapiBatch(async (_script, b64In) => b64In)
      try {
        const ref = await setSecret('fx', 'sk-f1', 'file')
        expect(await getSecret(ref)).toBe('sk-f1')
        // 外部直接改写 secrets.json（另一进程/手编）：明文表（解密对非前缀值原样透传）
        await writeSecrets({ fx: 'sk-f2', extra: 'sk-e' })
        expect(await getSecret(ref)).toBe('sk-f1') // 普通读仍指旧缓存（既有失效语义，未变）
        // 写路径强制重读：指纹失配 → 完整重解密 → 盘上新表为准（绝不复用旧明文覆盖外部改动）
        await setSecret('fx', 'sk-f3', 'file')
        expect(await getSecret(ref)).toBe('sk-f3')
        expect(await getSecret('file:extra')).toBe('sk-e') // 外部条目保留（未被旧缓存整表覆盖丢失）
      } finally {
        __testSetDpapiBatch()
        invalidateSecretsCache()
      }
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
        const tables: Array<Record<string, string>> = [{ demo: 'sk-v1' }, { demo: 'sk-v1', other: 'sk-concurrent' }]
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
describe('dpapiBatch 重试分流（transientSpawnError）', () => {
  it('瞬时类（超时标记 / 资源类错误码）重试；确定性（非零退出 / ENOENT）不重试', () => {
    const timeoutErr: Error & { transient?: boolean } = new Error('powershell DPAPI 超时（10000ms 无退出），已强制终止')
    timeoutErr.transient = true
    expect(transientSpawnError(timeoutErr)).toBe(true)
    expect(transientSpawnError(Object.assign(new Error('resource'), { code: 'EAGAIN' }))).toBe(true)
    expect(transientSpawnError(Object.assign(new Error('resource'), { code: 'EMFILE' }))).toBe(true)
    // 非零退出 = PowerShell 跑完但 Unprotect 失败（换账号密文必败，同一输入不会变）
    expect(transientSpawnError(new Error('powershell exited 1'))).toBe(false)
    expect(transientSpawnError(Object.assign(new Error('no tool'), { code: 'ENOENT' }))).toBe(false)
    expect(transientSpawnError('not an error object')).toBe(false)
  })
})
