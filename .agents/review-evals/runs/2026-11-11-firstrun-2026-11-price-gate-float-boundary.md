发现 2 个问题——审查对象：src/providers/pricing-core.ts @ f0ec255^ 快照，行号按材料标注。盲评口径：仅依据所给材料判断，未读仓库其他源码。

## 问题 1 [P1·blocker] 价格闸门在浮点边界误判：真实价差恰为 5% 的合法组合会被拒绝，且同一价差方向不同结果相反

**位置**：src/providers/pricing-core.ts:40-42（`ratio = Math.abs(a - b) / a`）与 :49-51（`r.input <= tolerance && r.output <= tolerance`，tolerance 缺省 0.05）。

**证据（IEEE-754 双精度语义可复算）：**
1. `1.05 - 1.0` 的双精度结果是 `0.050000000000000044…`，大于 0.05 的双精度值（0.0500000000000000027…）。故 primary.input=1.0、backup.input=1.05——数学上价差恰为 5%——算出 ratio = 0.05000000000000004 > 0.05，`<=` 判 false，**拒绝**。而 `<=` 与"价差 ≤5% 放行"的契约本意是恰 5% 应放行。
2. 同为数学上恰 5% 的 primary=2.5、backup=2.625：2.625−2.5=0.125 精确可表示，0.125/2.5 舍入回 0.05 的双精度值 → `<=` 判 true，**放行**。即恰 5% 的组合放不放行取决于二进制表示误差，行为不确定、不可预测。
3. 方向不对称：同一对价格 primary=1.05、backup=1.0 时 ratio ≈ 0.04762 → 放行；primary=1.0、backup=1.05 → 拒绝。primary=1.0、backup=0.95（备用便宜恰 5%）同样因 1.0−0.95 = 0.050000000000000044 > 0.05 被拒。
4. 用户可见后果：写入口保存恰在 5% 边界（或极接近）的映射时报"价差超 5%"，与闸门"≤5% 放行"的承诺冲突；这是配置写路径上的硬拒绝，材料内未见人工覆出口。

**修复方向**：不要直接对浮点商做边界比较——改为带量级比例容差的比较（如 `diff <= tolerance * a + a * Number.EPSILON * k`），或把单价换算到整数/分数域精确比较（价格本就是小数位有限的 USD 牌价）。

## 问题 2 [P1] 闸门只比 input/output 两桶，但计费按 cache_read/cache_write（含回落）——显式 cache 价差可完全绕过价格闸门

**位置**：src/providers/pricing-core.ts:36-38（注释声明"cache_read/cache_write 不参与（计费时缺省回落输入价，闸门只看牌价两主桶）"）、:47-52（闸门实现确实只比 input/output）、:59-60（计费取 `price.cache_read ?? price.input`、`price.cache_write ?? price.input`）。

**证据**：注释给出的豁免理由只在两侧都**未显式设置** cache 价时成立（此时双方 cache 价都回落到各自 input，卡住 input 即覆盖）。一旦任一侧显式设置 cache 价，它就是真实计费价且完全不受闸：例 primary = {input:1.0, output:1.0, cache_read:0.1}、backup = {input:1.0, output:1.0}（无 cache_read）→ 两桶 ratio 全 0 → 放行；但缓存读计费 backup 按 1.0，为 primary 的 10 倍。缓存重度负载下实际成本差远超 5%，"价格闸门"对最贵的维度失守。

**判定说明**：文件注释把它表述为有意取舍，故不算无意 bug；但所陈述的理由不覆盖显式 cache 价的情形，缺口真实存在且直接削弱该功能的成本保护目标。应修：两侧任一显式设置 cache 价时，把 cache_read/cache_write 的有效价（含回落）一并纳入闸门。

## 存疑

1. 分母取源模型价（/from）意味着"价差 ≤5%"以主模型价为基准：primary=0.95、backup=1.0 按 primary 基准为 5.26%（拒）、按 backup 基准为 5.0%（过）。文件注释已声明该选择，但若对外文案把"双向 ≤5%"理解为对称差，会出现口径出入。本材料不含对外文案，无法对拍，不报缺陷，仅提示核对口径。
2. `priceWithinTolerance` 对入参不做 sanity 校验（依赖调用方先过 `saneModelCost`）：若传入 NaN 价，ratio 为 NaN，`NaN <= t` 恒 false → fail-closed 拒绝，方向尚安全；调用方代码不在材料内，无法确认调用序，不报。

---
Blocker：1（问题 1）。
