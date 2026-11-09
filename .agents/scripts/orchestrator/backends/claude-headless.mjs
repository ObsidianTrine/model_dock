// claude-headless.mjs — 真实后端：包装 `claude -p --output-format stream-json`。
// 权限策略（docs 5.5，P0 评审项，缺一不可）：
//   --permission-mode acceptEdits（自动放行编辑类，headless 无 TTY 无法确认权限）
//   --allowedTools 白名单（命令执行 fail-closed，未列出的 shell 命令自动拒绝）
//   --disallowedTools 红线（push/tag/publish 双保险）
//   --settings <worker 专属 settings>（注入 policy-worker.mjs 拦截 hook，
//     只进 worker 会话，不污染项目级 .claude/settings.json）
// 预算口径（双轨，2026-11 usage-cache-read-scope）：tokensIn = input + cache_read +
// cache_creation（缓存读计入，旧口径字段保留）；budget_snapshot 另发 tokens_cache_read
// （缓存读单列）与 tokens_billable = (tokensIn − 缓存读) + tokensOut（可计费口径，
// max_tokens 熔断用它——GLM 网关缓存读占大头，旧口径预算虚胖）。
//
// **Windows shell 工具是 PowerShell（2026-10-30 沙箱实验实证）**：白名单规则按
// 工具名匹配——`Bash(git add:*)` 匹配不到 PowerShell 工具调用，写类命令
// （git add/commit、npm test）全部「requires approval」被 headless 自动拒绝，
// 只读 git status 反而走内置安全启发式放行——正是夜跑观测到的「能读不能验」
// 权限墙。因此白名单/红线一律双形态（Bash + PowerShell）双发；hook matcher
// 同理用 Bash|PowerShell。非 Windows 平台多出的 PowerShell 规则无害（无此工具）。

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadWorkflowConfig } from '../../workflow-config.mjs';
import { quoteArgsForShell, shellCommandline } from '../spawn-shell.mjs';
import { billableTokens } from '../budget.mjs';
import { zcodeAvailable } from './zcode-headless.mjs';
import { codexAvailable } from './codex-headless.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// 编辑/只读/git 白名单与项目无关；测试/构建命令从 workflow.json 生成（testCmd/buildCmd/packageManager），
// 不再假设 npm。每条命令按 <Tool>(prefix:*) 形态放行前缀族，Bash 与 PowerShell 双形态双发
// （Windows 上 claude CLI 的 shell 工具是 PowerShell，只写 Bash 形态 = 权限墙，见文件头注）。
const BASE_TOOL_PATTERNS = [
  'git add',
  'git commit',
  'git diff',
  'git status',
  'git log',
  'git show',
];

/** 单条命令 → [Bash(cmd:*) 形态, PowerShell(cmd:*) 形态]。 */
function shellPatterns(cmd) {
  return [`Bash(${cmd}:*)`, `PowerShell(${cmd}:*)`];
}

/** Set.add 只收单参——双形态逐个塞。 */
function toolsAdd(set, patterns) {
  for (const p of patterns) set.add(p);
}

/** worker 白名单 = 基础工具 + workflow.json 的 testCmd/buildCmd（缺省再补 npm 惯例形态）。 */
export function allowedTools(cfg = loadWorkflowConfig()) {
  const tools = new Set(['Edit', 'Write', 'Read', 'Glob', 'Grep']);
  for (const p of BASE_TOOL_PATTERNS) toolsAdd(tools, shellPatterns(p));
  const pm = cfg.packageManager || 'npm';
  // 惯例形态：`<pm> test:*` / `<pm> run *` 覆盖脚本化调用；显式 testCmd/buildCmd 再逐条放行
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(pm)) {
    toolsAdd(tools, shellPatterns(`${pm} test`));
    toolsAdd(tools, shellPatterns(`${pm} run test`));
    toolsAdd(tools, shellPatterns(`${pm} run build`));
  }
  for (const cmd of cfg.testCmd ?? []) toolsAdd(tools, shellPatterns(cmd));
  if (cfg.buildCmd) toolsAdd(tools, shellPatterns(cfg.buildCmd));
  return [...tools];
}

