import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { audit, corePaths, classifyChange, evaluateBranchEdit, evaluateCommand, gitSubcommand, readAudit, setAuditFile } from '../../.agents/scripts/policy.mjs'

describe('policy.mjs > Bash 命令红线（evaluateCommand）', () => {
  it('发布动作全拦：git push / git -C repo push / git tag / npm publish', () => {
    expect(evaluateCommand('git push origin feature/x')).toMatchObject({ allowed: false, rule: 'publish' })
    expect(evaluateCommand('git -C /repo push origin main')).toMatchObject({ allowed: false, rule: 'publish' })
    expect(evaluateCommand('git -c user.name=x push')).toMatchObject({ allowed: false, rule: 'publish' })
    expect(evaluateCommand('git tag -a v1.0 -m v1.0')).toMatchObject({ allowed: false, rule: 'publish' })
    expect(evaluateCommand('npm publish')).toMatchObject({ allowed: false, rule: 'publish' })
  })

  it('发版授权 hatch：AGENTS_ALLOW_RELEASE=1（新名）前缀仅放行白名单形态', () => {
    for (const c of [
      'AGENTS_ALLOW_RELEASE=1 git push origin main',
      'AGENTS_ALLOW_RELEASE=1 git push origin master',
      'AGENTS_ALLOW_RELEASE=1 git push origin develop',
      'AGENTS_ALLOW_RELEASE=1 git push origin v1.2.0',
      'AGENTS_ALLOW_RELEASE=1 git push origin :refs/tags/v1.2.0',
      'AGENTS_ALLOW_RELEASE=1 git tag -a v1.2.0 -m v1.2.0',
      'AGENTS_ALLOW_RELEASE=1 git tag -d v1.2.0',
    ]) {
      expect(evaluateCommand(c)).toMatchObject({ allowed: true, rule: 'release-hatch' })
    }
  })

  it('发版授权 hatch：旧项目名 MODELRDOCK_ALLOW_RELEASE=1 兼容放行', () => {
    expect(evaluateCommand('MODELRDOCK_ALLOW_RELEASE=1 git push origin main')).toMatchObject({ allowed: true, rule: 'release-hatch' })
    expect(evaluateCommand('MODELRDOCK_ALLOW_RELEASE=1 git push --tags')).toMatchObject({ allowed: false })
  })

  it('hatch 不放行白名单外的形态', () => {
    for (const c of [
      'AGENTS_ALLOW_RELEASE=1 git push --tags',
      'AGENTS_ALLOW_RELEASE=1 git push origin main --force',
      'AGENTS_ALLOW_RELEASE=1 git push origin feature/x',
      'AGENTS_ALLOW_RELEASE=1 git push origin main v1.2.0', // 一次推两个 ref
      'AGENTS_ALLOW_RELEASE=1 git checkout main && git push origin main', // 复合命令整串不匹配
      'AGENTS_ALLOW_RELEASE=1 git tag v1.2.0', // 轻量 tag 不在白名单（规程要求 annotated）
      'AGENTS_ALLOW_RELEASE=1 git tag -a v1.2 -m x', // 非 semver 三段
      'AGENTS_ALLOW_RELEASE=1 git tag -a v1.2.0.1 -m x',
      'AGENTS_ALLOW_RELEASE=1 git tag -d v1.2.0 v1.2.1',
      'AGENTS_ALLOW_RELEASE=1 npm publish',
    ]) {
      expect(evaluateCommand(c)).toMatchObject({ allowed: false })
    }
  })

  it('env 前缀剥离：VAR=x git push 仍识别为 push 并默认拦截（漏拦回归）', () => {
    expect(gitSubcommand('FOO=bar git push origin main')).toBe('push')
    expect(gitSubcommand('env git status')).toBe('status')
    expect(evaluateCommand('FOO=bar git push origin main')).toMatchObject({ allowed: false, rule: 'publish' })
    expect(evaluateCommand('env MODELRDOCK_ALLOW_RELEASE=0 git push origin main')).toMatchObject({ allowed: false })
    expect(evaluateCommand('MODELRDOCK_ALLOW_RELEASE=0 git push origin main')).toMatchObject({ allowed: false })
  })

  it('git tag -l / --list 只读放行', () => {
    expect(evaluateCommand('git tag -l').allowed).toBe(true)
    expect(evaluateCommand('git tag --list "v*"').allowed).toBe(true)
  })

  it('受保护端口：kill/stop 拦、启动监听拦', () => {
    expect(evaluateCommand('kill -9 $(lsof -t -i :8687)')).toMatchObject({ allowed: false, rule: 'port' })
    expect(evaluateCommand('pkill -f "gateway --port 8890"')).toMatchObject({ allowed: false, rule: 'port' })
    expect(evaluateCommand('taskkill /pid 123 /F  # 8687 gateway')).toMatchObject({ allowed: false, rule: 'port' })
    expect(evaluateCommand('gateway stop 8890')).toMatchObject({ allowed: false, rule: 'port' })
    expect(evaluateCommand('node src/cli.ts --sea-gateway --port 8687')).toMatchObject({ allowed: false, rule: 'port' })
  })

  it('只读探查与普通测试端口放行', () => {
    expect(evaluateCommand('lsof -nP -iTCP:8687 -sTCP:LISTEN').allowed).toBe(true)
    expect(evaluateCommand('gateway status').allowed).toBe(true)
    expect(evaluateCommand('gateway logs 8687').allowed).toBe(true)
    expect(evaluateCommand('node src/cli.ts --port 18990').allowed).toBe(true)
    expect(evaluateCommand('npm test').allowed).toBe(true)
    expect(evaluateCommand('git add -A && git commit -m fix').allowed).toBe(true)
  })

  it('空命令放行；gitSubcommand 兼容带值 flag', () => {
    expect(evaluateCommand('').allowed).toBe(true)
    expect(gitSubcommand('git -C /repo log --oneline')).toBe('log')
    expect(gitSubcommand('git -c a=b commit -m x')).toBe('commit')
    expect(gitSubcommand('npm test')).toBeNull()
  })
})

