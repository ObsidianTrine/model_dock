# incident-response（网关故障排查工作流）

8687 生产实例出问题时，在不碰它的前提下定位、复现、修复。

> **何时用**：用户反馈"网关不转了 / 报错 / 模型不通"，需要排查本机网关问题时。
> **第一红线**：**绝不停机、重启、kill 8687 上的进程**。排查全程 8687 必须保持在线。
> **第二红线**：对 8687 只允许**只读诊断**（`lsof` 查监听、看日志文件）——打它的接口、开它的 Web 页面、改它的配置或密钥、起/停任何形式的实例，全部禁止；复现一律在自己独立的沙箱实例做（见步骤 2）。**8890 是用户专属 dev 沙箱端口，agent 一律不得占用**（不启动、不 stop、不动 `~/.modeldock-dev` 数据）；`scripts/run_dev.sh` / `run_dev.bat` 默认落 8890，agent 不要用它们起排查实例。

## 流程

### 1. 先收集信息，不动任何东西

- 问清现象：什么客户端、什么操作、报什么错、什么时候开始。
- 看 8687 是否在监听（只读，允许）：
  ```bash
  # Windows
  netstat -ano | findstr :8687
  # Unix
  lsof -nP -iTCP:8687 -sTCP:LISTEN
  ```
- 看网关日志（日志目录见 `.agents/workflow.json` 的 `gatewayLogDir`，本仓库为 `~/.modeldock/logs`），或让用户在 Web 控制台复现一次并截图报错。

### 2. 在隔离沙箱实例复现（端口 + 沙箱成对指定）

```bash
# 唯一合法配方：独立沙箱目录 + 189xx 端口，两者必须成对出现
MODELRDOCK_FAKE_HOME=/tmp/modeldock-ir-$$ npx tsx src/cli.ts gateway start --port 18990   # Unix
# Windows (PowerShell)
$env:MODELRDOCK_FAKE_HOME="$env:TEMP\modeldock-ir"; npx tsx src/cli.ts gateway start --port 18990
```

- 只换端口不换沙箱会落进用户 dev 壳 `~/.modeldock-dev`，与用户 dev 实例互撞——**端口与 `MODELRDOCK_FAKE_HOME` 必须成对指定**。
- 复现用的配置与密钥（两个合法来源）：
  1. **自造**（推荐，状态可控）：先用 `mutateConfig()` + `setSecret(id, key, 'file')` 种一套服务/路由；
  2. **只读拷贝生产配置**（绝不改原件）：`mkdir -p $SB/.modeldock && cp ~/.modeldock/config.toml $SB/.modeldock/`，有 `secrets.json` 一并拷；**务必不要拷 `gateway.json`**——它含旧 pid / 端口 / 令牌，会让新实例误判"已在运行"。
- **复现成功** → 问题在代码或配置，进入步骤 3。
- **复现失败（18990 正常）** → 问题可能是 8687 实例的进程状态（如内存泄漏、句柄耗尽）。仍**不要重启 8687**——先对比两个实例的行为差异，收集足够信息后再决定是否建议用户手动重启。

### 3. 定位根因

- 对照日志和复现路径，找到出问题的代码位置。
- 常见根因方向：上游 API 变更、配置格式错误、密钥过期、端口冲突（用户又起了一个实例）。

### 4. 修复（走 feature-branch 或 hotfix）

- 非紧急（有变通办法）：走 `feature-branch.md` 正常排期修复。
- 紧急（生产完全不可用）：走 `hotfix.md` 基于 main 快速修复发版。

### 5. 验证修复

- 在自己的沙箱实例（`MODELRDOCK_FAKE_HOME` + 189xx）验证修复生效。
- **不要**为了验证去重启 8687——让用户自己决定何时重启生产实例。

### 6. 清理

- 停掉本次排查拉起的所有临时实例和进程（沙箱网关、mock 上游等；后台启动的进程不会随会话结束自动退出，按 PID / 端口自行清理）。
- 删除临时沙箱目录。
- 核实：
  ```bash
  # 确认临时端口已释放
  netstat -ano | findstr :18990   # Windows
  lsof -nP -iTCP:18990 -sTCP:LISTEN  # Unix
  # 确认无残留 node 进程
  ```

## 常见误判对照

| 现象 | 容易误判为 | 实际常见原因 |
|---|---|---|
| 客户端报 401 | 网关 bug | 上游 API Key 过期 |
| 客户端报 404 | 网关路由错 | 上游 base_url 或模型别名配错 |
| 网关不响应 | 需要重启 8687 | 另一个进程占了端口，或配置语法错误导致启动失败 |
| 模型列表为空 | 代码 bug | 上游 API 变更了模型列表接口 |

---

## 完整示例：排查"所有请求返回 502"

