#!/usr/bin/env node
// verify-provider-quota-scope.mjs — 上游供应商配额口径诊断（内部工具，不对外分发）。
//
// 回答的问题：某 provider 的额度配额是「账户级共享」（所有模型一个池）还是「按模型分池」
// （每模型独立配额/计费）。这决定 ModelDock 模型级容灾（provider.model_fallback：额度耗尽时
// 同 provider 换备用模型）对用户是否真有增益：
//   - 账户级共享 → 主模型 402 时备用模型同样 402，模型级容灾无增益（失败模式安全：原样回 402）；
//   - 按模型分池 → 主模型挂、备用模型通，模型级容灾有效。
//
// 原理：对同一 provider 的主模型与备用模型各发一条最小请求（max_tokens=1、messages 一条
// hello——花最少的钱），看两者是否「同时」返回额度类错误：
//   全部耗尽  → 疑似账户级共享配额；主挂备通 → 疑似按模型分池。
//
// 分类口径（与 src/gateway/relay.ts 的 QUOTA_BODY_RE / isQuotaExhausted 语义一致，独立实现，
// 不 import src/——本脚本零第三方依赖、可脱离仓库独立运行）：
//   - HTTP 200 / 4xx 内容类（400/404/413/422 等，非鉴权非额度）→ 该模型池可用（计费闸门已过）；
//   - HTTP 402，或 429 且响应体含额度特征 → 额度耗尽（正则 quota|insufficient|额度|配额|余额|欠费，
//     中英文都认；除原始文本外同时测 JSON 各字符串字段的解码值，防 \uXXXX 转义漏检）；
//   - 429 无额度特征 → 限流。限流不等于额度耗尽，等 30s 重试一次再判（脚本自动重试，
//     每模型最多 2 条请求；仍限流则标注，结论按「待确认」处理）；
//   - 401/403 → 鉴权/权限问题（非额度原因；任一模型鉴权失败时整体判定不可信，见结论提示）；
//   - 其他状态/网络错误 → 原样展示。
//
// 用法：
//   node scripts/verify-provider-quota-scope.mjs --base-url <上游base_url> --key <API key> \
//        --models <主模型>,<备用模型>[,<更多模型...>] [--protocol openai|anthropic]
//
//   --base-url   上游 OpenAI 兼容 base_url（如 https://ark.cn-beijing.volces.com/api/v3）；
//                openai 协议自动补 /chat/completions，anthropic 协议自动补 /v1/messages
//                （base_url 已含完整端点路径时原样使用）
//   --key        API key，命令行粘贴传入。只经内存使用，绝不落盘、绝不打进输出/日志
//                （输出仅显示前 6 位掩码；异常兜底路径对输出做 key 全文清洗）。
//                本脚本绝不读取任何密钥存储文件。
//   --models     逗号分隔，第一个为主模型、其余为备用模型（≥2 个才有判定意义）
//   --protocol   openai（默认）| anthropic
//
// 环境变量（内部自测钩子，正常使用无需设置）：
//   VERIFY_QUOTA_RETRY_WAIT_MS  覆盖 429 限流重试等待毫秒数（默认 30000）
//
// 安全与费用提示：
//   - 本脚本向真实上游发请求，消耗真实额度——每模型 1 条 max_tokens=1 请求，几毛钱级；
//   - 429 限流时自动等 30s 重试一次（每模型最多 2 条请求）；
//   - key 不写入任何文件，进程退出即丢弃。

import http from 'node:http';
import https from 'node:https';

const RETRY_WAIT_MS = Number(process.env.VERIFY_QUOTA_RETRY_WAIT_MS) || 30_000;
const REQUEST_TIMEOUT_MS = 30_000;
const BODY_CAP_BYTES = 256 * 1024;
// 与 src/gateway/relay.ts QUOTA_BODY_RE 语义一致（quota|insufficient|额度|配额|余额|欠费，/i）
const QUOTA_BODY_RE = /quota|insufficient|额度|配额|余额|欠费/i;
const MODEL_NAME_RE = /^[\w.:/-]{1,200}$/;

const USAGE = [
  '用法：node scripts/verify-provider-quota-scope.mjs \\',
  '         --base-url <上游base_url> --key <API key> \\',
  '         --models <主模型>,<备用模型>[,<更多模型...>] [--protocol openai|anthropic]',
].join('\n');

