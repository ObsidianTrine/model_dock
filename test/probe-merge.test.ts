import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { fakeHome, REPO_ROOT, TSX_LOADER } from './helpers.js'
import { exportSyncdoc, previewImport, applyImportedDoc } from '../src/sync/exportImport.js'
import { filterMergedDoc, makeVerdictFinder, mergePackages } from '../src/sync/merge.js'
import { applyVerdictEvidence } from '../src/gateway/probe/verdict.js'
import { drainAppendStreams } from '../src/util/fsx.js'
import { buildRuntime } from '../src/gateway/state.js'
import type { GatewayRuntime } from '../src/gateway/state.js'
import { loadConfig, saveConfig } from '../src/config/store.js'
import { setSecret } from '../src/config/secrets.js'
import { backupsDir, configPath, presetsJsonPath, secretsPath } from '../src/util/paths.js'
import { hMergeApply, hMergePreview } from '../src/gateway/mergepack.js'
import type { Syncdoc } from '../src/sync/types.js'
import type { Config } from '../src/config/types.js'
import type { AdminCtx } from '../src/gateway/admin-shared.js'

// 多包合并流（provider-probe-suite 任务 11）：多份 .msync 按 (base_url, key 指纹) 去重合并 →
// 挂本机探针 verdict 与三档建议 → 勾选后 applyImportedDoc 写入。验收红线：
// ① 同 base_url+同 key 跨包合并为 1 条；② verdict 继承探针结论（按 key 指纹全局扫，provider 维度不可用）；
// ③ 预览全程零写盘（config.toml/secrets.json/presets.json hash 前后不变）。
// 全部走 fakeHome 沙箱 + 合成包（测试口令自造），绝不触碰真实 .msync 与生产实例。

const PASS = 'merge-pass-12345'

function fileHash(fp: string): string {
  return createHash('sha256').update(fs.readFileSync(fp)).digest('hex')
}

async function mkSandbox(): Promise<{ home: string; restore: () => void }> {
  const h = fakeHome()
  return { home: h.home, restore: h.restore }
}

interface SeedProvider {
  base_url: string
  key?: string
  key_ref?: string
  models?: Record<string, unknown>
}

/** 铺一台「机器」的配置并导出 .msync：providers/profiles/preset/schedule 齐活，key 落 file 后端 */
async function seedAndExport(msyncPath: string, providers: Record<string, SeedProvider>, profiles: Record<string, { provider: string }>, opts?: { presetId?: string; schedule?: boolean; pass?: string }): Promise<Syncdoc> {
  const cfg: Config = { version: 1, language: 'zh', security: { store: 'file' }, providers: {}, profiles, harness: {} }
  for (const [id, p] of Object.entries(providers)) {
    if (p.key) {
      await setSecret(id, p.key, 'file')
      cfg.providers[id] = { base_url: p.base_url, protocol: 'openai', auth_style: 'bearer', key_ref: `file:${id}`, ...(p.models ? { models: p.models as Config['providers'][string]['models'] } : {}) }
    } else {
      cfg.providers[id] = { base_url: p.base_url, protocol: 'openai', auth_style: 'bearer', key_ref: p.key_ref ?? 'env:NO_SUCH_VAR' }
    }
  }
  if (opts?.schedule) cfg.gateway = { port: 18901, schedule: { enabled: false, windows: [{ start: '09:00', end: '18:00', target: Object.keys(profiles)[0] }] } }
  await saveConfig(cfg)
  if (opts?.presetId) {
    await fsp.mkdir(path.dirname(presetsJsonPath()), { recursive: true })
    await fsp.writeFile(presetsJsonPath(), JSON.stringify([{ id: opts.presetId, label: opts.presetId, vendor: 'V', base_url: 'https://preset.example.com', protocol: 'openai', auth_style: 'bearer' }], null, 2) + '\n')
  }
  const pass = opts?.pass ?? PASS
  await exportSyncdoc(msyncPath, pass)
  return (await previewImport(msyncPath, pass)).doc
}

/** 探针结论种子：写到 verdict store（进程内匹配）并落 probe-*.jsonl（CLI 子进程回放用） */
function seedVerdict(rt: GatewayRuntime, provider: string, key: string, model: string, state: 'healthy' | 'degraded' | 'auth-dead'): void {
  applyVerdictEvidence(rt, {
    provider,
    keyFp: createHash('sha256').update(key).digest('hex').slice(0, 8),
    model,
    source: 'probe:p1',
    kind: 'canary',
    state,
    evidence: { at: Date.now(), status: state === 'auth-dead' ? 401 : 200 },
  })
}

