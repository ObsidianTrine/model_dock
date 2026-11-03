# 客户端接入触达的配置键参考（attach 改动清单）

> 用途：一览 ModelDock 接入（attach/切模式/detach）会**读、写、删**客户端配置文件里的哪些键——排查「接入后行为不对」时先对照本页，也作为后续新增客户端适配器时的清单模板。
> 维护约定：
> 1. **以代码为准**：本文按 2026-11-03 develop（bac930b 接管清理 + 301b66c modelPicker 版本门控）整理；适配器实现调整后请同步本页，行号不写（会漂移），写分支/条件名。
> 2. 每个客户端一节；新接入客户端按 Claude Code 节的表式模板补节（zcode / dsh / codex / opencode / mimo-code / workbuddy … 逐个补齐）。
> 3. 「清除」列的条件口径务必写清（无条件 / 旧上游接管时 / takeoverModels 让位），这是最容易踩坑的部分。

## 通用原则（所有客户端）

- **只动接入必需的键**：凭据、端点、模型选择相关的 ModelDock 自写入/自注入键；用户自有配置（权限、主题、输出限制等）一律保留。
- **写盘前自动快照**：接入前状态可用 `modeldock restore`（或控制台断开还原）整体还原。
- **幂等**：重复接入内容无变化时零写盘、零快照。
- **历史注入物只按我们自己的值精确识别后清除**（如带 ModelDock 标记的 modelPicker、精确比对的白名单值），用户自己配的同名键不动。

---

## Claude Code（`~/.claude/settings.json`）

来源：`src/adapters/claude-code.ts`（planAttach / planDetach）。

### 网关模式 attach

**写入 / 替换：**

| 键 | 写入值 | 说明 |
|---|---|---|
| `env.ANTHROPIC_BASE_URL` | `http://127.0.0.1:<端口>` | 网关地址（生产 8687 / 实例实际端口） |
| `env.ANTHROPIC_AUTH_TOKEN` | `mdk_claude_code_*` | 网关 token（接入时生成，登记进 config.toml） |
| `modelPicker` | `{ replaceBuiltInOptions: true, options: 当前路由服务目录 }` | **仅 claude ≥ 2.1.243**（官方 changelog：modelPicker 设置 2.1.243 引入）：/model 选择器全量策划，raw ID 直列；全局切服务由 refreshBakedModelClients 自动重烙 |

**版本门控（2026-11-03 起，301b66c + a7ee357）**：attach 时探测 `claude --version`（60s memo）——

- **≥ 2.1.243**：上表 modelPicker 照写。
- **< 2.1.243 或探测失败**：**不写 modelPicker**（升级后重接会清掉此前烙的死键），改用**档位槽机械铺排**（不做能力排序）：服务目录按目录序（Web 端添加/拉取顺序）填 `ANTHROPIC_DEFAULT_OPUS_MODEL` / `_SONNET_` / `_HAIKU_` / `_FABLE_` 四槽——每槽 `_MODEL` = 真实 ID（≥1M 上下文带 `[1m]` 后缀）、`_NAME` = display_name（缺则原 ID）作行标签；槽位不足按末位复用（1 个模型四槽同值），超过 4 个第 5 个起旧版 /model 无行可选。**行上显示的就是真实模型名，用户按名字选用，无需理解档位含义**；Default 行 = profile `default_model`（`env.ANTHROPIC_MODEL`）。这些 env 是 ModelDock 管理的**烙定值**：重复接入 / 路由切换重烙（refreshBakedModelClients 复用 planAttach，门控自然生效）按新路由重铺。note 注明版本与升级指引。
- 探测失败（`--version` 不可得 / 输出不可解析）一律按旧版回退：宁可降级兼容，不假装新版。
- 测试钩子：`MODELRDOCK_FAKE_CLAUDE_CODE_VERSION`（空串 = 模拟探测失败）；`MODELRDOCK_FAKE_CLAUDE_CODE_PRESENT=1` 未指定版本时默认视为现代版本。
- 设计取舍（2026-11-03 讨论）：能力排序（哪个模型配 Opus 档）是人工判断，元数据区分不了 pro 与 flash，故不做排序、不引入优先级字段——档位只是槽位外壳，行名即选用依据（与 Claude Code 自身 `DEFAULT_*_MODEL` 显式映射设计、claude-code-router 角色显式映射同类；LiteLLM/OpenRouter 的元数据也只用于展示排序，不用于推断能力）。

**无条件清除（网关模式）：**

| 键 | 原因 |
|---|---|
| `env.ANTHROPIC_API_KEY` | 网关模式凭据唯一：两凭据并存时客户端可能仍带旧 x-api-key（网关按 token 解析必 401） |
| `env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY` | 早期 discovery 方案注入物（v2.1.296 discovery 硬过滤只认含 claude/anthropic 的 ID，已弃用），防残留生效 |
| `availableModels`（根级，仅当值 = `['anthropic.']`） | 历史白名单注入物，用户自己的名单不动 |
| `modelPicker`（根级，仅当 options 的 description 含 ModelDock 标记） | 我们策划的 lineup 才动，用户自己的 modelPicker 不动 |

