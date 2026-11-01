#!/usr/bin/env node
/**
 * Release 产物一键验证——release.md「流程」步骤 5 的机器化执行器。
 *
 * 用法：node scripts/release-verify.mjs <版本> [--spot <target>]
 *   版本：1.6.0 或 v1.6.0（对应 tag v1.6.0 与资产名 modeldock-1.6.0-*）。
 *   --spot：抽包目标 darwin-arm64 | darwin-x64 | linux-arm64 | linux-x64（tar.gz 类）；
 *           下载 → SHA256 对账 → 解压核对包内单一可执行文件 modeldock；
 *           darwin 目标且主机为 darwin 时再跑 ./modeldock --version 核对版本号。
 *
 * 默认检查（不烧大流量）：
 *   1. Release 存在且非 draft（gh release view）
 *   2. 资产清点：11 个资产与期望清单一致（不多不少）
 *   3. SHA256SUMS 下载解析：恰好覆盖其余 10 个资产
 *   4. 正文对拍：以 CHANGELOG 版本段开头——release.yml 用同一 extract 脚本生成正文，
 *      generate_release_notes 会在其后追加 What's Changed，故用前缀匹配；占位正文判 ✗
 *
 * 退出码：存在 ✗（阻断项）→ 1，否则 0。⚠ 不改退出码，但须逐条过目。
 * 约束：零第三方依赖（纯 node:std）；下载自带重试（大陆网络常态抖动）；Windows 兼容
 * （tar 用系统自带 bsdtar/tar.exe，仅 --spot 用到；路径一律 path.join）。
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const spotIdx = args.indexOf('--spot')
const ver = String(args.find((a, i) => a !== '--spot' && i !== spotIdx + 1) || '').replace(/^v/, '')
const spot = spotIdx !== -1 ? String(args[spotIdx + 1] || '') : null
if (!/^\d+\.\d+\.\d+$/.test(ver) || (spotIdx !== -1 && !spot)) {
  console.error('用法：node scripts/release-verify.mjs <版本> [--spot darwin-arm64|darwin-x64|linux-arm64|linux-x64]')
  process.exit(1)
}
const tag = `v${ver}`

const results = []
const add = (status, name, detail = '') => results.push({ status, name, detail })
const norm = (s) => String(s).replace(/\r\n/g, '\n').trim()

// 下载自带重试：网络抖动是常态，关键对账缺输出必须补跑闭合，不留「应该没问题」。
// 走 node:https + family:4 而非 global fetch——undici 对大文件 CDN（GitHub objects / nodejs.org）
// 建连常超默认 10s connectTimeout（本机 darwin x64 实证，IPv6 黑洞时更甚），IPv4 直连 0.2-2.5s。
function httpsGet(url, redirects = 5) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { family: 4, timeout: 120_000 }, (res) => {
      const loc = res.headers.location
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && loc) {
        res.resume()
        if (redirects <= 0) { reject(new Error('重定向次数过多')); return }
        httpsGet(new URL(loc, url).href, redirects - 1).then(resolve, reject)
        return
      }
      if (res.statusCode !== 200) {
        res.resume()
        reject(new Error(`HTTP ${res.statusCode}`))
        return
      }
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve(Buffer.concat(chunks)))
      res.on('error', reject)
    })
    req.on('timeout', () => req.destroy(new Error('连接超时（120s）')))
    req.on('error', reject)
  })
}
async function fetchBuf(url, attempts = 4) {
  let lastErr
  for (let i = 1; i <= attempts; i++) {
    try {
      return await httpsGet(url)
    } catch (e) {
      lastErr = e
      if (i < attempts) await new Promise((res) => setTimeout(res, 2000 * i))
    }
  }
  throw lastErr
}

// 期望资产清单（与 release.yml 产物、release.md「流程」步骤 5 的 11 资产一致）
const tarTargets = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64']
const expectedAssets = []
for (const t of tarTargets) {
  expectedAssets.push(`modeldock-${ver}-${t}.tar.gz`)
  if (t.startsWith('darwin')) expectedAssets.push(`modeldock-${ver}-${t}-app.tar.gz`, `modeldock-${ver}-${t}.dmg`)
}
expectedAssets.push(`modeldock-${ver}-win32-x64.zip`, `modeldock-${ver}-win32-x64-setup.exe`, 'SHA256SUMS')

// repo slug：git remote 解析（git@github.com:OWNER/REPO.git 或 https://github.com/OWNER/REPO.git），失败回退主仓
const remote = spawnSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8', cwd: ROOT })
const slug =
  (remote.stdout || '').trim().match(/github\.com[:/](.+?)(?:\.git)?$/)?.[1] || 'ObsidianTrine/model_dock'

const gh = spawnSync('gh', ['release', 'view', tag, '--repo', slug, '--json', 'isDraft,body,assets'], {
  encoding: 'utf8',
  maxBuffer: 32 * 1024 * 1024,
})
if (gh.error || gh.status !== 0) {
  add('fail', `gh release view ${tag} 失败`,
    'Release 尚未创建（release.yml 还在构建？先 gh run watch 盯完）或 gh 未安装/未登录：\n' +
    ((gh.stderr || '') + (gh.error || '')).trim().slice(0, 400))
} else {
  let rel = null
  try { rel = JSON.parse(gh.stdout) } catch { /* 结构异常按缺失处理 */ }
  if (!rel) {
    add('fail', 'gh 输出解析失败', (gh.stdout || '').slice(0, 200))
  } else {
    if (rel.isDraft) add('warn', 'Release 处于 draft 状态', '资产可能仍在上传；稍后重跑本脚本复核')
    else add('pass', `Release ${tag} 已发布且非 draft`)

    // 资产清点：不多不少
    const actual = (rel.assets || []).map((a) => a.name).sort()
    const expect = [...expectedAssets].sort()
    const missing = expect.filter((n) => !actual.includes(n))
    const extra = actual.filter((n) => !expect.includes(n))
    if (!missing.length && !extra.length) add('pass', `资产清点 ${actual.length}/${expect.length} 齐全`)
    else {
      add('fail', '资产清单不符',
        (missing.length ? '缺失：\n' + missing.join('\n') : '') +
        (extra.length ? (missing.length ? '\n' : '') + '多余：\n' + extra.join('\n') : ''))
    }

    // SHA256SUMS 覆盖清点（先下载留作 --spot 对账参考；失败降级 warn 交人工）
    let sums = null
    try {
      const buf = await fetchBuf(`https://github.com/${slug}/releases/download/${tag}/SHA256SUMS`)
      sums = new Map()
      for (const line of norm(buf.toString('utf8')).split('\n')) {
        const hit = line.match(/^([0-9a-f]{64})\s+\*?(.+)$/)
        if (hit) sums.set(hit[2].trim(), hit[1])
      }
    } catch { /* 网络失败降级，见下方 warn */ }
    if (!sums || sums.size === 0) {
      add('warn', 'SHA256SUMS 下载/解析失败', `人工下载对账：https://github.com/${slug}/releases/download/${tag}/SHA256SUMS`)
    } else {
      const covered = [...sums.keys()].sort()
      const want = expect.filter((n) => n !== 'SHA256SUMS').sort()
      const missCov = want.filter((n) => !covered.includes(n))
      const extraCov = covered.filter((n) => !want.includes(n))
      if (!missCov.length && !extraCov.length) add('pass', `SHA256SUMS 覆盖 ${covered.length} 个资产，清单一致`)
      else {
        add('fail', 'SHA256SUMS 覆盖清单不符',
          (missCov.length ? '缺：' + missCov.join('、') : '') + (extraCov.length ? (missCov.length ? '；' : '') + '多：' + extraCov.join('、') : ''))
      }
    }

    // 正文对拍（前缀匹配：generate_release_notes 追加的 What's Changed 在版本段之后）
    const notes = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'extract-release-notes.mjs'), tag], { encoding: 'utf8' })
    const section = notes.status === 0 ? norm(notes.stdout) : ''
    const body = norm(rel.body || '')
    const placeholder = new RegExp(`^ModelDock v?${ver.replace(/\./g, '\\.')}\\b`).test(body) && /完整变更见 \[CHANGELOG\.md\]/.test(body)
    if (!section) {
      add('fail', 'CHANGELOG 版本段提取失败', 'extract-release-notes 无输出——先确认 CHANGELOG 已有该版本段（release-check 已查此项）')
    } else if (placeholder) {
      add('fail', 'Release 正文是占位文本', '「ModelDock vX.Y.Z + 链接」——版本段未进正文；按 release.md「出错回滚」删 tag 重打')
    } else if (body.startsWith(section)) {
      add('pass', 'Release 正文以 CHANGELOG 版本段开头（对拍一致）')
    } else {
      add('fail', 'Release 正文与 CHANGELOG 版本段不一致',
        `期望开头：\n${section.split('\n').slice(0, 3).join('\n')}\n实际开头：\n${body.split('\n').slice(0, 3).join('\n')}`)
    }

    // 抽包
    if (spot) await spotCheck(spot, sums, slug)
  }
}

