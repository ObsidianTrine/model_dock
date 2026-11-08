<!--
考点：fail-open 收窄——网关观测失败从「回落文件直读」改成抛错阻断。
机器可读段供跑分器解析；关键词任意命中一个即记该阻塞点命中。
-->

# 期望判定

clean: false

## 应抓（阻塞点）
- [P1] 关键词: fail-open|failopen|回落|fallback|阻断 — 网关观测失败（fail-open 收窄）从「回落文件直读」改成抛错上抛/拒绝继续：违反编排侧「网络观测一律 fail-open 绝不阻断」口径（网关抖动即对账瘫痪，下游 stats/nightly 连带受累）；被删注释与本 hunk 顶部原注释明写「fail-open 回落，绝不阻断」——改动与自身注释/JSDoc 矛盾

## 不应抓（噪音）
- 关键词: AbortController|timer|clearTimeout|signal — 超时控制保留完好，不是考点
- 关键词: 双语|i18n|t() — .agents/ 编排脚本无 i18n 要求，中文报错文案不违规
- 「throw new Error 文案应更详细」「错误对象应带 cause 字段」类完善建议属建议级
- 「catch 后再 throw 包一层丢失原始堆栈」可作建议级提及，不作为本考点的命中判据
