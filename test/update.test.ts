import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  UpdateError,
  compareVersions,
  fetchChecksums,
  fetchLatestRelease,
  selectAssetName,
  verifyChecksum,
} from '../src/update/check.js'
import {
  appRootFromExecPath,
  buildWinInstallerCommand,
  detectInstallShape,
  installBareBinary,
  installMacApp,
} from '../src/update/install.js'
import { checkUpdate, runUpdate, type UpdateRunOptions } from '../src/update/run.js'
import { VERSION } from '../src/version.js'

// 本文件绝不触达真实网络与真实实例：GitHub API 用本地 http server 伪造，
// 停网关/停托盘/open/spawn 全部注入 mock（AGENTS 红线：单测禁跑 sweepGatewayProcesses 等）。

const TOKEN = 'ghp_test-token'
const REPO = 'owner/repo'

function sha256(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

interface MockRelease {
  tag: string
  /** 资产名 → 内容（Buffer/string）；SHA256SUMS 除外（由 makeSums 生成或测试自定） */
  assets: Record<string, Buffer>
  /** 额外原始响应覆盖（如 401） */
  status?: number
  /** manifest 里声明的 size 覆盖（默认真实长度；测不完整下载时改大） */
  sizeOverride?: Record<string, number>
  /** SHA256SUMS 名册内容（默认按 assets 真实哈希生成） */
  sums?: Buffer
  /** 发布正文（markdown）覆盖：默认一句简短说明 */
  body?: string
}

function makeSums(assets: Record<string, Buffer>): Buffer {
  return Buffer.from(
    Object.entries(assets)
      .filter(([n]) => n !== 'SHA256SUMS')
      .map(([n, b]) => `${sha256(b)}  ${n}`)
      .join('\n') + '\n'
  )
}

/** 本地伪造 GitHub API：releases/latest + assets/{id}（octet-stream）。返回基地址与请求路径记录。 */
async function startMockApi(release: MockRelease): Promise<{ apiBase: string; requests: string[]; close: () => Promise<void> }> {
  const requests: string[] = []
  const names = Object.keys(release.assets)
  const idOf = (n: string) => names.indexOf(n) + 1
  const server = http.createServer((req, res) => {
    requests.push(req.url ?? '')
    if (!req.headers.authorization || req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.writeHead(401).end()
      return
    }
    if (req.url === `/repos/${REPO}/releases/latest`) {
      if (release.status) {
        res.writeHead(release.status).end()
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          tag_name: release.tag,
          body: release.body ?? '**自动更新**：一条命令升级',
          html_url: `https://github.com/${REPO}/releases/tag/${release.tag}`,
          assets: names.map((n) => ({
            name: n,
            id: idOf(n),
            size: release.sizeOverride?.[n] ?? release.assets[n].length,
          })),
        })
      )
      return
    }
    const m = req.url?.match(/^\/repos\/[^/]+\/[^/]+\/releases\/assets\/(\d+)$/)
    if (m) {
      const name = names[Number(m[1]) - 1]
      if (name) {
        const body = name === 'SHA256SUMS' && release.sums ? release.sums : release.assets[name]
        res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(body)
        return
      }
    }
    res.writeHead(404).end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no port')
  return {
    apiBase: `http://127.0.0.1:${addr.port}`,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}

/** 打一个平台相关的裸二进制更新包（unix=tar.gz 含 modeldock；win=zip 含 modeldock.exe） */
function makeBareArchive(dir: string, version: string): { name: string; buf: Buffer } {
  const staging = path.join(dir, 'pkg')
  fs.mkdirSync(staging, { recursive: true })
  if (process.platform === 'win32') {
    const name = `modeldock-${version}-win32-x64.zip`
    const entry = path.join(staging, 'modeldock.exe')
    fs.writeFileSync(entry, 'NEW-BIN')
    const archive = path.join(dir, name)
    const r = spawnSync('powershell', ['-NoProfile', '-Command', `Compress-Archive -Path '${entry}' -DestinationPath '${archive}' -Force; if (!$?) { exit 1 }`], { stdio: 'ignore' })
    if (r.status !== 0) throw new Error('Compress-Archive failed')
    return { name, buf: fs.readFileSync(archive) }
  }
  const plat = process.platform === 'darwin' ? 'darwin' : 'linux'
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  const name = `modeldock-${version}-${plat}-${arch}.tar.gz`
  const entry = path.join(staging, 'modeldock')
  fs.writeFileSync(entry, 'NEW-BIN')
  const archive = path.join(dir, name)
  const r = spawnSync('tar', ['czf', archive, '-C', staging, 'modeldock'])
  if (r.status !== 0) throw new Error('tar failed')
  return { name, buf: fs.readFileSync(archive) }
}

/** mac-app 整包（tar.gz 内顶层 ModelDock.app/Contents/MacOS/ModelDock） */
function makeAppArchive(dir: string, version: string): { name: string; buf: Buffer } {
  const staging = path.join(dir, 'pkg')
  const binDir = path.join(staging, 'ModelDock.app', 'Contents', 'MacOS')
  fs.mkdirSync(binDir, { recursive: true })
  fs.writeFileSync(path.join(binDir, 'ModelDock'), 'NEW-APP-BIN')
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  const name = `modeldock-${version}-darwin-${arch}-app.tar.gz`
  const archive = path.join(dir, name)
  const r = spawnSync('tar', ['czf', archive, '-C', staging, 'ModelDock.app'])
  if (r.status !== 0) throw new Error('tar failed')
  return { name, buf: fs.readFileSync(archive) }
}

function mockDeps() {
  const calls = { stopGateway: 0, stopTray: 0, openApp: [] as string[], detached: [] as { file: string; args: string[] }[], wasLive: false }
  const deps = {
    stopGateway: vi.fn(async () => { calls.stopGateway++ }),
    stopTray: vi.fn(async () => { calls.stopTray++ }),
    openApp: vi.fn((p: string) => { calls.openApp.push(p) }),
    spawnDetached: vi.fn((file: string, args: string[]) => { calls.detached.push({ file, args }) }),
    gatewayWasLive: vi.fn(async () => calls.wasLive),
  }
  return { deps, calls }
}

function runOpts(over: Partial<UpdateRunOptions>): UpdateRunOptions {
  return { repo: REPO, token: TOKEN, yes: true, confirm: async () => true, ...over }
}

// 纯函数

describe('版本比较与资产选择', () => {
  it('compareVersions：逐段数值比较，前导 v 已由调用方剥离', () => {
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0)
    expect(compareVersions('1.10.0', '1.9.9')).toBeGreaterThan(0)
    expect(compareVersions('0.3.0', '1.0.0')).toBeLessThan(0)
    expect(compareVersions('2.0.1', '2.0.0')).toBeGreaterThan(0)
  })

  it('selectAssetName：四种安装形态按发布物命名规则选包', () => {
    expect(selectAssetName('mac-app', 'darwin', 'arm64', '1.2.3')).toBe('modeldock-1.2.3-darwin-arm64-app.tar.gz')
    expect(selectAssetName('bare', 'darwin', 'x64', '1.2.3')).toBe('modeldock-1.2.3-darwin-x64.tar.gz')
    expect(selectAssetName('bare', 'linux', 'arm64', '1.2.3')).toBe('modeldock-1.2.3-linux-arm64.tar.gz')
    expect(selectAssetName('win-setup', 'win32', 'x64', '1.2.3')).toBe('modeldock-1.2.3-win32-x64-setup.exe')
    expect(selectAssetName('win-bare', 'win32', 'x64', '1.2.3')).toBe('modeldock-1.2.3-win32-x64.zip')
  })

  it('detectInstallShape：.app 形态/裸二进制/win 安装器目录（路径分隔符双兼容）', () => {
    expect(detectInstallShape('/Applications/ModelDock.app/Contents/MacOS/ModelDock', 'darwin')).toBe('mac-app')
    expect(detectInstallShape('/usr/local/bin/modeldock', 'darwin')).toBe('bare')
    expect(
      detectInstallShape('C:\\Users\\u\\AppData\\Local\\Programs\\ModelDock\\modeldock.exe', 'win32', 'C:\\Users\\u\\AppData\\Local')
    ).toBe('win-setup')
    expect(detectInstallShape('D:\\tools\\modeldock.exe', 'win32', 'C:\\Users\\u\\AppData\\Local')).toBe('win-bare')
    expect(detectInstallShape('/usr/local/bin/modeldock', 'linux')).toBe('bare')
  })

  it('appRootFromExecPath：从 execPath 上溯 .app 根', () => {
    expect(appRootFromExecPath('/Applications/ModelDock.app/Contents/MacOS/ModelDock')).toBe('/Applications/ModelDock.app')
    expect(appRootFromExecPath('/usr/local/bin/modeldock')).toBeNull()
  })

  it('buildWinInstallerCommand：静默参数齐全；有托盘时串联拉起，无托盘时只装', () => {
    const withTray = buildWinInstallerCommand('C:\\tmp\\setup.exe', 'C:\\Programs\\ModelDock\\ModelDockTray.exe')
    expect(withTray.file).toBe('cmd.exe')
    const joined = withTray.args.join(' ')
    expect(joined).toContain('/VERYSILENT')
    expect(joined).toContain('/NORESTART')
    expect(joined).toContain('setup.exe')
    expect(joined).toContain('ModelDockTray.exe')
    const noTray = buildWinInstallerCommand('C:\\tmp\\setup.exe', null)
    expect(noTray.args.join(' ')).not.toContain('start')
  })
})

// GitHub API 发现与校验

describe('fetchLatestRelease / SHA256 校验（本地 mock API）', () => {
  let cleanup: (() => Promise<void>) | null = null
  afterEach(async () => {
    await cleanup?.()
    cleanup = null
  })

  it('拉取最新发布并派生 manifest：版本剥 v、资产带 id、鉴权头为 Bearer', async () => {
    const buf = Buffer.from('pkg-bytes')
    const api = await startMockApi({ tag: 'v9.9.9', assets: { 'modeldock-9.9.9-darwin-arm64-app.tar.gz': buf } })
    cleanup = api.close
    const m = await fetchLatestRelease(REPO, TOKEN, api.apiBase)
    expect(m.version).toBe('9.9.9')
    expect(m.tagName).toBe('v9.9.9')
    expect(m.assets).toHaveLength(1)
    expect(m.assets[0].id).toBe(1)
    expect(m.notes).toContain('自动更新')
    expect(api.requests.some((u) => u.endsWith('/releases/latest'))).toBe(true)
  })

  it('401 → 报可操作错误（指引 --token 重配）', async () => {
    const api = await startMockApi({ tag: 'v9.9.9', assets: {}, status: 401 })
    cleanup = api.close
    await expect(fetchLatestRelease(REPO, 'wrong-token', api.apiBase)).rejects.toThrow(UpdateError)
    // 401 分支在 Authorization 缺失/不符时由 mock 直接给出；带错误 token 同样 401
    await expect(fetchLatestRelease(REPO, TOKEN, api.apiBase)).rejects.toThrow(/--token/)
  })

  it('SHA256SUMS 解析 + 强校验：相符放行、不符删除并拒装', async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'modeldock-verify-'))
    try {
      const good = path.join(tmp, 'good.pkg')
      await fsp.writeFile(good, 'payload-v2')
      const sums = { 'good.pkg': sha256(Buffer.from('payload-v2')), 'bad.pkg': sha256(Buffer.from('expected-something-else')) }
      await verifyChecksum(good, sums) // 相符：不抛

      const bad = path.join(tmp, 'bad.pkg')
      await fsp.writeFile(bad, 'payload-tampered')
      await expect(verifyChecksum(bad, sums)).rejects.toThrow(UpdateError)
      expect(fs.existsSync(bad)).toBe(false) // 校验失败即删除下载物

      const unknown = path.join(tmp, 'unknown.pkg')
      await fsp.writeFile(unknown, 'zz')
      await expect(verifyChecksum(unknown, sums)).rejects.toThrow(/SHA256SUMS/)
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true })
    }
  })

  it('SUMS 名册缺失时拒绝安装（先校验后执行，绝无例外）', async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'modeldock-verify-'))
    try {
      const f = path.join(tmp, 'a.pkg')
      await fsp.writeFile(f, 'x')
      await expect(verifyChecksum(f, null)).rejects.toThrow(UpdateError)
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true })
    }
  })

  it('fetchChecksums：从 mock API 拉取并解析名册', async () => {
    const asset = Buffer.from('asset-bytes')
    const sums = makeSums({ 'modeldock-9.9.9.tar.gz': asset })
    const api = await startMockApi({ tag: 'v9.9.9', assets: { 'modeldock-9.9.9.tar.gz': asset, SHA256SUMS: sums } })
    cleanup = api.close
    const m = await fetchLatestRelease(REPO, TOKEN, api.apiBase)
    const map = await fetchChecksums(REPO, TOKEN, m, { apiBase: api.apiBase, retryDelayMs: 1 })
    expect(map).not.toBeNull()
    expect(map!['modeldock-9.9.9.tar.gz']).toBe(sha256(asset))
  })
})

