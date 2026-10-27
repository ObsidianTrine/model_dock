# 测试用例补齐方案（交接文档）

> 受众：接手写测试的模型 / agent。本文只给方案与判据，不含实现；动手前请先读
> `AGENTS.md`（工程约定、端口禁令、vitest singleFork 雷区）与 `docs/known-issues.md`。
>
> 产出目标：不改 `src/**`，只新增/扩充 `test/**`，每条用例单独跑也绿、全量跑也绿、三平台（ubuntu / windows / macos）都绿。

## 0. 三条命令先跑通

```bash
npm ci                       # 本地 node_modules 可能是旧的（曾见 vitest 3.2.7 vs package.json ^4.1.11，coverage 直接跑不起来）
npm test                     # 基线：80 文件 / 926 用例全绿（~135s）
npm run test:coverage        # 覆盖率（v8），报告在 coverage/（含 html 可点开看未覆盖行）
npx vitest run test/xxx.test.ts   # 单文件
```

测试文件**不在** `tsconfig.json` 的 include 里（`npm run build` 不检查它们），所以类型错误不会在 CI 暴露。写完用这个临时配置自查（完事删掉）：

```json
// tsconfig.tests.tmp.json
{ "extends": "./tsconfig.json",
  "compilerOptions": { "noEmit": true, "rootDir": "." },
  "include": ["./src", "./test/你的文件.test.ts"] }
```

## 1. 现状快照（2026-10-18 实测）

| 指标 | 数值 |
|------|------|
| 语句覆盖 | **74.2%**（7450/10044） |
| 分支覆盖 | **68.6%**（5590/8149） |
| 函数覆盖 | **75.2%**（1132/1505） |
| 测试文件 / 用例 | 80 / 926（6 skipped） |

覆盖率按文件看，缺口集中在五类：

1. **CLI 层（`src/cli/**`、`src/cli.ts`、`src/cliinstall.ts`）行覆盖 0%~40%** —— 这是**统计假象**：
   CLI 由子进程端到端测（`test/reset.test.ts` 的 spawn 配方），子进程不进本进程覆盖率。
   补 CLI 缺口不要追行覆盖，要补「行为用例」（见 P3）。
2. **真有逻辑没测的模块**（行/分支双低，按未覆盖语句数排序）：
   `gateway/holidays.ts`(43.6%/25%)、`config/secrets.ts`(57.4%)、`util/fsx.ts`(79.7%/66%)、
   `util/jsonpath.ts`(76.6%/60.8%)、`providers/dshcatalog.ts`(45.7%/23.3%)、`util/sysproxy.ts`(75.3%)、
   `sync/engine.ts`(72.6%/61.9%)、`update/install.ts`(53.8%/56.3%)、`update/run.ts`(77.2%/64.6%)、
   `autostart.ts`(64.6%/47.2%，本地实测值主要是平台分支差异，CI 三平台各自覆盖)、`cliinstall.ts`(61.7%)、`gateway/lan.ts`(87.7%/72.1%)、
   `adapters/presence.ts`(65.0%/54.3%)、`adapters/packs.ts`(90.9%/79.5%)、`sync/targets/webdav.ts`(81.8%/62.2%)、
   `sync/targets/cloud.ts`(79.5%/59.1%)、`backup/snapshot.ts`(89.1%/60.7%)、`gateway/state.ts`(90.7%/86%)。
3. **大文件里剩下的就是没测的端点**：`gateway/server.ts` 有 261 条未覆盖语句（80.97%/72.67%），
   基本是管理面 HTTP 端点（见 P1-1）。
4. **平台分支没走**：win32 注册表/DPAPI/`.cmd`、darwin keychain/`/Applications`、linux `machine-id` 加密。
   写法见 P1-4 与第 3 节「注入式 seam」。
5. **零覆盖导出符号**（`src/sync/engine.ts` 的 `remountSyncEngine/stopSyncEngine`、`gateway/state.ts` 的
   `clearGatewayState/pidAlive`、`ops.ts` 的 `setRouteNext/migrateSecretsToSecure`、`providers/dshcatalog.ts`
   的 `catalogForRoute/catalogLookupById` 等）—— 逐个确认后归入下表批次。

## 2. 铁律（违反任何一条都会被退回）

1. **不得改 `src/**`**。需要 seam 而实现里没有的，写进第 6 节「需决策」，不要自己动实现。
2. **端口**：单测一律 `listen(0)` + `127.0.0.1`；**禁止** 8687（生产）、8890（用户 dev 沙箱）；手测沙箱只能
   `MODELRDOCK_FAKE_HOME=<独立目录> npx tsx src/cli.ts gateway start --port 189xx`。
3. **`fakeHome()` + `finally h.restore()`**：任何会读写 `~/.modeldock` 的模块都要隔离；`fakeHome` 之外的
   临时目录自己 `fs.rmSync` 清理。
4. **`isolate:false`（全进程单 fork）**：同一个模块**不得**被两个测试文件 `vi.mock`；禁止
   `vi.clearAllMocks()/vi.restoreAllMocks()`；只清自己用的（`mockClear` / `spyOn(...).mockRestore()`）。
5. **环境变量必须存取还原**：`MODELRDOCK_*`、`HTTPS_PROXY/HTTP_PROXY/https_proxy/http_proxy`、`APPDATA`、
   `LOCALAPPDATA`、`PATH`、`TZ` 全部 `save → set → finally restore`。上一轮就有一个文件直接 `delete`
   代理变量，把后续所有测试的代理环境抹了。
