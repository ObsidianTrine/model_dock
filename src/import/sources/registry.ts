/** 导入源 registry：汇总是 11 个本地扫描器 + oneapi 显式拉取的分发入口（形态参照 adapters/registry.ts） */
import { t } from '../../util/i18n.js'
import { dedupeCandidates, type ImportCandidate, type ImportSource } from './common.js'
import { scanCcSwitch } from './cc-switch.js'
import { scanClaude } from './claude.js'
import { scanDsh } from './dsh.js'
import { scanZcode } from './zcode.js'
import { scanCodex } from './codex.js'
import { scanOpenCode } from './opencode.js'
import { scanMimocode } from './mimocode.js'
import { scanWorkbuddy } from './workbuddy.js'
import { scanCcr } from './ccr.js'
import { scanCrush } from './crush.js'
import { scanGemini } from './gemini.js'
import { scanOneApi } from './oneapi.js'

export interface ImportScanOptions {
  /** one-api / new-api 站点凭据：--from oneapi 时必填（渠道数据存在服务端，本机扫描拿不到） */
  oneapi?: { url: string; token: string }
}

export async function scanSources(source: ImportSource | 'all', opts: ImportScanOptions = {}): Promise<ImportCandidate[]> {
  const wanted = (s: ImportSource) => source === 'all' || source === s
  // 各本地扫描器相互独立（各自只读自己的固定路径集合），并行执行把延迟从「各扫描之和」压到
  // 「最慢一个」；Promise.all 保序，候选顺序与串行一致，dedupeCandidates 的去重口径不变
  const localScanners: Array<[ImportSource, () => Promise<ImportCandidate[]>]> = [
    ['cc-switch', scanCcSwitch],
    ['claude', scanClaude],
    ['dsh', scanDsh],
    ['zcode', scanZcode],
    ['codex', scanCodex],
    ['opencode', scanOpenCode],
    ['mimocode', scanMimocode],
    ['workbuddy', scanWorkbuddy],
    ['ccr', scanCcr],
    ['crush', scanCrush],
    ['gemini', scanGemini],
  ]
  const out: ImportCandidate[] = []
  const results = await Promise.all(localScanners.filter(([s]) => wanted(s)).map(([, scan]) => scan()))
  for (const r of results) out.push(...r)
  if (source === 'oneapi') {
    // oneapi 需要站点凭据，不进 'all'（自动扫描拿不到），只走显式 --from oneapi
    if (!opts.oneapi) {
      throw new Error(
        t('one-api 渠道导入需要站点地址与管理令牌（--url / --token，令牌见 one-api「个人设置 → 系统访问令牌」）', 'one-api channel import needs the site URL and an admin token (--url / --token; token is under one-api "Personal settings → System access token")')
      )
    }
    out.push(...(await scanOneApi(opts.oneapi)))
  }
  return dedupeCandidates(out)
}
