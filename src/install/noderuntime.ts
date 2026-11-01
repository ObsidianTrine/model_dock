import { spawn } from 'node:child_process'
import fsp from 'node:fs/promises'
import fs from 'node:fs'
import path from 'node:path'
import { getLang, t, type Lang } from '../util/i18n.js'
import { atomicWrite, commandOnPathResolved, ensureDir, fileSha256, readTextIfExists } from '../util/fsx.js'
import { homeDir, modeldockDir, sandboxNpmCache, sandboxNpmPrefix } from '../util/paths.js'
import { downloadText, downloadToFile, extractArchive, parseSums } from '../update/transfer.js'

/**
 * 托管 Node 运行时：为"本机没有任何 Node"的全新电脑自动补齐 npm 类 AI 客户端
 * （dsh、claude-code、codex、opencode 都是 Node 程序）的运行前提。
 * - 版本钉死在常量里（发版时随手 bump）：下载 URL 与 SHA256 校验都依赖确定版本；
 * - 只服务于客户端，与 ModelDock 自身运行无关（SEA 自带运行时）；
 * - 装在 ~/.modeldock/runtime/node/v<ver>，用户级目录、免管理员，删目录即卸载。
 * 版本依据（2026-10 评估）：claude-code 引擎要求 >=22，dsh 依赖链最苛刻项 commander 15
 * 要求 >=22.12；24 为 Active LTS 且与 SEA 内嵌运行时 / CI / 开发机同大版本。
 */
export const MANAGED_NODE_VERSION = '24.22.2'

/** 大陆网络实测 npm 官方源直连超时、nodejs.org 偶发缓慢：zh 用户默认走阿里镜像 */
const DEFAULT_NODE_MIRROR = 'https://cdn.npmmirror.com/binaries/node'
const OFFICIAL_NODE_DIST = 'https://nodejs.org/dist'
/** zh 用户代跑 npm 安装命令时注入的 registry（env 覆盖优先；不改用户全局 npm 配置） */
export const DEFAULT_NPM_REGISTRY = 'https://registry.npmmirror.com'

const PROGRESS_STEP = 8 * 1024 * 1024
const RC_PATH_MARK = 'ModelDock Node 运行时'

export function nodeVersion(): string {
  const v = process.env.MODELRDOCK_NODE_VERSION?.trim()
  return v ? v.replace(/^v/, '') : MANAGED_NODE_VERSION
}

/**
 * 地区策略（用户原则）：语言即地区假设——zh 默认大陆用户，Node 二进制只走国内镜像，
 * 失败按大陆环境提示接入 VPN 重试；en 默认海外用户，官方源直连。
 * 显式 MODELRDOCK_NODE_MIRROR 覆盖视为用户已接管源选择，保留官方源回落。
 */
export function nodeDownloadBases(lang: Lang = getLang()): string[] {
  const override = process.env.MODELRDOCK_NODE_MIRROR?.trim()
  if (override) return [...new Set([override.replace(/\/+$/, ''), OFFICIAL_NODE_DIST])]
  return [lang === 'zh' ? DEFAULT_NODE_MIRROR : OFFICIAL_NODE_DIST]
}

/** 安装命令子进程注入的 npm registry：显式 env 优先；zh 默认注入国内镜像（npmjs 大陆直连常超时）；
 *  en 不注入——保留官方默认与用户自己的 npm 配置。只影响本次子进程，不改全局配置。 */
export function npmRegistry(lang: Lang = getLang()): string | undefined {
  const r = process.env.MODELRDOCK_NPM_REGISTRY?.trim()
  if (r) return r
  return lang === 'zh' ? DEFAULT_NPM_REGISTRY : undefined
}

