# 审查评测报告

- 考题：1，审出：1，未审出：0
- 模型：glm-5-3-flash-260828
- 评分口径：expect 关键词命中（启发式），精确判定看原文

## 2026-10-fsx-idle-flush — ✅ 审出

- 考题：appendLine 常驻流池只进不出、无空闲刷盘——Windows gateway stop 是 TerminateProcess（无信号语义）drain 走不到，最后缓冲的尾部日志随进程一起丢
- 关键词：appendline=中，flush=未中，落盘=中，丢失=中
- 完整输出：/var/folders/vw/7vttg54s74ng208jp5063f0c0000gp/T/modeldock-review-eval-6og4eV/2026-10-fsx-idle-flush.output.txt

<details><summary>模型原文</summary>

```text
发现 3 个问题（已对照仓库现行代码与后续提交逐一核实；主发现即 0ba0d65 所修的 XPLAT-02）。

**1. appendLine 常驻流池无空闲刷盘，Windows 硬杀停机丢日志尾（主发现，行 318–335 / 363–386）**

- 证据：`appendLine` 建常驻 `WriteStream`（默认 16KB 缓冲），只在 LRU 淘汰（行 331）与 `close/drain`（行 338/366）时 `end()`；平时数据停留在缓冲里不落盘。而 Windows 无信号语义，`gateway stop` 走 `taskkill /T /F` 硬杀，行 363 注释里承认的 `drainAppendStreams` 优雅关停路径**根本没机会执行**——最后缓冲的日志尾（每流最长 16KB）随进程丢失；任何平台的崩溃/SIGKILL 同理。
- 失败形态：请求日志的最后若干行在 stop 后永久缺失，且丢失窗口取决于「下次写入/停机」，与停机方式无关地存在。
- 修法（与 0ba0d65 一致）：idle 定时 sweep，流 3s 无写入即 `end()` 强制刷盘、下条写入按需重建，`close/drain` 路径停 sweep 定时器。

**2. withFileLock 同路径嵌套申请必然死锁（行 277–308）**

- 证据：`enqueueLocked`（行 280–291）按 lockFile 串行排队。持有者 job 内再调 `withFileLock(同一 lockFile)` 时，内层 `prev.then(job)` 排在**自身外层 job 完成之后**，外层又 `await job()` 等内层——循环等待，且卡在 promise 链上，连 10s 锁超时都到不了，永久挂死。
- 触发形态：任一调用方在持锁回调里嵌套走 `mutateConfig` 等同一把锁（后续 engine 的 apply+post-collect 原子化正是此形态，CORRECT-06）。修复为 `AsyncLocalStorage` 属主识别、同路径重入内联执行（b917687）。

**3. atomicWrite 写入阶段失败泄漏残留 tmp 文件（行 155–162）**

- 证据：`open/writeFile/chmod/sync` 任一抛错（磁盘满 ENOSPC、权限错）时只有 `finally` 关 fd，**不删 tmp**；行 174 的清理只覆盖 rename 失败路径。目标目录每重试一次漏一份 `.config.toml.<pid>.<rand>` 垃圾。
- 失败形态：config/secrets 所在目录被残留文件堆积；REVIEW.md「更新与安装：半成品文件」类失败。
- 修复佐证：现行代码已包 `catch { rm tmp }`，d41f847 提交信息明说「此前只有 rename 失败清理」。

## 存疑

- **release 归属校验的 read→unlink 窗口（行 244–247）**：读到本 pid 与 `unlinkSync` 之间若锁因超 15s 陈旧被他人抢占再易主，会误删新锁造成双持锁。与行 256–263 抢占路径已做的 ino 复核同类，但触发前提是本进程持锁超 `lockStaleMs`（注释声明临界区无慢 I/O，属已明示接受的务实窗口），故不列为确认缺陷；若要收敛，对称补一次 stat 复核即可。
- appendLine 的 LRU 淘汰按插入序而非使用序（行 319–326 命中时不刷新位置），热流可能被 8 个新文件挤出——后果仅是多一次重建、行序由 O_APPEND 保证，按 REVIEW.md「清理/效率类不报」处理，仅备注。
```

</details>