const DISALLOWED_PATTERNS = [
  'git push',
  'git tag',
  'git -C * push',
  'npm publish',
  'pnpm publish',
  'yarn publish',
];
const DISALLOWED_TOOLS = DISALLOWED_PATTERNS.flatMap(shellPatterns);

/** 会话 cwd 所属仓库的主仓根（linked worktree → 主仓；普通仓库 → 自身；git 不可用 → null）。 */
export function mainRepoRootOf(cwd) {
  if (!cwd) return null;
  try {
    const r = spawnSync('git', ['-C', cwd, 'rev-parse', '--git-common-dir'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const common = (r.stdout ?? '').trim();
    if (r.status === 0 && common) {
      const dotGit = path.resolve(cwd, common);
      if (fs.existsSync(dotGit)) return path.dirname(dotGit);
    }
  } catch { /* git 不可用 */ }
  return null;
}

/**
 * worker hook 命令：默认锚定主仓绝对路径（P0 间接旁路收敛，2026-11）——worker 只有
 * worktree 内写权限，主仓副本篡改不到；hook 命令若用相对路径（随仓库 checkout 进
 * worktree），被篡改的 worktree 副本会顶替真正执行的 hook，红线层整体失效。主仓
 * 解析失败（git 不可用等）才回退相对路径——此时 policy-worker 自身的
 * hookIntegrityVerdict（相对 git HEAD 的完整性校验）兜底拦未提交篡改。
 * 路径用正斜杠 + 双引号包路径：Windows（cmd）与 unix shell 同形合法。
 */
export function workerHookCommand(sessionCwd = null) {
  const main = mainRepoRootOf(sessionCwd);
  if (main) {
    const hook = path.join(main, '.agents', 'hooks', 'policy-worker.mjs');
    if (fs.existsSync(hook)) return `node "${hook.replace(/\\/g, '/')}"`;
  }
  return 'node .agents/hooks/policy-worker.mjs';
}

/** 生成 worker 专属 settings 文件（注册 policy-worker.mjs 拦截 hook）。
 *  matcher 用 Bash|PowerShell：Windows 上 claude CLI 的 shell 工具是 PowerShell，
 *  只写 Bash = hook 对全部 shell 命令失明（红线层失效，2026-10-30 实验实证）。
 *  sessionCwd = worker 会话工作目录（worktree）——hook 命令据此锚定主仓绝对路径
 *  （workerHookCommand；缺省回退相对路径）。
 *  envPatch 非空时并入 settings.env（--settings 优先级高于用户级 settings.json，
 *  tier token 据此覆盖接入时写入的全局凭据）——子进程 env 同时补一份双保险，
 *  两层哪层生效都到得了网关。 */
export function writeWorkerSettings(settingsPath, envPatch = {}, sessionCwd = null) {
  const settings = {
    hooks: {
      PreToolUse: [
        {
          matcher: 'Bash|PowerShell',
          hooks: [{ type: 'command', command: workerHookCommand(sessionCwd) }],
        },
      ],
    },
  };
  if (envPatch && Object.keys(envPatch).length) settings.env = { ...envPatch };
  // 文件可能携带 tier 凭据（settings.env 注入 token）：按仓库写盘惯例 0600
  // （NTFS 不认权限位，mode 在 Windows 上无害忽略）；清理由调用方 finally 负责。
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), { mode: 0o600 });
  return settingsPath;
}

/**
 * 生成 policy hook 注入所需的临时 settings 路径（放在 orchestrator logs 外的
 * 系统临时目录，随任务结束可删）。
 */
