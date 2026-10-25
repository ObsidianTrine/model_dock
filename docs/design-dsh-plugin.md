# dsh 插件市场分发插件（安装引导）设计说明书

| 文档属性 | 内容 |
|---|---|
| 当前版本 | **v0.4 · §8.1 v0 + §4.5 设置页 tab 已实现** |
| 状态 | 实现于 `dsh-modeldock` 独立仓库（5 工具 + github-release 渠道 + 设置页 ModelDock tab + 单测/沙箱集成测试全绿，已装入本机 dsh web profile 验证）；npm 渠道默认未启用（D1）；开放决策点见第 11 章 |
| 日期 | 2026-10-25（v0.3 同日：A5 `attach --port` 落地 + §8.1 实现；v0.4：§4.5 设置页 tab 落地，D4 就 web 端实测坐实） |
| 读者 | 接手实现的 agent / 评审人 |

> **给接手 agent 的一句话任务说明**：
> 本文档设计一个**薄引导插件** `dsh-modeldock`（cordis 插件 npm 包），借 dsh 插件市场触达 dsh 用户。插件只做四件事：**探测 ModelDock、引导安装、调 ModelDock CLI 完成 dsh 接入、健康检查**——网关与接入细节全部复用 ModelDock 自身，插件**不实现网关、不写客户端配置文件**。实现前必读仓库根目录 `AGENTS.md`（端口红线、三平台兼容清单），联调测试一律走 `MODELRDOCK_FAKE_HOME` + 189xx 隔离配方。

## 目录

