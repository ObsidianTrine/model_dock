import { c, maskSecret, printTable, randomToken, t } from '../util/index.js'
import { loadConfig, mutateConfig } from '../config/store.js'
import { getSecret } from '../config/secrets.js'
import { allAdapters } from '../adapters/registry.js'
import { autostartStatus } from '../autostart.js'
import { autostartLine } from './gatewaycmd.js'
import { DEFAULT_GATEWAY_PORT, gatewayLive, loadCfg, requireGateway, exitWithError } from './shared.js'
import { resolveClientGatewayPort } from '../ops.js'

export async function cmdStatus(): Promise<void> {
  const cfg = await loadCfg()
  const live = await gatewayLive()
  console.log(
    live
      ? c.green(t('● 网关运行中  http://127.0.0.1:{port}（pid {pid}）', '● Gateway running  http://127.0.0.1:{port} (pid {pid})', { port: live.port, pid: live.pid }))
      : c.yellow(t('○ 网关未运行（modeldock gateway start --daemon）', '○ Gateway not running (modeldock gateway start --daemon)'))
  )
  const svc = autostartStatus()
  if (svc) console.log(autostartLine(svc).trimStart())
  console.log(`active_profile: ${c.bold(cfg.active_profile ?? t('(未设置)', '(not set)'))}`)
  const port = live?.port ?? cfg.gateway?.port ?? DEFAULT_GATEWAY_PORT
  const rows: Record<string, string>[] = []
  // status 各自独立只读，Promise.all 并行（与网关侧 buildOverview 同款），~9 个 adapter 不再逐个串行等
  const statusAdapters = allAdapters(cfg)
  const statusResults = await Promise.all(statusAdapters.map(async (a) => [a, await a.status(cfg, port)] as const))
  for (const [a, st] of statusResults) {
    const he = cfg.harness[a.id]
    const pinned = he?.route && he.route !== 'default' ? he.route : undefined
    rows.push({
      harness: a.id,
      mode: he ? (he.mode === 'direct' ? t('direct(直连)', 'direct') : he.mode) : '-',
      route: pinned ? c.bold(t('钉:{p}', 'pin:{p}', { p: pinned })) : he ? t('跟随全局', 'global') : '-',
      pointing: st.pointing ?? '-',
      detail: st.detail ?? '',
    })
  }
  printTable(rows, ['harness', 'mode', 'route', 'pointing', 'detail'])
  const attached = Object.keys(cfg.harness)
  if (attached.length === 0) console.log(c.gray(t('尚未接管任何 harness；modeldock attach <harness> 或 modeldock init', 'No harnesses attached yet. Use modeldock attach <harness> or modeldock init')))
}

export async function upstreamReachable(base: string, proxy?: string): Promise<{ ok: boolean; detail: string }> {
  // undici 与网关代理模块仅在此使用：惰性加载，避免任何 CLI 命令 / 网关进程为其付出启动成本
  const { request } = await import('undici')
  const { buildDispatcher } = await import('../gateway/proxy.js')
  try {
    const up = await request(base.replace(/\/+$/, '') + '/', {
      method: 'GET',
      dispatcher: buildDispatcher(proxy),
      headersTimeout: 3000,
      bodyTimeout: 3000,
    })
    await up.body.dump()
    return { ok: true, detail: t('HTTP {s}（可达）', 'HTTP {s} (reachable)', { s: up.statusCode }) }
  } catch (e) {
    return { ok: false, detail: (e as Error).message }
  }
}

