#!/usr/bin/env node
/**
 * ModelDock SEA 构建脚本
 *
 * 用法：node scripts/build-sea.mjs [--target linux-x64|darwin-arm64|win32-x64] [--ico-only] [--pack]
 *
 * 产物：release/modeldock-{platform}-{arch}[.exe]  +  SHA256SUMS；--pack 时另产 npm 包 modeldock-<版本>.tgz
 *
 * 流程：tsc → esbuild bundle → node SEA generate → 复制二进制 → 打包
 */

import { execSync, execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import zlib from 'node:zlib'

const ROOT = path.resolve(import.meta.dirname, '..')
const DIST = path.join(ROOT, 'dist')
const RELEASE = path.join(ROOT, 'release')

// 平台映射
const PLATFORMS = {
  'linux-x64':   { os: 'linux',   arch: 'x64',  ext: '',      nodeUrl: 'https://nodejs.org/dist/v24.16.0/node-v24.16.0-linux-x64.tar.gz' },
  'linux-arm64': { os: 'linux',   arch: 'arm64', ext: '',      nodeUrl: 'https://nodejs.org/dist/v24.16.0/node-v24.16.0-linux-arm64.tar.gz' },
  'darwin-x64':  { os: 'darwin',  arch: 'x64',  ext: '',      nodeUrl: 'https://nodejs.org/dist/v24.16.0/node-v24.16.0-darwin-x64.tar.gz' },
  'darwin-arm64':{ os: 'darwin',  arch: 'arm64', ext: '',      nodeUrl: 'https://nodejs.org/dist/v24.16.0/node-v24.16.0-darwin-arm64.tar.gz' },
  'win32-x64':   { os: 'win32',   arch: 'x64',  ext: '.exe',  nodeUrl: 'https://nodejs.org/dist/v24.16.0/node-v24.16.0-win-x64.zip' },
}

const currentPlatform = `${process.platform}-${process.arch}`

// 构建版本号（main() 里 Step 0 从 git tag 同步后设置；无 tag 时回落 package.json）
let BUILD_VERSION = null

// 参数解析
const args = process.argv.slice(2)
const targetFlag = args.find(a => a.startsWith('--target'))
const targetArg = targetFlag
  ? (targetFlag.includes('=') ? targetFlag.split('=')[1] : args[args.indexOf(targetFlag) + 1])
  : null

const targets = targetArg
  ? (targetArg === 'all' ? Object.keys(PLATFORMS) : [targetArg])
  : [currentPlatform]

// --pack：SEA 构建完成后、版本号还原前顺手打出 npm tgz（保证 tgz 版本 = git tag）
const packFlag = args.includes('--pack')

// 工具函数
function log(msg)  { console.log(`\x1b[36m[build]\x1b[0m ${msg}`) }
function warn(msg) { console.log(`\x1b[33m[build]\x1b[0m ${msg}`) }
function err(msg)  { console.error(`\x1b[31m[build]\x1b[0m ${msg}`); process.exit(1) }
function run(cmd, opts = {}) { execSync(cmd, { cwd: ROOT, stdio: 'inherit', ...opts }) }
function runOut(cmd) { return execSync(cmd, { cwd: ROOT, encoding: 'utf8' }).trim() }
/** 有限次重试（间隔退避固定）：Windows 上刚落盘的产物易被杀软实时扫描短暂锁住，等它释放即可 */
async function withRetry(maxAttempts, delayMs, fn) {
  for (let attempt = 1; ; attempt++) {
    try { return await fn() } catch (e) {
      if (attempt >= maxAttempts) throw e
      warn(`    ! 第 ${attempt}/${maxAttempts} 次失败（${e.message.split('\n')[0]}），${delayMs / 1000}s 后重试…`)
      await new Promise(r => setTimeout(r, delayMs))
    }
  }
}
function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex') }

// 版本同步：从 git tag 读取版本号，写入 src/version.ts 和 package.json
const VERSION_TS_PATH = path.join(ROOT, 'src', 'version.ts')
const PKG_JSON_PATH  = path.join(ROOT, 'package.json')

function readGitVersion() {
  try {
    // 获取最近的 tag（如 v0.1.1），去掉 v 前缀得 semver
    const tag = runOut('git describe --tags --abbrev=0')
    const ver = tag.replace(/^v/, '')
    if (!/^\d+\.\d+\.\d+/.test(ver)) return null
    return ver
  } catch {
    return null
  }
}

/**
 * 从 git tag 同步版本号到 src/version.ts 和 package.json。
 * 返回 { version, origVersionTs, origPkgJson } 供构建后还原。
 */
async function syncVersionFromTag() {
  const ver = readGitVersion()
  if (!ver) {
    warn('未找到 git tag，使用 src/version.ts 中的现有版本')
    return null
  }

  log(`从 git tag 同步版本: v${ver}`)

  // 备份原文件
  const origVersionTs = await fsp.readFile(VERSION_TS_PATH, 'utf8')
  const origPkgJson   = await fsp.readFile(PKG_JSON_PATH, 'utf8')

  // 写入新版本
  const newVersionTs = `export const VERSION = '${ver}'\n`
  await fsp.writeFile(VERSION_TS_PATH, newVersionTs)

  const pkg = JSON.parse(origPkgJson)
  pkg.version = ver
  await fsp.writeFile(PKG_JSON_PATH, JSON.stringify(pkg, null, 2) + '\n')

  return { version: ver, origVersionTs, origPkgJson }
}

/**
 * 还原被 syncVersionFromTag 修改的文件
 */
async function restoreVersionFiles(saved) {
  if (!saved) return
  await fsp.writeFile(VERSION_TS_PATH, saved.origVersionTs)
  await fsp.writeFile(PKG_JSON_PATH, saved.origPkgJson)
}

/** Node 官方 SHASUMS256 表（与 url 同目录的 SHASUMS256.txt），key=文件名 */
async function fetchNodeShasums(url) {
  const base = url.replace(/\/[^/]+$/, '')
  const res = await fetch(`${base}/SHASUMS256.txt`, { signal: AbortSignal.timeout(60_000) })
  if (!res.ok) err(`下载 SHASUMS256.txt 失败: ${res.status}（供应链门禁，拒绝跳过校验）`)
  const map = new Map()
  for (const line of (await res.text()).split('\n')) {
    const m = /^([0-9a-f]{64})\s+(\S+)$/.exec(line.trim())
    if (m) map.set(m[2], m[1])
  }
  return map
}

async function downloadFile(url, dest, shasums) {
  log(`下载 ${url}`)
  const res = await fetch(url, { signal: AbortSignal.timeout(600_000) })
  if (!res.ok) err(`下载失败: ${res.status} ${res.statusText}`)
  const buf = Buffer.from(await res.arrayBuffer())
  if (shasums) {
    const name = path.basename(url)
    if (shasums.get(name) !== sha256(buf)) {
      err(`Node 工具链哈希校验失败（${name} 与 nodejs.org SHASUMS256 不符）：拒绝落盘注入 SEA`)
    }
  }
  await fsp.writeFile(dest, buf)
  return buf
}

// Step 1: TypeScript 编译
async function buildTS() {
  log('Step 1/6 — TypeScript 编译')
  run('npx tsc -p tsconfig.json')
  log('  ✓ tsc 完成')
}

// Step 2: esbuild 打包
async function buildBundle() {
  log('Step 2/6 — esbuild 打包')
  await fsp.mkdir(DIST, { recursive: true })

  // 动态导入 esbuild（devDependency）
  const esbuild = await import('esbuild')
  await esbuild.build({
    entryPoints: [path.join(ROOT, 'dist/cli.js')],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node22',
    outfile: path.join(DIST, 'modeldock.bundle.cjs'),
    // Node.js 内置模块不打包
    external: [
      'node:*',
    ],
    // 确保所有 npm 依赖被打入
    packages: 'bundle',
    minify: false,   // 保留可读性，出错好排查
    sourcemap: false,
    logLevel: 'info',
  })

  const size = (await fsp.stat(path.join(DIST, 'modeldock.bundle.cjs'))).size
  log(`  ✓ bundle 完成 (${(size / 1024).toFixed(0)} KB)`)
}

// Step 3: 生成 SEA blob
async function buildBlob() {
  log('Step 3/6 — 生成 SEA blob')
  const seaConfig = path.join(ROOT, 'scripts/sea-config.json')
  run(`node --experimental-sea-config ${path.relative(ROOT, seaConfig)}`, { cwd: ROOT })
  const blobPath = path.join(DIST, 'modeldock.blob')
  if (!fs.existsSync(blobPath)) err('blob 生成失败')
  log(`  ✓ blob 完成 (${((await fsp.stat(blobPath)).size / 1024).toFixed(0)} KB)`)
}

// Step 4: 为每个 target 构建可执行文件
async function buildExecutables() {
  log('Step 4/6 — 构建可执行文件')
  // 清空 release 目录内容，避免残留旧平台文件
  await fsp.mkdir(RELEASE, { recursive: true })
  for (const f of await fsp.readdir(RELEASE)) {
    await fsp.rm(path.join(RELEASE, f), { force: true, recursive: true })
  }

  const blobPath = path.join(DIST, 'modeldock.blob')
  const blob = await fsp.readFile(blobPath)

  for (const target of targets) {
    const spec = PLATFORMS[target]
    if (!spec) err(`未知 target: ${target}，可选: ${Object.keys(PLATFORMS).join(', ')}`)

    const exeName = `modeldock-${target}${spec.ext}`
    const exePath = path.join(RELEASE, exeName)
    log(`  → ${exeName}`)

    if (target === currentPlatform) {
      // 当前平台：直接从 node 二进制复制
      const nodeExe = process.execPath
      await fsp.copyFile(nodeExe, exePath)
    } else {
      // 交叉编译：下载目标平台的 Node.js 二进制
      const cacheDir = path.join(ROOT, '.cache', 'node-binaries')
      await fsp.mkdir(cacheDir, { recursive: true })

      const url = spec.nodeUrl
      const archiveName = path.basename(url)
      const archivePath = path.join(cacheDir, archiveName)

      // 供应链门禁：交叉下载的 Node 二进制注入 SEA 后进入发布物，必须与 nodejs.org 官方
      // SHASUMS256 比对；缓存命中也复核（防缓存污染），不符即重新下载，仍不符则整体失败
      const shasums = await fetchNodeShasums(url)
      if (fs.existsSync(archivePath)) {
        const cachedOk = sha256(await fsp.readFile(archivePath)) === shasums.get(archiveName)
        if (!cachedOk) {
          warn(`  ! 缓存的 ${archiveName} 与官方 SHASUMS256 不符，重新下载`)
          await fsp.rm(archivePath, { force: true })
        }
      }
      if (!fs.existsSync(archivePath)) {
        await downloadFile(url, archivePath, shasums)
      }

      // 从压缩包中提取 node 二进制
      const extractDir = path.join(cacheDir, target)
      await fsp.rm(extractDir, { recursive: true, force: true })
      await fsp.mkdir(extractDir, { recursive: true })

      if (archiveName.endsWith('.tar.gz')) {
        run(`tar xzf "${archivePath}" -C "${extractDir}"`)
        // node 二进制在 node-v*-<os>-<arch>/bin/node
        const dirs = await fsp.readdir(extractDir)
        const nodeBin = path.join(extractDir, dirs[0], 'bin', 'node')
        await fsp.copyFile(nodeBin, exePath)
      } else if (archiveName.endsWith('.zip')) {
        // Windows: 用 PowerShell 解压（if (!$?) 把非终止错误转成失败码，防止解压失败被吞）
        run(`powershell -Command "Expand-Archive -Path '${archivePath}' -DestinationPath '${extractDir}' -Force; if (!$?) { exit 1 }"`)
        const dirs = await fsp.readdir(extractDir)
        const nodeBin = path.join(extractDir, dirs[0], 'node.exe')
        await fsp.copyFile(nodeBin, exePath)
      }

      // 清理解压目录
      await fsp.rm(extractDir, { recursive: true, force: true })
    }

    // 将 SEA blob 注入到 Node.js 二进制
    // 使用 postject（Node.js SEA 标准注入工具）；postject 已在 devDependencies，
    // npx 走本地 node_modules（不加 --yes 时 CI 无 TTY 会因"是否安装"的交互询问而失败）
    const SENTINEL = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'
    const postjectArgs = [
      'postject', `"${exePath}"`, 'NODE_SEA_BLOB', `"${blobPath}"`,
      '--sentinel-fuse', SENTINEL,
    ]
    if (spec.os === 'darwin') {
      postjectArgs.push('--macho-segment-name', 'NODE_SEA')
    }
    run(`npx --yes ${postjectArgs.join(' ')}`)

    // Windows：注入后把品牌图标 + 版本信息写进 exe 资源区（否则 exe 在资源管理器里显示 node.exe 自带的 Node.js 图标）。
    // 实测 resedit 重建 PE 会完整保留 postject 的 overlay blob；顺序反过来则 postject 会报 Relocation corrupted。
    if (spec.os === 'win32') {
      const icoPath = path.join(DIST, 'modeldock.ico')
      await generateIco(icoPath)
      await embedWinResources(exePath, icoPath)
      log(`    ✓ 已嵌入应用图标与版本信息`)
    }

    // macOS：nodejs.org 官方 v24 二进制自带 minos 13.5（Node 官方预编译版声明的部署目标），
    // Finder/LaunchServices 启动 .app 会据此拒绝 macOS 13.0–13.4（终端直接执行不检查此项）。
    // 实测 13.0 全功能正常，统一改写为 13.0；Info.plist 的 LSMinimumSystemVersion 与其保持一致。
    // vtool 会改写 Mach-O 使签名失效——放在 postject 之后、最终 codesign 重签之前
    if (spec.os === 'darwin') {
      try {
        const minosTmp = `${exePath}.minos`
        run(`vtool -set-build-version macos 13.0 15.0 -replace -output "${minosTmp}" "${exePath}"`)
        await fsp.rename(minosTmp, exePath)
      } catch {
        await fsp.rm(`${exePath}.minos`, { force: true })
        warn(`    ! vtool 不可用，${exeName} 最低系统版本仍为 13.5——macOS 13.0–13.4 的 Finder 将拒绝启动打包后的 .app`)
      }
    }

    if (spec.ext !== '.exe') {
      await fsp.chmod(exePath, 0o755)
    }

    // macOS：postject 注入后原签名失效——Apple Silicon 对签名无效的二进制直接拒绝执行，
    // Intel 虽不强制但也重签，与 Node.js SEA 官方文档一致
    if (spec.os === 'darwin') {
      try {
        run(`codesign --force --sign - "${exePath}"`)
      } catch {
        warn(`    ! codesign 不可用，${exeName} 未重签名——Apple Silicon 上运行前需在 macOS 执行: codesign --force --sign - "${exeName}"`)
      }
    }

    // 记录产物信息（校验名单在 Step 5.9 统一按对外发布物生成）
    const exeBuf = await fsp.readFile(exePath)
    log(`    ✓ ${exeName} (${(exeBuf.length / 1024 / 1024).toFixed(1)} MB, sha256:${sha256(exeBuf).slice(0, 16)}…)`)
  }

  // Step 5.5/6 — 打分平台安装包（Windows .zip / Linux、macOS .tar.gz，包内只放入口程序）
  await packageDistributions()

  // Step 5.7/6 — macOS DMG 拖拽安装镜像（仅 darwin target，且仅在 macOS 上制作）
  await packageMacDmg()

  // Step 5.8/6 — Windows 安装向导（Inno Setup，仅 windows 可编译；CI 的 windows job 会自动补上）
  await packageWinSetup()

  // Step 5.9/6 — SHA256SUMS 覆盖全部对外发布物（压缩包 / DMG / setup）
  await writeSums()
}

// Step 5.5: 打分平台安装包
/**
 * 每个 target 打一个用户安装包：Windows → .zip，Linux / macOS → .tar.gz。
 * 包内只有一个入口程序（unix 名为 modeldock，Windows 为 modeldock.exe），解压即用；
 * 图形化安装各走各的：macOS DMG（Step 5.7）、Windows setup 向导（Step 5.8）。
 */
async function packageDistributions() {
  log('Step 5.5/6 — 打分平台安装包')
  for (const target of targets) {
    const spec = PLATFORMS[target]
    const binName = `modeldock-${target}${spec.ext}`
    const entryName = spec.ext === '.exe' ? 'modeldock.exe' : 'modeldock'
    // 经 staging 改名打包：包内入口名固定，用户解压 mv 一步到位
    const staging = path.join(RELEASE, `_pkg-${target}`)
    const rmOpts = { recursive: true, force: true, maxRetries: 5, retryDelay: 2000 } // 被杀软扫描锁住时等它释放
    await fsp.rm(staging, rmOpts)
    await fsp.mkdir(staging, { recursive: true })
    await fsp.copyFile(path.join(RELEASE, binName), path.join(staging, entryName))
    await fsp.chmod(path.join(staging, entryName), 0o755)
    const archiveName = `modeldock-${BUILD_VERSION}-${target}${spec.ext === '.exe' ? '.zip' : '.tar.gz'}`
    const archivePath = path.join(RELEASE, archiveName)
    if (spec.ext === '.exe') {
      if (process.platform === 'win32') {
        // if (!$?) { exit 1 }：PowerShell 对 cmdlet 的 Write-Error 是非终止错误、exit 0，必须显式转成失败码，否则打包失败静默过关
        await withRetry(3, 2000, () => run(`powershell -Command "Compress-Archive -Path '${path.join(staging, entryName)}' -DestinationPath '${archivePath}' -Force; if (!$?) { exit 1 }"`))
      } else {
        run(`cd "${staging}" && zip -q "${archivePath}" "${entryName}"`)
      }
    } else {
      run(`tar czf "${archivePath}" -C "${staging}" "${entryName}"`)
    }
    await fsp.rm(staging, rmOpts)
    log(`  ✓ ${archiveName}（${entryName}）`)
  }
}

// Step 5.7: macOS .app + DMG 拖拽安装镜像
/**
 * 把 SEA 二进制包成 ModelDock.app（Info.plist + 图标 + ad-hoc 签名），再打成一压缩 DMG：
 * 挂载窗口内是 ModelDock.app + /Applications 快捷方式，用户拖拽即完成安装。
 * 双击 app = 无参数运行二进制 = src/cli.ts 的 GUI 分支（后台起网关 + 打开 Web 控制台）。
 * 仅 macOS 可制作（iconutil / codesign / hdiutil 为系统自带，零外部依赖）。
 */

// PNG 编码：手写 chunk/CRC（Node 内置 zlib 压缩），图标零依赖生成
const PNG_CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function pngChunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  let c = 0xffffffff
  for (const b of body) c = PNG_CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE((c ^ 0xffffffff) >>> 0)
  return Buffer.concat([len, body, crc])
}

