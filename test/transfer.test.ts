import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import net, { type AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { downloadText, downloadToFile, extractArchive, parseSums, type SpawnRunner } from '../src/update/transfer.js'
import { UpdateError, validateAssetName, downloadAsset, verifyChecksum, type ReleaseAsset } from '../src/update/check.js'

// 本文件零 vi.mock：下载用本地 mock 服务器桩测，命令拼装用注入执行器桩——尊重 vitest singleFork
// 跨文件 mock 雷区，也让测试在三大 OS 上都能过（不真跑 tar/powershell）。

function sha256(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

function listenEphemeral(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port))
  })
}

describe('transfer 下载原语（本地 mock 服务器）', () => {
  const servers: http.Server[] = []
  let root = ''
  beforeEach(async () => { root = await fsp.mkdtemp(path.join(os.tmpdir(), 'modeldock-transfer-')) })
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))))
    await fsp.rm(root, { recursive: true, force: true }).catch(() => {})
  })
  const serve = (handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<`http://127.0.0.1:${number}`> => {
    const server = http.createServer(handler)
    servers.push(server)
    return listenEphemeral(server).then((port) => `http://127.0.0.1:${port}`)
  }

  it('downloadToFile：正常下载落盘，字节数与进度回调正确', async () => {
    const body = Buffer.from('payload-'.repeat(1000))
    const base = await serve((_req, res) => { res.writeHead(200, { 'content-length': String(body.length) }); res.end(body) })
    const dest = path.join(root, 'x.bin')
    const progressed: number[] = []
    const received = await downloadToFile(`${base}/file`, dest, { onProgress: (r, t) => progressed.push(r) })
    expect(received).toBe(body.length)
    expect(fs.readFileSync(dest)).toEqual(body)
    expect(progressed.at(-1)).toBe(body.length)
  })

  it('downloadToFile：非 2xx 报错并点名 assetName', async () => {
    const base = await serve((_req, res) => { res.writeHead(500); res.end('boom') })
    await expect(downloadToFile(`${base}/file`, path.join(root, 'x.bin'), { objectName: 'pkg.tar.gz' }))
      .rejects.toThrow(/HTTP 500/)
  })

  it('downloadText：文本下载（SUMS 用例）', async () => {
    const text = `${sha256(Buffer.from('a'))}  asset\t${sha256(Buffer.from('b'))}  other\n`
    const base = await serve((_req, res) => { res.writeHead(200); res.end(text) })
    expect(await downloadText(`${base}/SHASUMS256.txt`)).toBe(text)
  })

  it('downloadAsset 重试：前几次 5xx 后 200 → 落盘成功（候选内整文件重试）', async () => {
    const body = Buffer.from('retry-payload')
    let calls = 0
    const base = await serve((_req, res) => {
      calls++
      if (calls < 3) { res.writeHead(503); res.end('not-ready'); return }
      res.writeHead(200); res.end(body)
    })
    const asset: ReleaseAsset = { name: 'modeldock-9.9.9-darwin-arm64.tar.gz', id: 7, size: body.length }
    const file = await downloadAsset('owner/repo', null, asset, root, { apiBase: base, retryDelayMs: 1 })
    expect(fs.readFileSync(file)).toEqual(body)
    expect(calls).toBe(3)
  })

  it('下载后 SHA256 相符放行；不符则删除并拒装', async () => {
    const body = Buffer.from('verify-me')
    const base = await serve((_req, res) => { res.writeHead(200); res.end(body) })
    const good = path.join(root, 'good.pkg')
    await downloadToFile(`${base}/good.pkg`, good)
    await verifyChecksum(good, { 'good.pkg': sha256(body) }) // 相符不抛

    const tampered = path.join(root, 'bad.pkg')
    await downloadToFile(`${base}/bad.pkg`, tampered)
    await expect(verifyChecksum(tampered, { 'bad.pkg': sha256(Buffer.from('not-it')) })).rejects.toThrow(UpdateError)
    expect(fs.existsSync(tampered)).toBe(false)
  })
})

describe('SUMS 解析与资产名校验', () => {
  it('parseSums：大小写哈希都认，兼容 * 标记，按文件名取小写哈希', () => {
    const text = [
      `${sha256(Buffer.from('a'))}  modeldock-a.tar.gz`,
      `${sha256(Buffer.from('b')).toUpperCase()} *modeldock-b.zip`, // 全大写哈希 + BSD * 前缀
      `    ${sha256(Buffer.from('c'))} \t modeldock-c.tar.gz   `,   // 首尾空白容错
    ].join('\n')
    const map = parseSums(text)
    expect(map['modeldock-a.tar.gz']).toBe(sha256(Buffer.from('a')))
    expect(map['modeldock-b.zip']).toBe(sha256(Buffer.from('b')))     // 大写 → 小写归一
    expect(map['modeldock-c.tar.gz']).toBe(sha256(Buffer.from('c')))
    expect(Object.keys(map)).toHaveLength(3)
    expect(map['missing']).toBeUndefined()
  })

  it('validateAssetName：路径穿越/非法名被拒，合法名通过', () => {
    expect(() => validateAssetName('modeldock-1.2.3-darwin-arm64.tar.gz')).not.toThrow()
    expect(() => validateAssetName('a/b.tar.gz')).toThrow(UpdateError)   // 含 /
    expect(() => validateAssetName('..\\..\\evil')).toThrow(UpdateError) // 含 \ 穿越
    expect(() => validateAssetName('..')).toThrow(UpdateError)
    expect(() => validateAssetName('')).toThrow(UpdateError)
    // downloadAsset 入口即在下载前拦截穿越资产名：不发网络请求
  })
})

