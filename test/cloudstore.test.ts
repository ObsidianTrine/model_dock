/**
 * 测试盲区 2（docs/known-issues.md §六尾注）：CloudStore（src/cloud/store.ts + server.ts）专属用例。
 *
 * 补 cloudserver.test.ts（HTTP 状态码层）之下/之外的缺口：
 *  - store 层直调：doc 单行 LWW 覆盖语义（此前只经 HTTP 间接覆盖）；
 *  - token 只存 sha256（known-issues「已核查无问题」项首次钉回归）：配对后库行只含哈希，
 *    cloud.db 全部文件（db/wal/shm）原始字节里扫不到明文 token；
 *  - 重新配对轮换设备凭据 + desired 清零（upsertDevice ON CONFLICT 语义，安全属性此前无网）；
 *  - putDoc 畸形 ts 拒收 / 422 回滚的 **store 行完整性**（cloudserver 只断言了状态码）；
 *  - 登录/配对等畸形 JSON 不 500：补 /v1/pair、heartbeat、desire、PUT /v1/doc 畸形体矩阵
 *    （cloudserver 已覆盖 /v1/login '{oops' 与畸形 cookie，此处不重复）。
 *    已知残留（发现于本任务，报告单列，不夹带修复）：请求体为 JSON 字面量 null 时
 *    parseBody 解析成功返回 null，b.token/b.pairCode 属性访问抛 TypeError → 500，
 *    login/pair/heartbeat/desire/PUT doc 五处同型；本文只钉当前已安全的形态。
 *  - 配对码 CSPRNG（REVIEW-27）：行为面（格式/唯一性/字母表覆盖）+ 源码契约
 *    （randomInt 而非 Math.random，复用 cloud-structure.test.ts 的源文本断言先例）。
 *
 * 红线遵守：零 vi.mock；listen(0) 随机端口；数据目录 os.tmpdir()+path.join，afterAll 清理。
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { CloudStore } from '../src/cloud/store.js'
import { createCloudServer, generatePairCode } from '../src/cloud/server.js'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const dirs: string[] = []
afterAll(async () => {
  for (const d of dirs) await fsp.rm(d, { recursive: true, force: true }).catch(() => {})
})

function tmpDataDir(): string {
  // os.tmpdir()：Windows 上写死 '/tmp' 会被 path.join 归一成无盘符的 '\tmp'（CI 实测 ENOENT）
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'md-cloudstore-'))
  dirs.push(d)
  return d
}

interface Server {
  port: number
  store: CloudStore
  dataDir: string
  consoleToken: string
  close: () => Promise<void>
}

async function startServer(): Promise<Server> {
  const dataDir = tmpDataDir()
  const store = new CloudStore(dataDir)
  const consoleToken = 'mdkcloud_' + 'a'.repeat(32)
  const server = createCloudServer(store, { consoleToken, rateLimitPerMin: 10_000 })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const addr = server.address() as net.AddressInfo
  return {
    port: addr.port,
    store,
    dataDir,
    consoleToken,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve())
        store.close()
      }),
  }
}

async function req(
  port: number,
  method: string,
  p: string,
  o?: { token?: string; rawBody?: string; body?: unknown; headers?: Record<string, string> }
): Promise<{ status: number; json: any; text: string }> {
  const headers: Record<string, string> = { ...(o?.headers ?? {}) }
  if (o?.token) headers.authorization = `Bearer ${o.token}`
  let body: string | undefined
  if (o?.rawBody !== undefined) {
    body = o.rawBody
    headers['content-type'] = 'application/json'
  } else if (o?.body !== undefined) {
    body = JSON.stringify(o.body)
    headers['content-type'] = 'application/json'
  }
  const res = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers, body })
  const text = await res.text()
  let json: any = null
  try {
    json = JSON.parse(text)
  } catch {
    /* 304 等无 body */
  }
  return { status: res.status, json, text }
}

const ENVELOPE = (ts: string): string => JSON.stringify({ fmt: 'modeldock-syncenv', v: 1, ts })

async function pairDevice(port: number, consoleToken: string, devid: string): Promise<string> {
  const pc = await req(port, 'POST', '/v1/paircode', { token: consoleToken, body: {} })
  expect(pc.status).toBe(200)
  const pair = await req(port, 'POST', '/v1/pair', { body: { pairCode: pc.json.pairCode, devid, deviceName: 't' } })
  expect(pair.status).toBe(200)
  return pair.json.deviceToken as string
}

