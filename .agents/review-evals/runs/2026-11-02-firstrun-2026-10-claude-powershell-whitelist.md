# 审查评测报告

- 考题：1，审出：1，未审出：0
- 模型：glm-5-3-flash-260828
- 评分口径：expect 关键词命中（启发式），精确判定看原文

## 2026-10-claude-powershell-whitelist — ✅ 审出

- 考题：claude-headless worker 的权限白名单按 Bash(...) 前缀写死——Windows 上 claude CLI 的 shell 工具是 PowerShell：Bash(git add:*) 匹配不到 PowerShell 调用，git add/commit/npm test 全被 headless 自动拒（只读 git status 反而走内置启发式放行），即夜跑「能读不能验」权限墙；hook matcher 只写 Bash 还使 PowerShell 调用绕过 policy-worker，红线层失明
- 关键词：powershell=中，白名单=中
- 完整输出：/var/folders/vw/7vttg54s74ng208jp5063f0c0000gp/T/modeldock-review-eval-HIiMty/2026-10-claude-powershell-whitelist.output.txt

<details><summary>模型原文</summary>

```text
发现 4 个问题

## 1.（P0，即后来修复的主 bug）Windows 权限墙：shell 白名单/红线/hook 只有 Bash 形态

- **证据**：行 22–34 `BASE_TOOLS`、行 41–47 `allowedTools()`、行 51 `DISALLOWED_TOOLS` 全部只生成 `Bash(...)` 形态；行 63 hook `matcher: 'Bash'`。
- **失败场景**：Windows 上 claude CLI 的 shell 工具是 PowerShell，权限规则按工具名匹配——`Bash(git add:*)` 匹配不到 PowerShell 工具调用，worker 的 git add/commit、npm test 全部「requires approval」被 headless 自动拒绝，只读 git status 反而走内置启发式放行，形成夜跑观测到的「能读不能验」权限墙。
- **更重的半边**：红线层同时失明——行 51 的 `Bash(git push:*)`/`Bash(git tag:*)`/`Bash(npm publish:*)` 拦不住 PowerShell 形态的 push/tag/publish，且行 63 matcher `'Bash'` 让 policy-worker hook 收不到任何 PowerShell 调用。push/tag/publish 双保险在 Windows 上同时失效。修法：白名单与红线一律 Bash+PowerShell 双形态双发，matcher 改 `Bash|PowerShell`。

## 2.（安全）worker settings 落盘无权限限制，可能泄露 tier 凭据

- **证据**：行 70 `fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2))`，无 `mode`；行 54–56 注释自证 `envPatch` 会把 tier token 并入 `settings.env`。文件落在系统临时目录（行 78–80），默认 0644，本机其他用户可读。
- **失败场景**：tier 任务运行期间凭据对同机其他用户可读。应 `{ mode: 0o600 }`（NTFS 忽略 mode，无害）。

## 3.（Windows 必挂点）`newWorkerSettingsPath` 的 tmpdir 回落错误

- **证据**：行 79 `process.env.TMPDIR ?? '/tmp'`。Windows 无 `TMPDIR` env，回落 `'/tmp'` 经 `path.join` 解析为「当前盘根 `\tmp`」（通常不存在）→ `mkdtempSync` ENOENT，worker 启动前即挂。
- **修法**：`os.tmpdir()`。

## 4.（逻辑）`resolveReviewBackendName` 的 prior 沿用只防了单向 mock

- **证据**：行 275 `if (prior && !(prior === 'mock' && worker !== 'mock'))`——只拦「prior=mock、worker=真实」。反方向 **worker=mock、prior=真实后端** 时仍直接沿用 `{ name: prior, mode: 'prior' }`。
- **失败场景**：mock 会话是测试路径，「零外部调用、永不异构」是不变量；resume 一旦沿用真实 prior，测试会给 mock 会话派真实 CLI 审查后端，烧真钱。应双向例外。

## 存疑

- 行 213–214 `child.stdin.write(prompt)` 无 `child.stdin.on('error')` 监听：unix 下 spawn 失败（ENOENT）时缓冲写可能触发未处理的 EPIPE 使编排进程崩溃。缺 Node 在 spawn 失败路径下 stdin 流错误行为的实证，不确证、不计数。

说明：问题 1 已对照本仓后续修复 commit（08cbb31）确认；问题 2/3/4 对照其后加固 commit（a3a68ab）逐条吻合；以上行号均已在给定片段中核实。
```

</details>