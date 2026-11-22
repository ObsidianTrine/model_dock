# Dockmaster 高层设计说明书

> 体系名 **Dockmaster（坞长）**——ModelDock 的 Dock，管坞的人就是 dockmaster；命令行与代码内命名保持 orchestrator 不变，Dockmaster 只用于文档与心智模型（命名理由见 `.agents/workflows/orchestrator.md` 开头）。

| 文档属性 | 内容 |
|---|---|
| 当前版本 | **v2.0** |
| 状态 | 设计基准 |
| 日期 | 2026-11-16 |
| 读者 | 接手实现的 agent / 评审人 |

**版本历史**

| 版本 | 日期 | 说明 |
|---|---|---|
| v2.0 | 2026-11-16 | 按设计先行原则重写（对齐 docs/design/hld.md 口径）：删除实施计划与实施对账，Phase 交付内容收编为子系统设计，剥离版本号注记与日期注记；规划项收敛至 TODOLists.md 台账（单一出处） |
| v1.0 – v1.4 | 2026-10-11 ~ 11-15 | 初版及四次随交付追加的修订（设计+实施对账混合口径），已被 v2.0 设计口径取代 |

## 目录

1. [引言](#1-引言)
2. [背景与目标](#2-背景与目标)
3. [设计输入](#3-设计输入)
4. [总体架构与演进路线](#4-总体架构与演进路线)
5. [设计公理：海事五原则](#5-设计公理海事五原则)
6. [子系统设计](#6-子系统设计)
7. [验收标准](#7-验收标准)
8. [红线与边界](#8-红线与边界)
9. [关键默认值](#9-关键默认值)
10. [规划中](#10-规划中)
11. [附录：参考资料](#11-附录参考资料)

---

## 1. 引言

### 1.1 定位与读者

本文定义 Dockmaster 自治编排体系的边界、架构与子系统设计，是详细实现与维护的基准。读者为工程评审人与接手实现的 agent。

本文为设计先行文档：所述能力为体系的承诺交付面。操作口径（怎么用、怎么写任务卡、怎么处理闸门）在 `.agents/workflows/orchestrator.md` 及其场景 runbook（orch-*.md），本文不重复。暂缓与规划项的执行台账在 `.agents/docs/TODOLists.md`（单一出处，见 §10）。

### 1.2 范围

**覆盖**：任务卡与队列状态机、事件日志、worker 执行与权限模型、调试子循环、静态门禁、独立审查、合并闸门与分级自动合并、熔断与预算、策略守护、调度与并行、巡检信号源、质量漂移保险丝、成本对账、Planner。

**不覆盖**：feature-branch 工作流本身（`.agents/workflows/feature-branch.md`）；具体客户端接入与网关产品功能（见 docs/design/hld.md）；调研可信度契约（`.agents/docs/research-verdict.md`）。

---

## 2. 背景与目标

ModelDock 已具备成熟的多 agent 并行开发约定（feature-branch 工作流 + worktree 隔离 + NOTES.md 交接 + 领域 playbook）。Dockmaster 在其上建立**自治编排体系**，让一个 agent 系统能够：

> 根据项目特点自动分配任务 → 自动修改 → 自动优化 → 自动审查 → 自动调试 BUG → 迭代，直到产出可合并的成果。

核心约束（与整个项目一致）：

- **纯 Node 标准库、零第三方依赖**（与 `feature-branch.mjs` 同技术栈；orchestrator 属于 `.agents/` 工具链，不进 src/、不进 SEA 包）。
- **8687 / 8890 生产端口永远人工；发布动作人工授权制**——端口边界硬编码不可关闭；发布（push/tag）默认拦截，仅用户明确授权发版后按 release.md「代理发布」以 `MODELRDOCK_ALLOW_RELEASE=1` 前缀放行白名单形态。
- **合并权与发布权永远在人**（责任不转移，见 §5 原则 5）。

---

## 3. 设计输入

### 3.1 业界调研结论

调研四个代表性实践与一组安全共识做法，提炼可复用的架构精髓。

**Ralph Wiggum 循环**（Geoffrey Huntley 提出，社区广泛采用）：核心是"Bash 循环"——开发拆成小任务逐条喂给 agent，每轮带验证命令，不靠单次完美、靠持续迭代收敛。**启示**：调试子循环（编排器亲自跑测试，失败喂回修复）比"agent 自报完成"可靠。

**Gas Town**（Steve Yegge，多 agent "暗工厂"）：协调 20-30 个并行 Claude Code 实例，四个关键机制——worktree 隔离、Beads 持久记忆（会话崩溃后断点续起）、角色层级（Mayor 派发 / worker 执行 / Witness 监督）、MEOW 分子式任务链。**启示**：worktree 隔离和持久交接是自治的两大地基——ModelDock 两者已有。

**GitHub Copilot Coding Agent**：Issue 分配 → agent 开 draft PR → 边做边推 commit → 人类在 PR 环节审查才合并；每会话独立 worktree。**启示**：人类闸门设在合并点是最小信任面；按改动爆炸半径分级可进一步放松低风险场景。

**OpenHands**：事件溯源架构——无状态 agent + append-only 事件日志 + action→observation 循环；技能、子 agent、安全分析器都是挂在循环上的 hook。**启示**：`events.jsonl`（append-only）同时解决崩溃恢复、成本核算、质量回溯三个问题。

**安全控制共识**：策略守护（interceptor）模式——agent 不直接执行敏感动作，必须发出意图由本地策略层裁决；成本熔断（max_turns / token 预算 / 迭代上限 / wall-clock）；分支隔离是底线。

**共同骨架（六要素）**：

```
外层编排循环 → worktree 隔离 → 任务队列/持久记忆 → 验证门禁 → 人类闸门 → 成本熔断
```

### 3.2 基础设施盘点（方案核心：不自造轮子，用薄编排层把已有原语串成闭环）

| 业界机制 | ModelDock 对应物 |
|---|---|
| worktree 隔离 | `.agents/scripts/feature-branch.mjs`（start/finish/list） |
| 持久记忆 / 断点续传 | worktree 内 `NOTES.md` 交接约定 |
| 分子工作单元 | `.agents/workflows/*.md` playbook 家族 |
| 策略守护 | `.agents/scripts/policy.mjs` 单一策略引擎 + guard-develop / policy-worker 薄壳 hook |
| 外层编排循环 | `.agents/scripts/orchestrator.mjs` |
| 任务队列 | 7 状态目录文件系统队列 + `run --next` / `drain` 自动调度 |
| 事件日志 | `.agents/orchestrator/logs/<task-id>/events.jsonl`（append-only） |
| 分级人类闸门 | L3 人工闸门 + L0/L1 自动合并（gate 上限声明 + 分级裁决） |
| 成本熔断 | 轮次 / token / wall-clock / 双迭代上限；网关 usage 旁路解析支撑对账 |

---

## 4. 总体架构与演进路线

### 4.1 目标架构（五层自治闭环）

```
┌─────────────────────────────────────────────────────────┐
│ 0. 信号源（任务从哪来）                                    │
│   TODO/FIXME 扫描 · npm test 失败 · npm audit · issue   │
│   CHANGELOG 未发布段 · 手动投任务卡                        │
└────────────────────┬────────────────────────────────────┘
                     ▼
┌─────────────────────────────────────────────────────────┐
│ 1. Planner（分析项目特点 → 拆任务 → 写任务卡）              │
│   产出：.agents/orchestrator/queue/pending/<task-id>.md   │
└────────────────────┬────────────────────────────────────┘
                     ▼
┌─────────────────────────────────────────────────────────┐
│ 2. Dispatcher（认领任务卡 → feature-branch start →        │
│    起 headless agent → 注入 AGENTS.md + 命中的 playbook） │
└────────────────────┬────────────────────────────────────┘
                     ▼
┌─────────────────────────────────────────────────────────┐
│ 3. Worker（think→act→observe 循环 + 调试子循环，           │
│    全程写 events.jsonl）                                  │
└────────────────────┬────────────────────────────────────┘
                     ▼
┌─────────────────────────────────────────────────────────┐
│ 4. Reviewer（静态门禁 + 独立上下文 LLM 审查 diff）          │
└────────────────────┬────────────────────────────────────┘
                     ▼
┌─────────────────────────────────────────────────────────┐
│ 5. Gate（分级合并闸门）                                   │
│   L0 纯文档/测试 → 全自动 │ L1 普通 src + 审查过 → 自动    │
│   L2 核心路径 → 人批准    │ L3 打 tag/推 main/8687 → 永人工 │
└─────────────────────────────────────────────────────────┘
```

### 4.2 演进路线（自主权逐级放开，人工闸门永不撤除）

| 阶段 | 能力 | 自主权 | 状态 |
|---|---|---|---|
| Phase 1 | 单任务闭环：submit → worker → 门禁 → 审查 → 人工合并；事件日志 + 熔断 | 仅 L3 闸门 | 已落地 |
| Phase 2 | 队列自动调度；L0/L1 自动合并；策略守护完整版；巡检信号源（含内容消毒）；Planner | L0/L1 放开 | 已落地 |
| Phase 3 | 多 worker 并行（文件归属分区互斥）；质量漂移监控与自动降级 | 并行自治 | 已落地 |
| 长期 | L3 闸门（生产端口、发布）永远保留人工 | — | 设计如此 |

---

## 5. 设计公理：海事五原则

海事行业几百年沉淀的本质，是「让一个船长安全指挥多船长期在海上」的制度。以下五条作为设计公理——未来每次扩展先过一遍这五问，防止效率改造悄悄侵蚀安全结构：

1. **双罗经（关键判定不依赖单一来源）**：审查引擎异构互审（claude/zcode 分源，防同底座共因盲区）、worker 自报 vs 门禁实测、reconcile 自报账 vs 网关实测账。单一信号源只做 advisory，裁决必须有第二来源。
2. **水密舱（单点破损不沉全船）**：drain 逐卡子进程隔离（单卡 blocked 不阻塞后续）、任务级互斥锁、队列运行态与代码仓分离。任何一舱进水，全队照航。
3. **分道通航（并发靠确定性规则，不靠协商）**：files_hint 分区互斥、调度器锁、引水闸（pilotage_required）、端口红线。通行规则必须机器可判定，LLM 判断永远排在确定性规则之后（对齐 pr-risk-tier「确定性先行」哲学）。
4. **领先指标优先（险情先于事故）**：watchdog_suspect / xte_alarm / worker_retry / fastlane_skipped 是近乎事故（near-miss）留痕，stats 安全晴雨表聚合为领先指标；drift 的 revert 统计是滞后指标。监控体系先看前者——近乎事故率上升早于真实失败出现。
5. **责任不转移（引水登轮，船长不卸责）**：autopilot 自动提交、异构审查、ci-autofix 自动修复，都不改变合并权与发布权在人。自动化程度越高，人工闸门越要显式、留痕、可审计（gate 分级 / AGENTS_ALLOW_RELEASE 白名单 / awaiting-human 目录）。

---

## 6. 子系统设计

### 6.1 任务卡

位置：`.agents/orchestrator/queue/pending/<task-id>.md`。Markdown + YAML frontmatter，**人可直接手写**，也是 Planner 自动生成的目标格式。

```markdown
---
id: fix-presets-merge
type: bugfix                  # bugfix | feature | docs | deps | refactor
priority: normal              # low | normal | high
created_at: 2026-10-01T10:00:00+08:00
created_by: human             # human | scanner | planner
budget:
  max_turns: 50               # worker agent 最大轮次（防死循环）
  max_tokens: 500000          # 单任务 token 预算上限（可计费口径，见 6.9）
  max_wall_minutes: 60        # wall-clock 超时（分钟）
  max_test_iterations: 5      # 调试子循环上限（测试失败→修→重跑）
  max_review_iterations: 3    # 审查修复子循环上限（独立于调试计数）
files_hint:                   # 预期改动范围（glob），供门禁做纯度检查与并行分区
  - src/presets/**
  - test/presets/**
workflows:                    # 注入 worker prompt 的 playbook 文件名（不含 .md）
  - feature-branch
  - docs-sync
gate: L3                      # 本任务允许自动合并的级别上限（L0 | L1 | L3，缺省 L3）
---

# 目标
修复 presets.json 中同名 id 的用户预设未覆盖内置预设的问题。

# 验收标准
- `npm test` 全绿
- 新增测试用例覆盖：同名 id 覆盖、新 id 追加、格式错误阻断启动
- 不改动 src/cli.ts

# 红线
- 禁止监听 8687 / 8890
- 禁止硬编码 ~/.modeldock，路径走 src/util/paths.ts
- 写盘走 atomicWrite()

# 背景
现象：……复现步骤：……相关文件：src/presets/data.ts 的 applyUserPresets()
```

**设计要点**：

- `验收标准` 必须是可机器检查的断言（测试命令、文件存在性、grep 模式）——orchestrator 用它做完成判定辅助，worker 用它做自我验证靶子。提交入口有确定性锚点校验（验证命令 / 测试路径 / 行为断言词），空洞卡拒绝提交（scanner 产卡豁免）——「可机器检查」是机器门禁，不是 prompt 纪律。
- worker 按验收标准逐条申报满足数（`acceptance: m/n`）：自报缺口即不等门禁直接送返工子循环（`acceptance_gap`，与测试修复共用 `max_test_iterations` 计数）；申报缺失/解析不出则跳过——达标与否仍由门禁与 reviewer 机器验证（自报不可信原则不受影响）。

### 6.2 队列状态机与崩溃恢复

```
pending/ ──run──► running/ ──worker完成──► reviewing/ ──审查通过──► awaiting-human/
                  │  ▲                        │                        │
                  │  └── 审查有阻塞，意见喂回   │ 门禁失败(超迭代上限)      │ approve → finish → merged/
                  │      worker（回边，受      │ 红线门禁（port/native）  │ reject（附原因）→ failed/
                  │      max_review_          ▼                        │ retry（附补充指令）→ running/
                  │      iterations 约束）  blocked/（等人工决策）◄──────┘（b 打回重试）
```

- 状态迁移 = `fs.rename` 任务卡在目录间移动（原子、无锁、崩溃安全）。目录全集：`pending/ running/ reviewing/ awaiting-human/ merged/ failed/ blocked/`。
- **调试子循环与审查修复子循环计数独立**：测试失败重跑计 `debug_iteration`（上限 `max_test_iterations`），审查阻塞返工计 `review_iteration`（上限 `max_review_iterations`）——两者语义不同，混用一个计数会把"代码没写对"和"审查标准没满足"搅在一起，且熔断原因无法区分。
- **崩溃恢复（两个方向都覆盖）**：
  - *worker 死了*（编排器在、worker PID 不存活）：读 `events.jsonl` + worktree `NOTES.md` 生成恢复摘要，提示操作者选择 `resume`（新 worker 带恢复上下文续做）或 `abandon`（按 worktree-rescue 流程清理，不自动删 worktree）。
  - *编排器死了、worker 还活着*（孤儿 worker）：孤儿会继续烧预算——`resume`/`run` 启动时先按 `events.jsonl` 里 `worker_spawned` 记录的 PID 检查进程是否仍存活，存活则**先杀掉整棵进程树**（见 6.9 killTree）再走恢复流程，绝不带着旧 worker 并行开新 worker。

### 6.3 事件日志

位置：`.agents/orchestrator/logs/<task-id>/events.jsonl`。append-only，每行一个 JSON 事件：

```jsonl
{"ts":"2026-10-01T10:00:01+08:00","seq":1,"type":"task_submitted","task_id":"fix-presets-merge","card_hash":"sha256:..."}
{"ts":"...","seq":2,"type":"worktree_ready","path":"...","branch":"feature/fix-presets-merge"}
{"ts":"...","seq":3,"type":"worker_spawned","backend":"claude-headless","pid":1234}
{"ts":"...","seq":4,"type":"worker_turn","turn":7,"tool":"Edit","file":"src/presets/data.ts"}
{"ts":"...","seq":5,"type":"command","cmd":"npm test","exit":1,"duration_ms":42000}
{"ts":"...","seq":6,"type":"debug_iteration","attempt":2,"trigger":"test_failure"}
{"ts":"...","seq":7,"type":"budget_snapshot","tokens_in":83000,"tokens_out":21000,"elapsed_min":12}
{"ts":"...","seq":8,"type":"circuit_breaker","reason":"max_test_iterations","detail":"5/5"}
{"ts":"...","seq":9,"type":"gate_result","gate":"npm_test","result":"pass"}
{"ts":"...","seq":10,"type":"review_verdict","blockers":0,"suggestions":2,"notes":1}
{"ts":"...","seq":11,"type":"human_gate","decision":"approved"}
{"ts":"...","seq":12,"type":"merged","merge_commit":"f5b5f2d","duration_min":31}
```

- 事件类型全集含：`task_submitted / worktree_ready / worker_spawned / worker_turn / command / debug_iteration / budget_snapshot / circuit_breaker / gate_result / review_verdict / human_gate / merged / failed / blocked`，另有运行期增量事件（`auto_merge` / `auto_merge_decision` / `change_classification` / `budget_baseline` / `review_verdict_retry` / `awaiting_human` 等，语义见对应小节）。事件字典的完整速查见 `.agents/reference/orch-events.md`。
- `seq` 单调递增；`ts` 用 ISO8601 带时区。
- **用途**：崩溃恢复（重建上下文）、成本核算、质量漂移统计（§6.12）。

### 6.4 Worker 执行

**Prompt 组装**（orchestrator 自动生成到临时文件，作为 worker 输入）：

```
[系统层] AGENTS.md 全文（端口红线、工程约定、判定边界）
[流程层] 任务卡 workflows 字段命中的 playbook 全文（.agents/workflows/<name>.md）
[任务层] 任务卡的 目标 / 验收标准 / 红线 / 背景
[环境层] worktree 绝对路径 + "所有编辑必须使用此路径下的绝对路径，禁止改主目录"
[契约层] 输出契约（见下）
```

**输出契约**（worker 结束前必须产出，orchestrator 正则解析 fenced block）：

````
```modeldock-result
status: done | stuck
summary: 一句话说明
files_changed: ["src/presets/data.ts", "test/presets/data.test.ts"]
tests: pass | fail
acceptance: 2/2
notes_updated: true
```
````

- `stuck` → 任务转 `blocked/`（NOTES.md 已留现场），等人工决策或换模型重试。
- 结束纪律：done 前自验（测试 + 构建）、干净提交、权限拒绝满 2 次判 stuck 熔断——防止任务在权限墙前空转烧预算。
- **自报不可信**：无论 worker 报什么，orchestrator 都亲自跑静态门禁（§6.6）。

**Worker 后端抽象（可插拔）**：

```typescript
// .agents/scripts/orchestrator/backends/types.mjs（JSDoc 类型，纯 .mjs 零依赖）
/**
 * @typedef {Object} AgentBackend
 * @property {string} name
 * @property {(opts: {
 *   promptFile: string,       // 组装好的 prompt 文件路径
 *   cwd: string,              // worktree 绝对路径
 *   maxTurns: number,
 *   onEvent: (e: object) => void   // 流式事件 → 转写 events.jsonl
 * }) => Promise<{ exitCode: number, usage: { tokensIn: number, tokensOut: number } }>} spawn
 */
```

两个后端：

- **`claude-headless`**：包装 `claude -p --output-format stream-json --max-turns N`（项目已有 hook 体系，worker 会话自动继承保护）。解析 stream-json 事件流转写 `worker_turn` / `budget_snapshot`。瞬时故障（无结果块且带 429/网络签名）按退避原地重试（60s × attempt，≤3 次）。
- **`mock`**：假后端——在 worktree 写固定文件、输出固定契约块。用于 orchestrator 自身集成测试（不烧钱、秒级）。

**Worker 权限模式（headless 必配，缺一不可）**：

headless `claude -p` 没有 TTY，无法响应交互式权限确认：默认权限模式下 worker 的第一次 Edit 就会被自动拒绝，任务烧完 `max_turns` 零产出；反之若用 `--dangerously-skip-permissions` 全量放行，则把任意命令执行面暴露给自治进程。因此按以下组合启动：

```
claude -p \
  --output-format stream-json \
  --max-turns <budget.max_turns> \
  --permission-mode acceptEdits \
  --allowedTools Edit Write Read Glob Grep "Bash(npm test:*)" "Bash(npm run build)" \
               "Bash(git add:*)" "Bash(git commit:*)" "Bash(git diff:*)" "Bash(git status)" \
               "Bash(git log:*)" "Bash(git -C .agents/worktrees/*:*)" \
  --disallowedTools "Bash(git push:*)" "Bash(git tag:*)" "Bash(npm publish:*)" \
  --settings <orchestrator 生成的 worker 专属 settings 文件>   # 注入 policy-worker.mjs（见 6.10）
```

- `acceptEdits` 只自动放行文件编辑类工具；命令执行走 `--allowedTools` 白名单按前缀放行，未列出的 Bash 命令在 headless 下被自动拒绝（fail-closed）。
- 白名单是**常规约束**，policy-worker hook 是**红线兜底**（白名单配错漏放 push/tag 时仍有硬拦截），两层缺一不可。
- **Windows 权限墙**：claude CLI 在 Windows 的 shell 工具是 PowerShell，`Bash(...)` 白名单匹配不到 PowerShell 调用——白名单/红线/hook matcher 一律 **Bash + PowerShell 双形态**。
- `--max-turns` 的 turn = 一次完整的 assistant 消息循环（含其全部工具调用），与 `budget.max_turns` 同语义，直接透传。
- worker 专属 settings 只经 `--settings` 注入，**不写入项目级 `.claude/settings.json`**——那会连带约束人工交互会话（agent 推 feature 分支是日常操作，不该被全局拦掉）。

### 6.5 调试子循环

```
worker 报告 done
  → orchestrator 在 worktree 内跑 testCmd（.agents/workflow.json，本仓库为 npm test）
  → 失败？把失败输出截断（尾部 200 行）追加为 fixup prompt，在同一 worktree 重启 worker 续做
  → 记 debug_iteration 事件（计数独立于审查返工，见 6.2）
  → attempt > max_test_iterations → 熔断（circuit_breaker 事件）→ blocked/
```

`tsc_build` 门禁失败走同一个调试子循环、共用 `max_test_iterations` 计数（都是"产物不达标"）。

### 6.6 静态门禁（合并前全部执行）

| 门禁 | 实现 | 失败后果 |
|---|---|---|
| `npm_test` | worktree 内跑 `workflow.json` 的 testCmd | 进调试子循环（6.5） |
| `tsc_build` | `npm run build` | 进调试子循环（与 npm_test 共用迭代计数） |
| `port_scan` | diff **只扫 `src/**` 新增行**，匹配 listen/端口绑定模式后接 8687/8890 | 直接 failed（红线不可调试） |
| `native_scan` | diff 触及 package.json 时，对新依赖检查 `.node`/`binding.gyp`/prebuilds | 直接 failed |
| `scope_purity` | 改动文件超出 `files_hint` 范围 | 警告注入审查 prompt，不阻塞 |
| `cli_entry` | diff 触及 `src/cli.ts` | 人工闸门标红高亮 |

> **port_scan 为什么限定 `src/**`**：本仓库的网关测试文件与 AGENTS.md 本来就大量合法提及 8687/8890（端口约定文档、测试断言），全仓扫描会误杀正常任务。红线门禁误杀的代价比漏报高——真要在测试里监听生产端口的改动也过不了 `npm test` 人工审查这一关；如需扩大范围，在实现里调白名单并同步本文档。

### 6.7 LLM 独立审查

- 静态门禁全过后，orchestrator 生成 `git diff develop...HEAD`，起**第二个 headless 会话**（全新上下文、**权限层强制只读**：`--allowedTools Read Glob Grep`，无 acceptEdits——headless 下白名单外工具调用被自动拒绝，编辑/命令在权限层不可能发生），prompt 用 code-review.md 中固化的模板，并注入 REVIEW.md 纪律。
- **逐条裁决（Task-first review）**：验收标准拆条编号进 prompt，reviewer 对每条给 pass/fail 判定与证据，fail 计阻塞项——给 critic 任务说明 + 变更、按任务逐项核，业界实证最优的 L3 评审形态（独立 critic 性价比最优）。`created_by: planner` 的卡追加第 5 项检查——验收标准的完备性（空洞标准/未覆盖意图/Planner 幻觉计阻塞项），独立审查同时盯住 Planner 的产出质量。
- **复诵核对闭环**：编排器对 worktree NOTES.md 做确定性预检（checkRecitation：复诵关键词 / 目标文本重叠双探针），把 NOTES 复诵段（截 800 字）与预检事实句一并注入审查 prompt——复诵协议闭环到核对（只有 prompt 承诺不够）；复诵与实际改动矛盾计阻塞项，预检只产事实不直接阻断（判罚权在 reviewer）。
- **契约行补问**：引擎正常（exitCode=0）但输出缺 REVIEW_SUMMARY 汇总行时，先向 reviewer 补问一次（输入只有上轮输出截尾，不重放 diff），补出即恢复正常链路；仍缺才按 blockers=1 保守判罚——不白烧一轮 worker 返工。补问写决策留底（`meta.retry: "contract_line"`）+ `review_verdict_retry` 事件（resolved 布尔）。
- 返回三级结果（阻塞/建议/提示）→ 写 `review_verdict` 事件。
- 有阻塞项 → 把审查意见作为 fixup prompt 喂回 worker（**受独立的 `max_review_iterations` 约束**，与调试子循环分开计数）；无阻塞 → 进合并闸门（§6.8）。

### 6.8 合并闸门（人工 L3 + 分级自动合并）

**闸门交互**（awaiting-human 任务的裁决面）：

```
════════ 任务 fix-presets-merge 待审 ════════
改动: 3 个文件 (+86/-12)        耗时: 31 分钟
测试: ✅ 全绿 (2 轮调试迭代)     预算: 104k / 500k tokens
门禁: 6/6 通过                  审查: 0 阻塞 / 2 建议 / 1 提示
⚠ src/cli.ts 被触及（标红）

[a] 批准合并   [v] 查看 diff   [r] 驳回(附原因)   [b] 打回重试   [q] 搁置
```

- `a` → 调 `feature-branch.mjs finish <task-id>`（自动 rebase + testCmd + --no-ff 合并 + 清理）
- `r` → 原因写任务卡，转 `failed/`，保留 worktree 供人查看现场
- `b` → 补充指令写任务卡，回 `running/`，worker 续做
- 非交互式等价命令：`approve <task-id>` / `reject <task-id> --reason "..."`（供脚本/其他工具调用）

**分级自动合并**：低风险场景的人工闸门是过度摩擦（Copilot 分级思想）。`gate` 字段 = 本任务允许自动合并的级别上限（**L0 | L1 | L3**，缺省 L3=全人工最保守；L2 核心路径永人工，声明直接拒绝并提示）。审查 0 阻塞后按 `classifyChange` 实际分级裁决：

- **自动合并**（四个条件缺一不可）：任务卡 gate 显式为 L0/L1（L3 永不自动）；实际分级 ∈ L0/L1 且不超 gate 上限；scope_purity 无越界；漂移保险丝未触发（§6.12）。动作 = 直接走 feature-branch finish（与人工 approve 完全同一条合并路径，含最终 testCmd 验证），事件写 `auto_merge`（含分级/gate/迭代数）与 `auto_merge_decision`，`merged` 事件带 `auto: true`——质量漂移统计按此回溯自动合并的回溯失败率。
- **回人工**：gate=L3；或实际分级 L2/L3；或改动超出 files_hint（范围失控不静默合并）；或 finish 失败（任务留 awaiting-human 等人工 approve）。
- **元文件豁免**：NOTES.md（finish 自动从分支移除）不计入改动面——worker `git add -A` 会把它带进提交，否则分级与范围检查永远失真。
- 闸门摘要显示改动分级（`printGateSummary` 输出 `classifyChange` 结果并写 `change_classification` 事件）。

### 6.9 熔断与预算

| 维度 | 机制 | 超限动作 |
|---|---|---|
| 轮次 | 后端 `--max-turns`（任务卡 budget.max_turns 传入） | kill worker → blocked |
| token | onEvent 解析 usage 累计（可计费口径，见下），超 max_tokens | kill → blocked |
| wall-clock | orchestrator 定时器 max_wall_minutes | kill → blocked |
| 调试迭代 | debug_iteration 计数 > max_test_iterations | blocked |
| 审查返工 | review_iteration 计数 > max_review_iterations | blocked |
| 权限墙 | worker 会话权限拒绝满 2 次 | 判 stuck → blocked |

所有熔断写 `circuit_breaker` 事件，任务卡转 `blocked/` 并附原因，**永不静默重试烧钱**。

**token 口径（双轨）**：stream-json 的 usage 含 `input_tokens` / `cache_read_input_tokens` / `cache_creation_input_tokens` / `output_tokens`（anthropic 语义：三输入字段不相交，总输入 = 前三者之和）。**旧口径** `tokensIn` = 前三者之和 + `tokensOut`，字段与历史事件兼容、继续落盘（stats / 交接油量回落路径仍用）。**可计费口径** `billable` = (tokensIn − 缓存读) + `tokensOut`：max_tokens 熔断与低油量告警改用它——网关缓存读占大头，旧口径下预算虚胖（熔断形同虚设）；缓存写与输出是真实成本、保留在 billable 内。`budget_snapshot` 事件另发 `tokens_billable` 与 `tokens_cache_read`（缓存读单列观测）；旧事件无拆分字段时 billable 退化为旧口径（熔断不放松也不误伤）。`budgetProfiles.max_tokens` 的语义为可计费口径。Budget 会话级记账（committed + sessionMax）修跨 fixup 会话的漏计。

**运行中 usage 依赖上游回传（实测结论）**：第三方上游（经网关代理的非官方模型）在 assistant 流式事件里 usage 可能为全 0，完整用量只在会话结束的 `result` 事件里。此时运行中的 token 熔断自然无法触发（0 永不超限），实际用量在结束时由 result 回填（`budget_snapshot` 最终值准确）。此降级属预期行为，wall-clock / 轮次 / 迭代上限三类熔断不受影响；对成本敏感的任务卡应同时收紧 `max_wall_minutes` 与 `max_turns`。

**kill 必须杀整棵进程树**：worker 的 claude CLI 在各平台都有子进程链（node → ripgrep → git …），`child_process.kill()` 只杀直接子进程会留下继续跑的孙进程。Unix 用 `detached: true` + `process.kill(-pid)`（负 pid 杀进程组）；Windows 用 `taskkill /pid <pid> /T /F`。实现收敛为一个 `killTree(pid)` 工具函数，熔断与孤儿清理共用。

### 6.10 策略守护

按 interceptor 模式把裁决收敛为**单一策略引擎 + 薄壳 hook**：

```
.agents/scripts/policy.mjs        ← 单一事实来源（零依赖，规则硬编码不可配置关闭）
├─ evaluateCommand(cmd)              Bash 红线：发布动作（git push/tag、npm publish）、
│                                    受保护端口（kill 8687/8890、启动监听、listen 绑定）
├─ evaluateBranchEdit(...)           分支保护：develop/main 直改拒绝；
│                                    worktree 内编辑与仓库外文件放行（路径归一化比对）
├─ classifyChange(files) → L0–L3    改动分级（自动合并的裁决原语）：
│                                    L3 发布流水线（.github/workflows、SEA 构建脚本）→ 永人工
│                                    L2 核心路径（src/cli.ts、gateway/server|state、config/store|
│                                       secrets、util/paths）+ package.json + 未识别文件（保守归高）
│                                    L1 普通 src；L0 纯文档/测试（全命中白名单才可 L0）
└─ audit(event) → .agents/policy/audit.jsonl   拦截与放行都留痕（append-only，
                                     运行态不入库；写失败静默——审计不能阻断裁决）

.agents/hooks/guard-develop.mjs   ← 薄壳：git 取证 + evaluateBranchEdit + audit
.agents/hooks/policy-worker.mjs   ← 薄壳：evaluateCommand + audit（worker/reviewer 共用）
```

- **reviewer 会话权限层强制只读**（不只靠 prompt 自觉）：`backend.spawn` 的 `readonly` 选项——见 §6.7。
- **matcher 双形态**：Windows 下 Bash+PowerShell 白名单/红线/hook matcher 一律双形态（§6.4）。
- **注册方式**：orchestrator 启动 worker 时生成临时 settings 文件（`hooks: { PreToolUse: [{ matcher: "Bash", hooks: [...] }] }`），经 `claude --settings <file>` **只注入 worker 会话**；绝不写进项目级 `.claude/settings.json`。现有 guard-develop hook（Edit/Write matcher）与 policy-worker（Bash matcher）覆盖面互补、互不替代。
- 测试防线：guard-develop 行为锁定测试（真实 git 仓库拓扑：develop 直改拦 / feature 放行 / worktree 放行 / escape hatch）、policy-worker 端到端（拦截+审计落盘）、policy 引擎单测。重构护栏行为逐字不变——它是所有会话（含人工）的分支保护，回归代价最高。

### 6.11 调度与并行

**队列自动调度**：

- **`run --next`**：取 pending 中优先级最高的任务启动闭环（high > normal > low；同优先级按 created_at 升序先到先跑）。
- **`drain [--max N] [--workers N]`**：循环清空 pending 队列。每个任务用**子进程**跑（cmdRun 的熔断走 process.exit，同进程循环会整批退出；子进程隔离后单任务 blocked/failed 不阻塞后续——水密舱）。`--workers N` 并发调度：最多 N 个 run 子进程同时跑，每个任务独立 worktree / 独立会话 / 独立熔断。
- **死循环防护**：run 子进程正常时任务必离开 pending。并发下按**每任务独立计数**——同一任务被调度 2 次仍在 pending 即拉黑转 blocked/ 并通报（failed 事件留痕，人工 resume 前先修执行环境）。
- 解析失败的卡跳过不阻塞调度（留在 pending 等 `status` 可见、人工修复）。
- **结束条件**：无活跃子进程 且 无可调度任务；`--max` 限制总启动数。
- **引擎预检**：drain 启动前预检后端可用性，不可用拒绝启动——杜绝逐卡烧成 blocked。

**并行互斥（分道通航，双层）**：

- **外层——按文件归属分区**（AGENTS.md「派发并行任务按文件归属分区」约定的自动化）：新任务与任一在跑任务的 files_hint 经 `hintsOverlap`（policy.mjs）判定相交则跳过、等占位释放再试。判定保守优先：提取 glob 的固定前缀段（`docs/**` → docs，`src/cli.ts` → src，首段即通配的裸 `**` → 完全通配），前缀不同才可并行——`docs/**` 与 `test/**` 可并行，`src/cli.ts` 与 `src/gateway/x.ts` 保守串行。
- **内层——任务级互斥锁**（task-lock.mjs）：调度器锁只防"调度器双开"，防不住手动 `run <id>` 撞上在跑的 drain——任务锁（`.agents/orchestrator/.run-<task-id>.lock`，记 pid）在 cmdRun 入口、worker spawn 之前持有：同任务后来者拿到明确报错退出（而不是悄悄杀掉前者——旧接管语义在 worker_spawned 事件落盘前有杀不掉的窄窗口，锁让该窗口从根上消失）。持锁进程死亡 = 陈锁自动接管，崩溃恢复语义不变（cleanupOrphanWorker 只在接管后才会遇到活孤儿）；闭环落位（merged/awaiting-human/blocked/failed）即释放；abandon 在闭环存活时拒绝（防误杀）。
- 质量保险丝（§6.12）与本节正交：降级只影响合并闸门，不影响并行调度。

### 6.12 巡检信号源与质量漂移保险丝

**巡检信号源**：`scan [--todo] [--audit] [--tests] [--dry-run]`（默认 --todo --audit；--tests 要跑整个测试套件故显式开启）扫描三类信号、消毒后生成任务卡进 pending/：

| 信号 | 生成卡 | 去重 id |
|---|---|---|
| TODO/FIXME 注释（src/ 下代码文件） | 每条一张，type=refactor priority=low | `scan-todo-<sha8(文件+内容)>` |
| npm audit 漏洞 | 汇总一张，type=deps priority=high | `scan-audit-<sha8(漏洞集)>`（无网/无 lock 容错跳过并提示） |
| 测试套件失败 | 一张，type=bugfix priority=high | `scan-testfail-<日期>`（同日天然去重） |

**注入面三重防线**：
1. **内容消毒**：`sanitize()` 把扫描到的文本压平——控制字符删除、空白折叠、命令/模板结构字符（反引号、`<>|;${}`）替换、截断 200 字符——信号内容进任务卡（→ worker prompt）时无法携带指令结构；
2. **巡检不自动 run**：scan 只生成卡（created_by: scanner），是否 run 由人工决定——注入内容最多躺在 pending 里，永远到不了 worker（例外：`scan --run` 只对机器信号卡（audit/testfail）立即发起闭环，合并仍人工——自动 run 的风险被分级闸门兜住；TODO 类语义信号易误判，仍留人工）；
3. **gate 缺省 L3**：巡检卡一律走人工合并闸门。

卡 id 按内容哈希稳定：信号不变 → 重复巡检自然去重；信号变化（新增/修改）→ 新卡。nightly 定时由外部 cron 调用，orchestrator 不引入常驻进程。

**质量漂移保险丝**：自动合并放开后必须回答"自动合并的成果靠不靠谱"。`drift [--clear]` 命令：

- **统计**：扫全部 merged/ 任务的 `merged` 事件（区分 auto/human），对自动合并逐一检测 **revert 信号**——`git log develop --grep "^Revert .*feature/<id>'"`（git --grep 是 BRE 正则，`.+` 是字面加号，必须用 `.*`）。被 revert 即计一次回溯失败。
- **自动降级**：回溯失败率严格大于阈值 **20%（硬编码，与熔断同哲学：不可配置关闭）** 时写降级标记 `.agents/orchestrator/degraded.json`（含降级原因、失败任务清单、时间）——**期间 run 的自动合并全部回人工**（gate=L0/L1 也不放行），awaiting_human 事件 reason=drift_degraded。标记幂等：不覆盖首次降级时间。
- **人工恢复**：`drift --clear` 删除标记。降级是保险丝，拔保险丝不该是自动的——恢复必须人工确认漂移根因已消除。
- 样本不足（autoTotal=0）时只报告不裁决。

### 6.13 成本对账（双账本）

worker 的 token 用量有两本账，对账命令 `reconcile [task-id]`（无参 = 全部 merged 任务按分歧降序）：

| 账本 | 来源 | 特性 |
|---|---|---|
| 自报账 | 任务 events.jsonl 的 budget_snapshot | stream-json result 回填；第三方上游流式 usage 全 0 时运行中不可信（§6.9） |
| 实测账 | 网关请求日志 gateway-*.jsonl 的 usage 字段 | 网关转发层旁路解析（产品功能 src/gateway/usage.ts），只看得到经网关转发的流量 |

**网关侧**：`createUsageTap(contentType)` Transform 流——字节**原样透传**（转发行为零改变），旁路尽力而为解析：anthropic SSE（message_start 的输入/缓存 + message_delta 的输出累计）、openai/responses SSE chunk usage、非流式 JSON 顶层 usage（≤1MB 缓冲，两种字段名口径都认）。解析失败静默，永不影响转发。LogEntry 的 usage 另含 `billable_tokens`（可计费口径 = 总输入 − 缓存读 + 输出）。

**orchestrator 侧**：把任务事件时间窗（worker_spawned 首条 → merged/failed 尾条，1 分钟容差）投影到网关日志，跨日期文件自动合并，只计成功转发。分歧率 = |自报 − 实测| / max(两账)；**网关零流量时标 ⚠（worker 直连上游，对账无意义）**。口径纪律：两本账都有可计费字段时分歧率按 **billable 对 billable**（与 max_tokens 熔断同口径，缓存读不再摊薄分歧）；任一侧缺新字段整体回落旧口径并在输出标注「旧口径」，绝不混口径相减。燃油账（美元）始终总口径。命令只读报告，不做任何动作。

### 6.14 Planner（意图 → 任务卡）

任务卡的大部分字段（目标重述/验收标准/files_hint/type/priority）本质是**从意图 + 仓库现状推导的执行计划**，不是原始意图。`intent "<一句话描述>" [--draft] [--backend mock]` 补上 Planner 环节：

- **readonly planner 会话**（与 reviewer 同一权限层：Read/Glob/Grep 白名单，fail-closed）在主仓库探索现状，把意图编译成完整任务卡（`modeldock-card` 契约块）；
- **校验重试**：输出经 loadCard 校验，失败把可操作报错喂回 Planner 重试（最多 3 次，与调试子循环同构）；id 冲突同样喂回，绝不静默覆盖；
- **gate 强制 L3**：Planner 卡一律人工合并闸门（文本级覆写，不浪费重试轮）——人的参与收敛为「给意图 + L2/L3 审核」；
- **双路径**：默认信任路径直接 submit 进 pending；`--draft` 只落 `.agents/orchestrator/drafts/`（不入库）供人工审阅后 submit；
- **注入面纵深**：意图文本 sanitize 消毒 → Planner 只读（无法落盘）→ 产出过 schema 校验 → worker 执行 → 独立审查（含验收标准完备性检查，§6.7）→ 人工闸门。

**不做**：每日预算计数器（per-task budget + drift 已兜底，实际用起来再评估）；Planner 拆分多卡（进阶，待单卡路径跑顺）。

### 6.15 目录布局与 CLI 面

```
.agents/
  orchestrator/
    queue/{pending,running,reviewing,awaiting-human,merged,failed,blocked}/   # 7 个状态目录
    logs/                              # <task-id>/events.jsonl
    drafts/                            # Planner --draft 产出（不入库）
  scripts/
    orchestrator.mjs                   # CLI 入口 + 状态机 + 熔断
    orchestrator/
      queue.mjs                        # 任务卡解析、状态迁移、frontmatter 解析（手写简易 YAML 子集解析，零依赖）
      events.mjs                       # jsonl append + seq 管理
      prompt.mjs                       # worker / reviewer / fixup prompt 组装
      gates.mjs                        # 静态门禁
      task-lock.mjs                    # 任务级互斥锁
      backends/types.mjs               # 后端接口 JSDoc 定义
      backends/claude-headless.mjs
      backends/mock.mjs
  hooks/policy-worker.mjs              # worker 会话内命令拦截（§6.10）
  workflows/orchestrator.md            # 操作手册入口（场景 runbook 见 orch-*.md）
test/orchestrator/                     # 单测 + 集成测试（文件名必须 .test.ts）
```

**运行态不入库**（`.gitignore`）：`.agents/orchestrator/queue/` 与 `.agents/orchestrator/logs/` 是本机运行产物，整体 ignore；任务与合并历史以 git log + events.jsonl 本地留存为准。7 个状态目录由 `ensureQueue()` 在 submit/run/status 前幂等创建。

CLI 面（`node .agents/scripts/orchestrator.mjs <cmd>`，完整子命令速查见 `.agents/reference/orch-commands.md`）：

| 命令 | 作用 |
|---|---|
| `submit <card.md>` | 校验任务卡 schema → 移入 pending/ |
| `run <task-id> | --next` | 启动单任务闭环 / 取最高优先级任务 |
| `drain [--max N] [--workers N]` | 循环清空队列（子进程隔离，可并发） |
| `status [task-id]` | 看队列全貌 / 单任务事件时间线 |
| `resume <task-id>` | 崩溃任务带恢复上下文重启 worker |
| `approve <task-id>` / `reject <task-id> --reason "..."` | 非交互式闸门操作 |
| `scan [--todo] [--audit] [--tests] [--dry-run] [--run]` | 巡检信号源 |
| `intent "<描述>" [--draft] [--backend mock]` | Planner 意图编译 |
| `drift [--clear]` | 质量漂移统计 / 恢复 |
| `reconcile [task-id]` | 自报账 vs 网关实测账对账 |
| `stats` / `follow <task-id>` | 观测汇总 / 跟踪任务时间线 |
| `release-propose` | 发版提案（盘点 + semver 定档 + CHANGELOG 草稿） |
| `sail` / `watch` / `nightly` / `schedule` | 自主航行族（见 orch-autonomy.md） |

---

## 7. 验收标准

1. 产品测试套件全绿（`npm test`，含 test/orchestrator/ 的单测与集成测试）。
2. mock 后端端到端集成测试通过：submit → run → gates → review(mock) → awaiting-human → approve → merged，秒级完成、零外部调用。
3. 真实后端冒烟任务成功合并一次（人工监督）。
4. 静态门禁正反例齐备（port_scan 命中 `listen(8687)` 必须 failed 等）。
5. 操作手册（orchestrator.md 入口 + orch-*.md runbook）与 AGENTS.md 索引一致。

---

## 8. 红线与边界

实现与运行都必须遵守（与 AGENTS.md「判定边界」一致并扩展）：

1. **8687 / 8890 永远人工**：orchestrator 及其 worker 不得监听、停止、重启这两个端口的任何进程；`policy-worker.mjs` 硬编码拦截。
2. **发布人工授权制**：默认拦截 worker 执行 `git push`（任何远程）、`git tag`；仅当用户明确授权发版（release.md「代理发布」），以 `MODELRDOCK_ALLOW_RELEASE=1` 前缀放行白名单形态；`npm publish` 与白名单外形态永远禁止。合并动作只发生在闸门 approve（人工或分级自动）之后。
3. **不破坏 feature-branch 工作流**：orchestrator 复用 `feature-branch.mjs`，不另起分支体系；worker 的所有编辑限定在 worktree 内。
4. **零第三方依赖**：`.agents/scripts/**` 纯 Node 标准库（frontmatter 手写简易解析，不引 yaml 包）。
5. **熔断不可关闭**：budget 字段必须有默认值；任务卡显式调大可以，删除字段不允许。
6. **测试结束清理进程**：orchestrator 测试拉起的所有子进程必须在 `finally` 中 kill 并核实端口释放（遵循 AGENTS.md 硬规则 4）。

---

## 9. 关键默认值

| # | 参数 | 默认值 | 理由 |
|---|---|---|---|
| 1 | worker 默认后端 | claude-headless（mock 仅测试用） | 项目已有 Claude Code hook 体系，开箱即用；权限策略固定为 §6.4 的 `acceptEdits + allowedTools 白名单 + policy hook 兜底`，禁止 `--dangerously-skip-permissions` |
| 2 | 预算默认值 | max_turns 50 / max_tokens 500000（可计费口径）/ max_wall_minutes 60 / max_test_iterations 5 / max_review_iterations 3 | 任务卡可逐任务覆盖；缺失字段回落默认值，不允许无预算运行；budgetProfiles 可按引擎校准 |
| 3 | 审查后端 | 同后端新会话（Phase 1 从简） | 交叉模型审查列为演进候选（异构互审，原则 1） |
| 4 | 漂移降级阈值 | 回溯失败率 > 20% 硬编码 | 与熔断同哲学：保险丝不可配置关闭 |
| 5 | 引擎授权面 | headless 舰队统一 claude-headless；zcode 为显式点名项 | zcode CLI 结构性限制（见历史定案）；桌面交互照旧 |

---

## 10. 规划中

暂缓与规划项的**单一出处**是 `.agents/docs/TODOLists.md`（每项四要素：功能 / 暂缓理由 / 重启条件 / 专家结论），本文不复制条目。当前开放面概览：

- **值得做但排后**：multi-dim sail 集成（feature 提案自动拆维度）。
- **观望 / 不做**：browse 字段改名、飞书卡片双向批示、zsearch 用量计数、codex researcher 联网检索。
- **待用户动作**：codex 激活、push 远程时机。

重启某项时把 TODOLists 中该项的「重启条件」改为「已重启（日期+卡片）」，完成后移入「已销账」；本文随之把对应能力收编进 §6。

---

## 11. 附录：参考资料

- Ralph Wiggum 技术：Geoffrey Huntley 提出；Vercel Labs `ralph-loop-agent`；Addy Osmani《Self-Improving Coding Agents》；Ralph Orchestrator（安全/监控/成本控制层）
- Gas Town：Steve Yegge 开源的多 agent 编排器（worktree 隔离、Beads 持久记忆、角色层级、MEOW 工作单元）
- GitHub Copilot Coding Agent：Issue → draft PR → 人类 PR 审查合并；每会话独立 worktree
- OpenHands：事件溯源架构（无状态 agent + append-only 事件日志 + action→observation 循环 + hook 体系）
- 设计依据（审查形态）：独立 critic 性价比最优 / Task-first review（arXiv 2610.34577）；Anthropic 多 agent 工程复盘（复述协议须闭环到核对）
- 仓内文档：`AGENTS.md`、`.agents/workflows/feature-branch.md`、`.agents/workflows/code-review.md`、`.agents/workflows/worktree-rescue.md`、`.agents/conventions/docs-writing.md`、`.agents/docs/research-verdict.md`
