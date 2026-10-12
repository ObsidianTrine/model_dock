# 安全政策（Security Policy）

**简体中文** ｜ [English](docs/en/SECURITY.md)
<!-- i18n-slot：新增语言时在上一行末尾追加链接（如 ｜ [日本語](docs/ja/SECURITY.md)），约定见 .agents/conventions/docs-writing.md -->

感谢帮助 ModelDock 变得更安全。**请勿在公开 issue 中报告安全漏洞。**

## 支持范围

仅**最新发布版本**接收安全修复；旧版本请先升级到最新版。

## 如何上报

**首选渠道：[GitHub Security Advisories 私密上报](https://github.com/ObsidianTrine/model_dock/security/advisories/new)**——不开公开 issue、不暴露细节。

上报时请尽量包含：

- 漏洞描述与影响（能拿到什么、能做什么）
- 复现步骤或 PoC（**注意脱敏，不要包含真实 API Key**）
- 受影响的版本 / 操作系统 / 安装方式

## 响应与披露

- **48 小时内**确认收到并开始评估
- 修复完成后与你协商披露时间（默认 **90 天**内公开）
- 公开披露时在 Release notes 中致谢（如你愿意署名）

## 范围界定

**在范围内**：

- 上游 API Key 的存储与泄漏（平台安全后端、secrets 文件、日志、接口响应）
- 网关认证与管理面（管理令牌、cookie、同源校验、审计日志）
- 客户端配置写入 / 还原（接入、断开、快照还原）中的注入、越权或凭据泄漏

**不在范围内**：

- 上游服务商自身的问题
- 需要已获得本机用户权限的攻击（网关仅监听 `127.0.0.1`，无远程暴露面）
- 依赖库的通用漏洞（请报给对应上游；若对 ModelDock 有实际影响仍欢迎告知）

安全设计与完整威胁模型见 [docs/design.md](docs/design.md)。