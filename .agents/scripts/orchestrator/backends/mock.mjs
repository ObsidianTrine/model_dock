// mock.mjs — 假后端：秒级、零外部调用、行为可由环境变量注入，专门服务
// orchestrator 自身的集成测试（docs 5.5）。不做任何真模型调用。
//
// 行为注入（集成测试在子进程里通过 env 控制）：
//   ORCH_MOCK_WORKER_STATUS=done|stuck   worker 结果块的状态（默认 done）
//   ORCH_MOCK_REVIEW_BLOCKERS=<n>        reviewer 输出的阻塞项数（默认 0）
//   ORCH_MOCK_REVIEW_FUZZY=1             L2 复核额外注入轻度转述 + 编造 claim 各一条
//                                        （verifyClaimVerbatim fuzzy 两级制的 e2e 用）
//   ORCH_MOCK_SPAWN_ERROR=1              spawn 直接抛错（测 cmdRun 异常兜底落 blocked）
//   ORCH_MOCK_TRANSIENT=1                worker 中途死亡：无结果块 + 瞬时签名 stderr
//                                        （走 isTransientWorkerFailure 原地退避重试路径，
//                                        配合 ORCH_RETRY_WAIT_MS 收缩等待）
//   ORCH_MOCK_NO_COMMIT=1                worker 写文件但不 git commit（测 xte no_commit 偏航）
//   ORCH_MOCK_RESEARCH_STDERR=1          researcher 会话附带 unrecognized_model 签名 stderrTail
//                                        （配 ORCH_MOCK_PLANNER_INVALID=1 测 research die 文案带
//                                        stderr 摘要路径；复刻真实 claude CLI 死法）
//   ORCH_MOCK_RESEARCH_FAIL_DIM=<子串>   调研问题含该子串的 researcher 会话输出无契约块
//                                        （research multi 单维失败隔离：按维度点名失败）
//   ORCH_MOCK_DIMS_SPLIT=one|invalid     拆维规划会话（sail researchAutoDim）注入：
//                                        one=只给 1 维（不足 2 维 → 调用方降级单 brief）、
//                                        invalid=无围栏无维度行（解析失败同降级）；缺省正常
//                                        输出 3 维
//   ORCH_MOCK_PLANNER_RESEARCH=<id>      feature 卡 research 行写该值（缺省 todo）——sail
//                                        autoDim 续接路径 e2e 用（planner 引用既有 brief/topic）
//   ORCH_MOCK_PLANNER_FEATURE_COUNT=<n>  feature 模式产 n 张卡（id 后缀 -2…-n，缺省 1 张）——
//                                        researchPerCycle cap 的「multi 计 1」断言用//   ORCH_MOCK_REVIEW_PARAPHRASE=1        L2 复核每次都改写复述 claim（非逐字 → fabricated；
//                                        测逐字重试仍败 → 降级保留链路）
//   ORCH_MOCK_REVIEW_PARAPHRASE_ONCE=1   仅本子进程第一次复核改写、重试后逐字（测重试恢复；
//                                        模块级计数器，runOrch 每次新子进程天然复位——
//                                        勿在同进程直接 import mock 断言次数）
// prompt 里含 "REVIEW_SUMMARY" 时按 reviewer 行为输出，否则按 worker 行为。
// worker 会话收尾发一条 budget_snapshot（与真实后端同契约：zcode 也是会话结束才回填
// usage）——cmdRun 靠它给 Budget 记账，token 熔断/低油量告警的集成测试因此可用 mock。

import fs from 'node:fs';
import path from 'node:path';
import { CARD_MARKER, RESULT_MARKER, SPEC_META_MARKER, REQUIREMENTS_MARKER, DESIGN_MARKER, TASKS_MARKER, BRIEF_MARKER, VERDICT_MARKER, ARBITRATION_MARKER, SPECVERDICT_MARKER, DIMS_SPLIT_MARKER } from '../prompt.mjs';

// L2 复核会话计数（PARAPHRASE_ONCE 用）：本子进程内第一次改写、重试后逐字。
// 模块级变量——runOrch 每次新子进程天然复位；测试不得在同进程 import mock 断言次数。
let verifierCall = 0;
const paraphraseOnce = process.env.ORCH_MOCK_REVIEW_PARAPHRASE_ONCE === '1';

