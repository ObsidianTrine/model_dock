import fs from 'node:fs'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { fakeHome } from './helpers.js'
import {
  catalogForRoute,
  catalogLookupById,
  clearDshCatalogCache,
  loadDshCatalog,
} from '../src/providers/dshcatalog.js'

// dsh 内置模型 catalog 的解析容错与缓存语义。probe 会扫描 $HOME/.npm/_npx（fakeHome 隔离后为空，
// 不会读到宿主机真实 npx 缓存）；进程级缓存必须 before/after 双向 clear，否则泄漏给其他测试文件。

const homes: ReturnType<typeof fakeHome>[] = []
afterAll(() => {
  // LIFO 还原：每个 fakeHome 的 restore 都把 env 设回它进场前的值，倒序才能还原到最初
  for (const h of [...homes].reverse()) h.restore()
})

/** 造一个 fixture ESM 并指为 catalog 来源；返回后调用方负责 finally 里 clearDshCatalogCache */
async function withFixture(content: string): Promise<string> {
  homes.push(fakeHome())
  const file = path.join(homes[homes.length - 1].home, `models-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mjs`)
  fs.writeFileSync(file, content)
  process.env.MODELRDOCK_DSH_CATALOG = file
  clearDshCatalogCache()
  return file
}

function doneFixture(): void {
  delete process.env.MODELRDOCK_DSH_CATALOG
  clearDshCatalogCache()
}

describe('loadDshCatalog：解析容错', () => {
  it('非法字段逐项丢弃（非整数窗口/非字符串名/null 条目），空 route 跳过', async () => {
    const file = await withFixture([
      'export const MODELS = {',
      '  routeA: {',
      '    m1: { name: "M1", contextWindow: 4096, maxTokens: 8192 },',
      '    m2: { name: 123, contextWindow: "4096" },',
      '    m3: null,',
      '    m4: { contextWindow: 4096.5 },',
      '  },',
      '  routeB: {},',
      '}',
    ].join('\n'))
    try {
      const r = await loadDshCatalog()
      expect(r).not.toBeNull()
      expect(r!.source).toBe(file)
      expect(r!.catalog.size).toBe(1) // routeB 空目录不进表
      const byId = catalogForRoute(r!.catalog, 'routeA')
      expect(byId.size).toBe(3) // m3（null）被丢弃
      expect(byId.get('m1')).toEqual({ id: 'm1', name: 'M1', contextWindow: 4096, maxTokens: 8192 })
      expect(byId.get('m2')).toEqual({ id: 'm2', name: undefined, contextWindow: undefined, maxTokens: undefined })
      expect(byId.get('m4')).toEqual({ id: 'm4', name: undefined, contextWindow: undefined, maxTokens: undefined })
      expect(byId.has('m3')).toBe(false)
    } finally {
      doneFixture()
    }
  })

  it('全部条目无效 / 缺 MODELS 导出 / 文件不存在：返回 null', async () => {
    const f1 = await withFixture('export const MODELS = { r: { x: null }, r2: {} }')
    try {
      expect(await loadDshCatalog()).toBeNull()
    } finally {
      doneFixture()
    }
    const f2 = await withFixture('export const OTHER = 1')
    try {
      expect(await loadDshCatalog()).toBeNull()
    } finally {
      doneFixture()
    }
    homes.push(fakeHome())
    process.env.MODELRDOCK_DSH_CATALOG = path.join(f2, '..', 'no-such-file.mjs')
    clearDshCatalogCache()
    try {
      expect(await loadDshCatalog()).toBeNull()
    } finally {
      doneFixture()
    }
  })
})

describe('loadDshCatalog：缓存语义', () => {
  it('同来源两次 load 返回同一引用；clear 后按新来源重载', async () => {
    const f1 = await withFixture('export const MODELS = { r: { m1: { name: "A" } } }')
    const r1 = await loadDshCatalog()
    expect(r1!.source).toBe(f1)
    expect(await loadDshCatalog()).toBe(r1) // 命中进程缓存
    const f2 = path.join(path.dirname(f1), 'models-second.mjs')
    fs.writeFileSync(f2, 'export const MODELS = { r2: { m2: { name: "B" } } }')
    process.env.MODELRDOCK_DSH_CATALOG = f2
    clearDshCatalogCache()
    const r2 = await loadDshCatalog()
    expect(r2!.source).toBe(f2)
    expect(r2).not.toBe(r1)
    expect(await loadDshCatalog()).toBe(r2)
    doneFixture()
  })
})

describe('catalogForRoute / catalogLookupById', () => {
  it('route 未命中返回空 map（新实例）；跨 route 查 id 先出现者胜', () => {
    const catalog = new Map([
      ['r1', new Map([['x', { id: 'x', name: 'A' }]])],
      ['r2', new Map([['x', { id: 'x', name: 'B' }]])],
    ] as const)
    expect(catalogForRoute(catalog, 'r1').get('x')?.name).toBe('A')
    const miss = catalogForRoute(catalog, 'nope')
    expect(miss.size).toBe(0)
    expect(catalogForRoute(catalog, 'nope')).not.toBe(miss) // 每次新 map，调用方可安全变更
    expect(catalogLookupById(catalog, 'x')?.name).toBe('A')
    expect(catalogLookupById(catalog, 'zzz')).toBeNull()
  })
})
