import fsp from 'node:fs/promises'
import { ConfigError, configLockPath, mutateConfig } from '../../config/store.js'
import { snapshot } from '../../backup/snapshot.js'
import { DEFAULT_LAN_PORT } from '../../config/types.js'
import { deleteSecret, invalidateSecretsCacheIfExternal, providerAllKeyRefs, providerKeyRefs, verifySecretsStore } from '../../config/secrets.js'
import { installAutostart, uninstallAutostart } from '../../autostart.js'
import { detachHarness } from '../../ops.js'
import { readSyncState } from '../../sync/state.js'
import { appendLineErrorCount, randomToken, withFileLock } from '../../util/fsx.js'
import { localIsoTs } from '../../util/time.js'
import { t, bi, biJoin } from '../../util/i18n.js'
import { modeldockDir, secretsPath } from '../../util/paths.js'
import { AdminCtx, errorReply, jsonRequestBody, maxBodyBytes, readBody, sendError } from '../admin-shared.js'
import { providerConcurrencyIds, providerConcurrencyLimit, providerConcurrencyStats } from '../concurrency.js'
import { buildLanStatus, refreshPreferredAddress, resolveLanToken, startLanServer, stopLan } from '../lan.js'
import { buildConfigView, invalidateOverviewCache } from '../overview-view.js'
import { probe, probePing } from '../probe/direct.js'
import { eventLoopLagMs, keyPoolHealthView, latencyQuantiles, logRequest, mutateGatewayState, readGatewayState, reloadRuntime, resolveByProfile, resolveTarget, seaStateSnapshot, seaWindowView, unregisterEphemeralHarness, SEA_WINDOW_5M_MS, SEA_WINDOW_60M_MS, type GatewayRuntime, type ResolvedTarget } from '../state.js'
import { catalogView } from '../ui-cache.js'

export async function hRotate(c: AdminCtx): Promise<void> {
  const { rt, req, res, audit } = c
  try {
    rt.adminToken = randomToken('mdkadm')
    // 只更新状态文件里的 token（串行队列防并发丢字段）；无状态文件（测试/嵌入式启动）则只换内存态
    await mutateGatewayState((state) => (state ? { ...state, admin_token: rt.adminToken } : null))
    const host = req.headers.host ?? `127.0.0.1:${rt.port ?? ''}`
    const consoleUrl = `http://${host}/_modeldock/ui?token=${rt.adminToken}`
    audit(bi('轮换管理令牌', 'Rotate admin token'), '-', bi('旧令牌已失效', 'Old token revoked'))
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, admin_token: rt.adminToken, console_url: consoleUrl }))
  } catch (e) {
    sendError(res, 400, (e as Error).message)
  }
  return
}

export async function hStatus(c: AdminCtx): Promise<void> {
  const { rt, res } = c
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(
    JSON.stringify({
      ok: true,
      active_profile: rt.config.active_profile ?? null,
      providers: Object.keys(rt.config.providers),
      profiles: Object.keys(rt.config.profiles),
      harness: Object.keys(rt.config.harness),
      reloads: rt.reloads,
      uptime_ms: Date.now() - rt.startedAt,
    })
  )
  return
}

export async function hConfig(c: AdminCtx): Promise<void> {
  const { rt, res } = c
  const view = await buildConfigView(rt)
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify(view))
  return
}

export async function hModelCatalog(c: AdminCtx): Promise<void> {
  const { req, res } = c
  // 模型元数据兜底总表（内置表 ∪ models.dev 目录，8000+ 条）：量大，单端点懒加载一次，
  // 不进 overview（每 5s 轮询，塞进去每秒多出百 KB 流量）。序列化结果缓存 + ETag：
  // 控制台每次刷新重拉时命中 304，不再重复 stringify/传输几百 KB（cache-control 覆盖
  // 管理面统一 no-store 为 no-cache：可存储但必须条件重验证，与 /ui 页同款策略）
  const { data, etag } = catalogView()
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { etag, 'cache-control': 'no-cache' })
    res.end()
    return
  }
  res.writeHead(200, { 'content-type': 'application/json', etag, 'cache-control': 'no-cache' })
  res.end(data)
  return
}

