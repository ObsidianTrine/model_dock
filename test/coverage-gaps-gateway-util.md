# coverage 缺口清单 — src/gateway 与 src/util（test-gap-gateway-util）

> 依据：worktree（develop@ed99611）`npm run test:coverage` istanbul 明细（coverage-final.json）。
> 卡背景给的 ~73%/71% 为 2026-10-29 旧实测；jsonpath 多段修复（5d81d63 等）与 sync-race /
> gateway-shared / keypool 等测试已改变缺口分布，本清单以现场 coverage 为准重新圈定。
> 每条「文件:函数:分支」至少对应 1 个新用例；新增测试文件 3 个，**零 vi.mock**（vitest 隔离雷区）。

## src/gateway/relay.ts（分支 89.53% → 补测后见 npm test）

| # | 文件:函数:分支 | 新用例（test/relay-gaps.test.ts） |
|---|---|---|
| 1 | relay.ts:forwardWithFailover:pickTarget 返回 down_all 的 503 前置短路（L782-785） | 「候选全部熔断：pickTarget down_all 前置短路」 |
| 2 | relay.ts:forwardWithFailover:并发闸排队超时且链中还有候选 → 跳下一家 + queue_full 留痕（L813-818） | 「并发闸排队超时且链中还有候选」 |
| 3 | relay.ts:forwardWithFailover:客户端已断开时取并发槽 → aborted 原样上抛（L821） | 「客户端已断开时取并发槽」 |
| 4 | relay.ts:forwardWithFailover:429 带 Retry-After ≤5s 原地退避重试（L830-841，含 sleepInterruptible 全分支） | 「上游 429 带 Retry-After ≤5s」 |
| 5 | relay.ts:forwardWithFailover:退避等待期间客户端断开 → sleep 中止上抛（L883 + sleepInterruptible onAbort） | 「429 退避等待期间客户端断开」 |
| 6 | relay.ts:forwardWithFailover:failover_status_codes 白名单 5xx → recordOutcome 5xx 档 + 排空后切换（L847/L854） | 「failover_status_codes 白名单含 500」 |
| 7 | relay.ts:forwardWithFailover:全部候选 transport 失败耗尽 → 收尾 502 down_all（L906-911） | 「全部候选 transport 层失败」 |
| 8 | relay.ts:buildUpstreamHeaders:auth_style=x-api-key 注入分支（L227） | 「auth_style=x-api-key」 |
| 9 | relay.ts:forwardToUpstream:响应头超时 transport='timeout' 分类与专属文案（L536/L541/L545） | 「响应头超时（headers_timeout_ms）」 |
| 10 | relay.ts:scanTopLevelModel:截断体/转义键/非法转义值 → null；嵌套与标量跳过、非字符串 model → undefined（L266-337） | topLevelModel 两组纯函数用例 |
| 11 | relay.ts:rewriteModel:scan=null 全量解析回落（L437-448）+ injectModel 拒绝数组体不谎报（L376） | 「非 JSON / 数组体 / 标量体」「转义键 model 全量解析识别」 |
| 12 | relay.ts:translateUpstreamError:ctx.model 缺省 '?' 占位（L613/L615/L621） | 「ctx 无 model 时 ? 占位」 |
| 13 | relay.ts:readUpstreamErrorText:deflate 两形态 / br / 大小写头 / 无 arrayBuffer 体 / zstd（L650-683） | 「错误体按 content-encoding 解压」 |

## src/gateway/state/*（keypool 89.47% / logs 78.1% / routing 88.11% / runtime 87.23% / state-file 90.47% / tokenlimits 91.89% / sea 94.87% 分支）

