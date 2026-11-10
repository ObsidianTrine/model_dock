// workflow-config.mjs — .agents 工具链的唯一项目配置入口（.agents/workflow.json）。
// 可移植性设计（2026-10-07）：所有项目专属红线数据（受保护端口/核心路径/发布流水线/
// 审查红线文本/包管理器）都住在这个 JSON 里；代码只认配置，缺省即关闭对应红线，
// 不再假设 npm/SEA/8687。字段：
//   baseBranch      feature 分支的合并目标（feature-branch.mjs / guard 的基准分支集合）
//   baseBranches    guard 保护的分支显式清单（可选；缺省 = main + baseBranch）。
//                   多基准分支仓库用：如 develop+master 双分支保护 ["develop","master"]
//   testCmd         finish/门禁的验证命令（字符串 | 数组 | {win32,unix} 平台映射）
//   testCmdL0       纯文档卡（全部改动为 .md，实际分级 L0）的轻量门禁命令；缺省 = 照跑 testCmd
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
//   gatewayAdmin    网关权威 tier 校验开关（布尔，缺省 false）：true 才允许编排器用 admin 面
//                   （读 gateway.json 的 port+admin_token 或 ORCH_GATEWAY_* env）调
//                   /_modeldock/tier-validate 对账 token→profile→tier；未开 = advisory only。
//                   也是 gatewayProvision 的前置（admin 面 W 全家共享同一授权面）
//   gatewayProvision 每任务一次性凭据开关（布尔，缺省 false = 现状不变）：true 且 gatewayAdmin
//                   已开时，run 的 spawn 前向网关 /_modeldock/harness/provision 签发临时
//                   harness（TTL ≤24h、不落盘），worker/reviewer 的 env patch 只换
//                   ANTHROPIC_AUTH_TOKEN（base_url 仍由 ModelDock attach 的客户端配置决定）；
//                   预算实测账按该 harnessId 精确取数（无同 harness 兄弟流量污染）。
//                   所有失败形态 fail-open 回落 tier token 并留 harness_provision_failed
//                   事件；终态/收尾/接管路径 best-effort revoke（失败只告警，TTL 兜底）。
//                   见 orchestrator/provision.mjs 与 orchestrator.md B16
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
//   gateTimeoutMinutes  门禁单命令超时分钟数（正整数，缺省 20）——gates.mjs runCmd 的默认
//                   超时，超时按进程树终止（win32 taskkill /T /F；unix 进程组 kill）
//   retryWaitBaseMs worker 瞬时故障原地重试的退避基值 ms（非负整数，缺省 60000）；
//                   env ORCH_RETRY_WAIT_MS 优先级更高（测试收缩到 ms 级用），两者都缺
//                   = 60s×attempt（与 dockmaster 技能「429 退避 60s」口径一致）
//   scheduling      worker 并发供给闸：{ maxWorkers?: 正整数（缺省 1 = 现状不变） }。
//                   drain 的有效并发 = min(请求并发（--workers 或本键）, provider 容量)；
//                   容量经网关 admin 面观测（tier-validate → provider → config 的
//                   max_concurrency + metrics 的 keypool 健康，见 orchestrator/supply.mjs）。
//                   观测面未开启（gatewayAdmin 缺省 false）不设闸，行为与历史版本一致
//   configGuard     workflow.json 自改守卫：{ enabled?: boolean（缺省 true） }。run/drain/
//                   watch/sail 启动时记 workflow.json 的 sha256 基线，每次派发前校验；不匹配
//                   → 落 fleet 事件 config_drift_detected（含前后 hash）+ 暂停新派发（在途
//                   任务继续），恢复 = 基线重新匹配（文件改回）或编排器自己 merge 后重置。
//                   2026-11 实证动机：sail 派发的卡自改 workflow.json 默认引擎后合并——
//                   授权配置被被调度方改写而编排器无感。enabled=false 关闭守卫（不推荐）
//   draftsGc        drafts/ 提案生命周期：{ autoSupersede?: boolean（缺省 true——卡落 merged/
//                   时 files_hint 重叠的提案自动迁入 drafts/superseded/ 并标注合并卡 id），
//                   archiveDays?: 正整数（缺省 30——drafts gc 时超龄提案迁入 drafts/archived/，
//                   永不删除只迁移） }
//   scanAutoFix     scan 型卡 failed 后自动转修复卡：{ enabled?: boolean（缺省 true） }。
//                   drain 处理到 failed/ 的 scan-* 卡时自动创建 pending 修复卡（id
//                   fix-<原名>，引用 incident.md 与失败摘要，files_hint/门禁继承原卡）；
//                   修复卡自身 failed 不再繁殖新卡（防循环），同名卡已存在任一状态即跳过
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
 * workflow.json 合法顶层键清单（2026-11-05 审查项）：各 resolveXxx 只校验自己的键，
 * 顶层键拼写错误会被静默忽略、对应功能悄悄关闭。这里收口「全量合法键」用于 load 时
 * 未知键告警——主配置消费方（loadWorkflowConfig 直读 + 各 resolveXxx）之外，还有两个
 * 外部消费者直读的键：setupCmd（feature-branch.mjs 自带 loader）、scan（eventfilter.mjs
 * readScanConfig；review/trace 主配置也是它的数据源，已在主清单内）。
 */
