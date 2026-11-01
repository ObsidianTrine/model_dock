# 2026-10-30-orch-resume-backend-first-hit — 审查跑分原文

- 考题：cases/2026-10-orch-resume-backend-first-hit.json（reviewRef 5e4dcfe^1，fixedBy 5e4dcfe）
- 评分器：ZCode 会话模型 subagent（GLM-5.3-Flash），2026-10-30
- 判定：✅ 审出（顶层「发现 5 个问题」+ 4 存疑）

## 原文要点

**[P1] 主缺陷命中**：resolveBackendName :271 `.find()` 取首条 worker_spawned，注释却承诺「沿用**上次**会话后端」——append-only 下多会话任务实际回到最早引擎；与 :253-254 专门防御「prior 是 mock 而 worker 已换真实」的 resolveReviewBackendName 自相矛盾，该防御想防的场景在 worker 侧复活。修向取末条。

**[P1] 临时 settings 路径 Windows 必炸**：:78 `process.env.TMPDIR ?? '/tmp'`——Windows 无 TMPDIR 回落 /tmp 经 path.join 落盘根，mkdtempSync ENOENT；违反「临时目录用 os.tmpdir()」硬约定。

**[P2] worker spawn 未走 shell，与同文件探测矛盾**：:119 spawn('claude') 无 shell；:214/:222 探测明确 `shell: process.platform === 'win32'`（注释：命中 .cmd 包装）——探测通过、执行 ENOENT。

**[P2] mock worker 可被派真实审查后端**：:255 prior 短路只防「prior=mock 且 worker=真实」单向；worker='mock' + prior='zcode-headless' 时 mode='prior' 返回真实后端，违反 :239「mock 永不异构、零外部调用」。

**[P2] settings 临时文件凭据暴露**：:68 writeFileSync 默认 0644 无 mode、无强制清理；与本仓库「密钥写盘 0600」不一致。

## 后续

除主缺陷（卡 09-2 修复）外 4 条当前版活缺陷立卡 17-harden-claude-headless-backend。复核注（2026-10-30 晚）：spawn shell 家族已被远端 c99f326 修复（考题 2026-10-agents-win-spawn-shell），卡 17 范围相应收窄。
