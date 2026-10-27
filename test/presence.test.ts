import { describe, expect, it, beforeEach } from 'vitest'
import {
  TRAY_LITE_TTL_MS,
  UI_PRESENCE_HEARTBEAT_MS,
  markUiSeen,
  markUiPing,
  markUiLeaving,
  requestTrayLite,
  trayLiteActive,
  pendingTrayLiteRequest,
  resetUiPresence,
} from '../src/gateway/presence.js'

// 纯函数单测：时间显式注入，不 mock 任何模块（vitest 单进程共享模块态，beforeEach 复位）
describe('gateway presence（轻量模式派生状态）', () => {
  beforeEach(() => resetUiPresence())

  it('初始从未见过 UI：trayLiteActive 为 true、无待广播请求、常量关系成立（心跳 < TTL）', () => {
    expect(trayLiteActive(1000)).toBe(true)
    expect(pendingTrayLiteRequest()).toBe(0)
    expect(UI_PRESENCE_HEARTBEAT_MS).toBeLessThan(TRAY_LITE_TTL_MS)
  })

  it('markUiSeen / markUiPing 使 trayLite 变 false；距今满 TTL（≥）后恢复 true', () => {
    markUiSeen(1000)
    expect(trayLiteActive(1000)).toBe(false)
    expect(trayLiteActive(1000 + TRAY_LITE_TTL_MS - 1)).toBe(false) // TTL 最后一毫秒仍算在场
    expect(trayLiteActive(1000 + TRAY_LITE_TTL_MS)).toBe(true) // 满 TTL 即过期

    markUiPing(5000) // 心跳只续在场
    expect(trayLiteActive(5000 + TRAY_LITE_TTL_MS - 1)).toBe(false)
    expect(trayLiteActive(5000 + TRAY_LITE_TTL_MS)).toBe(true)
  })

  it('markUiLeaving 立即过期（不等 TTL 走完）', () => {
    markUiSeen(1000)
    expect(trayLiteActive(1000)).toBe(false)
    markUiLeaving(1100)
    expect(trayLiteActive(1100)).toBe(true)
  })

  it('requestTrayLite 记录广播时间戳；markUiSeen（新页面加载）清除；新请求覆盖旧值', () => {
    markUiSeen(1000)
    requestTrayLite(2000)
    expect(pendingTrayLiteRequest()).toBe(2000)

    // 在场未过期时广播持续可见（多页同开：先关页面的离场信标不会让慢页漏掉广播）
    expect(trayLiteActive(2000)).toBe(false)
    expect(pendingTrayLiteRequest()).toBe(2000)

    requestTrayLite(3000)
    expect(pendingTrayLiteRequest()).toBe(3000)

    markUiSeen(4000) // 新页面打开 = 自动退出轻量模式，撤销在途广播
    expect(pendingTrayLiteRequest()).toBe(0)
    expect(trayLiteActive(4000)).toBe(false)
  })

  it('resetUiPresence 复位全部内存态', () => {
    markUiSeen(1000)
    requestTrayLite(2000)
    resetUiPresence()
    expect(trayLiteActive(3000)).toBe(true)
    expect(pendingTrayLiteRequest()).toBe(0)
  })
})
