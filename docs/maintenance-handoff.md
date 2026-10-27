# 维护性任务交接清单（2026-10-27）

> **2026-10-28 完成收口：T01–T12 全部实施并合入 develop，最终全量测试 79 文件 948 例绿。**择机卡 T10 已实施（注册表 Run 键 + 自分离隐藏启动，schtasks 需管理员实测否决）；PERF-25 的 Phase 2（esbuild 最小化）按卡属可选项维持暂缓，另开卡再做。
> 来源：基于 docs/known-issues.md、docs/backlog.md 与全仓结构盘点（2026-10-27 develop 快照）产出的「**不加新功能**」维护清单，经用户确认拆分为可独立交接的任务卡。
> 用法：每张卡自包含、按 orchestrator 任务卡 schema 写（frontmatter + 目标/验收标准/红线/背景）。**全部 12 张卡已抽为独立文件 `docs/task-cards/T*.md`（与本页同源生成于 2026-10-27，schema 已过 validateCard 校验）**：orchestrator 派发直接 `node .agents/scripts/orchestrator.mjs submit docs/task-cards/T<NN>-<id>.md`，交互 agent 派发直接把对应卡文件交给它；修改任务内容以卡文件为准并回同步本页总览。本页保留全局纪律、批次建议与「不做清单」。
> 注意：文中行号基于审查当日代码，**动手前先读对应源码确认仍成立**（known-issues.md 同款纪律）。

## 0. 全局纪律（所有任务通用，执行 agent 必读）

- **工作流**：一律 `node .agents/scripts/feature-branch.mjs start <task-id>`（task-id 即卡上的 id），编辑/提交/测试全在 worktree 内；完成后 `finish`（rebase → 全量测试 → --no-ff 合并）。
- **测试**：改完 `src/**` 必须 `npm test` 全绿；涉及路径/文件/进程/shell 的改动过一遍 AGENTS.md「工程硬性约定」三平台清单，diff 里显式复查 Windows 分支。
- **known-issues 勾选纪律**：修复 docs/known-issues.md 收录的条目后，回该条目勾选并标注日期与 commit，不删条目。
- **端口红线**：8687（生产）任何形式的访问/测试/改动一律禁止；8890（用户 dev 沙箱）不得占用；手测一律 `MODELRDOCK_FAKE_HOME=<独立目录> npx tsx src/cli.ts gateway start --port 189xx` 成对指定；结束清理自拉进程并核实端口释放（AGENTS.md 硬规则 4）。
- **i18n**：新增任何用户可见文案 zh/en 双语同写（`util/i18n.ts` 的 t()）；Web 端长生命周期组件 label 传惰性函数，传字符串会把语言固化。
- **vitest 隔离模型**：isolate:false 单 fork，同一模块禁止被两个测试文件 vi.mock，禁用 vi.clearAllMocks 做跨用例清场（AGENTS.md「跨文件 mock 是雷区」节）。
- **对外文档**：改 README/usage/CHANGELOG 前必读 `.agents/conventions/docs-writing.md`（用户视角、一条一事、不写内部黑话）。
- **中断交接**：未完成的任务在 worktree 的 `NOTES.md` 留交接（目标/已完成/剩余步骤/如何验证）。

## 1. 任务总览与建议批次

| # | id | 任务 | 类型 | 规模 | 批次 |
|---|---|---|---|---|---|
| T1 | secrets-write-lock | secrets.json 跨进程写锁 | bugfix | 小 | 一 |
| T2 | win-graceful-stop | Windows 网关优雅停机 | bugfix | 小 | 一 |
| T3 | snapshot-orphan-race | 快照孤儿清理竞态 | bugfix | 小 | 一 |
| T4 | split-ui-ts | 控制台 ui.ts 拆分（+可选构建链最小化） | refactor | 大 | 二（先设计后施工） |
| T5 | split-server-ts | server.ts 按域拆分 | refactor | 中 | 三（T4 后） |
| T6 | split-import-sources | import/sources.ts 按源拆分 | refactor | 中 | 三 |
| T7 | sync-cloud-test-gaps | 同步/云中枢测试盲区补齐 | test | 中 | 二（与 T4 并行） |
| T8 | config-reference-doc | config.toml 配置键参考文档（生成式） | docs | 小 | 二（与 T4 并行） |
| T9 | doctor-hardened-checks | doctor 补踩坑检查项 | feature | 中 | 三 |
| T10 | autostart-vbs-migration | Windows 自启 VBS 迁移 | refactor | 中 | 择机 |
| T11 | comment-assertion-fixes | 过时注释改写 + 错误文档断言修正 | docs | 微 | 随手 |
| T12 | archive-point-in-time-docs | 5 份已闭环时点文档归档 | docs | 微 | 随手 |

