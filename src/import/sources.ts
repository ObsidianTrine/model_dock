/** 薄 re-export：导入源实现已拆至 ./sources/（每源一文件，common.ts 共享帮手，
 *  registry.ts 汇总分发，apply.ts 落地）。对外导入面与拆分前完全一致——
 *  既有 `from '.../import/sources.js'` 的引用（ops / cli / gateway / 测试）零改动。 */
export type { ImportCandidate, ImportSource } from './sources/common.js'
export type { ImportScanOptions } from './sources/registry.js'
export type { OneApiImportSource } from './sources/oneapi.js'
export type { ImportReport } from './sources/apply.js'
export { normalizeBaseUrl, isLocalBaseUrl, stripApiEndpoint, dedupeCandidates } from './sources/common.js'
export { scanSources } from './sources/registry.js'
export { ccSwitchCodexRow, ccSwitchGeminiRow } from './sources/cc-switch.js'
export { oneApiChannelToCandidate, scanOneApi } from './sources/oneapi.js'
export { applyImport } from './sources/apply.js'
