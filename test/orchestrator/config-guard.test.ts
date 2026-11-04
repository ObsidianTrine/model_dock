// workflow.json 自改守卫测试（config-guard.mjs，B7）：基线记取 / 漂移检测 / 合法变更
// 重置 / 多仓库隔离 / 文件缺失 fail-open。纯模块测试 + 临时仓库 fixture，不触真实队列。

import { describe, expect, it, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  captureConfigBaseline,
  checkConfigDrift,
  clearConfigBaselines,
  resetConfigBaseline,
  workflowConfigHash,
} from '../../.agents/scripts/orchestrator/config-guard.mjs'

function mkRepo(workflow: Record<string, unknown> = { baseBranch: 'develop' }): { root: string; wf: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-guard-'))
  fs.mkdirSync(path.join(root, '.agents'), { recursive: true })
  const wf = path.join(root, '.agents', 'workflow.json')
  fs.writeFileSync(wf, JSON.stringify(workflow))
  return { root, wf, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) }
}

describe('orchestrator config-guard > workflowConfigHash', () => {
  it('内容 hash 稳定且随内容变化；文件缺失返回 null（不抛错）', () => {
    const repo = mkRepo()
    try {
      const h1 = workflowConfigHash(repo.root)
      expect(h1).toMatch(/^[0-9a-f]{64}$/)
      expect(workflowConfigHash(repo.root)).toBe(h1) // 内容不变 → hash 不变
      fs.writeFileSync(repo.wf, JSON.stringify({ baseBranch: 'main' }))
      expect(workflowConfigHash(repo.root)).not.toBe(h1)
      expect(workflowConfigHash(path.join(repo.root, 'nope'))).toBeNull()
    } finally {
      repo.cleanup()
    }
  })
})

describe('orchestrator config-guard > 基线记取与漂移检测', () => {
  beforeEach(() => clearConfigBaselines())

  it('未记基线（未接线场景）→ ok（守卫不动作）', () => {
    const repo = mkRepo()
    try {
      expect(checkConfigDrift(repo.root)).toEqual({ ok: true, drift: null })
    } finally {
      repo.cleanup()
    }
  })

  it('基线一致 → ok；文件被改 → drift（含前后 hash）；改回基线内容 → 自动恢复 ok', () => {
    const repo = mkRepo()
    try {
      const baseline = captureConfigBaseline(repo.root)
      expect(checkConfigDrift(repo.root)).toEqual({ ok: true, drift: null })
      // 外部改写（模拟被调度方合并进来的授权配置变更）
      fs.writeFileSync(repo.wf, JSON.stringify({ baseBranch: 'develop', worker: { backend: 'claude-headless' } }))
      const v = checkConfigDrift(repo.root)
      expect(v.ok).toBe(false)
      expect(v.drift?.from).toBe(baseline)
      expect(v.drift?.to).toMatch(/^[0-9a-f]{64}$/)
      expect(v.drift?.to).not.toBe(baseline)
      // 改回基线内容 → hash 复合 → 重新校验通过（无需重启）
      fs.writeFileSync(repo.wf, JSON.stringify({ baseBranch: 'develop' }))
      expect(checkConfigDrift(repo.root).ok).toBe(true)
    } finally {
      repo.cleanup()
    }
  })

  it('resetConfigBaseline（编排器自己 merge 后的合法变更）→ 按新基线放行', () => {
    const repo = mkRepo()
    try {
      captureConfigBaseline(repo.root)
      fs.writeFileSync(repo.wf, JSON.stringify({ baseBranch: 'develop', draftsGc: { archiveDays: 7 } }))
      expect(checkConfigDrift(repo.root).ok).toBe(false)
      const fresh = resetConfigBaseline(repo.root)
      expect(fresh).toMatch(/^[0-9a-f]{64}$/)
      expect(checkConfigDrift(repo.root)).toEqual({ ok: true, drift: null })
    } finally {
      repo.cleanup()
    }
  })

  it('文件缺失 fail-open：基线在、当前不可得 → ok（损坏阻断归 loadWorkflowConfig）', () => {
    const repo = mkRepo()
    try {
      captureConfigBaseline(repo.root)
      fs.rmSync(repo.wf)
      expect(checkConfigDrift(repo.root)).toEqual({ ok: true, drift: null })
    } finally {
      repo.cleanup()
    }
  })

  it('多仓库互不串扰（同进程跑多个临时仓库的测试场景）', () => {
    const a = mkRepo({ baseBranch: 'develop' })
    const b = mkRepo({ baseBranch: 'develop' })
    try {
      captureConfigBaseline(a.root)
      captureConfigBaseline(b.root)
      fs.writeFileSync(a.wf, JSON.stringify({ baseBranch: 'main' }))
      expect(checkConfigDrift(a.root).ok).toBe(false)
      expect(checkConfigDrift(b.root).ok).toBe(true) // b 未被改，不受 a 漂移影响
    } finally {
      a.cleanup()
      b.cleanup()
    }
  })
})
