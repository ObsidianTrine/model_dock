# ModelDock 云同步详设与演进路线（Phase 2）

| 文档属性 | 内容 |
|---|---|
| 当前版本 | **v1.0 · 评审通过（2026-10-04 与用户逐节确认）** |
| 对齐实现 | develop（2026-10-04，含 fff289f） |
| 作者 | ObsidianTrine |
| 日期 | 2026-10-04 |
| 上游文档 | [design.md](./design.md) §1.2「不覆盖：云同步（Phase 2，另行详设）」——本文即该详设 |

**版本历史**

| 版本 | 日期 | 说明 |
|---|---|---|
| v1.0 | 2026-10-04 | 初版：M1–M4 演进路线、M3 选型结论（国内轻量 VPS）、syncdoc 数据模型、加密信封、API 与存储规格、部署 runbook、测试门与验收标准 |

**评审记录**

| 评审人 | 日期 | 结论 | 意见摘要 |
|---|---|---|---|
| ObsidianTrine | 2026-10-04 | 通过 | 确认 M3 落点国内轻量 VPS；接受"分钟级生效"与"口令不可恢复"两项默认语义 |

---

## 0. 如何使用本文（AI 实施须知）

- 本文是 Phase 2 的**实施基准**。任何 AI 接手任一里程碑时：先读本文对应章节 + `AGENTS.md` 全文，再读该章节列出的「必读源码」，然后按任务清单逐项执行。
- 标注 **【决策】** 的条目是用户已拍板的结论，**不得擅自更改**；实施中发现决策不可行，停下来向用户说明，修订本文并重新确认后再动代码。
- 所有代码改动一律走 `.agents/workflows/feature-branch.md` 工作流（每个里程碑的任务 id 在各章「开工检查单」给出）。**禁止**在 develop/main 直接改代码。
- 用户可见文案（CLI 输出、报错、两个 Web 控制台）一律走 `src/util/i18n.ts` 的 `t(中文, English)` 双语，规范见 `AGENTS.md`「工程硬性约定」。
- 本文引用的现有模块路径均已对照 develop 源码核实；**函数名一律以实读源码为准**（本文只锚定到模块级，函数签名动手前自行确认）。
- 每个里程碑完成 = 该章「验收标准」逐条通过 + `npm test` 全绿 + 临时进程/沙箱清理完毕（`AGENTS.md`「端口与实例约定」硬规则 4）。

---

## 1. 背景与目标

### 1.1 用户场景

1. ModelDock 网关跑在笔记本（及未来多台电脑，含家里/公司等不同网络环境）上，伺服本机 AI 客户端。
2. **多台电脑共用一份配置与上游 key**：在一台机器上添加的服务/路由/预设，其他机器同步可用；在一台机器改了 key，处处生效。
3. **手机远程**：不开电脑时，用手机查看各机器状态（在线/当前激活服务），必要时远程切换某台机器（或全部机器）使用的服务。

### 1.2 目标

- 配置的**单一事实来源**：可同步态（§4.1）一处修改，多机收敛一致。
- 笔记本/台式机**零网络暴露**：网关保持仅监听 `127.0.0.1`，不因远程需求开任何入站端口。
- 云端**永不接触明文 key**：端到端加密（E2E），云服务器只见密文。
- 离线可用：任何一台机器断网/云端不可达时，本地最后一份配置继续照常工作。

### 1.3 非目标（明确不做）

- 不做多用户/团队/SaaS 化（单用户自托管）。
- 不做反向推送通道（WebSocket/长连接/内网穿透）——远程指令靠机器心跳拉取。
- 不做本地 Web 控制台的全量响应式重排（手机场景由云端轻控制台承载）。
- 不做 LAN 监听、二维码局域网配对、Tailscale 产品化（上一版方案已否决，见 §2 D8）。
- 不实时同步使用统计/请求日志（每机本地数据；M4 再评估汇总上报）。

---

## 2. 已拍板决策（ADR 摘要）

