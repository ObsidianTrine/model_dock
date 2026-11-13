# 客户端接入触达的配置键参考（attach 改动清单）

> 用途：一览 ModelDock 接入（attach/切模式/detach）会**读、写、删**客户端配置文件里的哪些键——排查「接入后行为不对」时先对照本页，也作为后续新增客户端适配器时的清单模板。
> 维护约定：
> 1. **以代码为准**：本文按 2026-11-04 develop（9646298）逐个核对适配器实码整理——claude-code 补录 1.6.0 起网关模式补写的两枚 `CLAUDE_CODE_DISABLE_*` 键、9 个内置客户端契约节全部补齐（承接 2026-11-03 bac930b 接管清理 + 301b66c modelPicker 版本门控的整理）；2026-11-13 对照实码补齐 Codex 11-09 / 11-11 两波新增键（`model_catalog_json` / `web_search` / `[profiles.*]` / 窗口键），并把各节 detach 匹配口径改写为与 `oursEntryUrl` 实现一致；适配器实现调整后请同步本页，行号不写（会漂移），写分支/条件名。
> 2. 每个客户端一节；新接入客户端按 Claude Code 节的表式模板补节。
> 3. 「清除」列的条件口径务必写清（无条件 / 旧上游接管时 / takeoverModels 让位），这是最容易踩坑的部分。

## 通用原则（所有客户端）

- **只动接入必需的键**：凭据、端点、模型选择相关的 ModelDock 自写入/自注入键；用户自有配置（权限、主题、输出限制等）一律保留。
- **写盘前自动快照**：接入前状态可用 `modeldock restore`（或控制台断开还原）整体还原。
- **幂等**：重复接入内容无变化时零写盘、零快照。
- **历史注入物只按我们自己的值精确识别后清除**（如带 ModelDock 标记的 modelPicker、精确比对的白名单值），用户自己配的同名键不动。
- **detach 的「是我们写的」条目匹配（oursEntryUrl）**：zcode / dsh / codex / provider-json 工厂（OpenCode、MiMo Code、MiMo 桌面端）/ claude-code 的条件统一是——条目 URL 的 **origin** 与接入时登记的 `gateway_base` 一致。`gateway_base` 恒为本机回环网关 `http://127.0.0.1:<端口>`（**直连接入也登记网关地址，直连地址不参与该匹配**）；唯一例外是 WorkBuddy，额外接受等于登记 `direct_base` 的直连条目。未登记 `gateway_base` 的旧版接入回退回环启发式（URL 指向 127.x / ::1 / localhost 即认）。直连写入的条目在 detach 时由接入快照还原收回（detach = 先还原最近一次接入前快照，再跑残留清理兜底）——残留清理这一步只认网关地址（WorkBuddy 直连条目除外）。

---

## Claude Code（`~/.claude/settings.json`）

来源：`src/adapters/claude-code.ts`（planAttach / planDetach）。

### 网关模式 attach

**写入 / 替换：**

| 键 | 写入值 | 说明 |
|---|---|---|
| `env.ANTHROPIC_BASE_URL` | `http://127.0.0.1:<端口>` | 网关地址（生产 8687 / 实例实际端口） |
| `env.ANTHROPIC_AUTH_TOKEN` | `mdk_claude_code_*` | 网关 token（接入时生成，登记进 config.toml） |
| `env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` | `'1'` | **仅缺失时补写（`??=` 口径，1.6.0 起）**：关自动更新 / 遥测 / 错误上报 / feature-flag 拉取等旁路流量——网关托管客户端不需要。用户已设任何值（含 `0`/`false`）一律尊重、不覆盖：官方语义置 0/false 也视为禁用、须 unset 才恢复，故只在缺失时补 |
| `env.CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT` | `'1'` | **仅缺失时补写（`??=` 口径，1.6.0 起）**：关「未知模型按内置假定窗口（200k）强制压实」——防网关路由的第三方大上下文模型被过早截断（`[1m]` 等已识别变体不受此开关影响）。已有值一律尊重 |
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

**注意**：上方两枚 `??=` 补写的 `CLAUDE_CODE_DISABLE_*` 键 **detach 与切直连都不清除**——它们是客户端自身的合法设置键，补写后留在 settings.json 继续生效（正是补写的目的）；要撤销请手动删除，或用接入前快照整体还原。

### 从不触碰（保留示例）

`CLAUDE_CODE_MAX_OUTPUT_TOKENS`、`ANTHROPIC_CUSTOM_HEADERS`、`apiKeyHelper` 相关、`permissions`、`alwaysThinkingEnabled`、根级 `effortLevel`、`autoUpdatesChannel`、`theme` 及其他一切未列出的键。

