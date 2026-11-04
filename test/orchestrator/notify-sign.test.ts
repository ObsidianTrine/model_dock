// 飞书出站签名测试（notify.mjs，C13）：feishuSign 算法（官方规范：timestamp+"\n"+secret
// 作 HMAC key、空消息体、base64）/ webhookPayload 附 timestamp+sign / notify 与
// notifyActionCard 的 dryRun 签名形态 / 未配置 = 现状不变。绝不真发 webhook；
// 密钥 env 用完即还原，密钥值绝不进断言输出。

import { describe, expect, it } from 'vitest'
import { createHmac } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { feishuSign, LARK_SIGN_SECRET_ENV, notify, notifyActionCard, resolveSignSecret, webhookPayload } from '../../.agents/scripts/orchestrator/notify.mjs'

const FEISHU = 'https://open.feishu.cn/open-apis/bot/v2/hook/xxx'
const SECRET = 'test-sign-secret-DO-NOT-LEAK'

function mkRepo(workflow: Record<string, unknown> = {}): { root: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'notify-sign-'))
  fs.mkdirSync(path.join(root, '.agents'), { recursive: true })
  fs.writeFileSync(path.join(root, '.agents', 'workflow.json'), JSON.stringify(workflow))
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) }
}

/** 独立复算（测试自证算法而非对拍实现）：官方规范直算一遍。 */
function referenceSign(timestamp: string, secret: string): string {
  return createHmac('sha256', `${timestamp}\n${secret}`).update('').digest('base64')
}

describe('orchestrator notify-sign > feishuSign（飞书自定义机器人签名算法）', () => {
  it('timestamp+"\\n"+secret 作 HMAC-SHA256 key、空消息体、base64（与官方示例复算一致）', () => {
    expect(feishuSign('1700000000', SECRET)).toBe(referenceSign('1700000000', SECRET))
    // 不同 timestamp / secret 产生不同签名；同输入稳定
    expect(feishuSign('1700000001', SECRET)).not.toBe(feishuSign('1700000000', SECRET))
    expect(feishuSign('1700000000', 'other')).not.toBe(feishuSign('1700000000', SECRET))
    expect(feishuSign(1700000000, SECRET)).toBe(feishuSign('1700000000', SECRET)) // 数字时间戳同值
    // 密钥绝不出现在签名输出里
    expect(feishuSign('1700000000', SECRET)).not.toContain(SECRET)
  })
})

describe('orchestrator notify-sign > resolveSignSecret（env 优先；未配置 = 不签名）', () => {
  it('env 已设 → env 来源；env 未设且非 darwin → null（钥匙串兜底是 darwin 专属，与 webhook 同模式）', () => {
    const repo = mkRepo({ notify: { signSecretService: 'svc-name' } })
    const saved = process.env[LARK_SIGN_SECRET_ENV]
    try {
      process.env[LARK_SIGN_SECRET_ENV] = `  ${SECRET}  `
      expect(resolveSignSecret(repo.root)).toEqual({ secret: SECRET, source: 'env' }) // trim
      delete process.env[LARK_SIGN_SECRET_ENV]
      if (process.platform !== 'darwin') {
        expect(resolveSignSecret(repo.root)).toBeNull() // 非 darwin：服务名在也不 spawn security
      }
    } finally {
      if (saved !== undefined) process.env[LARK_SIGN_SECRET_ENV] = saved
      else delete process.env[LARK_SIGN_SECRET_ENV]
      repo.cleanup()
    }
  })
})

describe('orchestrator notify-sign > webhookPayload（4 参调用逐字节不变；5 参附签名）', () => {
  it('sign=null（缺省）→ 飞书 payload 无 timestamp/sign 字段（现状不变）', () => {
    const p = JSON.parse(webhookPayload(FEISHU, 't', 'b', '2026-11-04T00:00:00Z'))
    expect(p.msg_type).toBe('text')
    expect(p.timestamp).toBeUndefined()
    expect(p.sign).toBeUndefined()
  })

  it('sign 提供 → body 附 timestamp（字符串）+ sign；企业微信/Slack 不附（非飞书协议）', () => {
    const p = JSON.parse(webhookPayload(FEISHU, 't', 'b', 'ts', { timestamp: '1700000000', sign: 'SIGNATURE' }))
    expect(p.timestamp).toBe('1700000000')
    expect(p.sign).toBe('SIGNATURE')
    expect(p.msg_type).toBe('text')
    const wecom = JSON.parse(webhookPayload('https://qyapi.weixin.qq.com/x', 't', 'b', 'ts', { timestamp: '1', sign: 's' }))
    expect(wecom.timestamp).toBeUndefined()
  })
})