function encodePng(width, height, rgba, dpm = 0) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8  // bit depth
  ihdr[9] = 6  // color type: RGBA
  const stride = width * 4 + 1
  const raw = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0 // filter: none
    rgba.copy(raw, y * stride + 1, y * width * 4, (y + 1) * width * 4)
  }
  const chunks = [
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
  ]
  // pHYs 声明物理 DPI：2x Retina 图必须标 144dpi（5669 px/m），Finder 才按减半的点尺寸平铺
  if (dpm > 0) {
    const phys = Buffer.alloc(9)
    phys.writeUInt32BE(dpm, 0)
    phys.writeUInt32BE(dpm, 4)
    phys[8] = 1 // 单位：米
    chunks.push(pngChunk('pHYs', phys))
  }
  chunks.push(pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })), pngChunk('IEND', Buffer.alloc(0)))
  return Buffer.concat(chunks)
}

// 图标设计 v3：紫色对角渐变圆角方块（macOS 图标栅格 824/1024）+ 居中圆润 "M" 字标（ModelDock 首字母）
// 依用户反馈弃用托盘/磁贴/锚形方案——单字母字标在小尺寸（任务栏 16px）下辨识度最高
function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r)
  const qy = Math.abs(py - cy) - (hh - r)
  const ax = Math.max(qx, 0), ay = Math.max(qy, 0)
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r
}

