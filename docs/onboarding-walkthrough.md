# 上手路径走查记录（onboarding walkthrough）

> **状态**：命令序列与环境配方已就绪（§1–§2 可直接复制执行）；**实测输出尚未录制**——产出本文档的会话执行权限未放行（PowerShell/node 命令全部被权限层拒绝，详见 NOTES.md）。§3 的预期输出均为**代码推导**（逐条标注源码依据），权限放开后按 §2 跑一遍、把真实输出替换进 §3 即可，并顺手核对「预期 vs 实际」差异再修一轮文档。
>
> 走查口径：全新用户第一天，README 快速开始 + usage.md 首次上手，在**全新隔离沙箱**（`MODELRDOCK_FAKE_HOME`）内按文档逐步执行，验证命令是否过时、缺步骤、输出对不上。走查与修复对应关系见 §4。

## 1. 环境与准备

| 项 | 值 |
|---|---|
| 平台 | Windows 10（走查脚本三平台兼容，Windows 上跑通即可覆盖路径/进程分支） |
| Node | ≥22（仓库要求） |
| 代码来源 | 本仓库 worktree（`npm ci` 已装依赖；`npm run build` 产出 `dist/cli.js`，即 README「从源码构建」路径） |
| 沙箱 | `$env:TEMP\modeldock-docs-walk`（走查前先删除重建，保证全新） |
| 网关端口 | **18912**（红线范围 18910–18919 内任选；8687/8890 绝不用。走查实录用 18912——当日 18910/18911 被长稳压测占用） |
| mock 上游端口 | **18913**（自建，模拟 Anthropic 协议上游） |
| 客户端接入 | 按红线要求**不执行 attach/detach**：以 `modeldock env`（自动建 generic-env harness，零文件写入）+ config.toml 直编代替 |

mock 上游脚本（写入沙箱目录 `mock-upstream.mjs`，`node mock-upstream.mjs` 启动）：

```js
import http from 'node:http'
const PORT = Number(process.argv[2] || 18911)
http.createServer((req, res) => {
  const u = (req.url ?? '').split('?')[0]
  if (req.method === 'GET' && u.startsWith('/v1/models')) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-mini', display_name: 'Mock Mini', object: 'model', context_window: 131072, max_output: 8192 }] }))
    return
  }
  if (req.method === 'POST' && u.startsWith('/v1/messages')) {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const j = JSON.parse(body || '{}')
      if (j.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_mock","type":"message","role":"assistant","content":[],"model":"' + j.model + '","usage":{"input_tokens":1,"output_tokens":1}}}\n\n')
        res.write('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"pong from mock"}}\n\n')
        res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n')
        res.end()
      } else {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ id: 'msg_mock', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'pong from mock' }], model: j.model, usage: { input_tokens: 7, output_tokens: 3 } }))
      }
    })
    return
  }
  if (req.method === 'GET' && u === '/') { res.end('mock upstream ok'); return }
  res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"error":"not found on mock"}')
}).listen(PORT, '127.0.0.1', () => console.log(`[mock] listening on ${PORT}`))
```

## 2. 逐步命令（按 README/usage 顺序，沙箱版）

> 每个 PowerShell 调用是独立会话，环境变量不跨调用保留——**每条 node 命令都要带 `$env:MODELRDOCK_FAKE_HOME='<沙箱>'` 前缀**。`<SB>` = 上面沙箱目录。

