# Spec 审查规约（spec-review rubric）

> spec 三件套（requirements / design / tasks）的分层审查标准与 verdict 契约。给三类读者：
> ① 未来 `spec review` 命令的 L2 审查船 prompt 注入源；② 人工审设计的 checklist；③ 审查结果消费方的语义依据。
> 与 `research-verdict.md` 同哲学：**agent 审查一律 advisory**——结论只做筛查与建议，`spec build` 拆卡（进入真实施工）永远人工拍板。
> 依据来源见文末引用（带日期）；本文件是活文档：误报/漏报案例发生后回填 §6。

## 0. 分层模型（与调研可信度判定同构）

| 层 | 手段 | 产物 | 性质 |
|---|---|---|---|
| L0 确定性门 | 纯脚本零 token：三件套齐全、tasks 可解析、依赖无环、文件路径存在、红线关键词扫描、TBD/模糊词扫描 | gate 清单（pass/fail 逐项） | fail 即 block，不可调试通过 |
| L2 审查船 | readonly headless 会话，读本规约 + 三件套 + 仓库只读探索 | spec-verdict/1（JSON 契约块） | **advisory**——needs_revision 也只是建议，拆卡权在人 |
| L3 台账 | 每次审查记 ledger（模型/维度分/结论） | 趋势对账（L4 雏形，暂缓） | 观测 |

## 1. 五个评分维度（0-100，权重合计 100）

### 1.1 完整性 completeness（权重 25）
- 每个用户故事都有对应验收标准，反之亦然（故事↔验收可互溯）。
- 边界与异常路径有覆盖：非法输入、空态、并发/重入、失败回滚至少各出现一次或显式声明不适用。
- 无悬空术语：引用的概念（配置键/端点/卡字段）在 requirements 或 design 里有定义。
- 非功能约束（性能/安全/兼容/Windows 三平台）按需声明或显式标注「不适用及原因」。
- 出现「待定/TBD/后续再说」未给判定条件 = 直接扣；「[NEEDS CLARIFICATION]」类显式标记可接受（Spec Kit 惯例：显式未知优于隐性遗漏），但每个标记必须附「何时、由谁裁决」。

### 1.2 无歧义性 unambiguity（权重 20）
- 每条验收标准只有一种解释；验收标准尽量落 EARS 结构（WHEN/IF/THE SYSTEM SHALL…）。
- 模糊词黑名单（出现即逐处扣分并要求改写）：「合理」「适当」「尽量」「优化」「等」作列举收尾、「基本上」「相关」。
- 数字化：凡可量化的（阈值/上限/超时/条数）必须给出具体值或给出「由谁在何时定」。
- 验收标准禁止写成实现描述（「用 X 库做 Y」）——那是 design/tasks 的职责。

### 1.3 一致性 consistency（权重 25）
- 三件套互溯：tasks 每张卡的完成条件可回溯到 requirements 的验收标准；design 不引入 requirements 没有的行为承诺。
- **现状声明对账**（本规约的杀手锏，来自调研教训「引用存在≠引用支撑」）：design「现状」节引用的每个代码事实（函数名/文件:行号/行为描述）必须与仓库真实状态一致——审查船必须打开被引文件核实，行号漂移、符号不存在、行为不符都算 P1 finding。
- 术语全仓一致：同一概念不换词（「任务卡」/「work item」混用即扣）。
- 不与 workflow.json 既有约束矛盾（testCmd/maxWorkers/protectedPorts 等）。

### 1.4 可验证性 testability（权重 20）
- 每张卡的完成条件是**可执行断言级**（命令 + 预期输出 / 测试文件名 + 用例名），不是「完成 XX 功能」。
- 验收标准能映射到测试：每条 EARS 语句至少指明一类可验证手段（单测/门禁脚本/CLI 冒烟）。
- 指明测试范围分层口径（相关用例优先，见 AGENTS.md 测试指南），不许「跑全量」当完成条件。

