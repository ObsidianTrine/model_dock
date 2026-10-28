# hotfix（生产紧急修复工作流）

生产环境（本机 8687 网关或已发布版本）出紧急问题时，走这条基于 main 的快速通道——**不要**走 feature-branch（那是基于 develop 的常规开发流程）。

> **何时用**：线上版本崩溃、网关 8687 实例故障、或已发布版本有必须立刻修的严重 bug。
> **何时不用**：普通功能开发、非紧急 bug——走 `feature-branch.md`。

## 与 feature-branch 的区别

| | feature-branch | hotfix |
|---|---|---|
| 分支起点 | `develop` | `main`（当前生产对应的代码） |
| 合并目标 | `develop` | **先 `main`（发紧急版本），再回灌 `develop`** |
| 验证门槛 | `npm test` 全绿 | `npm test` 全绿（不可省）+ 修复场景手测 |
| 节奏 | 正常排期 | 尽快，但**不跳过测试** |

## 流程

### 1. 开 hotfix 分支（基于 main）

```bash
git checkout -b hotfix/<简述> main
```

- 命名：`hotfix/fix-gateway-crash`、`hotfix/patch-token-leak` 等，小写短横线。
- **不要**基于 develop——develop 上可能混有未发布的功能，紧急修复不该把它们带进生产。

### 2. 修复 + 测试

- 改代码、写/改测试，确保 `npm test` 全绿。
- 对修复场景做最小手测验证（如网关问题：在隔离沙箱 + **非 8687** 端口起实例复现并验证修复——`MODELRDOCK_FAKE_HOME` 与 189xx 端口成对指定，见 `incident-response.md` 步骤 2）。

### 3. 合入 main 并发紧急版本

```bash
git checkout main
git merge --no-ff hotfix/<简述>
```

- 按 `release.md` 流程发 patch 版本（递增第三位版本号）：更新 CHANGELOG → 推 main 等 test 绿 → 打 tag 推送。

### 4. 回灌 develop（防止 develop 上问题重现）

```bash
git checkout develop
git merge --no-ff hotfix/<简述>
git push origin develop
```

- **必须回灌**：否则 develop 下次发版时，同一个 bug 会重新出现。
- 有冲突在 develop 侧解决（通常是 develop 已重构了相关代码），解决后 `npm test` 确认全绿再推。

### 5. 清理

```bash
git branch -d hotfix/<简述>
```

## 红线

- 紧急 ≠ 跳过测试。`npm test` 全绿是底线。
- hotfix 只做最小修复，不顺手重构、不夹带其他改动。
- 修复 8687 生产实例相关问题时，排查和验证一律用其他端口（见 `incident-response.md`），**绝不停机重启 8687**。

---

## 完整示例：修复网关 Token 泄漏

假设线上 v1.2.0 版本被发现：网关在特定错误路径下会把 API Key 打到响应里返回给客户端。这是安全漏洞，需要立刻修复。

### 步骤 1：开 hotfix 分支

```bash
$ git checkout main
$ git checkout -b hotfix/fix-token-leak main
# Switched to a new branch 'hotfix/fix-token-leak'
```

### 步骤 2：最小修复 + 测试

找到问题代码（假设在 `src/gateway/error-handler.ts`）：

```typescript
// 修复前（泄漏 API Key）
return res.status(500).json({ error: err.message, config: cfg })

// 修复后（不暴露 config）
return res.status(500).json({ error: '网关内部错误，请查看服务端日志' })
```

写测试覆盖这个场景：

```typescript
it('error response does not leak API key', async () => {
  // 触发一个会进入该错误路径的请求
  const res = await fetch(`http://localhost:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer invalid-token' },
    body: JSON.stringify({ model: 'gpt-4' }),
  })
  const body = await res.json()
  expect(body.config).toBeUndefined()  // 不应包含 config
  expect(JSON.stringify(body)).not.toContain('sk-')  // 不应包含 key 特征
})
```

跑测试确认修复：

```bash
$ npm test
# ✅ 全绿，包括新加的泄漏测试
```

在隔离沙箱实例手测验证（`MODELRDOCK_FAKE_HOME` 与 189xx 端口成对指定；禁止 run_dev/8890）：

```bash
$ export MODELRDOCK_FAKE_HOME=/tmp/modeldock-hotfix-test
$ npx tsx src/cli.ts gateway start --port 18990
# 在另一个终端发一个会触发 500 的请求，确认响应里没有 API Key
```

### 步骤 3：合入 main 并发 patch 版本

```bash
$ git checkout main
$ git merge --no-ff hotfix/fix-token-leak
# Merge made by 'ort' strategy
```

更新 CHANGELOG（新增 v1.2.1 patch 版本）：

```markdown
## [1.2.1] - 2026-10-15

修复安全漏洞。

### 修复

- **Token 泄漏**：修复特定错误场景下 API Key 可能被打到响应中的问题。
```

按 `release.md` 流程发布 v1.2.1（推 main → 等 test 绿 → 打 tag 推送）。

### 步骤 4：回灌 develop

```bash
$ git checkout develop
$ git merge --no-ff hotfix/fix-token-leak
# 如果有冲突（比如 develop 重构了 error-handler.ts），解决冲突
$ npm test  # 确认冲突解决后测试全绿
$ git push origin develop
```

### 步骤 5：清理

```bash
$ git branch -d hotfix/fix-token-leak
# Deleted branch hotfix/fix-token-leak
```

完成。生产版本 v1.2.1 已修复漏洞，develop 分支也同步了修复。
