# 已知问题清单（2026-10-11 全仓代码审查）

> 来源：2026-10-11 四分区静态审查（网关热路径 / 配置持久层 / 适配器与 CLI / 预设与 Web 服务），关键结论经人工到源码复核。
> 用途：给后续 agent 与开发者留底——当前已确认的性能、跨平台与正确性问题。**动手前先读本页，避免重复审查与踩已知坑。**
> 维护约定：
> 1. 修复某项后**回到本文档勾选该项并标注日期与 commit**，不要直接删条目。
> 2. 文中行号基于审查当日代码（develop@86b23bd 附近），动手前先读对应源码确认仍然成立。
> 3. 标注（推测）的条目是静态推演结论，未经实测基准；实施前先量化验证。
> 4. 与 `docs/backlog.md`（2026-10-07 热路径评审 B/C 级遗留）少量重叠：backlog 的 **B4 ≈ PERF-17**、**C2 与 PERF-06/07/09 同域**、**B2/B3 仍开放**（本页未重复收录），实施时可合并处理。
>
> 2026-10-12 批量修复：PERF-01/04/05/06/07/08/09/10/11/12/17、CORRECT-01、XPLAT-01/03/04/05/07/08/10 共 19 项已修（commit 见总览表），全部经 orchestrator 自治闭环（独立测试门禁 + LLM 审查 + 人工闸门复核 diff），合并后 develop 全量 691 例绿。
> 严重度定义：**P0** = 热路径/启动的真实性能损害或功能破损，优先修；**P1** = 明显浪费、周期性阻塞或正确性隐患；**P2** = 轻微、低频或纵深防御项。

## 总览

