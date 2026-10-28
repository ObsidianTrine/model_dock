import { describe, expect, it } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import type { AddressInfo } from 'node:net'
import { fakeHome } from './helpers.js'
import {
  downloadFailureMessage,
  engineWarningHint,
  ensureNodeRuntime,
  installChildEnv,
  integrateManagedPath,
  managedNodeBinDir,
  managedNodeDir,
  nodeAssetName,
  nodeDownloadBases,
  nodeInnerDirName,
  nodeStageDirName,
  npmRegistry,
  nodeVersion,
  MANAGED_NODE_VERSION,
} from '../src/install/noderuntime.js'
import { commandOnPathResolved, fileSha256 } from '../src/util/fsx.js'
import { sandboxNpmCache, sandboxNpmPrefix } from '../src/util/paths.js'

function listenEphemeral(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port))
  })
}

/** 用本地 mock 镜像测下载/校验/解压/PATH 接入全链路；Windows 走 PowerShell 解压，另测 */
const describePosix = process.platform === 'win32' ? describe.skip : describe

/** 构造最小 Node 目录树并打成 node dist 同构 tar.gz：node-v<ver>-<plat>-<arch>/{bin/{node,npm},lib} */
function makeNodeTarball(dir: string, version: string): { tarball: string; asset: string } {
  const plat = process.platform
  const asset = `node-v${version}-${plat}-${process.arch}.tar.gz`
  const inner = path.join(dir, `node-v${version}-${plat}-${process.arch}`)
  fs.mkdirSync(path.join(inner, 'bin'), { recursive: true })
  fs.mkdirSync(path.join(inner, 'lib'), { recursive: true })
  for (const name of ['node', 'npm']) {
    const p = path.join(inner, 'bin', name)
    fs.writeFileSync(p, '#!/bin/sh\necho fixture-node\n')
    fs.chmodSync(p, 0o755)
  }
  const tarball = path.join(dir, asset)
  const r = spawnSync('tar', ['-czf', tarball, '-C', dir, `node-v${version}-${plat}-${process.arch}`])
  if (r.status !== 0) throw new Error(`fixture tar failed: ${r.stderr}`)
  return { tarball, asset }
}

