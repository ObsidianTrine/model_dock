**评分器说明**：2026-10-29 基线跑分用本地 claude CLI（deepseek-v4-pro）；2026-10-30 夜训时该 CLI 的 DeepSeek key 401 失效，当日 12 题改用 **ZCode 会话模型 subagent（GLM-5.3-Flash）** 评分——两段分数来自不同评分器，跨段对比仅供参考；DeepSeek key 修好后可用 runner 重跑全量对齐。Runner 已加 120KB 考题文件护栏（历史上的 289KB ui.ts 会撑爆 prompt，选题时避开整文件巨物）。

| id | bug | fixedBy | 首跑 |
|----|-----|---------|------|
| 2026-10-update-stoptray | win 更新停托盘「尽力而为」零验证，托盘带锁活到安装向导，RM 30s 超时安装卡死 | 22f20fd | ✅（10-29，claude CLI）P0 定位根因 + 挖出 e4ac854 CRLF 真根因相关问题 |
| 2026-10-diag-darwin-cipher | 跨机密文检测缺 darwin / 无加密形态分支，macOS secrets 表条目漏报 | 53da3e2 | ✅（10-29，claude CLI）证据链完整复现修复逻辑 + 1 [存量] + 3 存疑 |
| 2026-10-tray-mutex-gc | win 托盘单实例 Mutex 局部变量被 GC 回收，双击叠出多个图标 | cbb9265 | ✅（10-29，claude CLI）[P0] 机制+行号齐全 |
| 2026-10-update-shape-customdir | 安装器装到自定义目录被 detectInstallShape 误判 win-bare，托盘永不更新 | d1d3eab | ✅（10-29，claude CLI）交叉引用 installer.iss 可改目录 |
| 2026-10-cloud-null-body | 请求体 JSON 字面量 null 穿透 parseBody，500 外泄 V8 原文（REVIEW-27 残留） | 78cf650 | ✅（10-29，claude CLI）扫出 5 端点同型点 |
| 2026-10-fsx-idle-flush | appendLine 常驻流池无空闲刷盘，Windows 硬杀丢日志尾 | 0ba0d65 | ✅（10-29，claude CLI）点名硬杀 + 无信号语义 |
| 2026-10-backup-prune-race | 快照孤儿清理误删他进程半成品 + recursive mkdir 死代码重试 | a494d81 | ✅（10-29，claude CLI）3 连中 |
| 2026-10-route-pin-precedence | 客户端钉住路由被定时窗口/全局当前槽接管，模型发错上游 404 | baa820c | ✅（10-29，claude CLI）定位 state.ts:483+499-505 |
| 2026-10-tray-autospawn-echo | 托盘自动弹控制台守卫是进程内标志，安装链弹两份控制台 | cc38c6b | ✅（10-30，GLM subagent）给出修复形态（AUTOSPAWN 注入）+ 2 个额外问题 |
| 2026-10-autostart-tray-gap | 开机自启只登记 daemon，重启后托盘永远缺席 | 9a93008 | ✅（10-30，GLM subagent）穷尽性 grep 证明无覆盖 + 指出须等就绪再拉；一道题带出 7a9107e/7b86522 两个修复点 |
| 2026-10-update-silent-blackhole | 静默安装三连败零提示 + && 链跳过托盘拉起致整机失联 | 9aa3066 | ✅（10-30，GLM subagent）完整失败链 + 独立推出 stoptray CRLF 根因 |
| 2026-10-tray-menu-flicker | 托盘菜单展开期间每 5s 整份 Clear 重建，悬停/子菜单被重置 | 1dd6b1c | ✅（10-30，GLM subagent）+ 新发现 CheckViaCli 中文子串分类的 i18n bug |
| 2026-10-review-concurrency-cancel | 审查 run 被自身评论触发的空 run 并发取消 | 628fbec | ✅（10-30，GLM subagent）带 Actions run 佐证；**并实证防回环守卫是死代码（已修）** |
| 2026-10-cloud-token-timing | 云端控制台令牌普通字符串比较，时序侧信道可爆破 | 85558ca | ✅（10-30，GLM subagent）两处比较点全找到（登录 + 统一鉴权） |
| 2026-10-orchestrator-backend-default | intent/spec 裸跑炸「未知后端 undefined」 | 27da5b8 | ✅（10-30，GLM subagent）+ 5 个当前版仍活的工具链 bug（见下清单） |
| 2026-10-secrets-cache-invalidation | 另一进程改 key 后缓存不失效，转发持续 401（CORRECT-01） | cf724eb | ✅（10-30，GLM subagent）连中 8 个历史确认缺陷（锁/损坏空表/负缓存/argv 泄漏/EPIPE 等） |
| 2026-10-update-spawn-error | spawn 无 error 监听：更新链失败崩网关 + updating 永久卡死 | 3a79e86 | ✅（10-30，GLM subagent）3 个修复面全中 + 同类第 4 处 |
| 2026-10-update-reminder-once | 常驻网关只在启动时查一次更新，常驻期间永远漏报 | db6354d | ✅（10-30，GLM subagent）+ 失败占成功 TTL 同源问题 + updating 门闩活 bug |
| 2026-10-lan-ratelimit-leak | LAN 限频表按 IP 只增不删，扫描一遍永久驻留（泄漏） | 9366fdc | ✅（10-30，GLM subagent）「邻居先例没跟上」抓手命中 + 空 Bearer 过鉴权活 bug |
| 2026-10-engine-quiet-ignore | 引擎接了 quiet 选项但 diff 预览照常输出（它撒谎） | b9c859a | ✅（10-30，GLM subagent）沿全部调用方核实影响链；同文件 3 个历史修复全中 |
| 2026-10-clean-chore-rm-debug | 噪声对照：纯删除 43 行调试壳（干净改动） | fe53330 | ✅ 无误报（10-30，GLM subagent）——核实后零报告 |
| 2026-10-clean-docs-bench | 噪声对照：新增 bench 基线文档（出题人误标干净） | 6fc99b7 | ❌ 机械口径误报，人工复核=真问题（:34/:56 首字节定义自相矛盾，「它撒谎」命中）——ground truth 标注错误的正例，保留作歧义样本 |
| 2026-10-server-reexport-drop | server.ts 拆分后原导入面 7 个符号未 re-export，外部测试全断 | d039010 | ✅（10-30，GLM subagent）穷尽式核对 13→6 导出 + 逐条对上快照树测试导入；+2 个活缺陷（catalog 缓存永不命中、probe 对 responses 必失败） |
| 2026-10-autoroute-doclink-xss | 控制台 docLinkA href 只做 HTML 转义没做协议白名单，presets.json docs_url 可注入 javascript: | d41f847 | ✅（10-30，GLM subagent）信任边界沿到渲染端 + CSP 拦不住的论证 |
| 2026-10-relay-client-abort | 客户端断开后网关继续向上游转发，非流式长推理白烧 token | d41f847 | ✅（10-30，GLM subagent）同批 ①⑤⑧ 三片全找齐 + Set-Cookie 折叠活缺陷 |
| 2026-10-filemode-route-guard | 删除守卫不区分 harness mode，file 模式误拦 + 悬空 route 残留 | 77fa6b8 | ✅（10-30，GLM subagent）两处守卫 + 3 个活缺陷（providers 统计过期快照/先删密钥后写/ensureProfile 重名） |
| 2026-10-crlf-proc-parse | parsePidCommandLines 不剥 CRLF，Windows 进程枚举恒空（托盘事故真根因） | e4ac854 | ✅（10-30，GLM subagent）同文件换行处理双标也点到；+ stderr 管道钉住父进程活 bug（本机实验坐实） |
| 2026-10-atomicwrite-tmp-leftover | atomicWrite 写入阶段失败不清残留 tmp，受保护目录漏半截文件 | d41f847 | ✅（10-30，GLM subagent）+ withFileLock 重入自死锁（b917687 修复）与孤儿锁 |
| 2026-10-hook-eval-failopen | 守卫 hook evaluateCommand 裸调用，配置损坏即静默失效 | 8c524ec | ✅（10-30，GLM subagent）+ 设计级发现：被守护对象可覆写 policy.mjs 让守卫自杀 |
| 2026-10-gateway-413-drain | readBody 超限立即 reject 413 + resume 排空，与客户端在途写入相撞，SDK 重试成超大包重传循环，413 永远到不了 | 87549d8 | ✅ 审出（首跑撞旧版跑分器 15min 超时一次，补丁后 full-12 中 ✅，见 runs/2026-10-30-full12-glm53flash.md） |
| 2026-10-cim-crlf-parse | parsePidCommandLines 不剥 \r 行尾，PowerShell CIM 输出（CRLF）全行失配，进程枚举恒空，stopTray 静默空转 | e4ac854 | ✅ 审出（证据链复现修复逻辑 + 正则语义分析；附带存疑发现 daemon stderr 管道钉住 CLI 事件循环，经复现坐实为 CORRECT-07，见 runs/2026-10-30-batch2-2026-10-cim-crlf-parse.md） |
| 2026-10-config-memo-alias | loadConfig memo 外借共享 Config 对象，调用方原地改污染缓存，把同步引擎轮询钉进竞态窗口 | 688f98b | ✅ 审出（批二单题与 full-12 双中，报告见 runs/2026-10-30-batch2-2026-10-config-memo-alias.md） |
| 2026-10-env-port-live | cmdEnv 复用写入链的 resolveClientGatewayPort（生产默认端口存活优先），非默认端口实例 env 恒输出 8687 | 87b2106 | ⚠️ 波动（批二单题 ✅ / full-12 ❌ 未命中目标——但其输出另带 diag.ts 3 个自启残留误报类真发现；03:15 第三次采样 ✅，累计 2/3。关键词启发式局限的实录，各轮原文都见 runs/） |
| 2026-10-agents-win-spawn-shell | .agents 编排器 Windows spawn 未带 shell（.cmd 包装直调必 ENOENT）：claude worker 探测带/spawn 不带（探测说可用、起必挂，worker/审查全落 blocked/），orchestrator npm ci 装不上、nightly audit 静默失效 | c99f326 | ⏳ 待首跑（2026-10-30 效能审查回灌；本机 shell 故障未跑，首跑前不计入基线分母） |
| 2026-10-orchestrator-repo-root | findRepoRoot 双实现语义相反（--git-common-dir vs --show-toplevel）且注释自称「同款」：worktree 内跑 orchestrator 把 queue/ 锚进 worktree | c99f326 | ⏳ 待首跑（同上） |
| 2026-10-review-concurrency-group | claude-review 的 auto-review 与 interactive（@claude）共用并发组 + cancel-in-progress：一条评论取消进行中的 auto-review，token 白费 | cc6d832 | ⏳ 待首跑（同上） |
| 2026-10-realhome-write-through | 测试收尾 restoreHomes 后同步引擎长尾 tick 把测试配置整包写进真实 home：stopSyncEngine 不等在飞 tick、单例无 home 钉扎、tick 中途写盘路径随 env 漂移（2026-10-30 生产配置覆盖事故，P0） | f77dc02 | ⏳ 待首跑（2026-10-30 事故回流；首跑前不计入基线分母） |
| 2026-10-jsonpath-tokenizer-regression | CORRECT-08 修复自带回归：tokenize 正则不消费段间「.」，多段点句式全部误判无法解析（develop HEAD 实测 12 例红含 2 例期望矛盾） | f77dc02 | ⏳ 待首跑（2026-10-30 回归回流；首跑前不计入基线分母） |
| 2026-10-finish-lock-wait-contract | 锁心跳改造合入未跑套件：finish-lock 夹具假设 fail-fast 默认，与 T13「默认有界等待 300s」契约冲突——develop test:workflow 3 例红，回归信号被红噪声淹没 | 92a78ac | ⏳ 待首跑（2026-10-30 T15 执行会话回灌；首跑前不计入基线分母） |
| 2026-10-relay-failover-observability | failover 链三处可观测性 lie：数组体改写谎报 modelAfter、全候选 skip 耗尽降级 502 吞 status/hint、replayed_from 只记最后一跳（CORRECT-09） | bf730c6 | ⏳ 待首跑（2026-10-30 T28 修复回流；首跑前不计入基线分母） |
| 2026-10-tray-win32-basename | trayPidsFromProcessLines 用平台相关 path.basename 切 Windows CIM 反斜杠命令行，非 Windows 宿主整类托盘行不命中：9 例单测红恰逢 runner 短缺漏进 develop（生产行为恰因 win32 上两 basename 同义而未坏、更隐蔽） | d6c0a9f | ⏳ 待首跑（2026-10-30 v1.5.1 周期回流；首跑前不计入基线分母） |
| 2026-10-daemon-gatewayjson-tamper-race | daemon 篡改纵深用例与常驻网关查更新回写 gateway.json（真实 started_at）竞态，慢速 arm64 断言偶发红、发版腿才炸（linux-arm64 删 tag 重打） | 815a65d | ⏳ 待首跑（2026-10-30 v1.5.1 周期回流；首跑前不计入基线分母） |

