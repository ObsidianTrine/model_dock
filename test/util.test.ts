import { describe, expect, it } from 'vitest'
import { stringify as tomlStringify } from 'smol-toml'
import fs from 'node:fs'
import path from 'node:path'
import { fakeHome } from './helpers.js'
import { matchAlias, globToRegExp } from '../src/util/glob.js'
import { getPath, setPath, toSegments } from '../src/util/jsonpath.js'
import { unifiedDiff, redact } from '../src/util/diff.js'
import { detectJsonIndent } from '../src/adapters/format.js'
import { applyPackUpsert } from '../src/adapters/packs.js'
import { reorderTomlRoot, tomlParse } from '../src/adapters/format.js'
import { atomicWrite, commandOnPath, readTextIfExists } from '../src/util/fsx.js'
import { expandHome } from '../src/util/paths.js'

describe('模型别名匹配', () => {
  it('精确优先，glob 其次，未命中 undefined', () => {
    const aliases = { 'claude-sonnet-*': 'ds-flash', 'gpt-4o': 'gpt-4o-target' }
    expect(matchAlias(aliases, 'claude-sonnet-4-6[1M]')).toBe('ds-flash')
    expect(matchAlias(aliases, 'gpt-4o')).toBe('gpt-4o-target')
    expect(matchAlias(aliases, 'unknown-model')).toBeUndefined()
    expect(matchAlias(undefined, 'x')).toBeUndefined()
  })

  it('glob 转义特殊字符', () => {
    expect(globToRegExp('a.b*').test('a.bX')).toBe(true)
    expect(globToRegExp('a.b*').test('aXbX')).toBe(false)
  })
})

describe('jsonpath', () => {
  it('setPath 创建中间容器 / 数组下标', () => {
    const root: any = {}
    setPath(root, '$.a.b.c', 1)
    setPath(root, '$.a.list[0]', 'x')
    setPath(root, '$.a.list[1]', 'y')
    expect(root).toEqual({ a: { b: { c: 1 }, list: ['x', 'y'] } })
    expect(getPath(root, '$.a.b.c')).toBe(1)
    expect(getPath(root, '$.a.missing')).toBeUndefined()
    expect(toSegments('$.a.list[1]')).toEqual(['a', 'list', 1])
  })

  it('star 遍历写入', () => {
    const root: any = { p1: { kind: 'x' }, p2: { kind: 'x' } }
    setPath(root, '$.*.kind', 'y')
    expect(root.p1.kind).toBe('y')
    expect(root.p2.kind).toBe('y')
  })
})

describe('diff', () => {
  it('unified diff 标注增删行', () => {
    const d = unifiedDiff('a\nb\nc\n', 'a\nB\nc\nd\n')
    expect(d).toContain('- b')
    expect(d).toContain('+ B')
    expect(d).toContain('+ d')
    expect(d).toContain('  a')
  })
  it('无差异返回空串', () => {
    expect(unifiedDiff('a\n', 'a\n')).toBe('')
  })
  it('CRLF 与 LF 内容相同不算差异（Windows 编辑过的配置不整文件误报）', () => {
    expect(unifiedDiff('a\r\nb\r\n', 'a\nb\n')).toBe('')
  })
  it('redact 抹掉敏感串', () => {
    expect(redact('token=abcdef123456', ['abcdef123456'])).toContain('***REDACTED***')
  })
})

describe('格式工具', () => {
  it('detectJsonIndent 识别缩进', () => {
    expect(detectJsonIndent('{\n  "a": {\n    "b": 1\n  }\n}\n')).toBe('  ')
    expect(detectJsonIndent('{"a":1}')).toBe('  ')
  })

  it('reorderTomlRoot 把标量提到表前，序列化合法', () => {
    const root = { model_providers: { md: { base_url: 'http://x' } }, model_provider: 'md', other: 1 }
    const out = reorderTomlRoot(root as Record<string, unknown>)
    const text = tomlStringify(out)
    expect(text.indexOf('model_provider = ')).toBeLessThan(text.indexOf('[model_providers'))
    expect(() => tomlParse(text)).not.toThrow()
  })
})

describe('L2 声明式 pack', () => {
  it('json upsert + 变量展开', () => {
    const pack = {
      format: 'json' as const,
      config_file: '/tmp/x.json',
      upsert: { '$.provider.modeldock.baseURL': '{base_url}', '$.provider.modeldock.apiKey': '{token}' },
    }
    const out = applyPackUpsert('{\n  "provider": {}\n}', pack, {
      token: 'mdk_t',
      port: '8687',
      base_url: 'http://127.0.0.1:8687',
      base_url_openai: 'http://127.0.0.1:8687/v1',
    })
    const parsed = JSON.parse(out)
    expect(parsed.provider.modeldock.baseURL).toBe('http://127.0.0.1:8687')
    expect(parsed.provider.modeldock.apiKey).toBe('mdk_t')
  })

  it('yaml upsert', () => {
    const pack = {
      format: 'yaml' as const,
      config_file: '/tmp/x.yaml',
      upsert: { '$.providers.modeldock.baseURL': '{base_url}' },
    }
    const out = applyPackUpsert('providers: {}\n# 注释保留\n', pack, {
      token: 't',
      port: '1',
      base_url: 'http://h:1',
      base_url_openai: 'http://h:1/v1',
    })
    expect(out).toContain('http://h:1')
    expect(out).toContain('# 注释保留')
  })

  it('未知模板变量报可读错误', () => {
    const pack = { format: 'json' as const, config_file: 'x', upsert: { '$.a': '{nope}' } }
    expect(() => applyPackUpsert('{}', pack, { token: 't', port: '1', base_url: 'u', base_url_openai: 'u' })).toThrow(
      /模板变量/
    )
  })
})

