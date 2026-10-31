# 审查评测报告

- 考题：1，审出：1，未审出：0
- 模型：glm-5-3-flash-260828
- 评分口径：expect 关键词命中（启发式），精确判定看原文

## 2026-10-jsonpath-tokenizer-regression — ✅ 审出

- 考题：CORRECT-08 修复自带回归：tokenize 正则把「.」排除出可匹配字符却不消费分隔符，多段点句式（$.a.b.c）全部被「不连续」误判，L2 pack 读写全废；两新用例期望与实现自相矛盾带红合并
- 关键词：consumed=中，分隔符=未中，正则=中
- 完整输出：/var/folders/vw/7vttg54s74ng208jp5063f0c0000gp/T/modeldock-review-eval-dhDbCl/2026-10-jsonpath-tokenizer-regression.output.txt

<details><summary>模型原文</summary>

```text
发现 2 个问题

**问题 1（主缺陷，即后补修复的对象）：key 段 × 数组容器 = expando 属性，序列化后静默丢失**

- `src/util/jsonpath.ts:93-94`（leaf 写）与 `src/util/jsonpath.ts:125-131`（中段写）：key 段写入前只处理了「下标段 × 对象容器」（缺陷③，line 98/134），**没有镜像检查「key 段 × 数组容器」**。
- 证据：`cur as Record<string, unknown>` 对数组同样成立——`arr['host'] = value` 是合法的 JS expando 赋值，不报错、不抛异常。但 `JSON.stringify`/YAML dump 只序列化数组的 index 属性，字符串键属性直接丢弃。
- 触发路径：`setPath(root, '$.servers.host', v)` 且 `root.servers` 是数组 → 内存里「写进去了」，`getPath` 甚至能当场读回来；一旦落盘（config.toml/secrets 序列化）再读回，值凭空消失。中段版本 `$.servers.host.port` 会先造出 `arr.host = {}` expando（line 130），同样在序列化时静默蒸发。
- 这正是 ③ 注释里自己描述的事故形态——「pack 作者视角即『写进去了但读不到』」，只是换了段类型；修复应为 key 段遇 `Array.isArray(cur)` 时对称抛双语错误。

**问题 2：空段表达式使 setPath 静默 no-op，value 无声丢弃**

- `src/util/jsonpath.ts:16` 把 `$` / `$.` 清成空 body，tokenize 返回 `[]`（line 33 检查 `consumed !== body.length` 对空串恒过）；`src/util/jsonpath.ts:70` 的 `if (segs.length > 0)` 于是整体跳过写入。
- `setPath(root, '$', v)` / `setPath(root, '$.', v)` 不写、不报错——与文件头部「宽容解析会把值静默写进错误的位置」的 CORRECT-08 立场相悖（这里连错的位置都没有，值直接没了）。

## 存疑

1. **tokenize 邻接宽容**：`$.a[0]b` 被接受并解析为 a→0→b（`src/util/jsonpath.ts:18` 的正则 + line 24 连续性检查只保证首尾相接，不要求 `]` 后必须 `.`）；`$.a*b` 整段当字面键 `a*b`（`*` 仅在独占一段时才是通配）。缺证据：不确定 L2 pack 场景是否视为非法句式，若按「仅支持列出的三种句式」的字面口径，这两类应报错。
2. **报错位置偏移**：`src/util/jsonpath.ts:39` 的 `pos: consumed + 1` 是相对 strip 掉 `$.` 之后的 body 计数，与用户手写的原始 expr 字符位不符（`$.a['b']` 报「第 2 个字符」，实际 `'` 在第 5 位）。诊断准确性问题，可能被归为风格不报。
```

</details>