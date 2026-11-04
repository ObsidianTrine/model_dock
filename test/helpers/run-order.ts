// 测试文件收集序观测器（test-suite-couplings.test.ts 门禁专用）——零依赖、无 IO。
// 原理（vitest 5.0.5 实测源码 node_modules/vitest/dist run.*.js 的 startTests）：
// isolate:false + 单 fork 下，worker 先对本次运行的全部测试文件 collectTests——
// for 循环顺序导入每个文件（模块顶层副作用与 vi.mock 注册都发生在收集期），
// collectTests 全部完成后才开始 runFiles 跑用例。因此任何用例执行时，下面这条
// 记录已完整包含本次运行所有文件的收集序；排序键是 vitest 的历史运行时长缓存
//（「慢者先行」，非字母序，见 vitest.config.ts 头注「顺序耦合对」），无法静态断言，
// 只能运行期观测。注意：时长缓存里的是测试时长（不含收集期 import 开销），且
// BaseSequencer 混合「failed 先行 → 缓存时长降序 → 无缓存按文件字节大小降序」，顺序
// 随缓存状态漂移（2026-11-05 三语境实测：暖缓存全量 uninstall → zz → tray、四文件子集
// zz → uninstall → tray、冷缓存全量 tray → zz → uninstall）——故门禁不对记录序做成对
// 断言（见 test-suite-couplings.test.ts 头注沿革②③），记录仅作排障观测线索。
// helper 自身零依赖：三文件顶层 import 不触碰 basic.js，无 registry 污染。
const order: string[] = []

/** 测试文件在模块顶层调用：把自己登记进共享收集序（只增不改） */
export function recordTestFile(name: string): void {
  order.push(name)
}

/** 只读快照：本次运行至今的文件收集序（收集期结束即全量） */
export function testFileRunOrder(): readonly string[] {
  return order
}