describe('orchestrator notify-sign > notify（dryRun 全链路形态）', () => {
  it('env 密钥已配 + 飞书端点 → dryRun payload 带 timestamp/sign；secret 本体绝不出现', async () => {
    const repo = mkRepo()
    const saved = process.env[LARK_SIGN_SECRET_ENV]
    try {
      process.env[LARK_SIGN_SECRET_ENV] = SECRET
      process.env.TEST_SIGN_WEBHOOK = FEISHU
      const r2 = await notify({ title: 't', body: 'b', dryRun: true, repoRoot: repo.root, webhookEnvs: ['TEST_SIGN_WEBHOOK'] })
      const line = r2.delivered.find((d) => d.startsWith('webhook POST')) ?? ''
      const payload = JSON.parse(line.slice(line.indexOf('{')))
      expect(typeof payload.timestamp).toBe('string')
      expect(payload.sign).toBe(referenceSign(payload.timestamp, SECRET))
      expect(line).not.toContain(SECRET) // 密钥不落 dryRun 描述
    } finally {
      if (saved !== undefined) process.env[LARK_SIGN_SECRET_ENV] = saved
      else delete process.env[LARK_SIGN_SECRET_ENV]
      delete process.env.TEST_SIGN_WEBHOOK
      repo.cleanup()
    }
  })

  it('未配置密钥 → 现状不变（payload 无 timestamp/sign）', async () => {
    const repo = mkRepo()
    const saved = process.env[LARK_SIGN_SECRET_ENV]
    delete process.env[LARK_SIGN_SECRET_ENV]
    try {
      process.env.TEST_SIGN_WEBHOOK = FEISHU
      const r = await notify({ title: 't', body: 'b', dryRun: true, repoRoot: repo.root, webhookEnvs: ['TEST_SIGN_WEBHOOK'] })
      const line = r.delivered.find((d) => d.startsWith('webhook POST')) ?? ''
      const payload = JSON.parse(line.slice(line.indexOf('{')))
      expect(payload.timestamp).toBeUndefined()
      expect(payload.sign).toBeUndefined()
    } finally {
      if (saved !== undefined) process.env[LARK_SIGN_SECRET_ENV] = saved
      delete process.env.TEST_SIGN_WEBHOOK
      repo.cleanup()
    }
  })
})

describe('orchestrator notify-sign > notifyActionCard（交互卡片同走签名）', () => {
  it('cardWebhook 开启 + env 密钥 → dryRun payload 带 timestamp/sign 且保留卡片结构', async () => {
    const repo = mkRepo({ notify: { cardWebhook: true } })
    const saved = process.env[LARK_SIGN_SECRET_ENV]
    try {
      process.env[LARK_SIGN_SECRET_ENV] = SECRET
      process.env.TEST_SIGN_WEBHOOK = FEISHU
      const r = (await notifyActionCard({ repoRoot: repo.root, webhookEnvs: ['TEST_SIGN_WEBHOOK'], taskId: 't', title: 'x', reason: 'y', dryRun: true })) as any
      expect(r.dryRun).toBe(true)
      const payload = JSON.parse(r.payload)
      expect(payload.msg_type).toBe('interactive')
      expect(typeof payload.timestamp).toBe('string')
      expect(payload.sign).toBe(referenceSign(payload.timestamp, SECRET))
      expect(r.payload).not.toContain(SECRET)
    } finally {
      if (saved !== undefined) process.env[LARK_SIGN_SECRET_ENV] = saved
      else delete process.env[LARK_SIGN_SECRET_ENV]
      delete process.env.TEST_SIGN_WEBHOOK
      repo.cleanup()
    }
  })
})
