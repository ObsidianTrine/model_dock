# ModelDock 云端控制面部署 runbook（M3）

**简体中文** ｜ [English](en/deploy-cloud.md)
<!-- i18n-slot：新增语言时在上一行末尾追加链接（如 ｜ [日本語](ja/deploy-cloud.md)），约定见 .agents/conventions/docs-writing.md -->

> 对应详设 `docs/design-cloud-sync.md` §7.7。服务端零第三方依赖（`node:http` + `node:sqlite`，Node ≥22.5，部署机统一 Node 24 LTS），与主仓同栈同测。

| 文档属性 | 内容 |
|---|---|
| 云端地址 | **`203.0.113.10:18443`【占位 IP（RFC 5737 文档保留段）——购买 VPS 后全文搜索替换为真实地址】** |
| 部署机 | 阿里云 ECS 2C2G 99 元/年档（续费同价；腾讯轻量同价位可替代），Ubuntu 24.04 LTS |
| 数据目录 | `/var/lib/modeldock-cloud`（systemd `StateDirectory`） |
| 端口 | 仅放行 TCP `18443`（示例端口，可改）+ SSH 22（限自己 IP） |
| 状态 | runbook 已就绪并随 v1.0.0 发布；**待执行**（VPS 未购，2026-10-11 确认）——购机后按 §1 起逐节执行，替换全文占位 IP |

> **共享基建**：本 VPS 未来兼作**自动更新源**（`docs/design-auto-update.md` M3）——部署时预留更新源端口/反代，TLS 证书与控制面统一拍板（两详设开放问题同源）。

---

## 1. 购买与初始化

1. 购买 ECS（地域就近），系统镜像 Ubuntu 24.04 LTS；安全组仅放行：SSH(22，限自己 IP) + TCP `18443`。
2. SSH 密钥登录、禁密码（`PasswordAuthentication no`）；服务器上不跑其他服务。

## 2. 运行

```bash
git clone <本仓库> modeldock && cd modeldock
# 装 Node 24 LTS（NodeSource 或 nvm）
npm ci && npm run build
node dist/cloud/main.js --port 18443 --host 0.0.0.0 --data /var/lib/modeldock-cloud
```

- 首次启动会生成 `consoleToken` 写入 `/var/lib/modeldock-cloud/cloud.json`（0600）并打印到 stdout——**这是云端控制台登录凭据，请立即存入密码管理器**。
- 限速默认单 IP 60 req/min（详设 §7.2）；需调整时加 `--rate-limit <次/分>`。
- 域名非必需（裸 IP + 端口，免备案）；将来上域名（含备案）再切 Let's Encrypt TLS。
- 防火墙只开 18443；`curl http://127.0.0.1:18443/` 本机自检。

## 3. systemd 常驻

`/etc/systemd/system/modeldock-cloud.service`：

```ini
[Unit]
Description=ModelDock Cloud control plane
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/node /root/modeldock/dist/cloud/main.js --port 18443 --host 0.0.0.0 --data /var/lib/modeldock-cloud
Restart=always
RestartSec=3
StateDirectory=modeldock-cloud
# StateDirectory 保证 /var/lib/modeldock-cloud 存在；ExecStart 的 --data 显式指向同一目录
# 环境不同按实际 Node 路径调整（which node）

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload && systemctl enable --now modeldock-cloud
journalctl -u modeldock-cloud -f
```

## 4. 每日备份（crontab）

```cron
30 4 * * * /usr/bin/node /root/modeldock/dist/cloud/main.js --backup --data /var/lib/modeldock-cloud >> /var/log/modeldock-cloud-backup.log 2>&1
```

`--backup` 用 SQLite `VACUUM INTO` 在线快照到 `<data>/backups/`，自动保留最近 14 份。

**恢复**：`systemctl stop modeldock-cloud` → 用某份快照覆盖数据目录的 `cloud.db`，并删掉同目录的 `cloud.db-wal` / `cloud.db-shm` 残留（WAL 模式下旧日志不能与新库混用）→ `systemctl start modeldock-cloud`。`cloud.json`（consoleToken）不在数据库里、保持不动，控制台登录不受影响；快照之后新入网的设备会回到快照时点，需重新配对。

## 5. 升级

```bash
cd /root/modeldock && git pull && npm ci && npm run build && systemctl restart modeldock-cloud
```

API v1 内向后兼容演进；破坏性变更升 `/v2`。

## 6. 安全清单

- 仅一个业务端口对外；SSH 密钥登录禁密码；`cloud.json` 0600；服务器上无其他服务。
- **明文 HTTP 阶段的残余风险**：token 可被链路窃听者重放——但读到的只是密文（E2E 加密兜底），写入受 ts 单调性 + HMAC 限制为「无法伪造新内容」。TLS 为第一优先升级项（见 §7）。
- 控制台 token 爆破防护：限速 60 req/min；token 高熵；HttpOnly + SameSite=Strict cookie。

## 7. 传输加密路线

- M3 上线允许 IP+HTTP（端到端加密兜底）。
- v1.1 升级：自签/IP SAN 证书（ZeroSSL 支持 IP 证书）或域名+备案+Let's Encrypt。上 TLS 后客户端 `sync enroll --server https://…` 换 https 地址即可。

## 8. 更换服务器地址（购买后替换占位 IP）

- **服务端**：部署时 `--port`/`--host`/`--data` 全部由参数注入，代码零硬编码；把本文档与 systemd unit 里的 `203.0.113.10` 换成真实 IP 即可。
- **客户端**（每台电脑）：`modeldock sync enroll --server http://<真实IP>:18443 --code XXXX-XXXX` 重新入网（新服务器=新 consoleToken=新配对码，属全新入网；同机换 IP/域名/协议而数据目录迁移的情况，直接改 `~/.modeldock/sync.json` 的 `cloud.url` 也生效）。
- **数据迁移**：整目录拷贝 `/var/lib/modeldock-cloud`（含 cloud.db 与 cloud.json），consoleToken 不变、设备无需重新配对。

## 9. 客户端接入（验收路径）

1. 控制台（手机或电脑浏览器开 `http://<IP>:18443/`）→ 粘贴 consoleToken 登录 → 生成配对码。
2. 电脑上 `modeldock sync enroll --server http://<IP>:18443 --code XXXX-XXXX`，输入同步口令。
3. 手机控制台应看到该设备上线（180s 心跳窗口）；点设备切换服务，≤1 分钟内本机生效（详设 D4 分钟级语义）。
4. 拔云端（防火墙临时封 18443）：两台电脑网关工作不受影响，恢复后自动续同步。
