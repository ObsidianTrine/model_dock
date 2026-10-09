# 多机配置同步：本机实录 + 新电脑接入指南

> 适用：`modeldock sync setup` 的**本地同步盘（localdir）**目标（Google Drive / iCloud / OneDrive / 坚果云同步盘…），文末附 WebDAV 差异。
> 本文是"照着做就能成"的操作手册，不是设计文档；设计取舍见 [design-cloud-sync.md](design-cloud-sync.md)。

## 0. 先建立心智模型（不懂这条必然踩坑）

**ModelDock 不连网盘 API。** 它只是往一个普通本地目录里读写文件（`src/sync/targets/localdir.ts` 全文 41 行，纯 `fs`）。上传/下载完全交给网盘客户端。

所以一次同步由**两段独立的链路**拼成，缺任何一段都不通：

```
本机 ModelDock  ──写文件──▶  本地目录（网盘客户端在盯）  ──网盘客户端上传──▶  云
                                                                             │
新电脑 ModelDock ◀──读文件──  本地目录（网盘客户端在盯）  ◀──网盘客户端下载──┘
        ▲
        └── 但这一段必须先在【新电脑上手动跑一次 sync setup】才会存在
```

**最常见的误解**：以为"我在 A 机配了 Google Drive 同步，B 机登录同一账号看到那个文件夹，就该自动同步"。
**不会。** 因为本机的同步凭据存在 `~/.modeldock/sync.json`，而那个文件**被设计为不参与同步**（凭据不能随包被同步回去）。B 机的 ModelDock 处于 `mode: off`，它**根本不会去看那个文件夹**。

---

## 1. 本机（源机）当前配置实录

### 1.1 现状快照

| 项 | 值 | 怎么查 |
|---|---|---|
| 同步模式 | `target`（网盘目录模式，非云中台模式） | `modeldock sync status` |
| 目标类型 | `localdir` | 同上「目标：localdir · …」 |
| 同步目录 | `~/Library/CloudStorage/GoogleDrive-<你的 Google 账号>/我的云端硬盘/modeldock` | 同上，或读 `~/.modeldock/sync.json` 的 `target.dir` |
| 本机设备号 | `mdksync_7b34def3…`（`sync.json` 的 `devid`） | `modeldock sync status` |
| 当前版本号 | rev 32（每次推送 +1；blob 只增不删） | 同上「已同步到第 N 版」 |
| 口令缓存 | `sync.json` 的 `key.{salt,hkdfSalt,encKey,macKey,verifier}` | 勿手改；换机靠口令重新派生 |
| 引擎挂载点 | **网关进程内**（`remountSyncEngine`，`src/gateway/main.ts`） | 网关在跑才有自动同步 |
| 同步节奏 | 网盘目标：120s ± 30%；本地改动后 3s 防抖即时推 | 代码常量，不可配 |

> 账号部分按 PII 惯例隐去了；本机精确值以 `modeldock sync status` 输出为准（路径里含你自己的邮箱，别照抄本文）。

### 1.2 同步目录长什么样

```
<你选的目录>/                                ← sync setup 时填的 dir
└── modeldock-sync/                          ← 固定子目录名（SYNC_DIRNAME）
    ├── manifest.json                        ← { rev, ts, byDevid, blobRef }「最新版指向谁」
    └── blobs/
        ├── 1-mdksync_7b34def3….msync         ← 加密信封，只增不删，保留全部历史
        ├── 2-mdksync_7b34def3….msync
        └── …  32-mdksync_7b34def3….msync
```

- 每个 `.msync` 是一个 **AES-256-GCM 加密的整包配置**（含明文 key），口令派生密钥，网盘服务商只能看到密文。
- `manifest.json` 是唯一的"当前版本指针"，靠 `rev` 单调递增实现乐观锁。

### 1.3 当初这台机器是怎么配的（可原样复现）