describePosix('noderuntime 托管运行时（下载/校验/解压/PATH）', () => {
  it('系统无 node 时下载托管运行时：SHA256 通过、解压到位、PATH 写入 shell rc，二次调用走缓存', async () => {
    const h = fakeHome()
    const version = '0.0.0-test'
    const envs = ['MODELRDOCK_NODE_MIRROR', 'MODELRDOCK_NODE_VERSION', 'MODELRDOCK_NODE_FORCE_DOWNLOAD']
    const saved = envs.map((k) => process.env[k])
    let server: http.Server | null = null
    try {
      const { tarball, asset } = makeNodeTarball(fs.mkdtempSync(path.join(h.home, 'fixture-')), version)
      const sha = await fileSha256(tarball)
      let hits = 0
      server = http.createServer((req, res) => {
        hits++
        if (req.url === `/v${version}/SHASUMS256.txt`) {
          res.end(`${sha}  ${asset}\n`)
        } else if (req.url === `/v${version}/${asset}`) {
          res.end(fs.readFileSync(tarball))
        } else {
          res.statusCode = 404
          res.end('nope')
        }
      })
      const port = await listenEphemeral(server)
      process.env.MODELRDOCK_NODE_MIRROR = `http://127.0.0.1:${port}`
      process.env.MODELRDOCK_NODE_VERSION = version
      process.env.MODELRDOCK_NODE_FORCE_DOWNLOAD = '1'

      const lines: string[] = []
      const info = await ensureNodeRuntime((l) => lines.push(l))
      expect(info.source).toBe('download')
      expect(info.binDir).toBe(managedNodeBinDir())
      expect(fs.existsSync(path.join(managedNodeBinDir(), 'node'))).toBe(true)
      expect(lines.join('\n')).toContain('SHA256')

      // PATH 接入：fakeHome 下 .zshrc/.bashrc 都不存在 → 建 .zshrc 并含托管 bin 目录
      const rc = fs.readFileSync(path.join(h.home, '.zshrc'), 'utf8')
      expect(rc).toContain(managedNodeBinDir())
      expect(rc).toContain('ModelDock')

      // 二次调用命中托管缓存：不再发起下载（请求数不增）
      const before = hits
      const again = await ensureNodeRuntime()
      expect(again.source).toBe('managed')
      expect(hits).toBe(before)
    } finally {
      server?.close()
      envs.forEach((k, i) => {
        if (saved[i] === undefined) delete process.env[k]
        else process.env[k] = saved[i]!
      })
      h.restore()
    }
  })

  it('SHA256 不符：报错拒绝安装，不留半截目录', async () => {
    const h = fakeHome()
    const version = '0.0.0-test'
    const envs = ['MODELRDOCK_NODE_MIRROR', 'MODELRDOCK_NODE_VERSION', 'MODELRDOCK_NODE_FORCE_DOWNLOAD']
    const saved = envs.map((k) => process.env[k])
    let server: http.Server | null = null
    try {
      const { tarball, asset } = makeNodeTarball(fs.mkdtempSync(path.join(h.home, 'fixture-')), version)
      server = http.createServer((req, res) => {
        if (req.url === `/v${version}/SHASUMS256.txt`) {
          res.end(`${'0'.repeat(64)}  ${asset}\n`) // 故意给错校验值
        } else if (req.url === `/v${version}/${asset}`) {
          res.end(fs.readFileSync(tarball))
        } else {
          res.statusCode = 404
          res.end('nope')
        }
      })
      const port = await listenEphemeral(server)
      process.env.MODELRDOCK_NODE_MIRROR = `http://127.0.0.1:${port}`
      process.env.MODELRDOCK_NODE_VERSION = version
      process.env.MODELRDOCK_NODE_FORCE_DOWNLOAD = '1'

      await expect(ensureNodeRuntime()).rejects.toThrow(/SHA256|下载失败|Failed to download/)
      expect(fs.existsSync(managedNodeDir())).toBe(false)
      // stage 临时目录已清理
      const root = path.join(h.home, '.modeldock', 'runtime', 'node')
      expect(fs.readdirSync(root).filter((e) => e.startsWith('.stage-'))).toEqual([])
    } finally {
      server?.close()
      envs.forEach((k, i) => {
        if (saved[i] === undefined) delete process.env[k]
        else process.env[k] = saved[i]!
      })
      h.restore()
    }
  })

  it('PATH 接入幂等：重复调用只写一行；NO_PATH_EDIT=1 跳过', async () => {
    const h = fakeHome()
    try {
      const binDir = managedNodeBinDir()
      await integrateManagedPath(binDir)
      await integrateManagedPath(binDir)
      const rc = fs.readFileSync(path.join(h.home, '.zshrc'), 'utf8')
      expect(rc.split(binDir).length - 1).toBe(1)
      // 追加前没有结尾换行的文件也能正确拼接
      const bashrc = path.join(h.home, '.bashrc')
      fs.writeFileSync(bashrc, 'export FOO=1')
      await integrateManagedPath(binDir)
      const text = fs.readFileSync(bashrc, 'utf8')
      expect(text.startsWith('export FOO=1\n')).toBe(true)
      expect(text.split(binDir).length - 1).toBe(1)

      process.env.MODELRDOCK_NODE_NO_PATH_EDIT = '1'
      const other = path.join(h.home, '.modeldock', 'runtime', 'node', 'v9.9.9', 'bin')
      await integrateManagedPath(other)
      expect(fs.readFileSync(path.join(h.home, '.zshrc'), 'utf8')).not.toContain('v9.9.9')
      delete process.env.MODELRDOCK_NODE_NO_PATH_EDIT
    } finally {
      h.restore()
    }
  })
})