| # | 决策 | 内容与依据 |
|---|---|---|
| D1 | **M3 控制面 = 国内轻量 VPS 自托管**【决策】 | 阿里云 2C2G 99 元/年档（续费同价；腾讯轻量同价位可替代）。依据（2026-10 调研）：Cloudflare Workers 免费额度够（10 万请求/天）但 `workers.dev` 国内被墙、绑自有域名后大陆仍走海外节点有波动；国内函数计算（FC/SCF）长期免费额度已取消且平台政策 4 年内两度变动；自托管 VPS 国内可达性最稳、¥99/年性价比最高、无平台锁定 |
| D2 | **端到端加密**【决策】 | 配置 blob 客户端加密后才出机器；云服务器/同步盘只见密文。我们不成为密钥托管方 |
| D3 | **激活服务是每机运行态**【决策】 | 同步的是「可用的服务/路由库」，不是「当前用哪个」；云端存每机 `desired_profile`（期望激活态），机器心跳时拉取应用 |
| D4 | **远程切换分钟级生效**【决策】 | 手机点切换 → 写云端 desired → 机器下一个心跳（默认 60s±抖动）拉取应用。接受分钟级，不做秒级推送 |
| D5 | **忘记同步口令 = 密文不可恢复**【决策】 | 用户接受；需在产品文案明确提示，后续 M4 可加恢复码 |
| D6 | **整包 LWW + 冲突快照**【决策】 | 不做字段级合并：推送冲突时保留双方快照、整包以后写者为准，UI 提示用户处理 |
| D7 | **云端组件零 native 依赖**【决策】 | 服务端用 Node ≥22 内置 `node:sqlite`（部署机装 Node 24 LTS），HTTP 用 `node:http`，加密用 `node:crypto`——与主项目「纯 JS」红线同构，同仓同测 |
| D8 | **否决项** | LAN 监听/局域网二维码配对/Tailscale 产品化（复杂度不匹配收益）；全量响应式重排；CF Workers（备选保留，见 §11 风险）；自家常开电脑当 hub |

---

## 3. 总体架构

```
                       ┌────────────────────────────┐
                       │  云端控制面（M3，VPS 自托管）  │
                       │  Node + node:sqlite 单进程    │
                       │  · 加密配置 blob（唯一事实来源）│
                       │  · 设备注册表 / 修订号         │
                       │  · 心跳与 desired_profile     │
                       │  · 手机轻控制台（静态单页）     │
                       └──────────▲───────┬──────────┘
              HTTPS/IP+端口        │pull/push(密文)  │heartbeat/desired
   ┌──────────────────────┤                ▼ 手机浏览器
   │  电脑 A（笔记本）       │        ┌───────────────┐
   │  ModelDock 网关        │        │ 电脑 B（台式机） │
   │  127.0.0.1:8687       │        │ 同左           │
   │  + sync agent(新增)    │        │               │
   │  ~/.modeldock/ 本地兜底 │        │               │
   └──────────────────────┘        └───────────────┘
   harness 接入 / 日志 / 统计 / autostart / admin token —— 每机本地，永不同步
```

- **数据流（写）**：任一机器本地改配置 → sync agent 推送新加密 blob（带基线修订号）→ 云端 rev+1。
- **数据流（读）**：机器心跳/启动时拉取 → 修订号变化则解密校验 → 写入本地（经既有备份机制）→ 应用 desired。
- **手机**：只与云端通信（看设备列表/心跳态，写 desired_profile），永不直连任何电脑。

---

## 4. 同步数据模型

### 4.1 可同步态 vs 机器态（精确清单）【决策，实施时按此切分】

**可同步态（进 syncdoc，加密后上云）**

