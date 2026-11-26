import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { REPO_ROOT } from './helpers.js'

/**
 * test/ 类型检查门禁的登记断言（T30）：tsconfig.test.json 的 exclude 是「存量豁免清单」，
 * 每一项都必须是已知的历史脏文件——谁往 exclude 加文件（让新测试逃过类型检查）或删掉登记，
 * 这里立刻红，逼先补类型或给出理由。
 *
 * 现为**空清单**（2026-11-26 E-01 收口）：test/ 全量受检——orchestrator 侧靠
 * test/orchestrator/agents-scripts.d.ts 把 .agents 的 .mjs 声明为 any 边界，产品侧逐文件补了
 * 夹具断言。以后要豁免，两边同时加并在这里写明原因。
 */
const REGISTERED_EXCLUDE: string[] = []

describe('test/ 类型检查门禁（T30）', () => {
  it('tsconfig.test.json 存在且豁免清单与登记完全一致（防白名单无意识生长）', () => {
    const cfgText = fs.readFileSync(path.join(REPO_ROOT, 'tsconfig.test.json'), 'utf8')
    // tsconfig 是 JSONC（带注释），剥掉 // 注释行后按 JSON 解析
    const cfg = JSON.parse(cfgText.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n'))
    expect(cfg.compilerOptions?.noEmit).toBe(true)
    expect(cfg.exclude).toEqual(REGISTERED_EXCLUDE)
  })

  it('豁免清单里的文件都真实存在（改名/删除后清单必须跟着收缩）', () => {
    for (const f of REGISTERED_EXCLUDE) {
      expect(fs.existsSync(path.join(REPO_ROOT, f)), `豁免文件不存在：${f}`).toBe(true)
    }
  })

  it('npm test 确实前置了类型检查（脚本被改回纯 vitest 时此门禁形同虚设）', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'))
    expect(pkg.scripts.test).toContain('tsc -p tsconfig.test.json --noEmit')
  })
})