| 编号 | 级别 | 位置 | 一句话 | 状态 |
|---|---|---|---|---|
| PERF-01 | **P0** | `src/gateway/relay.ts:298-308` | 配 default_model 时每请求全量 JSON.parse 请求体，即使无需改写 | ☑ 已修（2026-10-12 @6fd71fa） |
| PERF-02 | P2 | `src/gateway/state.ts:285` | dayFilter 窗口每请求 1 次 statSync | ☐ 未修 |
| PERF-03 | P1 | `src/cli/index.ts:1-14` | CLI 任何命令静态加载 823KB catalog snapshot | ☐ 未修 |
| PERF-04 | P1 | `src/cli/diag.ts:1,6` | undici + gateway/proxy 进全命令启动链 | ☑ 已修（2026-10-12 @20f6b1c） |
| PERF-05 | P1 | `src/adapters/engine.ts:1` | @inquirer 白白进网关常驻进程 | ☑ 已修（2026-10-12 @20f6b1c） |
| PERF-06 | P1 | `src/gateway/server.ts:757-758` | overview 重建串行 await 9 个适配器 status | ☑ 已修（2026-10-12 @e9788a0） |
| PERF-07 | P1 | `src/util/fsx.ts:46-97` | commandOnPathResolved 无 memo，每轮数百次同步 fs | ☑ 已修（2026-10-12 @54e01c3） |
| PERF-08 | P1 | `src/adapters/presence.ts:62` | Windows reg /s 全树查询 8s 超时，首建可秒级 | ☑ 已修（2026-10-12 @54e01c3） |
| PERF-09 | P2 | `src/gateway/server.ts:1197-1200` | overview 缓存命中仍整包 JSON.stringify | ☑ 已修（2026-10-12 @e9788a0） |
| PERF-10 | P2 | `src/gateway/server.ts:1065-1066` | 控制台页 236KB 无 ETag/304/gzip | ☑ 已修（2026-10-12 @e9788a0，浏览器侧 @328e79a） |
| PERF-11 | P2 | `src/gateway/lan.ts:1041,1047` | PWA 图标 no-store 每次重下 | ☑ 已修（2026-10-12 @e9788a0） |
| PERF-12 | P1 | `src/sync/crypto.ts:150,175` | openEnvelope 双重 PBKDF2（600k×2）阻塞事件循环 | ☑ 已修（2026-10-12 @0caad3a） |
| PERF-13 | P2 | `src/providers/catalog.ts:109-140` | catalogBase 每次 merge+sort+statSync，每模型 3 次调用 | ☐ 未修 |
| PERF-14 | P2 | `src/config/store.ts:160-163` | mutateConfig 无变化也全量重写；路由变更放大 K+1 次 | ☐ 未修 |
| PERF-15 | P2 | `src/config/secrets.ts:310-313` | 改一个 key 全表重加密；win32 setSecret spawn PowerShell | ☐ 未修 |
| PERF-16 | P2 | `src/gateway/state.ts:614,625` | 请求/审计 JSONL 无轮转，磁盘无界增长 | ☐ 未修 |
| PERF-17 | P2 | `src/gateway/state.ts:130` | reload 不 close() 旧 ProxyAgent（≈backlog B4） | ☑ 已修（2026-10-12 @2a0c5c9） |
| XPLAT-01 | P2 | `src/util/fsx.ts:120-131` | atomicWrite 重试白名单缺 EBUSY | ☑ 已修（2026-10-12 @54e01c3） |
| XPLAT-02 | P2 | `src/cli/gatewaycmd.ts:110,123` | Windows stop 硬杀，优雅清理永不执行 | ☐ 未修 |
| XPLAT-03 | P2 | `src/util/paths.ts:38` | displayPath 在 Windows 永不缩写 ~ | ☑ 已修（2026-10-12 @0caad3a） |
| XPLAT-04 | P2 | `src/config/secrets.ts:119` | darwin keychain 经 argv 传密钥，ps 可见 | ☑ 已修（2026-10-12 @2a0c5c9） |
| XPLAT-05 | P2 | `src/cli/basic.ts:44` | config edit 引号只处理空白，cmd 元字符截断（推测） | ☑ 已修（2026-10-12 @0caad3a） |
| XPLAT-06 | P2 | `src/autostart.ts:36-39` | Windows VBS 自启长期弃用风险 | ☐ 未修 |
| XPLAT-07 | P2 | `src/adapters/codex.ts:69` | bootstrap.path 顶层求值，违反惰性约定 | ☑ 已修（2026-10-12 @0caad3a） |
| XPLAT-08 | P2 | `src/adapters/dsh.ts:236` | label 写死中文未走 t() | ☑ 已修（2026-10-12 @0caad3a） |
| XPLAT-09 | P2 | `src/adapters/format.ts:52-61` | JSONC 剥注释不支持尾逗号（设计取舍） | ☐ 未修 |
| XPLAT-10 | P2 | `src/update/check.ts:224` | 更新资产名未校验（供应链纵深防御） | ☑ 已修（2026-10-12 @0caad3a） |
| XPLAT-11 | P2 | `src/util/color.ts` | 老 conhost ANSI 无检测（推测） | ☐ 未修 |
| CORRECT-01 | **P1** | `src/config/secrets.ts:267` | secrets 缓存永不失效：跨进程改 key 网关发旧 key 直到重启 | ☑ 已修（2026-10-12 @2a0c5c9） |
| CORRECT-02 | P2 | `src/backup/snapshot.ts:154-158` | 孤儿清理删他进程半成品快照 → 偶发假失败 | ☐ 未修 |
| CORRECT-03 | P2 | `src/config/store.ts`（saveConfig） | config.toml 无写前快照，与「写前自动快照」承诺有边界差 | ☐ 未修 |
| CORRECT-04 | P2 | `src/gateway/state.ts`（activeScheduleWindow） | 定时窗口在每日 00:00:00 前后数秒疑似被误判不活跃（实测一次全量 5 例红，根因未查） | ☐ 未修 |

---

## 一、性能问题

### A. 转发热路径（每请求都走，用户最敏感）