| 数据 | 现状载体 |
|---|---|
| providers（含 base_url/协议/key 引用与**上游 key 明文**） | `config.toml` providers 段 + `secrets.json` |
| profiles（默认模型/别名映射/fallback 链定义） | `config.toml` profiles 段 |
| 用户自定义预设 | `~/.modeldock/presets.json`（机制见 `src/presets/data.ts` 的 `readUserPresets/applyUserPresets/reloadPresets`） |
| 定时切换规则（dayFilter 时段表） | `config.toml` 定时切换段（规则共享；每机「启用」开关属机器态，默认每机独立停用） |

**机器态（永不同步，留在各机）**

harness 接入状态与各客户端配置文件、`gateway.json`（admin token/端口）、autostart 安装状态、请求日志与用量统计、当前激活 profile（运行态）、`sync.json`（本机同步凭据）、备份快照目录。

> 切分原则：**换一台新电脑装好 ModelDock 后，希望"自动就有"的东西 = 可同步态；换电脑后必须重做的东西 = 机器态。** 实施时若遇到清单未覆盖的字段，按此原则归类并在本文 §4.1 补行（文档同步更新是任务的一部分）。

### 4.2 syncdoc v1（传输/存储的逻辑格式，加密前的明文形态）

```jsonc
{
  "fmt": "modeldock-syncdoc",
  "v": 1,                          // schema 版本；解密后 v 不认识 → 拒绝应用并提示升级客户端
  "ts": "2026-10-04T12:00:00.000Z",
  "data": {
    "providers": [ /* 与 config store 中 providers 等价的完整对象，含 key */ ],
    "profiles":  [ /* 同上 */ ],
    "userPresets": { /* presets.json 的原始 JSON */ },
    "scheduleRules": [ /* 定时切换规则 */ ]
  }
}
```

- 序列化：JSON（稳定键序不要求；比较/去重不做字段级处理）。
- 校验：应用前按 schema 校验（手写校验函数即可，不引第三方依赖）；校验失败**拒绝应用**并保留本地现状，报错信息含「云端版本可能更新，请升级客户端」。

### 4.3 加密信封（envelope v1，出机器的唯一形态）

```jsonc
{
  "fmt": "modeldock-syncenv",
  "v": 1,
  "kdf": { "alg": "PBKDF2-HMAC-SHA256", "iter": 600000, "salt": "<base64,16B>" },
  "iv":  "<base64,12B>",
  "ct":  "<base64, AES-256-GCM(syncdoc JSON)>",
  "hmac":"<base64, HMAC-SHA256(macKey, rev || ts || ct)>",   // 防服务器/存储端回滚与篡改
  "created_by": "<devid>",
  "created_at": "<ISO8601>"
}
```

密钥派生（`node:crypto`，实现放 `src/sync/crypto.ts`）：

```
master = PBKDF2-HMAC-SHA256(口令, salt, 600000, 32B)
encKey || macKey = HKDF-SHA256(master, hkdfSalt, info="modeldock/syncdoc/v1")  // 各 32B
ct = AES-256-GCM(encKey, iv, syncdocJSON)      // 认证标签随 ct
hmac = HMAC-SHA256(macKey, ASCII(rev) || "||" || ts || "||" || ct)
```

- `rev` 是服务端/存储端分配的修订号，客户端推包时还不知道最终 rev，因此 **HMAC 覆盖 `(ts || ct)`**；防回滚由「信封内 ts 必须晚于当前已存信封 ts，否则服务端 422 拒收、客户端拒收应用」实现。服务端不可信由 GCM 认证 + ts 单调性共同兜底。【实现约定，按此执行】
- 换口令 = 下次推送用新口令重新生成 salt/keys（透明轮换）；旧信封作废。
- 新机器入网：在该机输入同一口令派生密钥（无需传输任何密钥材料）。

### 4.4 本机凭据文件 `~/.modeldock/sync.json`（0600，atomicWrite）