describe('多包合并：去重 + verdict 继承 + 三档建议', () => {
  it('两包含同 base_url+同 key 的 provider 合并为 1 条（id 取首次出现、跨包 profile 重指）', async () => {
    const h = await mkSandbox()
    try {
      const pkgDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'modeldock-merge-pkg-'))
      const aPath = path.join(pkgDir, 'a.msync')
      const bPath = path.join(pkgDir, 'b.msync')
      // 包 A：ark（尾斜杠形态）+ 路由 main
      const docA = await seedAndExport(aPath, { ark: { base_url: 'https://ark.example.com/api/', key: 'sk-ark-plain', models: { 'claude-x': {} } } }, { main: { provider: 'ark' } }, { presetId: 'corp' })
      // 包 B：同一服务换 id（ark-main，无尾斜杠）+ 独立服务 solo + 引用 solo 的路由 pB
      const docB = await seedAndExport(bPath, { arkMain: { base_url: 'https://ark.example.com/api', key: 'sk-ark-plain' }, solo: { base_url: 'https://solo.example.com', key: 'sk-solo' } }, { pB: { provider: 'solo' } })
      expect(docA.data.providers.ark!.key).toBe('sk-ark-plain')

      const store = new Map()
      const rtLike = { probeVerdicts: store } as unknown as GatewayRuntime
      // verdict 记在别的 provider id 下（旧机器的 id）：合并匹配只认 key 指纹，不认 provider
      seedVerdict(rtLike, 'old-machine-ark', 'sk-ark-plain', 'claude-x', 'auth-dead')
      const { preview, doc } = mergePackages([{ name: 'a.msync', doc: docA }, { name: 'b.msync', doc: docB }], makeVerdictFinder(store))

      expect(preview.candidates).toHaveLength(2) // ark 合并成 1 条 + solo
      const ark = preview.candidates.find((c) => c.id === 'ark')!
      expect(ark).toBeDefined()
      expect(ark.sources).toEqual(['a.msync', 'b.msync'])
      expect(ark.duplicateCount).toBe(1)
      expect(ark.key_fp).toBe(createHash('sha256').update('sk-ark-plain').digest('hex').slice(0, 8))
      // verdict 继承：auth-dead → 失效档
      expect(ark.verdict_state).toBe('auth-dead')
      expect(ark.suggestion).toBe('dead')
      // 合并 doc：id 取首次出现（ark），B 包重复条目并入；B 的路由引用重指到 ark（solo 未去重，原 id 保留）
      expect(Object.keys(doc.data.providers).sort()).toEqual(['ark', 'solo'])
      expect(doc.data.profiles.pB!.provider).toBe('solo')
      const solo = preview.candidates.find((c) => c.id === 'solo')!
      expect(solo.suggestion).toBe('keep')
      expect(solo.verdict_state).toBeNull()
    } finally {
      h.restore()
    }
  })

  it('三档建议映射：healthy→保留候选、degraded/quota/unreachable→存疑、auth-dead→失效、无记录→保留候选', async () => {
    const h = await mkSandbox()
    try {
      const pkgDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'modeldock-merge-pkg-'))
      const p = path.join(pkgDir, 't.msync')
      const doc = await seedAndExport(
        p,
        {
          ok: { base_url: 'https://ok.example.com', key: 'sk-ok' },
          sus: { base_url: 'https://sus.example.com', key: 'sk-sus' },
          dead: { base_url: 'https://dead.example.com', key: 'sk-dead' },
          fresh: { base_url: 'https://fresh.example.com', key: 'sk-fresh' },
        },
        {}
      )
      const store = new Map()
      const rtLike = { probeVerdicts: store } as unknown as GatewayRuntime
      seedVerdict(rtLike, 'ok', 'sk-ok', '', 'healthy')
      seedVerdict(rtLike, 'sus', 'sk-sus', '', 'degraded')
      seedVerdict(rtLike, 'dead', 'sk-dead', '', 'auth-dead')
      const { preview } = mergePackages([{ name: 't.msync', doc }], makeVerdictFinder(store))
      const byId = Object.fromEntries(preview.candidates.map((c) => [c.id, c]))
      expect(byId.ok!.suggestion).toBe('keep')
      expect(byId.ok!.verdict_state).toBe('healthy')
      expect(byId.sus!.suggestion).toBe('review')
      expect(byId.dead!.suggestion).toBe('dead')
      expect(byId.fresh!.suggestion).toBe('keep')
      expect(byId.fresh!.verdict_state).toBeNull()
    } finally {
      h.restore()
    }
  })
})

