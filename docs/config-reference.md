# config.toml 配置参考

**简体中文** ｜ [English](en/config-reference.md)
<!-- i18n-slot：新增语言时在上一行末尾追加链接（如 ｜ [日本語](ja/config-reference.md)），约定见 .agents/conventions/docs-writing.md -->

> `~/.modeldock/config.toml` 是 ModelDock 的主配置文件：模型服务、路由方案、客户端接入与网关行为都在这里，可以直接手编。本页逐项列出全部配置键的**类型、默认值与说明**，并附可直接粘贴的示例；日常操作与命令见[使用指南](usage.md)。

本页由脚本根据程序内置的配置定义自动生成，与代码同源更新；请勿直接编辑本页，发现描述与实际行为不符时以实际行为为准并反馈。
<!-- 由 scripts/gen-config-reference.mjs 生成（键清单源：src/config/types.ts，勿手改）；重新生成：node scripts/gen-config-reference.mjs -->

---

## 读前须知

- **手编入口**：`modeldock config edit` 起编辑器并在保存时校验；网关运行中改动 config.toml 会自动热加载，无需重启。
- **手写注释与排版不会保留**：通过 Web 控制台或命令修改配置时，ModelDock 会重写整个 config.toml，你手写的注释与排版不会保留（配置项本身不丢失）；需要长期保留的备注建议放在别处。<!-- 已知取舍：mutateConfig 整包重序列化（known-issues CORRECT-03 相邻） -->
- **占位符**：键名里的 `<id>` `<model>` `<profile>` `<client>` `<pack>` 是你自己起的条目名；示例取值均为示意。
- **「程序维护」**：该键由 ModelDock 写入与管理，列出仅为完整；误改可由快照还原。

## 1. 全局

作用于整个 ModelDock 的顶层键，直接写在 config.toml 根层级。

| 键 | 类型 | 必填 | 默认值 | 说明 |
|---|---|---|---|---|
| `version` | `number` | 是 | `1`（勿改） | 程序维护。配置格式版本号，随程序升级自动迁移，请勿手改。 |
| `language` | `'zh' \| 'en'` | 否 | `zh` | 界面语言：`zh` 中文、`en` 英文，作用于命令行输出、报错与网关日志消息。命令行 `--lang` 与环境变量 `MODELRDOCK_LANG` 可临时覆盖。 |
| `active_profile` | `string` | 否 | 无（未选定） | 当前生效的路由方案（`[profiles.*]` 里的一个 id），决定「跟随默认路由」的客户端实际走哪个服务。 |

示例：

```toml
version = 1
language = "zh"
active_profile = "ark-coding"
```

## 2. 服务（providers）

每个上游模型服务一段，`<id>` 是你起的服务名（小写字母、数字、下划线）。模型元数据（`models`）见下一节。

| 键 | 类型 | 必填 | 默认值 | 说明 |
|---|---|---|---|---|
| `name` | `string` | 否 | 同 id | 服务显示名，缺省用 id；控制台与列表里展示。 |
| `base_url` | `string` | 是 | — | 上游 API 基地址。 |
| `protocol` | `'anthropic' \| 'openai' \| 'responses'` | 是 | — | 上游接口协议：`anthropic`（Anthropic 兼容）、`openai`（OpenAI 兼容对话接口）、`responses`（OpenAI Responses）。 |
| `auth_style` | `'bearer' \| 'x-api-key'` | 是 | — | 鉴权头风格：`bearer`（`Authorization: Bearer …`）或 `x-api-key`（`x-api-key: …`）。 |
| `key_ref` | `string` | 是 | — | 上游 API Key 的引用：`file:<id>`（本地密钥文件）、`keychain:<id>`（系统钥匙环）、`env:<VAR>`（环境变量）；也可直接写明文，但强烈不建议。 |
| `proxy` | `'direct' \| 'env' \| string` | 否 | `direct` | 出站代理：`direct` 直连；`env` 跟随系统环境变量代理；或写 `http://host:port` 指定代理。 |
| `enabled` | `boolean` | 否 | `true` | 设 `false` 手动下线该服务：不再探测，也不参与自动路由与故障切换。 |
| `priority` | `number` | 否 | `0` | 自动路由候选排序权重，数值大者优先；仅在「程序自动选主」开启时生效。 |
| `endpoints` | `{ anthropic?, openai?, responses? }` | 否 | 无 | 按协议覆盖基地址：同一服务商同时提供 anthropic / openai / responses 多协议端点、供不同客户端直连时使用；未写的协议回落 `base_url`。 |

