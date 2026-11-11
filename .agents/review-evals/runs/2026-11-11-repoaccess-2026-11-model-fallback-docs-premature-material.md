# 审查评测 prompt 预览（--dry，共 1 题）

# [dry] 2026-11-model-fallback-docs-premature

下面是一个真实仓库里已合入的改动（提交 dbebff0）。这个 diff 之后补了一个真实 bug 的修复——你的任务：
只读审查这个 diff，找出其中引入或暴露的缺陷（就是后来要发修复的那个，以及其它你能确证的问题）。
== 审查纪律（REVIEW.md）==
# REVIEW.md — 审查纪律（AI 与人工审查者共用）

> 代码所有者维护。审查者（AI bot、子 agent、人）看 PR 前先读这个。
> 保持简短：只写「在这个仓库里什么叫失败」。反复出现的误报/漏报修到这里或对应 lint，不在 PR 里反复争辩。

## 各区域「失败长什么样」

- **网关转发**（src/gateway/）：路由/模型映射错；密钥或 token 出现在日志与错误消息；流式响应中断处理缺失；端口/句柄/子进程泄漏。
- **配置与密钥**（src/config/）：静默丢用户数据；绕过 atomicWrite 直接写盘；secrets 明文外泄或权限过宽。
- **适配器**（src/adapters/）：写坏客户端配置文件（丢注释/丢格式）；detach 冲掉用户自己的改动。
- **更新与安装**（src/update/、scripts/installer.iss）：更新中途留残留进程或半成品文件；强杀误伤无辜进程。
- **测试**（test/）：踩 vitest 隔离雷（跨文件 vi.mock / clearAllMocks）；监听 8687/8890；NTFS 权限断言无平台分支；写死 /tmp 或盘符；收尾在后台任务（同步引擎 tick 等长尾）仍在飞时恢复 env/关闭资源——配置整包写穿真实 home（2026-10-30 realhome 事故，stopSyncEngine 不等在飞 tick）。
- **拆分/搬移类 refactor**（目录+shim、模板抽纯模块——T04/T05/T22/T23/T24 同款）：
  静态门禁与生成脚本按**文件路径**读源（ui-lint 令牌扫描、gen-ui-min 等），文件搬家后扫描面没跟着走——表现为门禁必红（令牌缺失/白名单陈旧）或更糟的静默漏检；
  搬移函数被跨模块引用时的**接线**遗漏（原非 export 的函数被 import、re-export 没保住旧 import 路径，调用点零改动是验收项）；
  「逐字搬移」红线只约束**内容**（函数体/模板字节级对拍），import/export/路径属**接线**可改——审查者见到 diff 里的接线改动不必拦，见到内容改动必须拦。
- **文档**：与代码行为不一致——「它撒谎」即失败。

## 一票否决红线（出现即 P0）

1. 测试或默认配置出现 8687 / 8890 端口。
2. 硬编码 `~/.modeldock`（必须走 src/util/paths.ts）。
3. 绕过 atomicWrite() 写盘。
4. 使用 import.meta.url（SEA 打包约束，必须走 process.execPath）。
5. 引入 native addon。
6. src/cli.ts 三路分发被破坏。

## 报告纪律

- 只报有把握的真问题：每条给 **文件+行号** 证据，不许按名字猜。
- 风格 / 诊断 / 清理类不报；不是本 PR 引入的问题标 **[存量]**。
- 同类问题一次说全（标明「同类还有 N 处」），不要每轮挤牙膏。
- 顶层评论以「发现 N 个问题」开头；N=0 明说通过，不凑数。
- 每条发现先自行验证（读文件确认行号与代码属实）再报，相当于「投票前先自证」。

## 跳过路径（生成物与锁文件，不审）

`src/gateway/ui-minified.ts`、`src/providers/catalog-snapshot.generated.ts`、`dist/`、`release/`、`coverage/`、`package-lock.json`。

## 分级提示

PR 的风险档位由 `scripts/pr-risk-tier.mjs` 按改动文件自动判定（risk:* label）：
低=文档/模板类，中=常规源码，高=网关核心/密钥/CI/发布面（规则见 `.agents/workflow.json` corePaths/releasePaths）。
高风险 PR 的发现逐条都要有把握——漏报一条的代价比多报一条高。


== 待审改动 ==
### 改动 diff：CHANGELOG.md（提交 dbebff0）

