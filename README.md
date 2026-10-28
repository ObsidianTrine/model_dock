# ModelDock

**简体中文** ｜ [English](docs/en/README.md)
<!-- i18n-slot：新增语言时在上一行末尾追加链接（如 ｜ [日本語](docs/ja/README.md)），约定见 .agents/conventions/docs-writing.md -->

[![test](https://github.com/ObsidianTrine/model_dock/actions/workflows/test.yml/badge.svg)](https://github.com/ObsidianTrine/model_dock/actions/workflows/test.yml)
[![Release](https://img.shields.io/github/v/release/ObsidianTrine/model_dock)](https://github.com/ObsidianTrine/model_dock/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%E2%89%A522-brightgreen)
![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-lightgrey)

**本地模型配置托管中心 + API 网关**：把所有 AI 客户端（Claude Code、ZCode、dsh、Codex、OpenCode、MiMo、WorkBuddy……）的 `base_url` + API Key 收进一处统一管理。客户端只需指向本机网关一次，此后换供应商、换模型映射都在 ModelDock 侧完成——即时生效，客户端配置零改动。

## 解决什么问题

- 每个客户端各配各的地址和 key，换供应商要挨个改配置、逐个重启才生效；
- 真实上游 key 散落在各个客户端配置文件里，难看管、易泄露；
- 主力服务限流、挂掉或额度用完时，流量没有备用去处。

ModelDock 用一个只监听本机的网关收口：**密钥集中保管、切换即时生效、故障自动兜底**——且在你主动接入之前对现有配置只读不写，随时可还原。

![ModelDock Web 控制台：服务与路由、定时切换、客户端接入](docs/images/console.png)

## 工作原理

```
AI 客户端 (Claude Code / ZCode / dsh / Codex / ...)
   │  base_url 指向 http://127.0.0.1:8687 + 本地 token
   ▼
ModelDock 网关（仅监听本机 127.0.0.1）
   │  选路由 → 重写模型别名 → 注入真实 key
   ▼
上游 API (火山方舟 / DeepSeek / GLM / Kimi / OpenAI / ...)
```

## 核心能力

| 领域 | 你能得到什么 |
|------|--------------|
| **一处切换** | `modeldock profile use <name>` 或控制台点一下，所有已接入客户端即时生效，配置文件零改动 |
| **自动兜底与定时路由** | 主服务连不上 / 限流 / 额度用完，自动切到其他已启用服务；可按时段自动换服务（法定节假日自动识别）；单个客户端可钉定专属服务 / 模型，或切「直连」不经网关 |
| **密钥安全** | 上游 key 只存本机安全后端（macOS Keychain / Windows DPAPI / Linux Secret Service，无钥匙环时回退机器绑定加密）；客户端配置里只有本地 token，明文存量自动迁移 |
| **非侵入可回退** | 未 `attach` 前对你现有配置只读不写；写入客户端配置前自动快照，`detach` / `restore` 一键还原 |
| **常驻可靠** | `gateway install` 开机自启 + 崩溃自动拉起；macOS 菜单栏 / Windows 托盘常驻，关掉控制台窗口网关照跑，「轻量模式」一键只留托盘 |
| **Web 与手机控制台** | 切路由、定时切换、换 key、装新客户端全都有图形界面；局域网内手机扫码开简版控制台，远程看状态、切服务（默认关闭，一键开启） |
| **搬家与多机同步** | 加密配置包导出 / 导入 / 10 分钟一次性分享链接；`modeldock sync setup` 走 WebDAV 网盘或本地同步盘，多台电脑双向自动收敛，冲突不丢数据 |
| **升级与扩展** | `modeldock update` 一条命令完成下载 → 校验 → 替换 → 自动重启；内置适配器（Claude Code / ZCode / dsh / Codex / OpenCode / MiMo / WorkBuddy / 通用 env），新客户端零代码声明式接入；存量配置可从 cc-switch、claude-code-router、one-api / new-api 等来源一键导入 |

## 快速开始

### 1. 安装

从 [Releases](https://github.com/ObsidianTrine/model_dock/releases) 下载对应平台安装包：

| 平台 | 下载 | 说明 |
|------|------|------|
| Windows | `modeldock-<版本>-win32-x64-setup.exe` | 安装向导：可选路径，自动写 PATH 与快捷方式；免安装用同目录 `.zip` |
| macOS 13.0+ | `modeldock-<版本>-darwin-x64.dmg`（Intel）/ `-arm64.dmg`（Apple Silicon） | 拖入 Applications 即完成安装，自动装好 `modeldock` 命令行 |
| Linux / 命令行 | `modeldock-<版本>-linux-x64.tar.gz` / `-arm64.tar.gz` | 解压移入 PATH 即可，无需 Node.js |

```bash
# Linux / 命令行安装示例
tar xzf modeldock-<版本>-<平台>.tar.gz
chmod +x modeldock
sudo mv modeldock /usr/local/bin/     # 或 PATH 里的其他目录
```

> 所有发布物的 SHA256 见 Release 附带的 `SHA256SUMS`。SmartScreen / Gatekeeper 首次放行、卸载等细节见[使用指南 · 安装与构建](docs/usage.md#2-安装与构建)。

### 2. 上手

**最快路径**——一条命令向导：自动发现本机客户端与存量供应商配置（cc-switch / Claude Code / Codex / claude-code-router 等 10+ 来源），勾选导入 key、设默认路由、后台起网关、逐个确认接入：

```bash
modeldock init
```

**手动等价**：

```bash
modeldock provider add              # ① 预设库选服务（火山方舟/DeepSeek/GLM/Kimi/MiMo/OpenAI…），粘贴 key 即用
modeldock profile use auto-<服务id>  # ② 设默认路由（add 会自动建 auto-<服务id>；modeldock profile list 查看）
modeldock gateway start --daemon    # ③ 后台启动本地网关（127.0.0.1:8687）
modeldock attach claude-code        # ④ 接管 Claude Code（先展示 diff，确认后写入并自动快照）
```

接入后跑一次 `modeldock test` 做端到端连通性自测（key / 模型 / 流式 / 延迟）。

> Web 控制台：网关运行时执行 `modeldock ui`（或浏览器开 `http://127.0.0.1:8687`）——上面这些操作都有图形界面，顶栏随时切换中英文。

### 从源码构建（需要 Node.js ≥22）

```bash
git clone https://github.com/ObsidianTrine/model_dock.git
cd model_dock && npm ci && npm run build
node dist/cli.js init     # 首启向导；开发调试用 `npm run dev -- <命令>` 直跑源码
```

## 日常使用

```bash
modeldock status                # 总览：网关/active profile/各客户端接管状态
modeldock test                  # 端到端连通性自测（key/模型/流式/延迟）
modeldock doctor                # 逐客户端体检；--fix 自动修复（敏感项确认），--json 机器可读
modeldock gateway log -f        # 网关请求日志（不落 prompt）
modeldock profile use <name>    # 切换 provider，网关模式即时生效，零改动客户端
modeldock gateway install       # 开机自启（常驻）：登录自动拉起、崩溃自动重启
modeldock update                # 一键升级：下载 → 校验 → 替换 → 自动重启网关（--check 只看不安）
modeldock model refresh <id>    # 自动拉取上游可用模型列表
modeldock config export         # 换电脑搬家：导出口令加密配置包（服务/路由/预设/定时，连同 Key）
modeldock config import <file>  # 新电脑导入：预览将替换的内容 → 确认 → 自动备份后应用
modeldock sync setup            # 多台电脑自动同步：目标=WebDAV 网盘/本地同步盘，改动自动双向收敛
modeldock detach <harness>      # 还原接入前的原始配置
modeldock reset                 # 重置配置（快照保留，可重新 init）；--deep 连日志、同步状态与缓存一起清
modeldock uninstall             # 卸载程序（配置与密钥保留）；--purge 连配置一起彻底清除
```

> 中英文界面：命令行输出与报错默认中文，`modeldock --lang en`（加在命令任意位置）切英文；也可设环境变量 `MODELRDOCK_LANG=en` 或在 config.toml 写 `language = "en"` 持久生效；Web 控制台顶栏随时切换，报错等服务端提示同步跟随。

## 文档

| 文档 | 内容 |
|------|------|
| **[使用指南](docs/usage.md)** | 核心概念、安装细节、日常操作全流程（README 展不开的都在这里） |
| [配置参考](docs/config-reference.md) | `config.toml` 全部配置键的类型、默认值与说明（由脚本生成，与代码同源） |
| [换电脑与多机同步](docs/multi-machine-sync.md) | 同步盘接入新电脑的完整步骤与排错 |
| [云端部署](docs/deploy-cloud.md) | 自建云端同步中枢 runbook，手机单页管理所有设备 |
| [设计文档](docs/design.md) | 架构、ADR、威胁模型 |
| [更新日志](CHANGELOG.md) | 每个版本的用户可见变化 |
| 英文文档 | [docs/en/](docs/en/)（README / 使用指南等英文镜像，随版本同步） |

## 安全

网关仅监听 `127.0.0.1`，不支持远程访问（设计如此）；上游 key 只存本机安全后端，客户端配置中只出现本地 token；请求日志只记元数据、不落 prompt。完整威胁模型与安全设计见[设计文档 §9](docs/design.md#9-安全设计)。发现安全漏洞？请按[安全政策](SECURITY.md)私密上报。

## 参与贡献

欢迎提 [Issue](https://github.com/ObsidianTrine/model_dock/issues) 反馈问题与建议。提交 PR 前请先读[贡献指南](CONTRIBUTING.md)与 [AGENTS.md](AGENTS.md)（工程约定与硬性约束），并确保 `npm test` 全绿。

## 维护者

[@ObsidianTrine](https://github.com/ObsidianTrine)

## 许可证

[MIT](LICENSE) © ObsidianTrine