export async function hLanGet(c: AdminCtx): Promise<void> {
  const { rt, res } = c
  // 手机简版控制台状态（二维码只对已过 admin 鉴权的本机控制台返回）
  // 顺带重算默认出口地址：换 Wi-Fi / 起停 VPN 后该用哪块网卡会变，面板一刷新即纠正二维码
  await refreshPreferredAddress()
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ ok: true, ...buildLanStatus(rt) }))
  return
}

export async function hLanPost(c: AdminCtx): Promise<void> {
  const { rt, req, res, audit } = c
  // 开关手机简版控制台：config.lan.enabled 落盘并即时启停第二监听器；
  // LAN 凭据复用 gateway.json 旧值（手机 cookie 跨重启不掉），没有才新生成
  const b = await jsonRequestBody(req)
  try {
    if (b.enabled === true) {
      const state = await readGatewayState()
      const lanToken = resolveLanToken(state?.lan_token ?? null)
      await startLanServer(rt, { port: rt.config.lan?.port ?? DEFAULT_LAN_PORT, token: lanToken })
      await mutateConfig((c) => {
        c.lan = { ...(c.lan ?? {}), enabled: true }
      })
      await reloadRuntime(rt)
      await mutateGatewayState((refreshed) =>
        refreshed ? { ...refreshed, lan_token: lanToken, lan_port: rt.lan?.port } : null
      )
      audit(bi('手机远程', 'Mobile console'), bi('开启', 'on'), bi('端口 {port}', 'port {port}', { port: rt.lan?.port ?? 0 }))
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, ...buildLanStatus(rt) }))
    } else {
      stopLan(rt)
      await mutateConfig((c) => {
        c.lan = { ...(c.lan ?? {}), enabled: false }
      })
      await reloadRuntime(rt)
      await mutateGatewayState((refreshed) => (refreshed ? { ...refreshed, lan_port: undefined } : null))
      audit(bi('手机远程', 'Mobile console'), bi('关闭', 'off'))
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, ...buildLanStatus(rt) }))
    }
  } catch (e) {
    audit(bi('手机远程', 'Mobile console'), '-', undefined, (e as Error).message)
    // 失败走 sendError（经 errorReply 还原业务错误状态码与 hint），不再 200+{ok:false}：
    // 控制台 api() 封装按 !res.ok 抛错并取 error.message，200 包体会被当成功静默吞掉
    // （2026-11-04 审查 P2）。前端两处调用（pillSwitch 开关 / configpack 导出面板）均有 catch 展示
    const r = errorReply(e)
    sendError(res, r.status, r.message, r.hint)
  }
  return
}

export async function hAutostart(c: AdminCtx): Promise<void> {
  const { req, res, audit } = c
  // 开机自启开关。网关必然处于运行中，install 只登记服务文件、不 bootstrap——
  // 否则第二个实例被单实例保护拒掉，launchd KeepAlive 会陷入重启循环。
  const b = await jsonRequestBody(req)
  try {
    if (b.enabled === true) {
      const r = await installAutostart()
      audit(bi('开机自启', 'Start at login'), bi('开启', 'on'), bi('服务文件 {file}', 'Service file {file}', { file: r.file }))
      // 不走 persistConfig（reloads 不变），不清缓存则紧随的 overview GET 会命中 6s TTL 旧值，UI 回灌旧状态
      invalidateOverviewCache()
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, installed: true, note: r.note ?? t('下次登录自动启动', 'Starts automatically at next login') }))
    } else {
      const r = await uninstallAutostart()
      audit(bi('开机自启', 'Start at login'), bi('关闭', 'off'), r.wasInstalled ? bi('已移除 {path}', 'Removed {path}', { path: r.removed }) : bi('本就未安装', 'Was not installed'))
      invalidateOverviewCache()
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, installed: false }))
    }
  } catch (e) {
    audit(bi('开机自启', 'Start at login'), '-', undefined, (e as Error).message)
    sendError(res, 400, (e as Error).message)
  }
  return
}

