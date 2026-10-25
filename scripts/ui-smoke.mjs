#!/usr/bin/env node
// ui-smoke.mjs — orchestrator ui_check 门禁用 Web 控制台沙箱冒烟（worktree 内运行）。
//
// 隔离配方（AGENTS.md「端口与实例约定」硬规则 2）：MODELRDOCK_FAKE_HOME=<系统临时目录>
// + 189xx 端口成对指定——绝不触碰 8687（生产）/ 8890（用户 dev 沙箱），端口白名单硬校验。
// 流程：起网关（前台子进程，tsx 直跑 src）→ 健康端点就绪 → 读 gateway.json 拿 adminToken
// → 控制台页断言 → 杀进程树 → 删沙箱 → 核实端口释放。任何失败 exit 1（门禁进调试子循环）。
//
// 平台兼容：路径一律 path.join；Windows 用 taskkill /T /F 杀树，unix 用进程组信号；
// 临时目录 os.tmpdir()（不写死 /tmp）。

import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT_MIN = 18900;
const PORT_MAX = 18999;
const START_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 300;

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

/** 探测 http 状态与响应体（上限 5MB）；连接失败返回 null。opts.headers 附加请求头。 */
function probe(urlPath, port, opts = {}) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: urlPath, timeout: 4000, headers: opts.headers ?? {} }, (res) => {
      let body = '';
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size <= 5 * 1024 * 1024) body += c;
      });
      res.on('end', () => resolve({ status: res.statusCode, body, setCookie: res.headers['set-cookie'] ?? [] }));
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

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldock-uismoke-'));
const stateFile = path.join(fakeHome, '.modeldock', 'gateway.json');
let child = null;
let port = 0;
let gport = 0; // gateway.json 实际监听端口（listenWithRetry 可能顺延；finally 里核实清理也用它）
let stderrTail = '';
let exitCode = 0;

try {
  const loader = tsxLoaderHref();
  const cliEntry = path.join(ROOT, 'src', 'cli.ts');

  for (let p = PORT_MIN + 1; p <= PORT_MAX && !child; p++) {
    assertPortSafe(p);
    const c = spawn(
      process.execPath,
      ['--import', loader, cliEntry, 'gateway', 'start', '--port', String(p)],
      {
        cwd: ROOT,
        env: { ...process.env, MODELRDOCK_FAKE_HOME: fakeHome },
        stdio: ['ignore', 'ignore', 'pipe'],
        detached: process.platform !== 'win32',
      }
    );
    // spawn 级失败（ENOENT 等）没有 error 监听会以 unhandled error 崩掉整个脚本
    let spawnErr = null;
    c.on('error', (e) => {
      spawnErr = e;
    });
    c.stderr.setEncoding('utf8');
    c.stderr.on('data', (chunk) => {
      stderrTail = (stderrTail + chunk).slice(-2000);
    });

    // 就绪 = 健康端点 200；进程提前退出/spawn 失败 = 端口被占/启动失败，换下一个端口
    const healthy = await waitFor(async () => {
      if (spawnErr || c.exitCode !== null || c.signalCode !== null) return 'exited';
      const r = await probe('/_modeldock/health', p);
      return r?.status === 200 ? 'ready' : null;
    }, START_TIMEOUT_MS, `gateway :${p}`);

    if (healthy === 'ready') {
      child = c;
      port = p;
    } else {
      killTree(c);
      await sleep(200); // 端口释放缓冲
    }
  }

  if (!child) {
    fail(`189xx 端口段未能拉起沙箱网关（FAKE_HOME=${fakeHome}）。stderr 尾部：\n${stderrTail || '（无）'}`);
  }
  console.log(`[ui-smoke] 网关已就绪：127.0.0.1:${port}（FAKE_HOME=${fakeHome}）`);

  // adminToken + 实际监听端口（listenWithRetry 端口被占会顺延——后续探测一律以
  // gateway.json 的 port 为准，防止健康探活命中别的实例、页面打到空端口的错位）
  const state = await waitFor(() => {
    try {
      return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    } catch {
      return null;
    }
  }, 10_000, 'gateway.json');
  if (!state?.admin_token) fail(`gateway.json 缺 admin_token：${stateFile}`);
  gport = Number(state.port) || port;
  if (gport !== port) console.log(`[ui-smoke] 实际监听端口 ${gport}（请求端口 ${port} 被顺延）`);

  // 控制台页断言（三段，对齐真实登录流）：
  //   ?token= 命中 → 302 下发 admin/device cookie；带 cookie 的页面 → 200 + 稳定标记；
  //   受保护 API 带 cookie 200 / 无凭据非 200——鉴权数据链路真正打通
  //   （/_modeldock/ui 的静态壳在管理门之前、无凭据也 200，单靠它证不了鉴权）。
  const login = await probe(`/_modeldock/ui?token=${encodeURIComponent(state.admin_token)}`, gport);
  if (!login || login.status !== 302) fail(`token 登录跳转异常（${login?.status ?? '无响应'}，预期 302 下发 cookie）`);
  const cookie = login.setCookie.map((c) => c.split(';')[0]).join('; ');
  const page = await probe('/_modeldock/ui', gport, { headers: cookie ? { cookie } : {} });
  if (!page || page.status !== 200) fail(`控制台页 /_modeldock/ui 返回 ${page?.status ?? '无响应'}（预期 200）`);
  if (!page.body.includes('ModelDock')) fail('控制台页缺少 ModelDock 标题标记');
  if (!page.body.includes('data-i18n')) fail('控制台页缺少 data-i18n（双语机制）标记');
  const apiAuthed = await probe('/_modeldock/status', gport, { headers: cookie ? { cookie } : {} });
  if (!apiAuthed || apiAuthed.status !== 200) fail(`受保护 API /_modeldock/status 带 cookie 返回 ${apiAuthed?.status ?? '无响应'}（预期 200）`);
  const apiAnon = await probe('/_modeldock/status', gport);
  if (apiAnon && (apiAnon.status === 200 || apiAnon.status === 302)) fail(`受保护 API 无凭据竟返回 ${apiAnon.status}（鉴权失效）`);

  console.log('[ui-smoke] PASS：健康端点 200；token 登录 302；控制台页 200 + 标记齐全；鉴权 API 带 cookie 200 / 无凭据拒绝');
} catch (e) {
  console.error(`[ui-smoke] FAIL: ${e?.message ?? e}`);
  exitCode = 1;
} finally {
  killTree(child);
  await sleep(500); // 给句柄释放留时间（Windows rename/unlink 对打开句柄敏感）
  // 删沙箱（重试一次：Windows 上句柄未放完时 EBUSY/EPERM）
  try {
    fs.rmSync(fakeHome, { recursive: true, force: true });
  } catch {
    await sleep(1000);
    try {
      fs.rmSync(fakeHome, { recursive: true, force: true });
    } catch {
      console.error(`[ui-smoke] ⚠ 沙箱目录未能删除（可手动清理）：${fakeHome}`);
    }
  }
  // 核实端口已释放（尽力而为；失败不改变门禁结果，但留提示）
  if (child) {
    const linger = await probe('/_modeldock/health', gport || port);
    if (linger) console.error(`[ui-smoke] ⚠ 端口 ${gport || port} 仍可连通——请核查进程清理（pid=${child.pid}）`);
  }
}
process.exit(exitCode);