const KNOWN_TOP_LEVEL_KEYS = new Set([
  // loadWorkflowConfig 直读
  'version', 'baseBranch', 'baseBranches', 'testCmd', 'testCmdL0', 'buildCmd', 'lintCmd', 'typecheckCmd',
  'packageManager', 'protectedPorts', 'corePaths', 'releasePaths', 'reviewNotes', 'uiCheckCmd',
  'envPrefix', 'projectName', 'listenCommandNames', 'scheduleId', 'gatewayLogDir', 'gatewayAdmin', 'gatewayProvision',
  'driftThreshold', 'reviewMaxTurns', 'gateTimeoutMinutes', 'retryWaitBaseMs', 'fastlaneAllowed',
  // resolveXxx 子配置
  'worker', 'review', 'tiers', 'budgetProfiles', 'scheduling', 'watchdog', 'autopilot', 'propose',
  'weatherHold', 'autoResume', 'trace', 'configGuard', 'draftsGc', 'scanAutoFix', 'escalation',
  'dynamicDispatch', 'notify', 'research', 'freeSail', 'autoApprove',
  // 外部消费者直读
  'setupCmd', 'scan',
]);

/** 未知顶层键一次性告警（单次 load 一行、列出全部未知键）：拼写错误防线——不阻断，
 *  与各 resolveXxx 的告警同风格走 stderr。 */
function warnUnknownTopLevelKeys(raw, cfgPath) {
  const unknown = Object.keys(raw ?? {}).filter((k) => !KNOWN_TOP_LEVEL_KEYS.has(k));
  if (unknown.length) {
    console.warn(`[workflow-config] ${cfgPath} 存在未知顶层键：${unknown.join(', ')}——可能是拼写错误，对应功能会静默关闭（合法键清单见 .agents/scripts/workflow-config.mjs 的 KNOWN_TOP_LEVEL_KEYS）`);
  }
}

/**
 * 读取并规整 workflow.json。文件缺失/字段缺省 → 全部回落「关闭」缺省值，
 * 只有 baseBranch/testCmd 沿用 feature-branch.mjs 的既有回落（develop→当前分支 / 无验证）。
 * JSON 损坏抛错（阻断启动，错误可操作）。未知顶层键 console.warn 告警（拼写错误防线）。
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
    warnUnknownTopLevelKeys(raw, cfgPath);
  }
  const strArr = (v) => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : []);
  return {
    version: typeof raw.version === 'number' && Number.isFinite(raw.version) ? raw.version : null,
    baseBranch: typeof raw.baseBranch === 'string' && raw.baseBranch.trim() ? raw.baseBranch.trim() : null,
    baseBranches: strArr(raw.baseBranches),
    testCmd: resolveTestCmd(raw.testCmd),
    testCmdL0: resolveTestCmd(raw.testCmdL0), // 纯文档卡（L0）的轻量验证命令；缺省 = 照跑 testCmd（行为不变）
    buildCmd: typeof raw.buildCmd === 'string' && raw.buildCmd.trim() ? raw.buildCmd.trim() : null,
    lintCmd: typeof raw.lintCmd === 'string' && raw.lintCmd.trim() ? raw.lintCmd.trim() : null,
    typecheckCmd: typeof raw.typecheckCmd === 'string' && raw.typecheckCmd.trim() ? raw.typecheckCmd.trim() : null,
    packageManager: typeof raw.packageManager === 'string' && raw.packageManager.trim() ? raw.packageManager.trim().toLowerCase() : null,
    protectedPorts: strArr(raw.protectedPorts),
    corePaths: strArr(raw.corePaths),
    releasePaths: strArr(raw.releasePaths),
    reviewNotes: typeof raw.reviewNotes === 'string' ? raw.reviewNotes.trim() : '',
    uiCheckCmd: typeof raw.uiCheckCmd === 'string' && raw.uiCheckCmd.trim() ? raw.uiCheckCmd.trim() : null,
    worker: resolveEngine(raw.worker, 'worker'),
    review: resolveEngine(raw.review, 'review'),
    tiers: resolveTiers(raw.tiers),
    budgetProfiles: resolveBudgetProfiles(raw.budgetProfiles),
    envPrefix: typeof raw.envPrefix === 'string' && /^[A-Z][A-Z0-9_]*$/i.test(raw.envPrefix.trim()) ? raw.envPrefix.trim() : 'AGENTS',
    projectName: deriveProjectName(repoRoot, raw),
    listenCommandNames: strArr(raw.listenCommandNames),
    scheduleId: typeof raw.scheduleId === 'string' && raw.scheduleId.trim() ? raw.scheduleId.trim() : null,
    gatewayLogDir: typeof raw.gatewayLogDir === 'string' && raw.gatewayLogDir.trim() ? expandHome(raw.gatewayLogDir.trim()) : null,
    // 网关权威 tier 校验开关（admin 面）：显式 true 才允许编排器读 gateway.json / 调
    // /_modeldock/tier-validate——可移植工具链不得默认读用户 home 下的 ModelDock 状态
    gatewayAdmin: raw.gatewayAdmin === true,
    // 每任务一次性凭据开关（ephemeral harness，provision.mjs）：显式 true 才签发/吊销；
    // 生效前提是 gatewayAdmin 也为 true（admin 面解析同一套）。缺省 false = 行为与历史一致
    gatewayProvision: raw.gatewayProvision === true,
    // drift 阈值可调不可关（design doc §10.5）：0 / false / 超界等非法值拒绝生效（回落缺省 0.2）
    // 且显式告警——键缺失不告警（沿用缺省），显式写错必须让人看见（2026-11 B11 常量收口）
    driftThreshold: resolveDriftThreshold(raw.driftThreshold),
    reviewMaxTurns: Number.isInteger(raw.reviewMaxTurns) && raw.reviewMaxTurns > 0 ? raw.reviewMaxTurns : 30,
    gateTimeoutMinutes: resolvePositiveInt(raw.gateTimeoutMinutes, 20, 'gateTimeoutMinutes'),
    retryWaitBaseMs: resolveNonNegativeInt(raw.retryWaitBaseMs, 60_000, 'retryWaitBaseMs'),
    scheduling: resolveScheduling(raw.scheduling),
    fastlaneAllowed: raw.fastlaneAllowed !== false, // 缺省 true；仅显式 false 关闭（其他值视为未配置）
    watchdog: resolveWatchdog(raw.watchdog),
    autopilot: resolveAutopilot(raw.autopilot),
    propose: resolvePropose(raw.propose),
    weatherHold: resolveWeatherHold(raw.weatherHold),
    autoResume: resolveAutoResume(raw.autoResume),
    trace: resolveTrace(raw.trace),
    configGuard: resolveConfigGuard(raw.configGuard),
    draftsGc: resolveDraftsGc(raw.draftsGc),
    scanAutoFix: resolveScanAutoFix(raw.scanAutoFix),
    escalation: resolveEscalation(raw.escalation),
    dynamicDispatch: resolveDynamicDispatch(raw.dynamicDispatch),
    notify: resolveNotify(raw.notify),
    // 调研船解耦选型（2026-11-08）：research.model 缺省时 research 命令回落 claude CLI 全局默认
    research: resolveResearch(raw.research),
    // freeSail 自由航行配置（注意：此前无 resolve 条目，workflow.json 里的 freeSail 键
    // 被规整丢弃——canSailSubmit 的白名单收窄从未生效过，2026-11-08 L1 排查时发现）
    freeSail: resolveFreeSail(raw.freeSail),
    // 分层审核超时委托（D6.5，2026-11-10）：L2/L3 卡 awaiting-human 后人工 3 分钟内拍板，
    // 超时由 autoapprove sweep 按最后一条 review_verdict 的推荐自动 merge/retry
    //（fail-closed：无审查结论绝不动作；blockers>0 只自动返工限次）。缺省开。
    autoApprove: resolveAutoApprove(raw.autoApprove),
  };
}

/** research 调研配置：{ model?: string, maxDims?: 正整数, concurrency?: 整数 1-4,
 *  snapshotMax?: 整数 1-48, snapshotMirror?: boolean }——模型名经 ModelDock 网关按名路由。 */
