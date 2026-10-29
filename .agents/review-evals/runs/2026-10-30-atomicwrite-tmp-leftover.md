# 2026-10-atomicwrite-tmp-leftover — ✅ 审出

- 评分器：ZCode 会话模型（GLM-5.3-Flash）subagent（与 8/8 基线的 deepseek-v4-pro 评分器不同）
- 关键词：tmp=中，残留=中，清理=中
- 结论：发现 3 个问题。问题 1 即目标缺陷——155 行 fsp.open 在清理 try 之外，写阶段（writeFile/chmod/sync）失败只有 finally close 没有 rm，半截 .config.toml.<pid>.<rand> 落在受保护目录且每次重试再漏一份（对照 174 行 rename 失败路径有清理），引 d41f847② 佐证
- 额外收获：问题 2 = withFileLock 同路径重入自死锁（队列无属主概念；后来 b917687 CORRECT-06 用 AsyncLocalStorage 真实修复——当时靠注释约定规避）；问题 3 = 锁文件写 pid 失败不回滚留孤儿锁

## 目标缺陷证据（摘）

> - tmp 文件在 155 行 open('w') 成功的一刻已落盘创建；157-159 行 writeFile/chmod/sync 任一步抛错，finally 只关句柄，没有 rm——半截残留。
> - 清理只覆盖 rename 阶段（174 行），未覆盖写入阶段；atomicWrite 是全仓唯一写盘入口（21 处调用），目标含 config.toml / secrets.json / gateway.json。
> - 修复佐证：d41f847「②atomicWrite 写入阶段失败清残留 tmp（此前只有 rename 失败清理，磁盘满/权限错每次重试漏一份）」。
