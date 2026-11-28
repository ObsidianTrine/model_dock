// agents 工具链类型检查门禁：跑 tsconfig.agents.json（allowJs + checkJs + noEmit），
// 把错误数与 typecheck-agents-baseline.json 比对——超基线即失败（新增回归），低于基线也失败
// （修好了要下调基线，否则棘轮会慢慢松掉）。本文件自身也在被检查范围内，改动后按脚本提示重测。
//
// 退出码：0 = 与基线一致；1 = 超基线 / 低于基线 / tsc 执行异常。
// 用法：npm run typecheck:agents
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

/** 仓库根（scripts/ 上一级） */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CONFIG = path.join(REPO_ROOT, 'tsconfig.agents.json')
const BASELINE = path.join(REPO_ROOT, 'typecheck-agents-baseline.json')

// 编译器归属：tsc 二进制是 TS 7（别名 @typescript/native7），`typescript` 别名装的是 TS 6
// JS API（供 typescript-eslint）。基线由前者测得，故显式定位它，不走 npx / .bin 包装。
// 别名不叫 @typescript/native：typescript-eslint 8.73+ 有同名 optional peer，npm10 会把
// 不满足范围的它重新解析装 nightly，lock 缺条目致 npm ci 必红；也不叫 typescript7 之类
// 排在 @typescript/old（TS6 内嵌真 typescript，同样声明 bin tsc）之后的名字，否则 .bin/tsc
// 归属被抢走，build 静默换成 TS6。
const TSC_BIN = path.join(
  path.dirname(createRequire(import.meta.url).resolve('@typescript/native7/package.json')),
  'bin',
  'tsc'
)

/**
 * 跑 tsc 并按错误码计数。多行错误的续行不含 `error TS`，不会被重复计入。
 * @returns {{ status: number | null, errors: string[], byCode: Record<string, number>, stderr: string }}
 */
function runTsc() {
  const res = spawnSync(process.execPath, [TSC_BIN, '-p', CONFIG, '--noEmit', '--pretty', 'false'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  })
  const lines = (res.stdout ?? '').split(/\r?\n/)
  const errors = lines.filter((l) => /error TS\d+/.test(l))
  /** @type {Record<string, number>} */
  const byCode = {}
  for (const line of errors) {
    const code = /error (TS\d+)/.exec(line)?.[1] ?? '(unknown)'
    byCode[code] = (byCode[code] ?? 0) + 1
  }
  return { status: res.status, errors, byCode, stderr: res.stderr ?? '' }
}

function main() {
  if (!fs.existsSync(TSC_BIN)) {
    console.error(`tsc 未安装（缺 ${TSC_BIN}），先 npm install`)
    return 1
  }
  /** @type {{ total: number, byCode: Record<string, number> }} */
  const baseline = JSON.parse(fs.readFileSync(BASELINE, 'utf8'))
  const { status, errors, byCode, stderr } = runTsc()
  const now = errors.length

  const codes = [...new Set([...Object.keys(byCode), ...Object.keys(baseline.byCode)])].sort()
  const deltaObjs = codes
    .map((code) => ({ code, now: byCode[code] ?? 0, was: baseline.byCode[code] ?? 0 }))
    .filter((d) => d.now !== d.was)
  const delta = deltaObjs.map((d) => `  ${d.code}: ${d.was} → ${d.now}（${d.now > d.was ? '+' : ''}${d.now - d.was}）`)

  // tsc 的合法退出码只有 0（无错误）与 1（有类型错误）；其余说明配置/执行出错
  if (status !== 0 && status !== 1) {
    console.error(`tsc 异常退出（status=${status}），不是「有类型错误」的正常路径：\n${stderr.slice(-1000)}`)
    return 1
  }

  if (now === baseline.total && delta.length === 0) {
    console.log(`typecheck:agents OK — ${now} 处存量错误，与基线一致（只降不升）`)
    return 0
  }

  if (now > baseline.total) {
    console.error(`typecheck:agents 失败 — 新增 ${now - baseline.total} 处错误（基线 ${baseline.total}，实测 ${now}）`)
    console.error(delta.join('\n'))
    console.error('\n修复：按下面输出的位置逐一修复；确属工具链/依赖升级导致的判定漂移，才改基线并在提交说明里写理由。')
    // 只列「计数上涨的错误码」对应的报错，避免被存量错误淹没
    const grown = new Set(deltaObjs.filter((d) => d.now > d.was).map((d) => d.code))
    const fresh = grown.size ? errors.filter((l) => [...grown].some((code) => l.includes(`error ${code}`))) : errors
    for (const line of fresh.slice(0, 40)) console.error(line)
    if (fresh.length > 40) console.error(`... 另有 ${fresh.length - 40} 条，完整输出见下方复现命令`)
    console.error(`\n复现：node node_modules/@typescript/native7/bin/tsc -p tsconfig.agents.json --noEmit --pretty false`)
    return 1
  }

  console.error(`typecheck:agents 失败 — 错误数降到 ${now}（基线 ${baseline.total}），基线陈旧`)
  console.error(delta.join('\n'))
  console.error(
    `\n修复：把 typecheck-agents-baseline.json 的 total 改为 ${now}、byCode 同步为下面这份实测值，棘轮才真正收紧：\n` +
      JSON.stringify(byCode, null, 2)
  )
  return 1
}

process.exitCode = main()
