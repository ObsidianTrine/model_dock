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
import { parseTasksDoc, renderTaskCard } from '../../.agents/scripts/orchestrator/spec.mjs'
import { loadCard } from '../../.agents/scripts/orchestrator/queue.mjs'
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