```diff
commit dbebff06fac38e2975c75ec1d6608d685f24a055
Author: ObsidianTrine <antonios.zhou@gmail.com>
Date:   Sun Nov 8 23:34:41 2026 +0800

    feat(gateway): /usage 聚合补 tokens_by_model per-model 四桶 + 模型级容灾对外文档
    
    - logs.ts：UsageSummary 新增可选 tokens_by_model（input/output/cache_read/cache_creation 按模型分桶）——与全局 tokens 同口径（成功且有 usage），条目缺 model（极老日志）跳过不记账；共享累加器使流式路径（summarizeUsageDays）与 /usage 端点天然带出新字段，零接线改动
    - test/usage-cost.test.ts：+3 用例（多模型分桶与全局桶互不影响 / 缺 model 跳过且不落 (unknown) / 旧 Summary 无此键仍合法）；usage-cost+observability+state-gaps+docs-lint 组合 73 例全绿（isolate:false 单 fork 防跨文件假红）
    - CHANGELOG：补建 [未发布] 段（原无未发布段，按 docs-writing 模板惯例）加模型级容灾条目；docs/en/CHANGELOG.md 镜像 [Unreleased]
    - README + docs/en/README：核心能力「自动兜底与定时路由」行扩展；「日常使用」末尾新小节——三要素（同服务商内仅额度类错误触发 / 价格闸门双向 5% 写入口校验 / 未映射模型永不触发）+ config.toml 示例 + modeldock model list 一行
    - orchestrator.md B5 风暴闸补交互说明：model_fallback 服务吸收额度类错误 → worker 看不到 402/quota cause → 风暴闸灵敏度下降=有意取舍，编排器零代码改动
    - docs/config-reference、截图、relay/server/cli 等并行属地未触碰（docs-lint 16 例全绿，链接可达）

diff --git a/CHANGELOG.md b/CHANGELOG.md
index 73da042..b685e34 100644
--- a/CHANGELOG.md
+++ b/CHANGELOG.md
@@ -5,6 +5,12 @@
 
 本文件记录 ModelDock 的版本变更。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。
 
+## [未发布]
+
+### 新增
+
+- **模型级容灾**：同一服务商内主力模型额度耗尽时，网关自动改发同服务的备用模型重试，不再一耗尽就把流量切去别家。仅额度耗尽类错误（HTTP 402，或 429 且错误体带额度特征）且该服务的备用服务链都走完才触发；备用模型与主模型单价差须双向 ≤5%（CLI / 控制台写入口校验价格闸门）；**未映射的模型永不触发**——审查、规划等质量敏感角色的模型不会被静默替换。在 config.toml 服务段写 `model_fallback = { "主力模型" = "备用模型" }` 即启用，改完热加载即时生效。
+
 ## [1.7.2] - 2026-11-08
 
 更新预取秒装、请求日志可读性与钉路由协议校验；bigmodel 预设补 Anthropic 端点；托盘检查更新改现查。

```
### 改动 diff：README.md（提交 dbebff0）