async function spotCheck(target, sums, slug) {
  if (!tarTargets.includes(target)) {
    add('fail', `抽包目标 ${target} 不受支持`, '可选：' + tarTargets.join(' / ') + '（win32-x64 的 zip 不做解压抽查）')
    return
  }
  const name = `modeldock-${ver}-${target}.tar.gz`
  const url = `https://github.com/${slug}/releases/download/${tag}/${name}`
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modeldock-release-verify-'))
  try {
    let buf
    try {
      buf = await fetchBuf(url)
    } catch (e) {
      add('fail', `抽包下载失败：${name}`, String(e).slice(0, 200) + '\n下载自带 3 次重试，仍失败多为网络问题——重跑本脚本闭合')
      return
    }
    const want = sums ? sums.get(name) : null
    const got = createHash('sha256').update(buf).digest('hex')
    if (!want) add('warn', `${name} 无 SHA256SUMS 参考值`, '只做布局/版本核对，未做哈希对账')
    else if (want === got) add('pass', `${name} SHA256 对账一致`)
    else {
      add('fail', `${name} SHA256 对账不一致`, `期望 ${want}\n实际 ${got}\n疑似产物损坏或被替换——立即停下核查，勿放行发布`)
      return
    }

    const tgz = path.join(dir, name)
    fs.writeFileSync(tgz, buf)
    const tar = spawnSync('tar', ['-xzf', tgz, '-C', dir], { encoding: 'utf8' })
    if (tar.status !== 0) {
      add('fail', `${name} 解压失败`, ((tar.stderr || '') + (tar.error || '')).trim().slice(0, 200) + '\n本机无 tar 命令？（win10+ 自带 tar.exe）')
      return
    }
    const entries = fs.readdirSync(dir).filter((n) => n !== name)
    const bin = entries.find((n) => n === 'modeldock' && fs.statSync(path.join(dir, n)).isFile())
    const dirs = entries.filter((n) => { try { return fs.statSync(path.join(dir, n)).isDirectory() } catch { return true } })
    if (!bin) {
      add('fail', `${target} 包内缺入口 modeldock`, '实际：\n' + entries.join('\n'))
      return
    }
    if (dirs.length) {
      add('fail', `${target} 包内出现子目录`, '包内应全是平铺文件，实际：\n' + dirs.join('\n'))
      return
    }
    const others = entries.filter((n) => n !== 'modeldock')
    add('pass', `${target} 包内入口 modeldock 在位（无子目录）` +
      (others.length ? `；伴随文件：${others.join('、')}（托盘等辅助程序，属预期）` : '，包内仅此一文件'))
    if (process.platform === 'darwin' && target.startsWith('darwin')) {
      const run = spawnSync(path.join(dir, 'modeldock'), ['--version'], { encoding: 'utf8', timeout: 30_000 })
      const out = ((run.stdout || '') + (run.stderr || '')).trim()
      if (run.status === 0 && out.includes(ver)) add('pass', `${target} 抽包 --version 含 ${ver}，与 tag 一致`)
      else if (run.error) add('warn', `${target} 抽包运行失败（架构不兼容？）`, String(run.error).slice(0, 200) + '——换与本机架构一致的目标补抽')
      else add('fail', `${target} 抽包 --version 不符`, `期望含 ${ver}，实际：${out.slice(0, 200)}`)
    } else {
      add('warn', `${target} 抽包仅验布局未跑 --version`, `本机 ${process.platform} 不能直接运行 ${target} 产物；版本核对交由对应平台人工补验`)
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
  }
}

// 汇总（输出风格与 release-check.mjs 一致）
const icon = { pass: '✓', warn: '⚠', fail: '✗' }
console.log(`\n═══ Release 产物验证 ${tag} ═══`)
for (const r of results) {
  console.log(`${icon[r.status]} ${r.name}`)
  if (r.detail) console.log(`   ${r.detail.split('\n').join('\n   ')}`)
}
const fails = results.filter((r) => r.status === 'fail')
const warns = results.filter((r) => r.status === 'warn')
console.log(`\n${results.length - fails.length - warns.length} 过 / ${warns.length} 警告 / ${fails.length} 阻断`)
if (fails.length) {
  console.error('✗ 存在阻断项——Release 不可视为发布成功，按 release.md「出错回滚」处置')
  process.exit(1)
}
console.log(warns.length ? '⚠ 有警告项，逐条过目后发布闭环' : '✓ 全过，发布闭环')