**基线：召回 27/27 审出、零漏报**（10-29 claude CLI 8/8 + 10-30 GLM subagent 19/19）；噪声面 1/2 无误报（另 1 题经复核为出题标注错误、实为正例）。REVIEW.md 无需因漏报补强。此后任何审查者改动（REVIEW.md / prompt / 模型）全量跑分低于基线（21/21，或分段对齐后的新基线）即不保留。新题入库流程（挖题 → dry → 实跑 → 如实记录，未审出照写）见上「怎么加新考题」。

## 怎么加新考题（事故 / 回滚之后必做）

1. 找到修复提交 `<fix>`，`reviewRef` 填 `<fix>^`（bug 在场的最后一个状态）；`files` 填根因所在文件。
2. `expect` 填根因关键词（函数名 / 特征串），宽松一点没关系——打分是启发式，精确判定看模型原文。
3. `note` 写清为什么当时的流程没拦住（哪一层的洞），对应的堵法落进 REVIEW.md / lint / prompt。
4. 跑一次确认能复现「审出」或「没审出」，如实记录——没审出的题才是最有价值的题。
5. 成题前提是「bug 在场 + 修复提交」都在树上；同提交内自纠（坏版本从未进树）的坑进「执行坑复盘」，不成题。

## 怎么跑

