import { randomBytes } from 'node:crypto'
import { DEFAULT_GATEWAY_PORT } from '../../config/types.js'
import { applyAttach, detachHarness, planAttach, pinRouteProtocolError, resyncHarnessToRoute, switchHarnessMode } from '../../ops.js'
import { localIsoTs } from '../../util/time.js'
import { t, bi, biCat, biJoin } from '../../util/i18n.js'
import { EPHEMERAL_TTL_DEFAULT_MINUTES, EPHEMERAL_TTL_MAX_MINUTES, registerEphemeralHarness, reloadRuntime, renewEphemeralHarness, unregisterEphemeralHarness } from '../state.js'
import { UpstreamError } from '../relay.js'
import { AdminCtx, jsonRequestBody, persistConfig, profileForProvider, sendError } from '../admin-shared.js'
import { pickerSyncStates } from '../picker-state.js'

/** generic-env 四键 env 组的唯一拼装点（C14 抽取）：harness/env 与 harness/provision 共用，
 *  不复制粘贴。ANTHROPIC 面 = 根路径，OPENAI 面 = /v1（OpenAI 兼容路径），与既有下发口径一致。 */
function gatewayEnvGroup(
  port: number,
  token: string
): { base_url: string; vars: { ANTHROPIC_BASE_URL: string; ANTHROPIC_AUTH_TOKEN: string; OPENAI_BASE_URL: string; OPENAI_API_KEY: string } } {
  const base = `http://127.0.0.1:${port}`
  return {
    base_url: base,
    vars: {
      ANTHROPIC_BASE_URL: base,
      ANTHROPIC_AUTH_TOKEN: token,
      OPENAI_BASE_URL: `${base}/v1`,
      OPENAI_API_KEY: token,
    },
  }
}

export async function hHarnessEnv(c: AdminCtx): Promise<void> {
  const { rt, req, res, audit } = c
  // 按需取某客户端经网关接入用的环境变量（generic-env 的「复制环境变量」按钮调用）。
  // token 属敏感值，与 reveal-key 同策略：不随 overview 批量下发，显式动作才返回一份
  const b = await jsonRequestBody(req)
  const hid = String(b.harness ?? '')
  const he = rt.config.harness[hid]
  if (!he) return sendError(res, 400, t('客户端「{id}」尚未接入，先接入再获取环境变量', 'Client "{id}" is not attached yet; attach it first to get env vars', { id: hid }))
  const token = he.token ?? ''
  if (!token) return sendError(res, 400, t('客户端「{id}」没有网关令牌（该客户端不经本网关转发）', 'Client "{id}" has no gateway token (it does not route through this gateway)', { id: hid }))
  const port = rt.port ?? rt.config.gateway?.port ?? DEFAULT_GATEWAY_PORT
  const env = gatewayEnvGroup(port, token)
  audit(bi('查看环境变量', 'View env vars'), hid)
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(
    JSON.stringify({
      ok: true,
      harness: hid,
      base_url: env.base_url,
      token,
      lines: [
        `export ANTHROPIC_BASE_URL=${env.vars.ANTHROPIC_BASE_URL}`,
        `export ANTHROPIC_AUTH_TOKEN=${env.vars.ANTHROPIC_AUTH_TOKEN}`,
        `export OPENAI_BASE_URL=${env.vars.OPENAI_BASE_URL}`,
        `export OPENAI_API_KEY=${env.vars.OPENAI_API_KEY}`,
      ],
    })
  )
  return
}

/** POST /_modeldock/harness/provision：签发 runtime-only 临时 harness（C14 / P2⑧，admin 门内）。
 *  「用完即焚」凭据（不落盘、TTL 到点被 sweeper 摘除、可随时经 harness/revoke 吊销）：
 *  语义与不落盘推演见 state/types.ts EphemeralHarnessState 注。路由语义复用现有 harness.route：钉 profile 或跟随
 *  active_profile；max_daily_tokens 挂进 tokenlimits per-harness 日限额（超限 429 与
 *  daily_tokens 一致）。请求 {id?, profile|route?, ttl_minutes?, max_daily_tokens?}；响应
 *  {ok, id, token, expires_at, env}——token 明文只在本响应出现一次，任何列示端点与审计日志
 *  绝不回显（审计只记 id/路由/TTL）。 */
