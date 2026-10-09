/**
 * 云端控制面存储（docs/design-cloud-sync.md §7.3）：node:sqlite（Node ≥22.5 内置，零第三方依赖）。
 * 明文 token 不落盘——只存 sha256；doc 表恒单行（id=1，整包 LWW，保留 rev 单调递增）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const DDL = `
CREATE TABLE IF NOT EXISTS devices(
  devid TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  enrolled_at TEXT NOT NULL,
  last_seen TEXT,
  client_version TEXT,
  reported_profile TEXT,
  desired_profile TEXT,
  desired_ts TEXT,
  services_json TEXT
);
CREATE TABLE IF NOT EXISTS doc(
  id INTEGER PRIMARY KEY CHECK(id=1),
  rev INTEGER NOT NULL,
  envelope TEXT NOT NULL,
  ts TEXT NOT NULL,
  by_devid TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS paircodes(
  code TEXT PRIMARY KEY,
  expires_at TEXT NOT NULL
);
`

export interface DeviceRow {
  devid: string
  name: string
  token_hash: string
  enrolled_at: string
  last_seen: string | null
  client_version: string | null
  reported_profile: string | null
  desired_profile: string | null
  desired_ts: string | null
  services_json: string | null
}

export interface DocRow {
  rev: number
  envelope: string
  ts: string
  by_devid: string
}

export class CloudStore {
  private db: DatabaseSync
  readonly file: string

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true })
    this.file = path.join(dataDir, 'cloud.db')
    this.db = new DatabaseSync(this.file)
    this.db.exec('PRAGMA journal_mode=WAL')
    this.db.exec(DDL)
  }

  // —— devices ——

  upsertDevice(devid: string, name: string, tokenHash: string, now: string): void {
    this.db
      .prepare(
        `INSERT INTO devices(devid, name, token_hash, enrolled_at) VALUES(?,?,?,?)
         ON CONFLICT(devid) DO UPDATE SET name=excluded.name, token_hash=excluded.token_hash, desired_profile=NULL, desired_ts=NULL`
      )
      .run(devid, name, tokenHash, now)
  }

  deviceByTokenHash(tokenHash: string): DeviceRow | null {
    const row = this.db.prepare('SELECT * FROM devices WHERE token_hash = ?').get(tokenHash) as Record<string, unknown> | undefined
    return row ? (row as unknown as DeviceRow) : null
  }

  device(devid: string): DeviceRow | null {
    const row = this.db.prepare('SELECT * FROM devices WHERE devid = ?').get(devid) as Record<string, unknown> | undefined
    return row ? (row as unknown as DeviceRow) : null
  }

  listDevices(): DeviceRow[] {
    return this.db.prepare('SELECT * FROM devices ORDER BY enrolled_at').all() as unknown as DeviceRow[]
  }

  touchDevice(devid: string, fields: { lastSeen: string; clientVersion?: string; reportedProfile?: string; servicesJson?: string }): void {
    this.db
      .prepare('UPDATE devices SET last_seen = ?, client_version = COALESCE(?, client_version), reported_profile = COALESCE(?, reported_profile), services_json = COALESCE(?, services_json) WHERE devid = ?')
      .run(fields.lastSeen, fields.clientVersion ?? null, fields.reportedProfile ?? null, fields.servicesJson ?? null, devid)
  }

  /** 写 desired：devid=null 表示全部设备。返回更新的设备数 */
  setDesired(devid: string | null, profileId: string, ts: string): number {
    if (devid === null) {
      const r = this.db.prepare('UPDATE devices SET desired_profile = ?, desired_ts = ?').run(profileId, ts)
      return Number(r.changes)
    }
    const r = this.db.prepare('UPDATE devices SET desired_profile = ?, desired_ts = ? WHERE devid = ?').run(profileId, ts, devid)
    return Number(r.changes)
  }

  // —— doc ——

  getDoc(): DocRow | null {
    const row = this.db.prepare('SELECT rev, envelope, ts, by_devid FROM doc WHERE id = 1').get() as Record<string, unknown> | undefined
    if (!row) return null
    return { rev: Number(row.rev), envelope: String(row.envelope), ts: String(row.ts), by_devid: String(row.by_devid) }
  }

  putDoc(rev: number, envelope: string, ts: string, byDevid: string): void {
    this.db
      .prepare(
        `INSERT INTO doc(id, rev, envelope, ts, by_devid) VALUES(1, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET rev=excluded.rev, envelope=excluded.envelope, ts=excluded.ts, by_devid=excluded.by_devid`
      )
      .run(rev, envelope, ts, byDevid)
  }

  // —— paircodes ——

  createPairCode(code: string, expiresAt: string): void {
    this.db.prepare('INSERT INTO paircodes(code, expires_at) VALUES(?, ?)').run(code, expiresAt)
  }

  /** 用后即焚：code 存在且未过期 → 删除并返回 true */
  takePairCode(code: string, nowMs: number): boolean {
    const row = this.db.prepare('SELECT expires_at FROM paircodes WHERE code = ?').get(code) as { expires_at: string } | undefined
    if (!row) return false
    this.db.prepare('DELETE FROM paircodes WHERE code = ?').run(code)
    return Date.parse(row.expires_at) > nowMs
  }

  /** 过期配对码清理（写路径顺带执行即可，无需定时器） */
  sweepExpiredPairCodes(nowMs: number): void {
    this.db
      .prepare('DELETE FROM paircodes WHERE expires_at <= ?')
      .run(new Date(nowMs).toISOString())
  }

  /** 在线备份到单文件（VACUUM INTO，部署 runbook 的 crontab 每日快照） */
  backupTo(destFile: string): void {
    fs.mkdirSync(path.dirname(destFile), { recursive: true })
    const safe = destFile.replace(/'/g, "''")
    this.db.exec(`VACUUM INTO '${safe}'`)
  }

  close(): void {
    this.db.close()
  }
}
