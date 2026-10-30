import fsSync from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { TEST_TMP } from './helpers.js'
import { parseArgs, resolveConsoleToken } from '../src/cloud/main.js'

const dirs: string[] = []
afterAll(async () => {
  for (const d of dirs) await fsp.rm(d, { recursive: true, force: true }).catch(() => {})
})

function tmpDir(prefix: string): string {
  const d = fsSync.mkdtempSync(path.join(TEST_TMP, prefix))
  dirs.push(d)
  return d
}

describe('cloud/main 数据目录（DESIGN-06）', () => {
  it('数据目录经 homeDir() 派生：桩 home 下不落 CWD 相对路径', () => {
    const fakeHome = tmpDir('md-cloud-home-')
    const prevHome = process.env.HOME
    const prevFake = process.env.MODELRDOCK_FAKE_HOME
    delete process.env.HOME // Windows 语义：HOME 未设
    process.env.MODELRDOCK_FAKE_HOME = fakeHome
    try {
      const args = parseArgs([])
      expect(args.dataDir).toBe(path.join(fakeHome, '.modeldock-cloud'))
      // 明确不在 CWD 相对目录（旧实现 HOME 未设时静默写进 './' 的相对路径）
      expect(args.dataDir).not.toBe(path.join('.', '.modeldock-cloud'))
      expect(path.isAbsolute(args.dataDir)).toBe(true)
    } finally {
      if (prevHome === undefined) delete process.env.HOME
      else process.env.HOME = prevHome
      if (prevFake === undefined) delete process.env.MODELRDOCK_FAKE_HOME
      else process.env.MODELRDOCK_FAKE_HOME = prevFake
    }
  })

  it('显式 --data 仍优先于 homeDir 默认值', () => {
    const dataDir = tmpDir('md-cloud-data-')
    const args = parseArgs(['--data', dataDir])
    expect(args.dataDir).toBe(dataDir)
  })
})

describe('cloud/main consoleToken 持久化（DESIGN-06）', () => {
  it('atomicWrite 写出 cloud.json（0600，win32 分支），跨调用稳定读回同 token', async () => {
    const dataDir = tmpDir('md-cloud-token-')
    const r1 = await resolveConsoleToken(dataDir)
    expect(r1.created).toBe(true)
    const file = path.join(dataDir, 'cloud.json')
    expect(fsSync.existsSync(file)).toBe(true)
    const j = JSON.parse(fsSync.readFileSync(file, 'utf8')) as { consoleToken: string }
    expect(j.consoleToken).toBe(r1.token)
    // 无 tmp 残留（atomicWrite 原子性）
    expect(fsSync.readdirSync(dataDir).some((f) => f.startsWith('.cloud.json.'))).toBe(false)
    if (process.platform !== 'win32') {
      // NTFS 不认权限位（AGENTS.md 测试指南 win32 分支）
      expect(fsSync.statSync(file).mode & 0o777).toBe(0o600)
    }
    // 二次调用：读回已有 token，不重复生成
    const r2 = await resolveConsoleToken(dataDir)
    expect(r2.created).toBe(false)
    expect(r2.token).toBe(r1.token)
  })
})