function die(msg, code = 1) {
  console.error(`[verify-provider-quota-scope] ${msg}`);
  if (code === 1) console.error(USAGE);
  process.exit(code);
}

// ── 参数解析（零依赖手写）────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const m = a.match(/^--([a-z-]+)$/);
    if (!m) die(`无法识别的参数：${a}`);
    const val = argv[++i];
    if (val === undefined || val.startsWith('--')) die(`参数 ${a} 缺值`);
    args[m[1]] = val;
  }
  return args;
}

const raw = parseArgs(process.argv.slice(2));
for (const req of ['base-url', 'key', 'models']) {
  if (!raw[req]) die(`缺少必填参数 --${req}`);
}
const baseUrl = raw['base-url'];
const apiKey = raw.key;
const models = raw.models.split(',').map((s) => s.trim()).filter(Boolean);
const protocol = raw.protocol || 'openai';

if (models.length < 1) die('--models 至少要 1 个模型（主模型 + 备用模型逗号分隔，≥2 个才有判定意义）');
if (models.length < 2) console.error('[verify-provider-quota-scope] 提示：只给了 1 个模型——没有备用模型可对照，无法判定配额口径（建议给 ≥2 个）');
if (new Set(models).size !== models.length) die('--models 有重复模型名——同名模型互相对照无判定意义');
for (const m of models) {
  if (!MODEL_NAME_RE.test(m)) die(`模型名不合法：${JSON.stringify(m)}（只允许字母数字与 . : / - _）`);
}
if (!['openai', 'anthropic'].includes(protocol)) die(`--protocol 只支持 openai|anthropic，收到：${protocol}`);
if (apiKey.length < 8) die('--key 看起来不像有效的 API key（长度 < 8）——请粘贴完整 key');
if (!(RETRY_WAIT_MS >= 0 && RETRY_WAIT_MS <= 10 * 60_000)) die(`VERIFY_QUOTA_RETRY_WAIT_MS 非法：${process.env.VERIFY_QUOTA_RETRY_WAIT_MS}（0 ~ 600000）`);

// key 掩码：任何输出只允许出现掩码形态
function maskKey(key) {
  return `${key.slice(0, 6)}****（已掩码）`;
}
const KEY_LITERAL = apiKey;

// 全局兜底：任何意外报错路径都不得把 key 泄进 stderr（全文清洗后输出）
process.on('uncaughtException', (e) => {
  console.error(`[verify-provider-quota-scope] 未捕获异常：${redact(String(e?.stack || e))}`);
  process.exit(2);
});
process.on('unhandledRejection', (e) => {
  console.error(`[verify-provider-quota-scope] 未处理的 Promise 拒绝：${redact(String(e?.stack || e))}`);
  process.exit(2);
});
function redact(s) {
  return KEY_LITERAL ? s.split(KEY_LITERAL).join('***') : s;
}

// ── endpoint 归一 ───────────────────────────────────────────────────────────
function buildEndpoint(baseUrl, protocol) {
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    die(`--base-url 不是合法 URL：${baseUrl}`);
  }
  if (!['http:', 'https:'].includes(url.protocol)) die(`--base-url 只支持 http/https，收到：${url.protocol}`);
  let path = url.pathname.replace(/\/+$/, '');
  if (protocol === 'openai') {
    if (!path.endsWith('/chat/completions')) path += '/chat/completions';
  } else if (path.endsWith('/messages')) {
    // 已是完整 messages 端点，原样使用
  } else if (path.endsWith('/v1')) {
    path += '/messages';
  } else {
    path += '/v1/messages';
  }
  url.pathname = path;
  url.search = '';
  url.hash = '';
  return url;
}
const endpoint = buildEndpoint(baseUrl, protocol);