export async function cmdDoctor(): Promise<void> {
  const lines: { mark: string; msg: string; hint?: string }[] = []
  const ok = (msg: string) => lines.push({ mark: c.green('✓'), msg })
  const warn = (msg: string, hint?: string) => lines.push({ mark: c.yellow('!'), msg, hint })
  const bad = (msg: string, hint?: string) => lines.push({ mark: c.red('✗'), msg, hint })

  let cfg
  try {
    cfg = await loadConfig()
    ok(t('config.toml 可解析（version {v}）', 'config.toml parses (version {v})', { v: cfg.version }))
  } catch (e) {
    bad((e as Error).message, t('modeldock config edit 修复', 'Fix it with modeldock config edit'))
    printDoctor(lines)
    return
  }

  const live = await gatewayLive()
  if (live) ok(t('网关运行中 127.0.0.1:{port}（pid {pid}）', 'Gateway running on 127.0.0.1:{port} (pid {pid})', { port: live.port, pid: live.pid }))
  else warn(t('网关未运行', 'The gateway is not running'), 'modeldock gateway start --daemon')

  const ap = cfg.active_profile
  if (!ap) warn(t('未设置 active_profile', 'active_profile is not set'), 'modeldock profile use <name>')
  else {
    const profile = cfg.profiles[ap]
    if (!profile) bad(t('active_profile「{a}」不存在', 'active_profile "{a}" does not exist', { a: ap }), 'modeldock profile list')
    else {
      const provider = cfg.providers[profile.provider]
      if (!provider) bad(t('profile「{a}」的 provider「{p}」不存在', 'provider "{p}" of profile "{a}" does not exist', { a: ap, p: profile.provider }))
      else {
        ok(t('active_profile「{a}」→ {p}（{u}）', 'active_profile "{a}" → {p} ({u})', { a: ap, p: provider.name ?? profile.provider, u: provider.base_url }))
        const key = await getSecret(provider.key_ref)
        if (key) ok(t('上游 key 可读取（{k}）', 'Upstream key is readable ({k})', { k: maskSecret(key) }))
        else bad(t('上游 key 不可用（key_ref={r}）', 'Upstream key is unavailable (key_ref={r})', { r: provider.key_ref }), `modeldock provider set-key ${profile.provider}`)
        const reach = await upstreamReachable(provider.base_url, provider.proxy)
        if (reach.ok) ok(t('上游可达：{d}', 'Upstream is reachable: {d}', { d: reach.detail }))
        else bad(t('上游不可达：{d}', 'Upstream is unreachable: {d}', { d: reach.detail }), t('检查网络；国外上游可设 provider.proxy="env" 走代理', 'Check the network. For overseas upstreams, set provider.proxy="env" to go through a proxy'))
        const modelCount = Object.keys(provider.models ?? {}).length
        if (modelCount === 0) warn(t('该 provider 模型目录为空', 'This provider has an empty model catalog'), `modeldock model refresh ${profile.provider}`)
        else if (profile.default_model && !(provider.models?.[profile.default_model]?.context_window)) {
          warn(t('默认模型 {m} 缺上下文元数据', 'Default model {m} is missing context metadata', { m: profile.default_model }), `modeldock model set ${profile.provider} ${profile.default_model} --ctx <n>`)
        }
      }
    }
  }

  const port = live?.port ?? cfg.gateway?.port ?? DEFAULT_GATEWAY_PORT
  // 并行探测（status 各自独立只读）；单个 adapter 异常（如 pack 目标文件损坏）不应击穿整条体检——
  // 错误随 adapter 带回，按原顺序逐个输出
  const doctorAdapters = allAdapters(cfg)
  const doctorStatuses = await Promise.all(
    doctorAdapters.map(async (a) => [a, await a.status(cfg, port).catch((e: Error) => e)] as const)
  )
  for (const [a, st] of doctorStatuses) {
    if (st instanceof Error) {
      bad(t('{l}：状态检查失败（{m}）', '{l}: status check failed ({m})', { l: a.label, m: st.message }), t('modeldock adapter list 查看；若配置了 adapter pack 请检查目标文件', 'Run modeldock adapter list to inspect; if an adapter pack is configured, check its target files'))
      continue
    }
    if (st.attached && st.pointing === 'gateway') ok(t('{l}：已接管且指向网关', '{l}: attached and pointing at the gateway', { l: a.label }))
    else if (st.attached && st.pointing === 'other') bad(t('{l}：已接管但配置指向别处', '{l}: attached but its config points elsewhere', { l: a.label }), t('modeldock attach {id} 重新写入', 'Rewrite it with modeldock attach {id}', { id: a.id }))
    else if (st.attached) warn(t('{l}：已接管但未检测到指向（file 模式或待重启）', '{l}: attached but no pointing detected (file mode, or restart pending)', { l: a.label }))
    else if (st.installed) warn(t('{l}：已安装未接管（不影响使用）', '{l}: installed but not attached (no impact on use)', { l: a.label }), `modeldock attach ${a.id}`)
    else if (a.id !== 'generic-env') lines.push({ mark: c.gray('○'), msg: t('{l}：未安装，跳过', '{l}: not installed, skipped', { l: a.label }) })
  }

  printDoctor(lines)
}

