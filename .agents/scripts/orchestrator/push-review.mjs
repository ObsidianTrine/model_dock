// push-review.mjs — orch push-review：push 上远程前的整体审查闸（push-review-gate 卡，2026-11）。
// 流程：range 解析（缺省 @{u}..HEAD → origin/develop..HEAD → die 提示显式传）→ 提交清单 +
// 整体 diff（>400KB die 建议缩 range/分段）→ 只读审查船（review.backend/model 缺省链，readonly
// 无写工具）→ 产出契约块 agents-push-verdict（schema push-verdict/1）→ 落盘
// .agents/orchestrator/push-review/latest.json + fleet 留痕 push_review + stdout 摘要。
// verdict=fail 退出码非 0（脚本可判）。契约外 verdict 值一律按 fail（fail-closed）。
// 消费方：.agents/hooks/push-gate.mjs（policy-dispatch 的 push 闸）——verdict=pass 且 24h 内
// 且 HEAD 未变才放行 git push main/develop；HEAD 再变即失效，需重跑本命令。

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getBackend, writeWorkerSettings } from './backends/claude-headless.mjs';
import { buildPushReviewPrompt, parsePushVerdictBlock, PUSHVERDICT_MARKER } from './prompt.mjs';
import { appendFleetEvent } from './weather.mjs';
import { loadWorkflowConfig } from '../workflow-config.mjs';
import { toIsoLocal } from './events.mjs';

/** 待审 diff 字节上限：审查船上下文装不下更大的（实测 400KB 已是极限量级），超限宁可
 *  分段重跑也不静默截断——截断审查 = 没审到的部分裸奔上远程。 */
const DIFF_MAX_BYTES = 400 * 1024;
const ARTIFACT_RELPATH = path.join('.agents', 'orchestrator', 'push-review', 'latest.json');
/** 短 sha 长度：与 .agents/hooks/push-gate.mjs 的 SHORT_SHA_LEN 同口径（不跨目录 import——
 *  scripts 目录保持零 hooks 依赖可独立拷贝，两边一致性由 push-gate.test.ts e2e 断言锁定）。 */
const SHORT_SHA_LEN = 12;

/**
 * 防伪造 generation 戳（date +%s%N 同精度：墙钟 ms + hrtime 纳秒尾数，唯一且单调）。
 * gate 侧只验格式存在——把「随手编辑一个 json 就能过」的门槛抬高到「需真跑本命令」；
 * 这是成本抬高层，不是密码学防护（防 agent 顺手造假，不防蓄意攻击者——读得到 gate 源码
 * 就能伪造全部字段；完全防线 = hook 只拦 agent 会话 + AGENTS_ALLOW_PUSH 人工在环）。
 */
function generationStamp() {
  return `${Date.now()}${(BigInt.asUintN(64, process.hrtime.bigint()) % 1_000_000_000n).toString().padStart(9, '0')}`;
}

const die = (msg, code = 1) => {
  console.error(`[orchestrator] ${msg}`);
  process.exit(code);
};
const log = (msg) => console.log(msg);

