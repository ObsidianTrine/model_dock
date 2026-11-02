# 审查评测报告

- 考题：1，审出：1，未审出：0
- 模型：glm-5-3-flash-260828
- 评分口径：expect 关键词命中（启发式），精确判定看原文

## 2026-10-jsonpath-multiseg-overreject — ✅ 审出

- 考题：jsonpath tokenize 完整覆盖校验漏算段间 `.` 分隔符：`.` 不被任何 token 消费，fd235ea 加的「消费位置必须连续」判定把所有多段点路径（$.a.b）当跳字误抛「无法解析」——CORRECT-08 修复引入的回归，jsonpath 主流句式的多段读写全废（远端实现过审合入，合并后本地全量抓到）
- 关键词：多段=中，误拒=未中，点路径=未中
- 完整输出：/var/folders/vw/7vttg54s74ng208jp5063f0c0000gp/T/modeldock-review-eval-zIWmb5/2026-10-jsonpath-multiseg-overreject.output.txt

<details><summary>模型原文</summary>

```text
发现 2 个问题

## 1.【主缺陷·致命】tokenize 正则不消费段间 `.`，所有多段点句式全部误判抛错 — src/util/jsonpath.ts:18

- 证据：`re = /([^[.\]]+)|\[(\d+)\]/g`（第 18 行）的首个分支只匹配键字符，**不含分隔符 `.` 也不消费它**。逐字推演 `$.a.b.c`：body=`a.b.c`，exec 匹配 `a`（index 0，consumed=1）；下一次 exec 在 index 1 匹配不到（`.` 被键字符类排除、也不是下标句式），滑到 index 2 才匹配 `b`，`m.index(2) !== consumed(1)` → 第 24 行 break → 第 33 行抛「无法解析：第 2 个字符“.”不支持」。
- 波及面：**文档宣称的首选句式 `$.a.b.c` 整体不可用**——`getPath`/`setPath`/`toSegments` 三个入口全挂；`$.a.*.b`、`$.a.list[0]` 等任何含「点号后还有段」的表达式同样全红。单段 `$.a` 与 `$.a[0]`（括号紧跟首段）恰好能走通，掩盖了问题。
- 对照验证：当前 HEAD `src/util/jsonpath.ts:20` 已改为 `/\.?([^[.\]]+)|\[(\d+)\]/g`，注释（18-19 行）自证：「m.index 永远停在点号上、多段点句式（$.a.b.c）全部被『不连续』误判——全量实测 12 例红」。test/util.test.ts:33/34/86 的 `$.a.b.c`、`$.a.list[0]` 用例即回归面。

## 2.【存量·HEAD 仍在】叶子键段写入数组容器无守卫，值被静默丢进序列化黑洞 — src/util/jsonpath.ts:94

- 证据：第 93-94 行 leaf 分支 `seg.key !== undefined` 时直接 `(cur as Record)[seg.key] = value`，没有 `Array.isArray(cur)` 检查。中间键段遇数组子节点会原样递归（130 行 `typeof child === 'object'` 对数组为真），故 `setPath({a:[1,2]}, '$.a.b', 9)` 得到 `a[\"b\"]=9`——`JSON.stringify` 丢弃非下标键，落盘后即「写进去了但读不到」。这正是本文件第 98/136 行为下标×对象方向显式修掉的 CORRECT-08 缺陷③，对称方向（键×数组）漏了。已核对 HEAD 96 行同样无守卫，非本片段新引入，标 **[存量]**。

## 存疑（证据不足，不列入正式发现）

- **前缀宽容**：`^\$\.?` 使 `a.b`、`$a.b` 也被接受（第 16 行），与报错文案「仅支持 `$.` 句式」不一致；未在 HEAD 中找到相关测试或注释表明是有意取舍，但影响仅限拼写容错，无数据破坏路径。
- **空表达式静默 no-op**：`setPath(x, '$', v)` / `expr=''` 时 segs 为空直接返回（70-72 行），无报错。若 L2 pack 校验层保证路径非空则无害，需看调用面（src/adapters/packs.ts）才能定论。

其余部分（未闭合括号/负数下标/引号键拒绝、`idx > arr.length` 越界守卫、star 跳过 object 子节点、`idx === length` 追加语义）均逐条推演过，行为与注释声明一致，无问题。
```

</details>