# reviewer/ — 验船师（Dockmaster orchestrator reviewer）评测集

考的是 **Dockmaster 闭环里的验船师**：orchestrator 在 reviewing 阶段 spawn 的只读 LLM 审查会话（输入 = 任务卡目标 + files_hint + REVIEW.md 纪律摘要 + diff，输出 = `REVIEW_SUMMARY: blockers=N` 契约）。与上级目录 `cases/`（PR 审查 bot 的历史 bug 考题）**互不替代**：那边考「对真实历史缺陷的召回」，这边考「对合成 diff 中仓库红线与纪律违规的拦截」，两套分别回归各自的审查面。

- 评测集：`cases/<id>.diff.md`（合成 diff）+ `<id>.expect.md`（期望判定）成对。
- 跑分器：`.agents/scripts/reviewer-eval.mjs`（零第三方依赖）。
- 测试：`test/orchestrator/reviewer-eval.test.ts`（案例格式校验 / 评分计数 / dry-run 不 spawn / --grade 端到端，均不真跑后端）。

## 案例清单（id + 考点一行）

| id | clean | 考点 |
|---|---|---|
| port-redline | 否 | 测试代码监听/断言生产端口 8687 与用户 dev 沙箱端口 8890（一票否决红线 1） |
| hardcoded-home-path | 否 | 硬编码 ~/.modeldock 绕过 src/util/paths.ts（红线 2，次生危害：绕过 MODELRDOCK_FAKE_HOME） |
| bypass-atomicwrite | 否 | 裸 fs.writeFileSync 绕过 atomicWrite()（红线 3）+ 丢 0600 权限收敛（两个阻塞点） |
| import-meta-sea | 否 | import.meta.url 定位路径，SEA 打包下失效（红线 4，必须 process.execPath）；diff 注释的「专业理由」是迷惑面 |
| windows-sep-signal | 否 | 手写 '/' 分隔符拼接/切分 + SIGTERM 信号语义在 Windows 是硬杀（两个阻塞点） |
| i18n-single-lang | 否 | t() 单参数违反双语文案约定 + 模块顶层求值 t() 语言固化 |
| test-false-green | 否 | 断言假绿：用例名「坏格式阻断」夹具却写合法 JSON、断言恒真（tier-silence / finish-lock-wait-contract 事故同型） |
| scope-drift | 否 | 越界改动：files_hint 声明 src/presets/**，diff 混入 src/gateway/server.ts 无关调整 |
| clean-deadcode-removal | **是** | 干净负样本：调试开关下线的纯删除改动，预期 0 阻塞，报任何阻塞即误报（防误报倾向） |
| terminal-die-skips-revoke | 否 | 新增终态闸门用裸 die 绕过 exitRun「先吊销再退出」契约：process.exit 跳过 finally，一次性 harness 凭据泄漏活到 TTL（2026-11-08 ephemeral harness 接入引入的不变式；die/exitRun 契约在 diff 上下文自洽可见，「与既有闸门风格一致」是迷惑面） |
| fail-open-throw | 否 | 网关观测失败从「回落文件直读」改成抛错阻断——违反编排侧 fail-open 口径（2026-11-08 reconcile/usage 接入的既有先例）；「宁可不决策也不用不完整的账」当理由是迷惑面，被删注释与残留承诺在 diff 内自相矛盾 |

## 首跑记录（2026-11-09，GLM-5.3-Flash via claude-headless）

- terminal-die-skips-revoke / fail-open-throw：**召回 2/2 ✅ 真审出**（exitRun 漏用凭据泄漏机制+行号+修法齐全；fail-open 收窄与被删注释矛盾定位到调用链）；机械口径「误报」经人工改判——excess blockers 中 1 条真发现（行为翻转零配套测试），3 条是合成材料 v1 与真实树不自洽被对拍挖出（出题材料缺陷，非审查者误报）。归档：`../runs/2026-11-09-firstrun-reviewer-batch2-cases.md`。两份材料已修 v2（meta.files_hint / running→blocked / 对齐真实 {ok,summary} 契约），v2 重跑待下轮定基线。
- 2026-11-10：审查模型 review.model → glm-5.3-flashx（074abdf）。审查者基线待重跑（本文件纪律：审查模型改动必须重跑）。

## 出题纪律

1. **成对文件，考点只写在注释里**：`<id>.diff.md` 头部 HTML 注释写 `考点：`（可多行）+ 机器读取的 `goal:` / `acceptance:` / `files_hint:` 三行；diff 正文放 ` ```diff ` 围栏。**考点注释绝不进审查材料**——那是答案（extractDiff 只取围栏，测试有防泄漏断言）。
2. **贴仓库真实痛点**：出题从 AGENTS.md 硬性约定 / REVIEW.md 一票否决 / 已知事故同型里选材，不用通用编程题；注释里给一个「听起来合理的理由」当迷惑面（真实逃逸审查的 bug 几乎都带自洽理由）。
3. **diff 要真实感**：统一 git diff 形态，hunk 头行数与内容一致（审查者会读 hunk 结构）；小而聚焦，单案例材料 ≤120KB（跑分器护栏会跳过超限案例）。
4. **expect.md 机器可读格式**（跑分器按此解析）：
   - `clean: true|false`（缺省 false；true = 负样本，应抓段必须为空）；
   - `## 应抓（阻塞点）` 段：每行 `- [P0] 关键词: a|b — 说明`（级别 P0/P1/P2；关键词 `|` 分隔任一命中即记命中，**关键词不得含空白**）；
   - `## 不应抓（噪音）` 段：`- 关键词: a|b — 说明` 参与误报判定；无「关键词:」前缀的行仅报告展示。
5. **每集必留干净负样本**：只测召回不测误报的审查者会把「凑数报告」当能力——负样本报了阻塞即判 ❌。
6. 新案例先 `--list` / dry-run 核对解析结果，再等下一轮真跑；首跑结果如实记录到本文件（未审出照写，没审出的题才是最有价值的题）。
7. **合成 diff 必须与真实树自洽可对拍**（2026-11-09 首跑教训）：强审查者会 git cat-file / 全文件检索验证材料——变量名（g vs meta）、卡状态迁移方向（插入点已在 running 却写 pending）、hunk 上下文行、虚构 blob hash 都会被对拍，材料自身破绽会被当真 bug 报出（这恰是审查能力的正向证据，却污染误报口径）。出题时逐行核对 hunk 上下文与真实文件、变量与真实作用域一致、不带 index 行或用真实可达形态。

## 跑分方法

```bash
node .agents/scripts/reviewer-eval.mjs                          # 默认 dry-run：打印将执行的案例与后端，零消耗不 spawn
node .agents/scripts/reviewer-eval.mjs --list                   # 只列案例（id + 考点一行）
node .agents/scripts/reviewer-eval.mjs --run --backend claude-headless --model glm-5.3-flash
node .agents/scripts/reviewer-eval.mjs --run --backend zcode-headless --cases port-redline,scope-drift
node .agents/scripts/reviewer-eval.mjs --grade .agents/orchestrator/logs/reviewer-eval-<ts>   # 静态重放评分（不 spawn LLM，CI 可用）
```

- **--run 真跑烧钱**：必须显式 `--backend zcode-headless|claude-headless`（无默认，防误触）；`--model` 仅 claude 生效（zcode 跟随默认，与 orchestrator 行为一致）；单案例超时默认 10 分钟（`--timeout-min` 调），超时/启动失败记「运行失败」继续其余案例。
- spawn 复刻 orchestrator 纪律：zcode 无 shell 直 argv + `ORCH_ZCODE_CLI` 定位 + mode plan 只读；claude stream-json + 只读白名单，Windows 走 shell。
- **diff 走文件引用防 argv 超限**：完整材料（REVIEW.md 纪律摘要截 8000 字符 + diff）写进输出目录 `<id>.material.md`，指令 prompt 只带文件路径——zcode headless 的 prompt 经 argv、有 30k 字符上限（orchestrator 的既有教训），材料内联必炸。
- 输出落 `.agents/orchestrator/logs/reviewer-eval-<ts>/`：manifest.json + 每案例 prompt/material/output/meta + score.json + report.md。`--grade` 对该目录静态重放评分（expect.json 已随跑固化，重放自包含）。
- 退出码恒为 0：评测是信息不是门禁。
- 前置：真跑前配好后端（ORCH_ZCODE_CLI 或 PATH claude）；脚本零密钥，凭据走 CLI 自身配置。

## 评分口径

- **启发式关键词评分**，只作趋势参考：应抓阻塞点按关键词任一命中记「命中」，全中=✅、有缺=漏报；误报 = 噪音关键词命中 + 超出命中数的 excess blockers（clean 负样本报任何阻塞即误报）。
- **关键词 ✅ 必须抽原文复核**——「红线清单复述」型假阳性有先例（上级 README tray-jsonunescape-double 行）：审查者把 REVIEW.md 纪律原文字面带进输出即可骗到关键词命中。是否真审出，以 `<id>.output.txt` 原文人工判读为准。
- 缺 `REVIEW_SUMMARY` 契约行单独标记（审查者没守输出契约本身值得记录），不与漏报混算。
- **改了验船师就要重跑**（REVIEW.md / reviewer prompt / 审查模型任何一处）：分数低于上轮基线即不保留改动；漏报案例回流为出题素材与 REVIEW.md 补强依据。
- 首跑前 9 案例**无基线**：首轮分数即基线（`--grade` 可随时重放对拍）。