describe('多包合并：预览零写盘 + 过滤应用', () => {
  it('预览调用前后沙箱 config.toml / secrets.json / presets.json 内容 hash 不变', async () => {
    const h = await mkSandbox()
    try {
      const pkgDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'modeldock-merge-pkg-'))
      const aPath = path.join(pkgDir, 'a.msync')
      const bPath = path.join(pkgDir, 'b.msync')
      await seedAndExport(aPath, { ark: { base_url: 'https://ark.example.com/api', key: 'sk-ark-plain' } }, { main: { provider: 'ark' } }, { presetId: 'corp', schedule: true })
      await seedAndExport(bPath, { ark2: { base_url: 'https://ark.example.com/api', key: 'sk-ark-plain' } }, { pB: { provider: 'ark2' } })
      // 本机铺一份真实配置（预览不得动它）
      await seedAndExport(path.join(pkgDir, 'local.msync'), { localOnly: { base_url: 'https://local.example.com', key: 'sk-local' } }, {})
      const before = { cfg: fileHash(configPath()), sec: fileHash(secretsPath()), presets: fileHash(presetsJsonPath()) }

      const docA = (await previewImport(aPath, PASS)).doc
      const docB = (await previewImport(bPath, PASS)).doc
      const store = new Map()
      const { preview, doc } = mergePackages([{ name: 'a.msync', doc: docA }, { name: 'b.msync', doc: docB }], makeVerdictFinder(store))
      const filtered = filterMergedDoc(doc, ['ark'])
      expect(preview.duplicatesMerged).toBe(1)

      const after = { cfg: fileHash(configPath()), sec: fileHash(secretsPath()), presets: fileHash(presetsJsonPath()) }
      expect(after).toEqual(before)
      void filtered
    } finally {
      h.restore()
    }
  })

  it('按勾选过滤应用：只写勾选 provider 及其路由，悬空路由剔除并给计数；userPresets/定时规则默认保留', async () => {
    const h = await mkSandbox()
    try {
      const pkgDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'modeldock-merge-pkg-'))
      const aPath = path.join(pkgDir, 'a.msync')
      const bPath = path.join(pkgDir, 'b.msync')
      await seedAndExport(aPath, { ark: { base_url: 'https://ark.example.com/api', key: 'sk-ark-plain' }, gone: { base_url: 'https://gone.example.com', key: 'sk-gone' } }, { main: { provider: 'ark' }, dangling: { provider: 'gone' } }, { presetId: 'corp', schedule: true })
      await seedAndExport(bPath, { ark2: { base_url: 'https://ark.example.com/api', key: 'sk-ark-plain' } }, {})
      // 本机现有配置将被整包替换（合并流语义：以勾选结果为准）
      await seedAndExport(path.join(pkgDir, 'local.msync'), { localOnly: { base_url: 'https://local.example.com', key: 'sk-local' } }, { localProf: { provider: 'localOnly' } })

      const docA = (await previewImport(aPath, PASS)).doc
      const docB = (await previewImport(bPath, PASS)).doc
      const store = new Map()
      const { doc } = mergePackages([{ name: 'a.msync', doc: docA }, { name: 'b.msync', doc: docB }], makeVerdictFinder(store))
      const filtered = filterMergedDoc(doc, ['ark'])
      expect(filtered.droppedProfiles).toEqual(['dangling'])

      const applied = await applyImportedDoc(filtered.doc, { backend: 'file' })
      expect(applied.providers).toEqual(['ark'])
      expect(applied.profiles).toEqual(['main'])
      const cfg = await loadConfig()
      expect(Object.keys(cfg.providers).sort()).toEqual(['ark'])
      expect(Object.keys(cfg.profiles).sort()).toEqual(['main'])
      // userPresets / scheduleRules 跟随勾选默认保留（不挂具体 provider）
      expect(applied.presetCount).toBe(1)
      expect(applied.scheduleRules).toBe(1)
      // 写入前快照由 applySyncdoc 自带（快照根 = modeldockDir()/backups/config）
      const backups = fs.readdirSync(path.join(backupsDir(), 'config'))
      expect(backups.length).toBeGreaterThan(0)
    } finally {
      h.restore()
    }
  })
})

// ── 控制台合并端点（POST /_modeldock/merge/preview|apply）：两段式 confirmToken 闸 ────────────

/** 请求体已知的假 req：readBody 只挂 data/end/error 监听 */
function fakeReq(body: unknown): http.IncomingMessage {
  const req = new EventEmitter() as unknown as http.IncomingMessage
  const raw = Buffer.from(JSON.stringify(body))
  ;(req as unknown as { headers: Record<string, string> }).headers = { 'content-length': String(raw.length) }
  ;(req as unknown as { readableEnded: boolean }).readableEnded = false
  ;(req as unknown as { destroy: () => void }).destroy = () => {}
  ;(req as unknown as { resume: () => void }).resume = () => {}
  process.nextTick(() => {
    req.emit('data', raw)
    req.emit('end')
  })
  return req
}

