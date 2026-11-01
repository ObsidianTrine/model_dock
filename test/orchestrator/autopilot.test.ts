// autopilot 授权判定测试：workflow.json autopilot 配置解析 + canAutoSubmit 授权矩阵。
// 授权语义（见 autopilot.mjs 头注）：enabled 总开关；人工草稿/deps/核心路径永不自动；
// 自动提交 ≠ 自动合并（gate 覆写 L1，实际分级 L2/L3 照样回人工闸门）。

import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { canAutoSubmit, AUTO_SUBMIT_GATE } from '../../.agents/scripts/orchestrator/autopilot.mjs'
import { loadWorkflowConfig } from '../../.agents/scripts/workflow-config.mjs'
import { nightlyArgs } from '../../.agents/scripts/orchestrator/schedule.mjs'

function tmpCfg(raw: unknown): ReturnType<typeof loadWorkflowConfig> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-ap-'))
  try {
    fs.mkdirSync(path.join(dir, '.agents'), { recursive: true })
    fs.writeFileSync(path.join(dir, '.agents', 'workflow.json'), JSON.stringify(raw))
    return loadWorkflowConfig(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

describe('autopilot > workflow.json 配置解析', () => {
  it('缺省全关闭：enabled=false / autoSubmitTypes=["docs"] / autoDrain=0 / maxProposals=3', () => {
    const cfg = tmpCfg({})
    expect(cfg.autopilot).toEqual({ enabled: false, autoSubmitTypes: ['docs'], autoDrainPerCycle: 0, maxProposalsPerCycle: 3 })
  })

  it('显式开启与白名单覆写生效；非法类型过滤；非法数值回落', () => {
    const cfg = tmpCfg({ autopilot: { enabled: true, autoSubmitTypes: ['docs', 'refactor', 'bogus'], autoDrainPerCycle: 2, maxProposalsPerCycle: 5 } })
    expect(cfg.autopilot).toEqual({ enabled: true, autoSubmitTypes: ['docs', 'refactor'], autoDrainPerCycle: 2, maxProposalsPerCycle: 5 })
    const bad = tmpCfg({ autopilot: { enabled: 'yes', autoDrainPerCycle: -1, maxProposalsPerCycle: 0 } })
    expect(bad.autopilot.enabled).toBe(false) // 非布尔按 false
    expect(bad.autopilot.autoDrainPerCycle).toBe(0)
    expect(bad.autopilot.maxProposalsPerCycle).toBe(3)
    const junk = tmpCfg({ autopilot: 'on' })
    expect(junk.autopilot.enabled).toBe(false) // 非对象回落缺省（stderr 有告警）
  })
})

describe('autopilot > canAutoSubmit 授权矩阵', () => {
  const cfg = (over: Record<string, unknown> = {}) => ({
    autopilot: { enabled: true, autoSubmitTypes: ['docs'], ...(over.ap as object) },
    corePaths: (over.corePaths as string[]) ?? [],
    releasePaths: (over.releasePaths as string[]) ?? [],
  })
  const proposal = (over: Record<string, unknown> = {}) => ({ created_by: 'planner', type: 'docs', files_hint: ['docs/**'], ...over })

  it('白名单内 planner 提案 → 允许；gate 覆写常量为 L1', () => {
    expect(canAutoSubmit(proposal(), cfg())).toEqual({ ok: true })
    expect(AUTO_SUBMIT_GATE).toBe('L1')
  })

  it('总开关关闭 → 一律拒绝（缺省回归底线）', () => {
    expect(canAutoSubmit(proposal(), cfg({ ap: { enabled: false, autoSubmitTypes: ['docs'] } })).ok).toBe(false)
    expect(canAutoSubmit(proposal(), { autopilot: undefined, corePaths: [], releasePaths: [] }).ok).toBe(false)
  })

  it('人工草稿（created_by: human）永不自动提交', () => {
    const r = canAutoSubmit(proposal({ created_by: 'human' }), cfg())
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('人工草稿')
  })

  it('deps 类型永不自动（依赖升级一律人工）', () => {
    expect(canAutoSubmit(proposal({ type: 'deps' }), cfg({ ap: { enabled: true, autoSubmitTypes: ['docs', 'deps'] } })).ok).toBe(false)
  })

  it('白名单外类型拒绝', () => {
    const r = canAutoSubmit(proposal({ type: 'refactor' }), cfg())
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('autoSubmitTypes')
  })

  it('files_hint 命中核心路径 / 发布路径 / 全通配 → 拒绝', () => {
    const c = cfg({ corePaths: ['src/gateway/server.ts'], releasePaths: ['.github/workflows/'] })
    expect(canAutoSubmit(proposal({ files_hint: ['src/gateway/relay.ts'] }), c).ok).toBe(false) // 同前缀段 src 命中
    expect(canAutoSubmit(proposal({ files_hint: ['.github/workflows/x.yml'] }), c).ok).toBe(false)
    expect(canAutoSubmit(proposal({ files_hint: ['**'] }), c).ok).toBe(false) // 全通配保守视为重叠
    expect(canAutoSubmit(proposal({ files_hint: ['docs/**'] }), c).ok).toBe(true) // 不相交放行
  })
})

describe('autopilot > schedule watch 模式参数', () => {
  it('mode=watch：wrapper 参数为 watch --interval N；缺省仍为 nightly 形态', () => {
    expect(nightlyArgs({ mode: 'watch', interval: 15 })).toEqual(['watch', '--interval', '15'])
    expect(nightlyArgs({ mode: 'watch' })).toEqual(['watch'])
    expect(nightlyArgs({ auto: 3 })).toEqual(['nightly', '--auto', '3'])
  })
})
