#!/usr/bin/env node
// bench-relay.mjs — 转发热路径黑盒基准（四场景，可复跑，产出 before/after 对比基线）。
//
// 隔离配方（AGENTS.md「端口与实例约定」硬规则 2）：MODELRDOCK_FAKE_HOME=<系统临时目录>
// + 18910-18919 端口成对指定——绝不触碰 8687（生产）/ 8890（用户 dev 沙箱），端口白名单硬校验。
// 流程：占一个白名单端口起 mock 上游（同进程 http server）→ 种子脚本（tsx 直跑 src 模块，
// mutateConfig + setSecret）在沙箱写 config.toml/secrets.json → 起网关（前台子进程，tsx 直跑 src）
// → 健康端点就绪 → 四场景压测 → 统计输出 → 杀进程树 / 关上游 / 删沙箱 → 核实端口释放。
// 任何失败 exit 1。
//
// 黑盒纪律：测量全部走网关对外端口（127.0.0.1），不对 src/** 加任何插桩；mock 上游的
// 「收到即验证」（改写是否发生）是压测脚本自身的断言，不进入网关。
//
// 用法：
//   node scripts/bench-relay.mjs           默认模式：30/30/20/100 样本，全程 <5min
//   node scripts/bench-relay.mjs --quick   快跑：10/10/8/40 样本，全程 <2min
//
// 平台兼容：路径一律 path.join；Windows 用 taskkill /T /F 杀树，unix 用进程组信号；
// 临时目录 os.tmpdir()（不写死 /tmp）。

import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT_MIN = 18910;
const PORT_MAX = 18919;
const START_TIMEOUT_MS = 45_000;
const POLL_INTERVAL_MS = 300;
const TOKEN = 'mdk_bench_harness_token_0001';

// mock 上游响应形状（客户端断言与 SSE 构造共用，避免两处漂移）
const JSON_OK_BYTES = Buffer.byteLength('{"ok":true}');
const SSE_CHUNK_BYTES = 8192; // data 行 + \n\n，整块固定 8KB
const SSE_CHUNK_DATA = `data: ${'x'.repeat(SSE_CHUNK_BYTES - 'data: '.length - 2)}\n\n`;
const SSE_CHUNK_COUNT = 128; // 128 × 8KB = 1MB（验收要求流式内容 ≥1MB）
const SSE_DONE = 'data: [DONE]\n\n';
const SSE_TOTAL_BYTES = SSE_CHUNK_BYTES * SSE_CHUNK_COUNT + Buffer.byteLength(SSE_DONE);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 失败统一抛错：由最外层 catch 记 FAIL、finally 保证清理后退出。
// （不能用 process.exit 直接失败——会跳过 finally，泄漏网关进程与沙箱目录，实测踩中。）
function fail(msg) {
  throw new Error(msg);
}

function assertPortSafe(p) {
  if (!Number.isInteger(p) || p < PORT_MIN || p > PORT_MAX) {
    fail(`端口 ${p} 超出沙箱白名单 ${PORT_MIN}-${PORT_MAX}（8687 生产 / 8890 用户 dev 绝对禁止）`);
  }
}

function tsxLoaderHref() {
  try {
    const require = createRequire(path.join(ROOT, 'package.json'));
    return pathToFileURL(require.resolve('tsx/esm')).href;
  } catch (e) {
    return fail(`无法解析 tsx/esm loader（先 npm install）：${e.message}`);
  }
}

/** 探测 http 状态（上限 5MB）；连接失败返回 null。 */
function probe(urlPath, port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: urlPath, timeout: 4000 }, (res) => {
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
      });
      res.on('end', () => resolve({ status: res.statusCode, size }));
      res.on('error', () => resolve(null));
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.on('error', () => resolve(null));
  });
}

function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  try {
    process.kill(-child.pid, 'SIGTERM'); // detached 独立进程组，整组终止
  } catch {
    /* 已退出 */
  }
}

async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) return null;
    await sleep(POLL_INTERVAL_MS);
  }
}

/** 在白名单段内找一个空闲端口（exclude 必跳过）。先占后放：与后续 spawn 之间存在毫秒级
 *  竞态，但网关 listenWithRetry 被占会顺延到 +1，启动后仍以 gateway.json 实际端口复核范围。 */
async function findFreePort(exclude) {
  for (let p = PORT_MIN; p <= PORT_MAX; p++) {
    assertPortSafe(p);
    if (exclude.has(p)) continue;
    const free = await new Promise((resolve) => {
      const s = net.createServer();
      s.once('error', () => resolve(false));
      s.listen(p, '127.0.0.1', () => s.close(() => resolve(true)));
    });
    if (free) return p;
  }
  return null;
}

