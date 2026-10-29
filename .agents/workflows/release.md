# release（发布工作流）

把版本发布固化为可核对清单，防止步骤错序触发错误的 GitHub Release。

> **何时用**：需要对外发布新版本（打 tag）时。
> **红线**：发布是**不可逆的公开动作**——tag 一旦推送，release.yml 会自动为 5 平台构建并发布到 Releases。错发 tag 的清理代价远高于多检查一遍。

## 版本号怎么定（semver）

- **新功能**递增 minor（1.2.0 → 1.3.0）；**纯修复**递增 patch（1.2.0 → 1.2.1）。
- **破坏性改动**（删命令、配置格式不兼容）递增 major（1.x → 2.0.0）；1.0.0 之前按 0.x 惯例走 minor（0.3.0 → 0.4.0）。
- 版本号按 CHANGELOG「未发布」段内容定档；**公开发布过的版本号永不复用**（见「出错回滚」）。

## 前置检查（动手前，在 develop 上）

- [ ] 当前在 `develop` 分支，`git status` 干净，且 `git log origin/develop..develop` 为空（本地不领先远程）。
- [ ] 机器门禁全过：`node scripts/release-check.mjs vX.Y.Z`（含 npm test + test:workflow 两套件，约 5 分钟；清单见 `docs/RELEASE_CHECKLIST.md`，⚠ 警告项须逐条过目）。
- [ ] 托管 Node 钉版核对含在门禁内（npm 客户端 engines 冲突会 ✗ 阻断、补丁滞后/新 LTS 大版本会 ⚠ 提示）：出现 ⚠ 时按 `docs/RELEASE_CHECKLIST.md` §2 的年度评估条目裁决是否随本版 bump `MANAGED_NODE_VERSION`。

## 流程（严格按顺序，不可跳步）

### 1. 盘点发布内容，按规范更新 CHANGELOG 与 README（develop 上）

**先盘点**——列出上个 tag 到当前 develop 的全部内容提交（merge 节点不算）：

```bash
git log vX.Y.Z..develop --oneline --no-merges    # vX.Y.Z 替换为上一个已发布的 tag
```

> 懒人路径：`node .agents/scripts/orchestrator.mjs release-propose` 自动完成盘点、semver 定档与 CHANGELOG 草稿（含未发布段漏记初筛），产出提案文件供核对采纳——版本号仍是建议，采纳与否人工定（见 `.agents/workflows/orchestrator.md`「发版提案」）。

- 上个 tag 打在 main 侧，develop 的 `git describe` 够不着它，这里必须显式写 tag 名。
- 逐条归纳成「新增 / 变更 / 修复」清单：既查漏（开发中没记进 CHANGELOG 的改动），也查杂（不该进这个版本的内容）。

**再更新文档**——以清单为依据逐项核对：

- **CHANGELOG**：开发期已记入「未发布」段的核对措辞，漏记的补上；然后把「未发布」段归并进新版本段 `## [X.Y.Z] - YYYY-MM-DD`（日期 = 实际发布日）；文末版本链接表同步补一行。
- **README**：用户可感知的新能力补 bullet、新增命令进命令表、文档区链接核对。
- 其他对外文档（如 usage.md）有对应变更的一并同步。
- 条目规范必读 `.agents/conventions/docs-writing.md`：用户视角、一条一事、粗体点题、不写内部实现黑话（CHANGELOG 与 README 同一规范）。
- 提交：`git commit -m "docs: release vX.Y.Z changelog/readme 收口"`。main 不直改（含 CHANGELOG，分支卫生规则），文档一律随 develop 合入。

### 2. develop 合入 main 并推送

```bash
git checkout main
git merge develop
git push origin main
```

- 推送前在 main 上过一遍自上次 tag 以来的提交，确认没有遗漏该发的、也没有混入不该发的：

  ```bash
  git log $(git describe --tags --abbrev=0)..HEAD --oneline
  ```

  注意此检查必须在 main 上做——tag 都打在 main 侧提交上，develop 的 `git describe` 够不着它们。