/** git 子进程封装；失败返回 null（调用方给可操作报错）。buffer 模式取字节长度判 diff 上限。 */
function gitRun(repoRoot, args, maxBuffer = 32 * 1024 * 1024) {
  const r = spawnSync('git', args, { cwd: repoRoot, encoding: 'buffer', maxBuffer, stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.error || r.status !== 0) return null;
  return r.stdout;
}

/** 缺省待推范围：@{u}..HEAD → origin/develop..HEAD → die（要求显式 --range）。 */
function defaultRange(repoRoot) {
  const up = gitRun(repoRoot, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  if (up) return `${up.toString('utf8').trim()}..HEAD`;
  const originDevelop = gitRun(repoRoot, ['rev-parse', '--verify', '--quiet', 'origin/develop']);
  if (originDevelop) return 'origin/develop..HEAD';
  die('当前分支无 upstream、仓库也无 origin/develop——无法确定待推范围。请显式传 --range A..B（如 --range origin/develop..HEAD）。');
}

/**
 * push 审查主流程（orchestrator.mjs case 'push-review' 委托）。opts：{ range?, backend?, model? }。
 */
export async function cmdPushReview(repoRoot, opts = {}) {
  const range = opts.range || defaultRange(repoRoot);
  const branch = gitRun(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD'])?.toString('utf8').trim() || 'HEAD';
  const head = gitRun(repoRoot, ['rev-parse', 'HEAD'])?.toString('utf8').trim();
  if (!head) die(`git rev-parse HEAD 失败——${repoRoot} 不是有效 git 仓库？`);
  const commitsBuf = gitRun(repoRoot, ['log', '--oneline', range]);
  if (commitsBuf === null) die(`range "${range}" 无效（git log 失败）——用 git log --oneline <A>..<B> 确认两端都存在，或显式传 --range。`);
  const commits = commitsBuf.toString('utf8').trim();
  const diffBuf = gitRun(repoRoot, ['diff', range]);
  if (diffBuf === null) die(`git diff ${range} 失败——确认 range 两端存在且可 diff。`);
  if (diffBuf.byteLength > DIFF_MAX_BYTES) {
    die(
      `待审 diff ${(diffBuf.byteLength / 1024).toFixed(0)}KB 超过 ${DIFF_MAX_BYTES / 1024}KB 上限——审查船上下文装不下，截断审查等于没审的部分裸奔上远程。\n` +
        `修复建议：① 缩小 range 按提交分段审（--range A..B，逐段 push-review）；② 或先只合并/推送已审段落。`
    );
  }
  const diff = diffBuf.toString('utf8');

  const cfg = loadWorkflowConfig(repoRoot);
  const backendName = opts.backend || cfg.review?.backend || 'claude-headless';
  const model = opts.model || cfg.review?.model || undefined;
  const backend = await getBackend(backendName);
  const commitCount = commits ? commits.split('\n').length : 0;
  log(`═══ push 审查（${branch}，${range}）：${commitCount} 个提交，diff ${(diffBuf.byteLength / 1024).toFixed(1)}KB，审查船 ${backendName}${model ? `/${model}` : ''} ═══`);

  const settingsFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-pushreview-')), 'settings.json');
  const promptFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-pushreview-prompt-')), 'push-review-prompt.md');
  try {
    let promptText = buildPushReviewPrompt({ range, branch, commits, diff });
    const MAX_ATTEMPTS = 2;
    let parsed = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      fs.writeFileSync(promptFile, promptText);
      if (backendName === 'claude-headless') writeWorkerSettings(settingsFile, {}, repoRoot);
      const result = await backend.spawn({
        promptFile,
        cwd: repoRoot, // 审查船只读探索主仓库（Read/Glob/Grep；readonly 无写工具）
        maxTurns: 30,
        onEvent: () => {},
        readonly: true,
        settingsFile,
      });
      parsed = parsePushVerdictBlock(result.output ?? '');
      if (!parsed) {
        if (attempt < MAX_ATTEMPTS) {
          promptText += `\n\n# 重试要求（第 ${attempt} 次输出不含合规 ${'```'}${PUSHVERDICT_MARKER}${'```'} JSON 契约块）\n请严格按产出契约重新输出：verdict/overall/findings/reasons 单个 fenced block。`;
          continue;
        }
        die(`push 审查会话 ${MAX_ATTEMPTS} 次均未产出合规 ${PUSHVERDICT_MARKER} 契约块（--backend mock 可验证管线）。`);
      }
      break;
    }
    const verdict = parsed.verdict === 'pass' ? 'pass' : 'fail'; // 契约外值一律按 fail（fail-closed）
    const overall = Number.isFinite(parsed.overall) ? Math.max(0, Math.min(100, Math.round(parsed.overall))) : null;
    const findings = (Array.isArray(parsed.findings) ? parsed.findings : []).slice(0, 12);
    const reasons = (Array.isArray(parsed.reasons) ? parsed.reasons : []).map((r) => String(r));
    const stored = {
      schema: 'push-verdict/1',
      branch,
      head,
      // 防伪造三件套（gate 侧 loadPushArtifact 双向核验，口径与口径注释见该函数头）：
      // short + full sha 必须与当时 rev-parse 一致，generation 是本命令真跑产出的一次性戳。
      head_sha: head.slice(0, SHORT_SHA_LEN),
      head_sha_full: head,
      generation: generationStamp(),
      range,
      verdict,
      overall,
      findings,
      reasons,
      reviewer_model: model ?? null,
      backend: backendName,
      reviewed_at: toIsoLocal(),
    };
    const artifactPath = path.join(repoRoot, ARTIFACT_RELPATH);
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    fs.writeFileSync(artifactPath, `${JSON.stringify(stored, null, 2)}\n`);
    appendFleetEvent(repoRoot, 'push_review', { verdict, head, overall, branch, range, backend: backendName, model: model ?? null });
    const icon = verdict === 'pass' ? '✓' : '⛔';
    log(`${icon} push 审查结论：${verdict}（overall ${overall ?? 'null'}；结论落 ${ARTIFACT_RELPATH}）`);
    for (const f of findings) {
      log(`  · [${f?.severity ?? '?'}] ${f?.file ?? '?'}${f?.line != null ? `:${f.line}` : ''}——${String(f?.claim ?? f?.why ?? '').slice(0, 80)}`);
    }
    for (const r of reasons) log(`  · ${r}`);
    if (verdict === 'pass') {
      log(`通过后可 push：24h 内且 HEAD 未变（${head.slice(0, 12)}）时 hook 闸自动放行 main/develop；HEAD 再变即失效，需重跑 push-review。`);
    } else {
      die('push 审查未通过（verdict=fail）——先修复 findings 再重跑 push-review；确要跳过请人工 AGENTS_ALLOW_PUSH=1（与 AGENTS_ALLOW_RELEASE 同语义，责任在人）。');
    }
  } finally {
    try {
      fs.rmSync(path.dirname(promptFile), { recursive: true, force: true });
      fs.rmSync(path.dirname(settingsFile), { recursive: true, force: true });
    } catch {
      /* 清理失败不阻断 */
    }
  }
}