/** mock 上游：按当前场景断言收到的请求（改写是否发生/模型名完好），并回对应形状的响应。
 *  violations 记录断言失败条数（按场景归零重计）；sse 场景按块推流 1MB。
 *  端口必须落在 18910-18919 白名单段（端口红线：所有监听只允许这一段，mock 上游也不例外）。 */
function startMockUpstream(port) {
  assertPortSafe(port);
  const state = { scenario: null, violations: {} };
  const bump = (label) => {
    state.violations[state.scenario] = (state.violations[state.scenario] ?? 0) + 1;
    console.error(`[bench] ⚠ mock 断言失败（场景 ${state.scenario}）：${label}`);
  };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const s = state.scenario ?? '';
      if (s === 's1') {
        // 客户端未带 model 字段：网关 default_model 兜底必须注入 preset-model
        if (!body.includes('"model":"preset-model"')) bump('default_model 改写未发生（收到体里没有 model 字段）');
      } else if (s === 's2') {
        // 模型名已是目标：必须原样在首键位置（浅扫描快路径不重序列化）
        if (!body.startsWith('{"model":"preset-model"')) bump('透传请求体 model 字段不在首键/被改动');
      } else if (s === 's4') {
        if (!body.includes('"model":"preset-model"')) bump('小请求 model 字段丢失');
      }
      if (s === 's3') {
        if (!body.includes('"stream":true')) bump('流式请求缺 stream:true');
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        res.flushHeaders();
        let sent = 0;
        const timer = setInterval(() => {
          if (sent >= SSE_CHUNK_COUNT) {
            clearInterval(timer);
            res.end(SSE_DONE);
            return;
          }
          res.write(SSE_CHUNK_DATA);
          sent++;
        }, 1); // ~1ms 一块：模拟上游分块推流节奏，1MB ≈ 128ms，样本时长可控
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve({ server, state, port }));
  });
}

// ---- 统计 ----

/** 有序样本的最近秩分位数 */
function quantile(sorted, q) {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
}

function summarize(ms) {
  const n = ms.length;
  const sorted = [...ms].sort((a, b) => a - b);
  const mean = ms.reduce((a, b) => a + b, 0) / n;
  const r1 = (v) => (Math.round(v * 10) / 10).toFixed(1);
  return {
    n,
    mean: r1(mean),
    p50: r1(quantile(sorted, 0.5)),
    p95: r1(quantile(sorted, 0.95)),
    p99: r1(quantile(sorted, 0.99)),
    min: r1(sorted[0]),
    max: r1(sorted[n - 1]),
  };
}

// ---- 场景与请求 ----

/** 发起一次经网关的转发请求，测全链路：写请求 → 收完响应体。返回耗时与响应形态。 */
function benchRequest(agent, port, body) {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/v1/messages',
        method: 'POST',
        headers: {
          authorization: `Bearer ${TOKEN}`,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        },
        agent,
      },
      (res) => {
        let bytes = 0;
        let firstByteMs = null;
        res.on('data', (c) => {
          if (firstByteMs === null) firstByteMs = performance.now() - t0;
          bytes += c.length;
        });
        res.on('end', () => resolve({ status: res.statusCode, bytes, firstByteMs, ms: performance.now() - t0 }));
        res.on('error', reject);
      }
    );
    req.on('timeout', () => {
      req.destroy(new Error('请求超时（120s 未收完响应）'));
    });
    req.on('error', reject);
    req.setTimeout(120_000);
    req.end(body);
  });
}

const PAD_5MB = 'x'.repeat(5 * 1024 * 1024);
const PAD_1KB = 'x'.repeat(1024);