export async function hProvisionHarness(c: AdminCtx): Promise<void> {
  const { rt, req, res, audit } = c
  const b = await jsonRequestBody(req)
  // 路由目标：profile / route 二字段等价（兼容两种叫法，harness/route 用 profile、编排侧惯用 route）；
  // 'default' = 显式跟随全局。钉定目标必须是存在的 profile
  const routeRaw = typeof b.profile === 'string' && b.profile.trim() ? b.profile.trim() : typeof b.route === 'string' && b.route.trim() ? b.route.trim() : ''
  const route = routeRaw && routeRaw !== 'default' ? routeRaw : undefined
  if (route && !rt.config.profiles[route]) {
    return sendError(res, 400, t('profile「{name}」不存在', 'Profile "{name}" not found', { name: route }), t('modeldock profile list 查看，或在 Web 控制台「服务」页确认', 'Run modeldock profile list, or check the Services page of the web console'))
  }
  // id：缺省自动 eph-<随机>；显式给定须不与既有 harness（含在册临时条目）冲突，且限安全字符集
  // （harness id 会成为 config.harness 对象键，拒绝原型链/路径类花名）
  let id = typeof b.id === 'string' ? b.id.trim() : ''
  if (id && !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(id)) {
    return sendError(res, 400, t('id 非法：仅限字母/数字开头，可含 . _ -，最长 64 字符', 'Invalid id: must start with a letter/digit, may contain . _ -, max 64 chars'), t('省略 id 可自动生成（eph-<随机>）', 'Omit id to auto-generate one (eph-<random>)'))
  }
  if (id && (rt.config.harness[id] || rt.ephemeral.has(id))) {
    return sendError(res, 400, t('harness id「{id}」已存在，换一个或省略 id 自动生成', 'Harness id "{id}" already exists; pick another or omit id to auto-generate', { id }))
  }
  if (!id) id = `eph-${randomBytes(6).toString('hex')}`
  // TTL：缺省 480 分钟（8h，覆盖一个无人值守工作日）、上限 1440（24h 硬顶——「临时」凭据
  // 不得事实永久化，泄漏收敛靠短命）；非法 400 + 可操作报错。非 number 一律 NaN 同路 400：
  // Number(true)===1 曾把布尔 true 静默当 1 分钟 TTL，泄漏收敛被无声绕过（rev-server-night）
  const ttl = typeof b.ttl_minutes === 'number' ? b.ttl_minutes : b.ttl_minutes === undefined ? EPHEMERAL_TTL_DEFAULT_MINUTES : NaN
  if (!Number.isFinite(ttl) || ttl <= 0) {
    return sendError(res, 400, t('ttl_minutes 非法：需为正数（分钟），缺省 {d}，上限 {m}', 'Invalid ttl_minutes: must be a positive number (minutes), default {d}, max {m}', { d: EPHEMERAL_TTL_DEFAULT_MINUTES, m: EPHEMERAL_TTL_MAX_MINUTES }))
  }
  if (ttl > EPHEMERAL_TTL_MAX_MINUTES) {
    return sendError(res, 400, t('ttl_minutes 超上限：最多 {m} 分钟（24 小时）。临时凭据的泄漏收敛靠短命，确需长期用请走持久 harness 接入', 'ttl_minutes exceeds the cap: at most {m} minutes (24 hours). Leak containment for ephemeral credentials relies on short lifetimes; use a persistent harness for long-term access', { m: EPHEMERAL_TTL_MAX_MINUTES }))
  }
  // 日限额：配了就挂进 tokenlimits per-harness 日限额体系（超限 429 与现有 daily_tokens 一致）；
  // 非 number 一律 NaN 同路 400：Number(true)===1 曾把布尔 true 当 1 token 日限额（与 ttl_minutes 同型强转）
  const maxDailyRaw = typeof b.max_daily_tokens === 'number' ? b.max_daily_tokens : b.max_daily_tokens === undefined ? undefined : NaN
  if (maxDailyRaw != null && (!Number.isFinite(maxDailyRaw) || maxDailyRaw <= 0)) {
    return sendError(res, 400, t('max_daily_tokens 非法：需为正数（本地日 token 上限），不配即不限', 'Invalid max_daily_tokens: must be a positive number (local-day token cap); omit for unlimited'))
  }
  const maxDaily = maxDailyRaw != null ? Math.floor(maxDailyRaw) : undefined
  const state = registerEphemeralHarness(rt, { id, ...(route ? { route } : {}), ttlMinutes: ttl, ...(maxDaily != null ? { maxDailyTokens: maxDaily } : {}) })
  const port = rt.port ?? rt.config.gateway?.port ?? DEFAULT_GATEWAY_PORT
  const env = gatewayEnvGroup(port, state.token)
  // 审计不含 token 明文：凭据身份 = id + 路由 + TTL（+ 日限额）
  const detail = biCat(
    route ? bi(`路由 ${route}`, `Route ${route}`) : bi('跟随全局', 'Follow global'),
    bi(`TTL ${ttl} 分钟`, `TTL ${ttl} min`),
    ...(maxDaily != null ? [bi(`日限额 ${maxDaily} tokens`, `Daily cap ${maxDaily} tokens`)] : [])
  )
  audit(bi('颁发临时凭据', 'Provision ephemeral credential'), id, detail)
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ ok: true, id, token: state.token, expires_at: new Date(state.expiresAt).toISOString(), env: env.vars }))
  return
}

