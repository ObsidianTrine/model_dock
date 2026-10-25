// release-propose 测试：conventional 前缀解析 / semver 定档（含 0.x 惯例）/ 未发布段提取 /
// CLI 端到端（盘点、提案文件、版本指定校验、只读仓库红线）。

import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { parseCommit, bumpLevel, incVersion, extractUnreleased } from '../../.agents/scripts/orchestrator/release-propose.mjs'
import { mkRepo, git, runOrch, tryOrch } from './helpers.js'

describe('orchestrator release-propose > 纯函数', () => {
  it('parseCommit：前缀/scope/breaking 标记/body BREAKING CHANGE', () => {
    expect(parseCommit('feat(ui): 新功能')).toEqual({ subject: 'feat(ui): 新功能', type: 'feat', desc: '新功能', breaking: false })
    expect(parseCommit('fix: 修复').breaking).toBe(false)
    expect(parseCommit('feat!: 破坏性').breaking).toBe(true)
    expect(parseCommit('feat: x', '其他行\nBREAKING CHANGE: 接口变更').breaking).toBe(true)
    expect(parseCommit('feat: x', '其他行\nBREAKING-CHANGE: 接口变更').breaking).toBe(true)
    // 提及字样但非 footer 声明（无冒号）→ 不算 breaking：正文描述误顶 major 的实测误报来源
    expect(parseCommit('feat: x', '盘点时做 BREAKING CHANGE 识别').breaking).toBe(false)
    expect(parseCommit('feat: x', 'BREAKING CHANGE 识别）之类的字样在行首也不算').breaking).toBe(false)
    expect(parseCommit('随手一提没有前缀').type).toBeNull()
    expect(parseCommit('随手一提没有前缀').desc).toBe('随手一提没有前缀')
  })

  it('bumpLevel：feat→minor、fix-only→patch、breaking 按 0.x 惯例走 minor、≥1.0 走 major', () => {
    expect(bumpLevel({ feat: 1, fix: 0, breaking: 0 }, 'v1.2.2')).toBe('minor')
    expect(bumpLevel({ feat: 0, fix: 2, breaking: 0 }, 'v1.2.2')).toBe('patch')
    expect(bumpLevel({ feat: 0, fix: 0, breaking: 1 }, 'v0.2.0')).toBe('minor')
    expect(bumpLevel({ feat: 1, fix: 0, breaking: 1 }, 'v1.2.2')).toBe('major')
    expect(bumpLevel({ feat: 0, fix: 0, breaking: 0 }, 'v1.2.2')).toBe('patch')
  })

  it('incVersion：三档递增', () => {
    expect(incVersion('v1.2.2', 'major')).toBe('2.0.0')
    expect(incVersion('v1.2.2', 'minor')).toBe('1.3.0')
    expect(incVersion('v1.2.2', 'patch')).toBe('1.2.3')
    expect(incVersion('v0.2.9', 'minor')).toBe('0.3.0')
  })

  it('extractUnreleased：截取未发布段；缺失返回 null', () => {
    const md = '# Changelog\n\n## [未发布]\n\n### 新增\n\n- **条目**：内容。\n\n## [1.0.0] - 2026-01-01\n\n首版。\n'
    expect(extractUnreleased(md)).toBe('### 新增\n\n- **条目**：内容。')
    expect(extractUnreleased('# Changelog\n\n## [1.0.0]\n\n首版。\n')).toBeNull()
  })
})

