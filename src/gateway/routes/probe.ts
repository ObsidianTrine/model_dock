import { sha256 } from '../../util/fsx.js'
import { safeEqual } from '../../util/safe-equal.js'
import { t, bi } from '../../util/i18n.js'
import { AdminCtx, jsonRequestBody, sendError } from '../admin-shared.js'
import type { GatewayRuntime, ProviderAvailability } from '../state.js'
import { buildProbePlan, makeRelayProbeTransport, probeConfigView, runProbeSuite, clearProbeRunProgress, registerProbeRunProgress } from '../probe/engine.js'
import { probeBudgetState, probeMonthBreakdown, probeSpendSeries, readProbeLedger } from '../probe/ledger.js'
import { PROBE_REGISTRY, getProbeDef } from '../probe/registry.js'
import { getProbeRunner } from '../probe/runners/index.js'
import { probeVerdictTimeline, probeVerdictTimelinePage, probeVerdictView } from '../probe/verdict.js'

/** GET /_modeldock/model-availability：per-provider 上游模型目录探测结果（admin 门内只读，纯内存读）。
 *  数据源 = 周期探测（modelprobe.ts：启动 90s + 每 24h，失败负缓存）。从未探测到的 provider
 *  （未到首查点 / 无 key / 已禁用）不出现在结果里——缺席 ≠ 不可用，消费方勿把缺席当故障。 */
export async function hModelAvailability(c: AdminCtx): Promise<void> {
  const { rt, res } = c
  const availability: Record<string, ProviderAvailability> = {}
  for (const [id, a] of rt.modelProbe?.results ?? []) availability[id] = a
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ ok: true, availability }))
}

// ===== 服务探针端点（provider-probe-suite 任务 6；与 hTest 的差异：走探针引擎、不调 logRequest——
// 请求日志 / usageToday / key 冷却 / 熔断计数零副作用，花费只进探针独立账本）=====

/** 探针运行确认 token：绑定 (adminToken, provider, probes, 目标数, 预估) 的短摘要。预估展示与确认
 *  执行之间 key 池/配置变化会改变目标数与预估——旧 token 即失效（不能拿旧预估执行新计划）；
 *  键入 adminToken 防外部伪造 (plan → token) 映射；比较走 safeEqual 恒时。 */
function probeConfirmToken(rt: GatewayRuntime, providerId: string, probeIds: string[], planned: number, estimate: number): string {
  return sha256(`${rt.adminToken}|probe-run|${providerId}|${probeIds.join(',')}|${planned}|${estimate}`).slice(0, 32)
}

/** POST /_modeldock/probe/run：跑探针套件（admin 门内写路径，audit 留痕）。两段式成本确认闸：
 *  首段不带 confirmToken 只出预估（targets/estimate/per_probe_cost/budget + confirmToken），零上游
 *  请求；第二段带对 bind 计划的 confirmToken 才执行（对应 CLI 的逐次确认）。 */