function resolveResearch(raw) {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    console.warn(`[workflow-config] research 配置非法，已忽略：${JSON.stringify(raw)}（应为 { model?: 模型名, maxDims?: 正整数, concurrency?: 整数 1-4, snapshotMax?: 整数 1-48, snapshotMirror?: boolean, usageGates?: {decision|external: {coherence?, coverage?}} }）`);
    return {};
  }
  const out = {};
  if (raw.model !== undefined) {
    if (typeof raw.model === 'string' && raw.model.trim()) out.model = raw.model.trim();
    else console.warn(`[workflow-config] research.model ${JSON.stringify(raw.model)} 不合法（应为模型名字符串）——忽略`);
  }
  // multi 调研的维度上限（research multi --dim 数量封顶）：正整数，缺省 4（调用方回落）。
  // 与本模块各键同口径：显式非法值 console.warn 报错并忽略（回落缺省），不阻断其他键
  if (raw.maxDims !== undefined) {
    if (Number.isInteger(raw.maxDims) && raw.maxDims > 0) out.maxDims = raw.maxDims;
    else console.warn(`[workflow-config] research.maxDims ${JSON.stringify(raw.maxDims)} 不合法（应为正整数；research multi 的维度上限，缺省 4）——忽略`);
  }
  // 维度并发池上限（research multi 维度池与 verify topic 逐维复核共用，2026-11-09 P2）：
  // 1–4 整数，缺省 2（调用方回落）。workflow.json 缺省不写此键（用缺省值，避免配置漂移）。
  // 与本模块各键同口径：显式非法值 console.warn 报错并忽略（回落缺省），不阻断其他键
  if (raw.concurrency !== undefined) {
    if (Number.isInteger(raw.concurrency) && raw.concurrency >= 1 && raw.concurrency <= 4) out.concurrency = raw.concurrency;
    else console.warn(`[workflow-config] research.concurrency ${JSON.stringify(raw.concurrency)} 不合法（应为 1–4 整数；维度并发池上限，缺省 2）——忽略`);
  }
  // 引用快照覆盖上限（snapshotCitations 的 max，2026-11-10 快照质量包）：1–48 整数，缺省 16。
  // 真实对拍实证：21 条引用的 brief 在缺省 8 下有 13 条从未尝试快照——L2 复核反复报
  // 「引用 [n] 无快照无法对账」。缺省不写此键（用缺省 16）
  if (raw.snapshotMax !== undefined) {
    if (Number.isInteger(raw.snapshotMax) && raw.snapshotMax >= 1 && raw.snapshotMax <= 48) out.snapshotMax = raw.snapshotMax;
    else console.warn(`[workflow-config] research.snapshotMax ${JSON.stringify(raw.snapshotMax)} 不合法（应为 1–48 整数；引用快照上限，缺省 16）——忽略`);
  }
  // 快照镜像回退（2026-11-10 快照质量包，缺省 false）：开启后直连失败（非 404）或分类
  // 非 ok 的引用追加一次 r.jina.ai 镜像读取。隐私取舍：开启 = 把引用 URL 发给第三方
  // reader 服务——所以默认关、显式 opt-in
  if (raw.snapshotMirror !== undefined) {
    if (typeof raw.snapshotMirror === 'boolean') out.snapshotMirror = raw.snapshotMirror;
    else console.warn(`[workflow-config] research.snapshotMirror ${JSON.stringify(raw.snapshotMirror)} 不合法（应为 boolean；缺省 false——开启会把引用 URL 发给 r.jina.ai 第三方服务）——忽略`);
  }
  // 仲裁轮开关（research verify 判出 contradicted 时的联网外部取证，2026-11-09 实测驱动）：
  // 缺省开（不配置 = true）——仲裁是取证不是放水，upheld 才翻案、翻不了维持否决；false 只省 token
  if (raw.arbitration !== undefined) {
    if (typeof raw.arbitration === 'boolean') out.arbitration = raw.arbitration;
    else console.warn(`[workflow-config] research.arbitration ${JSON.stringify(raw.arbitration)} 不合法（应为 boolean）——忽略`);
  }
  // usage 矩阵阈值（verdict/2）：可配的只有 coherence/coverage 两档阈值——否决权与
  // COVERAGE_FLOOR=50 硬底线在 scoreVerdict 里写死，不可配（防配置失误放水）
  if (raw.usageGates !== undefined) {
    if (typeof raw.usageGates !== 'object' || Array.isArray(raw.usageGates)) {
      console.warn(`[workflow-config] research.usageGates ${JSON.stringify(raw.usageGates)} 不合法（应为 { decision?: {coherence?,coverage?}, external?: {…} }）——忽略`);
    } else {
      out.usageGates = {};
      for (const key of ['decision', 'external']) {
        const sub = raw.usageGates[key];
        if (sub === undefined) continue;
        if (typeof sub !== 'object' || Array.isArray(sub)) {
          console.warn(`[workflow-config] research.usageGates.${key} 不合法（应为 {coherence?,coverage?} 0-100 整数）——忽略`);
          continue;
        }
        const entry = {};
        for (const k of ['coherence', 'coverage']) {
          if (sub[k] === undefined) continue;
          if (Number.isInteger(sub[k]) && sub[k] >= 0 && sub[k] <= 100) entry[k] = sub[k];
          else console.warn(`[workflow-config] research.usageGates.${key}.${k} ${JSON.stringify(sub[k])} 不合法（0-100 整数）——忽略`);
        }
        if (Object.keys(entry).length) out.usageGates[key] = entry;
      }
      if (!Object.keys(out.usageGates).length) delete out.usageGates;
    }
  }
  return out;
}

