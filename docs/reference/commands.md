# CLI 命令参考（commands）

**简体中文** ｜ [English](../en/reference/commands.md)
<!-- i18n-slot：新增语言时在上一行末尾追加链接（如 ｜ [日本語](ja/commands.md)），约定见 .agents/conventions/docs-writing.md -->

> 全部 CLI 命令与用途速查。与 [config-reference.md](./config-reference.md)（脚本生成）不同，本表**手工维护**——命令面以 `src/cli/index.ts` 为准，改命令面时同步本表（后续可仿 config-reference 接生成器）。
> 每条命令的选项细节与示例见 [使用指南 §5](../guide/usage.md)；通用约定（`--yes` 跳过确认、`--json` 结构化输出）适用于多数命令。

## 初始化与配置

| 命令 | 用途 |
|---|---|
| `init [--yes]` | 首启向导：检测 → 收编存量 → 预设选服务 → 起网关 → 接入客户端 |
| `import --from all\|cc-switch\|claude\|dsh\|zcode\|… [--yes] [--no-with-profiles]` | 只读收编本机存量配置（原软件不动） |
| `config edit` | `$EDITOR` 直编 config.toml，保存校验 |
| `config export` / `config import <file>` | 导出 / 导入口令加密配置包（.msync，跨机手动迁移） |
| `config merge <files...> [--stdin-pass] [--yes] [--json]` | 合并多个配置包：同 base_url+同 key 去重，按探针结论给三档建议（保留候选/存疑/失效），勾选后写入；预览零写盘，应用前自动快照 |

## 上游服务与模型

| 命令 | 用途 |
|---|---|
| `provider add [presetId] [--name/--base-url/--protocol/--auth/--key/--key-env/--no-fetch/--yes]` | 添加上游（默认自动拉模型，可建同名 profile） |
| `provider list` / `provider rm <id>` | 列出（脱敏）/ 删除（连带 key 与引用 profile） |
| `provider set-key <id> [--add]` | 换 key 热生效；`--add` 追加进多 Key 池 |
| `model list [pid]` / `model refresh <pid>` | 模型目录查看 / 重新拉取 |
| `model set <pid> <model> [--ctx/--max-out/--display/--cap]` | 编辑模型元数据（上下文 / 最大输出 / 显示名 / 能力） |
| `model fallback <pid> <主力模型> <备用模型>` | 配置模型级容灾映射（价格闸门校验） |
| `model catalog refresh` | models.dev 社区元数据补全 |

## 路由

| 命令 | 用途 |
|---|---|
| `profile add [name] --provider/--model/--aliases/--tier` | 建路由档案（别名支持 `*` 通配；tier 任务等级） |
| `profile use <name>` | 切默认路由（热生效） |
| `profile list` / `profile rm <name>` | 查看 / 删除 |

## 接入与运行期管理

| 命令 | 用途 |
|---|---|
| `attach <harness> [--mode gateway\|file] [--profile] [--set-default] [--takeover-models] [--port] [--yes]` | 接入客户端：diff 预览 → 快照 → 写入 |
| `detach <harness> [--yes]` | 断开并还原（优先整份还原 attach 快照） |
| `token <harness>` | 显示该客户端的本地网关 token |
| `harness route <id> [profile]` | 运行期改路由（写盘前协议兼容校验） |
| `harness direct <id> [profile]` | 切独立直连（救援通道：上游地址 + 真实 key 直写客户端） |
| `harness gateway <id>` | 切回网关模式 |
| `harness restore <harness> [snapshotId] [--list]` | 从快照还原客户端配置 |
| `env` | 输出 generic-env 环境变量（兜底任何读环境变量的客户端） |

## 网关

| 命令 | 用途 |
|---|---|
| `gateway start [--port] [--daemon] [--debug]` | 启动网关（前台 / 后台守护；debug 排障日志） |
| `gateway stop` | 停止目标实例（服务托管时先解除接管防拉锯） |
| `gateway install` / `gateway uninstall` | 注册 / 移除开机自启系统服务 |
| `gateway rotate-token` | 轮换管理令牌（旧登录全部失效） |
| `gateway status` | 网关与实例状态 |
| `gateway log [-n] [-f] [--harness]` | 请求日志（按天 JSONL） |
| `ui` | 打开 Web 控制台（自动携带令牌） |

## 诊断

| 命令 | 用途 |
|---|---|
| `test [profile]` | 经网关对上游发最小流式请求（通不通、慢不慢） |
| `doctor [--deep] [--fix] [--json]` | 体检：`--deep` 真实请求深检、`--fix` 分级修复并自动复核、异常项退出码 1 |
| `status` | 总览表 |
| `mcp list` | MCP 配置只读盘点 |

## 维护

| 命令 | 用途 |
|---|---|
| `adapter list` | 三层适配器与检测状态 |
| `sync setup/status/pause/enroll/resume` / `sync assets list/add/rm` | 多机配置同步（WebDAV / 本地同步盘 / 云端入网）；assets 管文本资产白名单 |
| `update [--check/--yes/--token/--clean/--restore]` | 自更新；`--restore` 一键回退上一版（对换式、零下载） |
| `presets update` | 预设库远程更新（规划中占位，当前随版本发布） |
| `usage` | 用量统计指引（本体见 Web 控制台状态行与管理面 `/_modeldock/usage`） |
| `reset` | 还原全部客户端 → 停网关 → 清配置与密钥（保留快照与日志） |
| `uninstall` | 还原全部 → 停网关 → 删除整个数据目录 |

> Dockmaster 编排器命令族（`sail` / `schedule` / `reconcile` 等）属本仓库开发基建（`.agents/`），不在产品 CLI 范围。
