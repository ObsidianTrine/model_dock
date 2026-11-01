# feature-branch 工作流（多 agent 并行开发规范）

多个 agent 并行开发时，**禁止直接在 develop/main 上 Edit/Write 代码文件**（PreToolUse hook 会拦截并给出本提示）。所有代码改动走下面的 worktree 分支流程，由 `.agents/scripts/feature-branch.mjs` 提供支撑。

## 流程（每个功能点/问题执行一遍）

### 1. 开任务分支 + 独立工作目录

```bash
node .agents/scripts/feature-branch.mjs start <task-id>
```

- `<task-id>`：小写短横线短词，如 `fix-presets-merge`、`add-export-cmd`。
- 成功后输出 worktree 路径（`.agents/worktrees/<task-id>`）和分支名（`feature/<task-id>`，基于基准分支，见 `.agents/workflow.json` 的 `baseBranch`）。
- start 会在建好 worktree 后自动执行 `.agents/workflow.json` 的 `setupCmd`（本仓库为 `npm ci --prefer-offline`，装好 node_modules），**worktree 产出即可直接跑测试**，无需手工补装依赖。setup 失败只告警不中断——worktree 本身没问题，按提示手动重跑该命令即可。
- 每个 agent 一个独立 worktree，互不干扰；主目录基准分支检出保持不动。
- **start 即认领（claim-before-execute）**：项目启用了 orchestrator 队列（`.agents/orchestrator/queue/` 存在）且队列里有同 id 任务卡在 `pending/` 时，start 自动认领它——抢任务锁并把卡迁到 `running/`、写 `manual_claimed` 事件。卡一离开 `pending/`，orchestrator drain 与其他 agent 都不会再调度它（双 agent 撞同一张卡从机制上收口，2026-10-30 卡 22 实证）。认领后的持久记录就是「卡在 `running/`」；任务锁只守「两个 start 并发认领」的窄窗口（start 进程退出即自动释放）。同一张卡已被认领（锁被存活进程持有，典型是 orchestrator 闭环正在跑它）时 start 明确拒绝并报锁持有者 pid——不提供强夺活锁的开关，确认持有者卡死先终止该进程再重跑（陈锁自动接管）。worktree 建失败时认领自动回滚（卡回 `pending/`、锁释放）。项目没跑 orchestrator（无队列目录）或队列里没有同 id 卡时，start 行为与从前完全一致。

### 2. 在 worktree 内修改

- **所有文件编辑都必须使用 worktree 路径下的绝对路径**（例如 `E:\...\model_dock\.agents\worktrees\<task-id>\src\...`），不要改主目录的同名文件。
- 改完在 worktree 内提交：
  ```bash
  git -C .agents/worktrees/<task-id> add -A
  git -C .agents/worktrees/<task-id> commit -m "<清晰的修改说明>"
  ```

### 3. 自测

**只跑与改动相关的测试用例**（2026-11-02 分层规则：全量套件慢，日常交付不做全量回归）：

```bash
npx vitest run test/<相关测试文件>.test.ts                              # 产品套件（test/*.test.ts）
npx vitest run -c vitest.workflow.config.ts test/orchestrator/<相关文件>.test.ts   # 编排器/工作流套件（test/orchestrator/**）
```

需要更窄时叠加 `-t "用例名关键词"`。相关用例全绿才能进入合并步骤（项目 AGENTS.md「判定边界」）；涉及跨文件 mock / 共享模块的改动，相关文件之外至少加跑一组组合文件（见 AGENTS.md「vitest 隔离模型」——单独跑绿 ≠ 组合绿）。

- **范围分层**：全量 `npm test` / `npm run test:workflow` 保留给版本发布、develop→main 合并等大节点与 CI 门禁；finish 的自动 `testCmd`（合并门禁，一次性）保持现状不动。
- 测试期间遵守项目自身的红线约定（见项目 AGENTS.md，如端口/实例/环境限制）。

### 4. 合并回 develop（串行、保留完整信息）

```bash
node .agents/scripts/feature-branch.mjs finish <task-id>
```

finish 自动完成：rebase 到最新基准分支（有冲突时脚本提示你在 worktree 内解决后重跑）→ 在 worktree 内跑配置的验证命令 `testCmd`（`.agents/workflow.json`）→ `git merge --no-ff` 合入基准分支（保留完整合并信息）→ 删除 feature 分支和 worktree。**认领的卡随之归位**：finish 成功后若队列里该任务的卡在 `running/`，自动落 `merged/`（写 `manual_merged` 事件）——工作已合并进主干，与编排器闭环的同一终态；卡在其他状态（如 `awaiting-human/`）则不动，归编排器状态机处理。orchestrator 自己的 approve 路径（带 `ORCHESTRATOR_GATE_HEAD` 标记）不受影响，卡仍由闭环状态机落位。