### 1.5 可行性与范围对齐 feasibility（权重 10）
- tasks 引用的文件路径真实存在（L0 会查，L2 复核改动合理性）。
- 触达 corePaths/releasePaths 的卡必须显式声明并给出保护思路（workflow.json reviewNotes 红线逐条对）。
- 卡粒度：每张卡可独立合并（独立绿、不依赖未合并邻居）；依赖图成 DAG。
- 与罗盘对齐：spec 不得引入与项目定位冲突的功能面；对齐声明不空泛。

## 2. 红线 gate（两级裁决：L0 扫描升级义务，L2 终审 blocked，无评分）

红线语义（L2 审查船据以下判 violation）：

1. 任务触达 protectedPorts（8687/8890）任何形式。
2. 引入 native addon、破坏 `src/cli.ts` 三路分发、绕过 `atomicWrite()`、硬编码 `~/.modeldock` 路径。
3. 提交/push/发布类动作写进任务完成条件（合并终点永远是本地 develop）。
4. 规划绕过人工闸门（把「spec build」「approve」写进 agent 自动步骤）。

**两级裁决协议**（2026-11-10 定）：L0 关键词扫描命中 ≠ 违规——spec 文本完全可能合法地提到
8687（如「绝不触碰 8687」）或 atomicWrite（如「改设计规避绕过 atomicWrite」）。命中只产生
L2 的**逐条裁决义务**：审查船必须在 gates.notes 对每个命中标注 violation / legitimate-mention，
存在 violation 才 gates.redlines=fail → verdict=blocked。L0 命中清单随 prompt 注入，不得跳过。

## 3. spec-verdict/1 契约（L2 审查船输出）

```json
{
  "spec": "<spec-id>",
  "reviewer": "<model>",
  "gates": {"redlines": "pass|fail", "notes": ["…"]},
  "dimensions": {
    "completeness": 0-100, "unambiguity": 0-100, "consistency": 0-100,
    "testability": 0-100, "feasibility": 0-100
  },
  "overall": 0-100,          // 加权和，维度缺失即 null（不猜测）
  "findings": [               // ≤12 条，按严重度排
    {"severity": "P0|P1|P2", "file": "specs/<id>/xxx.md", "section": "§节名/行号",
     "claim": "审查员断言（须与 spec 原文可对账）", "why": "依据（引用本规约条目或代码事实）", "fix": "一句话建议"}
  ],
  "usage": {"build_ready": "approve_to_build|needs_revision|rework|blocked"},
  "advisory": true
}
```

**硬纪律（防编造，同 research 逐字哲学）**：
- finding 的 `file` 必须真实存在且属于该 spec 三件套或被引代码文件；`section` 必须是该文件真实存在的节名或行号区间——L0 机器可对账，对不上 = 该 finding 判 fabricated 并整体降档。
- `claim` 涉及 spec 原文时必须可逐字定位（空白归一后 substring 匹配）；涉及代码事实时审查员必须实际打开文件核实过。
- 维度分不确定就给 null 并在 usage 说明，禁止拍脑袋填数。

**usage 判定矩阵**：

| build_ready | 条件 | 人侧动作 |
|---|---|---|
| blocked | 任一红线 gate 命中 | 改 spec（红线不可审过） |
| rework | overall<50 或 P0 finding ≥2 或 现状对账 2 处不符 | 退回重写三件套 |
| needs_revision | overall 50-79 或 P0=1 或 P1 ≥3 | 人改具体条目后可直接 build |
| approve_to_build | overall≥80 且 P0=0 且 P1≤2 | 人确认即可拆卡 |

## 4. L0 确定性检查清单（脚本实现口径）

1. 三件套文件齐全且非空（requirements/design/tasks）。
2. tasks.md「## 任务 N:」可解析（复用 parseTasksDoc），每段 目标/文件/完成条件/依赖 四行齐全。
3. 依赖图无环、依赖 id 均存在于本 tasks.md。
4. 「文件」行路径（files_hint）存在性（支持 `src/gateway/` 目录形式与 `a.md` 文件形式；通配符查前缀目录）。**缺路径是 warn 不是 fail**：任务引用拟新建文件（新测试/新模块）时路径不存在是合法的——裁决义务交 L2（新建=正常；修改既有文件却写错路径=P1）。fail 只留给让审查无法进行的结构性问题（2026-11-10 首跑真 spec 误判后修正，见 §6）。
5. 红线关键词扫描（§2 清单）扫三件套全文。
6. TBD/待定/后续再定 标记计数（report-only，进入 completeness 扣分依据）。
7. finding 定位对账（§3 硬纪律）——L2 输出落地后机器复核 file/section 真实性。

