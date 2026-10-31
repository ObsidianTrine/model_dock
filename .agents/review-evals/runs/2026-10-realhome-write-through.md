# 审查评测报告

- 考题：1，审出：0，未审出：1
- 模型：glm-4.5-air
- 评分口径：expect 关键词命中（启发式），精确判定看原文

## 2026-10-realhome-write-through — ❌ 未审出

- 考题：测试收尾 restoreHomes 后同步引擎长尾 tick 把测试配置整包写进真实 home：stopSyncEngine 不等在飞 tick、单例无 home 钉扎、tick 中途写盘路径随 env 漂移
- 关键词：stopsyncengine=未中，restorehomes=未中，fake_home=未中，长尾=未中，钉扎=未中
- 完整输出：/var/folders/vw/7vttg54s74ng208jp5063f0c0000gp/T/modeldock-review-eval-oVOByJ/2026-10-realhome-write-through.output.txt

<details><summary>模型原文</summary>

```text
发现 2 个问题

## src/sync/engine.ts 问题

### 1. `cloudHeartbeat` 函数中的时间解析缺乏验证 (src/sync/engine.ts:170)
```typescript
const desiredMs = Date.parse(desiredTs)
if (!Number.isFinite(desiredMs) || desiredMs <= lastSwitchMs) return
```

**问题**：`Date.parse()` 返回的是毫秒时间戳，但与 `lastSwitchMs`（也是毫秒）比较时，存在整数溢出的风险。当 `desiredMs` 是一个非常大的正数（接近 `Number.MAX_SAFE_INTEGER`）时，与 `lastSwitchMs` 比较可能得到错误结果。

**证据**：
- `Date.parse()` 返回毫秒时间戳（数字）
- `lastSwitchMs` 也是毫秒时间戳
- 两个大整数相减可能超出安全整数范围

**修复建议**：应该先检查 `desiredMs` 是否在合理范围内（如 1970-2100 年），再进行比较。

### 2. `syncTickOnce` 函数中的错误处理可能导致静默丢失 (src/sync/engine.ts:191-192)
```typescript
} catch {
  /* sync.json 本身不可写时只能放弃记录 */
}
```

**问题**：当 `updateSyncState` 写入 `sync.json` 失败时，错误被静默忽略。这会导致同步状态不准确，特别是 `lastError` 字段未被记录，可能掩盖问题。

**证据**：
- 注释明确说"放弃记录"
- 没有记录错误到日志或其他地方
- 可能导致用户不知道同步失败的具体原因

**修复建议**：应该记录错误到日志，至少让用户知道同步状态记录失败。

## 存疑

### 1. `syncTickOnce` 函数中的锁持有时间可能过长 (src/sync/engine.ts:82-93)
```typescript
await withFileLock(configLockPath(), undefined, async () => {
  // ... 长时间操作
})
```

**问题**：锁内操作包括网络请求（`target.readBlob`）、文件读写、密钥解析等，最慢可达 15 秒。虽然注释说"分钟级一次可接受"，但在高并发场景下，长时间持锁可能阻塞其他进程。

**缺证据**：需要了解 `withFileLock` 的具体实现和并发处理机制才能确认是否真的是问题。
```

</details>