// spawn-shell.mjs — 全局命令 spawn 的跨平台选项与参数包装（.agents 工具链 Windows
// 必挂点修复）。Windows 上 npm / claude 等全局命令是 .cmd 包装，spawn 直调必 ENOENT
// （AGENTS.md「工程硬性约定·进程」）——win32 补 shell: true 命中包装器。unix 一律
// 不加 shell：sh -c 包装会改变进程组/信号语义（熔断杀树依赖 unix 进程组），是行为
// 红线。纯函数、platform 显式注入：测试跑在任意 OS 上都能断言双分支。

/** spawn/spawnSync 通用 options：base 之上按平台补 shell。 */
export function shellSpawnOptions(platform, base = {}) {
  return platform === 'win32' ? { ...base, shell: true } : { ...base };
}

/** shell 模式参数包装：含空格/引号的参数包双引号（如 --allowedTools 的
 *  "Bash(git add:*)" 族、--settings 的临时文件路径——临时目录落在带空格的用户名
 *  下时必现），否则拼成一行命令后被拆成多个参数；内部引号按 node argv 解析惯例
 *  转义。unix 不走 shell、原样返回。 */
export function quoteArgsForShell(args, useShell) {
  if (!useShell) return args;
  return args.map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a));
}
