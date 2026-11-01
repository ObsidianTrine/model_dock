# orchestrator（自治编排 Phase 1）操作手册

> 目标读者：给人写任务卡、看闸门、处理 blocked 任务的 agent / 人类操作者。
> 设计文档：`docs/design-orchestrator.md`（架构、状态机、熔断、红线，本文只讲怎么用）。
> **运行前提**：从主仓库根目录运行；Node ≥18；零第三方依赖（纯 node: 内置模块）。

## 一句话心智模型

**任务卡进、合并出**：人写一张任务卡 → `run` 让 orchestrator 自动跑 worker（改代码）→ 静态门禁（测试/build/红线扫描）→ 调试子循环（失败自动喂回）→ LLM 独立审查 → 审查返工子循环 → **人确认合并**（L3 闸门，Phase 1 唯一放权边界）。

## 快速上手

**推荐：一句话给意图（Planner 自动编译任务卡）**

```bash
node .agents/scripts/orchestrator.mjs intent "<一句话描述任务>"          # 编译并直接进队列
```

Planner 是只读会话（Read/Glob/Grep），产出卡 gate 固定 L3（合并前人工审核），
独立审查会额外检查其验收标准质量。以下手写路径仍完全有效：

```bash
# 1. 写任务卡（手写 markdown，schema 见 docs 5.2；验收标准必须是可机器检查的断言）
$EDITOR my-task.md

# 2. 提交（校验 schema，转 pending/）
node .agents/scripts/orchestrator.mjs submit my-task.md

# 3. 启动闭环（后端缺省读 workflow.json worker.backend，本仓库为 zcode-headless；
#    --backend mock 用假 worker，秒级不烧钱）
node .agents/scripts/orchestrator.mjs run <task-id>

# 4. 看进度（任意时刻）
node .agents/scripts/orchestrator.mjs status            # 队列全貌
node .agents/scripts/orchestrator.mjs status <task-id>  # 单任务事件时间线

# 5. 审查通过后任务停在 awaiting-human/，人工三选一：
node .agents/scripts/orchestrator.mjs approve <task-id>                    # 批准 → feature-branch finish 合并
node .agents/scripts/orchestrator.mjs reject <task-id> --reason "..."      # 驳回 → failed/（worktree 保留现场）
node .agents/scripts/orchestrator.mjs retry <task-id> --note "..."         # 打回 → 附补充指令重新闭环
```

`run` 在 TTY 下会在人工闸门处交互（a 批准 / v 看 diff / r 驳回 / b 打回 / q 搁置）；非 TTY（脚本/CI）打印提示后退出，用上面的 approve/reject/retry 命令异步处理。

## 任务卡怎么写（关键：验收标准可机器检查）

```markdown
---
id: fix-user-presets-merge       # 小写短横线，即 feature-branch task-id
type: bugfix                     # bugfix | feature | docs | deps | refactor
priority: normal
created_at: 2026-10-01T10:00:00+08:00
created_by: human
budget:                          # 可整体省略（回落默认）；给了就必须是正整数
  max_turns: 50
  max_tokens: 500000
  max_wall_minutes: 60
  max_test_iterations: 5
  max_review_iterations: 3
files_hint:                      # 预期改动范围（glob），超出只是警告注入审查
  - src/presets/**
workflows:                       # 注入 worker 的 playbook（至少 feature-branch）
  - feature-branch
ui_check: true                   # 可选：改 Web 控制台/网关页面的任务开启 UI 冒烟门禁（跑 workflow.json uiCheckCmd）
tier: heavy                      # 可选：任务等级（按难度选服务/模型，见「任务等级（tier）」节）；缺省时 files_hint 命中核心/发布路径自动升 heavy
fastlane: true                   # 可选布尔（缺省 false）：轻卡快速通道——跳过 LLM 审查子循环省最大开销，
                                 # 门禁/调试子循环/分级闸门一个不省；实际分级 L2/L3、drift 降级、gate=L3
                                 # 或 workflow.json fastlaneAllowed:false 时自动失效回常规链路（规则见「常见问题」）
gate: L3                         # Phase 1 固定值
---

# 目标
一句话说清"改什么、为什么"。

# 验收标准
- `npm test` 全绿
- 新增用例覆盖：同名 id 覆盖、新 id 追加、格式错误阻断启动

# 红线（可选）
- 不改动 src/cli.ts

# 背景（可选）
现象、复现步骤、相关文件。
```

**验收标准是 orchestrator 的灵魂**：worker 拿它当自查靶子，审查者拿它当评判基准，你看闸门时拿它当验收清单。写"做得好用一点"这种不可检查的句子等于没写。

**`fastlane` 只省审查、不省任何闸门**：适合纯 docs/test 类小改动（分级判定仍然按实际改动面算，声明不兜底）。写 `fastlane: true` 即请求跳过 LLM 审查子循环，失效规则与失效条件见「常见问题」末条。

## 任务卡状态机（哪里找我的任务）