export function newWorkerSettingsPath() {
  // os.tmpdir()：Windows 无 TMPDIR，回落 '/tmp' 经 path.join 落「当前盘根\tmp」
  //（通常不存在）→ mkdtempSync ENOENT（2026-10-31 卡 17）
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-settings-')), 'worker-settings.json');
}
/** researcher 会话工具白名单（只读文件 + 联网检索；无 Bash 无写，fail-closed 同 reviewer）。
 *  WebSearch 在非 Anthropic 后端可能不可用（不可用时会话内自然退化，产出引用不足即被
 *  validateBriefBody 拒收）——research --selftest 供船东实测两条工具的可用性。
 *  mcp__zsearch__web_search：本地 zsearch MCP server（智谱 BigModel 搜索包，user scope
 *  注册于 ~/.claude.json，server 脚本 ~/.agents/mcp/zsearch-mcp.mjs）——船东未注册该
 *  server 时该工具自然缺席（白名单多余项无害），已注册则优先用真实搜索包。 */
export const RESEARCH_TOOLS = ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'mcp__zsearch__web_search'];

/** 组装 claude CLI 参数（纯函数，测试用）。model 可选（--model，执行/审查分源换模型用）。
 *  web: true = researcher 会话（只读 + 联网白名单）；与 readonly 互斥时 web 优先。 */
export function buildClaudeArgs({ maxTurns, readonly, web, model, settingsFile }) {
  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose', // --print 下用 stream-json 必须带 --verbose（claude CLI 校验）
    '--max-turns',
    String(maxTurns),
  ];
  if (model) args.push('--model', model);
  if (web) {
    // 调研会话：只读文件 + WebFetch/WebSearch，无 acceptEdits——headless 下未列入
    // 白名单的工具调用被自动拒绝（fail-closed），编辑/命令不可能发生
    args.push('--allowedTools', ...RESEARCH_TOOLS);
  } else if (readonly) {
    // 只读会话（reviewer）：白名单收敛为只读工具，无 acceptEdits——headless 下
    // 未列入白名单的工具调用被自动拒绝（fail-closed），编辑/命令不可能发生
    args.push('--allowedTools', 'Read', 'Glob', 'Grep');
  } else {
    args.push(
      '--permission-mode',
      'acceptEdits',
      '--allowedTools',
      ...allowedTools(),
      '--disallowedTools',
      ...DISALLOWED_TOOLS,
    );
  }
  if (settingsFile) args.push('--settings', settingsFile);
  return args;
}

/**
 * spawn 实参/选项组装（纯函数，platform 注入供任意 OS 断言双分支；调用处只做
 * spawn(inv.cmd, inv.args, inv.options)）。
 * Windows 上 claude 是 .cmd 包装，spawn 必须走 shell 才能命中——可用性探测
 * （claudeAvailable）已带 win32 shell，spawn 必须同语义，否则「探测说可用、
 * 实际起不来」，worker/审查全挂落 blocked/。prompt 走 stdin，不受 shell 命令行
 * 长度限制；含空格的 args（--allowedTools 白名单族、--settings 临时路径）由
 * quoteArgsForShell 包引号。unix 不加 shell（sh -c 包装改变进程组/信号语义，
 * detached 独立进程组 + 熔断杀树依赖它）。
 */
export function claudeSpawnInvocation(platform, args, { cwd, envPatch }) {
  const useShell = platform === 'win32';
  const options = {
    cwd,
    detached: !useShell, // win32 无 detached（shell 包装层无进程组意义）；unix 独立进程组，熔断时可整组 kill（kill-tree.mjs）
    stdio: ['pipe', 'pipe', 'pipe'],
    ...(useShell ? { shell: true } : {}),
  };
  if (envPatch && Object.keys(envPatch).length) options.env = { ...process.env, ...envPatch };
  // win32 整串化消 DEP0190（Node 内部同款拼行，行为等价）；unix 原样数组
  const [cmd, spawnArgs] = shellCommandline('claude', quoteArgsForShell(args, useShell), useShell);
  return { cmd, args: spawnArgs, options };
}