/**
 * freeSail 配置：{ autoSubmitTypes?: string[], researchPerCycle?: 正整数, specPerCycle?: 正整数,
 * researchAutoDim?: boolean }。
 * researchAutoDim（2026-11-10 P3，缺省 false）：sail 上游管线自动拆维度调研——feature 提案
 * 缺调研时先派拆维规划会话，≥2 维跑 research multi（一个 multi 对 researchPerCycle 仍计 1 个
 * 调研动作，成本倍乘靠默认关治理）。非 bool 值 warn + 忽略（与本模块各键同口径）。
 */
function resolveFreeSail(raw) {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    console.warn(`[workflow-config] freeSail 配置非法，已忽略：${JSON.stringify(raw)}`);
    return {};
  }
  const out = {};
  if (raw.autoSubmitTypes !== undefined) {
    const types = strArr(raw.autoSubmitTypes);
    if (types.length) out.autoSubmitTypes = types;
    else console.warn(`[workflow-config] freeSail.autoSubmitTypes ${JSON.stringify(raw.autoSubmitTypes)} 不合法（应为类型字符串数组）——忽略`);
  }
  for (const k of ['researchPerCycle', 'specPerCycle']) {
    if (raw[k] !== undefined) {
      if (Number.isInteger(raw[k]) && raw[k] > 0) out[k] = raw[k];
      else console.warn(`[workflow-config] freeSail.${k} ${JSON.stringify(raw[k])} 不合法（应为正整数）——忽略`);
    }
  }
  if (raw.researchAutoDim !== undefined) {
    if (typeof raw.researchAutoDim === 'boolean') out.researchAutoDim = raw.researchAutoDim;
    else console.warn(`[workflow-config] freeSail.researchAutoDim ${JSON.stringify(raw.researchAutoDim)} 不合法（应为布尔值 true/false）——忽略（缺省 false，行为与未开启一致）`);
  }
  return out;
}

/** drift 降级阈值：0 < v ≤ 1，缺省 0.2。可调不可关（design doc §10.5）——显式给出的
 *  非法值（0 / false / 负数 / >1 / 字符串）拒绝生效并 console.warn 报错（回落缺省 0.2，
 *  漂移监控没有「不监控」档）；键缺失 = 沿用缺省，不告警。 */
