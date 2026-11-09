// snapshot-quality：引用快照质量包（2026-11-10，multi-dim 对拍实证 evidence 天花板=快照
// 可得性）——①覆盖 max 8→16 + cfg snapshotMax；②瞬时类重试（超时/网络错误/5xx·429，
// 4xx 不重试）；③文件头分类 type/usable/via（PDF 存在性证据、区域封锁页归因）；
// ④镜像回退 r.jina.ai（默认关、显式 opt-in）；⑤CLI research snapshot 补跑入口；
// loadSnapshots 新文件头兼容 + resolveResearch 校验。
// 判分语义零改动：分类只标注（文件头/日志/verdict reasons），scoreVerdict/scoreCitation
// 分值行为不变。fetchImpl 注入与 module-load 钩子手法同 research-concurrency（零 vi.mock，
// singleFork 下无跨文件 mock 冲突）。

import { describe, expect, it, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  assessBrief,
  loadSnapshots,
  snapshotCitations,
  writeBrief,
} from '../../.agents/scripts/orchestrator/research.mjs'
import { loadWorkflowConfig } from '../../.agents/scripts/workflow-config.mjs'
import { mkRepo, tryOrch } from './helpers.js'

const WORKTREE_ROOT = path.resolve(process.cwd()) // vitest 的 cwd = 仓库根（worktree 内），同 helpers.ts

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'snapshot-quality-'))
}

const TODAY = new Date().toISOString().slice(0, 10)

/** 五段齐全的 brief 正文，引用 N 条（URL 各不相同——extractCitations 去重保序）。 */
function fiveSectionBody(citations: string[]): string {
  return [
    '# 结论',
    '调研结论占位 [1]。',
    '',
    '# 选项对比',
    '- 方案 A：占位。',
    '',
    '# 引用',
    ...citations.map((u) => `- ${TODAY} ${u} — 来源：依据`),
    '',
    '# 建议',
    '占位。',
    '',
    '# 罗盘对齐',
    '占位。',
  ].join('\n')
}

/** ≥400 可见字符的正文（ok 分类达标线 = SNAPSHOT_MIN_VISIBLE）。 */
const LONG_BODY = '正文可见内容，用于骨架判定达标。'.repeat(45)

/** 区域封锁页正文（OpenAI 文档 "App unavailable in region" 类实测形态，可见文本 <400）。 */
const REGION_BODY = 'App unavailable in region. Check your network or try again later.'

/** 骨架页正文（客户端渲染：meta 有点、正文零字）。 */
const SKELETON_BODY =
  '<!DOCTYPE html><html><head><meta charset="utf-8"/><meta name="description" content="app"/><script src="/x.js"></script></head><body class="dark"><div id="root"></div></body></html>'

/** PDF 伪二进制（无换行，2400 字符——截存断言用）。 */
const PDF_BODY = '%PDF-1.4-binary-existence-evidence'.repeat(60)

interface Route {
  status?: number
  body?: string
  contentType?: string
  throwMsg?: string
  throwName?: string
}

/** fetchImpl 注入（按 URL 路由表响应，'*' 为通配缺省），calls 记录每次尝试（重试/镜像断言用）。 */
function makeFetch(routes: Record<string, Route>, calls: string[]): typeof fetch {
  return (async (url: string) => {
    calls.push(String(url))
    const route = routes[String(url)] ?? routes['*'] ?? {}
    if (route.throwMsg) {
      const e = new Error(route.throwMsg)
      if (route.throwName) (e as { name: string }).name = route.throwName
      throw e
    }
    const status = route.status ?? 200
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: {
        get: (k: string) => (String(k).toLowerCase() === 'content-type' ? (route.contentType ?? 'text/html; charset=utf-8') : null),
      },
      text: async () => route.body ?? '',
    }
  }) as unknown as typeof fetch
}

function readSnapshotFile(root: string, id: string, n: number): string {
  return fs.readFileSync(path.join(root, '.agents', 'orchestrator', 'research', id, 'sources', `${n}.txt`), 'utf8')
}