export const claudeHeadlessBackend = {
  name: 'claude-headless',

  spawn({ promptFile, cwd, maxTurns, onEvent, settingsFile, readonly, web, model, envPatch }) {
    return new Promise((resolve, reject) => {
      const prompt = fs.readFileSync(promptFile, 'utf8');
      const args = buildClaudeArgs({ maxTurns, readonly, web, model, settingsFile });

      // detached：独立进程组，熔断时可整组 kill（kill-tree.mjs）——组装细节见
      // claudeSpawnInvocation（win32 shell 同语义探测纪律）
      const inv = claudeSpawnInvocation(process.platform, args, { cwd, envPatch });
      const child = spawn(inv.cmd, inv.args, inv.options);
      // role 区分 worker/reviewer/researcher 会话：resolveBackendName 只认 worker 侧 spawn——
      // 异构互审后事件流最后一条 spawn 是 reviewer 的引擎，不区分会让 retry/resume
      // 静默换船（2026-10-29 夜跑「静默换引擎」事故同型）；trackPid/cleanupOrphanWorker
      // 两类都要（孤儿 reviewer/researcher 也得能杀）
      onEvent({ type: 'worker_spawned', role: web ? 'researcher' : readonly ? 'reviewer' : 'worker', backend: 'claude-headless', pid: child.pid, ...(model ? { model } : {}) });

      let tokensIn = 0;
      let tokensOut = 0;
      let cacheReadIn = 0; // 缓存读单列（billable 口径的剔除项，与会话累计同口径）
      let output = '';
      let stderrTail = '';
      let settled = false;

      const usageFrom = (u = {}) => ({
        input: u.input_tokens ?? 0,
        cacheRead: u.cache_read_input_tokens ?? 0,
        cacheCreate: u.cache_creation_input_tokens ?? 0,
        output: u.output_tokens ?? 0,
      });

      child.stdout.setEncoding('utf8');
      let buf = '';
      child.stdout.on('data', (chunk) => {
        buf += chunk;
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line) continue;
          let evt;
          try {
            evt = JSON.parse(line);
          } catch {
            continue; // 非 JSON 行（版本差异），容错跳过
          }
          if (evt.type === 'assistant' && evt.message?.usage) {
            const u = usageFrom(evt.message.usage);
            tokensIn += u.input + u.cacheRead + u.cacheCreate;
            tokensOut += u.output;
            cacheReadIn += u.cacheRead;
            const turn = (evt.message.id ?? '').slice(-8) || undefined;
            onEvent({ type: 'worker_turn', turn: turn ?? undefined, tool: lastToolName(evt) });
            onEvent({ type: 'budget_snapshot', tokens_in: tokensIn, tokens_out: tokensOut, tokens_cache_read: cacheReadIn, tokens_billable: billableTokens(tokensIn, tokensOut, cacheReadIn) });
          } else if (evt.type === 'result') {
            output = evt.result ?? '';
            if (evt.usage) {
              // result 的 usage 是会话累计，以此为准回填（防漏计）
              const u = usageFrom(evt.usage);
              tokensIn = Math.max(tokensIn, u.input + u.cacheRead + u.cacheCreate);
              tokensOut = Math.max(tokensOut, u.output);
              cacheReadIn = Math.max(cacheReadIn, u.cacheRead);
              onEvent({ type: 'budget_snapshot', tokens_in: tokensIn, tokens_out: tokensOut, tokens_cache_read: cacheReadIn, tokens_billable: billableTokens(tokensIn, tokensOut, cacheReadIn) });
            }
          }
        }
      });

      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (c) => {
        stderrTail = (stderrTail + c).slice(-4000);
      });

      child.on('error', (e) => {
        if (!settled) {
          settled = true;
          reject(new Error(`claude CLI 启动失败（检查 PATH 中是否有 claude）：${e.message}`));
        }
      });

      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        resolve({ exitCode: code ?? 1, output, stderrTail, usage: { tokensIn, tokensOut }, pid: child.pid });
      });

      child.stdin.write(prompt);
      child.stdin.end();
    });
  },
};

