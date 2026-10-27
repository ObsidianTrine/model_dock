/**
 * 测试盲区 3（docs/known-issues.md §六尾注）：applySyncdoc 半完成态恢复 + REVIEW-26 既定语义钉行为。
 *
 * applySyncdoc（src/sync/collect.ts）的落盘顺序：快照 → setSecretsBatch（key 重存）→
 * mutateConfig 整包替换（providers/profiles/schedule/active_profile 补默认）→ presets 整体替换。
 * 进程在任意两步之间被杀都会留下「半完成态」；恢复手段只有一个——重放（引擎下轮拉取/用户重导
 * 都会重放同一文档）。本文件钉死恢复契约：
 *  1. 重放幂等：同一文档连 apply 两次，config.toml 与 presets.json 逐字节稳定、key_ref 不漂移；
 *  2. 半完成态恢复：按真实落盘顺序手摆两个崩溃点夹具（①secrets 已写 config 未写；②config 已
 *     整包替换 presets 未写），重放一次即收敛，且引用不悬空（profile→provider、fallback、
 *     定时窗口 target、key_ref 可解析逐项核查）；
 *  3. REVIEW-26（既定语义，留档不改，只钉行为）：远端删除正激活 profile → active_profile 悬空
 *     保留、不自动重指（机器态保护）；转发侧安全回落——默认路由解析 503 可操作提示、
 *     展示层无路由不崩、pickTarget 对未知目标顺延首候选；用户重选一次即恢复。
 *
 * 红线遵守：零 vi.mock；全真实模块直调；fakeHome 隔离（applySyncdoc 显式 backend:'file'，
 * 不触碰真实钥匙串）；不碰 8687/8890。
 */
import fsSync from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { fakeHome } from './helpers.js'
import { loadConfig, mutateConfig, saveConfig } from '../src/config/store.js'
import { getSecret, makeKeyRef, setSecret, setSecretsBatch } from '../src/config/secrets.js'
import { atomicWrite, readTextIfExists } from '../src/util/fsx.js'
import { presetsJsonPath } from '../src/util/paths.js'
import { applySyncdoc, collectSyncdoc } from '../src/sync/collect.js'
import { setupSyncTarget } from '../src/sync/setup.js'
import { syncTickOnce } from '../src/sync/engine.js'
import { keysFromState } from '../src/sync/runtime.js'
import { sealWithKeys } from '../src/sync/crypto.js'
import { createLocaldirTarget } from '../src/sync/targets/localdir.js'
import { blobRefOf } from '../src/sync/targets/types.js'
import { readSyncState } from '../src/sync/state.js'
import { SYNCDOC_FMT, type Syncdoc } from '../src/sync/types.js'
import { buildRuntime, displayRouteProvider, pickTarget, resolveByProfile } from '../src/gateway/state.js'
import type { Config } from '../src/config/types.js'

const TMP = fsSync.realpathSync.native(os.tmpdir())

/** 远端下发的标准文档：2 服务（1 明文 key + 1 env 引用）、2 路由、1 条定时规则、1 条自定义预设 */
function makeDoc(): Syncdoc {
  return {
    fmt: SYNCDOC_FMT,
    v: 1,
    ts: '2026-10-27T00:00:00.000Z',
    data: {
      providers: {
        ark: { base_url: 'https://ark.example.com/api', protocol: 'anthropic', auth_style: 'bearer', key: 'sk-ark' },
        envprov: { base_url: 'https://env.example.com', protocol: 'openai', auth_style: 'bearer', key_ref: 'env:ARK_KEY' },
      },
      profiles: {
        main: { provider: 'ark', default_model: 'auto' },
        backup: { provider: 'envprov', fallback: ['ark'] },
      },
      userPresets: [
        { id: 'corp', label: 'Corp', vendor: 'Corp', base_url: 'https://corp.example.com', protocol: 'openai', auth_style: 'bearer' },
      ],
      scheduleRules: [{ start: '09:00', end: '18:00', target: 'ark' }],
    },
  }
}

