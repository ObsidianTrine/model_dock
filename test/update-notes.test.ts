import { describe, expect, it } from 'vitest'
import { notesSummary, notesSummaryText, notesToPlain } from '../src/update/notes.js'

// 纯函数（无 i18n 依赖注入、无网络、无文件）：只锚定「去标记 + 摘要收口」的行为契约

/** 与真实发布说明同构：首段摘要 + 「### 新增/改进/修复」+ 加粗点题的长条目 */
const RELEASE_BODY = `一个「日常维护更省心」的版本：菜单栏可一键清理数据，没配备用链也能自动切、额度用完自动切。

### 新增

- **菜单栏 / 托盘可以一键清理数据**：菜单里新增「清理数据…」，确认后自动把被接管的客户端还原成接入前的样子，并删掉 ModelDock 保存的全部数据。

### 改进

- **导出的配置包文件名带上时间**：配置包文件名从「只到日期」（\`modeldock-config-20261007.msync\`）改成到秒。
- **导出配置包只输一次口令**：桌面控制台导出配置包时不再要求「输两遍确认」，只输一次即可。
- **模型的「视觉」能力可勾选**：编辑服务的模型表在上下文 / 最大输出后面新增一列「视觉」。
- **模型表里能看出模型叫什么**：编辑 / 添加服务时，模型 ID 下方会用小字显示模型的展示名。
- **额度用完自动切**：服务返回「余额不足 / 额度耗尽」（HTTP 402）时自动改发备用服务。

### 修复

- **手机远程不再容易被误关**：右侧整段都是展开 / 收起，分隔线就是命中边界。
`

describe('notesToPlain：markdown → 纯文本', () => {
  it('去标题 / 粗体 / 行内代码，条目统一「· 」前缀，段落之间留空行', () => {
    const out = notesToPlain(RELEASE_BODY)
    expect(out.startsWith('一个「日常维护更省心」的版本：')).toBe(true)
    expect(out).toContain('\n\n新增\n· 菜单栏 / 托盘可以一键清理数据：')
    expect(out).toContain('\n\n改进\n· 导出的配置包文件名带上时间：')
    // 条目之间不插空行（列表成块）
    expect(out).toContain('· 导出的配置包文件名带上时间：配置包文件名从「只到日期」（modeldock-config-20261007.msync）改成到秒。\n· 导出配置包只输一次口令：')
    expect(out).not.toContain('**')
    expect(out).not.toContain('###')
    expect(out).not.toContain('`')
    expect(out.endsWith('· 手机远程不再容易被误关：右侧整段都是展开 / 收起，分隔线就是命中边界。')).toBe(true)
  })

  it('链接 / 图片 / HTML 标签 / 分隔线一并降级', () => {
    const out = notesToPlain('看 [CHANGELOG](https://example.com/c.md) 与 ![图](https://x/y.png)\n\n---\n\n<br>粗<strong>体</strong>与 *斜体*')
    expect(out).toContain('看 CHANGELOG (https://example.com/c.md) 与 图')
    expect(out).toContain('粗体与 斜体')
    expect(out).not.toContain('---')
    expect(out).not.toContain('<strong>')
  })

  it('空 / 纯空白输入 → 空串', () => {
    expect(notesToPlain('')).toBe('')
    expect(notesToPlain('\n\n  \n')).toBe('')
  })

  it('CRLF 正文与 LF 等价（Windows 上编辑过的说明不该多出 \\r）', () => {
    const lf = notesToPlain(RELEASE_BODY)
    expect(notesToPlain(RELEASE_BODY.replace(/\n/g, '\r\n'))).toBe(lf)
    expect(lf).not.toContain('\r')
  })
})