/** 记账式假 res：writeHead/end/setHeader/getHeader 按需记录 */
function fakeRes(): http.ServerResponse & { status: number; bodyText: string } {
  const store: Record<string, string> = {}
  const res = {
    statusCode: 0,
    status: 0,
    bodyText: '',
    setHeader(_k: string, _v: string) {
      store[_k.toLowerCase()] = _v
    },
    getHeader(k: string) {
      return store[k.toLowerCase()]
    },
    writeHead(code: number) {
      res.status = code
      res.statusCode = code
      return res
    },
    end(text?: string) {
      res.bodyText = String(text ?? '')
    },
  }
  return res as unknown as http.ServerResponse & { status: number; bodyText: string }
}

async function callEndpoint(fn: (c: AdminCtx) => Promise<void>, rt: GatewayRuntime, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = fakeRes()
  const c: AdminCtx = { rt, req: fakeReq(body), res, audit: () => {}, o: { idle: 0, retries: 0 } }
  await fn(c)
  return { status: res.status, json: res.bodyText ? (JSON.parse(res.bodyText) as Record<string, unknown>) : {} }
}

function b64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64')
}

describe('控制台合并端点：preview/apply 两段式', () => {
  it('preview 零写盘出候选与 confirmToken；token 错拒绝；token 对写入并热加载', async () => {
    const h = await mkSandbox()
    try {
      const pkgDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'modeldock-merge-pkg-'))
      const aPath = path.join(pkgDir, 'a.msync')
      const bPath = path.join(pkgDir, 'b.msync')
      await seedAndExport(aPath, { ark: { base_url: 'https://ark.example.com/api', key: 'sk-ark-plain' } }, { main: { provider: 'ark' } })
      await seedAndExport(bPath, { ark2: { base_url: 'https://ark.example.com/api', key: 'sk-ark-plain' } }, {})
      const aText = fs.readFileSync(aPath, 'utf8')
      const bText = fs.readFileSync(bPath, 'utf8')
      const beforeCfg = fileHash(configPath())
      const rt = buildRuntime(await loadConfig(), 'admin-token-x')
      const packages = [
        { name: 'a.msync', content_b64: b64(aText) },
        { name: 'b.msync', content_b64: b64(bText) },
      ]

      const pv = await callEndpoint(hMergePreview, rt, { packages, passphrase: PASS })
      expect(pv.status).toBe(200)
      const preview = pv.json.preview as { candidates: { id: string; key_fp: string }[] }
      expect(preview.candidates).toHaveLength(1)
      expect(preview.candidates[0]!.id).toBe('ark')
      // key 明文不出端点：整个响应体不含包内 key
      expect(pv.json.confirmToken).toBeTruthy()
      expect(JSON.stringify(pv.json)).not.toContain('sk-ark-plain')
      expect(fileHash(configPath())).toBe(beforeCfg)

      // token 错 → 拒绝且不写
      const bad = await callEndpoint(hMergeApply, rt, { packages, passphrase: PASS, keep: ['ark'], confirmToken: 'forged-token' })
      expect(bad.status).toBe(400)
      expect(fileHash(configPath())).toBe(beforeCfg)
      // 勾选与预览内容不匹配（token 绑定 keep 清单）→ 拒绝
      const stale = await callEndpoint(hMergeApply, rt, { packages, passphrase: PASS, keep: ['nonexistent'], confirmToken: pv.json.confirmToken })
      expect(stale.status).toBe(400)

      const ok = await callEndpoint(hMergeApply, rt, { packages, passphrase: PASS, keep: ['ark'], confirmToken: pv.json.confirmToken })
      expect(ok.status).toBe(200)
      expect(fileHash(configPath())).not.toBe(beforeCfg)
      const cfg = await loadConfig()
      expect(Object.keys(cfg.providers)).toEqual(['ark'])
      expect(rt.reloads).toBeGreaterThan(0)
    } finally {
      h.restore()
    }
  })
})

// ── 控制台合并端点：逐包口令（passphrases 数组，merge-import-integration 收编）──────────────

