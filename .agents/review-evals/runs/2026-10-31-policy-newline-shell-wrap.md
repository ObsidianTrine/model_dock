# 2026-10-policy-newline-shell-wrap — ✅ 审出

- 评分器：ZCode 会话模型（GLM-5.3-Flash）subagent
- 关键词：换行=中，包装=中
- 结论：发现 9 个问题，问题 1/2 即目标缺陷（换行不分段整体放行 + bash/sh/zsh -c 包装漏拦，均经内联复刻历史版逻辑实证），并发现 `AGENTS_ALLOW_RELEASE=1 bash -c 'git push origin main --force'` 组合可绕过白名单强制 force push——修复 ba5f0b7 收口了这两类
- **评测循环产出的新旁路面（当前版 policy.mjs 仍未修，7 项）**：env -i / env -- 使 git 检测失效；命令替换 `$(git push)` 与子壳 `(git push)` 放行；xargs/heredoc 外层包装放行；npm 全局 flag 在前（--registry）漏拦 npm publish；status/logs/list 词豁免是全文任意位置匹配（`gateway start … && curl …/status` 击穿缺省端口兜底）；破坏性进程词表缺 Stop-Process（PowerShell kill 8687 放行）；`.agents/` 整目录归 L0 自动合并 = 守护器可被守护对象改写后合法落地。→ 已立卡 27 收口

## 目标缺陷证据（摘）

> - 问题 1【高危·后真实修复】L107 `command.split(/[;&|]+/)` 分隔符集合不含 \n/\r：`echo hi\ngit push origin main` 实测整体放行。
> - 问题 2【高危·后真实修复】无任何包装解包：`bash -c 'git push origin main'`、`sh -c 'git push origin main'` 实测放行；`AGENTS_ALLOW_RELEASE=1 bash -c 'git push origin main --force'` 白名单被整段绕过。
