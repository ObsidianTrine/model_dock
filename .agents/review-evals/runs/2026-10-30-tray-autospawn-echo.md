# 2026-10-tray-autospawn-echo — ✅ 审出

- 评分器：ZCode 会话模型（GLM-5.3-Flash）subagent——本地 claude CLI 的 DeepSeek key 401 失效，2026-10-30 夜间训练改用本评分器（与 8/8 基线的 deepseek-v4-pro 评分器不同，跨评分器对比分数仅供参考）
- 关键词：autospawn=中
- 结论：发现 3 个问题，问题 1 即目标缺陷（tray.ts spawn 不注入标记 + ModelDockTray.cs `_autoOpened` 仅进程内守卫 + 抢锁失败一律当双击 → 安装链弹两份控制台、开机自启也弹窗），并给出修复形态（注入 MODELRDOCK_TRAY_AUTOSPAWN=1 + AutoSpawn 判定）
- 额外收获（均经当前版比对「仍未修」）：CheckViaCli 注释承诺 40s 看门狗但实现无超时（CLI 挂住 → 更新检查永久卡死，「它撒谎」类）；TrayActions `_port`/`_token` 静态字段多线程无同步读写 → `QuitClicked` 可能跳过 gateway stop

## 目标缺陷证据（摘）

> - `tray.ts:24`：`spawnFn(trayPath, [], { ..., env: process.env, ... })` —— 拉起托盘时不注入任何"本次是程序拉起"的标记。
> - `ModelDockTray.cs:44-52`：抢不到单实例 Mutex 的新托盘进程一律当作用户双击处理：`EnsureGateway(); OpenConsoleWhenAlive(); return;`
> - `ModelDockTray.cs:99`：`_autoOpened` 是 `static int`，守卫只在进程内生效——新进程的 `_autoOpened` 必为 0。
> 修复方式（当前版可证）：`src/tray.ts` 注入 `MODELRDOCK_TRAY_AUTOSPAWN=1`；`ModelDockTray.cs` 增加 `AutoSpawn` 静态判定并在 `OpenConsoleWhenAlive` 开头 `if (AutoSpawn) return;`
