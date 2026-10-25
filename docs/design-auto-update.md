# ModelDock 自动更新详设与演进路线

| 文档属性 | 内容 |
|---|---|
| 当前版本 | **v1.0 · 发布基线（M1/M2 已发布、M3 暂缓待 VPS）** |
| 对齐实现 | 公开仓库 v1.0.0（git tag，2026-10-11 发布；M1/M2 已随该版本发布）；develop 分支 |
| 作者 | ObsidianTrine |
| 日期 | 2026-10-11 |
| 性质 | **决策记录 + M1/M2 实施基准**（M3 为路线规划，动手前重新对齐） |

**版本历史**

| 版本 | 日期 | 说明 |
|---|---|---|
| v1.0 | 2026-10-11 | 初版（随公开仓库 v1.0.0 发布）：业界调研结论、feed 演进决策（公开 releases 仓库匿名直连 → VPS 自建源）、M1 详设（发现/下载/校验/按平台替换/重启）、安全与测试门；实施状态——M1/M2 已全部实施并随 v1.0.0 公开发布（M2 第 1–2 项按新前提作废），M3 维持规划、后续启动（触发条件不变） |

**评审记录**

| 评审人 | 日期 | 结论 | 意见摘要 |
|---|---|---|---|
| ObsidianTrine | 2026-10-05 | 通过 | M1 先走 PAT 私有直连；功能做好后迁公开 releases 专用仓库；买了 VPS 后再迁自建源，三阶段计划写入本文 |

---

## 0. 如何使用本文（AI 实施须知）

- 本文是自动更新功能的**实施基准**。AI 接手任一里程碑：先读本文对应章节 + `AGENTS.md` 全文，再读该章「必读源码」，然后按任务清单逐项执行。
- 标注 **【决策】** 的条目是用户已拍板的结论，**不得擅自更改**；实施中发现决策不可行，停下来向用户说明，修订本文并重新确认后再动代码。
- 所有代码改动一律走 `.agents/workflows/feature-branch.md` 工作流；本文档本身的修订（develop 上）可直接改。
- 用户可见文案一律走 `src/util/i18n.ts` 的 `t(中文, English)` 双语（规范见 `AGENTS.md`「工程硬性约定·双语文案」）。
- 本文引用的模块路径已对照 develop 源码核实到函数级；**实施时签名以实读源码为准**。

## 1. 背景与目标

### 1.1 用户痛点

发新版后，用户需手动打开 GitHub Releases 页 → 认证 → 找到对应平台的包 → 下载 → 按安装方式重装（mac 拖 DMG / win 跑 setup / 解压覆盖）。版本一多这成为高频负担，且容易漏装、装错平台。

### 1.2 目标

- **M1（本文详设）**：`modeldock update` 一条命令完成「检查 → 下载 → 校验 → 替换 → 重启」，mac 真实场景全链路可用。
- **M2**：Web 控制台「检查更新」入口 + 托盘菜单项 + 启动检查提示；更新源迁公开 releases 专用仓库（镜像回退链生效，摆脱 PAT）。
- **M3**：更新源迁自建（VPS / R2），与云同步基础设施合流。

### 1.3 非目标

- 不做静默自动安装（检查后必须用户确认才安装；Claude Code 式静默装与本项目「用户掌控配置」的定位冲突）。
- 不做多版本共存与一键回滚 UI（保留 `.old` 旧版目录 + 手动恢复指引即可）。
- 不做增量更新（SEA 单文件约 40–80 MB，全量包可接受）。

## 2. 业界调研结论（2026-10-05）