- 若 main 上存在 hotfix 提交（`hotfix.md` 流程），必须先回合 develop 再发布——`release-check` 的「main 存在 develop 缺失的内容提交」会在此阻断。

### 3. 等 test workflow 全绿

- 推送后到 GitHub 仓库网页的 **Actions** 标签页看 `test.yml` 跑完且**全部 job 全绿**（三平台矩阵 + 工作流套件共 4 个 job；已装 gh CLI：`gh run watch` 盯进度；网页亦可）。
- **盯 run 必按 workflow 过滤并以提交核对**：`gh run list --branch main --workflow=test` + headSha 比对——同分支混着 Dependabot 等 run，裸 `--limit 1` 会盯错对象（v1.2.3 实证）。
- CI 腿被「未获分配」取消（典型：macos arm64 runner 容量短缺，排队 15 分钟即取消）时，**ci-retry.yml 自动重跑失败腿**（≤3 次尝试，只重跑最新 run）；连续多轮仍取消 = 平台故障，等恢复后 `gh run rerun <run-id> --failed` 补一脚即可，不必重推。
- **不绿就停**：在 develop 修好后重新合入 main 并推送，回到本步。绝不带病打 tag。

### 4. 打 tag，只推这一个

- tag 前把机器门禁再跑一遍：`node scripts/release-check.mjs vX.Y.Z --skip-test`（快速复核 CHANGELOG 段、链接表、版本号占用与递增）。此时在 main 上跑，「当前在 main 分支」warn 属预期，其余 ⚠ 仍须逐条过目。
- 先确认版本号未被占用（两条都应无输出；撤回过的版本号不可复用）：

  ```bash
  git tag -l vX.Y.Z
  git ls-remote --tags origin vX.Y.Z
  ```

- 打 annotated tag，只推这一个：

  ```bash
  git tag -a vX.Y.Z -m "vX.Y.Z"
  git push origin vX.Y.Z
  ```

- ❌ **禁止** `git push --tags`：会把本地所有 `v*` tag 一并推出，每个都触发一次 Release。
- tag 名即版本号唯一事实来源（`scripts/build-sea.mjs` 用 `git describe --tags --abbrev=0` 读取），不要手动改 `src/version.ts` / `package.json` 里的版本号。

### 5. 验证 Release 产物

- 到 GitHub Releases 页面确认 `release.yml` 构建完成，5 平台产物齐全（共 11 个资产，名字不带 v 前缀）：
  - 每平台一个压缩包：darwin/linux `.tar.gz`、win `.zip`（包内单一入口程序，unix 名 `modeldock`）——共 5 个
  - darwin 另有每平台一个自更新整包 `*-darwin-{x64,arm64}-app.tar.gz`（内含 ModelDock.app）——共 2 个
  - darwin 另有 `.dmg` 拖拽安装镜像——共 2 个
  - win 另有 Inno Setup `*-setup.exe` 安装向导——共 1 个
  - 一份合并的 `SHA256SUMS`（覆盖上述全部发布物）
- **确认 Release 正文**是该版本在 CHANGELOG 里的完整段（首行版本概述 + 分节齐全），不是「ModelDock vX.Y.Z + 链接」占位——出现占位说明漏了版本段（正常应已被 release.yml 的 preflight 在构建前拦下，见「常见错误对照」）。
- 抽查一个平台的压缩包：下载、解压、跑 `modeldock --version`，确认版本号 = 刚打的 tag。解压后目录里只有**单一可执行文件** `modeldock`（无子目录），直接 `./modeldock --version`。

### 6. develop 对齐 main（发布收尾）

```bash
git checkout develop
git merge --ff-only main
git push origin develop
```

- tag 打在 main 侧，不对齐的话 develop 的 `git describe` 够不着新 tag——develop 上本地 `build:sea` 会一直显示旧版本号；对齐后两侧基线一致，下轮发布前「main 有 develop 没有的提交」审计天然为零。
- develop 无新提交时 `--ff-only` 纯快进、不产生合并节点；若 develop 已有新提交 ff 会拒绝，改用普通 `git merge main`。

## 代理发布（agent 代执行完整流程）

