# workflow.json 配置键参考（orch-config）

> Dockmaster 编排器的全部配置键（`.agents/workflow.json`，version=1）。**权威源 = 各模块读取代码**（`orchestrator.mjs` 与 `orchestrator/*.mjs`）；本表按域分组并标注缺省语义——改键面前后同步本表。
> 未列出的键不存在；新增键先过设计公理五问（design-orchestrator.md §5），缺省值遵循「危险自动化缺省关」先例。

## 项目与门禁

| 键 | 类型 | 本仓取值 | 语义 |
|---|---|---|---|
| `version` | number | 1 | 配置 schema 版本 |
| `projectName` | string | ModelDock | 项目名（提案/报告文案用） |
| `baseBranch` | string | develop | 基准分支（feature-branch 起点；直改保护对象） |
| `testCmd` | string | `node scripts/test-gate.mjs` | finish/门禁跑的测试命令（L2 域路由） |
| `testCmdL0` | string | `npx vitest run test/docs-lint.test.ts` | 纯文档改动的 L0 门禁 |
| `setupCmd` | string | `npm ci --prefer-offline` | worktree start 后的初始化命令（失败仅告警） |
| `buildCmd` | string | `npm run build` | tsc 门禁 |
| `packageManager` | string | npm | 包管理器 |
| `protectedPorts` | string[] | ["8687","8890"] | 端口红线（worker/policy 硬拦截，**不可删除**） |
| `corePaths` | string[] | cli.ts / gateway 核心 / config / paths | 改动分级 L2 核心路径（永人工闸） |
| `releasePaths` | string[] | .github/workflows / build-sea / build-all | 改动分级 L3 发布流水线（永人工闸） |
| `reviewNotes` | string | 端口/硬编码/atomicWrite/… | 注入 reviewer 的红线提醒文本 |
| `uiCheckCmd` | string | `node scripts/ui-smoke.mjs` | UI 冒烟命令（fastlane ui_check） |

## 后端与模型

| 键 | 类型 | 本仓取值 | 语义 |
|---|---|---|---|
| `worker.{backend,model}` | string | claude-headless / glm-5.3-flash | 执行船引擎与模型 |
| `review.{backend,model}` | string | claude-headless / glm-5.3-flashx | 审查船（缺省自动异构互审防同底座共因盲区） |
| `scan.{smartFilter,smartModel}` | bool,string | true / glm-4.5-air | 巡检提案语义过滤（LLM 去噪） |
| `research.{model,snapshotMax,maxDims,arbitration}` | — | glm-5.3-flash / 24 / 4（缺省）/ 未配=开 | 调研船模型、引用快照上限、多维调研维度上限、联网仲裁轮开关 |
| `propose.{feedback,model}` | bool,string | true / glm-5.3-flash | planner 提案反馈回路 |
| `watchdog.{mode,model}` | string | actuate / glm-4.5-air | 看门狗模式（actuate=可代收尾）与模型 |
| `escalation.{enabled,fallbackBackend}` | bool,string | true / claude-headless | 故障处置升级链（主引擎不可用降级） |
| `dynamicDispatch.{enabled,envelope}` | bool,string[] | true / [zcode-headless, claude-headless] | 动态选船（海况+卡难度在预授权包络内自动选执行船；envelope=允许的引擎白名单） |
| `tiers.<id>.tokenEnv` / `tiers.<id>.workerModel` | string | MDK_TIER_AHEADx_TOKEN | 任务等级档位：独立 token 环境变量与可选模型覆盖 |

## 预算与供给

| 键 | 类型 | 本仓取值 | 语义 |
|---|---|---|---|
| `budgetProfiles.<backend>.max_tokens` | number | 20000000 | 该引擎的默认 token 预算（**可计费口径**，剔除缓存读；任务卡 budget 可逐卡覆盖） |
| `budgetProfiles.<backend>.max_wall_minutes` | number | 150 | 该引擎默认 wall-clock 上限（分钟） |
| `scheduling.maxWorkers` | number | 1 | drain 并发 worker 数（上限受并发上限约束；解锁 2 需实证稳定性） |
| `gatewayAdmin` | bool | true | 编排器可用网关管理面（燃油账价目、metrics 海况、一次性凭据签发） |
| `gatewayProvision` | bool | true | 每任务一次性凭据（ephemeral harness，限时限额、用量独立台账） |
| `gatewayLogDir` | string | ~/.modeldock/logs | 网关日志目录（风暴闸日志扫描兜底数据源） |
| `listenCommandNames` | string[] | ["modeldock","gateway"] | 端口红线识别的监听命令名 |

## 授权与自动化开关（危险自动化缺省关先例）

| 键 | 类型 | 本仓取值 | 语义 |
|---|---|---|---|
| `autopilot.enabled` | bool | true | 自动舵：提案自动提交进队列 |
| `autopilot.autoSubmitTypes` | string[] | ["docs","bugfix","refactor"] | 自动提交白名单卡型（deps/feature/核心·发布路径永不自动） |
| `autopilot.autoDrainPerCycle` | number | 0 | 每周期自动 drain 数 |
| `autopilot.maxProposalsPerCycle` | number | 3 | 每周期提案上限（防连环烧钱） |
| `autoApprove.{enabled,timeoutMinutes,maxAutoRetry}` | — | true / 3 / 1 | 分层审核超时委托（拍板窗口过期的推荐自动执行；限次重试） |
| `autoApprove.specBuild.enabled` | bool | true（本仓已 opt-in） | spec 审查超时自动拆卡（**缺省关**——拆卡人工闸的 opt-in 委托） |
| `upstream.specAutoBuild.enabled` / `upstream.autoPipeline.enabled` | bool | true / true | 上游管线自动段（spec 自动 build / 调研→spec 流水线） |
| `autoResume.enabled` | bool | true | 崩溃任务自动带恢复上下文续做 |
| `configGuard.enabled` | bool | true | workflow.json 自改防护（外部改写期间跳过派发与规划） |
| `draftsGc.{autoSupersede,maxAgeDays,archiveDays}` | — | true / 14（缺省）/ 30 | 提案清退：重叠自动让位 / 零痕迹清退天数 / 归档天数 |
| `scanAutoFix.enabled` | bool | true | 巡检卡自动转修复卡（断链自愈） |
| `weatherHold.enabled` | bool | 未配整键=关；配了缺省 true | 风暴闸：窗口内 worker_retry 合计达 threshold 停派发 |
| `weatherHold.{threshold,windowMinutes}` | number | 3 / 60 | 风暴闸阈值与窗口（分钟） |
| `weatherHold.upstream.{source,threshold,windowMinutes}` | — | metrics / 5 / 60 | 上游海况数据面：metrics 优先（`sea_state.storm` 直通 + 429+quota 计数），admin 不可得自动落回网关日志扫描（fail-open）；`source:"log"` 显式降级仅日志 |

## 观测与通知

| 键 | 类型 | 本仓取值 | 语义 |
|---|---|---|---|
| `notify.keychainService` | string | modeldock-orch-feishu-webhook | webhook 钥匙串服务名（防明文） |
| `notify.digest.{enabled,quietWindowSec}` | bool,number | true / 60 | 聚合通报：静默窗内事件合并成一条扁平事件流（标题 emoji 计数分诊） |
| `testCmd` 家族（上表） | — | — | 门禁命令集中在此文件，编排器零项目专属假设 |

> 移植到其他项目：复制 `.agents/` 后跑 `node .agents/scripts/agent-init.mjs` 交互生成本文件（`--defaults` 非交互）；键语义与本表一致。
