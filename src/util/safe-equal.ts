import { createHash, timingSafeEqual } from 'node:crypto'

/** 常数时间字符串比较：先 sha256 归一化到定长再加 timingSafeEqual，避免对长度不等输入提前短路
 *  （长度泄漏）。用于 admin token / LAN token 等高价值凭据比对；主网关 server.ts 与手机控制台
 *  lan.ts 共用此单一实现（收敛前 lan 侧为「先长度预比较」版本，互换为安全的归一版，判定结果语义不变）。 */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a, 'utf8').digest()
  const hb = createHash('sha256').update(b, 'utf8').digest()
  return timingSafeEqual(ha, hb)
}