6. **时间断言必须时区无关**：禁止写死 `+08:00` / 某天的 `07:30`；用「本地构造 + 回环解析」或
   `getTimezoneOffset()` 推导期望值。也禁止靠改 `TZ` 造场景（CI 三平台都在 UTC）。
7. **禁止时钟计时断言**：`expect(Date.now()-t0).toBeLessThan(...)` 这类在 CI 上必 flaky；性能只做基准记录
   （输出到 stdout 不设阈值），或用纯函数级断言（如缓存命中标记）。
8. **禁止「测试里自抄一份实现再断言它自己」**：例如把实现里的正则复制到测试里 `expect(re.test(x)).toBe(true)`。
   必须走真实导出函数；实现里的非导出逻辑用公开行为覆盖，或提 issue 请实现方导出。
9. **禁止空断言**：`toBeDefined()` / `typeof x === 'function'` / 构造一个对象再断言它的属性
   （这两类上一批已清理过，别再写）。`expect(fn).not.toThrow()` 只在「不抛」本身就是契约时使用。
10. **破坏性验证（mutation check）**：写完用例后**临时**把实现里对应的一行改坏，确认用例转红，再还原
    （`git checkout -- src/...`）。这是「不是假绿」的唯一证据。
11. **Windows 三平台**：路径用 `path.join`；权限断言按 `process.platform === 'win32'` 分支；spawn 全局命令带
    `shell: true`；不假设信号语义（`process.kill` 在 win 是硬杀）。
12. **禁止真实网络**：外网源（holiday-cn、npm registry、GitHub Release）一律用本地 mock 服务器 +
    实现里既有的环境变量 seam（如 `MODELRDOCK_HOLIDAY_SOURCES`）。
13. **fixture 落到 `os.tmpdir()`** 并用 `path.join`，不写死 `/tmp`、不写盘符。
14. **假定时器**只在必要的批次用，且 `vi.useFakeTimers()` 必须配 `finally { vi.useRealTimers() }`（进程共享）。
15. **测试结束后不留进程**：起过 mock 服务器/网关的，`finally` 里 `closeAllConnections?.()` + `close()`，
    并核 `lsof -nP -iTCP:<port> -sTCP:LISTEN` 已释放。

## 3. 注入式 seam 清单（写平台/外部进程用例时优先用这些，别再 spawn 真进程）

| seam | 位置 | 用途 |
|------|------|------|
| `__testSetExternalReader(fn?)` | `src/config/secrets.ts` | 替换 keychain / secret-service **读**路径，避免 spawn `security`/`secret-tool` |
| `__testSetDpapiBatch(fn?)` | `src/config/secrets.ts` | 替换 Windows DPAPI 批量加解密（避免 spawn powershell） |
| `regQueryAny(exec, …)` | `src/adapters/presence.ts` | 传入 exec 桩即可在任意平台测注册表聚合逻辑 |
| `MODELRDOCK_FAKE_*_PRESENT` | `src/adapters/presence.ts` | 强制「客户端在场」真/假，测 overview 分支 |
| `MODELRDOCK_HOLIDAY_SOURCES` / `MODELRDOCK_DISABLE_HOLIDAY_FETCH` | `src/gateway/holidays.ts` | 日历数据源改指本地 mock / 关掉拉取 |
| `MODELRDOCK_DSH_CATALOG` | `src/providers/dshcatalog.ts` | 指向自造的 `models.generated.js` |
| `watchFn` | `src/sync/engine.ts` `SyncLoopOpts` | 替换 `fs.watch`，触发异步 `error` |
| `opts.timeoutError` | `src/util/fsx.ts` `acquireFileLock` | 自定义锁超时错误 |
| `cmdGatewayStart` 等的 CLI | 子进程配方见 `test/reset.test.ts` | CLI 层端到端（独立沙箱 + 随机端口） |

## 4. 待补用例（按优先级分批，每批 = 一个 feature-branch 任务，可并行）

> 编号规则：`批次-序号`。`依据`列给的是**未覆盖代码位置**（本次覆盖率报告），实现改动后行号会漂，
> 以符号名为准。每批建议单独一个 `test/*.test.ts` 文件（避免追加到超大文件里冲突）。

### P0-1 `test/holidays-cache.test.ts` — 节假日日历（`gateway/holidays.ts`，43.6%/25%）

现有 `test/holidays.test.ts` 只覆盖了两条：全源 404 → `notPublished`、500 → `failures`。**不要重复这两条**。

