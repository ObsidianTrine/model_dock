// vitest 双 config 同构门禁（T21）：vitest.workflow.config.ts 靠 spread 主 config 构造性
// 保证「isolate/watchdog 防死锁面两处同构」（见其头注）——本测试把该承诺机器化：
// 后人若把 spread 换成手写对象、或只改一处的防死锁面参数，这里立刻红。除 include（套件
// 分工，本就不同）与 maxWorkers / testTimeout（分域异构，各自证据见下）外，两边 test 段
// 必须 deep-equal。
// - maxWorkers（2026-11-11 起）：编排套件缺省并行 4 经 B3 实验证据
//   docs/archive/test-orch-parallel-exp.md 定档，产品套件因 2026-10-01 卡死前科保持串行 1；
//   各域并行度按自身证据独立定档，理由见两 config 头注。
// - testTimeout（2026-11-23 起）：编排用例多为 mock worker 的 run/drain 子进程链，合法
//   耗时 15-25s，20s 上限负载下贴边成片假红（失败集合跨跑漂移、零断言失败、孤跑单文件即
//   绿），上调 60s 只拉长真挂死的败速；产品套件 in-process 测试无此耗时形态，保持 20s。
import { describe, expect, it } from 'vitest'
import baseConfig from '../vitest.config.ts'
import workflowConfig from '../vitest.workflow.config.ts'

describe('vitest 双 config 同构（T21 门禁）', () => {
  it('workflow config 的 test 段除 include / maxWorkers / testTimeout 外与 base deep-equal', () => {
    const {
      include: _baseInclude,
      maxWorkers: _baseMaxWorkers,
      testTimeout: _baseTestTimeout,
      ...baseRest
    } = baseConfig.test!
    const {
      include: _wfInclude,
      maxWorkers: _wfMaxWorkers,
      testTimeout: _wfTestTimeout,
      ...wfRest
    } = workflowConfig.test!
    expect(wfRest).toEqual(baseRest)
  })

  it('workflow include 仅指向 test/orchestrator（套件分工本身也钉住）', () => {
    expect(workflowConfig.test!.include).toEqual(['test/orchestrator/**/*.test.ts'])
  })
})
