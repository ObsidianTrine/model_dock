// notify.mjs — nightly 结果通知（可观测性补口）：巡检跑完/跑挂只有日志文件等于没跑。
// 通道清单，全部尽力而为（失败静默，通知绝不影响编排本身）：
//   1. webhook 环境变量：fetch POST JSON（企业微信/飞书/Slack 的 incoming webhook
//      均可接一层适配；本层只管发 {title, body, ts}）。变量名 ${envPrefix}_NIGHTLY_WEBHOOK
//      （envPrefix 来自 workflow.json，默认 AGENTS）；旧项目名 MODELRDOCK_NIGHTLY_WEBHOOK 永远兼容
//   2. macOS 本地通知：osascript display notification（无依赖，登录会话可见）
//   3. 双向批示卡片（可选，notify.cardWebhook 开启才发）：需要人工动作的落位事件在
//      文本通知之外额外 POST 一张飞书交互卡片（approve/reject 按钮回调 approval-listener），
//      见 buildInteractiveCard / notifyActionCard
// dryRun 模式返回将执行的命令/payload 不发送（测试用）。

import { createHmac } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { loadWorkflowConfig } from '../workflow-config.mjs';
import { keychainServiceName } from './schedule.mjs';

/** 旧项目名的 webhook 变量（兼容识别，永不删除——已注册过通知的老环境不断供）。 */
export const NIGHTLY_WEBHOOK_ENV = 'MODELRDOCK_NIGHTLY_WEBHOOK';

/** 飞书自定义机器人签名密钥的 env 名（与 approval-listener 的 VERIFICATION_TOKEN 命名
 *  同族；config notify.signSecretService 指向的钥匙串条目是第二来源）。 */
export const LARK_SIGN_SECRET_ENV = 'AGENTS_LARK_SIGN_SECRET';

/**
 * 飞书自定义机器人签名（官方规范）：把 `timestamp + "\n" + secret` 当作 HMAC-SHA256 的
 * **密钥**、空串当作消息，取 base64 摘要。密钥本身绝不进 payload/日志——出站 body 只附
 * timestamp 与 sign 两个字段。
 * @param {string|number} timestamp 秒级时间戳（十进制字符串）
 * @param {string} secret 机器人签名密钥
 */
export function feishuSign(timestamp, secret) {
  return createHmac('sha256', `${String(timestamp)}\n${String(secret)}`).update('').digest('base64');
}

/**
 * 签名密钥解析：env（AGENTS_LARK_SIGN_SECRET）优先 → darwin 钥匙串兜底（服务名
 * notify.signSecretService，与 webhook URL 的钥匙串兜底同模式）。取不到返回 null =
 * 不签名（未配置 = 现状不变）。密钥属密钥——只返回值，绝不打日志。
 */
export function resolveSignSecret(repoRoot) {
  const env = process.env[LARK_SIGN_SECRET_ENV];
  if (typeof env === 'string' && env.trim()) return { secret: env.trim(), source: 'env' };
  if (process.platform === 'darwin') {
    const service = loadWorkflowConfig(repoRoot)?.notify?.signSecretService;
    if (!service) return null;
    try {
      const r = spawnSync('security', ['find-generic-password', '-s', service, '-w'], { encoding: 'utf8', timeout: 5000 });
      const v = (r.stdout || '').trim();
      if (r.status === 0 && v) return { secret: v, source: 'keychain' };
    } catch { /* 钥匙串不可得：不签名，通知照发（尽力而为） */ }
  }
  return null;
}

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
 * sign = { timestamp, sign }（飞书自定义机器人签名，C13）：提供且端点为飞书时
 * body 附 timestamp+sign 两字段（签名算法见 feishuSign）；缺省 null = 不签名，
 * 老调用方（4 参）行为逐字节不变。
 */