export async function hReload(c: AdminCtx): Promise<void> {
  const { rt, res, audit } = c
  try {
    await reloadRuntime(rt)
    // 手动兜底语义补全：watcher 失效（health 提示走这里）时外部改的 key 也一并即刻生效——
    // invalidateSecretsCacheIfExternal 按盘上指纹区分自家/外部写，自家刚写的不误失效
    await invalidateSecretsCacheIfExternal()
    audit(bi('重载配置', 'Reload config'), '-', bi('第 {n} 次热重载', 'Hot reload #{n}', { n: rt.reloads }))
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, reloads: rt.reloads }))
  } catch (e) {
    audit(bi('重载配置', 'Reload config'), '-', undefined, (e as Error).message)
    sendError(res, 500, t('配置重载失败：{msg}', 'Failed to reload config: {msg}', { msg: (e as Error).message }))
  }
  return
}

export async function hTest(c: AdminCtx): Promise<void> {
  const { rt, req, res, o } = c
  const url = '/_modeldock/test'
  const body = await readBody(req, maxBodyBytes(rt.config))
  let p: { profile?: string; provider?: string; model?: string; stream?: boolean; mode?: string } = {}
  try {
    p = body.length ? JSON.parse(body.toString('utf8')) : {}
  } catch {
    return sendError(res, 400, t('test 请求体必须是 JSON', 'The test request body must be JSON'))
  }
  let resolved: { ok: boolean; target?: ResolvedTarget; status?: number; message?: string; hint?: string }
  if (p.provider) {
    // 按服务直接探测（不必先建路由）
    const provider = rt.config.providers[p.provider]
    if (!provider) return sendError(res, 400, t('服务「{id}」不存在', 'Service "{id}" not found', { id: p.provider }))
    const models = Object.keys(provider.models ?? {})
    const fakeProfile = {
      name: `probe-${p.provider}`,
      provider: p.provider,
      default_model: p.model ?? models[0],
    }
    resolved = { ok: true, target: { harness: 'admin-test', profileName: fakeProfile.name, profile: fakeProfile, provider } }
  } else {
    resolved = resolveByProfile(rt, p.profile)
  }
  if (!resolved.ok) return sendError(res, resolved.status ?? 400, resolved.message ?? t('无法解析路由', 'Cannot resolve a route'), resolved.hint)
  // mode='ping' → 纯网络延迟（不推理）；否则保持原有的完整模型请求测速
  const out = p.mode === 'ping'
    ? await probePing(rt, resolved.target!.provider)
    : await probe(rt, resolved.target!, p.model, p.stream === true, o)
  // 连接测试也记入请求日志（客户端记为 admin-test），便于追溯测试失败原因
  logRequest(rt, {
    ts: localIsoTs(),
    harness: 'admin-test',
    profile: resolved.target?.profileName ?? '-',
    provider: p.provider ?? resolved.target?.profile.provider ?? '-',
    model: (out as { model?: string }).model ?? p.model,
    path: p.mode === 'ping' ? 'ping' : url,
    status: out.ok ? 200 : 502,
    ms: out.ms,
    err: out.err,
  })
  res.writeHead(out.ok ? 200 : 502, { 'content-type': 'application/json' })
  res.end(JSON.stringify(out))
  return
}