describe('CloudStore 直调（store 层语义）', () => {
  it('doc 单行 LWW：putDoc 覆盖不追加，getDoc 恒返回最新一行', () => {
    const store = new CloudStore(tmpDataDir())
    try {
      expect(store.getDoc()).toBeNull()
      store.putDoc(1, ENVELOPE('2026-10-05T01:00:00.000Z'), '2026-10-05T01:00:00.000Z', 'mdksync_a')
      expect(store.getDoc()).toEqual({ rev: 1, envelope: ENVELOPE('2026-10-05T01:00:00.000Z'), ts: '2026-10-05T01:00:00.000Z', by_devid: 'mdksync_a' })
      store.putDoc(2, ENVELOPE('2026-10-05T02:00:00.000Z'), '2026-10-05T02:00:00.000Z', 'mdksync_b')
      const doc = store.getDoc()
      expect(doc?.rev).toBe(2)
      expect(doc?.by_devid).toBe('mdksync_b')
      // 单行表（id=1 唯一）：旧行不残留
      expect(store.listDevices()).toEqual([])
    } finally {
      store.close()
    }
  })
})

describe('设备 token 只存 sha256（盲区 2）', () => {
  it('配对后：库行是 sha256(token)，明文 token 在 cloud.db 全部文件的原始字节里不存在', async () => {
    const s = await startServer()
    try {
      const token = await pairDevice(s.port, s.consoleToken, 'mdksync_hash')
      const tokenHash = createHash('sha256').update(token).digest('hex')
      // 库行只含哈希
      const row = s.store.device('mdksync_hash')
      expect(row).toBeTruthy()
      expect(row!.token_hash).toBe(tokenHash)
      expect(row!.token_hash).not.toContain('mdkdev')
      // 按哈希可反查设备；把明文 token 当哈希查不到
      expect(s.store.deviceByTokenHash(tokenHash)?.devid).toBe('mdksync_hash')
      expect(s.store.deviceByTokenHash(token)).toBeNull()
      // 落盘字节扫描：db/wal/shm 任一文件都不得出现明文 token；哈希必须已在盘上
      const files = (await fsp.readdir(s.dataDir)).filter((f) => f.startsWith('cloud.db'))
      expect(files.length).toBeGreaterThan(0)
      let sawHash = false
      for (const f of files) {
        const buf = await fsp.readFile(path.join(s.dataDir, f))
        expect(buf.includes(Buffer.from(token, 'utf8')), `${f} 不得含明文 token`).toBe(false)
        if (buf.includes(Buffer.from(tokenHash, 'utf8'))) sawHash = true
      }
      expect(sawHash, `token 哈希应落在 ${files.join(',')}`).toBe(true)
    } finally {
      await s.close()
    }
  })

  it('重新配对：旧 token 即刻失效、新 token 可用，desired 随重配对清零', async () => {
    const s = await startServer()
    try {
      const tok1 = await pairDevice(s.port, s.consoleToken, 'mdksync_rot')
      // 心跳上报 + 控制台下发 desired
      expect((await req(s.port, 'POST', '/v1/heartbeat', { token: tok1, body: { devid: 'mdksync_rot', reportedProfile: 'ark' } })).status).toBe(200)
      expect((await req(s.port, 'POST', '/v1/desire', { token: s.consoleToken, body: { devid: 'mdksync_rot', service: 'deepseek' } })).json.updated).toBe(1)
      expect(s.store.device('mdksync_rot')?.desired_profile).toBe('deepseek')

      const tok2 = await pairDevice(s.port, s.consoleToken, 'mdksync_rot')
      // 旧凭据即刻失效
      expect((await req(s.port, 'GET', '/v1/doc', { token: tok1 })).status).toBe(401)
      // 新凭据可用（云端无文档 → 404 no_doc，说明鉴权已过）
      const fresh = await req(s.port, 'GET', '/v1/doc', { token: tok2 })
      expect(fresh.status).toBe(404)
      expect(fresh.json.error.code).toBe('no_doc')
      // 重配对清 desired（防「换机后旧切换指令误下发」）
      expect(s.store.device('mdksync_rot')?.desired_profile).toBeNull()
      expect(s.store.device('mdksync_rot')?.desired_ts).toBeNull()
    } finally {
      await s.close()
    }
  })
})