```jsonc
{
  "v": 1,
  "mode": "off | target | cloud",        // off=未启用; target=M2 存储同步; cloud=M3 云端
  "target": { "kind": "webdav | localdir", "url": "...", "dir": "..." },  // M2
  "cloud":  { "url": "https://<ip>:<port>", "devid": "...", "token": "...", "deviceName": "..." }, // M3
  "key": { "salt": "...", "hkdfSalt": "...", "verifier": "<base64>" },  // 派生密钥材料缓存在本机（与 secrets.json 同信任级别）；verifier 用于校验口令输入是否一致
  "lastAppliedRev": 0, "lastAppliedTs": "...", "lastLocalSwitchTs": "..."
}
```

- 与 `config.toml`/`secrets.json` 分文件的原因：config.toml 是被同步的内容，凭据不能随它被同步回去。
- 口令派生材料落盘本机 = 机器失窃即密钥失窃（与今日 secrets.json 同级风险，接受）；高危用户可配置不缓存、每次启动手输（M4 可选开关，不进 MVP）。

---

## 5. M1：syncdoc 分层 + 加密导出/导入（纯本地）

**目标**：完成 §4 的数据模型落地；提供「导出加密配置包 / 导入」命令，实现手动多机共享与迁移备份。无任何网络代码。

### 5.1 新增文件

| 文件 | 职责 |
|---|---|
| `src/sync/types.ts` | syncdoc/envelope 类型、schema 校验（`validateSyncdoc`）、`SCHEMA_VERSION = 1` |
| `src/sync/collect.ts` | `collectSyncdoc()`：从 config store + secrets + presets.json 收集可同步态 → syncdoc；`applySyncdoc()`：校验后写回（providers/profiles 走 config store 既有写入函数，key 写 secrets，presets 写 presets.json；**一律 atomicWrite**，写前触发既有 backup 快照机制） |
| `src/sync/crypto.ts` | §4.3 信封加解密（`sealEnvelope/openEnvelope`）+ 口令 verifier |
| `src/sync/exportImport.ts` | 导出（收集→密封→写 `.msync` 文件）；导入（拆封→校验→**预览 diff**→确认→applySyncdoc） |
| `src/cli/sync.ts` | commander 命令组，注册进 `src/cli/index.ts`（`buildProgram`） |

### 5.2 CLI 命令

```bash
modeldock config export -o modeldock-config.msync     # 交互输口令（@inquirer/prompts，项目已有依赖）；不回显
modeldock config import modeldock-config.msync        # 校验口令 → 显示将变更内容摘要（服务数/路由数/预设数）→ 确认 → 应用
modeldock config export --stdin-pass                  # 供脚本/CI 使用（口令经 stdin，不进 argv）
```

- 导入语义【决策】：**替换全部可同步态，机器态一律不动**。确认提示必须列出"将被替换"与"不受影响"两类清单。
- 所有报错可操作（例：口令错 → 「口令不正确。若遗忘口令，包内容无法恢复，请向导出方重新获取」）。

### 5.3 开工检查单

- [ ] 分支：`node .agents/scripts/feature-branch.mjs start sync-schema-m1`
- [ ] 必读：`src/config/store.ts`、`src/config/types.ts`、`src/backup/`（快照触发点）、`src/presets/data.ts`、`AGENTS.md` 全文
- [ ] 测试先行：`test/syncdoc.test.ts`（schema roundtrip、未知 v 拒绝）、`test/syncexport.test.ts`（fakeHome 下导出→清空→导入→逐字段相等；错口令失败；篡改 ct 失败；机器态导入后不变——断言 gateway.json/harness 接入未被触碰）
- [ ] 验收：两台 fakeHome 沙箱 + `MODELRDOCK_FAKE_HOME` 成对演示导出导入；`npm test` 全绿；无端口监听类改动
- [ ] 工作量：1–2 天

---

## 6. M2：自动同步到用户自选存储（无自建服务器）

**目标**：不运维任何服务器的前提下，多机通过用户已有的网盘/WW 存储（WebDAV）自动共享配置。

### 6.1 SyncTarget 接口（`src/sync/targets/types.ts`）