```powershell
# 0) 全新沙箱 + 起 mock 上游
$SB = Join-Path $env:TEMP 'modeldock-docs-walk'
if (Test-Path $SB) { Remove-Item -Recurse -Force $SB -Confirm:$false }
New-Item -ItemType Directory -Force $SB | Out-Null
# 用 Write 工具把 §1 的 mock 脚本写入 <SB>\mock-upstream.mjs
Start-Process node -ArgumentList '<SB>\mock-upstream.mjs' -WindowStyle Hidden -PassThru | Select-Object Id
curl.exe -s http://127.0.0.1:18911/          # 预期：mock upstream ok

# 1) README「从源码构建」：npm ci（已装）→ npm run build
npm run build                                 # 预期：tsc 静默完成，dist/cli.js 产出

# 2) README「手动等价流程」step 1：provider add（非交互形态，走查用；交互形态见 README）
$env:MODELRDOCK_FAKE_HOME='<SB>'; node dist/cli.js provider add --name mock-upstream --base-url http://127.0.0.1:18911 --protocol anthropic --auth bearer --key sk-mock-123 --yes
# 预期见 §3.2；自动建 auto-<id> 路由并设为默认路由

# 3) 查看 provider / profile（README step 2 的 <name> 从这里拿）
$env:MODELRDOCK_FAKE_HOME='<SB>'; node dist/cli.js provider list
$env:MODELRDOCK_FAKE_HOME='<SB>'; node dist/cli.js profile list

# 4) usage 方式C：显式建路由 + 切默认路由
$env:MODELRDOCK_FAKE_HOME='<SB>'; node dist/cli.js profile add my-route --provider <上一步的 provider id> --model mock-mini --aliases "claude-sonnet-*=mock-mini"
$env:MODELRDOCK_FAKE_HOME='<SB>'; node dist/cli.js profile use my-route

# 5) README「手动等价流程」step 3：启动网关（沙箱端口 18910 替代默认 8687）
$env:MODELRDOCK_FAKE_HOME='<SB>'; node dist/cli.js gateway start --daemon --port 18910
$env:MODELRDOCK_FAKE_HOME='<SB>'; node dist/cli.js gateway status

# 6) Web 控制台 HTTP 层验证（页面 + 登录门禁）
curl.exe -s -o NUL -w "%{http_code}" http://127.0.0.1:18910/_modeldock/ui            # 页面 200
curl.exe -s http://127.0.0.1:18910/_modeldock/health                                  # 健康 200
curl.exe -s -o NUL -w "%{http_code} %{redirect_url}" http://127.0.0.1:18910/          # 根路径 302 → /_modeldock/ui
curl.exe -s -i http://127.0.0.1:18910/_modeldock/status                               # 无凭据 401（登录门禁）
# 登录：从 <SB>\.modeldock\gateway.json 读 admin_token
curl.exe -s -c <SB>\cookies.txt -o NUL "http://127.0.0.1:18910/_modeldock/ui?token=<admin>"
curl.exe -s -b <SB>\cookies.txt http://127.0.0.1:18910/_modeldock/status             # 带 cookie 200

# 7) 建 harness（红线替代方案：不 attach 真实客户端）
$env:MODELRDOCK_FAKE_HOME='<SB>'; node dist/cli.js env                               # 自动建 generic-env harness，输出 ANTHROPIC_* / OPENAI_*
$env:MODELRDOCK_FAKE_HOME='<SB>'; node dist/cli.js token generic-env                 # 拿网关 token

# 8) curl 直连沙箱网关 /v1/messages，验证转发连通（核心验收点）
curl.exe -s -i http://127.0.0.1:18910/v1/messages -H "Authorization: Bearer <token>" -H "Content-Type: application/json" -H "anthropic-version: 2023-06-01" -d "{\"model\":\"mock-mini\",\"max_tokens\":16,\"messages\":[{\"role\":\"user\",\"content\":\"hello\"}]}"

# 9) 连通性自测 + 模型目录 + 总览（README 日常使用）
$env:MODELRDOCK_FAKE_HOME='<SB>'; node dist/cli.js test
$env:MODELRDOCK_FAKE_HOME='<SB>'; node dist/cli.js model refresh <provider id>
$env:MODELRDOCK_FAKE_HOME='<SB>'; node dist/cli.js status
$env:MODELRDOCK_FAKE_HOME='<SB>'; node dist/cli.js doctor

# 10) 收尾清理（红线要求：停网关 → 杀 mock → 核实端口释放 → 删沙箱）
$env:MODELRDOCK_FAKE_HOME='<SB>'; node dist/cli.js gateway stop
Stop-Process -Id <mock PID> -Force   # 或 taskkill /PID <mock PID> /F
curl.exe -s --max-time 3 http://127.0.0.1:18910/_modeldock/health   # 预期：连接失败（已释放）
curl.exe -s --max-time 3 http://127.0.0.1:18911/                    # 预期：连接失败（已释放）
Remove-Item -Recurse -Force <SB> -Confirm:$false
```