```diff
commit dbebff06fac38e2975c75ec1d6608d685f24a055
Author: ObsidianTrine <antonios.zhou@gmail.com>
Date:   Sun Nov 8 23:34:41 2026 +0800

    feat(gateway): /usage 聚合补 tokens_by_model per-model 四桶 + 模型级容灾对外文档
    
    - logs.ts：UsageSummary 新增可选 tokens_by_model（input/output/cache_read/cache_creation 按模型分桶）——与全局 tokens 同口径（成功且有 usage），条目缺 model（极老日志）跳过不记账；共享累加器使流式路径（summarizeUsageDays）与 /usage 端点天然带出新字段，零接线改动
    - test/usage-cost.test.ts：+3 用例（多模型分桶与全局桶互不影响 / 缺 model 跳过且不落 (unknown) / 旧 Summary 无此键仍合法）；usage-cost+observability+state-gaps+docs-lint 组合 73 例全绿（isolate:false 单 fork 防跨文件假红）
    - CHANGELOG：补建 [未发布] 段（原无未发布段，按 docs-writing 模板惯例）加模型级容灾条目；docs/en/CHANGELOG.md 镜像 [Unreleased]
    - README + docs/en/README：核心能力「自动兜底与定时路由」行扩展；「日常使用」末尾新小节——三要素（同服务商内仅额度类错误触发 / 价格闸门双向 5% 写入口校验 / 未映射模型永不触发）+ config.toml 示例 + modeldock model list 一行
    - orchestrator.md B5 风暴闸补交互说明：model_fallback 服务吸收额度类错误 → worker 看不到 402/quota cause → 风暴闸灵敏度下降=有意取舍，编排器零代码改动
    - docs/config-reference、截图、relay/server/cli 等并行属地未触碰（docs-lint 16 例全绿，链接可达）

diff --git a/README.md b/README.md
index a14bc70..59c326e 100644
--- a/README.md
+++ b/README.md
@@ -53,7 +53,7 @@ sequenceDiagram
 | 领域 | 你能得到什么 |
 |------|--------------|
 | **一处切换** | `modeldock profile use <name>` 或控制台点一下，所有已接入客户端即时生效，配置文件零改动 |
-| **自动兜底与定时路由** | 主服务连不上 / 限流 / 额度用完，自动切到其他已启用服务；单个服务可配多把 API Key，被拒的那把自动冷却换下一把；可按时段自动换服务（法定节假日自动识别）；单个客户端可钉定专属服务 / 模型，或切「直连」不经网关 |
+| **自动兜底与定时路由** | 主服务连不上 / 限流 / 额度用完，自动切到其他已启用服务；单个服务可配多把 API Key，被拒的那把自动冷却换下一把；可按时段自动换服务（法定节假日自动识别）；单个客户端可钉定专属服务 / 模型，或切「直连」不经网关；同一服务内可给模型配同价位备用模型，主模型额度耗尽自动改发（模型级容灾） |
 | **密钥安全** | 上游 key 只存本机安全后端（macOS Keychain / Windows DPAPI / Linux Secret Service，无钥匙环时回退机器绑定加密）；客户端配置里只有本地 token，明文存量自动迁移 |
 | **非侵入可回退** | 未 `attach` 前对你现有配置只读不写；写入客户端配置前自动快照，`detach` / `restore` 一键还原 |
 | **常驻可靠** | `gateway install` 开机自启 + 崩溃自动拉起；macOS 菜单栏 / Windows 托盘常驻，关掉控制台窗口网关照跑，「轻量模式」一键只留托盘 |
@@ -132,6 +132,17 @@ modeldock uninstall             # 卸载程序（配置与密钥保留）；--pu
 
 > 中英文界面：命令行输出与报错默认中文，`modeldock --lang en`（加在命令任意位置）切英文；也可设环境变量 `MODELRDOCK_LANG=en` 或在 config.toml 写 `language = "en"` 持久生效；Web 控制台顶栏随时切换，报错等服务端提示同步跟随。
 
+### 模型级容灾（同服务商备用模型）
+
+**主力模型额度耗尽，改发同服务商的备用模型**：主模型额度用完时，网关自动改发同服务里你指定的备用模型重试，而不是整条链路切到别家。边界与保护：仅额度耗尽类错误（HTTP 402，或 429 且错误体带额度特征）且该服务的备用服务链都走完才触发；备用模型与主模型单价差须双向 ≤5%（CLI / 控制台写入口校验价格闸门，config.toml 手编只做形状校验）；**未映射的模型永不触发**——审查、规划等质量敏感角色的模型不会被静默替换。配置示例（改完热加载即时生效）：
+
+```toml
+[providers.acme]
+model_fallback = { "glm-5.3-flash" = "glm-5.2" }   # 主力模型 → 同服务备用模型
+```
+
+模型 ID 以服务目录为准：`modeldock model list <服务id>` 查看；字段说明见[配置参考](docs/config-reference.md)。
+
 ## 文档
 
 | 文档 | 内容 |

```
### 改动 diff：docs/en/CHANGELOG.md（提交 dbebff0）

