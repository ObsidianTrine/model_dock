# 冗余与设计审查（2026-10-11）

> 来源：2026-10-11 第二轮全仓审查，聚焦**冗余代码、死代码、双实现漂移、结构与设计**（性能/跨平台/正确性第一轮结论见 `docs/known-issues.md`，热路径 B/C 级见 `docs/backlog.md`）。四分区只读审查（gateway / adapters+import / config+util+backup+presets+providers / cli+update+sync+cloud+install），关键正确性结论已人工到源码复核。
> 用途：给后续改进排期留底。**动手前先读 `docs/known-issues.md` 避免踩已知坑**；本文不重复收录其条目，重叠处只做交叉引用。
> 维护约定（与 known-issues 相同）：
> 1. 修复某项后回到本文档标注日期与 commit，不要直接删条目。
> 2. 行号基于审查当日代码（develop@687c392 附近），动手前先读对应源码确认仍成立。
> 3. 编号前缀：**BUG-**（新发现正确性问题）/ **DRIFT-**（双实现行为漂移）/ **DUP-**（冗余实现）/ **DEAD-**（死代码）/ **DESIGN-**（结构与约定）。与 known-issues 的 PERF-/XPLAT-/CORRECT- 不重叠。

## 审查依据：好代码标准

本轮按以下标准审查（2026-10 主流共识 + 本项目 AGENTS.md 既有约定）：

- **DRY 按业务规则去重**：只合并代表同一业务规则/校验/流程的重复，形似而神异的代码不强行合并（2026 共识，避免过激发明）。
- **死代码清除**：无调用者的导出、不可达分支、残留调试代码直接删（git 可找回），不留"以后可能用"。
- **单一职责与可读结构**：函数一个屏读得完、嵌套 ≤3 层、命名一致；同一件事在全仓只有一种做法。
- **一致性即质量**：同一操作（写盘、路径、i18n、进程终止）全仓走同一条路径，双实现必然漂移。
- **可操作错误信息**：失败时告诉用户怎么修，不静默吞错。
- 本项目自有约定：路径走 `util/paths.ts`、写盘走 `atomicWrite()`、文案走 `t()` 双语、平台差异显式分支。

