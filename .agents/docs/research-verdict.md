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
| `arbitration` | object\|null | 仲裁轮留痕（判出 contradicted 时自动跑，见下节）：`{ ran, upheld, overturned, undetermined, unmatched, veto_cleared, model, backend }`；会话失败为 `{ ran, failed: true, error }` |
| `usage` | object | **决策矩阵（消费方唯一行动接口）**，见下 |
| `level` | string | overall 的三值映射（pass ≥75 / warn ≥50 / fail <50；null → unknown）——兼容旧消费者 |

## usage 决策矩阵（读这个就够）

| 字段 | 取值 | 规则 |
|---|---|---|
| `browse` | 恒 `ok` | 入库阅读无害 |
| `internal_decision` | `ok` | coverage ≥50（硬底线，不可配）且 coherence ≥阈值（缺省 60）且 evidence ≠ fail（<40）且 fabricated=0 且无否决 |
| | `needs_review` | 未达 ok 但无否决；或 fabricated>0（含 claims 全灭——复核契约被违反是红旗，不是「没测」） |
| | `unsafe` | **任一 claim contradicted（一票否决，不可配置）**；仲裁轮 upheld 翻案后解除（见下节） |
| | `undetermined` | evidence/coverage/coherence 任一 null（数据不足以判定） |
| `external_doc` | `ok` | internal_decision=ok 且 coherence ≥75 且 coverage ≥70（阈值可配，硬底线同样适用） |
| | `needs_review` / `undetermined` / `unsafe` | 随 internal_decision；external_doc=ok 也建议人工过目后才对外 |

阈值可在 workflow.json `research.usageGates` 调（`{decision|external: {coherence?, coverage?}}` 0-100 整数）；**否决权与 coverage 50 硬底线不可配**。

## 仲裁轮（contradicted 的外部取证翻案，2026-11-09 实测驱动）

L2 复核船无联网、只拿快照裁断；快照自身误导（页面 published_time 元数据语义、骨架截断）时矛盾可能是误报——实测案例：公告页 `published_time=2025-06` 被当事件日期判 contradicted，四来源证实 brief 的「2025 年 1 月上线」正确。因此 `research verify` 判出 contradicted 时**自动追加一轮联网仲裁**（`research.arbitration: false` 可关）：

- 仲裁会话（researcher 同款联网工具面，模型缺省 `research.model`）对每条 contradicted claim 检索 **≥2 个独立带日期来源**（优先官方公告/文档/changelog），并显式区分「页面发布/更新时间 ≠ 事件发生时间」；
- 裁定合并语义（保守，只放行有正证据的翻案）：`upheld`（≥2 来源佐证）→ claim 翻案为 `partial`、note 标「仲裁轮」，**一票否决解除**；`overturned`（来源证实矛盾）/ `undetermined`（证据不足）→ 维持 contradicted，否决保留；
- verdict.json `arbitration` 字段留痕裁定统计与 `veto_cleared`；台账记 `kind: l2-arbitration`（含翻案率，供 `research stats` 后续分析误报面）；
- 仲裁会话 2 连败 → fail-closed 维持原否决（取证失败 ≠ 放行）。

**消费方语义不变**：仍只读 `usage.internal_decision`——仲裁只是让 unsafe 的成立需要经过外部证据检验，`overturned/undetermined` 的 unsafe 与从前完全同义。

## topic（research multi 的复合清单，2026-11-09）

`research multi "<主题>" --dim "<维度1>" --dim "<维度2>" …` 把一个主题按维度拆成 N 份 brief（每维 id 强制 `<topic-slug>-d<N>`，meta.json 带 `topic_id`/`dim` 溯源字段），另落一份复合清单 **`research/topics/<topic-id>.json`**：

```json
{
  "id": "<topic-id>", "topic": "<主题>", "created_at": "<ISO>",
  "dims": [
    { "dim": "<维度>", "brief_id": "<id>", "status": "ok|failed", "reason": null,
      "verdict_level": "pass|warn|fail|unknown|null", "internal_decision": "ok|needs_review|unsafe|undetermined|null" }
  ],
  "rollup": { "level": "<最差档>", "internal_decision": "<最差档>", "partial": true }
}
```