**PERF-01（P0）请求体全量 JSON.parse**
- 位置：`src/gateway/relay.ts:298-308`（`rewriteModel`）
- 现状：透传快路径条件为 `!modelOverride && !default_model && 无 aliases && 非 anthropic. 前缀`。**`default_model` 是配服务时的常规操作**，一配就走 `JSON.parse(body.toString('utf8'))` 全量解析；而大量请求最终 `final === wire`（模型名无需改写，网关只注入 key），解析纯属浪费。
- 影响：Claude Code/ZCode 长上下文请求体常达 0.5–10MB，每请求 5–100ms（推测）事件循环阻塞，串行化同实例所有并发流（含正在推流的 SSE）。
- 修复方向（已人工复核可行）：`topLevelModel` 扫描结果 `pre` 非 null 时，modelOverride / aliases 匹配 / tierFallback（CLAUDE_BUILTIN_RE）/ anthropic. 剥壳 / default_model 兜底的**全部判定只用模型名字符串即可完成**；仅当 `final !== wire` 确需改写时才 parse + 重序列化。`pre === null`（扫描器放弃）再退回现有全量解析路径，逻辑与现路径逐字节等价。
- 验证：用大请求体（≥5MB）压测对比 p99；回归 gateway 套件的 rewriteModel 用例。

**PERF-02（P2）dayFilter 每请求 statSync**
- 位置：`src/gateway/state.ts:285` → `src/gateway/daytype.ts:33`
- 现状：仅「配了定时切换 + dayFilter」的部署命中；mtime memo 免了读文件、免不了每请求 1 次 stat。
- 修复方向：窗口匹配结果按分钟级时间戳缓存进 rt。

其余热路径项已核查**无问题**（勿重复审查）：config/tokens/provider 全内存；getSecret 命中 fileCache/externalCache 零落盘；SSE 经 `pipeline(上游body → usageTap → res)` 逐块透传、backpressure 正确、无整体缓冲；undici `request` + 缓存 dispatcher（direct 模块级单例 Agent，keepAliveTimeout 55s；headersTimeout 60s 可配 / bodyTimeout 10min），连接类错误重试 1 次；usage tap 以 `includes('usage')` 预过滤跳过 95%+ 的 SSE 行解析；请求日志走常驻 WriteStream（`util/fsx.ts:162-179` appendLine 流池）无逐条 open/fsync；鉴权 `Map.get` O(1) + admin token sha256 + `timingSafeEqual`；glob 正则按 pattern 缓存；路由分发为字符串前缀线性链（~30 个，纳秒级）；内存无只增不减结构（ring≤500、appendStreams LRU≤8、syncTickets TTL 清扫等）。

### B. 启动成本（每次 CLI 调用 / SEA 冷启都付）

**PERF-03（P1）catalog snapshot 进全部 CLI 启动链**
- 位置：`src/cli/index.ts:1-14`（12 个命令模块全静态 import）→ `cli/providers.ts` → `providers/catalog.ts:6`（唯一 importer）→ `providers/catalog-snapshot.generated.ts`（33896 行 / 823KB，226 厂商 8000+ 模型）；第二进链点：`adapters/dsh.ts:19` → `providers/resolve.ts:3` → catalog（网关启动 / 触达 adapter registry 的命令同样背负）。
- 影响：任何 CLI 命令（含 `--help`、`gateway stop`）都解析 823KB 对象字面量；推测 V8 解析+物化 20–50ms、堆 6–12MB；SEA 二进制无 code cache 每次全付。网关常驻进程只付一次，影响小。
- 修复方向：命令模块下沉到 commander action 内 `await import()`；`catalog-snapshot.generated.ts` 改懒 `import()`（或拆 catalog-lazy 模块），仅 `refreshCatalog` / `catalogModelMeta` 真正触达。
- 2026-10-12 核查：属实（实测 33896 行 / 772KB，命令模块 10 个）。纯懒 `import()` 需把同步触达点（`resolveModelMeta` 等 15+ 调用点）整体 async 化，SEA 下 createRequire 同步方案另有打包约束——**暂缓，待专项设计**。
- 验证：`node --cpu-prof` 或简单计时对比 `modeldock --help` 冷启耗时；注意 vitest 隔离模型（跨文件 mock 雷区，见 AGENTS.md）。

**PERF-04（P1）diag.ts 把 undici 与 gateway/proxy 拉进启动链**
- 位置：`src/cli/diag.ts:1,6`（`import { request } from 'undici'`、`import { buildDispatcher } from '../gateway/proxy.js'`）
- 现状：diag.ts 被 `cli/index.ts:9` 静态 import，任何命令都加载 undici 与网关代理模块；仅 `cmdDoctor` 用，Node≥22 有内建 fetch 可替代。
- 修复方向：改 cmdDoctor action 内动态 import。