| 编号 | 用例 | 输入 | 断言 |
|------|------|------|------|
| H1 | `holidaySources` 默认两源 | 清空 `MODELRDOCK_HOLIDAY_SOURCES` | 返回 2 条，第 1 条含 `jsdelivr`，第 2 条含 `raw.githubusercontent.com`，都含 `{year}` |
| H2 | 环境变量覆盖与清洗 | `= ' a , ,b '` / `= '   '` / `= ','` | 前者得 `['a','b']`；后两者回落默认两源 |
| H3 | 多源回落：首源 500、次源 200 | mock 两源（`MODELRDOCK_HOLIDAY_SOURCES` 逗号分隔） | 该年份数据进 `cache.data`，`failures` 为空（依据 L95） |
| H4 | 200 但 JSON 无 `days` | `{}` | 该年进 `failures`，含「days 字段缺失」 |
| H5 | 200 但体不是 JSON | `<html>` | 该年进 `failures`，错误含 JSON 解析信息 |
| H6 | `days` 条目清洗 | `days: [{date:'2026-10-01',isOffDay:true,name:'国庆'},{date:'bad',isOffDay:true},{date:'2026-10-11',isOffDay:'yes',name:'x'.repeat(60)}]` | 保留 2 条；`bad` 丢弃；`isOffDay:'yes'` → `false`；`name` 截断到 40 字符 |
| H7 | 单年失败不覆盖缓存旧数据 | `cache.data['2026']` 预置 + 源 500 | 成功后 `cache.data['2026']` 仍是旧数据，`fetchedAt` 已更新（依据 L125-130） |
| H8 | 缓存损坏视为空缓存 | 写 `holidays-cn.json` 为 `not json` / `[]` / `{"data":null}` | 不抛，按空缓存重建（依据 L59-64） |
| H9 | 非手动且未配 `gateway.schedule` → 零请求 | `rt.config.gateway.schedule` 缺省 + mock 源 | 立即返回空结果，mock 服务器 0 次请求（依据 L148-149） |
| H10 | `MODELRDOCK_DISABLE_HOLIDAY_FETCH=1` | 同 H9，`manual:true` | 返回空结果，0 请求（CI 防真实网络） |
| H11 | 手动刷新写缓存 + 审计条目 | `manual:true` + mock 源返回合法年份 | 返回 `years/updatedDays/fetchedAt`；审计日志新增一条 `kind:'audit'`，`op/op_en/detail/detail_en` 双语齐全 |
| H12 | 手动刷新无更新 | 源 404（`notPublished`） | 返回 `note` 含「公告尚未发布」；审计 detail 为「数据源无变化」；`failures` 空 |

**坑**：`logAudit` 需要 `GatewayRuntime` —— 照 `test/gateway.test.ts` 的建 runtime 方式（`fakeHome` +
`createRuntime`/`loadConfig`，跟着现有写法走），或把审计断言放进网关套件的现有 rt 用例；`fetch` 目标必须是
`http://127.0.0.1:<ephemeral>/{year}`。

### P0-2 `test/secrets-backends.test.ts` — 密钥后端（`config/secrets.ts`，57.4%）

现有 `test/store.test.ts`、`test/secrets-inval.test.ts` 已覆盖：file 后端读写、缓存失效、外部 reader 注入、
沙箱强制 file、keychain→file 启动迁移。**不要重复**。

| 编号 | 用例 | 输入 | 断言 |
|------|------|------|------|
| S1 | `parseKeyRef` 全 scheme | `file:/keychain:/secret-service:/env:` / 无前缀 | 各自得到 `scheme`+`id`；无前缀 → `plain` |
| S2 | `makeKeyRef` 轮转一致 | 三种 backend | `parseKeyRef(makeKeyRef(b,id))` 回原 scheme/id；`env` 走 default 分支得 `file:` |
| S3 | `keychainArgValue` 转义 | `abc` / `a"b` / `a\b` / `a\nb` / `a\0b` | 前三个返回带双引号且内部转义正确；后两个返回 `null`（调用方回落 argv 路径） |
| S4 | `getSecret('env:VAR')` | 设/不设环境变量 | 设了返回值；未设返回 `null`；`deleteSecret` 对 env 前缀不报错 |
| S5 | 外部后端读 + 60s 缓存 | `__testSetExternalReader` 计数桩 | 首次调用 reader 1 次并返回值；60s 内第二次 0 次调用（缓存命中）；`__testSetExternalReader()` 还原后仍可用 |
| S6 | 外部读取为 null 时缓存负结果 | reader 返回 `null` | 两次 `getSecret` 只调 reader 1 次，都返回 `null`（依据 L117-131,160） |
| S7 | DPAPI 整表往返（注入） | `__testSetDpapiBatch` 桩（base64 原样往返） | `dpapiCipher.encryptTable` 全部值带 `enc:dpapi:` 前缀；`decryptTable` 还原；空值/已带前缀原样保留 |
| S8 | DPAPI 输出行数不匹配 | 桩返回少于输入 | 抛 `SecretsError`，消息含 `{got}/{want}`（依据 L320-345） |
| S9 | DPAPI 解密失败 → 置空而非明文 | 桩抛错 | `getSecret` 返回 `null`（绝不回落明文），且不抛给调用方 |
| S10 | `pickFileCipher` 平台判定 | 直接调用，按当前平台写期望（三平台 CI 天然覆盖三支） | win32 → `dpapiCipher`（prefix `enc:dpapi:`，enabled）；linux 且有 machine-id → `machCipher`（`enc:mach:`）；其他 → 明文（enabled=false）。**注意**：`CAN_DPAPI/CAN_MACH` 是模块加载期常量，`vi.spyOn(process,'platform','get')` 改不动它，别那样写 |
| S11 | `machCipher` 往返与损坏（仅 linux） | `it.skipIf(process.platform !== 'linux')`；对 `{a:'sk-1',b:''}` 加解密 | 往返回原值、空值原样；把某条密文中间字符改掉 → 该条目置空（不抛） |
| S12 | 写锁超时错误文案 | 手工放置新鲜 `.lock` + 只假 `Date`（`vi.useFakeTimers({toFake:['Date']})` + `setSystemTime` 快进 11s） | `setSecret` 抛 `SecretsError`，消息含 `.lock` 与「删除该 .lock 文件重试」（依据 L304-310） |
| S13 | 批量写入原子性与去重 | `setSecretsBatch` 多条 / 含重复 id | 一次落盘、后者覆盖；任一条失败不产生半表 |

