// workflow-config.mjs — .agents 工具链的唯一项目配置入口（.agents/workflow.json）。
// 可移植性设计（2026-10-07）：所有项目专属红线数据（受保护端口/核心路径/发布流水线/
// 审查红线文本/包管理器）都住在这个 JSON 里；代码只认配置，缺省即关闭对应红线，
// 不再假设 npm/SEA/8687。字段：
//   baseBranch      feature 分支的合并目标（feature-branch.mjs / guard 的基准分支集合）
//   baseBranches    guard 保护的分支显式清单（可选；缺省 = main + baseBranch）。
//                   多基准分支仓库用：如 develop+master 双分支保护 ["develop","master"]
//   testCmd         finish/门禁的验证命令（字符串 | 数组 | {win32,unix} 平台映射）
//   buildCmd        构建门禁命令（缺省 = 跳过 build 门禁）
//   lintCmd         lint 门禁命令（缺省 = 跳过；失败进调试子循环，与 build 同级）
//   typecheckCmd    类型检查门禁命令（缺省 = 跳过；失败进调试子循环，与 build 同级）
//   packageManager  npm | pnpm | yarn | bun | 其他任意串；npm 系才启用 native addon 扫描
//   protectedPorts  受保护端口（空 = 不做端口红线）；如 ["8687","8890"]
//   corePaths       核心路径（改动即 L2 人工 / 人工闸门标红）
//   releasePaths    发布流水线路径前缀（触及即 L3 永远人工）
//   reviewNotes     注入独立审查/spec planner 提示词的项目红线文本（自由文本）
//   uiCheckCmd      UI 冒烟门禁命令（任务卡 ui_check: true 时跑；缺省 = 卡声明 ui_check 直接报错）
//   envPrefix       escape hatch 环境变量前缀（默认 "AGENTS" → AGENTS_ALLOW_RELEASE 等；
//                   旧项目名 MODELRDOCK_* 永远兼容识别）
//   version         配置 schema 版本（agent-init 生成时写 1；工具链按缺失向后兼容）
//   projectName     项目展示名（通知标题/调度任务名）；缺省 package.json name > 仓库目录名
//   listenCommandNames  项目自备可执行命令名，参与受保护端口的「启动监听」拦截正则
//                       （node/tsx/npx/npm run 是通用形态永远参与；如 ["modeldock","gateway"]）
//   scheduleId      nightly 调度标识（launchd label / crontab 标记段）；缺省 com.<slug(projectName)>.orchestrator-nightly
//   gatewayLogDir   网关请求日志目录（支持 ~/ 展开）——配置了才启用 reconcile 对账；
//                   缺省 = 对账关闭（吃狗粮是走网关的项目才有的能力）
//   driftThreshold  自动合并回溯失败率的降级阈值（0 < v ≤ 1，缺省 0.2）。只可调严/调松，
//                   不可关闭——漂移监控没有「不监控」档
//   reviewMaxTurns  LLM 审查会话的轮次上限（正整数，缺省 30）
//   fastlaneAllowed 轻卡快速通道总开关（缺省 true）：任务卡 frontmatter 可声明
//                   fastlane: true 跳过 LLM 审查子循环（门禁/分级闸门不省）；设 false
//                   后即使卡声明 fastlane 也按常规链路跑审查（fastlane_skipped 事件
//                   reason=disabled_by_config 留痕）——团队级全局关闭开关
//   watchdog        LLM 进展看门狗：{ mode?: 'observe'|'actuate', everyTurns?: 正整数 }。
//                   缺省 observe（疑似空转只记 watchdog_suspect 事件，不动作）；actuate 下
//                   连续 2 次 suspect 走熔断 kill→blocked。非法值回落缺省并 console.warn 告警
//   autopilot       自主提案的授权配置：{ enabled?: bool（缺省 false=全人工），
//                   autoSubmitTypes?: 卡类型白名单（缺省 ["docs"]），
//                   autoDrainPerCycle?: 正整数（watch/nightly 每周期 drain 上限，缺省 0=不限），
//                   maxProposalsPerCycle?: 正整数（propose 单轮提案上限，缺省 3） }。
//                   授权语义见 autopilot.mjs：自动提交 ≠ 自动合并（gate 覆写 L1，
//                   实际分级 L2/L3 照样回人工闸门）；deps/核心路径/人工草稿永不自动
//   weatherHold     风暴闸（weather hold，可选键）：{ threshold?: 正整数（缺省 3），
//                   windowMinutes?: 正整数（缺省 60），upstream?: { threshold: 正整数,
//                   windowMinutes?: 正整数（缺省 15） } }。键存在才启用——drain/nightly --auto/
//                   watch 派发前统计窗口内各任务 worker_retry 合计，达阈值即停止派发
//                   （无状态，窗口滑过自动恢复）；upstream 子键启用上游海况：网关日志
//                   （gatewayLogDir，须已配）窗口内 429/402 合计达阈同样滞留（外部风暴）；
//                   删掉该键 = 关闭风暴闸（行为与历史版本一致）
//   autoResume      blocked 卡有限自动续跑：{ enabled?: boolean（缺省 true）, maxPerRun?: 正整数
//                   （缺省 2）, cooldownHours?: 正整数（缺省 24） }。drain 选卡前对「transient 类
//                   失败 blocked」的卡自动 resume（资格判定见 orchestrator/autoresume.mjs）：
//                   只续 429 限流/网络类、每卡冷却期内最多 1 次、每次 drain ≤maxPerRun 张、
//                   auto_resume 事件留痕；enabled=false 完全不扫 blocked/。非法值回落缺省并
//                   console.warn 告警
//   trace           LLM 决策留底：{ enabled?: boolean（缺省 true）, maxPerTask?: 正整数
//                   （缺省 20）, maxInputKB?: 正整数（缺省 64） }。三类 LLM 决策点（看门狗
//                   watchdog / scan 语义过滤 smartfilter / 独立审查 review）把模型输入与
//                   原始输出落盘到 logs/<taskId>/decisions/<kind>-*.json 供复盘（见
//                   orchestrator/trace.mjs）：input/output 超上界截前缀（{ truncated,
//                   originalBytes } 标记）、每 kind 滚动保留 maxPerTask 份；enabled=false
//                   完全不留底。非法值回落缺省并 console.warn 告警
//
// 锚定策略（两个调用场景，务必区分）：
//   - hook（guard-develop / policy-worker）：进程 cwd 是任意客户端工作目录，
//     必须**脚本锚定**（本模块所在 .agents/scripts 的上一级）——hook 文件与
//     workflow.json 随仓库同进退，脚本相对定位永远正确。
//   - orchestrator / 门禁：操作对象是 repoRoot（可能是集成测试的临时仓库），
//     必须显式传 repoRoot 锚定，读 <repoRoot>/.agents/workflow.json。
// 零第三方依赖（.agents/ 工具链红线）。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_ANCHOR_CONFIG = path.resolve(HERE, '..', 'workflow.json');
const SCRIPT_ANCHOR_REPO = path.resolve(HERE, '..', '..');