- **批次一**（T1/T2/T3）：小、独立、验收可机器查——orchestrator 自治闭环的典型好卡，可三卡并行。T11/T12 为注释/文档微修批量，可随手并入任一批次。
- **批次二**：T4 是全仓唯一"越拖越贵"的债，先出 Phase 1 设计稿（拆分粒度与文件布局）经确认再施工；T7/T8 与它无文件交集，可并行。
- **批次三**：T5 排 T4 后（同文件域，避免互撞）；T6、T9 随时可做。

---

## T1 secrets-write-lock

```markdown
---
id: secrets-write-lock
type: bugfix
created_at: 2026-10-27T00:00:00+08:00
created_by: human
files_hint:
  - src/config/secrets.ts
  - src/config/store.ts
  - test/store.test.ts
workflows:
  - feature-branch
gate: L3
---

# 目标
secrets.json 的读-改-写补跨进程锁，堵 CLI `provider set-key` 与运行中网关并发 setSecret 时整表覆盖丢更新。

# 验收标准
- 新增并发回归用例：两个异步执行流（或两个子进程）对同一 FAKE_HOME 沙箱的 secrets.json 并发 setSecret 不同 key，最终两 key 均存在且值正确（现实现会丢一方）
- `npm test` 全绿
- docs/known-issues.md CORRECT-01 条目注记处勾选「跨进程轻量锁已补」并标注日期与 commit

# 红线
- 不改密文格式、不改 keychain/DPAPI/secret-tool 外部后端交互语义（REVIEW-19 修过的"不存在 vs 故障"区分不许回退）
- 不引入新依赖；锁参数（陈锁抢占超时等）沿用 store.ts 现值

# 背景
config.toml 写路径已有两层防护：进程内 promise 串行 + O_EXCL 锁文件 + 15s 陈锁抢占（src/config/store.ts，known-issues §四「已核查无问题」）。secrets.json 的 setSecret / setSecretsBatch / deleteSecret → writeFileSecrets 是无锁整表覆盖（known-issues CORRECT-01 修复注记明确「连带的跨进程轻量锁未实施，仍开放」）。方案二选一：① 把 store.ts 的锁实现抽成公共 util 供两处复用；② secrets.ts 内照抄同型实现。锁文件落 modeldockDir() 下，路径一律 path.join。
```

## T2 win-graceful-stop

```markdown
---
id: win-graceful-stop
type: bugfix
created_at: 2026-10-27T00:00:00+08:00
created_by: human
files_hint:
  - src/gateway/main.ts
  - src/util/fsx.ts
  - src/cli/gatewaycmd.ts
  - test/gateway.test.ts
workflows:
  - feature-branch
gate: L3
---

# 目标
Windows 上 `gateway stop` 不再无条件硬杀：网关进程停机前把日志流缓冲刷盘、运行态收敛做完（known-issues XPLAT-02）。

# 验收标准
- Windows 上 stop 后，最近的请求/审计 JSONL 尾部完整（新增可自动化断言，或交付说明里写明手工验证步骤与结果）
- unix 行为零变化：现有 SIGTERM cleanup 路径（drainAppendStreams / server.close / stopSyncEngine）回归全绿
- `npm test` 全绿（含 CI Windows matrix）
- docs/known-issues.md XPLAT-02 勾选

# 红线
- 不动 sweepGatewayProcesses 的沙箱守卫（CORRECT-05 修复）
- 若走"优雅停机通道"，必须复用现有鉴权（admin 门/凭据），不得新增无鉴权停机面
- 不引入原生依赖

# 背景
`process.kill` 在 Windows 是 TerminateProcess（无信号语义），src/gateway/main.ts 的 cleanup 只有 unix 走得到；appendLine 流池（util/fsx.ts）每流最多 16KB 缓冲未刷即丢。方向二选一（执行时拍板，可叠加）：
A）appendLine 流池加 idle 定时 flush，把最坏丢失窗口从"每次 stop 丢尾部"压到秒级——改动最小、收益独立于停机路径，建议保底做；
B）stop 先走优雅通道（仅 127.0.0.1、带鉴权的内部 shutdown 触发），失败再回退 kill。known-issues 原文提的 CTRL_BREAK 方案评估为收益有限（推测）。
```

