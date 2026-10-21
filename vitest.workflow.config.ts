import { defineConfig } from 'vitest/config'
import base from './vitest.config.ts'

// agent 工作流套件（test/orchestrator/**）：测 .agents/ 编排器脚本、分支守卫 hook、policy。
// 与产品套件（vitest.config.ts，include test/*.test.ts）拆分运行：`npm run test:workflow`。
// 对象 spread 覆盖 include（数组整体替换，不是 mergeConfig 的拼接），其余防死锁设置
// （串行池 / watchdog / 超时）与产品套件单一事实来源，天然同构。
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ['test/orchestrator/**/*.test.ts'],
  },
})