```ts
interface SyncTarget {
  readManifest(): Promise<{ rev: number; ts: string; byDevid: string; blobRef: string } | null>
  writeBlob(rev: number, devid: string, envelope: string): Promise<void>       // blobs/<rev>-<devid>.msync
  writeManifest(m: Manifest, baseRev: number): Promise<'ok' | 'conflict'>      // 读-改-写，baseRev 不符 → conflict
  readBlob(ref: string): Promise<string>
}
```

实现：`targets/webdav.ts`（用依赖 `undici` 发 PUT/GET/PROPFIND，Basic Auth；坚果云/Nextcloud/群晖均兼容）、`targets/localdir.ts`（目录内直接读写，配合 iCloud/OneDrive/坚果云同步盘）。

### 6.2 存储布局与冲突语义

```
<dir>/modeldock-sync/manifest.json          // { rev, ts, byDevid, blobRef }
<dir>/modeldock-sync/blobs/<rev>-<devid>.msync  // 加密信封，只增不删（保留全部历史）
```

- 推送：读 manifest → `manifest.rev == 本机 baseRev` → 写 blob → 写 manifest(rev+1)；否则 **conflict**：拉取最新 blob 应用（替换本机可同步态），本机待推内容存入 `~/.modeldock/backups/sync-conflict-<ts>.json` 并 toast/CLI 提示用户在任一机器重做差异【决策 D6，不做自动合并】。
- 拉取轮询：每 120s ± 30% 抖动 + 每次本地配置变更后即时推（防抖 3s）；`sync.json.lastAppliedRev` 幂等。
- WebDAV 无原子 CAS → 靠 manifest.rev 比对 + 冲突检测兜底；单用户 2–4 台机器实际冲突率极低，够用。

### 6.3 CLI / UI

```bash
modeldock sync setup --target webdav --url https://dav.jianguoyun.com/dav/ --dir modeldock
modeldock sync status        # mode/最近推拉时间/rev/上次冲突
modeldock sync pause | resume
```

Web 控制台「我的服务」页顶部加一行同步状态小字（只读 + 「去电脑端命令行配置」提示，M2 不做控制台内配置）。

### 6.4 开工检查单

- [ ] 分支 task-id：`sync-target-m2`
- [ ] 必读：M1 产物、`src/gateway/ui.ts` 状态卡渲染区、`undici` 用法（`src/` 内已有使用先例）
- [ ] 测试：`test/synctarget.test.ts`——用 `http.createServer().listen(0)` 起内存 WebDAV 假件（红线：随机端口）；覆盖 首推/正常轮换/双机冲突/离线兜底（target 不可达时网关照常工作、静默重试 + 状态行提示）
- [ ] 验收：两个 fakeHome 沙箱对同一个 localdir 目标做双向修改，最终收敛一致且留下冲突快照样本；`npm test` 全绿
- [ ] 工作量：2–3 天

---

## 7. M3：云端控制面（国内轻量 VPS 自托管）

### 7.1 服务端（`src/cloud/`，与主代码同仓同栈）

| 文件 | 职责 |
|---|---|
| `src/cloud/main.ts` | 入口：参数解析（`--port`、`--data <dir>`）、初始化、`node:http` 启动；**仅监听 `127.0.0.1` 或显式 `--host`**（部署时 `--host 0.0.0.0`） |
| `src/cloud/store.ts` | `node:sqlite`：设备表/文档表/配对码表（DDL 见 §7.3）；每日快照函数 |
| `src/cloud/server.ts` | 路由与鉴权（§7.2）；统一 JSON 错误（`{error: {code, message}}`） |
| `src/cloud/console.ts` | 手机优先静态单页（内嵌 HTML/JS/CSS，独立实现，**不 import ui.ts**；双语走 `data-i18n="中||EN"` 同款机制） |

技术约束【决策 D7】：零第三方依赖；`node:sqlite` 需 Node ≥22.5，部署机统一 Node 24 LTS。**主客户端 package.json 不新增任何依赖。**