**PERF-05（P1）@inquirer 进网关常驻进程**
- 位置：`src/adapters/engine.ts:1`（顶层 `import { confirm } from '@inquirer/prompts'`）
- 现状：`server.ts` 引 engine 且全部以 `yes:true` 调用，交互确认在网关进程内永不使用。
- 修复方向：confirm 按需 import（或 CLI 侧传入确认函数）。

### C. 控制台轮询（overview/health/logs 三路 5s 轮询，压在与转发共用的事件循环上）

**PERF-06（P1）overview 重建串行跑适配器 status**
- 位置：`src/gateway/server.ts:757-758`（`for (const a of allAdapters(cfg)) { await a.status(cfg, port) }`）；`/config` 同病（`buildConfigView`，server.ts:649-651）。
- 修复方向：`Promise.all` 并行（status 各自独立）。

**PERF-07（P1）同步 PATH 扫描无 memo**
- 位置：`src/util/fsx.ts:46-97`（`commandOnPathResolved`：existsSync+statSync 逐目录逐后缀，另 readdirSync runtime/nvm 目录）
- 现状：被 claude-code.ts:46、codex.ts:22、provider-json.ts:77 的 `present()` 在每次 detect/status 调用；overview 每 5s 重建 → 10 适配器 × 数十次同步 stat ≈ 数百 syscall/轮（Windows 更重）。桌面客户端的注册表查询反而有 60s memo（presence.ts REG_TTL），这个更便宜的扫描没有任何 memo。
- 修复方向：presence 结果按 cmd 做 TTL memo（30–60s，与 regMemo 对齐；命令安装是低频事件）。

**PERF-08（P1）Windows 注册表全树查询首建慢**
- 位置：`src/adapters/presence.ts:62`（`reg query <key> /s /f <appName> /d`，超时 8000ms）
- 现状：未命中时每应用最多 3 个注册表视图串行 × 8s 超时（workbuddy 双名共 6 次）；`regMemo` 60s 只压后续轮询、压不住首建，worst case 秒级甚至更慢（推测，取决于机器）。
- 修复方向：三视图查询并行化（Promise.all）；或改定点 `reg query <key>\<AppName>` 探测；dirHasEntry 结果也加 TTL。
- 2026-10-12 核查修正：regMemo 对 miss 也无条件缓存 60s，「每轮询都重扫」不成立，实际最坏每应用每 60s 一轮 3×8s，严重度低于原文；已按三视图并行化修复（54e01c3）。

**PERF-09（P2）overview 缓存命中仍重序列化**
- 位置：`src/gateway/server.ts:1197-1200`：命中分支 `res.end(JSON.stringify(cached.data))`，view 含全部服务/客户端/预设/knownModels（几十–几百 KB），每 5s 重复一次。
- 修复方向：缓存序列化后的字符串（失效时才重序列化）。
- 2026-10-12 核查修正：TTL 实为 2s（`OVERVIEW_TTL_MS = 2_000`）非 5s，重序列化比原文描述更频繁；已修（e9788a0）。

**PERF-10（P2）控制台页无缓存头**
- 位置：`src/gateway/server.ts:1065-1066`：每请求 `UI_HTML.replaceAll(...)` 后整包 ~236KB 明文返回，无 ETag/304/Cache-Control/gzip。页面低频加载，影响小；局域网/移动端收益明显。
- 修复方向：加 ETag（内容 hash）+ If-None-Match→304；可预压一份 gzip Buffer 按 Accept-Encoding 发。
- 2026-10-12 核查与修复补充：admin 面本有统一 `no-store`（server.ts 约 :1005），原文「无缓存头」不准（等效每次整包 200）；e9788a0 加 ETag/304 + 渲染缓存，但浏览器在 no-store 下不存响应、条件请求不生效；328e79a 将 HTML 页 200 覆盖为 `no-cache`（可存储但必须重验证）后浏览器侧 304 真正生效，JSON API 的 no-store 未动。

**PERF-11（P2）PWA 图标 no-store**
- 位置：`src/gateway/lan.ts:1041,1047`：192/512 PNG 每次重新下载。改 `cache-control: immutable` 长缓存。

### D. 用户动作触发的重操作（低频但值得优化）