## 5. 与既有机制的关系

- **审查船模型解耦**：与 research verify 同口径——backend 缺省 review.backend、model 缺省 review.model（异构互审）。
- **不改人工闸门**：`spec build` 前人审仍必须；审查器只是把「人肉通读 74 行找问题」变成「人只裁决 findings 清单」——这正是界面不好审的解法：verdict + findings 即审查报告。
- **与 research verdict 的衔接**：design 引用调研结论时（--from-brief 产物），审查船核对 brief 引用确实支撑对应设计决策（用 verdict.json 的 claim 判级，不重跑调研）。
- **台账**：appendResearchLedger 加 kind:'spec-review' 记录（复用基建，不新建库）。

## 6. 误报/漏报案例回填（活文档）

- **2026-11-10 首跑真 spec（research-verbatim-precision）——L0 自身误判被实测纠正**：任务 2 引用拟新建的 `test/orchestrator/research-verbatim.test.ts`，路径不存在被旧逻辑判结构 fail → 提前 die 不烧 L2。教训与 §2 红线同哲学：**确定性层管机械事实，语义裁决交 L2**——「缺路径」无法机器区分「新建文件」与「typo」，降 warn 交裁决。fail 集合收敛为：三件套缺失、任务段不可解析、依赖悬空/成环。

- **2026-11-09 首跑（research-verdict-trust-fixes 试点）——零误报，捕获真漂移**：spec 21:18:31 写就，develop 21:31:42 合入 753a1b4（L2 仲裁轮+verifier 日期硬规则，另一会话实施），「现状」节整体过期——L2 审查船经现状对账判 rework（overall=73，consistency=45），4 条 P1 全部经人工复核为真（行号漂移 3 处、prompt 硬规则已存在、docs 认领缺口、守卫×仲裁轮顺序交互未讨论）。教训固化：**「现状」节定位一律用 符号+函数名，行号只作辅助**——行号漂移是常态不是事故；L0 补一条「spec 落盘时间晚于 HEAD 提交时间的审查警告」可提前暴露基线漂移。

## 7. 依据来源

- 2026-11-09 https://juejin.cn/post/7646820023195762697 — GitHub Spec Kit（官方 SDD 工具包）七阶段流程：constitution 治理原则 / specify 用户故事+验收标准 / clarify / plan / tasks；「显式未知（[NEEDS CLARIFICATION]）优于隐性遗漏」惯例（经 BigModel 搜索引擎检索快照，GitHub 直连超时）
- 2026-11-09 https://blog.csdn.net/weixin_37786060/article/details/153220821 — Spec-Kit 五阶段与命令清单（2025-10-13）
- 2026-11-09 https://blog.csdn.net/lllooollpp/article/details/160191990 — SDD 动机：约束层前置，解决「写错了还以为自己写对了」（2026-04-15）
- 2026-11-09 https://blog.csdn.net/u011281853/article/details/54098583 — 需求文档质量特性六条：无歧义/完整/可验证/一致/可修改/可追踪（IEEE 29148 / Wiegers 口径的中文实践转述）
- 2026-11-09 http://mp.weixin.qq.com/s?__biz=MzI2ODY0ODM2Ng==&mid=2247492148&idx=1&sn=355ac1f2c9f4b6f878d6de32991cae82 — Spec-Kit constitution=「家规」：所有阶段必须与宪法兼容（2026-08-31）
- 背景知识（未逐条溯源，按惯例采用）：EARS 需求语法（Mavin & Wilkinson）、Google design doc 惯例（现状/方案/取舍/风险/跨切面）、ADR。已在本仓 requirements/design 模板中落地。
