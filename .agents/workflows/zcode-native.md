# ZCode 原生模式（ZCode-Native）——编排器引擎不可用时的降级开航手册

> **触发时机**：编排器 worker 引擎全部不可用（claude-headless 被网关路由 pin 死 / zcode-headless CLI 无模型旗标报「Select a model」）但需要继续派活/开航时，调度台降级为本模式：**主会话 agent 亲自当调度台，用 ZCode 会话原生 Agent 工具（子代理）当船**。
> 引擎=子代理与主会话同款模型（如 bigmodel start plan 的 GLM-5.3-Flash），零 claude code、零网关依赖。
> 2026-11-09 晨航实证（3 船：2 核实 + 1 真修复合并 develop，全量 1674 绿）。

## 一、与编排器自动闭环的能力对照（哪些环节被什么替代）

| 编排器自动环节 | 原生模式替代 | 风险 |
|---|---|---|
| budget 熔断（50 轮/500k tokens/60min） | 无自动熔断——调度台控制单卡粒度与船数 | 任务写太大易失控，卡必须小 |
| gate L1/L2 分级自动合并/挡回 | 手动验收后 finish 合并；核心路径（corePaths）改动合并时在汇报里显式标注「留审」 | 靠调度台自律 |
| LLM 审查船（reviewer） | 可选：`SendMessage` 另派一只只读船（`--mode plan` 语义：只读报告，禁 Edit/Write）互审 | 省略即无审查 |
| 状态机队列（pending/running/merged） | drafts 卡 + `feature-branch.mjs list` + git log 对账 | 无 watchdog，卡丢失无人管 |
| VDR 事故调查包 | 子代理最终报告 + worktree NOTES.md | 中断需交接时必须落 NOTES.md |
| sail 时间盒 | 无 daemon——调度台在会话内自控时间盒，不适用无人值守长跑 | 需要长跑时先修编排器引擎（钉回 coding-plan / 等 zcode CLI 补 headless 模型旗标） |

## 二、SOP（七步）

1. **对账（防重复派工，2026-11-09 教训）**：写卡/派船前先查 git log 与记忆——批次修复（如三船审查 Top5 拆卡）常已落地而草稿卡未归档。已修的卡在卡头标注 commit，不再派船。
2. **写卡**：沿用编排器任务卡模板（放 `.agents/orchestrator/drafts/<id>.md`，`created_by: scanner`）；验收标准必须可机器检查；文件分区不相交才可并行。
3. **开 worktree**：`node .agents/scripts/feature-branch.mjs start <task-id>`（命令前缀 `export PATH="$HOME/.nvm/versions/node/<v22+>/bin:$PATH"` 修 nvm PATH——shell 默认 node 可能是 v15，编排器/测试都会假死）。
4. **派船（Agent 工具，run_in_background）**：prompt 六件套缺一不可——
   - 卡全文（目标/背景/**原始需求原文逐字**/航次计划/验收标准；主体是专名而非常识实体时，卡里必须附坞长查证结论与来源——坞长自己没查证的先查证再派工，不许把「猜一个占位主体」下放给施工船）
   - worktree 绝对路径（「一切改动限定于此」）
   - 仓库红线：8687/8890 禁令、不 push、不起网关实例、三平台兼容（win32 分支断言）、注释只写 why、原子写走 atomicWrite()
   - 完成动作：worktree 内 commit 命令（含建议 commit message）+ 更新 NOTES.md + 报告格式
   - 排查方向（已掌握的证据/猜想按概率排序给船，并声明「行号可能漂移先 grep 再改」）
   - 测试命令（worktree 内跑相关文件 + 一组跨文件组合回归——vitest `isolate:false` 共享注册表，单独绿≠组合绿）
   - **第 0 条任务理解回执**（2026-11-14 醍醐事故新增）：要求施工船报告开头给出「主体×动作×载体×验收外观」四要素分解复诵；发现卡面与需求矛盾时停船要信息，不许带未申报的假设硬干；**先调研后动工**——卡面查证资料只是起点，施工船须自行检索核验主体典型特征（含「哪些明显不属于它」）；**改造类任务强制残留盘点**（2026-11-15 鹈鹕辫子事故补强）：旧产物元素按「主体固有（保留/修正）/ 无冲突活动配件（可留）/ 旧主体遗留人类特征（清除）」三分类，「卡面说可保留」不豁免主体一致性；**关联内容全量过滤**（2026-11-15 兔子事故补强）：换主体时标题/文案/aria/气泡/注释凡引用旧主体的一律同步更新，grep 旧主体名归零是完成条件
5. **并发上限 2 船/会话**；等待期间不轮询子代理（完成会自动通知），可并行做勘察/盘点。
6. **独立验收（不盲信报告）**：**先核保真度再核质量**——对照原始需求核对交付物主体/行为没有被偷换（同上事故：两层都精致、主体是错的），换主体任务还要全量过滤与主体关联的内容（标题/文案/aria/注释）确认无漏改（兔子事故：验船师只审 diff 触碰面，漏了标题）；再 `git diff develop...HEAD` 抽查 + 本地复跑测试；不绿用 `SendMessage` 打回。核心路径改动逐行看。
7. **收尾**：`finish <task-id>`（同样必带 nvm PATH，自动跑 testCmd 全量）→ 清理核查（worktree/分支/临时文件/进程零残留）→ memory 留档（成果+commit+教训）→ 汇报（改动/测试/commit/燃耗；**最后一行固定提示：已合本地 develop 未 push，是否 push 由用户决定**）。

## 三、硬边界

- 子代理（船）在 prompt 里显式告知：禁 push/npn publish、禁碰 8687/8890、禁改 `.agents/workflow.json`（授权面被调度方改写=2026-11 实证事故型）。
- 调度台自身：不直接 Edit/Write 仓库源代码（走 worktree+船，PreToolUse hook 也拦）；docs/workflows/skill 类非源代码文档在 develop 直改放行。
- 本模式是**降级路径不是替代**：编排器引擎恢复后回归 `sail/drain` 自动闭环（预算熔断、审查门禁、状态机都在那边）。