const clamp01 = (x) => Math.min(1, Math.max(0, x))
// 4096² 超采样主图渲染一次，各尺寸盒式降采样（16/32/…/1024 均整除 4096）
const ICON_MASTER = 4096
// 覆盖度：d 为归一化 SDF 距离，乘渲染分辨率换算成像素后取 1px 抗锯齿带（深 interiors 饱和为 1）
const cover = (d, res = ICON_MASTER) => clamp01(0.5 - d * res)
function blendOver(dst, src) {
  const sa = src[3] / 255, da = dst[3] / 255
  const oa = sa + da * (1 - sa)
  if (oa === 0) return [0, 0, 0, 0]
  const mix = (s, d) => (s * sa + d * da * (1 - sa)) / oa
  return [mix(src[0], dst[0]), mix(src[1], dst[1]), mix(src[2], dst[2]), oa * 255]
}

// M 字标：四段圆头笔画中心线（左竖 / 左斜 / 右斜 / 右竖），加粗等宽、圆角端点
const ICON_M_SEGS = [
  [0.295, 0.360, 0.295, 0.645], // 左竖
  [0.295, 0.360, 0.500, 0.565], // 左斜（下探至中部）
  [0.500, 0.565, 0.705, 0.360], // 右斜
  [0.705, 0.360, 0.705, 0.645], // 右竖
]
const ICON_M_HALF = 0.0405 // 笔画半宽（全宽 0.081，256px 下约 21px）

