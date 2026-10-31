# 审查评测报告

- 考题：1，审出：1，未审出：0
- 模型：glm-5-3-flash-260828
- 评分口径：expect 关键词命中（启发式），精确判定看原文

## 2026-10-realhome-write-through — ✅ 审出

- 考题：测试收尾 restoreHomes 后同步引擎长尾 tick 把测试配置整包写进真实 home：stopSyncEngine 不等在飞 tick、单例无 home 钉扎、tick 中途写盘路径随 env 漂移
- 关键词：stopsyncengine=中，restorehomes=未中，fake_home=未中，长尾=未中，钉扎=未中
- 完整输出：/var/folders/vw/7vttg54s74ng208jp5063f0c0000gp/T/modeldock-review-eval-8LFn5z/2026-10-realhome-write-through.output.txt

<details><summary>模型原文</summary>

```text
发现 3 个问题（另附 3 条存疑）。以下发现均已读 f77dc02^ 版本的配套模块（state.ts / store.ts / fsx.ts / targets/* / main.ts / setup.ts）核实契约后确认。

---

**问题 1 [P1] remountSyncEngine 并发重入会泄漏 SyncLoop 实例（孤儿定时器 + 双活引擎）**

`src/sync/engine.ts:302-307`：`stopLoop()` 先同步置 `active = null`，再 `await loop.stop()`——后者要等在飞 tick 跑完（单 tick 可达 15s+，`engine.ts:63` 自述）。挂起期间 `active` 为 null。

`src/sync/engine.ts:324`：重挂早退条件是 `if (active && activeSig === sig) return`——`active` 为 null 时无条件走「摘除 → 新建」。而 `src/gateway/main.ts:185-189` 对**每一次 sync.json 写盘**都会 500ms 防抖后调 `remountSyncEngine`。

时序：cloud 模式 tick 在飞（心跳/收集阶段）→ 用户重跑 `sync setup` 换目标（写 sync.json）→ remount A 进入 `await stopLoop()` 挂起（active=null）→ 在飞 tick 中段经 `applySwitch → switchToService → noteLocalSwitch`（`src/ops/routing.ts:64`）再次写 sync.json → +500ms remount B：`active` 为 null → 早退失效 → **新建 loop B 并 `start()`** → 旧 tick 收尾、remount A 恢复 → 再建 loop C，`active = C`。**loop B 成孤儿**：poll timer 与 fs.watch 句柄永不释放，与 C 并行各自 tick（双心跳、并发推拉，单飞保证只在单 loop 内有效）。

cloud 模式下 noteLocalSwitch 落在 tick 中段、其后还有 collectSyncdoc（秒级密钥 spawn）+ readBlob（最长 15s），窗口稳定大于 500ms 防抖；target 模式簿记写都在 tick 末尾（94/116/120 行），窗口极窄——但 cloud 是默认演进方向，且重复发生会累积泄漏。

**问题 2 [P2] 在飞 tick 收尾的 updateSyncState 会把旧目标基线 merge 进并发 setup 刚写入的 sync.json（基线腐蚀）**

`src/sync/state.ts:74-79`：`updateSyncState` 是「读当前 → `{...cur, ...patch}` 整包写」，无世代/签名校验。`src/sync/setup.ts:125,149,233,257`：setup 用 `writeSyncState` **全量重写** state，并精心写入新基线 `lastSyncedHash = got/fresh.afterHash`。

在飞 tick 在 `engine.ts:47` 读的是 setup 前的旧 state；setup 在 tick 飞行中落盘后，tick 收尾的 `updateSyncState`（`engine.ts:94` 拉取路径 / `:120` 推送路径）把**旧目标的** `lastAppliedRev`/`lastAppliedTs`/`lastSyncedHash`/`lastPullTs` merge 进 setup 的新基线。后果：下轮 tick 用错基线——若旧 rev 较新则 `manifest.rev > lastAppliedRev` 判否、漏拉；若旧 rev 较旧则 `:84` 冲突判定恒真，对本无改动的机器产生假冲突（快照 + 重应用）。窗口 = 整个 tick 时长（秒级，远大于问题 1 的 500ms），单进程外 CLI setup 即可触发。与问题 1 同根：在飞 tick 不感知 sync.json 已被换掉。

**问题 3 [P2] heartbeat 响应体为合法 JSON `null` 时裸抛 TypeError**

`src/sync/engine.ts:158`：`body = JSON.parse(text || '{}')`——`text === 'null'` 时（真值字符串）解析结果为 `null`，`:163` `body.desiredProfile` 抛 `TypeError`。被 `safeSyncTick` 兜住记进 lastError，不崩网关，但报错文案是裸 TypeError（违反「错误信息必须可操作」约定，且注释 `:160` 声称该 catch 已覆盖反代错误页场景——`null` 体恰好漏掉）。同类无需扩大：仅此一处对 parse 结果无对象守卫。

---

### 存疑（证据不足，不计入问题数）

1. **watcher 异步 error 后未 close**（`engine.ts:255-258` 只置 `this.watcher = undefined`）。`src/gateway/main.ts:210-215` 同款自防有 `watcher?.close()`，此处没有；句柄是否真泄漏取决于 Node 对 FSWatcher error 后的内部处置，未验证。
2. **`stopSyncEngine()` void 返回 + main.ts cleanup 随后 `process.exit(0)`**（`main.ts:234-247`）：在飞 `applySyncdoc` 的多文件应用可被硬杀成半套（config.toml 已换、presets.json/assets 未写）。逐文件原子 + 重启按 rev 重拉自愈，且 `:334` 注释自称「尽力收尾」——可能是有意取舍，未报问题。
3. **`src/sync/state.ts:62` 注释「同进程对同一锁文件再入 withFileLock 会死锁」与 `src/util/fsx.ts:300-321` 的 AsyncLocalStorage 同路径重入内联实现矛盾**——仅注释失真（会误导后续维护者在锁内嵌套同锁时绕开 withFileLock），行为无缺陷。
```

</details>