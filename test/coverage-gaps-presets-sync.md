# presets / sync 域测试补盲清单（test-gap-presets-sync）

依据：2026-10-29 在本 worktree 跑全量 `npm run test:coverage`（vitest v8 coverage，`isolate:false` singleFork 全量），
用 `coverage-final.json` 逐文件提取未覆盖分支圈出缺口；每个缺口至少对应一条新增用例。
只改 `test/**`：新增 7 个测试文件 + 本清单，未动任何 `src/**`。

## 基线（补测前，全量 coverage 实测）

| 域 | %Stmts | %Branch | %Lines | 主要缺口文件 |
|----|--------|---------|--------|--------------|
| src/presets | 90.76 | 62.79 | 93.51 | data.ts（validateUserPresetEntries / knownModelsForBaseUrl） |
| src/sync | 81.21 | 73.49 | 84.79 | engine.ts（remount/syncStatus/cloudHeartbeat 分支）、collect.ts、crypto.ts |
| src/sync/targets | 84.55 | 74.44 | 89.28 | webdav.ts / cloud.ts 错误分支 |

## 补测后（2026-10-31，develop 全量 coverage 实测，全量绿）

| 域 | %Stmts | %Branch | %Lines | 说明 |
|----|--------|---------|--------|------|
| src/presets | 99.23 | 97.67 | 100 | data.ts 主缺口收口；余量 = 死分支（见下方 followups ①②，已回流 known-issues CORRECT-11） |
| src/sync | 96.92 | 97.96 | 97.84 | engine/collect/crypto/setup/types 缺口收口；余量 = 有意不补与不可稳定注入项 |
| src/sync/targets | 95.58 | 94.44 | 98.38 | webdav/cloud 错误分支收口；余量 = 不可稳定注入项（cloud.ts:36 死守卫见 followups ③） |

测量口径：全量 112 文件 1306 passed / 13 skipped（Windows，0ec18fc 修 fd 2 接管后首次全量绿）；基线为 2026-10-29 worktree 全量（合并前代码态），两态间 presets/sync 源码零改动，数字可直接对比。
施工发现回流：followups ①②③ → known-issues CORRECT-11（死代码三处）、④（HH:mm 只验形状）→ CORRECT-10（2026-10-31）。

## 新增测试文件

| 文件 | 用例数 | 覆盖对象 |
|------|--------|----------|
| test/presets-userpresets-gaps.test.ts | 8 | src/presets/data.ts |
| test/sync-types-gaps.test.ts | 9 | src/sync/types.ts（validateSyncdoc） |
| test/sync-crypto-export-gaps.test.ts | 14 | src/sync/crypto.ts + exportImport.ts |
| test/sync-collect-apply-gaps.test.ts | 8 | src/sync/collect.ts |
| test/sync-engine-gaps.test.ts | 8 | src/sync/engine.ts |
| test/sync-setup-gaps.test.ts | 9 | src/sync/setup.ts + state.ts + runtime.ts + targets/types.ts |
| test/sync-targets-gaps.test.ts | 7 | src/sync/targets/webdav.ts + cloud.ts + localdir.ts |

红线遵守：零 `vi.mock`（不触碰 singleFork 跨文件 mock 雷区）；无 `vi.clearAllMocks/restoreAllMocks`；
临时目录一律 `os.tmpdir()`（native realpath 打底）+ `path.join`；HTTP 假件全部 `listen(0)` 随机端口；
不碰 8687/8890；engine 模块单例 loop 在用例内用 paused 重挂摘除，文件收尾兜底 `stopSyncEngine()`。

## 缺口 → 用例映射（每行 ≥1 个新用例）

### src/presets/data.ts

| # | 文件:函数:分支 | 缺口 | 新用例 |
|---|----------------|------|--------|
| 1 | data.ts:406 readUserPresets:if(非 ENOENT 读错误) | 文件读失败（非不存在）从未测 | presets-userpresets-gaps「presets.json 是目录…」 |
| 2 | data.ts:415-418 readUserPresets:cond/if(arr===null) | 顶层对象但无 presets 数组 | presets-userpresets-gaps「顶层是对象但没有 presets 数组…」 |
| 3 | data.ts:440-442 validateUserPresetEntries:raw 空/缺 id | 条目 null、缺 id、序号报错 | presets-userpresets-gaps「条目为 null / 缺 id…」 |
| 4 | data.ts:458-460 validateUserPresetEntries:模型缺 id | 模型条目 null / 缺 id（含预设 id 文案） | presets-userpresets-gaps「模型条目为 null / 缺 id…」 |
| 5 | data.ts:450-452 validateUserPresetEntries:endpoints 全臂 | 非法键/非字符串/空白值/缺省 | presets-userpresets-gaps「endpoints：合法键保留…」 |
| 6 | data.ts:479-486 validateUserPresetEntries:标量回退 | label/vendor 回退 id、docs_url 有无、endpoints 三元 | presets-userpresets-gaps「标量归一化…」 |
| 7 | data.ts:470-473 validateUserPresetEntries:模型字段 | 0/负数丢弃、字段跳过、capabilities String 化 | presets-userpresets-gaps「模型字段…」 |
| 8 | data.ts:543-544 knownModelsForBaseUrl:host 匹配/无模型 | 匹配返回目录 / `!models.length` continue | presets-userpresets-gaps「命中方舟 host…」「host 匹配但预设无模型…」 |