// 检查输出（托盘原生弹窗的正文来源）

describe('checkUpdate 输出：说明降级 + 摘要收口 + 发布页链接', () => {
  let cleanup: (() => Promise<void>) | null = null
  afterEach(async () => {
    await cleanup?.()
    cleanup = null
  })

  const BODY = [
    '一个「测试版」的版本：三件小事。',
    '',
    '### 新增',
    '',
    '- **第一条点题**：这条很长，长到原生弹窗一行放不下，细节应当只留在发布页，不往弹窗里塞。',
    '- **第二条点题**：细节。',
    '',
    '### 改进',
    '',
    '- **第三条点题**：细节。',
    '- **第四条点题**：细节。',
    '',
    '### 修复',
    '',
    '- **第五条点题**：细节。',
    '- **第六条点题**：细节。',
  ].join('\n')

  it('输出首段 + 至多 4 条点题 + 总数 + 发布页地址；markdown 标记与「截 12 行」都不再出现', async () => {
    const api = await startMockApi({ tag: 'v999.0.0', assets: {}, body: BODY })
    cleanup = api.close
    const lines: string[] = []
    await checkUpdate(REPO, TOKEN, { apiBase: api.apiBase, log: (m) => lines.push(m) })
    const out = lines.join('\n')

    expect(out).toContain('有新版本：v999.0.0')
    expect(out).toContain('一个「测试版」的版本：三件小事。')
    // 点题逐条一行（点题后的长细节不进弹窗）
    expect(out).toContain('· 第一条点题\n· 第二条点题\n· 第三条点题\n· 第四条点题')
    expect(out).not.toContain('第一条点题：这条很长')
    expect(out).toContain('共 6 项改动')
    // 链接单独成行：托盘按 http(s) 正则取出，加「打开发布页」按钮
    expect(out).toContain(`完整说明：https://github.com/${REPO}/releases/tag/v999.0.0`)
    expect(out).toContain('执行 modeldock update 安装')
    // markdown 标记一个都不许漏进弹窗
    expect(out).not.toContain('**')
    expect(out).not.toContain('###')
  })

  it('说明为空：只输出版本行与发布页地址，不留空说明块', async () => {
    const api = await startMockApi({ tag: 'v999.0.0', assets: {}, body: '' })
    cleanup = api.close
    const lines: string[] = []
    await checkUpdate(REPO, TOKEN, { apiBase: api.apiBase, log: (m) => lines.push(m) })
    const out = lines.join('\n')
    expect(out).toContain('有新版本：v999.0.0')
    expect(out).toContain('完整说明：https://github.com/')
    expect(out).not.toContain('共 0 项')
    expect(out).not.toContain('·')
  })
})

