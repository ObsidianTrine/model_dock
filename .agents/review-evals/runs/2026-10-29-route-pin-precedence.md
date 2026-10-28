# 审查评测报告

- 考题：1，审出：1，未审出：0
- 评分口径：expect 关键词命中（启发式），精确判定看原文

## 2026-10-route-pin-precedence — ✅ 审出

- 考题：客户端钉住路由被定时窗口/全局当前槽接管——mimo-desktop 钉住 hundsun-mimo 后请求仍被 14:00-18:00 窗口压到 agent-plan，模型发错上游 404 UnsupportedModel（2026-10-21 用户报障）
- 关键词：pin=中，钉=中
- 完整输出：C:\Users\81424\AppData\Local\Temp\modeldock-review-eval-TNz0Bn\2026-10-route-pin-precedence.output.txt

<details><summary>模型原文</summary>

```text
# 审查报告：src/gateway/state.ts（baa820c^）

## 发现 3 个问题

### 1. [高]「下一个切换」钉定（route_next）被优先级排序覆盖，钉定实际不生效 —— state.ts:483 + 499-505

`pickTarget` 里 route_next 钉定插入备用链头之后，紧接着同一个数组又被 priority 重排：

- state.ts:482-483：`const fbSource = nextRaw && nextRaw !== primaryId ? [nextRaw, ...(fallbackIds ?? [])] : ...` —— 钉定被插到链首；
- state.ts:485-505：`.map(...).filter(...).sort(...)` —— 随后按 `priority` 降序、`lastMs` 升序整体重排，**钉定没有任何排序豁免**，插入位置被直接作废。

证据链（代码自身文档三处承诺与行为矛盾）：
- state.ts:481-482 注释：「『下一个切换』人工钉定：**插到备用链首位**…它也不可用时…自然顺延」—— 只在"不可用"时才顺延；
- state.ts:450：「人为修改优先于程序自动——程序出错时人工修改就是想要的」—— 这是整条选路阶梯的原则，priority 排序是"程序自动"；
- state.ts:710 `nextPinnedSkipped` 文档只列两种跳过原因（不可用 / 与主候选相同）—— 被 priority 挤出链首是第三种、未声明的行为。

触发场景（可复现）：providers A(base, priority 0)、B(priority 5，且在 profile.fallback)、C(priority 2)；`route_next = C`，无窗口、无主钉定。`fbSource = [C, B]` → 排序后变 `[B, C]` → 链为 `[A, B, C]`。A 挂掉后实际切 B，而不是用户钉定的 C；`next = B ≠ C`，UI 把健康的 C 标成 `nextPinnedSkipped`（理由还只能是文档里那两个，都是错的）。同理，C 与 B 同 priority 时 C 因无 `lastMs`（无穷大）也照样排到末尾。

影响：用户显式钉定的下一个切换目标被程序自动排序静默推翻——正是「路由/模型映射错」这类网关核心失败。与案例主题「route-pin-precedence」吻合，我判断这就是后来发修复的那个 bug（修复方向应是让钉定免于排序、固定链首）。

### 2. [中] `preferredRoute` 默认分支不检查 `enabled`，与自身注释矛盾 —— state.ts:371-372

- state.ts:351 注释：「与 pickTarget 同序，但**只看 enabled（已下线即跳过）**」；
- state.ts:360-362（钉定分支）与 state.ts:367-369（窗口分支）都查了 `p.enabled !== false`；
- state.ts:371-372 默认分支：`return { providerId: profName ? (rt.config.profiles[profName]?.provider ?? null) : null, source: 'default' }` —— 无任何 enabled 检查。

触发场景：active_profile 指向的服务被下线（`enabled: false`）后，`pickTarget` 会跳过它走备用链，而 `displayRouteProvider`（state.ts:376-378）仍返回这个已下线服务；烤模型客户端按此写入的默认模型映射指向一个不再服务的上游，展示路由与请求路由分叉。若 provider 已被删除，还返回悬空 id。

### 3. [低] 主钉定不可用、顺延到默认路由时 `degradedFrom` 缺失，UI 无法解释「为什么不是它」—— state.ts:467-468

- state.ts:467-468：`degradedFrom` 只在 `source === 'failover'` 时计算；
- 当 `auto_route_provider` 被钉定但目标不可用（下线/熔断）、又无定时窗口接管时，`primaryId` 回落到 base provider（state.ts:461），首候选即 base → `source = 'default'` → **`degradedFrom` 恒为 undefined**。

与同函数里 schedule 的待遇对比：窗口被钉定压过/目标不可用有 `suppressedBy = 'pin'/'unavailable'`（state.ts:659-667），而主钉定被跳过没有任何标记。state.ts:692-693 的 `degradedFrom` 文档明说「供 UI 解释『为什么不是它』」—— 这个场景下 UI 只看到「当前 · 默认」，无法解释用户钉定的服务去哪了。行为可从代码确证，属展示/可观测性缺陷，修复成本低（`choose` 里 forcedId 存在而 source 非 pinned 时补 `degradedFrom: 'pinned'`）。

---

## 存疑（缺证据或属边缘，不占主结论）

1. **state.ts:769** `today: dayTypeFor(new Date())` 单参调用，而 state.ts:275 是两参 `dayTypeFor(ref, calendar())`。若第二参可选且内部自行加载日历，则每次 `autoRouteInfo`（Web 展示路径）都绕开 `rt.calendar` 的 30s TTL 缓存做文件 IO。需 daytype.ts 签名与实现佐证。
2. **state.ts:516-543 vs 547-550**：auto_fallback 开启时，base provider 若挤进前 3 名会被自动链按 priority 吃掉，注释（545-546）承诺的「排整个候选链末尾作最后保底」只在 auto 关闭或 base 被 AUTO_FALLBACK_MAX 截断时才成立——故障切换顺序与注释不符，但未超出注释的兜底目的。
3. **state.ts:181** `he.route !== 'default'`：harness 钉定到名为「default」的 profile 会被当作未钉定。是否成问题取决于 profile 命名规则是否允许该名。
4. **state.ts:855-856**：验身仅在 `j.started_at` 与 `state.started_at` **都有**时才比较；健康端或状态文件缺字段时，一个占了该端口、返回 200 的冒名进程会被 `gatewayLive` 认作活网关（随后 stop 按文件 pid 杀进程）。防御偏弱，但需要端口被无关 HTTP 服务占用，场景罕见。
5. **state.ts:483/510 vs 753/756**：`pickTarget` 用 `parseFallbackEntry` 解析 `route_next`（容忍 `"provider:model"` 形式），而 `autoRouteInfo` 按裸 id 处理（`nameOf(routeNext)` 查表、`rs.next !== routeNext` 字符串比较）——若控制台允许带模型后缀钉定，`nextPinnedSkipped` 会恒为 true。取决于 UI 是否产出带模型的 route_next 值。

说明：本报告仅基于所给片段审查，未对照后续提交或当前工作区代码；行号均按片段标注逐一核对过。
```

</details>