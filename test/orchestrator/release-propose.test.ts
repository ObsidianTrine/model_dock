// release-propose 测试：conventional 前缀解析 / semver 定档（含 0.x 惯例）/ 未发布段提取 /
// CLI 端到端（盘点、提案文件、版本指定校验、只读仓库红线）。

import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { githubRepoBase, parseCommit, bumpLevel, incVersion, extractUnreleased, isProductCommit, commitFiles } from '../../.agents/scripts/orchestrator/release-propose.mjs'
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

  it('isProductCommit：产品路径白名单；空提交从产品（宁多勿漏）；scripts 整体是基建但 tray 与 installer.iss 是产品', () => {
    const c = { hash: 'abc', subject: 'x', type: 'fix', desc: 'x', breaking: false }
    expect(isProductCommit(c, ['src/gateway/server.ts'])).toBe(true)
    expect(isProductCommit(c, ['scripts/tray/ModelDockTray.cs'])).toBe(true)
    expect(isProductCommit(c, ['scripts/installer.iss'])).toBe(true) // cd09641 实证：只动安装器脚本也是产品修复
    expect(isProductCommit(c, ['package.json', 'package-lock.json'])).toBe(true) // undici 先例：生产依赖随 SEA 分发
    expect(isProductCommit(c, [])).toBe(true) // 空提交看不了路径，宁多勿漏
    expect(isProductCommit(c, undefined)).toBe(true)
    expect(isProductCommit(c, ['.agents/scripts/orchestrator.mjs'])).toBe(false)
    expect(isProductCommit(c, ['.github/workflows/test.yml', 'docs/usage.md', 'test/a.test.ts'])).toBe(false)
    expect(isProductCommit(c, ['scripts/soak.mjs', 'scripts/release-check.mjs'])).toBe(false) // scripts/ 其余是开发工具
    expect(isProductCommit(c, ['.agents/x.md', 'src/util/fsx.ts'])).toBe(true) // 混合提交：src 决定产品侧
  })
})

describe('orchestrator release-propose > githubRepoBase（远端解析，链接表行数据源）', () => {
  it('https / ssh / 带 .git 尾巴三种 GitHub 形态都解析；仓库主页不含 .git', () => {
    const repo = mkRepo()
    try {
      git(repo.root, 'remote add origin https://github.com/ObsidianTrine/model_dock.git')
      expect(githubRepoBase(repo.root)).toBe('https://github.com/ObsidianTrine/model_dock')
      git(repo.root, 'remote set-url origin git@github.com:foo/bar.git')
      expect(githubRepoBase(repo.root)).toBe('https://github.com/foo/bar')
      git(repo.root, 'remote set-url origin https://github.com/foo/bar')
      expect(githubRepoBase(repo.root)).toBe('https://github.com/foo/bar')
    } finally {
      repo.cleanup()
    }
  })

  it('非 GitHub 托管 / 无远端 → null（提案降级提示，不猜 compare URL）', () => {
    const repo = mkRepo()
    try {
      git(repo.root, 'remote add origin https://gitlab.com/foo/bar.git')
      expect(githubRepoBase(repo.root)).toBeNull()
      git(repo.root, 'remote remove origin')
      expect(githubRepoBase(repo.root)).toBeNull()
    } finally {
      repo.cleanup()
    }
  })
})