function resolveDriftThreshold(raw) {
  if (raw === undefined) return 0.2;
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0 && raw <= 1) return raw;
  console.warn(`[workflow-config] driftThreshold ${JSON.stringify(raw)} 不合法（须为 0 < v ≤ 1 的数值；漂移监控可调不可关）——回落缺省 0.2`);
  return 0.2;
}

/** 正整数键解析（B11 常量收口共用）：键缺失 = 沿用缺省不告警；显式非法值回落缺省并
 *  console.warn 报错（与 resolveWatchdog 同风格，可操作文案点名键名）。 */
function resolvePositiveInt(raw, fallback, name) {
  if (raw === undefined) return fallback;
  if (Number.isInteger(raw) && raw > 0) return raw;
  console.warn(`[workflow-config] ${name} ${JSON.stringify(raw)} 不合法（须为正整数）——回落缺省 ${fallback}`);
  return fallback;
}

/** 非负整数键解析（retryWaitBaseMs：0 = 立即重试，合法）。 */
function resolveNonNegativeInt(raw, fallback, name) {
  if (raw === undefined) return fallback;
  if (Number.isInteger(raw) && raw >= 0) return raw;
  console.warn(`[workflow-config] ${name} ${JSON.stringify(raw)} 不合法（须为非负整数）——回落缺省 ${fallback}`);
  return fallback;
}

/** worker 并发供给闸配置解析：{ maxWorkers: 正整数 }，缺省 1 = 现状不变（单 worker）。
 *  drain 的有效并发 = min(请求并发, provider 容量)——容量观测见 orchestrator/supply.mjs；
 *  非法值回落缺省并 console.warn 告警（与 resolveWatchdog 同风格）。键缺失 = 沿用缺省，不告警。 */
function resolveScheduling(raw) {
  const DEFAULTS = { maxWorkers: 1 };
  const warn = (detail) =>
    console.warn(`[workflow-config] scheduling 配置非法，已回落缺省：${detail}（.agents/workflow.json 的 scheduling 键：{ maxWorkers?: 正整数 }）`);
  if (raw === undefined || raw === null) return DEFAULTS;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    warn(`应为对象 { maxWorkers? }，当前为 ${JSON.stringify(raw)}`);
    return DEFAULTS;
  }
  const out = { ...DEFAULTS };
  if (raw.maxWorkers !== undefined) {
    if (Number.isInteger(raw.maxWorkers) && raw.maxWorkers > 0) out.maxWorkers = raw.maxWorkers;
    else warn(`maxWorkers ${JSON.stringify(raw.maxWorkers)} 不合法（须为正整数）`);
  }
  return out;
}

/** 大 prompt 落文件阈值（D17，字符数）：worker prompt 超过它默认把全文落 logs/<taskId>/
 *  prompt-full.md、正文收缩为「文件引用 + 要点摘要」——不再依赖 zcode argv 30k 超限后的
 *  escalation 换船（escalation 保留为最后兜底）。取 20k：低于 zcode argv 上限 30k，给
 *  收缩体（目标/验收/契约块）留足余量。常量集中在本模块（B11），无 workflow.json 键。 */
export const PROMPT_FILE_THRESHOLD_CHARS = 20_000;

/** 动态选船配置解析（阶段 3）：{ enabled?: bool（缺省 false=决策完全不参与，行为与历史
 *  一致）, envelope?: 船型数组（允许自动切换的船白名单——写进配置即持久授权，包络外永不
 *  自动切）, models?: { <backend>: 模型名 }（可选：换到该船时注入的 --model，仅 claude 系
 *  生效） }。非法值回落缺省并 console.warn（与 resolveEscalation 同风格）。 */
function resolveDynamicDispatch(raw) {
  const DEFAULTS = { enabled: false, envelope: [], models: {} };
  const warn = (detail) =>
    console.warn(`[workflow-config] dynamicDispatch 配置非法，已回落缺省：${detail}（.agents/workflow.json 的 dynamicDispatch 键：{ enabled?: boolean, envelope?: ["claude-headless","zcode-headless"] 之类船型数组, models?: { <backend>: 模型名 } }）`);
  if (raw === undefined || raw === null) return DEFAULTS;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    warn(`应为对象 { enabled?, envelope?, models? }，当前为 ${JSON.stringify(raw)}`);
    return DEFAULTS;
  }
  const out = { ...DEFAULTS, models: { ...DEFAULTS.models } };
  if (raw.enabled !== undefined) out.enabled = raw.enabled === true;
  if (raw.envelope !== undefined) {
    if (Array.isArray(raw.envelope)) {
      out.envelope = raw.envelope.map((x) => String(x).trim()).filter(Boolean);
    } else {
      warn(`envelope ${JSON.stringify(raw.envelope)} 不合法（须为船型字符串数组）`);
    }
  }
  if (raw.models !== undefined) {
    if (raw.models && typeof raw.models === 'object' && !Array.isArray(raw.models)) {
      const models = {};
      for (const [k, v] of Object.entries(raw.models)) {
        if (k.trim() && typeof v === 'string' && v.trim()) models[k.trim()] = v.trim();
      }
      out.models = models;
    } else {
      warn(`models ${JSON.stringify(raw.models)} 不合法（须为 { <backend>: 模型名 } 对象）`);
    }
  }
  return out;
}

