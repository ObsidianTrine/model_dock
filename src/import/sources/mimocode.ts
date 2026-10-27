/** MiMo Code CLI / MiMo 桌面端导入源（mimocode.jsonc，与 OpenCode 同构，扫描器复用 opencode.ts） */
import { configCandidates as mimocodeConfigCandidates } from '../../adapters/mimo-code.js'
import { scanProviderJson } from './opencode.js'
import type { ImportCandidate } from './common.js'

export async function scanMimocode(): Promise<ImportCandidate[]> {
  return scanProviderJson('mimocode', mimocodeConfigCandidates(), 'MiMo Code')
}
