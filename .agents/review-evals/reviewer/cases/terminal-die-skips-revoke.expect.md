<!--
考点：新增终态出口用裸 die 绕过 exitRun 的「先吊销再退出」契约——
process.exit 跳过 finally，revokeRunHarness 不执行，一次性 harness 凭据泄漏。
机器可读段供跑分器解析；关键词任意命中一个即记该阻塞点命中。
-->

# 期望判定

clean: false

## 应抓（阻塞点）
- [P1] 关键词: exitRun|revoke|裸die|跳过finally — 新增终态出口（exitRun 漏用）直用 die（process.exit 跳过 finally），revokeRunHarness 不执行：一次性 harness 凭据泄漏活到 TTL、events 留未吊销陈账；同文件刚定义的「终态出口必须走 exitRun 先吊销再退出」契约被新闸门违反

## 不应抓（噪音）
- 关键词: moveCard|settleNotify|await — blocked 迁移与通知顺序不是考点（迁移方向 pending→blocked 正确；「缺 archiveIncident」类完善建议属建议级）
- 关键词: 风格|一致|统一 — 「与既有闸门写法一致」是 diff 自带的错误理由，把风格统一当辩护或单独当发现都不算命中
- 第二个 hunk 的日志文案改动属伴随噪音，单独报告不算漏报对象
