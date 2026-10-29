/**
 * 面向"用户任务"的操作层：添加服务 / 切换服务 / 接入客户端 / 断开客户端。
 * CLI 与 Web 控制台共用，保证行为（含快照、非侵入语义）一致。
 */
/** 薄 re-export：ops.ts 已按域拆至 ./ops/（service 服务添加 / routing 路由切换与烤模型同步 /
 *  gateway-port 客户端端口解析帮手 / attach 接入摘除与模式切换 / maintenance 密钥迁移与级联删除；
 *  依赖单向：routing → {gateway-port, attach}，attach → gateway-port，无环）。对外导入面与
 *  拆分前完全一致——既有 `from '.../ops.js'` 的全部调用点（server/lan/cli/测试等）零改动。 */
export type { AddServiceResult, AddServiceSubmittedModels } from './ops/service.js'
export { validateServiceInput, resolveServiceModels, resolveFallbackChain, addService } from './ops/service.js'
export type { RefreshBakedResult, DisplayRouteSyncResult } from './ops/routing.js'
export { setAutoRoute, setRouteNext, switchToService, switchToServiceWithRoute, refreshBakedModelClients, ensureProfileForProvider, syncBakedClientsForDisplayRoute, resyncHarnessToRoute } from './ops/routing.js'
export { resolveClientGatewayPort } from './ops/gateway-port.js'
export type { AttachPlan, AttachOutcome, RegisterAttachResult, DetachOutcome, ModeSwitchOutcome } from './ops/attach.js'
export { planAttach, registerAttach, applyAttach, switchHarnessMode, detachHarness } from './ops/attach.js'
export { migrateSecretsToSecure, removeProviderCascade } from './ops/maintenance.js'
