import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fakeHome } from './helpers.js'
import {
  clearStaging,
  markStagingConsumed,
  readReadyStaged,
  readStagingMeta,
  saveStagingMeta,
  stagingFinalFile,
  stagingMetaPath,
  stagingPartFile,
  stagingSlotDir,
  sweepStaging,
  STAGING_MAX_AGE_MS,
  type StagingMeta,
} from '../src/update/staging.js'

// 预取 staging 账本（fakeHome 隔离）：meta 往返/损坏容错、consumed 语义、sweep 三类命中、就绪包复用判定

const VER = '999.0.0'
const ASSET = 'modeldock-999.0.0-darwin-arm64.tar.gz'

function meta(over: Partial<StagingMeta> = {}): StagingMeta {
  return {
    version: VER,
    tagName: 'v999.0.0',
    assetName: ASSET,
    assetId: 7,
    size: 100,
    etag: '"e1"',
    url: 'https://mirror.example/a',
    received: 100,
    sumsVerified: true,
    ready: true,
    consumed: false,
    error: null,
    startedAt: Date.now(),
    updatedAt: Date.now(),
    ...over,
  }
}

/** 落一个账本 + 对应尺寸的成品文件（readReadyStaged/sweep 的公共夹具） */
async function writeReadyPackage(over: Partial<StagingMeta> = {}): Promise<StagingMeta> {
  const m = meta(over)
  await saveStagingMeta(m)
  fs.mkdirSync(stagingSlotDir(VER), { recursive: true })
  fs.writeFileSync(stagingFinalFile(m.version, m.assetName), Buffer.alloc(m.size))
  return m
}

/** 绕过 saveStagingMeta 的 updatedAt 恒刷（生产语义：每次保存=活动），直写历史时间戳用例 */
async function writeRawMeta(m: StagingMeta): Promise<void> {
  await fsp.writeFile(stagingMetaPath(), JSON.stringify(m), 'utf8')
}

describe('staging 账本', () => {
  let h: ReturnType<typeof fakeHome>
  beforeEach(() => {
    h = fakeHome()
  })
  afterEach(() => {
    h.restore()
  })

  it('meta 往返：save→read 一致；损坏/缺失返回 null', async () => {
    await saveStagingMeta(meta({ received: 42 }))
    expect(await readStagingMeta()).toMatchObject({ version: VER, received: 42 })
    // 损坏内容：读方按无槽处理
    await fsp.writeFile(stagingMetaPath(), '{oops', 'utf8')
    expect(await readStagingMeta()).toBeNull()
  })

  it('markStagingConsumed：只标记匹配版本；版本不匹配不动', async () => {
    await saveStagingMeta(meta())
    await markStagingConsumed('1000.0.0')
    expect((await readStagingMeta())?.consumed).toBe(false)
    await markStagingConsumed(VER)
    expect((await readStagingMeta())?.consumed).toBe(true)
  })

  it('readReadyStaged：ready+匹配+成品在盘 → 命中；consumed/版本错/资产错/尺寸错/缺文件 → null', async () => {
    const m = await writeReadyPackage()
    expect(await readReadyStaged(m.version, m.assetName)).toEqual({ file: stagingFinalFile(m.version, m.assetName) })
    // consumed 后不可复用（sweep 收走前也不许二用）
    await markStagingConsumed(VER)
    expect(await readReadyStaged(m.version, m.assetName)).toBeNull()
    // 版本/资产不匹配
    await writeReadyPackage()
    expect(await readReadyStaged('1000.0.0', ASSET)).toBeNull()
    expect(await readReadyStaged(VER, 'other.tar.gz')).toBeNull()
    // 尺寸不符（成品被截断/被换）：文件 100 字节、账本声称 999
    const m2 = await writeReadyPackage()
    await writeRawMeta({ ...m2, size: 999 })
    expect(await readReadyStaged(VER, ASSET)).toBeNull()
    // 成品缺失
    await writeReadyPackage()
    await fsp.rm(stagingFinalFile(VER, ASSET), { force: true })
    expect(await readReadyStaged(VER, ASSET)).toBeNull()
  })

  it('sweepStaging：consumed 清、在途新鲜留、到龄清、账本损坏清', async () => {
    // consumed → 清
    await writeReadyPackage()
    await markStagingConsumed(VER)
    await sweepStaging()
    expect(await readStagingMeta()).toBeNull()
    // 在途（新鲜、未 consumed）→ 留
    await saveStagingMeta(meta({ ready: false, received: 30, sumsVerified: false }))
    fs.mkdirSync(stagingSlotDir(VER), { recursive: true })
    fs.writeFileSync(stagingPartFile(VER, ASSET), Buffer.alloc(30))
    await sweepStaging()
    expect(await readStagingMeta()).not.toBeNull()
    // 到龄 → 清（直写历史 updatedAt——saveStagingMeta 恒刷时间戳，绕过）
    await writeRawMeta(meta({ ready: false, received: 30, updatedAt: Date.now() - STAGING_MAX_AGE_MS - 1000 }))
    await sweepStaging()
    expect(await readStagingMeta()).toBeNull()
    // 账本损坏（目录有残骸）→ 清
    fs.mkdirSync(stagingSlotDir(VER), { recursive: true })
    fs.writeFileSync(stagingPartFile(VER, ASSET), 'x')
    await fsp.writeFile(stagingMetaPath(), 'garbage', 'utf8')
    await sweepStaging()
    expect(await readStagingMeta()).toBeNull()
    expect(fs.existsSync(stagingPartFile(VER, ASSET))).toBe(false)
  })

  it('clearStaging：整目录清干净', async () => {
    await writeReadyPackage()
    await clearStaging()
    expect(await readStagingMeta()).toBeNull()
  })
})