// ── 最小请求（max_tokens=1 + 一条 hello，花最少的钱）─────────────────────────
function postOnce(url, protocol, key, model, timeoutMs) {
  const body = JSON.stringify({
    model,
    max_tokens: 1,
    messages: [{ role: 'user', content: 'hello' }],
  });
  const headers = { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) };
  if (protocol === 'openai') {
    headers.authorization = `Bearer ${key}`;
  } else {
    headers['x-api-key'] = key;
    headers['anthropic-version'] = '2023-06-01';
  }
  const mod = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.request(
      url,
      { method: 'POST', headers, timeout: timeoutMs },
      (res) => {
        const chunks = [];
        let size = 0;
        let capped = false;
        res.on('data', (c) => {
          size += c.length;
          if (size <= BODY_CAP_BYTES) chunks.push(c);
          else capped = true;
        });
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8') + (capped ? '\n…(响应体超长截断)' : '');
          resolve({ status: res.statusCode ?? 0, text });
        });
      },
    );
    req.on('timeout', () => {
      req.destroy(new Error(`请求超时（${timeoutMs}ms）`));
    });
    req.on('error', (e) => reject(e));
    req.end(body);
  });
}

// ── 响应体额度特征检测（独立实现；原始文本 + JSON 字段解码值双重检测）──────────
function bodyHasQuotaSignal(text) {
  if (!text) return false;
  if (QUOTA_BODY_RE.test(text)) return true;
  // 上游可能把中文以 \uXXXX 转义进 JSON——解析后逐字段再测一遍，防漏检
  try {
    const stack = [JSON.parse(text)];
    while (stack.length) {
      const cur = stack.pop();
      if (typeof cur === 'string') {
        if (QUOTA_BODY_RE.test(cur)) return true;
      } else if (Array.isArray(cur)) {
        stack.push(...cur);
      } else if (cur && typeof cur === 'object') {
        stack.push(...Object.values(cur));
      }
    }
  } catch {
    /* 非 JSON 体：只按原始文本判定 */
  }
  return false;
}