1. [背景与目标](#1-背景与目标)
2. [dsh 插件生态调研结论（实证）](#2-dsh-插件生态调研结论实证)
3. [总体架构与薄插件原则](#3-总体架构与薄插件原则)
4. [插件详细设计](#4-插件详细设计)
5. [ModelDock 侧配套改动](#5-modeldock-侧配套改动)
6. [安全与校验](#6-安全与校验)
7. [三平台兼容清单](#7-三平台兼容清单)
8. [实施计划](#8-实施计划)
9. [测试计划](#9-测试计划)
10. [红线与边界](#10-红线与边界)
11. [开放决策点](#11-开放决策点)
12. [附录：证据与参考](#12-附录证据与参考)

---

## 1. 背景与目标

### 1.1 为什么做这个插件

ModelDock 当前触达 dsh 用户的唯一路径是「用户先知道 ModelDock → 手动安装 → 手动 attach」。dsh 已有插件市场生态（`@1e0zj/dsh-plugin-mall`，检索 GitHub topic `dsh-plugin`，一键装进 profile），把 ModelDock 以引导插件形态摆进这个市场，是成本最低的分发入口。

**已否决的替代方案**：把 ModelDock 网关整体塞进插件。否决理由（2026-10-20 调研结论）：

- 定位冲突：ModelDock 是跨 8+ 客户端的统一配置中心 + 常驻网关，塞进 dsh 后只能活在 dsh 进程里，dsh 退出即网关下线，其他客户端断流，「统一管理」价值归零；
- 生命周期硬伤：dsh 桌面版 / web 版是两个 profile 两个进程，插件各自起服务会端口互撞；`gateway.json` 单实例保护、托盘、自启这套守护逻辑全部要按进程内模型重做；
- 已有正确形态：`src/adapters/dsh.ts` 已通过 `cordis.patch.yml` + `.credentials.yaml` 完成零侵入接入。

### 1.2 目标

dsh 用户在插件市场一键安装本插件后，**几分钟内**（无需了解 ModelDock 文档）完成：

1. 安装 ModelDock CLI（机器上没有时）；
2. 启动网关并设置开机自启（可选但推荐）；
3. 把当前 dsh profile 接入网关（写入 provider patch + 凭据）；
4. 验证连通（health 探活 + 试跑一次对话）。

### 1.3 非目标（红线）

- **不做网关**：插件进程内不起任何 HTTP 服务、不转发任何模型请求；
- **不写 dsh 配置文件**：`cordis.patch.yml` / `.credentials.yaml` / `settings.yaml` 的写入一律由 `modeldock` CLI（即 `src/adapters/dsh.ts`）完成，插件避免与 ModelDock 形成对同一文件的双写者；
- **不托管密钥**：上游 key、网关 token 全程不经过插件进程；
- 不支持脱离 ModelDock CLI 的纯手工 YAML 拼装（那是 CLI 的职责）。

## 2. dsh 插件生态调研结论（实证）

> 证据来源：本机 dsh 0.2.0-rc.2 安装的第三方插件 `@1e0zj/dsh-plugin-mall@0.4.17`、`dsh-rewind-plugin@0.17.1` 的 package.json 与源码，及 npm registry 公开查询。dsh 官方开发文档暂未发现（RC 阶段），以下契约以在跑插件为准，实现前需按当时版本复核。

### 2.1 插件契约（cordis 插件 npm 包）

| 要素 | 约定 | 实证出处 |
|---|---|---|
| 加载器 | `@deepseek-ai/cordis-plugin-loader`（npm 公开，1.0.6）：`apply(ctx, config)` 入口；`export const name`；`inject: string[]` 声明依赖服务；`Config` 用 `@deepseek-ai/schemastery` 校验 | plugin-mall `src/index.js` 头注释 |
| agent 工具 | `defineTool`（`@deepseek-ai/dsh-tools`，npm 公开，0.0.1-rc.1）；挂 profile bundle 层的工具进全局层，每个会话可见 | plugin-mall 五个 `market_*` 工具 |
| 后台任务 | `jobs` 服务（plugin-mall 的 install/uninstall 均为 background job） | plugin-mall `inject: ["tools","jobs","systemPrompt","loader"]` |
| Web UI | package.json `exports['./client']` 出口 + `dsh.client: { inject: [...], platform: "web" }`；locale 经 `exports['./locale/*.json']` | dsh-rewind package.json |
| 默认配置 | package.json `dsh.bundle.patch: "./cordis.patch.yml"`，随包分发、作为 bundle 层挂进每个安装它的 profile | plugin-mall / rewind 同构 |
| 安装 | `dsh plugin --profile <name> add <pkg>`（pnpm 装进 profile 的 node_modules 并登记 bundles），或插件市场 `market_install` | `dsh --help` |
| 分发 | npm 包 + GitHub 仓库打 topic `dsh-plugin`（market_search 按 topic 检索；market_info 会检查 package.json 的 `dsh.bundle` 与 README） | plugin-mall README/工具注释 |
| 版本钉子 | `engines.dsh` 范围钉法：`">=0.2.1-rc.1 <0.3.0-0"` | rewind package.json |

### 2.2 必须避开的坑（调研中确认）

1. **npm 名 `modeldock` 已被第三方占用**：npm 上 `modeldock@0.1.2` 是 nimjal 的另一款产品（"A unified AI workspace"），与本仓库无关（2026-10-25 复核仍为 0.1.2，结论有效）。**任何引导 `npm i -g modeldock` / `npx modeldock` 的路径都会装错包**，插件内严禁出现这两个命令；本仓库 CLI 的 npm 分发必须用 scoped 名（见 5.A1，阻塞项）。
2. **bundle 层 patch 的值会变成「所有 profile 的显式配置」**：plugin-mall 在其 cordis.patch.yml 注释里明确踩过（曾把 `defaultProfile: web` 写进 bundle 层，导致其他 profile 的行为被静默钉死）。本插件 bundle patch 只放插件自身注册项与用户无关的默认值，环境相关值留给用户层或运行时探测。
3. **dsh 仍在 0.2.x RC**：插件 API（cordis-plugin-loader、dsh-tools）无稳定承诺；`engines` 钉范围 + CI 里按 dsh 当前版本回归是底线。
4. **同插件被多个 profile 加载**：desktop 与 web 是两个 profile 两个进程，插件代码在两边各跑一份。工具注册天然隔离无碍，但安装/接入类动作必须幂等、防并发（jobs 服务 + 幂等设计，见 4.6）。

## 3. 总体架构与薄插件原则

```
dsh 进程（profile: web / desktop / …）
  └─ dsh-modeldock 插件（cordis 插件，随 profile bundle 层加载）
       ├─ agent 工具：modeldock_status / modeldock_install / modeldock_attach
       │             / modeldock_detach / modeldock_health
       ├─ 设置页 UI：状态卡 + 安装向导（./client 出口，platform: web）
       └─ spawn 子进程（继承 DSH_HOME 等环境变量）
            └─ modeldock CLI（独立安装的常驻产品，非插件的一部分）
                 ├─ attach dsh → 写 ~/.dsh/profiles/<n>/cordis.patch.yml
                 │               + ~/.dsh/.credentials.yaml（现有 adapter 逻辑）
                 └─ gateway install → 开机自启（现有 gatewaycmd 逻辑）

dsh（llm-pi-ai provider，apiKeyEnv=MODELDOCK_TOKEN）
   ──HTTP──▶ ModelDock 网关（127.0.0.1:8687，独立常驻进程）
                ──▶ 上游 API（按 profile 路由）
```

**薄插件原则**（本设计的核心取舍）：插件是「安装器 + 遥控器」，不是「第二个实现」。凡 ModelDock CLI 已有的能力（diff 预览、快照、新旧布局迁移、等值过滤跳过、凭据写入），插件一律 spawn CLI 复用，自己只做探测、下载、调命令、展示。代价是插件依赖 CLI 已安装且在 PATH（安装步骤正是为此存在）；收益是接入逻辑单实现、无漂移，dsh 布局再变也只改 ModelDock 一侧。

环境变量链路：插件进程是 dsh 的子进程，`DSH_HOME` 天然继承，spawn 出的 `modeldock` 再继承一层——ModelDock 的 `dshHomeDir()`（`$DSH_HOME` > `~/.dsh`）与 dsh 自身解析规则一致，非默认安装位置无需插件特殊处理。（沙箱测试例外：`MODELRDOCK_FAKE_HOME` 下 `dshHomeDir()` 会**忽略 `DSH_HOME`**、强制解析到 `$FAKE_HOME/.dsh`，见 `src/util/paths.ts` 与第 9 章联调配方。）

## 4. 插件详细设计

### 4.1 包结构与元数据

```
dsh-modeldock/
├─ package.json          # dsh.bundle / dsh.client / engines / exports
├─ cordis.patch.yml      # bundle 层：只注册插件自身
├─ src/index.js          # apply(ctx, config) + 五个工具
├─ src/install.js        # CLI 安装器（npm 渠道 / GitHub Releases 下载）
├─ src/client.js         # 设置页 UI（状态卡 + 向导）
├─ locale/zh.json        # 双语文案（key 结构对齐 rewind 的 locale 导出；「中文原文即 key」仅在 dsh client locale loader 支持时可用，实现前复核）
├─ locale/en.json
└─ README.md             # market_info 会读取；中英双语、含截图
```

package.json 关键字段（建议值，名称最终见 D2）：

```jsonc
{
  "name": "dsh-modeldock",
  "version": "0.1.0",
  "type": "module",
  "main": "src/index.js",
  "exports": {
    ".": "./src/index.js",
    "./client": "./src/client.js",
    "./locale/*.json": "./locale/*.json",
    "./package.json": "./package.json"
  },
  "keywords": ["dsh", "dsh-plugin", "deepseek-harness", "modeldock", "gateway"],
  "engines": { "node": ">=22.19.0", "dsh": ">=0.2.1-rc.1 <0.3.0-0" },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "inject": ["@deepseek-ai/dsh-client-ui-settings", "@deepseek-ai/dsh-client-locale"], "platform": "web" }
  }
}
```

### 4.2 Config（schemastery 校验）

| 字段 | 类型/默认 | 说明 |
|---|---|---|
| `gatewayPort` | number，默认 `8687` | 网关端口；health 探活与 attach 前探活都用它 |
| `installChannel` | `'npm' \| 'github-release'`，默认 `'npm'` | CLI 安装渠道（npm 渠道优先的理由见 4.6） |
| `cliPackage` | string，默认 `'@obsidiantrine/modeldock'` | npm 渠道的包名（**禁止**缺省指向裸名 `modeldock`，见 2.2-1） |
| `releaseRepo` | string，默认 `'ObsidianTrine/model_dock'` | github-release 渠道的下载仓库（固定归属，防下载源被换） |
| `suggestAutoStart` | boolean，默认 `true` | 安装完成后是否引导开启网关开机自启 |

不提供 `dshHome` 字段：home 位置跟随 `DSH_HOME` 环境变量与 dsh 自身规则，插件不猜。**Config 与 bundle patch 中不出现任何密钥字段**（红线见 1.3）。

### 4.3 bundle patch（`cordis.patch.yml`）

```yaml
# dsh-modeldock bundle patch: register the plugin itself only.
# 红线（2.2-2）：这里不放环境相关/用户相关的值，bundle 层值会变成所有 profile 的显式配置。
- insert:
    - id: dsh-modeldock
      name: dsh-modeldock
      config:
        gatewayPort: 8687
        installChannel: npm
```

### 4.4 agent 工具面（`defineTool` × 5）

工具命名跟随市场插件惯例（`market_*` → `modeldock_*`）。注入服务：`inject: ['tools', 'jobs']`（不需要 systemPrompt/loader）。

| 工具 | 输入 | 行为 | 输出 |
|---|---|---|---|
| `modeldock_status` | 无 | ① `which`/`where` 探测 PATH 上有无 `modeldock` CLI 及版本（`modeldock --version`）② GET `/_modeldock/health` 探活 ③ 读 dsh patch 判断当前 profile 是否已接入（检测 modeldock provider 条目，判据与 `isGatewayBase` 一致：baseURL 指向 `127.0.0.1:gatewayPort`） | 结构化状态：`{ cliInstalled, cliVersion, gatewayUp, gatewayPort, attached }` + 下一步建议文案 |
| `modeldock_install` | `{ channel?, autoStart? }` | background job：按渠道安装 CLI（见 4.6）；装完探测版本；`suggestAutoStart` 时提示可执行 `modeldock gateway install` | job id；完成回执含版本与 PATH 提示 |
| `modeldock_attach` | `{ setDefault?, clientProfiles? }` | 前置探活（未运行则拒绝并给指引：`modeldock gateway start` / `gateway install`）；然后 spawn `modeldock attach dsh --mode gateway --yes --port <gatewayPort> [--set-default] [--client-profile <…>]`（显式端口跳过 CLI 的 8687 探测启发式，需 CLI ≥ A5 版本） | CLI 的 diff/快照回执（原样转述），接入前后 patch 摘要 |
| `modeldock_detach` | `{ yes? }` | spawn `modeldock detach dsh --yes`；二次确认语义（`yes` 缺省时先回传将执行的还原说明再等确认） | CLI 回执 |
| `modeldock_health` | 无 | GET `/_modeldock/health`（无鉴权，见 5.A4）；失败时附 `modeldock doctor` 指路 | `{ up, version?, latencyMs }` |

幂等与并发约束：`modeldock_install` 用 jobs 服务做单飞（同 profile 已有运行中的 install job 时直接返回该 job）；attach/detach 天然幂等（CLI 等值过滤不产生重复变更）。desktop/web 两 profile 同时调用 install 的竞态：安装动作落在本机全局环境（npm -g / 系统安装器），两个进程最多重复探测版本，重复安装由 npm/安装器自身语义兜底；文档标注此为已知非原子点。

版本门槛：插件不假设 PATH 上 `modeldock` 的选项面（`--client-profile` 等随 CLI 版本演进）。`modeldock_status` 与 install 完成回执校验 `cliVersion` ≥ 插件声明的最低版本（门槛值在 M0 落地后按当时发布版钉定），低于门槛时给升级指引而非直接 spawn。

### 4.5 client UI（设置页 tab）

> **落地状态（2026-10-25，v0.2.0）**：已实现并装入本机 dsh web profile——tab 注入
> `settings.plugins.tab` 槽位（id `modeldock`、order 40，与「插件市场」并列），浏览器端经
> `window.__ModuleLoader__.load` 契约挂载（对齐 plugin-mall：宿主共享 React、ES5 无构建、dsw 设计令牌），
> 动作全部走主进程 `/modeldock` RPC（status/install/attach/detach，见 `dsh-modeldock/src/rpc.js`），
> 与 agent 工具共用同一套动作本体与安装 job 单飞管理器。
> **v0.3.0 增左侧栏入口**：`sidebar.panellist` 行（id `dsh-modeldock`、order 2，正好排在插件市场
> order 1 之下）+ `"main"` 面板（key 同 id，点击条目主区域渲染同款面板）——契约照抄 dshmarket 的侧边栏实现。
> **v0.3.1 传输修正（405 排查结论）**：connection 的 `rpc.handle` 通道在本宿主（dsh 0.2.0-rc.2 web
> profile）不生效——浏览器 POST 落 SPA 兜底回 405（plugin-mall 的 `/market` 同宿主同样 405）；
> 实测 dshmarket 走的是 **webServer 直挂路由**（`/dsh-market/*` 200）。插件改为同款姿势：
> 主进程 `ctx.inject(["webServer"])` 挂 `POST /modeldock/<endpoint>` prefix 路由（鉴权门请求时读
> `connection.requestRejection`，在场复用宿主 fence+浏览器登录，不在场回退 loopback 开放），
> 客户端改 `fetch` 直连；connection 通道注册保留（未来宿主生效时自带鉴权）。已在真实 dsh 第二实例
> （`--patch` 换端口）curl 验证 status 200 + attach 版本门槛拒绝路径。

三态状态卡 + 向导，全部文案走 locale 双语：

1. **未安装 CLI**：渠道选择（npm / GitHub Releases）→ 安装按钮（触发 `modeldock_install` job，进度展示）→ 完成后提示「需重启 dsh 使 PATH 生效」（见 7-P2）；
2. **已装未接**：网关探活状态（未运行给启动指引 + 自启建议）→「接入当前 profile」按钮（触发 attach，展示 CLI diff 回执）；
3. **已接入**：网关健康、CLI 版本、「断开接入」入口（detach 带确认）。

UI 只做展示与触发，所有状态来自工具同款探测函数（client 与 main 共享探测逻辑，经各自进程边界——client 出口运行在 dsh 前端 plane，探测经 ctx 服务或直接 fetch health，与 rewind 的 client 写法对齐，实现时按当时 dsh client 文档复核）。

### 4.6 CLI 安装流程（`modeldock_install`）

**npm 渠道（默认，推荐）**：dsh 用户必然有 Node ≥22.19（dsh 自身即 npm 包，rewind 钉的 engines 与此一致），满足 ModelDock CLI 的 `engines.node >=22`。执行 `npm install -g <cliPackage>`（Windows 用 `shell: true`，见 7-P1）。**前置条件是 5.A1 落地**（scoped 包发布），实施前该渠道不可用。

**GitHub Releases 渠道（fallback，不依赖 5.A1）**：

1. 按平台 × 架构映射资产名（与 `build-sea.mjs` 产出一致，**文件名内嵌版本号**：`modeldock-<ver>-<os>-<arch>.tar.gz`（linux / darwin）/ `modeldock-<ver>-<os>-<arch>.zip`（win），darwin 另有 `.dmg`，win 另有 `-setup.exe`；os 段取 `linux` / `darwin` / `win32`，arch 段取 `x64` / `arm64`）。版本号从 latest release 元数据读取，或按资产名前后缀匹配解析，**禁止写死固定文件名**；darwin 的 `-app.tar.gz` 是自更新专用件，不取；
2. 拉取 latest release 的 `SHA256SUMS` + 对应资产，**逐字节校验哈希**，不匹配即中止并报错；
3. 解压出单一入口程序，装入用户可写 bin 目录（mac/Linux：`~/.local/bin` 并提示 PATH；Windows：引导运行 `*-setup.exe`（Inno Setup 支持静默参数）或手动放置）；
4. 完成后 `modeldock --version` 复验。

失败兜底：两渠道都失败时，回退为展示手动安装指引（复用 ModelDock 安装文档链接），不阻塞用户。

### 4.7 接入流程（`modeldock_attach`）

1. `modeldock_status` 前置检查：CLI 已装、网关存活（health 200）；网关未运行 → 返回指引（`modeldock gateway start` 手动拉起，或建议先 `modeldock gateway install` 常驻），**插件绝不代替用户拉起网关**（网关生命周期属于 ModelDock 自身，避免插件侧再养进程）；
2. spawn `modeldock attach dsh --mode gateway --yes --port <gatewayPort> [--set-default] [--client-profile <…>]`：写入 provider patch（含模型列表、reasoningEfforts 声明）与 `.credentials.yaml` 的 `refs.MODELDOCK_TOKEN`——全部是现有 adapter 行为；`--port` 见 5.A5（多实例下不写错端口，沙箱联调不触 8687）；
3. 回执：CLI 的 diff 预览与 notes 原样转述；提示「patch 生效是否需要重启 profile 见 D5 实测结论」。

v1 不支持 `--mode file`（直连）入口，仅网关模式（理由见 D3）。

### 4.8 卸载

插件被 `market_uninstall` / `dsh plugin remove` 移除时，cordis 生命周期销毁插件实例，但**不会**还原已写入的 dsh 配置。约定：UI 与 README 在卸载指引中显式要求先执行「断开接入」（或让 agent 跑 `modeldock_detach`）；README 同步说明可用 `modeldock restore dsh` 走快照还原。v1 不尝试在插件销毁钩子里自动 detach（避免卸载插件时误触还原用户配置）。

## 5. ModelDock 侧配套改动

| # | 改动 | 性质 | 说明 |
|---|---|---|---|
| A1 | **发布 ModelDock CLI 的 npm 分发渠道**（scoped 名，如 `@obsidiantrine/modeldock`；`modeldock` 裸名被第三方占用，不可用） | **阻塞** | 新分发渠道决策：scoped npm 包（bin 指向 `dist/cli.js`，纯 JS 无 native addon，dsh 用户 Node 版本天然满足）；发布走 release.yml 增补或独立 workflow。名称归属见 D1 |
| A2 | `modeldock status` / `doctor` 增加 `--json` 机器可读输出 | 建议 | 插件 UI 与 status 工具消费；无它则插件自行拼 patch 解析（能做但不薄） |
| A3 | `attach` 支持 `--json` 输出结果摘要 | 可选 | v1 可先靠 stdout 转述，不阻塞 |
| A4 | `/_modeldock/health` 响应体带版本号字段 | 可选 | 现响应为 `{ ok, started_at, uptime_ms, reloads, active_profile }`（无鉴权豁免已实证），缺版本号字段；补 `version` 后插件可展示「网关 vX.Y.Z」。`active_profile` 字段现状即可复用为状态展示 |
| A5 | `attach` 支持 `--port <n>` 显式网关端口（透传 planAttach.gatewayPort，跳过 8687 探测启发式） | **已落地**（2026-10-25 合入 develop，含全链路回归测试） | 多实例下启发式会把客户端文件写到别的实例端口（ops.ts 注释自警，attach-cli.test.ts 记载的可测性缺口）；插件 attach 一律显式传端口，沙箱联调全程不触生产 8687 |

## 6. 安全与校验

- **下载校验**：GitHub Releases 渠道必须校验 `SHA256SUMS`，仓库归属固定为 `releaseRepo` 配置值，不允许运行期改写下载源；仅 https。
- **密钥零接触**：网关 token 与上游 key 由 ModelDock CLI 写入 `.credentials.yaml` / secrets.json，插件进程读不到也不请求；Config 无密钥字段；日志与回执不得回显任何凭据（CLI 输出本身已脱敏）。
- **命令注入**：spawn 一律数组参数形式（`spawn(cmd, args, …)`），禁止字符串拼接整行命令；`--client-profile` 等用户输入值只作单个参数传递。
- **最小权限**：插件不申请 loader 之外的写服务；对 `~/.dsh` 只读（探测），写入全部经由 CLI。

## 7. 三平台兼容清单

| # | 差异点 | 处理 |
|---|---|---|
| P1 | Windows spawn npm 全局命令是 `.cmd` 包装，直调 ENOENT | `spawn` 时 `shell: true` 或补后缀（与本仓库 gatewaycmd 既有 win32 分支写法一致） |
| P2 | 安装后 PATH 不刷新：当前 dsh 进程及其子进程探测不到新装 CLI | 完成回执与 UI 明确提示「重启 dsh 后生效」；status 工具对「health 活但 CLI 不可见」的状态给出该解释 |
| P3 | macOS `.dmg`（Apple silicon）与 Windows Inno `setup.exe` 的静默安装参数不同 | 按平台分支映射资产与安装命令；Linux 仅 tar 包 + `~/.local/bin` |
| P4 | 路径拼接一律 `path.join()`/`path.resolve()`，分隔符正则写 `[\\/]` | 与 AGENTS.md 硬性约定一致 |
| P5 | 插件不管网关进程生命周期 → 无信号/taskkill 需求 | 网关启停/自启全部留给 `modeldock gateway` 命令与用户 |

## 8. 实施计划

| 里程碑 | 内容 | 前置 | 粗估 |
|---|---|---|---|
| M0 | ModelDock 侧配套：A1（npm scoped 发布，阻塞项）、A2（status/doctor --json） | D1 决策 | 0.5–1 天（A1 含发布流程增补） |
| M1 | 插件骨架：包结构 + bundle patch + `modeldock_status`/`modeldock_health` + client 状态卡（只读） | 无 | 1 天 |
| M2 | 安装向导：`modeldock_install`（双渠道 + SHA256）+ UI 向导 | A1（npm 渠道） | 1–2 天 |
| M3 | 接入闭环：`modeldock_attach`/`modeldock_detach` + UI 接入/断开 | M1 | 1 天 |
| M4 | 发布：npm 发插件包、GitHub 仓库打 topic `dsh-plugin`、README 双语 + 截图、market_info 自检 | M1–M3 | 0.5 天 |

新插件代码放独立仓库（不进本仓库 src/，避免 SEA 打包与插件发布互相牵制；且 market_search 按**仓库级** topic `dsh-plugin` 检索，插件须独立成仓才能被命中——塞本仓库子目录等于放弃市场发现渠道）；本仓库仅承担 M0 配套改动（走 feature-branch 工作流）。

### 8.1 引流优先的 v0 裁剪路线（推荐起点）

若首要目标是**引流**（把 dsh 用户导流到 ModelDock）而非完整安装体验，按下面裁剪出 1–2 天可发面的 v0，且 ModelDock 侧只需 A5 一处小改（已落地；A1/D1 仍不在关键路径）：

- 砍 client UI（设置页向导）：D4（desktop 端 web plane 可用性）的不确定性直接消失，引导靠 agent 工具回执 + README；
- 安装渠道只留 GitHub Releases（不依赖 A1）；npm 渠道等 D1 落地后再补为默认；
- 工具面 5 → 3：`modeldock_status`（吸收 health 探活）、`modeldock_install`（仅 github 渠道）、`modeldock_attach`；detach 与卸载指引放 README（`modeldock detach dsh` / `modeldock restore dsh` 本就是一条 CLI 命令）；
- 红线不裁：不写 dsh 配置、不起 HTTP 服务、密钥零接触——「薄」正是这个插件的价值来源；
- 发布 = 双语 README（含安装截图）+ GitHub 仓库打 topic `dsh-plugin` + `npm publish`（裸名 `dsh-modeldock` 未被占，定了尽早占名）。

落地状态（2026-10-25）：v0 已在 `dsh-modeldock` 独立仓库实现——5 工具齐备、github-release 渠道（SHA256SUMS 逐字节校验）+ npm 渠道护栏、CLI 版本门槛（≥1.3.0，A5）、双语 README；单测 + 沙箱集成测试（真实网关 189xx × 假 dsh home × PATH shim 全流程）全绿。**v0.2.0 增设页 tab（§4.5，含 `/modeldock` RPC）并已装入本机 dsh web profile 验证（40 测试用例全绿 + 已装位全链路 15 项 PASS）**。ModelDock 侧仅落地 A5 一处小改（已合入 develop）。待办：npm publish 占名、GitHub topic、desktop 端 tab 可用性实测（D4 剩余）、npm 渠道默认切换（D1）。

## 9. 测试计划

- **插件单元**（插件仓库内）：`apply` 可被 cordis-plugin-loader 加载（冒烟）；Config 校验（非法端口/渠道拒载）；工具 handler 用注入的假 spawn/fake fetch 测三态状态、attach 前置探活拒绝路径、SHA256 不匹配中止路径。
- **集成联调**（沙箱，遵守 AGENTS.md 端口红线）：临时 ModelDock 实例（`MODELRDOCK_FAKE_HOME=<独立目录>` + `--port 189xx`，**绝不触 8687/8890**）+ 临时 dsh home 放在 **`$FAKE_HOME/.dsh`**——注意 `MODELRDOCK_FAKE_HOME` 下 `dshHomeDir()` 会忽略 `DSH_HOME`、强制解析到 `$FAKE_HOME/.dsh`（`src/util/paths.ts`），把 `DSH_HOME` 另指外部目录会被无视、attach 写错位置 → 全流程：install（npm 渠道用 Verdaccio / 本地 registry 代理并配临时 npm prefix，不污染真机全局；或直接测 github-release 渠道）→ attach → health → detach → 复原断言。
- **市场验收**：`market_info` 能读到本插件 `dsh.bundle` 与 README；`market_install` 装进干净 profile 后 `dsh --dump-config` 可见 bundle 层注册项。
- **三平台**：P1/P2/P3 各分支在 CI matrix（或至少 Windows 实机）过一遍 install 渠道。

## 10. 红线与边界

- 8687（生产）/ 8890（用户 dev 沙箱）在本插件的一切开发与联调中照常全面禁用（AGENTS.md ⛔ 禁令适用）。
- 插件不写 `~/.dsh` 任何文件（探测只读；写入仅经 `modeldock` CLI）；不在插件进程内起 HTTP 服务。
- 插件出现 `npm i -g modeldock` / `npx modeldock` 字样即实现错误（2.2-1）。
- ModelDock 仓库本身不引入 cordis/dsh 运行时依赖（M0 配套改动仅 CLI 输出与发布流程；插件依赖留在插件仓库）。

## 11. 开放决策点

| # | 决策 | 建议 | 阻塞性 |
|---|---|---|---|
| D1 | ModelDock CLI 的 npm scoped 包名（`@obsidiantrine/modeldock` / `@modeldock/cli` / 其他） | `@obsidiantrine/modeldock`（与 GitHub 归属一致，防抢注误导） | **阻塞 M0** |
| D2 | 插件包名与仓库归属（`dsh-modeldock` 裸名 vs scoped；独立仓库 or 本仓库 monorepo 子目录） | 裸名 `dsh-modeldock` + 独立仓库（市场检索友好，生态惯例如此；npm 裸名 `dsh-modeldock` 2026-10-25 查询未被注册，定了尽早占名防抢注） | M1 前 |
| D3 | 是否支持 `--mode file`（直连）接入入口 | v1 不做：直连绕开网关，插件价值与统一管理目标相悖；需求出现再议 | 否 |
| D4 | 桌面版 profile 的 client UI 可用性（`platform: "web"` 是否覆盖 desktop） | **web 端已实测坐实**（本机 plugin-mall 同机制实证 + dsh-modeldock v0.2.0 设置页 tab 落地）；desktop 端仍未测，不可用则 desktop 侧仅靠 agent 工具 | desktop 实测待做 |
| D5 | patch 写入后 dsh 是否需重启 profile 才生效（llm-pi-ai provider 配置热加载与否） | 实测；若需重启，attach 回执中明确提示，并可评估市场 `allowRestart` 能力 | M3 前实测 |

## 12. 附录：证据与参考

- 本机实证：dsh 0.2.0-rc.2（`dsh --help`：profile/patch/plugin 命令面）；`~/.dsh/profiles/web/package.json`（bundles 结构）；`@1e0zj/dsh-plugin-mall@0.4.17`（`src/index.js` 头部插件契约注释、`cordis.patch.yml` bundle 层教训注释、installer/restart 协议）；`dsh-rewind-plugin@0.17.1`（`dsh.client` 出口、`engines.dsh` 钉法、`./locale/*.json` exports）。
- npm 公开包：`@deepseek-ai/cordis-plugin-loader@1.0.6`（"Plugin loader for cordis"）、`@deepseek-ai/dsh-tools@0.0.1-rc.1`（"Tool registry and execution pipeline for the DeepSeek Harness"）。
- npm 名占用：`modeldock@0.1.2` → nimjal/ModelDock（"A unified AI workspace"），与本仓库无关。
- 本仓库锚点：`src/adapters/dsh.ts`（接入写入逻辑）、`src/cli/index.ts`（`attach/detach/token`、`gateway start/install` 选项面）、`src/gateway/server.ts`（`/_modeldock/health` 无鉴权豁免）、`scripts/build-sea.mjs`（发布资产命名）、`src/util/paths.ts`（`dshHomeDir()` 的 `$DSH_HOME` > `~/.dsh` 解析与沙箱覆盖）。
- 相关文档：`docs/design-orchestrator.md`（体例参照）、`AGENTS.md`（端口红线、三平台清单、i18n 约定）。
