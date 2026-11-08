// ESLint flat config（ESM）。作用域仅 src/**/*.ts：
// - 不含 test/（test/orchestrator 无 d.ts 项目会踩 type-aware 解析，本轮不动 test/）
// - 规则全部 warn 级：eslint 退出码保持 0，不阻断 CI；超基线由 test/eslint-baseline.test.ts 棘轮门禁拦
// - ignores 覆盖构建产物与 agent 工具链目录
// @ts-check 无需——本文件不在 tsc 项目内，保持纯 JS
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: ['dist/**', 'release/**', '.agents/**', 'node_modules/**'],
  },
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      '@typescript-eslint': tseslint.plugin,
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'warn',
      '@typescript-eslint/no-misused-promises': 'warn',
      '@typescript-eslint/no-unused-vars': ['warn', { args: 'after-used' }],
    },
  },
)
