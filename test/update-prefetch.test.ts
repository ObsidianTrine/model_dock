import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fakeHome } from './helpers.js'
import { selectAssetName, type ReleaseManifest } from '../src/update/check.js'
import { detectInstallShape } from '../src/update/install.js'
import {
  getStagedStatus,
  maybeStartPrefetch,
  prefetchInflightForTests,
  resetPrefetchStateForTests,
  setPrefetchExecPathForTests,
  setPrefetchFailAtForTests,
  type PrefetchOpts,
} from '../src/update/prefetch.js'
import { readStagingMeta, saveStagingMeta, stagingFinalFile, stagingMetaPath, stagingPartFile, type StagingMeta } from '../src/update/staging.js'
import { updateLockHeld, updateLockPath } from '../src/update/lock.js'
import { modeldockDir } from '../src/util/paths.js'

// 预取编排（fakeHome 隔离 + 本地 mock API，零真实网络）：守卫链 / 全链路就绪 / 断点续传 / 退避 / 换槽 / 自愈

const VER = '999.0.0'
const TOKEN = 'ghp_test-token'
const REPO = 'owner/repo'
const EXEC = '/usr/local/bin/modeldock'
const BODY = crypto.randomBytes(1024)
const ETAG = '"etag-pf"'

function sha256(b: Buffer): string {
  return crypto.createHash('sha256').update(b).digest('hex')
}

const SHAPE = detectInstallShape(EXEC, process.platform, process.env.LOCALAPPDATA, false)
const ASSET = selectAssetName(SHAPE, process.platform, process.arch, VER)!
const SUMS = Buffer.from(`${sha256(BODY)}  ${ASSET}\n`)

interface PfServer {
  apiBase: string
  assetHits: number
  assetRequests: { range: string | null; ifRange: string | null }[]
  /** 前 n 次资产请求半途断流（模拟对象存储间歇断；断流响应头声明全量 content-length） */
  setFailFirstN(n: number): void
  /** 动态开合 SUMS 伺服（发布窗口语义：SUMS 后补齐全） */
  setSumsAvailable(b: boolean): void
  close(): Promise<void>
}

async function startPfServer(opts: { withSums?: boolean } = {}): Promise<PfServer> {
  let withSums = opts.withSums !== false
  let failFirstN = 0
  const state: PfServer = {
    apiBase: '',
    assetHits: 0,
    assetRequests: [],
    setFailFirstN(n: number) {
      failFirstN = n
    },
    setSumsAvailable(b: boolean) {
      withSums = b
    },
    close: () => new Promise((r) => server.close(() => r())),
  }
  const server = http.createServer((req, res) => {
    if (req.url === `/repos/${REPO}/releases/latest`) {
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          tag_name: `v${VER}`,
          body: 'notes',
          html_url: `https://github.com/${REPO}/releases/tag/v${VER}`,
          assets: [
            { name: ASSET, id: 1, size: BODY.length },
            ...(withSums ? [{ name: 'SHA256SUMS', id: 2, size: SUMS.length }] : []),
          ],
        })
      )
      return
    }
    const m = req.url?.match(/^\/repos\/[^/]+\/[^/]+\/releases\/assets\/(\d+)$/)
    if (m) {
      if (m[1] === '2') {
        if (!withSums) {
          res.writeHead(404).end()
          return
        }
        res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(SUMS)
        return
      }
      if (m[1] === '1') {
        state.assetHits++
        state.assetRequests.push({ range: req.headers.range ?? null, ifRange: (req.headers['if-range'] as string | undefined) ?? null })
        if (state.assetHits <= failFirstN) {
          // 断流：头声明全量，只发一半就干净收尾（content-length 不符 → 客户端报 premature close）
          res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': BODY.length, etag: ETAG })
          res.write(BODY.subarray(0, Math.ceil(BODY.length / 2)))
          res.end()
          return
        }
        const range = req.headers.range?.match(/^bytes=(\d+)-$/)
        if (range && Number(range[1]) < BODY.length) {
          const start = Number(range[1])
          res.writeHead(206, { 'content-type': 'application/octet-stream', 'content-length': BODY.length - start, etag: ETAG })
          res.end(BODY.subarray(start))
          return
        }
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': BODY.length, etag: ETAG }).end(BODY)
        return
      }
    }
    res.writeHead(404).end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no port')
  state.apiBase = `http://127.0.0.1:${addr.port}`
  return state
}