describe('控制台合并端点：逐包口令 passphrases 数组', () => {
  it('preview 接受 passphrases 数组：两包不同口令各自解包成功（验收①）', async () => {
    const h = await mkSandbox()
    try {
      const pkgDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'modeldock-merge-pkg-'))
      const aPath = path.join(pkgDir, 'a.msync')
      const bPath = path.join(pkgDir, 'b.msync')
      const passA = 'pass-a-11111'
      const passB = 'pass-b-22222'
      await seedAndExport(aPath, { ark: { base_url: 'https://ark.example.com/api', key: 'sk-ark-plain' } }, { main: { provider: 'ark' } }, { pass: passA })
      await seedAndExport(bPath, { solo: { base_url: 'https://solo.example.com', key: 'sk-solo' } }, {}, { pass: passB })
      const beforeCfg = fileHash(configPath())
      const rt = buildRuntime(await loadConfig(), 'admin-token-x')
      const packages = [
        { name: 'a.msync', content_b64: b64(fs.readFileSync(aPath, 'utf8')) },
        { name: 'b.msync', content_b64: b64(fs.readFileSync(bPath, 'utf8')) },
      ]
      const pv = await callEndpoint(hMergePreview, rt, { packages, passphrases: [passA, passB] })
      expect(pv.status).toBe(200)
      const preview = pv.json.preview as { candidates: { id: string }[] }
      expect(preview.candidates.map((c) => c.id).sort()).toEqual(['ark', 'solo'])
      // key 明文不出端点；预览零写盘
      expect(JSON.stringify(pv.json)).not.toContain('sk-ark-plain')
      expect(JSON.stringify(pv.json)).not.toContain('sk-solo')
      expect(fileHash(configPath())).toBe(beforeCfg)
    } finally {
      h.restore()
    }
  })

  it('某包口令错：整体 400 且报错含失败包名，不出半张候选清单（验收②）', async () => {
    const h = await mkSandbox()
    try {
      const pkgDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'modeldock-merge-pkg-'))
      const aPath = path.join(pkgDir, 'a.msync')
      const bPath = path.join(pkgDir, 'b.msync')
      await seedAndExport(aPath, { ark: { base_url: 'https://ark.example.com/api', key: 'sk-ark-plain' } }, { main: { provider: 'ark' } }, { pass: 'pass-a-11111' })
      await seedAndExport(bPath, { solo: { base_url: 'https://solo.example.com', key: 'sk-solo' } }, {}, { pass: 'pass-b-22222' })
      const beforeCfg = fileHash(configPath())
      const rt = buildRuntime(await loadConfig(), 'admin-token-x')
      const packages = [
        { name: 'a.msync', content_b64: b64(fs.readFileSync(aPath, 'utf8')) },
        { name: 'b.msync', content_b64: b64(fs.readFileSync(bPath, 'utf8')) },
      ]
      const pv = await callEndpoint(hMergePreview, rt, { packages, passphrases: ['pass-a-11111', 'wrong-pass'] })
      expect(pv.status).toBe(400)
      const msg = String((pv.json.error as { message?: string } | undefined)?.message ?? '')
      expect(msg).toContain('b.msync')
      // 整体拒绝：a.msync 解包成功也不出半张清单（无 preview / confirmToken）
      expect(msg).not.toContain('a.msync')
      expect(pv.json.preview).toBeUndefined()
      expect(pv.json.confirmToken).toBeUndefined()
      expect(fileHash(configPath())).toBe(beforeCfg)
      // apply 同样整体拒绝
      const ap = await callEndpoint(hMergeApply, rt, { packages, passphrases: ['pass-a-11111', 'wrong-pass'], keep: ['ark'], confirmToken: 'x' })
      expect(ap.status).toBe(400)
      expect(fileHash(configPath())).toBe(beforeCfg)
    } finally {
      h.restore()
    }
  })

  it('单值 passphrase 向后兼容：全部同口令照常出清单（验收③）', async () => {
    const h = await mkSandbox()
    try {
      const pkgDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'modeldock-merge-pkg-'))
      const aPath = path.join(pkgDir, 'a.msync')
      const bPath = path.join(pkgDir, 'b.msync')
      await seedAndExport(aPath, { ark: { base_url: 'https://ark.example.com/api', key: 'sk-ark-plain' } }, { main: { provider: 'ark' } })
      await seedAndExport(bPath, { ark2: { base_url: 'https://ark.example.com/api', key: 'sk-ark-plain' } }, {})
      const rt = buildRuntime(await loadConfig(), 'admin-token-x')
      const packages = [
        { name: 'a.msync', content_b64: b64(fs.readFileSync(aPath, 'utf8')) },
        { name: 'b.msync', content_b64: b64(fs.readFileSync(bPath, 'utf8')) },
      ]
      const pv = await callEndpoint(hMergePreview, rt, { packages, passphrase: PASS })
      expect(pv.status).toBe(200)
      const preview = pv.json.preview as { candidates: { id: string }[] }
      expect(preview.candidates).toHaveLength(1)
      expect(preview.candidates[0]!.id).toBe('ark')
      // passphrases 数组与单值 passphrase 等价（全部同口令时）
      const pv2 = await callEndpoint(hMergePreview, rt, { packages, passphrases: [PASS, PASS] })
      expect(pv2.json.confirmToken).toBe(pv.json.confirmToken)
    } finally {
      h.restore()
    }
  })

  it('confirmToken 换口令组合后失效：错位/换包重放均 400，正确组合才放行（验收④）', async () => {
    const h = await mkSandbox()
    try {
      const pkgDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'modeldock-merge-pkg-'))
      const aPath = path.join(pkgDir, 'a.msync')
      const bPath = path.join(pkgDir, 'b.msync')
      const passA = 'pass-a-11111'
      const passB = 'pass-b-22222'
      await seedAndExport(aPath, { ark: { base_url: 'https://ark.example.com/api', key: 'sk-ark-plain' } }, { main: { provider: 'ark' } }, { pass: passA })
      await seedAndExport(bPath, { solo: { base_url: 'https://solo.example.com', key: 'sk-solo' } }, {}, { pass: passB })
      const beforeCfg = fileHash(configPath())
      const rt = buildRuntime(await loadConfig(), 'admin-token-x')
      const packages = [
        { name: 'a.msync', content_b64: b64(fs.readFileSync(aPath, 'utf8')) },
        { name: 'b.msync', content_b64: b64(fs.readFileSync(bPath, 'utf8')) },
      ]
      const pv = await callEndpoint(hMergePreview, rt, { packages, passphrases: [passA, passB] })
      expect(pv.status).toBe(200)
      const token = String(pv.json.confirmToken)
      // 口令组合换序 → 错口令解包失败 400（摘要不绑口令——CodeQL 污点面，口令有效性由解包层强制；断言结果同为 400 且零写盘）
      const swapped = await callEndpoint(hMergeApply, rt, { packages, passphrases: [passB, passA], keep: ['ark', 'solo'], confirmToken: token })
      expect(swapped.status).toBe(400)
      expect(fileHash(configPath())).toBe(beforeCfg)
      // 别的预览发的 token 不能重放到这份包上
      const cPath = path.join(pkgDir, 'c.msync')
      const dPath = path.join(pkgDir, 'd.msync')
      await seedAndExport(cPath, { c1: { base_url: 'https://c1.example.com', key: 'sk-c1' } }, {}, { pass: 'pass-c-33333' })
      await seedAndExport(dPath, { d1: { base_url: 'https://d1.example.com', key: 'sk-d1' } }, {}, { pass: 'pass-c-33333' })
      const packagesCD = [
        { name: 'c.msync', content_b64: b64(fs.readFileSync(cPath, 'utf8')) },
        { name: 'd.msync', content_b64: b64(fs.readFileSync(dPath, 'utf8')) },
      ]
      const beforeCfg2 = fileHash(configPath()) // c/d 种子写盘后取新基线
      const pvCD = await callEndpoint(hMergePreview, rt, { packages: packagesCD, passphrase: 'pass-c-33333' })
      expect(pvCD.status).toBe(200)
      expect(pvCD.json.confirmToken).not.toBe(token)
      const replay = await callEndpoint(hMergeApply, rt, { packages, passphrases: [passA, passB], keep: ['ark', 'solo'], confirmToken: pvCD.json.confirmToken })
      expect(replay.status).toBe(400)
      expect(fileHash(configPath())).toBe(beforeCfg2)
      // 正确口令组合 + 本预览的 token → 放行
      const ok = await callEndpoint(hMergeApply, rt, { packages, passphrases: [passA, passB], keep: ['ark', 'solo'], confirmToken: token })
      expect(ok.status).toBe(200)
      expect(fileHash(configPath())).not.toBe(beforeCfg)
      const cfg = await loadConfig()
      expect(Object.keys(cfg.providers).sort()).toEqual(['ark', 'solo'])
    } finally {
      h.restore()
    }
  })
})

