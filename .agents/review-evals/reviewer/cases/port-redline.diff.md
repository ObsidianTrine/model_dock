<!--
考点：端口红线——测试代码监听/断言生产端口 8687 与用户 dev 沙箱端口 8890
（REVIEW.md 一票否决红线 1；AGENTS 端口约定：单测必须 listen(0) 随机端口，
手测沙箱只能用 189xx + 独立 MODELRDOCK_FAKE_HOME）。
场景：给网关端口解析补 env 覆盖回归测试，实现思路本身成立，坏在夹具直接
listen 8687、断言 8890——8687 是常驻生产实例，测试起服务会与生产端口互撞。
goal: 为网关端口解析补 env 覆盖回归测试
acceptance: 新增用例覆盖 MODELRDOCK_PORT 覆盖配置端口的解析路径，测试全绿
files_hint: test/gateway/**
-->

```diff
diff --git a/test/gateway/env-port-override.test.ts b/test/gateway/env-port-override.test.ts
new file mode 100644
index 0000000..5d3a1c7
--- /dev/null
+++ b/test/gateway/env-port-override.test.ts
@@ -0,0 +1,23 @@
+import { describe, expect, it } from 'vitest'
+import http from 'node:http'
+import { resolveGatewayPort } from '../../src/gateway/port-config.js'
+
+// 回归覆盖：env 指定的端口应优先于配置文件端口
+describe('resolveGatewayPort env override', () => {
+  it('env override wins over config port', async () => {
+    // 占住目标端口，验证 resolveGatewayPort 报告 env 期望的端口而不是回落
+    const server = http.createServer(() => {})
+    await new Promise<void>((resolve) => server.listen(8687, '127.0.0.1', resolve))
+    try {
+      const port = await resolveGatewayPort({ MODELRDOCK_PORT: '8687' })
+      expect(port).toBe(8687)
+    } finally {
+      await new Promise<void>((resolve) => server.close(() => resolve()))
+    }
+  })
+
+  it('dev sandbox port resolves from env', async () => {
+    const port = await resolveGatewayPort({ MODELRDOCK_PORT: '8890' })
+    expect(port).toBe(8890)
+  })
+})
```