/** 场景定义：请求体构造 + 样本/预热数 + mock 侧预期。默认与 --quick 两档样本数。 */
function scenarios(quick) {
  return [
    {
      id: 's1',
      name: '大请求体 default_model 改写（5MB，POST /v1/messages）',
      note: '请求体不含 model 字段 → 网关注入 default_model：JSON.parse + 整包重序列化',
      buildBody: () => `{"messages":[{"role":"user","content":"${PAD_5MB}"}],"max_tokens":1024}`,
      expectBytes: JSON_OK_BYTES,
      warmups: quick ? 1 : 3,
      samples: quick ? 10 : 30,
    },
    {
      id: 's2',
      name: '大请求体纯透传快路径（5MB，无模型改写）',
      note: 'model 已是目标模型且在首键：浅扫描即止，不 parse 不重序列化',
      buildBody: () => `{"model":"preset-model","messages":[{"role":"user","content":"${PAD_5MB}"}],"max_tokens":1024}`,
      expectBytes: JSON_OK_BYTES,
      warmups: quick ? 1 : 3,
      samples: quick ? 10 : 30,
    },
    {
      id: 's3',
      name: 'SSE 流式转发（mock 上游分块推流 1MB）',
      note: '128 × 8KB 块（~1ms/块）：测端到端吞吐与首字节延迟',
      buildBody: () => '{"model":"preset-model","stream":true,"messages":[{"role":"user","content":"stream bench"}],"max_tokens":4096}',
      expectBytes: SSE_TOTAL_BYTES,
      warmups: quick ? 1 : 2,
      samples: quick ? 8 : 20,
    },
    {
      id: 's4',
      name: '小请求基准（1KB，鉴权 + 转发）',
      note: '鉴权解析 + 转发的最小开销下限',
      buildBody: () => `{"model":"preset-model","messages":[{"role":"user","content":"${PAD_1KB}"}],"max_tokens":16}`,
      expectBytes: JSON_OK_BYTES,
      warmups: quick ? 3 : 10,
      samples: quick ? 40 : 100,
    },
  ];
}

/** 跑一个场景：预热（不计样本）→ 逐请求采样。返回统计（sse 附首字节与吞吐）。 */
async function runScenario(agent, port, mock, sc) {
  mock.state.scenario = sc.id;
  mock.state.violations[sc.id] = 0;
  const body = sc.buildBody();

  // 预热：建立连接 + 网关/上游冷缓存热身，不计样本
  for (let i = 0; i < sc.warmups; i++) {
    const r = await benchRequest(agent, port, body);
    if (r.status !== 200 || r.bytes !== sc.expectBytes) {
      fail(`场景 ${sc.id} 预热请求异常：status=${r.status} bytes=${r.bytes}（预期 200/${sc.expectBytes}）`);
    }
  }

  const lat = [];
  const fb = [];
  const mbps = [];
  let bad = 0;
  const t0 = performance.now();
  for (let i = 0; i < sc.samples; i++) {
    const r = await benchRequest(agent, port, body);
    if (r.status !== 200 || r.bytes !== sc.expectBytes) {
      bad++;
      console.error(`[bench] 场景 ${sc.id} 样本 ${i} 异常：status=${r.status} bytes=${r.bytes}`);
      continue;
    }
    lat.push(r.ms);
    if (sc.id === 's3') {
      fb.push(r.firstByteMs);
      mbps.push(r.bytes / (r.ms / 1000) / 1e6);
    }
  }
  const elapsedMs = performance.now() - t0;
  if (bad > 0) fail(`场景 ${sc.id} 有 ${bad} 个异常样本，数字不可信，中止`);
  if ((mock.state.violations[sc.id] ?? 0) > 0) {
    fail(`场景 ${sc.id} mock 断言失败 ${mock.state.violations[sc.id]} 次：压测打的不是目标路径，中止`);
  }
  const out = {
    id: sc.id,
    name: sc.name,
    note: sc.note,
    lat: summarize(lat),
    rps: (lat.length / (elapsedMs / 1000)).toFixed(1),
  };
  if (sc.id === 's3') {
    out.firstByte = summarize(fb);
    out.throughputMBps = {
      mean: (mbps.reduce((a, b) => a + b, 0) / mbps.length).toFixed(1),
      p50: quantile([...mbps].sort((a, b) => a - b), 0.5).toFixed(1),
    };
  }
  return out;
}

// ---- 种子脚本（沙箱内造服务/路由/密钥）----
// AGENTS.md 硬规则 2 推荐配方：脚本内先设 MODELRDOCK_FAKE_HOME 再动态 import 源码模块，
// mutateConfig() + setSecret(id, key, 'file') 造 provider/profile/harness。写入的只是
// 临时沙箱自己的 config.toml/secrets.json，与真实 ~/.modeldock 零接触。