// 圆头线段 SDF（M 字标笔画用）
function sdSeg(px, py, ax, ay, bx, by) {
  const pax = px - ax, pay = py - ay, bax = bx - ax, bay = by - ay
  const h = Math.min(1, Math.max(0, (pax * bax + pay * bay) / (bax * bax + bay * bay)))
  return Math.hypot(pax - bax * h, pay - bay * h)
}

function mdist(px, py) {
  let d = Infinity
  for (const [ax, ay, bx, by] of ICON_M_SEGS) {
    d = Math.min(d, sdSeg(px, py, ax, ay, bx, by))
  }
  return d - ICON_M_HALF
}

// 品牌图标：紫色渐变圆角方块 + 顶部柔光 + 白色 "M"（带淡紫渐变与柔和投影）
function iconSample(u, v, res = ICON_MASTER) {
  // 背景：圆角方块 + 左上→右下对角渐变（#6D7CFF → #4F46E5，与 Web 端品牌紫一致）
  const bgA = cover(sdRoundRect(u, v, 0.5, 0.5, 0.4023, 0.4023, 0.181), res)
  if (bgA <= 0) return [0, 0, 0, 0]
  const t = clamp01(u * 0.35 + v * 0.65)
  let col = [
    109 + (79 - 109) * t,
    124 + (70 - 124) * t,
    255 + (229 - 255) * t,
    bgA * 255,
  ]
  // 顶部径向柔光（提亮 M 周边区域，增加体积感）
  const gd = Math.hypot(u - 0.5, (v - 0.40) * 1.1)
  const glow = 0.26 * Math.exp(-(gd * gd) / (2 * 0.17 * 0.17))
  col = blendOver(col, [206, 201, 255, glow * bgA * 255])
  // M 投影：把字标整体上移取样，等效投影下移，深紫色低透明度
  const shA = clamp01(0.5 - mdist(u, v - 0.015) * res) * 0.32
  if (shA > 0) col = blendOver(col, [26, 20, 92, shA * bgA * 255])
  // M 本体：白 → 淡紫 的垂直渐变，干净醒目
  const mA = clamp01(0.5 - mdist(u, v) * res)
  if (mA > 0) {
    const mt = clamp01((v - 0.360) / 0.285)
    col = blendOver(col, [
      255 + (226 - 255) * mt,
      255 + (223 - 255) * mt,
      255,
      mA * bgA * 255,
    ])
  }
  return col
}

// 主图渲染：归一化坐标逐像素取样（cover() 负责像素级抗锯齿）
function renderIconMaster() {
  const buf = Buffer.alloc(ICON_MASTER * ICON_MASTER * 4)
  for (let y = 0; y < ICON_MASTER; y++) {
    const v = (y + 0.5) / ICON_MASTER
    for (let x = 0; x < ICON_MASTER; x++) {
      const u = (x + 0.5) / ICON_MASTER
      const [r, g, b, a] = iconSample(u, v)
      const o = (y * ICON_MASTER + x) * 4
      buf[o] = r; buf[o + 1] = g; buf[o + 2] = b; buf[o + 3] = a
    }
  }
  return buf
}

async function generateIconset(dir) {
  const master = renderIconMaster()
  await fsp.mkdir(dir, { recursive: true })
  const sizes = [16, 32, 64, 128, 256, 512, 1024]
  for (const size of sizes) {
    const ss = ICON_MASTER / size
    const out = Buffer.alloc(size * size * 4)
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        let r = 0, g = 0, b = 0, a = 0
        for (let sy = 0; sy < ss; sy++) {
          for (let sx = 0; sx < ss; sx++) {
            const o = ((y * ss + sy) * ICON_MASTER + (x * ss + sx)) * 4
            r += master[o]; g += master[o + 1]; b += master[o + 2]; a += master[o + 3]
          }
        }
        const n = ss * ss
        const oo = (y * size + x) * 4
        out[oo] = r / n; out[oo + 1] = g / n; out[oo + 2] = b / n; out[oo + 3] = a / n
      }
    }
    // iconset 命名：16/32/128/256/512 各配 @2x；64 即 32@2x、1024 即 512@2x
    const file =
      size === 16 ? 'icon_16x16.png' :
      size === 32 ? 'icon_16x16@2x.png' :
      size === 64 ? 'icon_32x32.png' :
      size === 128 ? 'icon_32x32@2x.png' :
      size === 256 ? 'icon_128x128.png' :
      size === 512 ? 'icon_128x128@2x.png' :
      'icon_512x512@2x.png'
    await fsp.writeFile(path.join(dir, file), encodePng(size, size, out))
  }
}

function macInfoPlist(version) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>ModelDock</string>
  <key>CFBundleDisplayName</key>
  <string>ModelDock</string>
  <key>CFBundleExecutable</key>
  <string>ModelDock</string>
  <key>CFBundleIdentifier</key>
  <string>com.obsidiantrine.modeldock</string>
  <key>CFBundleVersion</key>
  <string>${version}</string>
  <key>CFBundleShortVersionString</key>
  <string>${version}</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleIconFile</key>
  <string>modeldock</string>
  <key>LSMinimumSystemVersion</key>
  <string>13.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>LSApplicationCategoryType</key>
  <string>public.app-category.developer-tools</string>
