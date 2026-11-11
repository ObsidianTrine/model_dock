# reviewer-eval 首跑归档：terminal-die-skips-revoke + fail-open-throw（2026-11-09）

- 环境：claude-headless（GLM-5.3-Flash 经 ModelDock 网关），每题 ~270s；原始输出 `.agents/orchestrator/logs/reviewer-eval-20261109T123834/`（运行态不入库，本文件为归档）
- **机械评分**：2 题均 ⚠️ 误报（应抓 2/2 全命中，漏报 0，excess blockers 5）
- **人工复核改判（评分口径按 README 需抽原文定性）**：

## 召回判定：2/2 ✅ 真审出

- terminal-die-skips-revoke：模型阻塞 3 精确命中考点——exitRun 漏用、process.exit 跳过 finally、revokeRunHarness 不执行、凭据泄漏活到 TTL、并引用文件自身 576-577 行注释与既有闸门 741/759/940 行用例证明「风格统一」的辩护与事实相反（机制+行号+修法齐全，非关键词复述）
- fail-open-throw：模型阻塞 1+2 命中考点——throw 契约无调用方适配（reconcileAll 整批中止、cmdReconcile 用量对账跳过状态对账、破坏 :2425 文档化独立性）+ 被删注释「fail-open 回落，绝不阻断」与改动矛盾；另出真发现：既有测试 fail-open 断言（reconcile.test.ts:705-783 三处）与新契约冲突零配套

## 误报改判

- fail-open-throw 的 excess（「测试零覆盖」）：**真发现，非误报**——行为翻转不配套测试更新在本仓测试纪律下确实不可合入
- terminal-die-skips-revoke 的 excess（g 未定义 / 迁移后 moveCard 方向错 / hunk2 上下文行不存在）：**合成材料 v1 与真实树不自洽的破绽被对拍挖出**——审查者按 REVIEW.md 纪律对拍真实代码（正行为），报的是出题材料的 bug，不计审查者误报

## 出题纪律新增教训（已入 reviewer/README 第 7 条）

**合成 diff 必须与真实树自洽可对拍**：强审查者会 git cat-file / 全文件检索验证上下文——变量名、卡状态迁移方向、hunk 上下文行、虚构 blob hash 都会被对拍；材料自身破绽会被当真 bug 报出（这恰是审查能力的正向证据）。两份材料已修 v2（meta.files_hint / running→blocked / 删对拍不可达的第二 hunk / fetchGatewayUsageSummary 对齐真实 {ok,summary} 契约），v2 重跑待下轮跑分定基线，本轮 v1 结果如实保留如下。

---

# reviewer-eval 评分报告

- 后端：claude-headless（模型 glm-5.3-flash）
- 案例：2，通过：0，部分漏报：0，全漏：0，误报：2，运行失败：0
- 漏报阻塞点合计：0；误报合计：5
- 评分口径：expect 关键词命中（启发式）；是否真审出以各 <id>.output.txt 原文人工复核为准。

| 案例 | clean | 结果 | 命中 | 漏报 | 误报 | verdict |
|---|---|---|---|---|---|---|
| fail-open-throw | 否 | ⚠️ 误报 | 1/1 | 0 | 1 | blockers=2 suggestions=2 notes=3 |
| terminal-die-skips-revoke | 否 | ⚠️ 误报 | 1/1 | 0 | 4 | blockers=3 suggestions=2 notes=1 |

## 明细

### fail-open-throw — ⚠️ 误报

- 考点：fail-open 红线——编排侧对网关观测（admin API/网关日志）一律 fail-open： / 不可得时回落文件直读/自报账，绝不抛错阻断派发与对账（reconcile/weather/supply / 三处既有先例同款口径，原实现注释里写明）。把「回落」改成「上抛拒绝」听着更 / 严谨（「宁可不决策也不用不完整的账」是典型迷惑面），实际是把网关抖动放大成 / 对账瘫痪、下游 stats/nightly 连带崩；且函数 JSDoc 的 fail-open 承诺没同步改—— / 文档与行为矛盾。 / 场景：reconcile 实测账取数改「严格模式」，意图成立，坏在收窄了 fail-open。
- 命中 [P1] 网关观测失败（fail-open 收窄）从「回落文件直读」改成抛错上抛/拒绝继续：违反编排侧「网络观测一律 fail-open 绝不阻断」口径（网关抖动即对账瘫痪，下游 stats/nightly 连带受累）；被删注释与本 hunk 顶部原注释明写「fail-open 回落，绝不阻断」——改动与自身注释/JSDoc 矛盾（关键词：fail-open、回落、阻断）
- 超出命中数的阻塞报告 1 条（对照原文定性是否误报）

