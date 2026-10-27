---
id: secrets-write-lock
type: bugfix
created_at: 2026-10-27T00:00:00+08:00
created_by: human
files_hint:
  - src/config/secrets.ts
  - src/config/store.ts
  - test/store.test.ts
workflows:
  - feature-branch
gate: L3
---

# 目标
secrets.json 的读-改-写补跨进程锁，堵 CLI `provider set-key` 与运行中网关并发 setSecret 时整表覆盖丢更新。

# 验收标准
- 新增并发回归用例：两个异步执行流（或两个子进程）对同一 FAKE_HOME 沙箱的 secrets.json 并发 setSecret 不同 key，最终两 key 均存在且值正确（现实现会丢一方）
- `npm test` 全绿
- docs/known-issues.md CORRECT-01 条目注记处勾选「跨进程轻量锁已补」并标注日期与 commit

# 红线
- 不改密文格式、不改 keychain/DPAPI/secret-tool 外部后端交互语义（REVIEW-19 修过的"不存在 vs 故障"区分不许回退）
- 不引入新依赖；锁参数（陈锁抢占超时等）沿用 store.ts 现值

# 背景
config.toml 写路径已有两层防护：进程内 promise 串行 + O_EXCL 锁文件 + 15s 陈锁抢占（src/config/store.ts，known-issues §四「已核查无问题」）。secrets.json 的 setSecret / setSecretsBatch / deleteSecret → writeFileSecrets 是无锁整表覆盖（known-issues CORRECT-01 修复注记明确「连带的跨进程轻量锁未实施，仍开放」）。方案二选一：① 把 store.ts 的锁实现抽成公共 util 供两处复用；② secrets.ts 内照抄同型实现。锁文件落 modeldockDir() 下，路径一律 path.join。
