---
id: sync-cloud-test-gaps
type: test
created_at: 2026-10-27T00:00:00+08:00
created_by: human
files_hint:
  - test/**
  - src/sync/**
  - src/cloud/**
workflows:
  - feature-branch
gate: L3
---

# 目标
补齐 docs/known-issues.md §六尾注记录的三个测试盲区——多机同步与云中枢是核心卖点，恰是回归覆盖最薄的区域（913 例绿 ≠ 这些路径有网）。

# 验收标准
1. **engine 推送部分失败簿记**：三个同步目标（webdav / localdir / cloud）各至少一例"部分条目写失败"，断言：sync.json 错误簿记正确、已成功条目不回退、下一轮 tick 收敛（建立在 REVIEW-06/28 回归网之上）
2. **CloudStore（src/cloud/server.ts）专属用例**：putDoc 畸形 ts 拒收且 422 回滚（REVIEW-27）、token 只存 sha256、配对码 CSPRNG、登录/配对畸形 JSON 不 500
3. **applySyncdoc 半完成态恢复**：应用中断（写了一半 profile/harness）后重放幂等、无悬空引用；REVIEW-26 既定语义（远端删除正激活 profile 后 active_profile 悬空、pickTarget 安全回落）作为**行为**用测试钉住，不改行为

# 红线
- 只加测试，不改产品行为（测试暴露出真 bug 时单独报告，不夹带修复）
- vitest 跨文件 mock 雷区：新测试文件不 vi.mock 已被其他文件 mock 的模块；优先端到端子进程形态（参考 test/reset.test.ts）
- 临时目录 os.tmpdir() + path.join，三平台可跑，不写死 /tmp 或盘符

# 背景
已知问题文档自述：「测试盲区（同步 engine 推送部分失败簿记、CloudStore 专属用例、applySyncdoc 半完成态恢复等）未在本轮补齐，作为后续测试建设方向」。现有相邻回归：test/syncpull.test.ts、test/synctarget.test.ts、test/lansync、test/syncexport、cloudserver 回归——先读它们避免重复造例。
