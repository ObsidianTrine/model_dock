/** T30 类型检查门禁的通配声明：test/orchestrator/** 直接 import .agents 的 .mjs 脚本
 *  （纯 JS 无类型），按 any 处理保持这些测试本身受检——给 .mjs 补 d.ts 是后续独立工作。 */
declare module '*.mjs'
