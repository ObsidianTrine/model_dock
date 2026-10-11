/**
 * 云端控制面入口（详设 §7.1/§7.7）：独立进程，`node dist/cloud/main.js --port 18443 --host 0.0.0.0 --data <dir>`。
 * 默认仅监听 127.0.0.1（部署时显式 --host 0.0.0.0）；首次启动生成 consoleToken 写 <data>/cloud.json（0600）并打印。
 * `--backup` 执行一次在线快照后退出（部署 runbook 的 crontab 每日备份用）。
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { randomToken, atomicWrite } from '../util/fsx.js'
import { t } from '../util/i18n.js'
import { homeDir } from '../util/paths.js'
import { CloudStore } from './store.js'
import { createCloudServer } from './server.js'

interface Args {
  port: number
  host: string
  dataDir: string
  backup: boolean
  rateLimit: number
}

export function parseArgs(argv: string[]): Args {
  // 数据目录经 homeDir() 派生（paths.ts 约定）：Windows 上 HOME 未设时 os.homedir() 仍回落
  // USERPROFILE，不会像旧的 `HOME ?? '.'` 一样静默写进 CWD 相对目录（DESIGN-06）。
  const args: Args = { port: 18443, host: '127.0.0.1', dataDir: path.join(homeDir(), '.modeldock-cloud'), backup: false, rateLimit: 60 }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = (): string => argv[++i] ?? ''
    if (a === '--port') args.port = Number(next())
    else if (a === '--host') args.host = next()
    else if (a === '--data') args.dataDir = next()
    else if (a === '--backup') args.backup = true
    else if (a === '--rate-limit') args.rateLimit = Number(next())
    else if (a === '--help' || a === '-h') {
      console.log(
        t(
          '用法：node main.js [--port 18443] [--host 127.0.0.1] [--data <目录>] [--backup] [--rate-limit 60]\n  --backup  执行一次在线快照到 <data>/backups/ 后退出（配 crontab 每日备份）',
          'Usage: node main.js [--port 18443] [--host 127.0.0.1] [--data <dir>] [--backup] [--rate-limit 60]\n  --backup  take an online snapshot into <data>/backups/ and exit (wire into crontab for daily backups)'
        )
      )
      process.exit(0)
    } else {
      console.error(t('未知参数：{a}（--help 查看用法）', 'Unknown argument: {a} (see --help)', { a }))
      process.exit(1)
    }
  }
  if (!Number.isInteger(args.port) || args.port <= 0 || args.port > 65535) {
    console.error(t('端口非法：{p}', 'Invalid port: {p}', { p: String(args.port) }))
    process.exit(1)
  }
  return args
}

/** consoleToken 持久化：<data>/cloud.json（0600，跨重启稳定）；经 atomicWrite 原子写（DESIGN-06） */
export async function resolveConsoleToken(dataDir: string): Promise<{ token: string; created: boolean }> {
  const file = path.join(dataDir, 'cloud.json')
  try {
    const j = JSON.parse(await fsp.readFile(file, 'utf8')) as { consoleToken?: string }
    if (j.consoleToken && /^mdkcloud_[0-9a-f]{32,}$/.test(j.consoleToken)) return { token: j.consoleToken, created: false }
  } catch {
    /* 首次启动或文件损坏 → 重新生成 */
  }
  const token = randomToken('mdkcloud')
  await atomicWrite(file, JSON.stringify({ consoleToken: token }, null, 2) + '\n', 0o600)
  return { token, created: true }
}

export async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv)
  const store = new CloudStore(args.dataDir)

  if (args.backup) {
    const dest = path.join(args.dataDir, 'backups', `cloud-${new Date().toISOString().replace(/[:.]/g, '-')}.db`)
    store.backupTo(dest)
    // 保留最近 14 份（详设 §7.7-4）
    const backupsDir = path.join(args.dataDir, 'backups')
    const files = fs
      .readdirSync(backupsDir)
      .filter((f) => f.startsWith('cloud-') && f.endsWith('.db'))
      .sort()
    for (const f of files.slice(0, Math.max(0, files.length - 14))) fs.rmSync(path.join(backupsDir, f), { force: true })
    console.log(t('✓ 已快照：{f}', '✓ Snapshot saved: {f}', { f: dest }))
    store.close()
    return
  }

  const { token, created } = await resolveConsoleToken(args.dataDir)
  const server = createCloudServer(store, { consoleToken: token, rateLimitPerMin: args.rateLimit })
  server.listen(args.port, args.host, () => {
    const proto = 'http'
    console.log(t('[modeldock-cloud] 控制台：{proto}://{host}:{port}/（登录用 consoleToken）', '[modeldock-cloud] Console: {proto}://{host}:{port}/ (log in with the consoleToken)', { proto, host: args.host, port: args.port }))
    console.log(t('[modeldock-cloud] 数据目录：{dir}', '[modeldock-cloud] Data dir: {dir}', { dir: args.dataDir }))
    if (created) {
      console.log(t('[modeldock-cloud] consoleToken（首次生成，已写入 {f}，请妥善保管）：', '[modeldock-cloud] consoleToken (newly generated, saved to {f}; keep it safe):', { f: path.join(args.dataDir, 'cloud.json') }))
      console.log(token)
    }
  })
  const shutdown = (): void => {
    server.close()
    store.close()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  setInterval(() => {}, 60_000) // 保活
}

if (process.argv[1] && /cloud[\\/]main\.(js|ts)$/.test(process.argv[1])) {
  void main(process.argv.slice(2))
}
