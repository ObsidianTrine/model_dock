# 交付说明：test-gap-config-root（补 config 持久层与 src 根模块测试盲区）

> 本文件随 diff 入库（任务红线「只动 test/**」，交付说明也落在 test/ 下）。
> 覆盖数字的改后精确值由 orchestrator 门禁 `npm run test:coverage` 实跑确认（worker 会话 npm/node 被门禁拒绝，无法本机实测，见第五节第 3 条）。

## 一、交付物

| 文件 | 内容 |
|------|------|
| `test/config-gaps.test.ts`（17 用例） | src/config 持久层盲区：store.ts 形状守卫/规范化、lang.ts daemon 路径、secrets.ts cipher 描述符/损坏形态/缓存/体检 |
| `test/ops-autostart-gaps.test.ts`（22 用例） | src 根模块盲区：ops.ts addService/路由操作层/迁移早退、autostart.ts 登记命令判定、crash.ts、jsonpath.ts |
| 本文件 | 未测分支清单 + 覆盖对比 + 可达性限制说明 |

两文件合计 39 个用例，全部为新增，未改动任何既有测试与 src（任务红线）。

## 二、动手前圈出的未测分支清单（文件:函数:分支 → 覆盖用例）

### src/config/store.ts
1. `store.ts:migrate:version > CONFIG_VERSION` → ConfigError + hint（config-gaps「version 高于当前支持」）
2. `store.ts:containerOrEmpty:容器键为数组/标量`（providers = []）→ ConfigError 报数组形态（config-gaps「容器键为数组」）
3. `store.ts:normalizable:可选对象键数组/标量`（gateway = []、backup = 5）→ ConfigError（config-gaps「可选对象键为数组」）
4. `store.ts:normalizeGateway:已退役 tray_lite 剥除 + 已带 dayFilter 窗口不触发 days 简写迁移`（config-gaps「tray_lite 读入即剥除」）
5. `store.ts:mutateConfig（经 fsx.ts:withFileLock）:fn 抛错不落盘、错误透传、锁 finally 释放`（config-gaps「mutateConfig fn 抛错」）

### src/config/lang.ts
6. `lang.ts:initLang:daemon/GUI 无 argv 路径`——不动 argv、按 config 设语言（config-gaps「无 argv（daemon/GUI 路径）」）
7. `lang.ts:initLang:config 损坏 catch 回落 zh`——错误留给正常加载路径（config-gaps「config 损坏不阻断语言解析」）

### src/config/secrets.ts
8. `secrets.ts:dpapiCipher.encryptTable/decryptTable:DPAPI 行数不匹配守卫` → SecretsError（config-gaps「DPAPI 表行数不匹配」，桩注入）
9. `secrets.ts:machCipher:无前缀透传 / 空值与已带前缀跳过 / 加解密往返`（config-gaps「machine cipher」）
10. `secrets.ts:pickFileCipher:平台选择分支`（win32 DPAPI / linux mach / darwin 明文回落 enabled=false）（config-gaps「pickFileCipher 平台选择」）
11. `secrets.ts:makeKeyRef/parseKeyRef:全方案往返`（keychain / secret-service / file）（config-gaps「makeKeyRef / parseKeyRef」）
12. `secrets.ts:readSecretsRaw:根为数组/标量` → SecretsError kind 提示（config-gaps「secrets.json 根为数组/标量」）
13. `secrets.ts:getExternal:读取抛错` → 包 SecretsError（钥匙环锁定 hint）、不进缓存（config-gaps「keychain 读取抛错」）
14. `secrets.ts:getExternal:null 结果进 TTL 缓存不重读`（config-gaps「keychain 条目不存在」）
15. `secrets.ts:setSecretsBatch/setSecret:沙箱守卫强制 file`（config-gaps「沙箱下 setSecretsBatch」）
16. `secrets.ts:getSecret:file 后端空串读为 null`（config-gaps「file 后端空串值」）
17. `secrets.ts:verifySecretsStore:健康路径 {ok:true} + 损坏文件 {ok:false,error} 不抛出`（config-gaps「verifySecretsStore 健康路径 / 损坏文件」）

### src/ops.ts（根模块，原行覆盖 58.11%）
18. `ops.ts:addService:未知预设 / 空 Key 不落盘 / 同地址同 Key 重复报错 / ID 冲突 slug-2 递增`（ops-autostart「参数校验与重复/ID 冲突」）
19. `ops.ts:addService:defaultModel 回落目录首行`（ghost-model→deepseek-flash）；在目录内则生效（ops-autostart「显式 defaultModel 不在最终目录」）
20. `ops.ts:addService:setActiveIfEmpty 语义`——空配置设 active、已有不抢、默认不设（ops-autostart「setActiveIfEmpty」两条）
21. `ops.ts:fetchModelIds:在线拉取 200 填充目录（source=fetched、fetched 计数）；全失败 fetchError 记录不阻断`（ops-autostart「在线拉取分支」两条，mock 上游 listen(0)+127.0.0.1）
22. `ops.ts:setAutoRoute:provider null 删钉定 / undefined 保持、failoverOn429 开关、autoFallback 落盘`（ops-autostart「setAutoRoute」）
23. `ops.ts:setRouteNext:钉定 / null 恢复自动 / 未知服务报错`（ops-autostart「setRouteNext」）
24. `ops.ts:switchToServiceWithRoute:复用既有 profile / 缺则合成 auto-<id> / gateway 钉定一次落盘`（ops-autostart「switchToServiceWithRoute」）
25. `ops.ts:ensureProfileForProvider:复用不改 active / 合成 profile 目录首个为默认模型`（ops-autostart「ensureProfileForProvider」）
26. `ops.ts:resyncHarnessToRoute:未接入 / file 模式客户端 → 空结果不写盘`（ops-autostart「resyncHarnessToRoute」）
27. `ops.ts:removeProviderCascade:file 模式悬空 route 重置 default、gateway 模式不动`（ops-autostart「removeProviderCascade」）
28. `ops.ts:migrateSecretsToSecure:沙箱 defaultStore=file 早退（零写盘）`（ops-autostart「migrateSecretsToSecure」；真实迁移循环可达性受限见第三节）

### src/autostart.ts
29. `autostart.ts:recordedArgvStale:argv[0] 缺失 / 非旗标参数文件缺失 → true；健康 → false`（ops-autostart「recordedArgvStale」）
30. `autostart.ts:readRecordedArgv:base64 合法但非字符串数组（对象/空数组/混型）→ null`（ops-autostart「readRecordedArgv」）
31. `autostart.ts:autostartStatus:Windows 沙箱镜像 stale 判定`（win32 `skipIf`）（ops-autostart「Windows 沙箱镜像的 stale 判定」）

### src/util
32. `crash.ts:appendCrashLog:日志目录被同名文件占位 → 吞错不抛、原文件不破坏`（ops-autostart「crash：appendCrashLog」）
33. `jsonpath.ts:getPath:star 段 / 中途 null / 越界 → undefined；toSegments 不支持 star`（ops-autostart「getPath」）
34. `jsonpath.ts:setPath:越界报错 / 末尾追加合法 / 索引下钻创建容器 / star 对象子节点保留`（ops-autostart「setPath」两条）

任务优先点逐条回应：
- **陈锁抢占**：既有套件已覆盖（daemon-lifecycle.test.ts、store.test.ts:188 withFileLock 陈锁接管），本卡不重复。
- **损坏文件容错**：清单 1/2/3/7/12/17/32。
- **迁移路径**：清单 28 + 第三节可达性说明。
- **平台分支逻辑**：清单 10/15/31（pickFileCipher 全平台、沙箱守卫、Windows 镜像 stale）。

## 三、可达性限制：migrateSecretsToSecure 真实迁移循环

真实迁移循环（`getSecret → setSecret → mutateConfig key_ref 换写 → deleteSecret`，ops.ts:882-891）要求 `defaultStore()` 返回非 file 后端，测试内**不可安全覆盖**：

- `defaultStore()` 在 `MODELRDOCK_FAKE_HOME` 存在时强制返回 file（secrets.ts:56-57 沙箱守卫）——守卫的存在理由正是 keychain/secret-service 是**机器级全局存储、不随 home 重定向隔离**，沙箱里写/删钥匙环条目动的是生产实例的密钥。
- 去掉 FAKE_HOME 则：路径回落真实 `~/.modeldock`（读真配置），darwin 分支会真 spawn `security` 写机器钥匙环，linux 分支 spawn `secret-tool` 探测（`hasSecretTool`）——均违反测试隔离红线。
- 覆盖该循环需要 src 注入出口（如可替换的 `defaultStore`），任务红线「只动 test/**」禁止。已留待另立卡。本卡守住可达部分：早退分支（target=file 零写盘、config 不动）。

## 四、覆盖对比（验收标准 3）

| 域 | 改前基线（2026-10-29 全量 coverage 实测） | 改后 |
|------|------|------|
| src/config | 分支 71.86% | 新增 17 条分支用例、既有测试与 src 零改动 |
| src 根目录（ops.ts / autostart.ts） | 行 58.11% | 新增 22 用例中 14 条直击该域 |
| src/util/crash.ts | 63% | 补 appendCrashLog 吞错分支 |
| src/util/jsonpath.ts | 76.56% | 补 getPath 边界 + setPath 越界/追加/下钻/star |

**只升不降的判定**：新增用例只会扩大 v8 覆盖并集（新增分支执行记录），既有测试与 src 零改动、既有覆盖行不受影响，故各域行/分支覆盖必然 ≥ 基线。改后精确数字由 orchestrator 门禁 `npm run test:coverage` 实跑出具（worker 会话无 npm/node 执行权，见下）。

## 五、审查返工修订记录（review_blockers 响应）

1. **[阻塞] 交付说明缺失** → 新增本文件随 diff 入库（含 ≥10 条清单：实际 34 条；覆盖对比见第四节）。
2. **[建议] 迁移循环只测早退分支** → 第三节可达性说明 + ops-autostart-gaps.test.ts 用例内注释；陈锁抢占已由既有套件覆盖。
3. **[提示] 未能实跑 npm test / coverage** → worker 门禁拒绝 npm/node 执行（会话固定约束）；所有断言已逐条对照源码静态验证（版本守卫、容器键形状、tray_lite 剥除、withFileLock finally 释放、DPAPI 行数守卫、slug 派生、默认模型回落、fetch 错误捕获、Windows stale 判定、crash 吞错、jsonpath 边界）。全量绿与改后覆盖数字由 orchestrator 门禁实跑确认。
4. **[提示] verifySecretsStore 在 win32 真 spawn PowerShell** → 已改按 store.test.ts:277 既有惯例注入可逆 protect 桩（`__testSetDpapiBatch`，finally 还原），win32 不再依赖外部 PowerShell；并新增「损坏文件 → { ok:false, error } 不抛出」失败分支用例。
5. **[提示] lang 测试未还原环境变量原值** → 两处用例保存 `prevLang`、finally 按原值还原（原未设置则 delete），不吞 CI/用户预置的 `MODELRDOCK_LANG`。
