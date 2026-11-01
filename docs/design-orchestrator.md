# Orchestrator（自治 Agent 编排服务）设计说明书

> 体系名 **Dockmaster（坞长）**——ModelDock 的 Dock，管坞的人就是 dockmaster；命令行与代码内命名保持 orchestrator 不变，Dockmaster 只用于文档与心智模型（命名理由见 `.agents/workflows/orchestrator.md` 开头）。

| 文档属性 | 内容 |
|---|---|
| 当前版本 | **v1.0 · 发布基线（Phase 1 全量交付 + Planner 环节）** |
| 状态 | Phase 2 推进中 |
| 日期 | 2026-10-11 |
| 读者 | 接手实现的 agent / 评审人 |

> **给接手 agent 的一句话任务说明**：
> 本文档是自包含的交接设计。目标：为 ModelDock 实现 `.agents/scripts/orchestrator.mjs` —— 一个"任务卡进、合并出"的单任务自治闭环（Phase 1）。实现前必读仓库根目录 `AGENTS.md`（端口红线、feature-branch 工作流、工程约定）和本文档第 7 章（Phase 1 详细设计）。实现过程本身必须走 feature-branch 工作流。

## 目录

1. [背景与目标](#1-背景与目标)
2. [业界调研结论](#2-业界调研结论)
3. [现有基础设施盘点](#3-现有基础设施盘点)
4. [总体架构与分阶段路线](#4-总体架构与分阶段路线)
5. [Phase 1 详细设计](#5-phase-1-详细设计)
6. [实施计划（任务分解）](#6-实施计划任务分解)
7. [测试计划与验收标准](#7-测试计划与验收标准)
8. [红线与边界](#8-红线与边界)
9. [开放决策点](#9-开放决策点)
10. [后续路线（Phase 2/3 展望）](#10-后续路线phase-23-展望)
11. [附录：参考资料](#11-附录参考资料)

---

## 1. 背景与目标

ModelDock 已具备成熟的多 agent 并行开发约定（feature-branch 工作流 + worktree 隔离 + NOTES.md 交接 + 11 个领域 playbook，含新增的 orchestrator）。下一步目标是建立一个**自治编排服务**，让一个 agent 系统能够：

> 根据项目特点自动分配任务 → 自动修改 → 自动优化 → 自动审查 → 自动调试 BUG → 迭代，直到产出可合并的成果。

核心约束（与整个项目一致）：

- **纯 Node 标准库、零第三方依赖**（与 `feature-branch.mjs` 同技术栈；orchestrator 属于 `.agents/` 工具链，不进 src/、不进 SEA 包）。
- **8687 生产实例永远人工；发布动作人工授权制**——端口边界硬编码不可关闭；发布（push/tag）默认拦截，仅用户明确授权发版后按 release.md「代理发布」以 `MODELRDOCK_ALLOW_RELEASE=1` 前缀放行白名单形态。
- 人类在 Phase 1 保留最终合并决定权。

## 2. 业界调研结论

调研了四个代表性实践与一组安全共识做法，提炼出可复用的架构精髓。

### 2.1 Ralph Wiggum 循环（Geoffrey Huntley 提出，社区广泛采用）

- 核心理念：**"Ralph 就是一个 Bash 循环"**——把开发拆成小任务，逐条喂给 agent，每轮带验证命令（跑测试、对比输出），不靠单次完美、靠持续迭代收敛。
- 衍生项目 Ralph Orchestrator 在循环外加了安全、监控、成本控制层。
- **对本设计的启示**：调试子循环（worker 报告完成后由编排器亲自跑测试，失败则喂回修复）比"agent 自报完成"可靠。

### 2.2 Gas Town（Steve Yegge，多 agent "暗工厂"）

- 协调 20-30 个并行 Claude Code 实例，四个关键机制：
  - **worktree 隔离**——每个 agent 独立工作区；
  - **Beads 持久记忆**——会话崩溃后下一个 agent 从断点续起；
  - **角色层级**——Mayor 派发、worker 执行、Witness 监督；
  - **MEOW 工作单元**——工作流表达为分子式任务链。
- **对本设计的启示**：worktree 隔离和持久交接是自治的两大地基——ModelDock 两者已有（feature-branch.mjs + NOTES.md）。

### 2.3 GitHub Copilot Coding Agent（大厂产品化路径）

- 流程：Issue 分配 → agent 开 draft PR → 边做边推 commit → **人类在 PR 环节审查才合并**。
- 每个会话跑在独立 git worktree（与 ModelDock 的 feature-branch 工作流同一隔离原语）。
- **对本设计的启示**：人类闸门设在合并点是最小信任面；按改动爆炸半径分级可以进一步放松低风险场景。

### 2.4 OpenHands（开源框架工程化样板）

- **事件溯源架构**：无状态 agent + append-only 事件日志 + action→observation 循环；技能、子 agent、安全分析器都是挂在循环上的 hook；执行环境 Docker 沙箱隔离。
- **对本设计的启示**：`events.jsonl`（append-only）同时解决崩溃恢复、成本核算、质量回溯三个问题。

### 2.5 安全控制共识

- **策略守护（interceptor）模式**：agent 不能直接执行敏感动作，必须发出意图，由本地策略层对照硬编码规则裁决。
- **成本熔断**：max_turns 防死循环、per-task token/美元预算、迭代次数上限、wall-clock 超时。
- **分支隔离是底线**：永远不让 agent 直接提交主干。

### 2.6 共同骨架（六要素）

```
外层编排循环 → worktree 隔离 → 任务队列/持久记忆 → 验证门禁 → 人类闸门 → 成本熔断
```

## 3. 现有基础设施盘点

| 业界机制 | ModelDock 现成对应物 | 差距 |
|---|---|---|
| worktree 隔离 | `.agents/scripts/feature-branch.mjs`（start/finish/list） | ✅ 已就绪 |
| 持久记忆 / 断点续传 | worktree 内 `NOTES.md` 交接约定 | ✅ 已就绪 |
| MEOW 分子工作单元 | `.agents/workflows/*.md` 11 个 playbook（orchestrator.md 已随 Phase 1 落地） | ✅ 已就绪 |
| 策略守护 | `.agents/scripts/policy.mjs` 集中策略引擎 + guard-develop / policy-worker 薄壳 hook（完整版，Phase 2 第一块已交付，见 10.1） | ✅ 已就绪 |
| 外层编排循环 | `.agents/scripts/orchestrator.mjs`（Phase 1 已验收：真实后端冒烟通过） | ✅ 已就绪 |
| 任务队列 | 7 状态目录文件系统队列 + `run --next` / `drain` 自动调度（见 10.3） | ✅ 已就绪 |
| 事件日志 | `.agents/orchestrator/logs/<task-id>/events.jsonl`（append-only，Phase 1 交付） | ✅ 已就绪 |
| 分级人类闸门 | L3 人工闸门 + L0/L1 自动合并（gate 上限声明 + 分级裁决，见 10.2） | ✅ 已就绪 |
| 成本熔断 | 轮次 / token / wall-clock / 双迭代上限（Phase 1 交付；第三方上游流式 usage 全 0 时 token 熔断降级，见 5.10） | ✅ 已就绪 |

**方案核心：不自造轮子，用薄编排层把已有原语串成闭环。**

## 4. 总体架构与分阶段路线

### 4.1 目标架构（五层自治闭环，最终形态）

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

### 4.2 分阶段路线

| 阶段 | 内容 | 自主权 |
|---|---|---|
| **Phase 1（本文档范围）** | 单任务闭环：人工 submit 任务卡 → orchestrator 自动跑 worker→门禁→审查 → **人工确认合并**；事件日志 + 熔断体系先上 | 只有 L3 闸门 |
| Phase 2 | 任务队列自动调度；L0/L1 自动合并；策略守护完整版；nightly 巡检自动生成任务卡（待批准） | L0/L1 放开 |
| Phase 3 | 多 worker 并行（按文件归属分区）；质量漂移监控，自动合并失败率超阈值自动降级全人工 | "暗工厂" |

## 5. Phase 1 详细设计

### 5.1 范围

**做**：`orchestrator.mjs run <task-id>` 单任务自动闭环（prepare → run → gates → review → 人工闸门 → finish 合并）；任务卡 schema；events.jsonl；熔断体系；静态门禁；LLM 独立审查；崩溃恢复（resume/abandon）。

**不做**：任务队列自动调度（一次只跑一个任务）；L0/L1 自动合并；自动巡检信号源；多 worker 并行。

### 5.2 任务卡 Schema

位置：`.agents/orchestrator/queue/pending/<task-id>.md`。Markdown + YAML frontmatter，**人可直接手写**；也是 Phase 2 自动生成的目标格式。

```markdown
---
id: fix-presets-merge
type: bugfix                  # bugfix | feature | docs | deps | refactor
priority: normal              # low | normal | high
created_at: 2026-10-01T10:00:00+08:00
created_by: human             # human | scanner（Phase 2）
budget:
  max_turns: 50               # worker agent 最大轮次（防死循环）
  max_tokens: 500000          # 单任务 token 预算上限（含缓存读，见 5.10 口径）
  max_wall_minutes: 60        # wall-clock 超时（分钟）
  max_test_iterations: 5      # 调试子循环上限（测试失败→修→重跑）
  max_review_iterations: 3    # 审查修复子循环上限（审查阻塞→修→重审；独立于调试计数）
files_hint:                   # 预期改动范围（glob），供门禁做纯度检查
  - src/presets/**
  - test/presets/**
workflows:                    # 注入 worker prompt 的 playbook 文件名（不含 .md）
  - feature-branch
  - docs-sync
gate: L3                      # Phase 1 固定 L3（人工确认合并）
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

**设计要点**：`验收标准` 必须是可机器检查的断言（测试命令、文件存在性、grep 模式）——orchestrator 用它做完成判定辅助，worker 用它做自我验证靶子。

### 5.3 队列状态机（文件系统实现）

```
pending/ ──run──► running/ ──worker完成──► reviewing/ ──审查通过──► awaiting-human/
                  │  ▲                        │                        │
                  │  └── 审查有阻塞，意见喂回   │ 门禁失败(超迭代上限)      │ approve → finish → merged/
                  │      worker（回边，受      │ 红线门禁（port/native）  │ reject（附原因）→ failed/
                  │      max_review_          ▼                        │ retry（附补充指令）→ running/
                  │      iterations 约束）  blocked/（等人工决策）◄──────┘（b 打回重试）
```

- 状态迁移 = `fs.rename` 任务卡在目录间移动（原子、无锁、崩溃安全）。
- 目录全集：`pending/ running/ reviewing/ awaiting-human/ merged/ failed/ blocked/`。
- **调试子循环与审查修复子循环计数独立**：测试失败重跑计 `debug_iteration`（上限 `max_test_iterations`），审查阻塞返工计 `review_iteration`（上限 `max_review_iterations`）——两者语义不同，混用一个计数会把"代码没写对"和"审查标准没满足"搅在一起，且熔断原因无法区分。
- **崩溃恢复（两个方向都要覆盖）**：
  - *worker 死了*（编排器在、worker PID 不存活）：读 `events.jsonl` + worktree `NOTES.md` 生成恢复摘要，提示操作者选择 `resume`（新 worker 带恢复上下文续做）或 `abandon`（按 worktree-rescue 流程清理，不自动删 worktree）。
  - *编排器死了、worker 还活着*（孤儿 worker）：孤儿会继续烧预算——`resume`/`run` 启动时先按 `events.jsonl` 里 `worker_spawned` 记录的 PID 检查进程是否仍存活，存活则**先杀掉整棵进程树**（见 5.10 跨平台 kill）再走恢复流程，绝不带着旧 worker 并行开新 worker。

### 5.4 events.jsonl 事件日志

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
{"ts":"...","seq":13,"type":"failed","reason":"..."}
{"ts":"...","seq":14,"type":"blocked","reason":"..."}
```

- 事件类型（Phase 1 共 14 种）：`task_submitted / worktree_ready / worker_spawned / worker_turn / command / debug_iteration / budget_snapshot / circuit_breaker / gate_result / review_verdict / human_gate / merged / failed / blocked`。
- `seq` 单调递增；`ts` 用 ISO8601 带时区。
- **用途**：崩溃恢复（重建上下文）、成本核算、Phase 3 质量漂移统计。

### 5.5 Worker 执行：Prompt 组装与输出契约

#### Prompt 组装（orchestrator 自动生成到临时文件，作为 worker 的输入）

```
[系统层] AGENTS.md 全文（端口红线、工程约定、判定边界）
[流程层] 任务卡 workflows 字段命中的 playbook 全文（.agents/workflows/<name>.md）
[任务层] 任务卡的 目标 / 验收标准 / 红线 / 背景
[环境层] worktree 绝对路径 + "所有编辑必须使用此路径下的绝对路径，禁止改主目录"
[契约层] 输出契约（见下）
```

#### 输出契约（worker 结束前必须产出）

要求 worker 最后输出一个 fenced block，orchestrator 用正则解析：

````
```modeldock-result
status: done | stuck
summary: 一句话说明
files_changed: ["src/presets/data.ts", "test/presets/data.test.ts"]
tests: pass | fail
notes_updated: true
```
````

- `stuck` → 任务转 `blocked/`（NOTES.md 已留现场），等人工决策或换模型重试。
- **自报不可信**：无论 worker 报什么，orchestrator 都亲自跑静态门禁（见 5.7）。

#### Worker 后端抽象（可插拔）

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

Phase 1 交付两个后端：

- **`claude-headless`**：包装 `claude -p --output-format stream-json --max-turns N`（项目已有 `.claude/settings.json` hook 体系，worker 会话自动继承 guard-develop 保护）。解析 stream-json 事件流转写 `worker_turn` / `budget_snapshot`。
- **`mock`**：假后端——在 worktree 写固定文件、输出固定契约块。用于 orchestrator 自身集成测试（不烧钱、秒级）。

#### Worker 权限模式（实现关键，headless 必配）

headless `claude -p` **没有 TTY，无法响应交互式权限确认**：默认权限模式下 worker 的第一次 Edit 就会被自动拒绝，任务烧完 `max_turns` 零产出；反之若用 `--dangerously-skip-permissions` 全量放行，则把任意命令执行面暴露给自治进程。因此 `claude-headless` 后端必须按以下组合启动 worker（缺一不可）：

```
claude -p \
  --output-format stream-json \
  --max-turns <budget.max_turns> \
  --permission-mode acceptEdits \
  --allowedTools Edit Write Read Glob Grep "Bash(npm test:*)" "Bash(npm run build)" \
               "Bash(git add:*)" "Bash(git commit:*)" "Bash(git diff:*)" "Bash(git status)" \
               "Bash(git log:*)" "Bash(git -C .agents/worktrees/*:*)" \
  --disallowedTools "Bash(git push:*)" "Bash(git tag:*)" "Bash(npm publish:*)" \
  --settings <orchestrator 生成的 worker 专属 settings 文件>   # 注入 policy-worker.mjs（见 5.11）
```

- `acceptEdits` 只自动放行文件编辑类工具；命令执行走 `--allowedTools` 白名单按前缀放行，未列出的 Bash 命令在 headless 下被自动拒绝（fail-closed）。
- 白名单是**常规约束**，policy-worker hook 是**红线兜底**（白名单配错漏放 push/tag 时仍有硬拦截），两层缺一不可。
- `--max-turns` 的 turn = 一次完整的 assistant 消息循环（含其全部工具调用），与 `budget.max_turns` 同语义，直接透传。
- worker 专属 settings 只经 `--settings` 注入，**不写入项目级 `.claude/settings.json`**——那会连带约束人工交互会话（agent 推 feature 分支是日常操作，不该被全局拦掉）。

### 5.6 调试子循环（自动调 BUG 的核心）

```
worker 报告 done
  → orchestrator 在 worktree 内跑 testCmd（.agents/workflow.json，本仓库为 npm test）
  → 失败？把失败输出截断（尾部 200 行）追加为 fixup prompt，在同一 worktree 重启 worker 续做
  → 记 debug_iteration 事件（计数独立于审查返工，见 5.3）
  → attempt > max_test_iterations → 熔断（circuit_breaker 事件）→ blocked/
```

`tsc_build` 门禁失败走同一个调试子循环、共用 `max_test_iterations` 计数（都是"产物不达标"）。

### 5.7 静态门禁（gates.mjs，合并前全部执行）

| 门禁 | 实现 | 失败后果 |
|---|---|---|
| `npm_test` | worktree 内跑 `workflow.json` 的 testCmd | 进调试子循环（5.6） |
| `tsc_build` | `npm run build` | 进调试子循环（与 npm_test 共用迭代计数） |
| `port_scan` | `git diff develop...HEAD` **只扫 `src/**` 的新增行**，匹配 listen/端口绑定模式（`listen(`、`--port`、`PORT =` 等）后接 8687/8890 | 直接 failed（红线不可调试） |
| `native_scan` | diff 触及 package.json 时，对新依赖检查 `.node`/`binding.gyp`/prebuilds | 直接 failed |
| `scope_purity` | 改动文件超出 `files_hint` 范围 | 警告注入审查 prompt，不阻塞 |
| `cli_entry` | diff 触及 `src/cli.ts` | 人工闸门标红高亮 |

> **port_scan 为什么限定 `src/**`**：本仓库的网关测试文件与 AGENTS.md 本来就大量合法提及 8687/8890（端口约定文档、测试断言），全仓扫描会误杀正常任务。红线门禁误杀的代价比漏报高——真要在测试里监听生产端口的改动也过不了 `npm test` 人工审查这一关；如需扩大范围，在实现里调白名单并同步本文档。

### 5.8 LLM 独立审查

- 静态门禁全过后，orchestrator 生成 `git diff develop...HEAD`，起**第二个 headless 会话**（全新上下文、只读），prompt 用 `.agents/workflows/code-review.md` 中已固化的模板。
- 返回三级结果（阻塞/建议/提示）→ 写 `review_verdict` 事件。
- 有阻塞项 → 把审查意见作为 fixup prompt 喂回 worker（**受独立的 `max_review_iterations` 约束**，与调试子循环分开计数）；无阻塞 → 进人工闸门。

### 5.9 人工闸门交互（Phase 1 唯一的 L3）

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

### 5.10 熔断体系（运行维度 + 迭代维度）

| 维度 | 机制 | 超限动作 |
|---|---|---|
| 轮次 | 后端 `--max-turns`（任务卡 budget.max_turns 传入） | kill worker → blocked |
| token | onEvent 解析 usage 累计，超 max_tokens | kill → blocked |
| wall-clock | orchestrator 定时器 max_wall_minutes | kill → blocked |
| 调试迭代 | debug_iteration 计数 > max_test_iterations | blocked |
| 审查返工 | review_iteration 计数 > max_review_iterations | blocked |

所有熔断写 `circuit_breaker` 事件，任务卡转 `blocked/` 并附原因，**永不静默重试烧钱**。

**token 口径**：stream-json 的 usage 含 `input_tokens` / `cache_read_input_tokens` / `cache_creation_input_tokens` / `output_tokens`。预算累计 = `tokensIn`（前三者之和，**缓存读计入**——长上下文任务靠缓存复用看着便宜，钱和上下文占用是真实发生的）+ `tokensOut`（output_tokens）。

**运行中 usage 依赖上游回传（实测结论，2026-10-01 真实冒烟）**：第三方上游（如经网关代理的非官方模型）在 assistant 流式事件里 usage 可能为全 0，完整用量只在会话结束的 `result` 事件里。此时运行中的 token 熔断自然无法触发（0 永不超限），实际用量在结束时由 result 回填（`budget_snapshot` 最终值准确）。此降级属预期行为，wall-clock / 轮次 / 迭代上限三类熔断不受影响；对成本敏感的任务卡应同时收紧 `max_wall_minutes` 与 `max_turns`。

**kill 必须杀整棵进程树**：worker 的 claude CLI 在各平台都有子进程链（node → ripgrep → git …），`child_process.kill()` 只杀直接子进程会留下继续跑的孙进程。Unix 用 `detached: true` + `process.kill(-pid)`（负 pid 杀进程组）；Windows 用 `taskkill /pid <pid> /T /F`。实现收敛为一个 `killTree(pid)` 工具函数，熔断与孤儿清理共用。

### 5.11 目录与文件清单（实现交付物）

```
.agents/
  orchestrator/
    queue/{pending,running,reviewing,awaiting-human,merged,failed,blocked}/   # 7 个状态目录（.gitkeep）
    logs/                              # <task-id>/events.jsonl
  scripts/
    orchestrator.mjs                   # CLI 入口 + 状态机 + 熔断
    orchestrator/
      queue.mjs                        # 任务卡解析、状态迁移、frontmatter 解析（手写简易 YAML 子集解析，零依赖）
      events.mjs                       # jsonl append + seq 管理
      prompt.mjs                       # worker / reviewer / fixup prompt 组装
      gates.mjs                        # 6 个静态门禁
      backends/types.mjs               # 后端接口 JSDoc 定义
      backends/claude-headless.mjs
      backends/mock.mjs
  hooks/policy-worker.mjs              # worker 会话内命令拦截：默认禁 git push/tag（授权 hatch 白名单除外）、禁 kill/stop 8687、禁 npm publish
  workflows/orchestrator.md            # 操作手册（playbook 家族第 11 个：如何写任务卡、如何看闸门、如何 resume）
test/orchestrator/                     # 单测 + 集成测试（文件名必须 .test.ts，见第 7 章）
```

**policy-worker.mjs 的注册方式**：orchestrator 启动 worker 时生成临时 settings 文件（`hooks: { PreToolUse: [{ matcher: "Bash", hooks: [...] }] }`，command 指向仓库内 `.agents/hooks/policy-worker.mjs`），经 `claude --settings <file>` **只注入 worker 会话**。绝不写进项目级 `.claude/settings.json`——那里对人工交互会话同样生效，会把日常的 agent 推分支操作也拦掉。现有 guard-develop hook（Edit/Write matcher）与 policy-worker（Bash matcher）覆盖面互补、互不替代。

**运行态不入库**（`.gitignore`）：`.agents/orchestrator/queue/` 与 `.agents/orchestrator/logs/` 是本机运行产物，整体 ignore；任务与合并历史以 git log + events.jsonl 本地留存为准，不把运行态提交进仓库。7 个状态目录由 `ensureQueue()` 在 submit/run/status 前幂等创建（无需预提交骨架，否则与整体 ignore 矛盾）。

CLI 面（`node .agents/scripts/orchestrator.mjs <cmd>`）：

| 命令 | 作用 |
|---|---|
| `submit <card.md>` | 校验任务卡 schema → 移入 pending/ |
| `run <task-id>` | 启动单任务闭环（prepare→run→gates→review→闸门） |
| `status [task-id]` | 看队列全貌 / 单任务事件时间线 |
| `resume <task-id>` | 崩溃任务带恢复上下文重启 worker |
| `approve <task-id>` / `reject <task-id> --reason "..."` | 非交互式闸门操作（供脚本/其他工具调用） |
| `logs <task-id>` | 打印 events.jsonl 时间线 |

## 6. 实施计划（任务分解）

按顺序执行，每步独立可验证。**实现过程本身必须走 feature-branch 工作流**（`node .agents/scripts/feature-branch.mjs start orchestrator-phase1`），所有编辑在 worktree 内。

| # | 任务 | 产出 | 验证 |
|---|---|---|---|
| 1 | 队列与事件基础设施 | `queue.mjs` + `events.mjs` + 目录结构 | 单测：状态迁移、frontmatter 解析、jsonl append |
| 2 | prompt 组装 | `prompt.mjs` | 单测：注入 AGENTS.md/playbook/任务卡内容齐全 |
| 3 | 后端抽象 + mock | `backends/types.mjs` + `mock.mjs` | 单测：mock 输出契约可被解析 |
| 4 | 静态门禁 | `gates.mjs` | 单测：6 个门禁各正反例 |
| 5 | orchestrator 状态机 + 熔断 | `orchestrator.mjs` | 集成测试：mock 后端跑通 submit→人工闸门（approve/reject/retry 三分支） |
| 6 | claude-headless 后端 | `backends/claude-headless.mjs` | 真实小任务冒烟（如"给 README 补一个标点"），人工监督 |
| 7 | 策略守护 hook | `hooks/policy-worker.mjs` + 注册 | 单测：禁推 tag/禁碰 8687 命令被拦 |
| 8 | 操作手册 playbook | `workflows/orchestrator.md` | 文档自查 |
| 9 | AGENTS.md 工作流索引更新 | 索引表加 orchestrator.md 一行 | 文档自查 |

## 7. 测试计划与验收标准

- **单测**（vitest，`MODELRDOCK_FAKE_HOME` 隔离，`finally` 中 restore——与现有测试套件同风格。**文件名必须 `.test.ts`**：vitest 配置只收 `test/**/*.test.ts`，写成 `.test.mjs` 会静默不被执行；被测的 `.mjs` 模块用 ESM import 即可）：
  - 队列：7 个状态目录迁移、非法迁移拒绝、frontmatter 边界（缺字段/预算默认值）
  - 事件：seq 单调递增、append 崩溃后无半行
  - 门禁：6 个门禁各正反例（如 port_scan 命中 `listen(8687)` 必须 failed）
  - prompt：任务卡字段全部出现在组装结果中
- **集成测试**：mock 后端端到端跑 submit → run → gates → review(mock) → awaiting-human → approve → merged，秒级完成、零外部调用。
- **真实后端冒烟**：一张最小任务卡人工监督跑一遍，验证 stream-json 解析与熔断计数。
- **验收标准（Phase 1 完成定义）**：
  1. `npm test` 全绿（含新增 orchestrator 测试）
  2. mock 后端端到端集成测试通过
  3. 真实后端冒烟任务成功合并一次
  4. `.agents/workflows/orchestrator.md` 手册可读、AGENTS.md 索引已更新

## 8. 红线与边界

实现与运行都必须遵守（与 AGENTS.md「判定边界」一致并扩展）：

1. **8687 / 8890 永远人工**：orchestrator 及其 worker 不得监听、停止、重启这两个端口的任何进程；`policy-worker.mjs` 硬编码拦截。
2. **发布人工授权制**：默认拦截 worker 执行 `git push`（任何远程）、`git tag`；仅当用户明确授权发版（release.md「代理发布」），以 `MODELRDOCK_ALLOW_RELEASE=1` 前缀放行白名单形态；`npm publish` 与白名单外形态永远禁止。Phase 1 的合并动作只发生在人工闸门 approve 之后。
3. **不破坏 feature-branch 工作流**：orchestrator 复用 `feature-branch.mjs`，不另起分支体系；worker 的所有编辑限定在 worktree 内。
4. **零第三方依赖**：`.agents/scripts/**` 纯 Node 标准库（frontmatter 手写简易解析，不引 yaml 包）。
5. **熔断不可关闭**：budget 字段必须有默认值；任务卡显式调大可以，删除字段不允许。
6. **测试结束清理进程**：orchestrator 测试拉起的所有子进程必须在 `finally` 中 kill 并核实端口释放（遵循 AGENTS.md 硬规则 4）。

## 9. 开放决策点

设计阶段遗留 3 个决策点，接手 agent **按推荐默认值实现**；若实现中发现推荐值有硬伤，停下来与负责人确认：

| # | 决策点 | 选项 | 推荐默认 |
|---|---|---|---|
| 1 | worker 默认后端 | A. claude-headless 直接作为默认 / B. 默认 mock，真后端后续接 | **A**（项目已有 Claude Code hook 体系，开箱即用；mock 仅用于测试）。权限策略固定为 5.5 的 `acceptEdits + allowedTools 白名单 + policy hook 兜底`，不可用 `--dangerously-skip-permissions` |
| 2 | 预算默认值 | max_turns / max_tokens / max_wall_minutes / max_test_iterations / max_review_iterations | **50 / 500000 / 60 / 5 / 3**（任务卡可逐任务覆盖；缺失字段回落默认值，不允许无预算运行） |
| 3 | 审查后端 | 同后端新会话 / 强制审查模型 ≠ 实现模型 | **同后端新会话**（Phase 1 从简；Phase 2 再考虑交叉模型） |

## 10. 后续路线（Phase 2/3 展望）

- **Phase 2（条件自动）**：~~队列自动调度~~（✅ 已交付，见 10.3）；~~L0/L1 自动合并~~（✅ 已交付，见 10.2）；~~策略守护完整版~~（✅ 已交付，见 10.1）；~~L0/L1 自动合并~~（✅ 已交付，见 10.2）；~~nightly 巡检信号源~~（✅ 已交付，见 10.4，含内容消毒）。
- **吃自家狗粮（✅ 已交付，见 10.7）**：worker 的 claude CLI 天然走本机网关（真实冒烟时的 unrecognized_model 警告即狗粮信号）。成本核算已从"events.jsonl 自报"升级为"与网关日志对账"——网关转发层新增 usage 旁路解析（src/gateway/usage.ts），orchestrator 侧 reconcile 命令对账。
- **Phase 3（持续自治，"暗工厂"）**：~~质量漂移监控~~（✅ 已交付，见 10.5）；~~多 worker 并行~~（✅ 已交付，见 10.6）；L3 闸门（8687、发布）永远保留人工。

### 10.1 策略守护完整版（Phase 2 第一块，已交付）

Phase 1 只有两个各自为政的 hook：guard-develop（拦基准分支直改）与 policy-worker（worker 会话 Bash 红线）。完整版按 interceptor 模式（2.5）把裁决收敛为**单一策略引擎 + 薄壳 hook**：

```
.agents/scripts/policy.mjs        ← 单一事实来源（零依赖，规则硬编码不可配置关闭）
├─ evaluateCommand(cmd)              Bash 红线：发布动作（git push/tag、npm publish）、
│                                    受保护端口（kill 8687/8890、启动监听、listen 绑定）
├─ evaluateBranchEdit(...)           分支保护：develop/main 直改拒绝；
│                                    worktree 内编辑与仓库外文件放行（路径归一化比对）
├─ classifyChange(files) → L0–L3    改动分级（Phase 2 自动合并的裁决原语）：
│                                    L3 发布流水线（.github/workflows、SEA 构建脚本）→ 永人工
│                                    L2 核心路径（src/cli.ts、gateway/server|state、config/store|
│                                       secrets、util/paths）+ package.json + 未识别文件（保守归高）
│                                    L1 普通 src；L0 纯文档/测试（全命中白名单才可 L0）
└─ audit(event) → .agents/policy/audit.jsonl   拦截与放行都留痕（append-only，
                                     运行态不入库；写失败静默——审计不能阻断裁决）

.agents/hooks/guard-develop.mjs   ← 薄壳：git 取证 + evaluateBranchEdit + audit
.agents/hooks/policy-worker.mjs   ← 薄壳：evaluateCommand + audit（worker/reviewer 共用）
```

配套收紧两点：

1. **reviewer 会话权限层强制只读**（此前只靠 prompt 自觉）：`backend.spawn` 新增 `readonly` 选项——`--allowedTools Read Glob Grep`，无 acceptEdits；headless 模式下白名单外工具调用被自动拒绝（fail-closed），编辑/命令在权限层不可能发生。
2. **闸门摘要显示改动分级**：`printGateSummary` 输出 `classifyChange` 结果并写 `change_classification` 事件——为 L0/L1 自动合并铺路（Phase 2 的自动合并 = 分级为 L0/L1 且审查 0 阻塞且门禁全绿时跳过人工闸门，裁决函数本节已备好，行为开关留待下一块单独评审）。

测试防线：guard-develop 行为锁定测试（真实 git 仓库拓扑：develop 直改拦 / feature 放行 / worktree 放行 / escape hatch）、policy-worker 端到端（拦截+审计落盘）、policy 引擎单测（29 个用例）。重构护栏行为逐字不变——它是所有会话（含人工）的分支保护，回归代价最高。

### 10.2 L0/L1 自动合并（Phase 2 第二块，已交付）

人工闸门在低风险场景是过度摩擦（2.3 Copilot 的分级思想）。任务卡 gate 字段语义升级：`gate` = 本任务允许自动合并的级别上限，允许 **L0 | L1 | L3**（缺省 L3=全人工，最保守；L2 核心路径永人工，声明直接拒绝并提示）。审查 0 阻塞后按 `classifyChange` 实际分级裁决：

- **自动合并**（四个条件缺一不可）：任务卡 gate 显式为 L0/L1（L3 永不自动）；实际分级 ∈ L0/L1 且不超 gate 上限；scope_purity 无越界。动作 = 直接走 feature-branch finish（与人工 approve 完全同一条合并路径，含最终 testCmd 验证），事件写 `auto_merge`（含分级/gate/迭代数）与 `auto_merge_decision`，`merged` 事件带 `auto: true`——Phase 3 质量漂移统计按此回溯自动合并的回溯失败率。
- **回人工**：gate=L3；或实际分级 L2/L3；或改动超出 files_hint（范围失控不静默合并）；或 finish 失败（任务留 awaiting-human 等人工 approve）。
- **元文件豁免**：NOTES.md（feature-branch 交接模板，finish 自动从分支移除）不计入改动面——worker `git add -A` 会把它带进提交，否则分级与范围检查永远失真。

### 10.3 队列自动调度（Phase 2 第三块，已交付）

Phase 1 每次都要人工 `run <task-id>`；自动调度补上「队列自己往前走」：

- **`run --next`**：取 pending 中优先级最高的任务启动闭环（priority：high > normal > low；同优先级按 created_at 升序先到先跑）。一次仍只跑一个任务——多 worker 并行是 Phase 3，按文件归属分区后再开。
- **`drain [--max N]`**：循环清空 pending 队列。每个任务用**子进程**跑（cmdRun 的熔断走 process.exit，同进程循环会整批退出；子进程隔离后单任务 blocked/failed 不阻塞后续）。
- **死循环防护**：run 子进程正常时任务必离开 pending（merged / awaiting-human / blocked / failed）。drain 连续两轮选中同一任务 = 子进程根本没能处理它（执行环境损坏、脚本缺失），立即停止报错而不是空转烧下去——此防护在设计期即写入，实测临时仓库缺 orchestrator.mjs 时正是它兜住。
- 解析失败的卡跳过不阻塞调度（留在 pending 等 `status` 可见、人工修复）。

### 10.4 nightly 巡检信号源（Phase 2 第四块，已交付）

`scan [--todo] [--audit] [--tests] [--dry-run]`（默认 --todo --audit；--tests 要跑整个测试套件故显式开启）扫描三类信号、消毒后生成任务卡进 pending/：

| 信号 | 生成卡 | 去重 id |
|---|---|---|
| TODO/FIXME 注释（src/ 下代码文件） | 每条一张，type=refactor priority=low | `scan-todo-<sha8(文件+内容)>` |
| npm audit 漏洞 | 汇总一张，type=deps priority=high | `scan-audit-<sha8(漏洞集)>`（无网/无 lock 容错跳过并提示） |
| 测试套件失败 | 一张，type=bugfix priority=high | `scan-testfail-<日期>`（同日天然去重） |

**注入面三重防线**（2.5 / Phase 2 展望的消毒要求）：
1. **内容消毒**：`sanitize()` 把扫描到的文本压平——控制字符删除、空白折叠、命令/模板结构字符（反引号、`<>|;${}`）替换、截断 200 字符——信号内容进任务卡（→ worker prompt）时无法携带指令结构；
2. **巡检不自动 run**：scan 只生成卡（created_by: scanner），是否 run 由人工决定——注入内容最多躺在 pending 里，永远到不了 worker；
3. **gate 缺省 L3**：巡检卡一律走人工合并闸门。

卡 id 按内容哈希稳定：信号不变 → 重复巡检自然去重；信号变化（新增/修改）→ 新卡。nightly 定时由外部 cron 调用本命令，orchestrator 不引入常驻进程。

**狗粮对账（Phase 2 展望项，明确不做实现）**：worker 流量过网关侧的成本对账依赖网关先具备 usage 记录能力（当前 logRequest 不解析上游响应的 token 用量）——那是 src/gateway 的功能开发，不属于 .agents 工具链范畴，单独立项，不为本阶段凑数。

### 10.5 质量漂移监控与自动降级（Phase 3 第一块，已交付）

自动合并放开后必须回答"自动合并的成果靠不靠谱"。`drift [--clear]` 命令：

- **统计**：扫全部 merged/ 任务的 `merged` 事件（区分 auto/human），对自动合并逐一检测 **revert 信号**——`git log develop --grep "^Revert .*feature/<id>'"`（git --grep 是 BRE 正则，`.+` 是字面加号，必须用 `.*`；这是实测踩过的坑）。被 revert 即计一次回溯失败。
- **自动降级**：回溯失败率严格大于阈值 **20%（硬编码，与熔断同哲学：不可配置关闭）** 时写降级标记 `.agents/orchestrator/degraded.json`（含降级原因、失败任务清单、时间）——**期间 run 的自动合并全部回人工**（gate=L0/L1 也不放行），awaiting_human 事件 reason=drift_degraded。标记幂等：不覆盖首次降级时间。
- **人工恢复**：`drift --clear` 删除标记。降级是保险丝，拔保险丝不该是自动的——恢复必须人工确认漂移根因已消除。
- 样本不足（autoTotal=0）时只报告不裁决。

### 10.6 多 worker 并行（Phase 3 第二块，已交付）

`drain [--workers N]`（默认 1 = 串行）并发调度：最多 N 个 run 子进程同时跑，每个任务独立 worktree / 独立会话 / 独立熔断（测试本身走随机端口，符合 AGENTS.md 约定）。

- **按文件归属分区互斥**（AGENTS.md「派发并行任务时按文件归属分区」约定的自动化）：新任务与任一在跑任务的 files_hint 经 `hintsOverlap`（policy.mjs）判定相交则跳过、等占位释放再试。判定规则保守优先：提取 glob 的固定前缀段（`docs/**` → docs，`src/cli.ts` → src，首段即通配的裸 `**` → 完全通配），前缀不同才可并行——`docs/**` 与 `test/**` 可并行，`src/cli.ts` 与 `src/gateway/x.ts` 保守串行。
- **任务级互斥锁（task-lock.mjs，双层互斥的内层）**：调度器锁只防"调度器双开"，防不住手动 `run <id>` 撞上在跑的 drain——任务锁（`.agents/orchestrator/.run-<task-id>.lock`，记 pid）在 cmdRun 入口、worker spawn 之前持有：同任务后来者拿到明确报错退出，而不是旧实现那样悄悄杀掉前者的 worker（旧接管语义在 worker_spawned 事件落盘前有杀不掉的窄窗口，锁让该窗口从根上消失）。持锁进程死亡 = 陈锁自动接管，崩溃恢复语义不变（cleanupOrphanWorker 只在接管后才会遇到活孤儿）；闭环落位（merged/awaiting-human/blocked/failed）即释放；abandon 在闭环存活时拒绝（防误杀）。并行 drain 的不同任务各持各的任务锁，互不影响。
- **死循环防护改造**：串行版的"连续两轮同任务"在并发下不再等价（同任务可能被不同 worker 交替选中），改为**每任务独立计数**——同一任务被调度 2 次仍在 pending 即拉黑跳过并告警（人工 resume 前先修执行环境）。
- **结束条件**：无活跃子进程 且 无可调度任务；`--max` 仍限制总启动数。
- 质量安全网（10.5）与本特性正交：降级只影响合并闸门，不影响并行调度。

### 10.7 狗粮对账（展望项落地，已交付——含网关产品功能）

worker 的 token 用量从此有两本账：

| 账本 | 来源 | 特性 |
|---|---|---|
| 自报账 | 任务 events.jsonl 的 budget_snapshot | stream-json result 回填；第三方上游流式 usage 全 0 时运行中不可信（5.10） |
| 实测账 | 网关请求日志 gateway-*.jsonl 的 usage 字段 | **网关转发层旁路解析**（src/gateway/usage.ts），只看得到经网关转发的流量 |

**网关侧（产品功能，src/gateway/usage.ts）**：`createUsageTap(contentType)` Transform 流——字节**原样透传**（转发行为零改变），旁路尽力而为解析：anthropic SSE（message_start 的输入/缓存 + message_delta 的输出累计）、openai/responses SSE chunk usage、非流式 JSON 顶层 usage（≤1MB 缓冲，anthropic/openai 两种字段名口径都认）。解析失败静默，永不影响转发。server.ts 成功转发路径在 pipeline 中插入 tap，LogEntry 新增 usage 字段落盘。

**orchestrator 侧（reconcile 命令）**：把任务事件时间窗（worker_spawned 首条 → merged/failed 尾条，1 分钟容差）投影到网关日志，跨日期文件自动合并，只计成功转发；`reconcile [task-id]` 单任务 / 无参全部 merged 任务按分歧降序。分歧率 = |自报 − 实测| / max(两账)；**网关零流量时标 ⚠（worker 直连上游，对账无意义）**。口径与预算一致：缓存读计入输入。命令只读报告，不做任何动作。

### 10.8 Planner 环节（意图 → 任务卡自动化，已交付）

任务卡的大部分字段（目标重述/验收标准/files_hint/type/priority）本质是**从意图 + 仓库现状推导的执行计划**，不是原始意图——手工填写是 Phase 1 的信任地基，并非终态。`intent "<一句话描述>" [--draft] [--backend mock]` 补上 Planner 环节：

- **readonly planner 会话**（与 reviewer 同一权限层：Read/Glob/Grep 白名单，fail-closed）在主仓库探索现状，把意图编译成完整任务卡（`modeldock-card` 契约块）；
- **校验重试**：输出经 loadCard 校验，失败把可操作报错喂回 Planner 重试（最多 3 次，与调试子循环同构）；id 冲突同样喂回，绝不静默覆盖；
- **gate 强制 L3**：Planner 卡一律人工合并闸门（文本级覆写，不浪费重试轮）——人的参与由此收敛为「给意图 + L2/L3 审核」；
- **双路径**：默认信任路径直接 submit 进 pending；`--draft` 只落 `.agents/orchestrator/drafts/`（不入库）供人工审阅后 submit；
- **审查联动**：reviewer 对 `created_by: planner` 的卡追加第 5 项检查——验收标准的完备性（空洞标准/未覆盖意图/Planner 幻觉计阻塞项），让独立审查同时盯住 Planner 的产出质量；
- **注入面纵深**：意图文本 sanitize 消毒 → Planner 只读（无法落盘）→ 产出过 schema 校验 → worker 执行 → 独立审查 → L3 人工；
- **scan --run**：巡检生成的 high 优先级卡（audit/testfail 机器信号）可立即发起闭环（合并仍人工）——自动 run 的风险被分级闸门完整兜住；TODO 类（语义信号，易误判）仍留人工。

**不做**：每日预算计数器（现有 per-task budget + drift 已兜底，实际用起来再评估）；Planner 拆分多卡（进阶，待单卡路径跑顺）。

## 11. 附录：参考资料

- Ralph Wiggum 技术：Geoffrey Huntley 提出；Vercel Labs `ralph-loop-agent`；Addy Osmani《Self-Improving Coding Agents》；Ralph Orchestrator（安全/监控/成本控制层）
- Gas Town：Steve Yegge 开源的多 agent 编排器（worktree 隔离、Beads 持久记忆、角色层级、MEOW 工作单元）
- GitHub Copilot Coding Agent：Issue → draft PR → 人类 PR 审查合并；每会话独立 worktree
- OpenHands：事件溯源架构（无状态 agent + append-only 事件日志 + action→observation 循环 + hook 体系）
- 安全共识：策略守护（interceptor）模式、成本熔断（max_turns / token 预算 / 迭代上限 / wall-clock）、分支隔离底线
- 仓内文档：`AGENTS.md`、`.agents/workflows/feature-branch.md`、`.agents/workflows/code-review.md`、`.agents/workflows/worktree-rescue.md`、`.agents/conventions/docs-writing.md`

## 12. 设计公理：海事五原则（2026-11，体系定名 Dockmaster 时确立）

海事行业几百年沉淀的本质，是「让一个船长安全指挥多船长期在海上」的制度。以下五条作为设计公理——未来每次扩展先过一遍这五问，防止效率改造悄悄侵蚀安全结构：

1. **双罗经（关键判定不依赖单一来源）**：审查引擎异构互审（claude/zcode 分源，防同底座共因盲区）、worker 自报 vs 门禁实测、reconcile 自报账 vs 网关实测账。单一信号源只做 advisory，裁决必须有第二来源。
2. **水密舱（单点破损不沉全船）**：drain 逐卡子进程隔离（单卡 blocked 不阻塞后续）、任务级互斥锁、队列运行态与代码仓分离。任何一舱进水，全队照航。
3. **分道通航（并发靠确定性规则，不靠协商）**：files_hint 分区互斥、调度器锁、引水闸（pilotage_required）、端口红线。通行规则必须机器可判定，LLM 判断永远排在确定性规则之后（对齐 pr-risk-tier「确定性先行」哲学）。
4. **领先指标优先（险情先于事故）**：watchdog_suspect / xte_alarm / worker_retry / fastlane_skipped 是近乎事故（near-miss）留痕，stats 安全晴雨表聚合为领先指标；drift 的 revert 统计是滞后指标。监控体系先看前者——近乎事故率上升早于真实失败出现。
5. **责任不转移（引水登轮，船长不卸责）**：autopilot 自动提交、异构审查、ci-autofix 自动修复，都不改变合并权与发布权在人。自动化程度越高，人工闸门越要显式、留痕、可审计（gate 分级 / AGENTS_ALLOW_RELEASE 白名单 / awaiting-human 目录）。

---

**版本历史**

| 版本 | 日期 | 说明 |
|---|---|---|
| v1.0 | 2026-10-11 | 初版（随公开仓库 v1.0.0 发布）：调研结论 + 五层架构 + Phase 1 详细设计 + 实施/测试计划 + 决策点；实施状态——策略守护（policy.mjs 命令红线/分级/审计）、L0/L1 自动合并、队列调度（run --next / drain）、nightly 巡检（scan + sanitize）、质量漂移监控（drift 降级/恢复）、多 worker 并行（hintsOverlap 分区互斥）、狗粮对账（reconcile + 网关 usage 旁路解析）、Planner 环节（intent 编译任务卡）均已交付（§10 各节），Phase 2 推进中 |
| v1.1 | 2026-10-29 | 任务级互斥锁（§10.6，task-lock.mjs）：同任务同时只允许一个 run 闭环进程，堵住"手动 run 撞 drain / 双重手动操作 → 两个 worker 写同一个 worktree"的全部路径与旧孤儿接管的杀竞窗口；abandon 增加闭环存活守卫；锁文件 .run-\<task-id\>.lock 入 gitignore |
| v1.2 | 2026-10-30 | 自治长跑加固（feature/orch-autonomy-hardening）：**Windows 权限墙根修**——claude CLI 在 Windows 的 shell 工具是 PowerShell，Bash(...) 白名单匹配不到 PowerShell 调用（沙箱实验实证），白名单/红线/hook matcher 一律 Bash+PowerShell 双形态；zcode 0.17.0 yolo 已恢复全自动。**budgetProfiles** 按引擎校准预算（zcode max_tokens 5M——GLM 缓存读口径失真+结束才回填 usage）+ Budget 会话级记账（committed+sessionMax，修跨 fixup 会话 Math.max 漏计）+ budget_baseline 事件。**瞬时故障退避**：无结果块且带 429/网络签名原地重试 60s×attempt ≤3 次；drain 引擎预检（不可用拒绝启动，杜绝逐卡烧成 blocked）。**无人值守观测**：落位（awaiting-human/blocked/failed）与 drain 收官 webhook 通知（\${envPrefix}_ORCH_WEBHOOK）；spec progress.json 全局进度锚（moveCard 自动同步）+ spec status。**prompt 纪律**：结束纪律层（done 前自验/干净提交/权限拒绝满 2 次 stuck 熔断——实测一次任务白烧 15+ 次重试）、git -C 与复合命令禁用、spec design/requirements 改 worktree 文件引用（防 zcode 30k argv 上限）、reviewer 注入 REVIEW.md 纪律、files_hint 剥反引号（tray-only-mode-t1 实测污染） |