/**
 * 安装命令子进程环境：网关进程常被 npm/npx 工具链拉起（npx tsx、npm run、全局 shim），这些父进程
 * 会把 npm_config_global_prefix/globalconfig/prefix 等指向宿主 npm 的变量泄漏进环境；托管 npm
 * 照单全收会把全局包装回宿主 prefix（2026-10-03 沙箱实测踩中：dsh 装进了宿主 nvm 目录而非托管
 * runtime）。统一剥掉 npm_* 再注入受控项；用户级 ~/.npmrc 不受影响。
 * 沙箱模式（FAKE_HOME）额外把全局落点与缓存指进沙箱——npm 全局安装完全不碰真机。
 */
export function installChildEnv(base: NodeJS.ProcessEnv, lang?: Lang): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(base)) {
    if (v !== undefined && !/^npm_/i.test(k)) env[k] = v
  }
  const reg = npmRegistry(lang)
  if (reg) env.npm_config_registry = reg
  const prefix = sandboxNpmPrefix()
  if (prefix) {
    env.npm_config_prefix = prefix
    const cache = sandboxNpmCache()
    if (cache) env.npm_config_cache = cache
  }
  return env
}

/** 下载失败文案：默认镜像直连（无覆盖）失败按大陆环境提示 VPN；覆盖/官方源失败给通用网络建议 */
export function downloadFailureMessage(bases: string[], err: string): Error {
  if (bases.length === 1 && bases[0] === nodeDownloadBases('zh')[0]) {
    return new Error(t(
      '国内镜像下载 Node 运行时失败（{base}）：{err}。请接入 VPN 后重试（VPN 下镜像与官方源均可访问）；也可设 MODELRDOCK_NODE_MIRROR 指向可用镜像',
      'Failed to download the Node runtime from the China mirror ({base}): {err}. Connect to a VPN and retry (both the mirror and the official source are reachable through a VPN); or point MODELRDOCK_NODE_MIRROR at a reachable mirror',
      { base: bases[0], err }
    ))
  }
  return new Error(t(
    'Node 运行时下载失败（已尝试 {bases}）：{err}。请检查网络后重试',
    'Failed to download the Node runtime (tried {bases}): {err}. Check the network and retry',
    { bases: bases.join('、'), err }
  ))
}

/**
 * 从 npm 安装输出识别 EBADENGINE（依赖 engines 与运行时不匹配）并生成可操作提示。
 * npm 对 engines 默认只警告不拦截：钉死的托管 Node 过期后，新客户端会「装成功、跑就崩」，
 * 把埋在安装日志里的警告提升到安装结果，过期钉版第一时间可见。无 EBADENGINE 时返回 null。
 */
export function engineWarningHint(output: string): string | null {
  if (!output.includes('EBADENGINE')) return null
  const required = [...new Set(
    [...output.matchAll(/required:\s*\{[^}]*\bnode:\s*'([^']+)'/g)].map((m) => m[1])
  )]
  const current = output.match(/current:\s*\{[^}]*\bnode:\s*'([^']+)'/)?.[1]
  return t(
    '检测到 EBADENGINE 警告：有依赖要求 Node {req}（本次安装用 {cur}）。安装可能照常完成，但客户端运行可能异常——建议升级系统 Node 到要求版本后点「重新检测」，或设 MODELRDOCK_NODE_VERSION=<更高版本> 重新安装',
    'EBADENGINE warnings detected: a dependency requires Node {req} (this install ran on {cur}). The install may have completed, but the client may fail to run — upgrade the system Node to the required version and click Re-detect, or set MODELRDOCK_NODE_VERSION=<a newer version> and reinstall',
    { req: required.join('、') || '?', cur: current ?? '?' }
  )
}

export function managedNodeDir(version = nodeVersion()): string {
  return path.join(modeldockDir(), 'runtime', 'node', `v${version}`)
}

/** node/npm/dsh shim 所在目录：win 解压即平铺，unix 多一层 bin */
export function managedNodeBinDir(version = nodeVersion()): string {
  return process.platform === 'win32' ? managedNodeDir(version) : path.join(managedNodeDir(version), 'bin')
}