describe('orchestrator snapshot-quality > 覆盖与并发（快照质量包 ①）', () => {
  it('缺省 max=16：12 条引用全部尝试、20 条只试 16（防引用面失控的上限仍在）', async () => {
    const root = tmpRoot()
    try {
      const urls12 = Array.from({ length: 12 }, (_, i) => `https://docs.example.com/p${i + 1}`)
      writeBrief(root, { id: 'cov-12', title: 't', body: fiveSectionBody(urls12) })
      const calls1: string[] = []
      const snap1 = await snapshotCitations(root, 'cov-12', { fetchImpl: makeFetch({ '*': { body: LONG_BODY } }, calls1), retryDelayMs: 1 })
      expect(calls1).toHaveLength(12)
      expect(snap1.ok).toHaveLength(12)
      expect(snap1.snapshots.map((s: any) => s.index)).toEqual([...Array(12).keys()]) // index 回填与完成先后无关
      const urls20 = Array.from({ length: 20 }, (_, i) => `https://docs.example.com/q${i + 1}`)
      writeBrief(root, { id: 'cov-20', title: 't', body: fiveSectionBody(urls20) })
      const calls2: string[] = []
      await snapshotCitations(root, 'cov-20', { fetchImpl: makeFetch({ '*': { body: LONG_BODY } }, calls2), retryDelayMs: 1 })
      expect(calls2).toHaveLength(16)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('cfg snapshotMax=5：resolveResearch 校验通过并生效——只试 5 条（12 条引用的 brief）', async () => {
    const root = tmpRoot()
    fs.mkdirSync(path.join(root, '.agents'), { recursive: true })
    fs.writeFileSync(
      path.join(root, '.agents', 'workflow.json'),
      JSON.stringify({ baseBranch: 'develop', research: { snapshotMax: 5 } }),
    )
    try {
      expect(loadWorkflowConfig(root).research?.snapshotMax).toBe(5)
      const urls = Array.from({ length: 12 }, (_, i) => `https://docs.example.com/r${i + 1}`)
      writeBrief(root, { id: 'cov-cfg', title: 't', body: fiveSectionBody(urls) })
      const calls: string[] = []
      const snap = await snapshotCitations(root, 'cov-cfg', { max: 5, fetchImpl: makeFetch({ '*': { body: LONG_BODY } }, calls), retryDelayMs: 1 })
      expect(calls).toHaveLength(5)
      expect(snap.snapshots).toHaveLength(5)
      expect(snap.ok).toHaveLength(5)
      expect([...calls].sort()).toEqual(urls.slice(0, 5).sort()) // 只试前 5 条（并发池下顺序不定，集合断言）
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('orchestrator snapshot-quality > 瞬时类重试（快照质量包 ②）', () => {
  it('首 5xx 次 2 成：重试后 ok 且快照落盘；重试后仍超时 → failed 且 reason 带尝试次数', async () => {
    const root = tmpRoot()
    try {
      writeBrief(root, {
        id: 'retry-mixed',
        title: 't',
        body: fiveSectionBody(['https://a.example.com/flaky', 'https://b.example.com/dead']),
      })
      const calls: string[] = []
      let flakyHits = 0
      const timeoutErr = () => {
        const e = new Error('The operation was aborted due to timeout')
        ;(e as { name: string }).name = 'TimeoutError'
        return e
      }
      const snap = await snapshotCitations(root, 'retry-mixed', {
        fetchImpl: (async (url: string) => {
          calls.push(url)
          if (String(url).includes('flaky')) {
            flakyHits++
            if (flakyHits === 1) return { ok: false, status: 503, headers: { get: () => null }, text: async () => '' }
            return { ok: true, status: 200, headers: { get: () => 'text/html' }, text: async () => LONG_BODY }
          }
          throw timeoutErr() // 每次都超时（瞬时类）→ 2 次尝试后判死
        }) as unknown as typeof fetch,
        retryDelayMs: 1,
      })
      // flaky：503（瞬时）→ 重试 → ok，落盘
      expect(calls.filter((u) => u.includes('flaky'))).toHaveLength(2)
      expect(snap.ok).toEqual(['https://a.example.com/flaky'])
      expect(readSnapshotFile(root, 'retry-mixed', 1)).toContain(LONG_BODY.slice(0, 20))
      // dead：超时是瞬时类 → 重试 1 次仍死 → failed（reason 带「重试」与尝试次数）
      expect(calls.filter((u) => u.includes('dead'))).toHaveLength(2)
      expect(snap.failed).toHaveLength(1)
      expect(snap.failed[0].reason).toContain('重试 1 次后仍失败')
      expect(snap.failed[0].reason).toContain('TimeoutError')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('404 是永久类：只尝试 1 次不重试、不走镜像回退（资源确不存在换路无意义）', async () => {
    const root = tmpRoot()
    try {
      writeBrief(root, { id: 'perm-404', title: 't', body: fiveSectionBody(['https://a.example.com/gone']) })
      const calls: string[] = []
      const snap = await snapshotCitations(root, 'perm-404', {
        fetchImpl: makeFetch({ 'https://a.example.com/gone': { status: 404 } }, calls),
        mirror: true,
        retryDelayMs: 1,
      })
      expect(calls).toEqual(['https://a.example.com/gone']) // 恰 1 次，无重试无镜像
      expect(snap.ok).toEqual([])
      expect(snap.failed[0].reason).toBe('HTTP 404') // 永久类失败：无「重试」字样
      expect(snap.failed[0].reason).not.toContain('重试')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('orchestrator snapshot-quality > 内容分类（快照质量包 ③）', () => {
  it('Content-Type pdf → type=pdf/usable=pdf，正文截存前 2000 字符（二进制只留存在性证据）', async () => {
    const root = tmpRoot()
    try {
      writeBrief(root, { id: 'cls-pdf', title: 't', body: fiveSectionBody(['https://a.example.com/paper.pdf']) })
      const calls: string[] = []
      const snap = await snapshotCitations(root, 'cls-pdf', {
        fetchImpl: makeFetch({ 'https://a.example.com/paper.pdf': { body: PDF_BODY, contentType: 'application/pdf' } }, calls),
        retryDelayMs: 1,
      })
      expect(snap.ok).toEqual([]) // 分类语义：pdf 不计入 ok（正文非文本，无对账价值）
      expect(snap.snapshots[0]).toMatchObject({ index: 0, url: 'https://a.example.com/paper.pdf', status: 'pdf', via: 'direct' })
      const raw = readSnapshotFile(root, 'cls-pdf', 1)
      expect(raw).toContain('type: pdf')
      expect(raw).toContain('usable: pdf')
      expect(raw).toContain('via: direct')
      const bodyPart = raw.split('\n\n')[1]
      expect(bodyPart).toHaveLength(2000) // PDF_BODY 2400 字符 → 截存前 2000
      expect(bodyPart.startsWith('%PDF-1.4')).toBe(true)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('区域封锁特征（大小写不敏感）→ usable: region_blocked；普通骨架页 → usable: skeleton', async () => {
    const root = tmpRoot()
    try {
      writeBrief(root, {
        id: 'cls-pages',
        title: 't',
        body: fiveSectionBody(['https://openai.example.com/region-lock', 'https://spa.example.com/shell']),
      })
      const calls: string[] = []
      const snap = await snapshotCitations(root, 'cls-pages', {
        fetchImpl: makeFetch({
          'https://openai.example.com/region-lock': { body: REGION_BODY }, // 200 + 区域封锁特征
          'https://spa.example.com/shell': { body: SKELETON_BODY }, // 200 + 零正文骨架
        }, calls),
        retryDelayMs: 1,
      })
      expect(snap.ok).toEqual([]) // 非 ok 分类不计入 ok
      const regionRaw = readSnapshotFile(root, 'cls-pages', 1)
      expect(regionRaw).toContain('type: text')
      expect(regionRaw).toContain('usable: region_blocked')
      expect(snap.snapshots[0]).toMatchObject({ status: 'region_blocked', via: 'direct' })
      const skelRaw = readSnapshotFile(root, 'cls-pages', 2)
      expect(skelRaw).toContain('usable: skeleton')
      expect(snap.snapshots[1]).toMatchObject({ status: 'skeleton', via: 'direct' })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('正文达标页 → usable: ok 且计入 ok（分类不改判分基线）', async () => {
    const root = tmpRoot()
    try {
      writeBrief(root, { id: 'cls-ok', title: 't', body: fiveSectionBody(['https://a.example.com/full']) })
      const calls: string[] = []
      const snap = await snapshotCitations(root, 'cls-ok', {
        fetchImpl: makeFetch({ 'https://a.example.com/full': { body: LONG_BODY } }, calls),
        retryDelayMs: 1,
      })
      expect(snap.ok).toEqual(['https://a.example.com/full'])
      const raw = readSnapshotFile(root, 'cls-ok', 1)
      expect(raw).toContain('usable: ok')
      expect(raw).toContain(LONG_BODY.slice(0, 20))
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('orchestrator snapshot-quality > 镜像回退（快照质量包 ④，默认关）', () => {
  it('mirror 开：直连区域封锁 → r.jina.ai 成功覆盖 via=mirror 且转 ok；mirror 关 → 维持 region_blocked', async () => {
    const root = tmpRoot()
    try {
      writeBrief(root, { id: 'mirror-on', title: 't', body: fiveSectionBody(['https://openai.example.com/locked']) })
      const mirrorUrl = 'https://r.jina.ai/https://openai.example.com/locked'
      const calls: string[] = []
      const snap = await snapshotCitations(root, 'mirror-on', {
        fetchImpl: makeFetch(
          {
            'https://openai.example.com/locked': { body: REGION_BODY },
            [mirrorUrl]: { body: LONG_BODY, contentType: 'text/plain' },
          },
          calls,
        ),
        mirror: true,
        retryDelayMs: 1,
      })
      expect(calls).toContain(mirrorUrl)
      expect(snap.ok).toEqual(['https://openai.example.com/locked']) // 镜像取得转 ok
      expect(snap.snapshots[0]).toMatchObject({ status: 'ok', via: 'mirror' })
      const raw = readSnapshotFile(root, 'mirror-on', 1)
      expect(raw).toContain('via: mirror')
      expect(raw).toContain('usable: ok')
      expect(raw).toContain(LONG_BODY.slice(0, 20)) // 覆盖为镜像文本
      // 对照：mirror 关（缺省）→ 无镜像调用，维持 region_blocked
      writeBrief(root, { id: 'mirror-off', title: 't', body: fiveSectionBody(['https://openai.example.com/locked']) })
      const calls2: string[] = []
      const snap2 = await snapshotCitations(root, 'mirror-off', {
        fetchImpl: makeFetch({ 'https://openai.example.com/locked': { body: REGION_BODY } }, calls2),
        retryDelayMs: 1,
      })
      expect(calls2.some((u) => u.includes('r.jina.ai'))).toBe(false)
      expect(snap2.snapshots[0]).toMatchObject({ status: 'region_blocked', via: 'direct' })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('镜像也失败：维持原分类不炸；直连 5xx（非 404）也可由镜像救回；404 永不镜像', async () => {
    const root = tmpRoot()
    try {
      // ① 直连区域封锁 + 镜像也失败 → 维持 region_blocked（直连正文保留）
      writeBrief(root, { id: 'mirror-fail', title: 't', body: fiveSectionBody(['https://x.example.com/both-down']) })
      const calls1: string[] = []
      const snap1 = await snapshotCitations(root, 'mirror-fail', {
        fetchImpl: makeFetch(
          {
            'https://x.example.com/both-down': { body: REGION_BODY },
            'https://r.jina.ai/https://x.example.com/both-down': { throwMsg: 'fetch failed' },
          },
          calls1,
        ),
        mirror: true,
        retryDelayMs: 1,
      })
      expect(calls1.filter((u) => u.includes('r.jina.ai'))).toHaveLength(1) // 镜像仅 1 次不重试
      expect(snap1.snapshots[0]).toMatchObject({ status: 'region_blocked', via: 'direct' })
      expect(snap1.snapshots[0].reason).toContain('镜像回退失败')
      expect(readSnapshotFile(root, 'mirror-fail', 1)).toContain('App unavailable in region')
      // ② 直连 503（重试 1 次仍死）→ 镜像救回 via=mirror
      writeBrief(root, { id: 'mirror-rescue', title: 't', body: fiveSectionBody(['https://y.example.com/5xx']) })
      let hits = 0
      const calls2: string[] = []
      const snap2 = await snapshotCitations(root, 'mirror-rescue', {
        fetchImpl: (async (url: string) => {
          calls2.push(String(url))
          if (!String(url).includes('r.jina.ai')) {
            hits++
            return { ok: false, status: 503, headers: { get: () => null }, text: async () => '' }
          }
          return { ok: true, status: 200, headers: { get: () => 'text/plain' }, text: async () => LONG_BODY }
        }) as unknown as typeof fetch,
        mirror: true,
        retryDelayMs: 1,
      })
      expect(calls2.filter((u) => u === 'https://y.example.com/5xx')).toHaveLength(2) // 直连重试 1 次
      expect(snap2.ok).toEqual(['https://y.example.com/5xx'])
      expect(snap2.snapshots[0]).toMatchObject({ status: 'ok', via: 'mirror' })
      expect(snap2.snapshots[0].reason).toContain('直连失败')
      // ③ 404 永不镜像（永久类失败，换路无意义）
      writeBrief(root, { id: 'mirror-404', title: 't', body: fiveSectionBody(['https://z.example.com/gone']) })
      const calls3: string[] = []
      await snapshotCitations(root, 'mirror-404', {
        fetchImpl: makeFetch({ 'https://z.example.com/gone': { status: 404 } }, calls3),
        mirror: true,
        retryDelayMs: 1,
      })
      expect(calls3.some((u) => u.includes('r.jina.ai'))).toBe(false)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('orchestrator snapshot-quality > loadSnapshots 兼容（新文件头解析）', () => {
  it('新文件头（url/fetched_at/type/usable/via）解析出 url/正文/kind/via；正文可见性口径不变', async () => {
    const root = tmpRoot()
    try {
      writeBrief(root, {
        id: 'compat',
        title: 't',
        body: fiveSectionBody(['https://a.example.com/full', 'https://b.example.com/paper.pdf']),
      })
      const calls: string[] = []
      const snapDbg = await snapshotCitations(root, 'compat', {
        fetchImpl: makeFetch(
          {
            'https://a.example.com/full': { body: LONG_BODY },
            'https://b.example.com/paper.pdf': { body: PDF_BODY, contentType: 'application/pdf' },
          },
          calls,
        ),
        retryDelayMs: 1,
      })
      expect(snapDbg.failed).toEqual([])
      expect(calls).toHaveLength(2)
      const snaps = loadSnapshots(root, 'compat')
      expect(snaps).toHaveLength(2)
      expect(snaps[0].url).toBe('https://a.example.com/full')
      expect(snaps[0].text).toContain(LONG_BODY.slice(0, 20))
      expect(snaps[0].kind).toBe('ok')
      expect(snaps[0].via).toBe('direct')
      expect(snaps[0].usable).toBe(true)
      expect(snaps[1].kind).toBe('pdf')
      expect(snaps[1].via).toBe('direct')
      // assessBrief：区域封锁/PDF 在 reasons 归因（只标注不改判分——evidence 照常从全部快照回查）
      writeBrief(root, {
        id: 'compat-reasons',
        title: 't',
        body: [
          '# 结论',
          '型号 X9-PRO 周下载 56.5T [1]。',
          '',
          '# 选项对比',
          '- A：占位。',
          '',
          '# 引用',
          `- ${TODAY} https://c.example.com/region — 来源：依据`,
          `- ${TODAY} https://c.example.com/doc.pdf — 来源：依据`,
          '',
          '# 建议',
          '占位。',
          '',
          '# 罗盘对齐',
          '占位。',
        ].join('\n'),
      })
      const calls2: string[] = []
      await snapshotCitations(root, 'compat-reasons', {
        fetchImpl: makeFetch(
          {
            'https://c.example.com/region': { body: REGION_BODY },
            'https://c.example.com/doc.pdf': { body: PDF_BODY, contentType: 'application/pdf' },
          },
          calls2,
        ),
        retryDelayMs: 1,
      })
      expect(calls2).toHaveLength(2)
      const verdict = assessBrief(root, 'compat-reasons', { model: 'glm-5.3-flash' })
      expect(verdict.reasons.join('\n')).toContain('区域封锁页')
      expect(verdict.reasons.join('\n')).toContain('PDF')
      expect(verdict.reasons.join('\n')).toContain('research snapshot compat-reasons --mirror')
      expect(verdict.scores.evidence).not.toBeNull() // 分类不改变 evidence 口径
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('旧格式文件（仅 url/fetched_at 头）向后兼容：kind/via 为 null，usable 照常计算', async () => {
    const root = tmpRoot()
    try {
      writeBrief(root, { id: 'legacy', title: 't', body: fiveSectionBody(['https://a.example.com/old']) })
      const srcDir = path.join(root, '.agents', 'orchestrator', 'research', 'legacy', 'sources')
      fs.mkdirSync(srcDir, { recursive: true })
      fs.writeFileSync(path.join(srcDir, '1.txt'), `url: https://a.example.com/old\nfetched_at: t\n\n${SKELETON_BODY}`)
      const snaps = loadSnapshots(root, 'legacy')
      expect(snaps).toHaveLength(1)
      expect(snaps[0].url).toBe('https://a.example.com/old')
      expect(snaps[0].kind).toBeNull()
      expect(snaps[0].via).toBeNull()
      expect(snaps[0].usable).toBe(false) // 骨架页口径与历史一致
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// CLI research snapshot（module-load 钩子注入 globalThis.fetch——只在带 --import 的
// 测试子进程生效，零 vi.mock；手法同 research-concurrency 的 POOL_HOOK）
// ---------------------------------------------------------------------------

// 注意两个实测坑（都是 NODE module hooks 线程模型导致）：
// ① load() 函数体跑在 hooks 线程——在里面给 globalThis.fetch 赋值改的是 hooks 线程的
//    global，主线程拿到的仍是真实 fetch（实测踩中）。所以 patch 必须追加进 research.mjs
//    源码（主线程模块求值时执行），手法与 research-concurrency 的 POOL_HOOK 同源。
// ② 追加的补丁块必须同步求值（赋值前不得有顶层 await——顶层 await 会把赋值推迟到
//    import 解析之后）；fs 依赖放进 stub 函数内部按需 import（stub 是 async，await 合法）。
const FETCH_HOOK = `
export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  if (!url.endsWith('/orchestrator/research.mjs')) return result;
  result.source = String(result.source) + \`
;{
  globalThis.fetch = async (input) => {
    const __fs = await import('node:fs');
    const __EOL = String.fromCharCode(10);
    const target = String(input);
    const log = process.env.ORCH_SNAP_FETCH_LOG;
    if (log) { try { __fs.appendFileSync(log, target + __EOL); } catch {} }
    const spec = JSON.parse(__fs.readFileSync(process.env.ORCH_SNAP_FETCH_SPEC, 'utf8'));
    const route = spec[target] ?? spec['*'] ?? {};
    if (route.throw) { const e = new Error(route.throw); if (route.name) e.name = route.name; throw e; }
    const status = route.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? (route.contentType ?? 'text/html; charset=utf-8') : null) },
      text: async () => route.body ?? '',
    };
  };
}
\`;
  return { ...result, shortCircuit: true };
}
`

function makeFetchHookRunner(tmpPrefix: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), tmpPrefix))
  const registerFile = path.join(dir, 'register.mjs')
  fs.writeFileSync(registerFile, `import { register } from 'node:module';\nregister('./hook.mjs', import.meta.url);\n`)
  fs.writeFileSync(path.join(dir, 'hook.mjs'), FETCH_HOOK)
  const specFile = path.join(dir, 'fetch-spec.json')
  const logFile = path.join(dir, 'fetch-log.jsonl')
  return {
    run(repo: string, args: string[], spec: Record<string, unknown>): { status: number; stdout: string; stderr: string } {
      fs.writeFileSync(specFile, JSON.stringify(spec))
      fs.rmSync(logFile, { force: true })
      const orch = path.join(WORKTREE_ROOT, '.agents', 'scripts', 'orchestrator.mjs')
      const r = spawnSync(process.execPath, ['--import', pathToFileURL(registerFile).href, orch, ...args], {
        cwd: repo,
        encoding: 'utf8',
        timeout: 180_000,
        env: { ...process.env, ORCH_SNAP_FETCH_SPEC: specFile, ORCH_SNAP_FETCH_LOG: logFile },
      })
      return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
    },
    calls(): string[] {
      return fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean) : []
    },
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  }
}

/** 在沙箱 repo 手写一个 brief 目录（meta.json + brief.md，与 writeBrief 落盘契约同形）。 */
function writeBriefFixture(repo: string, id: string, body: string): void {
  const dir = path.join(repo, '.agents', 'orchestrator', 'research', id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'meta.json'),
    JSON.stringify({ id, title: `brief ${id}`, question: 'q', backend: 'mock', created_at: '2026-11-10T10:00:00+08:00' }, null, 2),
  )
  fs.writeFileSync(path.join(dir, 'brief.md'), `${body.trim()}\n`)
}

describe('orchestrator snapshot-quality > CLI research snapshot（快照质量包 ⑤）', () => {
  it('对既有 brief 补跑：sources/ 刷新为新文件头 + 分类汇总输出；--max 限制尝试条数；--mirror 临时开镜像', () => {
    const repo = mkRepo()
    const hook = makeFetchHookRunner('snapshot-cli-obs-')
    try {
      writeBriefFixture(repo.root, 'cli-snap', fiveSectionBody([
        'https://openai.example.com/locked',
        'https://docs.example.com/full',
        'https://docs.example.com/extra',
      ]))
      const r = hook.run(repo.root, ['research', 'snapshot', 'cli-snap', '--max', '2', '--mirror'], {
        'https://openai.example.com/locked': { body: REGION_BODY },
        'https://r.jina.ai/https://openai.example.com/locked': { body: LONG_BODY, contentType: 'text/plain' },
        'https://docs.example.com/full': { body: LONG_BODY },
        'https://docs.example.com/extra': { body: LONG_BODY },
      })
      expect(r.status).toBe(0)
      // 分类汇总：2 份落盘（区域封锁被镜像转 ok + 达标页）——汇总行 = 落盘文件数 + 分类计数
      expect(r.stdout).toContain('引用快照补跑：cli-snap')
      expect(r.stdout).toContain('2 快照（2 ok）')
      expect(r.stdout).toContain('快照已刷新')
      // --max 2：只尝试前 2 条（第 3 条从未 fetch）
      const calls = hook.calls()
      expect(calls.filter((u) => !u.includes('r.jina.ai'))).toHaveLength(2)
      expect(calls.some((u) => u.includes('extra'))).toBe(false)
      // --mirror 临时覆盖配置（workflow.json 未开镜像）：区域封锁经镜像覆盖 via: mirror
      const raw = fs.readFileSync(path.join(repo.root, '.agents', 'orchestrator', 'research', 'cli-snap', 'sources', '1.txt'), 'utf8')
      expect(raw).toContain('via: mirror')
      expect(raw).toContain('usable: ok')
    } finally {
      repo.cleanup()
      hook.cleanup()
    }
  }, 120_000)

  it('配置默认（无 --mirror）：区域封锁保持 region_blocked；brief 不存在 → die 可操作报错', () => {
    const repo = mkRepo()
    const hook = makeFetchHookRunner('snapshot-cli-off-')
    try {
      writeBriefFixture(repo.root, 'cli-off', fiveSectionBody(['https://openai.example.com/locked']))
      const r = hook.run(repo.root, ['research', 'snapshot', 'cli-off'], {
        'https://openai.example.com/locked': { body: REGION_BODY },
      })
      expect(r.status).toBe(0)
      expect(hook.calls().some((u) => u.includes('r.jina.ai'))).toBe(false)
      expect(r.stdout).toContain('快照（1 区域封锁）')
      const raw = fs.readFileSync(path.join(repo.root, '.agents', 'orchestrator', 'research', 'cli-off', 'sources', '1.txt'), 'utf8')
      expect(raw).toContain('usable: region_blocked')
      // brief 不存在 → die（exit 1 + 可操作报错指路 research list）
      const missing = tryOrch(repo.root, 'research snapshot no-such-brief')
      expect(missing.status).toBe(1)
      expect(missing.stderr).toContain('no-such-brief')
      expect(missing.stderr).toContain('research list')
    } finally {
      repo.cleanup()
      hook.cleanup()
    }
  }, 120_000)
})

describe('orchestrator snapshot-quality > resolveResearch 校验（snapshotMax/snapshotMirror）', () => {
  function cfgWith(research: unknown): { root: string; cleanup: () => void } {
    const root = tmpRoot()
    fs.mkdirSync(path.join(root, '.agents'), { recursive: true })
    fs.writeFileSync(path.join(root, '.agents', 'workflow.json'), JSON.stringify({ baseBranch: 'develop', testCmd: 'node -e "process.exit(0)"', research }))
    return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) }
  }

  it('snapshotMax 1–48 整数生效；键缺失不产出该键（调用方回落缺省 16）', () => {
    for (const n of [1, 16, 48]) {
      const c = cfgWith({ snapshotMax: n })
      try {
        expect(loadWorkflowConfig(c.root).research?.snapshotMax).toBe(n)
      } finally {
        c.cleanup()
      }
    }
    const noKey = cfgWith(undefined)
    try {
      expect(loadWorkflowConfig(noKey.root).research?.snapshotMax).toBeUndefined()
      expect(loadWorkflowConfig(noKey.root).research?.snapshotMirror).toBeUndefined()
    } finally {
      noKey.cleanup()
    }
  })

  it('snapshotMax 非法（0/49/1.5/字符串）warn 回落；snapshotMirror 非 bool warn 回落 false 语义', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      for (const bad of [0, 49, 1.5, '10']) {
        const c = cfgWith({ snapshotMax: bad, model: 'glm-5.3-flash' })
        try {
          const r = loadWorkflowConfig(c.root).research
          expect(r?.snapshotMax).toBeUndefined()
          expect(r?.model).toBe('glm-5.3-flash') // 其他键不受连坐
          expect(warnSpy.mock.calls.some((args) => String(args[0]).includes('research.snapshotMax'))).toBe(true)
          warnSpy.mockClear()
        } finally {
          c.cleanup()
        }
      }
      for (const bad of ['yes', 1, null]) {
        const c = cfgWith({ snapshotMirror: bad })
        try {
          const r = loadWorkflowConfig(c.root).research
          expect(r?.snapshotMirror).toBeUndefined()
          expect(warnSpy.mock.calls.some((args) => String(args[0]).includes('research.snapshotMirror'))).toBe(true)
          warnSpy.mockClear()
        } finally {
          c.cleanup()
        }
      }
      // 合法 bool 双向生效
      const on = cfgWith({ snapshotMirror: true })
      try {
        expect(loadWorkflowConfig(on.root).research?.snapshotMirror).toBe(true)
      } finally {
        on.cleanup()
      }
    } finally {
      warnSpy.mockRestore()
    }
  })
})