/** POST /_modeldock/harness/revoke：吊销临时 harness（admin 门内）。幂等：条目不存在
 *  （已过期 / 已吊销 / 从未存在）也返回 ok —— 编排侧重试无需区分。只作用于在册临时条目：
 *  持久 harness id 传进来原样放行（revoked:false），不会误删真实客户端。 */
export async function hRevokeHarness(c: AdminCtx): Promise<void> {
  const { rt, req, res, audit } = c
  const b = await jsonRequestBody(req)
  const id = typeof b.id === 'string' ? b.id.trim() : ''
  if (!id) return sendError(res, 400, t('缺少 id（provision 响应返回的临时 harness id）', 'Missing id (the ephemeral harness id returned by provision)'))
  const existed = unregisterEphemeralHarness(rt, id)
  audit(bi('吊销临时凭据', 'Revoke ephemeral credential'), id, existed ? bi('已吊销', 'Revoked') : bi('条目不在册（幂等放行）', 'Entry not registered (idempotent)'))
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ ok: true, revoked: existed }))
  return
}

/** POST /_modeldock/harness/renew：临时 harness TTL 续期（admin 门内）。网关 P1「TTL 无续期」
 *  的网关半边：超长任务凭据临期续一把，不再中途 401（编排器侧 ttlHours 传参另行落地）。
 *  请求 {harnessId, ttl_minutes}（harnessId = provision 响应返回的临时 id；ttl 需正数分钟）；
 *  新到期 = max(旧到期, now+ttl) 收敛到与 provision 同顶 1440min——只延不缩，缩短请求 = 无效
 *  no-op（到期不变，响应如实回报）。已过期拒绝（410）：sweeper 60s 节奏未及摘除的窗口内同样
 *  拒绝，过期凭据不得复活；非在册临时条目（未知 id / 持久 harness / 已吊销或已清扫）404。
 *  token 不换发也不回显（响应与审计均无 token 明文，凭据身份 = id）；热加载幸存语义不变
 *  （expiresAt 是 reapply 基准，renew 后过 reload 依旧有效）。 */