## T3 snapshot-orphan-race

```markdown
---
id: snapshot-orphan-race
type: bugfix
created_at: 2026-10-27T00:00:00+08:00
created_by: human
files_hint:
  - src/backup/snapshot.ts
  - test/backup.test.ts
workflows:
  - feature-branch
gate: L3
---

# 目标
快照孤儿清理不再误删他进程"已开写、未写 manifest"的半成品目录（known-issues CORRECT-02）；顺带清掉 id 冲突重试死代码。

# 验收标准
- 新增用例：半成品目录（有内容无 manifest）在宽限期内不被 prune 删除；真正的超龄孤儿仍被清理
- 并发交错用例（两执行流交替 snapshot/prune）互不删除对方半成品
- `npm test` 全绿；docs/known-issues.md CORRECT-02 勾选

# 红线
- manifest 格式不破坏（新增字段需向后兼容：旧 reader 读新目录不报错）
- keep=20 保留语义不变

# 背景
src/backup/snapshot.ts 的孤儿清理以"有合法 manifest"为 valid 判据、其余 rm -rf；跨进程并发（网关 pickerSync/attach 与 CLI 同时写快照）时对方半成品被删 → applyChanges 在写客户端文件前抛错（偶发假失败，无数据损坏）。方向：目录创建时先落 `.incomplete` 占位（manifest 写完后移除），prune 只删"无占位"或"占位超龄"（如 >10min，兜底崩溃残留）的孤儿。死代码：约 :48-55 的 id 冲突重试——`mkdir(recursive:true)` 对已存在目录不抛错，重试永不触发，真撞 id 会静默共用目录互踩（概率≈0）；改为存在性预检 + 重新生成 id，或删掉重试并留一行说明。
```

## T4 split-ui-ts

```markdown
---
id: split-ui-ts
type: refactor
created_at: 2026-10-27T00:00:00+08:00
created_by: human
budget:
  max_turns: 80
files_hint:
  - src/gateway/ui.ts
  - src/gateway/ui/**
  - src/gateway/server.ts
  - test/ui-lint.test.ts
  - test/webui-static.test.ts
workflows:
  - feature-branch
ui_check: true
tier: heavy
gate: L3
---

# 目标
把 4817 行单文件 Web 控制台拆成多文件可维护形态，**行为零变化**；为后续一切 UI 工作铺路（PERF-23/25 随之解决或解绑）。

# 验收标准
- `npm test` 全绿：ui-lint.test.ts（门禁检查目标路径同步更新后，语义/封闭集/对比度规则不变）、webui-static 契约、gateway 套件的 CSP/304/弹层焦点断言（REVIEW-02/14/15/16 修的断言）全部保持
- 浏览器行为零变化：沙箱实例（MODELRDOCK_FAKE_HOME + 189xx 成对指定）手测主流程——服务增删/路由切换/定时面板/各弹层开闭与 Esc/切语言/切主题/手机页
- ui.ts 降为拼装壳（`wc -l src/gateway/ui.ts` < 800）
- Phase 2 若实施：known-issues PERF-25 勾选，并顺手更正 server.ts:2791/2799 的过时体积注释（「236KB」→ UI_HTML 实测 ~313KB；known-issues 原文写的 1087 行是审查当日行号，已漂移）

# 红线
- src 不用 import.meta、运行时不读 fs 拼页面——响应体必须保持"内联常量"形态（known-issues §四「路径穿越无逃逸面」结论依赖此前提）
- data-i18n="中||En" 浏览器机制不动；组件 label 惰性函数规则不动（AGENTS.md 2026-10 pill 教训）
- 模板注入逻辑（token/port 的 replaceAll）原样保留；CSP 基线不改

# 背景
现状单模板字面量 ≈304KB：body 21KB + CSS 45KB + 内联 JS 236KB（其中注释约 29KB）。改一个弹层要在 HTML 模板字符串里定位，多人/多 agent 并行必撞。
- **Phase 1（纯拆分，tsc 兼容，不加构建步骤）**：JS/CSS 拆成独立 TS 字符串模块（`export const`，ui.ts 保留拼装与注入），按域分文件，建议布局：`src/gateway/ui/` 下 overview（轮询与状态行）/ services（服务卡）/ routes（路由与定时）/ clients（接入卡）/ logs / configpack / update / kit（组件层）/ i18n-runtime / styles。
- **Phase 2（可选，随发布构建链）**：esbuild 最小化内联 JS（build-sea 已依赖 esbuild），解决 PERF-25。known-issues 暂缓注记已确认：裸正则剥注释会把字符串字面量剥坏，必须走正规最小化，不宜手写剥离器。
- PERF-23（编辑弹层/拉取模型在数百模型时全量渲染）拆分后模块独立了才好做，且需按 ui-kit 规范先过原型评审——**另开卡，不绑定本卡**。
```