1. 装 **Google Drive for desktop**，登录账号，在网盘里建（或选用）一个文件夹，例如 `我的云端硬盘/modeldock`。
2. 装 **ModelDock**（DMG / setup.exe / tar.gz，见 [usage.md](usage.md) §2）。
3. 跑 `modeldock sync setup`：
   - 目标类型选 **本地同步盘目录（iCloud / OneDrive…）**；
   - 目录填上一步那个文件夹的**本机路径**；
   - 设**同步口令**（交互输两遍，不回显）。
   - 因为目标当时是空的 → 本机会被作为 **rev 1** 首推上去，输出「✓ 多机同步已启用」。
4. 起网关（菜单栏托盘 / `ModelDock.app` / `modeldock gateway start`），之后才有轮询与即时推。
5. 之后每改一次配置（加服务、换 Key、改路由），3 秒内自动推一版；其他机器一两分钟内跟上（轮询 120s ± 30%）。

**口令是唯一的关键信息**，请自己另存一份。遗忘后已同步的密文无法恢复（无后门、无恢复码）。

---

## 2. 哪些内容会同步，哪些不会

同步 = 一份 `syncdoc`：**服务（provider，含明文 key）+ 路由（profile）+ 自定义预设 + 定时规则**。

**刻意不同步（"机器态"，每台机器各自独立）**：

- 各客户端的接入状态与客户端自己的配置文件（claude-code / zcode / dsh… 的配置不会被动）
- 网关端口与转发设置、当前激活路由、开机自启
- 请求日志与用量统计
- **`sync.json` 本身**（同步凭据 + 设备号，正是它不能被同步走，否则会互相覆盖凭据）

**Key 的迁移规则**（`src/sync/collect.ts`）：

| 本机 key 存储方式 | 是否会迁到新电脑 |
|---|---|
| `keychain:` / `file:` / `secret-service:` / `plain:` | **会**——解析成明文封进加密包，新电脑 setup 后自动重存进它自己的钥匙串 |
| `env:VAR` 环境变量引用 | **不会**——机器态，新电脑需自行设置同名环境变量 |
| 导出机上已读取不到 | **不会**——命令会提示 `modeldock provider set-key <id> 补填` |

本机 9 个服务的 key 全是 `file:` / `keychain:`，**属于第一种，会完整迁移**，新电脑不用重新填 key。

---

## 3. 新电脑接入：完整步骤

### 前置检查（**这一步跳过是最常见的失败原因**）

在文件管理器里确认新电脑上能看到这个文件：

```
<同步目录>/modeldock-sync/manifest.json
```

- **看不到就停下来**：说明 Google Drive 没装好 / 没登录同一账号 / 还在首次同步中。先解决网盘，再往下走。
- 路径和源机**不一样**（用户名不同；Windows 是 `G:\我的云端硬盘\modeldock` 这类虚拟盘符，或 `%USERPROFILE%\Google Drive\...`）。以新电脑上的实际路径为准。

### 步骤

**① 装 Google Drive for desktop**，用**同一个账号**登录，等 `modeldock-sync/` 目录在本地出现。

**② 装 ModelDock 本体**（程序不随同步迁移，必须单独装）：从 Releases 下对应平台的安装包（或从源码构建，见 [usage.md](usage.md) §2）。

**③ 跑一次 setup，指向那个目录，输入同一口令：**

```bash
modeldock sync setup --target localdir --dir "<新电脑上的实际路径>"
# 或者不带参数，走交互式选择（推荐，不容易填错路径）
modeldock sync setup
```

正确时的输出：

```
✓ 已加入多机同步：/Users/…/我的云端硬盘/modeldock（已应用其他机器的第 32 版配置）
```

注意 **「已加入」** 这个词——它意味着 setup 读到了远端 manifest、用你输的口令解开了最新包，并**当场把配置写进本机**。这一步**不需要网关在跑**，跑完即可用。

**④ 起网关**（托盘 / `ModelDock.app` / `modeldock gateway start`）。从此双向自动：本机改动 3 秒内推、远端新版本一两分钟内拉。

**⑤ 验证：**

```bash
modeldock sync status
```

期望看到：

```
多机同步 · 运行中
  目标：localdir · /Users/…/我的云端硬盘/modeldock
  本机设备：mdksync_xxxxxxxx…
  已同步到第 32 版
  最近推送 / 拉取：…
```

并打开 Web 控制台确认服务列表、路由、Key 都到位（本机的 key 应显示"已设置"）。