describe('known models 合并优先级', () => {
  it('knownMetaTable 与 knownModelMeta 优先级一致（预设库覆盖全局补充表）', async () => {
    const { knownMetaTable, knownModelMeta } = await import('../src/providers/known.js')
    const table = knownMetaTable()
    const ids = Object.keys(table)
    expect(ids.length).toBeGreaterThan(0)
    for (const id of ids) {
      expect(table[id]).toEqual(knownModelMeta(id))
    }
  })
})

describe('paths expandHome（~ 前缀跨平台展开）', () => {
  it('~、~/x、~\\x 都展开到 home；非 ~ 前缀原样返回', () => {
    const h = fakeHome()
    try {
      expect(expandHome('~')).toBe(h.home)
      expect(expandHome('~/foo/bar.toml')).toBe(path.join(h.home, 'foo', 'bar.toml'))
      expect(expandHome('~\\foo')).toBe(path.join(h.home, 'foo'))
      expect(expandHome('/abs/path')).toBe('/abs/path')
      expect(expandHome('rel/path')).toBe('rel/path')
      expect(expandHome('~not-a-home')).toBe('~not-a-home') // ~ 后不是分隔符不展开
    } finally {
      h.restore()
    }
  })
})

describe('fsx readTextIfExists（Windows 常见编码）', () => {
  it('剥 UTF-8 BOM：内容可直接 JSON.parse', async () => {
    const h = fakeHome()
    try {
      const p = path.join(h.home, 'bom.json')
      fs.writeFileSync(p, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"a":1}')]))
      const t = await readTextIfExists(p)
      expect(t).toBe('{"a":1}')
      expect(JSON.parse(t as string)).toEqual({ a: 1 })
    } finally {
      h.restore()
    }
  })
  it('UTF-16（LE/BE）明确报错并提示转存 UTF-8', async () => {
    const h = fakeHome()
    try {
      const le = path.join(h.home, 'le.json')
      fs.writeFileSync(le, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('{"a":1}', 'utf16le')]))
      await expect(readTextIfExists(le)).rejects.toThrow(/UTF-16/)
      const be = path.join(h.home, 'be.json')
      // Buffer.from 不支持 utf16be：用 utf16le 生成后按 16 位字节交换翻转大小端
      const beBody = Buffer.from('{"a":1}', 'utf16le')
      beBody.swap16()
      fs.writeFileSync(be, Buffer.concat([Buffer.from([0xfe, 0xff]), beBody]))
      await expect(readTextIfExists(be)).rejects.toThrow(/UTF-16/)
    } finally {
      h.restore()
    }
  })
})

describe('fsx commandOnPath（PATH 探测跨平台）', () => {
  /** 临时替换 PATH/APPDATA（commandOnPath Windows 还兜底扫 %APPDATA%\npm），用完还原 */
  function withPath(binDir: string | null, appData: string | undefined, fn: () => void): void {
    const savedPath = process.env.PATH
    const savedAppData = process.env.APPDATA
    const sep = process.platform === 'win32' ? ';' : ':'
    process.env.PATH = binDir ?? sep // 只剩空段：探测不到任何目录
    if (appData === undefined) delete process.env.APPDATA
    else process.env.APPDATA = appData
    try {
      fn()
    } finally {
      if (savedPath === undefined) delete process.env.PATH
      else process.env.PATH = savedPath
      if (savedAppData === undefined) delete process.env.APPDATA
      else process.env.APPDATA = savedAppData
    }
  }

  it('命中 PATH 中的可执行（Windows 走 .cmd/.exe 后缀探测）；不存在不误报', () => {
    const h = fakeHome()
    try {
      const dir = path.join(h.home, 'bin')
      fs.mkdirSync(dir, { recursive: true })
      const probe = 'mdk-path-probe-x1'
      fs.writeFileSync(path.join(dir, process.platform === 'win32' ? `${probe}.cmd` : probe), '')
      withPath(dir, undefined, () => expect(commandOnPath(probe)).toBe(true))
      // 空 PATH + 独特命令名：避开 Unix well-known 兜底与 Windows APPDATA 兜底，两个方向都确定
      withPath(null, undefined, () => expect(commandOnPath('mdk-no-such-cmd-x9z')).toBe(false))
    } finally {
      h.restore()
    }
  })
  it.skipIf(process.platform !== 'win32')('Windows 兜底扫 %APPDATA%\\npm（npm i -g shim 落点）', () => {
    const h = fakeHome()
    try {
      const npmDir = path.join(h.home, 'appdata', 'npm')
      fs.mkdirSync(npmDir, { recursive: true })
      fs.writeFileSync(path.join(npmDir, 'mdk-probe-x2.cmd'), '')
      withPath(null, path.join(h.home, 'appdata'), () => expect(commandOnPath('mdk-probe-x2')).toBe(true))
    } finally {
      h.restore()
    }
  })
})

describe('fsx atomicWrite（tmp+rename 跨平台语义）', () => {
  it('覆盖已有文件；成功后目录无 tmp 残留', async () => {
    const h = fakeHome()
    try {
      const p = path.join(h.home, 'a.json')
      await atomicWrite(p, 'v1\n')
      await atomicWrite(p, 'v2\n')
      expect(await readTextIfExists(p)).toBe('v2\n')
      expect(fs.readdirSync(h.home).filter((f) => f.startsWith('.'))).toEqual([])
    } finally {
      h.restore()
    }
  })
})