**坑**：`setSecret(…, 'keychain'|'secret-service')` 会真 spawn 外部命令（无写 seam），沙箱里**不要**直接调用；
该分支归入第 6 节「需决策」。

### P0-3 `test/fsx-lock.test.ts` — 文件工具与跨进程锁（`util/fsx.ts`，79.7%/66%）

现有覆盖：`test/store.test.ts` 覆盖 release 的 pid 归属校验；`test/fsx-memo.test.ts` 覆盖 memo/append 部分。

| 编号 | 用例 | 输入 | 断言 |
|------|------|------|------|
| F1 | `readTextIfExists` 缺失/普通/UTF-8 BOM | `tmp/a.txt` 不存在 / 写 `hi` / 写 `\uFEFFhi` | `null` / `hi` / `hi`（BOM 剥掉） |
| F2 | UTF-16 文件 → 可操作报错 | 写 UTF-16LE BOM 字节 | 抛错并提示「转存为 UTF-8 后重试」 |
| F3 | `shouldRetryAtomicWrite` | `EPERM/EACCES/EBUSY/EISDIR/undefined/ENOENT` | 前三个 `true`，其余 `false` |
| F4 | 陈旧锁抢占 | 手造 `.lock`（内容他人 pid，`fs.utimesSync` 把 mtime 拨到 20s 前） | `acquireFileLock` 抢到并返回 release；release 后锁文件消失 |
| F5 | 抢占后锁归属写入本进程 | F4 抢占成功 | 锁文件内容为 `String(process.pid)`；再拿一个 acquire 会排队（他人持锁），release 后才拿到 |
| F6 | 锁超时报错 | 新鲜 `.lock` + 自定义 `timeoutError` + 假 `Date` 快进 11s | 抛出自定义错误；消息含锁路径 |
| F7 | release 幂等 | 连续两次 release / 锁已被外部删除 | 不抛 |
| F8 | `atomicWrite` 落盘语义 | 写覆盖已有文件 | 内容更新；目录内无残留 `*.tmp`；`0600`（win32 跳过权限断言） |
| F9 | `appendLine` 顺序与重开 | 连续 3 次写 + `closeAppendStreams()` 后再写 1 次 | 行序正确、无 BOM、行尾恰一个 `\n` |
| F10 | `randomToken` / `slugify` / `fileMode` | 多次调用 + 边界输入 | token 长度/字符集稳定且两次不同；slugify 去非法字符/截断；`fileMode` 返回 `0o600`（或平台值） |

### P0-4 `test/jsonpath-write.test.ts` — 声明式路径读写（`util/jsonpath.ts`，60.8% 分支）

实现只支持 `$.a.b`、`$.a[0].b`、`$.a.*.b`（`*` 仅写）。现有 `test/util.test.ts` 有基础用例，**先读一遍再扩**。

| 编号 | 用例 | 输入 | 断言 |
|------|------|------|------|
| J1 | `getPath` 遇 `*` 返回 undefined | `$.a.*.b` | `undefined`（注释：star 仅用于写入） |
| J2 | `getPath` 缺键/越界/根为 null | `$.a.b` on `{}` / `[0]` on `[]` / on `null` | 均 `undefined`，不抛 |
| J3 | `toSegments` 含 `*` → 报错 | `$.a.*` | 抛错，消息含「不支持 *」 |
| J4 | 数组末尾追加合法 | `$.list[2]` on `{list:[a,b]}` | 追加成功，长度 3，无稀疏空洞 |
| J5 | 数组越界写入报错（写值分支） | `$.list[5]` on 长度 2 | 抛错，消息含数组长度与下标 |
| J6 | 数组越界写入报错（建容器分支） | `$.list[5].x` on 长度 2 | 同样抛错（依据 L100-113） |
| J7 | 自动创建容器 | `$.a.b.c` on `{}` / `$.a[0].b` on `{}` | 缺失层级按下一段类型建 `{}` 或 `[]` |
| J8 | `*` 叶子替换 | `$.svc.*.base_url` on `{svc:{a:{base_url:'x'},b:{base_url:'y'}}}` | 两个都变新值 |
| J9 | `*` 深层递归 | `$.svc.*.opts.model` on 两个子对象（一个缺 `opts`） | 都写入，缺 `opts` 的按需建 |
| J10 | `*` 跳过对象子节点 | 结构里某个子值是对象（非标量） | 该子值原对象不被替换 |
| J11 | `$` 前缀可有可无 | `a.b` 与 `$.a.b` | 等价 |

### P0-5 `test/sync-loop.test.ts` + `test/sync-webdav-errors.test.ts` — 同步引擎循环与 WebDAV 错误路径

> `test/synctarget.test.ts` 已有内存 WebDAV 假件（Basic 鉴权、MKCOL、正常推拉），**先读它**，只补下面的错误/重试路径。

`sync/engine.ts` 未覆盖的是 `SyncLoop` 生命周期（L239-297）与 `remountSyncEngine/stopSyncEngine`。

