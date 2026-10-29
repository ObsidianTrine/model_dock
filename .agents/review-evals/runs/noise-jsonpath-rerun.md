# 噪音测量（clean） — src/util/jsonpath.ts @ HEAD

- 顶层结论：发现 3 个问题

<details><summary>模型原文</summary>

```text
核对完毕：仓库实际文件与待审片段逐行一致（src/util/jsonpath.ts:1-117）。本机探针运行未获批准，以下结论均为静态语义推导（正则字符类 + ESM 严格模式），每条给出完整证据链。

**发现 3 个问题**（均为 [存量]；前两条已在 docs/known-issues.md CORRECT-08 登记“未修”）

**1. [存量·已登记] star 递归对原始值/null 子节点裸崩 TypeError** — src/util/jsonpath.ts:65
证据链：line 60 取出的 `child` 不做类型检查（line 62 的 `typeof child === 'object'` 守卫只在 `rest.length === 0` 的叶子分支生效），rest 非空时 line 65 把 primitive/null 直接传入 `applySet`；递归到 line 72 `(cur as Record)[seg.key] = value` 对原始值赋属性，ESM 严格模式下抛 TypeError。复现路径：`setPath({a:{x:5}}, '$.a.*.b', 1)`。line 58 的 typeof 守卫只护 star 自身容器，护不到下一层。

**2. [存量·已登记] 括号句式静默写歪键 / 写入静默丢失** — src/util/jsonpath.ts:16
证据链：line 16 正则 key 分支 `[^[.\]]+` 不排除引号，`$.env_vars["API_KEY"]` 会把含引号的 `"API_KEY"` 整体当 key（line 21 收下，line 34 读 miss、line 72 写出错键、line 44 toSegments 同样产出错段）。同类还有 2 处变体：`$.a[-1]`（`-1` 落进 key 字符类，写成数组上的 `"-1"` 悬挂属性，JSON.stringify 序列化时被静默丢弃）；`$.a.*.b` 中子节点为数组时 line 72 在数组上写 key `b`，同样序列化即丢。

**3. [存量·未登记] 目标已是对象时用下标写入，静默产出键 "0"** — src/util/jsonpath.ts:95
证据链：`$.a[0]` 而 `a` 已是 `{}` 时，line 95 的 `typeof child === 'object'` 检查放行对象；随后 line 74-86 把它当数组用，`idx > arr.length` 即 `0 > undefined` 恒 false，越界保护不触发，`arr[0] = value` 实际写出对象键 `"0"`。与 line 96 的意图（index 段 → 创建数组）不一致，产出畸形结构且无报错，违背 line 76 注释自述的“明确报错比静默产出坏数据好”。

**存疑**

- **setPath 对 `'$'` / `''` 静默丢弃写入**（src/util/jsonpath.ts:50-51，`segs.length === 0` 直接跳过）。行为确定，但实际 adapter pack 中根路径写入是否会出现、是否算缺陷，缺乏使用场景证据，不列为确证问题。
```

</details>