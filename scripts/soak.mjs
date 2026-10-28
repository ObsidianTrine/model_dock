#!/usr/bin/env node
// soak.mjs — 常驻网关长稳/压测工具：为内存/日志增长与流式稳定性提供实测证据。
//
// 用法：node scripts/soak.mjs --minutes <N> [--report-dir <dir>]
//   --minutes N    压测时长（分钟；4 小时级挂机用 240）
//   --report-dir   报告目录（metrics.csv + report.md），默认 os.tmpdir() 下新建
//   退出码：0 = PASS；非 0 = FAIL（含自清理失败与端口未释放）
//
// 一轮流程自包含：
//   临时 FAKE_HOME（os.tmpdir()+随机后缀，结束删除）→ 编程 seed 一个 provider+profile+harness
//   （调 src/config 的 mutateConfig/setSecret，经 tsx loader 子进程执行，见 scripts/ui-smoke.mjs
//   同款处理）→ 子进程拉起网关（node --import tsx src/cli.ts gateway start --port <18910-18919>，
//   前台子进程即网关本体，pid 直接采样 RSS）→ 内置 mock 上游（http.createServer，SSE 流式与
//   非流式两种带 usage 响应）→ 流量发生器：4 路并发，90% POST /v1/messages（50% 流式）+
//   10% GET /v1/models；每 30s 一次 admin overview 轮询；每 5min 一次配置 reload（mutateConfig
//   翻转 retries 制造无害字节变化，触发网关热加载，并按 /health 的 reloads 计数核实生效）→
//   每 30s 追加一行采样到 metrics.csv（网关 RSS + 请求日志 JSONL 累计行数/错误数）→ 结束写
//   report.md（时长/请求数/非 2xx 分类/RSS 首峰值末值/日志增长/结论行）。
//   结论行：RSS 增幅（末值-首值）/首值 <20% 且错误率 <0.5% 判 PASS。
//
// 端口红线：一切监听只在 127.0.0.1 的 18910-18919 段（8687 生产 / 8890 用户 dev 绝对禁止），
// 网关实际监听端口（listenWithRetry 可能顺延）读取后再次白名单校验，越界即失败。FAKE_HOME
// 一律临时目录、子进程 env 剥除 MODELRDOCK_HOME（paths.modeldockDir 优先读它，会绕过
// MODELRDOCK_FAKE_HOME 写穿真实配置），绝不写 ~/.modeldock 与 ~/.modeldock-dev。
// 全部临时进程结束自我清理并核实端口释放（参考 ui-smoke.mjs 的 killTree 写法），沙箱目录删除。
//
// 平台兼容：路径一律 path.join；Windows 进程树 taskkill /T /F、unix 独立进程组信号；RSS 采样
// Windows 走 PowerShell Get-Process（WorkingSet64）、unix 走 ps -o rss=。

import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PORT_MIN = 18910
const PORT_MAX = 18919
const START_TIMEOUT_MS = 60_000
const POLL_INTERVAL_MS = 300
const SAMPLE_MS = 30_000
const RELOAD_MS = 5 * 60_000
const WORKERS = 4
const WORKER_DELAY_MIN_MS = 40
const WORKER_DELAY_MAX_MS = 160
const LOG_IDLE_FLUSH_MS = 5000 // > 网关 appendIdleSweep 的 3s 空闲关流 + 1s 扫描周期，留余量

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 失败统一抛错：由最外层 catch 记 FAIL、finally 保证清理后退出（不能 process.exit 直接失败——
// 会跳过 finally，泄漏网关进程与沙箱目录，ui-smoke 实测踩中）。
function fail(msg) {
  throw new Error(msg)
}

// 全局运行态（模块级）：main 任何阶段失败，finally 都能把已创建的资源清干净——
// 网关子进程 / mock 服务器 / 沙箱目录 / keep-alive agent 一个不落。
const ctx = {
  child: null, // 网关前台子进程（即网关本体，pid 用于 RSS 采样）
  mock: null,
  fakeHome: null,
  gport: 0,
  mockPort: 0,
  agent: null,
  reportMd: null,
  aborted: false, // 用户 Ctrl+C / SIGTERM：尽早停流量、走清理
}
process.on('SIGINT', () => {
  ctx.aborted = true
})
process.on('SIGTERM', () => {
  ctx.aborted = true
})

function assertPortSafe(p) {
  if (!Number.isInteger(p) || p < PORT_MIN || p > PORT_MAX) {
    fail(`端口 ${p} 超出沙箱白名单 ${PORT_MIN}-${PORT_MAX}（8687 生产 / 8890 用户 dev 绝对禁止）`)
  }
}

/** 子进程 env：除 FAKE_HOME 外必须剥除 MODELRDOCK_HOME——paths.modeldockDir 优先读
 *  MODELRDOCK_HOME，宿主带该变量时（多实例/测试重定向）会绕过 FAKE_HOME 把 seed/reload/
 *  网关的读写全部打到真实配置目录，违反「FAKE_HOME 绝不写真实 home」红线。 */
