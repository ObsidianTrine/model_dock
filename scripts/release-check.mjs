#!/usr/bin/env node
/**
 * 发布前机器门禁一键检查——docs/RELEASE_CHECKLIST.md §1 的执行器。
 *
 * 用法：node scripts/release-check.mjs <版本> [--skip-test]
 *   版本：1.2.0 或 v1.2.0（对应 CHANGELOG 的 ## [1.2.0] 段与 tag v1.2.0）；
 *   必须大于最近已发布 tag（semver 只增不减，与最近 tag 相等=重复发布同样阻断）
 *   --skip-test：跳过 npm test（测试刚在别处全绿时；build/audit 照常跑）
 *
 * 退出码：存在 ✗（阻断项）→ 1，否则 0。⚠（警告项）不改退出码，但必须逐条过目。
 *
 * 约束：零第三方依赖（纯 node:std）；Windows 兼容——npm 走 shell:true（.cmd 包装），
 * git 直接 spawn（git.exe 无需 shell），路径以脚本位置为锚，不写死分隔符。
 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const skipTest = args.includes('--skip-test')
const ver = String(args.find((a) => a !== '--skip-test') || '').replace(/^v/, '')
if (!/^\d+\.\d+\.\d+$/.test(ver)) {
  console.error('用法：node scripts/release-check.mjs <版本> [--skip-test]    // 版本形如 1.2.0')
  process.exit(1)
}
const tag = `v${ver}`

const results = []
const add = (status, name, detail = '') => results.push({ status, name, detail })
const MAXBUF = 32 * 1024 * 1024
const git = (gitArgs, opts = {}) => {
  const r = spawnSync('git', gitArgs, { encoding: 'utf8', maxBuffer: MAXBUF, cwd: ROOT, ...opts })
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() }
}
const npm = (npmArgs) =>
  spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', npmArgs, {
    encoding: 'utf8',
    maxBuffer: MAXBUF,
    cwd: ROOT,
    shell: process.platform === 'win32',
  })

// git 状态
const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).out
if (branch === 'develop') add('pass', '当前在 develop 分支')
else add('warn', `当前在 ${branch} 分支`, '脚本设计为在主仓库 develop 上跑；其他分支/worktree 的结果仅供参考')

const dirty = git(['status', '--porcelain']).out
if (dirty) add('fail', '工作区不干净', '先提交或还原：\n' + dirty.split('\n').slice(0, 10).join('\n'))
else add('pass', '工作区干净')

const ahead = git(['log', '--oneline', 'origin/develop..develop'])
if (ahead.code !== 0) add('warn', '无法比对 origin/develop（未 fetch？）', 'git fetch 后重跑，或人工确认 develop 已推送')
else if (ahead.out) add('warn', `develop 领先 origin/develop ${ahead.out.split('\n').length} 个提交`, '推送备份：git push origin develop')
else add('pass', 'develop 不领先 origin/develop')

const feats = git(['branch', '--list', 'feature/*']).out
if (feats) add('warn', '存在 feature 分支残留', '确认其中没有本版该发的内容：\n' + feats)
else add('pass', '无 feature 分支残留')

// main 分叉（防 hotfix 只合 main 不回 develop，下轮被冲掉）
const mainOnly = git(['log', '--no-merges', '--oneline', 'develop..main'])
if (mainOnly.code !== 0) add('warn', '无法比对 main 分叉', mainOnly.err)
else if (mainOnly.out) add('fail', 'main 存在 develop 缺失的内容提交', 'hotfix 必须回合 develop：\n' + mainOnly.out)
else add('pass', 'main 无 develop 缺失的内容提交')

// CHANGELOG
const changelog = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8')
const sec = spawnSync(process.execPath, ['scripts/extract-release-notes.mjs', '--check', tag], {
  encoding: 'utf8',
  maxBuffer: MAXBUF,
  cwd: ROOT,
})
if (sec.status === 0) add('pass', `CHANGELOG 已有 [${ver}] 版本段`)
else add('fail', `CHANGELOG 缺 [${ver}] 版本段`, ((sec.stdout || '') + (sec.stderr || '')).trim())

if (/^##\s*\[?未发布\]?/m.test(changelog)) add('fail', 'CHANGELOG 仍有「未发布」段', '按 release.md 步骤 1 归并进版本段')
else add('pass', 'CHANGELOG 无「未发布」残留')

if (new RegExp(`^\\[${ver}\\]:`, 'm').test(changelog)) add('pass', '版本链接表有对应行')
else add('fail', `版本链接表缺 [${ver}]: 行`, `文末补一行：[${ver}]: https://github.com/ObsidianTrine/model_dock/releases/tag/${tag}`)

// tag 占用
if (git(['tag', '-l', tag]).out) add('fail', `tag ${tag} 本地已存在`, '撤回过的版本号永不复用；确认后换号')
else add('pass', `tag ${tag} 本地未占用`)

const remote = git(['ls-remote', '--tags', 'origin', tag], { timeout: 30000 })
if (remote.code !== 0) add('warn', '远端 tag 查询失败（离线？）', `联网后人工复核：git ls-remote --tags origin ${tag}`)
else if (remote.out) add('fail', `tag ${tag} 远端已存在`, '公开发布过的版本号永不复用（v1.1.0 先例）')
else add('pass', `tag ${tag} 远端未占用`)

// 版本递增（semver 只增不减；与已发布 tag 相等=重复发布，同样阻断）
const latest = git(['describe', '--tags', '--abbrev=0'])
if (latest.code !== 0 || !/^v\d+\.\d+\.\d+$/.test(latest.out)) {
  add('warn', '无法确定最近已发布 tag', `${latest.err || 'git describe --tags --abbrev=0 无结果'}；develop 对齐 main 后可解（release.md 步骤 6）`)
} else {
  const oldV = latest.out.slice(1).split('.').map(Number)
  const newV = ver.split('.').map(Number)
  const newer = newV[0] > oldV[0] || (newV[0] === oldV[0] && (newV[1] > oldV[1] || (newV[1] === oldV[1] && newV[2] > oldV[2])))
  if (newer) add('pass', `版本号 ${ver} 大于最近已发布 ${oldV.join('.')}`)
  else add('fail', `版本号 ${ver} 不大于最近已发布 ${oldV.join('.')}`, 'semver 只增不减：新功能递增 minor、修复递增 patch；已发布/撤回的版本号永不复用（release.md「版本号怎么定」）')
}

// src 静态红线
const imp = git(['grep', '-n', 'import\\.meta', '--', 'src'])
if (imp.out) add('fail', 'src 出现 import.meta', 'SEA/esbuild 下不可用（AGENTS 硬约定）：\n' + imp.out.split('\n').slice(0, 5).join('\n'))
else add('pass', 'src 无 import.meta')

const portHit = git(['grep', '-nE', 'listen\\([\'" ]*(8687|8890)', '--', 'src'])
if (portHit.out) add('fail', 'src 监听受保护端口', '8687=生产 / 8890=dev，红线（AGENTS 端口约定）：\n' + portHit.out)
else add('pass', 'src 无受保护端口 listen')

const FAKE = /sk-abc|xxxx|example|placeholder/i
const secretProd = git(['grep', '-inE', 'sk-[A-Za-z0-9]{16,}|Bearer [A-Za-z0-9_\\-]{20,}', '--', 'src', 'scripts'])
const secretProdHits = secretProd.out.split('\n').filter((l) => l && !FAKE.test(l))
if (secretProdHits.length) add('fail', '疑似真实密钥入库（src/scripts）', '先轮换密钥再发布：\n' + secretProdHits.slice(0, 5).join('\n'))
else add('pass', '密钥扫描（src/scripts）无真实密钥')

const secretTest = git(['grep', '-inE', 'sk-[A-Za-z0-9]{16,}|Bearer [A-Za-z0-9_\\-]{20,}', '--', 'test'])
const secretTestHits = secretTest.out.split('\n').filter((l) => l && !FAKE.test(l))
if (secretTestHits.length) add('warn', `测试代码有 ${secretTestHits.length} 处疑似密钥`, '确认全部是假值：\n' + secretTestHits.slice(0, 5).join('\n'))
else add('pass', '密钥扫描（test）无真实密钥')

const todo = git(['grep', '-nE', '\\b(TODO|FIXME|XXX|HACK)\\b', '--', 'src'])
if (todo.out) add('warn', `src 有 ${todo.out.split('\n').length} 处 TODO/FIXME 残留`, '逐条裁决是否带病发布：\n' + todo.out.split('\n').slice(0, 8).join('\n'))
else add('pass', 'src 无 TODO/FIXME 残留')

// 慢门禁（已有阻断项时跳过，省 3 分钟）
const hardFails = () => results.filter((r) => r.status === 'fail').length
let testStats = null
if (skipTest) {
  add('warn', 'npm test 已跳过（--skip-test）', '确认测试刚在别处全绿')
} else if (hardFails() === 0) {
  console.error('…… npm test（约 2-3 分钟）')
  const t = npm(['test'])
  const out = (t.stdout || '') + (t.stderr || '')
  const files = out.match(/Test Files\s+(\d+) passed/)
  const tests = out.match(/Tests\s+(\d+) passed(?:\s*\|\s*(\d+) skipped)?/)
  if (t.status === 0 && tests) {
    testStats = { files: files ? +files[1] : 0, passed: +tests[1], skipped: tests[2] ? +tests[2] : 0 }
    add('pass', `npm test 全绿：${testStats.passed} 例${testStats.skipped ? `（另 ${testStats.skipped} 跳过）` : ''} / ${testStats.files} 文件`)
  } else {
    add('fail', 'npm test 未全绿', '修复后重跑；缺依赖先 npm ci。输出尾部：\n' + out.split('\n').slice(-15).join('\n'))
  }
}
if (hardFails() === 0) {
  const b = npm(['run', 'build'])
  if (b.status === 0) add('pass', 'npm run build（tsc）零错误')
  else add('fail', 'tsc 编译失败', ((b.stdout || '') + (b.stderr || '')).trim().split('\n').slice(-10).join('\n'))

  const a = npm(['audit', '--omit=dev'])
  const aOut = ((a.stdout || '') + (a.stderr || '')).trim()
  const aTail = aOut.split('\n').slice(-6).join('\n')
  if (a.status === 0) add('pass', 'npm audit --omit=dev 无漏洞')
  else if (/vulnerabilities/i.test(aOut)) add('fail', '依赖存在漏洞', aTail)
  else add('warn', 'audit 未得出结论（网络/证书问题），人工补跑', 'npm audit --omit=dev\n' + aTail)

  // 托管 Node 钉版健康（src/install/noderuntime.ts MANAGED_NODE_VERSION）：npm 客户端 engines 下限
  // 只升不降（gemini-cli 18→20 先例），钉版过期会让无系统 Node 的全新机器「装成功、跑就崩」
  // （npm 对 engines 默认只告 EBADENGINE 不拦）。engines 冲突=✗；补丁滞后/有更新 LTS 大版本=⚠。
  const pin = fs.readFileSync(path.join(ROOT, 'src', 'install', 'noderuntime.ts'), 'utf8')
    .match(/MANAGED_NODE_VERSION = '([\d.]+)'/)?.[1]
  const installCmdRe = /(?:command|posix|win32):\s*'(npm (?:i|install) -g [^']+)'/g
  const pkgs = new Set()
  for (const f of fs.readdirSync(path.join(ROOT, 'src', 'adapters')).filter((f) => f.endsWith('.ts'))) {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'adapters', f), 'utf8')
    for (const m of src.matchAll(installCmdRe)) pkgs.add(m[1].trim().split(/\s+/).pop())
  }
  if (!pin || pkgs.size === 0) {
    add('warn', '托管 Node 钉版核对未执行', `解析失败：钉版=${pin || '未找到'}，npm 客户端=${pkgs.size} 个——src 结构变了，人工核对 engines 与 MANAGED_NODE_VERSION`)
  } else {
    const vercmp = (a, b) => {
      const pa = a.split('.'), pb = b.split('.')
      for (let i = 0; i < 3; i++) {
        const d = (+pa[i] || 0) - (+pb[i] || 0)
        if (d) return d
      }
      return 0
    }
    const floors = []
    let viewErr = ''
    for (const pkg of pkgs) {
      const v = npm(['view', pkg, 'engines.node', '--registry=https://registry.npmmirror.com'])
      if (v.status !== 0) viewErr = ((v.stdout || '') + (v.stderr || '')).trim().split('\n').slice(-3).join('\n')
      floors.push({ pkg, req: ((v.stdout || '').trim().replace(/^"|"$/g, '')) })
    }
    if (viewErr) {
      add('warn', 'npm 客户端 engines 查询失败（网络/registry）', `人工核对 ${[...pkgs].join('、')} 的 engines 与钉版 ${pin}：\n${viewErr}`)
    } else {
      const over = []
      const noted = []
      for (const { pkg, req } of floors) {
        if (!req) continue // 未声明 engines：明细里已标注，无需人工跟进
        const m = req.match(/^(?:>=?|\^|~)?\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/)
        if (!m) { noted.push(`${pkg} engines「${req}」无法自动比对（人工核对）`); continue }
        const floor = `${m[1]}.${m[2] || 0}.${m[3] || 0}`
        if (vercmp(floor, pin) > 0) over.push(`${pkg} 要求 >=${floor}`)
      }
      if (over.length) {
        add('fail', 'npm 客户端 engines 超出托管 Node 钉版', `${over.join('；')}（钉版 ${pin}）——无系统 Node 的全新机器会装成功但跑不起来；升 src/install/noderuntime.ts 的 MANAGED_NODE_VERSION（与 SEA/CI 大版本同步）`)
      } else {
        add('pass', `npm 客户端 engines 全部满足托管 Node 钉版 ${pin}`,
          floors.map((f) => f.req ? `${f.pkg} ${f.req}` : `${f.pkg} 未声明`).join('、') + (noted.length ? '；' + noted.join('；') : ''))
      }
    }
    // 新鲜度：node dist 镜像 index 取「钉版大版本最新 patch」与「最新 LTS 大版本」；fetch 经 node 子进程，主脚本保持同步风格
    const idxScript = "fetch('https://cdn.npmmirror.com/binaries/node/index.json',{signal:AbortSignal.timeout(30000)})" +
      `.then(r=>r.json()).then(d=>{const lts=d.find(x=>x.lts);const maj=d.find(x=>x.version.startsWith('v${pin.split('.')[0]}.'));` +
      "process.stdout.write(JSON.stringify({newestLts:lts?{v:lts.version,name:lts.lts}:null,pinLatest:maj?maj.version:null}))}).catch(()=>process.exit(1))"
    const idx = spawnSync(process.execPath, ['-e', idxScript], { encoding: 'utf8', timeout: 60000 })
    if (idx.status !== 0) {
      add('warn', '托管 Node 钉版新鲜度未核对（node 镜像查询失败）', ((idx.stderr || '') + (idx.stdout || '')).trim().slice(0, 200))
    } else {
      let info = null
      try { info = JSON.parse(idx.stdout) } catch { /* 响应异常按未核对处理 */ }
      if (!info?.pinLatest || !info?.newestLts?.v) {
        add('warn', '托管 Node 钉版新鲜度未核对（镜像 index 结构异常）', (idx.stdout || '').slice(0, 200))
      } else {
        const stale = []
        if (vercmp(info.pinLatest.replace(/^v/, ''), pin) > 0) {
          stale.push(`钉版 ${pin} 非 ${pin.split('.')[0]} 线最新（${info.pinLatest}）——安全补丁滞后，发版顺手 bump`)
        }
        const ltsMajor = Number(String(info.newestLts.v).match(/^v(\d+)\./)?.[1])
        if (ltsMajor > Number(pin.split('.')[0])) {
          stale.push(`已有更新 LTS 大版本 ${info.newestLts.v}（${info.newestLts.name}）——评估随发版切换（与 SEA/CI/开发机大版本同步）`)
        }
        if (stale.length) add('warn', '托管 Node 钉版新鲜度', stale.join('\n'))
        else add('pass', `托管 Node 钉版 ${pin} 为当前线最新且是最新 LTS 大版本`)
      }
    }
  }
}

