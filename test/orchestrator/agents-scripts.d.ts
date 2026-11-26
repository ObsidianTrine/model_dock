/**
 * 类型边界：test/orchestrator/** 直接 import `.agents/scripts/**` 的 .mjs 工具链（纯 JS，无声明）。
 * 这里用 shorthand ambient module 统一声明成 any——编排器工具链的类型化留给它自己的
 * tsconfig.agents.json（checkJs）与后续按模块补的 .d.mts，测试侧只保证「测试代码本身」受
 * tsconfig.test.json 检查，不被「找不到声明文件」的 TS7016 淹没。
 *
 * 边界内的契约靠测试断言本身：模块导出形状变了，这里不会替它报错，测试会红。
 */
declare module '*.mjs';
