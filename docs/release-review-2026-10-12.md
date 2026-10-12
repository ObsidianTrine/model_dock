# 发布前全面审查报告（2026-10-12）

> 审查对象：develop@b3e61b0（准备发布 v1.0.0 之后的下一版）。
> 审查方式：四分区并行专家审查（网关与云端安全 / CLI 与适配器 / 同步·更新·配置·构建发布链 / 文档·测试·发布内容盘点），关键论断逐条人工到源码复核；已先读 [known-issues.md](known-issues.md) 与 [backlog.md](backlog.md)，**不重复已收录条目**。行号基于 b3e61b0，动手前先读对应源码确认。
> 维护约定：修复某项后在总览表勾选并标注 commit；本报告与 known-issues.md 不互相搬运条目，引用编号即可。

## 修复状态（2026-10-12 当日闭环）

全部 **8×P1 + 18×P2 + CORRECT-04 根因修复**已完成， develop 全量 776 例绿（另 4 例按平台跳过）：

| 提交 | 内容 |
|---|---|
| @85558ca（rd-fix-gateway-cloud） | CORRECT-04（全天窗口死亡分钟，`e===1439` 含入 + 回归用例）、P2-06（LAN 请求体上限）、P2-07（云 token safeEqual） |
| @5912104（rd-fix-cli-adapters） | P1-01（direct 切回清 ANTHROPIC_API_KEY）、P2-01（dsh 等值过滤）、P2-02（还原原子写）、P2-03（applyChanges 跨进程锁）、P2-04（attach 透传 fromMode）、P2-05（自拷贝守卫）、gateway log 描述（P1-04 代码侧） |
| @e22264c（rd-fix-sync-update-build） | P1-02（detectInstallShape 补传 LOCALAPPDATA + 回归用例）、P1-03（release.yml 去双重 ISCC + Verify checksums 门）、P2-08（锁抢占双 stat 复核）、P2-09（webdav readBlob 越界校验）、P2-10（Node 工具链 SHASUMS 校验 + 超时）、P2-11（desiredTs NaN 防绕过）、P2-12（sync.json 跨进程锁）、P2-13（PowerShell 元字符守卫）、P2-14a（口令强度提示） |
| 文档收口（本提交） | P1-04/05（README+usage 命令修正）、P1-06（CHANGELOG 补记，中英双语）、P1-07（usage §4 ZCode）、P1-08（usage §10 基线）、P2-14b（AGENTS.md 注释取舍落档）、P2-15（三处清单补 MiMo 桌面端）、P2-16（macOS 标注）、P2-17（design-cloud-sync 路径）、P2-18（快照承诺措辞对齐 CORRECT-03 边界）、known-issues CORRECT-04 回写 |

未做（建议项，非缺陷）：SUG-01（FUNDING.yml / CODE_OF_CONDUCT.md 社区文件）、SUG-02（5 个中风险模块测试补盲：sync/targets/cloud.ts、adapters/generic.ts、provider-json.ts、registry.ts、cli/harness.ts）。

P2-11 的专用单测未补：cloudHeartbeat 走真实云端协议，畸形 desiredTs 需 mock undici（vitest singleFork 跨文件 mock 雷区），守卫为 2 行防御性判断，经代码审查验收。

## 一、总体结论

**无 P0 发布阻断**。机器门禁全绿（771 测试通过 + 4 跳过 / npm audit 0 漏洞 / tsc 零错误 / npm pack 无泄漏），架构与安全面经专项审查未发现新漏洞。共发现 **8 项 P1 + 18 项 P2 + 2 项建议**：P1 中 5 项是对外文档缺陷（错误命令示例、CHANGELOG 漏记，约半小时可收口），3 项是小改动代码缺陷（均给出明确修法）；另有 **CORRECT-04 根因已定位**（known-issues 遗留的午夜测试红灯悬案，实为「死亡分钟」语义问题，附修法）。文档收口 + 3 个小修复完成后即可进入 [RELEASE_CHECKLIST](RELEASE_CHECKLIST.md) 流程。

## 二、发布就绪基线（2026-10-12 实测）

