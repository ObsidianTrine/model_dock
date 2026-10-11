import fs from 'node:fs'
import http from 'node:http'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { fakeHome } from './helpers.js'
import { fetchHolidayData } from '../src/gateway/holidays.js'

describe('DESIGN-09：holidays 不再拿 t() 文案当控制流哨兵', () => {
  it('源文件不含 lastErr === t( 这种比较哨兵，改用类型化标志 lastErrKind', () => {
    const src = fs.readFileSync(fileURLToPath(new URL('../src/gateway/holidays.ts', import.meta.url)), 'utf8')
    expect(src).not.toMatch(/lastErr\s*===\s*t\(/)
    expect(src).toMatch(/lastErrKind\s*===/)
  })
})

describe('fetchHolidayData 公告未发布路径（行为回归，DESIGN-09 修后不回归）', () => {
  it('全源 404 = 公告尚未发布 → 进 notPublished 而非 failures', async () => {
    const h = fakeHome()
    const server = http.createServer((_req, res) => {
      res.statusCode = 404
      res.end('nope')
    })
    const prev = process.env.MODELRDOCK_HOLIDAY_SOURCES
    try {
      const port = await new Promise<number>((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port))
      })
      process.env.MODELRDOCK_HOLIDAY_SOURCES = `http://127.0.0.1:${port}/{year}`
      const { failures, notPublished } = await fetchHolidayData([2027], { data: {} })
      expect(notPublished).toEqual([2027])
      expect(failures).toEqual([])
    } finally {
      server.closeAllConnections?.()
      server.close()
      if (prev === undefined) delete process.env.MODELRDOCK_HOLIDAY_SOURCES
      else process.env.MODELRDOCK_HOLIDAY_SOURCES = prev
      h.restore()
    }
  })

  it('其他错误（如 500）→ 进 failures 而非 notPublished', async () => {
    const server = http.createServer((_req, res) => {
      res.statusCode = 500
      res.end('boom')
    })
    const prev = process.env.MODELRDOCK_HOLIDAY_SOURCES
    try {
      const port = await new Promise<number>((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port))
      })
      process.env.MODELRDOCK_HOLIDAY_SOURCES = `http://127.0.0.1:${port}/{year}`
      const { failures, notPublished } = await fetchHolidayData([2026], { data: {} })
      expect(notPublished).toEqual([])
      expect(failures[0]).toMatch(/^2026: HTTP 500/)
    } finally {
      server.closeAllConnections?.()
      server.close()
      if (prev === undefined) delete process.env.MODELRDOCK_HOLIDAY_SOURCES
      else process.env.MODELRDOCK_HOLIDAY_SOURCES = prev
    }
  })
})