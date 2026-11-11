import { describe, expect, it } from 'vitest'
import {
  ORCH_SMOKE_FILES,
  ORCH_SMOKE_EXCLUDED,
  CONTRACT_ORCH_TESTS,
  classifyFile,
  classifyFiles,
  isDocsOnlySet,
  contractExtras,
  buildPlan,
  matchRule,
  dedup,
  parseArgs,
} from '../scripts/test-gate.mjs'

// 纯函数单测：夹具全部用文件列表字符串，不起子进程、不跑真 vitest、无临时目录。

describe('matchRule 归属表规则匹配', () => {
  it('dir/** 目录递归，不吞同级近名目录', () => {
    expect(matchRule('docs/**', 'docs/usage.md')).toBe(true)
    expect(matchRule('.agents/**', '.agents/scripts/orchestrator/cost.mjs')).toBe(true)
    expect(matchRule('docs/**', 'docsx/usage.md')).toBe(false)
  })

  it('test/*.test.ts 仅顶层，不吃子目录', () => {
    expect(matchRule('test/*.test.ts', 'test/foo.test.ts')).toBe(true)
    expect(matchRule('test/*.test.ts', 'test/orchestrator/foo.test.ts')).toBe(false)
    expect(matchRule('test/*.test.ts', 'test/helpers.ts')).toBe(false)
  })

  it('prefix* 前缀形态限根级/单层', () => {
    expect(matchRule('README*', 'README.md')).toBe(true)
    expect(matchRule('README*', 'docs/README.md')).toBe(false)
    expect(matchRule('eslint.config.*', 'eslint.config.mjs')).toBe(true)
  })

  it('精确路径不含子路径', () => {
    expect(matchRule('src/cli.ts', 'src/cli.ts')).toBe(true)
    expect(matchRule('src/cli.ts', 'src/cli/basic.ts')).toBe(false)
  })

  it('Windows 反斜杠归一后匹配', () => {
    expect(matchRule('src/**', 'src\\cli.ts')).toBe(true)
    expect(matchRule('test\\orchestrator/**', 'test/orchestrator/x.test.ts')).toBe(true)
  })
})

describe('classifyFiles 域归属', () => {
  it('抽验：产品域', () => {
    expect(classifyFile('src/cli.ts')).toBe('product')
    expect(classifyFile('test/foo.test.ts')).toBe('product')
    expect(classifyFile('test/helpers.ts')).toBe('product')
    expect(classifyFile('test/helpers/x.ts')).toBe('product')
    expect(classifyFile('test/mocks/x.ts')).toBe('product')
    expect(classifyFile('test/setup-fast-kdf.ts')).toBe('product')
    expect(classifyFile('scripts/release-check.mjs')).toBe('product')
    expect(classifyFile('docs/usage.md')).toBe('product')
    expect(classifyFile('README.md')).toBe('product')
    expect(classifyFile('CHANGELOG.md')).toBe('product')
    expect(classifyFile('eslint-baseline.json')).toBe('product')
  })

  it('抽验：编排域', () => {
    expect(classifyFile('.agents/scripts/orchestrator/notify.mjs')).toBe('dockmaster')
    expect(classifyFile('.agents/workflows/docs-sync.md')).toBe('dockmaster')
    expect(classifyFile('.agents/workflow.json')).toBe('dockmaster') // 不在双域名单——契约联动依赖此归类
    expect(classifyFile('test/orchestrator/helpers.ts')).toBe('dockmaster')
    expect(classifyFile('test/orchestrator/foo.test.ts')).toBe('dockmaster') // 顶层 test/*.test.ts 不吞嵌套
  })

  it('抽验：双域（显式名单 + 未匹配非文档兜底）与未匹配 .md 文档桶', () => {
    expect(classifyFile('package.json')).toBe('dual')
    expect(classifyFile('package-lock.json')).toBe('dual')
    expect(classifyFile('tsconfig.test.json')).toBe('dual')
    expect(classifyFile('vitest.config.ts')).toBe('dual')
    expect(classifyFile('vitest.workflow.config.ts')).toBe('dual')
    expect(classifyFile('.github/workflows/test.yml')).toBe('dual')
    expect(classifyFile('AGENTS.md')).toBe('dual')
    expect(classifyFile('foo.xyz')).toBe('dual') // 未匹配非文档 → 双域保守
    expect(classifyFile('TODOLists.md')).toBe('docs') // 未匹配 .md → 文档桶（路由惰性）
  })

  it('归类分桶与入参去重', () => {
    const cls = classifyFiles(['src/a.ts', 'src/a.ts', '.agents/x.mjs', 'package.json'])
    expect(cls.product).toEqual(['src/a.ts'])
    expect(cls.dockmaster).toEqual(['.agents/x.mjs'])
    expect(cls.dual).toEqual(['package.json'])
  })
})