用户一句「发布 vX.Y.Z」即授权 agent 代执行发布全流程。盘点、文档收口、测试、合并照「流程」节执行；push/tag 按**授权 hatch 白名单**执行（`policy.mjs` 强制，hook 校验命令整串）：

- 仅放行（前缀 `AGENTS_ALLOW_RELEASE=1`）：`git push origin main`、`git push origin develop`（发布收尾对齐）、`git push origin v<X.Y.Z>`、`git push origin :refs/tags/v<X.Y.Z>`（回滚删 tag）、`git tag -a v<X.Y.Z> -m <msg>`、`git tag -d v<X.Y.Z>`（回滚删本地 tag）。
- `--tags`、force push、多 ref、其他分支、轻量 tag、`npm publish` 永不在白名单。
- 授权前提 = 用户明确说出目标版本号；agent 不得自行决定或修改版本号。

### agent 执行序（v<X.Y.Z> 为用户口述版本）

1. `node scripts/release-check.mjs <X.Y.Z>`（机器门禁一键检查；全绿才继续）
2. 盘点 + 文档收口（本文件「流程」步骤 1 的内容，含 CHANGELOG / README / usage 核对）
3. `git checkout main && git merge develop`
4. `AGENTS_ALLOW_RELEASE=1 git push origin main`
5. `gh run watch`（test.yml 全部 job 全绿：三平台 + 工作流套件，按 `--workflow=test` 过滤并以 headSha 核对提交；gh 不可用时降级为网页查看，**不绿就停**；腿被基础设施取消时 ci-retry 自动重跑，见步骤 3）
6. `node scripts/release-check.mjs <X.Y.Z> --skip-test`（tag 前快速复核；此时在 main 上，「当前在 main 分支」warn 属预期）→ `AGENTS_ALLOW_RELEASE=1 git tag -a v<X.Y.Z> -m "v<X.Y.Z>"` → `AGENTS_ALLOW_RELEASE=1 git push origin v<X.Y.Z>`
7. `gh run watch`（release.yml）→ `gh release view v<X.Y.Z>` 核对 11 资产与正文非占位 → 下载抽包跑 `--version`（即「流程」步骤 5）
8. develop 对齐 main（「流程」步骤 6）：`git checkout develop && git merge --ff-only main` → `AGENTS_ALLOW_RELEASE=1 git push origin develop`（develop 有新提交时 ff 拒绝，改普通 merge）

## 出错回滚

- **tag 推错了但 Release 还没构建完**：立即取消 workflow（agent：`gh run cancel <run-id>`），再删远程 tag（`git push origin :refs/tags/vX.Y.Z`，白名单内）和本地 tag（`git tag -d vX.Y.Z`，白名单内）。
- **Release 已发布**：不要删已发布的 Release（用户可能已下载）。发一个修正版（递增 patch 号）并在 Release 说明里标注替代关系。
- **撤回的版本号永不复用**：号一旦公开发布过，即使 Release 与 tag 都删掉也不再使用（用户侧可能已下载/引用）。先例：曾有版本因安装包签名缺陷发布数小时即撤回，递增新号发修正版，CHANGELOG 版本段随之更名。

## 常见错误对照

| ❌ 错误做法 | ✅ 正确做法 |
|---|---|
| 本地一把推 `git push origin main --tags` | 先推 main 等 test 绿，再单独推目标 tag |
| 手动改 `src/version.ts` 里的版本号 | 版本号由 git tag 决定，构建脚本自动临时替换并还原 |
| CHANGELOG 写完直接打 tag | 先推 main → 确认 CI 绿 → 再打 tag |
| 在 main 上直改 CHANGELOG（或让 agent 代改） | CHANGELOG 在 develop 上改，随 develop 合入 main（分支卫生规则） |
| 复用已撤回的版本号 | 撤回过的号永不复用，递增到新号发修正版 |
| 漏更 CHANGELOG 就打 tag | release.yml 的 preflight 在构建前失败并提示修复命令：补版本段后删 tag 重打 |
| 删除已发布的错误 Release | 发修正版替代，保留原 Release 并标注 |

