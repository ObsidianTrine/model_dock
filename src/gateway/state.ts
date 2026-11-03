/** 薄 re-export：gateway/state.ts 已按域拆至 ./state/（types 共享类型层 + runtime/routing/logs/
 *  state-file/sea 五域模块；依赖单向 types ← 各域模块，域间互不引用——唯一例外 routing 引
 *  sea 的记账入口 recordSeaOutcome（同源事件流，见 sea.ts 头注）。对外导入面与拆分前完全一致
 *  ——既有 `from '.../gateway/state.js'` 的全部调用点（ops/cli/tray/update/测试等）零改动。 */
export type { LogEntry, AuditEntry, EventEntry, RingEntry, ResolvedTarget, ResolveResult, GatewayRuntime, ProviderLatencyRing, HealthState } from './state/types.js'
export { buildTokenIndex, buildRuntime, reloadRuntime } from './state/runtime.js'
export type { OrderedCandidate, RouteSource, PickResult, ScheduleHit, RouteState, AutoRouteInfo } from './state/routing.js'
export { resolveTarget, resolveByProfile, recordOutcome, isMeltdown, activeScheduleWindow, activeAvoidTargets, displayRouteProvider, parseFallbackEntry, pickTarget, routeState, autoRouteInfo } from './state/routing.js'
export { pushRing, logRequest, logAudit, setEventRingSink, logEvent, reportEvent, latencyQuantiles, readRequestLogDay, filterLogEntries, logEntryMatches, summarizeUsage, summarizeUsageDays, createUsageAccumulator, startEventLoopDelaySampler, eventLoopLagMs, pruneExpiredLogs, usageTodayView, resetUsageTodayForTest } from './state/logs.js'
export type { UsageFilter, UsageSummary, UsageCost, UsageTodayView } from './state/logs.js'
export type { GatewayStateFile } from './state/state-file.js'
export { checkTokenLimits, recordTokenUsage } from './state/tokenlimits.js'
export type { TokenLimitTrip } from './state/tokenlimits.js'
export type { TokenUsageState } from './state/types.js'
export type { KeyPoolState } from './state/types.js'
export { KEY_COOLDOWN_MS, markKeyCooldown, keyInCooldown, nextRotation, keyPoolHealthView, resetKeyPool } from './state/keypool.js'
export { readGatewayState, gatewayLive, writeGatewayState, mutateGatewayState, clearGatewayState, pidAlive, startupGatewayState } from './state/state-file.js'
export { recordSeaOutcome, seaWindowView, seaStateSnapshot, SEA_WINDOW_5M_MS, SEA_WINDOW_60M_MS, SEA_STORM_MELTDOWN_RATIO, SEA_STORM_429_RATE, SEA_STORM_429_MIN_TOTAL, SEA_STORM_REASON_MELTDOWN_MAJORITY, SEA_STORM_REASON_429_RATE } from './state/sea.js'
export type { SeaMinuteBucket, SeaWindowView, SeaProviderErrors, SeaState, ProviderAvailability, ModelProbeState } from './state/types.js'