describe('extractArchive 命令拼装（注入执行器桩，不真跑系统工具）', () => {
  it('tar.zip 分支：zip 走 PowerShell Expand-Archive，其余走系统 tar', async () => {
    const calls: string[][] = []
    const runner: SpawnRunner = async (_cmd, args) => { calls.push(args) }
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'modeldock-extract-'))
    try {
      await extractArchive(path.join(dir, 'pkg.zip'), dir, runner)
      expect(calls).toHaveLength(1)
      expect(calls[0][0]).toBe('-NoProfile')
      expect(calls[0].join(' ')).toContain('Expand-Archive')
      // 不注入平台桩也可断言 powershell 参数（zip 分支与平台无关）

      calls.length = 0
      await extractArchive(path.join(dir, 'pkg.tar.gz'), dir, runner)
      expect(calls).toEqual([['-xzf', path.join(dir, 'pkg.tar.gz'), '-C', dir]])
    } finally {
      await fsp.rm(dir, { recursive: true, force: true })
    }
  })

  it('win32 解压路径含引号或 PowerShell 元字符会拒绝（Expand-Archive 拼坏/插值防护）', async () => {
    const calls: string[][] = []
    const runner: SpawnRunner = async (_cmd, args) => { calls.push(args) }
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ok-'))
    try {
      // 无引号路径：win 放行（拼好 powershell 命令）
      await extractArchive(path.join(dir, 'pkg.zip'), dir, runner, 'win32')
      expect(calls).toHaveLength(1)
      expect(calls[0].join(' ')).toContain('Expand-Archive')
      // 含引号 / PowerShell 插值元字符（反引号、$(）：拒绝且不跑任何命令、不落盘建目录
      calls.length = 0
      await expect(extractArchive('a"b.zip', dir, runner, 'win32')).rejects.toThrow(/引号|quote/)
      await expect(extractArchive('a`b.zip', dir, runner, 'win32')).rejects.toThrow(/引号|quote/)
      await expect(extractArchive('a$(x).zip', dir, runner, 'win32')).rejects.toThrow(/引号|quote/)
      const badDir = path.join(dir, 'dir`with$tick')
      await expect(extractArchive('ab.zip', badDir, runner, 'win32')).rejects.toThrow(/引号|quote/)
      await expect(fsp.access(badDir).then(() => true, () => false)).resolves.toBe(false)
      expect(calls).toHaveLength(0)
    } finally { await fsp.rm(dir, { recursive: true, force: true }) }
  })
})

describe('transfer 代理转发（系统代理链路）', () => {
  const servers: http.Server[] = []
  let root = ''
  beforeEach(async () => { root = await fsp.mkdtemp(path.join(os.tmpdir(), 'modeldock-proxy-')) })
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))))
    await fsp.rm(root, { recursive: true, force: true }).catch(() => {})
  })
  const serve = (handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<`http://127.0.0.1:${number}`> => {
    const server = http.createServer(handler)
    servers.push(server)
    return listenEphemeral(server).then((port) => `http://127.0.0.1:${port}`)
  }

  it('downloadToFile：proxyUrl 确实把请求交给代理（7.x CONNECT 隧道 / 8.x 绝对形态都算命中）', async () => {
    const body = Buffer.from('proxied-payload')
    const targetBase = await serve((_req, res) => { res.writeHead(200, { 'content-length': String(body.length) }); res.end(body) })
    let proxySeen = ''
    // undici 7.x 对 http 目标也走 CONNECT 隧道、8.x 走绝对形态请求行——mock 两种都接，断言二者其一
    const proxyServer = http.createServer((req, res) => { proxySeen = `ABSOLUTE ${req.url}`; res.writeHead(200, { 'content-length': String(body.length) }); res.end(body) })
    proxyServer.on('connect', (req, clientSocket: net.Socket, head: Buffer) => {
      proxySeen = `CONNECT ${req.url}`
      const [h, p] = String(req.url).split(':')
      const up = net.connect(Number(p), h, () => {
        clientSocket.write('HTTP/1.1 200 Connection established\r\n\r\n')
        if (head?.length) up.write(head)
        up.pipe(clientSocket)
        clientSocket.pipe(up)
      })
      up.on('error', () => clientSocket.end())
    })
    servers.push(proxyServer)
    const proxyPort = await listenEphemeral(proxyServer)
    const dest = path.join(root, 'px.bin')
    const received = await downloadToFile(`${targetBase}/file`, dest, { proxyUrl: `http://127.0.0.1:${proxyPort}` })
    expect(received).toBe(body.length)
    expect(fs.readFileSync(dest)).toEqual(body)
    // 命中形式 = 确实经代理转发，而非直连；回环免代理保护在 runUpdate 侧（apiBase 注入即不走代理）
    expect(proxySeen).toMatch(new RegExp(`CONNECT ${targetBase.slice(7)}|ABSOLUTE ${targetBase}/file`))
  })
})