### src/sync/types.ts

| # | 文件:函数:分支 | 缺口 | 新用例 |
|---|----------------|------|--------|
| 9 | types.ts:67,69,70 validateSyncdoc:顶层/fmt/v | 顶层非对象、fmt 缺失（fmt= 占位）、v 非正整数 | sync-types-gaps「顶层非对象…」「fmt 缺失…」「v 非正整数…」 |
| 10 | types.ts:84-95 validateSyncdoc:providers 形状 | 段非对象、条目非对象、auth_style、endpoints/models 非 object | sync-types-gaps「providers 段非对象…」等 4 例 |
| 11 | types.ts:99-104 validateSyncdoc:profiles 形状 | 段非对象、条目非对象、fallback 非数组 | sync-types-gaps「profiles 段非对象…」 |
| 12 | types.ts:108,115 validateSyncdoc:null 放行臂 | userPresets/scheduleRules 显式 null | sync-types-gaps「userPresets 与 scheduleRules 显式 null…」 |
| 13 | types.ts:116-123 validateSyncdoc:规则形状 | 非数组、条目非对象、HH:mm 形状、dayFilter 非法 | sync-types-gaps「scheduleRules 非数组…」「start/end 非 HH:mm…」「dayFilter 非法值…」 |

### src/sync/crypto.ts

| # | 文件:函数:分支 | 缺口 | 新用例 |
|---|----------------|------|--------|
| 14 | crypto.ts:65,67 openWithKeys:形状/缺字段 | 非对象、删 iv | sync-crypto-export-gaps「入参非对象…」「缺信封字段…」 |
| 15 | crypto.ts:77 openWithKeys:ct<17 | GCM tag 放不下 | sync-crypto-export-gaps「ct 少于 17 字节…」 |
| 16 | crypto.ts:90 openWithKeys:解密后调包 | fmt 不是 syncdoc（密钥直封构造） | sync-crypto-export-gaps「解密成功但文档 fmt 被调包…」 |
| 17 | crypto.ts:136-147 openEnvelope:形状/fmt/v/kdf | 数组、fmt 缺失、v 缺失、删 kdf | sync-crypto-export-gaps「入参数组拒绝」等 3 例 |
| 18 | crypto.ts:159,172 openEnvelope:ct<17/调包 | 与 openWithKeys 对应臂 | sync-crypto-export-gaps「ct 少于 17 字节…」「解密成功但文档 fmt 被调包…」 |
| 19 | crypto.ts:119 verifyHmacWithKeys:hmac 长度不符 | 短 hmac 直接判失败 | sync-crypto-export-gaps「verifyHmacWithKeys：hmac 长度不符…」 |

### src/sync/exportImport.ts

| # | 文件:函数:分支 | 缺口 | 新用例 |
|---|----------------|------|--------|
| 20 | exportImport.ts:44 previewImport:文件不存在 | 读不到包文件 | sync-crypto-export-gaps「包文件不存在…」 |
| 21 | exportImport.ts:56 previewImport:meta 回退 | 信封无 created_by/created_at → '' | sync-crypto-export-gaps「信封缺 created_by…」 |
| 22 | exportImport.ts:70-79 reportOfDoc:缺省臂 | 无 key_ref 服务、userPresets 缺省/{presets}、scheduleRules 缺省 | sync-crypto-export-gaps「reportOfDoc：无 key 无 key_ref…」 |

### src/sync/collect.ts

