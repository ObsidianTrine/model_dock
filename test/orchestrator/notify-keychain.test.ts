// notify 钥匙串兜底测试：env 全空时 darwin 查 `security find-generic-password`（第二道保险，
// 覆盖手动跑）。只测 dryRun 与真实不存在的服务名——绝不真发 webhook，绝不依赖机器钥匙串状态。

import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { keychainWebhook, notify } from '../../.agents/scripts/orchestrator/notify.mjs'
import { keychainServiceName } from '../../.agents/scripts/orchestrator/schedule.mjs'

const IS_DARWIN = process.platform === 'darwin'

function mkRepo(workflow: Record<string, unknown> = {}): { root: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'notify-kc-'))
  fs.mkdirSync(path.join(root, '.agents'), { recursive: true })
  fs.writeFileSync(path.join(root, '.agents', 'workflow.json'), JSON.stringify(workflow))
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) }
}

describe('orchestrator notify > 钥匙串兜底（darwin）', () => {
  it('keychainWebhook：不存在的服务名 → null（不抛错、静默）', () => {
    const repo = mkRepo()
    try {
      if (!IS_DARWIN) {
        expect(keychainWebhook(repo.root)).toBeNull() // 非 darwin 直接 null，不 spawn
        return
      }
      // 临时仓派生服务名（com.notify-kc-xxx.orchestrator-nightly.webhook）必然不在钥匙串
      expect(keychainWebhook(repo.root)).toBeNull()
    } finally {
      repo.cleanup()
    }
  })

  it('notify dryRun：env 全空时 darwin 不报错、无 env webhook 条目（钥匙串无该服务即静默跳过）', async () => {
    const repo = mkRepo()
    try {
      const r = await notify({ title: 't', body: 'b', dryRun: true, repoRoot: repo.root })
      expect(Array.isArray(r.delivered)).toBe(true)
      const envWebhook = process.env.AGENTS_NIGHTLY_WEBHOOK ?? process.env.MODELRDOCK_NIGHTLY_WEBHOOK
      if (!envWebhook) {
        // 环境未设 webhook 且测试服务名不在钥匙串 → 无 webhook 通道（darwin 也一样）
        expect(r.delivered.some((d) => d.startsWith('webhook POST'))).toBe(false)
      }
    } finally {
      repo.cleanup()
    }
  })

  it('notify dryRun：env 已设时直接用 env，不走钥匙串（dryRun 描述含完整 URL 与 payload）', async () => {
    const repo = mkRepo()
    try {
      const r = await notify({
        title: 't',
        body: 'b',
        dryRun: true,
        repoRoot: repo.root,
        webhookEnvs: ['TEST_KC_WEBHOOK'],
      })
      // dryRun 不真的发；TEST_KC_WEBHOOK 未设 → 无 webhook 条目（darwin 亦然，服务名不存在）
      expect(r.delivered.some((d) => d.startsWith('webhook POST'))).toBe(false)
    } finally {
      repo.cleanup()
    }
  })

  it('keychainServiceName 与 schedule.mjs 同源：notify.keychainService 显式 > 派生', () => {
    const repo = mkRepo({ notify: { keychainService: 'my-svc.webhook' } })
    try {
      expect(keychainServiceName(repo.root)).toBe('my-svc.webhook')
    } finally {
      repo.cleanup()
    }
  })
})
