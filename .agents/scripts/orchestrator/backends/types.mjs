// types.mjs — AgentBackend 接口的 JSDoc 定义（纯 .mjs 零依赖，无运行时逻辑）。
// 两个实现：mock.mjs（测试用假后端）、claude-headless.mjs（真实 Claude Code headless）。

/**
 * @typedef {Object} AgentBackendOpts
 * @property {string} promptFile   组装好的 prompt 文件路径（worker/reviewer/fixup 共用同一入口）
 * @property {string} cwd          worktree 绝对路径
 * @property {number} maxTurns     预算轮次（--max-turns 透传）
 * @property {(e: object) => void} onEvent  流式事件回调（转写 events.jsonl）
 * @property {string} [settingsFile] worker 专属 settings（policy hook 注入），仅 claude-headless 使用
 * @property {boolean} [readonly]  只读会话（reviewer）：allowedTools 收敛为 Read/Glob/Grep，
 *                                 编辑/命令在权限层不可能发生（fail-closed），不靠 prompt 自觉
 */

/**
 * @typedef {Object} AgentUsage
 * @property {number} tokensIn  input_tokens + cache_read + cache_creation（缓存读计入预算口径）
 * @property {number} tokensOut output_tokens
 */

/**
 * @typedef {Object} AgentResult
 * @property {number} exitCode   0 = 正常结束；非 0 = 异常（熔断 kill 会给非 0）
 * @property {string} output     最终文本输出（含/不含契约块，由 orchestrator 解析）
 * @property {AgentUsage} usage
 * @property {number} pid        worker 主进程 pid（崩溃恢复/孤儿清理用）
 */

/**
 * @typedef {Object} AgentBackend
 * @property {string} name
 * @property {(opts: AgentBackendOpts) => Promise<AgentResult>} spawn
 */

/** Phase 1 可用后端名。 */
export const BACKENDS = ['claude-headless', 'mock'];