| # | 文件:函数:分支 | 新用例（test/state-gaps.test.ts） |
|---|---|---|
| 14 | state/keypool.ts:resetKeyPool:带 providerId 的单服务清理分支（L71-74） | 「resetKeyPool 单 provider」 |
| 15 | state/keypool.ts:keyPoolHealthView:已过期冷却条目不投影（L60） | 「keyPoolHealthView：已过期的冷却条目不投影」 |
| 16 | state/routing.ts:recordOutcome:quota 类 3 次熔断档位 [3, 900s]（L97 cond-expr[1]） | 「quota 类 3 次即熔断」 |
| 17 | state/routing.ts:recordOutcome:错误窗口滑出 60s 重置计数（L91-93） | 「错误窗口滑出 60s 后重置计数」 |
| 18 | state/routing.ts:hitScheduleWindows:非法 HHmm / start===end 窗口跳过（L163）；dowOf 周日=7（L114） | 「非法 HHmm…」「days:[7] 仅周日生效」 |
| 19 | state/routing.ts:pickTarget:候选链全被避开且 auto_fallback 关闭 → 链外 extras 补链（L448-452） | 「候选链全被避开且 auto_fallback 关闭」 |
| 20 | state/routing.ts:pickTarget:fallback 空条目过滤（L368）+ 自动链 lastMs 决胜（L414） | 「fallback 空条目被过滤」 |
| 21 | state/routing.ts:routeState:无 active_profile 且人工钉定 → pinned 视图 + profileForProviderReadonly 循环（L201/L534-536/L538） | 「无 active_profile 且人工钉定存在」 |
| 22 | state/runtime.ts:reloadRuntime:已删 provider 的 health/seaErrors/modelProbe 三域清理（L155/L159/L162） | 「reloadRuntime 清理已删 provider 的三域运行态」 |
| 23 | state/state-file.ts:gatewayLive:健康端点 500 / started_at 不一致 / fetch 抛错三分支（L40/L42/L45）；clearGatewayState（L96） | state-file 组 5 用例 |
| 24 | state/logs.ts:pushRing:超 500 条环形裁剪（L17） | 「pushRing 环形裁剪」 |
| 25 | state/logs.ts:readRequestLogDay:日期格式严格校验（L223） | 「readRequestLogDay：日期格式严格校验」 |
| 26 | state/logs.ts:logEntryMatches:fromMs/toMs 时间窗边界（L250-254） | 「logEntryMatches：时间窗含边界」 |
| 27 | state/logs.ts:summarizeUsageDays:非法日期 / 缺失文件 / 崩溃半行三分支容错（L371/L373/L376） | 「summarizeUsageDays：非法日期跳过…」 |
| 28 | state/logs.ts:usageTodayView:今日仪表失败的零值视图 catch（L116） | 「usageTodayView：今日仪表不可用」 |
| 29 | state/logs.ts:startEventLoopDelaySampler:缺省参数 + 幂等（L395/L396） | 「startEventLoopDelaySampler…幂等」 |
| 30 | state/sea.ts:seaStore:rt.seaErrors 惰性建表兜底（L36-38）；seaWindowView:未来桶不计（L87） | sea 组 2 用例 |
| 31 | state/tokenlimits.ts:recordTokenUsage:usage 缺省无操作（L48）+ 缓存字段 ?? 0 兜底（L56） | 「recordTokenUsage：无 usage 无操作…」 |

## src/util（color 80.55% / fsx 79.33% / jsonpath 93.84% 分支）

| # | 文件:函数:分支 | 新用例（test/util-gaps2.test.ts） |
|---|---|---|
| 32 | util/color.ts:c.dim/blue/magenta/cyan（L10/L14-16 从未被调用）；hint stderr 出口（L64）；printTable cols 参数与空行（L54-55） | color 组 3 用例 |
| 33 | util/jsonpath.ts:applySet:中段下标 × 对象容器显式报错（L136-137） | 「中段下标 × 对象容器」 |
| 34 | util/jsonpath.ts:applySet:中段下标越界创建报错（L149-150）+ 下一跳为下标时容器建成数组（L157） | 「中段下标越界创建…」 |
| 35 | util/fsx.ts:acquireFileLock:陈锁 ino/mtime/size 复核后接管（L392-396）+ 非 EEXIST 错误原样上抛（L384） | fsx 文件锁组 2 用例 |
| 36 | util/fsx.ts:memoGet:TTL 过期重算（L106-108）；commandOnPathSandbox:无 FAKE_HOME 直通（L128） | 「memo TTL 过期后重算」 |
| 37 | util/fsx.ts:appendLine:写失败首次打日志、此后只计数（L518）；流池容量 FIFO 淘汰（L526-530）；空池 drain/close（L553/L577） | 追加流池组 3 用例 |
| 38 | util/fsx.ts:slugify:全非合法字符兜底 'provider'（L612） | 「slugify 兜底」 |

## 非缺口说明（避免后续重复补测）

- `relay.ts` scanTopLevelModel 对「完整顶层对象后跟残留垃圾」取值而非返回 null（topLevelModel('{...} trail') → 'm'）：快路径启发式的宽容侧——无效 JSON 体上游同样拒绝，网关不做前置校验；已按实际行为落断言锚点，非缺陷。

- `src/gateway/state.ts` / `state/types.ts`（text 表显示 0%）：纯 re-export barrel / 纯类型，无可执行语句，istanbul 显示 0 total lines。
- `src/util/crash.ts` 32-40（处理器体）：已由 util-gaps.test.ts 的子进程端到端覆盖（uncaughtException 落盘 / unhandledRejection 留痕），istanbul 看不到子进程覆盖，非真实缺口。
- `src/util/jsonpath.ts` L36 `body[consumed] ?? ''`：throw 前提是 consumed < body.length，该表达式恒有值，防御性不可达。
- `src/gateway/state/logs.ts` L440 `!Number.isFinite(fileDate)`：`new Date(y, m, d)` 对超界字段做 rollover 恒产出有限值，防御性不可达。
- `src/util/fsx.ts` L186-204（nvm/wellKnown 兜底）：win32 在 L185 提前 return，仅 unix CI 可达（本机 Windows 无法覆盖）。
- **未发现 src 真 bug**：本次补测全部是对既有实现行为的分支覆盖，无行为与注释/预期不符需要立项的情形。
