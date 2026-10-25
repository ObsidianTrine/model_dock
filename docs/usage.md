# ModelDock 使用指南

**简体中文** ｜ [English](en/usage.md)
<!-- i18n-slot：新增语言时在上一行末尾追加链接（如 ｜ [日本語](ja/usage.md)），约定见 .agents/conventions/docs-writing.md -->

> 一句话：把所有 AI harness（Claude Code / ZCode / dsh / Codex / …）的 base_url + key 收进 ModelDock 统一保管，harness 只需指向本地网关一次，此后换供应商、换模型映射都是一条命令、即时生效。

**目录**：[核心概念](#1-三分钟理解核心概念) · [安装与构建](#2-安装与构建) · [首次上手](#3-首次上手推荐路径) · [接管各 harness](#4-接管各-harness-的具体行为) · [日常使用](#5-日常使用) · [Web 控制台](#55-web-控制台) · [还原与卸载](#6-还原与卸载全部可逆) · [配置文件速查](#7-配置文件速查modeldock) · [网关与端口](#8-网关与端口) · [故障排查](#9-故障排查) · [实现状态](#10-当前实现状态v100)

## 1. 三分钟理解核心概念

```
provider（上游凭据：base_url + key + 模型目录）
   ↓
profile（一条路由：用哪个 provider + 默认模型 + 模型别名映射）
   ↓
harness（每个客户端怎么接入：claude-code / zcode / dsh / codex / opencode / mimo-code / mimo-desktop / workbuddy / generic-env）
```

- **网关模式（默认）**：harness 的配置里只写 `http://127.0.0.1:8687` + 一个本地 token，真实 key 永不出 ModelDock。切换 provider 改的是 ModelDock 的路由，harness 配置零改动。
- **非侵入**：不执行 `attach` 之前，ModelDock 对你现有的 harness 配置**只读不写**；接入/切换等对客户端配置的写盘前自动快照（`config.toml` 自身由锁 + 原子写保护），`detach` / `restore` 随时还原。

## 2. 安装与构建

### 下载独立安装包（无需 Node.js）

从 [Releases](https://github.com/ObsidianTrine/model_dock/releases) 下载对应平台的安装包，各平台形态：

- **Windows**：`modeldock-<版本>-win32-x64-setup.exe` 安装向导（可选路径、自动写入 PATH 和快捷方式、卸载自动还原清理）；免安装用 `modeldock-<版本>-win32-x64.zip` 解压即用。
- **macOS**：`modeldock-<版本>-darwin-<架构>.dmg` 拖拽安装（见下节）；命令行用户用 `.tar.gz` 解压 `chmod +x modeldock && sudo mv modeldock /usr/local/bin/`。
- **Linux**：`modeldock-<版本>-linux-<架构>.tar.gz`，解压后移入 PATH 目录。

所有发布物的 SHA256 见 Release 附带的 `SHA256SUMS`。

### macOS 图形化安装（DMG，要求 macOS 13.0+）

从 [Releases](https://github.com/ObsidianTrine/model_dock/releases) 下载 `modeldock-<版本>-darwin-x64.dmg`（Intel）或 `modeldock-<版本>-darwin-arm64.dmg`（Apple Silicon），双击打开后把 **ModelDock** 拖入 **Applications** 文件夹即完成安装。

- **首次打开**：在「应用程序」中右键 → 打开 → 打开（未公证应用的常规放行方式，只需一次）。若提示「已损坏」，执行一次 `xattr -dr com.apple.quarantine /Applications/ModelDock.app`。
- **日常使用**：双击 ModelDock 自动后台启动网关、以独立应用窗口打开 Web 控制台，并自动安装 `modeldock` 命令行到 `/usr/local/bin`（需要权限时弹一次管理员授权；拒绝过一次不再打扰）。之后在终端可直接使用完整 CLI。关闭控制台窗口后菜单栏托盘常驻，随时从托盘回到控制台；托盘「退出」停止网关。
- **卸载**：把 ModelDock 拖入废纸篓，再执行 `modeldock uninstall`——停止网关并移除命令行入口，**配置与密钥保留**，重装后自动接回；要连配置、密钥一起彻底清除并还原所有客户端，执行 `modeldock uninstall --purge`。

### 从源码构建

```bash
git clone https://github.com/ObsidianTrine/model_dock.git
cd model_dock
npm install
npm run build          # TypeScript 编译，产物在 dist/
npm link               # 全局注册 modeldock 命令
modeldock --help

# 构建独立可执行文件（当前平台）
npm run build:sea

# 交叉编译指定平台
npm run build:sea -- --target linux-x64
npm run build:sea -- --target darwin-arm64
```

开发模式：`npm run dev -- <命令>`（等价于 tsx 跑源码）。

## 3. 首次上手（推荐路径）

### 方式 A：一条命令向导

```bash
modeldock init
```

向导会依次：检测本机 harness → 列出从 cc-switch / Claude Code / Codex / dsh / ZCode / OpenCode / MiMo Code / WorkBuddy / claude-code-router / Crush / Gemini CLI 发现的现有 provider（勾选导入，key 一并入库）→ 没有可导入的就走预设库添加 → 选默认路由 → 后台启动网关 → 逐个 attach（每步先展示 diff）。`--yes` 可全自动。

### 方式 B：从 cc-switch 迁移（本机现状推荐）

```bash
modeldock import --from cc-switch   # 收编火山/DeepSeek/小米 MiMo 等档案（原库只读）
modeldock profile list              # 看导入结果
modeldock profile use <名字>        # 设默认路由
modeldock gateway start --daemon    # 启动网关（127.0.0.1:8687）
modeldock attach claude-code        # 接管 Claude Code：展示 diff → 确认 → 自动快照
modeldock test                      # 端到端连通性自测
```

迁移完成后**退出 cc-switch（或关掉它的本地代理）**，避免两边同时改 `~/.claude/settings.json`。

`import` 不只认 cc-switch：`--from` 可选 all / cc-switch / claude / dsh / zcode / codex / opencode / mimocode / workbuddy / ccr / crush / gemini——Codex、OpenCode、MiMo Code（与桌面端共用配置）、WorkBuddy、claude-code-router、Crush、Gemini CLI 中转里的上游一并只读收编。one-api / new-api 自建站点的渠道走管理 API 拉取：

```bash
modeldock import --from oneapi --url https://你的站点 --token <系统访问令牌>
```

令牌在 one-api「个人设置 → 系统访问令牌」生成（new-api 同入口）；只导入 OpenAI 兼容 / Anthropic 类型的渠道，Azure、Gemini 原生等 ModelDock 无法直连的渠道会注明原因跳过。

### 方式 C：手动逐个配置

```bash
modeldock provider add                       # 预设库模糊搜索 → 选一个 → 粘贴 key，url 自动填好
modeldock provider add deepseek-anthropic    # 或直接指定预设 id
modeldock profile add my-route --provider deepseek-anthropic --model deepseek-chat \
  --aliases "claude-sonnet-*=deepseek-chat,claude-opus-*=deepseek-reasoner"
modeldock profile use my-route
modeldock gateway start --daemon
modeldock attach claude-code
```

## 4. 接管各 harness 的具体行为

| harness | 命令 | attach 做了什么 | 之后你要做的 |
|---|---|---|---|
| Claude Code | `modeldock attach claude-code [--takeover-models]` | 改 `~/.claude/settings.json` 的 `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` 两个值，其余字段不动；`--takeover-models` 可选：把 `DEFAULT_*_MODEL` 映射迁进 profile 并从文件删除 | 重启 Claude Code |
| ZCode | `modeldock attach zcode` | 在 `~/.zcode/v2/provider_config.json` **新增** modeldock provider 条目（热加载，立即生效），不动既有条目；旧版写入 `config.json` 的 `builtin:modeldock` 条目会在接入时自动清理 | 在 ZCode 设置里手动选择一次 ModelDock provider |
| dsh | `modeldock attach dsh [--set-default]` | `~/.dsh/settings.yaml` 新增 modeldock provider（apiKeyEnv 间接引用），token 写进 `.credentials.yaml`；`--set-default` 顺带切 agent-default-model | 重启 dsh |
| Codex | `modeldock attach codex [--set-default]` | 创建/修改 `~/.codex/config.toml` 注册 modeldock provider（wire_api=chat） | `export MODELRDOCK_CODEX_TOKEN=$(modeldock token codex)` 写进 `~/.zshrc`（一次） |
| OpenCode | `modeldock attach opencode` | 在 `~/.config/opencode/opencode.json` 新增 `provider.modeldock`（OpenAI 兼容 `/v1`） | 重启 OpenCode |
| MiMo Code | `modeldock attach mimo-code` | 在 `~/.config/mimocode/mimocode.jsonc`（或 `.json`，`MIMOCODE_HOME` 可覆盖）注册 modeldock provider 并按当前路由写入模型声明；支持自动安装（npm `@mimo-ai/cli`） | 重启 MiMo Code，`mimo models` 可验证 |
| WorkBuddy | `modeldock attach workbuddy` | 在 `~/.workbuddy-ai/models.json`（多候选探测）写入当前路由的模型条目数组（UI「添加模型」同款格式），你已有的自定义条目原样保留 | WorkBuddy 运行中会热加载；模型列表未刷新就重启 |
| 任意其他 | `modeldock attach generic-env` 然后 `eval "$(modeldock env)"` | 不写任何文件 | 把 env 输出 source 进 shell |

attach 可重复执行（幂等更新）。查看某个 harness 的 token：`modeldock token <harness>`。

## 5. 日常使用

```bash
modeldock ui                      # ★ 打开本地 Web 控制台（浏览器自动登录）
modeldock profile use <name>      # ★ 切换供应商：网关模式下新请求立即走新路由，harness 不用动
modeldock gateway install         # ★ 开机自启（常驻）：注册系统服务，登录自动拉起、崩溃自动重启
modeldock status                  # 总览：网关 / active profile / 各 harness 指向
modeldock test [profile]          # 连通性自测：key、模型名、流式、延迟一次说清
modeldock doctor                  # 全面体检；--fix 自动修复（敏感项逐项确认），--json 机器可读
modeldock gateway log -f          # 实时请求日志（只有元数据，不落 prompt）
modeldock gateway log --harness claude-code
modeldock config export           # 换电脑搬家：导出口令加密配置包（服务/路由/预设/定时，连同 Key）；默认写到 modeldock-config-<日期>-<时间>.msync，用 -o 指定路径
modeldock config import <file>    # 新电脑导入：预览将替换的内容 → 确认 → 自动备份后应用
modeldock sync setup              # 多台电脑自动同步：目标=WebDAV 网盘/本地同步盘，改动自动双向收敛
modeldock sync status             # 同步状态：目标/最近推拉/冲突（sync pause / resume 暂停恢复）
modeldock update                  # 一键升级：下载 → SHA256 校验 → 替换 → 自动重启网关
```

> 界面语言：输出与报错默认中文，任意命令加 `--lang en` 切英文；也可设环境变量 `MODELRDOCK_LANG=en`，或在 config.toml 写 `language = "en"` 持久生效（后台网关沿用同一语言）。

### 版本更新（一键升级）

```bash
modeldock update --check          # 只看有没有新版（摘要 + 发布页链接），不安装
modeldock update                  # 检查 → 确认 → 下载校验 → 替换 → 自动重启网关（公开仓库匿名即可，无需令牌）
modeldock update --token <令牌>   # 可选：保存 GitHub 访问令牌（fine-grained、Contents 只读；存系统安全存储）——仅更新源为私有仓库时必需，配置后可把匿名限流 60 次/时提到 5000 次/时
modeldock update --clean          # 清理上一版残留（ModelDock.app.old / *.old）
```

发新版后不用再手动下载重装：`modeldock update` 一条命令完成，安装前会校验下载包的 SHA256 完整性（校验名单永走 GitHub 官方，下载大文件可经镜像加速），替换时网关短暂中断、完成后按原状态自动拉起（macOS 从 ModelDock.app 启动的会自动重开应用与托盘）。检查与下载会自动走本机代理：按「环境变量（`HTTPS_PROXY` 等）→ macOS 系统代理设置 → Windows 注册表」动态检测、不写死地址，检测到时命令行会明说代理来源，设 `MODELRDOCK_NO_SYS_PROXY=1` 可禁用。更新源/令牌/镜像记录在 `~/.modeldock/`（config.toml `[update]` 段 + 密钥安全存储；`mirror` 缺省走 gh-proxy → ghfast → 官方直连回退链，置空数组可关闭），详见 `docs/design-auto-update.md`。

> 不想敲命令也可以：网关运行中发现新版本时，控制台右下角会弹一条可复制的提醒，顶栏出现琥珀色「可更新 vX.Y.Z」徽标——点开居中更新卡片（版本 / 安装包大小 / 更新说明正文，底部给「在 GitHub 查看完整说明」链接）并一键升级，更新后页面自动重连；升级失败会立即提示原因；不想升级可选「此版本不再提醒」；没有新版本时界面零打扰（手动检查可用 `modeldock update --check` 或 macOS 菜单栏 / Windows 托盘的「检查更新…」——托盘弹窗里是收口后的摘要（首段 + 几条要点 + 共 N 项改动），可直接点「立即更新」就地升级，或点「打开发布页」逐条细看）。网关启动时会自动静默检查一次（24 小时内不重复，失败不打扰）。

## 5.5 Web 控制台

浏览器打开 `http://127.0.0.1:8687/_modeldock/ui`，或直接：

```bash
modeldock ui
```

**打开页面会自动探测旧配置**：如果本机的 cc-switch / Claude Code / Codex / dsh / ZCode / OpenCode / MiMo Code / WorkBuddy / claude-code-router / Crush / Gemini CLI 里已有 provider 配置，顶部会出现「🧲 检测到旧配置，一键搬进来」横幅——点一下即全部导入（Key 一并安全搬入、原软件不受影响、已导入的自动去重不再提示；点「暂不导入」可隐藏）。

界面就是三步，**没有任何需要理解的新概念**：

- **① 添加模型服务**：点服务商卡片（DeepSeek / 智谱 GLM / Kimi / 火山方舟 / 小米 MiMo / OpenAI / 更多…），粘贴 API Key，完成。接口地址自动填好、模型列表自动拉取、Key 只保存在本机；附官方文档链接。
- **② 我的服务**：点「应用」即全局切换——所有已接入的客户端立刻用新服务，不用改它们任何配置。每个服务可「测速」「编辑」（改名/改接口地址/换 Key）。
- **③ 接入你的 AI 客户端**：对 Claude Code / ZCode / dsh / Codex / OpenCode / MiMo Code 点「一键接入」——客户端还没装？面板里可直接「安装」（本机没有 Node.js 也能装——自动下载托管运行时并接入，大陆镜像加速；自动执行官方安装命令，或给出手动指引），装完接着接入。弹窗用大白话说明改什么、可还原，确认后自动写入并备份；重启客户端生效。随时可「断开并还原」。其他客户端选「通用环境变量」接入，接入后行内一键复制标准 `ANTHROPIC_*` / `OPENAI_*` 变量，粘贴进任何支持自定义接口地址的客户端即可经网关调用。

页面顶部显示当前使用的服务和模型——「我的服务」列表上方的「正在使用」状态卡是唯一口径（大字服务名 + 模型 + 来源彩徽，右缘写明「下一个切换：服务名」——在用谁、挂了去哪一眼分层），服务卡徽标、手机页与模型列表都跟它一致（人工钉定 > 定时时段 > 默认路由）；定时时段命中但没生效（被钉定、目标下线或熔断）时，定时 pill 会写明原因。第一行是「当前」与「下一个切换」两个下拉：「当前」手动选定即钉定（与服务卡「应用」同效，优先于定时切换的程序自动）；「下一个切换」钉定主服务不可达时切到哪个服务，选「自动 · 服务名」交还程序自动——既没配备用链、也没开「自动备用链」时这里显示「自动 · 无备用服务」，意思就是主服务出问题不会切到任何服务，去服务编辑页的「故障切换顺序」里添加即可。手动钉定的服务故障时仍自动顺延备用服务；**最近请求日志常驻在页面底部**——客户端报错时先来这里看原因。已添加服务后，「添加模型服务」收起为右下角的悬浮 ＋ 号，点击弹出浮层。顶栏可在「自动 / 暗色 / 亮色」主题间切换（默认暗色，记住选择）；「中文 | EN」一键切换中英文，报错与客户端卡片等服务端提示同步跟随。

两个提效开关：

- **定时切换（⏰）**：按时段自动在服务间切换——比如 DeepSeek 低谷半价时段（00:30–08:30）自动走 DeepSeek、其余时间走主力服务；法定节假日 DeepSeek 全天谷价，加一条「法定节假日」时段全天优先走它。生效日支持每天 / 工作日（周一至五与调休补班日）/ 周末 / 法定节假日，日历按国务院公告自动获取与更新，不用手动维护；支持跨午夜窗口。自动路由整体是一键开关（打开即启用）；设置即改即存，每次请求实时求值，改了时段立即生效，面板还会显示最近的法定节假日。
- **开机自启**：设置页一键注册系统服务（macOS LaunchAgent / Linux systemd / Windows 启动文件夹），登录自动拉起网关、崩溃自动重启——网关常驻，客户端永不掉线。

自动路由一行的开关里还有两枚与「切备用」有关：「临时故障切备用」=主服务返回 429 限流或 503 不可用时自动改发备用（默认开）；**「自动备用链」（默认开）=没手动配备用链也能自动切**——主服务连不上、限流或额度耗尽（如 DeepSeek 返回 402 余额不足）时，自动把其他已启用的服务补进切换候选，按定时时段、优先级、实测耗时排序（最多 3 个）；模型名原样透传，换模型请在客户端里换。手动配的「故障切换顺序」永远排在自动补尾前面。

**菜单栏 / 托盘常驻**：macOS 菜单栏与 Windows 系统托盘有 ModelDock 常驻图标——打开控制台、在浏览器打开、开关开机自启、打开日志目录；关闭控制台窗口网关照常运行，「退出」停止网关并退出托盘。

**手机简版控制台（局域网）**：默认关闭。控制台顶部「手机远程」一键开关——主体点一下直接开 / 关，右侧箭头展开 / 收起二维码面板（关闭走面板内「关闭手机远程」按钮）。手机连同一局域网扫码即可打开简版页，查看当前服务与状态、切换服务、调整自动路由（与桌面控制台同款同值，并显示现在实际走哪个服务）；「配置同步」卡片可把口令加密配置包导出到手机存着、再到另一台电脑上传导入，跨网段搬配置不用 U 盘（页面只做密文搬运与预览确认，不显示 Key）；页脚有「常驻到手机桌面」引导——添加到主屏幕后以 ModelDock 图标的独立全屏窗口打开（微信内打开会先提示换到浏览器）。也可手机浏览器直接访问 `http://<本机IP>:8787`。也可以在 config.toml 直接开启：

```toml
[lan]
enabled = true
# port = 8787   # 默认 8787，被占用自动顺延
```

简版页只开放状态查看、切换服务、路由调整与配置同步，管理凭据不下发；主网关仍只监听 `127.0.0.1`，不对外开放。

安全：控制台仅本机可访问；读取无需任何密码，修改类操作要求"浏览器同源请求"（防止其他网页暗中驱动本机网关）——**没有 admin token 概念，也不需要输入任何密码**。

### 模型目录（自动获取 + 默认填好 + 随手改）

```bash
modeldock model list                     # 每个模型的输入上下文/最大输出/能力/来源
modeldock model refresh <id>             # 从上游 /v1/models 自动拉取
modeldock model set <provider> <model> --ctx 262144 --max-out 32768   # 手动改元数据
modeldock model set <provider> <model> --cap reasoning,vision         # 手动改能力标记
```

- **视觉**是模型的可选能力：控制台「编辑服务 → 模型表」里上下文 / 最大输出后面有一列勾选，勾上即表示该模型能吃图片；已知的常见视觉模型（GPT / Claude / Gemini / Kimi-K3 / GLM-5.3-Flash 等）会自动勾好，带日期后缀的 id（如 `kimi-k3-260701`）按基名识别。接入 dsh 时会据此声明图片输入模态。
- **显示名**：模型有独立于 ID 的展示名时（厂商返回或预设自带，如「DeepSeek V4 Pro」），编辑 / 添加服务的模型表在模型 ID 下方以小字显示；与 ID 同名或没有时不显示。拉取模型时厂商回了名字的会随「填入所选」一并保存，接入的客户端（dsh / workbuddy 等）模型列表里显示的也是它。
- **推理等级不用配置**：接入 dsh 时按其官方四档（关闭 / 低 / 中 / 高）声明为可用，你在 dsh 里选的思考等级不会再被拒（此前手写模型一律被判「不支持该思考等级」）。

### key 轮换

```bash
modeldock provider set-key <id>          # 隐藏输入；或 --key-env MY_VAR
```

### 多机同步与云端管理（进阶）

多台电脑保持同一份配置：

```bash
modeldock sync setup             # 目标=WebDAV 网盘（坚果云等）或本地同步盘（Google Drive 等），设同步口令
modeldock sync status            # 目标 / 版本 / 最近推拉 / 错误与冲突；sync pause / resume 暂停恢复本机同步
```

- 改动自动双向收敛：新加服务、换 Key、改路由，别的电脑自动跟上；冲突自动保留双方快照，不丢数据。目标已有配置时，新入网的电脑自动收敛到最新；同步状态显示为控制台顶栏的小徽标（正常为「配置同步 · 已开启」，冲突 / 错误 / 暂停会变色提醒，冲突提醒在本机改动成功推送回去后自动消失，鼠标悬浮可看同步目标、版本与最近推拉详情；配置与管理在电脑端命令行）。
- 同步口令请妥善保管——遗忘则密文不可恢复。
- **换新电脑**：网盘客户端把文件同步过来只是"运输"，新电脑还需手动跑一次 `modeldock sync setup`（选同一目标、输同一口令）才会接入并自动收敛。完整步骤（前置检查与排错对照表）见 [multi-machine-sync.md](multi-machine-sync.md)。

**同一局域网内换电脑，不用网盘也不用传文件**：旧电脑控制台展开「手机远程」二维码面板，点**「分享配置到附近电脑…」**生成一条链接（10 分钟内有效、被拉取一次即作废）；新电脑控制台在「我的服务」空状态点**「从其他电脑导入…」**粘贴链接，预览将替换的内容后确认即完成。链接自带一次性口令，视同密钥、只发给对方本人。

不想用链接也可以走配置包：旧电脑服务卡片点**「导出配置包」**，生成口令保护的加密文件（与 `config export` 命令同一能力），微信 / U 盘传到新电脑，在其「从其他电脑导入…」里选文件、输口令完成；新电脑零配置时也能开启「手机远程」——手机扫新电脑的码进手机控制台，把存在手机里的配置包导进去（建议用系统浏览器打开，微信内置浏览器选不了文件；iPhone 上导出的包存在「文件」App →「下载项」）。

**免复制粘贴：附近电脑点选**：新电脑「从其他电脑导入」弹层里点**「搜索附近的电脑…」**，同网络中开启「手机远程」的 ModelDock 电脑自动列出，点选即发起拉取；旧电脑会弹出确认卡（显示对方主机名），点**「允许拉取」**后配置自动送达、预览确认即完成。发现走本地网络（UDP 广播，不经任何外部服务器）；若路由器开了客户端隔离搜不到，改用上方链接或文件方式。

也可以自建云端中枢统一管理多台设备（进阶）：在一台云服务器上部署控制面（一页 runbook 见 [deploy-cloud.md](deploy-cloud.md)），电脑 `modeldock sync enroll --server http://<IP>:18443 --code <配对码>` 入网；浏览器（手机最佳）打开云端地址、粘贴 consoleToken 登录，即可查看所有设备、单台 / 批量切换服务（1 分钟内生效）、生成新设备配对码。入网设备心跳上报各自的服务目录，切换下拉自动列出目标机可用的全部服务。

## 6. 还原与卸载（全部可逆）

```bash
modeldock restore claude-code --list     # 列出该 harness 的所有快照
modeldock restore claude-code <id>       # 还原到任意快照（还原前也会先快照，可撤销）
modeldock detach claude-code             # 分离 = 还原到 attach 前
modeldock uninstall                      # 卸载程序：停网关 → 移除自启/命令行入口；配置与密钥保留，重装自动接回
modeldock uninstall --purge              # 彻底清除：还原客户端 → 停网关 → 删 ~/.modeldock 与已存密钥
modeldock reset                          # 重置配置：还原客户端 → 停网关 → 删配置与密钥（快照、日志保留）
modeldock reset --deep                   # 清理数据：上面全部 + 删日志、同步状态与本机缓存（快照仍保留）
```

> 菜单栏 / 托盘图标也有「清理数据…」：确认弹窗后等价于执行 `modeldock reset --deep`，清理逻辑与命令行完全同一套。

## 7. 配置文件速查（~/.modeldock/）

```
config.toml    主配置：providers / profiles / harness / adapter_packs / gateway
secrets.json   key 存储（macOS 用系统 Keychain、Windows 用 DPAPI 加密、Linux 用 Secret Service；仅无钥匙环时回退 0600 明文；存量明文启动自动迁移）
sync.json      多机同步状态（同步目标 / 口令缓存 / 云端入网信息，sync 自动维护）
gateway.json   网关运行状态（pid / 实际端口 / admin token，网关自动维护）
backups/       每次写操作的快照（<harness>/<时间戳>-<操作>/，默认滚动保留 20 份，config 的 backup.keep 可调，最小 1）
logs/          网关请求日志（按天 JSONL，只有元数据）
```

`config.toml` 示例（可直接手编，`modeldock config edit` 起编辑器并校验）：

```toml
version = 1
active_profile = "ark-coding"

[providers.ark_coding]
base_url = "https://ark.cn-beijing.volces.com/api/coding"
protocol = "anthropic"            # anthropic | openai
auth_style = "bearer"             # bearer | x-api-key
key_ref = "file:ark_coding"       # 也支持 keychain: <id> / env:<VAR>
proxy = "direct"                  # direct | env | http://127.0.0.1:7890（clash）

[providers.ark_coding.models.deepseek-v4-flash]
display_name = "DeepSeek V4 Flash"
context_window = 131072           # 输入上下文
max_output = 8192                 # 最大输出
capabilities = ["tools", "reasoning"]
source = "preset"                 # preset | fetched | manual

[profiles.ark-coding]
provider = "ark_coding"
default_model = "deepseek-v4-flash"
aliases = { "claude-sonnet-*" = "deepseek-v4-flash", "claude-opus-*" = "glm-5-3" }

[harness.claude-code]
mode = "gateway"
route = "default"                 # 跟随 active_profile；也可钉死为某 profile 名
token = "mdk_..."

# 接入新 harness 的零代码方式（L2 声明式 pack）
[adapter_packs.opencode]
format = "json"                   # json | toml | yaml
config_file = "~/.config/opencode/opencode.json"
upsert = { "$.provider.modeldock.baseURL" = "{base_url}", "$.provider.modeldock.apiKey" = "{token}" }
```

变量模板：`{token}` `{port}` `{base_url}` `{base_url_openai}`。之后 `modeldock attach opencode` 即可接管。

## 8. 网关与端口

- 默认 `127.0.0.1:8687`，仅本机可访问；端口被占用会自动 +1 并打印实际端口（attach 以实际端口写入）。
- 常驻：`modeldock gateway install` 注册开机自启（登录自动拉起 + macOS/Linux 崩溃自动重启；`gateway uninstall` 移除）；`gateway status` 显示自启状态，能检出服务里登记的启动路径已失效（如 nvm 升级后）。
- 国外上游（OpenAI / Anthropic / Gemini…）的预设默认 `proxy = "env"`，读 `HTTPS_PROXY` 环境变量，兼容 clash；国内上游直连。
- 管理端点：`/_modeldock/health` 与各读取端点本机免鉴权；修改类操作要求同源请求或 admin token（gateway.json，CLI 自动使用）。浏览器直接访问 `http://127.0.0.1:8687` 会自动跳转到 Web 控制台。

## 9. 故障排查

| 现象 | 处理 |
|---|---|
| harness 报 401 | token 不对：`modeldock status` 核对，重跑 attach；codex 检查 `MODELRDOCK_CODEX_TOKEN` |
| 上游 401/403 | key 失效：`modeldock provider set-key <id>` |
| 上游 404 model | `modeldock model refresh <id>` 拉模型，或换 profile |
| 疑似上下文超限 | `modeldock model list` 看该模型 ctx；换长上下文模型 |
| 网关挂了 harness 全断 | 已装自启服务（`gateway install`）会自动拉起；否则 `modeldock gateway start --daemon`，应急 `modeldock detach <harness>` 立即回到直连 |
| ZCode 没走网关 | attach 只注册了 provider，还需在 ZCode 设置里选择它（一次性） |
| 配置改坏了 | `modeldock config edit` 或 `modeldock restore` |

## 10. 当前实现状态（2026-10-18 基线；发版时随版本号刷新）

已实现：本文档所列全部命令；网关（双协议透传/模型重写/SSE/热加载/错误翻译/代理/请求级 failover+熔断：手动备用链优先、自动备用链补尾、额度耗尽自动切换）；快照还原（保留份数由 `backup.keep` 控制）；预设库 20 个（含多协议端点与 2026 模型参数）；import 四来源；L2 声明式 pack；Web 控制台（§5.5，含一键迁移、顶部「当前 / 下一个切换」双槽位下拉、客户端「安装并接入」（本机无 Node.js 也能装，托管运行时 + 大陆镜像）、定时切换（自动识别工作日/周末/法定节假日/补班，国务院日历）、暗色主题）；**双槽位路由（「当前」/「下一个切换」，手动钉定优先于程序自动，故障切换常开）**；**手机简版控制台（局域网 8787 + 二维码：状态查看 / 切换服务 / 路由调整 / 配置同步，与桌面同口径；PWA 常驻手机桌面）**；**配置加密导出/导入（`config export` / `config import`，口令加密整包 AES-256-GCM，手机扫码当搬运工）**；**多机自动同步（`sync setup/status/pause/resume`，WebDAV / 本地同步盘，双向收敛 + 冲突快照）**；**云端中枢（自建控制面，见 docs/deploy-cloud.md：配对码入网 / 心跳 / 云端手机单页管理设备与远程切换）**；**菜单栏托盘（macOS 菜单栏 / Windows 系统托盘：打开控制台 / 检查更新 / 清理数据，退出即停网关）**；**密钥安全存储（macOS Keychain / Windows DPAPI / Linux Secret Service，无钥匙环回退 machine-id 绑定加密，存量明文自动迁移）**；**开机自启常驻（`gateway install`，macOS LaunchAgent / Linux systemd / Windows 启动文件夹）**；**一键升级（`modeldock update`：GitHub Releases 检查 + SHA256 校验 + 按平台替换 + 网关自动拉起，mac 整包换 .app / win 静默安装器 / 裸二进制原位换新；控制台顶栏「可更新」徽标 + 弹层一键升级 + 自动重连、托盘「检查更新」菜单、启动静默检查 24h TTL）**；跨平台支持（Linux / macOS / Windows）；单文件可执行包（SEA）与各平台安装包（macOS DMG 拖拽安装 / Windows 安装向导，双击启动自动装 CLI）；GitHub Actions 自动打包发布。

验证状态：TypeScript 编译通过；产品测试 850 例全绿（70 个文件：store / backup / util / adapters / gateway / install / autostart / cliinstall / lan / schedule / sync / cloud / i18n / update 等套件，含 Web 端点、手机控制台与云端控制面；另 6 例按平台跳过）；agent 工作流套件（.agents/ 编排器与守卫 hook）拆分单独运行：`npm run test:workflow`（140 例）；CLI 二进制冒烟通过；Windows / Linux / macOS 跨平台测试通过。真实 harness 的 attach 联调待你在本机执行——首次使用建议保留 diff 确认，并先跑 `modeldock test` / `modeldock doctor`。

计划中（M2/M3）：L3 外部插件、预设库远程更新、管理面「严格模式」（只读端点也要求 token）、anthropic↔openai 协议转换；用量统计经评估不做；云同步 M4 完善项（恢复码 / 吊销设备 / 口令缓存可选开关）与云端控制面 VPS 真机验收按详设（Phase 2）推进。
