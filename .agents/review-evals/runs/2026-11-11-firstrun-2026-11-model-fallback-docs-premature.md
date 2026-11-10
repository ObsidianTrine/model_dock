发现 3 个问题——审查对象：提交 dbebff0（CHANGELOG/README 双语文档 + src/gateway/state/logs.ts 观测字段）。盲评口径：仅依据所给材料判断，行号以材料内 diff hunk 标注/换算为准，未读仓库源码。

## 问题 1 [P1·blocker] 文档把未实现的 model_fallback 当作"已可用"交付，当前发布版用户照做必空转

**性质**：文档与代码行为不一致（REVIEW.md 文档标准："它撒谎即失败"），由本提交引入。

**证据（全部来自所给材料）：**
1. 本提交 src/ 侧改动仅 `src/gateway/state/logs.ts`：新增 `tokens_by_model` 接口字段（约 313–316 行）、累加器初始化（约 340 行）、per-model 累加块（约 366–373 行）、summary 产出（约 405 行）。整个 diff 里不存在 model_fallback 的任何实现：没有网关路由/重试逻辑，没有 config.toml 对该字段的解析或校验，没有 CLI/控制台写入口的价格闸门代码。
2. 提交信息自述：CHANGELOG "补建 [未发布] 段（**原无未发布段**）加模型级容灾条目"。按仓库"对外文档随代码同步交付"的纪律，若 model_fallback 已在更早提交实现，[未发布] 段应早已存在；材料内看不到任何更早的实现提交。
3. CHANGELOG 把该功能记入 [未发布]/[Unreleased] → 截至 1.7.2（最新发布版）不存在于任何已发布版本。

**后果**：README 新增小节（README.md，hunk @@ -132,6 +132,17 @@，新增约 134–144 行）与 CHANGELOG.md:8–12 以"在 config.toml 服务段写 `model_fallback = {...}` **即启用，改完热加载即时生效**"的口吻指示用户配置。对已发布版本的用户，这是配置一个没有任何代码读取的字段——无论该键被静默保留还是被丢弃，承诺的兜底行为都不会发生；"CLI / 控制台写入口校验价格闸门"同样无实现可对。文档未标注"自哪个版本起可用"。docs/en/CHANGELOG.md:8–12、docs/en/README.md 同款。

**前提与置信**：强结论（功能完全未实现）依赖"实现不在更早的未发布提交里"，由证据 1/2 支持但材料内无法 100% 排除无公告的实现提交；即便退这一步，"对已发布版本不可用却按当前可用口径写、无版本标注"仍然成立。

**修复方向**：实现先行（或与文档同一提交落地），或把表述改为"即将支持"并标注可用版本。

## 问题 2 [P2] README 指向配置参考的"字段说明"是死指针（前提同问题 1，同类 2 处）

- README.md 新增段末行（约 143 行）："字段说明见[配置参考](docs/config-reference.md)"；docs/en/README.md（约 143 行）"[config reference](config-reference.md)" 同款。
- 提交信息明确 "docs/config-reference、截图、relay/server/cli 等并行属地**未触碰**"。model_fallback 若是本发布周期的新字段，未更新的配置参考不可能包含它的字段说明——docs-lint 绿只保证链接可达，不保证内容存在。指向空承诺。
- 修复：随实现补 zh/en config-reference 条目，或移除该指针。

## 问题 3 [P2] 触发条件表述与功能目标自相矛盾（zh/en 共 4 处同款）

- CHANGELOG.md:12、docs/en/CHANGELOG.md:12、README.md 新增段（约 136 行）、docs/en/README.md（约 136 行）：
  - 标题句承诺："主力模型额度耗尽时，网关自动改发同服务的备用模型重试，**不再一耗尽就把流量切去别家**"——即先试同服务备用模型、后走跨服务兜底；
  - 触发条件句却写："仅额度耗尽类错误（HTTP 402，或 429 且错误体带额度特征）**且该服务的备用服务链都走完才触发**"（EN："only after the provider's backup chain is exhausted"）——字面 = 先走完跨服务兜底链、才轮到模型级容灾。
- 两句互斥：按触发条件句，额度耗尽时流量已经切去别家，标题句的核心承诺落空；反之则条件句把顺序写反。无论实现取哪种顺序，读者无法从文档确定真实行为。此条不依赖问题 1 的前提，独立成立。

## 存疑

1. **logs.ts per-model 键控的原型污染向量**（src/gateway/state/logs.ts 约 368 行 `tokensByModel[e.model] ??= {...}`，普通对象作 map）：若某条日志 `model === "__proto__"`，属性访问命中的是 Object.prototype（非 nullish，`??=` 不触发赋值），后续四桶 `+=` 会把 `input_tokens` 等值为 NaN 的属性挂上 Object.prototype，进程级污染（`"constructor"` 键同理、危害较小）。机制按 JS 语义是确定的，但材料内无法确认 model 字符串能否取到该值（取决于网关对模型名的约束与日志落盘/回读路径），故不作确定缺陷上报。建议改 `Map` 或 `Object.create(null)`。
2. 提交信息称"共享累加器使流式路径（summarizeUsageDays）……天然带出新字段，零接线改动"——若该路径是按日合并既有 Summary 而非逐条目过共享累加器，tokens_by_model 不会跨日聚合。summarizeUsageDays 实现不在材料内，无法核实。
3. 提交信息声称的 test/usage-cost.test.ts +3 用例与 orchestrator.md B5 修改未附 diff，无法核实（按材料截断处理，不计缺陷）。
4. "config.toml 手编只做形状校验"等于披露手编可绕过价格闸门——README 已如实披露，属产品取舍而非撒谎，不报。

---
Blocker：1（问题 1）。