export async function hRenewHarness(c: AdminCtx): Promise<void> {
  const { rt, req, res, audit } = c
  const b = await jsonRequestBody(req)
  const id = typeof b.harnessId === 'string' ? b.harnessId.trim() : ''
  if (!id) return sendError(res, 400, t('缺少 harnessId（provision 响应返回的临时 harness id）', 'Missing harnessId (the ephemeral harness id returned by provision)'))
  // 非 number 一律 NaN 同路 400（Number(true)===1 强转陷阱，与 provision 同口径，rev-server-night）
  const ttl = typeof b.ttl_minutes === 'number' ? b.ttl_minutes : NaN
  if (!Number.isFinite(ttl) || ttl <= 0) {
    return sendError(res, 400, t('ttl_minutes 非法：需为正数（分钟）。续期只延不缩，请求值小于剩余寿命时到期不变', 'Invalid ttl_minutes: must be a positive number (minutes). Renewal only extends; a value below the remaining lifetime leaves the expiry unchanged'))
  }
  const r = renewEphemeralHarness(rt, id, ttl)
  if (!r.ok) {
    if (r.reason === 'expired') {
      return sendError(res, 410, t('临时凭据「{id}」已过期，拒绝续期：过期凭据不得复活，请重新 provision 签发新凭据', 'Ephemeral credential "{id}" has expired; renewal is refused — expired credentials must not be revived, provision a new one instead', { id }))
    }
    return sendError(res, 404, t('「{id}」不是在册临时凭据（未知 id、持久 harness 或已吊销/已清扫）：renew 仅作用于 provision 签发的临时条目', '"{id}" is not a registered ephemeral credential (unknown id, persistent harness, or already revoked/swept): renew applies only to entries issued via provision', { id }))
  }
  const expiresIso = new Date(r.state.expiresAt).toISOString()
  // 审计不含 token 明文（与 provision 同口径）：凭据身份 = id + 续后到期
  audit(bi('续期临时凭据', 'Renew ephemeral credential'), id, bi(`TTL 延至 ${expiresIso}`, `TTL extended to ${expiresIso}`))
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ ok: true, id, expires_at: expiresIso, ttl_minutes: r.ttlMinutes }))
  return
}

export async function hAttachPlan(c: AdminCtx): Promise<void> {
  const { rt, req, res } = c
  const b = await jsonRequestBody(req)
  try {
    const plan = await planAttach(String(b.harness ?? ''), {
      profile: typeof b.profile === 'string' && b.profile ? b.profile : undefined,
      clientProfiles: parseClientProfiles(b.client_profiles),
      setDefault: b.setDefault === true,
      takeoverModels: b.takeoverModels === true,
      gatewayPort: rt.port, // 本实例自己的端口；状态文件在多实例下可能记录的是别的实例
    })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, ...plan }))
  } catch (e) {
    sendError(res, 400, (e as Error).message)
  }
  return
}

export async function hAttachApply(c: AdminCtx): Promise<void> {
  const { rt, req, res, audit } = c
  const b = await jsonRequestBody(req)
  try {
    const r = await applyAttach(String(b.harness ?? ''), {
      profile: typeof b.profile === 'string' && b.profile ? b.profile : undefined,
      clientProfiles: parseClientProfiles(b.client_profiles),
      setDefault: b.setDefault === true,
      takeoverModels: b.takeoverModels === true,
      gatewayPort: rt.port, // 本实例自己的端口；状态文件在多实例下可能记录的是别的实例
    })
    await reloadRuntime(rt) // 立即刷新内存态，overview 才能即时反映接入结果
    // attach 写入的 picker 目录取自 active_profile；若此刻正处于 prefer 窗口接管（展示路由 ≠
    // active_profile），基线置失效让周期检测在 5s 内按窗口目标校准一次
    pickerSyncStates.get(rt)!.route = undefined
    audit(bi('接入客户端', 'Attach client'), r.harness, bi('端口 {port}，写入 {n} 个文件', 'Port {port}, wrote {n} files', { port: r.port, n: r.files.length }))
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, ...r, hint: t('重启 {id} 后生效；原文件已自动快照，可随时断开还原', 'Takes effect after restarting {id}; the original files were auto-snapshotted and can be restored anytime by detaching', { id: r.harness }) }))
  } catch (e) {
    audit(bi('接入客户端', 'Attach client'), String(b.harness ?? '-'), undefined, (e as Error).message)
    sendError(res, 400, (e as Error).message)
  }
  return
}