## T5 split-server-ts

```markdown
---
id: split-server-ts
type: refactor
created_at: 2026-10-27T00:00:00+08:00
created_by: human
files_hint:
  - src/gateway/server.ts
  - src/gateway/*.ts
  - test/gateway.test.ts
workflows:
  - feature-branch
gate: L3
---

# 目标
2971 行 server.ts 按域拆分，handler 纯搬移、行为零变化。

# 验收标准
- `npm test` 全绿；gateway 套件断言零改动（纯搬移不应需要改测试）
- 搬移等价性可验证：独立脚本或 diff 方法证明 handler 体与原实现一致（沿袭 backlog C1「逐行比对确认与原 if 块字节一致」的纪律）
- server.ts 保留 http server、鉴权门、ADMIN_ROUTES 路由表装配，明显瘦身

# 红线
- 不重命名、不改逻辑、不改路由表键
- 模块级可变状态（overview 缓存、syncTickets/remoteRequests、设备记忆等）搬移时保持单例语义
- 防循环 import：共享依赖走参数或独立模块

# 背景
backlog C1 已把 admin 门后 45 端点收敛为 ADMIN_ROUTES 表——拆分沿表分组搬 handler 与其私有帮助函数，建议模块：overview-view（buildOverview/buildConfigView 及适配器并行 status）、remote-device（web 设备/远程请求/ticket）、configpack（msync offer/import/nearby）、update-panel（更新链路端点）。**排在 T4 之后执行**（同文件域，避免两卡互撞）。
```

## T6 split-import-sources

```markdown
---
id: split-import-sources
type: refactor
created_at: 2026-10-27T00:00:00+08:00
created_by: human
files_hint:
  - src/import/**
  - test/import-scan.test.ts
workflows:
  - feature-branch
gate: L3
---

# 目标
1197 行的 import/sources.ts（11 个导入源单文件）改为 `src/import/sources/` 目录每源一文件 + registry 汇总导出，此后新增导入源（历史上加得很勤）不再互撞，多 agent 并行零冲突。

# 验收标准
- `npm test` 全绿；import-scan 套件断言零改动
- applyImport 的批内 suggest_id 去重兜底（REVIEW-04 修的 usedIds Set）语义不变，有测试钉住
- 各源沙箱守卫（CORRECT-05 修的 APPDATA 分支 FAKE_HOME 跳过）搬移后语义不变
- 两代 zcode 扫描合并逻辑（REVIEW-24 修的）不变

# 红线
- 各源扫描/解析逻辑逐字搬移；不新增、不删除、不"顺手优化"任何源的行为
- 共享帮手（类型、YAML Document API 操作、路径约定）收进 common 模块，不复制粘贴

# 背景
现 11 源：cc-switch（sqlite）/ claude / dsh / zcode（新旧两代）/ codex / opencode / mimocode / workbuddy / ccr / crush / gemini / one-api（批量渠道，带分页 deadline，PERF-32 修过）。registry 形态参照 adapters/registry.ts 的既有模式。
```

## T7 sync-cloud-test-gaps