describe('putDoc 回滚的 store 行完整性（REVIEW-27 钉死）', () => {
  it('畸形 ts / 缺 ts 400、旧 ts 422：被拒路径 store 行四字段逐项不变', async () => {
    const s = await startServer()
    try {
      const tok = await pairDevice(s.port, s.consoleToken, 'mdksync_rb')
      const T1 = '2026-10-05T01:00:00.000Z'
      const put1 = await req(s.port, 'PUT', '/v1/doc', { token: tok, headers: { 'if-match': '0' }, body: { envelope: ENVELOPE(T1), ts: T1 } })
      expect(put1.status).toBe(200)
      const row1 = JSON.parse(JSON.stringify(s.store.getDoc())) as Record<string, unknown>

      // 畸形 ts：400，且 store 行不被触碰（NaN 打穿保护的前提是它能入库——入库即败）
      const bad = await req(s.port, 'PUT', '/v1/doc', { token: tok, headers: { 'if-match': '1' }, body: { envelope: ENVELOPE('not-a-date'), ts: 'not-a-date' } })
      expect(bad.status).toBe(400)
      expect(s.store.getDoc()).toEqual(row1)
      // 缺 ts 字段：400，行不变
      const noTs = await req(s.port, 'PUT', '/v1/doc', { token: tok, headers: { 'if-match': '1' }, body: { envelope: ENVELOPE('2026-10-05T02:00:00.000Z') } })
      expect(noTs.status).toBe(400)
      expect(s.store.getDoc()).toEqual(row1)
      // 旧 ts 回滚：422，行不变（rev/envelope/ts/by_devid 四字段逐项钉死）
      const T0 = '2026-10-04T00:00:00.000Z'
      const rollback = await req(s.port, 'PUT', '/v1/doc', { token: tok, headers: { 'if-match': '1' }, body: { envelope: ENVELOPE(T0), ts: T0 } })
      expect(rollback.status).toBe(422)
      expect(rollback.json.error.code).toBe('rollback_rejected')
      expect(s.store.getDoc()).toEqual(row1)
      // 合法推进不受影响
      const T2 = '2026-10-05T02:00:00.000Z'
      const ok = await req(s.port, 'PUT', '/v1/doc', { token: tok, headers: { 'if-match': '1' }, body: { envelope: ENVELOPE(T2), ts: T2 } })
      expect(ok.status).toBe(200)
      expect(s.store.getDoc()?.rev).toBe(2)
      expect(s.store.getDoc()?.ts).toBe(T2)
    } finally {
      await s.close()
    }
  })
})

describe('畸形 JSON 请求体不 500（REVIEW-27 延伸覆盖）', () => {
  it('login/pair/heartbeat/desire/PUT doc 的非对象 JSON 均走 4xx 统一错误壳，绝不 500', async () => {
    const s = await startServer()
    try {
      const tok = await pairDevice(s.port, s.consoleToken, 'mdksync_mal')
      // 已知残留（报告单列，不在本套件断言）：body 为字面量 null 时 parseBody 返回 null，
      // b.token/b.pairCode 属性访问抛 TypeError → 500。此处只钉当前已安全的畸形形态。
      const bodies: Array<[string, string]> = [
        ['{oops', '截断 JSON'],
        ['[1,2]', '顶层数组'],
        ['123', '顶层数字'],
        ['"just-a-string"', '顶层字符串'],
      ]
      for (const [body, label] of bodies) {
        // 公共端点
        const login = await req(s.port, 'POST', '/v1/login', { rawBody: body })
        expect(login.status, `login ${label}`).toBe(401)
        expect(login.json.error.code, `login ${label}`).toBe('unauthorized')
        const pair = await req(s.port, 'POST', '/v1/pair', { rawBody: body })
        expect(pair.status, `pair ${label}`).toBe(400)
        expect(pair.json.error.code, `pair ${label}`).toBe('invalid')
        // 鉴权端点（各角色一个代表）
        const hb = await req(s.port, 'POST', '/v1/heartbeat', { token: tok, rawBody: body })
        expect(hb.status, `heartbeat ${label}`).toBe(403)
        expect(hb.json.error.code, `heartbeat ${label}`).toBe('forbidden')
        const desire = await req(s.port, 'POST', '/v1/desire', { token: s.consoleToken, rawBody: body })
        expect(desire.status, `desire ${label}`).toBe(400)
        expect(desire.json.error.code, `desire ${label}`).toBe('invalid')
        const put = await req(s.port, 'PUT', '/v1/doc', { token: tok, rawBody: body, headers: { 'if-match': '0' } })
        expect(put.status, `put doc ${label}`).toBe(400)
        expect(put.json.error.code, `put doc ${label}`).toBe('invalid')
      }
      // 服务端始终未写入任何设备/文档
      expect(s.store.listDevices()).toHaveLength(1)
      expect(s.store.getDoc()).toBeNull()
    } finally {
      await s.close()
    }
  })
})

describe('配对码 CSPRNG（REVIEW-27）', () => {
  it('行为面：格式排除易混字符、600 样本零碰撞、31 字符字母表全覆盖', () => {
    const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789' // 0/O/1/I/L 已剔除
    const codes = Array.from({ length: 600 }, () => generatePairCode())
    for (const c of codes) expect(c).toMatch(/^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/)
    // 唯一性（31^8 ≈ 8.5e11，600 样本生日碰撞概率 <2e-7）
    expect(new Set(codes).size).toBe(600)
    // 字母表全覆盖（每字符期望出现 ~155 次；缺任一字符说明编码空间被砍）
    const seen = codes.join('')
    for (const ch of ALPHABET) expect(seen).toContain(ch)
  })

  it('源码契约：generatePairCode 走 node:crypto 的 randomInt（CSPRNG），代码中无 Math.random 调用', () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'src', 'cloud', 'server.ts'), 'utf8')
    expect(src).toContain("import { createHash, randomInt } from 'node:crypto'")
    expect(src).toMatch(/const pick = \(\): string => alphabet\[randomInt\(alphabet\.length\)\]/)
    // 调用形态（ASCII 括号）判定，规避 head 注释里的「不用 Math.random（…」全角括号
    expect(src).not.toContain('Math.random(')
  })
})
