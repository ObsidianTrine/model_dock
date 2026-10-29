# 2026-10-server-reexport-drop — ✅ 审出

- 评分器：ZCode 会话模型（GLM-5.3-Flash）subagent（与 8/8 基线的 deepseek-v4-pro 评分器不同；103KB 大文件题）
- 关键词：re-export=中，导入面=中
- 结论：发现 3 个问题。问题 1 即目标缺陷——穷尽式核对：拆分前 13 个导出符号有 7 个在快照中消失（maxBodyBytes/runClientInstall/runClientUninstall/OVERVIEW_TTL_MS/overviewCacheHit/overviewServeDecision/warmupOverview），并 grep 快照树测试导入逐条对上（test/gateway.test.ts:9、test/install.test.ts:12、test/perf-fixes.test.ts:5），引 d039010 + 07451a3 双修复佐证
- **评测循环产出的活 bug（当前版仍未修）**：问题 2（性能）——/_modeldock/model-catalog 视图缓存永不命中（fullKnownTable 每次 spread 新对象 → 引用比较恒 false），注释宣称的优化不存在；问题 3——probe() 对 responses 协议服务必失败且报错误导（探针拼错协议却怪客户端）

## 目标缺陷证据（摘）

> - 拆分前（744e03a^）server.ts 导出 13 个符号，其中 7 个在快照中消失；快照文件的 export 仅剩 6 个。
> - 这些符号被拆到子模块且仅以 import 形式留在 server.ts；overviewCacheHit/warmupOverview 连 import 都没有。
> - 快照树测试导入仍按 '../src/gateway/server.js' 路径取符号 → ESM 命名导出缺失，vitest/tsc 直接报错。
> - 后续真实修复：d039010 原样补回 7 个 re-export；07451a3 又补 errorReply。
