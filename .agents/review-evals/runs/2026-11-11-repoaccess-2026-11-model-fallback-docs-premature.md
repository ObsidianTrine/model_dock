# repo-access 补测：2026-11-model-fallback-docs-premature（2026-11-11）

> **补测口径**：首跑（GLM-5.3-Flash 盲评）判「文档先于实现」+「句 1/句 2 自相矛盾」，但「超前描述需穷尽 grep」维度在盲评下不可测。本跑补 repo-access 口径：审查者站在 **dbebff0^（82cc5c8）历史树只读 worktree** 上，材料与首跑同款（`review-eval.mjs --dry` 产物，见同目录 `-material.md`），另有树内 grep / 只读 git 访问权（禁未来历史、禁树外仓库、禁联网）。
> **审查者**：deepseek-v4-pro（claude CLI 2.1.214 无头 `-p --permission-mode bypassPermissions`，cwd=历史树；模型流量经沙箱网关 127.0.0.1:18921 → claude-direct——Volces coding/agent plan 订阅过期后可选通道里的本集首个基线模型，与首跑 GLM-5.3-Flash 跨模型，维度对比为主）。
> **判分**：✅ **主维度审出**——报告明确「文档把 config 管道当成已上线的运行特性」，穷尽 grep 全仓 model_fallback 零运行时消费点（types.ts:48 类型、store.ts:60-79 形状守卫、ops/service.ts:156 写入口校验三处在案），并逐行核对 relay.ts 主路径（815 候选链循环 / 869-876 quota 走下一 provider 候选）无 model_fallback 分支。关键词启发式 2/5（未实现 ×2、消费 ×3；矛盾/超前/不存在字面未出现）。**原文抽验防假阳性**：relay.ts:815/:869-876、types.ts:48 行号与内容逐条属实，真审出非命中侥幸。
> **未抓子点**：CLI/控制台写入口「接线」面——resolveModelFallback 在树内**零调用方**（文档声称「CLI / 控制台写入口校验价格闸门」比审查者认定的更超前一层），审查者以函数存在即视为已有；`modeldock model list <服务id>` 存在性则核实无误（providers.ts:314 确在）。
> **附带发现**：tokens_by_model[model].input_tokens 把 cache_read/creation 计入、破坏四桶互斥口径（与 costOfUsage/collectPairs 对拍冲突）——099b697 未触及 logs.ts，真伪未定性，留档。
> **对照真实修复**：099b697 仅改 4 个文档文件（句 1 事实性修正 + 补 modeldock model fallback CLI 用法，CLI 由 20a1c7a 先行补齐）——本题根因即「文档先行」，与审查者主发现一致。

以下为审查者报告全文（未改动）：

---

# 审查报告：提交 dbebff0（model_fallback 对外文档 + tokens_by_model per-model 四桶）

审查方式：只读。工作目录为 dbebff0 的父提交检出（改动未合入时的树），结合给定 diff 与当前树内可达历史交叉核对。

## 顶层结论：发现 2 个问题

1. **[P1] 文档「撒谎」：CHANGELOG / README 声称 model_fallback（模型级容灾）已实现并「即启用 / 热加载即时生效」，但网关路由代码里根本没有消费 `model_fallback` 的运行逻辑** —— 只有 config 侧的类型 + 形状守卫 + 写入口价格闸门。这是「文档与代码行为不一致」。
2. **[P1] `tokens_by_model` 的 `input_tokens` 桶把缓存读/缓存建也加进去，破坏「四桶」互斥口径** —— 与全仓既有 `costOfUsage` / `collectPairs` 的「input 为纯输入、四桶互斥」约定冲突；若把该桶喂给成本公式会对缓存重复计费。

---

## 问题 1（P1，主发现）：model_fallback 运行行为未实现，文档却宣称已上线

### 证据链

**A. 文档新增内容（本 diff 引入）直接断言功能可用：**

- `CHANGELOG.md`（新增「[未发布]」段，diff `@@ -5,6 +5,12 @@`）：
  > "网关自动改发同服务的备用模型重试，不再一耗尽就把流量切去别家……在 config.toml 服务段写 `model_fallback = { "主力模型" = "备用模型" }` **即启用，改完热加载即时生效**。"

- `README.md`（新增「模型级容灾」小节，diff `@@ -132,6 +132,17 @@`）：
  > "主模型额度用完时，**网关自动改发同服务里你指定的备用模型重试**……配置示例（**改完热加载即时生效**）"

- `docs/en/CHANGELOG.md` / `docs/en/README.md` 镜像同义：
  > "the gateway retries on a backup model of the same provider … **changes hot-apply immediately**"

**B. 但全仓检索 `model_fallback`，没有任何运行时消费点：**

`model_fallback` 只出现在：
- `src/config/types.ts:48` —— 类型声明 `model_fallback?: Record<string, string>`（仅有字段说明注释）。
- `src/config/store.ts:60-79` —— `guardModelFallbackShape`，只做「字符串→非空字符串」的形状守卫（启动/migrate 路径）。
- `src/ops/service.ts:156+` —— `resolveModelFallback`，写入口（CLI/控制台保存）的形状/自映射/环/目录成员/价格差校验。

以上全部是 **config 管道（类型 + 校验）**，没有任何「请求命中额度错误 → 改发同服务备用模型重试」的转发逻辑。

**C. 网关转发主路径（`src/gateway/relay.ts` `forwardWithFailover`）完全没有 model_fallback 分支：**

