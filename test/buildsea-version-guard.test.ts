import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  classifyPkgJsonDiff,
  classifyVersionTsDiff,
  decideVersionResidue,
  healVersionResidue,
  readGitHeadFile,
} from '../scripts/build-sea-version-guard.mjs'

// build-sea 版本文件中断残留自愈（fix-buildsea-version-residue）：四分支判定
// （无差异 / 纯版本差异→还原 / 超形状差异→拒绝 / HEAD 不可读→拒绝）+ 真实 git 沙盘 e2e。
// 沙盘在 os.tmpdir() + path.join()，三平台一致；不触网、不监听端口、收尾 rmSync。

const HEAD_VERSION_TS = `export const VERSION = '1.0.0'\n`
const HEAD_PKG = JSON.stringify({ name: 'modeldock', version: '1.0.0', private: true }, null, 2) + '\n'

function pkgWithVersion(v: string, rest: Record<string, unknown> = { name: 'modeldock', private: true }): string {
  return JSON.stringify({ ...rest, version: v }, null, 2) + '\n'
}

function git(dir: string, ...argv: string[]): void {
  const r = spawnSync('git', ['-C', dir, ...argv], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`git ${argv.join(' ')} 失败: ${r.stderr}`)
}

/** 真实 git 沙盘：HEAD 里提交两份版本文件，返回目录（调用方 finally rmSync） */
function makeGitRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-verguard-'))
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'src', 'version.ts'), HEAD_VERSION_TS)
  fs.writeFileSync(path.join(dir, 'package.json'), HEAD_PKG)
  git(dir, 'init')
  git(dir, 'add', '.')
  git(dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-m', 'init')
  return dir
}

describe('classifyVersionTsDiff', () => {
  it('clean：与 HEAD 完全一致', () => {
    expect(classifyVersionTsDiff(HEAD_VERSION_TS, HEAD_VERSION_TS)).toBe('clean')
  })
  it('clean：仅换行符差异（Windows CRLF 工作树 vs LF blob）', () => {
    expect(classifyVersionTsDiff(HEAD_VERSION_TS, HEAD_VERSION_TS.replace(/\n/g, '\r\n'))).toBe('clean')
  })
  it('residue：仅版本字面量不同（中断残留形状）', () => {
    expect(classifyVersionTsDiff(HEAD_VERSION_TS, `export const VERSION = '9.9.9'\n`)).toBe('residue')
  })
  it('foreign：新增注释行（人工改动）', () => {
    expect(classifyVersionTsDiff(HEAD_VERSION_TS, `// local tweak\nexport const VERSION = '9.9.9'\n`)).toBe('foreign')
  })
  it('foreign：截断文件', () => {
    expect(classifyVersionTsDiff(HEAD_VERSION_TS, `export const VERSION = '9.9`)).toBe('foreign')
  })
  it('foreign：引号风格变化（单引号 → 双引号）', () => {
    expect(classifyVersionTsDiff(HEAD_VERSION_TS, `export const VERSION = "9.9.9"\n`)).toBe('foreign')
  })
  it('foreign：文件其他位置出现的版本串改动不被掩码误吞', () => {
    expect(classifyVersionTsDiff(HEAD_VERSION_TS, `// bumped from 1.0.0\nexport const VERSION = '9.9.9'\n`)).toBe('foreign')
  })
})

describe('classifyPkgJsonDiff', () => {
  it('clean：与 HEAD 完全一致', () => {
    expect(classifyPkgJsonDiff(HEAD_PKG, HEAD_PKG)).toBe('clean')
  })
  it('clean：仅换行符差异', () => {
    expect(classifyPkgJsonDiff(HEAD_PKG, HEAD_PKG.replace(/\n/g, '\r\n'))).toBe('clean')
  })
  it('residue：仅 version 键不同', () => {
    expect(classifyPkgJsonDiff(HEAD_PKG, pkgWithVersion('9.9.9'))).toBe('residue')
  })
  it('residue：version 键缺失但其余语义一致（version 键差异属版本号形状内）', () => {
    const cur = JSON.stringify({ name: 'modeldock', private: true }, null, 2) + '\n'
    expect(classifyPkgJsonDiff(HEAD_PKG, cur)).toBe('residue')
  })
  it('foreign：新增依赖（人工改动）', () => {
    const cur = pkgWithVersion('9.9.9', { name: 'modeldock', private: true, dependencies: { evil: '^1.0.0' } })
    expect(classifyPkgJsonDiff(HEAD_PKG, cur)).toBe('foreign')
  })
  it('foreign：非法 JSON（截断写盘）', () => {
    expect(classifyPkgJsonDiff(HEAD_PKG, `{"name": "modeldock", "ver`)).toBe('foreign')
  })
  it('foreign：version 未变但其余语义有别（不猜格式化/键序意图）', () => {
    const cur = JSON.stringify({ version: '1.0.0', name: 'modeldock', private: true, scripts: { build: 'tsc' } }, null, 2) + '\n'
    expect(classifyPkgJsonDiff(HEAD_PKG, cur)).toBe('foreign')
  })
})

