// 规格驱动（spec 命令族）测试：三件套契约解析 / tasks 拆卡 / CLI 端到端（mock 后端）。

import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  buildSpecPrompt,
  parseSpecBlocks,
  SPEC_META_MARKER,
  REQUIREMENTS_MARKER,
  DESIGN_MARKER,
  TASKS_MARKER,
} from '../../.agents/scripts/orchestrator/prompt.mjs'
import { parseTasksDoc, renderTaskCard, buildSpecCards, writeSpec } from '../../.agents/scripts/orchestrator/spec.mjs'
import { SPEC_DIM_WEIGHTS, runSpecL0Checks, computeSpecVerdict } from '../../.agents/scripts/orchestrator/spec-review.mjs'
import { loadCard, queueRoot, ensureQueue } from '../../.agents/scripts/orchestrator/queue.mjs'
import { mkRepo, runOrch, tryOrch } from './helpers.js'

const FENCE = '```'

function specOutput() {
  return [
    '概述一句话。',
    '',
    `${FENCE}${SPEC_META_MARKER}`,
    'id: add-export',
    'title: 导出配置',
    `${FENCE}`,
    `${FENCE}${REQUIREMENTS_MARKER}`,
    '# 导出配置',
    '## 验收标准（EARS 式，可机器检查）',
    '- 当 运行 export，系统应当 写出 JSON。',
    `${FENCE}`,
    `${FENCE}${DESIGN_MARKER}`,
    '# 技术设计：导出配置',
    '## 方案',
    '新增 src/export.ts。',
    `${FENCE}`,
    `${FENCE}${TASKS_MARKER}`,
    '# 任务分解：导出配置',
    '## 任务 1:实现导出',
    '- 目标: 新增导出命令',
    '- 文件: src/export.ts, test/export.test.ts',
    '- 完成条件: export 命令端到端可用',
    '- 依赖: 无',
    `${FENCE}`,
  ].join('\n')
}

describe('orchestrator spec > prompt 构建与解析', () => {
  it('spec prompt 含意图、AGENTS.md、四契约模板与硬性要求', () => {
    const p = buildSpecPrompt('支持配置导出', process.cwd())
    expect(p).toContain('支持配置导出')
    for (const m of [SPEC_META_MARKER, REQUIREMENTS_MARKER, DESIGN_MARKER, TASKS_MARKER]) expect(p).toContain(m)
    expect(p).toContain('EARS')
    expect(p).toContain('files_hint')
    expect(p).toContain('AGENTS.md 红线')
    // 红线经 reviewNotes 注入（可移植：不写死任何项目的端口/框架名）；缺省不展开
    expect(p).toContain('设计不得违反 AGENTS.md 红线；')
  })

  it('spec prompt 第三参数注入项目红线（workflow.json reviewNotes）', () => {
    const p = buildSpecPrompt('支持配置导出', process.cwd(), '受保护端口 7000、禁止手写锁文件')
    expect(p).toContain('设计不得违反 AGENTS.md 红线（受保护端口 7000、禁止手写锁文件）；')
  })

  it('spec prompt 缺省（industrialDesign=false）不含工业级设计增补块（回归红线）', () => {
    const p = buildSpecPrompt('支持配置导出', process.cwd())
    expect(p).not.toContain('工业级设计增补')
    expect(p).not.toContain('交互原型先行')
    expect(p).not.toContain('关路径四件套')
    // 显式 false 与缺省同态
    expect(buildSpecPrompt('支持配置导出', process.cwd(), '', '', false)).not.toContain('工业级设计增补')
  })

  it('spec prompt industrialDesign=true 末尾注入工业级设计增补块（五条逐字锚，钉死契约）', () => {
    const p = buildSpecPrompt('支持配置导出', process.cwd(), '', '', true)
    expect(p).toContain('# 工业级设计增补（spec.industrialDesign=true 生效）\n含 UI/交互面的设计必须满足以下五条，缺一即违反产出契约：\n')
    expect(p).toContain('1. 交互原型先行：design 必须附自包含 HTML 交互原型文件路径（原型放 specs/<id>/proto/ 下，不入库），覆盖全部状态：空态/加载态/错误态/成功态/关闭路径；原型未经船东批准前不得 spec build（人工闸执行）。')
    expect(p).toContain('2. 关路径四件套：每个弹层/页面 ≥1 显式关闭按钮（头部 × 或 foot 次行动「关闭/返回」）+ Esc + 遮罩点击 + 主行动完成自动关；四路缺一须在 design 说明取舍理由。')
    expect(p).toContain('3. 全状态覆盖：空态/加载态/错误态/成功态逐一设计并写进 tasks 的呈现层验收，不许只画理想态。')
    expect(p).toContain('4. 刷新策略：打开即拉取数据（数据陈旧可接受）；手动刷新只作次行动（图标化或与主行动并列），禁止孤儿刷新按钮（无主行动配对的独占刷新）。')
    expect(p).toContain('5. 呈现面论证（规约 §1.6 既有检查点）持续适用。')
    expect(p.trimEnd().endsWith('5. 呈现面论证（规约 §1.6 既有检查点）持续适用。')).toBe(true) // 末尾追加
  })

  it('本仓库 workflow.json 实际开启 spec.industrialDesign（船东 2026-11-22 授权）', () => {
    const wf = JSON.parse(fs.readFileSync(path.join(process.cwd(), '.agents', 'workflow.json'), 'utf8'))
    expect(wf.spec?.industrialDesign).toBe(true)
  })

  it('parseSpecBlocks：四块齐全解出 id/title；缺块或缺 meta 字段返回 null', () => {
    const parsed = parseSpecBlocks(specOutput())
    expect(parsed?.id).toBe('add-export')
    expect(parsed?.title).toBe('导出配置')
    expect(parsed?.design).toContain('src/export.ts')
    expect(parseSpecBlocks(specOutput().replace(`${FENCE}${DESIGN_MARKER}`, `${FENCE}unknown-marker`))).toBeNull()
    const noId = specOutput().replace('id: add-export', 'slug: add-export')
    expect(parseSpecBlocks(noId)).toBeNull()
    expect(parseSpecBlocks('没有契约块')).toBeNull()
  })
})

