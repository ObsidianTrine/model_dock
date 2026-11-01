// notify.mjs — nightly 结果通知（可观测性补口）：巡检跑完/跑挂只有日志文件等于没跑。
// 两个通道，全部尽力而为（失败静默，通知绝不影响编排本身）：
//   1. webhook 环境变量：fetch POST JSON（企业微信/飞书/Slack 的 incoming webhook
//      均可接一层适配；本层只管发 {title, body, ts}）。变量名 ${envPrefix}_NIGHTLY_WEBHOOK
//      （envPrefix 来自 workflow.json，默认 AGENTS）；旧项目名 MODELRDOCK_NIGHTLY_WEBHOOK 永远兼容
//   2. macOS 本地通知：osascript display notification（无依赖，登录会话可见）
// dryRun 模式返回将执行的命令/payload 不发送（测试用）。

import { spawnSync } from 'node:child_process';
import { loadWorkflowConfig } from '../workflow-config.mjs';

/** 旧项目名的 webhook 变量（兼容识别，永不删除——已注册过通知的老环境不断供）。 */
export const NIGHTLY_WEBHOOK_ENV = 'MODELRDOCK_NIGHTLY_WEBHOOK';

/** webhook 环境变量名清单（按优先序）：${envPrefix}_NIGHTLY_WEBHOOK + 旧名兼容。 */
export function nightlyWebhookEnvs(repoRoot) {
  const prefix = loadWorkflowConfig(repoRoot).envPrefix || 'AGENTS';
  return [...new Set([`${prefix}_NIGHTLY_WEBHOOK`, NIGHTLY_WEBHOOK_ENV])];
}

/** 编排任务落位/收官通知的 webhook 变量：${envPrefix}_ORCH_WEBHOOK。
 *  与 nightly 通道分开（语义不同：巡检日报 vs 单卡落位即时提醒），unset 时静默跳过。 */
export function orchWebhookEnvs(repoRoot) {
  const prefix = loadWorkflowConfig(repoRoot).envPrefix || 'AGENTS';
  return [`${prefix}_ORCH_WEBHOOK`];
}

/**
 * 按端点特征适配 incoming webhook 请求体：飞书（msg_type/content）、企业微信
 * （msgtype/text）、Slack（text）三家格式互不相同，裸 {title,body,ts} 只有自建
 * 适配层能接。按 URL 域名识别主流三家直接适配，其余端点保持裸 JSON（已注册
 * 自建适配层的老环境不断供）。纯函数：dryRun 描述与实际发送共用同一形态。
 */
export function webhookPayload(webhook, title, body, ts) {
  const text = `${title}\n${body}`;
  if (/open\.feishu\.cn|open\.larksuite\.com/i.test(webhook)) {
    return JSON.stringify({ msg_type: 'text', content: { text } });
  }
  if (/qyapi\.weixin\.qq\.com/i.test(webhook)) {
    return JSON.stringify({ msgtype: 'text', text: { content: text } });
  }
  if (/hooks\.slack\.com/i.test(webhook)) {
    return JSON.stringify({ text });
  }
  return JSON.stringify({ title, body, ts });
}

/** 组装卡片落位通知正文（awaiting-human/blocked/failed——夜里无人值守时可扫读）。 */
export function buildSettleSummary({ taskId, state, reason } = {}) {
  const icon = state === 'merged' ? '✅' : state === 'awaiting-human' ? '⏸' : state === 'failed' ? '✗' : '⚠';
  return `${icon} ${taskId ?? '?'} → ${state ?? '?'}${reason ? `：${String(reason).slice(0, 120)}` : ''}`;
}

/** 组装单行多段的 nightly 摘要正文（通知场景：短、可扫读）。 */
export function buildNightlySummary({ created, proposals, awaiting, pending, degraded, autoRan, error } = {}) {
  const parts = [];
  if (error) parts.push(`✗ 巡检异常：${error}`);
  else parts.push('✓ 巡检完成');
  const prop = proposals ? `、规划提案 ${proposals}` : '';
  parts.push(`新提案 ${created ?? 0}${prop}、待审 ${awaiting ?? 0}、待调度 ${pending ?? 0}`);
  if (autoRan) parts.push(`夜间已自动跑 ${autoRan} 个任务`);
  if (degraded) parts.push('⚠ 漂移降级生效中');
  return parts.join('；');
}

/**
 * 发通知。opts: { title, body, dryRun, webhookEnvs }
 * webhookEnvs 缺省只查旧名（独立调用者兼容）；cmdNightly 传 nightlyWebhookEnvs(repoRoot) 全清单。
 * 返回 { delivered: string[] }（已投递通道描述；dryRun 时为「将执行」描述）。
 */
export async function notify(opts = {}) {
  const { title = 'nightly', body = '', dryRun = false, webhookEnvs = [NIGHTLY_WEBHOOK_ENV] } = opts;
  const delivered = [];
  const webhook = webhookEnvs.map((n) => process.env[n]).find(Boolean);
  if (webhook) {
    const payload = webhookPayload(webhook, title, body, new Date().toISOString());
    if (dryRun) {
      delivered.push(`webhook POST ${webhook} ${payload}`);
    } else {
      try {
        const res = await fetch(webhook, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: payload,
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        delivered.push('webhook');
      } catch {
        // 通道故障不阻断编排；摘要仍会出现在 nightly.log
      }
    }
  }
  if (process.platform === 'darwin') {
    const short = String(body).slice(0, 200).replace(/["\\]/g, ''); // osascript 引号安全
    const script = `display notification "${short}" with title "${title}"`;
    if (dryRun) {
      delivered.push(`osascript: ${script}`);
    } else {
      try {
        const r = spawnSync('osascript', ['-e', script], { stdio: 'ignore', timeout: 10_000 });
        if (r.status === 0) delivered.push('macOS 通知');
      } catch {
        // 非登录会话（纯后台 launchd）无通知中心：静默
      }
    }
  }
  return { delivered };
}
