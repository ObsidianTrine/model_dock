# runOrch 进程内化预研报告（test-orch-inproc · 测试提速方案 B）

> 任务卡：`.agents/orchestrator/queue/pending/test-orch-inproc.md`（船东 2026-11-03 入队）。
> 预研范围：test/orchestrator/helpers.ts 的 `runOrch`（每用例 execSync 一个完整 `node orchestrator.mjs` 子进程）改为进程内直调的可行性。**本卡只做预研不实施**。
> 分析基线：orchestrator.mjs 3659 行 + `orchestrator/` 30 个子模块（46 个 mjs，840KB）；工作流套件 659 用例 / runOrch+tryOrch 共 320 次调用 / mkRepo 332 次。
> 预研日期：2026-11-04。本报告随预研分支合并，实施时以本文为纲。

## 一、结论（先行）

**可行，但单独实施收益有限，达不到卡面 467s → ~100s 目标。**

- 技术面干净：argv 单点、process.exit 单点（`die()`）、无顶层副作用语句、子模块零 argv/env 直读、`isMain` 直跑守卫在 `.agents/scripts` 已有先例（approval-listener.mjs:324）——拆 `main(argv, opts)` 纯入口是低风险小改动。
- 收益如实测算：CLI boot 实测 165–198ms/次，320 次全按轻命令算上限 ≈ 64s，打折扣后 **预计节省 40–55s（约 10%）**。缺口的大头不在 CLI boot，而在每条用例的子进程工作量（git worktree 生命周期 / 门禁 / mock worker / git 提交链），进程内化触不到它们。
- 要逼近 ~100s 必须叠加替代降耗方案（§六）：慢文件用例审计（B2）+ 构建仓库成本削减（B1）+ 用例级并行预研（B3，另立卡）。
- 建议：阶段 1（纯入口拆分，仅接入轻命令用例）收益风险比最高，可独立交付；阶段 2+ 视阶段 1 实测收益再定投入。

## 二、① argv / env / 顶层副作用清单

### argv（单点）
- `orchestrator.mjs:3502`：`main()` 内 `const argv = process.argv.slice(2)` —— 全 CLI 唯一 argv 读取点。
- 30 个子模块（`orchestrator/*.mjs` + `orchestrator/backends/*.mjs`）：process.argv 直读 **0 处**。

### process.env（orchestrator.mjs 内 15 处，真实读取仅 6 处）
| 行 | 读取 | 用途 |
|---|---|---|
| :78 | `ORCH_RETRY_WAIT_MS` | retry 退避间隔 |
| :323 | `ORCH_APPROVE_BACKEND_SWITCH` | 引擎切换人工批准旁路 |
| :1409–1410 | `ORCH_FINISH_RETRY_ATTEMPTS` / `ORCH_FINISH_RETRY_DELAY_MS` | finish 重试参数 |
| :2800、:3506 | `process.env.CI` + `process.stdin.isTTY` | interactive 判定 |

其余 9 处均为 `env: { ...process.env, ...childEnv }`（构造子进程环境，直调语义下原样保留）。
子模块：process.env 直读 **0 处**（deps.mjs 等的 env 构造为传递型）。

### 顶层副作用（import 即执行的语句）
- **无**。awk 全量扫描 46 个 mjs 的列 0 执行语句 0 命中。
  - 例外说明：`orchestrator.mjs:1807` `const next = pickNextCard(root, { skipIds });` 列 0 是格式瑕疵，实为 cmdDrain 循环体内语句（上下文缩进可证），非顶层执行。
- 顶层 const 仅路径类纯函数调用：`:70 HERE = path.dirname(fileURLToPath(import.meta.url))`，无 IO。
- 尾部 `main().catch((e) => die(...))` 是唯一自动执行入口 → 加 `isMain` 守卫即可（先例：approval-listener.mjs:324 `pathToFileURL(process.argv[1]).href === import.meta.url`；reviewer-eval.mjs 用 argv[1] 基名判定同效）。
- 子模块无可变模块级单例：weather/budget/nightly-state 扫描 `^let` / 顶层容器 0 命中；`Budget` 是按次实例化的类；风暴闸「每次派发前现算（无状态）」（orchestrator.mjs:1797 注释自证）。

