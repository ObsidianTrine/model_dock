import { describe, expect, it, beforeEach } from 'vitest'
import {
  TRAY_ONLY_TTL_MS,
  UI_PRESENCE_HEARTBEAT_MS,
  markUiSeen,
  markUiPing,
  markUiLeaving,
  requestTrayOnly,
  trayOnlyActive,
  pendingTrayOnlyRequest,
  resetUiPresence,
} from '../src/gateway/presence.js'

// 纯函数单测：时间显式注入，不 mock 任何模块（vitest 单进程共享模块态，beforeEach 复位）
describe('gateway presence（仅托盘派生状态）', () => {
  beforeEach(() => resetUiPresence())

  it('初始从未见过 UI：trayOnlyActive 为 true、无待广播请求、常量关系成立（心跳 < TTL）', () => {
    expect(trayOnlyActive(1000)).toBe(true)
    expect(pendingTrayOnlyRequest()).toBe(0)
    expect(UI_PRESENCE_HEARTBEAT_MS).toBeLessThan(TRAY_ONLY_TTL_MS)
  })

  it('markUiSeen / markUiPing 使 trayOnly 变 false；距今满 TTL（≥）后恢复 true', () => {
    markUiSeen(1000)
    expect(trayOnlyActive(1000)).toBe(false)
    expect(trayOnlyActive(1000 + TRAY_ONLY_TTL_MS - 1)).toBe(false) // TTL 最后一毫秒仍算在场
    expect(trayOnlyActive(1000 + TRAY_ONLY_TTL_MS)).toBe(true) // 满 TTL 即过期

    markUiPing(5000) // 心跳只续在场
    expect(trayOnlyActive(5000 + TRAY_ONLY_TTL_MS - 1)).toBe(false)
    expect(trayOnlyActive(5000 + TRAY_ONLY_TTL_MS)).toBe(true)
  })

  it('markUiLeaving 立即过期（不等 TTL 走完）', () => {
    markUiSeen(1000)
    expect(trayOnlyActive(1000)).toBe(false)
    markUiLeaving(1100)
    expect(trayOnlyActive(1100)).toBe(true)
  })

  it('requestTrayOnly 记录广播时间戳；markUiSeen（新页面加载）清除；新请求覆盖旧值', () => {
    markUiSeen(1000)
    requestTrayOnly(2000)
    expect(pendingTrayOnlyRequest()).toBe(2000)

    // 在场未过期时广播持续可见（多页同开：先关页面的离场信标不会让慢页漏掉广播）
    expect(trayOnlyActive(2000)).toBe(false)
    expect(pendingTrayOnlyRequest()).toBe(2000)

    requestTrayOnly(3000)
    expect(pendingTrayOnlyRequest()).toBe(3000)

    markUiSeen(4000) // 新页面打开 = 自动退出仅托盘，撤销在途广播
    expect(pendingTrayOnlyRequest()).toBe(0)
    expect(trayOnlyActive(4000)).toBe(false)
  })

  it('resetUiPresence 复位全部内存态', () => {
    markUiSeen(1000)
    requestTrayOnly(2000)
    resetUiPresence()
    expect(trayOnlyActive(3000)).toBe(true)
    expect(pendingTrayOnlyRequest()).toBe(0)
  })
})