**消费方读 `rollup.internal_decision` 决策**（语义与单 brief 的 `usage.internal_decision` 同矩阵：ok / needs_review / unsafe / undetermined），逐维明细在 `dims`。聚合规则（代码见 `rollupTopicVerdict`）：

- rollup 只聚合 `status: "ok"` 的维，取**最差档**：`internal_decision` 序 `unsafe > needs_review > undetermined > ok`——任一维 unsafe 一票否决整批（与单 brief contradicted 否决同哲学）；`verdict_level` 序 `fail > warn > pass > unknown`。
- failed 维不参与聚合但在 `dims` 留痕（`reason` = 最后一跳 stderr 尾摘要，`verdict_level`/`internal_decision` 为 null）；有失败维时 `rollup.partial: true`——rollup 只代表成功维的可信度下限，缺失维度需补跑。
- `research verify <topic-id>` 走 topic 模式：逐维 L2 复核（每维行为与单 brief verify 完全一致，含仲裁轮）后重算 rollup、更新 topic.json、补一条 `kind: topic-verify` 台账。**未 verify 的 topic，各 ok 维判定是 L1 初判（恒 undetermined）——rollup 也只是 undetermined；消费前先 verify。**

### 注入 spec（`spec --from-brief <topic-id>`，2026-11-09 P2）

`spec "<意图>" --from-brief <topic-id>` 对命中 `topics/<id>.json` 的 id 走 **topic 模式**（brief 与 topic id 可混排：`--from-brief <brief>,<topic>`；brief 模式行为不变）：

- **决策契约接线**：注入前读 `rollup.internal_decision`——`unsafe` 一票否决**拒绝注入**并报可操作错误（处置：作废重跑，归档 `research-void/` 或拆维重跑 multi）；`undetermined` **不阻断**，提示先 `research verify <topic-id>`；`ok` / `needs_review` 正常注入。（单 brief 的 unsafe 是否拒绝属后续演进，本层不接。）
- **展开格式**：每个 ok 维一节，节头带维度与 rollup 溯源——`# 调研结论（topic：<topic-id>｜维度：<dim>｜brief：<brief-id>）` + brief 正文，节间 `---` 分隔；failed 维不注入正文，展开末尾附一行覆盖缺口 `（维度 <dim> 调研失败：<reason 摘要>）`——让 planner 知道覆盖缺口（ok 维的 brief 已被人工删除时同缺口处理）。

### 并发（`research.concurrency`，2026-11-09 P2）

multi 维度池与 verify topic 逐维复核共用**有界并发池**：同时最多 `research.concurrency` 维在跑（1–4 整数，缺省 2；显式非法值 console.warn 并忽略回落缺省）。语义保证：`dims` 数组**按 `--dim` 顺序回填**（index 写回，与完成先后无关）；rollup 重算与完成顺序无关；单维失败隔离语义不变。同主题并行 multi 的 topic-id 撞车在**落盘瞬间复检**、自动续派 `-2…-9`（`writeTopicAuto`，'wx' 排他创建；不做跨进程文件锁——复杂度与收益不成比例；派生后 id 可能平移后缀，各维 brief 保留原命名空间）。
## 消费方 agent 的标准动作

1. 读 `usage.internal_decision`：`ok` → 可直接引用其 `claims[].status=supported` 的条目做决策；`needs_review` → 只引用 supported 条目并人工核 `blockers`；`unsafe` → 禁用该 brief（可在 `research-void/` 归档）；`undetermined` → 先补 `research verify` 或重跑调研。
2. 引用具体数字前看对应 claim 的 `status` 与 `note`——**只采信 supported；partial 需注明依赖转述**。
3. `fabricated_claims > 0` 或 `blockers` 非空：逐条人工复核后再用。
4. L3 趋势：`research stats` 按调研船模型看核实率——低分模型的产物默认 needs_review。台账条目以 `researcher_model` 记调研船（L2 条目的 `model` 是复核船）；旧条目无该字段时回退 `model` 分组。

## 判级与分数的对应（供人读）

`pass ≥75` / `warn ≥50` / `fail <50` / `unknown（overall=null）`。**判级只是排序信号，决策请以 usage 矩阵为准。**