</dict>
</plist>
`
}

async function buildMacApp(target) {
  const appName = 'ModelDock.app'
  const appPath = path.join(RELEASE, appName)
  await fsp.rm(appPath, { recursive: true, force: true })
  const contents = path.join(appPath, 'Contents')
  await fsp.mkdir(path.join(contents, 'MacOS'), { recursive: true })
  await fsp.mkdir(path.join(contents, 'Resources'), { recursive: true })

  await fsp.writeFile(path.join(contents, 'Info.plist'), macInfoPlist(BUILD_VERSION))

  // SEA 二进制改名 ModelDock：isSEA() 按 basename 前缀（大小写不敏感）判定，仍命中
  const binName = `modeldock-${target}${PLATFORMS[target].ext}`
  const exeInApp = path.join(contents, 'MacOS', 'ModelDock')
  await fsp.copyFile(path.join(RELEASE, binName), exeInApp)
  await fsp.chmod(exeInApp, 0o755)

  try {
    const iconset = path.join(DIST, 'modeldock.iconset')
    await generateIconset(iconset)
    run(`iconutil -c icns "${iconset}" -o "${path.join(contents, 'Resources', 'modeldock.icns')}"`)
    log(`  ✓ 应用图标已生成`)
  } catch (e) {
    warn(`    ! 图标生成失败（${String(e.message).split('\n')[0]}），app 将使用系统默认图标`)
  }

  // 菜单栏托盘（swiftc 编译，仅 macOS 主机；CI runner 自带 Xcode）。失败优雅降级：
  // 没有 tray 不影响主程序，launchGui 侧按「托盘文件是否存在」决定是否拉起。
  // 目标架构随 target（intel 机型装 x64 包，托盘二进制必须同架构）
  try {
    const traySrc = path.join(ROOT, 'scripts', 'tray', 'ModelDockTray.swift')
    const trayOut = path.join(contents, 'MacOS', 'ModelDockTray')
    const swiftTarget = PLATFORMS[target].arch === 'arm64' ? 'arm64-apple-macos13.0' : 'x86_64-apple-macos13.0'
    run(`swiftc -O -target ${swiftTarget} "${traySrc}" -o "${trayOut}"`)
    await fsp.chmod(trayOut, 0o755)
    // 嵌套二进制必须先单独签名：x86_64 无链接器自动签名（arm64 有），未签名的托盘
    // 会让整包 codesign 失败且被下方 catch 吞掉——DMG 装机后被判「已损坏」（v1.1.0 Intel 机实测）
    run(`codesign --force --sign - "${trayOut}"`)
    log(`  ✓ 菜单栏托盘已编译并签名`)
  } catch (e) {
    warn(`    ! 托盘编译/签名失败（${String(e.message).split('\n')[0]}），本包不含菜单栏托盘`)
  }

  // ad-hoc 整体重签：嵌套二进制已各自签名，包结构组装完需整体重签（Apple Silicon 必需）。
  // 此步失败绝不能吞——签名残缺的 app 被 macOS 判「已损坏」，比缺签名严重得多；
  // 用 throw 而非 err()：让 main 的 finally 先还原 version 文件再退出
  try {
    run(`codesign --force --sign - "${appPath}"`)
  } catch (e) {
    throw new Error(`codesign 整包签名失败，产物将被 macOS 判「已损坏」：${String(e.message).split('\n')[0]}`)
  }
  log(`  ✓ ${appName}`)
  return appPath
}

async function buildDmg(target, appPath) {
  const dmgName = `modeldock-${BUILD_VERSION}-${target}.dmg`
  const dmgPath = path.join(RELEASE, dmgName)
  const rwPath = path.join(RELEASE, '_dmg-layout-rw.dmg')
  const staging = path.join(RELEASE, '_dmg-staging')
  const volname = `ModelDock ${BUILD_VERSION}`

  await fsp.rm(staging, { recursive: true, force: true })
  await fsp.mkdir(staging, { recursive: true })
  await fsp.cp(appPath, path.join(staging, 'ModelDock.app'), { recursive: true })
  await fsp.chmod(path.join(staging, 'ModelDock.app', 'Contents', 'MacOS', 'ModelDock'), 0o755)
  // 拖拽安装的右侧目标：指向系统 Applications 的符号链接
  await fsp.symlink('/Applications', path.join(staging, 'Applications'), 'dir')
  // 窗口背景箭头图（.background 点目录 Finder 默认隐藏）
  await fsp.mkdir(path.join(staging, '.background'), { recursive: true })
  await fsp.writeFile(path.join(staging, '.background', 'bg.png'), renderDmgBackground())

  // 残留同名卷会顶掉挂载点（新卷落到 " 1" 后缀路径），先清掉
  try { run(`hdiutil detach "/Volumes/${volname}" -force || true`, { stdio: 'ignore' }) } catch { /* 无挂载 */ }

  // 1) 可读写中转镜像（排版需要往卷里写 .DS_Store）→ 2) Finder 排版 → 3) 转压缩 UDZO
  await fsp.rm(rwPath, { force: true })
  try {
    run(`hdiutil create -volname "${volname}" -srcfolder "${staging}" -fs HFS+ -format UDRW -size 500m "${rwPath}"`)
    run(`hdiutil attach "${rwPath}" -quiet -nobrowse`)

    // Finder 排版偶发失败（首次 AppleEvents 握手超时），重试；全部失败则回落素版外观
    const layoutScript = path.join(RELEASE, '_dmg-layout.applescript')
    await fsp.writeFile(layoutScript, dmgLayoutAppleScript(volname))
    let ok = false
    for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
      try {
        run(`sleep ${attempt - 1} && osascript "${layoutScript}"`)
        ok = true
      } catch {
        warn(`    ! Finder 布局第 ${attempt}/3 次尝试失败${attempt < 3 ? '，重试' : '——DMG 回落素版外观（不影响安装）'}`)
      }
    }
    await fsp.rm(layoutScript, { force: true })
    // .DS_Store 落盘需要时间，过快 detach 会丢排版
    run('sleep 4')
    try { run(`hdiutil detach "/Volumes/${volname}" -force`) } catch { /* 已弹出 */ }
    run(`hdiutil convert "${rwPath}" -format UDZO -imagekey zlib-level=9 -o "${dmgPath}" -ov`)
  } finally {
    await fsp.rm(rwPath, { force: true })
    await fsp.rm(staging, { recursive: true, force: true })
    try { run(`hdiutil detach "/Volumes/${volname}" -force || true`, { stdio: 'ignore' }) } catch { /* 已弹出 */ }
  }
  const mb = ((await fsp.stat(dmgPath)).size / 1024 / 1024).toFixed(1)
  log(`  ✓ ${dmgName} (${mb} MB)`)
}

// DMG 窗口排版：680×440 图标视图，左 app 右 Applications，背景箭头图指引拖拽方向。
// 坐标为图标中心点；背景图按 2x（1360×880）绘制保证 Retina 清晰，并标 144dpi（见 renderDmgBackground）。
const DMG_LAYOUT = {
  width: 680, height: 440,
  iconSize: 128,
  appPos: { x: 170, y: 205 },      // 左：ModelDock.app
  appsPos: { x: 510, y: 205 },     // 右：Applications
  hintTopPt: 300,                  // 箭头下方提示语顶边（图标名标签底 ≈291pt，留 9pt 间距）
}

function dmgLayoutAppleScript(volname) {
  const { width, height, iconSize, appPos, appsPos } = DMG_LAYOUT
  return `tell application "Finder"
  tell disk "${volname}"
    open
    set current view of container window to icon view
    set toolbar visible of container window to false
    set statusbar visible of container window to false
    set the bounds of container window to {400, 100, ${400 + width}, ${100 + height}}
    set viewOptions to the icon view options of container window
    set arrangement of viewOptions to not arranged
    set icon size of viewOptions to ${iconSize}
    set text size of viewOptions to 14
    set background picture of viewOptions to file ".background:bg.png"
    set position of item "ModelDock.app" of container window to {${appPos.x}, ${appPos.y}}
    set position of item "Applications" of container window to {${appsPos.x}, ${appsPos.y}}
    close
    open
    update without registering applications
  end tell
