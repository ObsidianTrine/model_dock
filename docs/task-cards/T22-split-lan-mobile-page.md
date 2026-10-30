---
id: split-lan-mobile-page
type: refactor
created_at: 2026-10-29T00:00:00+08:00
created_by: human
files_hint:
  - src/gateway/lan.ts
  - src/gateway/lan-mobile-page.ts
  - test/**
workflows:
  - feature-branch
ui_check: true
gate: L3
---

> **状态**：✅ 已完成——merged 07562d5（2026-10-30）

# 目标
lan.ts（1136 行）第一步拆分：把内嵌手机页模板（HTML+JS 字符串，约 470 行）抽成纯字符串模块，lan.ts 只留服务逻辑——T04 为桌面控制台解决过的同款形态，**HTML 字节零变化**。

# 背景（行号基于 2026-10-29 develop，动手前核实）
- src/gateway/lan.ts:361-827 主要是页面串（renderMobilePage 模板 + tr/esc/toast/confirmDialog 内联 + render/load），:803-827 是 getMobilePage/serveMobilePage 装配；与鉴权、nearby 同步、HTTP 监听器混在同一文件。
- 同款先例：src/gateway/lanAssets.ts（纯字符串模块）、T04 的 gateway/ui/ 目录拆分（15 域模块 + 43 行拼装壳，经「拆分前 UI_HTML 字节基线 vs 拆分后」cmp 全等验证）。
- 历史：REVIEW-17 整批改动都在手机页——模板与服务器逻辑分离后，两类改动不再互撞。

# 实施要求
1. 新建 `src/gateway/lan-mobile-page.ts`：纯函数 renderMobilePage + 其私有 tr/esc/toast/confirmDialog 等，`export const` 形态（参照 lanAssets.ts）；lan.ts import 之，预期降至 ~650 行。
2. **纯搬移**：模板字符串与注入逻辑（token/port 的 replaceAll）逐字节不动；lan.ts 对外导出面零变化。
3. **等价性验证**：搬移前后对同一组输入（固定 token/port/lang 参数）renderMobilePage 输出字节全等——写一次性对拍脚本（cmp 或逐字节比较）并把结论记入 NOTES.md。

# 验收标准
- `npm test` 全绿；lan 相关断言零改动（dedup-smoke、REVIEW-15/16/17 的断言——焦点管理、aria-live、Esc/焦点还原、data-i18n title——原样通过）。
- ui-smoke 门禁通过（ui_check: true）。
- 沙箱手测手机页一次（`MODELRDOCK_FAKE_HOME=<独立目录> npx tsx src/cli.ts gateway start --port 189xx` 成对指定，禁碰 8687/8890）：页面加载、语言切换、轮询、确认弹层正常。

# 红线
- **HTML 字节不变**（对拍全等是本卡第一验收项）。
- 不拆 :187-270 的 nearby syncOffer/grant 域（第二步另开卡）；不改鉴权与 HTTP 逻辑。
- data-i18n="中||En" 机制、CSP 基线、惰性函数 label 规则（AGENTS.md pill 教训）不动。