| # | 文件:函数:分支 | 缺口 | 新用例 |
|---|----------------|------|--------|
| 23 | collect.ts:32 readRawUserPresets:非 ENOENT | presets.json 为目录（EISDIR） | sync-collect-apply-gaps「presets.json 是目录…」 |
| 24 | collect.ts:41-42,86,102 collect/collectSyncdoc:{presets} 形态 | 非数组分支透传 + 计数 | sync-collect-apply-gaps「presets.json 为 {presets:[...]} 形态…」 |
| 25 | collect.ts:65,75 collectSyncdoc:key 解析失败 | file: 引用无值 → missingKeys | sync-collect-apply-gaps「file: 引用解析不到…」 |
| 26 | collect.ts:111 applySyncdoc:defaultStore 回退 | 无 backend 且无 security.store（沙箱恒 file，安全） | sync-collect-apply-gaps「无 opts.backend 且 config 无 security.store…」 |
| 27 | collect.ts:130,147,156 applySyncdoc:字段缺省 | scheduleRules/userPresets（含 null）缺省 | sync-collect-apply-gaps「doc 无 scheduleRules…」「doc 无 userPresets…」「userPresets 显式 null…」 |
| 28 | collect.ts:160-161 applySyncdoc:missingKeys 统计 | apply 侧 file:ghost 归类 + map 回调 | sync-collect-apply-gaps「doc 带『解析不到的 file: 引用』…」 |

### src/sync/engine.ts

| # | 文件:函数:分支 | 缺口 | 新用例 |
|---|----------------|------|--------|
| 29 | engine.ts:40 syncModeReady:mode=off 臂 | key 残留但 mode off → skipped | sync-engine-gaps「mode=off 但 key 残留…」 |
| 30 | engine.ts:94 syncTickOnce:baseRev ?? 0 | 目标 manifest 丢失后重推 rev1 | sync-engine-gaps「目标 manifest 丢失…」 |
| 31 | engine.ts:99 syncTickOnce:writeManifest conflict | 推送 CAS 冲突（WebDAV 假件竞态）+ 簿记冻结 | sync-engine-gaps「推送时 writeManifest CAS 冲突…」 |
| 32 | engine.ts:117 cloudHeartbeat:currentProvider null 臂 | active_profile 缺失 / 悬空 | sync-engine-gaps「active_profile 缺失 / 悬空…」 |
| 33 | engine.ts:138,141 cloudHeartbeat:非 200/空 body | 报错记账、空 body 无 desired | sync-engine-gaps「心跳 HTTP 非 200…」 |
| 34 | engine.ts:151 cloudHeartbeat:无 applySwitch | CLI 手动 tick 只上报不切 | sync-engine-gaps「…无 applySwitch：只上报不切不崩」 |
| 35 | engine.ts:206,264 SyncLoop:beginTick raw/tick stopped | tick() raw 路径、stop 后 skipped | sync-engine-gaps「tick()（raw 单飞路径）…」 |
| 36 | engine.ts:230 SyncLoop:默认防抖 ?? DEFAULT_DEBOUNCE_MS | 不传 debounceMs 的 3s 即时推 | sync-engine-gaps「不传 debounceMs…」 |
| 37 | engine.ts:274-314 remount/stateSignature/stopLoop | 挂载、幂等早退、缺 key 摘除（日志）、坏 sync.json、云模式轮询参数、stopSyncEngine | sync-engine-gaps「remount：挂载 → 幂等重挂…」 |
| 38 | engine.ts:341-349 syncStatus:视图分支 | cloud 视图、webdav 带/不带 dir、localdir、cloud 无凭据 → off | sync-engine-gaps（同上用例内四种视图） |

### src/sync/setup.ts / state.ts / runtime.ts / targets/types.ts

| # | 文件:函数:分支 | 缺口 | 新用例 |
|---|----------------|------|--------|
| 39 | setup.ts:46 joinExistingTarget:缺 KDF | 目标包无 kdf → badKdf，不落 sync.json | sync-setup-gaps「目标最新包缺 KDF 参数…」 |
| 40 | setup.ts:76 pushFreshTarget:首推冲突 | readManifest 判空后目标被并发推进 | sync-setup-gaps「全新首推遇并发版本…」 |
| 41 | setup.ts:163,173-175,192 enrollCloud/cloudJson/cloudError | 非 JSON 响应 catch、error.message 透传、fallback、200 无 token | sync-setup-gaps「enrollCloud 配对失败三态」3 例 |
| 42 | state.ts:95,98,100 readSyncState:mode/v | mode 非法、v 不支持、v 缺失（'' 占位） | sync-setup-gaps「mode 非法…」「版本号不支持…」 |
| 43 | state.ts:132-136 noteLocalSwitch（整函数未测） | 未启用/off 静默、target 记录锚点 | sync-setup-gaps「noteLocalSwitch：未启用…」 |
| 44 | runtime.ts:48 targetFromState:无目标 throw | mode=off 报「未配置同步目标」 | sync-setup-gaps「targetFromState：无目标…」 |
| 45 | targets/types.ts:42 parseManifest:字段不完整 | 缺字段/rev 非整数/空串 | sync-setup-gaps「parseManifest：字段不完整…」 |

