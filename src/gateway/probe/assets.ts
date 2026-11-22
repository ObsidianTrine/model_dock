// assets.ts — 探针内置测试资产（provider-probe-suite 任务 8）。
// 纯红 2×2 PNG 由代码生成而非手写 base64 死串：CRC/压缩字节写错时手串只会「静默坏图」，
// 代码生成保证 IHDR/IDAT/IEND 结构与 CRC 恒合法（测试侧用独立解码器逐像素复核，见
// test/probe-assets.test.ts——两侧 CRC 实现不同写法，防同一份错误算法自证）。纯色小图是
// 判定的最小区分面：模型答出颜色 = 真收图，答不出/答错 = 图没送到（防收图不看图中转）。

import { deflateSync } from 'node:zlib'

export type Rgba = readonly [number, number, number, number]

/** PNG CRC-32（IEEE 多项式 0xEDB88320）：位蝶式无表实现，与测试侧表驱动实现互为独立验证 */
function pngCrc32(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]!
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  }
  return (c ^ 0xffffffff) >>> 0
}

/** 单个 PNG chunk：长度(BE) + 类型(ASCII) + 数据 + CRC（对类型+数据计算） */
function pngChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(4)
  head.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(pngCrc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([head, typeBuf, data, crc])
}

/** 生成 w×h 纯色 RGBA PNG：8bit/色型 6(RGBA)/压缩 0/逐行 filter 0/不隔行——结构最简，
 *  测试侧无需 unfilter 即可逐像素断言。IDAT 用 node:zlib deflateSync（zlib 包头格式，
 *  PNG 规范要求），全内建无 native addon（SEA 前提）。 */
export function buildSolidPng(width: number, height: number, rgba: Rgba): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type RGBA
  // 压缩(10)/filter(11)/interlace(12) 目标值全 0，alloc 清零即目标值
  const row = Buffer.alloc(1 + width * 4)
  for (let x = 0; x < width; x++) {
    row[1 + x * 4] = rgba[0]
    row[2 + x * 4] = rgba[1]
    row[3 + x * 4] = rgba[2]
    row[4 + x * 4] = rgba[3]
  }
  const raw = Buffer.concat(Array.from({ length: height }, () => row))
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

/** P4 视觉实证内置资产（design 判定规则 5）：纯红 2×2 PNG 的 base64。openai/responses 走
 *  data URL（data:image/png;base64,<本值>），anthropic 直接填本值——组装在 runners/p4.ts。 */
export const P4_RED_PNG_BASE64: string = buildSolidPng(2, 2, [255, 0, 0, 255]).toString('base64')