describe('noderuntime 纯函数', () => {
  it('资产命名：平台/架构映射与扩展名', () => {
    expect(nodeAssetName('24.21.0', 'darwin', 'arm64')).toBe('node-v24.21.0-darwin-arm64.tar.gz')
    expect(nodeAssetName('24.21.0', 'linux', 'x64')).toBe('node-v24.21.0-linux-x64.tar.gz')
    expect(nodeAssetName('24.21.0', 'win32', 'x64')).toBe('node-v24.21.0-win-x64.zip')
    expect(() => nodeAssetName('24.21.0', 'sunos', 'x64')).toThrow()
    expect(() => nodeAssetName('24.21.0', process.platform, 'ppc64' as never)).toThrow()
  })

  it('地区策略：zh 走国内镜像、en 走官方源、env 覆盖保留官方回落', () => {
    const saved = { M: process.env.MODELRDOCK_NODE_MIRROR, R: process.env.MODELRDOCK_NPM_REGISTRY }
    try {
      delete process.env.MODELRDOCK_NODE_MIRROR
      delete process.env.MODELRDOCK_NPM_REGISTRY
      expect(nodeDownloadBases('zh')).toEqual(['https://cdn.npmmirror.com/binaries/node'])
      expect(nodeDownloadBases('en')).toEqual(['https://nodejs.org/dist'])
      expect(npmRegistry('zh')).toBe('https://registry.npmmirror.com')
      expect(npmRegistry('en')).toBeUndefined()
      // 显式覆盖：用户接管源选择，保留官方源回落；registry 覆盖对两种语言生效
      process.env.MODELRDOCK_NODE_MIRROR = 'https://mirror.example/node/'
      process.env.MODELRDOCK_NPM_REGISTRY = 'https://registry.example'
      expect(nodeDownloadBases('zh')).toEqual(['https://mirror.example/node', 'https://nodejs.org/dist'])
      expect(nodeDownloadBases('en')).toEqual(['https://mirror.example/node', 'https://nodejs.org/dist'])
      expect(npmRegistry('zh')).toBe('https://registry.example')
      expect(npmRegistry('en')).toBe('https://registry.example')
      // 覆盖值与官方相同：去重不重复尝试
      process.env.MODELRDOCK_NODE_MIRROR = 'https://nodejs.org/dist'
      expect(nodeDownloadBases('en')).toEqual(['https://nodejs.org/dist'])
    } finally {
      if (saved.M === undefined) delete process.env.MODELRDOCK_NODE_MIRROR
      else process.env.MODELRDOCK_NODE_MIRROR = saved.M
      if (saved.R === undefined) delete process.env.MODELRDOCK_NPM_REGISTRY
      else process.env.MODELRDOCK_NPM_REGISTRY = saved.R
    }
  })

  it('下载失败文案：默认镜像失败提示 VPN，覆盖/官方源失败给通用建议', () => {
    const zhMirror = nodeDownloadBases('zh')[0]
    expect(downloadFailureMessage([zhMirror], 'timeout').message).toContain('VPN')
    expect(downloadFailureMessage(['https://nodejs.org/dist'], 'timeout').message).not.toContain('VPN')
    expect(downloadFailureMessage([zhMirror, 'https://nodejs.org/dist'], 'timeout').message).not.toContain('VPN')
  })

  it('engineWarningHint：识别 EBADENGINE、提取 required/current，无警告返回 null', () => {
    const block = (pkg: string) => [
      'npm warn EBADENGINE Unsupported engine {',
      `npm warn EBADENGINE   package: '${pkg}'`,
      "npm warn EBADENGINE   required: { node: '>=22.12.0' }",
      "npm warn EBADENGINE   current: { node: 'v24.21.0', npm: '10.9.4' }",
      'npm warn EBADENGINE }',
    ].join('\n')
    const hint = engineWarningHint(`added 3 packages in 2s\n${block('commander@15.1.0')}`)
    // 断言全用语言无关子串（env 变量名/版本号/警告标记），语言链 zh/en 都不影响
    expect(hint).toContain('>=22.12.0')
    expect(hint).toContain('v24.21.0')
    expect(hint).toContain('MODELRDOCK_NODE_VERSION')
    // 多包同下限去重，不重复点名
    const dup = engineWarningHint(block('commander@15.1.0') + '\n' + block('chalk@6.0.0'))
    expect(dup).toContain('>=22.12.0')
    expect(dup.split('>=22.12.0').length - 1).toBe(1)
    // 格式漂移兜底：有 EBADENGINE 无结构化行也提示，不让警告静默消失
    expect(engineWarningHint('npm warn EBADENGINE Unsupported engine')).toContain('EBADENGINE')
    expect(engineWarningHint('added 52 packages in 9s')).toBeNull()
  })

  it('版本覆盖：MODELRDOCK_NODE_VERSION 生效', () => {
    const saved = process.env.MODELRDOCK_NODE_VERSION
    try {
      process.env.MODELRDOCK_NODE_VERSION = 'v22.23.3'
      expect(nodeVersion()).toBe('22.23.3')
      expect(nodeAssetName()).toContain('node-v22.23.3-')
    } finally {
      if (saved === undefined) delete process.env.MODELRDOCK_NODE_VERSION
      else process.env.MODELRDOCK_NODE_VERSION = saved
    }
  })

  it('版本默认值与资产命名一致性', () => {
    expect(nodeVersion()).toBe(MANAGED_NODE_VERSION)
    expect(nodeAssetName()).toContain(`node-v${MANAGED_NODE_VERSION}-`)
  })

  it('暂存目录按资产名派生、inner 目录名单一来源（DESIGN-11 并发隔离）', () => {
    // 不同版本/架构资产 → 独立暂存目录，不再共享 .stage-<pid>（并发 ensureNodeRuntime 互不踩）
    const a = nodeStageDirName(nodeAssetName('24.21.0', 'darwin', 'arm64'))
    const b = nodeStageDirName(nodeAssetName('24.21.0', 'darwin', 'x64'))
    expect(a).not.toBe(b)
    expect(a).toContain('node-v24.21.0-darwin-arm64.tar.gz')
    expect(a.startsWith('.stage-')).toBe(true)
    // inner 目录名（node-v<ver>-<plat>-<arch>）与资产名同用平台归一，两者拼不出不一致
    expect(nodeInnerDirName('24.21.0', 'darwin', 'arm64')).toBe('node-v24.21.0-darwin-arm64')
    expect(nodeInnerDirName('24.21.0', 'win32', 'x64')).toBe('node-v24.21.0-win-x64')
    expect(nodeInnerDirName('24.21.0', 'linux', 'x64')).toBe('node-v24.21.0-linux-x64')
    // 平台归一一致：inner 段 = 资产名去掉扩展名的同名前缀（win32→win、其余原样）
    for (const pf of ['win32', 'darwin', 'linux']) {
      const [plat, arch] = pf === 'win32' ? ['win', 'x64'] : [pf, 'x64']
      expect(nodeInnerDirName('24.21.0', pf as never, 'x64')).toBe(`node-v24.21.0-${plat}-${arch}`)
    }
    expect(nodeInnerDirName().startsWith(`node-v${nodeVersion()}-`)).toBe(true)
  })
})