/** 平台资产名：node-v24.22.0-darwin-arm64.tar.gz / node-v24.22.0-win-x64.zip */
export function nodeAssetName(
  version = nodeVersion(),
  platform = process.platform,
  arch = process.arch
): string {
  const plat = normalizeNodePlat(platform)
  if (plat !== 'darwin' && plat !== 'linux' && plat !== 'win') {
    throw new Error(t('不支持的操作系统：{p}', 'Unsupported operating system: {p}', { p: platform }))
  }
  if (arch !== 'arm64' && arch !== 'x64') {
    throw new Error(t('不支持的 CPU 架构：{a}，托管运行时仅提供 x64/arm64', 'Unsupported CPU architecture: {a}; the managed runtime ships x64/arm64 only', { a: arch }))
  }
  return `node-v${version}-${plat}-${arch}.${plat === 'win' ? 'zip' : 'tar.gz'}`
}

/** 平台段的唯一归一（win32→win）：资产名与包内顶层目录名共用，杜绝两处独立拼接漂移（DESIGN-11） */
export function normalizeNodePlat(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'win' : platform
}

/** 暂存目录名：按资产名派生（.stage-<asset>），不同版本/架构的资产并发下载互不踩目录（DESIGN-11）。 */
export function nodeStageDirName(asset: string): string {
  return `.stage-${asset}`
}

/** 解压包内顶层目录名（node dist 命名规则 node-v<ver>-<plat>-<arch>）。与资产名共用平台归一，
 *  downloadNodeRuntime 的两处内层校验/换名一律经此（DESIGN-11 单一来源）。 */
export function nodeInnerDirName(
  version = nodeVersion(),
  platform: NodeJS.Platform = process.platform,
  arch = process.arch
): string {
  return `node-v${version}-${normalizeNodePlat(platform)}-${arch}`
}

export interface NodeRuntimeInfo {
  /** 需前置到子进程 PATH 的 bin 目录（含 node/npm）。系统 node 经 well-known 目录命中时
   *  LaunchAgent 的 PATH 可能缺该目录，因此 path 来源同样返回，由调用方统一前置 */
  binDir: string
  nodeBin: string
  source: 'path' | 'managed' | 'download'
}

/**
 * 确保可用 node：系统 PATH/常见位置 → 已下载的托管运行时 → 现场下载托管运行时。
 * onOut 逐行接收进度文案（安装输出流直接展示）。
 */
export async function ensureNodeRuntime(onOut?: (line: string) => void): Promise<NodeRuntimeInfo> {
  const isWin = process.platform === 'win32'
  // 测试注入点：强制走托管分支（CI/单测机必有 node，短路会让下载逻辑测不到）
  if (process.env.MODELRDOCK_NODE_FORCE_DOWNLOAD !== '1') {
    const found = commandOnPathResolved('node')
    if (found) return { binDir: path.dirname(found), nodeBin: found, source: 'path' }
  }
  const binDir = managedNodeBinDir()
  const nodeBin = path.join(binDir, isWin ? 'node.exe' : 'node')
  if (fs.existsSync(nodeBin)) return { binDir, nodeBin, source: 'managed' }

  const bases = nodeDownloadBases()
  onOut?.(t(
    '未检测到 Node.js，开始下载托管运行时（Node v{ver}，{asset}，来源 {src}）…',
    'Node.js not found; downloading the managed runtime (Node v{ver}, {asset}, from {src})…',
    { ver: nodeVersion(), asset: nodeAssetName(), src: bases.join(' / ') }
  ))
  await downloadNodeRuntime(onOut)
  if (!fs.existsSync(nodeBin)) {
    throw new Error(t('托管 Node 运行时解压后缺少 {bin}', 'The managed Node runtime is missing {bin} after extraction', { bin: nodeBin }))
  }
  onOut?.(t('托管 Node 运行时就绪：{dir}', 'Managed Node runtime ready: {dir}', { dir: managedNodeDir() }))
  await integrateManagedPath(binDir, onOut)
  return { binDir, nodeBin, source: 'download' }
}