function childEnv(fakeHome) {
  const env = { ...process.env, MODELRDOCK_FAKE_HOME: fakeHome }
  delete env.MODELRDOCK_HOME
  return env
}

function tsxLoaderHref() {
  try {
    const require = createRequire(path.join(ROOT, 'package.json'))
    return pathToFileURL(require.resolve('tsx/esm')).href
  } catch (e) {
    return fail(`无法解析 tsx/esm loader（先 npm install）：${e.message}`)
  }
}

/** 探测 http 状态与响应体（上限 5MB）；连接失败返回 null。opts.headers 附加请求头。 */
function probe(urlPath, port, opts = {}) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: urlPath, timeout: 4000, headers: opts.headers ?? {} },
      (res) => {
        let body = ''
        let size = 0
        res.on('data', (c) => {
          size += c.length
          if (size <= 5 * 1024 * 1024) body += c
          else res.destroy()
        })
        res.on('end', () => resolve({ status: res.statusCode, body }))
        res.on('error', () => resolve(null))
        res.on('close', () => resolve(null)) // 超限 destroy 也走这里（promise 幂等，重复 resolve 无害）
      }
    )
    req.on('timeout', () => {
      req.destroy()
      resolve(null)
    })
    req.on('error', () => resolve(null))
  })
}

function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    return
  }
  try {
    process.kill(-child.pid, 'SIGTERM') // detached 独立进程组，整组终止（网关有 SIGTERM 优雅关停）
  } catch {
    /* 已退出 */
  }
}

async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > deadline) {
      console.log(`[soak] ⚠ 等待超时（${timeoutMs}ms）：${label}`)
      return null
    }
    await sleep(POLL_INTERVAL_MS)
  }
}

/** 尝试在 127.0.0.1:port 上监听（成功即关闭返回 true）——确定性挑空闲端口；清理阶段同样
 *  用它核实端口已释放（能 bind = 无监听者，比 HTTP 探测更硬：不响应的挂死进程也逃不掉）。 */
function tryListen(port) {
  return new Promise((resolve) => {
    const s = net.createServer()
    s.once('error', () => resolve(false))
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)))
  })
}

async function pickFreePort(used) {
  for (let p = PORT_MIN; p <= PORT_MAX; p++) {
    if (used.has(p)) continue
    assertPortSafe(p)
    if (await tryListen(p)) return p
  }
  fail(`18910-18919 段无空闲端口（已占用：${[...used].join(', ') || '无'}）`)
}

/** 网关进程 RSS（MB，1 位小数）。Windows：PowerShell Get-Process WorkingSet64（字节）；
 *  unix：ps -o rss=（KB）。进程消失/查询失败返回 null（调用方按不可测处理）。 */