- **并发安全**：合并在主仓库检出上进行，finish 全程持有 `.agents/worktrees/.finish.lock` 串行化——多个 agent 同时 finish，后到者**有界等待**持锁者（轮询 2.5s，默认上限 300s，`FINISH_LOCK_WAIT_SECONDS` 可调、设 0 恢复立即失败），等待期间持锁者退出则自动接管；超时才提示重跑。陈锁（属主进程已死）同样自动接管，无需手动清理。

- rebase 冲突：在 worktree 内解决 → `git add -A && git rebase --continue` → 重新跑 finish。
- finish 里的验证失败：回 worktree 修复 → 提交 → 重跑 finish。
- 运行 finish 前先把终端/会话的工作目录退回主仓库（不要停在 worktree 里）：Windows 下被进程占用的目录删不掉，会让清理留下空壳。脚本启动时会自动把自身 cwd 退回主仓库、清理时也会重试扫尾，但提前退出最稳妥。
- 纯文档等不影响行为的改动可用 `--skip-test` 跳过验证步骤。orchestrator 自动合并（approve）会带 `--skip-test` + `ORCHESTRATOR_GATE_HEAD` 走**门禁快捷路径**：仅当基准分支未前进且 worktree HEAD 与 gate 记录一致时才真的跳过（gate 验证的就是当前树），否则 finish 内部自动回落全量验证——门禁强度不降。

### 5. 查看在跑任务

```bash
node .agents/scripts/feature-branch.mjs list
```

- 输出中的 `[NOTES.md]` 表示该任务留有交接文档——**接手前必读**；`[dirty]` 表示有未提交改动；`[claimed]` 表示队列里对应的任务卡在 `running/`（**有 agent 在岗，勿接手**）；`[card:<状态>]` 表示卡处于其他状态（如 `blocked`，走 orchestrator resume/abandon 处理）。

## 任务交接（NOTES.md，未完成任务必留痕）

`start` 会在 worktree 根目录自动生成 `NOTES.md` 交接模板。它是 worktree 本地文档，**永不合并进主干**（finish 时自动清除；若已被 `git add -A` 一起提交进分支，finish 也会自动从分支移除）。

- **动手前**：把「目标 / 计划步骤」填进 NOTES.md。
- **会话结束或任务中断前**：把「已完成 / 剩余步骤 / 如何验证 / 已知坑」写全并提交（至少保存）——下一个 agent 靠它续起，避免半成品无人认领。
- **接手在跑任务**：`feature-branch.mjs list` 找到任务 → 进 worktree 读 NOTES.md → 继续开发或补完测试后 finish。
- **确认任务不再要**：在 worktree 内提交删除全部改动说明后直接让负责人清理（`git worktree remove` + 删分支），NOTES.md 里写明放弃原因。

## 约束与例外

- 主目录（基准分支检出）只做只读浏览和合并落点，不直接改代码文件（文档仅 develop 可直改，main 连文档也拦）。
- 确实需要直接改基准分支的罕见情况（如本工作流自身的配置文件），设环境变量 `AGENTS_ALLOW_BASE_EDIT=1`（旧名 `MODELRDOCK_ALLOW_DEVELOP_EDIT=1` 兼容） 后 hook 放行——必须能向用户说明理由。
- 派发并行任务时，尽量按文件归属划分任务（如一个 agent 只动某几个模块目录），从源头减少 rebase 冲突。

## 分支卫生规则（2026-10-02 起，hook 强制）

1. **main 上一律不直改，文档也不例外**：hook 对 main 的 Edit/Write 全部拦截——CHANGELOG / README / docs/usage 等对外文档也一律在 develop 上改；main 只接受 develop 合入与 `hotfix.md` 规程的紧急修复。
2. **develop 上代码必走 worktree，非源代码类文档可直接改**：`.md` / `.markdown` / `.txt` / `.rst` / `.adoc` 等文档扩展名在 develop 直改放行（hook 按扩展名判定，白名单见 `policy.mjs` 的 `DOC_FILE_RE`）；代码与带执行语义的配置（CI 工作流 yml、hook/包清单 json 等）仍然拦截。
3. **多机同步用 `git pull --rebase`**（或 fetch + rebase）：默认 merge 式 pull 会留下「Merge branch 'main' of github.com...」节点——双向合并编织是提交图谱变乱的主要来源。
4. **NOTES.md 永不入库**：已列入 .gitignore，worktree 里 `git add -A` 不会带上它；历史上 20 条「提交→移除」噪音提交不再产生。
5. **hook 注册双客户端**：Claude Code 在 `.claude/settings.json`，ZCode 在 `.zcode/config.json`（配置文件 hook 必须 `hooks.enabled: true`，否则 ZCode 不运行任何配置文件 hook）。

