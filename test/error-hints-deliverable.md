# error-hints-audit 交付清单：四类高频失败路径的可操作报错审计

> 卡面要求：①网关启动端口冲突 ②harness token 无效 ③上游连接失败/超时 ④同步任务失败，
> 每处必须带可操作修复 hint；≥6 处改进，全部 t() 双语同写，纯文案不改行为。
> 审计口径：四类路径逐点核对「报错是否说清发生了什么 + 用户下一步该做什么」。

## 改进清单（7 处）

### 1. 端口顺延穷尽仍抛裸 EADDRINUSE（①）
- 位置：`src/gateway/shared.ts` listenWithRetry（顺延 10 次后的 throw）
- 前文案：`listen EADDRINUSE`（Node 原始错误，无上下文）
- 后文案：`端口 {from}–{to} 全部被占用（起始为配置端口）：确认是否已有 modeldock 实例在跑（modeldock status），或查占用后改 config.toml [gateway] 的 port`
- 理由：11 连占最可能是「已有实例常驻/另一沙箱占用」，裸错误让用户既不知道试了哪些端口也不知道查什么；顺延过程中的逐次提示保留不变。
- 用例：`test/error-hints.test.ts`（连续占用 11 端口断言新文案）

### 2. 手机控制台（LAN）启动失败无下一步（①）
- 位置：`src/gateway/main.ts` startForeground 的 startLanServer catch
- 前文案：`[modeldock] 手机控制台启动失败：{msg}`
- 后文案：追加一行 `  多为 LAN 端口被占用：改 config.toml [lan] 的 port，或暂关 lan.enabled（网关本身不受影响）`
- 理由：LAN 端口冲突是该 catch 的绝对主因；网关本体在线但用户需要知道「这只影响手机端、怎么让手机端回来」。
- 用例：文案级（该分支需真实 LAN 监听冲突，端到端构造留运行时验证）

### 3. 上游连接超时与拒绝同文案（③）
- 位置：`src/gateway/relay.ts` forwardToUpstream 重试穷尽包装
- 前文案：两类都报 `上游连接失败：{msg}（{url}）`，hint 只有「检查网络/代理」
- 后文案：超时类单独报 `上游连接超时：{url}（已等满超时窗口仍无响应）`，hint `上游过慢或代理黑洞：modeldock test 验证；慢上游可在 modeldock config edit 调大 [gateway] 超时与 retries`；拒绝类保持原样
- 理由：「连不上」和「连上但等不到响应」的排查动作完全不同（网络/代理 vs 上游过慢/挂死）；isConnectTimeoutError 判定本就存在（backlog B2），只差文案分流。
- 用例：拒绝类由 `test/error-hints.test.ts` 断言 hint（超时类需真挂死上游，构造留端到端）

### 4. 自动路由全候选失败无 hint（③）
- 位置：`src/gateway/relay.ts` failover 穷尽（routeReason=down_all 的 502）
- 前文案：`自动路由：所有候选服务连接失败（{msg}）`（无 hint）
- 后文案：hint `modeldock test 逐个验证候选服务；常见根因：key 失效（modeldock provider set-key）、网络/代理不通、上游宕机`
- 理由：多候选全挂时用户面对的是「一堆服务都不行」——给出逐个验证入口与三大根因排序。
- 用例：文案级（需多死上游编排，拒绝类单候选已由 3 的用例覆盖同链路）

### 5. 云端心跳失败无排查口径（④）
- 位置：`src/sync/engine.ts` cloud heartbeat request catch
- 前文案：`云端心跳失败（{url}）：{err}`
- 后文案：`云端心跳失败（{url}）：{err}。检查网络与云端地址；地址变更需重新 modeldock sync enroll`
- 理由：心跳失败两大根因（网络抖动 / 云端地址变更）分属「等待恢复」与「重新 enroll」两种动作。
- 用例：文案级（需真实云端/可注入 http 端点，同链路由 sync 套件覆盖）

### 6. 云端心跳被拒（HTTP 非 200）无解释（④）
- 位置：`src/sync/engine.ts` 心跳响应 statusCode !== 200 分支
- 前文案：`云端心跳被拒（HTTP {code}）`
- 后文案：`云端心跳被拒（HTTP {code}）。401/403 多为设备凭据过期：重新 modeldock sync enroll；其余对照云端服务日志`
- 理由：401/403 是凭据生命周期问题（可自愈动作明确），5xx 是服务端问题（不该让用户瞎猜）。
- 用例：文案级

### 7. 401 无效 token 的 re-attach 指引不精确（②）
- 位置：`src/gateway/state/routing.ts` resolveTarget 401 hint
- 前文案：`token 见 modeldock status；token 丢失可重新 attach（会生成新 token）`
- 后文案：`token 见 modeldock status；token 丢失可重新 attach 生成新 token：modeldock attach <harness>`
- 理由：指引落到可直接执行的命令形态（attach 子命令存在且带 <harness> 参数），少一次翻文档。
- 用例：`test/error-hints.test.ts`（resolveTarget 断言 hint 含 modeldock attach / modeldock status）

## 审计为「已达标、无需改动」的点

- ② 401 缺 token（server.ts:387）：已有「缺少认证 token（Authorization: Bearer 或 x-api-key）」+ token 查看指引。
- ③ 拒绝类连接失败（relay.ts:447 原文案）：本就带 `检查网络/代理（provider.proxy）或 modeldock test` 双 hint。
- ④ 同步冲突/拉取失败（engine.ts:85/104/133）：已带「快照落点 / 重跑 setup / 下周期处理」口径；engine.ts:301 watcher 失效已注明降级语义。
- ① 顺延过程中的逐次提示（shared.ts:54）：信息量足够，保留。
