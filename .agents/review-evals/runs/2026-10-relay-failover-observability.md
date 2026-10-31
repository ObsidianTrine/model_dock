# 审查评测报告

- 考题：1，审出：0，未审出：1
- 模型：glm-4.5-air
- 评分口径：expect 关键词命中（启发式），精确判定看原文

## 2026-10-relay-failover-observability — ❌ 未审出

- 考题：failover 链三处可观测性 lie：数组体改写谎报 modelAfter、全候选 skip 耗尽降级成 502「连接失败」吞真实 status/hint、replayed_from 单变量覆盖只剩最后一跳
- 关键词：array.isarray=未中，candidateskip=未中，replayed_from=未中
- 完整输出：/var/folders/vw/7vttg54s74ng208jp5063f0c0000gp/T/modeldock-review-eval-zbHSuI/2026-10-relay-failover-observability.output.txt

<details><summary>模型原文</summary>

```text
发现 3 个问题

## 1. 文件: src/gateway/relay.ts:419 - 重复的 `rewritten.body.length > 0` 检查

**问题**: `forwardToUpstream` 函数在第419行对 `rewritten.body.length > 0` 检查是多余的，因为 undici 的 request 在 body 为 Buffer 时自动处理空 Buffer。这代码可能是从旧版本复制残留。

**证据**:
```typescript
body: rewritten.body.length > 0 ? rewritten.body : undefined,
```

## 2. 文件: src/gateway/relay.ts:263 - 潜在的 JSON 解码错误处理不一致

**问题**: 在 `topLevelModel` 函数第263行，捕获 JSON.parse 错误后直接返回 null，但在其他类似场景（如第332行）会返回 null。不一致的错误处理可能导致调试困难。

**证据**:
```typescript
try {
  last = JSON.parse(body.toString('latin1', keyStart, i + 1)) as string
} catch {
  return null // 此处直接返回，没有记录错误
}
```

## 3. 文件: src/gateway/relay.ts:243 - 使用了不安全的字符编码 'latin1'

**问题**: 第243行使用 'latin1' 编码比较 'model' 键名，这在某些边界情况下可能导致错误。其他地方使用 utf8，这里应该保持一致。

**证据**:
```typescript
const isModelKey = i - keyStart === 5 && body.toString('latin1', keyStart, i) === 'model'
```

## 存疑

1. **第419行的多余检查**: 不确定这是否是后来修复的 bug，还是只是代码冗余。需要查看后续版本确认。
2. **错误处理不一致**: 可能是有意为之的设计，但缺少文档说明为什么这里需要特殊处理。
3. **编码不一致**: 'latin1' 可能在某些特定场景下是必要的，但需要更多上下文确认。
```

</details>