### src/sync/targets/*

| # | 文件:函数:分支 | 缺口 | 新用例 |
|---|----------------|------|--------|
| 46 | webdav.ts:28,30,31 createWebdavTarget:dir/凭据臂 | 无 dir 根挂载、无凭据、仅密码（空用户名） | sync-targets-gaps「无 dir…」「仅密码…」 |
| 47 | webdav.ts:48,57-61 putWithMkcol/mkcol（整函数未测） | PUT 409 → MKCOL 重试成功；MKCOL 403 → 报错 | sync-targets-gaps「PUT 409 → MKCOL…」 |
| 48 | webdav.ts:84 writeManifest:写前 CAS | rev 不符 → conflict 且不 PUT | sync-targets-gaps「写前 CAS…」 |
| 49 | cloud.ts:53,63 readBlob/writeManifest:守卫 | 未拉取就读 blob、未暂存就写 manifest | sync-targets-gaps「readBlob 未拉取…」 |
| 50 | cloud.ts:42-43,69-70 cloud 目标:缓存/冲突 | if-none-match 携带、422 回滚、409 conflict、成功推送 + readBlob | sync-targets-gaps「readManifest 两次携带 if-none-match…」 |
| 51 | localdir.ts:12 blobPath:越界拒绝 | ../ 逃出同步根 | sync-targets-gaps「readBlob 越界 ref…」 |

## 有意不补的分支（附原因）

| 位置 | 原因 |
|------|------|
| presets/data.ts:52 `md(id)` 无 display 臂 | `md` 为模块私有且内置数据恒传 display，测试侧无法触达（非 bug，纯数据形态事实） |
| presets/data.ts:471-472 `!Number.isNaN(...)` 臂 | 死条件：NaN 不满足 `> 0`，`&&` 链第三臂不可达（见 followups） |
| presets/data.ts:544 `presetModels(p) ?? {}` 右臂 | 不可达：543 行已保证 `models.length > 0`，presetModels 必返回对象（见 followups） |
| collect.ts:32/readUserPresets ENOENT 之外的 IO 错误枚举 | 已用「目录」代表非 ENOENT 类；其余错误码同路径，无需逐码覆盖 |
| engine.ts:257 schedulePoll 的 stopped 竞态臂 | 需在 timer 回调触发瞬间置 stopped，时序不可确定注入（clearTimeout 已兜住主路径） |
| localdir.ts:34 writeManifest 写后回读 conflict | 需在同一函数调用内拦截 fs（write 与 readback 之间无外部注入点）；webdav 同语义分支已有测试（synctarget P2 用例） |
| webdav.ts:31 / cloud.ts:31 `body.text().catch(() => '')` | 需响应中途掐断 socket 才触发 body 读取拒绝，undici 侧表现为请求级异常，不可稳定注入 |

## 施工中发现、未修的疑似问题（进 followups）

> 2026-10-31 终态：四条已全部处置——①②③ 回流 known-issues CORRECT-11 并修讫（①升级为 Infinity 放行真缺陷、②已删、③守卫留档=TS 收窄职责）；④ 回流 CORRECT-10 并修讫（parseHHmm 上移 util/time 与引擎求值同源，越界显式拒绝）。下文为发现时原文，留档。

1. **src/presets/data.ts:471-472 死条件**：`typeof mo.context_window === 'number' && mo.context_window > 0 && !Number.isNaN(mo.context_window)`——`!Number.isNaN` 排在 `> 0` 之后，NaN 走不到第三臂，该检查永不生效（max_output 同）。若本意是拦 NaN，应把 `Number.isFinite` 前置或替代 `> 0` 判定。
2. **src/presets/data.ts:544 不可达回退**：`Object.assign(out, presetModels(p) ?? {})` 的 `?? {}` 不可达（同函数上方 543 行已 `!p.models?.length → continue`），可删。
3. **src/sync/targets/cloud.ts:36 不可达守卫**：`manifestOf()` 内 `if (!cached) throw` 不可达——唯一调用点（readManifest 的 304 分支）已先判 `cached`；writeManifest 不经它。防御性代码可留，但覆盖率上恒为死分支。
4. **sync HH:mm 仅验形状**：`src/sync/types.ts:55` 的 `/^\d{2}:\d{2}$/` 不校验数值范围，`25:99` 会被同步包接受（config 侧归一化行为如何属另一域，未展开验证）。