示例：

```toml
[providers.<id>]
name = "ACME"
base_url = "https://api.acme.com/v1"
protocol = "anthropic"
auth_style = "bearer"
key_ref = "file:acme"
proxy = "direct"
enabled = true
priority = 10
endpoints.openai = "https://api.acme.com/openai"
```

## 3. 模型元数据（models）

每个模型一条，记录展示用元信息；模型实际可用性由上游决定，这里不影响请求。

| 键 | 类型 | 必填 | 默认值 | 说明 |
|---|---|---|---|---|
| `display_name` | `string` | 否 | 同模型 id | 模型显示名，缺省用模型 id。 |
| `context_window` | `number` | 否 | 无 | 输入上下文窗口（tokens），控制台展示用。 |
| `max_output` | `number` | 否 | 无 | 最大输出（tokens）。 |
| `capabilities` | `string[]` | 否 | 无 | 模型能力标签，控制台展示用（如 `tools`、`reasoning`）。 |
| `source` | `'preset' \| 'fetched' \| 'manual'` | 是 | — | 模型来源标记：`preset` 内置预设、`fetched` 从上游目录拉取、`manual` 手动添加（由程序维护）。 |

示例：

```toml
[providers.<id>.models.<model>]
display_name = "Fast Model"
context_window = 131072
max_output = 8192
capabilities = ["tools", "reasoning"]
source = "preset"
```

## 4. 路由方案（profiles）

路由方案 = 走哪个服务 + 默认模型 + 别名映射。客户端的 route 指向一个 profile id，或 `default` 跟随 active_profile。

| 键 | 类型 | 必填 | 默认值 | 说明 |
|---|---|---|---|---|
| `name` | `string` | 否 | 同 id | 路由方案显示名，缺省用 id。 |
| `provider` | `string` | 是 | — | 该路由指向的服务 id（`[providers.*]` 里的一个）。 |
| `default_model` | `string` | 否 | 无（用上游默认） | 请求模型名未命中别名重写时使用的上游模型；不写则用上游自己的默认。 |
| `aliases` | `Record<string, string>` | 否 | 无（不改写模型名） | 请求模型名 → 上游模型名的映射，支持 `*` 通配（如 `"claude-sonnet-*"`）；命中后按映射改写。 |
| `fallback` | `string[]` | 否 | 无（不启用手动备用链） | 手动备用链：主服务不可达时依次尝试。条目为 `"<服务id>"`（透传原模型名）或 `"<服务id>:<模型id>"`（改写为该模型）。 |

示例：

```toml
[profiles.<profile>]
name = "Coding"
provider = "acme"
default_model = "fast-model"
aliases = { "claude-sonnet-*" = "fast-model" }
fallback = ["backup", "backup:slow-model"]
```

## 5. 客户端接入（harness）

每个被接管的客户端一段（`<client>` 为客户端标识，如 claude-code）。接入 / 断开一般用 `modeldock attach` / `detach` 完成，这里用于查看与微调（`mode` / `route` / `token`）。