**旧上游接管时清除**（条件：`fromMode === 'direct'`（ModelDock 直连切回），**或** 接入前 `ANTHROPIC_BASE_URL` 非本 harness 已登记的网关地址——即用户手配第三方服务首次接入，2026-11-03 bac930b 修复的主场景；已指向本网关的重复接入不清，手动加的映射视为有意）：

| 键 | 说明 |
|---|---|
| `env.ANTHROPIC_MODEL` | env 优先级高于根 model，残留把模型钉死在旧上游 ID 上；`--takeover-models`（CLI）显式开启时不删、改迁入 profile.default_model |
| `env.ANTHROPIC_DEFAULT_OPUS_MODEL` / `_SONNET_` / `_HAIKU_` / `_FABLE_`（及各自 `_NAME`） | 同上；`--takeover-models` 时迁入 profile.aliases |
| `env.ANTHROPIC_SMALL_FAST_MODEL` | 同为模型钉死键，迁移不收它，无条件清 |
| `env.CLAUDE_CODE_SUBAGENT_MODEL` | 子代理钉死键，无条件清（迁移不管） |
| `env.CLAUDE_CODE_EFFORT_LEVEL` | 旧上游调优（直连分支写入值为 max），无条件清 |
| `env.CLAUDE_CODE_AUTO_COMPACT_WINDOW` | 旧上游调优（按 1M 上下文写 786432），无条件清 |
| `model`（根级） | 旧上游的真实 ID 或内置分层别名，都为旧上游而设，无条件清 |

**清掉后模型如何解析**：客户端内置默认分层名（`claude-sonnet-*` 等）→ 网关 `rewriteModel` 按当前路由 `profile.default_model` 兜底改写（`claude-*` 前缀且目录无此 ID 时）；/model 选定的 raw ID 原样透传（本服务目录 ID 上游必认）。**前提：目标 profile 配了 default_model**，否则分层名透传上游会 404。

### 直连模式 attach（差异部分）

| 键 | 写入值 |
|---|---|
| `env.ANTHROPIC_BASE_URL` | 上游真实端点（按协议取 anthropic 端点） |
| `env.ANTHROPIC_AUTH_TOKEN` **或** `env.ANTHROPIC_API_KEY` | 上游真实 Key（按 auth_style 二选一写入，另一种清除） |
| `env.ANTHROPIC_DEFAULT_*_MODEL(+_NAME)` | 仅当 profile 显式配了 `claude-*` 别名时按别名重写（带 [1m] 上下文后缀） |
| `model`（根级） | profile.default_model（无则回落服务目录首个模型；再无则撤掉） |
| `env.CLAUDE_CODE_EFFORT_LEVEL` | `'max'`（直连调优默认值） |
| `env.CLAUDE_CODE_AUTO_COMPACT_WINDOW` | `'786432'` |
| `modelPicker` | 同网关模式同款版本门控（≥ 2.1.243 才写；旧版靠上方根 model + env 映射，行为不变） |

无条件清除：`ANTHROPIC_MODEL`（takeoverModels 时让位迁移）、`ANTHROPIC_SMALL_FAST_MODEL`、`CLAUDE_CODE_SUBAGENT_MODEL`、discovery 开关、网关 lineup（自家 modelPicker）、历史白名单。

### detach / 切直连收回

仅当 `ANTHROPIC_BASE_URL` 是本 harness 接入时登记的 `gateway_base`（精确 origin 比对，未登记的旧接入回退回环启发式）：删 `BASE_URL` / `AUTH_TOKEN` / discovery 开关 / 自家 modelPicker / 历史白名单。模型 env 不在此处理——完整还原靠 attach 快照（detach 默认还原到本次接入前）。

### 从不触碰（保留示例）

`CLAUDE_CODE_MAX_OUTPUT_TOKENS`、`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`、`ANTHROPIC_CUSTOM_HEADERS`、`apiKeyHelper` 相关、`permissions`、`alwaysThinkingEnabled`、根级 `effortLevel`、`autoUpdatesChannel`、`theme` 及其他一切未列出的键。

> 注意区分：根级 `effortLevel`（Claude Code 自身设置键）与 env 层 `CLAUDE_CODE_EFFORT_LEVEL`（直连调优键）——前者从不触碰，后者按上表处理。

---

## 其他客户端（待补）

按接入实现逐个补节，模板照 Claude Code 节（写入 / 无条件清除 / 条件清除 / detach / 从不触碰）。已接入但未整理的：zcode、dsh、codex、opencode、mimo-code、mimo-desktop、workbuddy、generic-env。
