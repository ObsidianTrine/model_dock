# 参与贡献

**简体中文** ｜ [English](docs/en/CONTRIBUTING.md)
<!-- i18n-slot：新增语言时在上一行末尾追加链接（如 ｜ [日本語](docs/ja/CONTRIBUTING.md)），约定见 .agents/conventions/docs-writing.md -->

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
| 跑单个套件 | `npx vitest run test/<文件名>.test.ts` |
| 覆盖率 | `npm run test:coverage` |
| 编译 | `npm run build` |
| 热跑调试 | `npm run dev -- <cmd>` |
| 本机网关 | `scripts/run_dev.bat`（Win）/ `scripts/run_dev.sh`（mac/Linux） |
| 工作流套件 | `npm run test:workflow`（.agents/ 编排器与守卫 hook，随仓库改动按需跑） |

## 代码结构导览

| 目录 | 职责 |
|------|------|
| `src/cli/` | CLI 子命令（commander），每文件一组命令 |
| `src/config/` | 配置存储（config.toml）、密钥、类型定义 |
| `src/gateway/` | HTTP 网关、上游转发、运行态管理、Web 控制台 |
| `src/adapters/` | 客户端适配器（内置 + 声明式 pack） |
| `src/import/` | 从 cc-switch / 各客户端导入存量配置 |
| `src/presets/` | 内置 provider 预设库 |
| `src/util/` | 路径、原子写、i18n 等通用工具 |
| `test/` | vitest 套件，全部用 `MODELRDOCK_FAKE_HOME` 隔离 |

平台注意：CI 在 Linux / macOS / Windows 三大 OS 跑同一套测试，涉及路径 / 文件 / 进程的改动请对照 [AGENTS.md](AGENTS.md)「工程硬性约定」的三平台清单自查。

## AI 自治流水线

目标明确、验收标准可机器检查的任务可以交给本地自治闭环（任务卡进、合并出）：一句话给意图或写张任务卡 → 自动改码、跑测试、独立审查 → 人工闸门放行合并。上手路径与完整用法（spec 三件套、nightly 巡检、schedule 定时、发版提案）见 [docs/ai-pipeline-guide.md](docs/ai-pipeline-guide.md)。

## 提交 PR

1. 从 `develop` 拉分支；多 agent 并行开发时用 `node .agents/scripts/feature-branch.mjs start <task-id>`（见 AGENTS.md「多 Agent 并行开发约定」）
2. 改完跑 `npm test`，全绿再交
3. **文档同步**：改了用户可见行为，按 [.agents/conventions/docs-writing.md](.agents/conventions/docs-writing.md) 更新 CHANGELOG / README（用户视角、一条一事；README 改版遵循其中的结构蓝图），并跑一遍 [docs-sync 工作流](.agents/workflows/docs-sync.md) 的 checklist
4. 提交信息说清"改了什么、为什么"（中文即可，加 `feat:` / `fix:` / `docs:` 前缀更佳）
5. 发起 PR，说明改动动机与测试情况

## 报告问题

- bug / 功能建议：用 [issue 模板](https://github.com/ObsidianTrine/model_dock/issues/new/choose)
- **安全漏洞：不要开公开 issue**，见 [SECURITY.md](SECURITY.md)

## 发布

发布流程见 [docs/RELEASE_CHECKLIST.md](docs/RELEASE_CHECKLIST.md)（维护者向）。