```
pending → running → reviewing → awaiting-human → merged
             │          │             │
             ↓          ↓             ├─ reject → failed/
          blocked    （审查阻塞回 running）└─ retry  → running
             │
             └─ resume → running ／ abandon → failed/
```

- **blocked/**：worker 自报 stuck、预算/迭代熔断、异常结束。人接手：`resume`（带事件时间线与 NOTES.md 现场续做）或 `abandon`（转 failed/，worktree 按 `worktree-rescue.md` 手工清理）。
- **failed/**：红线门禁（端口/native）或人工驳回。红线失败不可调试——改设计，别改门禁。
- 运行态（`queue/`、`logs/`）不入库，崩溃后 orchestrator 重启即可从 `running/` + `events.jsonl` 恢复。

## 熔断（自动停，不会烧钱）

| 触发 | 行为 |
|---|---|
| worker 轮次超 `max_turns` | kill worker 进程树 → blocked |
| token 超 `max_tokens`（含缓存读） | kill → blocked |
| wall-clock 超 `max_wall_minutes` | kill → blocked |
| 测试/build 修复超 `max_test_iterations` | blocked（附失败尾部 200 行） |
| 审查返工超 `max_review_iterations` | blocked |
| 进展看门狗（`watchdog.mode: actuate`）连续 2 次判定无实质进展 | kill worker → blocked |

熔断全部记录 `circuit_breaker` 事件（`logs <task-id>` 可查），**永不静默重试**。

进展看门狗（watchdog）缺省 **observe** 档：worker 每 N 个 turn（workflow.json `watchdog.everyTurns`，缺省 20）由一次性只读 LLM 会话判断是否有实质进展，疑似空转只记 `watchdog_suspect` 事件不动作；actuate 是显式配置（连续 2 次 suspect 才熔断）。每任务最多检查 5 次（超限记 `watchdog_disabled`），检查自身故障记 `watchdog_error`（每任务 ≤3 条后静默）。

## 任务等级（tier）：按难度选服务与模型

重活走旗舰模型服务、轻活走便宜快服务——等级决策在任务卡与配置里声明，凭据经环境变量注入，**token 不入库**：

1. **ModelDock 侧（一次性）**：按等级建 profile（如 `orch-heavy` → 旗舰服务、`orch-light` → 便宜快服务），再各建一个钉定路由的 harness（config.toml 直编，热加载即时生效）：

   ```toml
   [harness.orch-heavy]
   mode = "gateway"
   route = "orch-heavy"     # 钉定到重活 profile
   token = "mdk_随机串1"

   [harness.orch-light]
   mode = "gateway"
   route = "orch-light"
   token = "mdk_随机串2"
   ```

   写完 `modeldock test orch-heavy` 逐级验证连通（经网关对该 profile 发最小请求）。

2. **workflow.json 声明等级**：`tokenEnv` 引用环境变量名（值在 shell 导出，如 `export MDK_TIER_HEAVY_TOKEN=…`）；`workerModel`/`reviewModel` 覆盖该等级的模型；`provider` + `gatewayBase` 用于派发前目录校验：

   ```json
   "tiers": {
     "heavy": { "tokenEnv": "MDK_TIER_HEAVY_TOKEN", "workerModel": "kimi-k2-…", "reviewModel": "…", "provider": "服务ID", "gatewayBase": "http://127.0.0.1:8687" }
   }
   ```

3. **任务卡点名**：frontmatter 写 `tier: heavy`。模型生效优先级：CLI `--worker-model/--review-model` > tier 的 `workerModel`/`reviewModel` > workflow.json 全局默认。

生效机制与降级（事件 `tier_resolved` 留痕，不含 token 值）：

- token 注入 worker/reviewer 子进程；claude 系同时写入每会话专属 `--settings` 文件的 env 块（优先级高于用户级 settings.json，实测生效）。
- 显式 tier 未配置 / 环境变量未设 → 告警并回落全局默认路由，不阻断；自动升级但 token 未设 → 静默跳过（该路径高频，不刷日志）。
- 派发前经 `/v1/models?provider=<服务ID>` 校验模型名在目标服务目录内（advisory：网关不可达/目录缺失只告警，上游报错为准）。
- **zcode-headless 不支持 tier**：ZCode CLI 不认 `ANTHROPIC_BASE_URL/AUTH_TOKEN` 环境变量（实测），zcode worker 模型跟随 ZCode 自身配置；claude 系 tier 生效的前提是客户端已按**网关模式**接入 ModelDock（base_url 指向网关，而非直连上游）。

## 常见问题

- **改 backend**：`--backend mock|claude-headless|zcode-headless`。缺省沿用上次会话的后端（retry/resume 场景），首次运行默认 claude-headless。mock 只用于测试闭环本身。zcode-headless 走 ZCode CLI headless（`-p --json`）：桌面版不装 PATH 命令时设 `ORCH_ZCODE_CLI=<zcode.cjs 绝对路径>`（macOS 例：`/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs`）；差异是 headless 无 `--max-turns`，轮次熔断不可用——wall-clock/token 熔断触发时 orchestrator 直接杀在跑进程树（进程级看门狗），prompt 经 argv 传递、超 30000 字符快速失败（该任务改用 claude-headless，stdin 无此限制）。
- **后端切换人工闸门**：worker 引擎最终解析结果 ≠ workflow.json `worker.backend`（配置默认）时 run 一律拒绝启动（显式 `--backend`/`--worker-backend`、resume 沿用皆不豁免），须 `--approve-backend-switch` 或环境 `ORCH_APPROVE_BACKEND_SWITCH=1` 显式批准；卡保持原状态零消费。背景：2026-10-29 夜跑 ORCH_ZCODE_CLI 未设 → zcode ENOENT + GLM 429 → 自治跑静默全量切 claude-headless 直连 DeepSeek，worker 烧到非预期账单——切换引擎=切换计费方，必须过人。
- **审查用的是哪个引擎（异构审查）**：执行与审查是两个独立会话，审查引擎独立解析——`--review-backend <name|same>` 显式指定 > workflow.json `review.backend` 默认 > 上次 `review_spawned` 事件（retry/resume 不换审查引擎；prior 为 mock 而 worker 已换真实后端时忽略，防 mock 审查冒充真实审查）> **自动异构**（worker 为真实后端时，自动选另一个 CLI 可用的真实引擎，如 claude 干活 / zcode 审查；mock worker 永不异构）> 回落同源并记 `review_backend_fallback` 事件。**注意：去相关的关键是引擎异源（不同模型家族），只拆会话不换引擎仍有共同盲区**；`same` 可强制回到同源。zcode worker 的红线走 `.agents/hooks/policy-zcode.mjs`（`ORCH_POLICY_ENFORCE=1` 才裁决，日常 ZCode 会话直通）。
- **引擎与模型的默认声明位（workflow.json）**：`worker: { backend, model? }` / `review: { backend, model? }`——仓库级声明「执行/审查各用什么引擎与模型」，CLI 四参数（`--worker-backend/--worker-model/--review-backend/--review-model`）单次覆盖，drain/nightly/scan --run 自动透传。优先级：CLI 显式 > resume 沿用（任务连续性）> 配置默认 > 既有缺省链。model 仅 claude 系 CLI 生效（`--model`）；zcode 无 `--model` 参数，模型跟随 ZCode 当前默认（App 内切换）。`review_spawned` 事件带 model 留痕可审计。本仓库当前默认：执行 zcode-headless、审查 claude-headless + opus。
- **worker 被什么拦了**：worker 会话注入专属 policy hook（`.agents/hooks/policy-worker.mjs`），git push/tag、npm publish、碰受保护端口一律拒；发布动作是硬编码红线，任务卡写了也没用（端口红线按 workflow.json protectedPorts 配置）。zcode worker 走同一裁决（policy-zcode.mjs / policy-dispatch.mjs），但注册通道不同：**必须在用户级 `~/.zcode/cli/config.json` 的 hooks 块注册（`enabled: true`）**——项目级 `.zcode/config.json` 的注册有 workspace trust 门且 headless 下被平台整体禁用（`config_project_hooks_pending_trust` / `workspace_hooks_feature_disabled`，2026-10-25 真跑 zcode 实证：项目级不生效、用户级成功拦截 git push 并留审计）。用户级注册二选一：
  - **机器级 dispatcher（推荐，一次注册全项目生效）**：`cp .agents/hooks/policy-dispatch.mjs ~/.agents/hooks/`，用户级 hook 指向它——它按 hook 事件的 cwd 委托该项目自带的 `.agents/scripts/policy.mjs`，新项目只要带 `.agents/` 就自动受保护，零注册；
  - **逐项目绝对路径（旧行为）**：每个项目注册自己的 `<项目绝对路径>/.agents/hooks/policy-zcode.mjs`。
  两者都以 `ORCH_POLICY_ENFORCE=1` 门控，日常 ZCode 会话直通零拦截；未注册时 zcode worker 的 Bash 红线无人把守——**用 zcode-headless 跑自治任务前先完成这一步注册**。
- **验收标准之外我该信什么**：什么都不必信——orchestrator 亲自跑 `workflow.json` 的 testCmd 和 build，自报不可信（docs 5.5）。
- **fastlane 卡跳过审查的规则与失效条件**：任务卡 frontmatter 写 `fastlane: true`（缺省 false；写了非法值按 false 处理并告警，不拒绝提交）→ 闭环变为 worker → 门禁/红线 → 调试子循环 → 直接进分级闸门：不进 reviewing 状态、不 spawn reviewer，事件留痕为 worker_spawned 后记 `fastlane_active`、`review_verdict` 记 `{verdict:"skipped", reason:"fastlane"}`。**只省审查，不降任何闸门**：自动合并四前提（无 drift 降级 + 声明与实际分级均为 L0/L1 + 实际≤声明 + scope 无越界）原样生效。三条失效规则（都记 `fastlane_skipped` 事件附 reason，失效后本次 run 不复活、照跑审查）：① worker 完成后按实际改动分级复判，L2/L3（核心路径/发布流水线/未识别文件）→ 回常规链路——核心路径恰恰最需要审查；② drift 降级标记存在 → 回常规链路（降级是保险丝期，不能省审查，自动合并也照旧关闭）；③ 卡 gate=L3（发布类/全人工）→ 跑前即失效（L3 本就永不自动合并）。另：workflow.json `fastlaneAllowed: false` 为团队级总开关，设 false 后声明一律被忽略（reason=`disabled_by_config`）。
- **和 feature-branch 工作流什么关系**：orchestrator 完全复用它（start/finish/NOTES.md 交接），worker 的编辑被 guard-develop 挡在 worktree 内。**人工开发同一任务现已机制化互通（claim-before-execute）**：feature-branch start 见队列同 id 卡在 pending/ 即自动认领（抢任务锁 + 卡迁 running/ + manual_claimed 事件），finish 成功后落 merged/——人工侧与闭环共享卡状态，drain 不会再误派/误转 blocked（2026-10-30 卡 22 双 agent 撞车已机制性收口）；编排器自己拉起的 start/finish 分别带 ORCHESTRATOR_CLOSURE / ORCHESTRATOR_GATE_HEAD 标记跳过认领与落卡，卡的归属权留在闭环状态机。同 task-id 混用仍然不要：卡已被闭环持有（锁存活）时 start 会拒绝。
- **多个调度器能同时跑吗**：不能。drain / nightly / scan --run 共用调度器互斥锁（`.agents/orchestrator/.scheduler-lock.json`）：他人持锁且存活时后来者打印提示直接退出（nightly 定时撞上白天手动 drain 不会双跑同一张卡）；持有进程已死 = 陈锁，自动接管不人工清理。手动 `run <id>` 单卡不抢调度器锁（人工明确意图）。被调度器 spawn 的子进程经环境标记豁免，不会自我死锁。
- **同一个任务能被两个进程同时跑吗**：不能。每个任务有任务级互斥锁（`.agents/orchestrator/.run-<task-id>.lock`）：run/resume/retry 进入闭环时抢锁，他人持锁且存活时后来者报错退出（手动 run 撞上 drain、双重手动操作都不会出现两个 worker 写同一个 worktree）；持有进程已死 = 陈锁自动接管（崩溃恢复：接管后仍会先清理孤儿 worker）。闭环落位（merged/awaiting-human/blocked/failed）即释放；`abandon` 在闭环存活时会被拒（防止误杀在跑 worker），确认卡死先终止该进程再 abandon。**人工指派的 agent 同样被挡**：feature-branch start 的认领逻辑会抢同一把锁（活锁持有者 = 闭环时拒绝，陈锁自动接管），且认领即把卡迁出 pending/——drain 不再把它当可调度卡误派（认领机制详见 feature-branch.md「start 即认领」）。
- **worker 起不来（claude CLI 缺失/未登录）会怎样**：任务卡自动落 `blocked/`（failed 事件附原因），不会悬在 running/ 冒充在跑；修好环境后 `resume <task-id>` 续做。
- **nightly 跑完怎么知道结果**：结束（含异常）发通知——macOS 本地通知（osascript，登录会话可见）；设环境变量 `${envPrefix}_NIGHTLY_WEBHOOK=<url>`（envPrefix 缺省 AGENTS，旧名 `MODELRDOCK_NIGHTLY_WEBHOOK` 兼容识别）追加 webhook POST `{title, body, ts}`（飞书/企业微信/Slack 的 incoming webhook 皆可接）。通知尽力而为：通道失败静默，摘要始终在 `logs/nightly.log`。

## 长跑加固（2026-10-30，feature/orch-autonomy-hardening）

自治长跑（夜里 drain 数小时）的工程补强，实验依据与设计细节见 `docs/design-orchestrator.md` v1.2：

- **Windows 权限墙已根修**：claude CLI 在 Windows 的 shell 工具是 **PowerShell**——`Bash(...)` 前缀白名单匹配不到 PowerShell 工具调用，git add/commit/npm test 全被 headless 自动拒（只读 git status 反而走内置启发式放行，即夜跑「能读不能验」形态）。现白名单/红线一律 **Bash+PowerShell 双形态双发**，worker settings hook matcher 为 `Bash|PowerShell`。zcode 侧 yolo 在 CLI 0.17.0 已恢复全自动（沙箱实验实证）。**zcode worker 红线前置条件**：`cp .agents/hooks/policy-dispatch.mjs ~/.agents/hooks/` 并在用户级 `~/.zcode/cli/config.json` 注册 PreToolUse（matcher `Bash|PowerShell`）指向它——缺失时 zcode worker 的红线无人把守（2026-10-30 发现本机注册缺失，已补并验证 git push 拦/git status 放）。
- **预算按引擎校准**：workflow.json `budgetProfiles.<backend>` 覆盖任意 `max_*` 正整数键（本仓库 zcode-headless `max_tokens: 5000000`——GLM 缓存读口径失真 + zcode 会话结束才回填 usage，默认 500k 形同虚设，夜跑 8 次误熔断；调大不关闭，wall-clock 才是真熔断）。Budget 记账改会话级 committed+sessionMax（跨 fixup 会话不再互相覆盖漏计），每次 worker_spawned 落 `budget_baseline` 事件。
- **瞬时故障退避**：worker 异常结束（无结果块）且输出带 429 限流/网络签名（transient.mjs）→ 原地重试同一 prompt，60s×attempt，≤3 次（`worker_retry` 事件留痕，不静默）；签名不匹配或自报 stuck 仍走 blocked。drain 起跑前**引擎预检**（zcodeAvailable/claudeAvailable）——CLI 不可用直接拒绝启动，不再逐卡 spawn 失败烧成 blocked（夜跑 8 卡 ENOENT 实证）。
- **无人值守观测**：卡片落 awaiting-human/blocked/failed（含异常兜底）即发 webhook（环境变量 `${envPrefix}_ORCH_WEBHOOK`，如 `AGENTS_ORCH_WEBHOOK`；未配置零开销，失败静默）；drain 收官发落位 tally 摘要。spec 全局进度锚 `specs/<id>/progress.json`（build 幂等生成，卡片状态迁移经 moveCard 自动同步），`spec status <id>` 看跨夜断点全局视图。
- **prompt 纪律**（对齐 Anthropic 长时程 harness）：worker prompt 新增结束纪律层——done 前自验测试、干净提交、不越界、**同一条命令被权限拒绝满 2 次即 stuck 熔断**（实测一次任务白烧 15+ 次重试+子代理）；环境层禁 `git -C` 形态（headless 白名单按前缀匹配）与 `;`/`&&` 复合命令（被按 multiple operations 整体拒绝）。spec 卡 design/requirements 改 **worktree 文件引用**（防 zcode headless 30k argv 上限），prepare 时由 orchestrator 拷贝进 worktree（specs/ 在 gitignore 内不污染改动面）。reviewer prompt 注入 REVIEW.md 纪律摘要（截 8000 字符，异构引擎+同一纪律）。files_hint 解析时自动剥反引号/引号（tray-only-mode-t1 实测污染）。

## UI 冒烟门禁（ui_check）

改 Web 控制台 / 网关页面的任务卡，frontmatter 加 `ui_check: true`：门禁链会在 build 之后跑 `workflow.json` 的 `uiCheckCmd`（本仓库为 `node scripts/ui-smoke.mjs`——自备 189xx 端口 + `MODELRDOCK_FAKE_HOME` 沙箱、健康端点 + token 登录 302 + 控制台页标记断言、结束杀进程树并核实清理）。失败进调试子循环（与 build 同级，不是红线）；卡声明了 `ui_check` 但仓库未配置 `uiCheckCmd` 时快速失败、卡留 pending。

## 规格驱动（spec，Spec Kit/Kiro 式三件套）

`intent` 适合小改动（一句话直达任务卡）；**需要「先设计后施工」的特性走 `spec`**——Planner 只读会话产出 requirements（用户故事 + EARS 验收标准）→ design（现状/方案/取舍/风险）→ tasks（可独立合并的任务段）三件套，**人工审阅设计后再拆卡**：

```bash
# 1. 意图 → 三件套（落 .agents/orchestrator/specs/<id>/，不进队列）
node .agents/scripts/orchestrator.mjs spec "支持配置导出为 JSON 文件"

# 2. 人工审阅/手改三件套（直接编辑 specs/<id>/ 下的 md，这是你的设计稿）

# 3. 确认设计后拆卡进队列（幂等；design 全文注入每张卡的背景段）
node .agents/scripts/orchestrator.mjs spec build <id>

# 浏览
node .agents/scripts/orchestrator.mjs spec list
node .agents/scripts/orchestrator.mjs spec show <id>

# 4. 之后就是常规闭环：drain 逐张跑（按任务序先后调度），合并逐张等人工 approve
```

- **人工闸门在「审设计」这一步**：Planner 只产文档不动代码；tasks 里的「文件」行直接成为任务卡的 `files_hint`，写得越准分区越好。
- 任务卡的 `created_at` 按任务序递增——drain 同优先级先到先跑，「依赖: 任务 N」天然先跑被依赖方（不引入显式依赖图）。
- specs/ 是人工审阅工作区（不入库）；「文件」行缺失的任务卡 files_hint 兜底为 `**`（独占分区）并告警提示手改收窄。
- 拆出的卡 `gate: L3`、`created_by: planner`：开发→测试→审查照走 orchestrator 闭环，合并仍人工——**设计与施工分离、审点前置**。

## 队列自动调度（Phase 2）

```bash
# 跑优先级最高的 pending 任务（priority: high > normal > low，同优先级先到先跑）
node .agents/scripts/orchestrator.mjs run --next

# 循环清空整个 pending 队列（单任务熔断转 blocked/ 不阻塞后续；--max N 限制轮数）
node .agents/scripts/orchestrator.mjs drain
node .agents/scripts/orchestrator.mjs drain --max 5
```

一次仍只跑一个任务（多 worker 并行是 Phase 3）。drain 对连续两轮选中同一任务的情况会自动停止——那说明 run 子进程无法处理该任务（执行环境损坏），防止空转。

## nightly 巡检（Phase 2）

```bash
# 扫描 TODO/FIXME、npm audit、GitHub open issues、已知问题账本（docs/known-issues.md）、
# 主干 CI 失败（默认信号源），生成提案卡落 drafts/（不直接进队列）
node .agents/scripts/orchestrator.mjs scan

# 全量巡检（含测试套件，慢）；先看会生成什么再落卡
node .agents/scripts/orchestrator.mjs scan --tests
node .agents/scripts/orchestrator.mjs scan --dry-run
```

- 生成**提案** `created_by: scanner`、gate=L3、`proposal: true`——落 `drafts/` 而非队列，**是否进队列由人工 submit 或 autopilot 白名单决定**（见「提案与 autopilot」节）；扫描内容经消毒（无法携带指令结构进 worker prompt）
- 提案 id 按内容哈希：信号不变重复扫描自动去重；cron 每晚调 `scan` 即为 nightly
- **issues / ci 信号源**（gh CLI，best-effort）：仅 origin 指向 GitHub 的仓库启用；gh 未安装/未登录 → 警告跳过。issues 每个 open issue 一张卡；ci 只看主干（baseBranch）最近一条失败 run，按 head sha 建 id（同提交同 id 去重）；`ORCH_GH_CLI` 可指认 gh 路径
- **known-issues 账本信号源**：解析 docs/known-issues.md 总览表的未修条目（已修/暂缓的条目自动跳过——人工裁决不被自主提案推翻）；仓库没有这本账时静默跳过
- 巡检后人工批量提交提案，或 `run --next` / `drain` 推进已提交的队列（见上节）

## nightly 编排与定时调度（schedule）

`nightly` = 一次完整巡检编排（scan 出提案 + autopilot 白名单提交 + drift 报告 + 队列摘要）；`schedule` 把它注册成每日定时任务——「夜里自动巡检（可选自动优化）、早上人工放行」的完整形态：

```bash
# 手动跑一次编排（零烧钱：只巡检出提案，不跑 worker）
node .agents/scripts/orchestrator.mjs nightly

# 含慢信号源（跑测试套件）
node .agents/scripts/orchestrator.mjs nightly --tests

# 加跑 planner 需求综合（烧钱：一次 headless planner 会话，产出对齐 goals.md 的高质量提案）
node .agents/scripts/orchestrator.mjs nightly --plan

# 注册每日 02:30 定时（macOS launchd / Linux crontab / Windows schtasks，经 wrapper 绝对路径启动，
# 不依赖调度器环境的 PATH）；--auto 3 = 夜间对 high 提案提交并发起闭环、再 drain 3 个任务（worker 烧钱仅在此档，
# gate=L3 兜底：合并仍等人工 approve）
node .agents/scripts/orchestrator.mjs schedule install --hour 2 --minute 30 --auto 3

# 注册常驻 watch 循环（见「watch 连续自治运行」节）而非每日波次
node .agents/scripts/orchestrator.mjs schedule install --mode watch --interval 30

# 只看会做什么，不动系统调度（写 wrapper + 打印注册计划）
node .agents/scripts/orchestrator.mjs schedule install --dry-run --hour 2

node .agents/scripts/orchestrator.mjs schedule status     # 查注册状态
node .agents/scripts/orchestrator.mjs schedule uninstall  # 卸载
```

- wrapper（`.agents/orchestrator/nightly-runner.sh|cmd`）在 install 时刻固化仓库/node 的绝对路径——launchd、schtasks 的执行环境 PATH 极瘦，运行时一律不做环境发现；仓库挪位置后需重跑 `schedule install`。
- 日志落在 `.agents/orchestrator/logs/nightly.log`（每次 nightly/watch 自动轮转：超 5MB 转 `.old`）。
- 默认档（不带 `--auto`/`--plan`）零烧钱：只出提案与报告，等人工提交/`drain`；`--auto` 档夜里真跑 worker，合并闸门不变。

## 提案与 autopilot（自主需求侧）

需求侧生命周期：**巡检/规划出提案（drafts/）→ 人工批量 submit 或 autopilot 白名单自动提交（pending/）→ 常规闭环（门禁/审查/合并闸门原样）**。

```bash
# 人工审阅提案后逐张提交（提交后草稿自动清掉；队列已有同 id 会拒绝）
node .agents/scripts/orchestrator.mjs submit .agents/orchestrator/drafts/<id>.md

# autopilot 需求综合：goals.md + drafts 巡检提案 + 队列现状 → planner 产出高质量提案
# （烧钱动作；产出的提案若命中 autopilot 白名单会立即自动提交）
node .agents/scripts/orchestrator.mjs propose
```

**目标面 `​.agents/orchestrator/goals.md`**（入库、用户手编、agent 只读）：核心目标（优先级排序）/当前主题/明确不做三段。propose 的产出必须对齐它；文件缺失或留空 = 无目标面（只基于巡检信号提案）。

**autopilot 授权配置**（workflow.json `autopilot` 键，缺省全关 = 行为与历史版本一致）：

```json
"autopilot": { "enabled": true, "autoSubmitTypes": ["docs"], "autoDrainPerCycle": 3, "maxProposalsPerCycle": 3 }
```

- 自动提交 ≠ 自动合并：白名单提交的卡 gate 覆写为 L1，**实际自动合并仍由门禁对真实改动的分级裁决**——drift 降级、scope 越界、实际 L2/L3 照样挡回人工闸门
- 永不自动提交（即使 enabled）：`deps` 类型（依赖升级人工裁决）、`created_by: human` 的人工草稿、files_hint 命中 corePaths/releasePaths 的卡
- 一次性授权沉淀为持久配置：开启即代表授权「该类型的提案自动进队列」，不再需要逐卡对话确认

## watch 连续自治运行

```bash
# 前台常驻：每周期 drain pending → 队列空时 scan 出提案 →（autopilot 开时）propose → 休眠
node .agents/scripts/orchestrator.mjs watch --interval 30

# 测试/调试：不休眠 + 限制周期数
node .agents/scripts/orchestrator.mjs watch --interval 0 --max-cycles 2 --backend mock
```

- 停止：`touch .agents/orchestrator/.watch-stop`（下周期即停，文件被消费删除）或 Ctrl-C；**drift 降级生效自动退出**（保险丝不允许自己插回去，人工 `drift --clear` 后重启）
- 每周期重读 workflow.json——改 autopilot 配置下周期即生效，无需重启
- **投机重探**：每周期检查 blocked 卡，worker 异常结束 + 瞬时故障签名（429/网络）且从未重探过的卡，一次性有痕 resume（`speculative_resume` 事件留痕）；熔断卡与 worker 自报 stuck 永不重探（「永不静默重试」红线不变）
- 与 drain/nightly 共用调度器锁：watch 在跑时手动 drain 会提示退出而非并发调度

## 运行度量与运行中信息通道

```bash
# 运行度量基线：每卡 wall/turns/调试与审查迭代/token 峰值/watchdog/follow-up + 合并率汇总
node .agents/scripts/orchestrator.mjs stats --days 7
node .agents/scripts/orchestrator.mjs stats --json   # 机器可读（summary 嵌套 + rows）

# 运行中任务的直通信息通道（订阅直通）：补充指令写 inbox，会话边界（fixup/审查返工/resume/新 spawn）送达 worker
node .agents/scripts/orchestrator.mjs follow <task-id> "优先改适配器层，测试放最后"
```

- stats 的 token 是**会话峰值口径**（budget_snapshot 累计），跨引擎精确对账跑 `reconcile`
- follow 只对 `running/` 的卡开放（只有运行中的闭环有注入点）；awaiting-human 用 `retry --note` 写回卡正文，pending 直接改卡文件；注入一律追加在 prompt 尾部（前缀缓存友好，20 条/4000 字符截断）

## 发版提案（release-propose，release-please 形态的触发层）

把 release.md 步骤 1 的「盘点 + 定档 + 草稿」自动化：自动解析上个 tag..develop 的内容提交（conventional 前缀），推 semver 档位（breaking 在 0.x 按惯例走 minor），核对 CHANGELOG「未发布」段找疑似漏记，产出提案文件：

```bash
# 自动定档出提案（纯只读仓库；提案落 .agents/orchestrator/release-proposals/）
node .agents/scripts/orchestrator.mjs release-propose

# 指定版本（校验 semver 与只增不减）
node .agents/scripts/orchestrator.mjs release-propose 1.4.0
```

- 提案含：建议版本与依据、盘点清单（含「待人工归类」的无前缀提交）、CHANGELOG 版本段草稿、版本链接表行、下一步指引。
- **产品/基建分类（用户决策 2026-10-29）**：CHANGELOG 草稿与 semver 档位只认产品侧提交（触碰 `src/**` / `scripts/tray/**` / `scripts/installer.iss` / `package.json` / `package-lock.json` / `sea-config.json` 之一）；仓库基建（agent 工具链 / CI / 开发者文档 / 测试基建 / 开发脚本）单独列「备查」节、不计档位、不写草稿。空提交看不了路径从产品（宁多勿漏，人工收口兜底）。
- **版本号是建议，决定权在人**（发布是不可逆公开动作）：确认后对 agent 说「发布 vX.Y.Z」，走 release.md「代理发布」执行序；本命令不写 CHANGELOG、不提交、不打 tag。
- 产品侧无 feat/fix（其余为基建/文档/杂务）会提示人工裁决是否值得发版；仅基建改动如实报「没有可发布内容」。


## 质量漂移监控（Phase 3）

```bash
# 自动合并健康度报告（统计 revert 信号，失败率超 20% 自动降级全人工）
node .agents/scripts/orchestrator.mjs drift
# 人工确认漂移根因消除后恢复自动合并
node .agents/scripts/orchestrator.mjs drift --clear
```

降级期间 `run` 的 L0/L1 自动合并全部回人工闸门（事件 reason=drift_degraded）。被 revert 的自动合并任务是主要失败信号，`drift` 报告会列出失败任务清单。

- 阈值 workflow.json `driftThreshold` 可调（0<v≤1，缺省 0.2）——**只可调严/调松，不可关闭**：漂移监控没有「不监控」档，非法值回落缺省。

## 多 worker 并行（Phase 3）

```bash
# 最多 3 个任务同时跑；按 files_hint 分区互斥——改动范围可能重叠的任务自动排队
node .agents/scripts/orchestrator.mjs drain --workers 3
```

- 分区规则（保守优先）：`docs/**` 与 `test/**` 可并行；`src/cli.ts` 与 `src/gateway/x.ts` 首段同为 src 会保守串行；裸 `**` 或未声明 hint = 独占
- 想让任务可并行，写任务卡时把 `files_hint` 收窄到独立目录（越窄并发性越好；越宽越可能独占）
- 质量降级（drift）不影响并行调度，只影响合并闸门

## 狗粮对账（reconcile）

```bash
# 全部已合并任务对账（自报账 vs 网关实测账，分歧降序）
node .agents/scripts/orchestrator.mjs reconcile
# 单任务
node .agents/scripts/orchestrator.mjs reconcile <task-id>
```

- **两本账**：自报 = 任务 events 的 budget_snapshot（stream-json 回填）；实测 = 网关转发日志的 usage 字段（网关从上游响应旁路解析，worker 流量过网关才有实测账）
- **分歧率** = |自报 − 实测| / max(两账)；口径含缓存读计入输入。网关零流量会标 ⚠——说明 worker 直连了上游
- 纯只读报告。想让自己的任务可对账，保持 worker 走本机网关（默认即是）
- **启用条件**：workflow.json `gatewayLogDir` 指向网关请求日志目录（支持 `~/` 展开）才启用；未配置 = 用量对账关闭（吃狗粮是走网关的项目才有的能力）。测试隔离沿用 `MODELRDOCK_FAKE_HOME`/`MODELRDOCK_HOME` 重定向，优先于配置值
- **状态对账**（同一命令顺带跑，与用量对账独立）：卡状态 vs git 现实——用 `git log --merges <baseBranch>` 解析 `Merge branch 'feature/<id>'` 得「已合并分支」集合，对照队列各状态目录：
  - 分支已合并但卡不在 merged/ → 列「已合并未落位」（含卡当前状态；状态机被人工旁路，如手工 git merge 后忘了落卡）
  - 卡在 merged/ 但 git 无对应 merge 提交 → 列「账面合并但 git 无实证」（警告级，可能是 squash 合并或改史）
  - 默认只读；`reconcile --fix-states` 把「已合并未落位」的卡落位 merged/ 并写 `state_reconciled` 事件（迁移白名单不允许的状态走直接落位——git 已合并是更高事实）

## 移植（把工具链带去其他项目）

代码零项目专属假设，全部项目数据住在 `.agents/workflow.json`；新项目落地用一键脚本：

```bash
cp -r <模板项目>/.agents .            # 整目录拷贝
node .agents/scripts/agent-init.mjs   # 交互生成 workflow.json + 注册双客户端 hook + AGENTS.md 骨架
# 非交互（agent 代跑）：node .agents/scripts/agent-init.mjs --defaults [--force] [--skip-agents-md]
```

- 派生链：`projectName` 缺省取 package.json name（通知标题、schedule 标识 `com.<slug>.orchestrator-nightly`、Windows 任务名都由它派生）；`scheduleId` 可显式指定以兼容既有注册。
- 受保护端口的「启动监听」拦截正则 = 通用可执行名（node/tsx/npx/npm run）+ workflow.json `listenCommandNames`（项目自备 CLI 名）。
- webhook 通知环境变量 = `${envPrefix}_NIGHTLY_WEBHOOK`（envPrefix 缺省 AGENTS；旧名 `MODELRDOCK_NIGHTLY_WEBHOOK` 永远兼容）。
- 门禁命令：`testCmd` 必配；`buildCmd`/`lintCmd`/`typecheckCmd`/`uiCheckCmd` 配了才跑（lint/typecheck 失败进调试子循环，与 build 同级）。审查会话轮次 `reviewMaxTurns`（缺省 30）。
- **headless worker 的 Bash 红线**（zcode-headless 必需）装一次机器级 dispatcher 即可全项目生效：`cp .agents/hooks/policy-dispatch.mjs ~/.agents/hooks/`，再在用户级 `~/.zcode/cli/config.json` 注册指向它（详见「worker 被什么拦了」）。
- 领域 playbook（add-adapter / add-preset / incident-response / ui-kit 等）是模板项目专属，移植时删除或重写；feature-branch / code-review / docs-sync / worktree-rescue / release / hotfix / orchestrator 通用可留用。

