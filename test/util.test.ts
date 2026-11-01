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

  // ── CORRECT-08 三处复现原文（坏输入 → 可操作双语报错，不再静默写坏数据）──

  it('缺陷①：引号键 / 负数下标 / 未闭合括号不再静默吞字改写，报可操作错误', () => {
    // 修复前：setPath({}, "$.a['b']", 1) → {"a":{"'b'":1}}（引号进键名，写错位置无报错）
    const root: any = {}
    expect(() => setPath(root, "$.a['b']", 1)).toThrow(/无法解析/)
    expect(root).toEqual({}) // 未静默写坏
    expect(() => setPath({}, '$.a[-1]', 1)).toThrow(/无法解析/)
    expect(() => setPath({}, '$.a[0', 1)).toThrow(/无法解析/) // 修复前：键 '0'，绕过越界守卫
    expect(() => setPath({}, '$.a..b', 1)).toThrow(/无法解析/) // 段间只允许一个 `.` 分隔符
    expect(() => toSegments("$.a['b']")).toThrow(/无法解析/) // 读/segments 共用同一守卫
  })

  it('缺陷②：star 中段遇标量子节点 skip 不裸崩（与 leaf 分支不覆盖 object 同口径）', () => {
    const root: any = { a: { b: 1 }, c: 'str' }
    expect(() => setPath(root, '$.*.b', 2)).not.toThrow() // 修复前：TypeError on 'str'
    expect(root.a.b).toBe(2)
    expect(root.c).toBe('str') // 标量不被改写、不报错中断其他键
  })

  it('缺陷③：对象容器遇下标段显式报错，不再静默落字符串键 "0"', () => {
    const root: any = { a: { existing: 1 } }
    // 修复前：setPath(root, '$.a[0]', 'x') → {"a":{"0":"x","existing":1}}
    expect(() => setPath(root, '$.a[0]', 'x')).toThrow(/下标段只能用于数组/)
    expect(root.a).toEqual({ existing: 1 }) // 未静默写入
    const leaf: any = { list: [{ v: 1 }] }
    expect(() => setPath(leaf, '$.list[0][0]', 1)).toThrow(/下标段只能用于数组/) // 中段同守卫：list[0] 是对象容器再遇下标段
    expect(leaf.list).toEqual([{ v: 1 }]) // 未静默写入
    const sub: any = { list: [{ v: 1, sub: {} }] } // sub 须已存在为对象——缺失会走缺容器自动创建（建数组）而非报错
    expect(() => setPath(sub, '$.list[0].sub[0]', 1)).toThrow(/下标段只能用于数组/) // 中段同守卫
    const ok: any = { list: [{ v: 1 }] }
    setPath(ok, '$.list[0].sub[0]', 1) // 缺失中段键按 next 形态自动建容器（fd235ea^ 原样合法）
    expect(ok.list[0]).toEqual({ v: 1, sub: [1] })
  })

  it('数组点句式行为零变化（点/下标合法句式回归锚点）', () => {
    const root: any = { a: { list: ['x', 'z'] } } // 预填长度 2：稀疏守卫语义（merge-base 起既有）下「追加」只能写 idx === length
    setPath(root, '$.a.b.c', 1) // 点句式
    setPath(root, '$.a.list[2]', 'append') // idx === length 追加合法
    expect(root.a.list).toEqual(['x', 'z', 'append'])
    setPath(root, '$.a.list[1]', 'y') // 改写已有元素合法
    expect(root.a.list[1]).toBe('y')
    const empty: any = {}
    setPath(empty, '$.a.list[0]', 'append') // 缺失中段键自动建数组容器再追加（越界守卫语义与 fd235ea^ 一致）
    expect(empty.a.list).toEqual(['append'])
    expect(() => setPath(root, '$.a.list[9]', 'x')).toThrow(/路径越界/) // 稀疏守卫原样
    expect(getPath({ a: { list: ['x'] } }, '$.a.list[0]')).toBe('x') // 读路径合法句式
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

  it('detectJsonIndent 顶层数组取元素缩进，重写不再翻倍（P1 回归）', () => {
    // 旧实现对数组根命中的是元素内键的缩进（基础×2），重写后再探测再×2，无界翻倍
    expect(detectJsonIndent('[\n  {\n    "id": 1\n  }\n]')).toBe('  ')
    expect(detectJsonIndent('[\n    {"a": 1},\n    {"b": 2}\n]')).toBe('    ')
    // 稳态：按探测值重写后再探测应得到同一缩进
    const src = '[\n  {\n    "id": 1\n  }\n]'
    const indent = detectJsonIndent(src)
    const rewritten = JSON.stringify(JSON.parse(src), null, indent) + '\n'
    expect(rewritten).toBe(src + '\n')
    expect(detectJsonIndent(rewritten)).toBe(indent)
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