> 勘误（2026-11-04）：`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` 曾误列于本清单——1.6.0 起网关模式 attach 会按上方写入表 `??=` 补写它，已移出。

> 注意区分：根级 `effortLevel`（Claude Code 自身设置键）与 env 层 `CLAUDE_CODE_EFFORT_LEVEL`（直连调优键）——前者从不触碰，后者按上表处理。

---

## ZCode（`~/.zcode/v2/provider_config.json`，旧版残留清 `~/.zcode/v2/config.json`）

来源：`src/adapters/zcode.ts`。**不读写任何环境变量**，全部改动在个人供应商配置 JSON 内。ZCode 对该文件做严格校验（任一条目字段非法会被整份丢弃、界面一条自定义供应商都不显示），适配器写值后有同源自检、坏条目会点名提示。

### attach 写入 / 替换（幂等：先按 providerId 摘除旧 modeldock 条目再写）

| 键 | 写入值 | 说明 |
|---|---|---|
| `config.providerConfigRules.providerRules[*]`（providerId=`modeldock`） | `providerName='ModelDock'` + `config.group='standard-personal'` / `config.access={type:'api-key', apiKey:<token>}` / `config.api={type:<协议枚举>, baseUrl:<端点>}` | 网关模式 token=网关令牌、baseUrl=网关地址（按当前路由服务协议取形态）；直连写上游真实 Key 与对应协议端点。api.type 是 ZCode 自己的枚举（anthropic-messages / openai-chat-completions / openai-responses），写错一个值整份配置被拒 |
| 同条目 `config.personalModelIds` / `config.modelOrder` | 当前路由的模型 ID 列表（目录序） | 空目录不写 |
| `config.modelConfigRules.manualProviderModelRules[*]`（providerId=`modeldock`） | 逐模型手动规则（上下文窗口 / 输入格式 / 推理档位 / 输出上限） | 同时清掉与本次写入同 model 的 modeldock 智能规则（`providerModelRules`）——ZCode 拒绝同一模型同时声明两种规则；其他模型的智能选择原样保留 |
| `config.providerOrder`（仅当已是数组） | 追加 `modeldock`（先摘旧项） | 非数组时不动 |

### 无条件清除（attach）

`~/.zcode/v2/config.json`（旧版存储）里 ModelDock 历史版本写入的 `provider['builtin:modeldock']` 条目——新版 ZCode 迁移时跳过 `builtin:*` 前缀、该条目永远不会显示，只作清理。用户自己的条目一律不动。

### detach（条件：条目 `api.baseUrl` 经 oursEntryUrl 比对通过——匹配口径见「通用原则」，只认登记的网关地址 origin，直连地址不参与）

删 providerRules 的 modeldock 条目、manual/smart 模型规则里 providerId=`modeldock` 的全部规则、providerOrder 里的 `modeldock` 项、旧版 `builtin:modeldock`。用户其他供应商与其余字段不动。

### 从不触碰

用户自己的个人供应商条目与模型规则、既有 providerOrder 顺序、schemaVersion 等其余字段；所有环境变量。

---

## dsh（`~/.dsh/settings.yaml` 或 `profiles/<名>/cordis.patch.yml` + `~/.dsh/.credentials.yaml`）

来源：`src/adapters/dsh.ts`。**不读写任何环境变量**——token 经 `apiKeyEnv` 间接引用、落在独立凭据文件。YAML 经 Document API 改写，保留注释与排版。

### attach 写入 / 替换（幂等；旧/新布局按存在性选择，可 `--client-profile` 限定 desktop/web）

| 键 | 写入值 | 说明 |
|---|---|---|
| `llm-pi-ai.providers.modeldock`（旧布局）/ `id=llm-pi-ai` patch 条目的 `config.providers.modeldock`（新布局 cordis.patch.yml） | `{api, baseURL, apiKeyEnv:'MODELDOCK_TOKEN', models:[…]}` | api/baseURL 按协议：网关模式跟随当前路由服务协议，直连写上游对应协议端点；models 按当前路由模型目录逐模型写（id / name / contextWindow / maxTokens / reasoningEfforts 低中高三档 / 视觉 input 声明）；既有 provider 条目不动 |
| `agent-default-model`（仅 `--set-default`） | `{provider:'modeldock', model:<profile.default_model>}` | 无 default_model 时跳过、不猜占位值 |
| `~/.dsh/.credentials.yaml` 的 `refs.MODELDOCK_TOKEN` | 网关 token（直连写上游真实 Key） | 顶层 `version` 缺失时补 `1`（新版凭据格式必需、缺失会拒载）；已有 version 不覆写 |

### detach（条件：provider 条目 `baseURL` oursEntryUrl 比对通过——匹配口径见「通用原则」，只认登记的网关地址 origin）