end tell
`
}

// 背景箭头：灰白色圆头箭头指向右侧 Applications（1:1 渲染，SDF 抗锯齿按像素计）
function sdTriangle(px, py, a, b, c) {
  const e = [
    [b[0] - a[0], b[1] - a[1]],
    [c[0] - b[0], c[1] - b[1]],
    [a[0] - c[0], a[1] - c[1]],
  ]
  const v = [
    [px - a[0], py - a[1]],
    [px - b[0], py - b[1]],
    [px - c[0], py - c[1]],
  ]
  let dist = Infinity
  const cross = []
  for (let i = 0; i < 3; i++) {
    const t = Math.max(0, Math.min(1, (v[i][0] * e[i][0] + v[i][1] * e[i][1]) / (e[i][0] ** 2 + e[i][1] ** 2)))
    const dx = v[i][0] - e[i][0] * t
    const dy = v[i][1] - e[i][1] * t
    dist = Math.min(dist, Math.hypot(dx, dy))
    cross.push(e[i][0] * v[i][1] - e[i][1] * v[i][0])
  }
  const inside = (cross[0] >= 0 && cross[1] >= 0 && cross[2] >= 0) || (cross[0] <= 0 && cross[1] <= 0 && cross[2] <= 0)
  return inside ? -dist : dist
}

// 提示语资产：文案固定，预渲染成透明底 2x PNG 提交进仓库（scripts/assets/dmg-hint.png，28px 系统字体），
// 构建期只做像素混合——本机/CI 的动态文字渲染（JXA/AppKit）行为不一且版本敏感，不进构建链。
// 改文案需重新生成该资产（swift + AppKit 渲染 NSAttributedString 导出 PNG，尺寸随内容自定）。
const DMG_HINT_PNG_PATH = path.join(ROOT, 'scripts', 'assets', 'dmg-hint.png')

// 最小 PNG 解码：仅供读取仓库内固定资产，支持 8bit 非隔行 RGBA/RGB/调色板 + 全部 5 种行过滤
function decodePng(input) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  if (input.length < 8 || !input.subarray(0, 8).equals(sig)) throw new Error('不是 PNG 文件')
  let width = 0, height = 0, colorType = 0, interlace = 0
  let palette = null, trns = null
  const idat = []
  let off = 8
  while (off + 8 <= input.length) {
    const len = input.readUInt32BE(off)
    const type = input.toString('ascii', off + 4, off + 8)
    const data = input.subarray(off + 8, off + 8 + len)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      if (data[8] !== 8) throw new Error(`不支持的位深 ${data[8]}`)
      colorType = data[9]
      interlace = data[12]
    } else if (type === 'PLTE') palette = data
    else if (type === 'tRNS') trns = data
    else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    off += 12 + len
  }
  if (!width || !height) throw new Error('PNG 缺少 IHDR')
  if (interlace) throw new Error('不支持隔行 PNG')
  const bpp = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 3 ? 1 : 0
  if (!bpp) throw new Error(`不支持的色彩类型 ${colorType}`)
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const stride = width * bpp
  const recon = Buffer.alloc(stride * height)
  const paeth = (a, b, c) => {
    const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
  }
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const rowIn = y * (stride + 1) + 1
    const rowOut = y * stride
    for (let x = 0; x < stride; x++) {
      const left = x >= bpp ? recon[rowOut + x - bpp] : 0
      const up = y > 0 ? recon[rowOut - stride + x] : 0
      const ul = y > 0 && x >= bpp ? recon[rowOut - stride + x - bpp] : 0
      let v = raw[rowIn + x]
      if (filter === 1) v += left
      else if (filter === 2) v += up
      else if (filter === 3) v += (left + up) >> 1
      else if (filter === 4) v += paeth(left, up, ul)
      recon[rowOut + x] = v & 0xff
    }
  }
  const rgba = Buffer.alloc(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    const o = i * 4
    if (colorType === 6) recon.copy(rgba, o, i * 4, i * 4 + 4)
    else if (colorType === 2) {
      rgba[o] = recon[i * 3]; rgba[o + 1] = recon[i * 3 + 1]; rgba[o + 2] = recon[i * 3 + 2]; rgba[o + 3] = 255
    } else {
      const idx = recon[i]
      rgba[o] = palette[idx * 3]; rgba[o + 1] = palette[idx * 3 + 1]; rgba[o + 2] = palette[idx * 3 + 2]
      rgba[o + 3] = trns && idx < trns.length ? trns[idx] : 255
    }
  }
  return { width, height, rgba }
}

// src(RGBA) 按 source-over 混合进 dst 的 (dx,dy) 处（2x 像素坐标），越界部分裁掉
function blendRgba(dst, W, H, src, sw, sh, dx, dy) {
  for (let y = 0; y < sh; y++) {
    const ty = dy + y
    if (ty < 0 || ty >= H) continue
    for (let x = 0; x < sw; x++) {
      const tx = dx + x
      if (tx < 0 || tx >= W) continue
      const so = (y * sw + x) * 4
      const sa = src[so + 3] / 255
      if (sa <= 0) continue
      const o = (ty * W + tx) * 4
      const da = dst[o + 3] / 255
      const oa = sa + da * (1 - sa)
      if (oa <= 0) continue
      dst[o] = Math.round((src[so] * sa + dst[o] * da * (1 - sa)) / oa)
      dst[o + 1] = Math.round((src[so + 1] * sa + dst[o + 1] * da * (1 - sa)) / oa)
      dst[o + 2] = Math.round((src[so + 2] * sa + dst[o + 2] * da * (1 - sa)) / oa)
      dst[o + 3] = Math.round(oa * 255)
    }
  }
}

function renderDmgBackground() {
  const W = DMG_LAYOUT.width * 2, H = DMG_LAYOUT.height * 2
  const buf = Buffer.alloc(W * H * 4)
  const y = DMG_LAYOUT.appPos.y * 2
  const x0 = (DMG_LAYOUT.appPos.x + DMG_LAYOUT.iconSize / 2) * 2 + 24          // app 图标右缘起
  const x1 = (DMG_LAYOUT.appsPos.x - DMG_LAYOUT.iconSize / 2) * 2 - 24         // Applications 左缘止
  const shaft = (px, py) => sdRoundRect(px, py, (x0 + x1) / 2 - 40, y, (x1 - x0) / 2 - 45, 15, 13)
  const head = (px, py) => sdTriangle(px, py, [x1 - 105, y - 56], [x1 - 105, y + 56], [x1, y])
  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
      const d = Math.min(shaft(px, py), head(px, py)) - 4
      const a = clamp01(0.5 - d)
      if (a > 0) {
        const o = (py * W + px) * 4
        buf[o] = 0x9a; buf[o + 1] = 0xa1; buf[o + 2] = 0xad; buf[o + 3] = a * 255
      }
    }
  }
  // 提示语：箭头下方居中一行；缺资产只少一行字，不阻断打包
  try {
    const hint = decodePng(fs.readFileSync(DMG_HINT_PNG_PATH))
    blendRgba(buf, W, H, hint.rgba, hint.width, hint.height, Math.round((W - hint.width) / 2), DMG_LAYOUT.hintTopPt * 2)
  } catch (e) {
    warn(`    ! DMG 背景提示语未混合（不影响安装）：${e.message}`)
  }
  return encodePng(W, H, buf, 5669)
}

async function packageMacDmg() {
  const darwinTargets = targets.filter(t => PLATFORMS[t].os === 'darwin')
  if (darwinTargets.length === 0) return
  if (process.platform !== 'darwin') {
    warn('跳过 DMG：.dmg 安装镜像仅能在 macOS 上制作（CI 的 darwin job 会自动补上）')
    return
  }
  log('Step 5.7/6 — 打 macOS DMG 安装镜像')
  for (const target of darwinTargets) {
    const appPath = await buildMacApp(target)
    await buildDmg(target, appPath)
    // 自更新用整包 tar.gz（Sparkle 风格：程序化换新 bundle；DMG 只留给首次人工安装）
    const appTarName = `modeldock-${BUILD_VERSION}-${target}-app.tar.gz`
    run(`tar czf "${path.join(RELEASE, appTarName)}" -C "${RELEASE}" "ModelDock.app"`)
    log(`  ✓ ${appTarName}（自更新用整包）`)
  }
}

// Step 5.8: Windows 安装向导
/**
 * Inno Setup 编译 setup.exe：可选安装路径、开始菜单/桌面快捷方式、写入用户 PATH、
 * 卸载联动 `modeldock uninstall --yes --purge`（详见 scripts/installer.iss）。
 * 仅 Windows 可编译（CI 的 windows-latest 预装 ISCC，本地 mac 构建跳过并提示）。
 * 图标复用 .app 同款 SDF 渲染直接产出各尺寸 modeldock.ico。
 */
async function packageWinSetup() {
  if (!targets.includes('win32-x64')) return
  log('Step 5.8/6 — Windows 安装向导（Inno Setup）')
  await generateIco(path.join(RELEASE, 'modeldock.ico'))
  log('  ✓ modeldock.ico')

  // Windows 托盘（C# WinForms NotifyIcon）：csc 随 .NET Framework 预装于所有 Win10/11。
  // 失败优雅降级：没有 tray 不影响主程序，cli.ts 按「托盘文件是否存在」决定是否拉起
  try {
    const windir = process.env.WINDIR ?? 'C:\\Windows'
    const cscCandidates = [
      `${windir}\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe`,
      `${windir}\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe`,
    ]
    const csc = cscCandidates.find((p) => fs.existsSync(p))
    if (!csc) throw new Error('未找到 csc.exe（.NET Framework 4.x）')
    const traySrc = path.join(ROOT, 'scripts', 'tray', 'ModelDockTray.cs')
    const trayOut = path.join(RELEASE, 'ModelDockTray.exe')
    // /win32manifest 带 PerMonitorV2 DPI 声明：缺省时进程 DPI-unaware，Win11 125%/150% 缩放整窗发糊
    const trayManifest = path.join(ROOT, 'scripts', 'tray', 'ModelDockTray.manifest')
    run(`"${csc}" /nologo /target:winexe /out:"${trayOut}" /win32manifest:"${trayManifest}" /win32icon:"${path.join(RELEASE, 'modeldock.ico')}" /r:System.Windows.Forms.dll /r:System.Drawing.dll "${traySrc}"`)
    log('  ✓ Windows 托盘已编译')
  } catch (e) {
    warn(`    ! 托盘编译失败（${String(e.message).split('\n')[0]}），本包不含 Windows 托盘`)
  }

  if (process.platform !== 'win32') {
    warn('跳过 setup.exe：Inno Setup 仅能在 Windows 上编译（CI 的 windows job 会自动补上）')
    return
  }
  const iscc = 'C:\\Program Files (x86)\\Inno Setup 6\\ISCC.exe'
  if (!fs.existsSync(iscc)) err(`未找到 Inno Setup（${iscc}）。可先执行: choco install innosetup -y`)
  runInnoSetup(iscc)
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** Inno Setup 编译（带杀软抢占重试）。Windows Defender 实时保护会在 Setup.exe 落盘瞬间
 *  扫描并短暂锁定文件，ISCC 随后的图标资源更新（EndUpdateResource）打不开文件 → 错误 110
 *  （用户 2026-10-02 实测；CI runner 无杀软故不受影响）。该失败是瞬时的：清理半成品退避重试；
 *  重试耗尽给出 Defender 排除项的可操作指引。 */
function runInnoSetup(iscc) {
  const outputDir = path.join(ROOT, 'release')
  const maxAttempts = 3
  for (let attempt = 1; ; attempt++) {
    const r = spawnSync(iscc, [`/DAppVersion=${BUILD_VERSION}`, 'scripts/installer.iss'], { cwd: ROOT, encoding: 'utf8' })
    if (r.error) err(`Inno Setup 启动失败：${r.error.message}`)
    // 与原 stdio:'inherit' 行为一致：ISCC 输出原样透传（含进度与错误详情）
    if (r.stdout) process.stdout.write(r.stdout)
    if (r.stderr) process.stderr.write(r.stderr)
    if (r.status === 0) return
    const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`
    const resourceLock = /EndUpdateResource failed|Resource update error/.test(out)
    if (!resourceLock || attempt >= maxAttempts) {
      if (resourceLock) {
        err(
          `Inno Setup 的资源更新连续 ${attempt} 次被杀毒软件抢占（错误 110）。\n` +
          `  解决：把构建目录加入杀软排除项后重跑，例如（管理员 PowerShell）：\n` +
          `    Add-MpPreference -ExclusionPath "${outputDir}"\n` +
          `    Add-MpPreference -ExclusionPath "${ROOT}"\n` +
          `  或临时关闭实时保护后重跑。`
        )
      }
      process.exit(r.status ?? 1)
    }
    warn(`Inno 资源更新被杀毒软件抢占（第 ${attempt}/${maxAttempts} 次），清理半成品后重试…`)
    sleepSync(2000)
    // 清掉可能被锁的半成品 setup exe，避免下次编译受旧文件干扰
    try {
      for (const f of fs.readdirSync(outputDir)) {
        if (/win32-x64-setup/i.test(f)) fs.rmSync(path.join(outputDir, f), { force: true })
      }
    } catch {}
  }
}