// 基线漂移（usage §10 的用例数 vs 实测）
if (testStats) {
  const usage = fs.readFileSync(path.join(ROOT, 'docs', 'usage.md'), 'utf8')
  // §10 两种合法形态：硬编码数字（校验漂移）或口径句（数字以 npm test 输出为准，无漂移面）；
  // 两者皆无才告警——口径化是 2026-10-28 引入的改进，检查不得把它当「缺基线」
  const m = usage.match(/测试 (\d+) 例全绿（(\d+) 个文件/)
  const calibrated = /用例数与文件数以\s*`?npm test`?\s*输出为准/.test(usage)
  if (m && (+m[1] !== testStats.passed || +m[2] !== testStats.files))
    add('warn', 'usage §10 基线漂移', `写的是 ${m[1]} 例 / ${m[2]} 文件，实测 ${testStats.passed} 例 / ${testStats.files} 文件——发布前更新 usage.md`)
  else if (m) add('pass', 'usage §10 基线数字与实测一致')
  else if (calibrated) add('pass', 'usage §10 基线口径句在位（数字以 npm test 实测为准）')
  else add('warn', 'usage.md §10 未找到基线句式', '按实测补写「测试 X 例全绿（Y 个文件：…）」，或改为「用例数与文件数以 npm test 输出为准」的口径句')
}

// 汇总
const icon = { pass: '✓', warn: '⚠', fail: '✗' }
console.log(`\n═══ 发布门禁 ${tag} ═══`)
for (const r of results) {
  console.log(`${icon[r.status]} ${r.name}`)
  if (r.detail) console.log(`   ${r.detail.split('\n').join('\n   ')}`)
}
const fails = results.filter((r) => r.status === 'fail')
const warns = results.filter((r) => r.status === 'warn')
console.log(`\n${results.length - fails.length - warns.length} 过 / ${warns.length} 警告 / ${fails.length} 阻断`)
if (fails.length) {
  console.error('✗ 存在阻断项——先修复上面全部 ✗ 再进入发布流程')
  process.exit(1)
}
console.log(warns.length ? '⚠ 有警告项，逐条过目后可继续发布流程' : '✓ 全过，可继续发布流程')
