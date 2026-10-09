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