| 键 | 类型 | 必填 | 默认值 | 说明 |
|---|---|---|---|---|
| `mode` | `'gateway' \| 'file' \| 'direct'` | 是 | — | 接入模式：`gateway` 流量走本地网关；`file` 接管配置文件但客户端自管路由；`direct` 独立直连上游（不经网关）。 |
| `route` | `string` | 否 | `default`（跟随当前路由方案） | 路由指向：`default` 跟随 active_profile；写具体 profile id 则钉死到它；`direct` 模式下为直连目标 profile。 |
| `direct_base` | `string` | 否 | 接入时写入 | 程序维护。`direct` 模式实际写入客户端的直连地址（接入时写入）。 |
| `token` | `string` | 否 | 接入时写入 | 该客户端访问网关用的令牌（接入时写入或指定）。 |
| `attached_at` | `string` | 否 | 接入时写入 | 程序维护。最近接入时间。 |
| `files` | `string[]` | 否 | 接入时写入 | 程序维护。已接管的客户端配置文件列表（断开时据此还原）。 |
| `client_profiles` | `string[]` | 否 | 接入时写入 | 程序维护。接入时选定的客户端自身配置档（如 dsh 的 desktop / web）；模式切换时按此范围重写。 |
| `gateway_base` | `string` | 否 | 接入时写入 | 程序维护。接入时写入的网关地址；断开时据此精确还原，不误删你自己的其他本地代理配置。 |
| `limits.rpm` | `number` | 否 | 不限 | 数据面限流：该客户端每分钟最大请求数，超过返回 429（防失控客户端打爆上游；计数在网关内存，重启清零）。 |
| `limits.daily_tokens` | `number` | 否 | 不限 | 日花费上限：该客户端当日 token 用量（输入含缓存 + 输出）达到即返回 429，次日自动重置。 |

示例：

```toml
[harness.<client>]
mode = "gateway"
route = "default"
# direct_base = "https://api.acme.com/v1"  # 程序维护，无需手改
token = "mdk_..."
# attached_at = "2026-01-01T00:00:00.000Z"  # 程序维护，无需手改
# files = ["~/.claude/settings.json"]  # 程序维护，无需手改
# client_profiles = ["desktop"]  # 程序维护，无需手改
# gateway_base = "http://127.0.0.1:8687"  # 程序维护，无需手改

[harness.<client>.limits]
rpm = 60
daily_tokens = 5000000
```

## 6. 声明式接入包（adapter_packs）

零代码接入新客户端：描述「写哪个文件、写哪些键」，之后 `modeldock attach <pack>` 即可接管。

| 键 | 类型 | 必填 | 默认值 | 说明 |
|---|---|---|---|---|
| `format` | `'json' \| 'toml' \| 'yaml'` | 是 | — | 客户端配置文件格式：`json` / `toml` / `yaml`。 |
| `config_file` | `string` | 是 | — | 客户端配置文件路径（支持 `~`）。 |
| `detect.file_exists` | `boolean` | 否 | 无 | 探测条件（可选）：该文件存在才视为客户端已安装。 |
| `detect.key_path` | `string` | 否 | 无 | 探测条件（可选）：客户端配置里该 JSONPath 能取到值才视为已接入。 |
| `upsert` | `Record<string, string>` | 是 | — | 写入条目：配置路径表达式 → 值模板。模板变量 `{token}` `{port}` `{base_url}` `{base_url_openai}`。 |

示例：

```toml
[adapter_packs.<pack>]
format = "json"
config_file = "~/.config/opencode/opencode.json"
upsert = { "$.provider.modeldock.baseURL" = "{base_url}", "$.provider.modeldock.apiKey" = "{token}" }

[adapter_packs.<pack>.detect]
file_exists = true
key_path = "$.modeldock"
```

## 7. 网关（gateway）

网关监听、超时、日志与故障切换行为。定时切换（schedule）单独见下一节。

