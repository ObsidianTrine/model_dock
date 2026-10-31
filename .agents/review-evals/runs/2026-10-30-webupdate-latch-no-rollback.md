# 2026-10-webupdate-latch-no-rollback — ✅ 审出

- 评分器：ZCode 会话模型（GLM-5.3-Flash）subagent
- 关键词：updating=中，永久=中
- 结论：发现 2 个问题。问题 1 即目标缺陷且三条同步失败路径逐一点名——244 行 mkdirSync（logsDir 被同名文件占位抛 EEXIST，recursive 不豁免）、249 行 openSync（Windows 日志文件被占 EBUSY/EPERM，常态风险）、251 行 spawn 同步 TypeError（默认 argv:[] 时 argv[0]=undefined 即触发）；任一抛出后 watchApplyChild 尚未挂载、markApplyFailed 永不执行，239 行守卫从此挡死所有一键更新直至重启。引 b7b91ad 修复佐证逐条对应
- **评测循环产出的活 bug（当前版仍在）**：问题 2——persistCheckTime 对 gateway.json 裸 read→modify→write，与 devices/lan_token 等并发写方构成丢字段竞态（每 60s status 轮询都 kick 一次检查，落盘窗口结构性放大）；项目侧 state-file.ts 已有 mutateGatewayState 串行队列但 webupdate.ts 至今未接入

## 目标缺陷证据（摘）

> - 240 行 state.updating = true 先置门闩，之后 mkdirSync / openSync / spawn 三个可同步抛出的步骤均无 try/catch、无复位；
> - 生产环境唯一复位点 markApplyFailed 仅由被 watch 的子进程 exit/error 触发，门闩后的同步失败它永不执行；
> - 长驻网关上等于单次瞬时失败放大成永久功能锁死。
