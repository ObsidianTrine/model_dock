# 审查评测报告

- 考题：1，审出：1，未审出：0
- 评分口径：expect 关键词命中（启发式），精确判定看原文

## 2026-10-fsx-idle-flush — ✅ 审出

- 考题：appendLine 常驻流池只进不出、无空闲刷盘——Windows gateway stop 是 TerminateProcess（无信号语义）drain 走不到，最后缓冲的尾部日志随进程一起丢
- 关键词：appendline=中，flush=未中，落盘=中，丢失=中
- 完整输出：C:\Users\81424\AppData\Local\Temp\modeldock-review-eval-bQHUQn\2026-10-fsx-idle-flush.output.txt

<details><summary>模型原文</summary>

```text
证据链齐了。`src/cli/shared.ts:125-137` 证实 Windows 停网关是 `taskkill /T /F` 硬杀（"Windows 无信号语义，SIGTERM 即硬杀"），`main.ts:239` 的 `drainAppendStreams` 只挂在优雅关停路径。以下是审查结论。

---

## 发现 2 个问题

### 1. [高] appendLine 常驻追加流无空闲刷盘：Windows 停网关硬杀丢日志尾
**src/util/fsx.ts:318-335（appendLine）、366-386（drainAppendStreams）**

证据链：

- `appendLine` 建流后（`createWriteStream`，默认 highWaterMark 16KB）**永不主动 end**——除 APPEND_STREAM_CAP=8 淘汰（line 327-332）与显式 close 外，缓冲一直驻留。
- 快照自身的 `drainAppendStreams` 注释（line 363-365）已承认这是常驻流引入的持久性缺口："直接 process.exit 会丢掉尾部尚未刷盘的日志行——appendFile 时代每条独立落盘不会有此问题"。但该缺口在快照里**只补了优雅关停路径**：`drainAppendStreams` 仅由 `main.ts:239` 在 `process.exit(0)` 前调用。
- Windows 上 gateway stop 是 `taskkill /T /F` 硬杀（`src/cli/shared.ts:125-137`："Windows 无信号语义，SIGTERM 即硬杀且不管子树"）→ 无信号处理器运行 → cleanup 走不到 → 最后缓冲的尾部日志（最坏窗口直到下次 stop）随进程一起丢。unix 下崩溃 / kill -9 同样命中。
- 已验修复：0ba0d65 正是补这个洞——APPEND_IDLE_MS=3000 的 idle sweep（1s 定时扫描，空闲流 end 强制落盘、下条写入按需重建），close/drain 路径停 sweep 定时器。

### 2. [中] 写入错误全静默：持久故障（磁盘满等）下请求日志零观测面丢失
**src/util/fsx.ts:324** — `ws.on('error', () => {})`

- 磁盘满 / 权限 / EIO 等错误被完全吞掉：不计数、不打日志、无健康信号。磁盘满这类故障可持续数小时，期间每条请求日志静默丢失，运维毫无察觉。注释虽声明「写入错误静默」为设计，但"全静默"使持久故障完全没有观测面。
- 已验修复：b84a32d（observability）改为首次失败打一条双语日志、此后计数，经 `appendLineErrorCount()` 暴露给 `/_modeldock/health` 的 `log_write_errors`。

---

## 存疑

- **acquireFileLock 陈旧锁抢占（src/util/fsx.ts:256）**：持锁者若临界区超过 15s（慢 fsync / 网络盘 / 进程挂起）会被误判为死亡而抢占，两个写者同时进入临界区 → 丢更新。注释声明「临界区内不应有慢 I/O」，但 `withFileLock` 的 job 由各调用方实现。缺证据：未逐一核验所有 `withFileLock` 调用点的临界区时长上界。
- **appendLine 忽略背压（line 321、333）**：`write()` 返回 false 仍继续写，磁盘停顿时 Node 内部缓冲持续增长，高频请求下内存可能膨胀。缺证据：未实测磁盘停顿场景，且该模式在后续版本仍保留（可能另有上限约束，需查调用方）。

## 排除项

- `MODELRDOCK_FAKE_HOME`（line 58/77/127）拼写异常但**非 bug**：`src/util/paths.ts:6` 定义的同名变量就是全仓库统一的环境变量名，与 paths.ts 一致。
- `atomicWrite` 的 Windows rename 退避重试、`acquireFileLock` 的 ino/mtime 双重复核、memo 的 TTL 策略——均已验证逻辑自洽且注释与代码一致。
```

</details>