### import 面与 SEA 约束
- orchestrator.mjs 仅 import node: 内建 + 相对路径子模块（queue/events/budget/weather/prompt/gates/backends/…），零第三方依赖——直调 import 无安装成本。
- `import.meta` 在 `.agents/scripts` 已有 4 处使用（orchestrator.mjs:70、feature-branch.mjs:62、approval-listener.mjs:281/324、workflow-config.mjs:81）。AGENTS.md 的 import.meta 禁令限 `src/**`（SEA CJS 输出下失效）；`.agents/scripts` 不进 SEA bundle，isMain 守卫可用。

## 三、② `main(args, env)` 纯入口拆分改动面评估

改动集中在 2 个文件，均为卡面 files_hint 范围：

### orchestrator.mjs（4 处小改）
1. `async function main(argv = process.argv.slice(2))` —— :3502 一行。
2. `die()`（:111–114）出口可注入：
   ```js
   let fatalExit = (code) => process.exit(code);
   export function setFatalExit(fn) { fatalExit = fn; }   // 测试注入 throw ExitError
   function die(msg, code = 1) { console.error(`[orchestrator] ${msg}`); fatalExit(code); }
   ```
   已核实 process.exit 全 CLI 唯一真实调用点就是 die()（其余 4 处 grep 命中均为注释/字符串）；`main().catch(die)` 兜底路径随之覆盖。
3. `findRepoRoot()`（:88–108）参数化：`process.cwd()` 3 处 → `rootDir` 参数；调用方仅 2 处（main + 1）。
4. 尾部 `main().catch(...)` 加 isMain 守卫。

### test/orchestrator/helpers.ts（新增 inproc 路径，保留 execSync 路径作对照/逃生门）
```ts
export async function runOrchInproc(repo, args, env = {}) {
  const out: string[] = []; const err: string[] = [];
  // 1) 捕获 console.log / console.error（orchestrator.mjs 的 log = console.log 包装是
  //    245/251 输出的咽喉；直呼 console 仅 6 处）
  // 2) setFatalExit(code => { throw new OrchExitError(code) })
  // 3) await main(args, { env: { ...process.env, ...env }, cwd: repo })
  // 4) finally 还原 console / fatalExit（防跨文件泄漏，见 §五-3）
  // 5) OrchExitError → { status: code, stdout: out.join(''), stderr: err.join('') }
  //    正常返回 → { status: 0, ... }
}
```

### env 线程化
`main(argv, opts)` 增 `opts.env` / `opts.cwd`；§二表 6 处真实读取改为 `const env = opts.env ?? process.env`（一次性入口快照，全链路透传）。子模块不动。

## 四、③ execSync → 直调语义差异对齐清单

| 维度 | execSync 现状 | 直调后差异 | 对齐方案 |
|---|---|---|---|
| exit code | 子进程退出码，tryOrch 捕获 | `die()` 若未拦截 = **真杀 vitest fork（isolate:false 单池 = 整套件崩）** | fatalExit 注入，唯一 exit 点已核实 |
| stdout/stderr 捕获 | stdio pipe 全量捕获，**含孙进程 inherit 输出经 fd 流入管道** | console 拦截只覆盖 log()/die()（245/251 处）；**约 10 处 `stdio:'inherit'` 孙进程**（feature-branch run 子进程 :1755/:1847/:1914/:2387、npm ci deps.mjs:22、worker spawn :2863/:2901/:2909 等）直写宿主进程 stdout，绕过拦截——断言 gate 消息 / finish 输出 / worker 输出的用例会拿不到文本 | 阶段 1 只接无孙进程断言的轻命令用例；阶段 2 将 inherit 站点改 pipe + 经 log() 转发（~10 处，中等改动面）后接入 run/drain 用例 |
| cwd | 每次调用 cwd=临时仓库 | 直调共享 vitest cwd（=真实仓库根），findRepoRoot 会解析到**主仓库**——submit/run 会操作真实队列 | `main(argv, { cwd })` 参数化 + runOrchInproc 入口断言 `findRepoRoot() !== WORKTREE_ROOT` 防御性检查 |
| env | 每次调用注入独立 env | 直调共享 process.env，跨用例/跨文件泄漏 | §三 env 线程化；测试不再直接改 process.env |
| 超时 | execSync timeout 240s → SIGTERM | vitest testTimeout 20s 管辖（套件现无 per-file 覆盖，实测基线用例最重 <20s）；240s 只是 execSync 侧安全上限 | 直调用例沿用全局 20s；超限用例显式放宽（显式声明优于隐性 240s） |
| maxBuffer 32MB | 超限抛 ENOBUFS | 直调无上限（字符串累积） | 无需对齐（现无用例触顶） |
| 交互判定 | stdio ignore → isTTY=false | vitest 下 isTTY 同样 undefined | 语义一致，无需对齐 |
| process.exit 意外路径 | 子进程崩 = 该次调用失败 | 未捕获 exit = 整套件崩 | fatalExit 全覆盖（§三-2）+ finally 还原 |

