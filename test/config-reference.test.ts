import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
// 生成脚本（.mjs 无类型声明；vitest 直跑不类型检查，tsc 构建不含 test/）
import { generateDocs, parseInventory, METAS } from '../scripts/gen-config-reference.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const norm = (s: string): string => s.replace(/\r\n/g, '\n')

describe('config reference（生成式文档 freshness）', () => {
  const inventory = parseInventory()

  it('types.ts 解析出的用户可配键与文档元数据一一对应（对拍，缺/多都会在 generateDocs 里抛错）', () => {
    expect(inventory.paths.length).toBeGreaterThan(50)
    expect(inventory.paths.length).toBe(Object.keys(METAS).length)
  })

  it('任务卡点名键全部在文档清单里（实测曾零提及的键）', () => {
    const must = [
      'gateway.headers_timeout_ms',
      'gateway.idle_timeout_ms',
      'gateway.max_body_mb',
      'gateway.log_retention_days',
      'gateway.retries',
      'gateway.schedule.windows[].dayFilter',
      'security.store',
      'backup.keep',
      'update.repo',
      'update.mirror',
      'lan.enabled',
      'adapter_packs.<pack>.detect.key_path',
    ]
    for (const p of must) expect(inventory.paths, `缺键：${p}`).toContain(p)
  })

  it('docs/config-reference.md 为最新生成（红 = 跑 node scripts/gen-config-reference.mjs）', () => {
    const docs = generateDocs()
    const onDisk = norm(readFileSync(path.join(ROOT, 'docs', 'config-reference.md'), 'utf8'))
    expect(onDisk).toBe(docs.zh)
  })

  it('docs/en/config-reference.md 为最新生成（红 = 跑 node scripts/gen-config-reference.mjs）', () => {
    const docs = generateDocs()
    const onDisk = norm(readFileSync(path.join(ROOT, 'docs', 'en', 'config-reference.md'), 'utf8'))
    expect(onDisk).toBe(docs.en)
  })
})
