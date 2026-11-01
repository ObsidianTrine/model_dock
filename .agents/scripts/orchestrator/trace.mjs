// trace.mjs — LLM 决策留底（decision trace）。
// 背景：编排器的三类 LLM 决策点——进展看门狗（watchdog.mjs watchdogCheck）、scan 语义
// 过滤（eventfilter.mjs semanticFilter）、独立审查（orchestrator.mjs reviewer 会话）——
// 此前只留了截断的 reason/verdict 字符串（事件里 ≤300 字符），模型当时看到的输入与原始
// 输出没有落盘：actuate 档看门狗误杀任务、smartFilter 误丢信号时无法复盘「模型为什么
// 这么判」。参考 DeepSeek《Super-agent 设计探索》第 6 节 Watchdog 的可问询形态——留底
// 是「向它询问故障原因」的前提。
//
// 设计约束（永不静默 × 防刷屏的平衡）：
//   - 写失败绝不抛、绝不影响主流程：try/catch 包死；stderr 告警每进程每 kind 最多一次
//     （同 kind 反复失败只报第一次，防长跑刷屏）。
//   - 截断上界：input/output 序列化后超上界（缺省 64KB）截前缀存 { text, truncated,
//     originalBytes }，未超限存原始字符串。UTF-8 按字节截断但回退到码点边界（中文不断字）。
//   - 滚动保留：每 <root>/decisions/<kind>-*.json 前缀最多 maxPerTask（缺省 20）份，
//     超出删最旧（文件名含毫秒级时间戳 + 序号，字典序 = 时间序；删除失败仅告警一次）。
//
// 落点与口径：writeDecisionTrace 的 root = 该决策主体的日志目录（logs/<taskId>，与
// events.jsonl 同层——orchestrator 即 .agents/orchestrator/logs/<taskId>；scan 固定
// logs/scan）。无独立任务卡的主体（scan / orchestrator 全局层）用固定名充当目录尾段，
// 由调用方拼进 root；taskId 原样记进 JSON 供归档/拷贝后仍可辨认主体。
// readDecisionTraces 按仓库根口径定位（logDir(repoRoot, taskId)/decisions），供后续
// 排查命令使用（本模块只提供函数，不做 CLI）。

import fs from 'node:fs';
import path from 'node:path';
import { logDir, toIsoLocal } from './events.mjs';

/** input/output 序列化后的截断上界缺省值（KB）。 */
export const DEFAULT_MAX_INPUT_KB = 64;
/** 每 <root>/decisions/<kind>-* 前缀的滚动保留份数缺省值。 */
export const DEFAULT_MAX_PER_TASK = 20;

/** 每进程每 kind 最多一次的失败告警（防刷屏；kind 缺失归入 '?' 桶）。 */
const warnedKinds = new Set();

function warnOnce(kind, msg) {
  const k = kind || '?';
  if (warnedKinds.has(k)) return;
  warnedKinds.add(k);
  console.error(`[decision-trace] ${k}: ${msg}`);
}

/** 正整数参数归一：非法（含 0/负/小数/非数）返回 null，由调用方回落缺省。 */
function posInt(v) {
  return Number.isInteger(v) && v > 0 ? v : null;
}

/**
 * UTF-8 按字节取前缀，回退到码点边界（不劈开多字节字符）。
 * 原理：从 maxBytes 位置向前跳过 UTF-8 续字节（10xxxxxx），最终停在本码点起始字节上——
 * 该起始字节整体落在前缀之外，前缀内不会出现半截序列。
 */
function utf8SafePrefix(str, maxBytes) {
  const buf = Buffer.from(str, 'utf8');
  if (maxBytes >= buf.length) return str;
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString('utf8');
}

/**
 * 单字段截断：未超限返回原始字符串；超限返回 { text, truncated: true, originalBytes }。
 * 非 string 值先 JSON.stringify（接线方实际都传 prompt 全文字符串，这是防御）。
 */
function clipField(value, maxBytes) {
  if (value == null) return { value: null };
  const str = typeof value === 'string' ? value : JSON.stringify(value);
  const originalBytes = Buffer.byteLength(str, 'utf8');
  if (originalBytes <= maxBytes) return { value: str };
  return { value: { text: utf8SafePrefix(str, maxBytes), truncated: true, originalBytes } };
}

/** 进程内序号（文件名尾段，防同毫秒撞名；跨进程同毫秒由落盘前的存在性检查兜底）。 */
let seqCounter = 0;