describe('installChildEnv（安装子进程环境装配）', () => {
  const envKeys = ['npm_config_prefix', 'npm_config_globalconfig', 'npm_execpath', 'npm_config_registry', 'MODELRDOCK_NPM_REGISTRY', 'KEEP_ME']

  it('剥离 npm_* 泄漏；zh 注入镜像 registry；沙箱下注入 prefix/cache；en 不注入', () => {
    const h = fakeHome()
    const saved = envKeys.map((k) => process.env[k])
    try {
      process.env.npm_config_prefix = '/leaked/prefix'
      process.env.npm_config_globalconfig = '/leaked/globalconfig'
      process.env.npm_execpath = '/leaked/npm'
      process.env.npm_config_registry = 'http://leaked-registry.example'
      delete process.env.MODELRDOCK_NPM_REGISTRY
      process.env.KEEP_ME = 'yes'

      const envZh = installChildEnv(process.env, 'zh')
      expect(envZh.npm_config_prefix).toBe(sandboxNpmPrefix()) // 受控重注入为沙箱落点，真机值绝不穿透
      expect(envZh.npm_config_cache).toBe(sandboxNpmCache())
      expect(envZh.npm_config_globalconfig).toBeUndefined() // 泄漏剥离
      expect(envZh.npm_execpath).toBeUndefined()
      expect(envZh.npm_config_registry).toBe('https://registry.npmmirror.com') // 地区策略重新注入
      expect(envZh.KEEP_ME).toBe('yes') // 非 npm_* 变量透传

      const envEn = installChildEnv(process.env, 'en')
      expect(envEn.npm_config_registry).toBeUndefined() // en 不注入，保留官方默认
      expect(envEn.npm_config_prefix).toBe(sandboxNpmPrefix())

      // 显式 registry 覆盖对两种语言生效
      process.env.MODELRDOCK_NPM_REGISTRY = 'https://reg.example'
      expect(installChildEnv(process.env, 'en').npm_config_registry).toBe('https://reg.example')
      expect(installChildEnv(process.env, 'zh').npm_config_registry).toBe('https://reg.example')
    } finally {
      envKeys.forEach((k, i) => {
        if (saved[i] === undefined) delete process.env[k]
        else process.env[k] = saved[i]!
      })
      h.restore()
    }
  })
})