<details><summary>模型原文</summary>

```text
发现 5 个问题（2 阻塞、2 建议，另附 3 条提示性说明）。

先说验证结论：材料中的 diff 与本仓库 `reconcile.mjs` 的实际内容不一致——blob `21f68b3`/`9c8d0e1` 在仓库中不存在（`git cat-file` 报 Not a valid object name），diff 中的 `fetchGatewayUsageSummary(ga, params)` 签名、`reconcileFromFile`/`reconcileFromGateway` 在实际文件里均不存在（实际契约是 `{ok:true,summary}|{ok:false,reason}` 结果对象，见 `.agents/scripts/orchestrator/reconcile.mjs:61`）。仓库里存在同内容夹具 `.agents/review-evals/reviewer/cases/fail-open-throw.diff.md`，故按评测夹具对待、以 diff 自身内容为审查对象，仓库现有对应物仅作佐证。此点列在提示里，不计入阻塞。

---

**阻塞 1 — throw 契约变化无调用方适配：整批对账中断、状态对账被连带跳过，「明确报错退出」只以裸崩溃形式达成。**

diff 删除了唯一回落路径并让 `fetchGatewayUsageSummary` 上抛，但 diff 中没有任何调用方改动来承接这个 throw。对照仓库实际调用链（作为佐证）：

- `reconcileAll`（`.agents/scripts/orchestrator/reconcile.mjs:419-427`）逐任务循环调用 `reconcileTask`，无逐任务隔离——网关在批量中途不可达时，一抛即整批中止，已算完的任务也不输出，且错误信息不带 taskId，无法定位是哪个任务取数失败。
- `cmdReconcile`（`.agents/scripts/orchestrator.mjs:2442` 与 `:2447`）对用量对账段无 try/catch；`:2425-2427` 的文档注记明确承诺「两节独立，用量对账未启用也照跑」——throw 会跳过 `:2456` 之后的状态对账整节，破坏这一已文档化的独立性。
- 被 diff 删掉的旧注释原文是「fail-open 回落，绝不阻断对账与派发」——这是当初 fail-open 的设计理由。严格模式若只改取数函数不改调用方，「绝不阻断派发」的承诺就被静默撕毁，而验收标准只说了 reconcile 报错退出，没授权波及派发链路。

正确做法至少是：cmdReconcile 层面 catch 后 `die()` 干净报错（本仓库既有模式，如 `orchestrator.mjs:2441`），批量路径逐任务隔离或整批统一报错并保留 taskId。

**阻塞 2 — 测试零覆盖，且与仓库既有 fail-open 断言直接冲突。**

diff 未包含任何测试改动，而新契约的每条路径（非 2xx、超时、离线、JSON 解析失败 → 报错）都没有覆盖。更严重的是仓库现有测试明确断言着被推翻的旧行为：`test/orchestrator/reconcile.test.ts:793`（「端点不可得（死端口）→ fail-open 落回文件扫描：结果与历史口径逐字段一致」，断言 `:806-810` 正常出账）、`:705-725`（旧版网关缺 billable → 落回文件扫描）、`:765-783`（partial → 落回文件扫描）。严格模式落地后这些用例要么失败要么语义反转，diff 一并没动。行为翻转不配套测试更新，在本仓库的测试纪律下不可合入。至少需要：网关在线→正常出账（验收 1）、离线/非 2xx/超时→报错路径各一条用例。

**建议 1 — 「在线但非 2xx / 慢」与「离线」未区分，验收标准 1 被破坏。**

旧回落注释写明非 2xx 的典型场景是「旧网关无该端点」——此时网关**在线**。diff 把 404（版本偏差）、401（token 轮换窗口）、5xx、3s 超时全部变成硬报错，而验收标准 1 要求「网关在线时取数口径与之前一致」。尤其 3s 超时线：本分支主题恰恰是首跑超时（eval-firstrun-timeout），负载下慢响应的在线网关以前回落文件直读照常出账，现在直接报错中止。若目标是「网关不可得（离线/不可达）才报错」，应区分错误类别（如连接拒绝/超时 vs HTTP 状态码），或至少在错误信息里区分，避免版本偏差期对账全面熔断。

**建议 2 — catch 把自己抛的错再包一层，错误消息重复嵌套。**

`if (!res.ok) throw new Error('网关实测账不可得（HTTP 404）')` 在 try 块内，随即被下方 `catch (e)` 捕获再包一层，最终消息为「网关实测账不可得：网关实测账不可得（HTTP 404）」。功能不受影响但消息自缠绕，日志里难读。修法：非 2xx 检查移出 try，或 throw 时用标记类/属性让 catch 跳过再包装。

**提示 1 — [夹具说明] diff 与仓库现状不符。** 如开头验证所述：blob 哈希不存在、被改函数签名与实际文件不符。按夹具审查处理，不影响上述结论；若是真实 PR，这条本身即阻塞（diff 不可应用）。

**提示 2 — 超时错误信息不可读。** 3s 超时触发 abort 后，`e?.message` 是 abort 类消息（如 "This operation was aborted"），最终报「网关实测账不可得：This operation was aborted」——看不出是超时、超时阈值是多少。建议对 abort 单独给「3s 内未响应」类消息。

**提示 3 — `reconcileFromFile` 疑似沦为死代码。** diff 删除了其唯一可见调用点；若确认无其他调用方，应随本改动一并删除。diff 视野外无法确证，故仅提示。

红线检查（一票否决六项）：无 8687/8890 端口、无 `~/.modeldock` 硬编码、不涉及写盘、无 `import.meta.url`、无 native addon、不触及 cli.ts 分发——全部通过。密钥方面 `adminToken` 只进请求头、不进错误消息，无外泄。范围检查（问题 4）：diff 仅触碰 `.agents/scripts/orchestrator/reconcile.mjs`，无顺手重构、无关格式化——范围干净，问题集中在契约翻转的配套缺失上。

REVIEW_SUMMARY: blockers=2 suggestions=2 notes=3
```

