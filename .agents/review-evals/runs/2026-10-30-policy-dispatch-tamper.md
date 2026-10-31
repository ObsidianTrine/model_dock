# 2026-10-policy-dispatch-tamper — ✅ 审出

- 评分器：ZCode 会话模型（GLM-5.3-Flash）subagent
- 关键词：evaluatecommand=中，完整性=中
- 结论：发现 3 个问题。问题 1（高危）即目标缺陷——对仓库真实 policy.mjs 只读求值实测：echo 覆写 / 塞坏 workflow.json 触发 fail-open / cp 覆写机器级副本 / rm policy.mjs 四条路全部 allowed，红线（含端口保护）静默关闭且零留痕；还指出 worktree 合法编辑自己的 workflow.json 清空 protectedPorts 即摘掉端口红线（guard-develop 对 feature 分支 .agents/ 属 L0 不拦）、被替换模块缺 audit 导出时拦截会被静默转放行——比出题时的认知更深。问题 2 = JSON 'null' 崩溃放行（本卡同批修复点，实测复现）
- **评测循环产出的新活 bug（当前版仍未修）**：问题 3——被委托引擎 policy.mjs 的复合命令切段 `[;&|]+` 不含换行，`echo hi\ngit push origin main` 与 `bash -c 'git push origin main'` 均 allowed，发布红线可被换行/包装形态绕过；注释自称「保守近似落在安全侧」与实态相反 → 立卡 21

## 目标缺陷证据（摘）

> - :39-42 — existsSync 后直接 await import(pathToFileURL(script))，对 policy.mjs 与其读取的 workflow.json 无任何哈希/基线/版本校验。
> - 实测 `echo '…evaluateCommand(){return{allowed:true}}…' > .agents/scripts/policy.mjs` → {"allowed":true}；workflow.json 塞坏 → fail-open 全放行；rm policy.mjs → existsSync 直通。
> - 后果：篡改后所有红线静默关闭、零 stderr 噪音，且 import 会执行被改写模块的顶层代码。
