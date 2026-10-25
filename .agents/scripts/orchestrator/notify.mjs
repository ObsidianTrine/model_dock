// notify.mjs — nightly 结果通知（可观测性补口）：巡检跑完/跑挂只有日志文件等于没跑。
// 两个通道，全部尽力而为（失败静默，通知绝不影响编排本身）：
//   1. MODELRDOCK_NIGHTLY_WEBHOOK 环境变量：fetch POST JSON（企业微信/飞书/Slack
//      的 incoming webhook 均可接一层适配；本层只管发 {title, body, ts}）
//   2. macOS 本地通知：osascript display notification（无依赖，登录会话可见）
// dryRun 模式返回将执行的命令/payload 不发送（测试用）。

import { spawnSync } from 'node:child_process';

export const NIGHTLY_WEBHOOK_ENV = 'MODELRDOCK_NIGHTLY_WEBHOOK';

/** 组装单行多段的 nightly 摘要正文（通知场景：短、可扫读）。 */
export function buildNightlySummary({ created, awaiting, pending, degraded, autoRan, error } = {}) {
  const parts = [];
  if (error) parts.push(`✗ 巡检异常：${error}`);
  else parts.push('✓ 巡检完成');
  parts.push(`新卡 ${created ?? 0}、待审 ${awaiting ?? 0}、待调度 ${pending ?? 0}`);
  if (autoRan) parts.push(`夜间已自动跑 ${autoRan} 个任务`);
  if (degraded) parts.push('⚠ 漂移降级生效中');
  return parts.join('；');
}

/**
 * 发通知。opts: { title, body, dryRun }
 * 返回 { delivered: string[] }（已投递通道描述；dryRun 时为「将执行」描述）。
 */
export async function notify(opts = {}) {
  const { title = 'ModelDock nightly', body = '', dryRun = false } = opts;
  const delivered = [];
  const webhook = process.env[NIGHTLY_WEBHOOK_ENV];
  if (webhook) {
    const payload = JSON.stringify({ title, body, ts: new Date().toISOString() });
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
