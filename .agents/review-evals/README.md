# 审查评测集（review evals）

> 设计来源：Anthropic《How the Claude Code team does code review》的改进闭环——
> **每次事故 / 回滚都变成一道考题**：收集真实逃过审查的 bug，让审查者对着它跑分；
> 审查者的任何改动（REVIEW.md、workflow prompt、lint、模型）都先在全量考题上重跑，分数升了才保留。

## 目录结构

- `cases/*.json` —— 考题。一道题 = 一次真实逃过审查的 bug。
- `scripts/review-eval.mjs`（仓库根 scripts/）—— 运行器：物化修复前代码 → 组装审查 prompt → 交给本地 claude CLI → 按 expect 关键词打分。

## 考题 schema

```jsonc
{
  "id": "2026-10-update-stoptray",      // 唯一 id，日期前缀
  "title": "一句话说清这个 bug 造成的用户可见后果",
  "reviewRef": "22f20fd^",              // 审查对象：修复提交的父提交（bug 当时在场的代码状态）
  "fixedBy": "22f20fd",                 // 实际修复提交，供回溯
  "files": ["src/update/install.ts"],   // 让审查者看的文件（从 reviewRef 物化）
  "expect": ["stoptray", "tray"],       // 打分关键词：审查输出命中即算「审出了」（小写比较）
  "note": "根因与来源，写清为什么当时漏过"
}
```

**噪声对照题（cleanSha 模式）**：`expect` 留空、加 `"cleanSha": "<提交>"`——物化该提交对 files 的 **diff**（而非文件内容），考「已知干净的改动不该报问题」；审查输出报「发现 N 个问题」即记误报。出处：文章的噪声度量（拿已知干净的 PR 考审查者）。注意 ground truth 要标对：clean-docs-bench 题就是出题人把「有真矛盾的文档改动」错标成干净（见其报告）。

## 怎么加新考题（事故 / 回滚之后必做）

1. 找到修复提交 `<fix>`，`reviewRef` 填 `<fix>^`（bug 在场的最后一个状态）；`files` 填根因所在文件。
2. `expect` 填根因关键词（函数名 / 特征串），宽松一点没关系——打分是启发式，精确判定看模型原文。
3. `note` 写清为什么当时的流程没拦住（哪一层的洞），对应的堵法落进 REVIEW.md / lint / prompt。
4. 跑一次确认能复现「审出」或「没审出」，如实记录——没审出的题才是最有价值的题。

## 怎么跑

```bash
node scripts/review-eval.mjs --dry                 # 只打印组装好的 prompt，不调模型
node scripts/review-eval.mjs                       # 全量跑（走本地 claude CLI 与其已配端点）
node scripts/review-eval.mjs --case 2026-10-update-stoptray
node scripts/review-eval.mjs --out eval-report.md  # 报告落盘（默认只打印 stdout）
```

- 前置：本机装有 `claude` CLI 并已登录 / 配好端点（脚本只透传环境，不自带 key）。
- 打分是**启发式**（关键词命中），只作趋势参考；是否真审出，看报告里附的模型原文。
- 频率：事故后随手跑；改了审查者（REVIEW.md / prompt / 模型）之后必跑一次全量。
- 历次报告落 `runs/`（含模型原文；报告里引用的临时目录路径已随清理失效，以原文内嵌为准）。

## 现有考题

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

**基线：召回 27/27 审出、零漏报**（10-29 claude CLI 8/8 + 10-30 GLM subagent 19/19）；噪声面 1/2 无误报（另 1 题经复核为出题标注错误、实为正例）。REVIEW.md 无需因漏报补强。此后任何审查者改动（REVIEW.md / prompt / 模型）全量跑分低于基线（21/21，或分段对齐后的新基线）即不保留。新题入库流程（挖题 → dry → 实跑 → 如实记录，未审出照写）见上「怎么加新考题」。

## 评测循环产出（2026-10-30 夜训）

跑分之外，审查者顺带挖出的**当前版本仍存活**的问题（每条都有文件+行号证据，详见对应 runs/ 报告）：

- **已修（本仓库同一提交）**：claude-review.yml 的 `[dependabot-fix]` 防回环守卫是死代码（merge 检出的 `git log -1` 永远匹配不上前缀）——两处 guard 改读 `github.event.pull_request.head.sha` 的提交 subject。
- **修复清账（2026-10-30，21 条全部落成编号任务卡并修复合并）**：
  - 已修：orchestrator 五项（06/09 号卡，54b0602/6fa7775）；lan 空 Bearer 过鉴权 + buildLanStatus host（01 号卡）；webupdate updating 门闩（04 号卡，b7b91ad）；托盘 C# 三项（10 号卡，b338cb1，含 CLI 侧 update --json 配套）；bench 文档定义矛盾（11 号卡，0445dbf）；providers 三项（05 号卡，06a5940）；shared.ts stderr 管道钉死 + 乱码（03 号卡，7d21df0）；policy-dispatch 自杀面 + null 崩溃（02 号卡，c32451c）；relay Set-Cookie 折叠（07 号卡，035f99b）。
  - **待修（唯一剩余，08 号卡 pending）**：`src/gateway/server.ts`——/_modeldock/model-catalog 视图缓存永不命中（fullKnownTable 每次 spread 新对象，注释宣称的缓存优化不存在）；probe() 对 responses 协议服务必失败且报错误导（server-reexport-drop 题审出）。
- **方法论收获**：审出率 100% 说明「给足 REVIEW.md 纪律 + 干净单文件考题」的组合对这类历史 bug 召回充分；出题的瓶颈在**选题**（批次修复提交一文件多 bug 归因不清、需部署上下文的题、超 120KB 的巨型文件都要避开）。