function lastToolName(evt) {
  const content = evt.message?.content;
  if (!Array.isArray(content)) return undefined;
  const tools = content.filter((c) => c.type === 'tool_use');
  return tools.length ? tools[tools.length - 1].name : undefined;
}

// 供 orchestrator.mjs 动态选择后端
export async function getBackend(name) {
  if (name === 'claude-headless') return claudeHeadlessBackend;
  if (name === 'zcode-headless') return (await import('./zcode-headless.mjs')).zcodeHeadlessBackend;
  if (name === 'codex-headless') return (await import('./codex-headless.mjs')).codexHeadlessBackend;
  if (name === 'mock') return (await import('./mock.mjs')).mockBackend;
  throw new Error(`未知后端 "${name}"（允许：claude-headless | zcode-headless | codex-headless | mock）`);
}

/**
 * claude CLI 定位（探测/诊断面）：ORCH_CLAUDE_CLI 环境变量优先——与 ORCH_ZCODE_CLI
 * 同款 seam，CI/沙箱没有 PATH claude 时指向桩脚本，动态选船的可用性探测才可确定
 * （否则「CLI 不可用」会抢在海况口径前面留痕）。脚本型目标（.cjs/.mjs/.js）用当前
 * node 直跑，其余按可执行直跑；未设则用 PATH 里的 `claude`。
 * 仅作用可用性探测与诊断（drill）：worker 实际拉起仍走 PATH 的 claude
 * （claudeSpawnInvocation 的 stream-json 输出契约依赖真实 CLI，不随此变量改道）。
 */
export function claudeCliSpec() {
  const custom = process.env.ORCH_CLAUDE_CLI?.trim();
  if (!custom) return { ok: true, cmd: 'claude', baseArgs: [] };
  if (!fs.existsSync(custom)) {
    return { ok: false, reason: `ORCH_CLAUDE_CLI 指向的文件不存在：${custom}` };
  }
  if (/\.(cjs|mjs|js)$/i.test(custom)) return { ok: true, cmd: process.execPath, baseArgs: [custom] };
  return { ok: true, cmd: custom, baseArgs: [] };
}

/** claude CLI 可用性探测（spawnSync --version；PATH 探测在 Windows 走 shell 以命中 .cmd 包装；按进程缓存）。 */
let claudeProbeCache;
export function claudeAvailable() {
  if (claudeProbeCache === undefined) {
    try {
      const spec = claudeCliSpec();
      const r = spec.ok
        ? spawnSync(spec.cmd, [...spec.baseArgs, '--version'], {
            encoding: 'utf8',
            timeout: 30_000,
            // 绝对路径直 exec（node 直跑/自定义可执行）不需要 shell——shell 反而引入
            // 空格路径解析坑；仅 PATH 探测的 'claude' 在 Windows 需要 shell 命中 .cmd
            shell: spec.cmd === 'claude' && process.platform === 'win32',
          })
        : { status: 1 };
      claudeProbeCache = r.status === 0;
    } catch {
      claudeProbeCache = false;
    }
  }
  return claudeProbeCache;
}

/**
 * 审查后端解析（异构审查）：把「执行」与「审查」拆成两个 agent 会话——
 * 但真正解决「既当运动员又当裁判」靠的是**引擎异源**（不同 CLI/模型家族无共同盲区），
 * 仅拆会话仍同源时只能部分去相关。解析顺序：
 *   1. 显式 --review-backend（'same' = 强制与 worker 同源）；
 *   2. 任务上次 review_spawned 的后端（retry/resume 不换审查引擎）；
 *   3. 自动异构：worker 为真实后端时选另一个 CLI 可用的真实后端
 *      （mock worker 永不异构——测试零外部调用前提）；
 *   4. 回落 worker 同源（mode='fallback'，调用方记 review_backend_fallback 事件）。
 * 返回 { name, mode: 'explicit' | 'prior' | 'heterogeneous' | 'fallback' }。
 * 未知显式后端名由调用方经 getBackend 校验（统一报「未知后端」）。
 */