| 项 | 结果 |
|---|---|
| `npm test`（node v24.20.0） | ✅ 62 文件 771 通过 + 4 跳过，222s |
| `npm audit --omit=dev` | ✅ found 0 vulnerabilities |
| `npm run build`（tsc） | ✅ 零错误 |
| `npm pack --dry-run` | ✅ 108 文件全部在 dist/ 下（files 仅 dist），无源码/测试泄漏 |
| git 状态 | ⚠️ develop 领先 origin/develop **57 提交未 push**；唯一 tag v1.0.0；CHANGELOG 有「未发布」段待收口 |
| `node --check scripts/*.mjs` | ✅ 全部通过 |

## 三、P1（建议随本版修复）

- **P1-01 [安全] claude-code 直连切回网关后 `ANTHROPIC_API_KEY`（真实上游 Key 明文）残留客户端配置**
  - 位置：`src/adapters/claude-code.ts:165-171`（direct 写入）、`:279-293`（gateway 分支 fromMode 清理清单）、`:382-386`（planDetach）
  - 现状：direct 按 `auth_style==='x-api-key'` 写 `env.ANTHROPIC_API_KEY = d.key`；切回网关的清理只删 `ANTHROPIC_MODEL`/TIER 键/SUBAGENT/EFFORT/`root.model`，全文件无路径删 `ANTHROPIC_API_KEY`；planDetach 只删 `ANTHROPIC_AUTH_TOKEN`。direct 分支自己的注释写明要「避免客户端拿旧的凭据变量先用错」，gateway 回切路径漏了对应清理。
  - 影响：x-api-key 型上游（如 Anthropic 官方）直连后切回网关，真实 Key 一直留在 settings.json；随后 detach 也残留。每次请求该 Key 还会作为 x-api-key 头发给本机网关（鉴权不受影响，凭据多一圈无谓暴露）。
  - 建议：gateway 分支 `fromMode==='direct'` 时补 `delete env.ANTHROPIC_API_KEY`（直连键是我们写的，删除安全；planDetach 不动以免误删用户自有凭据）。

- **P1-02 [更新链] Windows 安装器用户自更新形态永远误判为 win-bare，setup.exe 静默安装分支成死代码**
  - 位置：`src/update/run.ts:108`、`src/update/webupdate.ts:146`（根因 `src/update/install.ts:100-115`）
  - 现状：两处生产调用均为 `detectInstallShape(execPath, platform)`，漏传第三参 `localAppData`；函数内回落占位值 `'C:\\Users\\u\\AppData\\Local'`，真机 execPath（`C:\Users\<实际用户名>\...`）永不匹配 → 返回 `'win-bare'`。全仓只有测试传了第三参（test/update.test.ts:239）。
  - 影响：Inno 安装的用户 `modeldock update` 会下载 zip 裸替换主程序——跳过安装器（卸载登记/版本信息过期）、`ModelDockTray.exe` 不随更新（版本漂移）。网关本体仍能更新，故非 P0。
  - 建议：两处调用补传 `process.env.LOCALAPPDATA`（webupdate 的 `matchedAssetSize` 处同修），补一条「用户名 ≠ u」的真机形态用例。

- **P1-03 [发布链] release.yml 与 build-sea.mjs 对 setup.exe 双重 ISCC 构建，SHA256SUMS 锚定的是第一次产物**
  - 位置：`.github/workflows/release.yml:68-75`（第二次 ISCC）vs `scripts/build-sea.mjs:300,872-917`（build-sea 内部已跑一次 ISCC）+ `:303,1038-1055`（writeSums）
  - 现状：win32 job 中 build-sea 先构建 setup.exe 并写 `SHA256SUMS-win32-x64`；随后 workflow「Build Windows installer」无条件再跑一次 ISCC 覆盖同一产物，上传的是第二次产物。
  - 影响：Inno Setup 不承诺逐字节可复现输出——两次产物若有差异，发布的 SHA256SUMS 与 setup.exe 资产不一致，`verifyChecksum`（update/check.ts:310）会让 win-setup 自更新永久「校验失败」；发布后无步骤复核一致性。附带：步骤内 choco 兜底装在第二次构建前，对 build-sea 内第一次构建无效（ISCC 缺失会直接 err 退出）。
  - 建议：删除 workflow 的重复 ISCC 调用（choco 兜底前移到 build-sea 之前）；或第二次构建后重算 sums；至少在 release job 加一步「校验各资产哈希 ∈ SHA256SUMS」。