function printDoctor(lines: { mark: string; msg: string; hint?: string }[]): void {
  console.log()
  for (const l of lines) {
    console.log(`${l.mark} ${l.msg}`)
    if (l.hint) console.log(c.gray(`  → ${l.hint}`))
  }
}

export async function cmdTest(
  profileArg: string | undefined,
  opts: { model?: string; timeout?: string }
): Promise<void> {
  const live = await requireGateway()
  const cfg = await loadCfg()
  const profileName = profileArg ?? cfg.active_profile
  if (!profileName) {
    console.error(c.red(t('✗ 未指定 profile 且未设置 active_profile', '✗ No profile given and active_profile is not set')))
    process.exit(1)
  }
  console.log(c.gray(t('经网关对「{p}」发一次最小请求（stream）…', 'Sending a minimal request to "{p}" through the gateway (stream)…', { p: profileName })))
  try {
    const res = await fetch(`http://127.0.0.1:${live.port}/_modeldock/test`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-modeldock-admin': live.admin_token },
      body: JSON.stringify({ profile: profileName, model: opts.model, stream: true }),
      signal: AbortSignal.timeout((Number(opts.timeout) || 90) * 1000),
    })
    const text = await res.text()
    let j: { ok: boolean; status: number; ms: number; model?: string; usage?: Record<string, number>; err?: string; hint?: string }
    try {
      j = JSON.parse(text)
    } catch {
      exitWithError(
        t('网关返回非 JSON 响应（HTTP {s}）：{b}', 'The gateway returned a non-JSON response (HTTP {s}): {b}', { s: res.status, b: text.slice(0, 120) }),
        t('modeldock gateway status 检查网关状态；端口可能被其他服务占用（modeldock gateway stop 后重启）', 'Check the gateway with modeldock gateway status; the port may be taken by another service (stop with modeldock gateway stop, then restart)')
      )
    }
    if (j.ok) {
      const usage = j.usage ? `  usage=${JSON.stringify(j.usage)}` : ''
      console.log(c.green(t('✓ 畅通：{p} / {m}  {ms}ms{u}', '✓ OK: {p} / {m}  {ms}ms{u}', { p: profileName, m: String(j.model), ms: j.ms, u: usage })))
    } else {
      console.error(c.red(t('✗ 不通：HTTP {s}  {ms}ms', '✗ Failed: HTTP {s}  {ms}ms', { s: j.status, ms: j.ms })))
      if (j.err) console.error(c.gray(`  ${j.err}`))
      if (j.hint) console.error(c.yellow(t('提示: {h}', 'Hint: {h}', { h: j.hint })))
      process.exit(1)
    }
  } catch (e) {
    exitWithError(t('测试失败：{m}', 'Test failed: {m}', { m: (e as Error).message }), (e as Error).name === 'TimeoutError' ? t('上游响应超时，可用 -t 加大秒数', 'The upstream timed out. Increase the seconds with -t') : undefined)
  }
}

export async function cmdEnv(): Promise<void> {
  let cfg = await loadConfig()
  if (!cfg.harness['generic-env']) {
    const token = randomToken('mdk_generic')
    await mutateConfig((c2) => {
      c2.harness['generic-env'] = {
        mode: 'gateway',
        route: 'default',
        token,
        attached_at: new Date().toISOString(),
        files: [],
      }
    })
    console.error(c.gray(t('# 已自动创建 generic-env 接管（无文件改动）；撤销：modeldock detach generic-env', '# generic-env attach was created automatically (no files changed). Undo: modeldock detach generic-env')))
    cfg = await loadConfig()
  }
  const port = await resolveClientGatewayPort(undefined, cfg.gateway?.port)
  const token = cfg.harness['generic-env'].token
  console.log(t('# source 到 shell：eval "$(modeldock env)"', '# Source into your shell: eval "$(modeldock env)"'))
  console.log(`export ANTHROPIC_BASE_URL=http://127.0.0.1:${port}`)
  console.log(`export ANTHROPIC_AUTH_TOKEN=${token}`)
  console.log(`export OPENAI_BASE_URL=http://127.0.0.1:${port}/v1`)
  console.log(`export OPENAI_API_KEY=${token}`)
}
