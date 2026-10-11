import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// 结构回归：分层倒置修正（DESIGN-05）。providers 层不得反向依赖 gateway 层；buildDispatcher
// 作为无状态 undici 纯函数下沉到 util/net.ts 后，providers/fetch 从 util/net 引入。
describe('cloud/providers 分层结构（DESIGN-05）', () => {
  it('providers/fetch.ts 源文本不含 gateway/proxy（不再反向依赖 gateway 层）', () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'src', 'providers', 'fetch.ts'), 'utf8')
    expect(src).not.toContain('gateway/proxy')
  })

  it('buildDispatcher 定义在 src/util/net.ts', () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'src', 'util', 'net.ts'), 'utf8')
    expect(src).toMatch(/export function buildDispatcher/)
  })

  it('providers/fetch.ts 从 util/net 引入 buildDispatcher', () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'src', 'providers', 'fetch.ts'), 'utf8')
    expect(src).toMatch(/import \{ buildDispatcher \} from '\.\.\/util\/net\.js'/)
  })
})