### 7.2 API（v1，全部 JSON；鉴权头 `Authorization: Bearer <deviceToken|consoleToken>`）

| 路由 | 方法 | 鉴权 | 语义 |
|---|---|---|---|
| `/v1/pair` | POST | 一次性配对码 | `{pairCode, devid, deviceName}` → `{deviceToken}`；配对码 15 分钟有效、用后即焚 |
| `/v1/doc` | GET | device | `If-None-Match: <rev>` → 命中返回 304；否则 `{rev, envelope, ts, byDevid}` |
| `/v1/doc` | PUT | device | `If-Match: <baseRev>` + `{envelope, ts}` → 成功 `{rev}`；基线不符 **409** `{rev, ts}`（客户端走 D6 冲突流程）；ts 早于当前信封 ts → 422 拒收回滚 |
| `/v1/heartbeat` | POST | device | `{devid, version, reportedProfile}` → 更新 last_seen/reported；返回 `{desiredProfile, desiredTs}` |
| `/v1/devices` | GET | console | 设备列表（devid/名称/last_seen/client_version/reported/desired/在线态=last_seen<180s） |
| `/v1/desire` | POST | console | `{devid \| "all", profileId}` → 写 desired_profile + desired_ts=now |
| `/v1/paircode` | POST | console | 生成一次性配对码（控制台展示，供新机器入网） |
| `/` | GET | 无（静态） | 控制台单页；登录 = consoleToken 存 cookie |

- 服务端首次启动生成 `consoleToken` 写入 `<data>/cloud.json`（0600），并打印到 stdout（与网关 admin_token 同模式）。
- 所有端点恒定要求 Bearer；无 token 的静态页之外路径 401。限速：单 IP 60 req/min（内存计数即可）。

### 7.3 SQLite DDL

```sql
CREATE TABLE devices(
  devid TEXT PRIMARY KEY, name TEXT NOT NULL,
  token_hash TEXT NOT NULL,            -- sha256(token)，明文 token 不落盘
  enrolled_at TEXT NOT NULL, last_seen TEXT, client_version TEXT,
  reported_profile TEXT, desired_profile TEXT, desired_ts TEXT
);
CREATE TABLE doc( id INTEGER PRIMARY KEY CHECK(id=1),
  rev INTEGER NOT NULL, envelope TEXT NOT NULL, ts TEXT NOT NULL, by_devid TEXT NOT NULL );
CREATE TABLE paircodes( code TEXT PRIMARY KEY, expires_at TEXT NOT NULL );
```

### 7.4 远程切换语义（desired 状态机）【决策 D3/D4】

1. 手机/控制台 `POST /v1/desire {devid|all, profileId}` → 写 desired + desired_ts。
2. 机器 sync agent 每 60s±20% 抖动心跳；返回体带 desired。
3. 机器应用条件（全部满足才切）：`desired_profile != 当前激活` **且** `desired_ts > sync.json.lastLocalSwitchTs`（防止云端的旧指令覆盖用户在本机更新的手动切换）。
4. 应用 = 复用「应用」按钮的服务端内部逻辑（`src/gateway/` 内既有切换实现，动手前实读），成功后 `lastLocalSwitchTs = now`，下个心跳上报 reported。
5. 本机任何手动切换（UI/CLI）后：`lastLocalSwitchTs = now`，心跳自然把 reported 报上去；云端**不**因 reported 自动改写 desired（desired 只由控制台/`all` 指令写）。
6. 切换失败（如 profile 的 provider 缺 key）：保留现状，心跳 reported 带失败标记，控制台对该设备显示「云端期望 X，本机应用失败」提示。

### 7.5 客户端 sync agent（`src/sync/agent.ts` + `src/cli/sync.ts` 扩展）

```bash
modeldock sync enroll --server https://<ip>:<port> --code XXXX-XXXX   # 交互输同步口令（派生密钥入 sync.json）
modeldock sync status | pause | resume          # 复用 M2 命令，mode=cloud
```