| 软件 | 机制 | 可借鉴点 |
|---|---|---|
| cc-switch（Tauri） | tauri-plugin-updater：`latest.json` manifest（version/notes/platforms→{signature,url}）+ minisign 验签；**自建 Cloudflare R2 镜像（dl.ccswitch.io）置顶、GitHub Releases 兜底**，CI 用 sync-r2.yml + rewrite-updater-manifest.mjs 同步改写 | M3 形态参照：自建源置顶 + GitHub 兜底；mac 用 .tar.gz 整包换 .app、win 用安装器静默装；安装失败回退打开 releases 页 |
| Claude Code | 自有 CDN manifest + stable/latest 渠道；启动+周期检查，**静默后台装**、下次启动生效，多版本共存 symlink | 检查与安装分离；渠道概念（M2 起可留接口） |
| deno / bun | GitHub Releases API 发现 + sha256/签名校验 + **rename dance**：unix 直接换运行中二进制；Windows 运行中 exe **可改名不可覆盖**——旧 exe 改名 `.old` → 新 exe 移入 → 延迟清理 | 平台替换手法的权威参照（本项目同款实现） |
| opencode | 检查后仅提示「run opencode upgrade」，不静默装 | 与本项目「确认后安装」取向一致 |
| Windows Inno 惯例 | 下载 setup.exe → 应用先退出 → `/VERYSILENT /SUPPRESSMSGBOXES /NORESTART`；**注意 `/SUPPRESSMSGBOXES` 会吞掉 CloseApplications 对话框**，所以「更新器先停实例再装」更稳 | M1 win 流程按此实现 |
| GitHub API | `GET /repos/{owner}/{repo}/releases/latest` **永不返回 draft/prerelease**；未认证 60 req/h/IP（token 后 5000/h），应缓存/少调 | M1 检查走此端点（PAT 认证）；M1 无缓存必要（用户手动触发） |

**来源**：github.com/farion1231/cc-switch（tauri.conf.json / src/lib/updater.ts / scripts/rewrite-updater-manifest.mjs / .github/workflows/sync-r2.yml）、code.claude.com/docs/en/setup、denoland/deno `cli/tools/upgrade.rs`、bun.com/docs/cli/upgrade、github.com/sst/opencode、jrsoftware.org/ishelp、docs.github.com/rest/releases。

## 3. 总体架构

```
触发（CLI modeldock update；M2 加 Web 控制台/托盘/启动提示）
   │  1 发现：feed adapter → 统一 UpdateManifest（version/notes/平台资产表）
   ▼  2 比较：与构建时烘焙的 src/version.ts VERSION 做 semver 比较
下载（临时目录，按平台资产；M2 起镜像回退链）
   ▼  3 校验：SHA256（对 SHA256SUMS / manifest 内嵌值）
安装（按平台替换，见 §5.4）
   ▼  4 重启：停受管实例 → 换 → 按原形态拉起
收尾（清理 .old 上一版残留；失败保留并打印手动恢复指引）
```

- **统一 manifest 接口**：feed 来源（GitHub API / latest.json / 自建 URL）实现成可插拔 adapter，M2/M3 切换只换 adapter，客户端流程零改动。
- **版本唯一来源**：git tag 构建时烘焙进 `src/version.ts` 的 `VERSION`（现有机制，不变）。

## 4. 【决策】feed 演进路线（三阶段）