function manifestOf(apiBase: string, over: Partial<ReleaseManifest> = {}): ReleaseManifest {
  return {
    version: VER,
    tagName: `v${VER}`,
    notes: 'notes',
    htmlUrl: `https://github.com/${REPO}/releases/tag/v${VER}`,
    assets: [
      { name: ASSET, id: 1, size: BODY.length },
      { name: 'SHA256SUMS', id: 2, size: SUMS.length },
    ],
    ...over,
  }
}

function pfOpts(apiBase: string, over: Partial<PrefetchOpts> = {}): PrefetchOpts {
  return { repo: REPO, token: TOKEN, apiBase, mirrors: [], manifest: manifestOf(apiBase), execPath: EXEC, retryDelayMs: 10, ...over }
}

/** 等在飞预取收敛（maybeStartPrefetch 是 fire-and-forget；inflight 在同步前缀占位，必可见） */
async function waitPrefetch(): Promise<void> {
  for (let i = 0; i < 400 && !prefetchInflightForTests(); i++) await new Promise((r) => setTimeout(r, 5))
  const p = prefetchInflightForTests()
  if (p) await p
}

/** 直写账本（绕过 saveStagingMeta 的 updatedAt 恒刷）——退避过期用例需要历史时间戳 */
async function writeRawMeta(m: StagingMeta): Promise<void> {
  await fsp.writeFile(stagingMetaPath(), JSON.stringify(m), 'utf8')
}