/** workflow.json 的路径。repoRoot 显式给出时锚定该仓库，否则锚定脚本自身所在仓库。 */
export function workflowConfigPath(repoRoot) {
  return repoRoot ? path.join(repoRoot, '.agents', 'workflow.json') : SCRIPT_ANCHOR_CONFIG;
}

/**
 * 读取并规整 workflow.json。文件缺失/字段缺省 → 全部回落「关闭」缺省值，
 * 只有 baseBranch/testCmd 沿用 feature-branch.mjs 的既有回落（develop→当前分支 / 无验证）。
 * JSON 损坏抛错（阻断启动，错误可操作）。
 */
export function loadWorkflowConfig(repoRoot) {
  const cfgPath = workflowConfigPath(repoRoot);
  let raw = {};
  if (fs.existsSync(cfgPath)) {
    let text;
    try {
      text = fs.readFileSync(cfgPath, 'utf8');
    } catch (e) {
      throw new Error(`无法读取 ${cfgPath}：${e.message}`);
    }
    try {
      raw = JSON.parse(text);
    } catch (e) {
      throw new Error(`${cfgPath} 不是合法 JSON：${e.message}`);
    }
  }
  const strArr = (v) => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : []);
  return {
    version: typeof raw.version === 'number' && Number.isFinite(raw.version) ? raw.version : null,
    baseBranch: typeof raw.baseBranch === 'string' && raw.baseBranch.trim() ? raw.baseBranch.trim() : null,
    baseBranches: strArr(raw.baseBranches),
    testCmd: resolveTestCmd(raw.testCmd),
    buildCmd: typeof raw.buildCmd === 'string' && raw.buildCmd.trim() ? raw.buildCmd.trim() : null,
    lintCmd: typeof raw.lintCmd === 'string' && raw.lintCmd.trim() ? raw.lintCmd.trim() : null,
    typecheckCmd: typeof raw.typecheckCmd === 'string' && raw.typecheckCmd.trim() ? raw.typecheckCmd.trim() : null,
    packageManager: typeof raw.packageManager === 'string' && raw.packageManager.trim() ? raw.packageManager.trim().toLowerCase() : null,
    protectedPorts: strArr(raw.protectedPorts),
    corePaths: strArr(raw.corePaths),
    releasePaths: strArr(raw.releasePaths),
    reviewNotes: typeof raw.reviewNotes === 'string' ? raw.reviewNotes.trim() : '',
    uiCheckCmd: typeof raw.uiCheckCmd === 'string' && raw.uiCheckCmd.trim() ? raw.uiCheckCmd.trim() : null,
    worker: resolveEngine(raw.worker),
    review: resolveEngine(raw.review),
    tiers: resolveTiers(raw.tiers),
    budgetProfiles: resolveBudgetProfiles(raw.budgetProfiles),
    envPrefix: typeof raw.envPrefix === 'string' && /^[A-Z][A-Z0-9_]*$/i.test(raw.envPrefix.trim()) ? raw.envPrefix.trim() : 'AGENTS',
    projectName: deriveProjectName(repoRoot, raw),
    listenCommandNames: strArr(raw.listenCommandNames),
    scheduleId: typeof raw.scheduleId === 'string' && raw.scheduleId.trim() ? raw.scheduleId.trim() : null,
    gatewayLogDir: typeof raw.gatewayLogDir === 'string' && raw.gatewayLogDir.trim() ? expandHome(raw.gatewayLogDir.trim()) : null,
    driftThreshold: typeof raw.driftThreshold === 'number' && Number.isFinite(raw.driftThreshold) && raw.driftThreshold > 0 && raw.driftThreshold <= 1 ? raw.driftThreshold : 0.2,
    reviewMaxTurns: Number.isInteger(raw.reviewMaxTurns) && raw.reviewMaxTurns > 0 ? raw.reviewMaxTurns : 30,
    fastlaneAllowed: raw.fastlaneAllowed !== false, // 缺省 true；仅显式 false 关闭（其他值视为未配置）
    watchdog: resolveWatchdog(raw.watchdog),
    autopilot: resolveAutopilot(raw.autopilot),
    weatherHold: resolveWeatherHold(raw.weatherHold),
    autoResume: resolveAutoResume(raw.autoResume),
    trace: resolveTrace(raw.trace),
  };
}