describe('isDocsOnlySet 纯文档判定', () => {
  it('全 .md 且不触双域名单 → true（含未匹配 .md 文档桶）', () => {
    expect(isDocsOnlySet(['docs/usage.md'])).toBe(true)
    expect(isDocsOnlySet(['README.md', 'CHANGELOG.md'])).toBe(true)
    expect(isDocsOnlySet(['.agents/workflows/docs-sync.md'])).toBe(true)
    expect(isDocsOnlySet(['TODOLists.md', 'docs/usage.md'])).toBe(true)
  })

  it('混入代码 / 双域文件 / 空集 → false', () => {
    expect(isDocsOnlySet(['docs/a.md', 'src/x.ts'])).toBe(false)
    expect(isDocsOnlySet(['AGENTS.md'])).toBe(false) // 双域名单
    expect(isDocsOnlySet(['docs/a.md', 'foo.xyz'])).toBe(false) // 未匹配非文档兜底双域
    expect(isDocsOnlySet([])).toBe(false)
  })
})

describe('冒烟子集不变量', () => {
  it('不含硬排除的四个慢件（实测 sail 280s / sail-autodim 117s / integration 62s / drift 47s）', () => {
    const excluded = ORCH_SMOKE_FILES.filter((f: string) => ORCH_SMOKE_EXCLUDED.includes(f))
    expect(excluded).toEqual([])
  })

  it('不含已知长 sleep 与并行偶发红文件', () => {
    const banned = [
      'test/orchestrator/autoapprove.test.ts',
      'test/orchestrator/notify-digest.test.ts',
      'test/orchestrator/reviewing-recovery.test.ts',
    ]
    expect(ORCH_SMOKE_FILES.filter((f: string) => banned.includes(f))).toEqual([])
  })

  it('数量 ≤12 且均为编排套件顶层文件、无重复', () => {
    expect(ORCH_SMOKE_FILES.length).toBeLessThanOrEqual(12)
    expect(ORCH_SMOKE_FILES.length).toBeGreaterThan(0)
    expect(dedup(ORCH_SMOKE_FILES).length).toBe(ORCH_SMOKE_FILES.length)
    for (const f of ORCH_SMOKE_FILES) expect(f).toMatch(/^test\/orchestrator\/[^/]+\.test\.ts$/)
  })
})

describe('contractExtras 跨域契约联动', () => {
  it('计费面文件 → 编排侧追加三支计费用例', () => {
    for (const trigger of [
      'src/gateway/usage.ts',
      'src/gateway/server.ts',
      'src/gateway/state.ts',
      'src/providers/pricing-core.ts',
      '.agents/scripts/orchestrator/cost.mjs',
      '.agents/scripts/orchestrator/budget.mjs',
    ]) {
      const ext = contractExtras([trigger])
      expect(ext.orch).toEqual(CONTRACT_ORCH_TESTS)
      expect(ext.product).toEqual([])
    }
  })

  it('ui-kit.md → 产品侧追加 ui-lint；workflow.json → 产品侧追加 pr-risk-tier', () => {
    expect(contractExtras(['.agents/conventions/ui-kit.md']).product).toEqual(['test/ui-lint.test.ts'])
    expect(contractExtras(['.agents/workflow.json']).product).toEqual(['test/pr-risk-tier.test.ts'])
  })

  it('无关文件零追加；多触发去重合并', () => {
    expect(contractExtras(['src/cli.ts', 'test/foo.test.ts'])).toMatchObject({ orch: [], product: [] })
    const both = contractExtras(['.agents/conventions/ui-kit.md', '.agents/workflow.json'])
    expect(both.product).toEqual(['test/ui-lint.test.ts', 'test/pr-risk-tier.test.ts'])
  })
})

