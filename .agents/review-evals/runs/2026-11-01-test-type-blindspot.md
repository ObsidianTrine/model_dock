# 审查评测报告

- 考题：1，审出：1，未审出：0
- 模型：glm-5-3-flash-260828
- 评分口径：expect 关键词命中（启发式），精确判定看原文

## 2026-10-test-type-blindspot — ✅ 审出

- 考题：test/ 类型盲区：import type 坏路径（../config/types.js）与 status(cfg) 缺必填实参静默上树——esbuild 剥类型不解析模块路径，vitest/npm test 双门禁零信号
- 关键词：import type=中，types.js=中，sync-push-partial=中，adapter-packs=中
- 完整输出：/var/folders/vw/7vttg54s74ng208jp5063f0c0000gp/T/modeldock-review-eval-3SjxPX/2026-10-test-type-blindspot.output.txt

<details><summary>模型原文</summary>

```text
发现 2 个问题（共 4 处），全部是 test/ 脱离类型检查门禁期静默上树的类型缺陷——运行时被 esbuild 剥类型/宽松实现掩盖，vitest 全绿但 `tsc` 必红。已对照后续修复提交 2217949 逐行核实。

## 1. `import type` 指向不存在的模块路径（真缺陷，静态不可见）

**test/sync-push-partial.test.ts:34**

```ts
import type { Config } from '../config/types.js'   // ✗ 仓库无 test/../config/types.js，应为 ../src/config/types.js
```

证据：
- 同文件其余 import 全部带 `src/` 前缀（28–33 行），唯此条漏写；同仓库 test/adapter-packs.test.ts:13 同一类型写的是 `'../src/config/types.js'`，佐证正确形态。
- `import type` 被 esbuild（vitest/tsx）剥除且不解析路径，运行时零报错；该版本 test/ 未纳入 tsc 门禁，故从未暴露。
- 后果：任何类型检查（IDE、后续 tsc 接入）对此文件即红，且 `Config` 在该文件内是悬空类型，`saveConfig({...} as Config)`（:54）的类型保护形同虚设。

## 2. `status()` 缺必填实参（同类 3 处）

`src/adapters/types.ts:137` 契约为 `status(cfg: Config, gatewayPort: number)`——`gatewayPort` 无默认值、必填。以下三处只传一个实参：

- **test/adapter-packs.test.ts:129** — `await bad.status(cfg)`
- **test/adapter-packs.test.ts:273** — `await genericAdapter.status(cfg)`
- **test/adapter-packs.test.ts:276** — `await genericAdapter.status(cfg)`

运行时静默的原因：`undefined` 流入的实现恰好不读该参（generic-env 走环境变量、坏 pack 占位器在用 port 前就报错），断言照常通过。但契约已被破坏：任何实现一旦开始消费 `gatewayPort`（如按 `127.0.0.1:${port}` 比对 baseURL 判指向），这三例会拿 `undefined` 拼出错误判定。同文件 247/249/251 行的正确形态（`status(cfg, 18901)`）反衬此三处为笔误。

## 存疑

无。两文件其余 import 路径、导出名、端口纪律（listen(0)/18901，无 8687/8890）、临时目录清理均核过，未发现其它可确证问题。
```

</details>