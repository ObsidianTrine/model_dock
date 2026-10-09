# add-adapter（新增 harness 适配器 Playbook）

固化新增客户端适配器的步骤，确保每个适配器覆盖 detect / planAttach / planDetach / status 四件套并在 registry 正确注册。

> **何时用**：需要让 ModelDock 支持新的 AI 客户端（如新增 editor / IDE 插件）时。
> **前提**：已阅读 `src/adapters/types.ts` 了解 `HarnessAdapter` 接口定义。

## 新增流程

### 1. 调研客户端

- **配置方式**：客户端需要什么配置文件、格式（JSON / YAML / TOML）、路径（绝对？相对于用户目录？）。
- **接入协议**：支持什么格式发送请求？（OpenAI、Anthropic、自定义）
- **密钥管理**：客户端怎么存 API Key？（明文文件？keychain？环境变量？）
- **已有适配器参考**：找最类似的已有 adapter 抄骨架（如 Claude Code 走 YAML → 参考 `claude-code.ts`，Codex 走 JSON → 参考 `codex.ts`）。

### 2. 创建适配器文件

在 `src/adapters/` 下新建 `<client-id>.ts`，实现 `HarnessAdapter` 接口：

```typescript
import type { HarnessAdapter } from './types.js'

export const myClientAdapter: HarnessAdapter = {
  id: 'my-client',          // 小写短横线，唯一标识
  label: 'My Client',       // 展示名

  async detect(): Promise<DetectResult> {
    // 检查客户端是否已安装（配置目录 / 可执行文件 / 进程是否存在）
    return { installed: false, configFiles: [], note: 'TODO' }
  },

  async planAttach(opts: AttachOptions): Promise<PlanResult> {
    // 生成接入 ModelDock 所需的文件修改计划（不改文件，只返回计划列表）
    return { changes: [], notes: ['TODO'] }
  },

  async planDetach(opts: AttachOptions): Promise<PlanResult> {
    // 生成断开 ModelDock、恢复原配置的计划
    // 依赖写盘前的自动快照（backup）还原，不要自己删文件
    return { changes: [], notes: ['TODO'] }
  },

  async status(): Promise<AdapterStatus> {
    // 检查当前状态：是否已接入 ModelDock？指向哪个 gateway？
    return { installed: false, attached: false, pointing: 'unknown', detail: 'TODO' }
  },
}
```

### 3. 在 registry 注册

打开 `src/adapters/registry.ts`：

```typescript
import { myClientAdapter } from './my-client.js'

function builtins(): HarnessAdapter[] {
  return [
    // ... 现有适配器 ...
    myClientAdapter,
  ]
}
```

### 4. 写测试

在 `test/adapters/`（或适配器旁新建 `*.test.ts`）写测试：

```typescript
import { describe, expect, it } from 'vitest'
import { myClientAdapter } from '../../src/adapters/my-client.js'

describe('my-client adapter', () => {
  it('detect', async () => {
    const r = await myClientAdapter.detect()
    expect(r.installed).toBeTypeOf('boolean')
    expect(r.configFiles).toBeInstanceOf(Array)
  })

  // planAttach / planDetach / status 同理
})
```

### 5. 验证

```bash
npm test           # 全绿
npm run build      # tsc 编译通过（尤其检查 import 路径）
```

## 设计约束（不要踩的坑）

- **planAttach / planDetach 只返回计划，不执行修改**。实际修改由调用方统一执行——保持 adapter 纯函数化。
- **不要绕过 backup 机制**。断开时还原靠 `src/backup/` 的快照，不要自己恢复文件——用户可能在做其他改动。
- **路径统一走 `src/util/paths.ts`**。不要硬编码 `~/.config` / `~/Library/Application Support` 等路径。
- **detect 不要抛异常**。找不到客户端是正常状态，返回 `installed: false` 即可。
- **planDetach 允许返回空计划**。如果客户端从未 attach 过（没有快照），返回 `changes: []` 即可，不要报错。

## 何时用 L2 Pack 替代手写 Adapter

如果客户端的配置方式可以通过 "声明式 pack" 描述（固定路径、固定格式、简单替换），不需要写 TypeScript adapter：

1. 在 `~/.modeldock/config.toml` 里添加 `[adapter_packs.<id>]` 配置（格式见 `src/adapters/packs.ts`）。
2. pack adapter 会自动从配置解析出 `detect / planAttach / planDetach / status` 行为。