> **2026-10-09 更新**：项目已迁至 [ObsidianTrine/model_dock](https://github.com/ObsidianTrine/model_dock) 公开开源（v1.0.0 起），主仓库 `/releases/latest` 匿名可用——公开源的 PAT 已非必需（存量旧版本 ≤1.3.x 仍指向私有旧仓库，升级时才用得上 PAT）。下述三阶段为私有时期的决策记录。
>
> **2026-10-11 更新**：M2 按新前提落地——独立 releases 仓库/latest.json 作废，客户端改匿名免 PAT + 可选令牌 + 镜像回退链（详见 §6）；M3 维持规划。

初设计时**仓库私有**（匿名 404），无凭据的公开更新源不可用；公共镜像链（gh-proxy 类）对私有仓库同样 404。据此拍板：

| 阶段 | 更新源 | 触发条件 | 状态 |
|---|---|---|---|
| **M1** | GitHub API + 用户 PAT（私有直连） | 现在 | 已实施（已随 v1.0.0 公开发布；2026-10-11 起匿名免 PAT，PAT 转可选） |
| **M2** | ~~公开 releases 专用仓库 + latest.json~~ → 主仓库直连 + 匿名 + 镜像回退链 | —— | 已实施（2026-10-11，见 §6） |
| **M3** | VPS / Cloudflare R2 自建源（nginx/caddy 或 R2 + 自定义域），cc-switch 同款；与云同步 VPS 基础设施合流 | VPS 到位后（见 `docs/deploy-cloud.md`） | 规划（2026-10-11 确认 VPS 未购，暂缓） |

- M1 的 PAT 仅需 **fine-grained、单仓库、Contents: Read-only**；存在 `secrets.json`（程序管理，0600，现有 `atomicWrite` 链路）。
- 三阶段的 feed 地址/凭据全部收敛在配置里，客户端其余逻辑不变。

## 5. M1 详设（实施基准）

任务 id：`auto-update-m1`。必读源码：`src/version.ts`、`src/config/store.ts`（`loadConfig/saveConfig/mutateConfig/migrate`）、`src/config/types.ts`、`src/config/secrets.ts`（`getSecret/setSecret`）、`src/cli/gatewaycmd.ts`（`cmdGatewayStart/cmdGatewayStop`，**`sweepGatewayProcesses` 禁用于单测**，见 AGENTS 红线）、`src/gateway/state.ts`（实例注册表）、`src/util/paths.ts`、`src/util/i18n.ts`、`scripts/build-sea.mjs`、`.github/workflows/release.yml`。

### 5.1 发现（GitHub API adapter）

- 请求：`GET https://api.github.com/repos/{repo}/releases/latest`，头 `Authorization: Bearer <PAT>`、`X-GitHub-Api-Version: 2022-11-28`、UA 必填。
- 从响应派生统一 manifest：
  - `version` ← `tag_name`（剥 `v` 前缀，非 semver 形态报可操作错误）；
  - `notes` ← `body`（截断到 ~2000 字符）；
  - 资产表 ← `assets[]` 按 §5.3 命名规则匹配（name/id/size），SHA256 从 `SHA256SUMS` 资产拉取解析（第二次小请求）。
- 比较：`[major,minor,patch]` 数值逐段比较；相等或更旧 → 「已是最新」；远端解析失败/网络失败 → 可操作错误（含「检查网络或代理」指引，不重试轰炸）。
- 401/403 → 提示 PAT 失效或过期，指引重新 `--token`；404 → 仓库配置错误。

### 5.2 配置与凭据

- `config.toml` 新增段（走 `types.ts` 的 `Config` + `store.ts` 的 `migrate()` + `emptyConfig()` 三处同步，**新顶层字段必须进 migrate**）：

  ```toml
  [update]
  repo = "ObsidianTrine/model_dock"   # M2 起换公开仓库；M3 起可整体换成 feed url
  ```

- PAT 存 `secrets.json`：固定 id `update.token`，经 `setSecret/getSecret`（keychain 后端也自动生效）。
- 写入途径：`modeldock update --token ghp_xxx`（保存后立即用该 token 继续）。
- 无 token 时报错（双语、可操作）：说明去 GitHub → Settings → Developer settings → Fine-grained tokens 建只读 token，再 `modeldock update --token <token>`。

### 5.3 资产命名与选择

CI 产物（现有 + 新增）：

| 平台形态 | 资产 | 选择规则 |
|---|---|---|
| darwin 装在 .app 内 | `modeldock-<ver>-darwin-<arch>-app.tar.gz`（**新增**，包内顶层 ModelDock.app） | `process.execPath` 路径含 `.app/Contents/MacOS/` 段 |
| darwin / linux 裸二进制 | `modeldock-<ver>-<target>.tar.gz`（现有） | 其余 unix |
| win 安装器版 | `modeldock-<ver>-win32-x64-setup.exe`（现有） | execPath 在 `%LOCALAPPDATA%\Programs\ModelDock\` 下，或旁路有 Inno 卸载器 `unins000.exe`（自定义安装目录兜底，2026-10：D:\Programs\ModelDock 曾误判 win-bare 致托盘不随更） |
| win 裸二进制 | `modeldock-<ver>-win32-x64.zip`（现有） | 其余 win |

- arch 映射 `process.arch` → `arm64|x64`；选不到资产 → 报错并附该 release 资产清单。
- 校验：SHA256SUMS 里逐文件核对，不一致立即终止并删除下载物（**先校验后执行，绝无例外**）。

### 5.4 平台安装与重启（核心）

安装前动作（全平台一致）：
1. 记录当前受管运行中实例（实例注册表，`src/gateway/state.ts`）；
2. `cmdGatewayStop` 停掉全部受管实例（**不是** `sweepGatewayProcesses` 全量清扫）；
3. win 另需停托盘进程（按可执行名精确匹配，不用/im 全杀）。

**darwin（.app 形态，用户生产形态）**：
1. 下载 app.tar.gz → 校验 → 解压到临时 staging；
2. `rename` 旧 `/Applications/ModelDock.app` → `ModelDock.app.old`（unix 允许换名运行中目录，自身进程不受影响）；
3. staging 的 ModelDock.app `rename` 到原位置；
4. 换新后 `open <appPath>`（detached）拉起新版——GUI 分支自会拉起网关 + 托盘；
5. 更新进程退出后旧目录由下次更新或 `modeldock update --clean` 清理；启动失败时手动恢复 = 把 `.old` 改回原名。

**unix 裸二进制**：新二进制写 `<target>.new`（同目录）→ 旧改名 `.old` → 新改名到位 + chmod 755 → 对每个停掉的实例 spawn `<新二进制> gateway start` 拉回。

**win 安装器版**：下载 setup.exe → 校验 → 停实例与托盘 → detached spawn `cmd /s /c "<setup>" /VERYSILENT /SUPPRESSMSGBOXES /NORESTART && start "" "<新托盘路径>"`（cmd 等 setup 退出后自拉托盘；更新器随即退出释放 exe 锁）。**win 裸二进制**：同 unix rename dance（NTFS 允许改名运行中 exe），`.old` 清理延迟到下次更新。

- 硬约束：安装路径不可写 / 自身不拥有二进制（如未来 npm 全局安装）→ 拒绝并指引用对应方式升级；`/Applications` 无写权限 → 指引用 Finder 安装或修正权限。
- 更新过程中 **8687 短暂中断是本功能的预期行为**（用户主动触发）；但测试代码绝不允许触达真实实例（见 §5.7）。

### 5.5 CI 产物补充（scripts/build-sea.mjs）

- `packageMacDmg()` 内、每个 darwin target 的 `buildMacApp()` 完成后，打 `modeldock-<ver>-darwin-<arch>-app.tar.gz`（`tar czf`，包内顶层 ModelDock.app）；
- `writeSums()` 的 darwin 文件清单加入该 app 包；
- `release.yml` 上传 glob 已含 `release/*.tar.gz`，无需改动；M1 不产 latest.json（manifest 由 API 派生，M2 再引入）。

### 5.6 CLI 命令规格

```
modeldock update               # 检查 + 确认（显示版本/notes/体积）→ 下载安装重启
modeldock update --check       # 只检查不安装
modeldock update --yes         # 跳过确认（供脚本/未来的 Web 端点复用）
modeldock update --token <PAT> # 保存 PAT 后继续
modeldock update --clean       # 清理 .old 残留（darwin/win）
```

- 命令注册在 `src/cli/update.ts`，`src/cli/index.ts` 挂载；全部文案走 `t()` 双语。
- 进度输出：检查中 / 下载进度（百分比或体积）/ 校验 / 替换 / 重启，每步一行（短句、灰度辅助色，与现有 CLI 风格一致）。

### 5.7 测试门与验收标准

- `test/update.test.ts`：本地 `http.createServer`（`listen(0)`）伪造 GitHub API + 资产 + SHA256SUMS；FAKE_HOME 隔离；**停实例/停托盘/open 等副作用函数必须可注入并在单测中替换为 mock**（参照 `test/uninstall.test.ts` 对 gatewaycmd/secrets 的 vi.mock 范式）。覆盖：semver 比较、manifest 派生与资产选择、SHA256 不一致拒装、darwin .app 交换（对临时 staging 目录真实执行 rename 流程）、win 命令行构造断言（三大 OS 都能跑）。
- 三平台兼容：路径一律 `path.join`；win 分支逐条按 AGENTS「工程硬性约定」复查。
- 真机验收（mac，用户或 agent 协助）：PAT 配置 → `--check` 报新版 → 全量更新 → 8687 自动恢复、Web 控制台/托盘正常 → `--clean` 收尾。**agent 做真机验收前必须与用户确认时点**（涉及生产实例短暂重启）。
- 验收 = 测试全绿 + 本节真机清单逐条通过。

## 6. M2：公开 releases 专用仓库（规划 → 按主仓库公开落地）

- **触发**：M1 真机稳定使用数个版本后、开始向他人分发之前。
- **实施状态（2026-10-05）**：用户拍板拆分——**第 5 项（Web 控制台「检查更新」入口 + 托盘菜单项 + 启动静默检查 24h TTL）已随本轮 M2 交付**（`src/update/webupdate.ts` + server 三端点 + ui 徽标/弹层 + 双端托盘菜单；沙箱实例浏览器实测通过）；第 1–4 项维持规划。
- **实施状态（2026-10-11）**：主仓库已公开开源（ObsidianTrine/model_dock，v1.0.0 起新版本线），原前提（主仓库私有）失效，第 1–4 项按新前提落地（`feature/public-release-update`）：
  - **第 1–2 项作废**：不再新建独立 releases 仓库、release.yml 不加 sync job——Release 资产直接发布在已公开的主仓库。
  - **第 3 项改为「匿名 + 可选令牌」**：客户端不开 latest.json（GitHub API 匿名已可用，独立 manifest 无增益）——`fetchLatestRelease/downloadAsset` 的 token 改可空，无 `token_ref` 时省略 Authorization 头匿名访问；PAT 保留为私有仓库兼容模式 + 限流提升（60 次/时 → 5000 次/时）；CLI 不再无令牌硬拒，Web 启动检查无令牌照常进行；401/403/404 文案按有无令牌分流。
  - **第 4 项镜像回退链落地**：`[update].mirror` 列表（缺省 `DEFAULT_UPDATE_MIRRORS` = `https://gh-proxy.com/` → `https://ghfast.top/`，官方直连为隐式末位），候选链 = 镜像×1（60s 快失败）→ 官方 API 资产端点×3（15min）；仅当 `browser_download_url` 呈 `https://github.com/{repo}/releases/download/` 规范形态才走镜像（防陌生 URL 塞给第三方），Authorization 绝不随镜像请求发出；**SHA256SUMS 永走官方 API**（完整性锚点不经镜像，见 §8）。
- 改动（原始规划存档）：
  1. ~~新公开仓库 `modeldock-releases`（只放 Release 资产 + `latest.json`）~~ 主仓库公开后作废；
  2. ~~`release.yml` 增加 sync job：复制资产到公开仓库 Release 并生成 `latest.json`~~ 作废；
  3. ~~客户端：feed adapter 从「GitHub API+PAT」切「latest.json」~~ 改为匿名 + 可选令牌（见上）；`[update] repo` 指向主仓库；PAT 流程保留为私有仓库兼容模式；
  4. 镜像回退链：`[update].mirror` 列表，默认 `https://gh-proxy.com/` → `https://ghfast.top/` → 官方直连，逐个超时回退（仅公开资产可用镜像）——已落地（见上）；
  5. ~~Web 控制台「检查更新」入口、托盘菜单项、启动检查提示~~ **已完成（见上）**。实现要点：网关进程绝不自行安装（apply 仅分离 spawn `update --yes`，argv 由 `updateDaemonArgs()` 传入）；webupdate 模块不静态依赖 autostart（单测整模块 mock 与共享注册表叠加会击穿静态绑定）。
- 风险：镜像为第三方公共服，只做下载加速，**完整性仍以 SHA256 为准**（SUMS 本体永走官方 API，镜像调包资产会被校验拦截）。

## 7. M3：VPS / R2 自建源（规划）

- **实施状态（2026-10-11）**：用户确认 **VPS 尚未购买**，M3 暂缓、后续再做——当前无进行中工作、无前置代码欠账（客户端 `api_base` 可插拔接口已随 M2 落地）。VPS 到位后按本节实施，动手前按 §0 重新对齐；届时先完成 `docs/deploy-cloud.md` 的占位 IP（203.0.113.10）替换。
- **触发**：云同步 VPS 到位后（基础设施合流，参照 `docs/deploy-cloud.md`）。
- 形态（cc-switch 同款二选一，届时拍板）：
  - VPS nginx/caddy 静态托管 `latest.json` + 资产目录，release job 用 scp/rclone 同步；
  - Cloudflare R2 + 自定义域（dl.<domain>），workflow 同步 + manifest URL 改写脚本。
- 客户端唯一改动：`[update]` 指向自建 URL（adapter 已可插拔）；GitHub 兜底保留。

## 8. 安全与回滚

- 传输 HTTPS + 内容 SHA256 强校验，两道都过才执行；任何一步失败即终止，不留半成品（staging 目录清理）。
- PAT 最小权限（fine-grained、单仓库、只读 Contents），存 `secrets.json`（0600，程序管理，不进 config.toml、不打日志）。
- 回滚：darwin 保留 `ModelDock.app.old`、裸二进制保留 `.old`；`--clean` 显式清理；win 走安装器自身的事务性。
- 更新器**永不**执行未通过校验的二进制；`open`/spawn 的目标路径全部来自安装位置的推导而非 manifest 字段。

## 9. 测试红线（沿用 AGENTS 并强调）

- 单测/集成测试一律 FAKE_HOME + `listen(0)` 随机端口；停实例、停托盘、open、spawn 安装器等副作用在测试中必须 mock。
- `sweepGatewayProcesses` 严禁在单测直跑（按签名杀本机网关，含 8687 生产）。
- 真机验收涉及生产实例重启，必须用户知情同意后进行。