const SEED_SCRIPT = `
import { pathToFileURL } from 'node:url'
process.env.MODELRDOCK_FAKE_HOME = process.env.MDK_BENCH_FAKE_HOME
const upPort = process.env.MDK_BENCH_UP_PORT
const token = process.env.MDK_BENCH_TOKEN
const { mutateConfig } = await import(pathToFileURL(process.env.MDK_BENCH_STORE_TS).href)
const { setSecret } = await import(pathToFileURL(process.env.MDK_BENCH_SECRETS_TS).href)
const keyRef = await setSecret('bench-up', 'sk-bench-mock-key', 'file')
await mutateConfig((c) => {
  c.active_profile = 'bench'
  c.security = { store: 'file' } // 沙箱密钥一律本地 file 存储
  c.providers = {
    'bench-up': {
      name: 'bench-mock',
      base_url: 'http://127.0.0.1:' + upPort,
      protocol: 'anthropic',
      auth_style: 'bearer',
      key_ref: keyRef,
      models: { 'preset-model': { source: 'manual', context_window: 200000, max_output: 8192 } },
    },
  }
  c.profiles = { bench: { provider: 'bench-up', default_model: 'preset-model' } }
  c.harness = { bench: { mode: 'gateway', route: 'default', token } }
})
console.log('[bench-seed] 沙箱配置就绪：provider=bench-up profile=bench harness=bench')
`;

function runSeed(fakeHome, upPort) {
  const seedFile = path.join(fakeHome, 'bench-seed.mjs');
  fs.writeFileSync(seedFile, SEED_SCRIPT, 'utf8');
  const r = spawnSync(process.execPath, ['--import', tsxLoaderHref(), seedFile], {
    cwd: ROOT,
    env: {
      ...process.env,
      MODELRDOCK_FAKE_HOME: fakeHome,
      MDK_BENCH_FAKE_HOME: fakeHome,
      MDK_BENCH_UP_PORT: String(upPort),
      MDK_BENCH_TOKEN: TOKEN,
      MDK_BENCH_STORE_TS: path.join(ROOT, 'src', 'config', 'store.ts'),
      MDK_BENCH_SECRETS_TS: path.join(ROOT, 'src', 'config', 'secrets.ts'),
    },
    encoding: 'utf8',
    timeout: 60_000,
  });
  if (r.status !== 0) {
    fail(`种子脚本失败（exit ${r.status}）：\n${r.stdout ?? ''}\n${r.stderr ?? ''}`);
  }
}

// ---- 主流程 ----

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldock-bench-'));
const stateFile = path.join(fakeHome, '.modeldock', 'gateway.json');
let child = null;
let mock = null;
let agent = null;
let gatewayPort = 0; // gateway.json 实际监听端口（listenWithRetry 可能顺延；清理核实也用它）
let stderrTail = '';
let exitCode = 0;

const startedAt = Date.now();
const quick = process.argv.includes('--quick');

