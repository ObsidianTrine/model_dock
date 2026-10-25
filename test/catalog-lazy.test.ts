import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import { fakeHome } from './helpers.js'
import { catalogModelMeta, catalogSnapshot } from '../src/providers/catalog.js'
import { CATALOG_SNAPSHOT_JSON, CATALOG_SNAPSHOT_FETCHED_AT } from '../src/providers/catalog-snapshot.generated.js'

describe('catalog snapshot 懒解析（PERF-03）', () => {
  it('生成文件为 JSON 字符串形态（不再以对象字面量导出，模块求值零解析成本）', () => {
    const src = fs.readFileSync(new URL('../src/providers/catalog-snapshot.generated.ts', import.meta.url), 'utf8')
    expect(src).toContain('export const CATALOG_SNAPSHOT_JSON')
    expect(src).not.toMatch(/CATALOG_SNAPSHOT:\s*CatalogData\s*=/)
    expect(typeof CATALOG_SNAPSHOT_JSON).toBe('string')
    expect(JSON.parse(CATALOG_SNAPSHOT_JSON).fetchedAt).toBe(CATALOG_SNAPSHOT_FETCHED_AT)
  })

  it('catalogSnapshot() 解析形态正确且进程内 memo（重复调用同一引用）', () => {
    const h = fakeHome()
    try {
      const a = catalogSnapshot()
      const b = catalogSnapshot()
      expect(b).toBe(a)
      expect(a.fetchedAt).toBe(CATALOG_SNAPSHOT_FETCHED_AT)
      expect(Object.keys(a.providers).length).toBeGreaterThan(0)
    } finally {
      h.restore()
    }
  })

  it('catalogModelMeta 行为不变：已知模型命中限额、未知模型 undefined', () => {
    const h = fakeHome()
    try {
      const e = catalogModelMeta('gpt-4o')
      expect(e).toBeDefined()
      expect(e?.context_window).toBeGreaterThanOrEqual(1024)
      expect(catalogModelMeta('no-such-model-xyz')).toBeUndefined()
    } finally {
      h.restore()
    }
  })
})