/** 目标机机器态种子（导入后必须原样保留的部分） */
async function seedMachineB(): Promise<void> {
  await saveConfig({
    version: 1,
    language: 'en',
    active_profile: 'old-route',
    security: { store: 'file' },
    providers: { stale: { base_url: 'https://stale.example.com', protocol: 'openai', auth_style: 'bearer', key_ref: 'env:STALE' } },
    profiles: { 'old-route': { provider: 'stale' } },
    harness: { dsh: { mode: 'file', attached_at: '2026-02-02T00:00:00.000Z', files: ['/y'] } },
    gateway: { port: 4321, schedule: { enabled: true, windows: [{ start: '00:00', end: '23:59', target: 'stale' }] } },
  } as Config)
  await atomicWrite(presetsJsonPath(), JSON.stringify([{ id: 'old-local-preset', label: 'Old', vendor: 'Old', base_url: 'https://old.example.com', protocol: 'openai', auth_style: 'bearer' }], null, 2) + '\n')
}

/** REVIEW-26 用例的「远端删除前」本机种子：active_profile = main → ark */
async function seedMachineMain(): Promise<void> {
  await setSecret('ark', 'sk-ark-local', 'file')
  await saveConfig({
    version: 1,
    language: 'zh',
    active_profile: 'main',
    security: { store: 'file' },
    providers: { ark: { base_url: 'https://ark.example.com/api', protocol: 'anthropic', auth_style: 'bearer', key_ref: makeKeyRef('file', 'ark') } },
    profiles: { main: { provider: 'ark', default_model: 'auto' } },
    gateway: { port: 12345 },
  } as Config)
}

/** 无悬空引用核查：profile→provider、fallback 条目、定时窗口 target 逐项存在 */
function assertNoDangling(cfg: Config): void {
  for (const [name, pr] of Object.entries(cfg.profiles ?? {})) {
    expect(cfg.providers?.[pr.provider], `profile「${name}」引用的 provider「${pr.provider}」应存在`).toBeTruthy()
    for (const fb of pr.fallback ?? []) {
      const pid = String(fb).split(':')[0]!
      expect(cfg.providers?.[pid], `profile「${name}」fallback「${fb}」应存在`).toBeTruthy()
    }
  }
  for (const w of cfg.gateway?.schedule?.windows ?? []) {
    const pid = String(w.target ?? '').split(':')[0]!
    expect(cfg.providers?.[pid], `定时窗口 target「${w.target}」应存在`).toBeTruthy()
  }
}

describe('applySyncdoc 重放幂等（盲区 3）', () => {
  it('同一文档连 apply 两次：config/presets 逐字节稳定、key_ref 不漂移、keysRestored 一致', async () => {
    const h = fakeHome()
    try {
      await seedMachineB()
      const doc = makeDoc()
      const r1 = await applySyncdoc(doc, { backend: 'file' })
      const snap1 = JSON.stringify(await loadConfig())
      const presets1 = await readTextIfExists(presetsJsonPath())

      const r2 = await applySyncdoc(doc, { backend: 'file' })
      expect(JSON.stringify(await loadConfig())).toBe(snap1)
      expect(await readTextIfExists(presetsJsonPath())).toBe(presets1)
      expect(r2.keysRestored).toBe(r1.keysRestored)

      // 可同步态已替换、机器态原样
      const cfg = await loadConfig()
      expect(Object.keys(cfg.providers ?? {}).sort()).toEqual(['ark', 'envprov'])
      expect(Object.keys(cfg.profiles ?? {}).sort()).toEqual(['backup', 'main'])
      expect(cfg.harness?.dsh).toBeTruthy()
      expect(cfg.gateway?.port).toBe(4321)
      expect(cfg.active_profile).toBe('old-route')
      // 引用不悬空、key 按本机后端重存
      assertNoDangling(cfg)
      expect(cfg.providers!.ark.key_ref).toBe(makeKeyRef('file', 'ark'))
      expect(await getSecret(cfg.providers!.ark.key_ref!)).toBe('sk-ark')
      expect(cfg.providers!.envprov.key_ref).toBe('env:ARK_KEY')
    } finally {
      h.restore()
    }
  })
})