/** notify 配置解析（通知通道扩展点）：{ keychainService?: string（darwin 钥匙串服务名，
 *  承载 webhook URL——launchd/cron 环境极瘦读不到 env，runner 与 notify() 兜底都查它），
 *  signSecretService?: string（钥匙串服务名，承载飞书自定义机器人的签名密钥——配置后
 *  飞书端点出站消息按官方规范附 timestamp+sign；env AGENTS_LARK_SIGN_SECRET 优先），
 *  cardWebhook?: boolean（缺省 false——需要人工动作的落位事件额外发一张飞书交互卡片，
 *  按钮批示经 approval-listener 回流；非飞书 webhook 端点自动跳过），
 *  listenerPort?: 正整数（approval-listener 缺省监听端口；监听器必须显式配置才启动，
 *  永不缺省监听）}。缺省 null/false → 一切照旧（向后兼容：老 workflow.json 无此键零行为变化）。 */
function resolveNotify(raw) {
  const DEFAULTS = { keychainService: null, signSecretService: null, cardWebhook: false, listenerPort: null };
  const warn = (detail) =>
    console.warn(`[workflow-config] notify 配置非法，已回落缺省：${detail}（.agents/workflow.json 的 notify 键：{ keychainService?: 服务名, signSecretService?: 服务名, cardWebhook?: boolean, listenerPort?: 正整数 }）`);
  if (raw === undefined || raw === null) return DEFAULTS;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    warn(`应为对象，当前为 ${JSON.stringify(raw)}`);
    return DEFAULTS;
  }
  const keychainService = typeof raw.keychainService === 'string' && raw.keychainService.trim() ? raw.keychainService.trim() : null;
  const signSecretService = typeof raw.signSecretService === 'string' && raw.signSecretService.trim() ? raw.signSecretService.trim() : null;
  const cardWebhook = raw.cardWebhook === true;
  if (raw.cardWebhook !== undefined && typeof raw.cardWebhook !== 'boolean') {
    warn(`cardWebhook ${JSON.stringify(raw.cardWebhook)} 不合法（允许 true | false）`);
  }
  const listenerPort = Number.isInteger(raw.listenerPort) && raw.listenerPort > 0 && raw.listenerPort <= 65535 ? raw.listenerPort : null;
  if (raw.listenerPort !== undefined && listenerPort === null) {
    warn(`listenerPort ${JSON.stringify(raw.listenerPort)} 不合法（须为 1-65535 的正整数）`);
  }
  return { keychainService, signSecretService, cardWebhook, listenerPort };
}

/** escalation 配置解析（故障处置升级链第 1 档）：{ enabled?: bool（缺省 false=超限即
 *  blocked，行为不变）, fallbackBackend?: string（缺省 claude-headless——prompt 超限自动
 *  切换的船，写进配置即持久授权，运行时不再请示） }。非法值回落缺省并 console.warn。 */
function resolveEscalation(raw) {
  const DEFAULTS = { enabled: false, fallbackBackend: 'claude-headless' };
  const warn = (detail) =>
    console.warn(`[workflow-config] escalation 配置非法，已回落缺省：${detail}（.agents/workflow.json 的 escalation 键：{ enabled?: boolean, fallbackBackend?: 后端名 }）`);
  if (raw === undefined || raw === null) return DEFAULTS;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    warn(`应为对象 { enabled?, fallbackBackend? }，当前为 ${JSON.stringify(raw)}`);
    return DEFAULTS;
  }
  const out = { ...DEFAULTS };
  if (raw.enabled !== undefined) out.enabled = raw.enabled === true;
  if (raw.fallbackBackend !== undefined) {
    const b = typeof raw.fallbackBackend === 'string' && raw.fallbackBackend.trim() ? raw.fallbackBackend.trim() : '';
    if (b) out.fallbackBackend = b;
  }
  return out;
}

/** propose 配置解析（需求综合）：{ feedback?: bool（缺省 false=planner prompt 不注入
 *  舰队反馈段，行为与历史版本一致；true = 注入 stats 同源的运行度量数据事实段） }。
 *  非法值回落缺省并 console.warn 告警（stderr，不污染 stdout 裁决通道）。 */
function resolvePropose(raw) {
  const DEFAULTS = { feedback: false };
  const warn = (detail) =>
    console.warn(`[workflow-config] propose 配置非法，已回落缺省：${detail}（.agents/workflow.json 的 propose 键：{ feedback?: boolean }）`);
  if (raw === undefined || raw === null) return DEFAULTS;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    warn(`应为对象 { feedback? }，当前为 ${JSON.stringify(raw)}`);
    return DEFAULTS;
  }
  const out = { ...DEFAULTS };
  if (raw.feedback !== undefined) out.feedback = raw.feedback === true;
  return out;
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

/**
 * 分层审核超时委托配置（D6.5，2026-11-10）：{ enabled: boolean, timeoutMinutes: 正整数,
 * maxAutoRetry: 非负整数 }，缺省 true / 3 / 1——L2/L3 卡落 awaiting-human 后人工缺省
 * 有 3 分钟拍板窗口，超时由 autoapprove sweep 按最后一条 review_verdict 的推荐执行
 * （merge / 限次 retry）。fail-closed 底线：没有审查结论的卡超时也绝不动作；blockers>0
 * 只自动返工且每卡最多 maxAutoRetry 次，超限留人。enabled 显式 false = 整个功能关闭
 * （行为与历史一致）。非法值回落缺省并 console.warn（与 resolveAutoResume 同风格）。
 */
