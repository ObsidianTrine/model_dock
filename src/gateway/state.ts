/** 薄 re-export：gateway/state.ts 已按域拆至 ./state/（types 共享类型层 + runtime/routing/logs/
 *  state-file 四域模块；依赖单向 types ← 四模块，模块间互不引用）。对外导入面与拆分前
 *  完全一致——既有 `from '.../gateway/state.js'` 的全部调用点（ops/cli/tray/update/测试等）零改动。 */
export type { LogEntry, AuditEntry, EventEntry, RingEntry, ResolvedTarget, ResolveResult, GatewayRuntime, ProviderLatencyRing, HealthState } from './state/types.js'
export { buildTokenIndex, buildRuntime, reloadRuntime } from './state/runtime.js'
export type { OrderedCandidate, RouteSource, PickResult, ScheduleHit, RouteState, AutoRouteInfo } from './state/routing.js'
export { resolveTarget, resolveByProfile, recordOutcome, isMeltdown, activeScheduleWindow, activeAvoidTargets, displayRouteProvider, parseFallbackEntry, pickTarget, routeState, autoRouteInfo } from './state/routing.js'
export { pushRing, logRequest, logAudit, setEventRingSink, logEvent, reportEvent, latencyQuantiles, readRequestLogDay, filterLogEntries, summarizeUsage, startEventLoopDelaySampler, eventLoopLagMs, pruneExpiredLogs } from './state/logs.js'
export type { UsageFilter, UsageSummary } from './state/logs.js'
export type { GatewayStateFile } from './state/state-file.js'
export { checkTokenLimits, recordTokenUsage } from './state/tokenlimits.js'
export type { TokenLimitTrip } from './state/tokenlimits.js'
export type { TokenUsageState } from './state/types.js'
export { readGatewayState, gatewayLive, writeGatewayState, mutateGatewayState, clearGatewayState, pidAlive } from './state/state-file.js'