```markdown
---
id: sync-cloud-test-gaps
type: test
created_at: 2026-10-27T00:00:00+08:00
created_by: human
files_hint:
  - test/**
  - src/sync/**
  - src/cloud/**
workflows:
  - feature-branch
gate: L3
---

# 目标
补齐 docs/known-issues.md §六尾注记录的三个测试盲区——多机同步与云中枢是核心卖点，恰是回归覆盖最薄的区域（913 例绿 ≠ 这些路径有网）。

# 验收标准
1. **engine 推送部分失败簿记**：三个同步目标（webdav / localdir / cloud）各至少一例"部分条目写失败"，断言：sync.json 错误簿记正确、已成功条目不回退、下一轮 tick 收敛（建立在 REVIEW-06/28 回归网之上）
2. **CloudStore（src/cloud/server.ts）专属用例**：putDoc 畸形 ts 拒收且 422 回滚（REVIEW-27）、token 只存 sha256、配对码 CSPRNG、登录/配对畸形 JSON 不 500
3. **applySyncdoc 半完成态恢复**：应用中断（写了一半 profile/harness）后重放幂等、无悬空引用；REVIEW-26 既定语义（远端删除正激活 profile 后 active_profile 悬空、pickTarget 安全回落）作为**行为**用测试钉住，不改行为

# 红线
- 只加测试，不改产品行为（测试暴露出真 bug 时单独报告，不夹带修复）
- vitest 跨文件 mock 雷区：新测试文件不 vi.mock 已被其他文件 mock 的模块；优先端到端子进程形态（参考 test/reset.test.ts）
- 临时目录 os.tmpdir() + path.join，三平台可跑，不写死 /tmp 或盘符

# 背景
已知问题文档自述：「测试盲区（同步 engine 推送部分失败簿记、CloudStore 专属用例、applySyncdoc 半完成态恢复等）未在本轮补齐，作为后续测试建设方向」。现有相邻回归：test/syncpull.test.ts、test/synctarget.test.ts、test/lansync、test/syncexport、cloudserver 回归——先读它们避免重复造例。
```

## T8 config-reference-doc

```markdown
---
id: config-reference-doc
type: docs
created_at: 2026-10-27T00:00:00+08:00
created_by: human
files_hint:
  - docs/config-reference.md
  - docs/en/**
  - scripts/**
  - src/config/types.ts
  - test/**
workflows:
  - feature-branch
gate: L3
---

# 目标
补上 config.toml 全部可配键的权威参考文档，**生成式**防漂移（config.toml 定位"用户可直编"，但调优键的语义/默认值目前只能读源码）。

# 验收标准
- 生成脚本（或 freshness 测试）保证：src/config/types.ts 中每个用户可配键都在 docs/config-reference.md 有条目；该测试进 `npm test`
- 覆盖以下实测零提及的键（grep 证据 2026-10-27）：headers_timeout_ms / idle_timeout_ms / max_body_mb / log_retention_days / retries / dayFilter（以及 security / backup / update / adapter_packs / lan 各段全部键）
- 每键含：类型、默认值、语义、最小 TOML 示例；分组与 types.ts 结构对应
- 明确边界说明：「config.toml 经程序写入（mutateConfig）是整包重序列化，手写注释与排版会被抹除」（known tradeoff，known-issues CORRECT-03 相邻）
- usage.md §7「配置文件速查」处加链接；docs/en/ 有对应英文文档
- `npm test` 全绿

# 红线
- 写前必读 .agents/conventions/docs-writing.md（用户视角、一条一事、粗体点题、不写内部黑话）
- 不手写后不管：要么脚本生成，要么 freshness 测试兜底，二选一（推荐生成式——先例 catalog-snapshot.generated.ts 的 gen + 对拍纪律）

# 背景
证据（2026-10-27 复核更正）：上述键在 docs/usage.md 与 docs/en/usage.md 的 §7 配置速查**双语同缺**；design.md 与双语 CHANGELOG 已收录（zh:60/93 = en:60/93），不存在 zh/en 漂移。
```

## T9 doctor-hardened-checks