export async function hProbeRun(c: AdminCtx): Promise<void> {
  const { rt, req, res, audit, o } = c
  const b = await jsonRequestBody(req)
  const providerId = typeof b.provider === 'string' ? b.provider.trim() : ''
  if (!providerId) {
    return sendError(res, 400, t('缺少 provider', 'Missing provider'), t('示例：{"provider":"myapi","probes":["p1"]}', 'Example: {"provider":"myapi","probes":["p1"]}'))
  }
  if (!rt.config.providers[providerId]) {
    return sendError(res, 400, t('服务「{id}」不存在', 'Service "{id}" not found', { id: providerId }), t('/_modeldock/overview 的 services[].id 为可用值', 'services[].id in GET /_modeldock/overview lists the valid ids'))
  }
  const requested: unknown[] = Array.isArray(b.probes) ? b.probes : typeof b.probes === 'string' ? b.probes.split(',') : ['p1']
  const activeIds = PROBE_REGISTRY.filter((d) => d.status === 'active').map((d) => d.id)
  const probeIds: string[] = []
  for (const raw of requested) {
    const id = String(raw).trim()
    if (!id) continue
    if (id === 'all') {
      for (const a of activeIds) if (!probeIds.includes(a)) probeIds.push(a)
      continue
    }
    if (!getProbeDef(id)) {
      return sendError(res, 400, t('未知探针「{id}」', 'Unknown probe "{id}"', { id }), t('可用探针：{list}', 'Available probes: {list}', { list: activeIds.join(', ') }))
    }
    if (!probeIds.includes(id)) probeIds.push(id)
  }
  if (probeIds.length === 0) {
    return sendError(res, 400, t('探针清单为空', 'Probe list is empty'), t('示例：{"provider":"myapi","probes":["p1"]}', 'Example: {"provider":"myapi","probes":["p1"]}'))
  }
  // [probe].enabled=false：与 CLI 同口径的可操作报错，而非静默 0 请求
  if (!probeConfigView(rt).enabled) {
    return sendError(
      res,
      400,
      t('探针已被停用（[probe] enabled=false）', 'Probes are disabled ([probe] enabled=false)'),
      t('删除 config.toml [probe] 段的 enabled = false（或改为 true）后重试', 'Remove enabled = false from the [probe] section of config.toml (or set it to true) and retry')
    )
  }
  let plan
  try {
    plan = await buildProbePlan(rt, providerId, probeIds)
  } catch (e) {
    return sendError(res, 400, (e as Error).message)
  }
  if (plan.keys.length === 0) {
    return sendError(res, 400, t('服务「{id}」没有可用 key，探针无法发请求', 'Service "{id}" has no usable key; probes cannot send requests', { id: providerId }), t('先为该服务配置 key 后重试', 'Configure a key for this service first, then retry'))
  }
  const token = probeConfirmToken(rt, providerId, probeIds, plan.planned, plan.estimate)
  const supplied = typeof b.confirmToken === 'string' ? b.confirmToken : ''
  if (!supplied || !safeEqual(supplied, token)) {
    // 第一段：只回预估（确认闸在引擎层兜底双保险——即使 token 校验有洞，未确认也是 0 请求）
    const budget = await probeBudgetState(rt)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        ok: false,
        needConfirm: true,
        reason: 'unconfirmed',
        provider: providerId,
        probes: probeIds,
        targets: plan.planned,
        estimate: plan.estimate,
        per_probe_cost: plan.perProbeCost,
        budget,
        confirmToken: token,
        verdicts: [],
        skipped: [],
      })
    )
    return
  }
  audit(
    bi('探针运行', 'Probe run'),
    providerId,
    bi('{probes} × {n} 目标 · 预估 {e} tokens', '{probes} × {n} targets · estimate {e} tokens', { probes: probeIds.join(','), n: plan.planned, e: plan.estimate })
  )
  // 轮次进度（p14-progress）：runId 可选（前端生成，字符白名单净化）；注册建位 → 运行 →
  // finally 删。非法/缺席不拦运行——进度是体验增强，不属正确性
  const runId = typeof b.runId === 'string' ? b.runId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) : ''
  if (runId) registerProbeRunProgress(rt, runId, providerId, probeIds)
  let result
  try {
    result = await runProbeSuite(rt, {
      probeIds,
      targets: plan.units.map((u) => u.target),
      transport: makeRelayProbeTransport(rt, { idleTimeoutMs: o.idle, retries: o.retries }),
      runnerFor: getProbeRunner,
      confirmed: true,
      secrets: plan.secrets,
      ...(runId ? { runId } : {}),
    })
  } finally {
    if (runId) clearProbeRunProgress(rt, runId)
  }
  const budget = await probeBudgetState(rt)
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(
    JSON.stringify({
      ok: result.ok,
      reason: result.reason,
      provider: providerId,
      probes: probeIds,
      targets: plan.planned,
      dispatched: result.dispatched,
      upstreamRequests: result.upstreamRequests,
      tokens: result.tokens,
      estimate: plan.estimate,
      per_probe_cost: plan.perProbeCost,
      budget,
      verdicts: result.verdicts.map(probeVerdictView),
      skipped: result.skipped,
    })
  )
  return
}

/** GET /_modeldock/probe/verdicts：三元组 verdict 视图（admin 门内只读，纯内存读）。数据源 =
 *  rt.probeVerdicts 热态（经本网关运行的探针写入，重启回放 probe-<date>.jsonl 重建）；CLI 直跑的
 *  结论落盘后要等网关重启回放才进本视图。state 为读面状态（证据超 7 天未刷新即 stale）；
 *  key 只出 sha256 前 8 位指纹。 */
export async function hProbeVerdicts(c: AdminCtx): Promise<void> {
  const { rt, res } = c
  const verdicts = [...(rt.probeVerdicts?.values() ?? [])]
    .map(probeVerdictView)
    .sort((x, y) => (x.provider === y.provider ? (x.model < y.model ? -1 : x.model > y.model ? 1 : x.key_fp < y.key_fp ? -1 : 1) : x.provider < y.provider ? -1 : 1))
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ ok: true, verdicts, generated_at: new Date().toISOString() }))
  return
}

/** GET /_modeldock/probe/ledger：探针独立账本月度读数（admin 门内只读）。budget = 月度预算闸读数
 *  （probe/ledger.ts probeBudgetState），breakdown = 当月聚合 + 按 probe_id 分解；probe_labels 供
 *  前端按界面语言取探针展示名（`中文||English` 形态，与 data-i18n 机制同构）。 */
export async function hProbeLedger(c: AdminCtx): Promise<void> {
  const { rt, res } = c
  const breakdown = probeMonthBreakdown(await readProbeLedger())
  const budget = await probeBudgetState(rt)
  const probe_labels: Record<string, string> = {}
  for (const d of PROBE_REGISTRY) probe_labels[d.id] = `${d.titleZh}||${d.titleEn}`
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ ok: true, budget, breakdown, probe_labels }))
  return
}

