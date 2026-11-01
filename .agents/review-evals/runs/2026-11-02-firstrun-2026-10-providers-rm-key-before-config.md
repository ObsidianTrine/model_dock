# 审查评测报告

- 考题：1，审出：1，未审出：0
- 模型：glm-5-3-flash-260828
- 评分口径：expect 关键词命中（启发式），精确判定看原文

## 2026-10-providers-rm-key-before-config — ✅ 审出

- 考题：cmdProviderRm 先不可逆删密钥（deleteSecret）、后做可失败的配置写（mutateConfig）——配置写失败（mutator 抛错/落盘失败/锁超时）时 key 已永久删除而 provider 还在配置里，无从回滚
- 关键词：deletesecret=中，mutateconfig=中
- 完整输出：/var/folders/vw/7vttg54s74ng208jp5063f0c0000gp/T/modeldock-review-eval-hwysU8/2026-10-providers-rm-key-before-config.output.txt

<details><summary>模型原文</summary>

```text
发现 4 个问题

**① cmdProviderRm：先删密钥后写配置，配置写失败即永久丢 key（本次修复的主缺陷 1）**

- 证据：`src/cli/providers.ts:233-237`（片段）——`await deleteSecret(p.key_ref)` 在 `await mutateConfig(...)` **之前**执行。
- 失败场景：`mutateConfig` 因锁超时/落盘失败/mutator 抛错而失败时（它有原子回滚，配置无损），但 `deleteSecret` 已不可逆执行——provider 条目留在 config.toml、`key_ref` 指向已删除的密钥，网关取 key 失败且无从回滚。与 add 路径「先存密钥后写配置」（ops/service.ts:201-208）的提交序不对称。
- 正确顺序：先 `mutateConfig`（可失败、原子回滚），成功后再删密钥；删密钥失败降级为警告（provider 已删、密钥残留可手动清）。

**② cmdProviderAdd：拉取统计用拉取前的旧配置快照（本次修复的主缺陷 2）**

- 证据：`src/cli/providers.ts:177-179`（片段）——`cfgNow = await loadConfig()` 在 `refreshModelsInto(id, cfgNow)` **之前**取得，而 `refreshModelsInto` 内部经 `mutateConfig` 重新读盘合并（该函数自己的注释 54-55 行即声明临界区重读）；随后 `total = Object.keys(cfgNow.providers[id].models ?? {}).length` 数的仍是拉取前快照。
- 失败场景：无预设的自定义服务（models 初始为空）拉到 N 个模型后报「新增 N 个，共 0 个」。`cmdModelRefresh`（298 行）的做法是对的：拉取后重新 `loadConfig` 再统计。

**③ [存量] refreshModelsInto：`display_name` 可为 undefined，令整包 TOML 序列化抛错、整批模型合并失败**

- 证据：`src/cli/providers.ts:72-73`（片段）`display_name: fetched.display[id]` 无空值防护；而 `src/providers/fetch.ts:140` 只在 `typeof item?.display_name === 'string'` 时才写入 display 表——上游模型条目允许缺 display_name。
- 机制已验证：smol-toml 的 stringify 对 undefined 值直接抛 `TypeError: cannot serialize values of type 'undefined'`（node_modules/smol-toml/dist/stringify.js:187），`saveConfig`（src/config/store.ts:150）首行就是 `tomlStringify(cfg)`，mutateConfig 无 undefined 清洗。一个缺名的模型会拖垮该 provider 全部模型的拉取（写入原子回滚，配置无损，但功能失败）。
- 修法：与同函数 75-76 行的写法对齐——`...(fetched.display[id] != null ? { display_name: fetched.display[id] } : {})`。注：当前 develop HEAD 仍是原样，属存量缺陷；触发条件是上游返回无 display_name 的条目，fetch 侧的类型守卫表明作者认为该输入可能。

**④ [存量·低] cmdProviderSetKey：切换存储后端后旧密钥残留在原后端**

- 证据：`src/cli/providers.ts:253-256`（片段）——`setSecret(id, key, backend)` 返回的 keyRef 带 backend scheme（`makeKeyRef(backend, id)`，src/config/secrets.ts:609-621），keychain/file/secret-service 各是独立条目；此后直接覆写 `c.providers[id].key_ref = keyRef`，旧 ref 指向的条目没有任何 `deleteSecret` 调用。
- 失败场景：用户改过 `security.store`（如 keychain→file）后 set-key，新 key 落 file、旧 key 永久残留在系统钥匙环——机器级凭据泄漏面。HEAD 亦未修，标 [存量]。

红线核查：无 8687/8890、无硬编码 home（走 paths.ts）、写盘全走 mutateConfig/atomicWrite、无 import.meta.url、无 native 依赖——均通过。

存疑

- `cmdModelSet` 在无任何 flags 时仍把 `source` 改写为 `'manual'`（片段 340-346 行）：空操作也会覆盖 `'fetched'` 来源标记。机制确定，但属诊断/语义类取舍，按报告纪律不单列。
- 片段 34 行 `readFileSync(0)` 在 Windows 交互式无管道 stdin 下是否阻塞等待——未在 Windows 环境验证，缺实测证据，不报。
```

</details>