describe('orchestrator spec > 六维契约（integration 融入性）', () => {
  it('SPEC_DIM_WEIGHTS 六维含 integration:10 且合计 100', () => {
    expect(SPEC_DIM_WEIGHTS).toEqual({ completeness: 20, unambiguity: 20, consistency: 20, testability: 20, feasibility: 10, integration: 10 })
    expect(Object.values(SPEC_DIM_WEIGHTS).reduce((a: number, b: number) => a + b, 0)).toBe(100)
  })

  it('buildSpecPrompt design 模板含功能面盘点、融入位置论证与硬性要求第 7 条', () => {
    const p = buildSpecPrompt('支持配置导出', process.cwd())
    expect(p).toContain('### 代码事实')
    expect(p).toContain('### 用户可感知功能面')
    expect(p).toContain('### 融入位置论证')
    expect(p).toContain('7. 设计含新 UI 入口/新命令/新端点时，方案必须先引用「用户可感知功能面」盘点完成「融入位置论证」，缺失即违反产出契约；')
  })

  it('L0 融入性探针：design 缺节 → warn（report-only，不进 fail 集合）', () => {
    const repo = mkRepo()
    try {
      const id = 'integr-warn-spec'
      writeSpec(repo.root, {
        id,
        title: '缺融入性节',
        requirements: '# 需求\n\n- 作为用户，我希望 x。',
        design: '# 技术设计\n\n## 现状\n\n旧模板现状（fixture）。\n\n## 方案\n\n直接改（fixture）。',
        tasks: '## 任务 1:改 README\n- 目标: g\n- 文件: README.md\n- 完成条件: c\n- 依赖: 无\n',
      })
      const l0 = runSpecL0Checks(repo.root, id)
      const c = l0.checks.find((c: { name: string }) => c.name === '融入位置论证')
      expect(c?.status).toBe('warn')
      expect(c?.detail).toContain('用户可感知功能面')
      expect(c?.detail).toContain('融入位置论证')
      expect(l0.ok).toBe(true) // report-only：warn 不影响 ok，结构性 fail 才拦截
    } finally {
      repo.cleanup()
    }
  })

  it('六维 verdict 加权：integration 计入聚合，integration=null 传染 undetermined', () => {
    const dims = { completeness: 85, unambiguity: 80, consistency: 85, testability: 85, feasibility: 90, integration: 90 }
    const v = computeSpecVerdict({ dimensions: dims, findings: [], gates: { redlines: 'pass' }, fabricatedCount: 0 })
    expect(v.overall).toBe(85) // (85*20+80*20+85*20+85*20+90*10+90*10)/100 = 8500/100
    expect(v.build_ready).toBe('approve_to_build')
    const nulled = computeSpecVerdict({ dimensions: { ...dims, integration: null }, findings: [], gates: { redlines: 'pass' }, fabricatedCount: 0 })
    expect(nulled.overall).toBeNull()
    expect(nulled.build_ready).toBe('undetermined')
  })
})

