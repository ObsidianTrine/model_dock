# ModelDock 发布前检查清单（Release Checklist）

> **用途**：每次版本发布前的质量门禁。机器可查项由 `scripts/release-check.mjs` 一键执行，人工判断项逐条过目——**发布内容盘点前跑一遍，打 tag 前再跑一遍**。
> **与 release.md 的分工**：[release.md](../.agents/workflows/release.md) 是发布**流程**（步骤顺序与命令）；本文件是**门禁清单**（质量标准与执行器）。
> **维护**：流程或策略变更后，同步更新本文件与 release.md / [AGENTS.md](../AGENTS.md)。基线数字（用例数等）**不写死在本文件**——脚本实测并提示与 usage.md 的漂移。

---

## 0. 发布模型速览（先读这段）

| 要点 | 约定 |
|------|------|
| 版本号唯一事实来源 | **git tag**。`scripts/build-sea.mjs` 构建时读 `git describe --tags --abbrev=0`，临时改写 `src/version.ts` + `package.json` 后自动还原。**禁止手动改写文件里的版本号** |
| 发布触发 | 推 tag 后 GitHub Actions（`.github/workflows/release.yml`）自动构建：preflight（CHANGELOG 预检，缺版本段秒级失败）→ 5 平台构建 → 创建 Release |
| 发布分支 | 日常开发在 `develop`，发布时合入 `main`，在 `main` 上打 tag；**main 不得有 develop 缺失的内容提交**（脚本强制检查，防 hotfix 只合 main 不回 develop 被下轮冲掉） |
| 版本号语义 | major = 破坏性变更；minor = 向后兼容新功能；patch = 修复；**公开发布过的版本号永不复用**（先例见 release.md「出错回滚」） |
| 发布物 | 共 11 个资产：5 平台压缩包 + darwin app 整包×2（一键升级用）+ darwin DMG×2 + win setup.exe + 合并 SHA256SUMS（名字不带 v 前缀，如 `modeldock-1.0.1-linux-x64.tar.gz`） |

## 1. 机器门禁（一键跑）

```bash
node scripts/release-check.mjs v1.2.0                # 全量（含 npm test，约 3 分钟）
node scripts/release-check.mjs v1.2.0 --skip-test    # 测试刚在别处全绿时（build/audit 照常）
```

**✗ = 阻断**（退出码 1，禁止打 tag）；**⚠ = 警告**（不阻断，但必须逐条过目并给出理由）。