## 实战事故沉淀（2026-10，v1.1.5–v1.5.0 六次发布）

每次发布遇到过的坑与已落地的对策。动手发布前扫一遍——命中过的坑不踩第二次。

| 事故 | 对策（✅ = 已自动化） |
|---|---|
| macos 腿排队期 15m01s 被「未获分配」取消（GitHub arm64 runner 容量短缺，v1.5.0 连挂 7 次） | ✅ ci-retry.yml 自动重跑失败腿（≤3 次尝试、只重跑最新 run、cancelled 也算失败腿）；连续多轮仍取消 = 平台故障，等恢复后 `gh run rerun <run-id> --failed`，不必重推 |
| CHANGELOG 漏记（v1.1.5 补 4 条、v1.2.3 补 2 条、v1.5.0 无未发布段需整段归纳） | ✅ release-propose 自动盘点 + 疑似漏记清单；收口仍以 `git log v上一版..develop --no-merges` 逐条对账，「提交里有而日志没有 = 对外失真」 |
| 本地 npm test 绿、CI 工作流套件红（v1.5.0：feature-branch finish 把未跟踪文件算脏，编排器套件成组挂） | ✅ release-check 补跑 `npm run test:workflow`，发布前本地拦住两套件；修法教训：把「未跟踪」当「脏」会误伤临时仓库与本地杂物，校验用 `--porcelain --untracked-files=no` |
| release 构建在 test.yml 不覆盖的平台红、tag 已推（v1.2.1 linux-arm64：测试与网关后台写状态文件竞态） | 测试侧去竞态（用环境开关隔离后台写）；按「出错回滚」删 tag 重打，版本号不消耗。教训：与被测进程有共享状态的测试，先把后台写隔离再断言 |
| 门禁 §10 基线检查与口径化后的 usage 脱节（v1.5.0 报「未找到句式」） | ✅ 检查同时认硬编码数字（校验漂移）与口径句（数字以 npm test 实测为准） |
| audit 网络超时「未得出结论」（v1.2.2 / v1.2.3 / v1.5.0 三次） | 人工补跑 `npm audit --omit=dev`（带重试）拿到确定结论；查出漏洞**当版修**（v1.2.2 undici 三 CVE 先例），已发布版本可能带病 |
| 推平后 `--amend` 已推提交 → push 被拒（force push 禁用） | 永不 amend 已推提交；补救 = 软重置回远端已有提交 + 把差异补成新提交（v1.2.1 先例） |
| 多会话并行修同一 bug → rebase 冲突（v1.5.0 darwin 跨机密文两份等价修复） | `git pull --rebase` 同步；两解等价时二选一，**冲突解算后必须全量测试复验再推** |
| 托管 Node 钉版落后新 patch（v1.2.2 警告） | 门禁 ⚠ 即当版 bump `MANAGED_NODE_VERSION`；不当版 bump 须能说明非安全补丁 |
| 本地深夜测试三连挂、清晨复跑全绿（v1.1.5：scan.test spawnSync 240s 超时） | 环境性偶发的判定口径：同提交 CI 绿 + 本地复跑绿；悬死诊断开 `VITEST_WATCHDOG=1`（观测器判读见 test/vitest-watchdog.mjs）。注意 vitest 单进程串行下同步 exec 阻塞事件循环，testTimeout 打不断 execSync |
| 构建产物 / API 网络抖动（curl 56、gh API 502，大陆网络常态） | 命令一律带 `--retry`；关键比对（SHA256SUMS 对账、CI 结论）缺输出就单独补跑闭合，不留「应该没问题」 |
| 平台特定输入用平台相关解析（v1.5.1 前：托盘 CIM 反斜杠路径过 `path.basename`，非 Windows 整类不命中、9 例红恰逢 runner 短缺漏进 develop） | 解析固定平台的输出用显式 `path.win32/posix.*`，不吃运行平台；新测试合入前至少本地跑一次非 Windows 侧（macOS 本机即可拦住） |

---

## 完整示例：发布 v1.3.0

假设当前版本是 v1.2.0，develop 上积累了 3 个新功能要发 minor 版本。