```bash
node scripts/review-eval.mjs --dry                 # 只打印组装好的 prompt，不调模型
node scripts/review-eval.mjs                       # 全量跑（走本地 claude CLI 与其已配端点）
node scripts/review-eval.mjs --case 2026-10-update-stoptray
node scripts/review-eval.mjs --model deepseek-v4-pro   # 透传给 claude --model
node scripts/review-eval.mjs --timeout-min 25      # 单题超时（默认 15 分钟；超时/报错记「运行失败」继续其余题）
node scripts/review-eval.mjs --out eval-report.md  # 报告落盘（默认只打印 stdout）
```

- 前置：本机装有 `claude` CLI 并已登录 / 配好端点（脚本只透传环境，不自带 key）；CLI 不可用时可用 ZCode 会话模型 subagent 评分（2026-10-30 起的既有口径，报告照落 runs/）。
- 打分是**启发式**（关键词命中），只作趋势参考；是否真审出，看报告里附的模型原文。
- 频率：事故后随手跑；改了审查者（REVIEW.md / prompt / 模型）之后必跑一次全量。
- 历次报告落 `runs/`（含模型原文；报告里引用的临时目录路径已随清理失效，以原文内嵌为准）。

## 评测循环产出（2026-10-30 夜训）

跑分之外，审查者顺带挖出的**当前版本仍存活**的问题（每条都有文件+行号证据，详见对应 runs/ 报告）：