- agent 随网关进程内运行（`gateway/main.ts` 启动时若 `sync.json.mode=cloud` 则以 `setInterval` 挂载；不新开常驻进程，复用网关生命周期与退出清理）。
- 出站请求用 `undici`（已有依赖），超时 10s；连续失败只影响同步状态显示，**绝不影响网关本职**。
- 启动即拉取一次（新机器 enroll 后立即收敛）。

### 7.6 手机轻控制台（`src/cloud/console.ts`）

- 单页三区：**设备列表**（名称/在线点/当前激活服务/云端期望与失败标记）+ **切换**（点设备 → 服务下拉 → 确认；或全选机器批量切）+ **配对码生成**（新机器入网）。只读展示最近 doc 更新时间。
- 手机优先：单列布局、`max-width:480px`、触控目标 ≥44px、系统字号不锁死；无依赖无构建步骤。
- 登录：输入 consoleToken → 存 cookie（HttpOnly、SameSite=Strict）。
- 双语 `data-i18n`；按钮 ≤4 字动词开头（docs-writing 约定）。

### 7.7 部署 runbook（写入 `docs/deploy-cloud.md`，随 M3 交付）

1. **购买**：阿里云 ECS 2C2G 99 元/年档（续费同价），Ubuntu 24.04 LTS，地域就近；安全组仅放行：SSH(22，限自己 IP) + TCP `18443`（示例，可改）。
2. **运行**：`git clone` → `npm ci` → `npm run build` → `node dist/cloud/main.js --port 18443 --host 0.0.0.0 --data /var/lib/modeldock-cloud`。域名非必需（裸 IP + 端口，免备案）；将来上域名（含备案）再切 Let's Encrypt TLS。
3. **systemd**（`modeldock-cloud.service`）：`Restart=always`；`ExecStart` 指向 Node ≥24 的绝对路径与 `dist/cloud/main.js`；`StateDirectory=modeldock-cloud`；给出完整 unit 文本。
4. **备份**：crontab 每日 `node:sqlite` 在线备份（store.ts 内置 `--backup` 子命令执行单文件快照）到 `/var/backups/modeldock-cloud/`，保留 14 天。
5. **升级**：`git pull && npm ci && npm run build && systemctl restart modeldock-cloud`；API v1 内向后兼容演进，破坏性变更升 `/v2`。
6. **安全清单**：仅一个业务端口对外；SSH 密钥登录禁密码；服务器上无其他服务；`cloud.json` 权限 0600；明文 HTTP 阶段的残余风险（token 可被链路窃听者重放——读到的只是密文、写入受 ts 单调性/HMAC 限制为"无法伪造新内容"）在文档明示，TLS 为第一优先升级项。
7. **传输加密路线**：M3 上线允许 IP+HTTP（E2E 兜底）；v1.1 升级：自签/IP SAN 证书（ZeroSSL 支持 IP 证书）或域名+备案+Let's Encrypt。

### 7.8 开工检查单

- [ ] 分支 task-id：`cloud-server-m3`（服务端）→ `sync-agent-m3`（客户端 agent）→ `cloud-console-m3`（控制台），串行合并
- [ ] 必读：`src/gateway/main.ts`（生命周期/退出清理）、`src/gateway/server.ts`（路由风格）、「应用」切换的服务端实现、`AGENTS.md` 端口红线
- [ ] 测试（全部随机端口 + fakeHome，红线）：
  - `test/cloudserver.test.ts`：pair 过期/重放、doc If-Match/409/422 回滚拒绝、heartbeat 更新与 desired 返回、鉴权 401、限速；
  - `test/syncagent.test.ts`：双 fakeHome 机器 + 单服务进程（listen(0)）端到端——A 机改配置 → B 机 ≤2s（测试用短轮询注入）收敛；desired 应用与 `lastLocalSwitchTs` 保护；云端不可达时网关正常伺服；
  - 控制台：node 语法冒烟 + `data-i18n` 键双语齐全（仿 `test/i18n.test.ts`）。