describe('notesSummary：摘要收口', () => {
  it('首段 + 前 4 条加粗点题；total 报原文条目总数（供「另有 N 项」）', () => {
    const s = notesSummary(RELEASE_BODY)
    expect(s.summary).toBe('一个「日常维护更省心」的版本：菜单栏可一键清理数据，没配备用链也能自动切、额度用完自动切。')
    expect(s.items).toEqual([
      '菜单栏 / 托盘可以一键清理数据',
      '导出的配置包文件名带上时间',
      '导出配置包只输一次口令',
      '模型的「视觉」能力可勾选',
    ])
    expect(s.total).toBe(7)
  })

  it('正文以条目开头：无摘要段（summary 为空），条目照常收口', () => {
    const s = notesSummary('- **只有条目**：细节\n- **第二条**：细节')
    expect(s.summary).toBe('')
    expect(s.items).toEqual(['只有条目', '第二条'])
    expect(s.total).toBe(2)
  })

  it('摘要与点题里不放网址：发布页链接只由调用方单独给（托盘按「最后一个网址」取链接）', () => {
    const s = notesSummary('看 [发布页](https://example.com/rel) 的说明\n\n- **要点**：细节见 https://example.com/x')
    expect(s.summary).toBe('看 发布页 的说明')
    expect(s.items).toEqual(['要点'])
    expect(`${s.summary}${s.items.join('')}`).not.toContain('http')
  })

  it('摘网址不吃掉后面的正文：网址止于空格或中文标点（中文句子没有空格）', () => {
    const s = notesSummary(
      '本次改动要求手动改 base_url：把客户端指向 http://127.0.0.1:8687，然后重启客户端即可生效。\n\n' +
        '- 手机远程见 http://127.0.0.1:8787（默认关闭）与手机导出\n' +
        '- 见文档（https://example.com/x）后续说明'
    )
    expect(s.summary).toBe('本次改动要求手动改 base_url：把客户端指向，然后重启客户端即可生效。')
    expect(s.items).toEqual(['手机远程见（默认关闭）与手机导出', '见文档后续说明'])
    expect(`${s.summary}${s.items.join('')}`).not.toContain('http')
  })

  it('整条只有网址的条目降级后为空：丢弃空条目并用后面的条目补位', () => {
    const s = notesSummary('- https://example.com/x\n- **真要点**：细节\n- [https://example.com/x](https://example.com/x)', { maxItems: 2 })
    expect(s.items).toEqual(['真要点'])
    expect(s.total).toBe(3)
  })

  it('截断不劈开 emoji（按码点切，代理对完整保留）', () => {
    const s = notesSummary(`- ${'甲'.repeat(11)}🎉尾巴尾巴尾巴`, { maxItemChars: 12 })
    expect(s.items[0]).toBe(`${'甲'.repeat(11)}🎉…`)
    // 无孤立高位 / 低位代理
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(s.items[0])).toBe(false)
    expect(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s.items[0])).toBe(false)
  })

  it('有序列表降级为「· 」；代码围栏内容原样保留、围栏标记去掉', () => {
    const out = notesToPlain('1. 第一项\n2. 第二项\n\n```\n**不是粗体**\n```')
    expect(out).toContain('· 第一项\n· 第二项')
    expect(out).toContain('**不是粗体**')
    expect(out).not.toContain('```')
  })

  it('没有加粗点题的条目：整句截断到上限并以省略号收尾（不硬切在字中间）', () => {
    const s = notesSummary('- 一条很长的说明，前半句说清楚是什么，后半句才补细节，还有更多内容继续往下写', { maxItemChars: 20 })
    expect(s.items).toHaveLength(1)
    expect(s.items[0].endsWith('…')).toBe(true)
    expect(s.items[0].length).toBeLessThanOrEqual(21)
    expect(s.items[0]).not.toContain('更多内容')
  })

  it('maxItems 可调；条目少时原样返回', () => {
    expect(notesSummary(RELEASE_BODY, { maxItems: 2 }).items).toHaveLength(2)
    expect(notesSummary('- 甲\n- 乙', { maxItems: 9 })).toMatchObject({ items: ['甲', '乙'], total: 2 })
  })

  it('空说明：不产生空条目（原生弹窗据此跳过说明区）', () => {
    const s = notesSummary('   \n\n')
    expect(s).toMatchObject({ summary: '', items: [], total: 0 })
  })
})

describe('notesSummaryText：摘要整段纯文本（CLI 检查输出与 /admin/update/status 的 summary 字段同源同形）', () => {
  it('首段 + 「· 」条目；原文条目多于收录数时补「（共 N 项改动，其余见发布页）」', () => {
    const out = notesSummaryText(RELEASE_BODY)
    expect(out.startsWith('一个「日常维护更省心」的版本：')).toBe(true)
    expect(out).toContain('\n· 菜单栏 / 托盘可以一键清理数据')
    expect(out).toContain('（共 7 项改动，其余见发布页）')
    // 只收 maxItems 条
    expect(out.split('\n').filter((l) => l.startsWith('· '))).toHaveLength(4)
    expect(out).not.toContain('###')
    expect(out).not.toContain('**')
  })

  it('条目未超量不补总数行；全空输入 → 空串', () => {
    expect(notesSummaryText('- **甲**：细节')).toBe('· 甲')
    expect(notesSummaryText('   \n\n')).toBe('')
  })
})