| 级别 | 检查项 |
|------|--------|
| ✗ | 在 develop 分支、工作区干净（其他分支/worktree 降级 ⚠） |
| ✗ | **main 无 develop 缺失的内容提交** |
| ✗ | CHANGELOG：`## [X.Y.Z]` 版本段存在（复用 extract-release-notes --check）、无「未发布」残留、文末链接表有对应行 |
| ✗ | 版本号未被占用：本地无同名 tag（远端查询失败降级 ⚠） |
| ✗ | `npm test` 全绿（脚本解析并报告用例数 / 文件数） |
| ✗ | `npm run build`（tsc）零错误 |
| ✗ | `npm audit --omit=dev` 无漏洞（registry 不可达降级 ⚠） |
| ✗ | 托管 Node 钉版满足全部 npm 客户端 engines 下限（npmmirror 实查 `src/adapters` 的 4 个 npm 安装命令；冲突 = 无系统 Node 的全新机器「装成功、跑就崩」，升 `MANAGED_NODE_VERSION`；查询失败降级 ⚠ 人工核对） |
| ✗ | `src/` 无 `import.meta`（SEA 约定）、无 `listen(8687/8890)`（端口红线） |
| ✗ | 密钥扫描（src / scripts）无真实密钥（test/ 命中降级 ⚠，人工确认是假值） |
| ⚠ | `src/` TODO / FIXME / XXX / HACK 残留（列出供裁决） |
| ⚠ | develop 领先 origin/develop（提示推送备份）、feature/* 分支残留（确认不含本版内容） |
| ⚠ | 托管 Node 钉版新鲜度：非当前大版本最新 patch（安全补丁滞后，顺手 bump）/ 已有更新 LTS 大版本（提示评估切版，与 SEA/CI 同步） |
| ⚠ | 基线漂移：实测用例数 / 文件数 ≠ [usage.md](usage.md) §10 所写（提示更新 usage.md） |

## 2. 人工判断项（脚本替代不了）

**内容与文档**
- [ ] 按 release.md 步骤 1 完成盘点归纳；CHANGELOG / README 措辞过 [docs-writing](../.agents/conventions/docs-writing.md) 规范（用户视角、一条一事、粗体点题、无内部黑话）
- [ ] README / docs/usage.md 与新版本一致（新能力 bullet、命令表、§10 基线数字按脚本实测更新）
- [ ] 破坏性变更已识别：有则升 major，并在 usage.md 写迁移说明
- [ ] 无未合并的 WIP / 半成品开关；内部改动（CI / 测试 / 工具链）未混进 CHANGELOG

**架构与安全（违反 = 阻断）**
- [ ] 新增依赖逐一过目：全部纯 JS、无 native addon（SEA 打包前提）；lockfile 已提交、`npm ci` 可复现、无可疑 postinstall
- [ ] `package.json` 元数据正确（description / engines node>=22 / files 仅 dist）
- [ ] secrets.json 永不入库，.gitignore 覆盖 dist / release / .cache / *.tgz；管理面不回传 Key 明文（reveal-key 受 Host 白名单 + 同源校验）
- [ ] 网关仅监听 127.0.0.1（设计约束，改动即 major + 威胁模型更新）
- [ ] 托管 Node 钉版年度评估：每年 10 月新 LTS 落地后择发版升级 `MANAGED_NODE_VERSION`（与 SEA 内嵌运行时 / CI / 开发机同大版本切换）；平时发版按门禁 ⚠ 提示跟进当前线最新 patch
- [ ] 已知限制（AGENTS.md「已知限制」）逐条确认仍成立

## 3. 发布执行

按 [release.md](../.agents/workflows/release.md) 步骤 2-5：develop 合入 main 并推送 → 等 test.yml 三平台全绿 → **tag 前把 §1 脚本再跑一遍**（`--skip-test` 即可）→ 打 annotated tag 只推这一个 → 验证 11 资产与 Release 正文。回滚与「撤回版本号永不复用」规则见 release.md「出错回滚」。

## 4. 发布后验证（24 小时内）

- [ ] Release 页面 11 资产齐全、正文是 CHANGELOG 该版本完整段（非占位）
- [ ] 抽查一个平台压缩包：`modeldock --version` == 刚打的 tag
- [ ] 跨平台安装冒烟（至少本机 + 一台其他平台）：下载 → 安装 → 发一条真实请求
- [ ] 生产 8687 实例升级路径验证（服务不中断，或按发布说明升级）
- [ ] 客户端接入回归：至少 2 个 harness attach / detach 闭环 + 快照还原
- [ ] 观察 GitHub issues 与 `~/.modeldock/logs/` 错误日志；回滚预案就绪（上一版本产物可下载）
- [ ] 本清单结果归档（Release notes 或发布记录）

---

## 附录：参考来源

业界发布前 checklist 的共性条目（版本冻结、semver、changelog、测试全绿、依赖审计、密钥扫描、构建产物校验、跨平台验证、发布后监控与回滚）参考了以下资料，并按 ModelDock 的工程约定（git tag 版本源、SEA 打包、五平台发布、8687 端口红线）裁剪定制：

- [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)
- [Semantic Versioning 2.0.0](https://semver.org/lang/zh-CN/)
- [openclaw RELEASING.md](https://raw.githubusercontent.com/openclaw/openclaw/refs/heads/main/docs/reference/RELEASING.md)
- [autoresearch-ai RELEASING.md](https://github.com/vukrosic/autoresearch-ai/blob/main/RELEASING.md)
- [VuFind Release Checklist](https://vufind.org/wiki/changelog:release_checklist)
- [STRATOS Release Manager Guide](https://cloudfoundry.github.io/stratos/docs/release_guide/)