删 modeldock provider 条目（空 providers 表 / 空 patch 条目顺带收敛）；`agent-default-model` 仅当其 `provider === 'modeldock'` 时删除；credentials 删 `refs.MODELDOCK_TOKEN` 与旧拼写 `refs.MODELRDOCK_TOKEN`（<0.3.1）——凭据清理独立于 provider 比对，patch 全净但 ref 残留时同样清。

### 从不触碰

用户既有 provider 条目、其余 refs 与 shell 环境；所有环境变量。

---

## Codex（`~/.codex/config.toml`）

来源：`src/adapters/codex.ts`。**不写任何环境变量**——令牌内联在 `http_headers.Authorization`（任何终端 / IDE 直接可用）。旧版曾往 shell rc 写 `MODELDOCK_CODEX_TOKEN`，现只在 detach 清残留。

### attach 写入 / 替换

| 键 | 写入值 | 说明 |
|---|---|---|
| `model_providers.modeldock` | `{name:'ModelDock', base_url, http_headers:{Authorization:'Bearer <token>'}, wire_api:'responses'}` | 网关写 OpenAI 形态网关地址 + 网关 token；直连写上游 responses 端点（未配置回退 base_url 并提示；Anthropic 协议端点结构性不可直连，attach 直接报错）。TOML 整包重写会丢注释（含注释时提示，快照可还原） |
| `model_provider`（仅 `--set-default`） | `'modeldock'` | 未加则不切默认 provider |
| `model`（仅 `--set-default` 且 profile 有 default_model） | 默认模型 ID | — |
| `model_context_window` / `model_max_output_tokens`（仅 `--set-default` 且解析出对应元数据） | 默认模型的上下文窗口 / 最大输出 | 根级键作用于当前激活模型（Codex 对不在其内置表的模型按假定窗口处理）；路由切换重烙跟随更新 |
| `model_catalog_json`（网关模式且当前路由服务商有模型目录；**与 --set-default 无关**） | `~/.modeldock/codex-catalog.json`（指针；目录文件由 ModelDock 按 /model 选择器机制投影路由服务商模型目录生成） | 用户已自设他值时尊重不覆盖；目录空 fail-open 不写 |
| `web_search`（同 `model_catalog_json` 条件，仅缺省时补） | `'disabled'` | 多数非 OpenAI 上游对独立 web_search 工具类型直接 400（小米官方模板同款缺省）；用户显式值不动 |
| `profiles.<路由 ID>`（全部 ModelDock 路由；**与 --set-default 无关**） | `{model_provider:'modeldock', model:<该路由 default_model>}` | `codex -p <id>` 一键切路由免控制台往返；default_model 不在该路由服务商目录内不写；同名 profile 已被用户自设（model_provider 非 modeldock）跳过不覆盖并点名 |

### detach（条件：`model_providers.modeldock.base_url` oursEntryUrl 比对通过——匹配口径见「通用原则」）

删 `model_providers.modeldock`；根 `model_provider === 'modeldock'` 时再删 `model_provider` / `model_context_window` / `model_max_output_tokens`（窗口键随 `--set-default` 的路由接管写入，仅在路由仍由我们接管时收回）。以下三处**无论是否 `--set-default` 接入都收回**（attach 写入同样不受 setDefault 门控）：`model_catalog_json` 仅当仍指向 `~/.modeldock/codex-catalog.json`（用户自设他值不动）；`web_search` 仅当值仍是我们补写的缺省 `'disabled'`（用户改过的其他值不动；用户显式配的 `'disabled'` 与补写值无法区分，一并收回，接入前快照可 restore）；`[profiles.*]` 仅收 `model_provider === 'modeldock'` 的条目（用户自设保留），收空连根删。另扫 `.zshrc` / `.zprofile` / `.bashrc` / `.bash_profile` / `.profile` 清旧版哨兵段（`# >>> modeldock codex env >>>` … `# <<< modeldock codex env <<<`）——哨兵是 ModelDock 自己的标记，全量扫描幂等且安全。

### 从不触碰

用户其他 model_providers 条目、用户自设的 profiles 条目 / model_catalog_json / web_search 值、其余 TOML 字段（注释除外——重写即丢，见上）；不新增任何环境变量。

---

## OpenCode（`~/.config/opencode/opencode.json`）

来源：`src/adapters/opencode.ts`（provider-json 工厂）。**不读写任何环境变量**。

### attach 写入 / 替换

| 键 | 写入值 | 说明 |
|---|---|---|
| `provider.modeldock` | `{npm:'@ai-sdk/openai-compatible', name:'ModelDock', options:{baseURL, apiKey}}` | 网关写 OpenAI 兼容 `/v1` 地址 + 网关 token；直连写上游 openai 端点 + 真实 Key。JSONC 注释在重写为标准 JSON 时丢失（含注释时提示，快照可还原） |
| `model`（仅 `--set-default` 且 profile 有 default_model） | `'modeldock/<default_model>'` | 无 default_model 不写、不猜占位值 |