describe('orchestrator release-propose > CLI 端到端', () => {
  function seedRepo(): { root: string; cleanup: () => void } {
    const repo = mkRepo()
    const g = (args: string) => git(repo.root, args)
    g('commit --allow-empty -m "chore: baseline"')
    g('tag -a v1.0.0 -m v1.0.0')
    fs.writeFileSync(
      path.join(repo.root, 'CHANGELOG.md'),
      '# Changelog\n\n## [未发布]\n\n### 修复\n\n- **测试条目**：内容。\n\n## [1.0.0] - 2026-01-01\n\n首版。\n',
    )
    g('add -A')
    g('commit -m "docs: changelog"')
    return repo
  }

  it('feat 提交 → 建议 minor；提案文件落盘且含盘点/链接表/下一步；CHANGELOG 保持只读', () => {
    const repo = seedRepo()
    try {
      git(repo.root, 'commit --allow-empty -m "feat(ui): 新功能A"')
      git(repo.root, 'commit --allow-empty -m "fix: 修复B"')
      git(repo.root, 'commit --allow-empty -m "随手提交无前缀"')
      const out = runOrch(repo.root, 'release-propose')
      expect(out.stdout).toContain('发版提案 v1.1.0')
      expect(out.stdout).toContain('上个已发布 tag: v1.0.0')
      expect(out.stdout).toContain('feat 1 / fix 1 / breaking 0')
      expect(out.stdout).toContain('确认后对 agent 说「发布 v1.1.0」')
      const dir = path.join(repo.root, '.agents', 'orchestrator', 'release-proposals')
      const files = fs.readdirSync(dir).filter((f) => f.startsWith('v1.1.0-'))
      expect(files).toHaveLength(1)
      const text = fs.readFileSync(path.join(dir, files[0]), 'utf8')
      expect(text).toContain('feat(ui): 新功能A')
      expect(text).toContain('待人工归类')
      expect(text).toContain('随手提交无前缀')
      expect(text).toContain('[1.1.0]: https://github.com/ObsidianTrine/model_dock/compare/v1.0.0...v1.1.0')
      expect(text).toContain('## [1.1.0] - ')
      expect(text).toContain('- **测试条目**：内容。') // 未发布段原样进草稿
      // 只读红线：CHANGELOG.md 内容未被改动
      expect(fs.readFileSync(path.join(repo.root, 'CHANGELOG.md'), 'utf8')).toContain('## [未发布]')
    } finally {
      repo.cleanup()
    }
  })

  it('fix-only → patch；显式大版本指定（versionHint 合法递增）', () => {
    const repo = seedRepo()
    try {
      git(repo.root, 'commit --allow-empty -m "fix: 只修不发新功能"')
      expect(runOrch(repo.root, 'release-propose').stdout).toContain('发版提案 v1.0.1')
      // 0.x breaking 惯例由 bumpLevel 纯函数覆盖；CLI 自动档位始终基于最新 tag（v1.0.0）
      git(repo.root, 'commit --allow-empty -m "feat!: 破坏性改动"')
      expect(runOrch(repo.root, 'release-propose').stdout).toContain('发版提案 v2.0.0')
      expect(runOrch(repo.root, 'release-propose 2.1.0').stdout).toContain('发版提案 v2.1.0')
    } finally {
      repo.cleanup()
    }
  })

  it('versionHint：非 semver / 不递增 → exit 1 可操作报错', () => {
    const repo = seedRepo()
    try {
      git(repo.root, 'commit --allow-empty -m "feat: x"')
      expect(tryOrch(repo.root, 'release-propose 1.x').status).toBe(1)
      expect(tryOrch(repo.root, 'release-propose 1.0.0').stderr).toContain('不大于最近已发布')
      expect(tryOrch(repo.root, 'release-propose 0.9.0').stderr).toContain('不大于最近已发布')
    } finally {
      repo.cleanup()
    }
  })

  it('无 tag / 无可发内容 → 可操作报错与空态提示', () => {
    const empty = mkRepo() // 无任何 v* tag
    try {
      const r = tryOrch(empty.root, 'release-propose')
      expect(r.status).toBe(1)
      expect(r.stderr).toContain('没有任何 v* 版本 tag')
    } finally {
      empty.cleanup()
    }
    const clean = seedRepo() // 有 tag 但 tag..develop 无内容提交、无未发布段
    try {
      fs.writeFileSync(path.join(clean.root, 'CHANGELOG.md'), '# Changelog\n\n## [1.0.0] - 2026-01-01\n\n首版。\n')
      git(clean.root, 'add -A')
      git(clean.root, 'commit -m "docs: 去掉未发布段"')
      // tag 移到最新提交：v1.0.0..develop 归零，与「无未发布段」共同构成空态
      git(clean.root, 'tag -d v1.0.0')
      git(clean.root, 'tag -a v1.0.0 -m v1.0.0 HEAD')
      const out = runOrch(clean.root, 'release-propose')
      expect(out.stdout).toContain('没有可发布内容')
    } finally {
      clean.cleanup()
    }
  })
})
