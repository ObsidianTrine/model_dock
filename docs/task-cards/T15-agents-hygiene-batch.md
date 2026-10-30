---
id: agents-hygiene-batch
type: refactor
created_at: 2026-10-29T00:00:00+08:00
created_by: human
files_hint:
  - .agents/hooks/guard-develop.mjs
  - .agents/scripts/policy.mjs
  - .agents/scripts/orchestrator/events.mjs
  - .agents/scripts/orchestrator/backends/claude-headless.mjs
  - .agents/scripts/orchestrator.mjs
  - .agents/scripts/feature-branch.mjs
  - test/orchestrator/**
workflows:
  - feature-branch
gate: L3
---

# 目标
编排器与守卫 hook 的卫生批修：一个 hook 热路径重排、一个 O(n²) 写放大、一个无界日志、一个可挂起的调度缺口、三处死代码/过时注释、一处配置重读收敛、一处门禁段表驱动。全部小改、逐项独立。

**前置：本卡排在 merge-verify-once（T13）、agents-crossplatform-spawn（T14）之后**（同文件域 orchestrator.mjs / feature-branch.mjs，串行避免冲突）。

# 逐项清单（行号基于 2026-10-29 develop，动手前逐处读源码核实）
1. **guard-develop.mjs 执行序重排**（:81-86）：现在无条件先跑 3 个 git 子进程（branch/root/fileRoot），而 policy.mjs 的第一条判断就是「非基准分支放行」，escape hatch 检查（廉价，:86）也排在 git 之后——在 feature worktree 里干活（工作流常态）时后两个 git 纯浪费，实测单次编辑约省 25ms。重排为：escape hatch → 取 branch（单个 git 调用）→ 非基准分支直接 audit+exit → 再取 root/fileRoot 走后续判定。audit 事件字段与决策语义不变（每次放行/拦截仍各一条）。
2. **events.mjs appendEvent O(n²)**（:53-59）：每次 append 经 lastSeq → readEvents 全文件重读重解析；worker 每 turn 两条事件，长任务数百事件。改为模块级 `Map<目录, seq>` 缓存自增（读侧 lastSeq/readEvents 不动，保留崩溃恢复语义）；task-lock 接管陈锁时清一次对应目录的缓存（防同任务跨进程双写 seq 冲突——接管线在 task-lock.mjs）。
3. **audit.jsonl 无界增长**（policy.mjs:269-277 每次 Edit/Write/Bash 追加，已 638KB/2531 行）：按大小轮转——超过 5MB 时 rename 为 `audit.jsonl.1`（只留一代）再新建。先例：orchestrator.mjs NIGHTLY_LOG_MAX 5MB（:1314 附近）。
4. **drain 子进程缺 'error' handler**（orchestrator.mjs:932-937 只挂 exit）：spawn 'error'（ENOENT 等）时 active Map 条目永不清除 → pump 停摆、drain 挂起不退出。补 `child.on('error', ...)`：active.delete + 计数 + log + pump()。
5. **死代码与过时注释**：claude-headless.mjs:77 `newWorkerSettingsPath` 全仓（含 test/）无引用 → 删；feature-branch.mjs:244 `writeNotesStub` 的 base 参数模板未使用 → 删参；orchestrator.mjs:852 注释「每个任务用子进程跑 run --next」与实现（:891-892 父进程选 id 显式传参）不符 → 按实现改写。
6. **policy.mjs workflow.json 重读收敛**：evaluateCommand 单次调用最多 4 次重读（:102 releaseHatches、:144 protectedPorts、:148/:168 listenCommandNames）——入口读一次传参下去，行为不变。
7. **orchestrator.mjs 门禁段表驱动**（:406-508）：五段同构 try/catch（npm_test/tsc_build/lint/typecheck/ui_check）收敛为数据表 + 单个执行函数；每段行为逐字节等价（run → appendEvent → catch GateError → debugIter++ → 熔断 → fixup → continue）；staticGateFailed 标志位（:465 先例）语义保留。此项纯内部重构，重构前后对同一批卡的事件序列必须一致。

# 验收标准
- `npm run test:workflow` 全绿；1/2/4/6 各补一条定向断言（hook 执行序用注入 git 的 fake 验证「非基准分支只调一次 git」；events 缓存断言第二次 append 不再读全文件；drain error 断言 active 清空且 pump 继续；policy 用 fs spy 断言单次 evaluate 只读一次 workflow.json）。
- 门禁表驱动：对覆盖各 gate 类型的一组卡，重构前后 appendEvent 序列逐字节一致（临时对拍脚本或测试证明）。
- `npm test` 全绿。

# 红线
- audit 事件字段与格式不变（消费方兼容）；events.jsonl 行格式不变；轮转只留一代，不引入新配置项。
- 不做 pidAlive/isAlive、resolveCmds/resolveTestCmd 的跨文件去重——feature-branch 零内部依赖是刻意的可移植设计（cp -r .agents 移植约定）。
- guard-develop 重排不得改变任何拦截判定结果。