用户反馈：Claude Code 指向 8687 网关后，所有聊天请求都报 502 Bad Gateway，昨天上午还正常。

### 步骤 1：收集信息（8687 只读）

问用户确认：
- 客户端：Claude Code（最新版）
- 操作：所有对话请求
- 报错：`502 Bad Gateway`，响应体为空
- 开始时间：今天早晨开始，昨天正常
- 8687 是否在监听？

```bash
# Windows
$ netstat -ano | findstr :8687
  TCP    127.0.0.1:8687         0.0.0.0:0              LISTENING       12345
# ✅ 8687 在监听，进程 PID 是 12345
```

看 `~/.modeldock/logs` 下日志或让用户在 Web 控制台查看，发现大量：

```
[ERROR] upstream connect failed: connect ECONNREFUSED 142.250.x.x:443
```

### 步骤 2：隔离沙箱复现

拷一份生产配置到独立沙箱（只读拷贝，不拷 `gateway.json`），起 18990 实例：

```bash
$ SB=/tmp/modeldock-ir-502
$ mkdir -p $SB/.modeldock && cp ~/.modeldock/config.toml $SB/.modeldock/
$ cp ~/.modeldock/secrets.json $SB/.modeldock/ 2>/dev/null   # 有才拷
$ MODELRDOCK_FAKE_HOME=$SB npx tsx src/cli.ts gateway start --port 18990
# Gateway listening on 127.0.0.1:18990 ✅
```

用一个测试 token 复现（不要动 8687）：

```bash
$ curl -X POST http://127.0.0.1:18990/v1/chat/completions \
    -H "Authorization: Bearer test-token" \
    -d '{"model":"gpt-4","messages":[{"role":"user","content":"hi"}]}'
# 502 Bad Gateway ✅ 成功复现
```

### 步骤 3：定位根因

复现成功，说明不是 8687 实例的进程问题，是代码或配置的问题。

检查沙箱里拷来的 upstream 配置：

```bash
$ cat $SB/.modeldock/config.toml
[profiles.default]
provider = "openai"
```

检查 provider 预设：

```bash
$ curl http://127.0.0.1:18990/providers
# 发现 "openai" 的 base_url 是 `https://api.openai.com/v1`（默认的）
```

查看沙箱实例日志，发现 upstream 地址指向了一个 IP（142.250.x.x），但实际 ping openai.com 返回了不同 IP。结合用户说"昨天正常"，推测可能是 DNS 缓存或上游 API 变更了 endpoint。

实际上，更可能的原因是：用户之前修改了系统 hosts 文件，把 `api.openai.com` 指向了一个已失效的 IP，昨天这个 IP 还行，今天不行了。

或者，查看 18990 的详细日志发现：

```
[ERROR] upstream response 403: You are not authorized to use this model
```

这说明连接正常，但 API Key 被上游拒绝了——可能是 Key 过期了，或者用户换了一个不支持的 model。

### 步骤 4：修复

假设根因是**上游 API Key 过期**（日志显示 403）：

- 告知用户需要更新 OpenAI API Key（这是对生产配置的写操作，由用户执行或在用户明确授权后执行）：
  ```bash
  modeldock provider set-key <服务 id>
  ```
- 不需要改代码，不是 bug。

假设根因是**hosts 文件指向失效 IP**（日志显示 ECONNREFUSED）：

- 让用户检查并清理 hosts 文件中 `api.openai.com` 的静态映射。
- 仍然不需要改代码。

假设根因是**代码 bug**（上游接口响应格式变了）：

- 走 `feature-branch.md` 修复，发版前在沙箱实例验证修复生效。

### 步骤 5：验证修复

对于 Key 过期场景（用户已更新 key）：

```bash
# 在沙箱实例重新测试（必要时把新 key set 进沙箱的 secrets）
$ curl -X POST http://127.0.0.1:18990/v1/chat/completions \
    -H "Authorization: Bearer 新token" \
    -d '{"model":"gpt-4","messages":[{"role":"user","content":"hi"}]}'
# {"choices": [{"message": {"content": "Hello!"}}]} ✅
```

修复验证通过，**不重启 8687**——让用户自己选择何时重启生产实例（或者等发版后自动更新）。

### 步骤 6：清理

```bash
# 停止 18990 沙箱实例（gateway stop 按 MODELRDOCK_FAKE_HOME 里的 gateway.json 寻址，不带 --port）
$ MODELRDOCK_FAKE_HOME=$SB npx tsx src/cli.ts gateway stop

# 确认端口释放
$ lsof -nP -iTCP:18990 -sTCP:LISTEN
# (无输出) ✅

# 删除临时沙箱
$ rm -rf $SB
```

写入 worktree NOTES.md 的已知坑：排查时容易误以为是 8687 进程挂了，实际是先检查 upstream 连接状态和 API Key 有效性。