- 第 815 行 `for (const c of picked.ordered)` 遍历的是 **provider（服务）候选链**，逐个候选之间 failover。
- 第 869-876 行额度类错误（`quota`）的处理是 `canSwitch` → `continue` 到 **下一个 provider 候选**（`markReplay(c.providerId)`），并 `recordOutcome(..., cls:'quota')` 记熔断。
- 整段没有任何读取 `rt.config.providers[c.providerId].model_fallback`、也没有任何「同服务内改写 model 重试」的逻辑。

（另：本 commit 的 commit message 自己也承认 "orchestrator.md B5 …… 编排器零代码改动""relay/server/cli 等并行属地未触碰"，从侧面印证 relay 未接 model_fallback。）

### 结论

「配置段能写、写入口能校验价格闸门」≠「网关会按它改发重试」。文档把 config 管道当成了已上线的运行特性，用户照文档配置后并不会发生所描述的「同服务备用模型自动重试」。属 REVIEW.md「文档：与代码行为不一致——『它撒谎』即失败」。

> 补充：`docs/config-reference.md:55`（及 en 版）同样以「触发，改发同服务的备用模型重试」描述运行行为，但那是前一提交 eca52f9 生成器产出、**不在本 diff 内**，标 **[存量]**，不作为本 PR 的发现。

---

## 问题 2（P1）：`tokens_by_model[model].input_tokens` 把缓存读/缓存建一并计入，破坏四桶互斥口径

### 位置

`src/gateway/state/logs.ts`（本 diff 新增）。新增累加代码：

```ts
tm.input_tokens += (u.input_tokens ?? 0) + (u.cache_read_tokens ?? 0) + (u.cache_creation_tokens ?? 0)
tm.output_tokens += u.output_tokens ?? 0
tm.cache_read_tokens += u.cache_read_tokens ?? 0
tm.cache_creation_tokens += u.cache_creation_tokens ?? 0
```

（diff `@@ -355,6 +363,14 @@`，位于 `if (u)` 成功条目块内；接口字段新增于 `tokens` 字段之后，diff `@@ -307,6 +307,13 @@`。）

### 为什么是 bug

`tokens_by_model` 被描述为 "per-model **四桶**"，字段名 `input_tokens / output_tokens / cache_read_tokens / cache_creation_tokens` 与原始 `usage` 对象的四桶**同名同义**——在全仓既定口径里这四桶是**互斥**的：

- `src/providers/pricing-core.ts:54-68` `costOfUsage`：`cost = (input_tokens×input + output_tokens×output + cache_read_tokens×cacheRead + cache_creation_tokens×cacheWrite) / 1e6` —— 四桶各自独立计费，`input_tokens` 必须是纯输入。
- `.agents/scripts/orchestrator/cost.mjs:18-28` 与 `:39-55` `collectPairs`：per-(provider,model) 分桶 `p.input += u.input_tokens ?? 0`（**纯输入**），`cacheRead/cacheCreate` 单列；`:145-148` 把 `p.input` 映射回 `input_tokens` 喂给 `costOfUsage`。
- `.agents/scripts/orchestrator/reconcile.mjs:279-286` 的 `pairs` 分桶同样 `p.input += u.input_tokens ?? 0`（纯输入）。

而本 diff 把 `input_tokens` 设成 `input + cache_read + cache_creation`，与上述全部消费方冲突：

1. **同名不同义**：`usage.input_tokens`（纯输入）vs `tokens_by_model[model].input_tokens`（含缓存）——字段名一样，语义被偷换。
2. **四桶不再互斥**：把四桶相加得到 `input + output + 2×cache_read + 2×cache_creation`，缓存被数两次，不再是真实 token 总量。
3. **成本重复计费（具体失败场景）**：`tokens_by_model[model]` 形状与 `costOfUsage` 入参兼容，若直接喂给 `costOfUsage`，`cache_read` / `cache_creation` 会在自身 cacheRead/cacheWrite 价之外**再各被 input 价多计一次**。

### 根因与修复方向

作者注释写「缓存读+缓存建计入 input_tokens」，是照搬全局 `tokens.input` 的「总口径」（`logs.ts:354` `tokens.input = input + cache_read + cache_creation`，用于对账分歧率，注释已言明）。但全局 `tokens` 字段名是 `input`（且有意为之），而 per-model 是「四桶」结构、字段名带 `_tokens` 后缀、且要与 `collectPairs`/`costOfUsage` 对拍——两条口径被混用了。正确实现应为：

```ts
tm.input_tokens += u.input_tokens ?? 0   // 纯输入，缓存另计
```

并同步改掉「缓存读+缓存建计入 input_tokens」的错误注释。

### 为何测试没拦住

本 commit 自述新增 3 个用例（多模型分桶与全局桶互不影响 / 缺 model 跳过不落 (unknown) / 旧 Summary 无此键仍合法），没有一例断言 `input_tokens` 的**语义**（是否含缓存），故该口径错误可静默通过。

---

## 存疑 / 边界说明

- 「后来补的修复」具体方向我无法看到 dbebff0 之后的历史：可能是（a）把 model_fallback 运行逻辑补进 relay，或（b）删改这些提前发布的文档。无论哪个方向，**本 diff 引入的缺陷本身（文档描述未实现的行为）是确证的**。
- 问题 1 与问题 2 都未触及 REVIEW.md 的 P0 一票否决红线（无 8687/8890、无硬编码 `~/.modeldock`、无绕过 atomicWrite、无 import.meta.url、无 native addon、未破坏 cli.ts 三路分发），故均不判 P0。
- `docs/en/README.md` 的 `config-reference.md` 相对链接、中文 `README.md` 的 `docs/config-reference.md` 链接均可达（`docs/en/config-reference.md` 与 `docs/config-reference.md` 存在），`modeldock model list <服务id>` 命令存在——文档链接与命令名无错。
