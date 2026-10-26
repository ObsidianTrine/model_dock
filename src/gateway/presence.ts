/** 托盘「仅托盘模式」在场检测（纯逻辑，内存态，不落盘）。
 *  仅托盘 = 「没有任何 Web UI 打开」的派生状态，不是持久偏好：lastSeenAt 起 TTL 内有页面
 *  心跳即视为有 UI，否则托盘菜单勾选「仅托盘模式」。时间全部由调用方注入 now，便于纯函数单测；
 *  跨用例隔离用 resetUiPresence()（vitest 单进程共享模块态，beforeEach 调用，不得 vi.mock 本模块）。
 *  服务端接线（server.ts）：GET /_modeldock/ui 命中 200/304 → markUiSeen；hOverview → markUiPing；
 *  POST /_modeldock/ui-presence → markUiPing / markUiLeaving；POST /_modeldock/tray-only → requestTrayOnly。 */

/** 在场 TTL：页面停止心跳（关闭/被杀）后最迟这么久回到仅托盘态 */
export const TRAY_ONLY_TTL_MS = 30_000
/** 页面心跳建议间隔：必须明显小于 TTL，留出丢一次的余量 */
export const UI_PRESENCE_HEARTBEAT_MS = 15_000

let lastSeenAt = 0
let closeRequestedAt = 0

/** 页面加载（GET /_modeldock/ui 命中 200/304，托盘开控制台/双击 app/浏览器打开都走这里）：
 *  UI 在场 + 清除在途的关闭广播——任何方式打开 UI 即自动退出仅托盘 */
export function markUiSeen(now: number): void {
  lastSeenAt = now
  closeRequestedAt = 0
}

/** 页面心跳（overview 轮询 / ui-presence POST）：只续在场 */
export function markUiPing(now: number): void {
  lastSeenAt = now
}

/** 页面离场（pagehide 的 sendBeacon）：立刻过期，不等 TTL（主动关窗的即时反馈） */
export function markUiLeaving(now: number): void {
  lastSeenAt = now - TRAY_ONLY_TTL_MS
}

/** 托盘请求进入仅托盘：记录广播时间戳，已开页面经 overview 轮询感知后自关 */
export function requestTrayOnly(now: number): void {
  closeRequestedAt = now
}

/** 仅托盘是否生效：从未见过 UI，或最近一次在场距今已满 TTL（≥，与 markUiLeaving 的「置为刚好过期」配套） */
export function trayOnlyActive(now: number): boolean {
  return lastSeenAt === 0 || now - lastSeenAt >= TRAY_ONLY_TTL_MS
}

/** 待广播的关闭请求时间戳（0 = 无）。只被 markUiSeen（新页面加载 = 用户要 UI）清除，
 *  不随 trayOnlyActive 失效：多页同开时先关的页面 sendBeacon 会即时清空在场，
 *  若据此失效广播，还没轮询到的页面会漏掉自关。「新开页面不误拿旧广播」由服务端在
 *  GET /_modeldock/ui 命中时同步失效 overview 缓存承担（见 server.ts /ui 分支的注释），
 *  页面侧按「时间戳新于上次所见」去重，陈旧值不会重复触发。 */
export function pendingTrayOnlyRequest(): number {
  return closeRequestedAt
}

/** 测试专用：复位全部内存态 */
export function resetUiPresence(): void {
  lastSeenAt = 0
  closeRequestedAt = 0
}
