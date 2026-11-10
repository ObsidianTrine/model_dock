# TODOLists — 暂缓任务台账（Dockmaster）

> 2026-11-10 专家盘点（来源：2026-11-08~10 编排会话）。每项四要素：**功能 / 暂缓理由 / 重启条件 / 专家结论**。
> 规则：本文件是活文档——重启某项时把它的「重启条件」改成「已重启（日期+卡片）」，做完移入「已销账」。
> 红线提醒：以下任何一项重启都不改变既有红线（8687/8890 不碰、不 push、feature 永不自动提交）。

## 一、建议做（条件已满足，等你点头即开工）

### 1. 调研台账自动降级（L3 观测 → 行动闭环）
- **功能**：research 台账中低核实率 / 多 fail 的调研船模型自动触发降级——后续调研强制人工复核或建议换船（advisory 语义：亮牌不熔断，不硬阻断）
- **暂缓理由**（原定）：等样本积累——重启条件=快照可用性落地 + 台账 ≥15 条且跨 ≥3 主题
- **现状**：**条件已达成**（快照可用性已合；台账 25 条判定，glm-5.3-flash 为主力船）
- **专家结论**：✅ 值得做。四层可信度判定（L0 门禁→L1 快照→L2 逐字/仲裁→L3 台账）只差 L3→行动这最后一步；成本小（assessBrief/verify 路径加策略钩子 + 单测）。建议语义：连续 N 次 fail → 通知 + 标记「该模型调研结果需人工复核」，不做硬熔断（模型漂移可能瞬时）

### 2. codex 重烤覆盖面核对（烤入失联防御）
- **功能**：路由/服务商变更后核对 refreshBakedModelClients 覆盖面——确保烤入客户端（codex/dsh/workbuddy 等模型烙在文件里的）全部跟随重烤，杜绝「烤入模型 ≠ 路由目录」失联（gpt-6-astra 事故的根因面收口）
- **暂缓理由**：P0+P1 已解主痛（catalog + 无头船）；此项属防御性收尾，当前靠「控制台重接激活」人工兜底
- **专家结论**：✅ 值得做（小卡）。建议与 #3 一起做，一张卡两个任务段

## 二、值得做但排后（P2，触发条件明确）

### 3. codex profiles 多路由
- **功能**：attach 时为每条 ModelDock 路由写 `[profiles.<id>]` 进 codex config，`codex -p <id>` 一键切换路由/模型，免控制台往返
- **暂缓理由**：当前单路由钉定够用；切路由习惯走 ModelDock 控制台（控制台是唯一事实源，避免两侧状态漂移）
- **重启条件**：出现频繁切路由需求、或要在 codex 侧自助切换时

### 4. multi-dim sail 集成（feature 提案自动拆维度）
- **功能**：上游管线对 feature 提案自动分解 2-4 个维度并行调研（planner 拆维会话 + 并发池调度）
- **暂缓理由**：显式 `--dim` 已覆盖交互场景；自动拆维每提案多烧一次规划会话，且扩大 sail 自主面（烧钱面）；并发池（并行会话在飞）应先落地观察
- **重启条件**：multi-dim 实战跑过若干主题、并发池合并后，仍有「拆维需求」再议

## 三、观望 / 不做（P3，收益不抵成本或有外部依赖）

### 5. browse 字段改名（如 read_ok）
- **暂缓理由**：verdict.json 契约字段变更，消费方要跟着迁移，收益只是命名更不易误读；`.agents/docs/research-verdict.md` 已写清语义，且无真实误读事故
- **重启条件**：出现真实消费方误读案例

### 6. 飞书卡片批示（双向通知）
- **暂缓理由**：船东定「先维持单向」；双向需公网转发选型（Tailscale Funnel / frp / 云反代）+ verification token 接线，属外部依赖
- **重启条件**：船东明确要双向批示并选定转发方案

### 7. zsearch 用量计数
- **暂缓理由**：MCP 响应加 ~10 行遥测的小事，但 100 次搜索资源包近耗尽，计数价值随包耗尽降低
- **重启条件**：续购 / 继续使用资源包时顺手做

### 8. codex researcher 联网检索
- **暂缓理由**：小米 token plan 上游拒收独立 web_search 工具类型（400 实测）——上游能力面问题，代码侧无解；codex 船当前只胜任 worker/reviewer（离线）
- **重启条件**：换支持 web_search 工具的上游，或小米开放该工具

## 四、待用户动作（非 agent 任务）

### 9. codex 激活
控制台对 codex 做一次「重接/刷新」→ 自动生成 /model catalog + 烤回路由正确默认模型（清除 gpt-6-astra 误选遗留）。

### 10. push 远程决策
本地 develop 已堆多会话合并（codex catalog、research multi、verdict 仲裁、push 门禁等）均未 push；何时推由船东定（push 门禁已就位：push-review 工件 + AGENTS_ALLOW_PUSH 人工旁路）。

## 五、历史规格处置（5 分钟小清理）

### 11. specs/ai-pipeline-guide、specs/perf-residual-cleanup
- **现状**：三件套已落盘但从未 build（无 progress.json），滞留待人审
- **专家结论**：值得一次快速处置——人审后 `spec build`，或确认过时直接归档移出 specs/；别让死规格占着 id 池

## 已销账（原暂缓项 → 已由工作闭环）

| 原暂缓项 | 闭环 |
|---|---|
| L2 逐字失败自动重试 + [n] 引用豁免 | research-verbatim-precision 三任务全 merged |
| 日期误报（发布时间≠事件时间）处置 | 联网仲裁轮 merged（upheld 翻案制）+ strong_support 观测指标 |
| research multi 多维调研 | 0486201 merged（topic 复合清单 + rollup + 失败隔离） |
| codex /model catalog + 无头船 + 直连守卫 | bf969f3 merged（codex-catalog-ship） |
| 台账按调研船记账 | 已实现（ledger researcher_model 字段） |
| 评测集补录「发布时间≠事件时间」案例 | 进行中（agent 补录，2026-11-10 派工） |