## 五、④ 风险清单

1. **[高] cwd 漏参数化 → 写穿主仓库**：findRepoRoot 直调时解析到真实仓库根，run/submit 会动真实 `.agents/orchestrator/queue/`。对齐见 §三/§四；runOrchInproc 内置防御断言。
2. **[高] die 未完全拦截 → 整套件被杀**：已核实唯一 exit 点，但注入必须配 finally 还原；`main().catch` 兜底与门禁内 `die` 同链路覆盖。
3. **[中] vitest 隔离模型两条硬约束（AGENTS.md「vitest 隔离模型」节）**：
   - 直调 import 后 orchestrator.mjs 及 30 个子模块成为**全进程共享单例**——现有套件仅 hygiene.test.ts 用 vi.mock（不涉 orchestrator.*），无既有冲突；**inproc 化后立规：禁止对 orchestrator.* 做 vi.mock**（谁 mock 谁污染全进程）。
   - 注入的 fatalExit / console 替换必须 finally 还原，否则一个失败用例污染后续所有文件（表现为「单独跑绿、一起跑红」）。
4. **[中] inherit 孙进程输出绕过捕获**（§四）——混合模式（阶段 1 只接轻命令）是最低风险解；全量接管前必须完成 pipe+转发改造并逐文件验证断言。
5. **[低] drain→run 子进程边界是产品语义，不是测试开销**：架构注释明确「熔断 process.exit 不伤 drain 主循环，与派 run 子进程同哲学」（:1613/:1718/:2877）——inproc 只改**测试 harness 调 orchestrator** 这一层，绝不把 drain 内部的 run 子进程内联。
6. **[低] Windows**：直调少一层 spawn `.cmd` 包装差异，fatalExit/console 替换平台无关；风险面反而收窄。
7. **[低] 报告可靠性**：收益测算基于 boot 实测（§六），未计 vitest 帧调度差异；阶段 1 实测后修订。

## 六、预估收益与替代 / 叠加方案

### 进程内化收益（如实测算，非目标倒推）
| 项 | 实测 | 来源 |
|---|---|---|
| 裸 node 启动 | 84ms | `time node -e "1"` |
| orchestrator.mjs boot（usage 路径） | 165ms | `time node orchestrator.mjs` |
| 轻命令全链（status） | 198ms | worktree 实测 |
| runOrch/tryOrch 调用总数 | 320 次 | grep 普查 |

上限估算：320 × ~0.15s（净除裸启动）≈ **48–64s**；重命令（run/drain，占调用大头）boot 占比更低，实际 **40–55s**。即基线 <套件总耗时见 §七回填> → 约 −10%。**单独实施达不到 ~100s。**