/** watchdog 配置解析：{ mode: 'observe'|'actuate', everyTurns: 正整数 }，缺省 observe/20。
 *  非法值回落缺省并 console.warn 告警（可操作：指出哪个键、允许什么；stderr 输出，
 *  不污染 hook 的 stdout 裁决通道）。键缺失 = 沿用缺省，不告警。 */
function resolveWatchdog(raw) {
  const DEFAULTS = { mode: 'observe', everyTurns: 20 };
  const warn = (detail) =>
    console.warn(`[workflow-config] watchdog 配置非法，已回落缺省：${detail}（.agents/workflow.json 的 watchdog 键，mode 允许 observe|actuate、everyTurns 须为正整数）`);
  if (raw === undefined || raw === null) return DEFAULTS;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    warn(`应为对象 { mode?, everyTurns? }，当前为 ${JSON.stringify(raw)}`);
    return DEFAULTS;
  }
  const out = { ...DEFAULTS };
  if (raw.mode !== undefined) {
    if (raw.mode === 'observe' || raw.mode === 'actuate') out.mode = raw.mode;
    else warn(`mode ${JSON.stringify(raw.mode)} 不合法（允许 "observe" | "actuate"）`);
  }
  if (raw.everyTurns !== undefined) {
    if (Number.isInteger(raw.everyTurns) && raw.everyTurns > 0) out.everyTurns = raw.everyTurns;
    else warn(`everyTurns ${JSON.stringify(raw.everyTurns)} 不合法（须为正整数）`);
  }
  return out;
}