```diff
commit dbebff06fac38e2975c75ec1d6608d685f24a055
Author: ObsidianTrine <antonios.zhou@gmail.com>
Date:   Sun Nov 8 23:34:41 2026 +0800

    feat(gateway): /usage 聚合补 tokens_by_model per-model 四桶 + 模型级容灾对外文档
    
    - logs.ts：UsageSummary 新增可选 tokens_by_model（input/output/cache_read/cache_creation 按模型分桶）——与全局 tokens 同口径（成功且有 usage），条目缺 model（极老日志）跳过不记账；共享累加器使流式路径（summarizeUsageDays）与 /usage 端点天然带出新字段，零接线改动
    - test/usage-cost.test.ts：+3 用例（多模型分桶与全局桶互不影响 / 缺 model 跳过且不落 (unknown) / 旧 Summary 无此键仍合法）；usage-cost+observability+state-gaps+docs-lint 组合 73 例全绿（isolate:false 单 fork 防跨文件假红）
    - CHANGELOG：补建 [未发布] 段（原无未发布段，按 docs-writing 模板惯例）加模型级容灾条目；docs/en/CHANGELOG.md 镜像 [Unreleased]
    - README + docs/en/README：核心能力「自动兜底与定时路由」行扩展；「日常使用」末尾新小节——三要素（同服务商内仅额度类错误触发 / 价格闸门双向 5% 写入口校验 / 未映射模型永不触发）+ config.toml 示例 + modeldock model list 一行
    - orchestrator.md B5 风暴闸补交互说明：model_fallback 服务吸收额度类错误 → worker 看不到 402/quota cause → 风暴闸灵敏度下降=有意取舍，编排器零代码改动
    - docs/config-reference、截图、relay/server/cli 等并行属地未触碰（docs-lint 16 例全绿，链接可达）

diff --git a/docs/en/CHANGELOG.md b/docs/en/CHANGELOG.md
index 51425e3..c660d8b 100644
--- a/docs/en/CHANGELOG.md
+++ b/docs/en/CHANGELOG.md
@@ -5,6 +5,12 @@
 
 This file records ModelDock's version history. The format follows [Keep a Changelog](https://keepachangelog.com/en-US/1.1.0/).
 
+## [Unreleased]
+
+### Added
+
+- **Model-level failover**: when the primary model inside one provider runs out of quota, the gateway retries on a backup model of the same provider instead of switching the whole route to another provider. Only quota-exhaustion errors trigger it (HTTP 402, or a 429 with a quota-flavored body) and only after the provider's backup chain is exhausted; the backup model's unit prices must stay within ±5% of the primary's on both input and output (enforced by the CLI/console write paths); **unmapped models never trigger**, so quality-sensitive roles such as reviewers and planners are never silently swapped. Enable with `model_fallback = { "primary" = "backup" }` in the service section of config.toml; changes hot-apply immediately.
+
 ## [1.7.2] - 2026-11-08
 
 Update prefetch with one-click second-level installs, readable request logs, and protocol checks before pinning; the bigmodel preset ships with the Anthropic endpoint; the tray "Check for Updates" now checks live.

```
### 改动 diff：docs/en/README.md（提交 dbebff0）

