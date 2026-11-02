// L0 门禁分级 + merged 通知测试：纯文档卡（全部改动 .md）跑 testCmdL0 轻量门禁
// （npm_test 带 scoped:l0、tsc_build 带 reason:docs_only 跳过），代码卡照旧全量；
// 成功出港向 ORCH_WEBHOOK 发 merged ✅ 通知（此前 merged 静默）。

import { describe, expect, it } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { cardText, eventsOf, mkRepo, readCard, runOrch } from './helpers.js'

function submitCard(repo: string, id: string, overrides: Record<string, unknown> = {}) {
  const cardFile = path.join(repo, `card-${id}.md`)
  fs.writeFileSync(cardFile, cardText({ id, ...overrides }))
  runOrch(repo, `submit "${cardFile}"`)
}

describe('L0 门禁分级 > 纯文档卡轻量门禁', () => {
  it('docs 卡：npm_test 带 scoped:l0（跑 testCmdL0）、tsc_build 带 docs_only 签名跳过', () => {
    const repo = mkRepo({
      extra: { testCmdL0: 'node -e "process.exit(0)"' },
    })
    try {
      submitCard(repo.root, 'l0-docs', { gate: 'L3', files_hint: ['docs/**'] })
      runOrch(repo.root, 'run l0-docs --backend mock', { ORCH_MOCK_FILE: 'docs/notes.md' })
      const ev = eventsOf(repo.root, 'l0-docs')
      const npm = ev.find((e) => e.type === 'gate_result' && e.gate === 'npm_test')
      expect(npm?.result).toBe('pass')
      expect(npm?.scoped).toBe('l0')
      const build = ev.find((e) => e.type === 'gate_result' && e.gate === 'tsc_build')
      expect(build?.skipped).toBe(true)
      expect(build?.reason).toBe('docs_only') // docsOnly 跳过带签名；与 buildCmd 未配置的普通 skip 区分
      expect(readCard(repo.root, 'awaiting-human', 'l0-docs')).toBeTruthy()
    } finally {
      repo.cleanup()
    }
  }, 120_000)

  it('代码卡：照旧全量（npm_test 无 scoped、tsc_build 不走 docsOnly 跳过）', () => {
    const repo = mkRepo({
      extra: { testCmdL0: 'node -e "process.exit(0)"' },
    })
    try {
      submitCard(repo.root, 'l0-code', { gate: 'L3', files_hint: ['src/**'] })
      runOrch(repo.root, 'run l0-code --backend mock', { ORCH_MOCK_FILE: 'src/feat.ts' })
      const ev = eventsOf(repo.root, 'l0-code')
      const npm = ev.find((e) => e.type === 'gate_result' && e.gate === 'npm_test')
      expect(npm?.result).toBe('pass')
      expect(npm?.scoped).toBeUndefined()
      const build = ev.find((e) => e.type === 'gate_result' && e.gate === 'tsc_build')
      expect(build?.reason).toBeUndefined() // 代码卡不走 docsOnly 跳过（mkRepo 无 buildCmd 时普通 skip 不带 reason）
    } finally {
      repo.cleanup()
    }
  }, 120_000)
})

describe('L0 门禁分级 > merged 通知补缺', () => {
  it('自动出港时向 ORCH_WEBHOOK 发 merged 通知（✅）', async () => {
    const repo = mkRepo()
    const posts: Array<{ body: string }> = []
    const server = http.createServer((req, res) => {
      let raw = ''
      req.on('data', (c) => (raw += c))
      req.on('end', () => {
        try {
          posts.push(JSON.parse(raw))
        } catch { /* 非 JSON 忽略 */ }
        res.writeHead(200)
        res.end('ok')
      })
    })
    try {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
      const addr = (server.address() as { port: number }).port
      submitCard(repo.root, 'ntf-merged', { gate: 'L0', files_hint: ['docs/**'] })
      runOrch(repo.root, 'run ntf-merged --backend mock', {
        ORCH_MOCK_FILE: 'docs/notes.md',
        AGENTS_ORCH_WEBHOOK: `http://127.0.0.1:${addr}`,
      })
      // notify 尽力而为、fire-and-forget：轮询等 POST 到达（≤5s）
      await new Promise<void>((resolve) => {
        const deadline = Date.now() + 5000
        const tick = () => {
          if (posts.length || Date.now() > deadline) return resolve()
          setTimeout(tick, 200)
        }
        tick()
      })
      expect(posts.length).toBeGreaterThanOrEqual(1)
      const mergedPost = posts.find((p) => p.body?.includes('merged'))
      expect(mergedPost).toBeTruthy()
      expect(mergedPost!.body).toContain('✅')
      expect(readCard(repo.root, 'merged', 'ntf-merged')).toBeTruthy()
    } finally {
      server.close()
      repo.cleanup()
    }
  }, 120_000)
})
