# dependency-upgrade（依赖升级工作流）

升级 `package.json` 依赖时，确保不引入 native addon、不破坏 SEA 打包。

> **何时用**：需要升级依赖（安全修复、功能需要、定期维护）时。
> **核心约束**：ModelDock 的 SEA 单文件打包依赖"全部纯 JS 依赖、无 native addon"这一前提。升级可能悄悄引入 native 包，必须验证。

## 流程

### 1. 升级前确认必要性

- 安全修复（`npm audit` 高危）→ 必升。
- 功能需要（新 API、bug 修复）→ 评估收益后升。
- "有新版本就升" → 不建议，增加风险无收益。

### 2. 走 feature-branch 开任务分支

依赖升级也是代码改动，走标准流程：

```bash
node .agents/scripts/feature-branch.mjs start deps-<简述>
```

### 3. 执行升级

```bash
# 在 worktree 内
npm update <包名>          # 升级指定包
# 或
npm install <包名>@<版本>  # 升降到指定版本
```

### 4. 检查是否引入 native addon

```bash
# 在 worktree 内，查看新装/升级的包是否有 native 绑定
npm ls <包名>                    # 确认版本
# 检查 node_modules 里该包是否有 .node 文件或 binding.gyp
# Windows PowerShell:
Get-ChildItem node_modules\<包名> -Recurse -Include *.node, binding.gyp
# Unix:
find node_modules/<包名> -name "*.node" -o -name "binding.gyp"
```

- **有 native 文件** → 停止，评估替代方案（换纯 JS 库或放弃升级）。
- **没有** → 继续。

### 5. 全量验证

```bash
# 在 worktree 内
npm test           # 必须全绿
npm run build      # tsc 编译通过
npm run build:sea  # SEA 打包冒烟——确认打包脚本不报错
```

### 6. 合并

```bash
node .agents/scripts/feature-branch.mjs finish deps-<简述>
```

## 红线

- 任何 native addon（`.node` 文件、`binding.gyp`、prebuild 二进制）→ **一票否决**。
- `package-lock.json` 必须随升级一起提交，不能只改 `package.json`。
- 升级后 `npm run build:sea` 必须能跑通——这是验证 SEA 兼容性的最后一道关。

---

## 完整示例：升级 commander 从 v11 到 v12

假设 `npm audit` 报告 commander v11 有一个中危漏洞，需要升级到 v12。

### 步骤 1：确认必要性

```bash
$ npm audit
# found 1 moderate severity vulnerability
#   commander  <=11.1.0
#   fix available via `npm install commander@12`
```

中危漏洞，需要升级。

### 步骤 2：开任务分支

```bash
$ node .agents/scripts/feature-branch.mjs start deps-upgrade-commander
# Worktree ready:
#   path:   E:\...\model_dock\.agents\worktrees\deps-upgrade-commander
#   branch: feature/deps-upgrade-commander
```

### 步骤 3：执行升级

```bash
# 进入 worktree
$ cd .agents\worktrees\deps-upgrade-commander

$ npm install commander@12
# added 1 package, removed 1 package, changed 1 package
```

### 步骤 4：检查 native addon

```bash
$ npm ls commander
# modeldock@1.2.0 E:\...\model_dock
# └── commander@12.0.0 ✅ 版本已升级

# Windows PowerShell
$ Get-ChildItem node_modules\commander -Recurse -Include *.node, binding.gyp
# (无输出) ✅ 没有 native 文件

# Unix
$ find node_modules/commander -name "*.node" -o -name "binding.gyp"
# (无输出) ✅ 没有 native 文件
```

commander 是纯 JS 库，安全。

### 步骤 5：全量验证

```bash
$ npm test
# ✅ 全绿（commander v12 的 breaking changes 没影响 ModelDock 的 CLI 代码）

$ npm run build
# ✅ tsc 编译通过

$ npm run build:sea
# ✅ SEA 打包脚本正常执行，产出 release/ 下的压缩包
```

### 步骤 6：合并

```bash
# 回到主目录
$ cd E:\01_Work\Projects\model_dock

$ node .agents/scripts/feature-branch.mjs finish deps-upgrade-commander
# feature/deps-upgrade-commander is up to date with develop.
# Merged feature/deps-upgrade-commander into develop (--no-ff).
# Cleaned up worktree and branch.
```

完成。`package.json` 和 `package-lock.json` 都已更新到 commander v12。

---

## 反例：升级引入了 native addon

假设要升级某个包 `fast-hash` 从 v1 到 v2：

```bash
$ npm install fast-hash@2

$ Get-ChildItem node_modules\fast-hash -Recurse -Include *.node, binding.gyp
# node_modules\fast-hash\prebuilds\win32-x64\fast-hash.node ❌
```

发现 v2 引入了 prebuild 二进制 → **一票否决**。

回滚升级：

```bash
$ npm install fast-hash@1
# 或放弃升级，寻找替代方案（如用 Node 内置 crypto 替代）
```