**PERF-12（P1）openEnvelope 双重 PBKDF2**
- 位置：`src/sync/crypto.ts:150`（`deriveKeys` → `pbkdf2Sync(passphrase, salt, 600_000, 32, 'sha256')`）+ `crypto.ts:175` → `crypto.ts:126`（`verifyEnvelopeHmac` 用 passphrase **再次** deriveKeys 同参重算；它本可复用已派生的 `macKey`，`verifyHmacWithKeys` 就是为这设计的）。
- 影响：LAN/控制台导入（lan.ts:999）在网关进程内执行，每次导入事件循环阻塞约 2×250–500ms（推测），期间所有转发请求停摆。`createSyncOffer`/export（lan.ts:199,963 → sealEnvelope）同型单次阻塞。
- 修复方向：`verifyEnvelopeHmac` 复用 macKey（一行改动）；长期把 KDF 换异步 `crypto.pbkdf2`。其余场景（engine/setup）均走缓存密钥 `sealWithKeys/openWithKeys`，健康。

**PERF-13（P2）catalogBase 每调用全价**
- 位置：`src/providers/catalog.ts:109-113`（每次调用全量浅拷贝 merge ~450 项）+ `catalog.ts:140`（每次 `Object.keys().sort()` 226 键）+ `catalog.ts:86`（每次 statSync，mtime memo 只免 JSON.parse）。
- 调用点：`server.ts:675-678, 746-749`（**每个模型 3 次** resolveModelMeta：ctx/out/caps）、server.ts:1236/1790、lan.ts:309。`/_modeldock/config` 无缓存，打开编辑层 = 模型数×3 次全价。
- 修复方向：① 三处调用点取一次存局部变量；② catalogBase 按 mtime memo（照抄 daytype.ts `loadCalendar` 写法）；③ 排序键预计算。

**PERF-14（P2）mutateConfig 无条件重写 + 放大效应**
- 位置：`src/config/store.ts:160-163`（fn 无改动也 `saveConfig`：全量 stringify + fsync + rename）；`src/ops.ts:352-355`（refreshBakedModelClients 循环内**每客户端各一次** mutateConfig，只为更新 entry.files）；`src/ops.ts:374-383`（ensureProfileForProvider 命中已有 profile 时 no-op 也全量重写一次）。
- 影响：一次路由变更（手动切换/定时窗口接管/手机端应用）放大为 K+1 次全量 TOML 重写；每次重写还经 fs.watch 触发 reloadRuntime 再全量解析（与主动 reload 叠加，一次保存重载两代）。**不在每请求路径上**（pickerSync 定时器 5s 一跳但路由未变零 I/O）。
- 修复方向：mutateConfig 比较 stringify 结果未变则跳过写；refreshBakedModelClients 合并循环内 K 次为一次。

**PERF-15（P2）secrets 单 key 修改 O(N)**
- 位置：`src/config/secrets.ts:310-313`（writeFileSecrets 对全部条目重新加密）；win32 每次 setSecret/deleteSecret spawn 一次 PowerShell 批处理（~1s 级，冷启动首请求延迟尖峰，之后有缓存）。
- 另注意：`secrets.ts:287,298` 首次加载遇存量明文会在**读路径**自动改写 secrets.json（一次性迁移，行为正确但属"读触发写"）。
- 修复方向：增量加密单条目；或至少注释说明成本模型。

### E. 内存与磁盘增长

**PERF-16（P2）JSONL 日志无轮转**
- 位置：`src/gateway/state.ts:614`（`gateway-YYYY-MM-DD.jsonl`）、`:625`（audit 同款）。写盘本身健康（常驻流池、无逐条 fsync、错误 ring≤500），但按天落盘**永不清理**，磁盘无界增长。
- 修复方向：启动/每日惰性清理 N 天前日志。

**PERF-17（P2）reload 不关旧 ProxyAgent（≈backlog B4）**
- 位置：`src/gateway/state.ts:130`（`rt.dispatchers.clear()` 不调 close，旧连接池靠 keepAlive 空闲超时自然收尾；direct 单例不受影响，非无界泄漏）。
- 修复方向：clear 前对非 direct 的 dispatcher 逐个 `close()`。

---