/** GET /_modeldock/probe/trend?days=30&months=6：探针趋势视图（admin 门内只读，
 *  provider-probe-suite 任务 14）。timeline = 近 days 天 verdict 变化时间线（probeVerdictTimeline，
 *  只读 probe-<date>.jsonl、按证据时间 at 升序；窗口过滤在读取层逐行做，窗口外数据不出网关）；
 *  spend = 近 months 个自然月探针花费曲线（probeSpendSeries，读独立账本 probe-ledger.jsonl）。
 *  两路都不读真实流量请求日志。days/months 非法值按 hLogs 先例夹紧不报错（days 1–365 缺省 30、
 *  months 1–24 缺省 6）。timeline 条目 from=null = 窗口内该三元组首现；key 只出指纹。
 *  趋势窗口实际受保留期约束：probe-<date>.jsonl 随 log_retention_days 清理（同源策略），
 *  超保留期的历史自然为空。 */
export async function hProbeTrend(c: AdminCtx): Promise<void> {
  const { req, res } = c
  const q = new URL(req.url ?? '', 'http://x').searchParams
  const clampNum = (v: string | null, def: number, max: number): number => {
    const n = Number(v)
    return Number.isFinite(n) && n > 0 ? Math.min(max, Math.floor(n)) : def
  }
  const days = clampNum(q.get('days'), 30, 365)
  const months = clampNum(q.get('months'), 6, 24)
  const timeline = await probeVerdictTimeline(days * 86_400_000)
  const spend = probeSpendSeries(await readProbeLedger(), months)
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ ok: true, days, months, timeline, spend, generated_at: new Date().toISOString() }))
  return
}

/** GET /_modeldock/probe/timeline?provider=x&limit=10&days=30：单服务健康变化时间线（admin 门内
 *  只读）。服务健康弹层专用轻端点：服务端按 provider 裁剪 + 尾部 limit 截取——弹层打开只拉
 *  最近 10 条，点「展开全部」再以 limit=0 拉全窗口，不再整包下载全 provider 的 /probe/trend
 *  响应（spend 曲线弹层不消费）。timeline 语义与 /probe/trend 一致（只记翻转、from=窗口内该
 *  三元组首现、at 升序；截断后首条 from 仍是真实前态）；total = 窗口内该服务翻转总数（前端
 *  「展开全部 N 条」据此显示）。provider 必填（缺省 400）；limit 非负整数缺省 10、0=全量、
 *  非法值夹回缺省（hLogs 夹紧先例）；days 夹紧 1–365 缺省 30。窗口实际受保留期约束
 *  （probe-<date>.jsonl 随 log_retention_days 清理）。 */
export async function hProbeTimeline(c: AdminCtx): Promise<void> {
  const { req, res } = c
  const q = new URL(req.url ?? '', 'http://x').searchParams
  const provider = (q.get('provider') ?? '').trim()
  if (!provider) {
    return sendError(res, 400, t('缺少 provider', 'Missing provider'), t('示例：/_modeldock/probe/timeline?provider=myapi&limit=10', 'Example: /_modeldock/probe/timeline?provider=myapi&limit=10'))
  }
  const clampNum = (v: string | null, def: number, max: number): number => {
    const n = Number(v)
    return Number.isFinite(n) && n > 0 ? Math.min(max, Math.floor(n)) : def
  }
  const days = clampNum(q.get('days'), 30, 365)
  const limitRaw = q.get('limit')
  const limitNum = limitRaw != null ? Number(limitRaw) : NaN
  const limit = Number.isFinite(limitNum) && limitNum >= 0 ? Math.min(Math.floor(limitNum), 10_000) : 10
  const { items, total } = await probeVerdictTimelinePage(days * 86_400_000, { provider, limit })
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ ok: true, provider, days, limit, total, timeline: items, generated_at: new Date().toISOString() }))
  return
}

/** GET /_modeldock/probe/run-progress?run=<id>：探针运行轮次进度（admin 门内只读，p14-progress）。
 *  数据源 = rt.probeRunProgress 内存 Map（hProbeRun 注册建位、finally 删，引擎逐轮覆盖写）。
 *  active=true 带轮次与采样（rounds=0 = 已注册未开跑首轮；samples>1 = jittery 多采样，弹层拼
 *  「采样 n/m · 第 i/k 轮」）；false = 无此 run（已结束/非法 id/旧网关重启清 Map）——前端对
 *  false 与请求失败一律静默保持「检测中…」文案，不做区分。 */
export async function hProbeRunProgress(c: AdminCtx): Promise<void> {
  const { rt, req, res } = c
  const q = new URL(req.url ?? '', 'http://x').searchParams
  const run = (q.get('run') ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64)
  const e = run ? rt.probeRunProgress?.get(run) : undefined
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(
    JSON.stringify(
      e
        ? { ok: true, active: true, probe: e.probe, provider: e.provider, round: e.round, rounds: e.rounds, sample: e.sample, samples: e.samples }
        : { ok: true, active: false }
    )
  )
  return
}
