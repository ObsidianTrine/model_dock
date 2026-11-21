import { describe, expect, it } from 'vitest'
import { inflateSync } from 'node:zlib'
import { P4_RED_PNG_BASE64, buildSolidPng } from '../src/gateway/probe/assets.js'

// 探针内置资产（provider-probe-suite 任务 8）：P4 纯红 2×2 PNG 常量的独立解码验证。解码器
// 在测试侧独立实现（表驱动 CRC、逐 chunk 校验、inflate 后逐行断言），与 assets.ts 的位蝶式
// CRC 写法互为独立验证——若两侧实现犯同一个错，chunk CRC 校验/像素断言会当场炸出。

/** 独立 PNG 解码器：校验签名、逐 chunk CRC、IHDR 参数，inflate IDAT 后按行抽取 RGBA 像素 */
function decodePng(buf: Buffer): {
  width: number
  height: number
  bitDepth: number
  colorType: number
  pixels: Array<[number, number, number, number]>
} {
  const CRC_TABLE = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    CRC_TABLE[n] = c >>> 0
  }
  const crc32 = (b: Buffer): number => {
    let c = 0xffffffff
    for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]!) & 0xff]! ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  if (!buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    throw new Error('PNG signature mismatch')
  }
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  const idat: Buffer[] = []
  let off = 8
  let closed = false
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off)
    const type = buf.toString('ascii', off + 4, off + 8)
    const data = buf.subarray(off + 8, off + 8 + len)
    if (data.length !== len) throw new Error(`chunk ${type} truncated`)
    const crc = buf.readUInt32BE(off + 8 + len)
    if (crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])) !== crc) throw new Error(`chunk ${type} CRC mismatch`)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]!
      colorType = data[9]!
      if (data[10] !== 0 || data[11] !== 0 || data[12] !== 0) throw new Error('unexpected compression/filter/interlace')
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') {
      closed = true
    }
    off += 12 + len
  }
  if (!closed) throw new Error('IEND missing')
  if (!idat.length) throw new Error('IDAT missing')
  const raw = inflateSync(Buffer.concat(idat))
  const stride = 1 + width * 4
  if (raw.length !== height * stride) throw new Error(`raw size ${raw.length} != ${height}x${stride}`)
  const pixels: Array<[number, number, number, number]> = []
  for (let y = 0; y < height; y++) {
    if (raw[y * stride] !== 0) throw new Error('unexpected row filter')
    for (let x = 0; x < width; x++) {
      const b = y * stride + 1 + x * 4
      pixels.push([raw[b]!, raw[b + 1]!, raw[b + 2]!, raw[b + 3]!])
    }
  }
  return { width, height, bitDepth, colorType, pixels }
}

describe('probe-assets · P4 纯红 2×2 PNG', () => {
  it('常量解码后为 2×2、8bit RGBA、四像素全红 (255,0,0,255)', () => {
    const png = decodePng(Buffer.from(P4_RED_PNG_BASE64, 'base64'))
    expect(png.width).toBe(2)
    expect(png.height).toBe(2)
    expect(png.bitDepth).toBe(8)
    expect(png.colorType).toBe(6)
    expect(png.pixels).toHaveLength(4)
    for (const px of png.pixels) expect(px).toEqual([255, 0, 0, 255])
  })

  it('常量与即时生成逐字节一致（生成确定性）', () => {
    expect(Buffer.from(P4_RED_PNG_BASE64, 'base64').equals(buildSolidPng(2, 2, [255, 0, 0, 255]))).toBe(true)
  })
})

describe('probe-assets · buildSolidPng 通用性', () => {
  it('任意尺寸/颜色解码一致（3×1 纯绿、1×1 纯蓝）', () => {
    const green = decodePng(buildSolidPng(3, 1, [0, 255, 0, 255]))
    expect(green.width).toBe(3)
    expect(green.height).toBe(1)
    expect(green.pixels).toHaveLength(3)
    for (const px of green.pixels) expect(px).toEqual([0, 255, 0, 255])

    const blue = decodePng(buildSolidPng(1, 1, [0, 0, 255, 255]))
    expect(blue.pixels).toEqual([[0, 0, 255, 255]])
  })

  it('CRC 篡改被独立解码器捕获（校验器有效自证）', () => {
    const buf = buildSolidPng(2, 2, [255, 0, 0, 255])
    const tampered = Buffer.from(buf)
    // IHDR 数据区首字节（宽度低位）被改：chunk CRC 立即失配
    tampered[16] = 3
    expect(() => decodePng(tampered)).toThrow(/CRC mismatch/)
  })
})