// 下载与校验

async function downloadNodeRuntime(onOut?: (line: string) => void): Promise<void> {
  const version = nodeVersion()
  const asset = nodeAssetName(version)
  const bases = nodeDownloadBases()
  const root = path.join(modeldockDir(), 'runtime', 'node')
  // 暂存目录按资产名派生（.stage-<asset>），不同资产并发下载互不踩目录（DESIGN-11）：
  // 同进程并发 ensureNodeRuntime 不再因共享 `.stage-<pid>` 一方 rm/rename 毁另一方。
  const stageDir = path.join(root, nodeStageDirName(asset))
  await fsp.rm(stageDir, { recursive: true, force: true })
  await ensureDir(stageDir)
  const archive = path.join(stageDir, asset)
  try {
    let lastErr = ''
    let ok = false
    for (const base of bases) {
      try {
        // 资产与 SHASUMS256 必须同一来源：镜像同步存在差异时不能混搭校验
        const origin = `${base}/v${version}`
        // SHASUMS 是 ~1KB 小文本：不套 10min 通用下载超时，短超时让挂死连接尽快落到下一镜像源
        const sums = await downloadText(`${origin}/SHASUMS256.txt`, { timeoutMs: 30_000 })
        let nextReport = PROGRESS_STEP
        await downloadToFile(`${origin}/${asset}`, archive, {
          onProgress: (seen: number, total: number) => {
            if (onOut && seen >= nextReport) {
              onOut(t('已下载 {mb} MB{total}', 'Downloaded {mb} MB{total}', {
                mb: Math.round(seen / 1024 / 1024),
                total: total > 0 ? ` / ${Math.round(total / 1024 / 1024)} MB` : '',
              }))
              nextReport = seen + PROGRESS_STEP
            }
          },
        })
        const expect = parseSums(sums)[asset]
        if (!expect) throw new Error(t('SHASUMS256.txt 中找不到 {asset} 的校验项', 'SHASUMS256.txt has no entry for {asset}', { asset }))
        const actual = await fileSha256(archive)
        if (actual !== expect) {
          throw new Error(t('SHA256 校验不符：期望 {expect}，实际 {actual}', 'SHA256 mismatch: expected {expect}, got {actual}', { expect, actual }))
        }
        onOut?.(t('下载完成（{mb} MB），SHA256 校验通过', 'Downloaded ({mb} MB); SHA256 verified', { mb: Math.max(1, Math.round((await fsp.stat(archive)).size / 1024 / 1024)) }))
        ok = true
        break
      } catch (e) {
        lastErr = e instanceof Error ? e.message : String(e)
      }
    }
    if (!ok) {
      throw downloadFailureMessage(bases, lastErr)
    }
    await extractArchive(archive, stageDir)
    // 解压产物缺失说明包内容与预期不符（资产名对不上内容），让上层报错前先归因
    const inner = path.join(stageDir, nodeInnerDirName(version))
    if (!fs.existsSync(inner)) {
      throw new Error(t('压缩包内未找到目录 {dir}', 'Directory {dir} not found inside the archive', { dir: path.basename(inner) }))
    }
    const target = managedNodeDir(version)
    await fsp.rm(target, { recursive: true, force: true })
    await fsp.rename(inner, target)
  } finally {
    await fsp.rm(stageDir, { recursive: true, force: true }).catch(() => {})
  }
}

function spawnAwait(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
    let err = ''
    child.stderr?.on('data', (d) => { err += String(d) })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(err.trim() || t('进程退出码 {code}', 'process exited with code {code}', { code: code ?? -1 })))
    })
  })
}

// PATH 接入