### 步骤 0：确认状态（develop 上）

```bash
$ git checkout develop
$ git status
# On branch develop
# nothing to commit, working tree clean

$ git log origin/develop..develop --oneline
# (空输出，本地不领先远程)

$ npm test
# ✅ 全绿
```

### 步骤 1：盘点发布内容，更新 CHANGELOG 与 README（develop 上）

先列出上个 tag 以来的全部内容提交并归纳成清单：

```bash
$ git log v1.2.0..develop --oneline --no-merges
# a1b2c3d feat: add export command
# e4f5g6h feat: support glm-4.6 preset
# i7j8k9l fix: gateway memory leak on retry
# ✅ 清单：新增＝导出命令、GLM-4.6 预设；修复＝网关内存泄漏
```

对照清单更新文档——CHANGELOG 漏记的补上、README 补新命令与新能力 bullet。编辑 `CHANGELOG.md`，把「未发布」段改为：

```markdown
## [1.3.0] - 2026-10-15

新增导出命令、GLM-4.6 预设，修复网关重试内存泄漏。

### 新增

- **导出配置**：新增 `modeldock export` 命令，可导出当前配置为 JSON 文件。
- **GLM-4.6 预设**：新增智谱 GLM-4.6 模型预设，开箱即用。

### 修复

- **网关内存泄漏**：修复重试场景下连接未释放导致的内存持续增长问题。
```

文末版本链接表补一行：

```markdown
[1.3.0]: https://github.com/user/modeldock/compare/v1.2.0...v1.3.0
```

提交：

```bash
$ git add CHANGELOG.md README.md    # README 有改动时一并提交
$ git commit -m "docs: release v1.3.0 changelog/readme 收口"
```

### 步骤 2：合入 main 并推送

```bash
$ git checkout main
$ git merge develop

$ git log $(git describe --tags --abbrev=0)..HEAD --oneline
# a1b2c3d feat: add export command
# e4f5g6h feat: support glm-4.6 preset
# i7j8k9l fix: gateway memory leak on retry
# ✅ 确认这 3 个提交都该进 v1.3.0

$ git push origin main
# main -> main
```

### 步骤 3：等 CI 绿

到 GitHub Actions 页面，确认 `test.yml` workflow 跑完且全部通过（约 2-5 分钟）。

### 步骤 4：打 tag，只推这一个

```bash
$ git tag -l v1.3.0; git ls-remote --tags origin v1.3.0
# (都无输出 ✅ 版本号未被占用)

$ git tag -a v1.3.0 -m "v1.3.0"
$ git push origin v1.3.0
# v1.3.0 -> v1.3.0
```

### 步骤 5：验证产物

到 GitHub Releases 页面，等 `release.yml` 构建完成（约 10-15 分钟），确认产物列表包含（共 11 个资产）：

```
modeldock-1.3.0-darwin-arm64-app.tar.gz
modeldock-1.3.0-darwin-arm64.dmg
modeldock-1.3.0-darwin-arm64.tar.gz
modeldock-1.3.0-darwin-x64-app.tar.gz
modeldock-1.3.0-darwin-x64.dmg
modeldock-1.3.0-darwin-x64.tar.gz
modeldock-1.3.0-linux-arm64.tar.gz
modeldock-1.3.0-linux-x64.tar.gz
modeldock-1.3.0-win32-x64-setup.exe
modeldock-1.3.0-win32-x64.zip
SHA256SUMS
```

Release 正文应为 `[1.3.0]` 版本段的完整内容（不是占位）。

抽查一个平台验证版本号：

```bash
$ curl -L -o modeldock.tar.gz https://github.com/user/modeldock/releases/download/v1.3.0/modeldock-1.3.0-linux-x64.tar.gz
$ tar -xzf modeldock.tar.gz
$ ./modeldock --version
# 1.3.0 ✅
```

### 步骤 6：develop 对齐 main（发布收尾）

```bash
$ git checkout develop
$ git merge --ff-only main
$ git push origin develop
# develop 快进到 v1.3.0 发布点，与 main 基线一致 ✅
```

发布完成。
