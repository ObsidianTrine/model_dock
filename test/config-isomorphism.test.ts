// vitest 双 config 同构门禁（T21）：vitest.workflow.config.ts 靠 spread 主 config 构造性
// 保证「池策略/超时/watchdog 两处同构」（见其头注）——本测试把该承诺机器化：后人若把
// spread 换成手写对象、或只改一处的池参数，这里立刻红。除 include（套件分工，本就不同）
// 外两边 test 段必须 deep-equal。
import { describe, expect, it } from 'vitest'
import baseConfig from '../vitest.config.ts'
import workflowConfig from '../vitest.workflow.config.ts'

describe('vitest 双 config 同构（T21 门禁）', () => {
  it('workflow config 的 test 段除 include 外与 base deep-equal', () => {
    const { include: _baseInclude, ...baseRest } = baseConfig.test!
    const { include: _wfInclude, ...wfRest } = workflowConfig.test!
    expect(wfRest).toEqual(baseRest)
  })

  it('workflow include 仅指向 test/orchestrator（套件分工本身也钉住）', () => {
    expect(workflowConfig.test!.include).toEqual(['test/orchestrator/**/*.test.ts'])
  })
})