- **P1-04 [文档] README/usage 引用了不存在的命令 `modeldock logs`**
  - 位置：`README.md:83`、`docs/usage.md:119,120`；`src/cli/index.ts:155` 描述「（同 logs）」也指向它
  - 现状：CLI 只有 `modeldock gateway log`（index.ts:154），全仓从未注册过 `logs` 命令（`git log -S "command('logs')"` 无结果）。用户照文档复制粘贴直接报未知命令。
  - 建议：三处改 `modeldock gateway log -f`，顺手改掉 index.ts:155 描述里的「同 logs」。

- **P1-05 [文档] README/usage 引用了不存在的命令 `modeldock provider refresh`**
  - 位置：`README.md:87`、`docs/usage.md:186,299`（§9 故障排查表）
  - 现状：实际命令是 `modeldock model refresh <providerId>`（src/cli/index.ts:70,86，v1.0.0 起即如此）。拉模型、排 404 两条最常用路径的示例失效。
  - 建议：三处统一改 `modeldock model refresh <id>`。

- **P1-06 [文档] CHANGELOG「未发布」段漏记 2026-10-12 批量用户可见修复**
  - 位置：`CHANGELOG.md:5-12`（现仅 4 条托盘/弹窗条目）对照 `git log v1.0.0..HEAD`（58 提交，其中 9 个非合并 fix/perf）
  - 现状：已实现未收录的用户可见项（补记时按 docs-writing 翻译成用户语言）：另一进程换 Key 后网关发旧 Key（CORRECT-01）、大请求体不再阻塞转发（PERF-01）、配置锁与密钥文件并发/损坏处理（BUG-06/07/08）、presets.json 损坏崩溃与视觉能力误判（BUG-12/13）、dsh 断开误删用户条目等（BUG-01/09/10）、一键更新卡死与网关崩溃（BUG-02/11/14）、同步监视崩溃兜底（BUG-03）、命令行与网页「添加服务」行为统一（DRIFT-01/03）、Windows 路径显示/config edit 引号/文案双语（XPLAT-03/05/08）。反向核对：未发布段现有 4 条均已落地，无「写了没做」。
  - 建议：①补记上述项（DUP/DEAD/DESIGN 纯内部重构不进）；②第 1-2 条托盘修复实为 macOS 专属（只改了 ModelDockTray.swift），加平台限定；③打 tag 前归并为版本段 + 日期 + 文末链接表行。

- **P1-07 [文档] usage.md §4 ZCode 接入行为描述过期（文件与条目 ID 双错）**
  - 位置：`docs/usage.md:100`
  - 现状：写的是「在 `~/.zcode/v2/config.json` 新增 `builtin:modeldock` 条目」；实际现行写 `~/.zcode/v2/provider_config.json`（热加载），`config.json`+`builtin:modeldock` 是被清理的 legacy 形态（src/adapters/zcode.ts:24-30,131-132）。
  - 建议：按 zcode.ts 现行实现改写（可补一句「旧版写入条目会被自动清理」）。

- **P1-08 [文档] usage.md §10 基线数字与实现状态过期**
  - 位置：`docs/usage.md:305,309,311`
  - 现状：305 标题钉死 v1.0.0；309「测试 641 例全绿（47 个文件…）」≠ 实测 62 文件 771 通过 + 4 跳过；311「计划中」列有「网关侧 /v1/models 合成」——该能力已随 v1.0.0 交付（src/gateway/server.ts:525-530，CHANGELOG.md:27 已宣传），§10 自相矛盾。
  - 建议：305/309 按发布版本号与实测更新；311 删「网关侧 /v1/models 合成」（其余计划项与现状吻合）。

## 四、P2

### CLI / 适配器 / 快照