## 移植到其他项目（Porting）

本工作流与项目语言无关，唯一依赖是 **Node.js ≥18**（脚本纯 Node 标准库，零第三方依赖）。C++ / Rust / Python 等项目照搬即可。

### 拷贝清单（一个目录 + 一键初始化）

工作流的全部内容自包含在 `.agents/` 目录中，**整目录拷贝后跑一键初始化**：

```bash
# 在目标项目根目录：
cp -r <模板项目>/.agents .          # hooks/ + workflows/ + scripts/ + workflow.json 一次到位
node .agents/scripts/agent-init.mjs # 交互生成本项目 workflow.json + 注册双客户端 hook + AGENTS.md 骨架
# 非交互（agent 代跑）：加 --defaults；已有 workflow.json 重生成加 --force
```

只想要最小 feature-branch（不含 orchestrator）时，手工方式仍然可用：

```bash
# 另需 hook 注册（.claude/settings.json，内容原样即可；或改配到用户级 ~/.claude/settings.json）：
mkdir -p .claude && cp <模板项目>/.claude/settings.json .claude/
```

`.agents/` 内的分工：

| 路径 | 作用 |
|------|------|
| `.agents/scripts/feature-branch.mjs` | worktree 编排（start/finish/list）。脚本自动向上查找 `.git` 定位仓库根，放其他层级也能跑 |
| `.agents/hooks/guard-develop.mjs` | 分支守卫 hook（拦基准分支直改、放行 worktree） |
| `.agents/workflows/feature-branch.md` | 规约文档 + 本移植手册 |
| `.agents/workflow.json` | 每项目唯一要做的配置（见下） |

### 每项目唯一要做的配置：`.agents/workflow.json`

```json
{
  "baseBranch": "develop",
  "setupCmd": "npm ci --prefer-offline",
  "testCmd": "cmake --build build && ctest --test-dir build --output-on-failure"
}
```

- `baseBranch`：feature 分支的合并目标。没有 develop 分支的项目直接写 `main`。
- `setupCmd`：start 建好 worktree 后自动执行的环境准备命令（装依赖等，shell 执行），写法与 `testCmd` 相同（字符串 / 数组 / 平台映射）。配置后每个新 worktree 产出即可直接自测，agent 不必自己发现并补装依赖；缺省 = 跳过 setup。setup 失败仅告警不阻断（worktree 已建好，命令可手动重跑）。
- `testCmd`：finish 时在 worktree 内运行的验证命令（shell 执行），支持三种写法：
  - **字符串**——所有平台同一条命令：
    ```json
    "testCmd": "cargo test --all"
    ```
  - **数组**——多条命令按顺序执行，任一失败即中止：
    ```json
    "testCmd": ["cmake --build build", "ctest --test-dir build --output-on-failure"]
    ```
  - **平台映射**——Windows 与 Unix（linux + macOS）各配各的，值为字符串或数组：
    ```json
    "testCmd": {
      "win32": ["scripts\\run_tests.bat", "scripts\\run_unit_tests.bat"],
      "unix":  ["./scripts/run_tests.sh", "./scripts/run_unit_tests.sh"]
    }
    ```
  - 其他语言单命令示例：Rust `cargo test --all`、Python `pytest`。
- 文件缺失 = 无基准分支配置（回落 develop→当前分支）且 finish 跳过验证。**建议始终提交此文件**，团队成员行为才一致。

### 拷贝后需要手工调整的内容

1. 删除或改写 `.agents/workflows/feature-branch.md` 中任何残留的项目专属措辞。
2. 目标项目 AGENTS.md 增补「多 Agent 并行开发约定」章节（照搬模板项目并按项目语境改写），项目专属红线（端口/实例/环境）写在这里，不要写进本工作流文档。
3. `.gitignore` 增加 `.agents/worktrees/`（worktree 目录不入库）与 `NOTES.md`（交接文档不入库）。

### 团队与多机

- `.claude/settings.json` 属于项目级配置，提交进仓库后所有用 Claude Code 的成员自动生效。
- 不使用 Claude Code 的成员也能用脚本本体（start/finish/list 纯 git 编排），只是没有 hook 拦截保护。
