import { defineConfig } from 'vitest/config'

// 悬死观测调试模式：VITEST_WATCHDOG=1 时启用进程级观测（reporter + worker 心跳），
// 日常与 CI 默认零开销零噪音。观测器与判读指南见 test/vitest-watchdog.mjs。
// 背景（2026-10-01 已根治的 Linux CI 卡死）：policy.test.ts 对 /proc 做
// mkdirSync(recursive) 触发 Linux procfs 死循环——观测三件套（FILE-START/
// DONE、/proc 扫描、心跳）就是当时定位它的武器，保留待用。
const watchdog = process.env.VITEST_WATCHDOG === '1'

export default defineConfig({
  test: {
    // 顺序耦合对（T21 门禁：test-suite-couplings.test.ts）——singleFork 串行 + vitest
    // 按缓存混合排序（failed 先行 → 历史时长降序 → 无缓存按文件字节大小降序），文件
    // 顺序随缓存状态漂移、不可作前提（2026-11-05 实测三种语境三种顺序，详见该门禁
    // 文件头注）。安全靠静态不变量：uninstall.test.ts 唯一静态 import basic.js、唯一
    // vi.mock gatewaycmd（其 mock 经 hoist 先于自身 import 注册，自洽）；zz-quickwins /
    // update-tray 惰性 import 或依赖注入、顺序无关——均由 test-suite-couplings.test.ts
    // 门禁断言（vitest 5 collectTests 先收集全部文件、后跑用例，vi.mock 注册先于一切
    // 测试期动态 import）。动这三个文件前先重审耦合。
    // 产品套件 = test/ 顶层。agent 工作流套件（test/orchestrator/**，测 .agents/ 编排器与
    // 守卫 hook）拆到 vitest.workflow.config.ts，经 `npm run test:workflow` 单独运行——
    // 产品门禁不再为其支付 ~40s（方案 A）；池策略等防死锁设置两处必须保持同构。
    include: ['test/*.test.ts'],
    testTimeout: 20000,
    env: {
      NODE_NO_WARNINGS: '1'
    },
    // 覆盖率（默认关闭，`npm run test:coverage` 显式开启）：发布前人工审缺口用，不设硬阈值门禁
    // （覆盖率是手段不是目的；singleFork 串行全量约 +1 分钟）。生成文件与内联 UI 资产不计入。
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      exclude: [
        'src/providers/catalog-snapshot.generated.ts',
        'src/gateway/ui.ts',
        'src/gateway/lanAssets.ts',
        'src/version.ts'
      ],
      reporter: ['text', 'html'],
      reportsDirectory: 'coverage'
    },
    pool: 'forks',
    // ①isolate:false + maxWorkers:1（vitest4 迁移：原 forks.singleFork，见
    //   https://vitest.dev/guide/migration 的 pool rework 节）：全部文件在同一子进程
    //   串行执行，结构性消灭「每文件 spawn/销毁 worker」与多 worker 消息路由两个
    //   死锁面（CI 曾确定性卡死在 policy.test.ts：worker 生命周期/消息层问题，
    //   业务代码无嫌疑——另见上方 procfs 死循环根因，两者叠加）。串行下文件天然
    //   排队；测试间状态隔离依赖各测试自身的 try/finally 自洁（fakeHome、presence
    //   env 等均已如此设计），本地全量验证为准。
    //   vitest4 的另一层收益：worker→主进程 onTaskUpdate RPC 不再有 birpc 固定
    //   60s 死线（vitest3 下 orchestrator 集成测试的 execSync 长阻塞会误报
    //   `Timeout calling "onTaskUpdate"` 并中止整个 run，vitest-dev/vitest#8164，
    //   修复 PR #8297 仅落在 v4）。
    // ②观测三件套（test/vitest-watchdog.mjs 注释里有解读指南）：[FILE-START/DONE]
    //   文件生命周期、[WATCHDOG] /proc 扫描、[WORKER-HB] worker 心跳——输出默认
    //   关闭，VITEST_WATCHDOG=1 开启；8 分钟无进展自毁 exit(86) 常开（触发下方
    //   test.yml 的诊断步骤，不再悬死等 job 超时）。
    isolate: false,
    maxWorkers: 1,
    reporters: ['default', './test/vitest-watchdog.mjs'],
    // 常开 setup：sync 域 PBKDF2 测试降迭代（test/setup-fast-kdf.ts 头注有依据与还原方式）
    setupFiles: ['./test/setup-fast-kdf.ts', ...(watchdog ? (['./test/watchdog-heartbeat.mjs'] as string[]) : [])],
    silent: 'passed-only',
    teardownTimeout: 5000
  }
})
