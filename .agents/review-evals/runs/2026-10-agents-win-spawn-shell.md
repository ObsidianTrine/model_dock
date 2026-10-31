# 审查评测报告

- 考题：1，审出：1，未审出：0
- 模型：glm-4.5-air
- 评分口径：expect 关键词命中（启发式），精确判定看原文

## 2026-10-agents-win-spawn-shell — ✅ 审出

- 考题：.agents 编排器在 Windows 上 spawn 全局命令未带 shell（.cmd 包装直调必 ENOENT）：claude worker 探测带 shell 说可用、spawn 不带起必挂（worker/审查全落 blocked/），orchestrator npm ci 依赖装不上，nightly audit 信号源静默失效
- 关键词：shell=中，enoent=未中
- 完整输出：/var/folders/vw/7vttg54s74ng208jp5063f0c0000gp/T/modeldock-review-eval-YH2Q0U/2026-10-agents-win-spawn-shell.output.txt

<details><summary>模型原文</summary>

```text
发现 2 个问题

## 1. 隐蔽的竞态条件：临时目录清理失败
**文件**：`.agents/scripts/orchestrator.mjs`  
**行号**：630-634  
**问题**：finally 块中临时目录删除失败后未中断进程，可能导致后续进程污染
```javascript
} finally {
  clearTimeout(budget.wallTimer);
  releaseTaskLock(repoRoot, taskId);
  try {
    fs.rmSync(path.dirname(promptFile), { recursive: true, force: true });
    fs.rmSync(path.dirname(settingsFile), { recursive: true, force: true });
  } catch {}
}
```
**证据**：catch 块空悬（`catch {}`），当临时目录删除失败时（如权限不足/文件占用），程序仍继续执行。在 orchestrator 这种关键系统中，资源泄漏可能导致后续任务失败或数据污染。

## 2. 命令注入漏洞：shell 参数未转义
**文件**：`.agents/scripts/orchestrator/scan.mjs`  
**行号**：159  
**问题**：gh CLI 命令中的 `opts.run` 参数未经验证直接拼接
```javascript
const r = (opts.run ?? defaultGhRun)(gh, ['issue', 'list', '--state', 'open', '--limit', '50', '--json', 'number,title,body,url'], repoRoot);
```
**证据**：`opts.run` 是可注入的外部参数（测试用），如果攻击者传入恶意命令，如：
```javascript
{ run: (cmd, args, cwd) => spawnSync(cmd + '; rm -rf /', args, { cwd }) }
```
将导致任意命令执行。虽然测试环境使用，但未做参数边界检查违反纵深防御原则。

## 存疑
1. **line 190**: `fs.copyFileSync(path.resolve(cardFile), cardPath(...))` - 如果 `cardFile` 是恶意路径（如 `../../../etc/passwd`），可能导致文件被写入不预期位置。需确认是否有路径验证。
2. **line 343**: `fs.mkdtempSync(path.join(os.tmpdir(), 'orch-prompt-'))` - 临时目录创建未考虑 `TMPDIR` 不存在的情况，虽然罕见但可能导致故障。
```

</details>