| 编号 | 用例 | 输入 | 断言 |
|------|------|------|------|
| E1 | `start()` 立即 tick 一次并挂轮询 | 空 sync.json + `watchFn` 桩 | `tick()` 返回 `skipped`；`stop()` 后 `tick()` 仍 `skipped` |
| E2 | 文件监听只认三个文件 | `watchFn` 桩捕获 listener | `config.toml`/`secrets.json`/`presets.json` 触发防抖 tick；`other.txt` 不触发（用 `debounceMs:1` + 真实 `setTimeout` 或假定时器） |
| E3 | watcher 异步 error 降级不炸 | `watchFn` 返回伪 watcher，触发 `'error'` | `opts.log` 收到「仅轮询同步」文案；进程不抛 |
| E4 | `stop()` 等在飞 tick | `watchFn` 桩 + 在飞 tick | `await loop.stop()` 后无定时器残留（再 `tick()` 立即 `skipped`） |
| E5 | `remountSyncEngine` 幂等 | `fakeHome` 写 `mode:'cloud'` 的完整 sync.json，连续调 2 次 | 两次后 `syncStatus().running` 为 true，第二次不重启循环（`opts.log` 无「已停用/暂停」）；**`finally` 里必须调 `stopSyncEngine()` + 短暂等待**，否则真实轮询计时器会拖住进程 |
| E6 | 暂停/损坏 → 停循环 | `paused:true`；`sync.json` 写坏 | `running` false；坏文件不抛（内部 catch） |
| E7 | cloud 模式用 60s 轮询 | `mode:'cloud'` 完整凭据 | 挂载成功（`pollMs` 走 `CLOUD_POLL_MS`；可用 `opts.pollMs` 显式传入避免等待） |
| W1 | WebDAV 409 → MKCOL → 重试 | mock：首次 PUT 409、MKCOL 201、重试 PUT 201 | 请求序列 `PUT/MKCOL/PUT`；成功返回 |
| W2 | WebDAV MKCOL 非法状态码 | MKCOL 返回 500 | 抛可操作错误（含 HTTP 码与 URL），不静默 |
| W3 | WebDAV PUT/GET 非 2xx 与不可达 | PUT 返回 507；GET 返回 500；端口不通 | 各自可操作报错（依据 L84 与 L41）；不可达时消息含 URL |
| W4 | WebDAV MKCOL 405/301 视为已存在 | MKCOL 返回 405 或 301 | 不抛，继续 PUT（依据 L53-58） |
| C1 | cloud 目标 `readManifest` 语义 | mock `/v1/doc`：404 / 200 / 二次带 `If-None-Match` 得 304 | 404 → `null`；200 → 缓存 rev/ts/byDevid；304 → 命中缓存（`sync/targets/cloud.ts` L56-71） |
| C2 | cloud 目标 `writeManifest` 状态机 | mock PUT：`If-Match` 基线错 → 409；时间早于云端 → 422；200 带新 rev | 409 → `'conflict'`；422 → 「疑似回滚」可操作报错；200 → 返回 `'ok'` 且缓存 rev 更新 |
| C3 | cloud 目标前置校验 | 未 `readManifest` 就 `readBlob`；未 `writeBlob` 就 `writeManifest` | 各自抛「尚未拉取 / 未暂存信封」可操作错误（依据 L31-76） |

### P1-1 `test/gateway-admin-endpoints.test.ts` — 管理面剩余端点（`gateway/server.ts`，261 语句未覆盖）

按端点分组，一组一个 `describe`，复用 `test/gateway.test.ts` 的建服 helper（`listen(0)`、admin cookie、`fetch`）。
**先读 `gateway.test.ts` 已覆盖的端点，只补下面这些**（括号内是未覆盖依据行）：

| 编号 | 端点 | 断言重点 |
|------|------|----------|
| A1 | `POST /_modeldock/sync/import`（L1518+） | 合法包 → 落配置 + 200；损坏包/口令错 → 400 + 可操作 `hint`；未授权 → 401 |
| A2 | `POST /_modeldock/lan`（L1466-1503） | 开启/关闭 LAN、`grant` 发放与一次性消费、非法 token 拒绝 |
| A3 | `POST /_modeldock/autostart`（L1671-1692） | `enabled:true` 只登记服务文件不 bootstrap（沙箱内文件带 `.sandbox`）；`enabled:false` 返回 `wasInstalled` 语义；不支持平台 → 400 + 可操作错误；两次切换后 `overview` 立即反映新状态（overviewCache 失效） |
| A4 | `POST /_modeldock/import/apply`（L1721） | 候选 → 服务/profile 落库；重复地址跳过并回报 |
| A5 | `POST /_modeldock/service/update`（L1742-1859） | 改 base_url/protocol 后 key 保留；端点风险提示返回；非法端口/base_url 400 |
| A6 | `POST /_modeldock/harness/env`（L1900-1929） | 已接入且有 token → 返回 `base_url` + `lines`（含 `OPENAI_BASE_URL=<base>/v1`）；未接入 / 该客户端无 token → 400 + 可操作错误；每次调用写一条审计；`overview` 批量响应里仍无 token |
| A7 | `POST /_modeldock/install` + `/uninstall`（L1973-2024） | 沙箱内安装重定向；脚本类客户端拒绝执行并提示手动安装 |
| A8 | `POST /_modeldock/attach/plan|apply`、`/detach`（L2041-2093） | plan 预览与实际写入一致；detach 后客户端配置还原 |
| A9 | `POST /_modeldock/harness/route`、`/harness/mode`（L2098-2178） | 钉定 profile/服务后 overview 回显；非法 profile 400 |
| A10 | `POST /_modeldock/use`、`/profile`、`/key`、`/reload`、`/test`（L2194-2302） | 切换当前 profile；新建 profile 校验；key 轮转后旧 key 失效；reload 后配置生效 |
| A11 | `POST /_modeldock/reset`（L2324-2350） | 需要确认参数；沙箱内只清沙箱数据 |
| A12 | `probePing`（L2448-2476） | `base_url` 空/非法 → `{ok:false, err}` 且不抛；mock 上游可达 → `{ok:true, ms>=0}`；不可达 → `ok:false` 且带 `hint`。经 `dispatcherFor(rt, provider)`，用 `proxy:'direct'` + `listen(0)` |