/**
 * 写一条 LLM 决策留底。返回落盘文件绝对路径；失败返回 null（绝不抛）。
 *
 * @param {object} trace
 *   - root   决策主体的日志目录（logs/<taskId>，与 events.jsonl 同层）
 *   - taskId 主体 id（任务卡 id 或 scan/orchestrator 等固定名；记入 JSON 留痕，可省）
 *   - kind   决策类型（watchdog | smartfilter | review；也是文件名前缀与滚动单位）
 *   - input  传给模型的输入全文（prompt / 时间线摘要；超限截前缀）
 *   - output 模型原始输出全文（超限截前缀）
 *   - parsed 解析后的结构化结果（verdict / 数组 / null）
 *   - meta   附加信息（backend/model/耗时/error 等，有则带）
 * @param {object} [opts] { maxInputKB?, maxOutputKB?, maxPerTask? }（workflow.json trace
 *   键经 resolveTrace 解析后透传；缺省 64KB / 64KB / 20 份）
 */
export function writeDecisionTrace(trace = {}, opts = {}) {
  const { root, taskId, kind, input, output, parsed, meta } = trace ?? {};
  try {
    if (!root || !kind) throw new Error('缺 root 或 kind（决策留底需要落点目录与类型前缀）');
    const maxInputKB = posInt(opts.maxInputKB) ?? DEFAULT_MAX_INPUT_KB;
    const maxOutputKB = posInt(opts.maxOutputKB) ?? maxInputKB; // output 同规则，缺省跟随 input 上界
    const maxPerTask = posInt(opts.maxPerTask) ?? DEFAULT_MAX_PER_TASK;
    const dir = path.join(root, 'decisions');
    fs.mkdirSync(dir, { recursive: true });
    const record = {
      ts: toIsoLocal(),
      kind,
      ...(taskId ? { taskId } : {}),
      input: clipField(input, maxInputKB * 1024).value,
      output: clipField(output, maxOutputKB * 1024).value,
      ...(parsed !== undefined ? { parsed } : { parsed: null }),
      ...(meta && typeof meta === 'object' && !Array.isArray(meta) ? { meta } : {}),
    };
    // 文件名时间戳：ISO 本地时（与事件 ts 同口径便于对照），冒号/加号换连字符——
    // Windows 文件名禁冒号；字段定宽，字典序即时间序（滚动删除按名排序取最旧）
    const stamp = toIsoLocal().replace(/[:+]/g, '-');
    let file = path.join(dir, `${kind}-${stamp}-${String(++seqCounter).padStart(6, '0')}.json`);
    while (fs.existsSync(file)) file = path.join(dir, `${kind}-${stamp}-${String(++seqCounter).padStart(6, '0')}.json`);
    fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    pruneDecisions(dir, kind, maxPerTask);
    return file;
  } catch (e) {
    warnOnce(kind, `决策留底写入失败（不影响主流程，本进程此类型不再重复告警）：${String(e?.message ?? e).slice(0, 200)}`);
    return null;
  }
}

/** 滚动保留：dir 内 <kind>-*.json 超出 maxPerTask 删最旧；删除失败（Windows 文件被占用
 *  常见）本轮放弃并走每 kind 一次的告警，下轮写入再清。 */
function pruneDecisions(dir, kind, maxPerTask) {
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(`${kind}-`) && f.endsWith('.json'))
    .sort();
  for (let i = 0; i < files.length - maxPerTask; i++) {
    try {
      fs.unlinkSync(path.join(dir, files[i]));
    } catch (e) {
      warnOnce(kind, `决策留底滚动清理失败（${files[i]}，超出 ${maxPerTask} 份上限的旧文件本轮保留）：${String(e?.message ?? e).slice(0, 200)}`);
      return;
    }
  }
}

/**
 * 只读列出某主体的决策留底（排查命令的数据源；本任务只提供函数，不做 CLI）。
 * @param {string} root 仓库根（logDir 口径，与 readEvents 一致）
 * @param {string} taskId 任务卡 id 或固定主体名（scan / orchestrator）
 * @param {object} [opts] { kind?, limit? }：kind 按文件名前缀过滤；limit 截取最新 n 条
 * @returns {Array<{ file: string, doc: object }>} 按文件名降序（文件名含定宽时间戳：
 *   同 kind 内即时间新→旧；不传 kind 时跨类型按前缀分组，排查建议带 kind）；损坏文件
 *   跳过（与 readEvents 同哲学：半行/损坏不抛错）
 */
export function readDecisionTraces(root, taskId, opts = {}) {
  const dir = path.join(logDir(root, taskId), 'decisions');
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return []; // 目录不存在（从未留底）按空处理，不抛
  }
  files.sort().reverse(); // 文件名含定宽时间戳：同 kind 前缀内字典序降序 = 时间新→旧
  if (opts.kind) files = files.filter((f) => f.startsWith(`${opts.kind}-`));
  if (Number.isInteger(opts.limit) && opts.limit > 0) files = files.slice(0, opts.limit);
  const out = [];
  for (const f of files) {
    try {
      out.push({ file: path.join(dir, f), doc: JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) });
    } catch {
      /* 损坏文件跳过 */
    }
  }
  return out;
}