export async function hDetach(c: AdminCtx): Promise<void> {
  const { rt, req, res, audit } = c
  const b = await jsonRequestBody(req)
  // 临时 harness（C14）不支持 detach：它不是客户端接入（无文件触达、不落盘），到期即焚或
  // revoke 吊销；走 detach 会误报「尚未接入」（ops 只看盘上配置）
  const detachId = String(b.harness ?? '')
  if (rt.ephemeral.has(detachId)) {
    return sendError(res, 400, t('「{id}」是临时凭据（用完即焚）：不支持 detach，等待 TTL 到期或调 harness/revoke 吊销', '"{id}" is an ephemeral credential (burn-after-use): detach does not apply; let the TTL expire or revoke it via harness/revoke', { id: detachId }))
  }
  try {
    const r = await detachHarness(String(b.harness ?? ''))
    await reloadRuntime(rt)
    audit(bi('断开客户端', 'Detach client'), String(b.harness ?? '-'), r.restored ? bi('已还原到本次接入前（快照 {id}）', 'Restored to the state before this attach (snapshot {id})', { id: r.snapshotId ?? '-' }) : bi('已反向清理网关配置', 'Gateway-side config cleaned up in reverse'))
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, ...r }))
  } catch (e) {
    audit(bi('断开客户端', 'Detach client'), String(b.harness ?? '-'), undefined, (e as Error).message)
    sendError(res, 400, (e as Error).message)
  }
  return
}

export async function hHarnessRoute(c: AdminCtx): Promise<void> {
  const { rt, req, res, audit } = c
  // 客户端钉路由：UI 按「服务」（provider）操作，API 也可直接指定 profile 名；default = 恢复跟随全局。
  // 路由本身只改 config 的 harness.route（服务端内存，热加载后下一请求生效）；烤模型客户端
  // （dsh/workbuddy/zcode，adapter.bakesModels）的模型列表烙在客户端文件里，钉定后需按新 profile 重写
  const b = await jsonRequestBody(req)
  const hid = String(b.harness ?? '')
  try {
    if (!rt.config.harness[hid]) return sendError(res, 400, t('客户端「{id}」未接入，先接入再设置路由', 'Client "{id}" is not attached; attach it first to set a route', { id: hid }))
    // 临时 harness（C14）：路由在 provision 时钉定，运行中不支持改钉（写盘链路里它不存在，
    // 会误报「刚刚断开」）；要换路由重新 provision 一条即可
    if (rt.ephemeral.has(hid)) {
      return sendError(res, 400, t('「{id}」是临时凭据：路由在 provision 时钉定，不支持改钉；换路由请重新 provision 一条', '"{id}" is an ephemeral credential: its route is pinned at provision time and cannot be re-pinned; provision a new one to change routes', { id: hid }))
    }
    if (rt.config.harness[hid].mode === 'direct') {
      return sendError(res, 400, t('客户端「{id}」是独立直连模式：更换直连目标请用 /harness/mode（需要重写客户端配置文件）', 'Client "{id}" is in standalone direct mode: use /harness/mode to change the direct target (client config files get rewritten)', { id: hid }))
    }
    if (rt.config.harness[hid].mode === 'file') {
      return sendError(res, 400, t('客户端「{id}」是 file 模式（客户端自管路由），不支持钉定', 'Client "{id}" is in file mode (it manages its own routing) and cannot be pinned', { id: hid }))
    }
    const toDefault = b.default === true
    const profileName = typeof b.profile === 'string' && b.profile ? b.profile : ''
    const providerId = typeof b.provider === 'string' && b.provider ? b.provider : ''
    if (!toDefault && !profileName && !providerId) {
      return sendError(res, 400, t('缺少路由目标：provider / profile / default 三选一', 'Missing route target: provide one of provider / profile / default'))
    }
    if (profileName && !rt.config.profiles[profileName]) {
      return sendError(res, 400, t('profile「{name}」不存在', 'Profile "{name}" not found', { name: profileName }))
    }
    if (providerId && !rt.config.providers[providerId]) {
      return sendError(res, 400, t('服务「{id}」不存在', 'Service "{id}" not found', { id: providerId }))
    }
    // 协议兼容校验（钉到具体服务/profile 才查；恢复跟随全局不查——全局路由动态变化）：
    // 单协议客户端钉到不支持其协议的服务 = 钉成功但请求永远被静默改发给别家，写盘前拒绝
    const checkProviderId = profileName ? rt.config.profiles[profileName]?.provider : providerId || undefined
    if (checkProviderId) {
      const conflict = await pinRouteProtocolError(hid, checkProviderId, rt.config)
      if (conflict) return sendError(res, 400, conflict)
    }
    let finalRoute = toDefault ? 'default' : profileName
    await persistConfig(rt, (c) => {
      // 只以写锁内的最新配置为源：并发 detach（CLI/Web 同时操作）时 rt.config 还是进 handler
      // 前的旧引用，拿它兜底会把 {route} 幽灵条目写回已断开的客户端（指向无 token 的死路由）
      const he = c.harness[hid]
      if (!he) {
        throw new UpstreamError(400, t('客户端「{id}」刚刚断开，路由未设置；请刷新后重试', 'Client "{id}" was just detached; route not set — refresh and retry', { id: hid }))
      }
      if (!toDefault && !profileName && providerId) {
        finalRoute = profileForProvider(c, providerId)
      }
      c.harness[hid] = { ...he, route: finalRoute }
    })
    // 烤模型客户端按目标 profile 重写模型列表（恢复跟随 = 按 active_profile 重写；透明客户端为空操作）
    const syncProfile = toDefault ? rt.config.active_profile ?? undefined : finalRoute
    const synced = syncProfile
      ? await resyncHarnessToRoute(hid, syncProfile, { port: rt.port })
      : { refreshed: [], warnings: [] }
    const detail = biCat(
      finalRoute === 'default' ? bi('恢复跟随全局', 'Back to follow global') : bi('钉到 {route}', 'Pinned to {route}', { route: finalRoute }),
      synced.refreshed.length ? bi('；已同步重写 {id} 的模型列表（重启该客户端生效）', '; rewrote the model list of {id} (restart the client to apply)', { id: hid }) : '',
      synced.warnings.length ? bi('；{list}', '; {list}', { list: biJoin('；', '; ', synced.warnings) }) : ''
    )
    audit(bi('客户端钉路由', 'Pin client route'), hid, detail)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, route: finalRoute, ...synced, hint: synced.refreshed.length ? t('已同步重写该客户端的模型列表，重启该客户端后生效', 'Rewrote the model list of this client; restart the client to apply') : undefined }))
  } catch (e) {
    audit(bi('客户端钉路由', 'Pin client route'), hid, undefined, (e as Error).message)
    sendError(res, 400, (e as Error).message)
  }
  return
}