/** autopilot 授权配置解析：{ enabled, autoSubmitTypes, autoDrainPerCycle, maxProposalsPerCycle }。
 *  缺省 = 全关闭（enabled: false，行为与历史版本一致）。非法值回落缺省并 console.warn 告警；
 *  键缺失 = 沿用缺省，不告警。autoSubmitTypes 过滤到已知卡类型白名单。 */
function resolveAutopilot(raw) {
  const DEFAULTS = { enabled: false, autoSubmitTypes: ['docs'], autoDrainPerCycle: 0, maxProposalsPerCycle: 3 };
  const warn = (detail) =>
    console.warn(`[workflow-config] autopilot 配置非法，已回落缺省：${detail}（.agents/workflow.json 的 autopilot 键：{ enabled?: boolean, autoSubmitTypes?: 卡类型数组, autoDrainPerCycle?: 正整数, maxProposalsPerCycle?: 正整数 }）`);
  if (raw === undefined || raw === null) return DEFAULTS;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    warn(`应为对象 { enabled?, autoSubmitTypes?, autoDrainPerCycle?, maxProposalsPerCycle? }，当前为 ${JSON.stringify(raw)}`);
    return DEFAULTS;
  }
  const out = { ...DEFAULTS };
  if (raw.enabled !== undefined) out.enabled = raw.enabled === true;
  if (raw.autoSubmitTypes !== undefined) {
    const TYPES = ['bugfix', 'feature', 'docs', 'deps', 'refactor'];
    const arr = Array.isArray(raw.autoSubmitTypes)
      ? [...new Set(raw.autoSubmitTypes.map((x) => String(x).trim()).filter((x) => TYPES.includes(x)))]
      : [];
    out.autoSubmitTypes = arr;
  }
  if (raw.autoDrainPerCycle !== undefined) {
    out.autoDrainPerCycle = Number.isInteger(raw.autoDrainPerCycle) && raw.autoDrainPerCycle > 0 ? raw.autoDrainPerCycle : 0;
  }
  if (raw.maxProposalsPerCycle !== undefined) {
    out.maxProposalsPerCycle = Number.isInteger(raw.maxProposalsPerCycle) && raw.maxProposalsPerCycle > 0 ? raw.maxProposalsPerCycle : DEFAULTS.maxProposalsPerCycle;
  }
  return out;
}

/** blocked 卡自动续跑配置解析：{ enabled: boolean, maxPerRun: 正整数, cooldownHours: 正整数 }，
 *  缺省 true / 2 / 24（与 orchestrator/autoresume.mjs 的 DEFAULT_MAX_PER_RUN / DEFAULT_COOLDOWN_MS
 *  同一口径，改动须两处同步）。非法值回落缺省并 console.warn 告警（与 resolveWatchdog 同风格：
 *  stderr 输出可操作文案，不污染 hook 的 stdout 裁决通道，不阻断启动）。键缺失 = 沿用缺省，不告警。 */