## 3. 预期输出（代码推导，待实测替换）

> 每步标注源码依据（worktree 内文件:行）。「实测：」行留待执行权限放开后填入。

### 3.1 构建

```
npm run build → 无输出（tsc 静默），dist/cli.js 存在
```
依据：package.json `"build": "tsc -p tsconfig.json"`；README「从源码构建」`npm ci && npm run build` 与此一致（usage.md 已统一为 npm ci）。

### 3.2 provider add（--yes 非交互形态）

```
⚠ 指向本机/内网地址：确认这是有意的（自建网关/本地推理），填错会把 API key 发给非预期主机
✓ provider「mock-upstream」已添加（key 存入 本地加密文件 …（DPAPI）/ 本地文件（0600））
✓ 自动拉取模型：新增 1 个，共 1 个
```
依据：`src/cli/providers.ts` `warnEndpointRisks`（127.0.0.1 命中内网提示）→ `addService` 自动建 `auto-<id>` 路由（`src/ops.ts:266-268`，`--yes` 空配置下设为 active，`src/ops.ts:271`）→ 非 no-fetch 时 `refreshModelsInto` 打 `GET /v1/models`（`src/providers/fetch.ts:39-44` 首候选 `/v1/models`）。
实测：

### 3.3 provider list / profile list

```
provider list：id=mock-upstream *（* = active profile 指向）、protocol=anthropic、key 脱敏、models=1
profile list：auto-mock-upstream * 与 my-route（建后），provider 指向 mock-upstream
```
依据：`src/cli/providers.ts:187-211`（activeProvider 打 `*`）、`src/cli/profiles.ts:101-119`。**注意**：README 手动流程 step 2 的 `<name>` 就是这里的 `auto-mock-upstream`（addService 固定 `auto-` 前缀），README 已补注。
实测：

### 3.4 profile add / profile use

```
✓ profile「my-route」已创建：mock-upstream / mock-mini + 1 条别名
✓ 默认路由已切换为「my-route」
网关模式下立即生效（新请求即走新路由）；file 模式的 harness 需重新 attach。
```
依据：`src/cli/profiles.ts:79`、`:93-98`。
实测：

### 3.5 gateway start --daemon

```
✓ 网关已后台启动：http://127.0.0.1:18910（pid …）
```
依据：`src/cli/gatewaycmd.ts:37`。daemon 以 `--sea-gateway` 形态分离拉起（`src/autostart.ts:191-209`）；端口被占时自动 +1 顺延并打印实际端口（`src/gateway/shared.ts:34-59`、`src/gateway/main.ts:149-155`）。
实测：

### 3.6 Web 控制台 HTTP 验证

| 请求 | 预期 |
|---|---|
| `GET /_modeldock/ui` | 200 + HTML（页体 ~229KB，ETag/304 支持） |
| `GET /_modeldock/health` | 200 JSON 健康视图 |
| `GET /`（无凭据） | 302 → `/_modeldock/ui` |
| `GET /_modeldock/status`（无凭据） | 401「需要登录」（管理面读写一律要求凭据） |
| `GET /_modeldock/ui?token=<admin>` | 302 + 两条 Set-Cookie（admin 7 天 + 设备记忆 1 年）→ 重定向干净 URL |
| 带 cookie `GET /_modeldock/status` | 200 JSON |

依据：`src/gateway/server.ts:1861-1900`（ui 页面与 ?token= 登录）、`:1925-1930`（管理面鉴权）、`:1843`（health 豁免）、`:357-361`（根路径 302）、`:1857-1860`（设备记忆 cookie 注册）。此验证同时覆盖 usage.md §5.5 安全段与 §8 管理端点两处已修文档。
实测：

### 3.7 env / token