/** ICO 打包：PNG 位图条目（Windows Vista+ 支持），各尺寸直接按目标分辨率采样渲染 */
async function generateIco(outPath) {
  const sizes = [16, 32, 48, 64, 256]
  const pngs = []
  for (const size of sizes) {
    const buf = Buffer.alloc(size * size * 4)
    for (let y = 0; y < size; y++) {
      const v = (y + 0.5) / size
      for (let x = 0; x < size; x++) {
        const u = (x + 0.5) / size
        const [r, g, b, a] = iconSample(u, v, size)
        const o = (y * size + x) * 4
        buf[o] = r; buf[o + 1] = g; buf[o + 2] = b; buf[o + 3] = a
      }
    }
    pngs.push(encodePng(size, size, buf))
  }
  const header = Buffer.alloc(6)
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(sizes.length, 4)
  const entries = []
  let offset = 6 + 16 * sizes.length
  sizes.forEach((size, i) => {
    const e = Buffer.alloc(16)
    e[0] = size >= 256 ? 0 : size // 0 即 256
    e[1] = e[0]
    e.writeUInt16LE(1, 4)  // planes
    e.writeUInt16LE(32, 6) // bpp
    e.writeUInt32LE(pngs[i].length, 8)
    e.writeUInt32LE(offset, 12)
    offset += pngs[i].length
    entries.push(e)
  })
  await fsp.writeFile(outPath, Buffer.concat([header, ...entries, ...pngs]))
}