describe('预取编排', () => {
  let h: ReturnType<typeof fakeHome>
  let api: PfServer
  beforeEach(async () => {
    h = fakeHome()
    api = await startPfServer()
  })
  afterEach(async () => {
    await api.close()
    resetPrefetchStateForTests()
    delete process.env.MODELRDOCK_DISABLE_UPDATE_CHECK
    h.restore()
  })

  it('全链路：下载→.part→成品 rename→SUMS 现拉校验→ready；重复触发零新请求', async () => {
    maybeStartPrefetch(pfOpts(api.apiBase))
    await waitPrefetch()
    const meta = await readStagingMeta()
    expect(meta).toMatchObject({ version: VER, ready: true, sumsVerified: true, received: BODY.length, error: null, consumed: false })
    expect(fs.readFileSync(stagingFinalFile(VER, ASSET))).toEqual(BODY)
    expect(fs.existsSync(stagingPartFile(VER, ASSET))).toBe(false)
    const st = await getStagedStatus()
    expect(st).toMatchObject({ version: VER, ready: true, received: BODY.length, total: BODY.length, error: null })
    // 已就绪：再次触发直接跳过（零新资产请求）
    const hits = api.assetHits
    maybeStartPrefetch(pfOpts(api.apiBase))
    await waitPrefetch()
    expect(api.assetHits).toBe(hits)
  })

  it('断点续传（跨调用模拟重启）：半途失败留半成品与 error 记账；退避过期后续传完成', async () => {
    api.setFailFirstN(3)
    maybeStartPrefetch(pfOpts(api.apiBase))
    await waitPrefetch()
    const failed = await readStagingMeta()
    expect(failed?.error).toBeTruthy()
    expect(failed?.ready).toBe(false)
    expect(failed?.etag).toBe(ETAG) // 记账供下次 If-Range
    // 模拟重启（模块态清空）+ 退避窗跨过（meta.updatedAt 回拨 31 分钟；直写绕过恒刷）
    resetPrefetchStateForTests()
    const stale = (await readStagingMeta())!
    stale.updatedAt = Date.now() - 31 * 60_000
    await writeRawMeta(stale)
    maybeStartPrefetch(pfOpts(api.apiBase))
    await waitPrefetch()
    const done = await readStagingMeta()
    expect(done).toMatchObject({ ready: true, received: BODY.length, error: null })
    expect(fs.readFileSync(stagingFinalFile(VER, ASSET))).toEqual(BODY)
    // 续传确实发过 Range（failFirstN 之后的请求）
    expect(api.assetRequests.slice(3).some((r) => r.range !== null)).toBe(true)
  })

  it('失败退避：30min 内不重试（模块态与 meta 记账双来源）；过期后重试不重下成品（SUMS 补齐即 ready）', async () => {
    const noSums = await startPfServer({ withSums: false })
    try {
      maybeStartPrefetch(pfOpts(noSums.apiBase))
      await waitPrefetch()
      expect((await readStagingMeta())?.error).toBeTruthy()
      const hits = noSums.assetHits
      // 模块态退避命中：不重试
      setPrefetchFailAtForTests(Date.now(), VER)
      maybeStartPrefetch(pfOpts(noSums.apiBase))
      await waitPrefetch()
      expect(noSums.assetHits).toBe(hits)
      // 模块态清空（重启）后 meta.error+updatedAt 新鲜 → 仍退避
      resetPrefetchStateForTests()
      maybeStartPrefetch(pfOpts(noSums.apiBase))
      await waitPrefetch()
      expect(noSums.assetHits).toBe(hits)
      // 退避过期（updatedAt 回拨，直写绕过恒刷）+ 发布 SUMS 补齐 → 重试：成品已在（资产端点零新请求），
      // 只补 SUMS 校验即 ready
      noSums.setSumsAvailable(true)
      const stale = (await readStagingMeta())!
      stale.updatedAt = Date.now() - 31 * 60_000
      await writeRawMeta(stale)
      maybeStartPrefetch(pfOpts(noSums.apiBase))
      await waitPrefetch()
      expect(noSums.assetHits).toBe(hits)
      expect(await readStagingMeta()).toMatchObject({ ready: true, sumsVerified: true, error: null })
    } finally {
      await noSums.close()
    }
  })

  it('守卫链：更新锁被持有 / DISABLE 开关 / 测试上下文无 mock 数据源 → 全部静默跳过', async () => {
    // 锁被存活进程持有（自己）
    fs.mkdirSync(modeldockDir(), { recursive: true })
    fs.writeFileSync(updateLockPath(), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }))
    expect(updateLockHeld()).toBe(true)
    maybeStartPrefetch(pfOpts(api.apiBase))
    await waitPrefetch()
    expect(await readStagingMeta()).toBeNull()
    expect(api.assetHits).toBe(0)
    fs.rmSync(updateLockPath(), { force: true })
    // DISABLE 开关
    process.env.MODELRDOCK_DISABLE_UPDATE_CHECK = '1'
    maybeStartPrefetch(pfOpts(api.apiBase))
    await waitPrefetch()
    expect(await readStagingMeta()).toBeNull()
    delete process.env.MODELRDOCK_DISABLE_UPDATE_CHECK
    // 测试上下文（vitest 恒真）+ 数据源非本地 mock → 禁真网
    maybeStartPrefetch({ ...pfOpts(''), apiBase: undefined })
    await waitPrefetch()
    expect(await readStagingMeta()).toBeNull()
    expect(api.assetHits).toBe(0)
  })

  it('版本换槽：旧版本槽位（含半成品）在预取新版本时清掉', async () => {
    await saveStagingMeta({
      version: '998.0.0',
      tagName: 'v998.0.0',
      assetName: 'old.tar.gz',
      assetId: 9,
      size: 10,
      etag: null,
      url: null,
      received: 5,
      sumsVerified: false,
      ready: false,
      consumed: false,
      error: null,
      startedAt: Date.now(),
      updatedAt: Date.now(),
    })
    maybeStartPrefetch(pfOpts(api.apiBase))
    await waitPrefetch()
    const meta = await readStagingMeta()
    expect(meta?.version).toBe(VER)
    expect(meta?.ready).toBe(true)
    expect(fs.existsSync(stagingMetaPath())).toBe(true)
    // 旧槽目录已清（staging 里只剩新版本）
    expect(fs.existsSync(stagingFinalFile('998.0.0', 'old.tar.gz'))).toBe(false)
  })

  it('ready 槽位成品被外部删除：下一轮预取自愈重下', async () => {
    maybeStartPrefetch(pfOpts(api.apiBase))
    await waitPrefetch()
    expect((await readStagingMeta())?.ready).toBe(true)
    await fsp.rm(stagingFinalFile(VER, ASSET), { force: true })
    const hits = api.assetHits
    maybeStartPrefetch(pfOpts(api.apiBase))
    await waitPrefetch()
    expect(api.assetHits).toBeGreaterThan(hits)
    expect((await readStagingMeta())?.ready).toBe(true)
    expect(fs.readFileSync(stagingFinalFile(VER, ASSET))).toEqual(BODY)
  })
})