- [ ] 验收（用户参与）：真机 VPS 部署 → 手机浏览器完成一次「看状态 + 切换 + 1 分钟内生效」；拔云端网线，两台电脑网关工作不受影响。
- [ ] 工作量：服务端 2–3 天 + agent 2–3 天 + 控制台 1–2 天 ≈ 1–1.5 周

---

## 8. M4：完善项（按需逐个做）

恢复码（口令遗忘的自救）、同步冲突 UI 化处理、key 轮换/失效提醒同步到控制台、设备吊销与审计页、使用统计可选汇总、`--no-cache-key` 每次启动手输口令模式、TLS 正式证书。

---

## 9. 安全与威胁模型

| 资产 | 对手/途径 | 控制措施 |
|---|---|---|
| 上游 key（明文只在各机器 + 密文在云端） | 云平台/存储商窥探 | E2E（D2）；服务端只见密文 |
| 密文完整性 | 云端被篡改/回滚旧配置 | GCM 认证 + 信封 ts 单调性校验（§4.3）+ 422 拒收 |
| 设备身份 | token 泄露冒充 | token 仅存 sha256；控制台可吊销设备（M4）；限速 |
| 控制台 | token 爆破 | 限速 60 req/min；token 高熵 32B；HttpOnly+SameSite cookie |
| 本机 `sync.json` | 本机恶意软件 | 0600 + 与 secrets.json 同级风险声明 |
| 传输 | 链路窃听（HTTP 阶段） | 密文本身抗读；写入抗伪造；TLS 路线 §7.7-7 |
| 口令 | 遗忘 | 不可恢复（D5），文案明示；M4 恢复码 |

---

## 10. 风险与对策

| 风险 | 对策 |
|---|---|
| VPS 单点故障 | 机器本地兜底配置照常工作（同步只是收敛通道）；每日快照备份；换机=导出/导入（M1 能力）或重指 sync.json |
| syncdoc schema 演进破坏旧客户端 | `v` 字段强校验，不认识即拒用并提示升级；服务端保留全部历史 blob |
| WebDAV 平台差异（M2） | localdir 目标作兜底；接口收窄到 read/write/manifest 三操作 |
| 双机同时改（D6 体验代价） | 冲突快照 + 明确提示；单用户场景低频 |
| 跨境/被墙（若改用 CF 备选） | 不适用（已选国内 VPS）；若 VPS 供应商波动，迁移=数据目录搬移，客户端只改 sync.json 的 url |

---

## 11. 里程碑与发布映射

| 里程碑 | 分支 task-id | 预估 | 交付物 | 发布 |
|---|---|---|---|---|
| M1 | `sync-schema-m1` | 1–2 天 | src/sync/{types,collect,crypto,exportImport}.ts、CLI config export/import、测试×2 | 正常版本（release.md 流程；CHANGELOG 用户视角：「**配置可一键打包迁移**」） |
| M2 | `sync-target-m2` | 2–3 天 | SyncTarget + WebDAV/localdir、sync setup/status/pause、状态行 | 正常版本 |
| M3a | `cloud-server-m3` | 2–3 天 | src/cloud/*、docs/deploy-cloud.md、测试 | 正常版本 |
| M3b | `sync-agent-m3` | 2–3 天 | sync agent、sync enroll、desired 状态机 | 正常版本 |
| M3c | `cloud-console-m3` | 1–2 天 | 手机控制台单页 | 正常版本 |

> 版本号唯一事实来源是 git tag（AGENTS.md「命令速查」），本文不预定版本号。

## 12. 开放问题

1. TLS 证书最终形态（IP SAN 证书 vs 域名+备案）——M3 上线后按用户意愿定。
2. 定时切换规则是否需要「每机差异」（当前决策：规则共享、每机启停独立）——遇到真实冲突需求再议。
3. 使用统计/日志的云端汇总（M4 评估）——涉及隐私面扩大，单独评审。
