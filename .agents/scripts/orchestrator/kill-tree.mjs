// kill-tree.mjs — 跨平台进程树终止（熔断与孤儿 worker 清理共用，docs 5.10）。
// worker 的 claude CLI 有子进程链（node → ripgrep → git …），只杀直接子进程
// 会留下继续跑的孙进程：Unix 用进程组（detached + kill(-pid)），
// Windows 用 taskkill /T /F。

import { execFileSync } from 'node:child_process';

export function isAlive(pid) {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0); // 信号 0 = 探活，不实际发送
    return true;
  } catch (e) {
    return e.code === 'EPERM'; // EPERM = 存在但无权发信号，仍算活着
  }
}

export function killTree(pid) {
  if (!pid || pid <= 0) return;
  // 自杀护栏：mock 后端在进程内跑（worker_spawned 上报的 pid = orchestrator 自身），
  // Windows taskkill /T /F 会把 orchestrator 连树杀掉——熔断现场静默消失（卡滞留
  // running/、incident 不落盘，评测集 2026-11-02 复查实测）。真实后端的 pid 是真
  // 子进程（claude/zcode CLI），不受此护栏影响
  if (pid === process.pid) return;
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      // spawn 时 detached:true 建立了独立进程组，负 pid 杀整组
      process.kill(-pid, 'SIGTERM');
      // 给 2s 宽限，仍活着再 SIGKILL
      const deadline = Date.now() + 2000;
      const tick = () => {
        if (!isAlive(pid) || Date.now() > deadline) {
          if (isAlive(pid)) {
            try {
              process.kill(-pid, 'SIGKILL');
            } catch {}
          }
          return;
        }
        setTimeout(tick, 100);
      };
      setTimeout(tick, 100);
    }
  } catch (e) {
    if (e.code !== 'ESRCH') console.error(`[orchestrator] killTree(${pid}) 失败：${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// 进程属主校验（P0：陈锁/孤儿 pid 被复用时防误杀，2026-11）
// ---------------------------------------------------------------------------

/** 进程已运行时长（ms）；无法判定（进程已退 / ps·PowerShell 不可用）返回 null。
 *  unix 用 `ps -o etime=`（[[dd-]hh:]mm:ss，无 locale 歧义）；Windows 用
 *  PowerShell Get-Process StartTime（枚举/杀树同走系统工具，不新增裸 kill）。 */
export function processElapsedMs(pid) {
  if (!pid || pid <= 0) return null;
  try {
    if (process.platform === 'win32') {
      const out = execFileSync(
        'powershell',
        ['-NoProfile', '-Command', `(Get-Process -Id ${Number(pid)} -ErrorAction Stop).StartTime.ToString('o')`],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000 },
      ).trim();
      const t = Date.parse(out);
      return Number.isFinite(t) ? Date.now() - t : null;
    }
    const out = execFileSync('ps', ['-p', String(pid), '-o', 'etime='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15_000,
    }).trim();
    // etime 形态：mm:ss | hh:mm:ss | dd-hh:mm:ss
    const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(out);
    if (!m) return null;
    const [, d, h, min, sec] = m;
    const ms = (((Number(d ?? 0) * 24 + Number(h ?? 0)) * 60 + Number(min)) * 60 + Number(sec)) * 1000;
    return Number.isFinite(ms) ? ms : null;
  } catch {
    return null;
  }
}

/**
 * 孤儿 worker 属主判定（纯函数，cleanupOrphanWorker 与单测共用）：worker 是先 spawn
 * 后落 worker_spawned 事件，真实孤儿的运行时长 ≈ 事件距今；pid 被复用时新进程显著
 * 更「年轻」（事件之后才启动），「更老」则事件前就在跑、同样不可能是本次 spawn。
 * elapsed 不可测 / 事件无 ts → 'unknown'（调用方沿用旧语义处理，不做无据判定）。
 */
export function orphanOwnership(spawnedTsIso, elapsedMs, now = Date.now()) {
  if (!Number.isFinite(elapsedMs)) return 'unknown';
  const at = Date.parse(String(spawnedTsIso ?? ''));
  if (!Number.isFinite(at)) return 'unknown';
  const expected = Math.max(0, now - at);
  // 容差：spawn→落事件毫秒级；放宽到「年轻 2min 以上 / 年长 1min 以上」才算复用
  if (elapsedMs > expected + 120_000 || elapsedMs + 60_000 < expected) return 'recycled';
  return 'ours';
}