### 叠加方案（按风险从低到高）
- **B1 构建仓库成本削减（零风险）**：mkRepo 332 次 × cpSync 36ms ≈ 12s（改子集复制/模板缓存可省大半）；runDrainWithoutNode 的 node 二进制整拷 3 次（drain.test 2 + hygiene.test 1）≈ 3s。
- **B2 慢文件用例审计（低风险）**：对 top 慢文件逐用例审视「是否必须跑完整 run/drain」——能换轻命令（submit/status/logs）或改读事件文件（eventsOf）断言的改造验证路径，不改被测行为。缺口大头在此（§七回填 top10 慢文件）。
- **B3 用例级并行（中风险，另立预研卡）**：池串行（isolate:false + maxWorkers:1）是 2026-10-01 CI 卡死事故的结构性防线（vitest.config.ts 注释），解冻前须在 CI 复证 vitest4 多 worker 稳定性。工作流套件用例互相隔离（各自临时 git 仓库、无共享端口/锁），并行理论可行，但**独立立项，不搭本卡车**。
- ~~B4 门禁内 npm ci~~：核验为伪——测试仓 workflow.json 不带 setupCmd（仅 agent-init.test.ts 一个用例显式配 `npm ci --prefer-offline` 走失败告警路径，秒级），临时 worktree 无真实安装成本。

### 分阶段实施顺序（船东批准后执行）
1. **阶段 1（低风险）**：§三 全部改造 + runOrchInproc 只接轻命令用例（submit/status/logs/reconcile/stats 等无孙进程输出断言的），实测收益落 NOTES.md，全绿合并。
2. **阶段 2（中风险）**：inherit 站点 pipe+转发 → 接入 run/drain 用例，逐文件迁移，execSync 路径保留为逃生门。
3. **阶段 3**：叠加 B1/B2；B3 另立预研卡。

## 七、验收对账与基线数据

- [x] ① argv/env/顶层副作用清单 —— §二
- [x] ② main(args, env) 改动面评估 —— §三
- [x] ③ 语义差异对齐清单 —— §四
- [x] ④ 风险清单 —— §五
- [x] 结论：可行 + 分阶段顺序 + 如实收益测算 —— §一/§六
- [x] 预研分支 test/orchestrator 全量用例全绿 + 基线耗时 —— 本机实测（2026-11-04 00:06–00:36 两跑）：

### 基线实测（本机，mac darwin 22.1.0，后台跑分）
| 跑次 | 起始 | 总耗时 | 结果 |
|---|---|---|---|
| 第 1 跑（冷缓存，机载其他任务） | 00:06 | **718s** | 760/761 —— cost.test.ts:214 `fuel.measured` 偶发红 |
| 第 2 跑 | 00:24 | **579.7s** | **761/761 全绿** |

- 套件现量：**761 用例 / 73 文件**（卡面「659 用例 / 467s」为 2026-11-03 前口径，套件已增长；467s 亦为彼时机况）。
- **cost.test.ts:214 偶发红（非本卡引入，预研分支未动任何代码）**：全量第 1 跑唯一红，单独复跑 13/13 绿、第 2 跑全量绿。失败断言 `expect(fuel.measured).toBe(true)`，机制排查：价目为 opts.table 注入（不走网络）、写读两侧本地日切分一致——唯一能到 measured:false 的路径是「时间窗内网关零请求」，即 `gatewayLogsDir` 的 env 优先解析（MODELRDOCK_FAKE_HOME 先于 cfg.gatewayLogDir）在某文件泄漏时读空目录。建议立卡复现定位（配方：全量跑 + 捕获 fuel.reason；本次未复现第二次）。已登记 known-issues（本报告合并同批）。
- **慢文件 top10（第 2 跑，占总 578s 比例）**：sail 75.0s、integration 59.7s、drift 46.4s（top3 = 31%）；parallel 25.2、incident 21.7、fastlane 21.4、merge-verify 20.8、l0-gate 17.8、predeparture 16.7、stats 16.1（top10 = 51%）。**B2 用例审计从 sail/integration/drift 三文件下手**——它们全是多段 run/drain 全闭环用例，是「每用例改轻命令/改读事件断言」收益最大的地方。
- 注：第 1 跑 `| tail` 管道吃了 vitest 退出码（exit 0 但有红，v1.5.2 已知教训），核验以 Test Files/Tests 行为准。