```diff
commit dbebff06fac38e2975c75ec1d6608d685f24a055
Author: ObsidianTrine <antonios.zhou@gmail.com>
Date:   Sun Nov 8 23:34:41 2026 +0800

    feat(gateway): /usage 聚合补 tokens_by_model per-model 四桶 + 模型级容灾对外文档
    
    - logs.ts：UsageSummary 新增可选 tokens_by_model（input/output/cache_read/cache_creation 按模型分桶）——与全局 tokens 同口径（成功且有 usage），条目缺 model（极老日志）跳过不记账；共享累加器使流式路径（summarizeUsageDays）与 /usage 端点天然带出新字段，零接线改动
    - test/usage-cost.test.ts：+3 用例（多模型分桶与全局桶互不影响 / 缺 model 跳过且不落 (unknown) / 旧 Summary 无此键仍合法）；usage-cost+observability+state-gaps+docs-lint 组合 73 例全绿（isolate:false 单 fork 防跨文件假红）
    - CHANGELOG：补建 [未发布] 段（原无未发布段，按 docs-writing 模板惯例）加模型级容灾条目；docs/en/CHANGELOG.md 镜像 [Unreleased]
    - README + docs/en/README：核心能力「自动兜底与定时路由」行扩展；「日常使用」末尾新小节——三要素（同服务商内仅额度类错误触发 / 价格闸门双向 5% 写入口校验 / 未映射模型永不触发）+ config.toml 示例 + modeldock model list 一行
    - orchestrator.md B5 风暴闸补交互说明：model_fallback 服务吸收额度类错误 → worker 看不到 402/quota cause → 风暴闸灵敏度下降=有意取舍，编排器零代码改动
    - docs/config-reference、截图、relay/server/cli 等并行属地未触碰（docs-lint 16 例全绿，链接可达）

diff --git a/docs/en/README.md b/docs/en/README.md
index 384d95c..62cd496 100644
--- a/docs/en/README.md
+++ b/docs/en/README.md
@@ -53,7 +53,7 @@ sequenceDiagram
 | Area | What you get |
 |------|--------------|
 | **Switch in one place** | `modeldock profile use <name>` or one click in the console — every attached client switches instantly, zero config changes |
-| **Failover & scheduled routing** | Primary unreachable / rate-limited / out of quota → traffic auto-fails over to other enabled services; a service can carry multiple API keys — a rejected one cools down and the next takes over; change services by time of day (statutory holidays recognized automatically); pin a per-client service / model, or go "direct" past the gateway |
+| **Failover & scheduled routing** | Primary unreachable / rate-limited / out of quota → traffic auto-fails over to other enabled services; a service can carry multiple API keys — a rejected one cools down and the next takes over; change services by time of day (statutory holidays recognized automatically); pin a per-client service / model, or go "direct" past the gateway; per-model backup models within one provider — when the primary model runs out of quota, retry on the backup (model-level failover) |
 | **Key security** | Upstream keys live only in the local secure backend (macOS Keychain / Windows DPAPI / Linux Secret Service, with machine-bound-encryption fallback when no keyring exists); client configs contain only a local token; existing plaintext keys migrate automatically |
 | **Non-invasive & revertible** | Before `attach`, your existing configs are read-only; every write to a client config is auto-snapshotted, `detach` / `restore` revert in one command |
 | **Always-on** | `gateway install` registers auto-start with crash restart; a permanent macOS menu bar / Windows tray entry keeps the gateway running when the console window closes; "Lightweight mode" collapses everything to the tray |
@@ -132,6 +132,17 @@ modeldock uninstall             # uninstall the program (config & keys kept); --
 
 > Bilingual UI: CLI output and errors are Chinese by default; `modeldock --lang en` (anywhere in the command) switches to English. You can also set `MODELRDOCK_LANG=en`, or write `language = "en"` in config.toml to persist; the Web console toggles in the top bar anytime, and server-side messages such as errors follow along.
 
+### Model-level failover (backup model within the same provider)
+
+**When the primary model runs out of quota, retry on a backup model of the same provider**: instead of switching the whole route to another provider, the gateway retries on the backup model you mapped inside the same service. Boundaries and protections: only quota-exhaustion errors trigger it (HTTP 402, or a 429 with a quota-flavored body) and only after the service's backup chain is exhausted; the backup model's unit prices must stay within ±5% of the primary's on both input and output (the CLI/console write paths enforce the price gate; hand-edited config.toml only gets a shape check); **unmapped models never trigger** — quality-sensitive roles such as reviewers and planners are never silently swapped. Config example (changes hot-apply immediately):
+
+```toml
+[providers.acme]
+model_fallback = { "glm-5.3-flash" = "glm-5.2" }   # primary model → backup model of the same service
+```
+
+Model IDs come from the service catalog: run `modeldock model list <service-id>` to inspect; see the [config reference](config-reference.md) for the field details.
+
 ## Documentation
 
 | Document | Contents |

```
### 改动 diff：src/gateway/state/logs.ts（提交 dbebff0）