// 安装原语（真实文件系统，临时目录）
describe('安装原语', () => {
  let tmp = ''
  beforeEach(async () => {
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'modeldock-inst-'))
  })
  afterEach(async () => {
    await fsp.rm(tmp, { recursive: true, force: true })
  })

  it('installMacApp：旧 .app 让位为 .old、新包落位；已存在的 .old 先清掉', async () => {
    const appRoot = path.join(tmp, 'Applications', 'ModelDock.app')
    fs.mkdirSync(path.join(appRoot, 'Contents', 'MacOS'), { recursive: true })
    fs.writeFileSync(path.join(appRoot, 'Contents', 'MacOS', 'ModelDock'), 'OLD')
    // 上一版残留
    fs.mkdirSync(appRoot + '.old', { recursive: true })

    const staging = path.join(tmp, 'staging')
    fs.mkdirSync(path.join(staging, 'ModelDock.app', 'Contents', 'MacOS'), { recursive: true })
    fs.writeFileSync(path.join(staging, 'ModelDock.app', 'Contents', 'MacOS', 'ModelDock'), 'NEW')

    await installMacApp(staging, appRoot)

    expect(fs.readFileSync(path.join(appRoot, 'Contents', 'MacOS', 'ModelDock'), 'utf8')).toBe('NEW')
    expect(fs.readFileSync(path.join(appRoot + '.old', 'Contents', 'MacOS', 'ModelDock'), 'utf8')).toBe('OLD')
  })

  it('installMacApp：包里没有 ModelDock.app 时中止且不动旧包', async () => {
    const appRoot = path.join(tmp, 'Applications', 'ModelDock.app')
    fs.mkdirSync(path.join(appRoot, 'Contents', 'MacOS'), { recursive: true })
    fs.writeFileSync(path.join(appRoot, 'Contents', 'MacOS', 'ModelDock'), 'OLD')
    const staging = path.join(tmp, 'staging')
    fs.mkdirSync(staging, { recursive: true })
    await expect(installMacApp(staging, appRoot)).rejects.toThrow(UpdateError)
    expect(fs.readFileSync(path.join(appRoot, 'Contents', 'MacOS', 'ModelDock'), 'utf8')).toBe('OLD')
  })

  it('installBareBinary：rename dance 换新留旧（Windows 允许改名运行中 exe，同一路径可测）', async () => {
    const target = path.join(tmp, 'bin', 'modeldock')
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, 'OLD-BIN')
    const newBin = path.join(tmp, 'modeldock-new')
    fs.writeFileSync(newBin, 'NEW-BIN')

    await installBareBinary(newBin, target)

    expect(fs.readFileSync(target, 'utf8')).toBe('NEW-BIN')
    expect(fs.readFileSync(target + '.old', 'utf8')).toBe('OLD-BIN')
    expect(fs.existsSync(target + '.new')).toBe(false)
  })
})

