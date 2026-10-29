# 审查评测报告

- 考题：1，审出：1，未审出：0
- 模型：glm-5-3-flash-260828
- 评分口径：expect 关键词命中（启发式），精确判定看原文

## 2026-10-config-memo-alias — ✅ 审出

- 考题：loadConfig memo 直接复用共享 Config 对象——调用方原地修改即污染缓存，别名把同步引擎的等待轮询钉进 apply→collect 竞态窗口，lastSyncedHash 吞掉本地改动、rev3 永不推送
- 关键词：memo=中，clone=中
- 完整输出：/var/folders/vw/7vttg54s74ng208jp5063f0c0000gp/T/modeldock-review-eval-IjGJoD/2026-10-config-memo-alias.output.txt

<details><summary>模型原文</summary>

```text
发现 3 个问题

**1. loadConfig 记忆化把共享可变对象直接外借——未落盘的中间态泄漏给所有并发读者（本次改动引入，60163fe）**

- 证据：`store.ts:117` `loadMemo: { key, cfg }` 存的是 migrate 产物本体；`store.ts:131` `return loadMemo.cfg`、`store.ts:145` `return cfg` 返回的都是**同一个对象**；而 `store.ts:193` mutateConfig 的 `fn(cfg)` 按设计原地改它。
- 失败路径：单进程内（网关 daemon 并发请求是常态）调用 A 进入 mutateConfig 持锁执行 fn、原地改 memo 对象；期间任何不持锁的 `loadConfig()`（读路径）在 A `saveConfig` 落盘前就拿到**已改了一半**的 Config。中间态一旦被消费（如以它计算哈希/做判断），后续真实落盘会被判「无变化」而吞掉。另一面：任何按「只读约定」之外改了返回值的调用者（即使从不 save）会永久污染 memo，随后无关的 mutateConfig 会把这份幻影改动落盘。
- 修法：memo 只留原始对象，每次调用返回 `structuredClone`（clone 成本远低于重 parse），memo 对象绝不外借。

**2. memo 键不含 configPath()——切换沙箱后可能命中上一个文件的旧解析结果（本次改动引入）**

- 证据：`store.ts:122` 键 = `${st.mtimeMs}:${st.size}`（117-131），`configPath()` 逐次求值却不在键里。
- 失败路径：`MODELRDOCK_FAKE_HOME` 进程内切换（本仓库测试基座 `fakeHome()` 就是这么用）后，新沙箱的 config.toml 若与旧文件 **size 相同且在同一毫秒写入**（测试循环里小配置高频重写，完全现实），`loadConfig` 直接返回上一沙箱的 Config，跨用例静默串数据。键应掺入路径。

**3. [存量] 形状守卫覆盖不全：adapter_packs 顶层无守卫、schedule 二层无守卫**

- 证据一：`store.ts:48` `adapter_packs: raw.adapter_packs as Config['adapter_packs']`——types.ts 里它与 providers/profiles/harness 同为 `Record<string, …>` 容器，后三者都过了 `containerOrEmpty`（45-47），唯独它裸 `as`。手写 `adapter_packs = 5` 会通过 migrate，下游 `Object.entries` 抛原始 TypeError，违背本文件自述目的（60-61 行注释）。
- 证据二：`store.ts:98` `sch.windows ?? []` 不挡非数组——`schedule = { windows = "x" }` 时 `"x".map` 直接 TypeError 崩；`schedule = 5`（98 行 `!sch` 对数字不成立）则被 106 行静默改写成空表。同类共 2 处。

---

### 存疑

- **stat 异常被吞成 `'missing'`**（`store.ts:123-124`）：EACCES/EBUSY 等任何 stat 错误都让 `loadConfig` 返回 `emptyConfig()`，若随后走 mutateConfig 会用近空配置覆盖用户真实 config.toml（静默丢数据）。缺的证据：需要证实「stat 失败而后续 read/write 成功」的现实窗口（Windows 瞬时占用锁）存在，未验证，暂不报实锤。
- 已核查排除的候选：`saveConfig` 跳写路径（154 行提前 return 不清 memo）在内容上自洽（memo 对象 == 磁盘字节），不构成脏读，不报；`normalizeGateway` 106 行重建 schedule 只保留 enabled/windows，经查 types.ts 该类型仅此二字段，无丢失，不报。
```

</details>