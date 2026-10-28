# 依赖升级评估（deps-evaluation）

> 依据：2026-10-29 现场 `npm outdated` + `package-lock.json` 实装版本。本文档是后续升级排期的书面依据：Wanted 级（semver 范围内）已全部升级；跨大版本项统一「本次不升」，逐项给出评估与建议时机。

## 一、本次已升级（Wanted 级，semver 范围内）

| 包 | 版本 | 类型 | 说明 |
|------|------|------|------|
| @inquirer/prompts | 8.7.4 → 8.7.5 | dependencies | patch 修复。使用面：全部 CLI 交互提示（`src/cli/` 下 update/basic/sync/providers/profiles/init/import/harness + `src/cli/diag.ts` 与 `src/adapters/engine.ts` 惰性加载），API 无变化 |
| @types/node | 22.20.4 → 22.20.5 | devDependencies | 类型补丁。仅类型环境，无运行时影响 |

升级方式为 `npm install <pkg>@<version>`（等价 `npm update <pkg>` 结果），改动仅落 `package.json` / `package-lock.json`，**未改任何依赖使用代码**。

## 二、跨大版本逐项评估（结论：本次不升）

### 2.1 @types/node：22 → 26（Latest）

- **大版本核心变化**：@types/node 主版本号跟随 Node.js 运行时主版本，26.x 系列与 Node 26 的 API 对齐——新增 API 的类型、已弃用 API 的收紧或移除；全局 `fetch`/`Response`/`FormData` 等类型由 @types/node 内置的 undici-types 提供，主版本提升会连带变化。
- **对本仓的影响面**：全仓类型环境（tsc 编译 `npm run build` 直接消费），不是单点用法。关键约束：
  - `engines` 声明 `>=22`，CI 只跑 node 24（`.github/workflows/test.yml` matrix），**类型层跑到 26 会放开 24/26 才有的 API，node 22/24 运行时上编译过、跑挂**——这类问题类型检查发现不了。
  - `src/update/transfer.ts` 的代理感知 fetch 明确依赖「undici 与全局 fetch 的 Response 同源（@types/node 即 undici-types）」，@types/node 大版本动会牵动这条类型链。
- **升级前置条件**：先把运行时支持面升到 Node 26（CI matrix / SEA 捆绑的运行时大版本），或至少在 CI 增跑 node 26 矩阵后，再升类型。
- **建议时机**：跟随 Node 运行时升级策略（SEA 捆绑运行时大版本升级）一并做；维持 22.x 直到需要 26 新 API 的类型。

### 2.2 undici：7 → 8（Latest）

- **大版本核心变化**（部分未核实，标注推测）：
  - **已确证**：代理请求语义变化——本仓 `test/transfer.test.ts:176` 注释记录「undici 7.x 对 http 目标也走 CONNECT 隧道、8.x 走绝对形态请求行」，测试已兼容两种形态。
  - **推测**：engines 最低 Node 版本提升；7.x 系列已废弃 API/参数的移除；连接池与 fetch 规范对齐的行为调整（具体以官方 CHANGELOG 为准，升级任务第一步核实）。
- **对本仓的影响面（转发热路径核心依赖，逐文件）**：
  - `src/gateway/relay.ts`（`request`，上游转发核心路径，超时/重试逻辑围绕 undici 行为编写）
  - `src/gateway/server.ts:2046`（`request` 自探测）
  - `src/util/net.ts`（`Agent`/`ProxyAgent`，显式调优 `keepAliveTimeout: 55s` 等三参，依赖 undici dispatcher 参数语义）
  - `src/util/sysproxy.ts`（ProxyAgent 只认 HTTP(S) 代理、socks5 弃用——依赖 undici 代理支持边界）
  - `src/gateway/state.ts` / `src/gateway/proxy.ts`（`Dispatcher` 类型）
  - `src/providers/fetch.ts`、`src/sync/engine.ts`、`src/sync/setup.ts`、`src/sync/targets/cloud.ts`、`src/sync/targets/webdav.ts`（`request`，模型目录拉取与云同步）
  - `src/update/transfer.ts`（`fetch` + ProxyAgent，代理感知下载）
  - `src/cli/diag.ts`（惰性 `request`）
  - 测试侧：`test/hotpath.test.ts`、`test/net.test.ts`（直接构造 Agent/ProxyAgent）、`test/startup-lazy.test.ts`（顶层 import 纪律断言）
- **升级前置条件**：核对 8.x CHANGELOG 逐条过上面的使用点；全量 `npm test` + 转发热路径手测（直连 / 系统代理 / 显式代理 / 超时重试四形态）；等 8.x 发布数个稳定补丁后再动。
- **建议时机**：单独开任务评估（本次任务红线明确「8.x 行为变化未评估，绝不升 major」），建议在 8.x 稳定一至两个 minor 后、配合转发热路径专项验证进行。

### 2.3 qrcode-generator：1 → 2（Latest）

- **大版本核心变化**：未核实（生成本文档的 agent 会话禁网络，无法读 CHANGELOG）——major 语义即可能存在 API/输出不兼容，**升级任务第一步核实官方 CHANGELOG**，此处只评估本仓影响面。
- **对本仓的影响面（单点用法）**：仅 `src/gateway/lan.ts:170-176` `lanQrSvg()` 一处调用：`qrcode(0, 'M')` → `addData(url)` → `make()` → `createSvgTag(4, 4)`，产出控制台「手机远程」二维码 SVG；`src/gateway/ui-minified.ts` 为生成产物（`npm run gen:ui-min` 维护），不手改。
- **升级前置条件**：核对 v2 API 签名（`qrcode(typeNumber, errorCorrectionLevel)` 与 `createSvgTag` 是否保留）；新旧版本同输入 SVG 对拍 + 控制台扫码实测（相机可识读）。
- **建议时机**：低优先级——1.x 稳定、调用面极小、升级收益低；等 v2 有明确收益（如 ESM/类型改进）或有安全修复驱动时随 UI 需求走。

## 三、任务卡清单中已不在现场 outdated 列表的项（无需处理）

任务卡写作时基于主仓库目录的 `npm outdated`（其 node_modules 未随最近一次 package.json 升级重装，typescript 实装 5.9.3、vitest 实装 4.1.12），故清单里出现以下三项；**现场（fresh worktree，`npm ci` 自 lock）已是最新 major**，`npm outdated` 不再列出：

| 包 | 现场实装（lock） | 状态 |
|------|------|------|
| typescript | 7.0.2（Go 重写版） | 已是 Latest major，build 用 `tsc`（devDep）已在 CI 全绿 |
| vitest | 5.0.5 | 已是 Latest major，测试套件全量跑在 5.x |
| @vitest/coverage-v8 | 5.0.5 | 同上 |

若后续 registry 出现这三者的新 major（如 typescript 8），再按第二节同等格式补评估。

## 四、升级排期汇总

| 包 | 现场 | 结论 | 建议时机 |
|------|------|------|------|
| @inquirer/prompts | 8.7.5 | ✅ 本次已升 | — |
| @types/node | 22.20.5 | ✅ 本次已升（22.x 线） | 26 大版本：跟随 Node 运行时升级 |
| typescript / vitest / @vitest/coverage-v8 | 7.0.2 / 5.0.5 / 5.0.5 | 无需动作（已是 Latest） | 新 major 出现后单独立卡 |
| undici | 7.30.1 | 本次不升（8.x） | 8.x 稳定后单独任务 + 热路径专项验证 |
| qrcode-generator | 1.5.2 | 本次不升（2.x） | 低优先级，核实 CHANGELOG 后随 UI 需求走 |