// 全链路编排

describe('runUpdate 全链路（mock API + 副作用注入）', () => {
  let cleanup: (() => Promise<void>) | null = null
  afterEach(async () => {
    await cleanup?.()
    cleanup = null
  })

  it('已是最新：直接返回不下载、不停实例', async () => {
    const api = await startMockApi({ tag: `v${VERSION}`, assets: {} })
    cleanup = api.close
    const { deps, calls } = mockDeps()
    // 不传 execPath 会用 process.execPath（vitest 下就是 node），被开发态守卫拦下——给一个正式安装形态
    const r = await runUpdate(runOpts({ apiBase: api.apiBase, deps, execPath: '/usr/local/bin/modeldock' }))
    expect(r.updated).toBe(false)
    expect(r.latestVersion).toBe(VERSION)
    expect(calls.stopGateway).toBe(0)
    expect(api.requests.every((u) => u.endsWith('/releases/latest'))).toBe(true)
  })

  // mac-app 交换流程依赖 darwin 形态检测与 .app 布局：仅 macOS 执行（其他平台 selectAssetName 不会选 darwin 包）
  it.skipIf(process.platform !== 'darwin')('mac-app 形态全链路：下载→校验→停→整包交换→open 拉起；旧包留 .old', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'modeldock-e2e-'))
    try {
      const execPath = path.join(root, 'Applications', 'ModelDock.app', 'Contents', 'MacOS', 'ModelDock')
      fs.mkdirSync(path.dirname(execPath), { recursive: true })
      fs.writeFileSync(execPath, 'OLD-APP-BIN')

      const pkg = makeAppArchive(root, '999.0.0')
      const api = await startMockApi({ tag: 'v999.0.0', assets: { [pkg.name]: pkg.buf, SHA256SUMS: makeSums({ [pkg.name]: pkg.buf }) } })
      cleanup = api.close
      const { deps, calls } = mockDeps()

      const r = await runUpdate(runOpts({ apiBase: api.apiBase, deps, execPath }))
      expect(r.updated).toBe(true)
      expect(r.latestVersion).toBe('999.0.0')

      expect(calls.stopGateway).toBe(1)
      expect(calls.stopTray).toBe(1)
      // 新包已在位、旧包保留回滚（appRoot = execPath 上溯三级：MacOS → Contents → ModelDock.app）
      const appRoot = path.dirname(path.dirname(path.dirname(execPath)))
      expect(fs.readFileSync(path.join(execPath), 'utf8')).toBe('NEW-APP-BIN')
      expect(fs.readFileSync(path.join(appRoot + '.old', 'Contents', 'MacOS', 'ModelDock'), 'utf8')).toBe('OLD-APP-BIN')
      // open 拉起新 .app
      expect(calls.openApp).toEqual([appRoot])
    } finally {
      await fsp.rm(root, { recursive: true, force: true })
    }
  })

  it('裸二进制形态全链路：换新留旧，网关原来在跑则用新二进制拉回', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'modeldock-e2e-'))
    try {
      const binDir = path.join(root, 'bin')
      fs.mkdirSync(binDir, { recursive: true })
      const exeName = process.platform === 'win32' ? 'modeldock.exe' : 'modeldock'
      const execPath = path.join(binDir, exeName)
      fs.writeFileSync(execPath, 'OLD-BIN')

      const pkg = makeBareArchive(root, '999.0.0')
      const api = await startMockApi({ tag: 'v999.0.0', assets: { [pkg.name]: pkg.buf, SHA256SUMS: makeSums({ [pkg.name]: pkg.buf }) } })
      cleanup = api.close
      const { deps, calls } = mockDeps()
      calls.wasLive = true

      const r = await runUpdate(runOpts({ apiBase: api.apiBase, deps, execPath }))
      expect(r.updated).toBe(true)
      expect(calls.stopGateway).toBe(1)
      expect(fs.readFileSync(execPath, 'utf8')).toBe('NEW-BIN')
      expect(fs.readFileSync(execPath + '.old', 'utf8')).toBe('OLD-BIN')
      // 拉回用的是新二进制 + SEA 守护入口参数
      expect(calls.detached).toEqual([{ file: execPath, args: ['--sea-gateway'] }])
    } finally {
      await fsp.rm(root, { recursive: true, force: true })
    }
  })

  it('校验失败：拒装、实例未停、安装位置原样（先校验后停机的顺序契约）', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'modeldock-e2e-'))
    try {
      const binDir = path.join(root, 'bin')
      fs.mkdirSync(binDir, { recursive: true })
      const exeName = process.platform === 'win32' ? 'modeldock.exe' : 'modeldock'
      const execPath = path.join(binDir, exeName)
      fs.writeFileSync(execPath, 'OLD-BIN')

      const pkg = makeBareArchive(root, '999.0.0')
      const wrongSums = Buffer.from(`${sha256(Buffer.from('not-the-payload'))}  ${pkg.name}\n`)
      const api = await startMockApi({ tag: 'v999.0.0', assets: { [pkg.name]: pkg.buf }, sums: wrongSums })
      cleanup = api.close
      const { deps, calls } = mockDeps()

      await expect(runUpdate(runOpts({ apiBase: api.apiBase, deps, execPath, retryDelayMs: 1 }))).rejects.toThrow(UpdateError)
      expect(calls.stopGateway).toBe(0) // 校验失败绝不停机
      expect(fs.readFileSync(execPath, 'utf8')).toBe('OLD-BIN')
      expect(fs.existsSync(execPath + '.old')).toBe(false)
    } finally {
      await fsp.rm(root, { recursive: true, force: true })
    }
  })

  it('开发态保护：execPath 是 node 运行时（tsx 直跑）时拒绝自更新，且不发任何网络请求', async () => {
    const api = await startMockApi({ tag: 'v999.0.0', assets: {} })
    cleanup = api.close
    const { deps } = mockDeps()
    const nodeExecPath = path.join(os.tmpdir(), 'never-exists', 'node')
    await expect(
      runUpdate(runOpts({ apiBase: api.apiBase, deps, execPath: nodeExecPath }))
    ).rejects.toThrow(/开发态|tsx|source/)
    expect(api.requests).toHaveLength(0) // 守卫在下载前：一个请求都不该发出
  })

  it('发布里没有本机适配的包：报错并列出可用资产，不做任何替换', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'modeldock-e2e-'))
    try {
      // 裸二进制形态（三平台同构）：win=modeldock.exe，其余=modeldock
      const binDir = path.join(root, 'bin')
      fs.mkdirSync(binDir, { recursive: true })
      const exeName = process.platform === 'win32' ? 'modeldock.exe' : 'modeldock'
      const execPath = path.join(binDir, exeName)
      fs.writeFileSync(execPath, 'OLD-BIN')

      // 放一个「非本机平台」的包：linux 用 darwin 包，其余平台用 linux 包
      const otherName = process.platform === 'linux' ? 'modeldock-999.0.0-darwin-arm64-app.tar.gz' : 'modeldock-999.0.0-linux-x64.tar.gz'
      const other = Buffer.from('other-platform-pkg')
      const api = await startMockApi({ tag: 'v999.0.0', assets: { [otherName]: other } })
      cleanup = api.close
      const { deps, calls } = mockDeps()

      await expect(runUpdate(runOpts({ apiBase: api.apiBase, deps, execPath }))).rejects.toThrow(otherName)
      expect(calls.stopGateway).toBe(0)
      expect(fs.readFileSync(execPath, 'utf8')).toBe('OLD-BIN')
    } finally {
      await fsp.rm(root, { recursive: true, force: true })
    }
  })

  it('下载不完整（size 声明大于实际）：重试耗尽后报错', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'modeldock-e2e-'))
    try {
      // 裸二进制形态：资产名与包体按当前平台生成
      const pkg = makeBareArchive(root, '999.0.0')
      const api = await startMockApi({
        tag: 'v999.0.0',
        assets: { [pkg.name]: pkg.buf, SHA256SUMS: makeSums({ [pkg.name]: pkg.buf }) },
        sizeOverride: { [pkg.name]: pkg.buf.length + 100 },
      })
      cleanup = api.close
      const { deps } = mockDeps()
      const exeName = process.platform === 'win32' ? 'modeldock.exe' : 'modeldock'
      const execPath = path.join(root, 'bin', exeName)
      await expect(
        runUpdate(runOpts({ apiBase: api.apiBase, deps, execPath, retryDelayMs: 1 }))
      ).rejects.toThrow(/不完整|incomplete/)
    } finally {
      await fsp.rm(root, { recursive: true, force: true })
    }
  })
})
