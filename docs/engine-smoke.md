# 双引擎：执行 / 审查分体

orchestrator 的**执行（worker）**与**审查（reviewer）**是两个独立会话，可分别指定后端与模型家族。命令全貌见 `.agents/workflows/orchestrator.md` 与 `docs/orchestrator-usage.md`。

## 执行（worker）

- `run <task-id> --backend mock|claude-headless|zcode-headless` 指定执行引擎；缺省 claude-headless，retry/resume 沿用上次会话（显式传参可覆盖）。
- 选后端即选模型家族：`claude-headless` 走 Claude Code CLI headless（Claude 家族），`zcode-headless` 走 ZCode CLI headless（GLM 家族）；`mock` 只用于测试闭环本身，秒级不烧钱。
- zcode 执行的两个前提：桌面版不装 PATH 命令时设 `ORCH_ZCODE_CLI=<zcode.cjs 绝对路径>`；红线裁决需在**用户级** `~/.zcode/cli/config.json` 注册 `policy-zcode.mjs` hook（项目级注册 headless 下不生效）。
- zcode 执行的差异：无 `--max-turns`（轮次熔断不可用，wall-clock/token 熔断兜底杀进程树）；prompt 经 argv 传递，超 30000 字符快速失败，这类任务改用 claude-headless（stdin 无此限制）。

## 审查（reviewer）

- `--review-backend <name|same>` 为审查单独指定引擎；不传时按序解析：显式指定 > 任务上次 `review_spawned` 事件（retry/resume 不换审查引擎）> **自动异构**（worker 为真实后端时自动选另一个 CLI 可用的真实引擎）> 回落同源并记 `review_backend_fallback` 事件。
- 去相关的关键是**引擎异源**（不同模型家族无共同盲区）；只拆会话不换引擎，审查与执行仍有共同盲区。`same` 可强制回同源。
- reviewer 一律是只读会话：claude 侧白名单收敛为 `Read/Glob/Grep`；zcode 侧 `plan` 模式 + 整工具禁用双保险。

## 冒烟验证

2026-10-25 双引擎冒烟（本任务即实证）：worker = zcode-headless（GLM），reviewer = claude-headless（Opus）——异源互审组合全链路跑通。