参考已有 pack 的用法，比手写 adapter 快得多。只有 pack 覆盖不了时才手写 adapter。

---

## 可直接复制的 Adapter 骨架模板

把下面这段完整复制为 `src/adapters/<client-id>.ts`，替换尖括号内容：

```typescript
import fs from 'node:fs/promises'
import path from 'node:path'
import type { AttachOptions, AdapterStatus, DetectResult, HarnessAdapter, PlanResult } from './types.js'
import { modeldockDir } from '../util/paths.js'

/**
 * <客户端名称> 适配器
 * 调研结果：
 * - 配置文件：<路径，如 ~/.config/myclient/config.yaml>
 * - 格式：<YAML / JSON / TOML>
 * - 接入协议：<openai / anthropic / generic>
 * - 密钥管理：<配置文件明文 / keychain / 环境变量>
 */
export const <clientId>Adapter: HarnessAdapter = {
  id: '<client-id>',
  label: '<Client Name>',

  async detect(): Promise<DetectResult> {
    const configDir = path.join(modeldockDir(), '..', '<client-config-dir>')  // 根据实际路径调整
    const configFile = path.join(configDir, '<config-file>')

    try {
      await fs.access(configFile)
      return {
        installed: true,
        configFiles: [configFile],
        note: '<客户端> 已安装',
      }
    } catch {
      return {
        installed: false,
        configFiles: [],
        note: '未找到 <客户端> 配置文件',
      }
    }
  },

  async planAttach(opts: AttachOptions): Promise<PlanResult> {
    const { gatewayUrl, token } = opts  // gatewayUrl 如 http://127.0.0.1:8687

    // 根据客户端配置格式生成修改计划
    // 示例：YAML 格式（参考 claude-code.ts）
    const changes = [
      {
        file: path.join(modeldockDir(), '..', '<client-config-dir>', '<config-file>'),
        action: 'merge' as const,  // merge = 合并修改，overwrite = 覆盖
        content: `
# 接入 ModelDock 网关
base_url: ${gatewayUrl}/v1
api_key: ${token}
`,
      },
    ]

    return {
      changes,
      notes: [
        '接入后 <客户端> 将使用 ModelDock 网关统一管理和路由模型',
        '断开时会自动恢复原配置（基于写盘前快照）',
      ],
    }
  },

  async planDetach(opts: AttachOptions): Promise<PlanResult> {
    // 依赖 backup 机制自动还原，这里只需要标记哪些文件需要还原
    const configFile = path.join(modeldockDir(), '..', '<client-config-dir>', '<config-file>')

    return {
      changes: [
        {
          file: configFile,
          action: 'restore' as const,  // restore = 从快照还原
        },
      ],
      notes: ['断开后将恢复 <客户端> 原始配置'],
    }
  },

  async status(): Promise<AdapterStatus> {
    const detected = await this.detect()
    if (!detected.installed) {
      return {
        installed: false,
        attached: false,
        pointing: 'unknown',
        detail: '<客户端> 未安装',
      }
    }

    // 检查配置文件是否指向 ModelDock 网关
    const configFile = detected.configFiles[0]
    try {
      const content = await fs.readFile(configFile, 'utf-8')
      const isAttached = content.includes('127.0.0.1:8687') || content.includes('modeldock')

      return {
        installed: true,
        attached: isAttached,
        pointing: isAttached ? 'modeldock' : 'upstream',
        detail: isAttached ? '已接入 ModelDock' : '未接入 ModelDock',
      }
    } catch {
      return {
        installed: true,
        attached: false,
        pointing: 'unknown',
        detail: '无法读取配置文件',
      }
    }
  },
}
```

### 模板使用步骤

1. 复制模板到 `src/adapters/<client-id>.ts`。
2. 替换所有 `<尖括号>` 占位符。
3. 根据客户端实际的配置格式调整 `planAttach` 中的 `changes` 生成逻辑：
   - **YAML**：参考 `claude-code.ts`，用 `yaml` 库操作保留注释
   - **JSON**：参考 `codex.ts`，用 `JSON.parse` / `JSON.stringify`
   - **TOML**：参考 `dsh.ts`，手动拼接或解析
4. 在 `registry.ts` 注册（见上方「在 registry 注册」）。
5. 写测试（见上方「写测试」）。
6. `npm test` + `npm run build` 验证。