> WebDAV 目标（坚果云 / Nextcloud / 群晖）流程完全相同，只是第 ③ 步换成
> `modeldock sync setup --target webdav --url https://dav.jianguoyun.com/dav/ --dir modeldock --username <邮箱> --password <应用密码>`。

---

## 4. 排错对照表

| 现象 | 含义 | 处理 |
|---|---|---|
| `sync status` 说「多机同步未启用」 | 新电脑从没跑过 setup，`mode: off` | 回到 §3 步骤 ③ |
| setup 输出「✓ 已启用…（本机配置已作为第 1 版推送）」而不是「已加入」 | **有远端 manifest 却没读到** → 目录填错/Drive 尚未就绪，本机误开成一个独立孤岛（本地能看，实际什么都没同步） | 停下来核对路径；若已在错误位置建了 `modeldock-sync/`，删掉该目录重跑。**孤岛期间新电脑上的配置改动不要指望会过去** |
| setup 报「口令与该同步目标不一致」 | 口令不是源机那一个 | 重跑输入正确口令。此处不会污染目标，可反复重试 |
| 报「同步历史包缺失（blobs/N-….msync）」 | 网盘**先传了 manifest 后传 blob** 的上传顺序竞态，不是配置坏了 | 等 1–2 分钟网盘传完，重跑 `modeldock sync setup` 或 `sync status` 看是否自愈 |
| `sync status` 说「等待网关接管」 | 正常提示，不是故障：`sync.json` 已就绪但网关没在跑 | 起网关即可 |
| 状态行/控制台出现「最近冲突」 | 两台机器都改过，冲突已按「远端胜」处理，本机改动**已快照**到 `~/.modeldock/backups/sync-conflict-<时间戳>.json` | 打开快照文件对比差异，在任一机器手工补做。**不做自动合并**是设计决策（D6） |
| 报「sync.json 不是合法 JSON / 版本不受支持」 | 本地状态文件损坏 | 修好或删掉 `~/.modeldock/sync.json`，重跑 setup |
| 报「首推时目标上已出现更新版本」 | 两台机器同时在一个空目标上 setup | 重跑 setup；已有数据的那台先跑 |

---

## 5. 红线（做了会出麻烦）

- **不要**把源机的 `~/.modeldock/sync.json` 拷贝到新电脑。里面是源机的 `devid` + 端口/状态簿记，两台会共用一个设备身份，冲突与状态判断全乱。新电脑一律走 `sync setup`。
- **不要**把 `--dir` 指向一个空目录或写错的路径后照常使用（见上表第 2 行，会静默变孤岛）。
- **不要**在两台机器上同时改同一批配置。冲突不丢数据（有快照），但得你自己手工补差异。
- **不要**手改 `modeldock-sync/manifest.json` 或删 `blobs/`。blob 只增不删是历史回溯的前提。
- 同步与网关端口**无关**：两台机器各自跑自己的 8687 互不干扰。
- 忘记口令 = 密文不可恢复。口令只存在于你脑子里和各机 `sync.json` 的派生缓存里。

---

## 6. 其他搬配置的方式（对比）

同步是"持续双向"方案。若只是**一次性搬家**或**同一局域网临时搬**，项目里另有更轻的路径（详见 [usage.md](usage.md) §5「多机同步与云端管理」）：

| 方式 | 命令 / 入口 | 适用 |
|---|---|---|
| 加密配置包（文件） | `modeldock config export` → `config import` | 一次性迁移、备份；微信/U 盘传递 |
| 一次性局域网链接 | 控制台「手机远程」面板 →「分享配置到附近电脑…」 | 同一 Wi-Fi 下换机，10 分钟有效、被拉取一次即作废 |
| 附近电脑点选 | 新机「从其他电脑导入」→「搜索附近的电脑…」 | 同网段、免复制粘贴（UDP 广播，需旧机确认） |
| **网盘持续同步** | `modeldock sync setup`（本文） | **多台长期保持一致，改一处全机跟上** |
| 云中台 | `modeldock sync enroll --server … --code …` | 自建控制面，手机远程切换服务（[deploy-cloud.md](deploy-cloud.md)） |
