# 审查评测报告

- 考题：1，审出：0，未审出：1
- 模型：glm-5-3-flash-260828
- 评分口径：expect 关键词命中（启发式），精确判定看原文

## 2026-10-soak-warmup-baseline — ❌ 未审出

- 考题：soak 长稳压测 RSS 判泄漏用「末值 vs 首值」口径：Node 网关冷启预热（JIT/堆扩张/缓冲池）在流量启动后数分钟内 RSS 134→220MB 并随后 2.5h 严格走平，4h 实测按首值口径误判 +79.1% FAIL——真实稳态被当泄漏，机械结论直接错误；正解 = 基准取预热窗结束后首个采样，平台判定仅辅助判读
- 关键词：预热=未中，基准=未中，平台=未中
- 完整输出：/var/folders/vw/7vttg54s74ng208jp5063f0c0000gp/T/modeldock-review-eval-DXVrNJ/2026-10-soak-warmup-baseline.output.txt

<details><summary>模型原文</summary>

```text
发现 3 个问题

## 1. 端口白名单校验抛错路径泄漏网关孤儿进程（scripts/soak.mjs:605）

`assertPortSafe(Number(st.port))` 在 `ctx.child = c`（:606）**之前**执行，且 `fail()` 直接 throw 到顶层 catch。当 `listenWithRetry` 顺延到 18919 之外（这正是该检查要拦的场景）时：

- throw 时 `ctx.child` 仍为 `null` → `cleanup()`（:801）的 `killTree(ctx.child)` 跳过，已 spawn 的 detached 网关子进程（unix 独立进程组 / Windows 独立存活）无人终止；
- `ctx.gport` 也是 0 → `cleanup()` 的端口核实（:840）不覆盖该端口，孤儿完全静默；
- 随后 `cleanup()` 还会把沙箱目录 `rmSync` 删掉，孤儿网关拿着已删除的 FAKE_HOME 继续跑。

对照 ：610/:613 的两条失败路径都先 `killTree(c)` 再继续——唯独红线守卫这条最该杀的路径漏了。修法：赋值 `ctx.child = c` 提前到 `assertPortSafe` 之前，或在抛错前先杀。

## 2. jsonlStats 增量读按字节切分，多字节 UTF-8 跨块截断导致日志行永久漏计（scripts/soak.mjs:223-233）

按字节偏移 `readSync` 后直接 `buf.toString('utf8')`：若读取恰好落在写入中间态且切点位于多字节字符（中文报错文案经 `JSON.stringify` 不转义、原文进日志）中间，两侧各自解码出 U+FFFD，拼接后的行 `JSON.parse` 永远失败 → `countLogLine` 静默返回 null（:264），该行计不进 totalLines/totalErrors。代码用 `st.partial` 明确处理了「读到半行」场景（说明承认读到写入中间态可能），但半行机制对 UTF-8 截断无效——坏字节留在 `st.partial` 里，下轮补齐也救不回。后果：一个以「日志增长/错误率实测证据」为产出工具的计数口径失真。

## 3. jsonlStats readdir 失败早退分支返回形状不一致，CSV/样本写入 `undefined`（scripts/soak.mjs:209）

`:207-210` 的 catch 早退返回 `{ lines, errors, bytes }`，缺 `totalLines`/`totalErrors`；调用方 `sampleOnce`（:646-648）直接读 `s.totalLines`/`s.totalErrors` → `samples` 记录与 metrics.csv 写入字面 `undefined`。logsDir 尚未建立（网关首条日志落盘前的采样，如「首值」采早了）即触发。应返回 `{ lines, errors, bytes, totalLines: state.totalLines, totalErrors: state.totalErrors }`。

## 存疑

- **:40 `import.meta.url`**：字面踩 REVIEW.md 红线 #4，但红线动因是 SEA 打包、`src/` 才受约束；scripts/*.mjs 不进 SEA 包且 :11 自述与 ui-smoke.mjs「同款处理」（该文件大概率同写法）。缺 ui-smoke.mjs 对照，不确定是否算违例。
- **childEnv（:88-92）未设 `MODELRDOCK_TEST=1`**：AGENTS.md 隔离配方要求成对指定；但写守卫只看落点、FAKE_HOME 已指向临时目录，实际影响需看 fsx.ts 实现才能定。
- **:268 `status === null` 计为错误**：若网关往 gateway-*.jsonl 混写无 `status` 字段的生命周期行（启动/config reloaded 等），会被全部计成错误造成假 FAIL；:773 对 `/v1/models`、admin 轮询是否入日志的假设同样依赖网关实现，本片段无法证实。
```

</details>