describe('applySyncdoc 半完成态恢复（盲区 3）', () => {
  it('崩溃点①：secrets 已批量落盘（带旧值）、config 未写 → 重放一次收敛，文档值覆盖半完成值', async () => {
    const h = fakeHome()
    try {
      await seedMachineB()
      // 手摆半完成态：阶段①（setSecretsBatch）已发生且写入的是上次中断时的旧值
      await setSecretsBatch({ ark: 'sk-stale-from-interrupted-apply' }, 'file')
      // 重放（引擎下轮拉取/用户重导都会走到这里）
      await applySyncdoc(makeDoc(), { backend: 'file' })

      const cfg = await loadConfig()
      expect(Object.keys(cfg.providers ?? {}).sort()).toEqual(['ark', 'envprov'])
      // 半完成期的旧值被文档值覆盖，引用可解析
      expect(await getSecret(cfg.providers!.ark.key_ref!)).toBe('sk-ark')
      assertNoDangling(cfg)
      expect(cfg.active_profile).toBe('old-route')
      expect(cfg.gateway?.schedule?.windows).toEqual([{ start: '09:00', end: '18:00', target: 'ark' }])
    } finally {
      h.restore()
    }
  })

  it('崩溃点②：secrets+config 已整包替换、presets 未写 → 重放一次收敛，手摆引用被原样复用', async () => {
    const h = fakeHome()
    try {
      await seedMachineB()
      // 手摆半完成态：阶段①② 已落盘（形态与 applySyncdoc 的写法一致），阶段③ presets 未发生
      await setSecretsBatch({ ark: 'sk-ark' }, 'file')
      await mutateConfig((c) => {
        c.providers = {
          ark: { base_url: 'https://ark.example.com/api', protocol: 'anthropic', auth_style: 'bearer', key_ref: makeKeyRef('file', 'ark') },
          envprov: { base_url: 'https://env.example.com', protocol: 'openai', auth_style: 'bearer', key_ref: 'env:ARK_KEY' },
        }
        c.profiles = {
          main: { provider: 'ark', default_model: 'auto' },
          backup: { provider: 'envprov', fallback: ['ark'] },
        }
        c.gateway = { ...c.gateway, schedule: { enabled: true, windows: [{ start: '09:00', end: '18:00', target: 'ark' }] } }
      })
      // presets.json 仍是机器旧内容（old-local-preset）
      expect(await readTextIfExists(presetsJsonPath())).toContain('old-local-preset')

      await applySyncdoc(makeDoc(), { backend: 'file' })

      // presets 半完成态被文档整体替换
      const raw = JSON.parse((await readTextIfExists(presetsJsonPath()))!) as unknown
      const list = Array.isArray(raw) ? raw : (raw as { presets: unknown[] }).presets
      expect(list).toHaveLength(1)
      expect((list[0] as { id: string }).id).toBe('corp')
      // 引用稳定：手摆阶段的 file:ark 引用被同 id 覆盖复用（不换 ref），值正确
      const cfg = await loadConfig()
      expect(cfg.providers!.ark.key_ref).toBe(makeKeyRef('file', 'ark'))
      expect(await getSecret(cfg.providers!.ark.key_ref!)).toBe('sk-ark')
      assertNoDangling(cfg)
      expect(cfg.active_profile).toBe('old-route')
    } finally {
      h.restore()
    }
  })
})

