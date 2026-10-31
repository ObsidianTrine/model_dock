# 审查评测报告

- 考题：1，审出：0，未审出：1
- 模型：glm-5-3-flash-260828
- 评分口径：expect 关键词命中（启发式），精确判定看原文

## 2026-10-realhome-write-through — ❌ 未审出

- 考题：测试收尾 restoreHomes 后同步引擎长尾 tick 把测试配置整包写进真实 home：stopSyncEngine 不等在飞 tick、单例无 home 钉扎、tick 中途写盘路径随 env 漂移
- 关键词：stopsyncengine=未中，restorehomes=未中，fake_home=未中，长尾=未中，钉扎=未中
- 完整输出：/var/folders/vw/7vttg54s74ng208jp5063f0c0000gp/T/modeldock-review-eval-NvuhwD/2026-10-realhome-write-through.output.txt

<details><summary>模型原文</summary>

```text
「发现 2 个问题」（附存疑 4 条）。已对 `f77dc02^` 的全部协作模块（state/runtime/collect/crypto/types/targets×3/fsx 锁/store/main.ts 接线/cloud server 契约/既有测试）逐一核verified，以下两条有代码实证。

## 1.（P1）cloud 模式：心跳失败阻断同 tick 的文档推拉，同步不收敛

- 证据：`src/sync/engine.ts:54-56` 在文档同步**之前** `await cloudHeartbeat(...)`；而 heartbeat 的三类失败全部外抛——网络异常（L149-151）、HTTP≠200 含 404/429（L153-155）、200+非 JSON 反代错误页（L159-162）。
- 失败场景：云端服务器旧版本无 `/v1/heartbeat`（404）、反代只放行 `/v1/doc`、或多设备同出口 IP 触发 server 侧 60 req/min 限速（`cloud/server.ts` 内存计数，心跳+doc 共享配额）——此时 `/v1/doc` 明明可用，但每个 tick 都死在心跳上，**文档推拉永不执行**，`safeSyncTick` 只记账不区分，「配置同步」整体瘫痪。
- 佐证作者意图：L174-175 注释明确要求 applySwitch 失败「不阻断本 tick 的文档推拉，同步每 60s 永续重试不收敛」——但该保护只包住了 apply 回调，心跳本身的传输失败恰恰造成同样的不收敛，且心跳只是辅助面（远程切换上报），不应门禁核心的文档同步。

## 2.（P3）watcher 'error' 处理未 close 句柄

- 证据：`src/sync/engine.ts:255-258` 收到异步 error 后仅 `this.watcher = undefined`，未调用 `.close()`；同仓库同型代码 `src/gateway/main.ts`（f77dc02^ 的热加载 watcher error 分支）是 `watcher?.close(); watcher = undefined`。EMFILE/ENOSPC 场景下残留的 FSWatcher 及底层 inotify/kqueue 监视直至 GC 才可能释放，属句柄泄漏（REVIEW.md「端口/句柄泄漏」范畴）。

## 存疑（缺证据，不下结论）

- **冲突快照重复落盘**：apply 成功后 post-apply 重收集（L91）若持续抛错（如 keychain 后端 spawn 长期失败），state 不更新 → 每 tick 重走「conflict 判定→快照→apply」，`sync-conflict-*.json`（含明文 key，L87）按 60s 粒度无界积累。需证实 getSecret 失败路径是否 reject 而非返回 null。
- **cloud 422 误报回滚**：`localDoc.ts` 取自 collect 时刻（L58），密钥解析慢（秒级 spawn）时推送 ts 早于云端现版 → 触发 L422「疑似回滚」误报；自愈但报错误导。未实测时延分布。
- **manifest rev 回退不收敛**：同步盘（localdir）恢复旧 manifest 后 rev ≤ lastAppliedRev 且本地无改动 → 永久 idle。需确认是否有 restore 场景承诺。
- `syncTickOnce` L48 `|| !state` 为死分支（syncModeReady 已覆盖 null）——风格项，按纪律不单列，仅随文备注。
```

</details>