function classify(status, text) {
  const quota = bodyHasQuotaSignal(text);
  if (status >= 200 && status < 300) return { cat: 'ok', label: '可用' };
  if (status === 402) return { cat: 'exhausted', label: '额度耗尽（HTTP 402）' };
  if (status === 429) {
    return quota
      ? { cat: 'exhausted', label: '额度耗尽（429 且体含额度特征）' }
      : { cat: 'rate_limited', label: '限流（429 无额度特征）' };
  }
  if (status === 401 || status === 403) return { cat: 'auth', label: `鉴权/权限问题（HTTP ${status}）` };
  if (status >= 300 && status < 400) return { cat: 'other', label: `HTTP ${status} 重定向——base_url 路径可能不完整（本脚本不跟随重定向），请检查 base_url` };
  if (status >= 400 && status < 500) {
    const note = status === 404 ? '——请确认模型名拼写、base_url 路径与 --protocol 是否匹配' : '';
    return { cat: 'ok', label: `可用（4xx 内容类：HTTP ${status}${note}；计费/额度闸门已过）` };
  }
  if (quota) return { cat: 'other', label: `HTTP ${status}（体含额度特征但状态码非 402/429——部分供应商用其他状态码表达额度问题，请人工确认）` };
  return { cat: 'other', label: `HTTP ${status}` };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function truncateBody(text) {
  if (!text) return '';
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > 200 ? `${oneLine.slice(0, 200)}…` : oneLine;
}

async function probeModel(model, index, total) {
  const prefix = `[${index + 1}/${total}] ${model}`;
  let result;
  try {
    result = await postOnce(endpoint, protocol, KEY_LITERAL, model, REQUEST_TIMEOUT_MS);
  } catch (e) {
    return { model, cat: 'net_fail', label: `网络/超时失败：${redact(e?.message || String(e))}`, detail: '' };
  }
  let verdict = classify(result.status, result.text);
  // 限流不等于额度耗尽：等 30s 重试一次再判
  if (verdict.cat === 'rate_limited') {
    process.stdout.write(`${prefix} … 限流，等 ${Math.round(RETRY_WAIT_MS / 1000)}s 重试一次再判…\n`);
    await sleep(RETRY_WAIT_MS);
    let retryText = '';
    try {
      const retry = await postOnce(endpoint, protocol, KEY_LITERAL, model, REQUEST_TIMEOUT_MS);
      retryText = retry.text;
      verdict = classify(retry.status, retry.text);
      if (verdict.cat === 'rate_limited') {
        const waited = Math.round(RETRY_WAIT_MS / 1000);
        verdict = {
          ...verdict,
          label: `限流（429 无额度特征；已自动等 ${waited}s 重试一次仍限流）——限流不等于额度耗尽，等 30s 重试一次再判（建议稍后再跑确认）`,
        };
      }
    } catch (e) {
      verdict = { cat: 'net_fail', label: `重试网络/超时失败：${redact(e?.message || String(e))}`, detail: '' };
    }
    return { model, ...verdict, detail: truncateBody(redact(retryText)) };
  }
  return { model, ...verdict, detail: truncateBody(redact(result.text)) };
}

// ── 主流程 ──────────────────────────────────────────────────────────────────
console.log('ModelDock 上游配额口径诊断（模型级容灾增益验证）');
console.log(`base_url: ${baseUrl}`);
console.log(`endpoint: ${endpoint.origin}${endpoint.pathname}`);
console.log(`protocol: ${protocol}`);
console.log(`key: ${maskKey(KEY_LITERAL)}`);
console.log(`models: ${models.join(', ')}`);
console.log('提示：本脚本向真实上游发请求，消耗真实额度（每模型 1 条 max_tokens=1 最小请求，几毛钱级）。');
console.log('');

const results = [];
for (let i = 0; i < models.length; i++) {
  const r = await probeModel(models[i], i, models.length);
  results.push(r);
  console.log(`[${i + 1}/${models.length}] ${r.model} … ${r.label}${r.detail ? `｜体: ${r.detail}` : ''}`);
}

// ── 判定结论 ────────────────────────────────────────────────────────────────
const by = (cat) => results.filter((r) => r.cat === cat).map((r) => r.model);
const exhausted = by('exhausted');
const ok = by('ok');
const limited = by('rate_limited');
const auth = by('auth');
const other = by('other');
const netFail = by('net_fail');

console.log('');
console.log('════ 判定结论 ════');

if (netFail.length === results.length) {
  console.error('全部请求网络/超时失败——无法判定。请检查 base_url 可达性、本机代理与防火墙后重跑。');
  process.exit(2);
}
if (auth.length) {
  console.log(`注意：${auth.join(', ')} 鉴权/权限失败（HTTP 401/403）——key 无效或账号无该模型权限时，其余判定不可信。请先确认 key 与模型权限再重跑。`);
}
if (other.length) {
  console.log(`注意：${other.join(', ')} 返回其他状态（见上方原样展示）——不在 402/429 判定口径内，请人工确认后再下结论。`);
}

let conclusive = true;
if (exhausted.length === results.length) {
  console.log('疑似账户级共享配额（模型级容灾无增益）：所有模型同时额度耗尽，主模型 402 时备用模型同样 402。');
  console.log('失败模式安全（原样回 402）；建议把容灾放在跨 provider 备用（provider 级 fallback）而非模型级。');
} else if (exhausted.length && ok.length) {
  console.log(`疑似按模型分池（模型级容灾有效）：可用=${ok.join(', ')}；耗尽=${exhausted.join(', ')}。`);
  console.log('主模型额度耗尽时备用模型仍可用，provider.model_fallback 有真实增益。');
} else if (exhausted.length) {
  console.log(`疑似按模型分池（倾向）：耗尽=${exhausted.join(', ')}；但其余模型是限流/其他状态而非明确可用，判定不完全。`);
  conclusive = false;
} else if (ok.length === results.length) {
  console.log('所有模型池当前均有额度——本次没有额度耗尽样本，无法判定配额口径。');
  console.log('本测试只在主模型额度真正耗尽时有信息量；建议在额度耗尽窗口（或用极小额度套餐）重跑。');
} else if (ok.length && limited.length) {
  console.log('可判定的模型当前均有额度、无额度耗尽样本——暂无「按模型分池」证据。');
  conclusive = false;
} else {
  console.log('额度耗尽样本不足且无完整可用对照——无法判定配额口径（见上方各模型状态与注意事项）。');
  conclusive = false;
}
if (limited.length) {
  console.log(`限流样本：${limited.join(', ')}——限流不等于额度耗尽，等 30s 重试一次再判（脚本已自动重试一次仍限流）。`);
  console.log('存在限流样本时判定是初步的：等 30s 以上重跑一次，若限流模型转为 402/可用再下最终结论。');
  conclusive = false;
}
if (conclusive && !auth.length && !other.length) {
  console.log('（判定基于本次实测；供应商套餐调整可能改变配额口径，结论仅对当前套餐有效。）');
}