</details>

### terminal-die-skips-revoke — ⚠️ 误报

- 考点：终态出口吊销契约——cmdRun 的 die = process.exit（finally 不跑），ephemeral / harness 凭据的吊销挂在新终态出口 exitRun（先 best-effort 吊销再 die）。 / 新增终态闸门直用 die = 该出口跳过吊销：一次性凭据泄漏活到 TTL（≤24h）， / 且 events 留未吊销陈账污染接管路径。「与既有闸门写法一致」是迷惑面： / 既有闸门已全部改为 await exitRun(...)，风格统一的正确对象是 exitRun 不是 die。 / 场景：派发前新增「卡面完整性预检闸」，实现意图成立，坏在收口用了裸 die。
- 命中 [P1] 新增终态出口（exitRun 漏用）直用 die（process.exit 跳过 finally），revokeRunHarness 不执行：一次性 harness 凭据泄漏活到 TTL、events 留未吊销陈账；同文件刚定义的「终态出口必须走 exitRun 先吊销再退出」契约被新闸门违反（关键词：exitRun、revoke）
- 疑似误报（噪音命中）：blocked 迁移与通知顺序不是考点（迁移方向 pending→blocked 正确；「缺 archiveIncident」类完善建议属建议级）（关键词：moveCard、settleNotify、await）
- 疑似误报（噪音命中）：「与既有闸门写法一致」是 diff 自带的错误理由，把风格统一当辩护或单独当发现都不算命中（关键词：一致、统一）
- 超出命中数的阻塞报告 2 条（对照原文定性是否误报）

<details><summary>模型原文</summary>

