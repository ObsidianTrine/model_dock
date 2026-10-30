---
id: ci-micro-opts
type: refactor
created_at: 2026-10-29T00:00:00+08:00
created_by: human
files_hint:
  - .github/workflows/test.yml
  - .github/workflows/claude-review.yml
  - scripts/pr-risk-tier.mjs
  - scripts/gen-ui-min.mjs
  - test/update.test.ts
workflows:
  - feature-branch
gate: L3
---

> ✅ **已完成**：已合并 develop（merge `f66edeb`，2026-10-30）。
# 目标
CI 与生成脚本的六项微优化批。各项独立、互不依赖，可按清单逐项提交（建议每项一个 commit，便于回退）。

# 逐项清单（行号基于 2026-10-29 develop，动手前逐处核实）
1. **test.yml:36 `npm run build` 改 noEmit**：该产物在本 job 内无人消费（npm test 走 vitest 直跑 src；发布链的 tsc 由 build-sea.mjs:151-155 自带）——改 `npx tsc -p tsconfig.json --noEmit`，保留类型门禁语义，省 emit I/O 约 5-15s/腿。步骤旁注释补一句「noEmit：类型门禁；产物由发布链生成」。
2. **test.yml:35,73 的 `npm ci` 补 `--no-audit --no-fund`**：CI 审计由 release-check.mjs:162 显式 `npm audit --omit=dev` 承担，不丢门禁；省 2-5s × 安装次数。（release.yml 的同款改动归 T16 卡，本卡不动 release.yml。）
3. **claude-review.yml 并发组拆分**：auto-review（:94-96）与 interactive（:273-275）共用组名 `claude-review-<number>` + cancel-in-progress——同一 PR 上 @claude 评论会把进行中的 auto-review 取消掉，烧掉的 token 白费。interactive 改独立组名 `claude-review-interactive-<number>`；文件头注释（:37-39）涉及并发组动机的描述同步更正。
4. **pr-risk-tier.mjs:188 main 判定归一化**：`fileURLToPath(import.meta.url) === process.argv[1]` 未做路径归一化——Windows 下大小写/分隔符不一致时 main 不执行、退出码 0，CI（claude-review.yml:66 经 `node scripts/...` 调用）会拿到空 tier 而非报错（静默失败面）。改两侧 `path.resolve()`（同目录 gen-ui-min.mjs:107 是现成写法）。
5. **gen-ui-min.mjs 循环内 O(n²) 文件读**（:71-75）：每个 ORDER 条目 readdirSync + 全目录逐文件 readFileSync——且该脚本在每次 `npm test` 的 freshness 对拍里跑（test/ui-min-fresh.test.ts:14-18）。改为循环外读一次目录建 `Map<file, src>`，:71-83 的查找与 :78-83 未登记扫描复用同一 Map。
6. **test/update.test.ts 三处打包合并**（:182,197,211）：tar / PowerShell Compress-Archive 各打一次包（win 侧明显更慢）→ 抽共享 helper 或模块级一次打包复用；断言零改动。

# 验收标准
- `npm test` 全绿；update.test.ts 断言零改动；组合跑一次 update 相关套件（update-cli.test / install.test）确认无跨文件回归。
- gen-ui-min：改动前后对同一源树运行 `node scripts/gen-ui-min.mjs`，`git status` 确认 ui-minified.ts 无字节变化。
- pr-risk-tier：本机 `node scripts/pr-risk-tier.mjs`（有 gh 环境则对真实 PR 实测）输出与改动前一致。
- 两个 yml 语法校验通过。

# 红线
- 不改 test.yml 的 matrix、concurrency、watchdog 诊断步骤；不改 claude-review 的 job 逻辑、鉴权、风险分级语义。
- gen-ui-min 的对拍/防漂移机制（转义感知扫描、漏登记红灯、ui.ts 形态守卫）一行不动——只动文件读的收集方式。
- pr-risk-tier 只改 main 判定的路径归一化，不改分级规则。
