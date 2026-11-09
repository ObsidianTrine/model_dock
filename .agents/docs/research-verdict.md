# research verdict/2 — 调研可信度判定消费方契约

> 本文是 **agent 消费者的唯一契约**：拿到 `research/<brief-id>/verdict.json` 后如何决策。
> 产出方：`orchestrator.mjs research`（自动 L1）/ `research verify <brief-id>`（L2 复核）。
> schema：`modeldock.research.verdict/2`。**`advisory: true` 永远为真——本判定不绕过
> spec 审阅与合并闸门，最终否决权仍在人工与既有门禁。**

## 字段

| 字段 | 类型 | 含义 |
|---|---|---|
| `schema` | string | 固定 `modeldock.research.verdict/2` |
| `brief_id` / `model` / `verifier` | string | 调研产物 id / 调研船模型 / 复核船（verify 后才有） |
| `scores.evidence` | int\|null | L1 数字回查核实率（%）。null=无快照或无可回查 token（**不可核 ≠ 0 分**） |
| `scores.coherence` | int\|null | L2 claim 状态聚合（supported=1/partial=0.5/unsupported·contradicted=0；unverifiable 不计） |
| `scores.coverage` | int\|null | 已核承重结论 / 总承重结论（%）。unverifiable 拖它不拖 coherence |
| `scores.citation` | int\|null | L0 引用面（当日引用率/深链比/快照成功率 等权） |
| `scores.overall` | int\|null | 加权（0.4/0.35/0.15/0.10，缺维重归一）。**任一决策关键维 null → null**。仅用于排序与 L3 台账 |
| `claims[]` | array | L2 逐条判定：`claim`（逐字摘自 brief）+ `status` + `note` + `by`（l1=确定性回查 / l2=复核会话）。note 自认无快照/无直据的 supported 自动降级 unsupported（带 `downgraded: true` 留痕） |
| `claims[].status` | enum | `supported / partial / unsupported / contradicted / unverifiable` |
| `snapshots` | object | `{ total, usable, skeleton }`——骨架页（剥标签后可见文本 <400 字，客户端渲染/被拦的典型形态）只做标注不改判级：meta 描述仍可佐证排名类结论，但**数字类结论的可核性受限**（reasons 里有同款提示） |
| `blockers[]` | array | 复核会话给出的硬伤（一句话一条） |
| `fabricated_claims` | int | 非逐字摘录被丢弃的 claim 数（**编造红旗**，>0 时 decision 封顶 needs_review） |
| `usage` | object | **决策矩阵（消费方唯一行动接口）**，见下 |
| `level` | string | overall 的三值映射（pass ≥75 / warn ≥50 / fail <50；null → unknown）——兼容旧消费者 |

## usage 决策矩阵（读这个就够）

| 字段 | 取值 | 规则 |
|---|---|---|
| `browse` | 恒 `ok` | 入库阅读无害 |
| `internal_decision` | `ok` | coverage ≥50（硬底线，不可配）且 coherence ≥阈值（缺省 60）且 evidence ≠ fail（<40）且 fabricated=0 且无否决 |
| | `needs_review` | 未达 ok 但无否决；或 fabricated>0（含 claims 全灭——复核契约被违反是红旗，不是「没测」） |
| | `unsafe` | **任一 claim contradicted（一票否决，不可配置）** |
| | `undetermined` | evidence/coverage/coherence 任一 null（数据不足以判定） |
| `external_doc` | `ok` | internal_decision=ok 且 coherence ≥75 且 coverage ≥70（阈值可配，硬底线同样适用） |
| | `needs_review` / `undetermined` / `unsafe` | 随 internal_decision；external_doc=ok 也建议人工过目后才对外 |

阈值可在 workflow.json `research.usageGates` 调（`{decision|external: {coherence?, coverage?}}` 0-100 整数）；**否决权与 coverage 50 硬底线不可配**。

## 消费方 agent 的标准动作

1. 读 `usage.internal_decision`：`ok` → 可直接引用其 `claims[].status=supported` 的条目做决策；`needs_review` → 只引用 supported 条目并人工核 `blockers`；`unsafe` → 禁用该 brief（可在 `research-void/` 归档）；`undetermined` → 先补 `research verify` 或重跑调研。
2. 引用具体数字前看对应 claim 的 `status` 与 `note`——**只采信 supported；partial 需注明依赖转述**。
3. `fabricated_claims > 0` 或 `blockers` 非空：逐条人工复核后再用。
4. L3 趋势：`research stats` 按调研船模型看核实率——低分模型的产物默认 needs_review。台账条目以 `researcher_model` 记调研船（L2 条目的 `model` 是复核船）；旧条目无该字段时回退 `model` 分组。
5. sail 无人值守上游管线（orchestrator.mjs `sailUpstreamPipeline`）按本矩阵阻断：升 spec 前读 `verdict.json`——`internal_decision=unsafe` 或任一 claim `contradicted` → 本周期不升 spec，事件 `research_verdict_blocked` 留痕、不重试（下周期复查 verdict 是否改判）；`undetermined` / `needs_review` 不阻断；无 verdict（旧 brief / 未跑 L1）行为不变放行。人工 `spec --from-brief` 不受此闸（人已过目）。

## 判级与分数的对应（供人读）

`pass ≥75` / `warn ≥50` / `fail <50` / `unknown（overall=null）`。**判级只是排序信号，决策请以 usage 矩阵为准。**