- **已修（本仓库同一提交）**：claude-review.yml 的 `[dependabot-fix]` 防回环守卫是死代码（merge 检出的 `git log -1` 永远匹配不上前缀）——两处 guard 改读 `github.event.pull_request.head.sha` 的提交 subject。
- **修复清账（2026-10-30，21 条全部落成编号任务卡并修复合并）**：
  - 已修：orchestrator 五项（06/09 号卡，54b0602/6fa7775）；lan 空 Bearer 过鉴权 + buildLanStatus host（01 号卡）；webupdate updating 门闩（04 号卡，b7b91ad）；托盘 C# 三项（10 号卡，b338cb1，含 CLI 侧 update --json 配套）；bench 文档定义矛盾（11 号卡，0445dbf）；providers 三项（05 号卡，06a5940）；shared.ts stderr 管道钉死 + 乱码（03 号卡，7d21df0）；policy-dispatch 自杀面 + null 崩溃（02 号卡，c32451c）；relay Set-Cookie 折叠（07 号卡，035f99b）。
  - **08 号卡已修（9bfed39，本次合并落地）**：model-catalog 视图缓存命中修复（fullKnownTable/knownMetaTable 引用稳定化）+ probe() 补 responses 协议分支——至此 21 条全部清账。
- **方法论收获**：审出率 100% 说明「给足 REVIEW.md 纪律 + 干净单文件考题」的组合对这类历史 bug 召回充分；出题的瓶颈在**选题**（批次修复提交一文件多 bug 归因不清、需部署上下文的题、超 120KB 的巨型文件都要避开）。