describe('orchestrator spec > tasks 文档解析与拆卡渲染', () => {
  it('parseTasksDoc：任务段键值解析；文件逗号分隔；缺失兜底；无段返回空', () => {
    const tasks = parseTasksDoc('# 任务分解\n\n## 任务 1:实现导出\n- 目标: 新增导出\n- 文件: src/a.ts, test/a*.test.ts\n- 完成条件: 端到端可用\n- 依赖: 无\n\n## 任务 2:补文档\n- 目标: docs\n')
    expect(tasks).toHaveLength(2)
    expect(tasks[0]).toMatchObject({ n: 1, title: '实现导出', goal: '新增导出', files: ['src/a.ts', 'test/a*.test.ts'], done: '端到端可用', deps: '无' })
    expect(tasks[1].files).toEqual(['**']) // 文件行缺失 → 独占兜底
    expect(tasks[1].deps).toBe('无')
    expect(parseTasksDoc('# 没有任务段')).toEqual([])
  })

  it('renderTaskCard：复合 id、gate=L3、created_by=planner、spec 字段 + design 文件引用（30k argv 防爆）', () => {
    const spec = {
      dir: '/x',
      meta: { id: 'add-export', title: '导出配置', created_at: '2026-10-25T10:00:00+08:00' },
      requirements: '# 导出配置\n## 验收标准\n- 当 export 运行，系统应当写 JSON。',
      design: '# 技术设计\n## 方案\n新增 src/export.ts。',
      tasks: '# 任务分解',
    }
    const card = renderTaskCard(spec, { n: 1, title: '实现导出', goal: '新增导出命令', files: ['src/**'], done: '端到端可用', deps: '无' }, 2)
    const { meta } = loadCard(card, 't.md') // 渲染结果必须能通过卡校验
    expect(meta.id).toBe('add-export-t1')
    expect(meta.gate).toBe('L3')
    expect(meta.created_by).toBe('planner')
    expect(meta.files_hint).toEqual(['src/**'])
    expect(meta.spec).toBe('add-export') // 进度锚寻址键
    expect(card).toContain(`specs/${spec.meta.id}/`) // design 改文件引用（全文由 copySpecArtifacts 随 worktree 携带）
    expect(card).toContain('design.md')
    expect(card).toContain('requirements.md')
    expect(card).not.toContain('新增 src/export.ts。') // 全文不再随卡注入
    expect(card).toContain('任务 1/2')
  })

  it('renderTaskCard gate 参数化：显式 L1 生效（预授权 specAutoBuild 拆卡）；白名单外值回落 L3', () => {
    const spec = {
      dir: '/x',
      meta: { id: 'add-export', title: '导出配置', created_at: '2026-10-25T10:00:00+08:00' },
      requirements: '# 导出配置\n## 验收标准\n- 当 export 运行，系统应当写 JSON。',
      design: '# 技术设计\n## 方案\n新增 src/export.ts。',
      tasks: '# 任务分解',
    }
    const task = { n: 1, title: '实现导出', goal: '新增导出命令', files: ['src/**'], done: '端到端可用', deps: '无' }
    expect(loadCard(renderTaskCard(spec, task, 1, 'L1'), 't.md').meta.gate).toBe('L1')
    // 宁严勿松：只有 'L1' 允许降档，其余一律回落 L3（手动 build 行为不变）
    expect(loadCard(renderTaskCard(spec, task, 1, 'L2'), 't.md').meta.gate).toBe('L3')
    expect(loadCard(renderTaskCard(spec, task, 1, undefined), 't.md').meta.gate).toBe('L3')
  })

  it('buildSpecCards opts.gate：自动拆卡传 L1 进 pending；缺省保持 L3（手动 build 不变）', () => {
    const repo = mkRepo()
    try {
      const specId = 'gatespec'
      const dir = path.join(repo.root, '.agents', 'orchestrator', 'specs', specId)
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ id: specId, title: 'gate 参数', created_at: '2026-10-01T10:00:00+08:00' }))
      fs.writeFileSync(path.join(dir, 'requirements.md'), 'r')
      fs.writeFileSync(path.join(dir, 'design.md'), 'd')
      fs.writeFileSync(path.join(dir, 'tasks.md'), '## 任务 1:写文档\n- 目标: g\n- 文件: docs/**\n- 完成条件: c\n- 依赖: 无\n')
      const root = queueRoot(repo.root)
      ensureQueue(root)
      buildSpecCards(repo.root, root, specId, { gate: 'L1' })
      expect(loadCard(fs.readFileSync(path.join(root, 'pending', `${specId}-t1.md`), 'utf8'), 't.md').meta.gate).toBe('L1')
      fs.rmSync(path.join(root, 'pending', `${specId}-t1.md`))
      buildSpecCards(repo.root, root, specId) // 手动 build 形态：不传 gate
      expect(loadCard(fs.readFileSync(path.join(root, 'pending', `${specId}-t1.md`), 'utf8'), 't.md').meta.gate).toBe('L3')
    } finally {
      repo.cleanup()
    }
  })
})

