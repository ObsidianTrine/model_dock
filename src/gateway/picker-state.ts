import type { GatewayRuntime } from './state.js'

/** 各网关实例的 picker 展示路由基线（route=上次已同步的展示服务）。模块级 WeakMap：周期检测
 *  在 createGatewayServer 闭包里跑，而 attach/apply handler 在 handleRequest 里——接入后把
 *  基线置 undefined（强制下一周期校准 picker）需要两处共享。按 rt 弱引用，实例关闭自动可回收。 */
export const pickerSyncStates = new WeakMap<GatewayRuntime, { route?: string }>()
