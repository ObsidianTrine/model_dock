---
id: fix-daemon-start-cli-hang
type: fix
created_at: 2026-10-30T04:45:00+08:00
created_by: agent
files_hint:
  - src/cli/shared.ts
  - src/gateway/main.ts
  - test/daemon-lifecycle.test.ts
workflows:
  - feature-branch
gate: L3
---

# 目标
修 CORRECT-07（P1）：`gateway start --daemon` 在 daemon 就绪后 CLI 不返回——脚本/终端被钉住（实测 ≥45s，另一例约 13min 后才自行退出）。修完标准：**就绪探测成功后 CLI 秒级退出**，且 daemon 崩溃/启动报错仍可追（日志不消失）。

# 背景（行号基于 2026-10-30 develop @9785a9a，动手前先读源码确认仍成立）
- 根因：`spawnDaemonAndWait`（src/cli/shared.ts:47-105）以 `stdio: ['ignore','ignore','pipe']` 拉起 daemon 后，父 CLI 给 `child.stderr` 挂 `'data'`/`'close'` 监听做 daemon 日志转写（:76-90）。`child.unref()`（:66）只把**子进程句柄**移出引用计数，不移除 stderr 管道读端对事件循环的引用——daemon 常驻、其 fd 2 永不关闭（src/gateway/main.ts 无任何 stderr 重定向/自关），父 CLI 的 read 流挂着 `'data'` 监听处于 flowing 态且被引用 → 就绪探测返回后事件循环排不空，CLI 挂住。
- 实测（2026-10-30 凌晨，macOS + tsx 直跑，沙箱实例 18901）：端口已 LISTEN 后 CLI ≥45s 不返回（人工终止）；另一例 ~13min 后自行退出（退出机制未查明，推测与 tsx 子进程链的 fd 2 传递有关；**SEA 单文件形态未测**，修复须两形态都覆盖）。
- 连带观察（待顺带核查）：当晚两次「杀掉挂住的 CLI 包装进程，daemon 也跟着死」——`detached: true + child.unref()` 理论上不该连带，实测出现。修复时顺带核实 detached 语义是否真正生效（macOS `ps -o ppid` 看daemon 是否 reparent 到 launchd；Windows 看 job object），若未生效一并修。
- 完整登记：docs/known-issues.md §三 CORRECT-07。影响面：所有经 spawnDaemonAndWait 的路径（gateway start --daemon 等）；`--autostart`（直起 daemon）与 run_dev（tsx watch）不受影响；`gateway stop` 等不 spawn daemon 的命令不受影响。

# 实施要求
1. **主修方向（推荐）**：daemon 侧自写日志——daemon 进程自己把 stderr 落到 `logs/daemon-<date>.log`（main.ts 启动早期接管 fd 2 或改走 appendLine），父进程 spawn 改 `stdio: ['ignore','ignore','ignore']` 并删掉 :76-90 的转写段。注意保留现有语义：按天文件名、`pruneExpiredLogs` 保留期、跨 chunk 半行缓冲（这段逻辑从父侧迁到 daemon 侧，`line.replace(/\r$/, '')` 的 Windows 换行归一别丢）。
2. **备选方向**（若主修方向有未预见的循环依赖/启动时序问题）：保留父侧转写但对 stderr 读端 `unref()`，并处理与 `'close'` 收尾写的时序（unref 后 close 回调仍会在流关闭时触发，确认收尾行不丢）。
3. 两条路径都要过一遍「daemon 启动失败」场景：拉起失败/就绪超时时，报错文本仍能到用户眼前（现在靠父侧转写 + 轮询失败文案；改后确认不静默蒸发——这是当初从 stdio 全 ignore 改成 pipe 的动机，见 :60-63 注释，别修挂退回旧坑）。
4. 顺带核查上面「连带观察」的 detached 语义，结论写进提交说明（无论是否需改动）。
5. 修复合入后按 `.agents/review-evals/README.md`「怎么加新考题」把本 bug 回流为审查评测考题（reviewRef=修复提交^，files=[src/cli/shared.ts]，expect 关键词自修复 diff 提取；实跑经沙箱网关，配方见 review-eval-night 记忆/README）。

# 验收标准
- 新增定向回归（test/daemon-lifecycle.test.ts 或新文件）：真起 daemon（FAKE_HOME 沙箱 + `--port` 随机 189xx）→ `spawnDaemonAndWait` 返回后**限时 5s 内 CLI 进程退出**；daemon 进程仍存活且端口可连；stdout/stderr 不泄漏到测试输出。
- daemon 启动失败场景用例：坏 argv/端口占用时，用户可见报错仍在（文案断言），`logs/daemon-<date>.log` 仍收到崩溃输出。
- `npm test` 全绿 + 用例数不减；三平台兼容自查：fd 2 接管/日志路径拼接（path.join）/Windows 无信号语义（杀 daemon 用既有 killByPid 树杀语义）。
- `npm run test:workflow` 全绿（动到 CLI 基建）。
- 手测一次（沙箱配方：`MODELRDOCK_FAKE_HOME=<独立目录> npx tsx src/cli.ts gateway start --port 189xx --daemon`，`time` 计时 <5s 返回）；SEA 形态至少做代码级走查（`npm run build` 后 dist 直跑一次 `gateway start --daemon` 计时）。
- docs/known-issues.md CORRECT-07 条目勾选并标注日期与 commit（维护约定 1）。

# 红线
- 不碰 8687（生产）/8890（用户 dev）：测试一律 FAKE_HOME + 189xx 成对；不监听写死端口。
- 不改 `src/cli.ts` 三路分发；不改 fsx 流池既有语义；不动 `--autostart` 直起 daemon 的路径（它不经 spawnDaemonAndWait）。
- daemon 日志保留期/目录约定不变（logs/daemon-<date>.log，随 pruneExpiredLogs 清理）。
- 错误文案走 t() 双语（新增文案两个语言参数同写）。