- **P2-01** dsh「内容一致守卫」永不生效：稳态下每次全局切换仍全量重写 + 快照。`src/ops.ts:384-388` 守卫要求 `plan.changes.length === 1`，而 dsh planAttach 无条件 push cred 变更（dsh.ts:531-541）恒为 2 条——zcode/codex/claude-code/workbuddy 均有等值跳过，唯 dsh 违例。快照滚动池被无变化快照占用。建议仿 zcode 做等值过滤。
- **P2-02** `restoreSnapshot` 直接 `writeFile` 还原客户端文件，非原子写（`src/backup/snapshot.ts:139`）——全仓唯一绕过 atomicWrite 的客户端写点，且发生在「恢复」这一最脆弱时刻。改走 `atomicWrite`（fsx.ts 已导出）。
- **P2-03** 并发 attach 无跨进程锁：两个进程对同一未登记 harness 并发 attach 各自生成随机 token，乐观锁都可能放行，最终「文件里的 token」与「config 登记」可能失配 → 该客户端 401 直到下次同步自愈（`src/adapters/engine.ts:84-104`、`src/ops.ts:519`；CORRECT-02 的写入侧另一半）。建议按 harness id 加 `withFileLock`。
- **P2-04** 重新 attach 不透传 `fromMode`：对 mode='direct' 的客户端直接 `modeldock attach <id>`（doctor 也这么提示），网关分支跳过直连遗留清理 → 残留钉死模型映射 env，表现为「切了路由但模型不变」（`src/ops.ts:520-531,741`）。建议 planAttach 从 `cfg.harness[id]?.mode` 默认透传 fromMode。
- **P2-05** `installByCopy` 无「目标即自身」守卫（Windows，推测）：从 PATH 副本运行且就地更新过时，对运行中 exe 自拷贝静默失败、marker 永不更新（`src/cliinstall.ts:69-88`，cli.ts:113 空 catch 吞错）。入口加 `path.resolve` 相等即返回。

### 网关 / 云端

- **P2-06** LAN `/m/api/switch`、`/m/api/auto-route` 请求体无上限：鉴权后 `for await` 全量入内存，同文件其余端点走 `readJsonBody`（5MB 上限）唯这两处漏网（`src/gateway/lan.ts:852-853,887-888`）。持令牌者可把网关进程打出 OOM，纵深防御项，改 readJsonBody 即可。
- **P2-07** 云中枢 console token 用裸 `===` 比较，非常数时间（`src/cloud/server.ts:134,343`）——云端最高价值凭据，与本仓「高价值凭据一律 safeEqual」口径不一致（128-bit token + 60 req/min 限速下实际可利用性低）。两处换 `safeEqual`。

### 同步 / 更新 / 构建链