function resolveAutoApprove(raw) {
  const DEFAULTS = { enabled: true, timeoutMinutes: 3, maxAutoRetry: 1 };
  const warn = (detail) =>
    console.warn(`[workflow-config] autoApprove 配置非法，已回落缺省：${detail}（.agents/workflow.json 的 autoApprove 键：{ enabled?: boolean, timeoutMinutes?: 正整数, maxAutoRetry?: 非负整数 }）`);
  if (raw === undefined || raw === null) return DEFAULTS;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    warn(`应为对象 { enabled?, timeoutMinutes?, maxAutoRetry? }，当前为 ${JSON.stringify(raw)}`);
    return DEFAULTS;
  }
  const out = { ...DEFAULTS };
  if (raw.enabled !== undefined) {
    if (typeof raw.enabled === 'boolean') out.enabled = raw.enabled;
    else warn(`enabled ${JSON.stringify(raw.enabled)} 不合法（允许 true | false）`);
  }
  if (raw.timeoutMinutes !== undefined) {
    if (Number.isInteger(raw.timeoutMinutes) && raw.timeoutMinutes > 0) out.timeoutMinutes = raw.timeoutMinutes;
    else warn(`timeoutMinutes ${JSON.stringify(raw.timeoutMinutes)} 不合法（须为正整数）——回落缺省 3`);
  }
  if (raw.maxAutoRetry !== undefined) {
    if (Number.isInteger(raw.maxAutoRetry) && raw.maxAutoRetry >= 0) out.maxAutoRetry = raw.maxAutoRetry;
    else warn(`maxAutoRetry ${JSON.stringify(raw.maxAutoRetry)} 不合法（须为非负整数）——回落缺省 1`);
  }
  return out;
}

/** 风暴闸配置解析：{ threshold, windowMinutes, upstream? }。与 resolveAutopilot 同风格：
 *  键缺失 = 功能关闭（null，行为与历史版本一致）；键存在时缺省 threshold 3 / windowMinutes 60。
 *  enabled 子键（2026-11-04 海况数据面，可选）：缺省 true（键存在即启用，与历史「删键 = 关闭」
 *  兼容）；显式 false = 关闭风暴闸。
 *  upstream 子键（可选，presence 启用）：{ threshold: 正整数（必填）, windowMinutes?（缺省 15）,
 *  source?: "metrics" | "log"（缺省 "metrics"）}——上游海况滞留阈值。source="metrics"（缺省）
 *  = 优先 /_modeldock/metrics 海况数据面（sea_state 风暴 + 错误分桶计数，失败自动落回网关
 *  日志扫描）；source="log" = 显式降级：派发决策面只看网关日志 429/402 实测，不发起 metrics
 *  探测。非法值回落缺省并 console.warn 告警（stderr，不污染 stdout 裁决通道）；键内字段
 *  缺失 = 沿用该字段缺省，不告警。 */