export async function hReset(c: AdminCtx): Promise<void> {
  const { rt, res, audit } = c
  const { configPath, secretsPath } = await import('../../util/paths.js')
  const fs = await import('node:fs')
  // 与 CLI cmdReset（cli/basic.ts）同语义的三步序：先把已接管客户端逐个 detach 还原快照，
  // 再清钥匙环、删 config/secrets。旧实现直接 unlink 的后果：客户端文件仍指向本网关但
  // rt.tokens 已随空配置清空（全部客户端 401），且 config.harness 被删、attach 快照的
  // 自动还原路径失效——只能人工翻 backups/。
  // 1) 删前快照当前 config/secrets（unlink 绕过 atomicWrite 不触发自动快照，不补拍就没有「重置前」还原点）
  let snapshotId: string | undefined
  try {
    snapshotId = (await snapshot('config', 'pre-reset', [configPath(), secretsPath()])).id
  } catch { /* 快照失败不阻断重置（backups/ 通常已有历史快照） */ }
  // 2) 逐个 detach 还原客户端文件（单个失败不中断，对齐 CLI：逐条记失败继续）
  // 临时 harness（runtime-only 合成条目，不在盘上 config、无客户端文件可还原）不进 detach：
  // detachHarness 先查盘上 config.harness 必抛「尚未接入」，逐条污染 restoreFailed 假失败——
  // 用完即焚语义走 unregister 即收尾（重置后也不应幸存，reloadRuntime 的 reapply 会重注入幸存者）
  const restored: string[] = []
  const restoreFailed: string[] = []
  for (const id of Object.keys(rt.config.harness)) {
    if (rt.ephemeral.has(id)) {
      unregisterEphemeralHarness(rt, id)
      continue
    }
    try {
      await detachHarness(id)
      restored.push(id)
    } catch (e) {
      restoreFailed.push(`${id}: ${(e as Error).message}`)
    }
  }
  // 3) 清 OS 钥匙环里的 Key（keychain/secret-service 条目不在 secrets.json 里，删文件清不掉；
  // providerAllKeyRefs 全量口径盖住 keys[] 池，与 CLI reset 同口径）
  let secretsCleared = 0
  for (const [, p] of Object.entries(rt.config.providers)) {
    for (const ref of providerAllKeyRefs(p)) {
      try {
        await deleteSecret(ref)
        secretsCleared++
      } catch { /* 单项失败不影响其余 */ }
    }
  }
  // 删文件前包同一把 config 写锁（CORRECT-06 同法）：Web reset 与 CLI / 另一实例的 mutateConfig
  // 是独立写者，裸 unlink 会在他人「读文件→改→写回」的窗口里删掉目标、随后被整包写回归活——
  // reset 表面成功配置却还在。锁内删除让并发写者要么先完成再被删、要么等删除后才拿到锁
  // （读到空配置），不再复活（2026-11-04 审查 P2）
  const files = [configPath(), secretsPath()]
  const deleted: string[] = []
  const deleteFailed: Array<{ file: string; msg: string }> = []
  await withFileLock(configLockPath(), {
    // 超时报错与 mutateConfig 同口径（ConfigError → 400 + 可操作 hint），裸锁错误会落 500
    timeoutError: (lp) =>
      new ConfigError(
        t('重置失败：{lp} 被其他进程长期占用（可能是异常退出的残留锁）', 'Reset failed: {lp} has been held by another process for too long (possibly a stale lock from a crashed process)', { lp }),
        t('确认没有其他 modeldock 进程在写配置后，可删除该 .lock 文件重试', 'After confirming no other modeldock process is writing the config, delete the .lock file and retry')
      ),
  }, async () => {
    for (const f of files) {
      try {
        if (fs.existsSync(f)) { fs.unlinkSync(f); deleted.push(f) }
      } catch (e) {
        deleteFailed.push({ file: f, msg: (e as Error).message })
      }
    }
  })
  // fail-loud（审计 F4）：破坏性操作删文件失败必须如实报错——旧实现吞错后无条件 ok:true，
  // 用户以为配置已清空、实际原样存活。失败即中止（不 reloadRuntime 把幸存配置刷进运行态），
  // ConfigError 经顶层 errorReply 还原 400+hint，与上方锁超时同信封
  if (deleteFailed.length > 0) {
    const failedFiles = deleteFailed.map((d) => d.file)
    audit(
      bi('重置配置', 'Reset config'),
      '-',
      undefined,
      bi('删除 {files} 失败，重置中止：{msg}', 'Failed to delete {files}; reset aborted: {msg}', {
        files: biJoin('、', ', ', failedFiles),
        msg: deleteFailed.map((d) => d.msg).join('；'),
      })
    )
    throw new ConfigError(
      t('重置失败：{files} 删除未成功（配置未被清除，重置未完成）', 'Reset failed: {files} could not be deleted (config not cleared, reset incomplete)', { files: biJoin('、', ', ', failedFiles) }),
      t('文件可能被其他程序占用（编辑器/杀毒/云同步等）——关闭占用程序后重试重置', 'The file may be held open by another program (editor/antivirus/cloud sync) — close it and retry the reset')
    )
  }
  await reloadRuntime(rt)
  audit(
    bi('重置配置', 'Reset config'),
    '-',
    bi('还原 {h} 个客户端接管，删除 {files}，清除 {n} 个密钥', 'Restored {h} client attaches; deleted {files}; cleared {n} keys', { h: restored.length, files: deleted.length ? biJoin('、', ', ', deleted) : bi('无文件', 'no files'), n: secretsCleared }),
    restoreFailed.length ? bi('部分客户端还原失败：' + restoreFailed.join('；'), 'Some client restores failed: ' + restoreFailed.join('; ')) : undefined
  )
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ ok: true, deleted, restored, restoreFailed, snapshotId, hint: t('配置已清空（含钥匙环密钥）；快照和日志保留。运行 modeldock init 重新配置', 'Config cleared (including keychain keys); snapshots and logs are kept. Run modeldock init to set up again') }))
  return
}

