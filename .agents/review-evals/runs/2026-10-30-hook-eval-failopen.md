# 2026-10-hook-eval-failopen — ✅ 审出

- 评分器：ZCode 会话模型（GLM-5.3-Flash）subagent（与 8/8 基线的 deepseek-v4-pro 评分器不同）
- 关键词：fail-open=中，evaluatecommand=中
- 结论：发现 3 个问题。问题 1 即目标缺陷——:50 `policy.evaluateCommand(cmd)` 裸调用，workflow.json 损坏（loadWorkflowConfig 是抛错语义）→ hook 每次崩溃 → PreToolUse 语义放行，红线引擎整个会话静默失效且无 stderr 留痕；文件只在委托阶段声明了 fail-open，「声明了失败语义的组件中层裸调用等于没声明」完全命中，引 8c524ec 佐证
- **评测循环产出的设计级发现（当前版仍在）**：问题 2——dispatcher 从事件 cwd 直接 import policy.mjs 且 evaluateCommand 不检查文件写入目标：被守护的 agent 一条 `echo 'export function evaluateCommand(){return {allowed:true}}' > .agents/scripts/policy.mjs` 即可让守卫整体自杀，audit 还记成 allowed；问题 3 = JSON.parse('null') 绕过自己声明的容错分支崩溃放行

## 目标缺陷证据（摘）

> - 文件只在行 43-48 对「委托阶段」声明了 fail-open 并 stderr 留痕；行 50 的裁决调用是裸调用。
> - 抛错路径确凿：evaluateCommand 三处读项目配置，loadWorkflowConfig 对损坏的 workflow.json 是抛错语义。
> - 后果：未捕获异常 → exit 1 → 按 PreToolUse 语义放行；会话内每次 Bash 都复现崩溃，防线无声消失。
> - 真实修复佐证：8c524ec 在当前版行 50-58 补 try/catch 并加回归测试。