function resolveWeatherHold(raw) {
  if (raw === undefined || raw === null) return null;
  const DEFAULTS = { threshold: 3, windowMinutes: 60 };
  const warn = (detail) =>
    console.warn(`[workflow-config] weatherHold 配置非法，已回落缺省：${detail}（.agents/workflow.json 的 weatherHold 键：{ enabled?: boolean, threshold?: 正整数, windowMinutes?: 正整数, upstream?: { threshold: 正整数, windowMinutes?: 正整数, source?: "metrics" | "log" } }；删除该键 = 关闭风暴闸）`);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    warn(`应为对象 { enabled?, threshold?, windowMinutes?, upstream? }，当前为 ${JSON.stringify(raw)}`);
    return { ...DEFAULTS };
  }
  const out = { ...DEFAULTS };
  if (raw.enabled !== undefined) {
    if (typeof raw.enabled === 'boolean') {
      if (raw.enabled === false) return null; // 显式关闭（键存在但 enabled:false）
    } else {
      warn(`enabled ${JSON.stringify(raw.enabled)} 不合法（允许 true | false）`);
    }
  }
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
      warn(`upstream ${JSON.stringify(u)} 不合法（须为对象 { threshold: 正整数, windowMinutes?: 正整数, source?: "metrics" | "log" }）`);
    } else {
      out.upstream = { threshold: u.threshold, windowMinutes: 15, source: 'metrics' };
      if (u.windowMinutes !== undefined) {
        if (Number.isInteger(u.windowMinutes) && u.windowMinutes > 0) out.upstream.windowMinutes = u.windowMinutes;
        else warn(`upstream.windowMinutes ${JSON.stringify(u.windowMinutes)} 不合法（须为正整数）`);
      }
      if (u.source !== undefined) {
        if (u.source === 'metrics' || u.source === 'log') out.upstream.source = u.source;
        else warn(`upstream.source ${JSON.stringify(u.source)} 不合法（允许 "metrics" | "log"）`);
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

/** workflow.json 自改守卫配置解析：{ enabled: boolean }，缺省 true（守卫开启是安全缺省——
 *  授权配置被被调度方改写必须停派待查；确认合法变更后重启编排器即接受新基线）。非法值
 *  回落缺省并 console.warn 告警（与 resolveAutoResume 同风格）。 */
function resolveConfigGuard(raw) {
  const DEFAULTS = { enabled: true };
  const warn = (detail) =>
    console.warn(`[workflow-config] configGuard 配置非法，已回落缺省：${detail}（.agents/workflow.json 的 configGuard 键，enabled 允许 true|false）`);
  if (raw === undefined || raw === null) return DEFAULTS;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    warn(`应为对象 { enabled? }，当前为 ${JSON.stringify(raw)}`);
    return DEFAULTS;
  }
  const out = { ...DEFAULTS };
  if (raw.enabled !== undefined) {
    if (typeof raw.enabled === 'boolean') out.enabled = raw.enabled;
    else warn(`enabled ${JSON.stringify(raw.enabled)} 不合法（允许 true | false）`);
  }
  return out;
}

/** drafts/ 提案生命周期配置解析：{ autoSupersede: boolean, archiveDays: 正整数 }，
 *  缺省 true / 30。autoSupersede=false 关闭「卡落 merged/ 时 files_hint 重叠提案自动
 *  迁 superseded/」（drafts gc 手动档不受影响）；archiveDays 非法回落 30。非法值回落
 *  缺省并 console.warn 告警。 */
function resolveDraftsGc(raw) {
  const DEFAULTS = { autoSupersede: true, archiveDays: 30 };
  const warn = (detail) =>
    console.warn(`[workflow-config] draftsGc 配置非法，已回落缺省：${detail}（.agents/workflow.json 的 draftsGc 键：{ autoSupersede?: boolean, archiveDays?: 正整数 }）`);
  if (raw === undefined || raw === null) return DEFAULTS;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    warn(`应为对象 { autoSupersede?, archiveDays? }，当前为 ${JSON.stringify(raw)}`);
    return DEFAULTS;
  }
  const out = { ...DEFAULTS };
  if (raw.autoSupersede !== undefined) {
    if (typeof raw.autoSupersede === 'boolean') out.autoSupersede = raw.autoSupersede;
    else warn(`autoSupersede ${JSON.stringify(raw.autoSupersede)} 不合法（允许 true | false）`);
  }
  if (raw.archiveDays !== undefined) {
    if (Number.isInteger(raw.archiveDays) && raw.archiveDays > 0) out.archiveDays = raw.archiveDays;
    else warn(`archiveDays ${JSON.stringify(raw.archiveDays)} 不合法（须为正整数）`);
  }
  return out;
}

/** scan 型卡自动转修复卡配置解析：{ enabled: boolean }，缺省 true。修复卡照走既有全部
 *  闸门（引水闸/L2L3 人审不绕过）；enabled=false 恢复旧行为（failed scan 卡只能人工 abandon）。
 *  非法值回落缺省并 console.warn 告警。 */
function resolveScanAutoFix(raw) {
  const DEFAULTS = { enabled: true };
  const warn = (detail) =>
    console.warn(`[workflow-config] scanAutoFix 配置非法，已回落缺省：${detail}（.agents/workflow.json 的 scanAutoFix 键，enabled 允许 true|false）`);
  if (raw === undefined || raw === null) return DEFAULTS;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    warn(`应为对象 { enabled? }，当前为 ${JSON.stringify(raw)}`);
    return DEFAULTS;
  }
  const out = { ...DEFAULTS };
  if (raw.enabled !== undefined) {
    if (typeof raw.enabled === 'boolean') out.enabled = raw.enabled;
    else warn(`enabled ${JSON.stringify(raw.enabled)} 不合法（允许 true | false）`);
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

/** 引擎默认配置 { backend, model? }：仓库级「执行/审查各用什么引擎与模型」的声明位。
 *  backend 可选（缺省 = 执行沿用 resolveBackendName 链、审查走自动异构）；model 可选
 *  （仅 claude 系 CLI 支持 --model，zcode 模型跟随 ZCode 默认）。CLI 的 --worker-×× 与
 *  --review-×× 单次覆盖。形状不对返回 null（既有缺省行为）。model 与 backend 互不连坐：
 *  只配 model 不配 backend 也生效（2026-11-08 review.model 解耦收口——此前 backend 缺省
 *  即整节丢弃，配好的模型被静默吞掉，与 0eb29bb research.model 被规整丢弃同型）。 */
function resolveEngine(raw, name = 'engine') {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const backend = typeof raw.backend === 'string' && raw.backend.trim() ? raw.backend.trim() : null;
  const model = typeof raw.model === 'string' && raw.model.trim() ? raw.model.trim() : null;
  if (raw.model !== undefined && model === null) {
    console.warn(`[workflow-config] ${name}.model ${JSON.stringify(raw.model)} 不合法（应为模型名字符串）——忽略`);
  }
  if (!backend && !model) return null; // 空节维持 null（与历史一致，零行为变化）
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
 *  不破「熔断不可关闭」红线）；wall-clock / 迭代熔断不受影响。2026-11 起 max_tokens
 *  按可计费口径（剔除缓存读，见 budget.mjs）比较，数值可按真实消耗回调。条目不合法
 *  整条丢弃（与 resolveTiers 同哲学：配置错不阻断启动，无效条目静默失效）。 */
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
