#!/usr/bin/env node
// CLI 冷启动计时（perf-cold-start-imports）：spawn 同款入口多次，输出每次耗时与中位数。
// 用法：npm run bench:cold [-- <entry> <runs>]；缺省 entry=dist/cli.js（产品形态），runs=7。
// 计时口径：进程 wall time（spawnSync 全程），稳定前先跑 1 次预热不计入（OS 文件缓存一致化）。
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const entryArg = process.argv[2] ?? 'dist/cli.js'
const runs = Number(process.argv[3] ?? 7)
const entry = path.resolve(ROOT, entryArg)
if (!fs.existsSync(entry)) {
  console.error(`bench: 入口不存在 ${entry}（先 npm run build）`)
  process.exit(1)
}

const once = () => {
  const t0 = process.hrtime.bigint()
  const r = spawnSync(process.execPath, [entry, '--help'], { cwd: ROOT, encoding: 'utf8', timeout: 60_000 })
  const ms = Number(process.hrtime.bigint() - t0) / 1e6
  if (r.status !== 0) {
    console.error(`bench: 入口退出码 ${r.status}（stderr 前 500 字：${(r.stderr ?? '').slice(0, 500)}）`)
    process.exit(1)
  }
  return { ms, stdout: r.stdout ?? '' }
}

once() // 预热：不计入
const samples = []
let stdout0 = null
for (let i = 0; i < runs; i++) {
  const { ms, stdout } = once()
  if (stdout0 === null) stdout0 = stdout
  else if (stdout !== stdout0) console.error('bench: 警告——第 %d 次输出与前次不一致', i + 1)
  samples.push(ms)
}
const sorted = [...samples].sort((a, b) => a - b)
const median = runs % 2 ? sorted[(runs - 1) / 2] : (sorted[runs / 2 - 1] + sorted[runs / 2]) / 2
console.log(`entry=${entryArg} runs=${runs}`)
console.log(samples.map((m) => m.toFixed(1)).join(', '))
console.log(`median=${median.toFixed(1)}ms`)
// 输出指纹：改动前后 --help 逐字节一致性抽查用（sha256）
const h = (await import('node:crypto')).createHash('sha256').update(stdout0).digest('hex')
console.log(`help_sha256=${h}`)