### P1-2 `test/ops-routing.test.ts` — 路由切换与密钥迁移（`ops.ts`，79.8%）

| 编号 | 符号 | 断言 |
|------|------|------|
| O1 | `setRouteNext` | 设为不存在的服务 → 抛「服务不存在」；设/清后 `gateway.route_next` 落盘正确；清空返回 `null` |
| O2 | `setAutoRoute` 组合更新 | `failoverOn429` 开 → `failover_status_codes=[429,503]`；关 → 键被删除；部分更新不覆盖其他字段 |
| O3 | `switchToService` 复用/新建 | 已有 profile 时复用并设 `active_profile`；无 profile 时建 `auto-<id>` 且默认模型取服务首个模型 |
| O4 | `removeProviderCascade` 悬空引用清理 | 删除服务后：profile 删除、`active_profile` 清、`auto_route_provider` 清、fallback 里 `<id>` 与 `<id>:<model>` 两种形态都剔除、定时窗口里的引用剔除 |
| O5 | `resyncHarnessToRoute` / `refreshBaked` | 切路由后已烤模型客户端被重写；单客户端失败进 `warnings` 不阻断 |
| O6 | `migrateSecretsToSecure` 沙箱 no-op | `FAKE_HOME` 下调用一次：不 spawn、不改配置、不打印迁移日志（依据 L836-850 提前返回） |

### P1-3 `test/autostart-status.test.ts` — 自启**只补状态判定**（`autostart.ts`，本地 64.6%/47.2% 是平台差异，不是缺口）

> ⚠ 先读 `test/autostart.test.ts`：路径推导、plist/unit/vbs 内容、`gatewayDaemonArgs`、以及
> 「真实 bootstrap」层都已覆盖（后者用 `/bin/sleep` 桩 + 「用户已注册则 skip」守卫，绝不拉起真实网关）。
> **不要**在同一 OS 上再写真实 bootstrap/launchctl 用例；也不要让用例去探测默认端口健康
> （`installAutostart` 内含 `gatewayLive()`，会打到代码默认端口 8687 → 触碰生产红线）。

| 编号 | 用例 | 输入 | 断言 |
|------|------|------|------|
| T1 | `autostartStatus().stale` | `fakeHome` 写 plist/unit 指向一个不存在的可执行路径 | `installed:true` 且 `stale:true`（登记命令文件已不在 → 下次登录会失败） |
| T2 | `autostartStatus()` 未安装 / 文件存在但未加载 | 只 stat 不 spawn 的场景 | `installed:false` 分支与 `loaded:false` 分支各自可区分（`loaded` 依赖 init 查询，落 skip 分支时用 `if (kind==='windows')` 断言恒等） |
| T3 | `autostartOverview()` 纯 stat 语义 | 依次：无文件 → 写文件 → 删文件 | 三次结果依次 `{installed:false}` / `{installed:true,kind}` / `{installed:false}`，且**只看文件不动 init 系统**（别用 `vi.spyOn(child_process,'spawnSync')` 去拦：模块是具名导入绑定的，spy 拦不住；用行为断言） |
| T4 | `serviceFilePath()` 与 `autostartKind()` 一致 | 三平台按当前 OS 断言 | 返回路径的父目录就是该 kind 的落点；未知平台返回 `null`（本机 mac 只能断言自身分支，其余靠 CI 三平台覆盖） |

### P1-4 `test/presence-registry.test.ts` / `test/dsh-catalog.test.ts` / `test/sysproxy-detect.test.ts`

**presence**（`adapters/presence.ts`）
- P1 `regQueryAny` 注入 exec：三键并发（断言 exec 调用键顺序集合）、任一输出含应用名即 true、大小写不敏感、
  全空 → false（依据 L72-83）。
- P2 `cliPresent` 的沙箱隔离分支：`MODELRDOCK_FAKE_<ID>_PRESENT`（id 大写、`-`→`_`）强制 true/false 已由
  `test/adapters.test.ts` 覆盖；本批只补 `sandboxIsolated:true`——宿主 PATH 有同名命令但落点在沙箱外 → false，
  沙箱内 bin 有 → true（先对照 `test/install.test.ts` 的 `commandOnPathSandbox` 用例）。
- P3 `desktopPresent` darwin：`vi.spyOn(process,'platform','get')` + `FAKE_HOME` 下造 `~/Applications/Foo.app`
  → true；目录不存在 → false；`FAKE_HOME` 不隔离 `/Applications`，因此**只断言 `~/Applications` 分支**。
- P4 `residueNote`：配置在而本体缺席 → 提示「未安装/卸载残留」。

**dshcatalog**（`providers/dshcatalog.ts`，45.7%）
- D1 `MODELRDOCK_DSH_CATALOG` 指向自造 catalog 文件（`export const MODELS = { route: { id: { name, contextWindow, maxTokens } } }`）
  → `loadDshCatalog()` 返回 `catalog`，`source` 为该路径；非整数 `contextWindow` 被丢成 `undefined`。
  **坑**：实现用 `import(pathToFileURL(file))` 动态加载，Node 按最近 `package.json` 的 `type` 判模块制式 ——
  临时目录里写成 `.js` 但没有 `{"type":"module"}` 会被当 CJS、`export` 语法直接失败（`tryLoad` 吞成 null，
  用例会误判成「探测不到」）。fixture 用 `.mjs` 后缀，或同目录补一个 `package.json`。
