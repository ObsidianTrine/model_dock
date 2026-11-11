# 审查评测报告

- 考题：1，审出：1，未审出：0
- 模型：glm-5.3-flash
- 评分口径：expect 关键词命中（启发式），精确判定看原文

## 2026-11-orch-review-model-engine-coupling — ✅ 审出

- 考题：resolveEngine 把 engine 节 model 与 backend 连坐：backend 缺失即整节返回 null——JSDoc 承诺「model 可选」但只配 model 的配置被静默丢弃，review.model 声明位形同虚设（审查模型分源配置不可达，worker/review 长期同模型的隐性成因之一）
- 关键词：model=中，backend=中，静默=中，丢弃=中
- 完整输出：C:\Users\81424\AppData\Local\Temp\modeldock-review-eval-BB3ez1\2026-11-orch-review-model-engine-coupling.output.txt

<details><summary>模型原文</summary>

```text
## 发现 2 个问题

### 1.（P1，即后来 0fec018 修复的主 bug）engine 节 model 与 backend 连坐：只配 model 不配 backend 时整节被静默丢弃

**位置**：`.agents/scripts/workflow-config.mjs`（214e449 版本）:85（当前 HEAD 已修，见 721-729 行）

**证据**（214e449 引入的代码）：

```js
function resolveEngine(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const backend = typeof raw.backend === 'string' ? raw.backend.trim() : '';
  if (!backend) return null;          // ← L85：backend 缺失/空白 = 整节丢弃
  const model = typeof raw.model === 'string' && raw.model.trim() ? raw.model.trim() : null;
  return { backend, model };
}
```

**失败场景**：commit message 自己承诺的缺省语义是「backend 不配 → 审查走自动异构」，而接线层（`cfg.review.model → effReviewModel → spawn --model`、`review_spawned` 事件留痕）在同一提交里已就位。用户据此写 `review: { model: "opus" }`（只想换审查模型、引擎保持自动异构）——L85 直接 `return null`，model 被静默吞掉，审查回落默认模型，且**零告警**。这正是 REVIEW.md「配置与密钥：静默丢用户数据」的失败形态。后续修复提交 0fec018 的 message 明确承认：「只配 model 不配 backend 此前被静默丢弃……接线本体系 214e449 已有，本次为缺口修补」，并把签名改为 `resolveEngine(raw, name)`、`backend` 变为可选（`if (!backend && !model) return null`）。`worker` 节同型受累（同类还有 1 处，同一条修复覆盖）。

### 2.（P2，同修复一并补的缺口）非法 model 静默忽略，违反本文件既有的「显式写错必须告警」风格

**位置**：`.agents/scripts/workflow-config.mjs`（214e449 版本）:86

**证据**：`const model = typeof raw.model === 'string' && raw.model.trim() ? raw.model.trim() : null;` —— `review: { backend: "claude-headless", model: 123 }`（或纯空白字符串）时 model 被静默置 null，无任何输出。同文件同期已存在的 resolveWatchdog / resolveAutoResume 等对「显式给出但非法」的值一律 `console.warn` 点名键名（如 workflow-config.mjs:466-472 当前版本的 watchdog 同款逻辑）；214e449 的 resolveEngine 是唯一静默的例外。0fec018 补上了 `if (raw.model !== undefined && model === null) console.warn(...)`。

---

### 存疑

- **backend 值不做已知后端校验**：`backend: "claude-hedless"`（typo）会被原样放进 `{ backend, model }` 往下传。我没有读 214e449 时点下游 `resolveBackendName` 链 / spawn 预检（a755671 的「引擎预检」）对未知后端名的处理，无法确证它会 fail-fast 还是静默 ENOENT 逐卡烧 blocked，缺下游代码证据，故不作为问题上报。
```

</details>