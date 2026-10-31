# 审查评测报告

- 考题：1，审出：1，未审出：0
- 模型：glm-5-3-flash-260828
- 评分口径：expect 关键词命中（启发式），精确判定看原文

## 2026-10-jsonpath-lenient-parse — ✅ 审出

- 考题：L2 pack 写 JSON 配置时 jsonpath 宽容解析静默写坏数据：引号键写错位置、下标落对象成 "0" 字符串键、star 中段裸崩
- 关键词：tokenize=中，setpath=中，path=中
- 完整输出：/var/folders/vw/7vttg54s74ng208jp5063f0c0000gp/T/modeldock-review-eval-iDTIwW/2026-10-jsonpath-lenient-parse.output.txt

<details><summary>模型原文</summary>

```text
发现 3 个问题（已用只读方式对照仓库当前 `src/util/jsonpath.ts` 核实——该文件现行版本在头部注明 CORRECT-08 缺陷①②③，与下述三条一一对应；`git log` 需审批未执行，但现行文件足以确认修复方向。以下行号均为题给 fd235ea^ 版本）：

## 1. tokenize 宽容解析：exec 跳过无法解析的字符，值被静默写进错误位置（主缺陷）
**src/util/jsonpath.ts:16-26** — 正则 `/([^[.\]]+)|\[(\d+)\]/g` 配裸 `while (re.exec(body))`，没有任何「匹配段必须首尾相接」的校验。exec 会跳过不认识的字符继续匹配，于是：
- `$.servers['mcp']`：引号字符都在 `[^[.\]]` 类里，产出键 `'mcp'`（**含引号**）——`setPath` 把值写进错误键名，config 照常落盘，调用方视角「写成功」；
- `$.a[-1]`：负数下标匹配不到 `\[(\d+)\]`，`-1` 被当成**键名**写进对象；
- `$.a[0`：未闭合括号，`0` 被当成键名，句式残缺也静默通过；
- `$.a..b`：双点被跳过，静默当 `a.b`。

读侧 `getPath`（:29）共用同一 tokenize，detect/status 类读取同样会读错键。L2 pack 的路径是用户手写的（文件头自述），宽容解析把「写错位置」静默化，属「静默丢用户数据」级。现行版本改为消费位置连续性检测 + 不完整即抛双语可操作错误（现行 :20-44），且读侧也改为严格解析（现行 :48-49）。

## 2. 下标段 × 对象容器：静默落字符串键，而非报错
**src/util/jsonpath.ts:74-86（末端写）与 :100-113（中段写）** — `const arr = cur as unknown[]` 后 `idx > arr.length` 的越界检查在 `cur` 是普通对象时失效：`({}).length` 为 undefined，`idx > undefined` 恒为 false，于是 `arr[idx] = value` 把键 `"0"` 写到对象上。路径语义（下标=数组）与实际落点（对象字符串键）不符，pack 作者视角即「写进去了但读不到」。若 `cur` 是字符串/数字标量，`arr[idx] = value` 在 ESM 严格模式下直接抛 TypeError 裸崩，绕过 i18n 报错。现行版本两处都加了 `!Array.isArray(cur)` 显式报错（现行 :100-108、:136-144）。

## 3. star 递归对非 object 子节点无防护：null/标量子节点导致 TypeError 裸崩
**src/util/jsonpath.ts:65** — `applySet(child, rest, value)` 前未检查 `child` 是否为 object。`$.a.*.b` 遍历 `{x: null}` 或 `{x: "str"}` 时，递归进入后 :72 的 `(cur as Record)[seg.key] = value` 对 null/标量赋值，严格模式抛 `Cannot set properties of null` / `Cannot create property 'b' on string`——整次写入崩溃且无双语可操作报错。现行版本在同位置补了 `if (!child || typeof child !== 'object') continue`（现行 :88，注释明指 CORRECT-08 缺陷②）。

## 存疑
- **数组容器 × key 段**（:72，`$.a.b` 而 `a` 是数组）：写命名属性，`JSON.stringify` 会丢弃 → 改动静默丢失。机制确证，但现行修复版本（现行 :96）**仍未**加数组防护，疑似有意收窄范围，故不作确证报告。
- **`setPath(root, '$', v)` 静默 no-op**（:51）：表达式 `$` 时 segs 为空直接返回，写整根场景静默不生效；现行版本同样保留，疑似接受。
- `__proto__` 键经 :72/:97 赋值可改写对象原型（prototype pollution）：路径来自本地 pack 文件、非远程输入，实际风险低，未验证调用面是否可达，不入确证清单。
```

</details>