describe('ensureNodeRuntime · path 短路', () => {
  // 前提 = 运行环境 PATH 有 node；被裁剪的极端环境跳过而不是误入托管下载（真实外网）
  it.skipIf(commandOnPathResolved('node') === null)('系统 node 可用：source=path，不触发托管下载', async () => {
    const h = fakeHome()
    const saved = process.env.MODELRDOCK_NODE_FORCE_DOWNLOAD
    delete process.env.MODELRDOCK_NODE_FORCE_DOWNLOAD
    try {
      const info = await ensureNodeRuntime()
      expect(info.source).toBe('path')
      expect(info.nodeBin).toContain('node')
      expect(info.binDir.length).toBeGreaterThan(0)
      // 不落任何托管运行时目录
      expect(fs.existsSync(managedNodeDir())).toBe(false)
    } finally {
      if (saved === undefined) delete process.env.MODELRDOCK_NODE_FORCE_DOWNLOAD
      else process.env.MODELRDOCK_NODE_FORCE_DOWNLOAD = saved
      h.restore()
    }
  })
})

/** 打定制 tarball：可去掉 bin/node 或改内层目录名（缺二进制 / 目录缺失两类归因分支） */
function makeCustomTarball(dir: string, version: string, opts: { omitNode?: boolean; innerDir?: string }): { tarball: string; asset: string } {
  const plat = process.platform
  const asset = `node-v${version}-${plat}-${process.arch}.tar.gz`
  const inner = path.join(dir, opts.innerDir ?? `node-v${version}-${plat}-${process.arch}`)
  fs.mkdirSync(path.join(inner, 'bin'), { recursive: true })
  fs.writeFileSync(path.join(inner, 'bin', 'npm'), '#!/bin/sh\necho fixture-npm\n')
  if (!opts.omitNode) {
    const p = path.join(inner, 'bin', 'node')
    fs.writeFileSync(p, '#!/bin/sh\necho fixture-node\n')
    fs.chmodSync(p, 0o755)
  }
  const tarball = path.join(dir, asset)
  const r = spawnSync('tar', ['-czf', tarball, '-C', dir, path.basename(inner)])
  if (r.status !== 0) throw new Error(`fixture tar failed: ${r.stderr}`)
  return { tarball, asset }
}

/** 起一个只答一个资产请求的本地 mock 镜像（SHASUMS + 资产二进制） */
async function serveOneAsset(tarball: string, asset: string, version: string): Promise<{ port: number; close: () => void }> {
  const sha = await fileSha256(tarball)
  const server = http.createServer((req, res) => {
    if (req.url === `/v${version}/SHASUMS256.txt`) {
      res.end(`${sha}  ${asset}\n`)
    } else if (req.url === `/v${version}/${asset}`) {
      res.end(fs.readFileSync(tarball))
    } else {
      res.statusCode = 404
      res.end('nope')
    }
  })
  const port = await listenEphemeral(server)
  return { port, close: () => server.close() }
}

