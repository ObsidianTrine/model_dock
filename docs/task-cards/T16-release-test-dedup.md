---
id: release-test-dedup
type: refactor
created_at: 2026-10-29T00:00:00+08:00
created_by: human
files_hint:
  - .github/workflows/release.yml
workflows:
  - feature-branch
gate: L3
---

> **状态**：✅ 已完成——merged 9b1a891（2026-10-30 收口盘点）

# 目标
release.yml 五条构建腿不再各跑一次全量 npm test——tag 指向的 commit 已被 test workflow 验证全绿时跳过腿内测试；顺带给交叉编译 Node 二进制加 actions/cache、统一 npm ci 参数。预期每次发布省约 10 CI 分钟（mac 两条腿按 10× 计费口径约省 50 计费分钟）。

# 背景（行号基于 2026-10-29 develop，动手前核实）
- release.yml:62 每条 matrix 腿（5 腿，:31-44）跑 `npm test`；其中 linux-x64/arm64 同为 ubuntu host（arm64 SEA 是交叉编译产物，测试并未跑在 arm64 上）、darwin-x64/arm64 同为 macos-latest 同版 host Node——测试完全同质。AGENTS.md「发布」节本就要求**先等 main 上 test workflow 全绿再推 tag**，同 commit 的三平台测试已经付过一次。
- 交叉编译腿的 Node 二进制缓存在 build-sea.mjs 落于 `ROOT/.cache/node-binaries`（build-sea.mjs:222-241），runner 临时盘跨 run 不复用，每腿在线下载 25-45MB + SHASUMS；workflow 全部 5 个 yml 无任何 actions/cache。
- 腿内 `npm ci`（release.yml:59）无 `--no-audit --no-fund`（审计门禁在 scripts/release-check.mjs:162 的显式 `npm audit --omit=dev`，不受影响）。

# 实施要求
1. **preflight 增强**（preflight job 在 release.yml:18-24）：现有 CHANGELOG 版本段检查一行不动；新增一步——用 `gh api`（checks API：`repos/{repo}/commits/{sha}/check-runs` 或 actions runs API 按 head_sha 过滤）查 tag 指向 commit 的 test workflow 结论，全部 success 则设 job output `tested=true`；查不到或尚在跑一律 `tested=false`（保守回退）。
2. **腿内测试条件跳过**：build matrix 腿的 `npm test` 步骤加 `if: needs.preflight.outputs.tested != 'true'`；步骤前加一行 echo 说明跳过/自测原因（log 可读性）。tag 打在未验证 commit 上时回退为腿内自测，门禁强度不降。
3. **node 二进制缓存**：build 腿加 `actions/cache`，path `.cache/node-binaries`，key 含 PLATFORMS 里的 Node 版本（如 `node-binaries-v24.16.0-${{ runner.os }}-${{ runner.arch }}`）+ restore-keys 前缀兜底。build-sea.mjs 的 SHASUMS 哈希复核逻辑（:230-238）一行不动——缓存命中仍在线复核，供应链门禁不降。
4. **npm ci 参数**：release.yml:59 补 `--no-audit --no-fund`。

# 验收标准
- workflow 语法校验通过（actionlint 或逐行核对 expression 求值路径）。
- 交付说明写清三个场景的完整推演：① tag 在已全绿 commit（五腿跳过测试，preflight 秒过）；② tag 在未验证 commit（照旧五腿自测）；③ test workflow 尚在跑（视为未验证，照旧自测）。
- 说明 `needs.preflight` 输出在 matrix job 里引用的正确写法（`needs.preflight.outputs.tested`）。

# 红线
- preflight 既有门禁（CHANGELOG 版本段等）一行不动。
- 全局 `concurrency: release` 串行化（防多 tag 交错写 Release）、三段 job 的 timeout、收尾 job 逻辑不动。
- 不改 build-sea.mjs 任何逻辑（缓存 path 以脚本现值为准）。
- 属 releasePaths 敏感路径（.agents/workflow.json releasePaths 含 .github/workflows/），合并前 review 从严。