## 二、跨平台兼容问题（Linux / Windows / macOS）

> 未发现 P0 级跨平台破损。以下按影响排序。修复时遵循 AGENTS.md「工程硬性约定」三平台清单。

**XPLAT-01（P2）atomicWrite 重试白名单缺 EBUSY**
- 位置：`src/util/fsx.ts:120-131`：`code !== 'EPERM' && code !== 'EACCES'` 即抛。libuv 把 `ERROR_SHARING_VIOLATION`（目标被无共享删除位的句柄占用：杀毒/编辑器/备份扫描）映射为 **EBUSY**，不重试直接失败并删 tmp。两个独立审查线一致发现。
- 影响场景：适配器写客户端配置（如 zcode 轮询热读的 provider_config.json）恰逢客户端独占打开时一次即失败（engine 有快照兜底不致损坏，但 attach 中止）。
- 修复方向：EBUSY 加入重试码。

**XPLAT-02（P2）Windows 下 gateway stop 永不走优雅清理**
- 位置：`src/cli/gatewaycmd.ts:110,123`：Windows 上 `process.kill(pid, 'SIGTERM'/'SIGKILL')` 都是 TerminateProcess；`src/gateway/main.ts:223-236` 的 cleanup（drainAppendStreams / server.close / stopSyncEngine）在 unix 才走得到。
- 影响：常驻日志流最多 16KB/流缓冲未刷盘即丢（推测每次 stop 丢尾部若干行）；sync 引擎不做停机收敛。网关无子进程树，无需 taskkill /T。
- 修复方向：Windows 下先用 CTRL_BREAK（GenerateConsoleCtrlEvent）尝试优雅（推测，收益有限），或缩短日志流缓冲/关停前主动 flush。