// ── UI 收编冒烟：独立入口移除 + 多选分流（构建产物 grep 断言）──────────────────────────────

describe('控制台合并入口收编（构建产物冒烟）', () => {
  it('独立合并按钮/弹层已移除；impFile2 支持多选；审阅清单走宽弹层（svcmodal）', () => {
    const min = fs.readFileSync(path.join(REPO_ROOT, 'src', 'gateway', 'ui-minified.ts'), 'utf8')
    expect(min).not.toContain('mergePkgBtn')
    expect(min).not.toContain('mergeOverlay')
    expect(min).toContain('impFile2" multiple')
    // 审阅弹层在场且走 svcmodal 宽变体（esbuild 不改写属性名与字符串字面量，产物可 grep；
    // mergeReviewOverlay 不含子串 mergeOverlay，旧断言语义不回退）
    expect(min).toContain('id:"mergeReviewOverlay"')
    expect(min).toMatch(/id:"mergeReviewOverlay"[\s\S]{0,200}modalClass:"svcmodal"/)
    // tab 内嵌预览块已整体移除（呈现层替换为宽弹层）
    expect(min).not.toContain('impMergePreview')
    expect(min).toContain('impPwRows')
    // /merge/preview|apply 调用仍随包携带逐包口令数组
    expect(min).toContain('passphrases:')
  })

  it('占位符泄漏修复：摘要行 t() 带 params 第三参（传参形态 grep）', () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'src', 'gateway', 'ui', 'merge.ts'), 'utf8')
    const line = src.split('\n').find((l) => l.includes('合并 {n} 个包'))
    expect(line).toBeTruthy()
    expect(line).toMatch(/,\s*\{\s*n:/)
  })

  // merge-review-two-line（船东批准原型 /tmp/merge-proto/merge-flow.html 落地）：地址格两行化、
  // 同源标记降噪（仅 >1）、表头全选联动——源级形态断言 + 产物在场断言
  it('审阅表两行化：地址 rtl 左截断 + scheme 剥离 + 表头全选联动 + dup>1 条件形态', () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'src', 'gateway', 'ui', 'merge.ts'), 'utf8')
    const styles = fs.readFileSync(path.join(REPO_ROOT, 'src', 'gateway', 'ui', 'styles.ts'), 'utf8')
    const min = fs.readFileSync(path.join(REPO_ROOT, 'src', 'gateway', 'ui-minified.ts'), 'utf8')
    // ① 地址首行 rtl 左截断（省略号在行首、尾部 host/path 保留）：CSS 唯一事实源是 styles.ts
    // （ui-minified 只含 JS bundle，UI_CSS 由 ui.ts 直拼 <style>，不经过 gen-ui-min）
    expect(styles).toContain('direction:rtl')
    // ② scheme 剥离 replace 形态（模板字面量源里 \/ 双写为 \\；产物经 esbuild/模板转义回单杠）
    const addrLine = src.split('\n').find((l) => l.includes('base_url.replace'))
    expect(addrLine).toBeTruthy()
    expect(addrLine).toContain(String.raw`replace(/^https?:\\/\\//`)
    expect(min).toContain(String.raw`base_url.replace(/^https?:\\/\\//`)
    // ③ 表头全选联动：th 有 mgSelAll 复选框，change 置位全行，行变化经委托回写表头态
    expect(src).toContain('id="mgSelAll"')
    expect(src).toMatch(/mgSelAllBox\.addEventListener\('change'/)
    expect(src).toContain('mgSyncSelAll')
    // ④ 同源标记降噪：仅 duplicateCount > 1 才显「同源 ×n」，旧 dup=1 文案路径整条移除
    expect(src).toMatch(/duplicateCount > 1/)
    expect(src).not.toMatch(/duplicateCount > 0/)
    expect(src).not.toContain('合并 {n} 条重复')
    // 产物在场：全选框与两行形态类名随 esbuild 进 bundle（属性名/字面量不改写）
    expect(min).toContain('mgSelAll')
    expect(min).toContain('mgsub')
  })

  // merge-import-ux-polish（船东批准原型 /tmp/merge-proto/merge-flow.html Stage1 形态落地）：
  // 多选引导文案 + 空态提示块 + 逐包口令 .prow 紧凑行——源级形态断言 + 产物在场断言
  it('多包导入引导层：按钮多选文案 + 空态提示块切换挂钩 + 口令行 .prow 紧凑形态', () => {
    const modals = fs.readFileSync(path.join(REPO_ROOT, 'src', 'gateway', 'ui', 'modals.ts'), 'utf8')
    const configpack = fs.readFileSync(path.join(REPO_ROOT, 'src', 'gateway', 'ui', 'configpack.ts'), 'utf8')
    const merge = fs.readFileSync(path.join(REPO_ROOT, 'src', 'gateway', 'ui', 'merge.ts'), 'utf8')
    const styles = fs.readFileSync(path.join(REPO_ROOT, 'src', 'gateway', 'ui', 'styles.ts'), 'utf8')
    const min = fs.readFileSync(path.join(REPO_ROOT, 'src', 'gateway', 'ui-minified.ts'), 'utf8')
    // ① 按钮多选引导文案（data-i18n 双语，初始文案 = 中文半边）+ 产物在场
    //    （esbuild 缺省 charset=ascii 把非 ASCII 逐字转义为 \uXXXX 大写十六进制，产物内嵌 TS 模板字面量再转义一层为 \\uXXXX）
    const minEsc = (s: string) =>
      Array.from(s)
        .map((c) => (c.charCodeAt(0) > 127 ? '\\\\u' + c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0') : c))
        .join('')
    expect(modals).toContain('data-i18n="选择文件（可多选）||Choose files (multi-select)"')
    expect(min).toContain(minEsc('选择文件（可多选）'))
    // ② 空态提示块：panelFile 内在场（虚线 muted 形态进 styles.ts），显隐由渲染函数驱动
    //    ——两个文件来源（multi=mgFiles / 单包=input.files）任一非空即隐藏
    expect(modals).toMatch(/id="impEmptyHint" class="empty-hint"/)
    expect(styles).toMatch(/#pkgOverlay \.empty-hint\{[^}]*dashed/)
    expect(configpack).toMatch(/function updateImpEmptyHint\(\)/)
    expect(configpack).toMatch(/hint\.hidden = mgFiles\.length > 0/)
    expect(configpack).toMatch(/f\.files && f\.files\.length > 0/)
    // 挂钩点：showImpFileChip（单包选/清）与 mgExitMultiUi（multi 清场/降级）都驱动显隐
    expect(configpack).toMatch(/updateImpEmptyHint\(\)/)
    expect(merge).toContain('updateImpEmptyHint()')
    // ③ 逐包口令 .prow 紧凑行（原型形态）：包名 label 截断+title 全量、input flex 占余宽；
    //    旧「整宽文件名标题 + 行内整宽样式」形态移除
    expect(merge).toMatch(/row\.className = 'prow'/)
    expect(merge).toMatch(/nm\.title = file\.name/)
    expect(styles).toMatch(/#pkgOverlay \.prow label\{[^}]*text-align:right/)
    expect(styles).toMatch(/#pkgOverlay \.prow label\{[^}]*text-overflow:ellipsis/)
    expect(styles).toMatch(/#pkgOverlay \.prow input\{[^}]*flex:1/)
    expect(merge).not.toContain("input.style.width = '100%'")
    // 产物在场：prow 类与空态提示 id 随 esbuild 进 bundle（字符串字面量不改写；顶层函数名会被改写，不作断言）
    expect(min).toContain('"prow"')
    expect(min).toContain('impEmptyHint')
  })
})

// ── CLI 冒烟：config merge 两份合成包 → 逐服务三档建议清单 + 勾选写入 ────────────────────────

function runCli(args: string[], sandbox: string, stdin?: string): Promise<{ status: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', TSX_LOADER, path.join(REPO_ROOT, 'src', 'cli.ts'), ...args], {
      cwd: REPO_ROOT,
      env: { ...process.env, MODELRDOCK_FAKE_HOME: sandbox, MODELRDOCK_TEST: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c) => (stdout += String(c)))
    child.stderr.on('data', (c) => (stderr += String(c)))
    if (stdin !== undefined) child.stdin.end(stdin)
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('cli subprocess timeout'))
    }, 120_000)
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ status: code ?? -1, stdout, stderr })
    })
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
  })
}