describe('REVIEW-26 既定语义钉行为（远端删除正激活 profile，不改行为）', () => {
  it('引擎拉取远端删除文档后：active_profile 悬空保留、默认路由 503 可操作回落、pickTarget 顺延首候选、重选即恢复', async () => {
    const h = fakeHome()
    try {
      await seedMachineMain()
      const dir = path.join(h.home, 'sync-target')
      await setupSyncTarget({ kind: 'localdir', dir }, 'pw-review26', { backend: 'file' })
      const st1 = await readSyncState()
      expect(st1?.lastAppliedRev).toBe(1)

      // 远端机器把 main profile 与 ark 服务整包删掉，只剩 ark2/other（用同目标密钥密封 rev2）
      const keys = keysFromState(st1!)
      const remoteDoc = (await collectSyncdoc()).doc
      remoteDoc.data.providers = { ark2: { base_url: 'https://ark2.example.com', protocol: 'openai', auth_style: 'bearer', key: 'sk-ark2' } }
      remoteDoc.data.profiles = { other: { provider: 'ark2' } }
      remoteDoc.data.userPresets = []
      remoteDoc.data.scheduleRules = []
      remoteDoc.ts = new Date().toISOString()
      const target = createLocaldirTarget(dir)
      await target.writeBlob(2, 'mdksync_remote', JSON.stringify(sealWithKeys(remoteDoc, keys), null, 2) + '\n')
      await target.writeManifest({ rev: 2, ts: remoteDoc.ts, byDevid: 'mdksync_remote', blobRef: blobRefOf(2, 'mdksync_remote') }, 1)

      expect(await syncTickOnce()).toBe('pulled')

      // —— 悬空态（既定语义：机器态保护，不自动重指）——
      const cfg = await loadConfig()
      expect(cfg.active_profile).toBe('main')
      expect(cfg.profiles?.main).toBeUndefined()
      expect(Object.keys(cfg.profiles ?? {})).toEqual(['other'])
      expect(Object.keys(cfg.providers ?? {})).toEqual(['ark2'])
      expect((await readSyncState())?.lastAppliedRev).toBe(2)

      // —— 转发侧安全回落（无路由）：默认路由解析 503 + 可操作提示，不崩 ——
      const rt = buildRuntime(cfg, 'mdkadm_t07')
      const resolved = resolveByProfile(rt, undefined, 'admin-test')
      expect(resolved.ok).toBe(false)
      if (!resolved.ok) {
        expect(resolved.status).toBe(503)
        expect(resolved.message).toContain('main')
        expect(resolved.hint).toBeTruthy()
      }
      // 展示层：无路由可展示，不崩
      expect(displayRouteProvider(rt)).toBeUndefined()

      // —— 转发侧安全回落（首候选）：pickTarget 对未知目标（此处：定时窗口指向已删服务）
      //    不崩、不进候选链，顺延到首个可用候选 ——
      const cfgWin = await loadConfig()
      cfgWin.gateway = {
        ...cfgWin.gateway,
        auto_failover: true,
        schedule: { enabled: true, windows: [{ start: '00:00', end: '23:59', target: 'ghost-svc' }] },
      }
      const rtWin = buildRuntime(cfgWin, 'mdkadm_t07')
      const base = { harness: 'admin-test', profileName: 'other', profile: { provider: 'ark2' }, provider: cfgWin.providers!['ark2']! }
      const picked = pickTarget(rtWin, base, undefined)
      expect(picked.ok).toBe(true)
      if (picked.ok) {
        expect(picked.ordered.map((c) => c.providerId)).toEqual(['ark2'])
        expect(picked.primary.source).toBe('default')
      }

      // —— 恢复闭环：用户重选一次即恢复 ——
      await mutateConfig((c) => {
        c.active_profile = 'other'
      })
      const resolved2 = resolveByProfile(buildRuntime(await loadConfig(), 'mdkadm_t07'), undefined, 'admin-test')
      expect(resolved2.ok).toBe(true)
      if (resolved2.ok) expect(resolved2.target.profile.provider).toBe('ark2')
    } finally {
      h.restore()
    }
  }, 60_000)
})