describe('orchestrator spec > CLI 端到端（mock 后端）', () => {
  const SPEC_ID = 'add-export-command'

  function listPending(repo: string): string[] {
    const dir = path.join(repo, '.agents', 'orchestrator', 'queue', 'pending')
    return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)) : []
  }

  it('spec "意图" → 三件套落盘；spec build → 任务卡进 pending（合法卡 + design 注入）；重复 build 幂等', () => {
    const repo = mkRepo()
    try {
      const out = runOrch(repo.root, `spec "add export command" --backend mock`)
      expect(out.stdout).toContain('规格三件套已生成')
      const dir = path.join(repo.root, '.agents', 'orchestrator', 'specs', SPEC_ID)
      for (const f of ['meta.json', 'requirements.md', 'design.md', 'tasks.md']) {
        expect(fs.existsSync(path.join(dir, f))).toBe(true)
      }
      expect(JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')).id).toBe(SPEC_ID)
      expect(listPending(repo.root)).toHaveLength(0) // 不自动进队列

      const build = runOrch(repo.root, `spec build ${SPEC_ID}`)
      expect(build.stdout).toContain(`已生成任务卡：pending/${SPEC_ID}-t1.md`)
      const pending = listPending(repo.root)
      expect(pending).toEqual([`${SPEC_ID}-t1`, `${SPEC_ID}-t2`])
      const card1 = fs.readFileSync(path.join(repo.root, '.agents', 'orchestrator', 'queue', 'pending', `${SPEC_ID}-t1.md`), 'utf8')
      expect(() => loadCard(card1, 't.md')).not.toThrow()
      expect(card1).toContain(`specs/${SPEC_ID}/design.md`) // design 文件引用（全文随 worktree 拷贝，不随卡）
      expect(card1).not.toContain('mock 设计方案')
      expect(JSON.parse(fs.readFileSync(path.join(repo.root, '.agents', 'orchestrator', 'specs', SPEC_ID, 'progress.json'), 'utf8')).tasks).toHaveLength(2) // 全局进度锚落盘
      expect(card1).toContain('依赖：无')
      const card2 = fs.readFileSync(path.join(repo.root, '.agents', 'orchestrator', 'queue', 'pending', `${SPEC_ID}-t2.md`), 'utf8')
      expect(card2).toContain('依赖：任务 1')

      const again = runOrch(repo.root, `spec build ${SPEC_ID}`)
      expect(again.stdout).toContain('已存在，跳过')
      expect(listPending(repo.root)).toHaveLength(2)
    } finally {
      repo.cleanup()
    }
  })

  it('spec list / show 浏览；build 不存在的 id 与非法输出可操作报错', () => {
    const repo = mkRepo()
    try {
      const none = runOrch(repo.root, 'spec list')
      expect(none.stdout).toContain('尚无规格')
      expect(tryOrch(repo.root, 'spec build no-such').stderr).toContain('不存在')
      runOrch(repo.root, 'spec "add export command" --backend mock')
      expect(runOrch(repo.root, 'spec list').stdout).toContain(SPEC_ID)
      const show = runOrch(repo.root, `spec show ${SPEC_ID}`)
      expect(show.stdout).toContain('任务 1: 写文档')
      expect(show.stdout).toContain('任务 2: 补测试说明')

      const invalid = tryOrch(repo.root, 'spec "broken spec" --backend mock', { ORCH_MOCK_PLANNER_INVALID: '1' })
      expect(invalid.status).not.toBe(0)
      expect(invalid.stderr).toContain('均未产出三件套契约块')
    } finally {
      repo.cleanup()
    }
  })
})
