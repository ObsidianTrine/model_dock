# 2026-10-crlf-proc-parse — ✅ 审出

- 评分器：ZCode 会话模型（GLM-5.3-Flash）subagent（与 8/8 基线的 deepseek-v4-pro 评分器不同）
- 关键词：crlf=中，\r=中
- 结论：发现 3 个问题。问题 1（高）即目标缺陷——PROC_LINE_RE（:150）配 split('\n') 全程无 \r 归一化，PS 5.1 管道 CRLF 输出全行失配 → 枚举恒空；还点出**同文件 :75 对 daemon stderr 就做了 replace(/\r$/,'') 的双标**、并核对了两条受影响调用链（sweepGatewayProcesses / trayPidsFromProcessLines），引 e4ac854 佐证
- **评测循环产出的活 bug（当前版仍在）**：问题 2（高）——spawnDaemonAndWait 的 daemon stderr 管道钉住父 CLI 事件循环：subagent 做了本机同原语实验（pipe stderr + unref() → 父进程存活 8221ms = 子进程存活期；补一行 stderr.unref() → 138ms），成功路径 `gateway start --daemon` 打印成功后 shell 永不返回、SEA 双击窗口关不掉；问题 3 = stderr 多字节 UTF-8 跨 chunk 截断乱码

## 目标缺陷证据（摘）

> - 位置：src/cli/shared.ts:150（PROC_LINE_RE = /^\s*(\d+)\s+(.*)$/）+ :153-154（split('\n') 后直接 match，无 \r 归一化）。
> - JS 正则 . 不匹配 \r，无 m 标志时 $ 只匹配串尾；PS 5.1 管道输出实态 CRLF → 每条带命令的行整体失配，返回 []。
> - 佐证：e4ac854 正是 line.replace(/\r$/, '') 一行；同文件 :75 已有同款处理（双标）。