function resolveAutoResume(raw) {
  const DEFAULTS = { enabled: true, maxPerRun: 2, cooldownHours: 24 };
  const warn = (detail) =>
    console.warn(`[workflow-config] autoResume 配置非法，已回落缺省：${detail}（.agents/workflow.json 的 autoResume 键，enabled 允许 true|false、maxPerRun/cooldownHours 须为正整数）`);
  if (raw === undefined || raw === null) return DEFAULTS;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    warn(`应为对象 { enabled?, maxPerRun?, cooldownHours? }，当前为 ${JSON.stringify(raw)}`);
    return DEFAULTS;
  }
  const out = { ...DEFAULTS };
  if (raw.enabled !== undefined) {
    if (typeof raw.enabled === 'boolean') out.enabled = raw.enabled;
    else warn(`enabled ${JSON.stringify(raw.enabled)} 不合法（允许 true | false）`);
  }
  if (raw.maxPerRun !== undefined) {
    if (Number.isInteger(raw.maxPerRun) && raw.maxPerRun > 0) out.maxPerRun = raw.maxPerRun;
    else warn(`maxPerRun ${JSON.stringify(raw.maxPerRun)} 不合法（须为正整数）`);
  }
  if (raw.cooldownHours !== undefined) {
    if (Number.isInteger(raw.cooldownHours) && raw.cooldownHours > 0) out.cooldownHours = raw.cooldownHours;
    else warn(`cooldownHours ${JSON.stringify(raw.cooldownHours)} 不合法（须为正整数）`);
  }
  return out;
}

/** 风暴闸配置解析：{ threshold, windowMinutes, upstream? }。与 resolveAutopilot 同风格：
 *  键缺失 = 功能关闭（null，行为与历史版本一致）；键存在时缺省 threshold 3 / windowMinutes 60。
 *  upstream 子键（可选，presence 启用）：{ threshold: 正整数（必填）, windowMinutes?（缺省 15）}
 *  ——上游海况（网关日志 429/402 实测）滞留阈值。非法值回落缺省并 console.warn 告警
 *  （stderr，不污染 stdout 裁决通道）；键内字段缺失 = 沿用该字段缺省，不告警。 */
function resolveWeatherHold(raw) {
  if (raw === undefined || raw === null) return null;
  const DEFAULTS = { threshold: 3, windowMinutes: 60 };
  const warn = (detail) =>
    console.warn(`[workflow-config] weatherHold 配置非法，已回落缺省：${detail}（.agents/workflow.json 的 weatherHold 键：{ threshold?: 正整数, windowMinutes?: 正整数, upstream?: { threshold: 正整数, windowMinutes?: 正整数 } }；删除该键 = 关闭风暴闸）`);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    warn(`应为对象 { threshold?, windowMinutes?, upstream? }，当前为 ${JSON.stringify(raw)}`);
    return { ...DEFAULTS };
  }
  const out = { ...DEFAULTS };
  if (raw.threshold !== undefined) {
    if (Number.isInteger(raw.threshold) && raw.threshold > 0) out.threshold = raw.threshold;
    else warn(`threshold ${JSON.stringify(raw.threshold)} 不合法（须为正整数）`);
  }
  if (raw.windowMinutes !== undefined) {
    if (Number.isInteger(raw.windowMinutes) && raw.windowMinutes > 0) out.windowMinutes = raw.windowMinutes;
    else warn(`windowMinutes ${JSON.stringify(raw.windowMinutes)} 不合法（须为正整数）`);
  }
  if (raw.upstream !== undefined && raw.upstream !== null) {
    const u = raw.upstream;
    const uBad = !u || typeof u !== 'object' || Array.isArray(u) || !Number.isInteger(u.threshold) || u.threshold <= 0;
    if (uBad) {
      warn(`upstream ${JSON.stringify(u)} 不合法（须为对象 { threshold: 正整数, windowMinutes?: 正整数 }）`);
    } else {
      out.upstream = { threshold: u.threshold, windowMinutes: 15 };
      if (u.windowMinutes !== undefined) {
        if (Number.isInteger(u.windowMinutes) && u.windowMinutes > 0) out.upstream.windowMinutes = u.windowMinutes;
        else warn(`upstream.windowMinutes ${JSON.stringify(u.windowMinutes)} 不合法（须为正整数）`);
      }
    }
  }
  return out;
}