describe('policy.mjs > 基准分支直改（evaluateBranchEdit）', () => {
  const base = { branch: 'develop', repoRoot: '/repo', fileRoot: '/repo' }

  it('基准分支直改本仓库文件 → 拒绝', () => {
    expect(evaluateBranchEdit(base).allowed).toBe(false)
    expect(evaluateBranchEdit({ ...base, branch: 'main' }).allowed).toBe(false)
  })

  it('develop 上纯文档直改 → 放行；代码 → 拒绝', () => {
    expect(evaluateBranchEdit({ ...base, filePath: '/repo/CHANGELOG.md' }).allowed).toBe(true)
    expect(evaluateBranchEdit({ ...base, filePath: '/repo/docs/usage.md' }).allowed).toBe(true)
    expect(evaluateBranchEdit({ ...base, filePath: '/repo/src/cli.ts' }).allowed).toBe(false)
  })

  it('develop 上非源代码类文档（md/markdown/txt/rst/adoc）放行；带执行语义的配置仍拦', () => {
    for (const ext of ['md', 'markdown', 'txt', 'rst', 'adoc']) {
      expect(evaluateBranchEdit({ ...base, filePath: `/repo/docs/guide.${ext}` }).allowed).toBe(true)
    }
    // CI 工作流 / hook 注册 / 包清单带执行语义，不算文档
    expect(evaluateBranchEdit({ ...base, filePath: '/repo/.github/workflows/release.yml' }).allowed).toBe(false)
    expect(evaluateBranchEdit({ ...base, filePath: '/repo/.zcode/config.json' }).allowed).toBe(false)
    expect(evaluateBranchEdit({ ...base, filePath: '/repo/package.json' }).allowed).toBe(false)
  })

  it('main 上一律拦截（文档也不例外，分支卫生规则）', () => {
    expect(evaluateBranchEdit({ ...base, branch: 'main', filePath: '/repo/CHANGELOG.md' }).allowed).toBe(false)
    expect(evaluateBranchEdit({ ...base, branch: 'main', filePath: '/repo/README.md' }).allowed).toBe(false)
  })

  it('非基准分支 / 文件不在 git 仓库 / 独立 worktree → 放行', () => {
    expect(evaluateBranchEdit({ ...base, branch: 'feature/x' }).allowed).toBe(true)
    expect(evaluateBranchEdit({ ...base, fileRoot: '' }).allowed).toBe(true)
    expect(evaluateBranchEdit({ ...base, fileRoot: '/repo/.agents/worktrees/t1' }).allowed).toBe(true)
  })

  it('只比 git 产出的 repoRoot/fileRoot：8.3 短名形式的 filePath 不参与比对（Windows CI 回归）', () => {
    // CI 现场：TEMP 是短名 C:\Users\RUNNER~1\...（filePath 随之短名），两个 root 都来自
    // git——git -C 短名目录也稳定输出长名 runneradmin，两 root 同形相等 → 拦截
    expect(
      evaluateBranchEdit({
        branch: 'develop',
        repoRoot: 'C:\\Users\\runneradmin\\AppData\\Local\\Temp\\guard-dev-X',
        fileRoot: 'C:\\Users\\runneradmin\\AppData\\Local\\Temp\\guard-dev-X',
      }).allowed,
    ).toBe(false)
  })

  it('Windows 反斜杠与大小写差异下判断一致（路径归一化）', () => {
    expect(evaluateBranchEdit({ branch: 'develop', repoRoot: 'C:\\repo', fileRoot: 'C:/repo' }).allowed).toBe(false)
  })

  it('CMakeLists.txt 是构建配置不是文档：基准分支直改拦（.txt 后缀误放回归）', () => {
    expect(evaluateBranchEdit({ branch: 'develop', repoRoot: '/repo', fileRoot: '/repo', filePath: '/repo/mock_core/CMakeLists.txt' }).allowed).toBe(false)
    expect(evaluateBranchEdit({ branch: 'develop', repoRoot: '/repo', fileRoot: '/repo', filePath: '/repo/notes.txt' }).allowed).toBe(true)
  })

  it('baseBranches 显式清单（develop+master）：master 全拦、develop 文档放行代码拦', () => {
    const cfg = { baseBranches: ['develop', 'master'], baseBranch: 'develop' }
    expect(evaluateBranchEdit({ branch: 'master', repoRoot: '/repo', fileRoot: '/repo', filePath: '/repo/a.ts' }, cfg).allowed).toBe(false)
    expect(evaluateBranchEdit({ branch: 'master', repoRoot: '/repo', fileRoot: '/repo', filePath: '/repo/a.md' }, cfg).allowed).toBe(false)
    expect(evaluateBranchEdit({ branch: 'develop', repoRoot: '/repo', fileRoot: '/repo', filePath: '/repo/a.md' }, cfg).allowed).toBe(true)
    expect(evaluateBranchEdit({ branch: 'develop', repoRoot: '/repo', fileRoot: '/repo', filePath: '/repo/a.ts' }, cfg).allowed).toBe(false)
  })

  it('合并目标永远受保护：baseBranches 漏列 baseBranch 时自动补上（防误配置漏拦）', () => {
    const cfg = { baseBranches: ['master'], baseBranch: 'develop' }
    expect(evaluateBranchEdit({ branch: 'develop', repoRoot: '/repo', fileRoot: '/repo', filePath: '/repo/a.ts' }, cfg).allowed).toBe(false)
  })
})