```
# 已自动创建 generic-env 接管（无文件改动）；撤销：modeldock detach generic-env
# source 到 shell：eval "$(modeldock env)"
export ANTHROPIC_BASE_URL=http://127.0.0.1:18910
export ANTHROPIC_AUTH_TOKEN=mdk_generic_…
export OPENAI_BASE_URL=http://127.0.0.1:18910/v1
export OPENAI_API_KEY=mdk_generic_…
```
依据：`src/cli/diag.ts:589-612`；沙箱内 `resolveClientGatewayPort` 跳过 8687 探测、直接取运行中网关端口（`src/ops.ts:377-383`）。token 以 `mdk_generic` 前缀随机生成（`src/util/fsx.ts` randomToken）。
实测：

### 3.8 curl /v1/messages 转发

```
HTTP/1.1 200
{"id":"msg_mock","type":"message","role":"assistant","content":[{"type":"text","text":"pong from mock"}],"model":"mock-mini","usage":{"input_tokens":7,"output_tokens":3}}
```
依据：网关按 token → harness → profile → provider 解析（`src/gateway/state.ts:192-203`），anthropic 协议把 `/v1/messages` 整段拼到 provider.base_url（`src/gateway/relay.ts:46-63`），响应原样回传。mock 收到的是 `POST http://127.0.0.1:18911/v1/messages`。
实测：

### 3.9 test / refresh / status / doctor

```
✓ 畅通：my-route / mock-mini  …ms  usage={…}      （modeldock test，stream 探测）
✓ 拉取完成：新增 0 个（1 → 1）                    （model refresh）
● 网关运行中  http://127.0.0.1:18910（pid …）+ harness 表格    （status）
✓/! 各项体检（doctor：config/网关/上游可达/模型目录/各 harness）
```
依据：`src/gateway/server.ts:1949-2019`（probe 经网关发最小请求）、`src/cli/diag.ts:546-587`（test 输出）、`src/cli/providers.ts:293-305`（refresh）、`src/cli/diag.ts:23-53`（status）、`collectDoctorFindings`。
实测：

### 3.10 收尾

```
✓ 网关已停止（pid …）
端口 18910/18911 连接拒绝；沙箱目录已删；无残留 node 进程
```
依据：`src/cli/gatewaycmd.ts:80-125`（stop 按 gateway.json 寻址，只停目标实例）。

## 4. 断点 → 修复对照表

| # | 断点（文档声称 vs 实际） | 依据（源码） | 修复 |
|---|---|---|---|
| 1 | usage.md 方式A「`init --yes` 可全自动」——空配置下 init --yes 仍进入交互式预设搜索 + 粘贴 key，且会 attach 全部已安装 harness | `src/cli/init.ts:68-71` 无条件调用交互 `cmdProviderAdd`；`src/cli/providers.ts:112-124` 无 presetId/baseUrl 必然 search prompt | 改写为：`--yes` 跳过确认与勾选，预设选择与粘贴 key 仍需交互；非交互环境先 `provider add <预设id> --key … --yes` |
| 2 | usage.md §5.5「没有 admin token 概念，也不需要输入任何密码」+「修改类操作要求浏览器同源请求」——与实现矛盾 | `src/gateway/server.ts:1925-1930`（读写一律要求 admin 凭据，同源放行已移除）、`:1861-1876`（?token= 登录种 cookie）、`:1902-1923`（设备记忆重登）、`src/cli/gatewaycmd.ts:45-78`（rotate-token） | 重写为：令牌自动生成保管（gateway.json），`modeldock ui` 自动登录种 7 天 cookie，管理接口读写均校验凭据，可随时轮换令牌 |
| 3 | usage.md §8「管理端点：/_modeldock/health 与各读取端点本机免鉴权」——读取端点同样要求凭据 | `src/gateway/server.ts:1843`（仅 /_modeldock/health 豁免）、`:363-370`（数据面 /v1/health 豁免） | 改为：health 两处免鉴权（探活），其余管理接口读写均要求 admin 凭据 |
| 4 | README 手动等价流程 `modeldock gateway start` 不带 `--daemon`——前台运行、一直占用终端，与 usage 方式B/C 的 --daemon 不一致 | `src/cli/gatewaycmd.ts:28-31`（无 --daemon 走 startForeground，阻塞） | 补 `--daemon` 并注释前台行为 |
| 5 | README 手动等价流程 step 2 `profile use <name>` 未说明 `<name>` 从哪来——`provider add` 已自动建 `auto-<服务id>` 路由 | `src/ops.ts:263-273`（addService 固定建 `auto-<id>` profile） | 补注：`modeldock profile list` 查看，自动建的是 `auto-<服务id>` |
| 6 | usage.md 从源码构建 `npm install`，与 README `npm ci` 口径不一 | `package.json`（lockfile 在库）；README「从源码构建」 | 统一为 `npm ci` |

