# 审查评测报告

- 考题：1，审出：0，未审出：1
- 模型：glm-4.5-air
- 评分口径：expect 关键词命中（启发式），精确判定看原文

## 2026-10-orchestrator-repo-root — ❌ 未审出

- 考题：findRepoRoot 双实现语义相反（--git-common-dir vs --show-toplevel）且注释自称「同款」：从 linked worktree 内跑 orchestrator 会把 queue/ 锚进 worktree，与 finish 需主仓库检出矛盾
- 关键词：git-common-dir=未中，show-toplevel=未中
- 完整输出：/var/folders/vw/7vttg54s74ng208jp5063f0c0000gp/T/modeldock-review-eval-X5O2ce/2026-10-orchestrator-repo-root.output.txt

<details><summary>模型原文</summary>

```text
发现 5 个问题。

## 1. 文件系统处理不当 (feature-branch.mjs:243-242)
```javascript
function removeWorktreeDir(wtPath) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (!fs.existsSync(wtPath)) return null;
    try {
      fs.rmSync(wtPath, { recursive: true, force: true });
      return null;
    } catch (e) {
      if (attempt < 3) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, true, 250);
      else return String(e.message).trim();
    }
  }
}
```

问题：使用 `Atomics.wait` 时创建了 4 字节的 SharedArrayBuffer，但只使用了一个 Int32Array，这会导致内存泄漏和资源浪费。应该直接使用 `setTimeout` 或其他不创建 SharedArrayBuffer 的方式。

## 2. 文件清理可能失败但状态已更新 (feature-branch.mjs:328-332)
```javascript
try {
  git(['branch', '-d', branch]);
} catch (e) {
  die(`no worktree for task "${taskId}", and deleting leftover branch ${branch} failed (likely unmerged):` + CRLF_N + `  ${String(e.message).trim()}`);
}
const shellFail = removeWorktreeDir(wtPath);
if (shellFail) console.warn(`WARNING: could not remove leftover directory ${wtPath}: ${shellFail}`);
console.log(`Worktree already gone; deleted leftover branch ${branch}. Cleanup complete.`);
```

问题：即使 `git branch -d` 失败（throw 错误），代码还是会执行目录清理并打印"Cleanup complete"消息，这会给用户错误的成功暗示。

## 3. 状态机冲突检测可能不完整 (orchestrator.mjs:957-966)
```javascript
const picked = null;
for (const id of candidates) {
  if ((retryCount.get(id) ?? 0) >= 2) {
    blacklisted.add(id);
    log(`⚠ 任务 ${id} 两次被调度仍在 pending——run 子进程未能处理它，已跳过（人工检查执行环境后 resume）。`);
    continue;
  }
  try {
    const card = loadCard(fs.readFileSync(cardPath(root, 'pending', id), 'utf8'), `${id}.md`);
    const conflicts = [...active.values()].some((a) => hintsOverlap(a.hint, card.meta.files_hint));
    if (!conflicts) {
      picked = { id: card.meta.id, meta: card.meta };
      break;
    }
  } catch {
    continue;
  }
}
```

问题：在并发调度中，`loadCard` 和 `hintsOverlap` 检查之间可能存在竞态条件。如果两个任务同时检查到没有冲突，但都通过了检查，最终可能发生分区冲突。

## 4. 权限和文件清理处理不一致 (orchestrator.mjs:631-633)
```javascript
try {
  fs.rmSync(path.dirname(promptFile), { recursive: true, force: true });
  fs.rmSync(path.dirname(settingsFile), { recursive: true, force: true });
} catch {}
```

问题：使用空的 `catch` 块会隐藏所有可能的错误，包括权限问题或其他重要错误。应该至少记录错误信息，或者区分可预期的失败（如文件不存在）和真正的问题。

## 5. Git 错误处理中的平台差异 (feature-branch.mjs:325-328)
```javascript
try {
  git(['branch', '-d', branch]);
} catch (e) {
  die(`no worktree for task "${taskId}", and deleting leftover branch ${branch} failed (likely unmerged):` + CRLF_N + `  ${String(e.message).trim()}`);
}
```

问题：不同 Git 客户端和平台可能会产生不同的错误消息格式。这里的错误处理假设所有错误都包含 `.trim()` 可用的字符串，但在某些情况下可能不适用。
```

</details>