export async function hHarnessMode(c: AdminCtx): Promise<void> {
  const { rt, req, res, audit } = c
  // 接入模式切换：direct（独立直连，写上游 url+真实 Key，重写客户端文件）⇄ gateway（切回网关）。
  // 复用 ops.switchHarnessMode（快照/原子写/登记），直连后客户端不经过网关，网关挂掉仍可用作救援通道
  const b = await jsonRequestBody(req)
  const hid = String(b.harness ?? '')
  const mode = b.mode === 'direct' ? 'direct' : b.mode === 'gateway' ? 'gateway' : ''
  if (!mode) return sendError(res, 400, t('mode 必须是 gateway 或 direct', 'mode must be gateway or direct'))
  const he = rt.config.harness[hid]
  if (!he) return sendError(res, 400, t('客户端「{id}」未接入，先接入再切换模式', 'Client "{id}" is not attached; attach it first to switch modes', { id: hid }))
  if (he.mode === 'file') return sendError(res, 400, t('file 模式的客户端暂不支持切换直连', 'Clients in file mode do not support switching to direct yet'))
  if (mode === 'gateway' && he.mode !== 'direct') {
    return sendError(res, 400, t('客户端「{id}」已是网关接入模式', 'Client "{id}" is already in gateway mode', { id: hid }))
  }
  if (mode === 'direct' && he.mode === 'direct' && !b.profile && !b.provider) {
    return sendError(res, 400, t('客户端「{id}」已是独立直连模式；更换直连目标请带 profile 或 provider', 'Client "{id}" is already in standalone direct mode; pass profile or provider to change the direct target', { id: hid }))
  }
  const profileOverride = typeof b.profile === 'string' && b.profile ? b.profile : ''
  const providerOverride = typeof b.provider === 'string' && b.provider ? b.provider : ''
  if (profileOverride && !rt.config.profiles[profileOverride]) {
    return sendError(res, 400, t('profile「{name}」不存在', 'Profile "{name}" not found', { name: profileOverride }))
  }
  if (providerOverride && !rt.config.providers[providerOverride]) {
    return sendError(res, 400, t('服务「{id}」不存在', 'Service "{id}" not found', { id: providerOverride }))
  }
  try {
    let profile = profileOverride || undefined
    if (mode === 'direct' && !profile && providerOverride) {
      await persistConfig(rt, (c) => {
        profile = profileForProvider(c, providerOverride)
      })
    }
    const r = await switchHarnessMode(hid, mode, { profile, yes: true, port: rt.port })
    await reloadRuntime(rt)
    audit(mode === 'direct' ? bi('客户端切直连', 'Client switched to direct') : bi('客户端切回网关', 'Client switched back to gateway'), hid, bi('目标 {target}，写入 {n} 个文件', 'Target {target}, wrote {n} files', { target: r.profile, n: r.files.length }))
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, ...r, hint: t('重启 {id} 后生效', 'Takes effect after restarting {id}', { id: hid }) }))
  } catch (e) {
    audit(mode === 'direct' ? bi('客户端切直连', 'Client switched to direct') : bi('客户端切回网关', 'Client switched back to gateway'), hid, undefined, (e as Error).message)
    sendError(res, 400, (e as Error).message)
  }
  return
}

