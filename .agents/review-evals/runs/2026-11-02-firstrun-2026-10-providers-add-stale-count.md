# 审查评测报告

- 考题：1，审出：1，未审出：0
- 模型：glm-5-3-flash-260828
- 评分口径：expect 关键词命中（启发式），精确判定看原文

## 2026-10-providers-add-stale-count — ✅ 审出

- 考题：cmdProviderAdd 拉取统计用拉取前的旧配置快照——refreshModelsInto 内部经 mutateConfig 重新读盘合并，外层 cfgNow 不反映结果，无预设服务报「新增 N 个，共 0 个」
- 关键词：loadconfig=中，0 个=中
- 完整输出：/var/folders/vw/7vttg54s74ng208jp5063f0c0000gp/T/modeldock-review-eval-M1PyCh/2026-10-providers-add-stale-count.output.txt

<details><summary>模型原文</summary>

```text
发现 2 个问题

**1. `cmdProviderRm` 先删密钥后写配置——配置写失败时 key 永久丢失且无法回滚**（src/cli/providers.ts:233-237）

```ts
await deleteSecret(p.key_ref)        // 233：不可逆操作先执行
await mutateConfig((c) => {          // 234：可能失败（mutator 抛错 / 落盘失败 / 锁超时）
  removeProviderCascade(c, id)
})
```

失败场景：`deleteSecret` 成功后 `mutateConfig` 抛错（锁超时、磁盘写失败、`removeProviderCascade` 内部抛错），此时密钥已永久删除、provider 却还留在 config.toml 里且 `key_ref` 悬空——网关路由到该 provider 时取不到 key，且无任何回滚路径。正确提交序是先配置写（mutateConfig 失败有原子回滚）成功后再删密钥；删密钥失败时 provider 已删、仅密钥残留，属可提示手动清理的轻状态。与 add 路径「先存密钥后写配置」（providers.ts:159 `addService` 内部 ops.ts:216-217）正好相反，删除路径应保持对称的「先配置后密钥」。

**2. `cmdProviderAdd` 拉取统计用了拉取前的旧快照——新服务报「新增 N 个，共 0 个」**（src/cli/providers.ts:177-179）

```ts
const cfgNow = await loadConfig()                       // 177：拉取前快照
const { added: nAdded } = await refreshModelsInto(id, cfgNow)
const total = Object.keys(cfgNow.providers[id].models ?? {}).length  // 179：仍是旧对象
```

证据链：`refreshModelsInto`（providers.ts:63-90）在 `mutateConfig` 回调内**重新读盘**合并 models（`c.providers[providerId]` 是锁内新读的配置），写盘后并不回写调用方传入的 `cfgNow`——所以第 179 行数的还是拉取前的空 models（`fetch: false` 创建的新服务 models 为空）。失败场景：`modeldock provider add <preset>` 成功拉到 N 个模型，输出却是「✓ 自动拉取模型：新增 N 个，共 0 个」，自相矛盾。同文件 `cmdModelRefresh`（providers.ts:298-299）是正确写法：拉取后重新 `loadConfig()` 再统计（`cfgAfter`），本处应对齐。

存疑

- **providers.ts:199 `getSecret(p.key_ref)` 对 `key_ref` 为 undefined 的健壮性**：`parseKeyRef`（secrets.ts:32-37）直接调 `ref.startsWith`，`key_ref` 缺失时会抛 TypeError 使 `provider list` 整表崩溃。正常建服路径都会写入 key_ref，未能确证存在产生无 key_ref provider 的路径（如手工编辑 config.toml），缺证据不列为问题。
- **providers.ts:220-232 `cmdProviderRm` 的 TOCTOU**：`cfg` 在交互 `confirm` 前加载，用户停留期间配置可能被并发修改（如 profile 新增引用），删除判定基于旧快照；`mutateConfig` 锁内会用新配置执行 cascade，但 `usedBy`/钉定校验不会重跑。交互间隔短、后果轻（多删一个刚钉上的引用），推测为已知取舍，未列为主要问题。

两处主要问题与后续修复 commit 06a5940 的内容完全对应（删除序颠倒 + 统计口径陈旧）。
```

</details>