// ===== 健康自检（/_modeldock/health 与数据面 /v1/health 共用）=====

/** secrets 自检缓存：verifySecretsStore 读盘+解密，health 高频被探（gatewayLive / 托盘 / 监控），
 *  结果按 secrets.json mtime 缓存 60s——mtime 未变且 60s 内直接复用，mtime 变化立即重验。 */
let secretsHealthCache: { at: number; mtimeMs: number; ok: boolean } | null = null

export async function secretsOkCached(): Promise<boolean> {
  const now = Date.now()
  let mtimeMs = 0
  try {
    mtimeMs = (await fsp.stat(secretsPath())).mtimeMs
  } catch {
    /* 文件不存在（未设过任何 key）：mtime 记 0，verify 给出确定结论 */
  }
  const c = secretsHealthCache
  if (c && c.mtimeMs === mtimeMs && now - c.at < 60_000) return c.ok
  const r = await verifySecretsStore()
  secretsHealthCache = { at: now, mtimeMs, ok: r.ok }
  return r.ok
}

/** /health 只读自检视图。全量子检（secrets/watcher/磁盘/同步）各自独立 try/catch：
 *  任一项失败置 null / 降级返回部分，亚健康也要能答（探活不能因自检项异常而 5xx）。 */
export async function healthView(rt: GatewayRuntime): Promise<Record<string, unknown>> {
  const now = Date.now()
  // secrets_ok：密钥表可读可解密（mtime 缓存 60s）
  let secretsOk: boolean
  try {
    secretsOk = await secretsOkCached()
  } catch {
    secretsOk = false // verifySecretsStore 自身不抛，此处兜底异常路径
  }
  // disk_free_mb：modeldockDir 所在盘剩余空间（fs.statfs，Node≥18 三平台可用；失败置 null）
  let diskFreeMb: number | null = null
  try {
    const st = await fsp.statfs(modeldockDir())
    const bytes = Number(st.bsize) * Number(st.bavail)
    if (Number.isFinite(bytes) && bytes >= 0) diskFreeMb = Math.floor(bytes / (1024 * 1024))
  } catch {
    diskFreeMb = null
  }
  // sync：多机同步状态（sync.json 损坏/缺失降级为 null 字段，不影响其余自检）
  let syncMode: string | null = null
  let syncLastErrorTs: string | null = null
  try {
    const st = await readSyncState()
    if (st) {
      syncMode = st.mode
      syncLastErrorTs = st.lastErrorTs
    }
  } catch {
    /* sync.json 非法：同步域自检降级，健康端点照常应答 */
  }
  return {
    ok: true,
    started_at: localIsoTs(new Date(rt.startedAt)),
    uptime_ms: now - rt.startedAt,
    reloads: rt.reloads,
    active_profile: rt.config.active_profile ?? null,
    secrets_ok: secretsOk,
    watcher_alive: rt.watcherAlive === true ? true : rt.watcherAlive === false ? false : null,
    log_write_errors: appendLineErrorCount(),
    disk_free_mb: diskFreeMb,
    sync: { mode: syncMode, lastErrorTs: syncLastErrorTs },
  }
}