/** GET /_modeldock/harness-usage：per-harness 实时用量计数（admin 门内只读，纯内存读、不落盘）。
 *  数据源 = rt.tokenUsage（数据面限额计数，state/tokenlimits.ts；只统计配了 limits 的 harness，
 *  未配置者无条目、不出现在结果里）。rpm 是固定窗口计数：rpm_started_at 距今超 60s 即窗口已
 *  过期、要等下一个请求经过 checkTokenLimits 才清零——消费方按时间戳自行判陈旧，本端点只读不翻窗。
 *  双口径（day_tokens 总口径 / day_billable_tokens 可计费）定义与「编排器预算判定为何用后者」
 *  见 state/types.ts TokenUsageState 注（2026-11 预算实测账：总口径曾把 GLM 大额缓存读算成 12.1M 假阳性）。 */
export async function hHarnessUsage(c: AdminCtx): Promise<void> {
  const { rt, res } = c
  const usage: Record<string, { rpm: number; rpm_started_at: string; day: string; day_tokens: number; day_billable_tokens: number; ephemeral?: boolean; expires_at?: string }> = {}
  for (const [id, s] of rt.tokenUsage) {
    usage[id] = {
      rpm: s.rpmCount,
      rpm_started_at: new Date(s.rpmStart).toISOString(),
      day: s.dayKey,
      day_tokens: s.dayTokens,
      day_billable_tokens: s.dayBillableTokens,
    }
  }
  // 临时 harness（C14）观测：带 ephemeral:true + expires_at 标记；未配日限额、无 tokenUsage
  // 计数的临时条目也列出（零计数），供编排侧盯 TTL。token 明文不回显（见 hProvisionHarness 注）。
  for (const [id, e] of rt.ephemeral) {
    const s = rt.tokenUsage.get(id)
    usage[id] = {
      rpm: s?.rpmCount ?? 0,
      rpm_started_at: new Date(s?.rpmStart ?? Date.now()).toISOString(),
      day: s?.dayKey ?? localIsoTs().slice(0, 10),
      day_tokens: s?.dayTokens ?? 0,
      day_billable_tokens: s?.dayBillableTokens ?? 0,
      ephemeral: true,
      expires_at: new Date(e.expiresAt).toISOString(),
    }
  }
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ ok: true, usage }))
}

// attach 请求体里的 client_profiles：["desktop"] 或 "desktop,web"（后者兼容表单直传）；非法输入一律忽略为全部
const parseClientProfiles = (v: unknown): string[] | undefined => {
  const list = Array.isArray(v)
    ? v.map((x) => String(x).trim()).filter(Boolean)
    : typeof v === 'string'
      ? v.split(',').map((s) => s.trim()).filter(Boolean)
      : []
  return list.length > 0 ? list : undefined
}
