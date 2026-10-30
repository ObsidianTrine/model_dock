---
id: dependabot-preflight
type: refactor
created_at: 2026-10-29T00:00:00+08:00
created_by: human
files_hint:
  - .github/workflows/dependabot-fix.yml
workflows:
  - feature-branch
gate: L3
---

# 目标
dependabot-fix 的 npm ci 与 npm run build 从 Claude 会话回合里移出，改为 workflow 确定性步骤——每个 Dependabot PR 省 2-4 个 Claude 回合（token + 墙钟），安装/构建结果从「模型可能出错的操作」变为确定性产物。

# 背景（行号基于 2026-10-29 develop，动手前核实）
- dependabot-fix.yml:99 prompt 第 2 步要求会话内「npm ci 后跑 npm run build 与完整 npm test」；:108-111 回合预算纪律自述「npm ci/build/test 每轮都很贵」——说明实际发生过多回合反复跑这些命令。
- npm 缓存已在位（:76-79 setup-node `cache: npm`）；会话工具白名单 `Bash(npm:*)` 允许其修复时自行重跑。

# 实施要求
1. claude-code-action 步骤之前加两个 run 步骤：
   - `npm ci --no-audit --no-fund`
   - `npm run build`
   任一失败 job 直接红——语义即「升级破坏构建/安装」，无需会话判断，结论明确且零 token 消耗。
2. prompt 相应改写：原第 2 步改为「依赖已由 workflow 安装、`npm run build` 已通过，直接跑完整 `npm test` 验证」；第 6 步回合预算纪律保留并顺带更新（ci/build 不再占回合，test 仍占）。通读改后 prompt 确认步骤编号、前后引用自洽（无「第 2 步 npm ci」残留）。
3. 工具白名单与 `claude_args` 不变（修复失败重试时会话仍可自行跑 npm 命令）。

# 验收标准
- workflow 语法校验通过；改后 prompt 全文通读一遍无步骤错位。
- 交付说明写明：构建失败时 job 红、不进会话；构建通过时会话从「跑 test」开始。

# 红线
- 不改三件套 secrets/vars 引用（CLAUDE_AUTH_TOKEN / CLAUDE_BASE_URL / CLAUDE_MODEL）、DEPENDABOT_GH_TOKEN（PAT）逻辑、防回环机制（[dependabot-fix] 前缀 + actor=dependabot[bot] 限定）。
- 不动 allowed_bots / base_branch / allowed_tools。