export function webhookPayload(webhook, title, body, ts, sign = null) {
  const text = `${title}\n${body}`;
  if (/open\.feishu\.cn|open\.larksuite\.com/i.test(webhook)) {
    const base = { msg_type: 'text', content: { text } };
    return JSON.stringify(sign ? { timestamp: String(sign.timestamp), sign: sign.sign, ...base } : base);
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

// ---------------------------------------------------------------------------
// 任务通报（按任务号为话题）：单卡落位详情 + 收官/收帆花名册。数据全部来自
// 调用方（卡 events.jsonl + 卡目标），本文件保持纯字符串组装、零 IO 依赖。
// ---------------------------------------------------------------------------

/** 落位状态的图标与中文标签（单卡通报与花名册共用一套口径）。 */
const TASK_STATE_TAGS = {
  merged: '✅ 已出港',
  'awaiting-human': '⏸ 待船东放行',
  failed: '✗ 退关',
  blocked: '⚠ 搁浅',
};

/** 状态 → 「icon 中文」标签；未知状态原样展示（STATES 扩展时通知不哑）。 */
export function taskStateTag(state) {
  return TASK_STATE_TAGS[state] ?? `⚠ ${state ?? '?'}`;
}

/** 令牌数人话化：2144339 → '2.1M'、360248 → '360k'；非正数返回空串（不占版面）。 */
export function humanTokens(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return '';
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (v >= 1000) return `${Math.round(v / 1000)}k`;
  return String(v);
}

/**
 * 从单卡事件流提炼「过程」阶段链一行：派发(引擎·档位[重试]) → 执行(时长/tokens) →
 * 门禁 → 审查 → 落位(合并短哈希)。只认类型白名单，worker_turn/budget_snapshot 等高频
 * 流忽略；blocked/failed 等中途落位天然缺后续段，缺哪段跳哪段。
 */
export function buildPhaseLine(events = []) {
  const ev = Array.isArray(events) ? events : [];
  let dispatch = '';
  let exec = '';
  let gates = '';
  let review = '';
  let merge = '';
  let escalated = '';
  for (const e of ev) {
    if (e?.type === 'task_accepted' && e.backend) dispatch = String(e.backend).replace('-headless', '');
    if (e?.type === 'tier_resolved' && e.tier) dispatch = `${dispatch}${dispatch ? '·' : ''}${e.tier}`;
    if (e?.type === 'worker_spawned' && Number(e.attempt) > 0) dispatch = `${dispatch}${dispatch ? '·' : ''}重试${e.attempt}次`;
    if (e?.type === 'engine_escalated' && e.to) escalated = `⏫切${String(e.to).replace('-headless', '')}`;
    if (e?.type === 'budget_snapshot' && Number(e.elapsed_min) > 0) {
      const tok = humanTokens(e.tokens_in);
      exec = `${e.elapsed_min}m${tok ? `/${tok} tok` : ''}`;
    }
    if (e?.type === 'gate_result' && e.result === 'fail') gates = '门禁✗';
    if (e?.type === 'review_verdict') {
      review = `审查${Number(e.blockers) ? `${e.blockers}阻塞` : '通过'}${Number(e.suggestions) ? `/${e.suggestions}建议` : ''}`;
    }
    if (e?.type === 'merged' && e.merge_commit) {
      merge = `${e.auto === false ? '人工' : '自动'}合并 ${String(e.merge_commit).slice(0, 7)}`;
    }
  }
  if (!gates && ev.some((e) => e?.type === 'gate_result')) gates = '门禁过';
  return [dispatch, escalated, exec, gates, review, merge].filter(Boolean).join(' → ');
}

/**
 * 单卡任务通报正文（按任务号为话题）：为什么（卡目标首行）/ 成果（worker 交付摘要）/
 * 过程（事件流阶段链）/ 结果（落位理由）。数据缺失的行整行省略——无事件流的调用退化为
 * 「【id】状态 + 结果」，与旧 buildSettleSummary 等价（接口兼容）。
 */
export function buildTaskDigest({ taskId, state, reason, why, events } = {}) {
  const lines = [`【${taskId ?? '?'}】${taskStateTag(state)}`];
  if (why) lines.push(`为什么：${String(why).slice(0, 80)}`);
  const ev = Array.isArray(events) ? events : [];
  const done = [...ev].reverse().find((e) => e?.type === 'worker_done' && e.summary);
  if (done) lines.push(`成果：${String(done.summary).slice(0, 100)}`);
  const phase = buildPhaseLine(ev);
  if (phase) lines.push(`过程：${phase}`);
  if (reason) lines.push(`结果：${String(reason).slice(0, 120)}`);
  return lines.join('\n');
}

/**
 * 任务花名册（收官/收帆摘要用）：每张卡一行「【id】icon 状态：目标首行」，回答
 * 「这次做了哪些任务」。超过 max 张截断并注总数；infoOf 查不到目标（卡已清理等）
 * 只列 id 与状态，不影响整行。
 */
export function buildTaskRoster(tasks, { max = 8, infoOf } = {}) {
  const list = Array.isArray(tasks) ? tasks : [];
  if (!list.length) return '';
  const lines = [];
  for (const t of list.slice(0, max)) {
    const info = typeof infoOf === 'function' ? infoOf(t) : null;
    const goal = info?.goal ? `：${String(info.goal).slice(0, 60)}` : '';
    lines.push(`- 【${t.id}】${taskStateTag(t.state)}${goal}`);
  }
  if (list.length > max) lines.push(`…共 ${list.length} 张（余略）`);
  return lines.join('\n');
}

/** darwin 钥匙串兜底（launchd/cron 环境变量极瘦的正解的第二道保险）：env 全空时按
 *  notify.keychainService（缺省 `${scheduleId}.webhook`）直接查 `security find-generic-password`。
 *  覆盖手动跑与 runner 两路（runner 的 export 是第一道；env 已设时不会走到这里）。
 *  非 darwin / 无条目 / 任何异常一律返回 null——通知是尽力而为，绝不阻断编排。 */
export function keychainWebhook(repoRoot) {
  if (process.platform !== 'darwin') return null;
  try {
    const service = keychainServiceName(repoRoot);
    const r = spawnSync('security', ['find-generic-password', '-s', service, '-w'], { encoding: 'utf8', timeout: 5000 });
    const v = (r.stdout || '').trim();
    return r.status === 0 && /^https?:\/\//i.test(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * 发通知。opts: { title, body, dryRun, webhookEnvs, repoRoot }
 * webhookEnvs 缺省只查旧名（独立调用者兼容）；cmdNightly 传 nightlyWebhookEnvs(repoRoot) 全清单。
 * env 全空且 darwin 时查钥匙串兜底（repoRoot 缺省按 cwd 仓库解析——与 loadWorkflowConfig 同源）。
 * 返回 { delivered: string[] }（已投递通道描述；dryRun 时为「将执行」描述）。
 */
export async function notify(opts = {}) {
  const { title = 'nightly', body = '', dryRun = false, webhookEnvs = [NIGHTLY_WEBHOOK_ENV], repoRoot } = opts;
  const delivered = [];
  let webhook = webhookEnvs.map((n) => process.env[n]).find(Boolean);
  let webhookSrc = 'env';
  if (!webhook && process.platform === 'darwin') {
    const viaKeychain = keychainWebhook(repoRoot);
    if (viaKeychain) {
      webhook = viaKeychain;
      webhookSrc = 'keychain';
    }
  }
  if (webhook) {
    // 飞书端点 + 已配置签名密钥 → 出站签名（C13）：timestamp 秒级字符串 + HMAC 摘要。
    // 未配置 = 现状不变（不签名）；密钥解析失败不阻断（通知尽力而为）。
    let sign = null;
    if (isFeishuWebhook(webhook)) {
      const sec = resolveSignSecret(repoRoot);
      if (sec) {
        const tsSec = String(Math.floor(Date.now() / 1000));
        sign = { timestamp: tsSec, sign: feishuSign(tsSec, sec.secret) };
      }
    }
    const payload = webhookPayload(webhook, title, body, new Date().toISOString(), sign);
    if (dryRun) {
      delivered.push(webhookSrc === 'keychain' ? `webhook POST（钥匙串） ${payload}` : `webhook POST ${webhook} ${payload}`);
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

// ---------------------------------------------------------------------------
// 双向批示卡片（notify.cardWebhook 开启才发；飞书 interactive 卡 + approval-listener 回流）。
// 文本通知（上方 notify()）永远是主通道——卡片是叠加层，只给「能点按钮」的飞书群。
// ---------------------------------------------------------------------------

/** 批示动作的按钮文案与飞书配色（approve/reject 按钮进卡；retry 由监听器白名单支持，卡面按需带出）。 */
const CARD_ACTION_BUTTONS = {
  approve: { text: '✅ 批准合并', type: 'primary' },
  reject: { text: '❌ 驳回', type: 'danger' },
  retry: { text: '🔁 打回重跑', type: 'default' },
};

/**
 * 构造飞书交互卡片（纯函数，不发网）：header 标题 + lark_md 摘要 + 按钮行。
 * actions 为白名单子集（approve/reject/retry），按钮 value 携带 { task, action }——
 * 飞书回调原样回传，approval-listener 靠它路由到 orchestrator approve/reject/retry。
 * taskId 为空（fleet 级事件如 weather_hold，没有可批示的单卡）不出按钮行，纯信息卡。
 * 返回 JSON 字符串（msg_type: interactive），调用方直接作 POST body。
 */
export function buildInteractiveCard({ title, taskId, reason, actions = ['approve', 'reject'] } = {}) {
  const mdLines = [];
  if (taskId) mdLines.push(`**任务：${taskId}**`);
  if (reason) mdLines.push(String(reason).slice(0, 300));
  const elements = [];
  if (mdLines.length) {
    elements.push({ tag: 'div', text: { tag: 'lark_md', content: mdLines.join('\n') } });
  }
  const buttons = (Array.isArray(actions) ? actions : []).filter((a) => CARD_ACTION_BUTTONS[a] && taskId);
  if (buttons.length) {
    elements.push({ tag: 'hr' });
    elements.push({
      tag: 'action',
      actions: buttons.map((a) => ({
        tag: 'button',
        text: { tag: 'plain_text', content: CARD_ACTION_BUTTONS[a].text },
        type: CARD_ACTION_BUTTONS[a].type,
        value: { task: String(taskId), action: a },
      })),
    });
  }
  return JSON.stringify({
    msg_type: 'interactive',
    card: {
      config: { wide_screen_mode: true },
      header: { template: 'orange', title: { tag: 'plain_text', content: String(title ?? '任务通报') } },
      elements,
    },
  });
}

/** 飞书 incoming webhook 域名判定（与 webhookPayload 的三家识别同口径）：交互卡片只有
 *  飞书格式实现了回流闭环，企业微信/Slack 端点跳过发卡（文本通知照旧，不发废格式）。 */
export function isFeishuWebhook(webhook) {
  return /open\.feishu\.cn|open\.larksuite\.com/i.test(String(webhook ?? ''));
}

/**
 * 双向批示卡片通道：对需要人工动作的落位/滞留事件，在 notify() 文本通知之外**额外**
 * POST 一张飞书交互卡片。前置三道闸：notify.cardWebhook 显式开启（缺省 false =
 * 完全不发，缺省行为零变化）→ webhook URL 经既有解析链可得（env 优先，darwin 钥匙串
 * 兜底，与 notify() 同源）→ 端点是飞书。三道任一不过即静默返回 { sent: false }，
 * 通知绝不影响编排。dryRun 不发网，返回将发送的 payload（测试用）。
 */
export async function notifyActionCard({ repoRoot, webhookEnvs, taskId, reason, title, dryRun = false } = {}) {
  const cardWebhook = loadWorkflowConfig(repoRoot)?.notify?.cardWebhook === true;
  if (!cardWebhook) return { sent: false };
  let webhook = (Array.isArray(webhookEnvs) ? webhookEnvs : []).map((n) => process.env[n]).find(Boolean);
  if (!webhook && process.platform === 'darwin') webhook = keychainWebhook(repoRoot);
  if (!webhook || !isFeishuWebhook(webhook)) return { sent: false };
  const payload = buildInteractiveCard({ title, taskId, reason });
  if (dryRun) {
    // dryRun 同样带签名（配置了密钥时）——dryRun 描述与实际发送共用同一形态（测试据此断言）
    let sign = null;
    const sec = resolveSignSecret(repoRoot);
    if (sec) {
      const tsSec = String(Math.floor(Date.now() / 1000));
      sign = { timestamp: tsSec, sign: feishuSign(tsSec, sec.secret) };
    }
    const signedPayload = sign
      ? JSON.stringify({ timestamp: sign.timestamp, sign: sign.sign, ...JSON.parse(payload) })
      : payload;
    return { sent: false, dryRun: true, payload: signedPayload, webhook };
  }
  try {
    // 交互卡片出站同样签名（C13）：飞书端点 + 已配置密钥才附；未配置 = 现状不变
    let bodyOut = payload;
    const sec = resolveSignSecret(repoRoot);
    if (sec) {
      const tsSec = String(Math.floor(Date.now() / 1000));
      bodyOut = JSON.stringify({ timestamp: tsSec, sign: feishuSign(tsSec, sec.secret), ...JSON.parse(payload) });
    }
    const res = await fetch(webhook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: bodyOut,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return { sent: true };
  } catch {
    // 通道故障不阻断编排（与 notify() 同哲学）：文本通知已在，卡片尽力而为
    return { sent: false };
  }
}