```markdown
---
id: doctor-hardened-checks
type: feature
created_at: 2026-10-27T00:00:00+08:00
created_by: human
files_hint:
  - src/cli/diag.ts
  - test/diag.test.ts
workflows:
  - feature-branch
gate: L3
---

# 目标
把历史踩坑模式沉淀为 `modeldock doctor` 检查项，用户少走手工排障路（doctor 机制已完备：ok/warn/bad/info + DoctorFix 可操作修复）。

# 验收标准
- 先核对 diag.ts 现有检查集（以下条目推测未覆盖，若已覆盖则不重复做，在交付说明里写明核对结论）
- 每个新检查项至少一正一反用例进 test/diag.test.ts；`--json` 输出同步更新；文案走 t() 双语
- `npm test` 全绿

# 新检查项
1. **沙箱自启残留**（known-issues CORRECT-05 遗留清理）：darwin 下 `launchctl print gui/$(id -u)/com.modeldock.gateway` 核对 program 路径是否指向沙箱路径或无效路径 → warn + `--fix` 代清理（bootout）；Windows/Linux 对应自启形态同理核查（若适用）
2. **钥匙环故障 vs 条目缺失区分**：secrets 层语义已修（REVIEW-19：44/空输出=不存在可缓存、故障上抛）——doctor 侧把"读取失败/钥匙环锁定"报 warn + 解锁 hint，不与"未配置密钥"混同
3. **跨机密文引用**：检测 config/secrets 中的异平台密文前缀引用（enc:mach: / enc:dpapi:，REVIEW-18 语义）→ 报"此配置含他机密文引用，请对相应服务重新 set-key"

# 红线
- `--fix` 的写操作遵守沙箱守卫（FAKE_HOME 下只作用沙箱自身）
- 不自动删除任何用户数据——清理动作必须 --fix 显式触发，且删前打印将删内容
```

## T10 autostart-vbs-migration

```markdown
---
id: autostart-vbs-migration
type: refactor
created_at: 2026-10-27T00:00:00+08:00
created_by: human
files_hint:
  - src/autostart.ts
  - test/**
workflows:
  - feature-branch
gate: L3
---

# 目标
Windows 自启从 VBS 迁移到注册表 Run 键或 schtasks，规避 Win11 24H2 起 VBScript 转 Feature-on-Demand、部分企业策略禁 Startup VBS 的弃用风险（known-issues XPLAT-06）。**择机任务**：现状实现正确，风险在未来 OS 演进。

# 验收标准
- 安装/卸载对称，幂等契约测试更新（autostart 相关套件）
- 检测旧 VBS 自启残留并提供迁移/清理路径（对已装用户平滑）
- 三平台自启测试全绿；docs/known-issues.md XPLAT-06 勾选

# 红线
- 沙箱自启守卫语义不变：serviceLabel() 沙箱专属 label（com.modeldock.gateway.sandbox）、windowsStartupPath 沙箱走 homeDir（CORRECT-05 修的）
- 选型记录理由：注册表 Run 键简单但无崩溃拉起；schtasks 有崩溃拉起但实现重——执行时拍板并写进交付说明

# 背景
现状 src/autostart.ts（439 行）Windows 分支用 `%APPDATA%\...\Startup\modeldock-gateway.vbs` + WScript.Shell.Run，注释已如实标注"无崩溃拉起"。launchd（KeepAlive）/ systemd（Restart+linger）均有崩溃拉起，Windows 是唯一缺口——若选 schtasks 可顺带补齐。
```

---

## T11 comment-assertion-fixes

```markdown
---
id: comment-assertion-fixes
type: docs
created_at: 2026-10-27T00:00:00+08:00
created_by: human
files_hint:
  - src/gateway/lan.ts
  - src/gateway/server.ts
  - src/gateway/state.ts
  - src/install/noderuntime.ts
  - README.md
  - docs/**
workflows:
  - feature-branch
gate: L3
---

# 目标
改写与代码矛盾的注释/文档断言（E 类「改写优先于删除」），删一处编辑残留；来源为 2026-10-27 注释健康度审计。

# 逐项清单（动手前逐处核对代码再改写）
1. src/gateway/lan.ts:801 — 注释「~63KB HTML」→ 实测 renderMobilePage 模板 ~50KB + 注入 ~1.5KB ≈ 52KB，改数字留设计意图
2. src/gateway/server.ts:2791/2799 — 两处「236KB」→ UI_HTML 实测 ~313KB（与 T4 Phase 2 联动，T4 做了就归 T4）
3. src/install/noderuntime.ts:141-143 — JSDoc「解压包内顶层目录名（nodeInnerDirName）」挂在了 144 行 nodeStageDirName 头上（实际描述的是 148 行的 nodeInnerDirName），归位
4. src/gateway/state.ts:561 — pickTarget 内与 :570 逐字重复的「避开窗口」行（编辑残留；570 才是带钉住豁免的生效版，删 561 前先核对）
5. README.md:87 与 docs/en/README.md:87 — `modeldock use <profile>` 命令不存在，实际为 `profile use <name>`（CLI 抽查 6 个唯此错）
6. docs/usage.md 与 docs/en/usage.md §10 — 基线日期「2026-10-18」未随 10-27 更新；目录锚 `#10-当前实现状态v100` 仍指 v1.0.0 旧标题
7. docs/design-i18n.md — 「约 600 条 t()」实测 ~1644，改为「以 src/util/i18n.ts 现状为准」或标注快照@commit
8. AGENTS.md「测试指南」— 套件清单只列 5 个（store/backup/adapters/gateway/util），test/ 实有 75 文件；命令表补 `test:workflow` / `test:coverage`（package.json 已有）

