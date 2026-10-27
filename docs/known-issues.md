# 已知问题清单（2026-10-11 全仓代码审查）

> 来源：2026-10-11 四分区静态审查（网关热路径 / 配置持久层 / 适配器与 CLI / 预设与 Web 服务），关键结论经人工到源码复核。
> 用途：给后续 agent 与开发者留底——当前已确认的性能、跨平台与正确性问题。**动手前先读本页，避免重复审查与踩已知坑。**
> 维护约定：
> 1. 修复某项后**回到本文档勾选该项并标注日期与 commit**，不要直接删条目。
> 2. 文中行号基于审查当日代码（develop@86b23bd 附近），动手前先读对应源码确认仍然成立。
> 3. 标注（推测）的条目是静态推演结论，未经实测基准；实施前先量化验证。
> 4. 与 `docs/backlog.md`（2026-10-07 热路径评审 B/C 级遗留）少量重叠：backlog 的 **B4 ≈ PERF-17**、**C2 与 PERF-06/07/09 同域**、**B2/B3 仍开放**（本页未重复收录），实施时可合并处理。
>
> 2026-10-27 六分区全量复审（网关核心 / Web 控制台与 LAN / 配置与工具 / CLI 与更新链 / 适配器与导入 / 云同步）：新增 **REVIEW-01..29**，除 REVIEW-26 按既定语义留档外全部修复（四个 feature 分支合并：fix-review-p1 @a471295、fix-review-p2-web @f60f67a、fix-review-p2-core @e94e0e1、fix-review-p2-data @50ab868）。明细见文末 §六。
>
> 2026-10-28 归档：已闭环的时点记录（release-review-2026-10-12 / test-plan-handoff / web-testing-plan / engine-smoke / redundancy-design）移入 **docs/archive/**，本页与正文中的引用已同步改指新路径。
> 2026-10-12 批量修复：PERF-01/04/05/06/07/08/09/10/11/12/17、CORRECT-01、XPLAT-01/03/04/05/07/08/10 共 19 项已修（commit 见总览表），全部经 orchestrator 自治闭环（独立测试门禁 + LLM 审查 + 人工闸门复核 diff），合并后 develop 全量 691 例绿。
> 2026-10-20 性能复审批量修复：PERF-02 全修、PERF-03/14 部分修（@2540618，切换服务写放大同步收敛）；同日四路并行复审新增 PERF-18..36（P2）留底，见 §一.F。
> 2026-10-20 P2 批量修复：PERF-13/18/19/20/22/24/26/29/30/31/32/33/34/35 共 14 项已修（@ff407bd）；PERF-21/23/25/27/28/36 复核后暂缓（理由见 §一.F 各条注记）。
> 2026-10-26 收口批（perf-residual-cleanup 三卡）：PERF-03 残余懒加载、PERF-14 残余无变化重写、PERF-16 已修（@26bccbb/@01e1a7f/@0b65ace）；余下 PERF-15/21/23/25/27/28/36 维持暂缓（§一.F）。
> 严重度定义：**P0** = 热路径/启动的真实性能损害或功能破损，优先修；**P1** = 明显浪费、周期性阻塞或正确性隐患；**P2** = 轻微、低频或纵深防御项。

## 总览

| 编号 | 级别 | 位置 | 一句话 | 状态 |
|---|---|---|---|---|
| PERF-01 | **P0** | `src/gateway/relay.ts:298-308` | 配 default_model 时每请求全量 JSON.parse 请求体，即使无需改写 | ☑ 已修（2026-10-12 @6fd71fa） |
| PERF-02 | P2 | `src/gateway/state.ts:285` | dayFilter 窗口每请求 1 次 statSync | ☑ 已修（2026-10-20 @2540618） |
| PERF-03 | P1 | `src/cli/index.ts:1-14` | CLI 任何命令静态加载 823KB catalog snapshot | ☑ 已修（2026-10-20 @2540618 命令模块 action 内动态 import + 2026-10-26 @01e1a7f snapshot JSON 字符串懒解析） |
| PERF-04 | P1 | `src/cli/diag.ts:1,6` | undici + gateway/proxy 进全命令启动链 | ☑ 已修（2026-10-12 @20f6b1c） |
| PERF-05 | P1 | `src/adapters/engine.ts:1` | @inquirer 白白进网关常驻进程 | ☑ 已修（2026-10-12 @20f6b1c） |
| PERF-06 | P1 | `src/gateway/server.ts:757-758` | overview 重建串行 await 9 个适配器 status | ☑ 已修（2026-10-12 @e9788a0） |
| PERF-07 | P1 | `src/util/fsx.ts:46-97` | commandOnPathResolved 无 memo，每轮数百次同步 fs | ☑ 已修（2026-10-12 @54e01c3） |
| PERF-08 | P1 | `src/adapters/presence.ts:62` | Windows reg /s 全树查询 8s 超时，首建可秒级 | ☑ 已修（2026-10-12 @54e01c3） |
| PERF-09 | P2 | `src/gateway/server.ts:1197-1200` | overview 缓存命中仍整包 JSON.stringify | ☑ 已修（2026-10-12 @e9788a0） |
| PERF-10 | P2 | `src/gateway/server.ts:1065-1066` | 控制台页 236KB 无 ETag/304/gzip | ☑ 已修（2026-10-12 @e9788a0，浏览器侧 @328e79a） |
| PERF-11 | P2 | `src/gateway/lan.ts:1041,1047` | PWA 图标 no-store 每次重下 | ☑ 已修（2026-10-12 @e9788a0） |
| PERF-12 | P1 | `src/sync/crypto.ts:150,175` | openEnvelope 双重 PBKDF2（600k×2）阻塞事件循环 | ☑ 已修（2026-10-12 @0caad3a） |
| PERF-13 | P2 | `src/providers/catalog.ts:109-140` | catalogBase 每次 merge+sort+statSync，每模型 3 次调用 | ☑ 已修（2026-10-20 @ff407bd） |
| PERF-14 | P2 | `src/config/store.ts:160-163` | mutateConfig 无变化也全量重写；路由变更放大 K+1 次 | ☑ 已修（2026-10-20 @2540618 写合并 + 2026-10-26 @0b65ace 无变化跳写） |
| PERF-15 | P2 | `src/config/secrets.ts:310-313` | 改一个 key 全表重加密；win32 setSecret spawn PowerShell | ☐ 未修（DUP-07 重构已消 win32 逐条 spawn；交互低频路径暂缓） |
| PERF-16 | P2 | `src/gateway/state.ts:614,625` | 请求/审计 JSONL 无轮转，磁盘无界增长 | ☑ 已修（2026-10-26 @26bccbb，gateway.log_retention_days 保留期清理，默认 30） |
| PERF-17 | P2 | `src/gateway/state.ts:130` | reload 不 close() 旧 ProxyAgent（≈backlog B4） | ☑ 已修（2026-10-12 @2a0c5c9） |
| PERF-18 | P2 | `src/gateway/server.ts:629,1108` | admin 鉴权每请求 new RegExp 编译（UI 5s 轮询持续触发） | ☑ 已修（2026-10-20 @ff407bd） |
| PERF-19 | P2 | `src/gateway/server.ts:939-945` | syncTickets/remoteRequests 孤儿条目仅在同类入口懒清扫，无人认领常驻内存 | ☑ 已修（2026-10-20 @ff407bd） |
| PERF-20 | P2 | `src/gateway/state.ts:125-141` | reloadRuntime 不清 rt.health，已删服务的健康条目永久残留 | ☑ 已修（2026-10-20 @ff407bd） |
| PERF-21 | P2 | `src/gateway/server.ts:540` | 请求体全量 buffer 后才转发（改写管线设计前提；GET/DELETE 可跳过） | ☐ 未修（2026-10-20 复核暂缓，见 §一.F） |
| PERF-22 | P2 | `src/gateway/ui.ts:1383` | pollOverview 双 JSON.stringify diff，overview 几百 KB 时每 5s 两次 O(n) 序列化 | ☑ 已修（2026-10-20 @ff407bd） |
| PERF-23 | P2 | `src/gateway/ui.ts:3919,4046` | 编辑弹层/拉取模型一次性渲染全部行，数百模型时数千节点+勾选全表扫描 | ☐ 未修（2026-10-20 复核暂缓，见 §一.F） |
| PERF-24 | P2 | `src/gateway/lan.ts:780` | 手机页 30s 轮询无 document.hidden 门控；页面每请求重拼无 ETag | ☑ 已修（2026-10-20 @ff407bd） |
| PERF-25 | P2 | `src/gateway/ui.ts:8` | 控制台页 304KB 无压缩（内联 JS 含约 29KB 注释）；server.ts:1087 注释「236KB」已过时 | ☐ 未修（2026-10-20 复核暂缓，见 §一.F） |
| PERF-26 | P2 | `src/sync/collect.ts:72-73` | 每次 collect 把 presets.json 读+解析两遍 | ☑ 已修（2026-10-20 @ff407bd） |
| PERF-27 | P2 | `src/sync/engine.ts:116,57` | cloud 每 tick 全量 loadConfig×2；target 每 tick 全量 collect 无 mtime 短路 | ☐ 未修（2026-10-20 复核暂缓，见 §一.F） |
| PERF-28 | P2 | `src/sync/targets/webdav.ts:75-77` | readManifest 每 tick 全量 GET，无 ETag/304（cloud 目标已用） | ☐ 未修（2026-10-20 复核暂缓，见 §一.F） |
| PERF-29 | P2 | `src/providers/fetch.ts:106-157` | 拉取模型无失败负缓存：上游不可达时每次开弹窗重跑候选链（8 端点×15s 串行，最长 60s） | ☑ 已修（2026-10-20 @ff407bd） |
| PERF-30 | P2 | `src/util/fsx.ts:139-141` | fileSha256 整文件读内存（更新包 50–150MB 内存峰值），应流式 hash | ☑ 已修（2026-10-20 @ff407bd） |
| PERF-31 | P2 | `src/install/noderuntime.ts:214` | 1KB 的 SHASUMS256.txt 用 10min 默认超时，连接挂死最坏 20–40min 才切下一源 | ☑ 已修（2026-10-20 @ff407bd） |
| PERF-32 | P2 | `src/import/sources.ts:978-1007` | one-api 分页最多 50 页×15s 串行无整体 deadline，慢站点最坏 ~12min | ☑ 已修（2026-10-20 @ff407bd） |
| PERF-33 | P2 | `src/cli/diag.ts:24,104-108` | cmdStatus/cmdDoctor 对全部 adapter 串行 await status（网关侧已 Promise.all） | ☑ 已修（2026-10-20 @ff407bd） |
| PERF-34 | P2 | `src/adapters/presence.ts:109-111` | Windows desktopPresent 逐 app 串行 registryHas（reg /s 全树扫） | ☑ 已修（2026-10-20 @ff407bd） |
| PERF-35 | P2 | `src/backup/snapshot.ts:156,164` | pruneSnapshots 调 listSnapshots 两次，每次写快照备份目录 manifest 全量读两遍 | ☑ 已修（2026-10-20 @ff407bd） |
| PERF-36 | P2 | `src/ops.ts:830-843` | migrateSecretsToSecure 循环内逐 key mutateConfig 整包写 + 2N 次密钥表写 | ☐ 未修（2026-10-20 复核暂缓，见 §一.F） |
| XPLAT-01 | P2 | `src/util/fsx.ts:120-131` | atomicWrite 重试白名单缺 EBUSY | ☑ 已修（2026-10-12 @54e01c3） |
| XPLAT-02 | P2 | `src/cli/gatewaycmd.ts:110,123` | Windows stop 硬杀，优雅清理永不执行 | ☑ 已修（2026-10-27，appendLine 流池 idle 刷盘兜底，见 §二） |
| XPLAT-03 | P2 | `src/util/paths.ts:38` | displayPath 在 Windows 永不缩写 ~ | ☑ 已修（2026-10-12 @0caad3a） |
| XPLAT-04 | P2 | `src/config/secrets.ts:119` | darwin keychain 经 argv 传密钥，ps 可见 | ☑ 已修（2026-10-12 @2a0c5c9） |
| XPLAT-05 | P2 | `src/cli/basic.ts:44` | config edit 引号只处理空白，cmd 元字符截断（推测） | ☑ 已修（2026-10-12 @0caad3a） |
| XPLAT-06 | P2 | `src/autostart.ts:36-39` | Windows VBS 自启长期弃用风险 | ☑ 已修（2026-10-28，注册表 Run 键 + 自分离隐藏启动，见 §三） |
| XPLAT-07 | P2 | `src/adapters/codex.ts:69` | bootstrap.path 顶层求值，违反惰性约定 | ☑ 已修（2026-10-12 @0caad3a） |
| XPLAT-08 | P2 | `src/adapters/dsh.ts:236` | label 写死中文未走 t() | ☑ 已修（2026-10-12 @0caad3a） |
| XPLAT-09 | P2 | `src/adapters/format.ts:52-61` | JSONC 剥注释不支持尾逗号（设计取舍） | ☐ 未修 |
| XPLAT-10 | P2 | `src/update/check.ts:224` | 更新资产名未校验（供应链纵深防御） | ☑ 已修（2026-10-12 @0caad3a） |
| XPLAT-11 | P2 | `src/util/color.ts` | 老 conhost ANSI 无检测（推测） | ☐ 未修 |
| CORRECT-01 | **P1** | `src/config/secrets.ts:267` | secrets 缓存永不失效：跨进程改 key 网关发旧 key 直到重启 | ☑ 已修（2026-10-12 @2a0c5c9） |
| CORRECT-02 | P2 | `src/backup/snapshot.ts:154-158` | 孤儿清理删他进程半成品快照 → 偶发假失败 | ☑ 已修（2026-10-28，.incomplete 占位 + prune 宽限期，见 §三） |
| CORRECT-03 | P2 | `src/config/store.ts`（saveConfig） | config.toml 无写前快照，与「写前自动快照」承诺有边界差 | ☑ 已修（2026-10-28，版本迁移写盘前快照，见 §三） |
| CORRECT-04 | P2 | `src/gateway/state.ts`（activeScheduleWindow） | 定时窗口在每日 00:00:00 前后数秒疑似被误判不活跃（实测一次全量 5 例红，根因未查） | ☑ 已修（2026-10-12 @85558ca）——根因非午夜边界，是 end 排他在 23:59:00–23:59:59 的「死亡分钟」，见 docs/archive/release-review-2026-10-12.md §五 |
| CORRECT-05 | **P1** | `src/config/secrets.ts` 等 6 处 | dev/测试沙箱（FAKE_HOME）操作外溢生产：reset 删真钥匙环条目、sweep 杀生产网关、自启/CLI 入口被动 | ☑ 已修（2026-10-13 @d6e3a59） |

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
- 2026-10-20 已修（@2540618）：日历挂 rt 30s TTL 缓存，`windowDayMatches` 改 getter 惰性求值——顺带修掉日历作为实参总是求值、days-only 窗口也走 statSync 的问题；日历缓存文件更新最迟 30s 生效（变更极低频，可接受）。

其余热路径项已核查**无问题**（勿重复审查）：config/tokens/provider 全内存；getSecret 命中 fileCache/externalCache 零落盘；SSE 经 `pipeline(上游body → usageTap → res)` 逐块透传、backpressure 正确、无整体缓冲；undici `request` + 缓存 dispatcher（direct 模块级单例 Agent，keepAliveTimeout 55s；headersTimeout 60s 可配 / bodyTimeout 10min），连接类错误重试 1 次；usage tap 以 `includes('usage')` 预过滤跳过 95%+ 的 SSE 行解析；请求日志走常驻 WriteStream（`util/fsx.ts:162-179` appendLine 流池）无逐条 open/fsync；鉴权 `Map.get` O(1) + admin token sha256 + `timingSafeEqual`；glob 正则按 pattern 缓存；路由分发为字符串前缀线性链（~30 个，纳秒级）；内存无只增不减结构（ring≤500、appendStreams LRU≤8、syncTickets TTL 清扫等）。

### B. 启动成本（每次 CLI 调用 / SEA 冷启都付）

**PERF-03（P1）catalog snapshot 进全部 CLI 启动链**
- 位置：`src/cli/index.ts:1-14`（12 个命令模块全静态 import）→ `cli/providers.ts` → `providers/catalog.ts:6`（唯一 importer）→ `providers/catalog-snapshot.generated.ts`（33896 行 / 823KB，226 厂商 8000+ 模型）；第二进链点：`adapters/dsh.ts:19` → `providers/resolve.ts:3` → catalog（网关启动 / 触达 adapter registry 的命令同样背负）。
- 影响：任何 CLI 命令（含 `--help`、`gateway stop`）都解析 823KB 对象字面量；推测 V8 解析+物化 20–50ms、堆 6–12MB；SEA 二进制无 code cache 每次全付。网关常驻进程只付一次，影响小。
- 修复方向：命令模块下沉到 commander action 内 `await import()`；`catalog-snapshot.generated.ts` 改懒 `import()`（或拆 catalog-lazy 模块），仅 `refreshCatalog` / `catalogModelMeta` 真正触达。
- 2026-10-12 核查：属实（实测 33896 行 / 772KB，命令模块 10 个）。纯懒 `import()` 需把同步触达点（`resolveModelMeta` 等 15+ 调用点）整体 async 化，SEA 下 createRequire 同步方案另有打包约束——**暂缓，待专项设计**。
- 验证：`node --cpu-prof` 或简单计时对比 `modeldock --help` 冷启耗时；注意 vitest 隔离模型（跨文件 mock 雷区，见 AGENTS.md）。
- 2026-10-20 部分修复（@2540618）：cli/index.ts 全部命令模块改 action 内动态 import——`--help`/`--version` 及不触达 adapters/ops 的命令不再静态加载 providers/adapters 模块图与 @inquirer；走 adapter/ops 链的命令仍经 `resolve.ts` 背 snapshot，懒 `import()` 专项（同步触达点 async 化）继续开放。
- 2026-10-26 收口（@01e1a7f）：snapshot 改 JSON 字符串形态 + `catalog.ts` 的 `catalogSnapshot()` 进程内 memo 懒解析——保持同步语义、15+ 调用点零改动（无需 async 化），SEA 约束不破（无运行时 fs / import.meta）；gen 脚本写盘前对拍。`--help` / `gateway stop` 等命令零解析成本。

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
- 2026-10-20 部分修复（@2540618）：refreshBakedModelClients 的 K 次 files 登记合并为循环外一次 mutateConfig；新增 `switchToServiceWithRoute` 把「切换服务 + 钉定主服务」两次整包写合并为一次（桌面 /switch 与手机端同款链路均改走）。mutateConfig「无变化跳写」仍开放。
- 2026-10-26 收口（@0b65ace）：saveConfig 序列化结果与磁盘现值逐字节一致时跳过 atomicWrite——无实际改动的 mutateConfig / 同值保存不再整包重写（tmp/rename 写放大收口）；比较在写锁内，归一化首写语义不回退。

**PERF-15（P2）secrets 单 key 修改 O(N)**
- 位置：`src/config/secrets.ts:310-313`（writeFileSecrets 对全部条目重新加密）；win32 每次 setSecret/deleteSecret spawn 一次 PowerShell 批处理（~1s 级，冷启动首请求延迟尖峰，之后有缓存）。
- 另注意：`secrets.ts:287,298` 首次加载遇存量明文会在**读路径**自动改写 secrets.json（一次性迁移，行为正确但属"读触发写"）。
- 修复方向：增量加密单条目；或至少注释说明成本模型。

### E. 内存与磁盘增长

**PERF-16（P2）JSONL 日志无轮转**
- 位置：`src/gateway/state.ts:614`（`gateway-YYYY-MM-DD.jsonl`）、`:625`（audit 同款）。写盘本身健康（常驻流池、无逐条 fsync、错误 ring≤500），但按天落盘**永不清理**，磁盘无界增长。
- 修复方向：启动/每日惰性清理 N 天前日志。
- 2026-10-26 已修（@26bccbb）：`gateway.log_retention_days`（默认 30，0=禁用）保留期清理——网关启动即清一次 + 每日定时；文件名严格锚定、流池持有的日文件先关句柄再删（Windows unlink EPERM/EBUSY 跳过、次日重试）。

**PERF-17（P2）reload 不关旧 ProxyAgent（≈backlog B4）**
- 位置：`src/gateway/state.ts:130`（`rt.dispatchers.clear()` 不调 close，旧连接池靠 keepAlive 空闲超时自然收尾；direct 单例不受影响，非无界泄漏）。
- 修复方向：clear 前对非 direct 的 dispatcher 逐个 `close()`。

### F. 2026-10-20 性能复审新增（P2，留底待修）

> 来源：四路并行复审（网关热路径 / Web 控制台 / 配置与启动链 / 同步与供应商目录），关键结论经人工到源码复核。同日 P1 已批量修复（PERF-02 全修、PERF-03/14 部分，另含切换服务写放大、overview/addService 并行取密钥、keychain 在途去重、loadLogs 重建、sync tick 补跑，@2540618）；下列 P2 留底。
> 2026-10-20 P2 批修：PERF-13/18/19/20/22/24/26/29/30/31/32/33/34/35 已修（@ff407bd）；PERF-21/23/25/27/28/36 复核后**暂缓**，理由附各条。
> 整体结论：转发热路径（SSE 真流式、全内存索引、异步日志流池）、控制台轮询设计（可见性门控/ETag/懒加载/分页）与同步引擎（单飞+防抖+watcher 降级）无 P0/P1 遗留，本节均为卫生级。

**PERF-18（P2）admin 鉴权每请求编译正则**
- 位置：`src/gateway/server.ts:629,1108`（`new RegExp(`(?:^|;\\s*)${adminCookieName(...)}=([^;]+)`)）
- 现状：UI 每 5s 轮询 overview 都触发，开销小但纯浪费。修复方向：按端口 memo 编译结果。

**PERF-19（P2）syncTickets/remoteRequests 孤儿条目清扫不全**
- 位置：`src/gateway/server.ts:939-945`（sweep 只挂在 request-remote/remote-status 入口）
- 现状：无人认领的票据（含解密 Syncdoc、report）常驻到进程结束。修复方向：并入既有 60s 周期清扫。

**PERF-20（P2）reload 不清 rt.health 已删服务残留**
- 位置：`src/gateway/state.ts:125-141`（reloadRuntime 重建 config/tokens/dispatchers，不动 health）
- 现状：反复增删服务的长生命周期进程累积小对象，量级极小。修复方向：reload 时按现配置过滤。

**PERF-21（P2）请求体全量 buffer 后才转发**
- 位置：`src/gateway/server.ts:540`（chunks 收集 → Buffer.concat，上限 64MB）
- 现状：模型改写管线的设计前提（topLevelModel 浅扫描已把解析成本压到最低），非纯浪费；TTFB 含完整上传，大请求高并发内存峰值 = 64MB×N。修复方向：无改写需求的 GET/DELETE 跳过 buffer。
- 2026-10-20 复核：**暂缓**——GET/DELETE 跳过 buffer 是请求管线的分支重构，涉及 body 消费路径约定；本地回环上大请求高并发场景罕见，收益不抵扰动。

**PERF-22（P2）pollOverview 双 stringify diff**
- 位置：`src/gateway/ui.ts:1383`（`JSON.stringify(v) === JSON.stringify(view)`）
- 现状：overview 几十–几百 KB，每 5s 主线程两次 O(n) 序列化（约 3–10ms），纯浪费。修复方向：`res.text()` 先比串（服务端本就回发缓存串），相等才 parse。

**PERF-23（P2）编辑弹层/拉取模型全量渲染无上限**
- 位置：`src/gateway/ui.ts:3919,4046`（`innerHTML = rows.map(...).join('')`；服务端 fetch-models 不截断）
- 现状：数百模型的供应商一次插数千节点，勾选时全表 querySelectorAll。修复方向：拉取结果截断前 N 条 +「显示全部」；勾选改事件委托（:4153 已有基础）。
- 2026-10-20 复核：**暂缓**——截断/分页涉及编辑弹层与拉取面板的交互改版，按仓库 UI 规约组件改动先过原型评审；仅数百模型以上的供应商可感知。

**PERF-24（P2）手机页轮询无可见性门控、页面无 ETag**
- 位置：`src/gateway/lan.ts:780`（`setInterval(load, 30000)` 无 `document.hidden` 判断）；`server.ts:804,809`（每请求重拼 ~63KB HTML）
- 现状：后台标签每 30s 冗余请求（载荷小、移动端浏览器会节流，危害轻）。修复方向：补 hidden 判断 + visibilitychange 立刷；页面套桌面端现成 ETag/304 模式（server.ts:63-71）。

**PERF-25（P2）控制台页 304KB 无压缩**
- 位置：`src/gateway/ui.ts:8`（模板字面量约 302KB + 注入后 304KB：body 21KB + CSS 45KB + 内联 JS 236KB，其中注释约 29KB）；`server.ts:1087` 注释「236KB」数字已过时
- 现状：ETag/304 已兜住重复加载，首载解析 236KB JS 约 30–80ms（一次性）。修复方向：构建期剥内联 JS 注释；顺手更正注释数字。
- 2026-10-20 复核：**暂缓**——注释剥离须字符串/正则感知（裸正则容易把含 `//` 的字符串字面量剥坏），应随构建链改造一并引入正规最小化，不宜手写剥离器；注释数字过时属一行文档修正，顺手提交时带上。
- 2026-10-28（T04 Phase 1 完成）：单文件 ui.ts（4817 行）已拆为拼装壳（43 行）+ `src/gateway/ui/` 15 个域模块（styles/page/kit/modals/i18n/shared/overview/update/autoroute/services/schedule/configpack/clients/edit/logs），拆分经「拆分前 UI_HTML 字节基线 vs 拆分后」cmp 全等验证（314896B），ui-lint / webui-static 门禁源读取同步扩到模块集。**本条核心（构建链正规最小化，Phase 2）维持暂缓**，与拆分解绑、另开卡；server.ts 体积注释修正由 T11 随手批处理。

**PERF-26（P2）presets.json 每 tick 读+解析两遍**
- 位置：`src/sync/collect.ts:72-73`（`readUserPresets()` 后紧跟 `readRawUserPresets()`，各自 readFileSync+JSON.parse+逐条校验）
- 修复方向：读一次，校验复用同一解析结果。

**PERF-27（P2）sync tick 重复全量 loadConfig**
- 位置：`src/sync/engine.ts:116,57`（cloud 每 tick 心跳与 collectSyncdoc 各 loadConfig 一次；target 每 tick 全量 collect，无 mtime 短路）
- 现状：配置小则毫秒级，属持续性重复 I/O。修复方向：tick 内复用同一份 cfg；或按 config.toml/secrets.json mtime 指纹短路。
- 2026-10-20 复核：**暂缓**——config.toml 为 KB 级小文件，每分钟两次毫秒级解析实测无感；共享 cfg 需要穿 cloudHeartbeat/collectSyncdoc 内部签名，同步域改动从谨慎原则暂缓。

**PERF-28（P2）WebDAV readManifest 无条件请求**
- 位置：`src/sync/targets/webdav.ts:75-77`（每 tick 全量 GET manifest.json，不带 ETag；cloud 目标 `cloud.ts:44` 已用 if-none-match/304）
- 修复方向：缓存 ETag 带 If-None-Match。
- 2026-10-20 复核：**暂缓**——manifest 是同步收敛方向判定的安全输入，ETag 缓存引入「陈旧 manifest」风险面；WebDAV 服务器对 ETag 的支持参差（部分返回弱 ETag 或随时间变化），需专项设计失效兜底后再做。

**PERF-29（P2）拉取模型无失败负缓存**
- 位置：`src/providers/fetch.ts:106-157`（候选链最多 8 端点逐个串行 × 15s，总 60s 封顶）+ `src/gateway/server.ts:1275`（每请求直连上游）
- 现状：上游不可达时用户每开一次弹窗白等最长 60s。修复方向：失败结果做 ~60s 短 TTL 负缓存。

**PERF-30（P2）fileSha256 整文件读内存**
- 位置：`src/util/fsx.ts:139-141`（`sha256(await fsp.readFile(p))`）；调用点 `update/check.ts:324`、`install/noderuntime.ts:229`（SEA/app 包 50–150MB）
- 现状：更新/装运行时瞬间内存峰值 ≈ 包体积，低配 Windows 可感。修复方向：createHash 流式管道。

**PERF-31（P2）SHASUMS 小文本用 10min 默认超时**
- 位置：`src/install/noderuntime.ts:214`（`downloadText` 未传 timeoutMs，落 `DOWNLOAD_TIMEOUT_MS`=10min；每 base 的 sums 与 archive 各自独立计时串行）
- 现状：连接挂死时装 Node 运行时最坏 20–40min 才落到下一源。修复方向：小文本给 15–30s 短超时。

**PERF-32（P2）one-api 分页无整体 deadline**
- 位置：`src/import/sources.ts:978-1007`（最多 50 页 × 15s/页串行）
- 现状：慢站点最坏拖 ~12min（仅显式 `--from oneapi` 路径）。修复方向：加 60s 级整体 deadline。

**PERF-33（P2）CLI status/doctor 串行探测 adapter**
- 位置：`src/cli/diag.ts:24,104-108`（`for (const a of allAdapters(cfg)) await a.status(...)`；网关侧 server.ts:680,798 已 Promise.all）
- 现状：~9 个 adapter 文件探测串行累加，status/doctor 慢数百 ms。修复方向：与网关侧对齐改 Promise.all。

**PERF-34（P2）Windows 注册表逐 app 串行扫**
- 位置：`src/adapters/presence.ts:109-111`（`for (const name of appNames) if (await registryHas(name)) return true`，reg /s 全树）
- 现状：慢盘机器 overview 重建可能撞秒级注册表扫描（已有 memo + overview 缓存大幅缓解，仅 Windows）。修复方向：多 app 的 registryHas 并行。

**PERF-35（P2）pruneSnapshots 重复全量列快照**
- 位置：`src/backup/snapshot.ts:156,164`（`listSnapshots` 调两次，各 readdir + 逐目录 manifest.json parse；snapshot() 内还先 loadConfig 多 parse 一次 TOML）
- 现状：每次写快照把备份目录 manifest 全量读两遍（keep=20 即 ~40 次文件读）。修复方向：一次 listSnapshots 复用于 valid 集与修剪列表。

**PERF-36（P2）密钥安全迁移循环逐 key 整包写**
- 位置：`src/ops.ts:830-843`（循环内每 key 一次 mutateConfig + setSecret + deleteSecret）
- 现状：N 个存量明文 key = N 次全量配置写 + 2N 次密钥表写；fire-and-forget 不阻塞启动，仅迁移期发生。修复方向：key_ref 更新合并为一次 mutateConfig；补 deleteSecretsBatch 批量形态。
- 2026-10-20 复核：**暂缓**——每个存量安装只跑一次且不阻塞启动；合并写需新增 deleteSecretsBatch 批量 API 并动密钥迁移正确性路径，改动面大于收益。

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
- 2026-10-27 已修（T02 任务卡，A 方向「关停前主动 flush」）：appendLine 常驻流池加 idle 定时刷盘——流超过 3s 无新写入即 end 关流（缓冲随关流强制落盘），下一条写入按需重建（src/util/fsx.ts）。最坏丢失窗口从「直到下次 stop」压到秒级，且收益独立于停机路径（崩溃/被杀同样受益）。验证：test/hotpath.test.ts 新增三用例——不 drain 不 close 行已完整落盘、空闲关流后重建行序完整、子进程不经任何清理路径直接退出后尾部完整（模拟 TerminateProcess 的丢弃语义）。
- 优雅停机通道（B 方向）未做：需新增带鉴权 shutdown 管理面端点，与 server.ts 拆分计划（T04/T05）撞车且收益有限（stop 前最后 3s 空闲窗内仍在写的行，硬杀下仍可能丢——秒级残余窗口，接受）。

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
- 2026-10-28 已修（T10 任务卡，Run 键方向）：自启改写 HKCU Run 键（`reg add/query/delete` 子进程），安装时顺带清理旧 VBS、卸载对称清两种形态。schtasks 实测否决：未提权 `schtasks /create /sc onlogon` 报「拒绝访问」（ONLOGON/ONSTART 触发器需管理员），装个自启不该弹 UAC。黑窗问题：Run 键直启控制台程序会常驻黑窗，登记命令带 `--autostart` 标记，由 cli.ts 以 windowsHide（CREATE_NO_WINDOW）分离重拉 daemon、父进程即退——黑窗只存活亚秒级（纯 JS，无 native）。沙箱（MODELRDOCK_FAKE_HOME）不碰真机注册表，Run 键值落沙箱内镜像文件（兼作 overview 免 spawn 在场判断）。崩溃拉起维持 Windows 平台缺口（与 VBS 现状同等能力，schtasks 方向因权限面大弃用）。

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
- 2026-10-12 已修（2a0c5c9）：`invalidateSecretsCache()` + reloadRuntime 接线；externalCache 加 60s TTL 兜底 keychain 跨进程改动；darwin keychain 改 `security -i` stdin（XPLAT-04 同 commit）。
- 连带的跨进程轻量锁**已补**（2026-10-12 @8b12b77）：secrets 写路径（setSecret / setSecretsBatch / deleteSecret → `mutateFileSecrets`）统一走 `withFileLock`（`secretsLockPath` = secrets.json 旁 `.lock`，与 config.toml 锁同语义：进程内 promise 串行 + O_EXCL 锁文件 + 陈锁抢占），锁内强制跳过内存缓存重读盘拼新鲜表，改后整表写回。并发回归：test/store.test.ts「secrets 写路径经 withFileLock 互斥调用序」「并发 setSecret/setSecretsBatch 写入同一 secrets.json，键互不丢失」（2026-10-27 任务卡 T01 复核确认收口；残余边界：loadFileSecrets 读路径的存量明文迁移写不走锁——锁不可重入，锁内再取锁会死锁，且该写仅在首次迁移时发生、窗口极小）。

**CORRECT-02（P2）快照孤儿清理删他进程半成品**
- 位置：`src/backup/snapshot.ts:154-158`：`valid` 集合 = 有合法 manifest 的目录，其余 `rm -rf`。跨进程并发（网关 pickerSync/attach 与 CLI 同时写）时，对方"文件已拷、manifest 未写"的半成品被整体删除 → 对方 applyChanges 在写客户端文件前抛错。后果是偶发假失败（写操作安全中止），无数据损坏。
- 顺带：`snapshot.ts:48-55` 的 id 冲突重试是死代码——`mkdir(recursive:true)` 对已存在目录不抛错，真撞 id 会静默共用目录互踩（概率≈0）。
- 2026-10-28 已修（T03 任务卡）：① snapshot 目录建好后先落 `.incomplete` 占位、manifest 写盘后移除；pruneSnapshots 对无 manifest 目录见到**新鲜占位**（<10min）即视为他进程正在写、跳过，占位超龄（兜底崩溃残留）或无占位（旧版本残留半成品）才清。keep 语义不变、manifest 格式不变（占位是目录内文件，不进 manifest 解析路径，旧 reader 兼容）。② id 冲突改非 recursive mkdir（叶子已存在即 EEXIST，跨进程原子判定），撞了换随机后缀重试、连续 3 次冲突抛可操作错误——原「重试」意图首次真正生效。验证：test/backup.test.ts 新增三用例（宽限期幸存 + 无占位/超龄仍清、并发交错互不删、同秒双快照 id 独立）。

**CORRECT-04（P2，2026-10-12 新增）定时窗口午夜边界闪烁**
- 现象：00:00:08 前后跑全量测试，「窗口接管重写 picker」「pickTarget 顺延到窗口目标」「displayRouteProvider prefer 窗口接管」等 5 例失败（窗口 `00:00–23:59` 被判不活跃）；23:50 与 00:03 复测同组全绿。与当日合入的改动无交集（失败用例涉及 schedule/pickTarget，同批合并改的是 relay/secrets/fsx/server 轮询）。
- 推测（未定位）：activeScheduleWindow 对「恰在窗口起点 00:00:00」的判定存在边界差（如按起始日归属/闭区间端点），或测试窗口取整分钟与真实秒级时刻的组合竞态。每日只在午夜±数秒窗口内可复现，复现成本高。
- 方向：为 activeScheduleWindow 补「now=窗口起止端点」的确定性单测（注入时钟），定位后修复。
- ☑ **已修 2026-10-12（@85558ca）**：根因不是午夜边界——是 end 排他语义在分钟粒度下产生的「死亡分钟」：`00:00–23:59`（e=1439）在 23:59:00–23:59:59（t=1439 ≥ e）被判不活跃，全量跑到这一分钟才红（00:00:08 只是观察时刻）。修法：`e === 1439` 特判含入最后一分钟（「当天结束」惯例），普通窗口 end 不含语义不变；补全天窗口 23:59 回归用例。完整反例推演见 docs/archive/release-review-2026-10-12.md §五。

**CORRECT-03（P2）config.toml 无写前快照**
- 现状：全仓快照仅 4 处调用（engine.ts / ops.ts:749 / cli/harness.ts / sync/collect.ts），均针对客户端文件与 sync 导入前；config.toml 直写无快照，写坏（如 migrate/stringify 缺陷）无 undo。推测有意取舍（config 有 .lock + 原子写）。建议至少在 AGENTS.md 澄清边界，或对 migrate 类大改前补快照。
- 2026-10-28 已修（采纳「migrate 类大改前补快照」方向）：saveConfig 检测磁盘 version 低于当前 CONFIG_VERSION 时（且非空文件），先经 `snapshot('config', 'pre-migrate', [config.toml])` 快照到 backups/config/（与 sync 导入前快照同址同型，`modeldock restore config` 可撤），快照失败不阻断写盘；动态 import 避免与 snapshot.ts 的 loadConfig 循环依赖。逐次写前快照不做——常规写高频，20 份滚动窗口秒级即被冲掉，无 undo 价值（AGENTS.md 已补边界说明）。回归：test/store.test.ts「版本迁移写盘前快照」。

**CORRECT-05（P1，2026-10-13 用户实测踩中）dev/测试沙箱操作外溢生产**
- 事故：用户清 dev 沙箱（`~/.modeldock-dev`）数据后，生产实例的 provider Key 全部失效（401）。
- 根因（沙箱 = MODELRDOCK_FAKE_HOME，run_dev 的 dev 实例与 agent 测试实例同命中）：
  1. **钥匙环全局共享**（事故根源）：`src/config/secrets.ts` darwin 默认 keychain / linux secret-service 是机器级全局存储，不随 home 重定向隔离；`scripts/dev-seed.mjs` 原样复制生产的 `keychain:` 引用（注释明写「provider/profile/key 照搬」）；CLI `cmdReset`（basic.ts）、Web `/_modeldock/reset`（server.ts）、`uninstall --purge` 均循环 deleteSecret 按引用删真钥匙环；`migrateSecretsToSecure`（ops.ts，网关启动）还会把沙箱 file 密钥迁进真钥匙环。
  2. `src/cli/gatewaycmd.ts` sweepGatewayProcesses：按命令行签名全机杀网关进程（modeldock + gateway start/--sea-gateway），沙箱 uninstall 会杀掉生产 8687。
  3. `src/cliinstall.ts` cliBinDir：/usr/local/bin 软链（macOS）、%LOCALAPPDATA%\WindowsApps（Windows）是全局落点，沙箱 uninstall 摘掉真机 CLI 入口。
  4. `src/autostart.ts`：launchd label / systemd unit 名机器级全局，沙箱 install/uninstall 的 launchctl/systemctl 操作会卸生产服务；windowsStartupPath 用未重定向的 APPDATA，沙箱启动项写进真机「启动」文件夹。
  5. `src/import/sources.ts` readOpencodeAuth：win32 APPDATA 分支读真机密钥（只读泄漏）。
- 已核查安全：npm 全局安装（installChildEnv 的 npm_config_prefix 沙箱重定向）、自更新（run.ts 开发态守卫）、客户端文件/自启文件/快照/日志/网关状态写入（全部走 homeDir()）。
- ☑ **已修（2026-10-13 @d6e3a59）**：沙箱一律 file 后端（defaultStore 早退，顺带让 migrateSecretsToSecure 在沙箱 no-op）；setSecret/setSecretsBatch 外部后端强制转 file；deleteSecret 沙箱跳过外部删除（守卫兜底）；新增 `src/config/sandbox.ts` 启动迁移把沙箱配置的外部 key 引用落地为 file（值只读拷入沙箱 secrets.json，幂等，gateway main.ts 挂钩）；sweepGatewayProcesses 沙箱跳过；cliBinDir 沙箱重定向进 `modeldockDir()/cli-bin`；autostart 新增 `serviceLabel()`（沙箱 `com.modeldock.gateway.sandbox`）+ windowsStartupPath 沙箱走 homeDir；导入 APPDATA 分支沙箱跳过。
- 遗留清理：旧版沙箱若曾装过自启（生产 label 指向沙箱路径），需手动核对 `launchctl print gui/$(id -u)/com.modeldock.gateway` 的 program 路径后 `launchctl bootout` 清理；新版不会再产生该状态。

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

---

## 六、2026-10-27 六分区全量复审（REVIEW 系列）

> 来源： expert 复审（6 分区并行审查 + 人工复核全部 P1），基线为本文档既有条目之外的新发现。
> 全部 P1 + P2 已修复合并（develop @50ab868），仅 REVIEW-26 经核为既定设计语义、留档不改。

| 编号 | 级别 | 位置 | 一句话 | 状态 |
|---|---|---|---|---|
| REVIEW-01 | **P1** | `src/gateway/server.ts`（readBody） | 413 超限路径先毁 socket，响应永远到不了客户端（SDK 自动重传循环） | ☑ 已修（@4e048eb，排空请求体 + sendError 对 413 补 connection: close；wire 级回归测试） |
| REVIEW-02 | **P1** | `src/gateway/ui.ts:1682` 等三处 | 更新核验版本号用字符串 `>=`（'1.9.0' >= '1.10.0'），跨位版本对假完成/丢进度 | ☑ 已修（cmpSemver 逐段数值比较；webui-static 契约测试） |
| REVIEW-03 | **P1** | `src/gateway/state.ts` → `proxy.ts` | undici 经 state.ts 对 proxy.js 的静态 import 进全部 CLI 启动链（PERF-04 残留入口） | ☑ 已修（dispatcherFor 下沉 proxy.ts；startup-lazy 结构断言） |
| REVIEW-04 | **P1** | `src/import/sources.ts`（applyImport） | 批内 suggest_id 撞车静默覆盖（只查 cfg 不查本批），one-api 同名渠道丢服务丢 key | ☑ 已修（usedIds Set 兜底；import-scan 回归） |
| REVIEW-05 | **P1** | `src/adapters/format.ts`（detectJsonIndent） | 顶层数组 JSON 探测出 2 倍缩进，每次重写翻倍无上界（workbuddy models.json） | ☑ 已修（数组根分支 + 稳态回归测试） |
| REVIEW-06 | **P1** | `src/sync/engine.ts:153` | 云端 desired 应用失败阻断整个 tick，多机同步每 60s 永续重试不收敛 | ☑ 已修（applySwitch try/catch 只记错；cloud-heartbeat 回归） |
| REVIEW-07 | P2 | `src/gateway/server.ts`（runRemoteRequest） | 条目被 TTL 清扫后 set() 重写丢 createdAt → remoteRequests 永生条目 | ☑ 已修（缺失时按当前时间重建） |
| REVIEW-08 | P2 | `src/gateway/server.ts:722,2791` | 畸形 cookie 值（裸 %）decodeURIComponent 抛 URIError → admin 500 | ☑ 已修（safeCookieDecode，按不匹配走 401/403） |
| REVIEW-09 | P2 | `src/gateway/server.ts`（registerWebDevice/hRotate/hLanPost） | gateway.json 读-改-写无并发防护，并发丢字段 | ☑ 已修（state.ts 新增 mutateGatewayState 进程内串行；回归测试） |
| REVIEW-10 | P2 | `src/gateway/server.ts`（hServiceDelete） | 先删密钥再写配置：写锁失败留下引用已删 key 的 503 服务 | ☑ 已修（先 persistConfig 后 deleteSecret） |
| REVIEW-11 | P2 | `src/gateway/server.ts`（hHarnessRoute） | persistConfig 回调以陈旧 rt.config 兜底，并发 detach 写回幽灵 harness 条目 | ☑ 已修（只以写锁内最新配置为源，缺失即中止） |
| REVIEW-12 | P2 | `src/gateway/server.ts`（/ui） | 未鉴权 GET /ui 也 markUiSeen + 失效 overview 缓存（本机探测抑制仅托盘） | ☑ 已修（收窄到带有效凭据请求；tray-state 契约更新） |
| REVIEW-13 | P2 | `src/gateway/server.ts:2657,1876` | handleAdmin 文档注释错位；两处「2s TTL」注释过时（实为 6s） | ☑ 已修 |
| REVIEW-14 | P2 | `src/gateway/ui.ts`（createModal/Esc 分派） | 弹层壳无焦点管理（违反 ui-kit §9 声明）；Esc 穿透 closeOnEsc:false 关掉被遮弹层丢未保存输入 | ☑ 已修（open 移焦/close 还原/Tab 圈闭 + Esc 只看最上层；webui-static 断言） |
| REVIEW-15 | P2 | `src/gateway/ui.ts`（pkgM/pollOverview/load 链） | 配置包弹层无 onClose 停轮询（空转 65s）；轮询 401 静默冻结假实时页；load().then(loadLogs) 把 Promise 传真值形参 | ☑ 已修（onClose 停 nearbyPoll；401 弹重登带防重入；显式回调） |
| REVIEW-16 | P2 | `src/gateway/ui.ts:1682` 同域 | 两页均无 CSP（纵深防御） | ☑ 已修（console-shared CONSOLE_CSP 基线，桌面/手机页 200/304 接线；gateway 回归断言） |
| REVIEW-17 | P2 | `src/gateway/lan.ts:482,517` | 手机页语言判定 navigator 死逻辑（英文系统恒中文）；toast 无 aria-live；确认弹层无键盘路径；title 未双语 | ☑ 已修（en 兜底 + role=status + Esc/焦点还原 + data-i18n title） |
| REVIEW-18 | P2 | `src/config/secrets.ts`（loadFileSecrets） | 跨机拷贝的异平台密文（enc:mach:/enc:dpapi:）被当存量明文二次加密，原值不可逆损毁 | ☑ 已修（异源前缀守卫抛可操作 SecretsError，绝不重加密；store 回归） |
| REVIEW-19 | P2 | `src/config/secrets.ts`（外部后端读取） | 读取失败与条目不存在混同 null 且缓存 60s（钥匙环锁定期发无 key 请求）；解密失败透传原始报错；三处 stdin 无 EPIPE 守卫 | ☑ 已修（44/空输出=不存在可缓存，故障上抛；失败转可操作 SecretsError；stdin on('error')；注释纠正） |
| REVIEW-20 | P2 | `src/config/store.ts`（migrate） | 容器键形状无校验，`providers = 5` 类合法 TOML 标量抛原始 TypeError | ☑ 已修（containerOrEmpty/normalizable 守卫给含键名 ConfigError；回归测试） |
| REVIEW-21 | P2 | `src/ops.ts` + `src/config/sandbox.ts` | normalizeUserModels 数值无校验；removeProviderCascade 漏清 route_next；沙箱迁移读不到落空 key 翻转引用；沙箱下仍探测生产 8687 | ☑ 已修（saneModelNumber + 级联清理 + 只改写成功条目 + FAKE_HOME 跳过探测；attach-port 契约更新） |
| REVIEW-22 | P2 | `src/util/sysproxy.ts` | SOCKS 系统代理产出 undici 不支持的 socks5://（更新必挂） | ☑ 已修（识别即弃用回落直连/HTTP 口；sysproxy 契约测试更新） |
| REVIEW-23 | P2 | `src/update/*` + `src/cli/*` | cleanOldVersions 漏托盘 .old；托盘替换失败击穿安装；sweep 前缀缺 app/bin/sums；--clean 不持锁；stopTray 子串误杀；gatewaycmd 首次 kill 无 ESRCH 守卫；init 两轮 detect 串行；daemon 等待 5s 对 SEA 冷启过短 | ☑ 已修（八项全收；托盘替换降级警告；spawnDaemonAndWait rounds 可调、GUI 30s；update 回归） |
| REVIEW-24 | P2 | `src/import/sources.ts`（scanZcode） | 只扫旧版 config.json，漏现行 provider_config.json（用户自定义供应商常年漏导） | ☑ 已修（两代合并扫描；修掉旧文件缺席早退短路；import-scan 回归） |
| REVIEW-25 | P2 | `src/adapters/*` + `src/presets/data.ts` | claude-code 网关分支不清 ANTHROPIC_API_KEY；codex stripEnvBlock 全局压缩用户排版；5 适配器 planAttach 无等值过滤；reloadPresets 不失效 known 表 | ☑ 已修（无条件清 + 接缝局部收敛 + changeIfChanged 帮手统一五处 + clearKnownTable；adapters 幂等契约更新） |
| REVIEW-26 | P2 | `src/sync/collect.ts`（applySyncdoc） | 远端删除正激活 profile 后本机残留悬空 active_profile | ☑ **复核为既定语义，留档不改**（机器态保护：当前激活路由不随包覆盖，lansync/syncexport 测试钉死；转发侧 pickTarget 对未知 profile 安全回落，用户重选即恢复） |
| REVIEW-27 | P2 | `src/cloud/server.ts` | putDoc 畸形 ts 入库后 NaN 恒 false 打穿 422 回滚保护；login/pair 畸形 JSON 500 外泄 V8 原文；cookieToken 畸形值 500；配对码 Math.random 非 CSPRNG | ☑ 已修（Number.isFinite 拒收 + parseBody 回落 + 解码守卫 + randomInt；cloudserver 回归；2026-10-28 补 null/数组/标量穿透守卫，T07 实证） |
| REVIEW-28 | P2 | `src/sync/targets/webdav.ts` + `localdir.ts` | manifest CAS 两段写：双机窗口互覆双双记成功后永久 idle 静默分叉（连冲突快照都没有） | ☑ 已修（写后回读复核归属，被覆写方转 conflict 走引擎冲突分支；synctarget 回归） |
| REVIEW-29 | P2 | `src/cloud/console.ts` + 死代码 | 云控制台 10s 轮询无 document.hidden 门控；CLOUD_ENVELOPE_REF 导出与 sha256Hex 再导出无使用点 | ☑ 已修（hidden 门控 + visibilitychange 立刷；死代码删除） |

> 测试盲区（同步 engine 推送部分失败簿记、CloudStore 专属用例、applySyncdoc 半完成态恢复等）未在本轮补齐，作为后续测试建设方向；本轮各修复均带定向回归测试，全量 913 例绿（develop @50ab868）。