export const mockBackend = {
  name: 'mock',
  async spawn({ promptFile, cwd, onEvent, readonly }) {
    // ORCH_MOCK_SPAWN_ERROR：模拟 claude CLI 缺失/启动失败（backend.spawn reject）
    if (process.env.ORCH_MOCK_SPAWN_ERROR === '1') {
      throw new Error('mock: spawn 注入失败（ORCH_MOCK_SPAWN_ERROR=1，模拟 claude CLI 不可用）');
    }
    // ORCH_MOCK_DELAY_MS：模拟慢 worker（并发调度测试观测"同时在跑"用）
    const delay = parseInt(process.env.ORCH_MOCK_DELAY_MS ?? '0', 10) || 0;
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    const prompt = fs.readFileSync(promptFile, 'utf8');
    const isReviewer = prompt.includes('REVIEW_SUMMARY');
    const isSpecPlanner = prompt.includes(SPEC_META_MARKER);
    const isSpecReviewer = !isSpecPlanner && !isReviewer && prompt.includes(SPECVERDICT_MARKER); // spec 三件套审查船（cmdSpecReview）
    const isPlanner = !isSpecPlanner && !isSpecReviewer && prompt.includes(CARD_MARKER);
    const isArbiter = !isSpecPlanner && !isSpecReviewer && !isPlanner && prompt.includes(ARBITRATION_MARKER); // 仲裁轮：无 VERDICT/BRIEF 标记，与复核/调研互斥
    const isVerifier = !isSpecPlanner && !isSpecReviewer && !isPlanner && !isArbiter && prompt.includes(VERDICT_MARKER); // L2 复核：须先于 researcher 判定（verify prompt 内嵌 brief 含 BRIEF_MARKER）
    const isDimsSplit = !isSpecPlanner && !isSpecReviewer && !isPlanner && !isVerifier && !isArbiter && prompt.includes(DIMS_SPLIT_MARKER); // 拆维规划（sail researchAutoDim）：先于 researcher 判定
    const isResearcher = !isSpecPlanner && !isSpecReviewer && !isPlanner && !isVerifier && !isArbiter && !isDimsSplit && prompt.includes(BRIEF_MARKER);
    onEvent({ type: 'worker_spawned', role: readonly ? 'reviewer' : 'worker', backend: 'mock', pid: process.pid });

    if (isSpecReviewer) {
      // spec 审查模式（spec-verdict/1）：固定五维 + 1 条 P2 finding（file 指向 prompt 中的
      // spec design.md，section 行号 1 恒在界内——auditSpecFindings 对账必过）。
      //   ORCH_MOCK_SPEC_REVIEW_INVALID=1   输出无契约块（测重试→die 路径）
      //   ORCH_MOCK_SPEC_REVIEW_BLOCKERS>=2 两条 P0（测 rework 矩阵路径）
      //   ORCH_MOCK_SPEC_REVIEW_FABRICATED=1 finding 指向不存在的文件（测定位对账剔除+降档）
      const invalid = process.env.ORCH_MOCK_SPEC_REVIEW_INVALID === '1';
      const blockers = parseInt(process.env.ORCH_MOCK_SPEC_REVIEW_BLOCKERS ?? '0', 10) || 0;
      const fabricated = process.env.ORCH_MOCK_SPEC_REVIEW_FABRICATED === '1';
      if (invalid) {
        const output = '审查想好了但没有契约块。';
        onEvent({ type: 'worker_turn', turn: 1, tool: 'mock-spec-reviewer' });
        return { exitCode: 0, output, usage: { tokensIn: 100, tokensOut: 80 }, pid: process.pid };
      }
      const specId = /"spec":\s*"([a-z0-9-]+)"/.exec(prompt)?.[1] ?? 'mock-spec';
      const goodFile = `.agents/orchestrator/specs/${specId}/design.md`;
      const base = blockers >= 2
        ? [
            { severity: 'P0', file: goodFile, section: '第 1 行', claim: '', why: 'mock：现状对账不符（注入）', fix: '按当前 develop 重写现状节' },
            { severity: 'P0', file: `.agents/orchestrator/specs/${specId}/tasks.md`, section: '第 1 行', claim: '', why: 'mock：完成条件不可验证（注入）', fix: '改断言级完成条件' },
          ]
        : [{ severity: 'P2', file: goodFile, section: '第 1 行', claim: '', why: 'mock：轻微建议', fix: '可改可不改' }];
      const ghost = { severity: 'P2', file: '.agents/orchestrator/specs/no-such-dir/ghost.md', section: '第 1 行', claim: '', why: 'mock：幽灵文件', fix: '应被定位对账剔除' };
      const findings = fabricated ? [...base, ghost] : base;
      const payload = {
        spec: specId,
        gates: { redlines: 'pass', notes: ['mock：L0 无红线命中'] },
        dimensions: { completeness: 85, unambiguity: 80, consistency: 85, testability: 85, feasibility: 90 },
        findings,
        usage: { build_ready: blockers >= 2 ? 'rework' : 'approve_to_build' },
        advisory: true,
      };
      const output = ['审查完成。', '', '```' + SPECVERDICT_MARKER, JSON.stringify(payload, null, 2), '```'].join('\n');
      onEvent({ type: 'worker_turn', turn: 1, tool: 'mock-spec-reviewer' });
      return { exitCode: 0, output, usage: { tokensIn: 100, tokensOut: 80 }, pid: process.pid };
    }

    if (isArbiter) {
      // 仲裁轮模式：从 prompt 逐字摘录「待仲裁 claim」行（buildArbitrationPrompt 的
      // `N. 「claim」` 列表），ORCH_MOCK_ARB_RULING=upheld|overturned|undetermined 统一切换
      // 裁定（默认 upheld=翻案解除否决）；ORCH_MOCK_ARB_INVALID=1 输出无契约块（测 2 连败
      // fail-closed 维持否决路径）。
      if (process.env.ORCH_MOCK_ARB_INVALID === '1') {
        const output = '仲裁想好了但没有契约块。';
        onEvent({ type: 'worker_turn', turn: 1, tool: 'mock-arbiter' });
        return { exitCode: 0, output, usage: { tokensIn: 100, tokensOut: 80 }, pid: process.pid };
      }
      const ruling = ['upheld', 'overturned', 'undetermined'].includes(process.env.ORCH_MOCK_ARB_RULING) ? process.env.ORCH_MOCK_ARB_RULING : 'upheld';
      const claims = [...prompt.matchAll(/^\d+\. 「(.+)」$/gm)].map((m) => m[1]);
      const payload = {
        rulings: (claims.length ? claims : ['mock claim']).map((c) => ({
          claim: c,
          ruling,
          sources: ['- 2026-11-09 https://example.com/arb — mock 仲裁：独立带日期来源'],
          reasoning: 'mock 仲裁裁定',
        })),
      };
      const output = ['仲裁完成。', '', '```' + ARBITRATION_MARKER, JSON.stringify(payload, null, 2), '```'].join('\n');
      onEvent({ type: 'worker_turn', turn: 1, tool: 'mock-arbiter' });
      return { exitCode: 0, output, usage: { tokensIn: 100, tokensOut: 80 }, pid: process.pid };
    }

    if (isVerifier) {
      // L2 复核模式（v2 JSON 契约）：从 prompt 内嵌 brief 摘第一条承重结论逐字回显；
      // ORCH_MOCK_REVIEW_BLOCKERS>0 映射为 contradicted（否决链路 e2e 复用既有注入）；
      // ORCH_MOCK_REVIEW_PARAPHRASE=1 每次都改写复述（尾部加词 → 非 brief 子串），
      // PARAPHRASE_ONCE=1 仅第一次改写、重试后逐字（测逐字重试恢复链路）；
      // ORCH_MOCK_REVIEW_FUZZY=1 额外注入轻度转述 + 编造 claim 各一条（fuzzy 两级制 e2e 用：
      // 转述条——空白段轮换、词元集合不变——应被 fuzzy 层放行标 verbatim:'fuzzy'；编造条
      // brief 外实体应 fabricated 走降级保留）
      const blockers = parseInt(process.env.ORCH_MOCK_REVIEW_BLOCKERS ?? '0', 10) || 0;
      const briefMatch = /## 待复核 brief\n\n([\s\S]*?)\n\n## 来源快照/.exec(prompt);
      const firstLine = (briefMatch?.[1] ?? '').split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#')) ?? 'mock claim';
      let claim = firstLine.slice(0, 110);
      const paraphrase = process.env.ORCH_MOCK_REVIEW_PARAPHRASE === '1' || (paraphraseOnce && verifierCall === 0);
      if (paraphraseOnce) verifierCall++;
      if (paraphrase) claim = `${claim.replace(/。$/, '')}（mock 复核改写）。`;
      const segs = firstLine.split(/\s+/).filter(Boolean);
      const rotated = segs.length >= 2 ? [...segs.slice(1), segs[0]].join(' ') : null;
      const claims = [{
        claim,
        status: blockers > 0 ? 'contradicted' : 'supported',
        note: blockers > 0 ? 'mock 复核：与给定快照矛盾' : 'mock 复核：与给定快照一致',
      }];
      if (process.env.ORCH_MOCK_REVIEW_FUZZY === '1') {
        if (rotated) claims.push({ claim: rotated.slice(0, 110), status: 'supported', note: 'mock 复核：轻度转述（词序轮换）' });
        claims.push({ claim: 'mock 复核编造：Phantom Model X9 市占率 99.9% 领跑虚构榜', status: 'supported', note: 'mock 复核：编造注入' });
      }
      const payload = {
        claims,
        blockers: blockers > 0 ? ['mock 硬伤'] : [],
      };
      const output = ['复核完成。', '', '```' + VERDICT_MARKER, JSON.stringify(payload, null, 2), '```'].join('\n');
      onEvent({ type: 'worker_turn', turn: 1, tool: 'mock-verifier' });
      return { exitCode: 0, output, usage: { tokensIn: 100, tokensOut: 80 }, pid: process.pid };
    }

    if (isSpecPlanner) {
      // spec planner 模式：输出三件套契约块（两个任务、文件明确，供 spec build 端到端拆卡）；
      // ORCH_MOCK_PLANNER_INVALID=1 复用 planner 的非法输出注入（重试路径测试）
      const invalid = process.env.ORCH_MOCK_PLANNER_INVALID === '1';
      const specId = /用户意图：\s*(.+)$/m.exec(prompt)?.[1]?.trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'planner-mock-spec';
      const output = invalid
        ? '规格想好了但没有产出契约块。'
        : [
            '已探索仓库,意图编译为规格三件套。',
            '',
            '```' + SPEC_META_MARKER,
            `id: ${specId}`,
            'title: mock 规格标题',
            '```',
            '',
            '```' + REQUIREMENTS_MARKER,
            '# mock 规格标题',
            '',
            '## 背景',
            'mock planner 背景。',
            '',
            '## 用户故事',
            '- 作为用户，我希望 mock 能力，以便测试。',
            '',
            '## 验收标准（EARS 式，可机器检查）',
            '- 当 mock 命令运行，系统应当产出 mock 产物。',
            '```',
            '',
            '```' + DESIGN_MARKER,
            '# 技术设计：mock 规格标题',
            '',
            '## 现状',
            'src/mock-现状占位。',
            '',
            '## 方案',
            'mock 设计方案：docs/ 下新增说明文档。',
            '',
            '## 取舍',
            '无（mock）。',
            '',
            '## 风险',
            '无（mock）。',
            '```',
            '',
            '```' + TASKS_MARKER,
            '# 任务分解：mock 规格标题',
            '',
            '## 任务 1:写文档',
            '- 目标: 新增 docs/mock-a.md',
            '- 文件: docs/**',
            '- 完成条件: docs/mock-a.md 存在且非空',
            '- 依赖: 无',
            '',
            '## 任务 2:补测试说明',
            '- 目标: 扩充 docs/mock-b.md',
            '- 文件: docs/**',
            '- 完成条件: docs/mock-b.md 存在且非空',
            '- 依赖: 任务 1',
            '```',
          ].join('\n');
      onEvent({ type: 'worker_turn', turn: 1, tool: 'mock-spec-planner' });
      return { exitCode: 0, output, usage: { tokensIn: 400, tokensOut: 300 }, pid: process.pid };
    }

    if (isPlanner) {
      // planner 模式：输出一张合法任务卡（契约块）；ORCH_MOCK_PLANNER_INVALID=1 模拟非法输出（校验重试路径测试）
      // ORCH_MOCK_PLANNER_FEATURE=1：产 feature 卡（带 research: todo + score/evidence——
      // sail 上游管线 e2e 用：先派 researcher 出 brief，再自动升级 spec，不直接进队列）
      // ORCH_MOCK_PLANNER_RESEARCH=<id>：feature 卡 research 行写该值（缺省 todo——纯增量，
      // 不设时输出与历史逐字节一致；sail autoDim 续接路径 e2e 用）
      // ORCH_MOCK_PLANNER_FEATURE_COUNT=<n>：feature 模式产 n 张卡（id 后缀 -2…-n，缺省 1——
      // researchPerCycle cap 的「multi 计 1」断言用）
      const intentId = /用户意图：\s*(.+)$/m.exec(prompt)?.[1]?.trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'planner-mock-task';
      const isFeature = process.env.ORCH_MOCK_PLANNER_FEATURE === '1';
      const featureCount = isFeature ? (parseInt(process.env.ORCH_MOCK_PLANNER_FEATURE_COUNT ?? '1', 10) || 1) : 1;
      const plannerResearch = process.env.ORCH_MOCK_PLANNER_RESEARCH ?? 'todo';
      const cardBlock = (id) =>
        [
          '```' + CARD_MARKER,
          '---',
          `id: ${id}`,
          `type: ${isFeature ? 'feature' : 'docs'}`,
          'priority: normal',
          `created_at: ${new Date().toISOString()}`,
          'created_by: planner',
          'files_hint:',
          `  - ${isFeature ? 'docs/**' : 'docs/**'}`,
          'workflows:',
          '  - feature-branch',
          'gate: L3',
          ...(isFeature
            ? [
                'proposal: true',
                `research: ${plannerResearch}`,
                'score:',
                '  value: 2',
                '  effort: 1',
                '  confidence: 3',
                '  risk: 1',
                'evidence:',
                '  - mock 证据：ORCH_MOCK_PLANNER_FEATURE 注入',
              ]
            : []),
          '---',
          '',
          '# 目标',
          'mock planner 目标:完成用户意图。',
          '',
          '# 验收标准',
          '- `npm test` 全绿',
          '- docs/ 下出现意图所述的新文档内容',
          '',
          '# 背景',
          'mock planner 探索结论占位。',
          '```',
        ].join('\n');
      const output = process.env.ORCH_MOCK_PLANNER_INVALID === '1'
        ? '我想了一下,这个任务大概需要改一些文件。没有产出任务卡。'
        : [
            `已探索仓库,意图编译为任务卡。`,
            '',
            // 多卡（FEATURE_COUNT>1）：id 后缀 -2…-n 区分；缺省 1 张与历史逐字节一致
            [intentId || 'planner-mock-task', ...Array.from({ length: Math.max(0, featureCount - 1) }, (_, k) => `${intentId || 'planner-mock-task'}-${k + 2}`)]
              .map((id) => cardBlock(id))
              .join('\n\n'),
          ].join('\n');
      onEvent({ type: 'worker_turn', turn: 1, tool: 'mock-planner' });
      return { exitCode: 0, output, usage: { tokensIn: 300, tokensOut: 200 }, pid: process.pid };
    }

    if (isDimsSplit) {
      // 拆维规划模式（sail researchAutoDim，2026-11-10 P3）：输出 2-4 个短维度（围栏包裹，
      // 每行一个——research.mjs parseDimsPlan 消费）。ORCH_MOCK_DIMS_SPLIT 注入：
      //   'one'     只给 1 维（<2 → 调用方降级单 brief 路径）
      //   'invalid' 无围栏无维度行（解析失败同降级）
      //   缺省      正常 3 维（multi 成功路径）
      const mode = process.env.ORCH_MOCK_DIMS_SPLIT ?? '';
      const output = mode === 'invalid'
        ? '我想了想，这个提案大概需要先调研一下再说。'
        : [
            '```' + DIMS_SPLIT_MARKER,
            ...(mode === 'one' ? ['技术选型'] : ['技术选型', '成本与维护', '生态兼容风险']),
            '```',
          ].join('\n');
      onEvent({ type: 'worker_turn', turn: 1, tool: 'mock-dims-planner' });
      return { exitCode: 0, output, usage: { tokensIn: 100, tokensOut: 50 }, pid: process.pid };
    }

    if (isResearcher) {
      // researcher 模式：输出一份带引用的 brief 契约块（research 命令端到端 / sail 上游管线 e2e）；
      // ORCH_MOCK_RESEARCH_NO_CITE=1 注入无引用产出（validateBriefBody 拒收重试路径测试）
      // ORCH_MOCK_RESEARCH_FAIL_DIM=<维度子串>（research multi 单维失败隔离测试）：调研问题
      // （`主题——维度`）含该子串的会话输出无契约块（3 连败 → 该维 failed），其余维度照常；
      // 配合 ORCH_MOCK_RESEARCH_STDERR=1 让失败维的 reason 带 unrecognized_model 签名 stderr
      const noCite = process.env.ORCH_MOCK_RESEARCH_NO_CITE === '1';
      const failDim = process.env.ORCH_MOCK_RESEARCH_FAIL_DIM ?? '';
      const qLine = /调研问题：\s*(.+)$/m.exec(prompt)?.[1] ?? '';
      const dimFailed = Boolean(failDim) && qLine.includes(failDim);
      const qId = /调研问题：\s*(.+)$/m.exec(prompt)?.[1]?.trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'planner-mock-brief';
      const output = process.env.ORCH_MOCK_PLANNER_INVALID === '1' || dimFailed
        ? '我查了一些资料但没有产出契约块。'
        : [
            '调研完成,产出 brief。',
            '',
            '```' + BRIEF_MARKER,
            `id: ${qId}`,
            'title: mock 调研标题',
            '',
            '# 结论',
            'mock 调研结论占位 [1]。',
            '',
            '# 选项对比',
            '- 方案 A：mock——优劣占位。',
            '',
            '# 引用',
            ...(noCite ? [] : [`- ${new Date().toISOString().slice(0, 10)} https://example.com/mock-research — 支撑结论 [1]`]),
            '',
            '# 建议',
            'mock 建议占位。',
            '',
            '# 罗盘对齐',
            'mock 对齐说明占位。',
            '```',
          ].join('\n');
      onEvent({ type: 'worker_turn', turn: 1, tool: 'mock-researcher' });
      return {
        exitCode: 0,
        output,
        usage: { tokensIn: 200, tokensOut: 150 },
        pid: process.pid,
        ...(process.env.ORCH_MOCK_RESEARCH_STDERR === '1'
          ? { stderrTail: '[claude-code:unrecognized_model] {"model":"glm-5.3-flash","query_source":"sdk"}\n' }
          : {}),
      };
    }

    if (isReviewer) {
      // ORCH_MOCK_REVIEW_FAIL=1：审查引擎故障注入（exitCode=1、无契约块、错误文本进
      // output——复刻真实 claude CLI 死法：result 事件携带 "Not logged in" 文本）
      if (process.env.ORCH_MOCK_REVIEW_FAIL === '1') {
        onEvent({ type: 'worker_turn', turn: 1, tool: 'mock-review-fail' });
        return {
          exitCode: 1,
          output: 'Not logged in · Please run /login',
          stderrTail: '[claude-code:unrecognized_model] {"model":"glm-5.3-flash","query_source":"sdk"}\n',
          usage: { tokensIn: 0, tokensOut: 0 },
          pid: process.pid,
        };
      }
      // ORCH_MOCK_REVIEW_NOVERDICT=1：引擎活着（exitCode=0）但输出无 REVIEW_SUMMARY
      // 契约块——既有保守路径（blockers=1 进审查返工）的回归锚
      if (process.env.ORCH_MOCK_REVIEW_NOVERDICT === '1') {
        onEvent({ type: 'worker_turn', turn: 1, tool: 'mock-review-noverdict' });
        return {
          exitCode: 0,
          output: '审查者跑完了但没有输出 REVIEW_SUMMARY 汇总行（ORCH_MOCK_REVIEW_NOVERDICT=1 注入）。',
          usage: { tokensIn: 100, tokensOut: 50 },
          pid: process.pid,
        };
      }
      const blockers = parseInt(process.env.ORCH_MOCK_REVIEW_BLOCKERS ?? '0', 10) || 0;
      // 审查 token 上报注入：集成测试驱动「审查段熔断」路径（reviewer 记账 + 循环顶收敛）
      const reviewTokens = parseInt(process.env.ORCH_MOCK_REVIEW_TOKENS ?? '0', 10) || 0;
      if (reviewTokens > 0) onEvent({ type: 'budget_snapshot', tokens_in: reviewTokens, tokens_out: 0 });
      const output =
        blockers > 0
          ? `🔴 阻塞（1 个）\n- mock：验收标准第 ${blockers} 条未实现\nREVIEW_SUMMARY: blockers=${blockers} suggestions=0 notes=0`
          : `🟢 无阻塞\nREVIEW_SUMMARY: blockers=0 suggestions=1 notes=0\n- 🟡 建议：mock 建议项（不阻塞）`;
      onEvent({ type: 'worker_turn', turn: 1, tool: 'mock-review' });
      return { exitCode: 0, output, usage: { tokensIn: 100, tokensOut: 50 }, pid: process.pid };
    }

    // worker 模式：模拟真实改动（写一个文件让 diff/门禁有内容可看）+ git 提交。
    // ORCH_MOCK_FILE 可指定改动文件路径（供分级裁决测试：docs/x.md → L0 等）；
    // 并发场景（有 ORCH_MOCK_DELAY_MS）按任务 id 推导独立文件，否则多任务共享 env 会写同一个文件
    // ORCH_MOCK_TRANSIENT=1：worker 中途死亡（放在文件写入前——瞬时死亡不留半成品），
    // 无结果块 + 瞬时签名 stderr → cmdRun 走 isTransientWorkerFailure 原地退避重试路径
    if (process.env.ORCH_MOCK_TRANSIENT === '1') {
      return {
        exitCode: 1,
        output: 'mock worker 中途死亡（ORCH_MOCK_TRANSIENT=1 注入瞬时故障，无结果块）',
        stderrTail: 'request failed: 429 too many requests (ECONNRESET)',
        pid: process.pid,
      };
    }
    const idMatch = /本次任务（([a-z0-9][a-z0-9-]*)，/.exec(prompt);
    const relFile = process.env.ORCH_MOCK_FILE ?? (delay > 0 && idMatch ? `docs/notes-${idMatch[1]}.md` : 'mock-worker-output.txt');
    const markerFile = path.join(cwd, relFile);
    fs.mkdirSync(path.dirname(markerFile), { recursive: true });
    fs.writeFileSync(markerFile, `mock worker output @ ${new Date().toISOString()}\n`);
    const { execFileSync } = await import('node:child_process');
    if (process.env.ORCH_MOCK_NO_COMMIT !== '1') {
      try {
        execFileSync('git', ['add', '-A'], { cwd, stdio: 'ignore' });
        execFileSync('git', ['-c', 'user.name=mock-worker', '-c', 'user.email=mock@local', 'commit', '-m', 'chore: mock worker change'], { cwd, stdio: 'ignore' });
      } catch {
        // 已提交过/无改动时忽略，测试只关心流程
      }
    }
    onEvent({ type: 'worker_turn', turn: 1, tool: 'Write', file: relFile });

    const status = process.env.ORCH_MOCK_WORKER_STATUS === 'stuck' ? 'stuck' : 'done';
    const output = [
      'mock worker 完成。',
      '',
      '```' + RESULT_MARKER,
      `status: ${status}`,
      'summary: mock 后端固定输出',
      `files_changed: ["${relFile}"]`,
      `tests: ${status === 'done' ? 'pass' : 'fail'}`,
      'notes_updated: true',
      '```',
    ].join('\n');
    onEvent({ type: 'budget_snapshot', tokens_in: 4200, tokens_out: 1800 });
    return { exitCode: 0, output, usage: { tokensIn: 4200, tokensOut: 1800 }, pid: process.pid };
  },
};
