---
id: fix-jsonpath-input-hardening
type: fix
created_at: 2026-10-30T04:45:00+08:00
created_by: agent
files_hint:
  - src/util/jsonpath.ts
  - test/util.test.ts
workflows:
  - feature-branch
gate: L3
---

# 目标
修 CORRECT-08（P2）：src/util/jsonpath.ts 三处「宽容解析不报错」健壮性缺陷——L2 adapter pack 写 JSON 配置（src/adapters/packs.ts:47,57 的 `setPath(root, k, ...)`，`k` 来自用户手写 `[adapter_packs.*]` 路径表达式）踩到这些输入时会**静默写坏客户端配置**（适配器区红线邻接面）。修完标准：三种坏输入全部变成可操作的双语报错，文档口径内的点句式（`$.a.b`、`$.a.*.b`、`$.a[0]` 于数组）行为零变化。

# 背景（行号基于 2026-10-30 develop @9785a9a，全部有 tsx 实测复现，动手前先跑一遍确认）
- 缺陷 ①（tokenize 静默吞字/改写，:16 正则 `/([^[.\]]+)|\[(\d+)\]/g` + :18-24 exec 循环只消费匹配段、不校验完整覆盖）：
  - `setPath({}, "$.a['b']", 1)` → `{"a":{"'b'":1}}`——引号进了键名，写错位置且无报错；
  - `$.a[-1]` → 字符串键 `'-1'`（数组上写非索引属性，序列化即丢）；
  - `$.a[0`（未闭合）→ 键 `'0'`，绕过 :77 的稀疏数组越界守卫。
- 缺陷 ②（star 中段裸崩，:65 递归无类型守卫）：`setPath({a:{b:1}, c:'str'}, '$.*.b', 2)` → `TypeError: Cannot create property 'b' on string 'str'`——同函数 :62 与 :95-98 对非 object 子节点均有兜底，唯 star 递归裸崩，且报错未经 t() 双语化。
- 缺陷 ③（对象上下文下标写入，:74-86 分支）：`setPath({a:{existing:1}}, '$.a[0]', 'x')` → `{"a":{"0":"x","existing":1}}`——容器已是对象时下标段静默落字符串键 `"0"`，不报错也不建数组。
- 来源与完整登记：docs/known-issues.md §三 CORRECT-08（2026-10-30 噪音对照实验发现，审查者两轮稳定复现①②）。

# 实施要求
1. **tokenize 完整覆盖校验**（修①）：匹配段拼回后与输入等长，不等长按 `toSegments` 对 star 的既有先例（:43）抛可操作错误——文案点名原始路径表达式与第一个无法解析的字符位置，走 t() 双语（占位符 `{path}`）。
2. **star 递归类型守卫**（修②）：递归前对子节点补与 :62/:95-98 同款兜底；语义自选并在注释写明（建议：非 object 子节点 skip + 不静默改数据，与 :62 leaf 写入分支一致）。
3. **下标段 × 对象容器显式报错**（修③）：容器为 object（非数组）时遇到 index 段抛双语错误，不再静默落 `"0"` 键。**注意**：先 grep 仓库与内置 pack 数据确认没有既有调用方依赖这个「巧合行为」；若有，改为该调用方显式修正，不在 jsonpath 里保留宽容。
4. 顺带核查 `getPath` 读路径是否共享 tokenize 的同型问题（共享则同 guard 一并覆盖；纯读不报错、返回 undefined 亦可接受，注释写明取舍）。
5. 修复合入后按 `.agents/review-evals/README.md`「怎么加新考题」回流为审查评测考题（reviewRef=修复提交^，files=[src/util/jsonpath.ts]；实跑配方见 README「怎么跑」）。

# 验收标准
- test/util.test.ts 新增用例覆盖三处复现原文（逐字输入与断言），坏输入报 `ConfigError`/专用错误类型且**退出码与文案**可被 CLI 层透传；文案走 t() 双语，中文段断言逐字节（i18n 纪律）。
- 既有 jsonpath 用例全绿且**语义零变化**：`$.a.b`、`$.a.*.b`、数组 `$.a[0]`、稀疏数组越界守卫（:76-77 注释保护的场景）逐条仍在。
- `npm test` 全绿；Windows 兼容自查（无路径/shell 面，常规过一遍即可）。
- docs/known-issues.md CORRECT-08 条目勾选并标注日期与 commit（维护约定 1）。

# 红线
- 不改 `src/adapters/packs.ts` 的调用契约（除非第 3 条核查发现既有依赖需修正，改动单独提交说明）。
- 不引入对新语法（filter/递归下降等）的支持——本卡只做「不支持就报错」，不做功能扩展。
- 测试不监听 8687/8890，不写死 /tmp 或盘符。