export async function hMetrics(c: AdminCtx): Promise<void> {
  const { rt, res } = c
  const providers: Record<string, unknown> = {}
  // 键并集：只有耗时采样（logRequest）或只有海况分桶（recordOutcome）之一的 provider 都要露出。
  // 正常转发两者同来；测试直灌 recordOutcome 时只有 errors 侧（count 等耗时字段缺席）
  const ids = new Set<string>(rt.metricsLatency.keys())
  for (const id of rt.seaErrors?.keys() ?? []) ids.add(id)
  for (const id of ids) {
    const m = rt.metricsLatency.get(id)
    const sp = rt.seaErrors?.get(id)
    providers[id] = {
      ...(m ? { count: m.count, last_ms: m.lastMs ?? null, ...latencyQuantiles(m.samples) } : {}),
      ...(sp
        ? {
            errors: {
              last_5m: seaWindowView(sp, SEA_WINDOW_5M_MS),
              last_60m: seaWindowView(sp, SEA_WINDOW_60M_MS),
            },
          }
        : {}),
    }
  }
  // per-provider 并发水位（实时）：in_flight/queued 来自进程内信号量（concurrency.ts，重启清零），
  // limit 取当前配置 max_concurrency（0 = 不限）。键口径 = providers 段的同款并集（有完成流量才
  // 露出）∪ 当前持有信号量的 provider——首个请求还在途、尚未进耗时采样时也要露出，否则实时
  // 水位恰好漏掉正在满载的时刻。无流量且无在途的 provider 不出现：缺席 = 空闲（0/0），编排侧
  // 勿把缺席当故障（与 model-availability 的缺席语义一致）。
  const concurrency: Record<string, { in_flight: number; queued: number; limit: number }> = {}
  const concurrencyIds = new Set<string>(ids)
  for (const id of providerConcurrencyIds(rt)) concurrencyIds.add(id)
  for (const id of concurrencyIds) {
    const s = providerConcurrencyStats(rt, id)
    concurrency[id] = { in_flight: s.inFlight, queued: s.queued, limit: providerConcurrencyLimit(rt.config.providers[id]) }
  }
  const now = Date.now()
  const meltdown: Array<{ provider: string; class: string; until: string; remaining_ms: number }> = []
  for (const [id, h] of rt.health) {
    if (h.meltdown_until == null || h.meltdown_until <= now) continue
    meltdown.push({
      provider: id,
      class: h.meltdown_cls ?? 'unknown',
      until: new Date(h.meltdown_until).toISOString(),
      remaining_ms: h.meltdown_until - now,
    })
  }
  // 模型级熔断投影（model_fallback 域，ModelHealthState）：与 provider 级 meltdown 段同形，
  // 多 model 维度。键 = `${providerId}\u0000${model}`（state/routing.ts recordModelOutcome 记账），
  // 纯内存读；只露熔断中的条目（TTL 过期/已解除不出现，缺席 = 该模型无在熔断）。
  const model_meltdown: Array<{ provider: string; model: string; class: string; until: string; remaining_ms: number }> = []
  for (const [key, h] of rt.modelHealth ?? []) {
    if (h.meltdown_until == null || h.meltdown_until <= now) continue
    const sep = key.indexOf('\u0000')
    model_meltdown.push({
      provider: sep === -1 ? key : key.slice(0, sep),
      model: sep === -1 ? '' : key.slice(sep + 1),
      class: h.meltdown_cls ?? 'unknown',
      until: new Date(h.meltdown_until).toISOString(),
      remaining_ms: h.meltdown_until - now,
    })
  }
  // 模型级容灾改发计数投影（model_fallback 域，ModelFallbackCounter）：与 model_meltdown 同形
  // 位置、同键口径（key = `${providerId}\u0000${model}`，model = 被改发的原请求模型），纯内存读。
  // fallback_count = 改发累计（闸门预改写 + 链尾合成两路）；absorbed_count = 其中闸门吸收
  // （请求未触达原模型上游）的次数。单调累计（进程生命周期），熔断解除不清零——改发已发生
  // 是历史事实；只露有改发的条目（缺席 = 该键从未改发，与 model_meltdown 的缺席语义一致）。
  const model_fallback: Array<{ provider: string; model: string; fallback_count: number; absorbed_count: number }> = []
  for (const [key, s] of rt.modelFallbackCounts ?? []) {
    const sep = key.indexOf('\u0000')
    model_fallback.push({
      provider: sep === -1 ? key : key.slice(0, sep),
      model: sep === -1 ? '' : key.slice(sep + 1),
      fallback_count: s.fallbackCount,
      absorbed_count: s.absorbedCount,
    })
  }
  // key 池健康（P1⑥ 观测面）：per-provider 配置的 key 数量与失效冷却中的索引（含剩余 ms）。
  // 只有数量/索引/时间，绝无 key 明文或引用原文（ref 可能内嵌明文 key，一律不出域）。
  // 不实际读 key（无 IO，metrics 是轻量端点）：total=配置引用数；healthy=total-冷却数——
  // 个别引用读取失败时会高估 healthy（读取失败不进冷却，见 state/keypool.ts）
  const keypool: Record<string, { total: number; healthy: number; cooldown: Array<{ index: number; remaining_ms: number }> }> = {}
  for (const [id, p] of Object.entries(rt.config.providers)) {
    const total = providerKeyRefs(p).length
    keypool[id] = { total, ...keyPoolHealthView(rt, id, total, now) }
  }
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ event_loop_lag_ms: eventLoopLagMs(), providers, meltdown, model_meltdown, model_fallback, sea_state: seaStateSnapshot(rt, now), keypool, concurrency }))
}