| 键 | 类型 | 必填 | 默认值 | 说明 |
|---|---|---|---|---|
| `port` | `number` | 否 | `8687` | 网关监听端口，仅监听本机（127.0.0.1）；被占用自动 +1，并以实际端口写入客户端。 |
| `idle_timeout_ms` | `number` | 否 | `600000`（10 分钟） | 上游数据之间的最长等待间隔（毫秒）：流式回答超过该间隔没有新数据则中断。想容忍更久的停顿（长思考、慢上游）就调大。 |
| `retries` | `number` | 否 | `1` | 上游连接失败时的重试次数（仅连接类错误重试，已发出的请求不重复）。 |
| `headers_timeout_ms` | `number` | 否 | `60000` | 等待上游响应头的时限（毫秒）：非流式长推理可能超过 60 秒才回头，报超时时调大。 |
| `max_body_mb` | `number` | 否 | `16` | 网关缓冲请求体的上限（MB）：模型别名改写需要完整读入请求体，超限返回 413；要发大 PDF / 多附件时上调。 |
| `log_retention_days` | `number` | 否 | `30` | 请求日志按天文件保留的天数：更早的日志文件在网关启动时与每日定时自动删除；`0` = 永不清理。 |
| `auto_failover` | `boolean` | 否 | `false`（关） | 「程序自动选主」开关：开启后按时段 / 优先级 / 实测耗时自动挑选主服务；关闭（默认）= 主服务由人工钉定或默认路由决定。主服务不可达时切备用始终可用，不受此开关影响。 |
| `auto_route_provider` | `string` | 否 | 空（自动） | 人工钉定的主服务 id：设置后路由优先走它（优先于程序自动与定时时段）；留空 = 程序按时段 / 默认路由选主。与控制台「当前」下拉同款。 |
| `failover_status_codes` | `number[]` | 否 | `[]`（不切换） | 响应已开始送达后，仍允许切换备用服务的上游状态码白名单（如 `[429, 503]`）；缺省空 = 已送达的响应原样返回、不切换。 |
| `route_next` | `string` | 否 | 空（自动排序） | 人工钉定的「下一个切换」：主服务不可达时优先切到它（排到备用链首位）；留空按优先级 / 实测耗时自动排序。 |
| `auto_fallback` | `boolean` | 否 | `true`（开） | 「自动备用链」开关：手动备用链之外，自动把其他已启用服务补进切换候选（按定时窗口 / 优先级 / 实测耗时排序，模型名透传）；仅显式 `false` 关闭。 |

示例：

```toml
[gateway]
port = 8687
idle_timeout_ms = 600000
retries = 1
headers_timeout_ms = 60000
max_body_mb = 16
log_retention_days = 30
auto_failover = false
auto_route_provider = "acme"
failover_status_codes = [429, 503]
route_next = "backup"
auto_fallback = true
```

## 8. 定时切换（gateway.schedule）

时段内优先（或避开）某个服务，按本地时钟在每次请求时实时判定；法定节假日由日历数据（holiday-cn）判定。`windows[]` 是时段列表，每个时段一条。

| 键 | 类型 | 必填 | 默认值 | 说明 |
|---|---|---|---|---|
| `enabled` | `boolean` | 否 | `true`（配了时段即生效） | 定时切换总开关：配了时段缺省即生效；设 `false` 临时停用全部时段（配置保留）。 |
| `windows[].start` | `string` | 是 | — | 窗口开始，本地时间 `HH:mm`（含）。 |
| `windows[].end` | `string` | 是 | — | 窗口结束，本地时间 `HH:mm`（不含）；小于 start 表示跨午夜，后半夜归属窗口起始日。 |
| `windows[].target` | `string` | 是 | — | 窗口目标：`"<服务id>"`（透传模型）或 `"<服务id>:<模型id>"`（改写为该模型）。 |
| `windows[].days` | `number[]` | 否 | 全部星期 | 生效星期（1=周一 … 7=周日）；缺省不限；与 `dayFilter` 同时配置时取交集。 |
| `windows[].dayFilter` | `'workday' \| 'weekend' \| 'holiday'` | 否 | 每天 | 按日历日类型生效：`workday` 工作日（周一至五与调休补班日，不含法定假日）、`weekend` 周末、`holiday` 法定假日；缺省每天。节假日数据来自 holiday-cn。 |
| `windows[].mode` | `'prefer' \| 'avoid'` | 否 | `prefer` | 窗口模式：`prefer`（缺省）= 时段内优先走 target；`avoid` = 时段内避开 target 服务（其余服务照常按优先级顺延；仅到服务粒度，模型部分被忽略）。 |

示例：

```toml
[gateway.schedule]
enabled = true

[[gateway.schedule.windows]]
start = "09:00"
end = "18:00"
target = "acme"
days = [1, 2, 3, 4, 5]
dayFilter = "workday"
mode = "prefer"
```

## 9. 手机控制台（lan）

