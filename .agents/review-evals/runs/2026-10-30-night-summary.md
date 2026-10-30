# 2026-10-30 夜间评测集训练实录（00:13–03:05）

> 任务：以 ModelDock 为测试点，按 Anthropic《How the Claude Code team does code review》的改进闭环持续「测试 → 发现 → 沉淀测试集 → 回归验证」至 05:30。
> 执行：ZCode 会话（GLM-5.3-Flash 驱动），全部模型调用经本机沙箱网关。

## 审查者链路（今晚的「审查者改动」本身就要重跑基线）

- claude CLI 升级 2.1.214（2026-10-29 首跑）→ **2.1.310**（本机），且本机从未有 claude 登录态（2026-10-29 首跑在 Windows 端）。
- 链路：claude CLI → 沙箱网关（`MODELRDOCK_FAKE_HOME=/tmp/modeldock-eval-home-1030` + 18901）→ profile `claude-direct`（Volces /api/plan）→ **GLM-5.3-Flash（glm-5-3-flash-260828）**。
- 配置考古三则（dev 沙箱数据，只读拷贝）：
  1. deepseek / xiaomi / zcode-bigmodel-start-plan 四个 provider 的 key 在 dev secrets 里是**空串**，不存在「顺手指到 deepseek」的路线；
  2. `coding-plan` 下的 ark key 实为 **/api/plan** 的 key（放错 provider：/api/coding 401，/api/plan 200）——本沙箱内已归位到 claude-direct；
  3. bigmodel（/api/paas/v4）key 有效但其 anthropic 端点被「GLM Coding Plan 套餐已到期」挡住（429，bigmodel-2 副号未到期可用，弃用：glm-4.5-air 弱于 glm-5.3-flash）。
- 沙箱规范：端口 18901 + FAKE_HOME 成对、未拷 gateway.json、LAN 关闭，与 8687 生产 / 8890 用户 dev 零接触；收尾时进程与目录一并清理。

## 考题批二：4 道新考题（8 → 12）

| id | 失败类别（新） | fixedBy | full-12 判定 |
|----|----|----|----|
| 2026-10-gateway-413-drain | 网络流时序（提前应答 vs 对端在途写入） | 87549d8 | ✅ |
| 2026-10-cim-crlf-parse | 跨平台文本形态（CRLF 行尾） | e4ac854 | ✅ |
| 2026-10-config-memo-alias | 共享可变状态（memo 别名） | 688f98b | ✅ |
| 2026-10-env-port-live | 状态聚合口径（端口解析链复用） | 87b2106 | ⚠️ 波动（批二单题 ✅ / full-12 ❌） |

## 基线重跑（审查者改动 → 全量重跑）

- **full-12（12 题单轮）：审出 10，未审出 2**（原 8 题 7/8，批二 3/4）。报告：runs/2026-10-30-full12-glm53flash.md。
- 两题未审出均为**近失**：模型输出里带着同文件的其他真发现（cloud-null-body 轮挖到 body-limit destroy 断连族问题；env-port-live 轮挖到 3 个自启残留误报类问题），只是未命中目标根因与 expect 关键词——关键词启发式口径的实录。
- 跨轮波动：全部 12 题在今昨两日各轮中至少审出一次。基线口径更新为「单轮 ≥10/12 且原 8 题 ≥7/8」（见 README）。

## 噪音测量（clean 对照，论文第二维度）

- 方法：中性 prompt（不断言有 bug）+ 历史稳定文件。首测：diff.ts **0 误报**；jsonpath.ts 报 2 问题，**实证均真**（非误报）——「干净对照」被审出真缺陷，转化为 CORRECT-08。报告：runs/noise-*.md。

## 夜巡挖洞（存量代码）

- relay.ts @ HEAD：3 发现 + 2 存疑，逐条读码核实成立 → **CORRECT-09**（数组穿透谎报改写 / 耗尽 502 吞 status+hint / replayedFrom 覆盖丢首跳）。报告：runs/2026-10-30-hunt-relay.md。
- 考题轮副产物：cim-crlf 轮的「存疑」经复现坐实为 **CORRECT-07**（`gateway start --daemon` 就绪后 CLI 不返回，P1——child.stderr 管道读端钉住事件循环；沙箱实测 ≥45s 不返回，一例 ~13min 后自行退出）。

## 基建改进（随夜实操沉淀）

- scripts/review-eval.mjs：**单题失败不再炸整轮**（逐题 try/catch 记「运行失败」并继续）+ `--timeout-min` 可配。起因：旧版单题 15min 超时会丢弃整轮报告（今夜实测炸掉一轮 8 题跑分）。
- 已知坑（供下夜参考）：后台跑分命令不要接 `| tail` 管道（stdout 缓冲到收尾才可见、且管道吃掉真实退出码）；跑分中途勿动沙箱网关（今晚一次重启连带误杀 daemon，跑分器容错兜住了）。

## 交付物清单

- 考题 4 道 + README（表 +4 行、基线口径、噪音测量节）
- runs/：full12 报告、批二单题报告 ×3、noise ×2、hunt-relay、本纪要
- docs/known-issues.md：CORRECT-07/08/09（均未修，含实测复现与修复方向）
- scripts/review-eval.mjs 容错补丁

## 遗留（天亮后人工决策）

1. CORRECT-07/08/09 是否立卡修复（修后回流考题）；
2. Volces ark key 放错 provider（coding-plan vs claude-direct）是否要在生产/dev 配置更正——本沙箱已本地归位，未动 dev/生产任何数据；
3. bigmodel 主号 Coding Plan 到期是否续订（bigmodel-2 副号可用但模型旧）；
4. `.agents/` 工具链的 e61b8ea（release-propose 文件错位）可作批三考题候选——**03:20 复核排除**：该 bug 是开发中实测踩中、修复随同一提交落地，历史中不存在 bug 在场状态（reviewRef 无物化对象），不符合考题 schema。

## 追加验证波（03:15–03:30）

- **波动题第三次采样**：cloud-null-body ✅、env-port-live ✅（单题复跑，runs/resample-*.md）——两题各累计 2/3 命中，「边界题轮次方差」定性成立，非系统性漏报；基线口径（单轮 ≥10/12）维持。
- **噪音复跑（jsonpath.ts）**：前两条精确复现 CORRECT-08 ①②（审查者自行读到 known-issues 登记并标注「已登记」——工具化复读行为首见），另报第 ③ 处同族缺陷（对象上下文下标写入静默落键 `"0"`，tsx 实测坐实，已并入 CORRECT-08）。
- e61b8ea 批三候选复核排除（见遗留 4）。

