import http from 'node:http'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { downloadToFile } from '../src/update/transfer.js'

// 断点续传原语（本地 mock 服务器，零真实网络）：Range/If-Range 协议行为 + 落盘模式（追加/覆盖）

interface ResumeServer {
  base: string
  requests: { range: string | null; ifRange: string | null }[]
  close: () => Promise<void>
}

/** Range 感知 mock：带 Range 且（无 If-Range 或 If-Range 命中 etag）→ 206 剩余量；
 *  带 Range 但 If-Range 不命中 → 200 全量（资源已变语义）；Range 起点越界 → 416；无 Range → 200 全量 */
async function startResumeServer(full: Buffer, etag: string, opts: { honorRange?: boolean } = {}): Promise<ResumeServer> {
  const requests: { range: string | null; ifRange: string | null }[] = []
  const server = http.createServer((req, res) => {
    requests.push({ range: req.headers.range ?? null, ifRange: (req.headers['if-range'] as string | undefined) ?? null })
    const range = req.headers.range?.match(/^bytes=(\d+)-$/)
    const ifRange = (req.headers['if-range'] as string | undefined) ?? null
    if (range && Number(range[1]) >= full.length) {
      res.writeHead(416).end()
      return
    }
    if (range && opts.honorRange !== false && (!ifRange || ifRange === etag)) {
      const start = Number(range[1])
      res.writeHead(206, { 'content-type': 'application/octet-stream', 'content-length': full.length - start, etag })
      res.end(full.subarray(start))
      return
    }
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': full.length, etag }).end(full)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no port')
  return { base: `http://127.0.0.1:${addr.port}`, requests, close: () => new Promise((r) => server.close(() => r())) }
}

describe('downloadToFile 断点续传', () => {
  const full = Buffer.from('0123456789abcdefghij')
  let cleanup: (() => Promise<void>) | null = null
  let dir: string

  afterEach(async () => {
    await cleanup?.()
    cleanup = null
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
  })

  it('无 resumeFrom：行为不变（200 全量覆盖写，返回全量字节数）', async () => {
    const api = await startResumeServer(full, '"etag-1"')
    cleanup = api.close
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mdk-resume-'))
    const dest = path.join(dir, 'f.bin')
    const n = await downloadToFile(`${api.base}/asset`, dest, {})
    expect(n).toBe(full.length)
    expect(fs.readFileSync(dest)).toEqual(full)
    // 未发 Range
    expect(api.requests[0].range).toBeNull()
  })

  it('206 续传：追加写返回增量（剩余量），文件拼接完整', async () => {
    const api = await startResumeServer(full, '"etag-1"')
    cleanup = api.close
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mdk-resume-'))
    const dest = path.join(dir, 'f.bin')
    const head = full.subarray(0, 6)
    fs.writeFileSync(dest, head)
    const n = await downloadToFile(`${api.base}/asset`, dest, { resumeFrom: head.length, ifRange: '"etag-1"' })
    expect(n).toBe(full.length - head.length)
    expect(fs.readFileSync(dest)).toEqual(full)
    expect(api.requests[0].range).toBe(`bytes=${head.length}-`)
    expect(api.requests[0].ifRange).toBe('"etag-1"')
  })

  it('If-Range 不命中（资源已变）：服务器回 200 全量，覆盖重写不拼杂交内容', async () => {
    const api = await startResumeServer(full, '"etag-2"')
    cleanup = api.close
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mdk-resume-'))
    const dest = path.join(dir, 'f.bin')
    fs.writeFileSync(dest, full.subarray(0, 6))
    const n = await downloadToFile(`${api.base}/asset`, dest, { resumeFrom: 6, ifRange: '"etag-stale"' })
    expect(n).toBe(full.length) // 200 全量的字节数
    expect(fs.readFileSync(dest)).toEqual(full)
  })

  it('发 resumeFrom 但不带 ifRange：只发 Range 不发 If-Range（靠调用方终验兜底）', async () => {
    const api = await startResumeServer(full, '"etag-1"')
    cleanup = api.close
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mdk-resume-'))
    const dest = path.join(dir, 'f.bin')
    fs.writeFileSync(dest, full.subarray(0, 4))
    await downloadToFile(`${api.base}/asset`, dest, { resumeFrom: 4 })
    expect(api.requests[0].range).toBe('bytes=4-')
    expect(api.requests[0].ifRange).toBeNull()
    expect(fs.readFileSync(dest)).toEqual(full)
  })

  it('onResponseMeta：status 与 etag 在 body 流开始前透出（续传记账）', async () => {
    const api = await startResumeServer(full, '"etag-9"')
    cleanup = api.close
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mdk-resume-'))
    const dest = path.join(dir, 'f.bin')
    const meta: { status: number; etag: string | null }[] = []
    await downloadToFile(`${api.base}/asset`, dest, { onResponseMeta: (m) => meta.push(m) })
    expect(meta).toEqual([{ status: 200, etag: '"etag-9"' }])
  })

  it('Range 起点越界：416 抛错（调用方须保证 start < 资产总大小）', async () => {
    const api = await startResumeServer(full, '"etag-1"')
    cleanup = api.close
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mdk-resume-'))
    await expect(downloadToFile(`${api.base}/asset`, path.join(dir, 'f.bin'), { resumeFrom: full.length + 5 })).rejects.toThrow(/HTTP 416/)
  })
})