describe('buildPlan 路由', () => {
  const kindsOf = (plan: { actions: { kind: string }[] }) => plan.actions.map((a) => a.kind)

  it('纯 src diff → 产品域全量单段', () => {
    const plan = buildPlan(['src/gateway/relay.ts'])
    expect(plan.mode).toBe('product')
    expect(kindsOf(plan)).toEqual(['npm-test'])
    expect(plan.modeLabel).toContain('产品')
  })

  it('纯 .agents diff → 编排域冒烟单段（子集整装）', () => {
    const plan = buildPlan(['.agents/scripts/feature-branch.mjs'])
    expect(plan.mode).toBe('orch')
    expect(kindsOf(plan)).toEqual(['orch-smoke'])
    const smoke = plan.actions[0]
    expect(smoke.files).toEqual(ORCH_SMOKE_FILES)
  })

  it('混合 diff → 双段（npm-test + 编排冒烟），标签含「混合域：产品全量 + 编排冒烟」', () => {
    const plan = buildPlan(['src/cli.ts', '.agents/scripts/orchestrator/scan.mjs'])
    expect(plan.mode).toBe('mixed')
    expect(kindsOf(plan)).toEqual(['npm-test', 'orch-smoke'])
    expect(plan.modeLabel).toBe('混合域：产品全量 + 编排冒烟')
  })

  it('双域文件（package.json）→ 双段保守', () => {
    const plan = buildPlan(['package.json'])
    expect(plan.mode).toBe('mixed')
    expect(kindsOf(plan)).toEqual(['npm-test', 'orch-smoke'])
  })

  it('纯 .md diff → docs-lint 单段', () => {
    const plan = buildPlan(['docs/usage.md', 'README.md'])
    expect(plan.mode).toBe('docs')
    expect(kindsOf(plan)).toEqual(['docs-lint'])
    expect(plan.docsOnly).toBe(true)
  })

  it('ui-kit.md 单独变更 → docs-lint + 产品契约定点（ui-lint），不触发编排冒烟', () => {
    const plan = buildPlan(['.agents/conventions/ui-kit.md'])
    expect(plan.mode).toBe('docs')
    expect(kindsOf(plan)).toEqual(['docs-lint', 'product-files'])
    expect(plan.actions[1].files).toEqual(['test/ui-lint.test.ts'])
  })

  it('workflow.json 单独变更 → 产品契约定点（pr-risk-tier）+ 编排冒烟（产品侧段恒在前）', () => {
    const plan = buildPlan(['.agents/workflow.json'])
    expect(plan.mode).toBe('mixed')
    expect(kindsOf(plan)).toEqual(['product-files', 'orch-smoke'])
    expect(plan.actions[0].files).toEqual(['test/pr-risk-tier.test.ts'])
  })

  it('产品侧计费面触发（无编排域文件）→ 产品全量 + 仅契约用例的编排段', () => {
    const plan = buildPlan(['src/gateway/usage.ts'])
    expect(plan.mode).toBe('mixed')
    expect(kindsOf(plan)).toEqual(['npm-test', 'orch-smoke'])
    expect(plan.actions[1].files).toEqual(CONTRACT_ORCH_TESTS) // hasOrch=false：只跑契约三支
  })

  it('编排侧计费面触发 → 冒烟子集含契约三支且各仅一份（去重）', () => {
    const plan = buildPlan(['.agents/scripts/orchestrator/cost.mjs'])
    const smoke = plan.actions.find((a: { kind: string }) => a.kind === 'orch-smoke')
    for (const f of CONTRACT_ORCH_TESTS) {
      expect(smoke.files.filter((x: string) => x === f).length).toBe(1)
    }
    expect(smoke.addedCount).toBe(0) // 三支已在冒烟子集内
  })

  it('空变更集 → none；--full 强制双套件全量；conservative 保守双域', () => {
    const empty = buildPlan([])
    expect(empty.mode).toBe('none')
    expect(empty.actions).toEqual([])

    const full = buildPlan(['src/cli.ts'], { full: true })
    expect(full.mode).toBe('full')
    expect(kindsOf(full)).toEqual(['npm-test', 'orch-full'])

    const cons = buildPlan([], { conservative: true })
    expect(cons.mode).toBe('mixed')
    expect(kindsOf(cons)).toEqual(['npm-test', 'orch-smoke'])
    expect(cons.actions[1].files).toEqual(ORCH_SMOKE_FILES)
  })

  it('未匹配 .md（文档桶）并入纯文档集 → docs-lint；未匹配非文档仍保守双段', () => {
    const docs = buildPlan(['docs/usage.md', 'TODOLists.md'])
    expect(docs.mode).toBe('docs')
    expect(kindsOf(docs)).toEqual(['docs-lint'])

    const cons = buildPlan(['src/x.ts', '.gitignore']) // .gitignore 未匹配非文档 → 双域
    expect(cons.mode).toBe('mixed')
    expect(kindsOf(cons)).toEqual(['npm-test', 'orch-smoke'])
  })
})

describe('parseArgs 旗标解析', () => {
  it('缺省值与组合', () => {
    expect(parseArgs([])).toMatchObject({ base: null, head: 'HEAD', staged: false, dry: false, full: false })
    expect(parseArgs(['--dry', '--full'])).toMatchObject({ dry: true, full: true })
    expect(parseArgs(['--base', 'abc~1'])).toMatchObject({ base: 'abc~1' })
    expect(parseArgs(['--base=abc'])).toMatchObject({ base: 'abc' })
    expect(parseArgs(['--head', 'abc'])).toMatchObject({ head: 'abc' })
    expect(parseArgs(['--staged'])).toMatchObject({ staged: true })
  })

  it('非法输入给可操作报错', () => {
    expect(() => parseArgs(['--wat'])).toThrow(/未知参数/)
    expect(() => parseArgs(['--base'])).toThrow(/--base 需要/)
    expect(() => parseArgs(['--staged', '--base', 'x'])).toThrow(/互斥/)
  })
})