### detach（条件：`provider.modeldock.options.baseURL` oursEntryUrl 比对通过——匹配口径见「通用原则」，只认登记的网关地址 origin）

删 `provider.modeldock`（provider 表因此为空则连根删）；根 `model` 以 `modeldock/` 开头时删。用户其他 provider 不动。

### 从不触碰

用户其他 provider 条目与其余字段；所有环境变量。

---

## MiMo Code（`~/.config/mimocode/mimocode.jsonc` 等）

来源：`src/adapters/mimo-code.ts`（与 OpenCode 同一 provider-json 工厂）。**不读写任何环境变量**。

- 配置候选（首个存在者生效，都不存在时第一个为新建目标）：`$MIMOCODE_HOME/config/mimocode.jsonc|.json` → `~/.config/mimocode/mimocode.jsonc|.json` →（Windows 兜底）`%LOCALAPPDATA%\mimocode\mimocode.jsonc|.json`。
- **写入 / 清除契约与 OpenCode 节完全一致**（`provider.modeldock` 的 npm/name/options.baseURL/apiKey + `--set-default` 的根 `model`），差异是 `declareModels`：attach 另写 `provider.modeldock.models`（每模型 `{name, limit:{context,output}, attachment, modalities}`——上下文与输出缺任一则整段不写、能力未知不声明）与 `provider.modeldock.only_configured_models=true`（MiMoCode 不声明模型就不列出）。
- detach 同 OpenCode：`options.baseURL` oursEntryUrl 比对通过（匹配口径见「通用原则」）才删 `provider.modeldock`（含 models 声明）与 `modeldock/` 前缀根 model。

---

## MiMo 桌面端（与 MiMo Code 共用同一份配置文件）

来源：`src/adapters/mimo-desktop.ts`。桌面端内嵌 mimocode 引擎、自定义供应商与 CLI **共用 `~/.config/mimocode/mimocode.jsonc`**——写入 / 清除契约与 MiMo Code 节完全一致（同工厂、`declareModels=true`）。差异仅在「已安装」判定：探测 Windows 注册表卸载项 / 常见安装目录 / macOS /Applications（配置目录不随卸载删除，只认配置会把残留误报成已安装），本体缺席时 attach 拒绝写入。

---

## WorkBuddy（`~/.workbuddy-ai/models.json`）

来源：`src/adapters/workbuddy.ts`。**不读写任何环境变量**——token 明文进条目 `apiKey` 字段（应用自身即此格式）。文件支持顶层数组（UI「添加模型」保存格式）与 `{models:[…]}`（手写格式）两种形态，写回保留原形态；`url` 是**完整请求端点**（含 `/chat/completions` 全路径）。候选目录：`$WORKBUDDY_CONFIG_DIR` / `$CODEBUDDY_CONFIG_DIR` → `~/.workbuddy-ai` → `~/.workbuddy`。

### attach 写入 / 替换（幂等）

| 键 | 写入值 | 说明 |
|---|---|---|
| models 数组追加条目 | 每模型 `{id:<模型 ID>, name:<显示名或 ID>, url:<完整端点>, apiKey:<token>}` | 先精确摘除 isOursEntry 旧条目（`url` oursEntryUrl 比对、或等于本 harness 登记的 `direct_base`）再追加；id 与用户自有条目撞名（指向其它端点）时**跳过不覆盖**并逐个点名 |
| `{models:[…]}` 形态的 `availableModels`（仅当已是字符串数组） | 并入本次写入的模型 ID（去重） | 手写对象格式才需要 |

### detach（条件：条目 isOursEntry——`url` oursEntryUrl 比对通过，或等于登记的 `direct_base`；WorkBuddy 是唯一额外匹配直连地址的客户端，其余客户端口径见「通用原则」）

只删我们的条目；`availableModels` 里清掉「已无任何条目引用」的 ID。用户自有条目一律不动（含与本方模型同 ID 的自有条目）。

### 从不触碰

用户自有模型条目、文件其余字段；所有环境变量。

---

## generic-env（不写任何文件）

来源：`src/adapters/generic.ts`。兜底接入：**attach / detach 零写盘、零配置改动**。接入后由用户复制控制台「复制环境变量」或 `eval "$(modeldock env)"` 输出的标准 `ANTHROPIC_*` / `OPENAI_*` 变量（指向网关地址 + 网关 token）填进任意支持自定义端点的客户端；detach 仅提示用户从自己的 shell 配置移除这些变量——ModelDock 不追踪、也不清除用户粘贴出去的副本。