# 验收标准
- 每处改写前先核实代码真实行为；`git diff` 只含注释行与文档行，无代码变化
- `npm test` 全绿（含 webui-static / ui-lint 门禁不受影响）
- 治理约定沉淀：口径类数字（测试数、t() 条数）一律不写死——写「以 npm test 输出为准」或标注「快照@commit」（本仓已见 771/926/913/914/915 五个测试数版本并存，usage.md:320 与 docs/en/usage.md:320 的 914 也是其中之一，随本次一并处理）

# 红线
- 只改注释行与文档行；presets/data.ts 的「2026-10 核对」日期戳、noderuntime.ts:16-17 版本依据等踩坑记录类注释一律不动（保留集合）
```

## T12 archive-point-in-time-docs

```markdown
---
id: archive-point-in-time-docs
type: docs
created_at: 2026-10-27T00:00:00+08:00
created_by: human
files_hint:
  - docs/**
  - docs/known-issues.md
  - docs/design.md
  - test/webui-static.test.ts
workflows:
  - feature-branch
gate: L3
---

# 目标
建 `docs/archive/`，把 5 份已闭环的时点记录移入归档，同步修正全仓引用路径，让 docs/ 只剩活文档。

# 归档对象（2026-10-27 审计结论：内容已闭环、时点性质）
- docs/release-review-2026-10-12.md（8 P1 + 18 P2 全部闭环；known-issues.md 有两处引用 CORRECT-04→§五，改路径）
- docs/test-plan-handoff.md（384 行时点方案，零引用，926 例口径已过期；测试盲区已由本清单 T7 接棒）
- docs/web-testing-plan.md（方案已消费，L0/L2 已落地；design.md 与 test/webui-static.test.ts、test/webui/dom.test.ts 头注释引用，改路径）
- docs/engine-smoke.md（20 行时点冒烟记录，零引用）
- docs/redundancy-design.md（BUG/DRIFT/DUP 全勾选闭环，C1 路由表化已在 server.ts:2652 落地）

# 验收标准
- 用 `git mv` 移入 docs/archive/（保留历史）
- 全仓 grep 无断裂引用：known-issues 两处、design.md 一处、两个测试文件头注释，全部指向新路径
- docs/known-issues.md 与 docs/backlog.md 头部各加一行归档说明（指向 docs/archive/）
- `npm test` 全绿

# 红线
- 归档内容保持原样不改写（时点记录的价值在于原貌）；只改路径引用
- 活文档（usage/README/AGENTS/known-issues/backlog/design*.md/ci-bots 等）一律不移
```

---

## 2. 明确不做（维持现状，勿翻案）

| 项 | 不做理由 |
|---|---|
| PERF-15 / 21 / 27 / 28 / 36 | known-issues §一.F 复核后暂缓，理由成立（低频路径 / 收益不抵扰动 / 需专项设计） |
| PERF-23 | 待 T4 拆分后另开卡（需按 ui-kit 规范先过原型评审） |
| backlog B1 / B3 / C4 | 已评估放弃（2026-10-25），重启条件已写明 |
| XPLAT-09 / XPLAT-11 | 设计取舍留档 / 推测且项目门槛 Win10+ 无碍 |
| REVIEW-26 | 复核为既定设计语义，留档不改（测试钉住见 T7） |
| vitest isolate:false 单 fork | 跨文件 mock 约束已有成熟规避法，改真隔离风险大于收益 |