### 基线记录

- **2026-10-29（claude CLI 2.1.214，Windows 端）**：全量 8/8 审出。
- **2026-10-30（claude CLI 2.1.310 + GLM-5.3-Flash，经沙箱网关 claude-direct→Volces plan）**：全量 12 题单轮 **10/12**（原 8 题 7/8，批二 4 题 3/4）；两题未命中目标但模型输出均含同文件真发现（详见上表 ⚠️ 行）；全部 12 题在跨轮中至少审出一次（cloud-null-body 2026-10-29 ✅；env-port-live 批二单题 ✅）。同模型同考题跨轮波动实测存在，单轮未审出 ≠ 召回失效。**03:15 第三次采样**：两道波动题单题复跑均 ✅（runs/resample-*.md）——cloud-null-body 与 env-port-live 各累计 2/3 命中，波动定性成立（边界题的轮次方差，非系统性漏报）。**04:35 原 8 题第二次采样：8/8 全部审出**（runs/sample2-*.md，约 46 分钟）——核心基线回归满分；cloud-null-body 跨四轮累计 3/4，是全集波动最大的一道题。
- **基线口径（自 2026-10-30 起）**：审查者任何改动（REVIEW.md / prompt / lint / 模型）全量重跑，**单轮 ≥10/12 且原 8 题 ≥7/8** 视为基线保持；跌破则改动不保留，且必须读原文判读是「目标未命中」还是「启发式未命中」。
- **2026-10-30 增补 3 题**（2026-10-29 效能审查回灌：T14 修复对 ×2 + T19 修复对 ×1，见上表末三行）：首跑未做（执行会话本机 shell 故障），**首跑记录前不计入基线口径分母**；第三题 fixedBy 已随 T19 合入（cc6d832）回填。
- **2026-10-30 增补 1 题**（finish-lock-wait-contract，T15 执行会话回灌）：锁心跳改造合入时 test:workflow 3 例红未跑直接合入的逃逸——bug 在场 cb958be、修复 92a78ac 成对完整；首跑待补，不计入基线分母。
- **2026-10-30 增补事故考题**（realhome-write-through）：用户生产 ~/.modeldock 被测试写穿（config/secrets 被测试夹具整包覆盖）的真实 P0 事故回流，fixedBy=f77dc02（真实 home 写入门禁 + sync 引擎 home 钉扎）。题目只收 engine.ts 单文件（fsx 漏斗第二层门禁不在文件清单内）；首跑待补，跑前不计入基线分母。
- 本批同期副产物（夜巡 + 噪音对照实验，详见 runs/2026-10-30-night-summary.md）：**CORRECT-07**（`gateway start --daemon` 就绪后 CLI 不返回，P1）、**CORRECT-08**（jsonpath 括号句式静默写歪键 / star 裸崩，P2）、**CORRECT-09**（relay failover 可观测性三项，P2）——均实测复现、未修；修复后可按「怎么加新考题」回流为考题。新题入库流程（挖题 → dry → 实跑 → 如实记录，未审出照写）见上「怎么加新考题」。