export function resolveReviewBackendName({ worker, explicit, prior, probe } = {}) {
  const probeFn =
    probe ??
    ((name) => {
      if (name === 'claude-headless') return claudeAvailable();
      if (name === 'zcode-headless') return zcodeAvailable();
      if (name === 'codex-headless') return codexAvailable();
      return true; // mock 等非 CLI 后端视为可用
    });
  if (explicit) return { name: explicit === 'same' ? worker : explicit, mode: 'explicit' };
  // prior 沿用有两个例外（双向防御，2026-10-31 卡 17）：
  //   a) prior 是 mock 而 worker 已换真实后端——mock reviewer 固定输出「无阻塞」，
  //      把它当真实审查结果喂门禁等于跳过审查（且无任何日志）；
  //   b) worker 是 mock 而 prior 是真实后端——mock 会话是测试路径，「零外部调用、
  //      永不异构」是不变量，给它派真实 CLI 审查后端会烧真钱（2026-10-31 卡 17）。
  // 两个方向都不沿用，让解析走后面的自动异构/fallback 分支。
  if (prior && !(prior === 'mock' && worker !== 'mock') && !(worker === 'mock' && prior !== 'mock')) {
    return { name: prior, mode: 'prior' };
  }
  // 异构候选有序数组（探测守卫：按序取第一个 CLI 可用的候选；全不可用回落同源）。
  // codex-headless 作次选加入（codex-catalog-ship 卡），既有 claude↔zcode 优先序不变。
  const OTHERS = {
    'claude-headless': ['zcode-headless', 'codex-headless'],
    'zcode-headless': ['claude-headless', 'codex-headless'],
    'codex-headless': ['claude-headless', 'zcode-headless'],
  };
  for (const other of OTHERS[worker] ?? []) {
    if (probeFn(other)) return { name: other, mode: 'heterogeneous' };
  }
  return { name: worker, mode: 'fallback' };
}

/**
 * 后端名解析：显式 --backend 优先；run 场景（qdir 非空）沿用任务上次会话的后端
 * （retry/resume 续跑不换引擎）；否则缺省 claude-headless。
 * 沿用取**最后一条 worker 侧** worker_spawned（role !== 'reviewer'）：events.jsonl
 * append-only，.find 命中首次运行——多引擎切换过的任务 resume 会静默切回最初引擎
 * （正是后端切换人工闸门要防的事）。reviewer 的 spawn 事件必须排除：异构互审后
 * 事件流最后一条是 reviewer 的引擎，不排除则 retry/resume/reviewing 恢复全部
 * 静默换船。无 role 的历史事件视为 worker（向后兼容旧队列）。
 * 与 cleanupOrphanWorker 的 reverse().find 口径差异是有意的：孤儿清理要杀的
 * 恰恰包括 reviewer 进程，不做 role 过滤。
 * intent/spec 的规划会话不记账（qdir 传 null），首次即缺省——此前它们直接把
 * opts.backend（undefined）喂给 getBackend 炸「未知后端 "undefined"」（裸跑
 * `spec "..."` 实测踩中；历史测试全带 --backend mock 所以从未暴露）。
 */
export function resolveBackendName(opts, qdir, readEventsFn) {
  if (opts?.backend) return { name: opts.backend, inherited: false };
  const prior = qdir && readEventsFn
    ? [...readEventsFn(qdir)].reverse().find((e) => e.type === 'worker_spawned' && e.role !== 'reviewer')?.backend
    : undefined;
  return { name: prior ?? 'claude-headless', inherited: prior !== undefined };
}