- **P2-08** 陈锁抢占双持锁竞态：A 判陈旧后、unlink 前 B 已重建新锁，A 无条件删掉 B 的新锁后双方同时进临界区（`src/util/fsx.ts:249-263`）。毫秒级窗口、触发概率极低，一旦发生即 config/secrets 丢更新。建议改「rename 到唯一临时名再删」。
- **P2-09** WebDAV `readBlob` 缺 blobRef 越界校验：`encodeURIComponent` 不编码 `..`，manifest 里的 `../../x` 可读同步根之外（`src/sync/targets/webdav.ts:88-94`；localdir.ts:10-16 有校验，不一致）。内容须过解密才可用，实际危害≈0，对齐补校验即可。
- **P2-10** 构建期交叉下载的 Node 工具链无完整性校验、无超时：`fetch` 直落盘注入 SEA，不比对 nodejs.org SHASUMS256，缓存永不复核（`scripts/build-sea.mjs:25-29,122-129`）。整条更新链信任根建立在它上面，属构建供应链纵深防御：下载后核对 SHASUMS256 + 加超时。
- **P2-11** cloudHeartbeat 对非法 desiredTs 放行时间戳保护：`Date.parse` 返回 NaN 时 `NaN <= lastSwitchMs` 恒 false，畸形时间戳反而绕过「云端旧指令不得覆盖本机新切换」（`src/sync/engine.ts:147-148`）。改 `Number.isFinite` 显式判断。
- **P2-12** sync.json 读改写无跨进程锁（config.toml/secrets.json 均有，唯它没有，`src/sync/state.ts:107-117`）——丢的多是簿记字段，可自愈；复用 `withFileLock` 对齐语义。
- **P2-13** `extractArchive` win32 分支仅防引号，未防 PowerShell 插值元字符 `` ` ``/`$(`（`src/update/transfer.ts:122-128`）。需攻击者控制所配 repo 资产名才可达，守卫扩为 `/["`$]/`。
- **P2-14** 同步口令无强度提示（4 位纯数字也接受，`src/cli/sync.ts:20-33`）；config.toml 程序写入静默抹掉用户注释（`src/config/store.ts:85-87`，疑为既有取舍）——口令加非阻断提示；注释取舍落档 AGENTS.md 或 known-issues。

### 文档

- **P2-15** 三处适配器清单漏「MiMo 桌面端」：`README.md:20`、`docs/usage.md:14`、`CHANGELOG.md:76`（registry.ts:19 内置 9 个 adapter 含 mimo-desktop；README.md:8 能力清单反而有它，前后不一致）。
- **P2-16** CHANGELOG 托盘「清理完成」条目中 `~/Library/Logs/ModelDock` 为 macOS 专属路径未标注，Windows 用户找不到（`CHANGELOG.md:9`）。
- **P2-17** design-cloud-sync.md §7.5 引用不存在的 `src/sync/agent.ts`，实际在 `src/sync/engine.ts`（`docs/design-cloud-sync.md:326`）。
- **P2-18** README「每次写入前自动快照」承诺与 CORRECT-03 边界差（config.toml 无写前快照，`README.md:12`、`docs/usage.md:18`）——暂不改文案亦可，CORRECT-03 修复后自然对齐。

### 建议（非缺陷）

- **SUG-01** 开源社区文件可补 FUNDING.yml / CODE_OF_CONDUCT.md（SECURITY.md / CONTRIBUTING.md / ISSUE_TEMPLATE / PR 模板均已齐）。
- **SUG-02** 测试补盲（零直接覆盖 20 模块中的 5 个中风险项）：`src/sync/targets/cloud.ts`（enroll→cloud target 入网链路）、`src/adapters/generic.ts`、`src/adapters/provider-json.ts`（通用 env 用户可达路径）、`src/adapters/registry.ts`（坏 pack 兜底）、`src/cli/harness.ts`（attach/detach CLI 壳）。其余零覆盖均为 CLI 命令壳与小工具，可接受。

## 五、CORRECT-04 根因定位（可确定性修复）

**不是午夜 00:00 边界，是「end 不含」在分钟粒度下的 23:59:00–23:59:59 死亡分钟。**

- 位置：`src/gateway/state.ts:284-285`（`if (s < e) { if (t < s || t >= e) continue; ... }`），`parseHHmm('23:59') = 1439`
- 反例推演：窗口 `00:00–23:59`（s=0, e=1439）。① 23:59:08 执行时 t=1439，`t >= e` 成立 → 窗口 skip → `activeScheduleWindow` 返回 null → displayRouteProvider 回落 active_profile，恰杀掉全量 5 例红（adapters.test.ts:2353、gateway.test.ts:1564/1871/3318/3330、lan.test.ts:134）；② 00:00:08 执行时 t=0，两个条件都不成立 → 窗口判定活跃，不可能红；③ 复测 23:50（t=1430）与 00:03（t=3）均活跃全绿。三点共同锁定：红灯当次运行的相关用例必然落在 [23:59:00, 00:00:00) 执行。
- 影响不止测试：用户把「全天」写成 `00:00–23:59`（UI 与测试里最自然的写法）时，每天 23:59:00–23:59:59 的请求会回落 base 路由。一般窗口的最后一分钟不活跃是文档化「end 不含」语义，但 23:59 作「当天结束」惯例与它冲突。
- 修法（二选一）：命中条件改 `t >= s && t <= e`（相邻窗口重叠 1 分钟，「按配置顺序取首个命中」保证确定性）；或仅对 `e === 1439` 特判为当天含入。补「now=窗口起止端点」注入时钟单测。修完回 known-issues.md 勾选。

## 六、既有开放项盘点（本轮未重审，详见各文档）

| 来源 | 开放项 |
|---|---|
| known-issues.md | PERF-02/03（暂缓待专项设计）/13/14/15/16、XPLAT-02/06/09/11、CORRECT-02/03、**CORRECT-04（本报告 §五已给根因与修法）**、secrets 跨进程轻量锁（CORRECT-01 连带，仍开放） |
| backlog.md | B1（纯透传流式化）、B2（连接错误重试策略，需拍板）、B3（joinUpstreamUrl 缓存）、C1（handleAdmin 路由表化）、C3（/model-catalog ETag）、C4（safeEqual 长度预比较） |

均不构成本版阻断；P0/P1 级已全部修毕或在本报告收编。

## 七、已核查无问题面（后续审查可跳过）

- **网关管理面鉴权链闭合**：Host 白名单（防 DNS rebinding，连 GET 也拦）+ admin token sha256 + timingSafeEqual + SameSite=Lax cookie，全部写端点均 POST 且在 admin 门内，无读端点夹带写副作用。
- **ui.ts（4236 行）渲染面 esc() 覆盖完整**：72 处转义逐一核对无漏、外链先过 esc 且仅 http(s)、弹层 msg 槽位与 toast 分流合规。
- **出站转发凭据剥离彻底**：relay.ts 系统性剥 `host/authorization/x-api-key/cookie/x-modeldock-*`；failover 仅传输层失败与额度类错误改发、切换前排空响应体（防重复计费）。
- **同步加密链设计扎实**：PBKDF2-600k → HKDF 64B 双键分离（encKey/macKey）→ AES-256-GCM + HMAC（绑定 ts‖ct）+ verifier 区分口令错/篡改；冲突「远端胜 + 本地快照、绝不自动合并」。
- **更新链信任根纪律严格**：SHA256SUMS 永走官方 API、镜像只加速（browserUrl 前缀校验防第三方镜像）、令牌不进镜像、尺寸基线 + 强校验不过即删、资产名穿越校验（XPLAT-10 已修）。
- **release-check.mjs 与 RELEASE_CHECKLIST.md 逐项一致**；build-sea 版本号 tag→临时改写→还原 finally 纪律、11 资产矩阵核对无误；migrate() 12 个顶层字段与 Config 类型逐一比对无遗漏。
- **npm pack 无泄漏、README 下载文件名 8 种与产物一致、macOS 13.0+ 与 LSMinimumSystemVersion 一致、AGENTS.md「已知限制」4 条仍成立、deploy-cloud.md 占位 IP 已标注 RFC 5737 可替换**。
- 其余见 known-issues.md §四「已核查无问题项汇总」。

## 八、发布前收口清单（按序执行）

1. **文档修正**（P1-04/05/07/08、P2-15/16/17）：README 两处命令、usage 命令/§4/§10、适配器清单补 MiMo 桌面端、design-cloud-sync 路径。
2. **CHANGELOG 收口**（P1-06 + P2-16）：补记 2026-10-12 用户可见修复（macOS 条目加限定）→ 打 tag 前归并「未发布」为版本段 + 日期 + 文末链接表行（release 门禁 ✗ 项）。
3. **随本版代码修复**（均小改动，走 feature-branch）：P1-01（补一行 delete）、P1-02（补传 LOCALAPPDATA + 用例）、P1-03（release.yml 去重或复核哈希）、CORRECT-04（§五修法 + 注入时钟单测，终结午夜红灯悬案）。P2 按需，不阻断。
4. **收尾验证**：`npm test` 全绿 → `node scripts/release-check.mjs v<next>` 全量（含密钥扫描 / engines 钉版 / main 无缺失提交等门禁）。
5. **push develop**：57 提交未 push，发布前推远程备份（release-check 有 ⚠ 提示项）。
6. **提交本报告**（当前未提交，提交前工作区即恢复干净，满足门禁「工作区干净」）。
7. 版本号由用户拍板（semver：本轮以修复为主，建议 patch；agent 不得自行决定）。

---

## 附录：审查分区与方法

| 分区 | 覆盖 | 结论 |
|---|---|---|
| 网关 + Web 控制台 + 云端 | src/gateway/**、src/cloud/**、util/safe-equal、util/net | 无 P0；2×P2 + CORRECT-04 根因 |
| CLI + 适配器 + 客户端文件 | src/cli/**、src/adapters/**、import/backup/ops/autostart/cliinstall/install | 无 P0；1×P1 + 5×P2 |
| 同步 + 更新链 + 配置存储 + 构建发布链 | src/sync/**、src/update/**、src/providers/**、src/config/**、src/util/**、package.json、scripts/**、.github/workflows | 无 P0；2×P1 + 7×P2；audit 0 漏洞、build 零错误 |
| 文档 + 测试覆盖 + 发布内容盘点 | README、CHANGELOG、docs/**、AGENTS.md、test/**、npm pack | 无 P0；5×P1 + 4×P2；覆盖 78/96 模块 |

关键论断（P1 全部 8 条）已由主会话逐条到源码复核确认（含 grep 实证 `logs`/`provider refresh` 不存在、detectInstallShape 签名与调用点、release.yml:68-75 双重 ISCC、claude-code 清理清单），非单源转述。