// Windows exe 资源嵌入（图标 + 版本信息）
/**
 * 用 resedit（纯 JS PE 资源编辑器，devDependency 仅构建期使用，不违反纯 JS 依赖约束）
 * 把 generateIco() 的图标与版本信息写入 exe 资源区。
 * node.exe 自带签名 → NtExecutable.from 需 ignoreCert；输出始终为未签名二进制
 * （postject 注入后原签名本已失效，与现状一致）。
 * resedit 官方不建议原地读写同一文件，故先写临时文件再 rename。
 * 调用时机必须在 postject 注入之后（见 buildExecutables 内注释）。
 */
async function embedWinResources(exePath, icoPath) {
  const ResEdit = await import('resedit')

  const exe = ResEdit.NtExecutable.from(await fsp.readFile(exePath), { ignoreCert: true })
  const res = ResEdit.NtExecutableResource.from(exe)

  // 图标：替换 node.exe 自带图标组（lang 沿用原值；无图标组时按 ID 1 / en-US 新建）
  const iconFile = ResEdit.Data.IconFile.from(await fsp.readFile(icoPath))
  const icons = iconFile.icons.map((item) => item.data)
  const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries)
  if (groups.length > 0) {
    for (const g of groups) {
      ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, g.id, g.lang, icons)
    }
  } else {
    ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, 1, 1033, icons)
  }

  // 版本信息：文件属性里显示 ModelDock 而不是 Node.js
  const [major = 0, minor = 0, patch = 0] = String(BUILD_VERSION ?? '0.0.0').split('.').map((s) => parseInt(s, 10) || 0)
  for (const vi of ResEdit.Resource.VersionInfo.fromEntries(res.entries)) {
    const langs = vi.getAllLanguagesForStringValues()
    const lang = langs[0]?.lang ?? 1033
    vi.setFileVersion(major, minor, patch, 0, lang)
    vi.setProductVersion(major, minor, patch, 0, lang)
    for (const l of langs) {
      vi.setStringValues(l, {
        FileDescription: 'ModelDock — 本地模型配置托管中心 + API 网关',
        ProductName: 'ModelDock',
        OriginalFilename: 'modeldock.exe',
        InternalName: 'modeldock',
      })
    }
    vi.outputToResourceEntries(res.entries)
  }

  res.outputResource(exe)
  const tmpPath = `${exePath}.resedit`
  await fsp.writeFile(tmpPath, Buffer.from(exe.generate()))
  await fsp.rename(tmpPath, exePath)
}

// Step 5.9: SHA256SUMS
/**
 * 校验名单只覆盖对外发布物（压缩包 / DMG / setup.exe / 自更新整包）；裸二进制不单独外发，不入册 */
async function writeSums() {
  const sums = []
  for (const target of targets) {
    const spec = PLATFORMS[target]
    const files = [`modeldock-${BUILD_VERSION}-${target}${spec.ext === '.exe' ? '.zip' : '.tar.gz'}`]
    if (spec.os === 'darwin') files.push(`modeldock-${BUILD_VERSION}-${target}.dmg`, `modeldock-${BUILD_VERSION}-${target}-app.tar.gz`)
    if (spec.os === 'win32') files.push(`modeldock-${BUILD_VERSION}-${target}-setup.exe`)
    for (const f of files) {
      const p = path.join(RELEASE, f)
      if (!fs.existsSync(p)) { warn(`  ! ${f} 缺失，未计入校验名单`); continue }
      sums.push({ file: f, sha256: sha256(await fsp.readFile(p)) })
    }
  }
  // CI 按 target 单独构建时带 target 后缀，避免多 job 产物同名互相覆盖；本地全量构建用统一文件名
  const sumsName = targetArg ? `SHA256SUMS-${targetArg}` : 'SHA256SUMS'
  const sumsContent = sums.map(s => `${s.sha256}  ${s.file}`).join('\n') + '\n'
  await fsp.writeFile(path.join(RELEASE, sumsName), sumsContent)
  log(`  ✓ ${sumsName}（${sums.length} 个发布物）`)
}

async function main() {
  // --ico-only：只生成 release/modeldock.ico（图标源码就在本脚本内，任何机器 clone 后零依赖可重建）
  if (args.includes('--ico-only')) {
    await fsp.mkdir(RELEASE, { recursive: true })
    await generateIco(path.join(RELEASE, 'modeldock.ico'))
    log(`✓ release/modeldock.ico 已生成（--ico-only，图标由 scripts/build-sea.mjs 内置 SDF 渲染，无需 Node 二进制/网络）`)
    return
  }

  log(`构建目标: ${targets.join(', ')}`)
  log(`当前平台: ${currentPlatform}\n`)

  const t0 = Date.now()
  let saved = null
  try {
    // Step 0: 从 git tag 同步版本号（构建后自动还原，不污染源码树）
    log('Step 0/6 — 从 git tag 同步版本号')
    saved = await syncVersionFromTag()
    BUILD_VERSION = saved?.version ?? JSON.parse(fs.readFileSync(PKG_JSON_PATH, 'utf8')).version

    await buildTS()
    await buildBundle()
    await buildBlob()
    await buildExecutables()

    // Step 6/6: npm tgz —— 必须在版本号还原前打包：还原后再 pack，文件名与包内
    // CLI 自报版本都会退回 package.json 里的旧值；SEA 中间产物不进包（files=["dist"]）
    if (packFlag) {
      log('Step 6/6 — npm tgz（npm pack）')
      for (const f of ['modeldock.blob', 'modeldock.bundle.cjs']) {
        await fsp.rm(path.join(DIST, f), { force: true })
      }
      run('npm pack --pack-destination release/')
    }

    const dt = ((Date.now() - t0) / 1000).toFixed(1)
    log(`\n✓ 全部完成 (${dt}s)，产物在 release/ 目录`)
  } finally {
    await restoreVersionFiles(saved)
    if (saved) log(`（已还原 src/version.ts 和 package.json 到构建前状态）`)
  }
}

main().catch(e => { err(e.message) })