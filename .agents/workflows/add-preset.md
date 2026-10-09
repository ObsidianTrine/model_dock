# add-preset（新增 provider 预设 Playbook）

固化新增上游 provider 预设的步骤，确保预设数据准确、优先落到 `presets.json` 扩展机制。

> **何时用**：需要让 ModelDock 支持新的上游 AI 供应商（火山方舟新套餐、新的 OpenAI 兼容平台等）时。
> **核心原则**：能落到 `presets.json` 用户扩展机制的，**不要**只写内嵌代码——`presets.json` 能让用户零代码覆盖和扩展。

## 流程

### 1. 收集供应商信息

必须确认以下字段：

| 字段 | 如何获取 |
|---|---|
| `id` | 小写短横线唯一标识，如 `ark-coding-plan` |
| `label` | 展示名，如 `火山方舟 · Coding Plan` |
| `vendor` | 厂商名，如 `火山引擎` |
| `base_url` | API 根地址，如 `https://ark.cn-beijing.volces.com/api/coding` |
| `protocol` | 协议：`openai` / `anthropic` / `generic`（参考 `src/config/types.ts` 的 `Protocol`） |
| `auth_style` | 认证方式：`bearer` / `apikey` / `x-api-key` |
| `docs_url` | 官方文档地址（可选） |
| `needs_proxy` | 国内访问是否走代理（可选，默认 false） |
| `endpoints` | 额外协议端点映射（可选，见下方） |
| `models` | 已知模型清单（可选，保底用） |

### 2. 判断：内置还是 presets.json

| 情况 | 落地方式 |
|---|---|
| 这是标准主流供应商，所有用户都会用到 | 写进 `src/presets/data.ts` 的 `BUILTIN_PRESETS` |
| 这是小众/测试/企业内部供应商，或现有内置预设需要修正 | 落到 `~/.modeldock/presets.json` |
| 同时适用两者 | 内置 + presets.json 覆盖补充 |

**建议**：如果拿不准"是不是所有用户都需要"，**优先放 presets.json**。内置预设宁可少不要多——多了维护成本在仓库里，少了用户自己补就行。

### 3. 方式 A：落到 presets.json（推荐优先）

编辑 `~/.modeldock/presets.json`：

```json
{
  "presets": [
    {
      "id": "my-provider",
      "label": "我的供应商",
      "vendor": "我的厂商",
      "base_url": "https://api.example.com/v1",
      "protocol": "openai",
      "auth_style": "bearer",
      "docs_url": "https://docs.example.com",
      "needs_proxy": true,
      "models": [
        { "id": "model-a", "display_name": "Model A" }
      ]
    }
  ]
}
```

启动时 `src/presets/data.ts` 的 `reloadPresets()` 会自动读取合并：
- 同名 `id` 的条目覆盖内置预设
- 新 `id` 追加到预设列表

### 4. 方式 B：写进 BUILTIN_PRESETS

编辑 `src/presets/data.ts`，在 `BUILTIN_PRESETS` 数组中新增条目（参考已有条目格式）。

```typescript
{
  id: 'my-provider',
  label: '我的供应商',
  vendor: '我的厂商',
  base_url: 'https://api.example.com/v1',
  protocol: 'openai',
  auth_style: 'bearer',
  docs_url: 'https://docs.example.com',
  needs_proxy: true,
  endpoints: { anthropic: 'https://api.example.com/v1/anthropic' },
  models: [
    m('model-a', 128000, 4096, TOOLS, 'Model A'),
    md('model-b', 'Model B (plan 套餐，元数据待补)'),
  ],
}
```

模型元数据工具函数：
- `m(id, context_window?, max_output?, capabilities?, display_name?)`：完整模型
- `md(id, display_name)`：只有展示名（plan 套餐/元数据不详时兜底）
- `TOOLS = ['tools']`、`TOOLS_REASON = ['tools', 'reasoning']`

### 5. 写测试

如果是方式 B（改了 `data.ts`），加测试确保新预设能被加载：

```typescript
import { describe, expect, it } from 'vitest'
import { reloadPresets } from '../../src/presets/data.js'

describe('presets', () => {
  it('includes my-provider', async () => {
    const presets = await reloadPresets()
    const p = presets.find((x) => x.id === 'my-provider')
    expect(p).toBeDefined()
    expect(p!.label).toBe('我的供应商')
  })
})
```

### 6. 验证

```bash
npm test           # 全绿
npm run build      # tsc 编译通过
# 可选：本地启动网关，在 Web 控制台确认新预设出现在列表中
```

## 常见错误对照