- D2 缓存：第二次调用不再读盘（可用 `clearDshCatalogCache()` 前后对比 source/mtime 或注入坏文件验证仍命中缓存）。
- D3 坏文件/`MODELS` 非对象/空对象 → `null`（依据 L53-82）。
- D4 `catalogForRoute` 未命中返回空 Map；`catalogLookupById` 跨 route 命中、同名取先出现者。

**sysproxy**（`util/sysproxy.ts`，75.3%）
- 解析层（`pickEnvProxy`/`parseScutilProxy`/`parseRegProxyEnabled`/`parseRegProxyServer`/`parseWinProxyServer`）
  已由 `test/sysproxy.test.ts` 14 条覆盖，**不要重写**。
- 只剩 `detectSystemProxy` 的平台 spawn 分支（L112-131）与 `resetUpdateProxyCacheForTest`（L108）未覆盖；
  `detectSystemProxy` 未导出且无注入点 → 归入第 6 节，本批只加一条：`resolveUpdateProxyUrl` 在
  `cached` 已存在时不再重复探测（`resetUpdateProxyCacheForTest()` 前后行为可区分）。

### P1-5 `test/import-parsers-edge.test.ts` — 导入解析器边界（`import/sources.ts`，分支 73%）

已有 `test/import-scan.test.ts` 覆盖各源主路 + `applyImport`；本批只补**未覆盖分支**（分支行
199/214/244/316/387/637/718/756/811/915/981/997/1078，位置以符号为准）：
1. cc-switch 行缺字段/字段类型错 → 跳过并给 `skip_reason`，不整批失败。
2. gemini `.env` 里 `GOOGLE_GEMINI_BASE_URL` 缺失/空值 → 无候选；有多余注释行不炸。
3. one-api 渠道：缺 `base_url`、渠道类型不支持、模型字符串带前缀 → 候选字段正确/给出 skip 原因。
4. `stripApiEndpoint` / `isLocalBaseUrl` 边界：末尾 `/chat/completions`、`/v1`、IPv6 `::1`、`0.0.0.0`、
   形似回环的公网域名 `127.0.0.1.example.com`（不得误判）。
5. `dedupeCandidates`：带 `skip_reason` 的占位项保留、`is_current` 优先（**已在新 `test/import-sources.test.ts` 覆盖，先读**）。

### P2-1 `test/update-install-run.test.ts` — 更新安装与收尾（`update/install.ts` 53.8%、`update/run.ts` 77.2%）

1. `stopTrayProcesses`：桩 spawn/枚举，断言只停托盘进程、异常不抛（依据 L63-137）。
2. `cleanOldVersions`：临时目录造 3 个旧版本 + 1 个当前版本 → 只删旧版本、当前版本保留（L195-206）。
3. `defaultInstallDeps` 组装：断言参数中的落点/权限（不真装）。
4. `run.ts` 的 `cleanUpdateRemnants`：残留 `*.tmp`/旧目录被清、活动目录不动（L275-282）。
5. 更新过程中断（模拟失败）→ 错误可操作、不破坏当前版本（L201-217）。

### P2-2 `test/lan-discover.test.ts` + `test/cloud-cli.test.ts` — LAN 与云 CLI

1. `buildLanStatus`：未开启/已开启/有配对设备 三种视图（`gateway/lan.ts` L1090-1095）。
2. LAN POST 的 grant 生命周期：发放 → 消费一次 → 二次消费失败（L933-996）。
3. `discover.ts` beacon：`startSyncBeacon/stopSyncBeacon` 幂等；端口占用时报可操作错误、不崩（L83-124）。
4. `cloud/main.ts` 的 `main()`：子进程跑 `node --import tsx src/cloud/main.ts ...`（照 `test/reset.test.ts` 配方），
   断言参数解析、缺 token 的报错、`consoleToken` 持久化（部分已由 `cloudmain.test.ts` 覆盖，先读）。

### P2-3 小补丁批次（每项 ≤3 条用例）

| 目标 | 用例 |
|------|------|
| `providers/fetch.ts` L108-155 | 响应 `content-length` > 20MB → 跳过该候选并进错误列表；200 但体非 JSON → 失败但可诊断；顶层直接是数组的响应 → 正常解析 |
| `backup/snapshot.ts` L118-186 | `getSnapshot` 指定 id 读取/不存在返回 null；保留策略只留 N 份；快照文件权限 0600 |
| `gateway/state.ts` L691-700 | `clearGatewayState` 清掉 `gateway.json` 且不误删其他文件；`pidAlive` 对死的/自己的 pid 判定 |
| `gateway/shared.ts` L58-96 | `projectModel` 只暴露白名单字段（不泄 key）；`listenWithRetry` 端口占用时重试或报错；`fetchEnvelopeFromUrl` 非 2xx → 可操作错误 |
| `providers/known.ts` / `resolve.ts` L38-52、119 | `saneContextWindow/saneMaxOutput` 边界（0、负数、超上限、非整数）；`resolveModelMeta` 分层回退（多数已覆盖，先读） |
| `adapters/packs.ts` | `planDetach`/`status`/`label` 的 L2 pack 分支（声明式 pack 的 detach 计划与状态） |

### P3 `test/cli-behavior-*.test.ts` — CLI 行为化（覆盖统计假象的正解）

配方照 `test/reset.test.ts`（tsx ESM loader + `spawnSync` + 独立 `MODELRDOCK_FAKE_HOME` + `timeout: 120_000`）：