describe('decideVersionResidue 四分支', () => {
  const clean = {
    headVersionTs: HEAD_VERSION_TS,
    headPkgJson: HEAD_PKG,
    curVersionTs: HEAD_VERSION_TS,
    curPkgJson: HEAD_PKG,
  }

  it('分支 1：无差异 → none', () => {
    expect(decideVersionResidue(clean).action).toBe('none')
  })
  it('分支 2：纯版本差异 → restore 且带回 HEAD 内容', () => {
    const v = decideVersionResidue({
      ...clean,
      curVersionTs: `export const VERSION = '9.9.9'\n`,
      curPkgJson: pkgWithVersion('9.9.9'),
    })
    expect(v.action).toBe('restore')
    expect(v.headVersionTs).toBe(HEAD_VERSION_TS)
    expect(v.headPkgJson).toBe(HEAD_PKG)
  })
  it('分支 2 变体：仅单文件残留也 → restore', () => {
    expect(
      decideVersionResidue({ ...clean, curPkgJson: pkgWithVersion('9.9.9') }).action,
    ).toBe('restore')
  })
  it('分支 3：超形状差异（pkg 加依赖）→ reject', () => {
    const v = decideVersionResidue({
      ...clean,
      curPkgJson: pkgWithVersion('9.9.9', { name: 'modeldock', private: true, dependencies: { x: '^1' } }),
    })
    expect(v.action).toBe('reject')
    expect(v.reason).toContain('package.json')
  })
  it('分支 3 变体：超形状差异（version.ts 加注释）→ reject 且指明文件', () => {
    const v = decideVersionResidue({
      ...clean,
      curVersionTs: `// local\n${HEAD_VERSION_TS}`,
    })
    expect(v.action).toBe('reject')
    expect(v.reason).toContain('src/version.ts')
  })
  it('分支 4：HEAD 不可读（version.ts）→ reject', () => {
    const v = decideVersionResidue({ ...clean, headVersionTs: null })
    expect(v.action).toBe('reject')
  })
  it('分支 4 变体：HEAD 不可读（package.json）→ reject', () => {
    const v = decideVersionResidue({ ...clean, headPkgJson: null })
    expect(v.action).toBe('reject')
  })
  it('工作树文件不可读 → reject（无法区分残留与人工改动）', () => {
    expect(decideVersionResidue({ ...clean, curVersionTs: null }).action).toBe('reject')
    expect(decideVersionResidue({ ...clean, curPkgJson: null }).action).toBe('reject')
  })
})

describe('readGitHeadFile（真实 git 沙盘）', () => {
  it('HEAD 内文件返回内容', () => {
    const dir = makeGitRepo()
    try {
      expect(readGitHeadFile(dir, 'src/version.ts')).toBe(HEAD_VERSION_TS)
      expect(readGitHeadFile(dir, 'package.json')).toBe(HEAD_PKG)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
  it('文件不在 HEAD → null；非 git 目录 → null', () => {
    const dir = makeGitRepo()
    const nonGit = fs.mkdtempSync(path.join(os.tmpdir(), 'md-verguard-nogit-'))
    try {
      expect(readGitHeadFile(dir, 'no-such-file.txt')).toBe(null)
      expect(readGitHeadFile(nonGit, 'src/version.ts')).toBe(null)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
      fs.rmSync(nonGit, { recursive: true, force: true })
    }
  })
})

describe('healVersionResidue 端到端（真实 git 沙盘 + 真实 fs）', () => {
  it('残留 → 还原写回 HEAD 并提示；还原后工作树与 HEAD 一致', async () => {
    const dir = makeGitRepo()
    try {
      fs.writeFileSync(path.join(dir, 'src', 'version.ts'), `export const VERSION = '9.9.9'\n`)
      fs.writeFileSync(path.join(dir, 'package.json'), pkgWithVersion('9.9.9'))
      const warns: string[] = []
      const verdict = await healVersionResidue(dir, { warn: (m: string) => warns.push(String(m)) })
      expect(verdict.action).toBe('restore')
      expect(fs.readFileSync(path.join(dir, 'src', 'version.ts'), 'utf8')).toBe(HEAD_VERSION_TS)
      expect(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).toBe(HEAD_PKG)
      expect(warns.join('\n')).toContain('上次构建中断残留已还原')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
  it('干净 → none 且文件原样', async () => {
    const dir = makeGitRepo()
    try {
      const verdict = await healVersionResidue(dir)
      expect(verdict.action).toBe('none')
      expect(fs.readFileSync(path.join(dir, 'src', 'version.ts'), 'utf8')).toBe(HEAD_VERSION_TS)
      expect(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).toBe(HEAD_PKG)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
  it('超形状差异 → throw fail-loud 且绝不写盘（用户改动原封不动）', async () => {
    const dir = makeGitRepo()
    try {
      const dirtyTs = `// my wip\n${HEAD_VERSION_TS}`
      fs.writeFileSync(path.join(dir, 'src', 'version.ts'), dirtyTs)
      await expect(healVersionResidue(dir)).rejects.toThrow(/超出版本号字段/)
      expect(fs.readFileSync(path.join(dir, 'src', 'version.ts'), 'utf8')).toBe(dirtyTs)
      expect(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).toBe(HEAD_PKG)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