| ❌ 错误 | ✅ 正确 |
|---|---|
| 新增 provider 只写 `BUILTIN_PRESETS`，不留 presets.json 扩展入口 | 能预见复用的先落到 presets.json 机制 |
| `base_url` 末尾带 `/` 或不带 `/` 不一致 | 统一与已有预设保持一致（推荐不带尾部斜杠） |
| `protocol` 写错（如 `openai` 写成 `OpenAI`） | 必须匹配 `src/config/types.ts` 中 `Protocol` 字面量 |
| 模型元数据乱填（context_window 远大于实际） | 用保守默认值，宁可填小也不要夸大 |
| 不填 `docs_url` | 只要有官方文档就填，用户查 API 时有用 |

## 更新内置预设后需同步

- 如果新增/修改了 `BUILTIN_PRESETS`，记得同步更新 `docs-sync.md` 检查清单中的 README（新增供应商 → 支持列表更新）。

---

## 可直接复制的预设模板

### presets.json 模板（用户扩展）

复制到 `~/.modeldock/presets.json`，替换尖括号内容：

```json
{
  "presets": [
    {
      "id": "<provider-id>",
      "label": "<展示名>",
      "vendor": "<厂商名>",
      "base_url": "<API 根地址，不带尾部斜杠>",
      "protocol": "<openai | anthropic | generic>",
      "auth_style": "<bearer | apikey | x-api-key>",
      "docs_url": "<官方文档地址，可选>",
      "needs_proxy": <true | false，可选，默认 false>,
      "endpoints": {
        "<额外协议名>": "<对应端点地址>"
      },
      "models": [
        {
          "id": "<model-id>",
          "display_name": "<展示名，可选>",
          "context_window": <数字，可选>,
          "max_output": <数字，可选>,
          "capabilities": ["<tools | reasoning>", "..."]
        }
      ]
    }
  ]
}
```

**完整示例**（新增一个"月之暗面 Kimi"预设）：

```json
{
  "presets": [
    {
      "id": "kimi",
      "label": "月之暗面 Kimi",
      "vendor": "月之暗面",
      "base_url": "https://api.moonshot.cn/v1",
      "protocol": "openai",
      "auth_style": "bearer",
      "docs_url": "https://platform.moonshot.cn/docs",
      "needs_proxy": false,
      "models": [
        {
          "id": "kimi-k2-8-preview",
          "display_name": "Kimi K2 8 Preview",
          "context_window": 128000,
          "max_output": 4096,
          "capabilities": ["tools"]
        },
        {
          "id": "kimi-latest",
          "display_name": "Kimi Latest",
          "context_window": 128000,
          "max_output": 4096,
          "capabilities": ["tools", "reasoning"]
        }
      ]
    }
  ]
}
```

### BUILTIN_PRESETS 模板（内置预设）

复制到 `src/presets/data.ts` 的 `BUILTIN_PRESETS` 数组中，替换尖括号内容：

```typescript
{
  id: '<provider-id>',
  label: '<展示名>',
  vendor: '<厂商名>',
  base_url: '<API 根地址，不带尾部斜杠>',
  protocol: '<openai | anthropic | generic>',
  auth_style: '<bearer | apikey | x-api-key>',
  docs_url: '<官方文档地址，可选>',
  needs_proxy: <true | false，可选>,
  endpoints: { <额外协议>: '<端点地址>' },  // 可选
  models: [
    // 完整元数据模型
    m('<model-id>', <context_window>, <max_output>, TOOLS, '<展示名>'),
    m('<model-id>', <context_window>, <max_output>, TOOLS_REASON, '<展示名>'),

    // 只有展示名的模型（plan 套餐/元数据不详时）
    md('<model-id>', '<展示名>'),
  ],
}
```

**完整示例**（新增一个"智谱 GLM"预设）：

```typescript
{
  id: 'glm',
  label: '智谱 GLM',
  vendor: '智谱',
  base_url: 'https://open.bigmodel.cn/api/paas/v4',
  protocol: 'openai',
  auth_style': 'bearer',
  docs_url: 'https://open.bigmodel.cn/dev/api',
  needs_proxy: false,
  endpoints: {
    anthropic: 'https://open.bigmodel.cn/api/paas/v4/anthropic',
  },
  models: [
    m('glm-4.6', 200000, 8192, TOOLS_REASON, 'GLM 4.6'),
    m('glm-4.5-air', 128000, 4096, TOOLS, 'GLM 4.5 Air'),
    md('glm-4.5-flash', 'GLM 4.5 Flash（免费版，元数据不详）'),
  ],
}
```

### 工具函数速查

```typescript
// 完整模型元数据
m(id, context_window?, max_output?, capabilities?, display_name?)

// 只有展示名（plan 套餐/元数据不详）
md(id, display_name)

// 常用 capabilities
const TOOLS = ['tools']                    // 支持工具调用
const TOOLS_REASON = ['tools', 'reasoning'] // 支持工具调用 + 推理
```
