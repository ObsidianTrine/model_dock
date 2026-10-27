# ModelDock

**简体中文** ｜ [English](docs/en/README.md)
<!-- i18n-slot：新增语言时在上一行末尾追加链接（如 ｜ [日本語](docs/ja/README.md)），约定见 .agents/conventions/docs-writing.md -->

[![test](https://github.com/ObsidianTrine/model_dock/actions/workflows/test.yml/badge.svg)](https://github.com/ObsidianTrine/model_dock/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%E2%89%A522-brightgreen)
![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-lightgrey)

**本地模型配置托管中心 + API 网关**：一份配置管住所有 AI harness（Claude Code、ZCode、dsh、Codex、OpenCode、MiMo Code、MiMo 桌面端、WorkBuddy……），一次接入、随时切换、key 集中保管。

- 网关模式（默认）：harness 只需指向 `http://127.0.0.1:8687` 一次，切换 provider / 模型映射全部在 ModelDock 侧完成，即时生效，harness 配置文件里不再出现真实上游 key。
- 灵活路由：定时切换可按时段自动换服务（低谷/高峰/节假日，法定节假日自动识别），单个客户端可钉定专属服务/模型，也可切「直连」不经网关直接访问上游；主服务连不上、限流或额度用完时自动切到其他已启用的服务（自动备用链）。
- 非侵入：未执行 `attach` 前，ModelDock 对现有 harness 零写入；接入/切换等对客户端配置的写入前自动快照（`config.toml` 自身由锁 + 原子写保护），`detach` / `restore` 一键还原。
- 密钥安全：上游 key 集中存入平台安全后端（macOS Keychain / Windows DPAPI / Linux Secret Service，无钥匙环时回退机器绑定加密），存量明文自动迁移。
- 常驻可靠：`gateway install` 注册开机自启（macOS LaunchAgent / Linux systemd / Windows 启动文件夹），崩溃自动拉起，网关挂掉不再断连。
- 菜单栏常驻：macOS 菜单栏 / Windows 系统托盘常驻入口——打开控制台、在浏览器打开、切服务 / 换默认模型 / 接入断开客户端、开关自启、看日志、一键清理数据；关掉控制台窗口网关照常运行；「轻量模式」一键收起全部窗口、只留托盘常驻；托盘「退出」即停网关。
- 手机也能看：同一局域网内手机扫码打开简版控制台，查看状态、切换服务、调整自动路由，可常驻手机桌面当 App 用；主网关仍只监听本机，不对外开放（默认关闭，控制台顶部「手机远程」按钮一键开启）。
- 配置可搬家：控制台「配置包」一个入口管导出与导入——导出支持加密配置包文件（`modeldock config export` 同链路，服务、路由、自定义预设、定时规则连同 Key）、10 分钟一次性分享链接、以及让同网电脑直接来拉；导入从文件、链接或附近电脑三选一，替换前先预览清单。手机控制台也能扫码导出/导入当搬运工。
- 多机自动同步：`modeldock sync setup` 把同步目标设为 WebDAV 网盘或本地同步盘，多台电脑的服务、Key、路由改动自动双向收敛，冲突不丢数据；进阶可自建云端中枢（[docs/deploy-cloud.md](docs/deploy-cloud.md)），手机单页管理所有设备、远程切换服务。
- 一键升级：`modeldock update` 检查并安装新版本——下载、SHA256 校验、替换、自动重启网关一条命令完成，不再需要手动到 Releases 页下载重装；Web 控制台顶栏与托盘菜单也会提示新版本，弹窗里给出更新摘要与发布页链接，可在界面里一键升级。
- 可扩展：内置 adapter（Claude Code / ZCode / dsh / Codex / OpenCode / MiMo Code / MiMo 桌面端 / WorkBuddy / 通用 env）+ 声明式 adapter pack（零代码接入新 harness）。

## 快速开始

### 方式一：Windows 安装向导（推荐 Windows 用户）

从 [Releases](https://github.com/ObsidianTrine/model_dock/releases) 下载 `modeldock-<版本>-win32-x64-setup.exe`，双击安装：可选安装路径，自动写入 PATH 和开始菜单/桌面快捷方式（快捷方式启动托盘程序，双击直达控制台、无黑色命令行窗口）；卸载时自动还原所有客户端配置并清理。

> 安装包未做代码签名，SmartScreen 首次提示时点「更多信息 → 仍要运行」。免安装用户可下载 `modeldock-<版本>-win32-x64.zip` 解压后双击 `modeldock.exe`——首次双击会自动把 `modeldock` 命令装入 PATH，新开终端即可直接使用；也可双击 `ModelDockTray.exe` 免黑窗直达控制台。

### 方式二：macOS 拖拽安装（DMG，推荐 macOS 用户，要求 macOS 13.0+）

从 [Releases](https://github.com/ObsidianTrine/model_dock/releases) 下载 `modeldock-<版本>-darwin-x64.dmg`（Intel）或 `modeldock-<版本>-darwin-arm64.dmg`（Apple Silicon）：

1. 双击打开 DMG，把 **ModelDock** 拖入旁边的 **Applications** 文件夹
2. 首次打开：在「应用程序」中**右键 → 打开 → 打开**（未公证应用的常规放行方式，之后可正常双击启动）；若提示「已损坏」，在终端执行一次 `xattr -dr com.apple.quarantine /Applications/ModelDock.app`
3. 双击 ModelDock：自动后台启动网关（`127.0.0.1:8687`）、以独立应用窗口打开 Web 控制台，并自动安装 `modeldock` 命令行（可能弹一次管理员授权，用于写入 `/usr/local/bin`）；关闭控制台窗口后菜单栏托盘常驻，随时从托盘回到控制台，托盘「退出」停止网关

> 卸载：把 ModelDock 拖入废纸篓，再执行 `modeldock uninstall`——停止网关并移除命令行入口，**配置与密钥保留**，重装后自动接回；要彻底清除（含还原所有客户端），执行 `modeldock uninstall --purge`。

### 方式三：Linux / 命令行安装（tar.gz，无需 Node.js）

| 平台 | 文件 |
|------|------|
| Linux x64 | `modeldock-<版本>-linux-x64.tar.gz` |
| Linux ARM64 | `modeldock-<版本>-linux-arm64.tar.gz` |
| macOS Intel | `modeldock-<版本>-darwin-x64.tar.gz` |
| macOS Apple Silicon | `modeldock-<版本>-darwin-arm64.tar.gz` |

```bash
tar xzf modeldock-<版本>-<平台>.tar.gz
chmod +x modeldock
sudo mv modeldock /usr/local/bin/     # 或 PATH 里的其他目录
modeldock init
```

> 所有发布物的 SHA256 见 Release 附带的 `SHA256SUMS`。

> 网关也可通过命令行管理：`modeldock gateway start --daemon` / `modeldock gateway stop`；`modeldock gateway install` 注册开机自启（登录自动拉起、崩溃自动重启）。

### 从源码构建（需要 Node.js ≥22）

```bash
git clone https://github.com/ObsidianTrine/model_dock.git
cd model_dock && npm ci && npm run build
node dist/cli.js init     # 首启向导；开发调试用 `npm run dev -- <命令>` 直跑源码
```

### 手动等价流程

```bash
modeldock provider add            # 从预设库选择（火山方舟/DeepSeek/GLM/Kimi/MiMo/OpenAI…），粘贴 key 即用
modeldock profile use <name>      # 设置默认路由
modeldock gateway start           # 启动本地网关（127.0.0.1:8687）
modeldock attach claude-code      # 接管 Claude Code（先展示 diff，确认后写入并自动快照）
```

## 日常使用

```bash
modeldock status                # 总览：网关/active profile/各 harness 接管状态
modeldock test                  # 端到端连通性自测（key/模型/流式/延迟）
modeldock doctor                # 逐 harness 体检；--fix 自动修复（敏感项确认），--json 机器可读
modeldock gateway log -f        # 网关请求日志（不落 prompt）
modeldock profile use <name>    # 切换 provider，网关模式即时生效，零改动 harness
modeldock gateway install       # 开机自启（常驻）：登录自动拉起、崩溃自动重启
modeldock update                # 一键升级：下载 → 校验 → 替换 → 自动重启网关（--check 只看不安）
modeldock model refresh <id>    # 自动拉取上游可用模型列表
modeldock config export         # 换电脑搬家：导出口令加密配置包（服务/路由/预设/定时，连同 Key）；默认名带日期时间，-o 指定路径
modeldock config import <file>  # 新电脑导入：预览将替换的内容 → 确认 → 自动备份后应用
modeldock sync setup            # 多台电脑自动同步：目标=WebDAV 网盘/本地同步盘，改动自动双向收敛
modeldock detach <harness>      # 还原 attach 前的原始配置
modeldock reset                 # 重置配置（快照保留，可重新 init）；--deep 连日志、同步状态与缓存一起清
modeldock uninstall             # 卸载程序（配置与密钥保留）；--purge 连配置一起彻底清除
```

> Web 控制台：网关运行时执行 `modeldock ui`（或浏览器开 `http://127.0.0.1:8687`）——总览仪表盘、一键切换路由、定时切换（按时段/法定节假日自动换服务）、新建 Profile、换 key、一键迁移旧配置、客户端「安装并接入」（本机没装 Node.js 也能装，自动下载托管运行时）、实时日志；局域网内手机扫码可开简版控制台。

> 中英文界面：命令行输出与报错默认中文，`modeldock --lang en`（加在命令任意位置）切英文；也可设环境变量 `MODELRDOCK_LANG=en` 或在 config.toml 写 `language = "en"` 持久生效；Web 控制台顶栏随时切换中英文，报错等服务端提示同步跟随。

## 文档

- **使用指南：[docs/usage.md](docs/usage.md)**（配置与日常操作全流程）
- 英文版文档：[docs/en/](docs/en/)（README / CHANGELOG / 使用指南等镜像，随版本同步）
- 设计文档：[docs/design.md](docs/design.md)（架构、ADR、威胁模型）
- 换电脑与多机同步：[docs/multi-machine-sync.md](docs/multi-machine-sync.md)（网盘同步盘接入新电脑的完整步骤与排错）
- 云端部署：[docs/deploy-cloud.md](docs/deploy-cloud.md)（自建云端同步中枢 runbook）
- 更新日志：[CHANGELOG.md](CHANGELOG.md)

## 安全

网关仅监听 `127.0.0.1`，不支持远程访问（设计如此）；上游 key 只存本机安全后端，harness 配置中只出现本地 token；请求日志只记元数据、不落 prompt。完整威胁模型与安全设计见[设计文档 §9](docs/design.md#9-安全设计)。发现安全漏洞？请按[安全政策](SECURITY.md)私密上报。

## 参与贡献

欢迎提 [Issue](https://github.com/ObsidianTrine/model_dock/issues) 反馈问题与建议。提交 PR 前请先读[贡献指南](CONTRIBUTING.md)与 [AGENTS.md](AGENTS.md)（工程约定与硬性约束），并确保 `npm test` 全绿。

## 维护者

[@ObsidianTrine](https://github.com/ObsidianTrine)

## 许可证

[MIT](LICENSE) © ObsidianTrine