function rssMb(pid) {
  if (!pid) return null
  try {
    if (process.platform === 'win32') {
      const out = spawnSync(
        'powershell',
        ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid}).WorkingSet64`],
        { encoding: 'utf8', timeout: 10_000 }
      )
      const bytes = Number((out.stdout ?? '').trim())
      if (!Number.isFinite(bytes) || bytes <= 0) return null
      return Math.round((bytes / 1024 / 1024) * 10) / 10
    }
    const out = spawnSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8', timeout: 10_000 })
    const kb = Number((out.stdout ?? '').trim().split(/\s+/)[0])
    if (!Number.isFinite(kb) || kb <= 0) return null
    return Math.round((kb / 1024) * 10) / 10
  } catch {
    return null
  }
}

/** 增量统计沙箱网关请求日志（gateway-*.jsonl）：按文件名记字节偏移，每轮只读新增部分；
 *  半行暂存待下轮补全（同 cli/gatewaycmd.ts 的 readLogLines 思路，4 小时级日志增量读不放大）。
 *  返回本轮增量；累计值在 state.totalLines/totalErrors。hist 记录非 2xx 按状态码分类。 */
function jsonlStats(dir, state, opts = {}) {
  let lines = 0
  let errors = 0
  let bytes = 0
  let names = []
  try {
    names = fs.readdirSync(dir)
  } catch {
    return { lines, errors, bytes }
  }
  for (const name of names) {
    if (!/^gateway-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)) continue
    const full = path.join(dir, name)
    let size = 0
    try {
      size = fs.statSync(full).size
    } catch {
      continue
    }
    bytes += size
    const st = state.files.get(name) ?? { offset: 0, partial: '' }
    if (size > st.offset) {
      const buf = Buffer.alloc(size - st.offset)
      let fd
      try {
        fd = fs.openSync(full, 'r')
        fs.readSync(fd, buf, 0, buf.length, st.offset)
      } finally {
        if (fd !== undefined) fs.closeSync(fd)
      }
      const chunk = st.partial + buf.toString('utf8')
      const parts = chunk.split('\n')
      st.partial = chunk.endsWith('\n') ? '' : (parts.pop() ?? '')
      for (const line of parts) {
        const r = countLogLine(line, state)
        if (!r) continue
        lines++
        if (r.error) errors++
      }
      st.offset = size
    }
    // 最终读数：进程已停、文件不再增长，未收尾的半行按整行结算
    if (opts.final && st.partial.trim()) {
      const r = countLogLine(st.partial, state)
      if (r) {
        lines++
        if (r.error) errors++
      }
      st.partial = ''
    }
    state.files.set(name, st)
  }
  state.totalLines += lines
  state.totalErrors += errors
  return { lines, errors, bytes, totalLines: state.totalLines, totalErrors: state.totalErrors }
}

function countLogLine(line, state) {
  if (!line.trim()) return null
  let o
  try {
    o = JSON.parse(line)
  } catch {
    return null // 坏行/半行静默跳过
  }
  const status = typeof o.status === 'number' ? o.status : null
  // 非 2xx 口径（与报告「非 2xx 计数与分类」一致；status 缺失=流中断类异常也计入错误）
  const error = status === null || status < 200 || status >= 300 || !!o.err
  if (error) {
    const key = status !== null ? String(status) : 'err'
    state.hist.set(key, (state.hist.get(key) ?? 0) + 1)
  }
  return { error }
}

/** 发一次 HTTP 请求并吞掉响应体。admin 传 token 时附带 x-modeldock-admin 头；token 传 harness
 *  token 时附带 Authorization: Bearer（数据面 /v1/messages、/v1/models 都要过网关鉴权）。
 *  返回 {status}；连接失败/超时返回 {status:0}（客户端传输失败，网关日志里不会有这条）。 */
function sendRequest(agent, port, reqPath, { method = 'GET', body = null, admin = null, token = null, timeoutMs = 20_000 } = {}) {
  return new Promise((resolve) => {
    let done = false
    const finish = (r) => {
      if (done) return
      done = true
      resolve(r)
    }
    const headers = {}
    if (admin) headers['x-modeldock-admin'] = admin
    if (token) headers.authorization = `Bearer ${token}`
    if (body) headers['content-type'] = 'application/json'
    const req = http.request({ host: '127.0.0.1', port, path: reqPath, method, headers, agent, timeout: timeoutMs }, (res) => {
      res.on('data', () => {})
      res.on('end', () => finish({ status: res.statusCode ?? 0 }))
      res.on('error', () => finish({ status: 0 }))
    })
    req.on('timeout', () => {
      req.destroy()
      finish({ status: 0 })
    })
    req.on('error', () => finish({ status: 0 }))
    if (body) req.write(body)
    req.end()
  })
}

// ===== mock 上游（SSE 流式 + 非流式，两种都带 usage）=====

/** 流式：anthropic SSE 事件序列，data 行带 usage（message_start 输入 / message_delta 输出），
 *  网关旁路 usage tap 按此解析；15ms 一个 delta 模拟 token 逐段产出。
 *  客户端中途断开时 res.write 可能抛错——error 监听 + destroyed 守卫防止异步未捕获异常绕过清理。 */
function sseRespond(res) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  const ev = (type, payload) => `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`
  const write = (chunk) => {
    if (res.destroyed || res.writableEnded) return
    try {
      res.write(chunk)
    } catch {
      /* 连接已断，忽略 */
    }
  }
  write(
    ev('message_start', {
      type: 'message_start',
      // usage 嵌在 message 内：与真实 anthropic 格式一致，网关旁路 usage tap 按 message.usage 取输入用量
      message: {
        id: 'msg_soak',
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'soak-model-1',
        usage: { input_tokens: 12, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    })
  )
  const deltas = ['Hello', ' from', ' soak', ' mock', ' upstream', '.']
  let i = 0
  const timer = setInterval(() => {
    if (i < deltas.length) {
      write(
        ev('content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: deltas[i] },
        })
      )
      i++
      return
    }
    clearInterval(timer)
    write(
      ev('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 18 },
      })
    )
    write(ev('message_stop', { type: 'message_stop' }))
    try {
      res.end()
    } catch {
      /* 已断开 */
    }
  }, 15)
  res.on('close', () => clearInterval(timer))
}

function jsonRespond(res) {
  res.writeHead(200, { 'content-type': 'application/json' })
  try {
    res.end(
      JSON.stringify({
        id: 'msg_soak',
        type: 'message',
        role: 'assistant',
        model: 'soak-model-1',
        content: [{ type: 'text', text: 'soak ok' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 12, output_tokens: 8 },
      })
    )
  } catch {
    /* 已断开 */
  }
}

function createMockUpstream() {
  return http.createServer((req, res) => {
    res.on('error', () => {}) // 对端中途断开：写失败不再成为异步未捕获异常
    const p = (req.url ?? '').split('?')[0]
    if (req.method === 'GET' && (p === '/' || p === '/health')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, mock: 'soak' }))
      return
    }
    if (req.method === 'POST' && p === '/v1/messages') {
      let body = ''
      req.on('data', (c) => {
        body += c
        if (body.length > 1024 * 1024) req.destroy() // 超限防御：mock 不接受大包
      })
      req.on('end', () => {
        let stream = false
        try {
          stream = !!JSON.parse(body).stream
        } catch {
          /* 坏 JSON 也回非流式，mock 不挑剔 */
        }
        if (stream) sseRespond(res)
        else jsonRespond(res)
      })
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { type: 'not_found', message: `mock: unknown path ${p}` } }))
  })
}

// ===== seed / reload 子进程脚本（经 tsx loader 动态 import src 的 TS 模块；入口仍是 node 可执行）=====

function srcUrl(rel) {
  return pathToFileURL(path.join(ROOT, 'src', rel)).href
}

function seedSource(mockPort, token) {
  return `// 由 scripts/soak.mjs 生成（一次性 seed 子进程）。先设 FAKE_HOME 再动态 import 源码模块。
const { mutateConfig } = await import('${srcUrl('config/store.ts')}')
const { setSecret } = await import('${srcUrl('config/secrets.ts')}')
const keyRef = await setSecret('soak-provider', 'sk-soak-${crypto.randomBytes(12).toString('hex')}', 'file')
await mutateConfig((c) => {
  c.active_profile = 'soak'
  c.providers['soak'] = {
    name: 'Soak Mock',
    base_url: 'http://127.0.0.1:${mockPort}',
    protocol: 'anthropic',
    auth_style: 'bearer',
    key_ref: keyRef,
    proxy: 'direct',
    models: { 'soak-model-1': { display_name: 'Soak Model 1', source: 'manual' } },
  }
  c.profiles['soak'] = { provider: 'soak', default_model: 'soak-model-1' }
  c.harness['soak'] = { mode: 'gateway', token: '${token}' }
})
console.log('[soak-seed] ok')
`
}

function reloadSource() {
  return `// 由 scripts/soak.mjs 生成（周期性配置 reload 子进程）。翻转 retries 制造无害字节变化，
// 经 config.toml 原子写触发网关 watcher 热加载（reloads+1，由 soak 主进程经 /health 核实）。
const { mutateConfig } = await import('${srcUrl('config/store.ts')}')
let applied = 0
await mutateConfig((c) => {
  const g = { ...(c.gateway ?? {}) }
  g.retries = (g.retries ?? 1) === 1 ? 2 : 1
  c.gateway = g
  applied = g.retries
})
console.log('[soak-reload] ok retries=' + applied)
`
}

/** 运行短命 tsx 子进程（seed/reload），返回 spawnSync 结果；超时/失败不抛、由调用方判。 */
function runTsxChild(scriptPath, fakeHome) {
  return spawnSync(process.execPath, ['--import', tsxLoaderHref(), scriptPath], {
    cwd: ROOT,
    env: childEnv(fakeHome),
    encoding: 'utf8',
    timeout: 60_000,
  })
}

// ===== 流量发生器 =====

async function worker(port, token, stats, stopFlag) {
  while (!stopFlag.done) {
    const isMessages = Math.random() < 0.9
    const reqPath = isMessages ? '/v1/messages' : '/v1/models'
    const body = isMessages
      ? JSON.stringify({
          model: 'soak-model-1',
          max_tokens: 32,
          stream: Math.random() < 0.5,
          messages: [{ role: 'user', content: 'soak ping' }],
        })
      : null
    const r = await sendRequest(ctx.agent, port, reqPath, { method: isMessages ? 'POST' : 'GET', body, token })
    stats.sent++
    if (r.status >= 200 && r.status < 300) stats.ok++
    else if (r.status > 0) stats.httpErr++
    else stats.transportErr++
    await sleep(WORKER_DELAY_MIN_MS + Math.floor(Math.random() * (WORKER_DELAY_MAX_MS - WORKER_DELAY_MIN_MS)))
  }
}

// ===== 主流程 =====

function parseArgs() {
  const argv = process.argv.slice(2)
  let minutes = 60
  let reportDir = null
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--minutes' || argv[i] === '--report-dir') {
      const v = argv[++i]
      if (v === undefined) fail(`参数 ${argv[i - 1]} 缺少值（用法见 --help）`)
      if (argv[i - 1] === '--minutes') minutes = Number(v)
      else reportDir = v
    } else if (argv[i] === '--help' || argv[i] === '-h') {
      console.log('用法: node scripts/soak.mjs --minutes <N> [--report-dir <dir>]')
      console.log('  --minutes N   压测时长（分钟），4 小时级挂机用 240')
      console.log('  --report-dir  报告目录（metrics.csv + report.md），默认 os.tmpdir() 下新建')
      console.log('  退出码: 0 = PASS；非 0 = FAIL')
      process.exit(0)
    } else fail(`未知参数: ${argv[i]}（支持 --minutes <N> / --report-dir <dir>）`)
  }
  if (!Number.isFinite(minutes) || minutes <= 0) fail('--minutes 必须是正数（分钟）')
  return { minutes, reportDir }
}

/** 读网关 /health 的 reloads 计数（配置热加载核实用）；不可读返回 null。 */
async function healthReloads(port) {
  const r = await probe('/_modeldock/health', port)
  if (!r || r.status !== 200) return null
  try {
    const n = Number(JSON.parse(r.body).reloads)
    return Number.isInteger(n) && n >= 0 ? n : null
  } catch {
    return null
  }
}

/** 主流程：返回结论（true=PASS）。任何失败抛错，finally 统一清理并核实端口。 */
async function main() {
  const { minutes, reportDir } = parseArgs()
  const reportPath = reportDir ?? path.join(os.tmpdir(), 'modeldock-soak-' + Date.now().toString(36))
  fs.mkdirSync(reportPath, { recursive: true })
  ctx.fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldock-soak-home-'))
  const logsDir = path.join(ctx.fakeHome, '.modeldock', 'logs')
  const csvPath = path.join(reportPath, 'metrics.csv')
  ctx.reportMd = path.join(reportPath, 'report.md')
  console.log(`[soak] 报告目录: ${reportPath}；沙箱: ${ctx.fakeHome}`)

  // mock 上游（先起，provider.base_url 指向它）
  const usedPorts = new Set()
  ctx.mockPort = await pickFreePort(usedPorts)
  usedPorts.add(ctx.mockPort)
  ctx.mock = createMockUpstream()
  await new Promise((resolve, reject) => {
    ctx.mock.once('error', reject)
    ctx.mock.listen(ctx.mockPort, '127.0.0.1', resolve)
  })
  console.log(`[soak] mock 上游就绪: 127.0.0.1:${ctx.mockPort}`)

  // seed（tsx 子进程调 src/config 的 mutateConfig/setSecret）。脚本写进沙箱目录（含沙箱凭据，
  // 随沙箱一并删除，不进可归档的报告目录）
  const token = 'soak_' + crypto.randomBytes(16).toString('hex')
  const seedScript = path.join(ctx.fakeHome, 'soak-seed.mjs')
  fs.writeFileSync(seedScript, seedSource(ctx.mockPort, token), 'utf8')
  const seed = runTsxChild(seedScript, ctx.fakeHome)
  if (seed.status !== 0) {
    fail(`seed 失败（exit ${seed.status}）：${(seed.stderr || seed.stdout || '').trim().slice(0, 800)}`)
  }
  if (ctx.aborted) fail('用户中断')

  // 网关子进程（tsx 直跑 src/cli.ts；前台子进程即网关本体，pid 直接采样 RSS）。
  // 候选端口与 mock 同款 tryListen 预检；就绪后按 gateway.json 校验 pid 归属 + 端口白名单
  // （listenWithRetry 可能顺延，越界即失败，绝不让流量/清理落在 18910-18919 之外）。
  const loader = tsxLoaderHref()
  const cliEntry = path.join(ROOT, 'src', 'cli.ts')
  let stderrTail = ''
  for (let p = PORT_MIN; p <= PORT_MAX && !ctx.child; p++) {
    if (usedPorts.has(p)) continue
    assertPortSafe(p)
    if (!(await tryListen(p))) continue
    fs.rmSync(path.join(ctx.fakeHome, '.modeldock', 'gateway.json'), { force: true }) // 防陈旧状态串扰
    const c = spawn(process.execPath, ['--import', loader, cliEntry, 'gateway', 'start', '--port', String(p)], {
      cwd: ROOT,
      env: childEnv(ctx.fakeHome),
      stdio: ['ignore', 'ignore', 'pipe'],
      detached: process.platform !== 'win32',
    })
    let spawnErr = null
    c.on('error', (e) => {
      spawnErr = e
    })
    c.stderr.setEncoding('utf8')
    c.stderr.on('data', (chunk) => {
      stderrTail = (stderrTail + chunk).slice(-2000)
    })
    const healthy = await waitFor(async () => {
      if (spawnErr || ctx.aborted || c.exitCode !== null || c.signalCode !== null) return 'exited'
      const r = await probe('/_modeldock/health', p)
      return r?.status === 200 ? 'ready' : null
    }, START_TIMEOUT_MS, `gateway :${p}`)
    if (healthy === 'ready') {
      // 验明正身：gateway.json 必须是本子进程刚写的（pid 一致），实际端口仍在白名单内
      const st = await waitFor(() => {
        try {
          return JSON.parse(fs.readFileSync(path.join(ctx.fakeHome, '.modeldock', 'gateway.json'), 'utf8'))
        } catch {
          return null
        }
      }, 10_000, 'gateway.json')
      if (st && Number(st.pid) === c.pid && st.admin_token && st.port) {
        assertPortSafe(Number(st.port))
        ctx.child = c
        ctx.gport = Number(st.port)
        break
      }
      killTree(c)
      await sleep(200)
    } else {
      killTree(c)
      await sleep(200)
    }
    if (ctx.aborted) break
  }
  if (!ctx.child) {
    if (ctx.aborted) fail('用户中断')
    fail(`18910-18919 段未能拉起沙箱网关（FAKE_HOME=${ctx.fakeHome}）。stderr 尾部：\n${stderrTail || '（无）'}`)
  }
  const adminToken = await (async () => {
    const st = JSON.parse(fs.readFileSync(path.join(ctx.fakeHome, '.modeldock', 'gateway.json'), 'utf8'))
    return st.admin_token
  })()
  console.log(`[soak] 网关已就绪: 127.0.0.1:${ctx.gport} (pid ${ctx.child.pid})`)

  // 流量 + 采样
  ctx.agent = new http.Agent({ keepAlive: true, maxSockets: WORKERS + 2 })
  const stop = { done: false } // 正常收尾时置位；ctx.aborted 是用户中断
  const stats = { sent: 0, ok: 0, httpErr: 0, transportErr: 0 }
  const workerPs = Array.from({ length: WORKERS }, () => worker(ctx.gport, token, stats, stop))
  const logState = { files: new Map(), hist: new Map(), totalLines: 0, totalErrors: 0 }
  const samples = []
  let pollOk = 0
  let pollFail = 0
  let reloadOk = 0
  let reloadFail = 0
  const reloadScript = path.join(ctx.fakeHome, 'soak-reload.mjs')
  fs.writeFileSync(reloadScript, reloadSource(), 'utf8')

  fs.writeFileSync(csvPath, 'ts,rss_mb,log_lines,log_errors,sent,transport_errors\n', 'utf8')
  const sampleOnce = (note) => {
    const s = jsonlStats(logsDir, logState)
    const rss = rssMb(ctx.child.pid)
    const rec = { note: note ?? '', rss, lines: s.totalLines, errors: s.totalErrors, sent: stats.sent, transportErr: stats.transportErr }
    samples.push(rec)
    fs.appendFileSync(csvPath, `${new Date().toISOString()},${rss ?? ''},${s.totalLines},${s.totalErrors},${stats.sent},${stats.transportErr}\n`, 'utf8')
    console.log(`[soak] ${note ?? '采样'} rss=${rss ?? '?'}MB log_lines=${s.totalLines} log_errors=${s.totalErrors} sent=${stats.sent} transport_err=${stats.transportErr}`)
    return rec
  }

  // 配置 reload 调度：每 5min 一次（按时间而不是 tick 计数——minutes=5 整点也能触发一次）；
  // 生效性经 /health 的 reloads 计数核实（watcher 失效时报告如实记失败，不只信子进程退出码）
  let prevReloads = await healthReloads(ctx.gport)
  let reloadFired = 0
  const doReload = async () => {
    const before = prevReloads
    const rl = runTsxChild(reloadScript, ctx.fakeHome)
    reloadFired++
    if (rl.status !== 0) {
      reloadFail++
      console.log(`[soak] ⚠ 配置 reload 子进程失败（exit ${rl.status}）：${(rl.stderr || rl.stdout || '').trim().slice(0,400)}`)
      return
    }
    const bumped = await waitFor(async () => {
      const n = await healthReloads(ctx.gport)
      return n !== null && before !== null && n > before
    }, 8000, '配置热加载生效（reloads 递增）')
    if (bumped) {
      reloadOk++
      prevReloads = await healthReloads(ctx.gport)
      console.log(`[soak] 配置 reload 已生效（reloads=${prevReloads}）`)
    } else {
      reloadFail++
      console.log(`[soak] ⚠ 配置 reload 未核实生效（reloads 未递增）`)
    }
  }
  const reloadDue = () => Date.now() - startedAt >= reloadFired * RELOAD_MS + RELOAD_MS

  const startedAt = Date.now()
  const deadline = startedAt + minutes * 60_000
  console.log(`[soak] 流量启动: ${WORKERS} 路并发（90% /v1/messages 流式/非流式混合 + 10% /v1/models），每 30s 采样 + admin 轮询，每 5min 配置 reload`)
  // 基线前落定 5s：启动一次性分配（模块装载/warmup 尾部）与首批流量不混进增幅判定，
  // 否则 2 分钟自检会被启动分配干扰、4 小时挂机反而无感——增幅口径应是稳态后的增长
  await sleep(5000)
  sampleOnce('首值')

  while (Date.now() < deadline && !ctx.aborted) {
    await sleep(Math.min(SAMPLE_MS, deadline - Date.now()))
    if (Date.now() >= deadline || ctx.aborted) break
    // admin overview 轮询（控制台同款端点；x-modeldock-admin 头鉴权）
    const ov = await sendRequest(ctx.agent, ctx.gport, '/_modeldock/overview', { method: 'GET', admin: adminToken, timeoutMs: 15_000 })
    if (ov.status === 200) pollOk++
    else pollFail++
    if (reloadDue()) await doReload()
    sampleOnce(`t+${Math.round((Date.now() - startedAt) / 1000)}s`)
    if (ctx.child.exitCode !== null || ctx.child.signalCode !== null) {
      console.log(`[soak] ⚠ 网关进程中途退出（exit ${ctx.child.exitCode ?? ctx.child.signalCode}），提前收尾`)
      break
    }
  }
  // 收尾：5min 整点场景补一次 reload（如 minutes=5），不打扰已提前退出的网关
  if (!ctx.aborted && ctx.child.exitCode === null && ctx.child.signalCode === null && reloadDue()) {
    await doReload()
  }

  // 停流量 → 等网关日志空闲刷盘（appendIdleSweep 3s 空闲关流 + 1s 周期，留 5s 余量）→ 最终采样
  stop.done = true
  await Promise.all(workerPs)
  await sleep(LOG_IDLE_FLUSH_MS)
  jsonlStats(logsDir, logState, { final: true }) // 先结算半行，CSV 末行与报告总数一致
  sampleOnce('结束')

  // ===== 报告 =====
  const interrupted = ctx.aborted
  const gatewayDied = ctx.child.exitCode !== null || ctx.child.signalCode !== null
  const rssVals = samples.map((s) => s.rss).filter((v) => v !== null)
  const rssFirst = rssVals[0] ?? null
  const rssPeak = rssVals.length ? Math.max(...rssVals) : null
  const rssLast = rssVals[rssVals.length - 1] ?? null
  // 增幅口径：末值相对首值（长稳泄漏观测）；峰值相对首值一并报告，不参与判定
  const rssGrowthRaw = rssFirst ? (rssLast - rssFirst) / rssFirst : null
  const rssPeakRaw = rssFirst ? (rssPeak - rssFirst) / rssFirst : null
  const totalReq = logState.totalLines
  const totalErr = logState.totalErrors + stats.transportErr
  const errRateRaw = totalReq + stats.transportErr > 0 ? totalErr / (totalReq + stats.transportErr) : null
  const pct = (x) => (x === null ? '?' : Math.round(x * 1000) / 10 + '%')

  const reasons = []
  if (interrupted) reasons.push('运行被中断')
  if (gatewayDied) reasons.push('网关进程中途退出')
  if (rssGrowthRaw === null || rssGrowthRaw >= 0.2) reasons.push(`RSS 增幅 ${pct(rssGrowthRaw)}（阈值 <20%）`)
  if (errRateRaw === null || errRateRaw >= 0.005) reasons.push(`错误率 ${pct(errRateRaw)}（阈值 <0.5%）`)
  if (totalReq === 0) reasons.push('请求日志为零（流量未生效）')
  if (pollOk === 0 && pollFail > 0) reasons.push(`admin overview 轮询全部失败（${pollFail} 次）`)
  if (reloadFail > 0) reasons.push(`配置 reload 失败 ${reloadFail} 次`)
  const pass = reasons.length === 0
  const conclusion = pass
    ? `结论: PASS（RSS 增幅 ${pct(rssGrowthRaw)} < 20%；错误率 ${pct(errRateRaw)} < 0.5%）`
    : `结论: FAIL（${reasons.join('；')}）`

  const histLines = logState.hist.size
    ? [...logState.hist.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([k, n]) => `  - ${k}: ${n}`)
        .join('\n')
    : '  - 无'
  const durSec = Math.round((Date.now() - startedAt) / 1000)
  const logFiles = (() => {
    const out = []
    try {
      for (const name of fs.readdirSync(logsDir).sort()) {
        if (/^gateway-.*\.jsonl$/.test(name)) out.push(`${name}: ${fs.statSync(path.join(logsDir, name)).size} B`)
      }
    } catch {
      /* 日志目录已不可读 */
    }
    return out
  })()
  const totalBytes = logFiles.reduce((n, l) => n + Number(l.split(': ')[1].replace(' B', '')), 0)
  const avgLineB = totalReq > 0 ? Math.round(totalBytes / totalReq) : 0

  fs.writeFileSync(
    ctx.reportMd,
    [
      '# ModelDock 常驻网关压测报告（soak）',
      '',
      `- 运行时长: ${Math.floor(durSec / 60)} 分 ${durSec % 60} 秒（计划 ${minutes} 分钟）`,
      `- 端口: 网关 127.0.0.1:${ctx.gport} / mock 上游 127.0.0.1:${ctx.mockPort}（18910-18919 沙箱段，未触碰 8687 生产 / 8890 用户 dev）`,
      `- 沙箱: ${ctx.fakeHome}（临时 FAKE_HOME，运行结束后清理删除；清理结果见末尾行）`,
      `- 流量: ${WORKERS} 路并发，90% POST /v1/messages（50% SSE 流式）+ 10% GET /v1/models；每 30s admin overview 轮询；每 5min 配置 reload（翻转 gateway.retries 触发热加载，按 /health 的 reloads 计数核实）`,
      `- 总请求数: ${totalReq}（网关请求日志 JSONL 行数；/v1/models 本地合成不入日志。客户端合计发出 ${stats.sent}，其中客户端观测 4xx/5xx ${stats.httpErr}、传输失败 ${stats.transportErr}）`,
      `- 非 2xx 计数与分类（JSONL 状态字段；status 缺失=流中断类异常）:`,
      histLines,
      `- RSS 采样（MB，${samples.length} 个采样，30s 间隔）: 首值 ${rssFirst ?? '?'} / 峰值 ${rssPeak ?? '?'} / 末值 ${rssLast ?? '?'}；增幅（末值-首值）/首值 = ${pct(rssGrowthRaw)}（峰值相对首值 ${pct(rssPeakRaw)}，仅展示不参与判定；首值=流量启动 5s 后的基线采样）`,
      `- JSONL 日志增长摘要: 共 ${totalBytes} B（${totalReq} 行，平均 ${avgLineB} B/行；沙箱新建，总量即增长）；明细:`,
      ...logFiles.map((l) => `  - ${l}`),
      `- admin overview 轮询: 成功 ${pollOk} / 失败 ${pollFail}；配置 reload: 成功 ${reloadOk} / 失败 ${reloadFail}`,
      `- 错误率口径: (JSONL 非 2xx + 客户端传输失败) / (JSONL 总行数 + 客户端传输失败) = ${pct(errRateRaw)}`,
      `- 采样明细: ${csvPath}`,
      '',
      conclusion,
      '',
    ].join('\n'),
    'utf8'
  )
  console.log(`[soak] ${conclusion}（报告: ${ctx.reportMd}）`)
  return pass
}

/** 清理与端口核实（finally：任何失败路径都走这里，绝不留孤儿进程/端口/沙箱）。
 *  端口核实用 tryListen 确定性探测（能 bind = 无监听者，挂死不响应的进程也逃不掉）。
 *  返回端口核实结果（true=全部释放）。 */
async function cleanup() {
  try {
    ctx.agent?.destroy()
  } catch {
    /* 忽略 */
  }
  if (ctx.child) {
    killTree(ctx.child)
    await sleep(400)
    // 未退出再补一刀（unix SIGKILL 兜底；win taskkill 已是强制）
    if (ctx.child.exitCode === null && ctx.child.signalCode === null) {
      if (process.platform !== 'win32') {
        try {
          process.kill(-ctx.child.pid, 'SIGKILL')
        } catch {
          /* 已退出 */
        }
      }
      await sleep(300)
    }
  }
  if (ctx.mock) {
    try {
      ctx.mock.closeAllConnections?.()
      await Promise.race([new Promise((r) => ctx.mock.close(() => r())), sleep(2000)])
    } catch {
      /* 忽略 */
    }
  }
  // 沙箱删除（重试一次：Windows 句柄未放完时 EBUSY/EPERM）
  let sandboxRemoved = true
  if (ctx.fakeHome) {
    try {
      fs.rmSync(ctx.fakeHome, { recursive: true, force: true })
    } catch {
      await sleep(1000)
      try {
        fs.rmSync(ctx.fakeHome, { recursive: true, force: true })
      } catch {
        sandboxRemoved = false
        console.error(`[soak] ⚠ 沙箱目录未能删除（可手动清理）：${ctx.fakeHome}`)
      }
    }
  }
  // 核实端口已释放（网关 + mock 两个监听点，一个都不能残留）
  const gwReleased = ctx.gport ? await tryListen(ctx.gport) : true
  const mkReleased = ctx.mockPort ? await tryListen(ctx.mockPort) : true
  const portsOk = gwReleased && mkReleased
  if (!portsOk) {
    console.error(
      `[soak] ⚠ 端口核实未通过：网关 ${gwReleased ? `${ctx.gport} 已释放` : `${ctx.gport} 仍有监听`} / mock ${mkReleased ? `${ctx.mockPort} 已释放` : `${ctx.mockPort} 仍有监听`}——请核查残留进程`
    )
  } else {
    console.log(`[soak] 清理完成：网关/mock 已退出，端口 ${ctx.gport}/${ctx.mockPort} 已释放，沙箱已${sandboxRemoved ? '' : '未'}删除`)
  }
  // 清理结果补进报告（报告主体写于清理前，删除/释放结论以本行为准）
  if (ctx.reportMd) {
    try {
      fs.appendFileSync(ctx.reportMd, `\n- 清理核实: 端口释放 ${portsOk ? '通过' : '未通过'}；沙箱删除 ${sandboxRemoved ? '成功' : '失败'}\n`, 'utf8')
    } catch {
      /* 报告目录不可写则忽略 */
    }
  }
  return portsOk && sandboxRemoved
}

let pass = false
try {
  pass = await main()
} catch (e) {
  console.error(`[soak] FAIL: ${e?.message ?? e}`)
} finally {
  const clean = await cleanup()
  if (pass && !clean) pass = false // 端口未释放/沙箱未删除视同 FAIL
}
process.exit(pass ? 0 : 1)
