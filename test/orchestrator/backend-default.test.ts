// 后端缺省回落测试：裸跑 intent/spec（不带 --backend）不得把 undefined 直喂 getBackend
// （曾炸「未知后端 "undefined"」；历史测试全带 --backend mock 从未暴露，全链真跑实测踩中）。

import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { resolveBackendName, getBackend } from '../../.agents/scripts/orchestrator/backends/claude-headless.mjs'
import { readEvents } from '../../.agents/scripts/orchestrator/events.mjs'
import { mkRepo } from './helpers.js'

describe('backend 缺省回落（resolveBackendName）', () => {
  it('显式 --backend 优先；无 qdir（规划会话）缺省 claude-headless，不返回 undefined', () => {
    expect(resolveBackendName({ backend: 'mock' }, null)).toEqual({ name: 'mock', inherited: false })
    expect(resolveBackendName({}, null).name).toBe('claude-headless')
    expect(resolveBackendName({ backend: undefined }, null).name).toBe('claude-headless')
    expect(resolveBackendName({}, null).inherited).toBe(false)
  })

  it('run 场景沿用任务上次会话的后端（retry/resume 不换引擎）', () => {
    const repo = mkRepo()
    try {
      const qdir = path.join(repo.root, '.agents', 'orchestrator', 'logs', 't1')
      fs.mkdirSync(qdir, { recursive: true })
      fs.writeFileSync(path.join(qdir, 'events.jsonl'), JSON.stringify({ type: 'worker_spawned', backend: 'mock' }) + '\n')
      expect(resolveBackendName({}, qdir, readEvents)).toEqual({ name: 'mock', inherited: true })
      // 显式 --backend 覆盖沿用
      expect(resolveBackendName({ backend: 'claude-headless' }, qdir, readEvents).name).toBe('claude-headless')
    } finally {
      repo.cleanup()
    }
  })

  it('回落产物始终能被 getBackend 接受（不再出现未知后端）', async () => {
    const { name } = resolveBackendName({}, null)
    await expect(getBackend(name)).resolves.toBeTruthy()
  })
})
