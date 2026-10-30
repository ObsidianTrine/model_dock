# 首跑报告 — 2026-10-daemon-gatewayjson-tamper-race

- **日期**: 2026-10-30（v1.5.1 发布周期事故回流批，batch3）
- **评分器**: ZCode 会话模型 subagent（GLM-5.3-Flash），tool-free（禁读仓库/git 防剧透），prompt 由 `node scripts/review-eval.mjs --dry --case 2026-10-daemon-gatewayjson-tamper-race` 组装（REVIEW.md + test/daemon-lifecycle.test.ts@815a65d^ 全文）
- **结果**: ✅ 审出（启发式关键词 `started_at` 命中；人工判读见下）
- **判读**: 目标机制落在「存疑」区第一条——「test 4 篡改窗口：:236 直接覆写活网关名下的 gateway.json。若网关启动后存在 state 重写路径（心跳等），篡改值可能在二次 start 读取前被『治愈』，:238 的 exit 1 断言偶发翻车」。机制与真实事故一致（周期写手闯进篡改窗口 → exit 1 断言偶发红）；写入者归因「心跳」不准，实为查更新回写 started_at（考题只给了测试文件，看不到 src/update，归「缺证据不报」纪律内）。另带 4 个真发现：exitCode 判定漏 signalCode（:99/:108 盲等 10s）、test 1 注释称 exit 0 却未断言退出码（对照 test 4 :238 有断言）、startGateway 无 error 监听（spawn 失败打崩 worker 沙箱不还原）、runCli 按 chunk toString 多字节截断。
- **出题侧记录**: 单题耗时 ~9.4 分钟 / 77.6k tokens。

## 模型原文

发现 4 个问题

**1. exitOf/stopChild 的退出判定只认 exitCode，漏了 signalCode（中）**
- 位置：test/daemon-lifecycle.test.ts:99、:108（守卫均为 `child.exitCode != null`）、:101（`child.once('exit')`）。
- 证据：子进程被信号终止时 exitCode 为 null（信号记在 signalCode），且 'exit' 事件只发一次、不补发。对「已信号死亡」的 child：守卫放行 → `kill('SIGKILL')` 成空操作 → `once('exit')` 永不触发 → 只能等 :102 的 10s 超时兜底。
- 后果：stop 用例中网关由 stop CLI 的 SIGTERM 终止（:181-183）。若网关是默认终止（未装 handler），:183 与 finally :190 各盲等 10s，该用例每次多耗约 20s（POSIX；Windows 的 TerminateProcess 记为正常退出码，不触发）；stopChild 注释（:106）承诺「必须先等 exit 才删沙箱」，此时退化为固定超时。同时测试标题断言「SIGTERM 优雅退出」，但 exitOf（:98-104）返回 void、丢弃退出码/信号——网关究竟优雅退出还是被硬杀，本套件实际测不出来。

**2. test 1 声称「拒绝且优雅退出（exit 0）」却未断言退出码（低）**
- 位置：:157-160。注释明确 exit 0，代码只断言 `second.output` 含「网关已在运行」；对照 test 4 的 :238 是断言了 `second.status === 1` 的。拒绝路径若回归成 exit 1 或异常退出且文案不变，此用例照样绿。

**3. startGateway 未挂 'error' 监听（低）**
- 位置：:64-71。spawn 失败（CI 资源耗尽 EAGAIN 等）时 ChildProcess 发出的 'error' 无人处理 → 未捕获异常打崩 worker，finally 不执行：沙箱不还原、子进程收尾全部跳过。runCli（:58）有兜错，唯独拉起网关的入口没有。

**4. runCli 按 chunk 逐段 toString，多字节中文可被截断（低）**
- 位置：:56-57。`out += d.toString()` 在 chunk 边界劈开 UTF-8 序列时产生替换符，`:toContain('网关已在运行')` 类断言会误红；应 `setEncoding('utf8')` 或 Buffer 聚合后统一解码。当前输出量小、通常单 chunk，触发概率很低，属防御性修正。

存疑（证据不足，不作为问题上报）：
- test 4 篡改窗口：:236 直接覆写活网关名下的 gateway.json。若网关启动后存在 state 重写路径（心跳等），篡改值可能在二次 start 读取前被「治愈」，:238 的 exit 1 断言偶发翻车。缺 src/gateway 运行态代码确认。
- 沙箱参数被无视：readState/writeState（:113、:137）收了 sandbox 不用，waitStateFile/readStateSafe 干脆无参，全部裸调 `gatewayStatePath()`（:114、:122、:131、:139）——仅当 helpers 的 fakeHome() 会设置父进程 `MODELRDOCK_FAKE_HOME` 时才正确；若不会，这些读写落向真实 home 的 gateway.json，且 :139 的裸 writeFileSync 不受写入门禁拦截（门禁只拦 atomicWrite/withFileLock）。需 helpers.js 确认。
- deadPid 的 Windows 侧缘（:31-35）：Windows PID 复用激进，死 pid 可能在网关做陈旧锁复核前被复用 → 误判「存活」拒绝启动，test 3 在 Windows CI 偶发红。概率低，缺 CI 数据。
- gatewayLive 对 `started_at: '2000-01-01'`（:236）的语义：若「过旧」被判为陈旧锁而走接管而非 startForeground 拦下，:238-239 的预期整体不成立。需 gatewayLive 实现确认。
- 顺带：:202 写死 `port: 59999`（在 mac/Windows 临时端口范围内），当前仅作数据、无人监听，无害；若接管逻辑将来加「探测旧端口」，撞上同机临时监听会翻车。