export async function hTierValidate(c: AdminCtx): Promise<void> {
  const { rt, req, res } = c
  const b = await jsonRequestBody(req)
  const token = typeof b.token === 'string' ? b.token : ''
  const wantedTier = typeof b.tier === 'string' ? b.tier.trim() : ''
  if (!token) return sendError(res, 400, t('缺少 token', 'Missing token'))
  const resolved = resolveTarget(rt, token)
  if (!resolved.ok) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: false, reason: resolved.status === 401 ? 'unknown_token' : `resolve_${resolved.status}` }))
    return
  }
  const { target } = resolved
  const providerId = target.profile.provider
  const tierProfiles: Record<string, string[]> = {}
  for (const [id, p] of Object.entries(rt.config.profiles)) {
    const tag = typeof p.tier === 'string' && p.tier.trim() ? p.tier.trim() : null
    if (tag) (tierProfiles[tag] ??= []).push(id)
  }
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(
    JSON.stringify({
      ok: true,
      harness: target.harness,
      profile: target.profileName,
      provider: providerId,
      tier: rt.config.profiles[target.profileName]?.tier ?? null,
      ...(wantedTier ? { requested_tier: wantedTier } : {}),
      models: Object.keys(rt.config.providers[providerId]?.models ?? {}),
      tier_profiles: tierProfiles,
    })
  )
  return
}