**XPLAT-03（P2）displayPath 在 Windows 永不缩写 ~**
- 位置：`src/util/paths.ts:38`：`p.startsWith(realHome + '/')` —— Windows 下 path.join 产出 `\` 分隔，子路径永不匹配（`p === realHome` 仍命中）。修：匹配 `[\\/]`。

**XPLAT-04（P2）darwin keychain 经 argv 传密钥**
- 位置：`src/config/secrets.ts:119`：`security add-generic-password -w <value> -U`，密钥短暂出现在进程列表（同用户本机 `ps` 可见）；win DPAPI / linux secret-tool 均走 stdin，唯 darwin 例外。
- 修复方向：改 `security -i` 交互模式或 `-X` hex 文件方式走 stdin。

**XPLAT-05（P2，推测）config edit 的 cmd 元字符**
- 位置：`src/cli/basic.ts:44`：`/\s/.test(s) ? '"'+s+'"' : s` 只对含空白参数加引号；路径含 `&`/`^` 但无空格时（如 Windows 用户名 `A&B`，罕见）经 `spawnSync(shell:true)` 会被 cmd 截断。方向：始终加引号。

**XPLAT-06（P2）Windows 自启用 VBS，长期有弃用风险**
- 位置：`src/autostart.ts:36-39,166-171`：`%APPDATA%\...\Startup\modeldock-gateway.vbs` + WScript.Shell.Run。实现本身正确（隐藏窗口、argv base64 落档、卸载对称），但 Microsoft 正把 VBScript 转 Feature-on-Demand（Win11 24H2 起可移除，推测未来默认关闭），部分企业策略禁 Startup VBS。
- 备选：注册表 Run 键或 schtasks（后者才有崩溃拉起）。现状注释已如实标注"无崩溃拉起"，属信息项，择机迁移。

**XPLAT-07（P2）codex.ts bootstrap.path 顶层求值**
- 位置：`src/adapters/codex.ts:69`：`bootstrap: { path: configFile(), content: '' }` 模块加载即求值——是全部适配器中唯一违例（claude-code.ts:99、dsh.ts:254、opencode.ts:24、mimo-code.ts:55 均传函数；types.ts:91 明文约定惰性求值）。
- 影响：仅测试 / FAKE_HOME 场景下 bootstrap 落点固化到真机 home。改传 `path: configFile`。

**XPLAT-08（P2）dsh label 写死中文**
- 位置：`src/adapters/dsh.ts:236`：`label: 'dsh（DeepSeek Harness）'`——scope 内唯一静态中文 label（其余适配器都用 getter + t()）。英文界面显示中文。改 getter。

**XPLAT-09（P2，设计取舍）JSONC 剥注释不支持尾逗号**
- 位置：`src/adapters/format.ts:52-61`：行注释剥离会连换行吃掉（对 JSON 合法性无害）；带尾逗号的 JSONC 会在 parseJsonTolerant 判负 → attach 中止并给可操作报错。比同类工具严格，行为可接受，注明留档。

**XPLAT-10（P2）更新资产名未校验**
- 位置：`src/update/check.ts:224`：`path.join(destDir, asset.name)`，`asset.name` 来自 GitHub Releases 元数据，未做 basename/`[\\/]`/`..` 校验。信任根是本仓库 release，属供应链纵深防御项：拒绝含分隔符与 `..` 的资产名。

**XPLAT-11（P2，推测）老 conhost ANSI**
- 位置：`src/util/color.ts`：NO_COLOR 与 isTTY 均支持，但未做 Windows 版本/conhost 的 ANSI 能力检测。Win10+ 与 Windows Terminal 正常；项目实际门槛 Win10+ 时无碍。

**已核查无问题的跨平台项（勿重复审查）**：181 条相对 import 大小写逐一比对 0 错误；路径拼接全走 path.join、无手写分隔符拼文件路径；`taskkill /T /F`（update/install.ts:76）正确；进程枚举 PowerShell CIM 分支（gatewaycmd.ts listProcessLines 参考写法）；reg 查询三视图（HKCU/HKLM/WOW6432）实现正确；三平台自启齐全（launchd KeepAlive / systemd Restart+linger / VBS）且卸载对称；dsh/zcode YAML 走 Document API 保注释；全 src 无 `import.meta`（SEA 约定未破坏）；同步 spawnSync 类调用严格限 CLI 进程，网关进程内无同步阻塞 spawn。

---

## 三、正确性侧记（非性能，但建议一并修）

**CORRECT-01（P1）secrets 缓存永不失效：跨进程改 key 网关发旧 key**
- 位置：`src/config/secrets.ts:267,271`（`fileCache` 一经加载永不再读盘）、`:92-97`（externalCache 同）；`src/gateway/state.ts:125-131` reloadRuntime 只重载 config/tokens 不清这两个缓存；`src/gateway/main.ts:196-198` 的 watcher 对 secrets.json 与 config.toml 走同一个 scheduleReload，但回调不区分文件。
- 影响：CLI `provider set-key` / 导入 / 另一实例改 key 后，运行中网关持续用旧 key（`relay.ts:340` 每请求经缓存取）→ 上游 401，用户视角"改了没生效"，直到重启。
- 修复方向：secrets.ts 导出 `invalidateSecretsCache()`（清 fileCache+externalCache），watcher 识别到 secrets.json 变化时调用；或 loadFileSecrets 做 mtime 复核。
- 连带问题：secrets.json 读-改-写**没有跨进程锁**（config.toml 有两层防护，secrets 没有），CLI 与网关并发 setSecret → 整表覆盖丢更新。建议与缓存失效一并补轻量锁。
- 2026-10-12 已修（2a0c5c9）：`invalidateSecretsCache()` + reloadRuntime 接线；externalCache 加 60s TTL 兜底 keychain 跨进程改动；darwin keychain 改 `security -i` stdin（XPLAT-04 同 commit）。**连带的跨进程轻量锁未实施，仍开放。**

**CORRECT-02（P2）快照孤儿清理删他进程半成品**
- 位置：`src/backup/snapshot.ts:154-158`：`valid` 集合 = 有合法 manifest 的目录，其余 `rm -rf`。跨进程并发（网关 pickerSync/attach 与 CLI 同时写）时，对方"文件已拷、manifest 未写"的半成品被整体删除 → 对方 applyChanges 在写客户端文件前抛错。后果是偶发假失败（写操作安全中止），无数据损坏。
- 顺带：`snapshot.ts:48-55` 的 id 冲突重试是死代码——`mkdir(recursive:true)` 对已存在目录不抛错，真撞 id 会静默共用目录互踩（概率≈0）。

**CORRECT-04（P2，2026-10-12 新增）定时窗口午夜边界闪烁**
- 现象：00:00:08 前后跑全量测试，「窗口接管重写 picker」「pickTarget 顺延到窗口目标」「displayRouteProvider prefer 窗口接管」等 5 例失败（窗口 `00:00–23:59` 被判不活跃）；23:50 与 00:03 复测同组全绿。与当日合入的改动无交集（失败用例涉及 schedule/pickTarget，同批合并改的是 relay/secrets/fsx/server 轮询）。
- 推测（未定位）：activeScheduleWindow 对「恰在窗口起点 00:00:00」的判定存在边界差（如按起始日归属/闭区间端点），或测试窗口取整分钟与真实秒级时刻的组合竞态。每日只在午夜±数秒窗口内可复现，复现成本高。
- 方向：为 activeScheduleWindow 补「now=窗口起止端点」的确定性单测（注入时钟），定位后修复。

**CORRECT-03（P2）config.toml 无写前快照**
- 现状：全仓快照仅 4 处调用（engine.ts / ops.ts:749 / cli/harness.ts / sync/collect.ts），均针对客户端文件与 sync 导入前；config.toml 直写无快照，写坏（如 migrate/stringify 缺陷）无 undo。推测有意取舍（config 有 .lock + 原子写）。建议至少在 AGENTS.md 澄清边界，或对 migrate 类大改前补快照。

---

## 四、已核查无问题项汇总（后续审查可跳过）

- **presets/data.ts**：label/vendor 全 getter 懒求值 t() 合规；顶层一次 readFileSync(presets.json) 每进程一次可接受。
- **holidays/daytype**：mtime memo；自动拉取启动 90s 后首查 + 每 24h，未配 schedule 直接跳过。
- **update 全链路**：24h TTL + 启动 fire-and-forget + `MODELRDOCK_DISABLE_UPDATE_CHECK` 开关；手动流式下载带背压 + SHA256 强校验；超时分级合理；平台分支齐备。
- **util/i18n**：t() 无查表开销；**全仓库未发现模块顶层直接求值 t() 的违例**。
- **util/diff / jsonpath / glob**：O(n·m) 带 2M 格降级护栏 / 低频 / 正则按 pattern 缓存。
- **cloud/**：IP 限速、5MB body 上限、/v1/doc 304、token 只存 sha256、node:sqlite 单文件。
- **sync/engine**：抖动轮询 + 防抖 watch + 单飞 tick，错误只记 sync.json 不影响网关。
- **路径穿越**：gateway/lan/cloud 全部响应体来自内联常量或 ring buffer，无「请求参数→文件路径」拼接点，无 `../` 逃逸面（唯一例外 XPLAT-10）。
- **install/noderuntime、cliinstall**：平台分支完整，无 unix-only 假设。
- **内存结构**：ring≤500、appendStreams LRU≤8、syncTickets/remoteRequests TTL 清扫、regMemo 60s、pickerSyncStates WeakMap，未发现只增不减。
- **store.ts 写并发**：进程内 promise 串行 + O_EXCL 锁文件 + 15s 陈锁抢占，设计完整。

## 五、建议修复顺序

1. **PERF-01**（P0，体验收益最大；修复等价性已推演，改动集中在 relay.ts）
2. **CORRECT-01** + secrets 轻量锁（改动最小、同时修正确性）
3. **PERF-07 / PERF-06 / PERF-08**（控制台轮询阻塞三件套，presence memo + Promise.all）
4. **PERF-03 / PERF-04 / PERF-05**（启动链减负，注意 vitest 隔离模型回归）
5. **PERF-12**（复用 macKey，一行改动）+ **XPLAT-01**（EBUSY 白名单）
6. 其余 P2 按需排期；与 `docs/backlog.md` 重叠项（B2/B3/B4/C2）合并实施。

> 修复纪律提醒：改 `src/**` 必须全绿 `npm test`；一律走 feature-branch 工作流（`node .agents/scripts/feature-branch.mjs start <task-id>`）；涉及 hot path 的改动用手测沙箱配方验证（`MODELRDOCK_FAKE_HOME` + 189xx，禁碰 8687/8890）。修完回到本页勾选。
