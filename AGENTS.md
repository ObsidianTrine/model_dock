# ModelDock — 项目指南（AGENTS.md）

> 面向 AI 编码代理的项目说明（"给 agent 看的 README"）。章节结构参考 [agents.md 官方指南](https://agents.md/)：
> 项目概览 → 命令 → 端口约定 → 架构 → 代码结构 → 工程约定 → 回复风格 → 测试 → 多 Agent 并行 → 判定边界 → 已知限制 → 发布。
> 本文件是活文档：流程或端口策略变更后请同步更新。

## 项目概览

本地模型**配置托管中心 + API 网关**：把所有 AI 客户端（Claude Code / ZCode / dsh / Codex / …）的 `base_url` + API Key 收进 ModelDock 统一管理。客户端只需指向本机网关（当前生产实例为 `http://127.0.0.1:8687`），切换供应商 / 模型映射全在 ModelDock 侧完成、即时生效，客户端配置零改动。

**核心约束**：TypeScript（ESM，NodeNext），Node.js ≥22，**全部纯 JS 依赖、无 native addon**（SEA 单文件打包依赖此前提）。

## 命令速查

| 用例 | 命令 |
|------|------|
| 装依赖 | `npm install` |
| 编译到 `dist/` | `npm run build`（tsc） |
| 测试 | `npx vitest run <相关测试文件>`；**日常改动只跑与改动相关的用例，全绿即交付**（分层规则见「测试指南」） |
| 全量回归 | `npm test`（产品套件 test/*.test.ts）/ `npm run test:workflow`（编排器套件 test/orchestrator/**）——仅版本发布、develop→main 合并等大节点跑 |
| 覆盖率 | `npm run test:coverage` |
| 开发热跑 | `npm run dev -- <cmd>`（tsx 直跑源码，**无热重载**，改码后重启实例再验证） |
| 本机网关热重载 | `scripts/run_dev.bat`（Win）/ `run_dev.sh`（mac/Linux），默认端口 **8890**（用户 dev 端口）。完全沙箱化：配置/密钥/日志全在 `~/.modeldock-dev`（密钥本地 file，不写系统钥匙环；npm 全局安装重定向进沙箱；脚本类安装拒绝并提示手动），与生产互不影响。**用户本人日常验证专用——agent 一律不得占用其沙箱与 8890 端口**，测试走硬规则 2 的隔离配方 |
| SEA 可执行包 | `npm run build:sea`（产出 `release/` 下各平台**对外发布物**：压缩包（包内单一入口程序，unix 名 `modeldock`）+ `SHA256SUMS`；darwin 另产 `ModelDock.app` + `.dmg`；win 另产 Inno Setup `*-setup.exe`；裸二进制只作构建中间产物，不外发） |
| 一键发布（tgz + 可执行 + 安装包） | 双击 `scripts/build.bat`（Win）/ `build.sh`（mac/Linux），或 `node scripts/build-all.mjs` |

> 版本号**唯一事实来源是 git tag**（构建中临时改 `src/version.ts` + `package.json` 后自动还原）。不要手动维护文件里写死的版本号。

## 端口与实例约定（务必遵守）

| 端口 | 角色 | 说明 |
|------|------|------|
| **8687** | **生产端口（本机常驻实例）** | 代码默认 `DEFAULT_GATEWAY_PORT`；用户日常使用的网关实例监听于此，必须保持在线 |
| **8890** | **用户 dev 沙箱端口（run_dev 默认）·用户专属** | 完全沙箱化（`~/.modeldock-dev`）。**agent 一律不得占用**：不启动、不 stop、不删数据；测试实例统一走 **189xx + 独立沙箱**（见硬规则 2） |

> ### ⛔ 8687 是生产实例：agent 一律禁止用于测试
> **任何形式的测试/验证/改动都不许打到 8687**：起实例、stop/kill/重启、改配置或密钥、打接口/开页面、当验证目标、把 8687 写进测试脚本或示例——全部禁止。只读诊断（用户报障时的 `lsof`/日志查看）除外，且不得附带写操作。
> **测试只在 agent 自己的沙箱**：唯一配方 `MODELRDOCK_FAKE_HOME=<独立目录> MODELRDOCK_TEST=1 npx tsx src/cli.ts gateway start --port 189xx`。**8890 用户专属 dev 沙箱同样不得占用**。
> 误用高发原因：8687 是代码默认端口且常驻在线——测试命令必须显式带 `--port 189xx` + `MODELRDOCK_FAKE_HOME`，命令里出现 8687 就立刻换沙箱端口。

**改功能做测试时的硬规则：**

1. **8687 全面禁止（不止"不得关闭"）**：任何写操作或测试性访问全部禁止；测试期间 8687 必须始终在线且零打扰。
2. **测试一律在沙箱（端口 + 沙箱成对指定）**：单测用 `listen(0)` 随机端口；手测/临时实例用上方隔离配方。**agent 只用 189xx**，且必须与 `MODELRDOCK_FAKE_HOME` 成对——只换端口不换沙箱会落进 `~/.modeldock-dev`，与用户 dev 实例同壳互撞单实例保护（一方静默拒绝启动、页面连接被拒却无报错）。**测试数据两个合法来源**：① 自造（推荐）：`export MODELRDOCK_FAKE_HOME=<沙箱>` 后用种子脚本调 `mutateConfig()` + `setSecret(id, key, 'file')`（脚本内先设 env 再动态 import 源码模块）；② 只读拷贝 dev 数据：`config.toml` + `secrets.json` 成对拷，**绝不拷 `gateway.json`**（含旧 pid/端口/令牌，会误判「已在运行」）；残留 keychain 引用首次启动自动落地为本地 file。不要用 `run_dev.sh/bat` 起测试实例。
3. **不做全量清扫**：多实例共存是常态（生产 8687 + dev/测试），`gateway stop` 只停目标实例；全量清扫游离网关仅在完整卸载时执行（`src/cli/basic.ts`）。
4. **测试结束清理自己拉起的全部进程**：网关实例、mock 上游等临时进程收尾前全部停止（后台启动的进程不会随会话退出；mock 上游不在实例注册表、`gateway stop` 管不到，按 PID/端口清），临时沙箱目录一并删除；**核实再收工**：`lsof -nP -iTCP:<port> -sTCP:LISTEN` 确认端口已释放、`ps aux | grep` 无残留。任务中断需交接的，把已拉起进程和端口写进 worktree 的 `NOTES.md`。

## 架构速览

```
客户端 (Claude Code / ZCode / dsh / Codex / ...)
   │  Bearer token 或 x-api-key
   ▼
网关 (127.0.0.1:8687 生产实例，即代码默认端口)
   │  token → harness → profile → provider
   │  模型别名重写、注入真实 key、代理选择
   ▼
上游 API (火山方舟 / DeepSeek / GLM / OpenAI / ...)
```

数据模型：`provider`（上游凭据）→ `profile`（路由：provider + 默认模型 + 别名映射）→ `harness`（客户端接入方式）。

## 代码结构（src/）

| 目录 | 职责 |
|------|------|
| `src/cli/` | CLI 子命令（commander），每文件一组命令 |
| `src/config/` | 配置存储（config.toml）、密钥（secrets.json）、类型定义 |
| `src/gateway/` | HTTP 网关、上游转发、运行态管理、Web 控制台 |
| `src/adapters/` | Harness 适配器（L1 内置 + L2 声明式 pack） |
| `src/backup/` | 写盘前自动快照 |
| `src/import/` | 从 cc-switch / Claude Code / dsh / ZCode 导入存量配置 |
| `src/mcp/` | MCP 配置只读盘点（CLI `mcp list` 与 doctor 安检的数据源；不做控制台页面与下发，见「判定边界」） |
| `src/presets/` | 内置 provider 预设库 |
| `src/providers/` | 上游模型目录拉取 |
| `src/util/` | 路径、原子写、终端颜色、diff、JSONPath |

**入口 `src/cli.ts` 三路分发（勿破坏）**：`--sea-gateway` 起网关守护进程；SEA 二进制无参数运行为 GUI；其余走 commander 正常 CLI。

## 工程硬性约定（非显而易见）

- **三平台兼容（Linux / macOS / Windows）**：CI 三大 OS 同跑一套测试，本机 macOS 全绿 ≠ Windows 绿；**每段改动交付前自问「Windows 上这段怎么走」**，涉及路径/文件/进程/shell 的改动逐项过：
  - **路径**：拼接解析一律 `path.join()` / `path.resolve()`（正则匹配分隔符写 `[\\/]`），**禁止手写 `/` 或 `\` 拼路径**（URL 例外，永远 `/`）；import 大小写与实际文件严格一致。
  - **文件**：NTFS 不认 `0o600`（断言按 `process.platform === 'win32'` 分支）；目标文件被占用时 rename/unlink 报 EBUSY/EPERM（覆盖写/删除要容忍重试或先关句柄）；文本比较/正则/hash 前归一化换行 `\r\n` → `\n`。
  - **进程**：Windows 无信号语义，`kill(pid, 'SIGTERM')` 是硬杀且管不到子进程树（停进程树用 `taskkill /T /F`）；枚举进程按既有 win32 分支（PowerShell CIM 见 `gatewaycmd.ts` 的 `listProcessLines`）；spawn 全局命令（npm/git/tsc）Windows 是 `.cmd` 包装，需 `shell: true` 或补后缀。
  - **平台分支**：行为差异一律 `process.platform` 显式分支；mac 验证不到 Windows 分支时，diff 里显式复查该分支逻辑再交付。
- **路径**：所有文件系统路径经 `src/util/paths.ts`，**禁止硬编码** `~/.modeldock`。测试用 `MODELRDOCK_FAKE_HOME` 重定向临时目录。
- **写盘**：一律 `atomicWrite()`（tmp + rename，权限 0600）；写前自动快照（边界：config.toml 自身由 .lock + 原子写保护；版本迁移类写盘与同步导入前快照到 backups/config/）。
- **SEA 检测**：用 `process.execPath` 文件名（开头 `modeldock`）判断，**不要**依赖 `sea-config.json` 的 `env` 或 `import.meta.url`（postject 注入下失效）。
- **适配器**：每个 harness 实现 `detect / planAttach / planDetach / status`；新增放 `src/adapters/` 并在 `registry.ts` 注册。L2 pack 经 `config.toml` 的 `[adapter_packs.*]` 零代码扩展。
- **配置格式**：`config.toml` 用户可直编（atomicWrite）；`secrets.json` 程序管理、勿手改；dsh/ZCode 的 YAML 用 `yaml` Document API 保留注释。`mutateConfig` 是整包重序列化，用户手写注释会被抹除（已知取舍，见 docs/known-issues.md CORRECT-03）。
- **预设扩展**：运行时预设 = 内置库 `src/presets/data.ts` 的 `BUILTIN_PRESETS` + 用户覆盖文件 **`~/.modeldock/presets.json`**（同名 `id` 覆盖、新 `id` 追加；缺失视为无自定义、格式错误阻断启动）。**新增 provider 不要只写内嵌，可复用的先落到 presets.json 机制。**
- **错误信息**：必须可操作，附修复建议。
- **双语文案**：用户可见文案一律经 `src/util/i18n.ts` 的 `t(中文, English, params?)`（中文原文即 key），**两个语言参数必须同写**；语言解析链 `--lang > MODELRDOCK_LANG > config.toml language > zh`，commander 分支须在 `buildProgram()` 前 `initLang()`。中文段输出须与既有文案逐字节一致（测试有中文断言）；注释、枚举值、程序比较用的字符串不走 t()；模块顶层常量禁直接求值 t()（用 getter/懒函数）。Web 控制台 `data-i18n="中文||English"` 机制独立存在，勿混用。长生命周期 Web 组件的 label/title **必须传惰性函数**且在 `applyLang()` 末尾补 `render()`（传字符串会把语言固化在加载时刻，2026-10 状态行 5 颗 pill 曾踩）。
- **Web UI 组件与令牌**：一律用 `.agents/conventions/ui-kit.md` 的令牌与组件，禁止写死样式值、禁止 pill 文字当开关；**组件库缺组件先提原型经用户审核，禁止绕过组件库写一次性样式**；机器门禁 `test/ui-lint.test.ts` 随 `npm test` 强制——改 UI 前读规范、改完门禁必须绿；特例走白名单登记。
- **弹层提示归宿（强制）**：Modal 开着时，其按钮触发的错误与提示一律写弹层底栏 msg 槽位（`.mferr` / `.testline`+语义色），**禁止走全局 toast**（磨砂遮罩 z-modal 100 会盖住 z-toast 50）；只有动作会关闭弹层/页面时反馈才写主页面左下角 toast；新弹层 foot 必须配 `{slot:'msg'}`；分流参考 `createOffer`（shareM）与 `updFail`（updM）；弹层内复制成功反馈 = 按钮图标/文案翻转。
- **对外文档与用户文案**（CHANGELOG / README / 报错与界面文案）：用户视角、一条一事、粗体点题、不写内部黑话。改前必读 `.agents/conventions/docs-writing.md`（README 遵循「README 结构蓝图」，新增内容按「文档体系」表先归位），收尾过 `.agents/workflows/docs-sync.md` checklist（含链接与截图可达性），英文镜像同一交付同步。
- **端口使用**：遵循上方「端口与实例约定」——**8687 任何形式的测试/访问/改动一律禁止**，**8890 一律不得占用**；测试统一 `MODELRDOCK_FAKE_HOME=<独立目录>` + `--port 189xx`。

## 回复风格约定

Agent 回复用户时（无论是否涉及本仓库代码）遵循以下规则，与代码交付同视为验收标准：

1. **第一句必须是直接答案或结论**，禁止任何开场白（"好的""当然""这是个好问题"一律不要）。
2. **固定结构**：结论 → 关键要点（最多 5 条）→ 必要细节；先重后轻，推测性内容标注"推测"。
3. **默认篇幅不超过 300 字**；用户说"展开讲"才允许写长。
4. **删除一切冗词**：道歉、"作为 AI"、结尾总结（"总之…""希望对你有帮助"）、复述用户的问题、对已确认内容的重复。
5. **短句 + 列表**，不写大段落；用户已懂的背景不再解释。
6. **信息不全时**，给出最可能的答案并注明假设，不用反问拖延；确需用户确认时，只问一个问题。

## 测试指南

- **测试范围分层（2026-11-02 定）**：日常代码修改**只跑与改动相关的测试用例**，全绿即交付——按文件过滤（`npx vitest run test/<文件>.test.ts`；编排器改动用 `npx vitest run -c vitest.workflow.config.ts test/orchestrator/<文件>.test.ts`），更窄再叠加 `-t "用例名关键词"`。**全量** `npm test` / `npm run test:workflow` 只在版本发布、develop→main 合并等大节点与 CI 门禁跑。注意下方 vitest 隔离模型：涉及跨文件 mock / 共享模块的改动，相关文件之外至少加跑一组组合文件（如 `uninstall.test` / `store.test`），避免「单独跑绿、组合跑红」。
- 套件：test/ 下 75+ 个文件（store / backup / adapters / gateway / util / import-scan / sync / cloud / diag / update / ui 门禁等，以 test/ 目录与 `npm test` 输出为准），均以 `fakeHome()` 隔离，`finally` 中 `h.restore()` 还原。
- **写入门禁**（2026-10-30 生产覆盖事故防线）：测试/agent 上下文进程（vitest 注入 `VITEST`、种子脚本显式 `MODELRDOCK_TEST=1`、**agent CLI 环境标记**——`ZCODE_*`/`CLAUDECODE` 等，见 `src/util/fsx.ts` AGENT_ENV_MARKERS）对真实 home（`~/.modeldock` 或 `MODELRDOCK_HOME`）的 `atomicWrite`/`withFileLock` 一律拒写并给可操作报错——**只看写入目标落点，不看沙箱 env 是否已配**；ModelDock 自家入口进程（cli.ts 三路分发）置受信写者标记不受误伤；有意写真实 home 的场景（当前仅 test/autostart.test.ts 的 win 真注册表用例）在用例内设 `MODELRDOCK_ALLOW_REAL_HOME_WRITE=1` 豁免。测试收尾必须 `await stopSyncEngine()` 再恢复 env（同步引擎长尾 tick 是两次事故的直接写手）。
- 单测一律 `server.listen(0)` 取随机端口，**绝不监听 8687 / 8890 / 任何写死端口**；手测沙箱配方见「端口与实例约定」。
- 文件权限断言按 `process.platform === 'win32'` 做平台分支（NTFS 不认权限位）。
- 新增/改动测试必须三大 OS 都能过：临时目录用 `os.tmpdir()` + `path.join()`，**不写死 `/tmp` 或盘符**；断言平台差异前先想 Windows（Windows CI 红多来自测试而非实现）。

### vitest 隔离模型：跨文件 mock 是雷区（必读）

`vitest.config.ts` 用 `isolate: false` + `poolOptions.forks.singleFork`：**所有测试文件在同一个子进程里串行跑，模块注册表与模块 mock 注册表全进程共享**。两条硬约束：

1. **同一个模块不要被两个测试文件 `vi.mock`**——谁生效取决于执行顺序，表现为「单独跑绿、一起跑红」（最典型：别的文件的断言突然收到 0 次调用）。
2. **不要用 `vi.clearAllMocks()` / `vi.restoreAllMocks()` 做跨用例清场**（会连其他文件的模块 mock 一起清/还原）；只清自己的：`vi.mocked(x).mockClear()`、`vi.spyOn(...).mockRestore()`。

要测的代码经 `src/cli/basic.ts` 这类「扇出很广」的模块触达网关/钥匙环/适配器时（`cmdReset`/`cmdUninstall` 是已知踩雷点），不要在同进程里调它：把可测纯逻辑抽成导出函数单独测，端到端行为走 **CLI 子进程 + 独立沙箱**：

```ts
// tsx 的 ESM loader 直跑 .ts 源码：免 shell、三平台一致（不要用 npx / .bin/tsx）
const loader = pathToFileURL(createRequire(path.join(ROOT, 'package.json')).resolve('tsx/esm')).href
spawnSync(process.execPath, ['--import', loader, path.join(ROOT, 'src', 'cli.ts'), 'reset', '--yes', '--deep'],
  { cwd: sandbox, env: { ...process.env, MODELRDOCK_FAKE_HOME: sandbox }, encoding: 'utf8', timeout: 120_000 })
```

判断方法：涉及多处共享模块的改动，**单独跑新文件绿 ≠ 全量绿**，必须组合跑（至少 `uninstall.test` / `update-cli.test` / `store.test`）。参考实现：`test/reset.test.ts`、`test/reset-cli.test.ts`。

## 多 Agent 并行开发约定（feature-branch 工作流）

本仓库的自治编排体系定名 **Dockmaster（坞长）**——任务卡进、合并出；agent 入口为 `/dockmaster` 技能（原 `/orchestrate`），操作手册见 `.agents/workflows/orchestrator.md`。

多个 agent 并行开发时，**禁止直接在 develop/main 上修改代码文件**（PreToolUse hook 拦截 Edit/Write）；**main 上连文档也禁止直改**——对外文档一律在 develop 上改（develop 非源代码类文档直改放行），main 只接受 develop / hotfix 合入。多机同步用 `git pull --rebase`。所有代码改动走 worktree 分支流程，完整规程见 **`.agents/workflows/feature-branch.md`**（动手前必读），由 `.agents/scripts/feature-branch.mjs` 支撑：

### 工作流索引（.agents/workflows/）

| 文件 | 场景 | 何时必读 |
|------|------|---------|
| `feature-branch.md` | 常规功能 / bug 修复开发 | **任何代码改动前必读** |
| `release.md` | 对外发布新版本（打 tag） | 发布前必读 |
| `hotfix.md` | 生产紧急修复（基于 main） | 线上严重问题必读 |
| `code-review.md` | 合并前独立审查 diff | 任何 `finish` 前建议读 |
| `incident-response.md` | 排查 8687 网关故障 | 用户反馈网关问题必读 |
| `dependency-upgrade.md` | 升级依赖 | 改 `package.json` 前必读 |
| `docs-sync.md` | 同步对外文档（CHANGELOG/README/AGENTS.md） | 任何 `finish` 前建议读 |
| `worktree-rescue.md` | 接管 / 清理中断的 worktree 任务 | `list` 显示残留任务时读 |
| `add-adapter.md` | 新增 harness 客户端适配器 | 新增 adapter 时读 |
| `add-preset.md` | 新增 provider 预设 | 新增供应商时读 |
| `orchestrator.md` | **Dockmaster（坞长）**自治编排操作手册：任务卡进、合并出（速查 + A 核心闭环 / B 自主模式 / C 观测对账 / D 周边） | 写任务卡 / 跑编排 / 处理 blocked 任务时读 |

### feature-branch 核心命令

```bash
node .agents/scripts/feature-branch.mjs start <task-id>   # 开分支+worktree（基于 develop）→ .agents/worktrees/<task-id>
node .agents/scripts/feature-branch.mjs finish <task-id>  # rebase 最新 develop → 测试 → --no-ff 合并 → 清理（冲突按提示在 worktree 内解决后重跑）
node .agents/scripts/feature-branch.mjs list              # 查看在跑任务
```

- `task-id` 用小写短横线短词（如 `fix-presets-merge`）。
- **start 即认领（claim-before-execute）**：队列里有同 id 任务卡时 start 自动把卡从 `pending/` 迁 `running/`（抢任务锁+留痕），finish 成功落 `merged/`——人工 agent 与闭环共享卡状态，同一张卡不会被重复执行；`list` 显示 `[claimed]` = 有 agent 在岗勿接手。
- **未完成任务必须在 worktree 的 `NOTES.md` 留交接**（start 自动生成模板），接手 agent 从 `list` 与 NOTES.md 续起。
- start 自动跑 `setupCmd`（本仓库 `npm ci --prefer-offline`，失败仅告警可手动重跑）；finish 自动跑 `testCmd`（本仓库 `npm test`，纯文档改动可 `--skip-test`），全程持锁串行（陈锁自动接管）。
- 例外：确需直接改 develop 时设 `AGENTS_ALLOW_BASE_EDIT=1`（旧名兼容），且必须能向用户说明理由。
- 派发并行任务按文件归属分区（如一个 agent 只动 `src/gateway/`），减少合并冲突。

### 把工作流移植到其他项目

`.agents/` 工具链零项目专属假设（项目数据全在 workflow.json，代码按缺省派生）：

```bash
cp -r <本项目>/.agents <目标项目>/
cd <目标项目> && node .agents/scripts/agent-init.mjs   # 交互生成 workflow.json + 注册双客户端 hook + AGENTS.md 骨架（--defaults 非交互）
cp <目标项目>/.agents/hooks/policy-dispatch.mjs ~/.agents/hooks/   # 机器级 Bash 红线 dispatcher：注册一次、全项目生效
```

移植要点见 `.agents/workflows/orchestrator.md`「移植」节与 `.agents/workflows/feature-branch.md`「移植到其他项目」节。

### GitHub 侧自动化（分层 PR 审查 + Dependabot）

agent 在 GitHub Actions 上做分层 PR 审查与依赖升级验证（配置在 `.github/`，改动同样走 worktree 流程；总览与运维见 **`docs/ai-review-system.md`**）。启用需在仓库 Settings 配置 secret `CLAUDE_AUTH_TOKEN` 与 Variables `CLAUDE_BASE_URL`/`CLAUDE_MODEL`（三件套，缺一 AI job 跳过并告警）；完整设置与成本控制见 **`docs/ci-bots.md`**：

| 文件 | 作用 | 需要 secrets |
|------|------|------|
| `workflows/claude-review.yml` | 分层 PR 审查：`risk-tier` 确定性打 `risk:*` label（零消耗）+ `auto-review` 只读审查（REVIEW.md 纪律，[P0]/[P1]/[P2] + inline，3 轮收敛）+ `security-review`（`SECURITY-VERDICT` 门禁，FAIL 即失败）；`@claude` 评论可交互追问 | `CLAUDE_AUTH_TOKEN`（key；risk-tier 不需要） |
| `REVIEW.md` + `.github/CODEOWNERS` | 审查纪律 + 敏感路径归属；审查者动手前必读 | 无 |
| `scripts/pr-risk-tier.mjs` | PR 风险分级脚本（规则对齐 workflow.json corePaths/releasePaths；测试 `test/pr-risk-tier.test.ts`） | 无 |
| `.agents/review-evals/` | 审查评测集：事故/revert 变考题（`scripts/review-eval.mjs` 跑分）——**出事故后必读加题**，改 REVIEW.md/prompt/模型后全量重跑 | 无 |
| `dependabot.yml` | npm + GitHub Actions 依赖周更；minor/patch 成组降噪，major 单独出 | 无 |
| `workflows/dependabot-fix.yml` | Claude 验证 Dependabot PR（build+test 全绿评论可合并；失败做最小修复推回；大破坏不硬修） | `CLAUDE_AUTH_TOKEN` + `DEPENDABOT_GH_TOKEN`（PAT） |
| `workflows/ci-autofix.yml` | 主干 test 失败的投机自动修复（main/develop、首次失败才触发）：最小修复+补测试 → 开 `[ci-autofix]` PR 待审；每 run 仅 1 次 | `CLAUDE_AUTH_TOKEN`（key），无需 PAT |

- **模型接入**：bot 走任意 Anthropic 兼容端点，**配置全在 GitHub 侧、yml 零默认值**，换供应商只改三件套。注意项见 `docs/ci-bots.md`「模型接入」。
- **Dependabot PR 上的 GITHUB_TOKEN 一律只读**（平台行为）：评论/推送必须经 PAT；缺 PAT 时跳过留人工。
- **防回环**：bot 修复提交固定前缀（`[dependabot-fix]` / `[ci-autofix]`），review bot 检测 PR head 为该前缀即跳过；ci-autofix 仅认 main/develop 的 push 型 run 且每 run 只尝试一次。
- **合并权在人**：bot 只发评论与修复提交，不 approve、不 merge；发版仍走 release.md 人工授权流程。

## 判定边界（Boundaries）

**必须做**
- 改完代码跑**与改动相关的测试用例**（见「测试指南」测试范围分层），全绿再交付；全量留给发布、develop→main 等大节点与 CI 门禁。
- 涉及路径/文件/进程/shell 的改动，交付前过一遍「工程硬性约定」三平台兼容清单（Windows CI 红是高频事故源，本机 mac 全绿不算数）。
- 测试结束清理自己拉起的全部临时进程，核实无端口占用、无残留进程再收工（硬规则 4）。

**禁止做**
- 添加 native 依赖（破坏 SEA 打包前提）。
- 改坏 `src/cli.ts` 三路分发、或改用 `import.meta.url` 做 SEA 检测。
- **以任何形式测试、访问或改动 8687 生产实例**；**占用或改动 8890 用户 dev 沙箱**；或让单测与临时实例监听写死端口（详见「端口与实例约定」⛔ 禁令）。
- 绕过 feature-branch 工作流直接在 develop/main 上 Edit/Write 代码（hook 会拦截；例外与规程见「多 Agent 并行开发约定」）。
- **新增 MCP 配置下发 / 统一管理、skill 管理 / 分发类功能**（2026-10-29 产品决策：客户端原生管理已是标配，ModelDock 只做只读诊断；skills 跨机器用 sync assets 白名单覆盖）。

> 其余如"不提交 `dist/`、`release/`、`.cache/`"由 `.gitignore` 强制，不在此重复。

## 已知限制

- Windows 上 NTFS 不生效 `0o600` 权限位。
- esbuild CJS 输出下 `import.meta.url` 为空——src 一律不用 `import.meta`：SEA 检测走 `process.execPath`，非 SEA 相对路径以 `process.argv[1]`（cli 入口）为锚点。
- 网关仅监听 `127.0.0.1`，不支持远程访问（设计如此）。
- tsx 直跑（`npm run dev -- <cmd>`、隔离手测实例）**没有热重载**：改完 `src/**` 后运行中的实例仍伺服旧代码，验证前必须先重启该实例。run_dev.sh / run_dev.bat 用 `tsx watch` 会自动重启，不受此限。

## 发布

发布分两步：**先推 main 等 test workflow 全绿，再单独推 tag**（不要用 `--tags` 一次全推，每个 tag 都触发一次 Release）：

```bash
git push origin main                                       # 1. 等 test workflow 全绿
git tag -a v<ver> -m "v<ver>" && git push origin v<ver>    # 2. 测试绿后只推这一个 tag，触发 Release
```

tag 推送后由 GitHub Actions（`.github/workflows/release.yml`）自动为 5 平台构建并发布到 Releases。

**agent 代理发布**：用户明确说「发布 vX.Y.Z」即授权 agent 代执行完整发布流程。push/tag 红线为**人工授权制**：按 `.agents/workflows/release.md`「代理发布」节，以 `AGENTS_ALLOW_RELEASE=1` 命令前缀（旧名兼容）仅执行白名单形态（push origin main / develop（发布收尾对齐）、push/删 v<semver> tag、annotated tag）；`--tags`、force push、多 ref、其他分支与 `npm publish` 永不放行。agent 不得自行决定版本号。