/** LLM 决策留底配置解析：{ enabled: boolean, maxPerTask: 正整数, maxInputKB: 正整数 }，
 *  缺省 true / 20 / 64（与 orchestrator/trace.mjs 的 DEFAULT_MAX_PER_TASK / DEFAULT_MAX_INPUT_KB
 *  同一口径，改动须两处同步）。非法值回落缺省并 console.warn 告警（与 resolveWatchdog 同风格：
 *  stderr 输出可操作文案，不污染 hook 的 stdout 裁决通道，不阻断启动）。键缺失 = 沿用缺省，
 *  不告警。导出供 eventfilter.mjs 的 readScanConfig 复用（scan 不经 loadWorkflowConfig 读配置）。 */
export function resolveTrace(raw) {
  const DEFAULTS = { enabled: true, maxPerTask: 20, maxInputKB: 64 };
  const warn = (detail) =>
    console.warn(`[workflow-config] trace 配置非法，已回落缺省：${detail}（.agents/workflow.json 的 trace 键，enabled 允许 true|false、maxPerTask/maxInputKB 须为正整数）`);
  if (raw === undefined || raw === null) return DEFAULTS;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    warn(`应为对象 { enabled?, maxPerTask?, maxInputKB? }，当前为 ${JSON.stringify(raw)}`);
    return DEFAULTS;
  }
  const out = { ...DEFAULTS };
  if (raw.enabled !== undefined) {
    if (typeof raw.enabled === 'boolean') out.enabled = raw.enabled;
    else warn(`enabled ${JSON.stringify(raw.enabled)} 不合法（允许 true | false）`);
  }
  if (raw.maxPerTask !== undefined) {
    if (Number.isInteger(raw.maxPerTask) && raw.maxPerTask > 0) out.maxPerTask = raw.maxPerTask;
    else warn(`maxPerTask ${JSON.stringify(raw.maxPerTask)} 不合法（须为正整数）`);
  }
  if (raw.maxInputKB !== undefined) {
    if (Number.isInteger(raw.maxInputKB) && raw.maxInputKB > 0) out.maxInputKB = raw.maxInputKB;
    else warn(`maxInputKB ${JSON.stringify(raw.maxInputKB)} 不合法（须为正整数）`);
  }
  return out;
}

/** 项目名派生：workflow.json 显式 projectName > package.json name > 仓库目录名（可移植缺省链）。 */
function deriveProjectName(repoRoot, raw) {
  if (typeof raw.projectName === 'string' && raw.projectName.trim()) return raw.projectName.trim();
  const root = repoRoot ?? SCRIPT_ANCHOR_REPO;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    if (typeof pkg.name === 'string' && pkg.name.trim()) return pkg.name.trim();
  } catch {
    /* 无 package.json → 目录名兜底 */
  }
  return path.basename(root) || 'project';
}

/** 展示名（通知标题/调度任务名）：按 -_. 分段各自首字母大写后拼接。"model-dock" → "ModelDock"。 */
export function displayProjectName(name) {
  return String(name ?? '')
    .split(/[-_.]/)
    .map((s) => (s ? s[0].toUpperCase() + s.slice(1) : s))
    .join('');
}

/** 展开 ~/ 前缀（gatewayLogDir 等用户目录级配置路径）。 */
export function expandHome(p) {
  const s = String(p ?? '');
  if (s === '~') return os.homedir();
  if (s.startsWith('~/') || s.startsWith('~\\')) return path.join(os.homedir(), s.slice(2));
  return s;
}

/** 引擎默认配置 { backend, model? }：仓库级「执行/审查各用什么引擎」的声明位。
 *  backend 必须非空字符串；model 可选（仅 claude 系 CLI 支持 --model，zcode 模型
 *  跟随 ZCode 默认）。CLI 的 --worker-×× 与 --review-×× 单次覆盖。形状不对返回
 *  null（缺省：执行沿用 resolveBackendName 链、审查走自动异构）。 */
