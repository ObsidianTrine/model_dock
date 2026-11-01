# 2026-10-spawndaemon-stderr-pipe-pin — ✅ 审出

- 评分器：ZCode 会话模型（GLM-5.3-Flash）subagent
- 关键词：钉=中，管道=中
- 结论：发现 1 个问题，即目标缺陷且机制链完整——stdio pipe（L60）+ data/close 监听（L84/L93）→ 读端成被引用活动句柄；child.unref() 只解子进程句柄不解 stdio 流；daemon 常驻写端永不关 → 事件循环排不空 → 成功路径自然 return 的调用方全部挂住。还核对了 docs/known-issues.md CORRECT-07（P1，实测 ≥45s/13min 不返回）与后续修复 99fa3a5（daemon 侧 redirectDaemonStderrToLog 接管 fd 2、spawnDaemonAndWait 改全 ignore）——**本卡 7d21df0 的 fd 重定向方案后来被演进为更彻底的 daemon 侧接管**，考题 fixedBy 保留首个修复、报告记录演进
- 次级引用源同场指出：appendLine 常驻流池 idle 3s 才关，给父退出叠加有界延迟；openUrlInBrowser 的 `&` URL cmd 截断列为存疑（当前调用图无触发点，克制）

## 目标缺陷证据（摘）

> - L60 stdio: ['ignore','ignore','pipe'] —— 父进程持有 daemon stderr 读端；L84/L93 挂 data/close 监听 → flowing 态活动句柄；全函数无任何路径 destroy/unref 该流。
> - daemon 是 detached 常驻进程，fd 2 永不关闭 → 父进程读端永远活跃，事件循环排不空；成功路径调用方自然 return → CLI 挂住不退出。
