# 生态与边界 runbook（spec · 发版提案 · feature-branch · 移植）

> 何时读：特性级「先设计后施工」（spec 三件套与 spec review）、发版提案（release-propose）、理解编排闭环与 feature-branch 工作流的关系（claim-before-execute）、把 `.agents/` 工具链移植到其他项目。命令速查见 [orchestrator.md](orchestrator.md)。

## spec（特性级先设计后施工）

`spec "<意图>" [--from-brief <brief-id|topic-id>]` → Planner 产出 requirements（用户故事 + EARS 验收）→ design（现状/方案/取舍/风险）→ tasks（可独立合并的任务段）三件套，落 `specs/<id>/` 人工审阅/手改 → `spec build <id>` 拆卡进队列（幂等；design 全文注入卡背景；tasks 的「文件」行直接成为 files_hint）。**人工闸门在「审设计」这一步**；拆出的卡 gate=L3，开发→测试→审查照走闭环。`spec status <id>` 看跨夜进度锚（progress.json）。`--from-brief <id>` 把调研结论注入设计（上游管线 glue，见 orch-autonomy.md『上游管线』；id 缺失报错指路）：brief id 注入 brief 正文；命中 `topics/<id>.json` 的 topic id 自动按维展开（每 ok 维一节 + 失败维覆盖缺口行，P2 2026-11-09；rollup `unsafe` 一票否决拒绝注入，`undetermined` 提示先 `research verify` 不阻断；brief 与 topic id 可混排）。

## spec review（三件套 agent 分层审查，advisory）

`spec review <id> [--backend <名>] [--model m]`：把「人肉通读三件套找问题」变成「人只裁决 findings 清单」（spec-review-cmd 卡，2026-11-10）。两层：**L0 确定性检查**零 token（三件套齐全/任务段四行/依赖 DAG/files_hint 存在/红线关键词/TBD/基线漂移警告——结构性 fail 直接 die 不烧 L2）；**L2 审查船** readonly 会话按 `.agents/conventions/spec-review.md` 规约五维评分 + findings（现状对账杀手锏：design 引用的代码事实逐个开文件核实）。服务端权威重算 overall（加权 + null 传染 + 定位对账失败降档）与 build_ready（blocked/rework/needs_revision/approve_to_build）。产物 `specs/<id>/review-verdict.json`（spec-verdict/1）+ L3 台账（kind=spec-review）+ 通知。**advisory 纪律：审查结论只做筛查，spec build 拆卡默认人工拍板**（与 research verdict 同哲学；可显式 opt-in 委托超时自动拆卡 `autoApprove.specBuild.enabled=true`——缺省关，blocked/rework 结论开了也永不放行，2026-11-11 巡航修复）。审查船模型解耦：backend 缺省 review.backend、model 缺省 review.model（异构互审）。教训：design「现状」定位一律符号+函数名，行号只作辅助——行号漂移是常态不是事故（规约 §6）。

## release-propose（发版提案）

`release-propose [X.Y.Z]`：盘点上个 tag..develop 的 conventional 提交推 semver 档位（breaking 在 0.x 走 minor）、核对 CHANGELOG「未发布」段、产出提案文件（只认产品侧提交计档，基建单独备查——2026-10-29 用户决策）。**版本号是建议，决定权在人**；确认后说「发布 vX.Y.Z」走 release.md 代理发布，不在本命令范围。

## 与 feature-branch 的关系（claim-before-execute）

orchestrator 完全复用 feature-branch 工作流（start/finish/NOTES.md），worker 编辑被 guard 挡在 worktree 内。人工 agent 的 `feature-branch start` 见队列同 id 卡在 pending/ 即自动认领（抢任务锁 + 卡迁 running/），finish 成功落 merged/——人工侧与闭环共享卡状态，drain 不会误派。同 task-id 人工与闭环混用仍然禁止（锁存活时 start 拒绝）。

## 移植到其他项目

代码零项目专属假设，项目数据全在 `.agents/workflow.json`；体系名 Dockmaster 随 `.agents/` 目录一起带走，无需改代码：

```bash
cp -r <模板项目>/.agents .
node .agents/scripts/agent-init.mjs   # 交互生成 workflow.json + 注册 hook + AGENTS.md 骨架（--defaults 非交互）
```

- 派生链：projectName 缺省取 package.json name（通知标题、调度标识、Windows 任务名都由它派生）。
- 门禁命令：testCmd 必配；buildCmd/lintCmd/typecheckCmd/uiCheckCmd 配了才跑。
- 领域 playbook（add-adapter/add-preset 等）是模板项目专属，移植时删除或重写；feature-branch/code-review/docs-sync/worktree-rescue/release/hotfix/orchestrator 通用可留用。