function resolveEngine(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const backend = typeof raw.backend === 'string' ? raw.backend.trim() : '';
  if (!backend) return null;
  const model = typeof raw.model === 'string' && raw.model.trim() ? raw.model.trim() : null;
  return { backend, model };
}

/** 任务等级表 tiers.<name> → { tokenEnv, workerModel?, reviewModel?, provider?, gatewayBase? }。
 *  任务卡按 tier 键名点名等级，凭据走 tokenEnv 环境变量（token 本体绝不入库）。
 *  键名不合法 / 值非对象的条目丢弃（其余条目照常生效）；无 tiers 键 = 空表（功能关闭）。 */
function resolveTiers(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const [name, v] of Object.entries(raw)) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name) || !v || typeof v !== 'object' || Array.isArray(v)) continue;
    const str = (x) => (typeof x === 'string' && x.trim() ? x.trim() : null);
    const gatewayBase = str(v.gatewayBase);
    out[name] = {
      tokenEnv: str(v.tokenEnv),
      workerModel: str(v.workerModel),
      reviewModel: str(v.reviewModel),
      provider: str(v.provider),
      gatewayBase: gatewayBase && /^https?:\/\//.test(gatewayBase) ? gatewayBase : null,
    };
  }
  return out;
}

/** 按引擎的预算校准表 budgetProfiles.<backend> → 部分预算覆盖（只认 max_* 正整数键，其余丢弃）。
 *  背景（2026-10-29 夜跑实证）：zcode headless 无逐 turn usage（会话结束才回填）+ GLM
 *  缓存读口径失真，默认 token 预算对 zcode 形同虚设——按引擎放宽（调大而非关闭，
 *  不破「熔断不可关闭」红线）；wall-clock / 迭代熔断不受影响。条目不合法整条丢弃
 *  （与 resolveTiers 同哲学：配置错不阻断启动，无效条目静默失效）。 */
function resolveBudgetProfiles(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const BUDGET_KEYS = ['max_turns', 'max_tokens', 'max_wall_minutes', 'max_test_iterations', 'max_review_iterations'];
  const out = {};
  for (const [backend, v] of Object.entries(raw)) {
    if (typeof backend !== 'string' || !backend.trim() || !v || typeof v !== 'object' || Array.isArray(v)) continue;
    const overrides = {};
    for (const [k, num] of Object.entries(v)) {
      if (BUDGET_KEYS.includes(k) && Number.isInteger(num) && num > 0) overrides[k] = num;
    }
    if (Object.keys(overrides).length) out[backend.trim()] = overrides;
  }
  return out;
}

/** testCmd 三形态（字符串 / 数组 / 平台映射）→ 当前平台的命令数组或 null。与 feature-branch.mjs 同语义。 */
export function resolveTestCmd(raw) {
  const toList = (v) => {
    if (typeof v === 'string') return v.trim() ? [v.trim()] : null;
    if (Array.isArray(v)) {
      const arr = v.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim());
      return arr.length ? arr : null;
    }
    return null;
  };
  if (raw == null) return null;
  if (typeof raw === 'string' || Array.isArray(raw)) return toList(raw);
  if (typeof raw === 'object') {
    const key = process.platform === 'win32' ? 'win32' : 'unix';
    return toList(raw[key] ?? raw.unix ?? null);
  }
  return null;
}

/** npm 系包管理器才做 native addon / node_modules 相关检查。 */
export function isNpmFamily(pm) {
  return ['npm', 'pnpm', 'yarn', 'bun'].includes(String(pm ?? '').toLowerCase());
}

/**
 * escape hatch 环境变量名集合：`${envPrefix}_ALLOW_RELEASE=1` + 旧项目名兼容。
 * 返回完整 "NAME=1" 形态列表，供命令前缀匹配。
 */
export function releaseHatches(envPrefix) {
  const names = new Set([`${envPrefix || 'AGENTS'}_ALLOW_RELEASE`, 'MODELRDOCK_ALLOW_RELEASE']);
  return [...names].map((n) => `${n}=1`);
}