```text
我已读完审查材料并逐条对照真实代码验证（diff 未套用在树上，按材料审查；以下行号均指 `.agents/scripts/orchestrator.mjs` 当前文件实况，插入点即 `exitRun` 定义（614-617 行）与预算实测账段（619 行）之间）。

发现 6 个问题：

---

**【阻塞】1. `g` 未定义——闸门第一行就会 ReferenceError，预检从未生效**
- diff：`if (!g.files_hint || !g.files_hint.length)`
- 证据：全文件中 `g` 的唯一绑定是 `.agents/scripts/orchestrator.mjs:926` 的 `for (const g of gates)`——位于 worker 循环内部的一个块级作用域，在插入点（~618 行）根本不存在。卡面元数据变量是 `meta`（同文件 1052 行既有用法 `gateScopePurity(worktree, meta.files_hint, ...)` 可证）。
- 后果：缺 files_hint 的卡走到闸门即抛 `ReferenceError: g is not defined`，die/落位/通知全都到不了。
- 修复：改为 `meta.files_hint`。

**【阻塞】2. 闸门位置在 `pending→running` 迁移之后——`moveCard('pending','blocked')` 必抛「任务卡不存在」，卡滞留 running/，验收标准直接失败**
- diff 在插入点执行 `moveCard(root, taskId, 'pending', 'blocked')`，但真实代码在 **490-491 行**早已执行 `moveCard(root, taskId, 'pending', 'running')`（awaiting-human/reviewing 恢复路径 497/501 行同样先迁到 running）。此时卡在 `running/` 目录。
- 证据：`queue.mjs:375` — `if (!fs.existsSync(src)) fail(\`任务卡不存在：${src}\`)`，`fail` 抛异常。moveCard 抛出后 settleNotify 与 die 都不会执行。
- 后果：每张缺 files_hint 的卡（无论来源状态）都会让 cmdRun 裸崩，卡留在 running/、worktree 已建、依赖已装，验收标准「缺 files_hint 的卡进 blocked/ 并通知」完全不成立。
- 修复：把闸门上移到状态迁移之前（与 303-312 行引水闸同区，那里才是卡仍在 pending/ 的位置）。注意恢复路径（found.state 为 running/reviewing/awaiting-human）源状态不是 pending——且 `queue.mjs:42` 显示 `awaiting-human→blocked` 不在 TRANSITIONS 白名单，需要一并处理，不能硬编码 `'pending'`。上移还顺带避免给将被拒绝的卡白建 worktree、装依赖、签一次性凭据。

**【阻塞】3. 终态出口用 `die()` 而非 `exitRun()`——一次性凭据漏吊销（terminal-die-skips-revoke）**
- 插入点位于 ephemeral harness 签发（579-604 行）**之后**：`gatewayProvision: true` 时 `taskHarness` 已签发。`die` = `process.exit`，finally 不跑，也不会走 614-617 行专门为此定义的 `exitRun`（内部 `revokeRunHarness('terminal')`）。
- 证据：文件自己的注释 576-577 行——「终态落位（blocked/failed 经 exitRun…）」「die 语义 = process.exit，finally 不跑，故 exitRun 显式吊销」；既有全部终态闸门均用 `exitRun`（741、759、940、1018、1030 行）。
- 后果：该退出路径签发的一次性凭据漏吊销，存活至 TTL（≤24h）——正是凭据生命周期设计要堵的洞。diff 里「收口写法与既有闸门保持一致（一行 die 收口）」的注释与事实相反。
- 修复：改用 `await exitRun(...)`（并将 moveCard/appendEvent/settleNotify 排在其前，对齐 755-760 行 config-drift 闸的同款序列）。若按问题 2 上移到签发之前，此洞自然消失，但收口仍应统一走既有模式。

**【建议】4. 缺事件留痕与事故归档——违反「永不静默」纪律**
- 既有每一处 blocked/failed 落位都成对执行 `appendEvent(qdir, 'blocked'/'failed', { reason })` + `archiveIncident(...)`（663-665、737-740、755-758 行）。新闸门只有 moveCard + settleNotify，events.jsonl 里查不到这张卡为何进 blocked/，drain 收官/autoresume/事后对账都会失明。
- 修复：补 `appendEvent(qdir, 'blocked', { reason: 'missing_files_hint' })`（是否 archiveIncident 与同类预检闸对齐）。

**【建议】5. 零测试覆盖——验收标准无法验证**
- `test/orchestrator/` 下每个既有闸门都有对应测试（backend-switch-gate、config-guard、drain、fastlane 等 243 个文件）；本闸门没有新增任何测试。两条验收标准（缺 hint 卡进 blocked/ + 通知、正常卡不受影响）合并后无人守。至少应补：缺 files_hint 卡 run → 断言卡在 blocked/ + 通知发出；带 files_hint 卡正常派发不受影响。

**【提示】6. 第二个 hunk 上下文行在仓库中不存在——diff 本身不可应用，且属超范围改动**
- hunk 2 的上下文/被改行 ``log(`[drain] 卡 ${taskId} 开始派发`)`` 在整个 `.agents/` 下检索不到（仅存在于本 diff 材料自身；真实 spawn 点 808 行只有 `appendEvent(qdir, 'worker_spawned', ...)`，无此日志）。真正的 `git diff` 不可能产出对不上树的上下文——请核实 diff 出处/基线，或删除该 hunk。即便想加这行日志，它也与预检闸目标无关。

---

补充说明（不计问题）：`files_hint` 判空写法本身（`!meta.files_hint || !meta.files_hint.length`）对 undefined/空数组两种形态都成立，语义无误；`settleNotify(repoRoot, taskId, 'blocked', ...)` 签名与 147 行定义相符。

REVIEW_SUMMARY: blockers=3 suggestions=2 notes=1
```

</details>