参考：[Codacy — What Is Clean Code](https://blog.codacy.com)、[CodeAnt — 7 Axes of Code Quality](https://codeant.ai)、[Coderio — Best Coding Practices 2026](https://www.coderio.com)、[Devcom — Clean Code Principles](https://devcom.com)。

## 总体评价

架构本身健康：plan/apply 两段式适配器引擎、原子写+快照+乐观锁、双语 i18n 覆盖率高、网关热路径有充分的竞态防护注释。没有结构性腐烂。主要债务是**横向复制**：update/sync/cloud/install 各自长出平行的下载-校验-解压栈与状态机，六个适配器互相抄写同款逻辑，gateway/server.ts 与 ui.ts 内部多处三写五写——这些是未来 bug 的主要来源。另有约 14 个本轮新发现的正确性隐患（含 4 个 P1），全部是局部小修。

---

## A. 新发现的正确性问题（BUG-）

- [ ] **BUG-01（P1）`src/adapters/dsh.ts:592-621` planDetach 索引错位，可能删掉用户条目或留下脏配置**
  `const js = doc.toJS()` 先快照索引，随后 `seq.delete(idx)`（modeldock 条目清空 config 时）改动活的序列，第二个删除 `seq.delete(j)` 仍用改动前的 `j`。yaml 的 `YAMLSeq.delete` 越界静默 no-op：常见形态（attach 只建了 modeldock+agent-default 两项）detach 后**残留指向已删 provider 的 `agent-default-model`**；若用户后面还有自己的条目，则**删的是用户的条目**。现有测试（test/adapters.test.ts:588-603）因用户 `ark` provider 占位而绕过此路径。修：两个索引都取自 `js` 并按降序删除（或首次删除后重查 `patchEntryIndex`）；补一个 modeldock-only patch 文件的回归测试。
- [ ] **BUG-02（P1）`src/update/webupdate.ts:211-217` 一键更新子进程只监听 `exit`，spawn 失败要么崩网关、要么更新状态永久卡死**
  Node 不保证 spawn 失败（ENOENT/EACCES）后发 `exit`；只有 `error`/`close` 时 `markApplyFailed` 永不执行 → `state.updating` 恒为 true，后续所有 apply 返回 in_progress；未处理的 `error` 事件则直接崩掉网关。修：`watchApplyChild` 同时监听 `exit` 与 `error`（防双触发），error 视为立即失败。
- [ ] **BUG-03（P1）`src/sync/engine.ts:202-211` `fs.watch` 无 `error` 监听，异步错误 = uncaught exception 杀网关**
  外层 try/catch 只覆盖同步调用；EMFILE/ENOSPC（inotify 耗尽）或被监视目录被删时 FSWatcher 异步发 `error`。修：`this.watcher.on('error', ...)` 降级为轮询（与现有 catch 文案语义一致：只丢即时推送）。
- [ ] **BUG-04（P1）`src/gateway/server.ts:695` overview 缓存 TTL 2s < UI 轮询间隔 5s（ui.ts:4239），缓存永不命中**
  注释写明"UI 每 5s 轮询，避免每次全量 adapter IO"，但 2s TTL 在下次轮询前必过期：每次轮询全量跑 `buildOverview`（每 provider 一次 keychain `getSecret` 子进程 + 9 适配器 status 文件探测）。与 PERF-06（串行 await）同点不同因，都要修。修：TTL 提到 ~4s（或轮询降到 ≤TTL）；`hasKey` 可再加更长 TTL 的子缓存。
- [ ] **BUG-05（P2）`src/gateway/lan.ts:223,241` `requestRateByIp` 无界增长**
  只 set 不 delete（grep 证实），LAN 扫一遍就是 254 条永久驻留。修：仿同文件 `putSyncGrant`（249-254）在写入时顺带清扫过期键。
- [ ] **BUG-06（P2）`src/config/store.ts:114-128` 陈锁被 steal 后，原持有者 `release()` 无条件 unlink，删掉新持有者的锁**
  超 15s 被抢锁后原进程收尾仍删锁文件 → 第三个写者进入。修：锁文件写 pid，release 前校验内容仍是本进程 pid 再删。
- [ ] **BUG-07（P2）`src/config/secrets.ts:327-359` secrets.json 读改写无跨进程锁**
  CLI 与 daemon 并发 setSecret 丢更新（store.ts:101-153 已为 config.toml 解决过同一问题）。修：把 `acquireLock`/`serialize` 下沉 `util/fsx.ts`，secrets RMW 同样包一层。
- [ ] **BUG-08（P2）`src/config/secrets.ts:274-279` secrets.json 损坏被静默当作"无密钥"**
  `catch { raw = {} }` 吞掉解析错误，用户只看到全部 Key 未设置、无从排查；与 `loadConfig` 抛可操作 `ConfigError` 的做法不一致。修：抛同类可操作报错（指向文件与恢复办法）。
- [ ] **BUG-09（P2）`src/adapters/workbuddy.ts:360-373` planDetach 重读文件 TOCTOU 崩溃路径**
  `activeFile()` 与实际重读之间文件消失时 `parseJsonStrict` 返 null，`(root as …).models` 在 try/catch 之外抛 TypeError。修：重读为 null 时按"跳过"早退返回 notes。
- [ ] **BUG-10（P2）`src/import/sources.ts:242-246` 单个损坏的 dsh patch 文件中断整个扫描并丢弃已收集结果**
  循环内 `catch { return [placeholder(...)] }` 丢掉了 `out` 里先前解析出的候选；同文件 scanCcSwitch 是逐行 continue。修：push placeholder 后 continue。
- [ ] **BUG-11（P2）`src/cli.ts:95` tray spawn 无 `error` 监听**
  同文件 152 行注释明说"spawn 失败不监听会让整个进程崩掉"，此处漏了。修：补 `.on('error', () => {})`。
- [ ] **BUG-12（P2）`src/presets/data.ts:500` 模块加载期执行同步 IO 且校验失败即 throw**
  presets.json 格式错误时静态 import 链在错误处理器建立前就抛——所有命令（含 `--help`）裸栈崩溃，丢掉已写好的可操作报错。修：懒初始化（首次 `findPreset` 时），或在 cli.ts 入口 try/catch 内触发加载并走 `✗` 格式化输出。
- [ ] **BUG-13（P2）`src/providers/known.ts:155` `VISION_ID_RE` 第二分支 `|vision` 未锚定**
  裸 `vision` 匹配任意子串，"envision/revision" 类 id 被误判为视觉模型，前面精心写的边界检查形同虚设。修：删掉第二分支（第一分支已覆盖分词级 vision）。
- [ ] **BUG-14（P2）`src/update/webupdate.ts:71-94` `kickUpdateCheck` 防重入竞态**
  `if (state.checking || inflight) return` 在首个 `await` 之前，占位 promise 在其后才创建：并发两次 kick 双双穿透、双拉 GitHub（耗 rate-limit，last-writer-wins）。修：在任何 await 之前同步创建并赋值 inflight。

## B. 双实现行为漂移（DRIFT-）——同一件事两套代码，已经不一致

- [ ] **DRIFT-01（P1）"添加服务"双实现：`src/cli/providers.ts:102-207`（cmdProviderAdd）vs `src/ops.ts:37-233`（addService）**
  ops 版有同 URL+同 Key 查重、endpoints/fallback 链校验、预设模型合并、`auto-<id>` 命名 + `setActiveIfEmpty`；CLI 版全都没有且**无条件覆盖 active_profile**。`cmdInit` 走 CLI 版、Web 控制台走 ops 版——同一用户动作在两个入口行为不同。修：`cmdProviderAdd` 改为 `ops.addService` 之上的薄交互壳（只留预设选择问答），行为差异即消失。
- [ ] **DRIFT-02（P1）`src/sync/setup.ts:27-109` 与 `143-229` 是两份 ~85 行的同款状态机**
  "已有 manifest → 解析 → KDF 派生 → openWithKeys（含同款错误口吻）→ applySyncdoc"与"新目标 → sealWithKeys → 写 manifest/rev-1"两大块逐字重复，仅 mode/cloud 字段不同；KDF 派生块在 `sync/engine.ts:68-77` 还有第三份。修：抽 `joinExistingTarget()` / `pushFreshTarget()`，mode 差异作参数传入。
- [ ] **DRIFT-03（P2）网关端口解析双启发式，旧的那个带已知多实例误判**
  `cli/shared.ts:14-17` `targetGatewayPort` 信任"最后启动实例"状态文件；`ops.ts:309-317` `resolveClientGatewayPort` 正是为修它的多实例误判而写（注释里有 2026-10-01 事故），但 `cmdEnv`（cli/diag.ts:188）仍在用旧者 → `eval "$(modeldock env)"` 在双实例场景会输出 dev 实例地址。修：删 `targetGatewayPort`，diag.ts 改用 ops 解析器（导出即可）。

## C. 冗余实现清单（DUP-）——合并落点与消重收益

- [ ] **DUP-01 守护进程拉起/开浏览器/按 PID 杀树，各有两份且已分歧**
  spawn daemon + 20×250ms 轮询：`cli.ts:53-81` vs `cli/gatewaycmd.ts:34-53`（超时文案都相同）；开浏览器三分支 + win `['/c','start','',url]` 技巧 + 同款注释：`cli.ts:139-158` vs `gatewaycmd.ts:327-344`；进程行解析 + kill：`update/install.ts:62-87`（taskkill /T /F，符合约定）vs `gatewaycmd.ts:132-161`（全平台 SIGTERM，关联 XPLAT-02）。修：在 `src/cli/shared.ts` 抽 `spawnDaemonAndWait` / `openUrlInBrowser` / `killByPid`（win32 统一 taskkill /T /F）/ `parsePidCommandLines`，约 -300 行并消灭最大分歧源。
- [ ] **DUP-02 下载-SHA256-解压三套平行栈：update/ 与 install/noderuntime.ts**
  `downloadAsset`（check.ts:217-281，带进度+重试）vs `downloadFile/downloadText`（noderuntime.ts:220-249）；SHA256SUMS 行正则两份（check.ts:299 vs noderuntime.ts:253）；`sha256File`（check.ts:308-316）与已有 `fsx.fileSha256` 并存；`extractArchive` tar+Expand-Archive 双份（install.ts:196-213 vs noderuntime.ts:273-288）；`run.ts:217-229` checkUpdate 重复 runUpdate:108-112 的比对块。修：抽 `src/update/transfer.ts`（下载到文件+进度+重试、SUMS 解析、解压），sha256 收敛到 fsx。
- [ ] **DUP-03 六个适配器横向抄写（最大的一组冗余）**
  ① route→profile→provider 解析 5 行同款 ×4：dsh.ts:327-331、zcode.ts:222-227、workbuddy.ts:208-213、provider-json.ts:159-165，配套"模型列表取自当前路由…"note ×4；② 直连 wire 选择逐字同款 ×2（dsh.ts:383-400 vs zcode.ts:270-278，含同款 Responses 协议警告），"独立直连已写入明文 Key"note 手抄 ×6（codex:150、dsh:536、zcode:350、provider-json:184、packs:156、workbuddy:247）；③ `presence.ts` 的 `residueNote()` 建好了没人用，六个适配器各自手写同款残留提示（claude-code:119、codex:98、zcode:163、workbuddy:113、provider-json:102、mimo-desktop:63）；④ `[dD]*\[\d+[MmKk]\]` 上下文后缀正则 ×3（claude-code.ts:36、sources.ts:172、sources.ts:457，仅靠注释约定同步）；⑤ `fileExists` ×2（dsh.ts:29、sources.ts:338）而 fsx.isFile 死着（见 DEAD-01）；⑥ dsh 私有 `credFile()`/`providersOf()` 被 `import/sources.ts:229,247-252` 抄写（含 `llm-pi-ai` 根 id 字面量），dsh 一改名 import 静默失配。修：`resolveRoute()`、`directWire()`、`directAttachNote()` 落 types.ts/共享模块；residueNote 全面启用；正则与 dsh 内部件导出复用。
- [ ] **DUP-04 gateway 内部三份投影**
  "找引用此 provider 的 profile（active_profile 优先）"×3：server.ts:716-719、1835-1838、1845-1848（已有变异版 `profileForProvider` 可参照）；模型元数据投影 ×3：server.ts:672-680、743-750、lan.ts:307-316——填充链改一处漏两处。修：抽 `profileRefForProvider()`、`projectModel()`。
- [ ] **DUP-05 server.ts 与 main.ts/lan.ts 之间的安全与引导原语双份**
  listen+EADDRINUSE 重试机制 ×2（main.ts:30-44,112-124 vs lan.ts:1068-1093）；`safeEqual` ×2 且策略分歧（server.ts:580 sha256 归一 vs lan.ts:39 长度预比较）；runClientInstall/Uninstall 子进程引导块逐字 ×2（server.ts:117-126 vs 183-192）。修：`listenWithRetry` 落共享处；`safeEqual` 收敛 util（用 sha256 归一版）；抽 `runInstallCommand()`。
- [ ] **DUP-06 ui.ts 内部复制粘贴（4263 行单文件的内部赘余）**
  剪贴板复制+图标翻转反馈 ×5（1092、1501、2105、3232、4130），而 `copyText()` 助手已存在；`applyLang` 与 `applyI18nTree` 五段 `querySelectorAll('[data-i18n…]')` 遍历逐字重复（1039-1043 vs 3384-3390）；`impWarnList`/`parseTarget`/自动路由 `<option>` 构建器在 ui↔lan（2309 vs lan:569、2488 vs lan:597、1575 vs lan:617）与 ui↔ui（1575 vs 1603）重复。修：统一走 `copyText()`+`withCopyFeedback()`；`applyLang` 委托 `applyI18nTree(document)`；target 解析与 warn 列表抽成两页共享的模板片段。
- [ ] **DUP-07 secrets 加密整表双实现 + 退化回退复活了已修掉的病灶**
  `encryptMachineAll/decryptMachineAll`（AES-GCM）与 `encryptAll/decryptAll`（DPAPI）同构 ×2，`loadFileSecrets`/`writeFileSecrets` 的 CAN_DPAPI/CAN_MACH 分支近重复；且 DPAPI 批量失败回退（236-239、256-258）逐条重 spawn PowerShell——正是 137-139 注释说已修掉的病理（关联 PERF-15）。修：抽 `{ prefix, encryptTable, decryptTable }` cipher 描述符一次选定。
- [ ] **DUP-08 `cmdGatewayLog`（gatewaycmd.ts:251-315）三份 JSON 行解析**
  readAll、follow 循环、print 各自"读文件→分行→JSON.parse try/catch"，`[todayFile(), yesterdayFile()]` 双算。修：一个 `readLogLines(sinceMap)` 两路复用。
- [ ] **DUP-09 `daytype.ts:28-53` vs `67-93` 双 loader 同脚手架**
  statSync→mtime memo→readFile→parse 两份、memo 变量各自独立——失效逻辑改一处即静默失步（且损坏时一个返回空 Map 一个空数组）。修：合并为单个 `{years, days}` loader。
- [ ] **DUP-10 `providers/known.ts:39-127` EXTRA 表与 `presets/data.ts` 模型元数据手工双份**
  glm-5.3、deepseek-v4-*、kimi-k2.7-code 等条目数字完全相同，BY_ID 覆盖令 EXTRA 副本成死重，每次核对预设要人肉同步两处。修：模块初始化时按 preset id 差集推导 EXTRA，只保留真正非预设的变体。

## D. 死代码清单（DEAD-）——可直接删除

- [ ] **DEAD-01 `src/util/fsx.ts`**：`which()`（242-272，全仓零调用，职责已被 `commandOnPathResolved` 覆盖）；`isFile()`（212-218，仅被死的 which 调用）；`closeAppendStreams()`（182-185，关停路径用的是 `drainAppendStreams`，gateway/main.ts:222）。
- [ ] **DEAD-02 `src/config/store.ts:171-172`**：`configLockPath`/`configDir` 导出，注释称"供测试"但 src/test 均无引用。
- [ ] **DEAD-03 `src/gateway/server.ts`**：2470 行 `export { buildRuntime, randomToken }` 无任何消费者；25 行 `displayRouteProvider`、10 行 `saveConfig` 未使用 import；`state.ts:156-161` `_tokenPlaceholder` 参数从未被读。
- [ ] **DEAD-04 `src/adapters/presence.ts:124-130`**：`residueNote()` 零调用（处置见 DUP-03③——优先启用而非删除）。
- [ ] **DEAD-05 `src/import/sources.ts:455-467`**：`normalizeModelIds()` 全仓零调用，注释声称的"存量数据修复"无调用路径。
- [ ] **DEAD-06 `src/adapters/format.ts:88-94`**：`yamlSetText`/`yamlDelete` 是零附加值透传包装（注释保留能力实际来自 `parseDocument`），仅 dsh 使用。修：内联或删除。
- [ ] **DEAD-07 `src/gateway/ui.ts:1363,1480-1481`**：`applyPollTimer` 只被 clear 从未 set（等待循环实为链式 setTimeout，本就无可取消句柄），误导维护者。

## E. 结构与设计（DESIGN-）

- [ ] **DESIGN-01 `handleAdmin` ~1345 行 26 个内联端点（server.ts:992-2336）**＝ backlog C1，此处补两点：`parseClientProfiles` 等函数定义在函数体中部（2017-2024）；`audit`/`src` 闭包应随路由表显式传参。按 C1 路由表化一并处理。
- [ ] **DESIGN-02 三座"全能函数"**：`ops.ts addService` ~200 行混五职责（校验/查重/模型合并/在线拉取/落盘，60-231）；`update/run.ts runUpdate` 127 行、`cli/init.ts cmdInit` 124 行各 6+ 阶段内联。修：按阶段抽 `validateServiceInput` / `resolveServiceModels` / `resolveFallbackChain` 等，cmdInit/runUpdate 同理。
- [ ] **DESIGN-03 `planAttach` 双 240 行深嵌套**：`claude-code.ts:135-375`（双模式×模型恢复×picker 烘焙×接管交织）、`dsh.ts:322-562`（legacy/patch 布局+创建回退+凭据+目录合并在一体）。修：按 concern 抽 `bakeModelPicker()` / `dshEnsureProviderEntry()` 等步骤函数。DRIFT-01/BUG-01 动手时应顺路拆。
- [ ] **DESIGN-04 `cloud/server.ts:89-358` handle() 270 行 if 链**：8 端点各重复角色守卫与 `JSON.parse(bodyText||'{}')` 样板。修：路由表 `{ method, pattern, role, handler }` + 守卫/解析上提。
- [ ] **DESIGN-05 反向依赖：`src/providers/fetch.ts:4` import `gateway/proxy.js`**，而 gateway/server.ts:24 又 import providers/fetch——互相够。`buildDispatcher` 本是无状态 undici 纯函数。修：挪 `util/net.ts` 双向引用它。
- [ ] **DESIGN-06 `cloud/main.ts:22` 数据目录 `process.env.HOME ?? '.'`**：Windows 上 HOME 未设 → 静默写进 CWD 相对目录，绕过 paths.ts 约定；同文件 `resolveConsoleToken` 手写 tmp+rename 不走 `atomicWrite`。修：走 `homeDir()`/paths.ts + `atomicWrite(..., 0o600)`。
- [ ] **DESIGN-07 i18n 违规三组**：① `adapters/packs.ts:149-151` `FileChange.note` 裸英文 `'adapter pack upsert'` 绕过 t()；② 中文顿号 `'、'` 直接插值进英文文案 ×8（dsh.ts:144,308,519,525、zcode.ts:166、workbuddy.ts:306、mimo-desktop.ts:66、presence.ts:128；provider-json.ts:57 还有第三种 `' / '` 变体）→ 统一 `biJoin('、', ', ', list)`（server.ts:1302 已有正确用法）；③ `server.ts:345-363` pickerSyncTimer 审计手写双语字符串绕过 `bi()`，未来改文案必漏一种语言。
- [ ] **DESIGN-08 硬编码 `~/.modeldock` 用户文案 ×2**：`ui.ts:1473`（更新失败提示查 `~/.modeldock/logs/`）与 `webupdate.ts:222`（同款）——`MODELRDOCK_HOME`/dev 沙箱下误导。修：`displayPath(logsDir())` 插值（ui 端可仿 `__MD_…__` 服务端替换或 overview 加字段）。
- [ ] **DESIGN-09 `holidays.ts:120-132` 用 t() 字符串当控制流哨兵**：`lastErr === t('公告尚未发布', …)` 比较依赖两次 t() 逐字节一致——改文案/语言即碎。修：改布尔/类型化标志。
- [ ] **DESIGN-10 `server.ts:1251-1255` `knownFallback()` 定义在服务于它的 `return` 之后**：靠函数提升侥幸工作，重构早退分支极易弄坏。修：声明上移。
- [ ] **DESIGN-11 `install/noderuntime.ts:181,211,284` 共享 `.stage-${process.pid}` 暂存目录**：同进程并发 `ensureNodeRuntime` 互踩（一方 rm/rename 毁另一方）；inner 目录名字符串两处独立拼接。修：stage 目录按资产名派生（`${asset}.stage`）或 mkdtemp；导出唯一 `nodeInnerDirName(version)`。
- [ ] **DESIGN-12 `gatewaycmd.ts:92-128` SIGKILL 分支静默收场**（关联 XPLAT-02）：kill 后不复核 `gatewayLive()`、无成败输出。修：与 SIGTERM 分支同款复 poll + "✓ 已停止"/失败提示。
- [ ] **DESIGN-13 `cli.ts:121` 30s 竞速 vs 无时限 osascript 提权弹窗**：用户弹窗挂超 30s 后 GUI 退出而 `osaAdminRun` 孤儿续跑、结果写进死控制台。修：给 `ensureCliInstalled` 传 AbortSignal/共享 deadline，日志回调加取消标记。

## F. 建议处理顺序

1. **第一批（正确性，全是局部小修）**：BUG-01（含回归测试）→ BUG-02/03/11（三处 error 监听，一次过）→ BUG-04（TTL 对齐）→ BUG-05～BUG-14 按顺手程度清。
2. **第二批（去重收敛，消除漂移源）**：DUP-01/02（cli/shared.ts + update/transfer.ts）→ DRIFT-01/02/03（双实现合并，DRIFT-01 优先——用户可见行为不一致）→ DUP-03～10。
3. **第三批（结构重构，行为零变化）**：DESIGN-01（=backlog C1）与 DESIGN-02/03/04 拆函数；DEAD-01～07 顺手全删；DESIGN-05～13 穿插在相关文件被触碰时做。
4. 每批交付跑全量 `npm test`；涉及 Windows 分支的（DUP-01 killByPid、DESIGN-06、BUG-03）过一遍三平台自检清单。