try {
  const loader = tsxLoaderHref();
  const cliEntry = path.join(ROOT, 'src', 'cli.ts');

  // 1. mock 上游先占白名单端口
  const upPort = await findFreePort(new Set());
  if (!upPort) fail(`18910-18919 段没有空闲端口可起 mock 上游`);
  mock = await startMockUpstream(upPort);
  console.log(`[bench] mock 上游就绪：127.0.0.1:${mock.port}`);

  // 2. 种子：沙箱写 config.toml + secrets.json（gateway start 之前）
  runSeed(fakeHome, mock.port);

  // 3. 网关：白名单内找空闲端口拉起
  const gwPort = await findFreePort(new Set([mock.port]));
  if (!gwPort) fail(`18910-18919 段没有空闲端口可起网关（mock 上游占用 ${mock.port}）`);
  child = spawn(
    process.execPath,
    ['--import', loader, cliEntry, 'gateway', 'start', '--port', String(gwPort)],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        MODELRDOCK_FAKE_HOME: fakeHome,
        MODELRDOCK_DISABLE_CATALOG_FETCH: '1', // 模型元数据目录出站拉取与本测无关，压测窗口内不引入网络噪声
      },
      stdio: ['ignore', 'ignore', 'pipe'],
      detached: process.platform !== 'win32',
    }
  );
  let spawnErr = null;
  child.on('error', (e) => {
    spawnErr = e;
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderrTail = (stderrTail + chunk).slice(-2000);
  });

  const ready = await waitFor(async () => {
    if (spawnErr || child.exitCode !== null || child.signalCode !== null) return 'exited';
    const r = await probe('/_modeldock/health', gwPort);
    return r?.status === 200 ? 'ready' : null;
  }, START_TIMEOUT_MS, `gateway :${gwPort}`);
  if (ready !== 'ready') {
    fail(`网关启动失败（--port ${gwPort}）。stderr 尾部：\n${stderrTail || '（无）'}`);
  }
  // 实际监听端口以 gateway.json 为准，且必须仍在白名单段（listenWithRetry 顺延不能越界）
  const state = await waitFor(() => {
    try {
      return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    } catch {
      return null;
    }
  }, 10_000, 'gateway.json');
  gatewayPort = Number(state?.port) || gwPort;
  assertPortSafe(gatewayPort);
  console.log(`[bench] 网关就绪：127.0.0.1:${gatewayPort}（FAKE_HOME=${fakeHome}）`);

  // 4. 四场景（预热不计样本）
  agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  const scs = scenarios(quick);
  const results = [];
  console.log(`\n[bench] 场景采样开始（${quick ? '--quick 快跑' : '默认'}，预热不计样本）\n`);
  for (const sc of scs) {
    const r = await runScenario(agent, gatewayPort, mock, sc);
    results.push(r);
    const l = r.lat;
    console.log(
      `  ${r.name}\n    n=${l.n}  mean=${l.mean}ms  p50=${l.p50}ms  p95=${l.p95}ms  p99=${l.p99}ms  (min=${l.min} max=${l.max})  rps=${r.rps}`
    );
    if (r.firstByte) {
      const f = r.firstByte;
      console.log(
        `    首字节: mean=${f.mean}ms  p50=${f.p50}ms  p95=${f.p95}ms  p99=${f.p99}ms  吞吐: mean=${r.throughputMBps.mean} MB/s  p50=${r.throughputMBps.p50} MB/s`
      );
    }
  }

  // 5. 汇总（含可直接贴进 docs/bench-baseline.md 的表格与机器信息）
  const totalSec = ((Date.now() - startedAt) / 1000).toFixed(1);
  const env = {
    cpu: os.cpus()[0]?.model ?? 'unknown',
    platform: `${process.platform} ${os.release()}`,
    node: process.version,
    date: new Date().toISOString().slice(0, 10),
    mode: quick ? '--quick' : '默认',
    totalSec,
  };
  console.log(`\n[bench] 完成：总耗时 ${totalSec}s（模式 ${env.mode}，含起停）\n`);
  console.log('## 汇总（可直接入 docs/bench-baseline.md）');
  console.log(`- CPU: ${env.cpu}`);
  console.log(`- 系统: ${env.platform}`);
  console.log(`- Node: ${env.node}`);
  console.log(`- 日期: ${env.date}（模式 ${env.mode}）`);
  console.log('| 场景 | n | mean(ms) | p50(ms) | p95(ms) | p99(ms) | rps | 首字节 p50(ms) | 吞吐 p50(MB/s) |');
  console.log('|---|---|---|---|---|---|---|---|---|');
  for (const r of results) {
    const l = r.lat;
    const fb = r.firstByte?.p50 ?? '-';
    const tp = r.throughputMBps?.p50 ?? '-';
    console.log(`| ${r.name} | ${l.n} | ${l.mean} | ${l.p50} | ${l.p95} | ${l.p99} | ${r.rps} | ${fb} | ${tp} |`);
  }
} catch (e) {
  console.error(`[bench] FAIL: ${e?.message ?? e}`);
  exitCode = 1;
} finally {
  killTree(child);
  if (agent) agent.destroy();
  if (mock) {
    // keep-alive 连接不随 close() 退出，主动踢掉让句柄即刻收敛
    mock.server.closeAllConnections?.();
    mock.server.close();
  }
  await sleep(500); // 给句柄释放留时间（Windows rename/unlink 对打开句柄敏感）
  // 删沙箱（重试一次：Windows 上句柄未放完时 EBUSY/EPERM）
  try {
    fs.rmSync(fakeHome, { recursive: true, force: true });
  } catch {
    await sleep(1000);
    try {
      fs.rmSync(fakeHome, { recursive: true, force: true });
    } catch {
      console.error(`[bench] ⚠ 沙箱目录未能删除（可手动清理）：${fakeHome}`);
    }
  }
  // 核实端口已释放（尽力而为；失败不改变结果，但留提示）
  if (child) {
    const linger = await probe('/_modeldock/health', gatewayPort);
    if (linger) console.error(`[bench] ⚠ 端口 ${gatewayPort} 仍可连通——请核查进程清理（pid=${child.pid}）`);
  }
  if (mock) {
    const linger = await probe('/', mock.port);
    if (linger) console.error(`[bench] ⚠ mock 上游端口 ${mock.port} 仍可连通——请核查进程清理`);
  }
}
process.exit(exitCode);