describePosix('noderuntime 下载后归因缺口（缺二进制 / 内层目录缺失）', () => {
  const version = '0.0.0-test'
  const envs = ['MODELRDOCK_NODE_MIRROR', 'MODELRDOCK_NODE_VERSION', 'MODELRDOCK_NODE_FORCE_DOWNLOAD']

  it('解压后缺 node 二进制：报「缺少」且不留半截目录', async () => {
    const h = fakeHome()
    const saved = envs.map((k) => process.env[k])
    let mirror: { port: number; close: () => void } | null = null
    try {
      const { tarball, asset } = makeCustomTarball(fs.mkdtempSync(path.join(h.home, 'fixture-')), version, { omitNode: true })
      mirror = await serveOneAsset(tarball, asset, version)
      process.env.MODELRDOCK_NODE_MIRROR = `http://127.0.0.1:${mirror.port}`
      process.env.MODELRDOCK_NODE_VERSION = version
      process.env.MODELRDOCK_NODE_FORCE_DOWNLOAD = '1'
      await expect(ensureNodeRuntime()).rejects.toThrow(/缺少/)
      // 解压已到位（rename 完成），缺的是包内 node 二进制本身——报错发生在归因检查步
      expect(fs.existsSync(path.join(managedNodeDir(), 'bin', 'npm'))).toBe(true)
      expect(fs.existsSync(path.join(managedNodeDir(), 'bin', 'node'))).toBe(false)
      const root = path.join(h.home, '.modeldock', 'runtime', 'node')
      expect(fs.readdirSync(root).filter((e) => e.startsWith('.stage-'))).toEqual([])
    } finally {
      mirror?.close()
      envs.forEach((k, i) => {
        if (saved[i] === undefined) delete process.env[k]
        else process.env[k] = saved[i]!
      })
      h.restore()
    }
  })

  it('压缩包内层目录名不符：报「未找到目录」（下载与校验均通过）', async () => {
    const h = fakeHome()
    const saved = envs.map((k) => process.env[k])
    let mirror: { port: number; close: () => void } | null = null
    try {
      const { tarball, asset } = makeCustomTarball(fs.mkdtempSync(path.join(h.home, 'fixture-')), version, { innerDir: 'wrong-top-dir' })
      mirror = await serveOneAsset(tarball, asset, version)
      process.env.MODELRDOCK_NODE_MIRROR = `http://127.0.0.1:${mirror.port}`
      process.env.MODELRDOCK_NODE_VERSION = version
      process.env.MODELRDOCK_NODE_FORCE_DOWNLOAD = '1'
      await expect(ensureNodeRuntime()).rejects.toThrow(/未找到目录/)
      expect(fs.existsSync(managedNodeDir())).toBe(false)
    } finally {
      mirror?.close()
      envs.forEach((k, i) => {
        if (saved[i] === undefined) delete process.env[k]
        else process.env[k] = saved[i]!
      })
      h.restore()
    }
  })

  it('多个 shell rc 都存在时都写入 PATH 行（既有内容保留）', async () => {
    const h = fakeHome()
    try {
      const binDir = managedNodeBinDir()
      fs.writeFileSync(path.join(h.home, '.zshrc'), 'export Z=1\n')
      fs.writeFileSync(path.join(h.home, '.bashrc'), 'export B=1')
      await integrateManagedPath(binDir)
      const zsh = fs.readFileSync(path.join(h.home, '.zshrc'), 'utf8')
      const bash = fs.readFileSync(path.join(h.home, '.bashrc'), 'utf8')
      expect(zsh).toContain('export Z=1')
      expect(zsh).toContain(binDir)
      expect(bash).toContain('export B=1')
      expect(bash).toContain(binDir)
    } finally {
      h.restore()
    }
  })
})

describe('noderuntime PATH 接入 · Windows 沙箱分支', () => {
  it.skipIf(process.platform !== 'win32')('FAKE_HOME 下跳过写用户 PATH（沙箱不碰真机环境变量）', async () => {
    const h = fakeHome()
    const lines: string[] = []
    try {
      await integrateManagedPath(managedNodeBinDir(), (l) => lines.push(l))
      expect(lines.join('\n')).toContain('沙箱模式')
    } finally {
      h.restore()
    }
  })
})
