// workflow-config.mjs — .agents 工具链的唯一项目配置入口（.agents/workflow.json）。
// 可移植性设计（2026-10-07）：所有项目专属红线数据（受保护端口/核心路径/发布流水线/
// 审查红线文本/包管理器）都住在这个 JSON 里；代码只认配置，缺省即关闭对应红线，
// 不再假设 npm/SEA/8687。字段：
//   baseBranch      feature 分支的合并目标（feature-branch.mjs / guard 的基准分支集合）
//   baseBranches    guard 保护的分支显式清单（可选；缺省 = main + baseBranch）。
//                   多基准分支仓库用：如 develop+master 双分支保护 ["develop","master"]
//   testCmd         finish/门禁的验证命令（字符串 | 数组 | {win32,unix} 平台映射）
//   buildCmd        构建门禁命令（缺省 = 跳过 build 门禁）
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
    packageManager: typeof raw.packageManager === 'string' && raw.packageManager.trim() ? raw.packageManager.trim().toLowerCase() : null,
    protectedPorts: strArr(raw.protectedPorts),
    corePaths: strArr(raw.corePaths),
    releasePaths: strArr(raw.releasePaths),
    reviewNotes: typeof raw.reviewNotes === 'string' ? raw.reviewNotes.trim() : '',
    uiCheckCmd: typeof raw.uiCheckCmd === 'string' && raw.uiCheckCmd.trim() ? raw.uiCheckCmd.trim() : null,
    worker: resolveEngine(raw.worker),
    review: resolveEngine(raw.review),
    tiers: resolveTiers(raw.tiers),
    envPrefix: typeof raw.envPrefix === 'string' && /^[A-Z][A-Z0-9_]*$/i.test(raw.envPrefix.trim()) ? raw.envPrefix.trim() : 'AGENTS',
    projectName: deriveProjectName(repoRoot, raw),
    listenCommandNames: strArr(raw.listenCommandNames),
    scheduleId: typeof raw.scheduleId === 'string' && raw.scheduleId.trim() ? raw.scheduleId.trim() : null,
    gatewayLogDir: typeof raw.gatewayLogDir === 'string' && raw.gatewayLogDir.trim() ? expandHome(raw.gatewayLogDir.trim()) : null,
  };
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