## 噪音测量（clean 对照，2026-10-30 起建立）

参照原论文的第二个评测维度（在已知干净代码上跑审查者、数误报）：选历史稳定文件（如 init 后零改动、扛过多轮全仓审查的 `src/util/diff.ts`、`src/util/jsonpath.ts`），用**中性 prompt**（不断言存在 bug，只要求「确证才报，没有就明说通过」）跑同一审查者。注意与考题 prompt 的差别：考题断言「之后补了一个修复」会诱导找茬，测噪音必须去掉该断言。首测：diff.ts **0 误报**；jsonpath.ts 报 2 个问题——**逐条实证均为真缺陷**（CORRECT-08），不是误报——「干净对照」的挑选本身要经得起审查，被审出的对照文件按其价值转为缺陷记录。**03:20 复跑（runs/noise-jsonpath-rerun.md）**：前两条精确复现（审查者自行读到 known-issues 的 CORRECT-08 登记并标注「已登记」），另报第 3 处同族缺陷（对象上下文用下标写入静默产键 `"0"`，tsx 实测坐实，已并入 CORRECT-08）。噪音报告见 runs/noise-*.md。

## 执行坑复盘（2026-10-30 效能卡批次，未成标准考题的过程坑）

来源：T14/T22/T24 执行会话（详见各卡 NOTES 与 memory `optimization-handoff-status`）。这些坑都被分支内验证链当场拦住（未逃过测试/运行），**没有「bug 在场 + 修复提交」对，无法按标准 schema 成题**——但每一类都是未来拆分/搬移类 PR 的真实审查点，堵法已落 REVIEW.md「拆分/搬移类 refactor」节；日后若有同类缺陷真正逃过审查（如 worker 拆分漏改门禁却蒙混合并），按上节流程以那时的 reviewRef 挖题入库。

