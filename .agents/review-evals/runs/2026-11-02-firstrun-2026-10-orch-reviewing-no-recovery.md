# 审查评测报告

- 考题：1，审出：1，未审出：0
- 模型：glm-5-3-flash-260828
- 评分口径：expect 关键词命中（启发式），精确判定看原文

## 2026-10-orch-reviewing-no-recovery — ✅ 审出

- 考题：orchestrator reviewing/ 卡硬崩后无恢复路径：run/resume 白名单都不含 reviewing，唯一程序化出口是 abandon 强制落 failed（TRANSITIONS 本就允许 reviewing→running）；reviewer 临时目录（orch-review-*/orch-review-settings-*）每轮 mkdtemp 从不清理，finally 只清 worker 的两个，die() 走 process.exit 连 worker 的也泄漏
- 关键词：reviewing=中，abandon=中
- 完整输出：/var/folders/vw/7vttg54s74ng208jp5063f0c0000gp/T/modeldock-review-eval-Zggg8G/2026-10-orch-reviewing-no-recovery.output.txt

<details><summary>模型原文</summary>

```text
发现 3 个问题（前 2 条即后续修复提交 1913703「reviewing 卡恢复白名单 + reviewer 临时目录收进 finally」的内容，已对照 git 实证；第 3 条为额外确证，修复未覆盖、当前 HEAD 仍在）。

**1. reviewing/ 卡无程序化恢复出口（run/resume 白名单缺 `reviewing`）**
- 证据：`orchestrator.mjs:232`（run 白名单仅 `pending/running/awaiting-human`）、`:352`（`resuming` 只认 running）、`:962-963`（resume 只认 running/blocked）。
- 失败场景：闭环进程在审查阶段被硬杀/断电（非异常路径，`failTaskToBlocked`:730 兜不到），卡滞留 reviewing/；此时 `run`/`resume` 都拒绝，唯一出口是 `abandon`:984-988 强制落 failed/——已通过全部静态门禁的工作被丢弃。而状态机本身（:606/:654）会产生 reviewing 态，TRANSITIONS 也允许 reviewing→running，纯属白名单遗漏。

**2. reviewer 临时目录泄漏（每轮审查漏 1-2 个 mkdtemp 目录）**
- 证据：`:610`（`orch-review-*`）与 `:616-619`（`orch-review-settings-*`）各自 `mkdtempSync` 新建目录；`finally`:714-721 只清 worker 的 `promptFile`/`settingsFile` 两个目录。
- 失败场景：审查返工循环（:644-656 `continue` 回来）每轮重建，泄漏累积；对照 `cmdIntent`:1402-1407 / `cmdSpecStart`:1474-1478 均有清理，此处遗漏。

**3. [存量] 交互闸门按 `[b]` 打回重试必然自撞任务锁崩溃**
- 证据：`humanGateInteractive`:822-826 → `doRetry`:914 先把卡迁移到 running/ → `:916` 递归调 `cmdRun` → `:244` `acquireTaskLock`；而外层 cmdRun 的锁要到 `:716` finally 才释放。`task-lock.mjs` 的 `acquireTaskLock` 对活 pid（含本进程自身）一律返回 `{held:false}`。
- 失败场景：TTY 下 run 到 awaiting-human 后选 `b` → 内层 `die`:250（process.exit 整进程退出），报错还指向自己的 pid；卡已迁到 running/ 但无进程驱动，滞留等人工 resume。

**存疑**（证据不足，不计入 N）
- reviewer 用量未入 token 预算：`:625-628` 审查 `onEvent` 无 `budget.account`（对比 worker `:430`），token 熔断不覆盖审查阶段，仅 wall-clock+maxTurns 兜底——可能是有意设计。
- wall-clock 熔断若在门禁同步段（`execFileSync` 阻塞事件循环）触发，timer 回调延后到门禁间隙执行，此后直到审查/合并再无 `budget.tripped` 检查——熔断后仍可能走完自动合并，与 `:148-151`「trip 即落 blocked」注释语义不符；质量上门禁已过，危害有限，不确定是否有意。
- 附注（按纪律诊断类不报）：`:1370-1373` 先覆写 `meta.gate='L3'` 再拼日志，永远输出「gate=L3 已强制覆写为 L3」，原始 gate 值丢失。
```

</details>