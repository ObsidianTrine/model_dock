// workflow-config.mjs 行为锁定：.agents 工具链的唯一项目配置入口。
// 可移植性的关键不变量——配置缺省 = 红线关闭；hook 脚本锚定 / orchestrator repoRoot 锚定。

import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isNpmFamily, loadWorkflowConfig, releaseHatches, resolveTestCmd, workflowConfigPath } from '../../.agents/scripts/workflow-config.mjs'

describe('workflow-config > 脚本锚定（hook 场景）', () => {
  it('无 repoRoot 参数 → 读 .agents 自身仓库的 workflow.json（本仓库已配置红线）', () => {
    const cfg = loadWorkflowConfig()
    expect(cfg.baseBranch).toBe('develop')
    expect(cfg.testCmd).toEqual(['npm test'])
    expect(cfg.buildCmd).toBe('npm run build')
    expect(cfg.packageManager).toBe('npm')
    expect(cfg.protectedPorts).toEqual(['8687', '8890'])
    expect(cfg.corePaths).toContain('src/cli.ts')
    expect(cfg.releasePaths).toContain('.github/workflows/')
    expect(cfg.reviewNotes).toContain('8687')
    expect(cfg.envPrefix).toBe('AGENTS')
  })

  it('workflowConfigPath：repoRoot 锚定 vs 脚本锚定，同仓库时指向同一文件', () => {
    const scriptAnchored = workflowConfigPath()
    expect(scriptAnchored).toMatch(/\.agents[/\\]workflow\.json$/)
    expect(fs.existsSync(scriptAnchored)).toBe(true)
  })
})

describe('workflow-config > repoRoot 锚定（orchestrator / 临时仓库场景）', () => {
  it('显式 repoRoot → 读 <repoRoot>/.agents/workflow.json', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfcfg-'))
    try {
      fs.mkdirSync(path.join(dir, '.agents'))
      fs.writeFileSync(
        path.join(dir, '.agents', 'workflow.json'),
        JSON.stringify({ baseBranch: 'trunk', testCmd: 'cargo test', protectedPorts: ['7000'] }),
      )
      const cfg = loadWorkflowConfig(dir)
      expect(cfg.baseBranch).toBe('trunk')
      expect(cfg.testCmd).toEqual(['cargo test'])
      expect(cfg.protectedPorts).toEqual(['7000'])
      // 未配置字段回落关闭缺省
      expect(cfg.buildCmd).toBeNull()
      expect(cfg.corePaths).toEqual([])
      expect(cfg.reviewNotes).toBe('')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('文件缺失 → 全部关闭缺省（红线不启用，不抛错）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfcfg-empty-'))
    try {
      const cfg = loadWorkflowConfig(dir)
      expect(cfg.baseBranch).toBeNull()
      expect(cfg.testCmd).toBeNull()
      expect(cfg.protectedPorts).toEqual([])
      expect(cfg.corePaths).toEqual([])
      expect(cfg.releasePaths).toEqual([])
      expect(cfg.envPrefix).toBe('AGENTS')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('JSON 损坏 → 抛可操作报错（阻断启动）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfcfg-bad-'))
    try {
      fs.mkdirSync(path.join(dir, '.agents'))
      fs.writeFileSync(path.join(dir, '.agents', 'workflow.json'), '{ not json')
      expect(() => loadWorkflowConfig(dir)).toThrowError(/不是合法 JSON/)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('envPrefix 非法值回落 AGENTS', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfcfg-env-'))
    try {
      fs.mkdirSync(path.join(dir, '.agents'))
      fs.writeFileSync(path.join(dir, '.agents', 'workflow.json'), JSON.stringify({ envPrefix: '1 bad name' }))
      expect(loadWorkflowConfig(dir).envPrefix).toBe('AGENTS')
      fs.writeFileSync(path.join(dir, '.agents', 'workflow.json'), JSON.stringify({ envPrefix: 'MYTEAM' }))
      expect(loadWorkflowConfig(dir).envPrefix).toBe('MYTEAM')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('workflow-config > baseBranches（多基准分支保护）', () => {
  it('显式清单解析；缺省空数组（回落 main+baseBranch 推导）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfcfg-bb-'))
    try {
      fs.mkdirSync(path.join(dir, '.agents'))
      fs.writeFileSync(path.join(dir, '.agents', 'workflow.json'), JSON.stringify({ baseBranches: ['develop', 'master'] }))
      expect(loadWorkflowConfig(dir).baseBranches).toEqual(['develop', 'master'])
      fs.writeFileSync(path.join(dir, '.agents', 'workflow.json'), JSON.stringify({}))
      expect(loadWorkflowConfig(dir).baseBranches).toEqual([])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('workflow-config > testCmd 三形态与工具函数', () => {
  it('字符串 / 数组 / 平台映射', () => {
    expect(resolveTestCmd('npm test')).toEqual(['npm test'])
    expect(resolveTestCmd(['a', 'b'])).toEqual(['a', 'b'])
    expect(resolveTestCmd({ unix: './run.sh', win32: 'run.bat' })).toEqual([process.platform === 'win32' ? 'run.bat' : './run.sh'])
    expect(resolveTestCmd(undefined)).toBeNull()
    expect(resolveTestCmd({})).toBeNull() // 当前平台无映射 → null
  })

  it('isNpmFamily：npm 系才做 native/依赖检查', () => {
    for (const pm of ['npm', 'pnpm', 'yarn', 'bun']) expect(isNpmFamily(pm)).toBe(true)
    expect(isNpmFamily('cargo')).toBe(false)
    expect(isNpmFamily(null)).toBe(false)
    expect(isNpmFamily(undefined)).toBe(false)
  })

  it('releaseHatches：envPrefix 派生新名 + 旧项目名永远兼容', () => {
    expect(releaseHatches('AGENTS')).toEqual(['AGENTS_ALLOW_RELEASE=1', 'MODELRDOCK_ALLOW_RELEASE=1'])
    expect(releaseHatches('MYTEAM')).toEqual(['MYTEAM_ALLOW_RELEASE=1', 'MODELRDOCK_ALLOW_RELEASE=1'])
    expect(releaseHatches('')).toContain('AGENTS_ALLOW_RELEASE=1')
  })
})