1. `profile add/use/list/rm`：`add` 后 `list` 含新 profile；`use` 改 `active_profile`；`rm` 删除并清理 `active_profile`；
   不存在的 profile → exit 1 + 可操作报错。
2. `init`：空沙箱 `init` 生成最小 `config.toml`；重复 `init` 不覆盖已有配置（或明确提示）。
3. `import --from <source>`：空沙箱 → 0 候选提示；有 fixture（造 cc-switch/claude 配置）→ 落库并打印数量；
   `--yes` 与交互路径至少各覆盖一条。
4. `gateway status/log/rotate-token`：未运行时 `status` 给启动指引；`rotate-token` 后旧 token 401；
   `log` 展示当天文件（造日志文件）。
5. `provider list/set-key`、`model set/list/refresh`：`set-key` 落 file store 且打印脱敏；
   `model set` 写入元数据；`model refresh` 在 mock 上游下成功/失败两条。
6. `sync export/import`：导出包 → 导入回同一沙箱幂等；口令错 → 可操作报错。

## 5. 不要写的（上一轮已踩过的反例）

1. `expect(fn).toBeDefined()` / `typeof fn === 'function'` 型空断言。
2. 构造 `ImportCandidate`/`ImportSource` 对象再断言它的属性（`ImportSource` 是字符串联合，不是对象）。
3. 把实现里的正则/常量复制进测试再断言副本（假绿）。
4. `Date.now()` 计时断言。
5. 写死 `+08:00`、某一天的具体钟点，或靠改 `TZ` 造时区场景。
6. 直接 `delete process.env.X` 不还原（尤其 `HTTPS_PROXY/HTTP_PROXY` 与 `PATH`）。
7. 传错参数形态的调用（如 `scanSources([])` —— 它收单个源名，传数组永远返回空）。
8. 断言垃圾行为（如无效 Date 的 `NaN-NaN-NaN` 输出）当作契约；这类应记为已知缺陷，不在测试里锁死。
9. 重复已有覆盖：`gateway.test.ts` 已覆盖 failover/quota/gzip/熔断/钉定路由；`hotpath.test.ts` 覆盖
   dispatcher 与模型改写快路径；`modelmeta.test.ts` 覆盖 `fetchModelIds` 成功路径；`import-scan.test.ts`
   覆盖扫描与 `applyImport`；`store.test.ts` 覆盖配置/密钥主路；`adapters.test.ts` 覆盖 attach/detach。

## 6. 需要决策 / 需要实现侧加 seam 的项（先问，不要自己改 src）

| 项 | 现状 | 建议 |
|----|------|------|
| `setSecret(..., 'keychain'/'secret-service')` 写路径 | 只 spawn `security`/`secret-tool`，无写 seam | 加 `__testSetExternalWriter`（与 reader 同套路）后可测；否则跳过并记录 |
| `migrateSecretsToSecure` 的 keychain 目标分支 | `FAKE_HOME` 下 `defaultStore()` 恒为 `file`，永远提前返回 | 加 `__testSetDefaultStore` seam，或在沙箱里允许 `security.store='keychain'` 走注入 reader/writer |
| `defaultStore()` 的 darwin/linux 分支 | 依赖真实 `security`/`secret-tool` | 用 `vi.spyOn(process,'platform','get')` + `hasSecretTool` 的 stub（需 seam） |
| `cloud/main.ts` 入口 | 仅 CLI 子进程可达 | 走 P3 子进程配方（无需 seam） |
| `sysproxy.detectSystemProxy` 的平台命令 | 直接 spawn 平台命令 | 先查是否已有注入点；没有则只测解析/缓存层，spawn 分支写进本条 |

## 7. 分工与流程

1. 每批一个 `feature-branch` 任务：
   ```bash
   node .agents/scripts/feature-branch.mjs start test-<批次小写名>     # 如 test-holidays-cache
   ```
   在 `.agents/worktrees/<task-id>/` 内写测试，提交、`npm test` 全绿后 `finish`。
2. **并行分工按文件分区**（避免同一文件冲突）：P0 五批可同时跑（各自新文件）；P1-1 与 P1-2 都动网关/ops 的测试
   辅助函数时先约定放 `test/helpers.ts` 还是各自内联（建议各自内联，helpers 只放通用 fakeHome）。
3. 未完成必须在 worktree 的 `NOTES.md` 写清「已完成 / 剩余 / 如何验证」（start 会自动生成模板）。
4. 每批交付时附：新增用例数、目标文件覆盖率前后数字（`npm run test:coverage` 单文件跑亦可）、
   做过哪些 mutation check。

## 8. 验收清单

- [ ] `npm test` 全绿（80+ 文件，无 skipped 新增例外）。
- [ ] 新用例单独跑、与 `test/reset.test.ts`、`test/update-cli.test.ts`、`test/store.test.ts` 组合跑都绿
      （验证没有跨文件 mock/环境变量污染）。
- [ ] `TZ=UTC npm test` 与本地时区都绿（时间相关断言）。
- [ ] 目标模块语句覆盖提升且**分支覆盖**同步提升（只提行数不算）。
- [ ] 至少做一次 mutation check（临时改坏实现 → 用例红 → 还原）。
- [ ] 没改 `src/**`；没新增 `vi.mock` 于共享模块；没写死端口/路径。
- [ ] 测试文件 `tsc --noEmit`（第 0 节临时配置）无错。
- [ ] 收尾无残留进程/端口/临时目录。
