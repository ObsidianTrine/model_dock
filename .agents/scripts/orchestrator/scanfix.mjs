// scanfix.mjs — scan 型卡 failed 后自动转修复卡（B10，2026-11 定）：主干巡检卡
// （scan-ci-* 等，id 以 scan- 前缀起）failed 是终态，此前只能人工 abandon——
// scan→修复的自动链断路。这里在 drain 处理到 failed 的 scan 卡后自动补一张 pending
// 修复卡（id fix-<原名>），正文引用 incident.md 与失败摘要，files_hint/type/门禁
// 继承原卡——修复卡是普通卡，照走既有全部闸门（引水闸/L2L3 人审不绕过）。
// 防循环双保险：
//   1. 修复卡 id 无 scan- 前缀 → 自身 failed 不再繁殖新卡；
//   2. 同名修复卡在**任一队列状态**已存在即跳过（不止 pending/running——merged/failed
//      也算：scan 卡是终态留在 failed/ 永远在场，按状态白名单去重会让每轮 drain
//      重生同一张修复卡，跨 drain 打环）。
// 配置开关 workflow.json scanAutoFix.enabled（缺省 true）；workflow-config 非法值告警。

import fs from 'node:fs';
import { appendEvent, logDir, readEvents, toIsoLocal } from './events.mjs';
import { cardPath, findCard, loadCard } from './queue.mjs';

/** scan 型卡判定：巡检产出的卡 id 统一带 scan- 前缀（scan-todo-* / scan-audit-* /
 *  scan-ci-* / scan-ki-*，scan.mjs 的命名约定）。只认 id 前缀——type 与普通卡同域
 *  （bugfix/refactor/deps），按 type 判会把人工卡误卷进来。 */
export function isScanCardId(id) {
  return /^scan-[a-z0-9-]*$/.test(String(id ?? ''));
}

/** 修复卡 id：fix-<原名>。原卡 id 已过 TASK_ID_RE，加 fix- 前缀后仍合法。 */
export function fixCardId(scanId) {
  return `fix-${scanId}`;
}

/**
 * 组装修复卡 markdown（纯函数）。frontmatter 继承原卡 type/priority/files_hint/
 * workflows/gate（原卡过过 validateCard，继承值必合法）；created_at 记生成时刻，
 * created_by 留空（既非人工也非 scanner——编排器自生成的衍生卡）。
 */
export function buildFixCardText({ scanId, scanMeta, scanBody, failReason = '', iso } = {}) {
  const meta = scanMeta ?? {};
  const arr = (v, fallback) => (Array.isArray(v) && v.length ? v : fallback);
  const filesHint = arr(meta.files_hint, ['**/*']);
  const workflows = arr(meta.workflows, ['feature-branch']);
  const goalLine = String(scanBody?.goal ?? '').split('\n')[0].trim();
  const fm = [
    '---',
    `id: ${fixCardId(scanId)}`,
    `type: ${meta.type ?? 'bugfix'}`,
    `priority: ${meta.priority ?? 'normal'}`,
    `created_at: ${iso}`,
    'files_hint:',
    ...filesHint.map((h) => `  - ${h}`),
    'workflows:',
    ...workflows.map((w) => `  - ${w}`),
    `gate: ${meta.gate ?? 'L3'}`,
    '---',
  ].join('\n');
  const acceptance = String(scanBody?.acceptance ?? '').trim() || '- 修复后相关测试全绿（具体以原巡检卡验收标准为准）';
  const background = [String(scanBody?.goal ?? '').trim(), String(scanBody?.background ?? '').trim()].filter(Boolean).join('\n\n');
  const parts = [
    fm,
    '',
    '# 目标',
    `修复巡检卡 ${scanId} 失败暴露的问题${goalLine ? `（原目标：${goalLine}）` : ''}。本卡由 scanAutoFix 在原卡落 failed/ 后自动生成，属普通任务卡，照走全部门禁与人工闸门。`,
    '',
    `原始巡检卡：queue/failed/${scanId}.md（事件流：logs/${scanId}/events.jsonl）`,
    `事故调查包：.agents/orchestrator/logs/${scanId}/incident.md`,
    `失败摘要：${failReason ? failReason.slice(0, 300) : '（未记录）'}`,
    '',
    '# 验收标准',
    acceptance,
  ];
  if (background) parts.push('', '# 背景', background);
  parts.push('');
  return parts.join('\n');
}

/**
 * scan 卡 failed 后的自动转修复卡（drain 落位点的接线，尽力而为不阻断调度）。
 * @returns {{ created?: boolean, id?: string, skipped?: boolean, reason?: string }}
 */
export function scanAutoFixAfterFailure(repoRoot, root, scanId, { enabled = true } = {}) {
  if (!enabled) return { skipped: true, reason: 'scanAutoFix.enabled=false' };
  if (!isScanCardId(scanId)) return null;
  const fid = fixCardId(scanId);
  const existing = findCard(root, fid);
  if (existing) return { skipped: true, reason: `修复卡已存在（${existing.state}/）` };
  try {
    const text = fs.readFileSync(cardPath(root, 'failed', scanId), 'utf8');
    let meta;
    let body;
    try {
      ({ meta, body } = loadCard(text, `${scanId}.md`));
    } catch (e) {
      return { skipped: true, reason: `原卡解析失败（${String(e?.message ?? e).slice(0, 120)}）` };
    }
    // 失败摘要：最后一条 failed/blocked 事件的 reason（人工 abandon 也有据可查）
    let failReason = '';
    try {
      const events = readEvents(logDir(repoRoot, scanId));
      const last = [...events].reverse().find((e) => e?.type === 'failed' || e?.type === 'blocked');
      failReason = String(last?.reason ?? last?.detail ?? '');
    } catch { /* 无事件流：摘要留空 */ }
    fs.writeFileSync(cardPath(root, 'pending', fid), buildFixCardText({ scanId, scanMeta: meta, scanBody: body, failReason, iso: toIsoLocal() }));
    appendEvent(logDir(repoRoot, scanId), 'scan_autofix', { fix: fid, reason: failReason.slice(0, 200) });
    return { created: true, id: fid };
  } catch (e) {
    return { skipped: true, reason: `修复卡创建失败（${String(e?.message ?? e).slice(0, 120)}）` };
  }
}