局域网内的手机简版控制台：只读状态 + 快捷切换，与主网关互不影响。

| 键 | 类型 | 必填 | 默认值 | 说明 |
|---|---|---|---|---|
| `enabled` | `boolean` | 否 | `false`（关） | 手机简版控制台开关（默认关）：开启后局域网内的手机可以访问只读状态页并做切换；第二监听器，与主网关互不影响。 |
| `port` | `number` | 否 | `8787` | 手机控制台监听端口；被占用自动 +1。 |

示例：

```toml
[lan]
enabled = true
port = 8787
```

## 10. 密钥存储（security）

API Key 等敏感信息的存放方式。

| 键 | 类型 | 必填 | 默认值 | 说明 |
|---|---|---|---|---|
| `store` | `'file' \| 'keychain'` | 否 | 按平台自动 | 密钥存储后端：`file`（本地文件；Windows 为系统级加密）/ `keychain`（系统钥匙环）。缺省按平台自动选择（macOS 钥匙环、Windows 加密文件、Linux 系统钥匙环、不可用时回退本地文件）；存量明文密钥会在启动时自动迁移，一般无需手改。 |

示例：

```toml
[security]
store = "file"
```

## 11. 快照（backup）

每次改动配置或接入 / 断开客户端前，ModelDock 会自动留一份快照供还原。

| 键 | 类型 | 必填 | 默认值 | 说明 |
|---|---|---|---|---|
| `keep` | `number` | 否 | `20` | 每次改动前的自动快照滚动保留份数（最小 1）：超出后最旧的自动清除。 |

示例：

```toml
[backup]
keep = 20
```

## 12. 自动更新（update）

新版本检查与下载安装的来源。

| 键 | 类型 | 必填 | 默认值 | 说明 |
|---|---|---|---|---|
| `repo` | `string` | 否 | 公开主仓库 | 检查更新的源仓库（owner/name）；默认公开主仓库，改指私有仓库时需配 `token_ref`。 |
| `api_base` | `string` | 否 | GitHub API | 更新源 API 基地址（默认 GitHub API）；自建更新源时覆盖。 |
| `token_ref` | `string` | 否 | 无（匿名访问） | 访问更新源令牌的密钥引用（可选）：私有仓库必需；公开仓库配了可把匿名限流提高到登录额度。令牌本体存密钥库，不进 config 明文。 |
| `mirror` | `string[]` | 否 | 内置镜像链 | 下载镜像前缀列表，按序尝试；`[]` = 关闭镜像只走官方直连；缺省用内置镜像链。校验文件始终走官方源，防镜像篡改。 |

示例：

```toml
[update]
repo = "ObsidianTrine/model_dock"
api_base = "https://api.github.com"
token_ref = "file:github_pat"
mirror = ["https://gh-proxy.com/", "https://ghfast.top/"]
```

## 13. 导入状态（import）

一键导入（存量配置收编）的记忆数据，由程序维护。

| 键 | 类型 | 必填 | 默认值 | 说明 |
|---|---|---|---|---|
| `dismissed` | `string[]` | 否 | 无（程序维护） | 程序维护。一键导入里「暂不导入」过的候选地址：不再重复弹卡提醒；「添加服务 → 勾选导入」的手动入口不受影响。 |

示例：

```toml
[import]
# dismissed = ["https://api.example.com"]  # 程序维护，无需手改
```

## 14. 文本资产同步（sync_assets）

多机同步时随包收敛的白名单目录清单（每台机器自选，清单本身不随包同步）。

| 键 | 类型 | 必填 | 默认值 | 说明 |
|---|---|---|---|---|
| `dirs` | `string[]` | 否 | 无（不随包同步文本资产） | 文本资产同步白名单：这些目录（home 相对路径）里的文本文件随同步包跨机收敛——远端有则写入、相同则跳过、本机多出的绝不删除，改动前自动快照。~/.modeldock 与 node_modules 永不入包，二进制自动跳过（单文件 ≤512KB、总量 ≤4MB、≤200 个文件）。管理命令：modeldock sync assets add / list / rm。 |

示例：

```toml
[sync_assets]
dirs = ["skills"]
```

