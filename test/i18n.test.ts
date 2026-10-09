import { describe, expect, it, afterEach } from 'vitest'
import { fakeHome } from './helpers.js'
import { setLang, getLang, t, normalizeLang, bi, biCat, biJoin, runWithLang } from '../src/util/i18n.js'
import { extractLangArgv, initLang, LANG_ENV } from '../src/config/lang.js'
import { loadConfig, ConfigError } from '../src/config/store.js'
import { atomicWrite } from '../src/util/fsx.js'
import { configPath } from '../src/util/paths.js'

afterEach(() => {
  setLang('zh')
  delete process.env[LANG_ENV]
})

describe('t() 内核', () => {
  it('默认 zh：返回中文参', () => {
    setLang('zh')
    expect(t('取消', 'Cancel')).toBe('取消')
  })

  it('en：返回英文参；英文为空串回退中文', () => {
    setLang('en')
    expect(t('取消', 'Cancel')).toBe('Cancel')
    expect(t('取消', '')).toBe('取消')
  })

  it('{name} 占位插值；缺参保留占位符原样', () => {
    const params = { port: 8687, name: 'ark' }
    expect(t('端口 {port} 被占用', 'Port {port} in use', params)).toBe('端口 8687 被占用')
    setLang('en')
    expect(t('provider「{name}」不可用', 'Provider "{name}" unavailable', params)).toBe('Provider "ark" unavailable')
    expect(t('值 {missing}', 'Value {missing}', params)).toBe('Value {missing}')
  })

  it('数字与字符串参数统一转字符串；字面花括号无参不动', () => {
    expect(t('a{v}b', 'a{v}b', { v: 0 })).toBe('a0b')
    expect(t('JSON {a: 1}', 'JSON {a: 1}')).toBe('JSON {a: 1}')
  })
})

describe('normalizeLang', () => {
  it('识别 zh/zh-CN/zh_CN 与 en/en-US', () => {
    expect(normalizeLang('zh')).toBe('zh')
    expect(normalizeLang('zh-CN')).toBe('zh')
    expect(normalizeLang('zh_CN.UTF-8')).toBe('zh')
    expect(normalizeLang('en')).toBe('en')
    expect(normalizeLang('en-US')).toBe('en')
  })

  it('空值与未知值返回 undefined', () => {
    expect(normalizeLang(undefined)).toBeUndefined()
    expect(normalizeLang('')).toBeUndefined()
    expect(normalizeLang('fr')).toBeUndefined()
  })
})

describe('extractLangArgv', () => {
  it('摘除 --lang 值形式与等号形式，其余原序保留', () => {
    expect(extractLangArgv(['node', 'cli', '--lang', 'en', 'status'])).toEqual({ rest: ['node', 'cli', 'status'], raw: 'en' })
    expect(extractLangArgv(['node', 'cli', 'status', '--lang=en'])).toEqual({ rest: ['node', 'cli', 'status'], raw: 'en' })
    expect(extractLangArgv(['node', 'cli', 'gateway', 'start', '--port', '18990'])).toEqual({
      rest: ['node', 'cli', 'gateway', 'start', '--port', '18990'],
      raw: undefined,
    })
  })

  it('--lang 无值记为空串（后续报错），不吞相邻选项', () => {
    expect(extractLangArgv(['node', 'cli', '--lang', '--port', '1'])).toEqual({ rest: ['node', 'cli', '--port', '1'], raw: '' })
  })
})

describe('initLang 解析链', () => {
  it('优先级：--lang > 环境变量 > config > 默认 zh', async () => {
    const h = fakeHome()
    try {
      await atomicWrite(configPath(), 'language = "en"\n')
      // config=en 生效
      await initLang(['node', 'cli', 'status'])
      expect(getLang()).toBe('en')
      // 环境变量压过 config
      process.env[LANG_ENV] = 'zh'
      await initLang(['node', 'cli', 'status'])
      expect(getLang()).toBe('zh')
      // flag 压过环境变量
      await initLang(['node', 'cli', '--lang', 'en', 'status'])
      expect(getLang()).toBe('en')
      // 无任何设置 → 默认 zh
      delete process.env[LANG_ENV]
      await atomicWrite(configPath(), '')
      await initLang(['node', 'cli'])
      expect(getLang()).toBe('zh')
    } finally {
      h.restore()
    }
  })

  it('非法 --lang 值抛可操作报错', async () => {
    await expect(initLang(['node', 'cli', '--lang', 'fr', 'status'])).rejects.toThrow(/fr/)
    await expect(initLang(['node', 'cli', '--lang', 'status'])).rejects.toThrow(/zh \| en/)
  })

  it('非法环境变量报错；非法 config 值由 loadConfig 报 ConfigError', async () => {
    process.env[LANG_ENV] = 'fr'
    await expect(initLang(['node', 'cli'])).rejects.toThrow(/fr/)

    const h = fakeHome()
    try {
      await atomicWrite(configPath(), 'language = "fr"\n')
      await expect(loadConfig()).rejects.toBeInstanceOf(ConfigError)
    } finally {
      h.restore()
    }
  })
})

describe('bi 双语对与请求级语言', () => {
  it('bi 与当前语言无关地同时渲染两种语言；空 en 回退 zh；参数支持 Bilingual', () => {
    setLang('en')
    expect(bi('端口 {p}', 'Port {p}', { p: 8687 })).toEqual({ zh: '端口 8687', en: 'Port 8687' })
    expect(bi('仅中文', '')).toEqual({ zh: '仅中文', en: '仅中文' })
    expect(bi('模型 {m}', 'Model {m}', { m: bi('甲', 'A') })).toEqual({ zh: '模型 甲', en: 'Model A' })
    setLang('zh')
  })

  it('biCat/biJoin：字符串元素语言无关，Bilingual 元素各取各语言，空元素剔除', () => {
    expect(biCat('a', bi('中', 'EN'), '-', bi('文', 'EN2'))).toEqual({ zh: 'a中-文', en: 'aEN-EN2' })
    expect(biJoin('、', ', ', ['x', bi('甲', 'A'), '', bi('乙', 'B')])).toEqual({ zh: 'x、甲、乙', en: 'x, A, B' })
    expect(biJoin('、', ', ', [])).toEqual({ zh: '', en: '' })
  })

  it('runWithLang：上下文内 t()/getLang() 取上下文语言，退出回落全局', () => {
    setLang('zh')
    runWithLang('en', () => {
      expect(getLang()).toBe('en')
      expect(t('取消', 'Cancel')).toBe('Cancel')
    })
    expect(getLang()).toBe('zh')
    expect(t('取消', 'Cancel')).toBe('取消')
  })

  it('runWithLang 随异步链传播且并发请求互不串扰', async () => {
    const enP = runWithLang('en', async () => {
      await new Promise((r) => setTimeout(r, 10))
      expect(getLang()).toBe('en')
      return t('取消', 'Cancel')
    })
    const zhP = runWithLang('zh', async () => {
      await new Promise((r) => setTimeout(r, 2))
      expect(getLang()).toBe('zh')
      return t('取消', 'Cancel')
    })
    expect(await enP).toBe('Cancel')
    expect(await zhP).toBe('取消')
  })
})