1. **静态门禁扫描面未跟随文件搬家**（T22）：模板抽新模块后 ui-lint 仍按旧路径读 lan.ts，npm test 2 红（`--bg 在对方文件缺失` / 白名单条目全部不命中）。堵法：拆分 PR 必须同步所有按路径读源的静态门禁/生成脚本的文件清单——审查者对拆分 diff 先 grep 门禁里的文件名。先例：T04 的 SRC_UI 拼接模式。
2. **搬移函数的可见性接线遗漏**（T22）：`renderDeniedPage` 原为文件内私有函数，整函数逐字节搬进新模块后未加 `export`，lan.ts import 即 `SyntaxError: does not provide an export named`。教训：**对拍只覆盖搬移的内容，接线是新增面**——import/export/re-export 必须经 tsc + 运行验证，靠「逐字节搬了」的直觉不兜底。
3. **对拍脚本自身的行号边界**（T22）：切片 diff 两次切偏（多算 1 空行 / 少算函数尾 `}`），靠 diff 输出暴露。堵法：切片边界用首尾行内容 `assert` 锚定（`assert lines[360].startswith('export function renderMobilePage')`），不用裸行号。
4. **SIGTERM 杀网关不退**（T22 手测收尾）：`kill` 后 2 秒监听仍在，需 SIGKILL。AGENTS 硬规则 4「清理后核实再收工」的实战形态：杀完必须 `lsof -iTCP:<port> -sTCP:LISTEN` 复核，而不是假定信号生效。
5. **手测 API 三连 404/403**（T22 手测）：路由是 `/m` 非 `/m/`、入口参数是 `?token=` 非 `?t=`、manifest/icon 鉴权只认 cookie/Bearer（`?token=` 仅页面入口种 cookie；cookie 名还内嵌端口）。堵法：手测前先读路由与鉴权实现，参数名与路径不猜。
6. **跨域帮手按卡字面归属会成循环 import**（T24 预研）：卡点名两个「跨域帮手」的归属，实际真正跨域的是第三个（`resolveClientGatewayPort` 被②③双向使用）——按域归属必成 ②⇄③ 环，最终独立成 `ops/gateway-port.ts` 破环。教训：拆分卡动手前先画依赖方向图，卡上的归属是提示不是结论。
7. **接管 worktree 前必须核实活跃信号**（T13 撞车避让）：worktree 里已有非本会话的未提交改动时，用「文件 mtime 距今 + NOTES 是否仍是模板 + 有无 commit」判定对方是否在跑——本会话据此全程避让 T13 worktree，避免双 agent 同写。
8. **「gate 验证树 == 合并树」比较被流程自身破坏**（T13）：worker `git add -A` 把 worktree 本地 NOTES.md 带进分支，finish 又在 gate 之后用专用提交移除——HEAD 前进一提交但除 NOTES.md 外树不变；gate-skip 的「HEAD 相等」判定据此误判回落全量。堵法：比较树内容（`git diff --quiet A B -- . ':(exclude)NOTES.md'`）而非 sha 相等；凡树等值断言，必须把流程自身移动 HEAD 的环节（提交/移除/搬运）算进排除集。
9. **SIGKILL 后立即 kill(pid, 0) 判活不可靠**（T13 锁测试）：被杀进程在父进程 reap 前是僵尸，`kill(pid, 0)` 恒报存活——测试父进程阻塞在 execSync 期间永不 reap，锁等待方把僵尸当活持有者等满上限（实测挂 300s）。堵法：测试造「已死 pid」让占位进程自然退出并 await exit 事件后再写锁；审查测试类 PR 时对「spawn + kill + 立即判活」模式保持警惕。
10. **临时仓库夹具 .gitignore 与真实仓库不对齐**（T13）：mkRepo 漏了 `.agents/worktrees/` 忽略，主仓库一次 `git add -A` 把任务 worktree 收成 embedded repo（gitlink），finish 的基准分支清洁检查误报退出 1。堵法：夹具 ignore 清单与真实仓库对齐；主仓库 `add -A` 前先看 status 是否混入意外路径。
11. **负向场景夹具先自检前置状态**（T13 ③c）：造了「定时删锁的持有者」却没先创建锁文件，等待方首轮即拿到锁，「等待日志」断言必红。教训：造「X 中途发生」的夹具，先断言 X 前的状态真实存在。
12. **排序类前提未查证框架机制**（T21 预研）：审查报告断言 zz-quickwins「押文件名字典序」在 uninstall.test 之后跑，实际 vitest 按历史运行时长缓存排序（慢者先行，非字母序）——照卡实现的守卫会在排序漂移时误报/漏报。堵法：守卫写成与排序无关的不变量（mock 属主关系、不重复 mock）；「押某种顺序」类前提动手前查框架文档或实测。