// autopilot.mjs — autopilot 授权判定（纯逻辑，可单测）：系统自主产出的提案卡能否被
// 自动提交进队列。授权模型（持久化配置替代「一次性对话授权」，合并闸门原样保留）：
//   - workflow.json autopilot.enabled 总开关（缺省 false = 全人工，行为与历史版本一致）；
//   - created_by: human 的人工草稿永不自动提交（drafts/ 里混着 intent --draft 的人工产物）；
//   - deps 类型永不自动（依赖升级一律人工裁决）；
//   - autoSubmitTypes 白名单圈定可自动提交的卡类型（缺省 ["docs"]，最保守）；
//   - files_hint 命中 corePaths/releasePaths 永不自动（hintsOverlap 全通配判重叠——
//     核心路径/发布流水线由 classifyChange 的 L2/L3 分级闸门兜底，这里提前挡掉省一轮
//     worker 烧钱）。
// 注意：自动提交 ≠ 自动合并——提交的卡 gate 覆写为 L1，实际自动合并仍由门禁对真实
// 改动的分级裁决（drift 降级 / scope 越界 / 实际 L2 照样挡回人工闸门）。

import { hintsOverlap } from '../policy.mjs';

/** autopilot 自动提交的卡 gate 覆写值：预授权到 L1（实际 L2/L3 照样回人工）。 */
export const AUTO_SUBMIT_GATE = 'L1';

/**
 * 判定一张提案卡是否可被 autopilot 自动提交。
 * @param {object} meta 任务卡 frontmatter（parseCard 的 meta）
 * @param {object} cfg loadWorkflowConfig 的返回值
 * @returns {{ ok: boolean, reason?: string }}
 */
export function canAutoSubmit(meta, cfg) {
  const ap = cfg?.autopilot;
  if (!ap?.enabled) return { ok: false, reason: 'autopilot 未启用（workflow.json autopilot.enabled）' };
  if (meta.created_by === 'human') return { ok: false, reason: '人工草稿（created_by: human）永不自动提交' };
  if (meta.type === 'deps') return { ok: false, reason: 'deps 类型永不 autoSubmit（依赖升级人工裁决）' };
  if (!Array.isArray(ap.autoSubmitTypes) || !ap.autoSubmitTypes.includes(meta.type)) {
    return { ok: false, reason: `type "${meta.type}" 不在 autopilot.autoSubmitTypes [${(ap.autoSubmitTypes ?? []).join(', ')}]` };
  }
  const guarded = [...(cfg.corePaths ?? []), ...(cfg.releasePaths ?? [])];
  // hintsOverlap 对空列表按「重叠」保守处理——项目未配置 corePaths/releasePaths 时
  // 不能把所有卡都拒掉：空守卫清单 = 无守卫面，直接跳过该检查
  if (guarded.length && hintsOverlap(meta.files_hint, guarded)) return { ok: false, reason: 'files_hint 命中核心/发布路径（永不 autoSubmit）' };
  return { ok: true };
}
