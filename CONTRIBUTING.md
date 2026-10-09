# 参与贡献

感谢有兴趣为 ModelDock 做贡献！提交 PR 前请先读 [AGENTS.md](AGENTS.md)（工程约定与硬性约束，AI agent 必读）。

## 开发环境

- Node.js >= 22，npm

```bash
git clone https://github.com/ObsidianTrine/model_dock.git
cd model_dock
npm install
```

## 常用命令

| 用例 | 命令 |
|------|------|
| 跑测试 | `npm test`（改完 `src/**` 必须全绿） |
| 编译 | `npm run build` |
| 热跑调试 | `npm run dev -- <cmd>` |
| 本机网关 | `scripts/run_dev.bat`（Win）/ `scripts/run_dev.sh`（mac/Linux） |

## 提交 PR

1. 从 `develop` 拉分支；多 agent 并行开发时用 `node .agents/scripts/feature-branch.mjs start <task-id>`（见 AGENTS.md「多 Agent 并行开发约定」）
2. 改完跑 `npm test`，全绿再交
3. **文档同步**：改了用户可见行为，按 [.agents/conventions/docs-writing.md](.agents/conventions/docs-writing.md) 更新 CHANGELOG / README（用户视角、一条一事）
4. 提交信息说清"改了什么、为什么"（中文即可，加 `feat:` / `fix:` / `docs:` 前缀更佳）
5. 发起 PR，说明改动动机与测试情况

## 报告问题

- bug / 功能建议：用 [issue 模板](https://github.com/ObsidianTrine/model_dock/issues/new/choose)
- **安全漏洞：不要开公开 issue**，见 [SECURITY.md](SECURITY.md)

## 发布

发布流程见 [docs/RELEASE_CHECKLIST.md](docs/RELEASE_CHECKLIST.md)（维护者向）。