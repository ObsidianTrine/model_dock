# ModelDock Web 控制台测试设计方案

> 回答「Web 端的测试用例应该如何设计和测试」。现状：`src/gateway/ui.ts`（4236 行，桌面控制台单页）、`src/gateway/lan.ts`（/m 手机简版）、`src/gateway/console-shared.ts`（共用 JS 片段）都是**服务端模板字符串**，浏览器端行为此前只有 dedup-smoke 冒烟（脚本可编译 + 收敛断言）与 gateway.test.ts 的 i18n 审计，DOM 行为零覆盖。
>
> 核心思路：**不引入浏览器自动化进 CI**（纯 JS 依赖约束 + 稳定性），把"网页"当"模板产物"分层测——静态契约进 CI、服务端契约进 CI、DOM 行为进 CI（happy-dom），真浏览器只做发布前抽查。

## L0 静态契约（进 CI，零浏览器，新增 test/webui-static.test.ts）

对 `UI_HTML` / `renderMobilePage()` 的求值产物做字符串/正则断言，把 AGENTS.md 的 UI 纪律变成可执行规则：

1. **i18n 完整性**：每个 `data-i18n="中文||English"` 必须含 `||` 且两段非空（gateway.test.ts 已有 i18n 审计则引用之，不重复实现）。
2. **弹层提示归宿**：每个 modal 壳（`z-modal`）的 foot 必须含 msg 槽位（`.mferr` / `.testline`）；全局 toast 容器只允许一个——防「磨砂遮罩糊掉 toast」回归（2026-10 两起）。
3. **惰性 label 纪律**：长生命周期组件的 `label:`/`title:` 传参禁止 `t(...)` 直接求值（防语言固化，2026-10 状态行 pill 事故）；静态检查 = 在组件工厂调用点匹配 `label: t(` / `title: t(` 应为零命中（允许 `label: function(){ return t(` 与 getter）。
4. **内联脚本语法**：每个 `<script>` 块 `new Function` 可编译（dedup-smoke 已有，保留）。
5. **端点漂移审计**：从 `UI_HTML`/`renderMobilePage()` 提取所有 `fetch('/_modeldock/…')`、`/m/api/…` 路径字面量，逐一断言在 `src/gateway/server.ts` / `lan.ts` 的路由源码中出现——前端调用了不存在的端点（或改名后端）直接红灯。反向（端点无前端引用）输出清单供人工确认，不阻断。

## L1 服务端契约（进 CI，扩展既有 gateway.test.ts）

Web 控制台的后端就是 `/_modeldock/*` 管理面，gateway.test.ts 已覆盖大部分；按「每端点四组用例」口径补齐缺口（先用 L0 第 5 条的审计结果定位）：

- **鉴权**：无 token → 401/锁屏引导；伪造 token → 拒绝（已有 admin 门用例，对未覆盖端点补齐）。
- **契约形状**：GET `/status` `/overview` `/config` 返回 JSON 的顶层键集合断言——这是前端渲染的数据契约，键改名 = 前端静默白屏，值得钉住。
- **错误路径**：POST 非法 body（缺字段/类型错）→ 4xx + 可操作 message，而非 500。

## L2 DOM 行为（进 CI，新增 test/webui-dom.test.ts，`// @vitest-environment happy-dom`）

依赖 `happy-dom`（纯 JS devDependency，无 native）。做法：`document.body.innerHTML = UI_HTML`，再 `new Function(CONSOLE_SHARED_JS + 页面脚本)` 挂到 stub 过的全局（fetch 返回 L1 契约夹具、localStorage 内存桩），然后断言渲染结果。**先做一次 spike 验证脚本能在 happy-dom 里跑通再铺开**；跑不通就退回「只测纯函数片段」。

首批只做 3 个最高价值行为（各 1-2 例）：

1. **语言切换重渲染**：`applyLang()` 后桌面控制台 5 颗 pill 与标题随语言变化（钉 2026-10 pill 惯性事故类）。
2. **弹层错误写槽位**：打开任一弹层 → 触发其校验失败 → 断言 foot 的 `.mferr` 有文案、全局 toast 容器仍为空（钉「磨砂遮罩糊 toast」事故类）。
3. **状态渲染契约**：喂 `/status` 夹具 → services 表行数/active pill 文案正确（前端最常用的数据面）。

## L3 真浏览器抽查（不进 CI）

保持 ui-kit.md 既有验收（`MODELRDOCK_FAKE_HOME=<独立目录> npx tsx src/cli.ts gateway start --port 189xx` 真开页过交互），并在发布检查单加一步：**agent 用 browser-use 技能对沙箱实例跑一遍关键路径**（登录 → 切换服务 → 添加服务弹层校验失败 → 语言切换 → 导出包弹层），截图留档。浏览器 E2E 框架（Playwright 等）暂不引入：下载浏览器二进制重、CI 抖动大，收益被 L0-L2 覆盖大半；若 L2 spike 长期不稳再复议。

## 落地顺序与验收

1. L0（半天）：webui-static.test.ts 五条规则 + 修掉它揪出的现存量违规。
2. L1（半天）：跑端点审计 → 按缺口补 3-6 例契约用例。
3. L2（1 天，含 spike）：happy-dom 环境 + 三个行为用例；spike 失败则 L2 降级为「纯函数片段测试」并在本文件记录原因。
4. 全程遵守：不跨文件 vi.mock 共享模块；`npm test` 全绿；Windows CI 兼容（无路径/进程敏感操作，天然安全）。

## 落地记录（2026-10-24，feature/webui-tests-docs）

- **L0 已实施**：`test/webui-static.test.ts`（9 用例）——i18n 双语对完整（含单引号属性防漏扫）、
  弹层 foot msg 槽位（白名单：通用确认弹层 mCancel/mOk 先关后执行、反馈按分流规则落页面 toast；
  `foot: []` 无弹层内动作者豁免）、toast 容器唯一、惰性 label 禁直接求值、端点漂移审计（前端
  调用 ↔ 服务端路由双向；反向无引用清单只打印不阻断）。**存量零违规**，无需修页面代码。
- **L2 已实施且 spike 成功**：`test/webui-dom.test.ts`（4 用例，`@vitest-environment happy-dom`，
  新增 devDependency `happy-dom@21` 纯 JS 无 native，SEA 兼容）——4700 行内嵌脚本在 happy-dom
  求值 + 首屏 load() 走通；overview 渲染契约（2 服务 2 卡 + 「正在使用」pill）；语言切换重渲染
  （静态 data-i18n 节点 + 动态服务卡跟随且可逆）；弹层校验失败写 foot 槽位而非全局 toast。
  实现要点：伪定时器冻结 5s/60s 轮询（singleFork 共享进程防滞留，afterAll 还原）、fetch 按端点
  stub 夹具、`innerHTML` 注入 body 段后 `new Function` 手动求值脚本（happy-dom 不执行 innerHTML
  里的 `<script>`）。
- **L1 维持既有覆盖**：gateway.test.ts 对管理面端点已充分；端点契约形状断言由 L2 的 overview
  渲染契约用例部分承担（夹具即契约，键改名 → 渲染断言红灯）。
- **L3 不变**：发布前 agent + browser-use 对沙箱实例抽查。