/** 下载成功后把托管 bin 目录接进用户 PATH（幂等）：unix 追加 shell rc 带标记行，
 *  Windows 写用户级 PATH。npm 全局装出的客户端 shim 依赖 `env node`，不接 PATH 用户终端里跑不起来。
 *  MODELRDOCK_NODE_NO_PATH_EDIT=1 时整体跳过（自动化场景不碰用户 shell 配置）。 */
export async function integrateManagedPath(binDir: string, onOut?: (line: string) => void): Promise<void> {
  if (process.env.MODELRDOCK_NODE_NO_PATH_EDIT === '1') {
    onOut?.(t('已按 MODELRDOCK_NODE_NO_PATH_EDIT 跳过 PATH 配置', 'PATH setup skipped per MODELRDOCK_NODE_NO_PATH_EDIT'))
    return
  }
  if (process.platform === 'win32') {
    // 沙箱模式不写用户级 PATH：那是真机环境变量，装进沙箱的 shim 没必要也不允许暴露给真机终端
    // （unix 分支写 homeDir() 下的 shell rc，FAKE_HOME 下本就落沙箱，无需跳过）
    if (process.env.MODELRDOCK_FAKE_HOME) {
      onOut?.(t(
        '沙箱模式：跳过写入 Windows 用户 PATH（沙箱内安装不改动真机环境变量）',
        'Sandbox mode: skipping the Windows user PATH edit (sandbox installs do not touch real machine environment variables)'
      ))
      return
    }
    await integrateWindowsUserPath(binDir, onOut)
    return
  }
  const line = `export PATH="${binDir}:$PATH"  # ${RC_PATH_MARK}（删除本行即撤销）`
  const home = homeDir()
  const candidates = ['.zshrc', '.bashrc'].map((f) => path.join(home, f))
  const existing: string[] = []
  for (const file of candidates) {
    if (fs.existsSync(file)) existing.push(file)
  }
  if (existing.length === 0) existing.push(path.join(home, '.zshrc')) // 全新机器 macOS 默认 zsh
  const touched: string[] = []
  for (const file of existing) {
    const text = (await readTextIfExists(file)) ?? ''
    if (text.includes(binDir)) continue // 已配置过（幂等）
    const sep = text.length > 0 && !text.endsWith('\n') ? '\n' : ''
    await atomicWrite(file, `${text}${sep}${line}\n`, 0o644)
    touched.push(file)
  }
  if (touched.length > 0) {
    onOut?.(t(
      '已把 {binDir} 加入 PATH（写入 {files}）；新开终端标签页生效，删除对应行可撤销',
      'Added {binDir} to PATH (written to {files}); takes effect in new terminal tabs — remove the line to undo',
      { binDir, files: touched.map((f) => path.basename(f)).join('、') }
    ))
  }
}

async function integrateWindowsUserPath(binDir: string, onOut?: (line: string) => void): Promise<void> {
  // setx 有 1024 字符截断风险，走 .NET API 读改写用户级 PATH；contains 判重保证幂等
  if (binDir.includes("'")) {
    onOut?.(t('安装目录含单引号，跳过自动配置 PATH，请手动加入：{binDir}', 'Install path contains a single quote; PATH not set automatically — add it manually: {binDir}', { binDir }))
    return
  }
  const script = `$bd='${binDir}';$p=[Environment]::GetEnvironmentVariable('Path','User');if(($p -split ';') -notcontains $bd){$n=(@($p -split ';')+$bd | Where-Object {$_ -ne ''}) -join ';';[Environment]::SetEnvironmentVariable('Path',$n,'User')}`
  await spawnAwait('powershell', ['-NoProfile', '-Command', script])
  onOut?.(t(
    '已把 {binDir} 写入用户 PATH；新开终端生效，"编辑账户环境变量"可撤销',
    'Added {binDir} to the user PATH; takes effect in new terminals — undo via "Edit environment variables for your account"',
    { binDir }
  ))
}