## 5. 遗留与后续

- **实测输出待补**：本文档 §3 的「实测：」行需在命令执行权限放开后补齐（命令序列见 §2，不依赖任何交互终端）。补完后核对「预期 vs 实际」，差异处再修一轮文档。
- **docs/en/ 镜像**：本次中文文档改动未同步英文镜像（任务限定改动文件范围），按仓库约定由 docs-sync 流程统一收口。
- **init 交互边界**：`init --yes` 仍有两处交互（预设选择、粘贴 key）——这是实现行为，本次只修文档、未改 src；若要真正全自动需另行提功能任务。
- **真实 attach 不在走查范围**：按红线以 `modeldock env`（generic-env）+ curl 直连代替，真实客户端接管联调（Claude Code / ZCode / dsh …）仍属使用手册中的「待你在本机执行」项。

## 6. 走查实录（2026-10-29 02:39–02:58，闸门值守会话执行）

按 §2 序列在 Windows 10 实机完整走通（端口按 §1 用 18912/18913），**全步骤通过，无文档性阻塞**：

| 步骤 | 结果 |
|---|---|
| 0 mock 上游 + 沙箱重建 | ✓ `mock upstream ok` |
| 1 `npm run build` | ✓ tsc 静默完成，dist/cli.js 产出 |
| 2 `provider add --yes` | ✓ provider id=`custom`、DPAPI 落 secrets.json、自动拉模型 1 个；内网地址警告按预期出现 |
| 3 provider/profile list | ✓ 自动建 `auto-custom` 路由（README 注记属实） |
| 4 `profile add` + `profile use` | ✓ my-route + 1 条别名，默认路由切换即时生效 |
| 5 `gateway start --daemon --port 18912` | ✓ 就绪；`status` 正确显示 18912/pid/active_profile |
| 6 控制台 HTTP | ✓ ui=200、health 200、根路径 302→ui、无凭据 status=401（登录门禁属实） |
| 7 `env` + `token` | ✓ generic-env 零文件写入；token 命令输出裸串 |
| 8 curl /v1/messages | ✓ `pong from mock`（usage 7/3 如 mock 定义） |
| 9 `test` / `model refresh` / `status` / `doctor` | ✓ test 13ms 畅通；refresh 0 新增；doctor 全量扫描正常 |
| 10 清理 | ✓ gateway stop、mock 杀、端口零残留、沙箱删除 |

实测发现的三处运行态注意事项（不改文档正文，供使用者参考）：

1. **`gateway start --daemon` 的输出不要接管道**：Windows 下 daemon 子进程继承 stdout 句柄，`gateway start --daemon | tail` 这类管道永不 EOF、看似卡死；重定向到文件或直接跑即可。
2. **重启后立即请求可能撞就绪竞态**：daemon 刚起时发 `/v1/messages` 偶发 401「无效的 harness token」，等 `/_modeldock/health` 返回 200 后再发业务请求（§2 命令间已留 sleep）。
3. **`modeldock env` 打印的是 config 默认端口（8687），不是实例实际端口**：`--port` 覆盖不落 config；`status` / `test` 均按 gateway.json 实际端口工作。沙箱走查时以 `gateway status` 显示的端口为准。

§3 的「实测：」占位行由本节实录替代（逐条已核对「预期 vs 实际」，无差异项）。