```diff
commit dbebff06fac38e2975c75ec1d6608d685f24a055
Author: ObsidianTrine <antonios.zhou@gmail.com>
Date:   Sun Nov 8 23:34:41 2026 +0800

    feat(gateway): /usage 聚合补 tokens_by_model per-model 四桶 + 模型级容灾对外文档
    
    - logs.ts：UsageSummary 新增可选 tokens_by_model（input/output/cache_read/cache_creation 按模型分桶）——与全局 tokens 同口径（成功且有 usage），条目缺 model（极老日志）跳过不记账；共享累加器使流式路径（summarizeUsageDays）与 /usage 端点天然带出新字段，零接线改动
    - test/usage-cost.test.ts：+3 用例（多模型分桶与全局桶互不影响 / 缺 model 跳过且不落 (unknown) / 旧 Summary 无此键仍合法）；usage-cost+observability+state-gaps+docs-lint 组合 73 例全绿（isolate:false 单 fork 防跨文件假红）
    - CHANGELOG：补建 [未发布] 段（原无未发布段，按 docs-writing 模板惯例）加模型级容灾条目；docs/en/CHANGELOG.md 镜像 [Unreleased]
    - README + docs/en/README：核心能力「自动兜底与定时路由」行扩展；「日常使用」末尾新小节——三要素（同服务商内仅额度类错误触发 / 价格闸门双向 5% 写入口校验 / 未映射模型永不触发）+ config.toml 示例 + modeldock model list 一行
    - orchestrator.md B5 风暴闸补交互说明：model_fallback 服务吸收额度类错误 → worker 看不到 402/quota cause → 风暴闸灵敏度下降=有意取舍，编排器零代码改动
    - docs/config-reference、截图、relay/server/cli 等并行属地未触碰（docs-lint 16 例全绿，链接可达）

diff --git a/src/gateway/state/logs.ts b/src/gateway/state/logs.ts
index acc06e6..595f615 100644
--- a/src/gateway/state/logs.ts
+++ b/src/gateway/state/logs.ts
@@ -307,6 +307,13 @@ export interface UsageSummary {
   latency: { p50: number | null; p95: number | null; p99: number | null }
   /** 实测用量（成功且有 usage 的条目；缓存读+缓存建计入 input——与 reconcile 对账口径一致） */
   tokens: { input: number; output: number; cache_read: number; cache_creation: number }
+  /** 按 model 分桶的实测用量（与 tokens 同口径：成功且有 usage 的条目；缓存读+缓存建计入
+   *  input_tokens）。可选字段：旧版消费方/旧聚合产物不带此键不破；窗口内条目缺 model 的
+   *  （极老日志）跳过不记账——模型级容灾（model_fallback）的 per-model 观测面。 */
+  tokens_by_model?: Record<
+    string,
+    { input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_creation_tokens: number }
+  >
   /** 可计费口径合计（成功且有 usage 的条目，与 tokens 同口径；剔除缓存读的公式在条目落盘前
    *  已按协议形态算好——此处只求和，绝不重算）。窗口内条目缺该数字的跳过（不入和）。 */
   billable_tokens: number
@@ -330,6 +337,7 @@ export function createUsageAccumulator(priceOf?: PriceResolver) {
   const byModel: Record<string, number> = {}
   const ms: number[] = []
   const tokens = { input: 0, output: 0, cache_read: 0, cache_creation: 0 }
+  const tokensByModel: NonNullable<UsageSummary['tokens_by_model']> = {}
   let billableTokens = 0
   let billablePartial = false
   const cost: UsageCost | null = priceOf ? { total: 0, by_provider: {}, by_model: {} } : null
@@ -355,6 +363,14 @@ export function createUsageAccumulator(priceOf?: PriceResolver) {
           tokens.output += u.output_tokens ?? 0
           tokens.cache_read += u.cache_read_tokens ?? 0
           tokens.cache_creation += u.cache_creation_tokens ?? 0
+          // per-model 四桶与全局 tokens 同口径累加；条目缺 model（极老日志）跳过不记账
+          if (e.model) {
+            const tm = (tokensByModel[e.model] ??= { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 })
+            tm.input_tokens += (u.input_tokens ?? 0) + (u.cache_read_tokens ?? 0) + (u.cache_creation_tokens ?? 0)
+            tm.output_tokens += u.output_tokens ?? 0
+            tm.cache_read_tokens += u.cache_read_tokens ?? 0
+            tm.cache_creation_tokens += u.cache_creation_tokens ?? 0
+          }
           // billable 只求和不重算（公式分协议形态，条目落盘前已算好）；缺数字 = 旧版日志 → partial
           const b = u.billable_tokens
           if (typeof b === 'number' && Number.isFinite(b)) billableTokens += b
@@ -386,6 +402,7 @@ export function createUsageAccumulator(priceOf?: PriceResolver) {
         by_model: byModel,
         latency: latencyQuantiles(ms),
         tokens,
+        tokens_by_model: tokensByModel,
         billable_tokens: billableTokens,
         billable_partial: billablePartial,
         cost,

```
== 输出要求 ==
- 顶层结论以「发现 N 个问题」开头；每条给 文件+行号 与证据；没有把握不报。
- 不确定的问题单独放「存疑」一节，说明缺什么证据。