describe('CLI 冒烟：config merge 输出逐服务三档建议清单', () => {
  it('merge 两份合成包（--stdin-pass --yes）输出三档清单并只保留「保留候选」档', async () => {
    const h = await mkSandbox()
    try {
      const pkgDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'modeldock-merge-pkg-'))
      const aPath = path.join(pkgDir, 'a.msync')
      const bPath = path.join(pkgDir, 'b.msync')
      // 包 A：keep + dead 两档；包 B：同 base_url+同 key 的 keep 重复 + sus 档
      await seedAndExport(aPath, { keep1: { base_url: 'https://keep.example.com', key: 'sk-keep', models: { 'm-keep': {} } }, dead1: { base_url: 'https://dead.example.com', key: 'sk-dead', models: { 'm-dead': {} } } }, { pKeep: { provider: 'keep1' } })
      await seedAndExport(bPath, { keep2: { base_url: 'https://keep.example.com', key: 'sk-keep' }, sus1: { base_url: 'https://sus.example.com', key: 'sk-sus', models: { 'm-sus': {} } } }, { pSus: { provider: 'sus1' } })

      // 探针结论落 probe-*.jsonl（CLI 子进程无网关运行态，靠回放）：keep1 健康、sus1 降级、dead1 失效
      const rt = buildRuntime(await loadConfig(), 'tok')
      seedVerdict(rt, 'keep1', 'sk-keep', 'm-keep', 'healthy')
      seedVerdict(rt, 'sus1', 'sk-sus', 'm-sus', 'degraded')
      seedVerdict(rt, 'dead1', 'sk-dead', 'm-dead', 'auth-dead')
      await drainAppendStreams()

      const r = await runCli(['config', 'merge', aPath, bPath, '--stdin-pass', '--yes'], h.home, PASS + '\n')
      expect(r.status).toBe(0)
      // 逐服务三档建议清单：保留候选 / 存疑 / 失效 全部出现，且探针行带三档建议
      expect(r.stdout).toContain('保留候选')
      expect(r.stdout).toContain('存疑')
      expect(r.stdout).toContain('失效')
      expect(r.stdout).toContain('探针')
      expect(r.stdout).toContain('✓ 已合并导入')
      // key 明文红线：stdout/stderr 绝不出现包内 key
      expect(r.stdout + r.stderr).not.toContain('sk-keep')
      expect(r.stdout + r.stderr).not.toContain('sk-sus')
      expect(r.stdout + r.stderr).not.toContain('sk-dead')
      // --yes 非交互缺省：只保留「保留候选」档；同址同 key 的 keep2 并入 keep1（合并为 1 条）
      const cfg = await loadConfig()
      expect(Object.keys(cfg.providers).sort()).toEqual(['keep1'])
      expect(Object.keys(cfg.profiles)).toContain('pKeep')
      expect(cfg.profiles.pSus).toBeUndefined()
    } finally {
      h.restore()
    }
  })
})