describe('policy.mjs > 改动分级（classifyChange，Phase 2 自动合并裁决原语）', () => {
  it('L0：纯文档/测试', () => {
    expect(classifyChange(['CHANGELOG.md', 'docs/x.md', 'test/a.test.ts', 'README.md'])).toMatchObject({ level: 'L0' })
  })

  it('L1：普通 src 改动', () => {
    expect(classifyChange(['src/presets/data.ts'])).toMatchObject({ level: 'L1' })
    expect(classifyChange(['src/adapters/registry.ts', 'test/a.test.ts'])).toMatchObject({ level: 'L1' })
  })

  it('L2：核心路径 / package.json / 未识别文件（保守归高）', () => {
    for (const f of corePaths().slice(0, 3)) expect(classifyChange([f]).level).toBe('L2')
    expect(classifyChange(['package.json']).level).toBe('L2')
    expect(classifyChange(['some/unknown/file.xyz']).level).toBe('L2')
  })

  it('corePaths 可显式注入（repoRoot 锚定场景），不依赖脚本锚定配置', () => {
    expect(classifyChange(['core/heart.ts'], { corePaths: ['core/heart.ts'], releasePaths: [] }).level).toBe('L2')
    expect(classifyChange(['src/cli.ts'], { corePaths: [], releasePaths: [] }).level).toBe('L1') // 注入空配置 → 当普通 src
  })

  it('L3：发布流水线', () => {
    expect(classifyChange(['.github/workflows/release.yml']).level).toBe('L3')
    expect(classifyChange(['scripts/build-sea.mjs']).level).toBe('L3')
  })

  it('取最高级：文档改动混入核心路径 → L2', () => {
    expect(classifyChange(['CHANGELOG.md', 'src/cli.ts'])).toMatchObject({ level: 'L2' })
    expect(classifyChange(['docs/a.md', 'src/gateway/relay.ts']).level).toBe('L2')
  })

  it('空改动 L0', () => {
    expect(classifyChange([]).level).toBe('L0')
  })
})