describe('orchestrator release-propose > CLI 端到端', () => {
  // ls-remote 占用检查会真发网络请求——单测统一跳过（fixture 的 remote 只为解析链接表行）
  const SKIP_REMOTE = { ORCH_SKIP_REMOTE_CHECK: '1' }
  function seedRepo(): { root: string; cleanup: () => void } {
    const repo = mkRepo()
    const g = (args: string) => git(repo.root, args)
    g('remote add origin https://github.com/ObsidianTrine/model_dock.git')
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
      const out = runOrch(repo.root, 'release-propose', SKIP_REMOTE)
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

  it('无远端 → 链接表行降级为提示行（不猜 compare URL）', () => {
    const repo = seedRepo()
    try {
      git(repo.root, 'remote remove origin')
      git(repo.root, 'commit --allow-empty -m "feat: 新功能"')
      const out = runOrch(repo.root, 'release-propose', SKIP_REMOTE)
      expect(out.stdout).toContain('发版提案 v1.1.0')
      const dir = path.join(repo.root, '.agents', 'orchestrator', 'release-proposals')
      const files = fs.readdirSync(dir).filter((f) => f.startsWith('v1.1.0-'))
      const text = fs.readFileSync(path.join(dir, files[0]), 'utf8')
      expect(text).toContain('未识别 GitHub 远端')
      expect(text).not.toContain('[1.1.0]: https://github.com/')
    } finally {
      repo.cleanup()
    }
  })

  it('fix-only → patch；显式大版本指定（versionHint 合法递增）', () => {
    const repo = seedRepo()
    try {
      git(repo.root, 'commit --allow-empty -m "fix: 只修不发新功能"')
      expect(runOrch(repo.root, 'release-propose', SKIP_REMOTE).stdout).toContain('发版提案 v1.0.1')
      // 0.x breaking 惯例由 bumpLevel 纯函数覆盖；CLI 自动档位始终基于最新 tag（v1.0.0）
      git(repo.root, 'commit --allow-empty -m "feat!: 破坏性改动"')
      expect(runOrch(repo.root, 'release-propose', SKIP_REMOTE).stdout).toContain('发版提案 v2.0.0')
      expect(runOrch(repo.root, 'release-propose 2.1.0', SKIP_REMOTE).stdout).toContain('发版提案 v2.1.0')
    } finally {
      repo.cleanup()
    }
  })

  it('versionHint：非 semver / 不递增 → exit 1 可操作报错', () => {
    const repo = seedRepo()
    try {
      git(repo.root, 'commit --allow-empty -m "feat: x"')
      expect(tryOrch(repo.root, 'release-propose 1.x', SKIP_REMOTE).status).toBe(1)
      expect(tryOrch(repo.root, 'release-propose 1.0.0', SKIP_REMOTE).stderr).toContain('不大于最近已发布')
      expect(tryOrch(repo.root, 'release-propose 0.9.0', SKIP_REMOTE).stderr).toContain('不大于最近已发布')
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

describe('orchestrator release-propose > 产品/基建分类（用户决策 2026-10-29：CHANGELOG 只留产品内容）', () => {
  const SKIP_REMOTE = { ORCH_SKIP_REMOTE_CHECK: '1' }
  /** 有 tag、无未发布段的干净基线：盘点结果完全由新提交决定。 */
  function seedClean(): { root: string; cleanup: () => void } {
    const repo = mkRepo()
    const g = (args: string) => git(repo.root, args)
    g('remote add origin https://github.com/ObsidianTrine/model_dock.git')
    fs.writeFileSync(path.join(repo.root, 'CHANGELOG.md'), '# Changelog\n\n## [1.0.0] - 2026-01-01\n\n首版。\n')
    g('add -A')
    g('commit -m "docs: 去掉未发布段"')
    g('tag -a v1.0.0 -m v1.0.0')
    return repo
  }

  it('产品+基建混合：产品进「产品侧」节并计档位，基建单独备查节不进 CHANGELOG', () => {
    const repo = seedClean()
    try {
      fs.mkdirSync(path.join(repo.root, 'src'), { recursive: true })
      fs.writeFileSync(path.join(repo.root, 'src', 'a.ts'), 'export {}\n')
      git(repo.root, 'add -A')
      git(repo.root, 'commit -m "feat(ui): 产品新功能"')
      fs.mkdirSync(path.join(repo.root, '.agents'), { recursive: true })
      fs.writeFileSync(path.join(repo.root, '.agents', 'notes.md'), 'note\n')
      git(repo.root, 'add -A')
      git(repo.root, 'commit -m "feat(orch): 基建能力"')
      const out = runOrch(repo.root, 'release-propose', SKIP_REMOTE)
      expect(out.stdout).toContain('发版提案 v1.1.0') // 产品 feat 计档位 → minor（基建 feat 不计）
      expect(out.stdout).toContain('产品侧信号: feat 1 / fix 0 / breaking 0')
      expect(out.stdout).toContain('产品 1 + 基建 1')
      const dir = path.join(repo.root, '.agents', 'orchestrator', 'release-proposals')
      const files = fs.readdirSync(dir).filter((f) => f.startsWith('v1.1.0-'))
      const text = fs.readFileSync(path.join(dir, files[0]), 'utf8')
      expect(text).toContain('### 产品侧（进 CHANGELOG 草稿）')
      expect(text).toContain('feat(ui): 产品新功能')
      expect(text).toContain('### 仓库基建（不进 CHANGELOG，仅备查）')
      expect(text).toContain('feat(orch): 基建能力')
      // 基建提交只出现在备查节：产品侧节不含它（节标题顺序约束下，基建行只在基建节出现一次）
      expect(text.indexOf('基建能力')).toBe(text.lastIndexOf('基建能力'))
    } finally {
      repo.cleanup()
    }
  })

  it('仅基建改动 → 没有可发布内容（基建不计，空态如实）', () => {
    const repo = seedClean()
    try {
      fs.mkdirSync(path.join(repo.root, '.agents'), { recursive: true })
      fs.writeFileSync(path.join(repo.root, '.agents', 'notes.md'), 'note\n')
      git(repo.root, 'add -A')
      git(repo.root, 'commit -m "chore(agents): 纯基建改动"')
      expect(runOrch(repo.root, 'release-propose', SKIP_REMOTE).stdout).toContain('没有可发布内容')
    } finally {
      repo.cleanup()
    }
  })

  it('只动 scripts/installer.iss 的修复 = 产品侧（patch 档；scripts/ 整体当基建会漏掉它）', () => {
    const repo = seedClean()
    try {
      fs.mkdirSync(path.join(repo.root, 'scripts'), { recursive: true })
      fs.writeFileSync(path.join(repo.root, 'scripts', 'installer.iss'), '; installer\n')
      git(repo.root, 'add -A')
      git(repo.root, 'commit -m "fix: 安装强关兜底"')
      const out = runOrch(repo.root, 'release-propose', SKIP_REMOTE)
      expect(out.stdout).toContain('发版提案 v1.0.1')
      expect(out.stdout).toContain('产品侧信号: feat 0 / fix 1 / breaking 0')
    } finally {
      repo.cleanup()
    }
  })
})