describe('policy.mjs > 拦截审计（append-only，尽力而为）', () => {
  it('写入与读取；半行容错', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-audit-'))
    const file = path.join(dir, 'audit.jsonl')
    setAuditFile(file)
    try {
      for (let i = 0; i < 5; i++) audit({ hook: 'guard-develop', tool: 'Edit', decision: 'blocked', reason: '基准分支直改', target: `/repo/f${i}.ts` })
      const events = readAudit(file)
      expect(events).toHaveLength(5)
      expect(events[0]).toMatchObject({ hook: 'guard-develop', decision: 'blocked' })
      expect(events[0].ts).toMatch(/^\d{4}-\d{2}-\d{2}T/)
      fs.appendFileSync(file, '{"broken') // 模拟崩溃半行
      expect(readAudit(file)).toHaveLength(5)
    } finally {
      setAuditFile(null)
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('审计失败不阻断（目录不可写时静默）', () => {
    // 禁用写权限的目录制造"审计必然失败"场景。绝不能用 /proc 下的路径：
    // Linux 内核对 procfs 的 mkdir 返回错误码与常规文件系统不同，
    // fs.mkdirSync(recursive) 会陷入 syscall 风暴死循环（CI 实测 worker
    // 20 分钟 stime 打满，Windows/macOS 无 /proc 而未暴露）。
    if (process.platform === 'win32') return // chmod 权限位在 Windows 不生效，跳过
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-ro-'))
    const noWrite = path.join(dir, 'no-write')
    fs.mkdirSync(noWrite)
    fs.chmodSync(noWrite, 0o500) // 移除写权限：在目录里建文件必 EACCES
    setAuditFile(path.join(noWrite, 'audit.jsonl'))
    try {
      expect(() => audit({ hook: 'x', tool: 'Bash', decision: 'blocked', reason: 'r', target: 't' })).not.toThrow()
    } finally {
      fs.chmodSync(noWrite, 0o700) // 恢复权限以便清理
      setAuditFile(null)
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
