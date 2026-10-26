import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// UI 设计令牌静态门禁（规则正文见 .agents/conventions/ui-kit.md「UI 静态门禁」节）：
// 把设计规范里可机器判定的约束变成 CI 红灯——令牌三分支同步、跨文件同源、主题块外禁裸色值
// （白名单登记制）、字号/圆角/z-index/box-shadow 封闭集、核心令牌对 WCAG 2.2 对比度。
// 纯文本扫描，不 vi.mock 任何模块（singleFork 共享注册表，见测试指南）。
// 豁免说明：src/cloud/console.ts 尚未接入令牌体系（全页裸 px 字号/圆角），v1 仅参与令牌同源
// 校验，色值/字号扫描豁免（技术债登记在 ui-kit「已知例外与技术债」）；transition 时长存量
// 硬编码 .15s，暂不设门禁。

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC_UI = readFileSync(path.join(ROOT, 'src', 'gateway', 'ui.ts'), 'utf8')
const SRC_LAN = readFileSync(path.join(ROOT, 'src', 'gateway', 'lan.ts'), 'utf8')
const SRC_CLOUD = readFileSync(path.join(ROOT, 'src', 'cloud', 'console.ts'), 'utf8')

/** 提取全部 `:root…{…}` 块（含 [data-theme] 与 :not() 变体；括号配平），并返回置空这些块后的文本（保留换行以稳住行号） */
function extractRootBlocks(text: string): { blocks: { sel: string; body: string; start: number; end: number }[]; blanked: string } {
  const blocks: { sel: string; body: string; start: number; end: number }[] = []
  const re = /:root[^\n{}]*\{/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const open = m.index + m[0].length - 1
    let depth = 0
    let i = open
    for (; i < text.length; i++) {
      if (text[i] === '{') depth++
      else if (text[i] === '}') { depth--; if (depth === 0) break }
    }
    blocks.push({ sel: m[0].slice(0, -1).trim(), body: text.slice(open + 1, i), start: m.index, end: i + 1 })
  }
  let blanked = text
  for (const b of [...blocks].sort((a, b) => b.start - a.start)) {
    blanked = blanked.slice(0, b.start) + text.slice(b.start, b.end).replace(/[^\n]/g, ' ') + blanked.slice(b.end)
  }
  return { blocks, blanked }
}

/** 解析块体里的 CSS 自定义属性 → name:value（先剥 CSS 块注释；按分号切，兼容块尾无分号的最后一条） */
function parseVars(body: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const decl of body.replace(/\/\*[\s\S]*?\*\//g, '').split(';')) {
    const m = decl.match(/^\s*(--[\w-]+)\s*:\s*(.+?)\s*$/)
    if (m) map.set(m[1], m[2])
  }
  return map
}

const UI_BLOCKS = extractRootBlocks(SRC_UI)
const UI_ROOT = parseVars(UI_BLOCKS.blocks.find(b => b.sel === ':root')?.body ?? '')
const UI_LIGHT_ATTR = parseVars(UI_BLOCKS.blocks.find(b => b.sel.includes('[data-theme="light"]'))?.body ?? '')
const UI_LIGHT_MEDIA = parseVars(UI_BLOCKS.blocks.find(b => b.sel.includes(':not('))?.body ?? '')
const LAN_ROOT = parseVars(extractRootBlocks(SRC_LAN).blocks[0]?.body ?? '')
const CLOUD_ROOT = parseVars(extractRootBlocks(SRC_CLOUD).blocks[0]?.body ?? '')

// ---------------------------------------------------------------- ① 主题令牌三分支同步

// 主题相关令牌必须在三个分支都定义（--warn/--star 等主题不变量两主题同值，只放 :root，不在本清单）
const THEME_REQUIRED = [
  '--bg', '--card', '--text', '--muted', '--border',
  '--accent', '--accent-weak', '--ok', '--ok-weak', '--err',
  '--warn-weak', '--neutral-weak', '--ok-halo', '--warn-halo',
  '--direct-bg', '--direct-border', '--direct-text',
  '--direct-bg-h', '--direct-border-h', '--direct-text-h',
  '--shadow-sm', '--shadow-md', '--shadow-lg',
]

describe('① ui.ts 主题令牌三分支同步', () => {
  it('两个亮色分支（[data-theme=light] 与 prefers-color-scheme）键集合一致且值一致', () => {
    expect([...UI_LIGHT_MEDIA.keys()].sort()).toEqual([...UI_LIGHT_ATTR.keys()].sort())
    for (const [k, v] of UI_LIGHT_ATTR) {
      expect(UI_LIGHT_MEDIA.get(k), `${k} 两个亮色分支值不一致`).toBe(v)
    }
  })

  it('亮色分支只覆写 :root 已有令牌，不发明新令牌', () => {
    const invented = [...UI_LIGHT_ATTR.keys()].filter(k => !UI_ROOT.has(k))
    expect(invented, '亮色分支发明了 :root 没有的令牌（新主题令牌必须三分支同步）').toEqual([])
  })

  it('核心主题令牌三分支齐全', () => {
    for (const branch of [UI_ROOT, UI_LIGHT_ATTR, UI_LIGHT_MEDIA]) {
      const missing = THEME_REQUIRED.filter(k => !branch.has(k))
      expect(missing, `分支缺令牌（新令牌必须 :root + 两个亮色分支三处同步，见 ui-kit §令牌）`).toEqual([])
    }
  })

  // 主题不变量（单值双主题，只放 :root）：收编自散落值的弱底 tint / 中性细节 / on-accent 白 / 浮动投影
  const INVARIANT_REQUIRED = [
    '--err-weak', '--warn-tint', '--hover-tint', '--divider',
    '--on-accent', '--on-accent-dim',
    '--shadow-accent', '--shadow-accent-h', '--shadow-accent-soft',
    '--shadow-float', '--shadow-pop',
  ]

  it('主题不变量令牌（收编的弱底/细节/投影）在 :root 齐备', () => {
    const missing = INVARIANT_REQUIRED.filter(k => !UI_ROOT.has(k))
    expect(missing, '不变量令牌缺失（它们已被组件引用，删除即断样式）').toEqual([])
  })
})

// ---------------------------------------------------------------- ② 跨文件令牌同源

// lan.ts（手机页）与 cloud console.ts 的令牌必须与桌面暗色 :root 逐值一致（ui-kit「已知例外」：同源约定）
const PARITY_LAN = [
  '--bg', '--card', '--text', '--muted', '--border', '--accent', '--accent-weak',
  '--ok', '--ok-weak', '--warn', '--err', '--mono', '--on-accent',
  '--fs-xs', '--fs-sm', '--fs-md', '--fs-base', '--fs-lg', '--fs-xl',
  '--r-sm', '--r-md', '--r-lg', '--r-full',
  '--shadow-sm', '--shadow-md', '--shadow-lg',
  '--z-sticky', '--z-fab', '--z-toast', '--z-pop', '--z-modal', '--dur',
  // --scrim 不入本清单：lan=.55 与桌面 .5 是存量差异（移动 confirm 略深），强同源属设计变更
]
const PARITY_CLOUD = ['--bg', '--card', '--border', '--text', '--muted', '--ok', '--warn', '--err', '--accent']

describe('② 跨文件令牌同源（lan / cloud ↔ ui 暗色 :root）', () => {
  it.each([
    ['lan.ts', LAN_ROOT, PARITY_LAN],
    ['console.ts', CLOUD_ROOT, PARITY_CLOUD],
  ])('%s 与桌面 :root 同名令牌逐值一致', (_name, map, required) => {
    for (const k of required as string[]) {
      expect(map.get(k), `${k} 在对方文件缺失`).toBeDefined()
      expect(map.get(k), `${k} 值已与桌面 :root 漂移（改令牌必须三文件同步，见 ui-kit §令牌）`).toBe(UI_ROOT.get(k))
    }
  })
})

// ---------------------------------------------------------------- ③ 主题块外禁裸色值（白名单登记制）

type WlEntry = { file: 'ui' | 'lan'; re: RegExp; why: string }

// 白名单登记制：每条 = 文件 + 行级正则 + 理由。主题块外的每个 hex/rgba 必须命中至少一条；
// 反向约束：每条也必须命中至少一处（防陈旧条目沉淀）。可登记的只有三类：品牌固定色、
// 结构性固定色（on-accent 白/tooltip 反色调色板/二维码白底）、独立降级页与 JS 选择器误报；
// 其余一律先令牌化（2026-10 存量散落值已收编为 --err-weak/--warn-tint/--hover-tint/--divider/
// --on-accent(--dim)/--shadow-accent 系/--shadow-float/--shadow-pop，见 ui-kit §2/§14）。
const COLOR_WL: WlEntry[] = [
  // —— 品牌固定色（主题无关）
  { file: 'ui', re: /\.logo svg\{[^{}]*rgba\(79,70,229,\.35\)/, why: 'logo 品牌靛蓝投影（品牌固定色）' },
  { file: 'ui', re: /stop-color="#(6d7cff|4f46e5)"/, why: '品牌 logo 渐变（品牌固定色）' },
  { file: 'ui', re: /stroke="#fff"/, why: 'logo 描边白（品牌固定色）' },
  { file: 'lan', re: /theme-color" content="#0f1115"/, why: 'PWA 浏览器 chrome 品牌色' },
  { file: 'lan', re: /background_color: '#0f1115'/, why: 'webmanifest 品牌色' },
  { file: 'lan', re: /theme_color: '#0f1115'/, why: 'webmanifest 品牌色' },
  // —— 结构性固定色
  { file: 'ui', re: /#lanPanel svg\{[^{}]*background:#fff/, why: '二维码必须白底（扫码识别要求）' },
  { file: 'ui', re: /background:#111827/, why: 'tooltip 反色底（组件自带调色板，对比度已由本文件门禁）' },
  { file: 'ui', re: /color:#f5f5f5/, why: 'tooltip 反色字（组件自带调色板）' },
  { file: 'ui', re: /rgba\(255,255,255,\.12\)/, why: 'tooltip 反色系边框' },
  { file: 'ui', re: /#fabAdd/, why: 'JS id 选择器，非色值' },
  // —— 独立降级页（无令牌壳的 standalone 页面内联样式）
  { file: 'lan', re: /background:#0f1115/, why: '降级页内联底色（独立页无令牌壳）' },
  { file: 'lan', re: /color:#e5e7eb/, why: '降级页内联字色（独立页无令牌壳）' },
  { file: 'lan', re: /color:#9ca3af/, why: '降级页内联次级色（独立页无令牌壳）' },
]

const HEX_RE = /(?<=[(:,="'\s])#[0-9a-fA-F]{3,8}\b/g
const RGBA_RE = /\brgba?\(/g

/** 扫描置空主题块后的源码，返回 {行号, 匹配片段, 整行} 列表 */
function scanColors(src: string): { line: number; match: string; lineText: string }[] {
  const { blanked } = extractRootBlocks(src)
  const hits: { line: number; match: string; lineText: string }[] = []
  blanked.split('\n').forEach((lineText, i) => {
    for (const re of [HEX_RE, RGBA_RE]) {
      re.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = re.exec(lineText))) hits.push({ line: i + 1, match: m[0], lineText })
    }
  })
  return hits
}

function unwhitelisted(src: string, file: 'ui' | 'lan', wl: WlEntry[]): string[] {
  return scanColors(src)
    .filter(h => !wl.some(e => e.file === file && e.re.test(h.lineText)))
    .map(h => `  ${file}.ts:${h.line} [${h.match}] ${h.lineText.trim().slice(0, 90)}`)
}

describe('③ 主题块外禁裸色值（白名单登记制）', () => {
  it('ui.ts 每个裸色值都命中白名单条目', () => {
    expect(unwhitelisted(SRC_UI, 'ui', COLOR_WL), '新裸色值必须先令牌化；确属品牌/结构固定色的，到本文件 COLOR_WL 登记理由（见 ui-kit「UI 静态门禁」）').toEqual([])
  })

  it('lan.ts 每个裸色值都命中白名单条目', () => {
    expect(unwhitelisted(SRC_LAN, 'lan', COLOR_WL), '新裸色值必须先令牌化；确属品牌/结构固定色的，到本文件 COLOR_WL 登记理由（见 ui-kit「UI 静态门禁」）').toEqual([])
  })

  it('白名单条目必须全部命中（防陈旧条目沉淀）', () => {
    const stale: string[] = []
    for (const e of COLOR_WL) {
      const src = e.file === 'ui' ? SRC_UI : SRC_LAN
      const hit = scanColors(src).some(h => e.re.test(h.lineText))
      if (!hit) stale.push(`${e.file}: ${e.re} — ${e.why}`)
    }
    expect(stale, '白名单条目已无命中对象，应删除（对应散落值已收编或代码已改）').toEqual([])
  })
})

// ---------------------------------------------------------------- ④ 字号 / 圆角 / z-index / box-shadow 封闭集

const RADIUS_OK = /^(0|50%|999px|var\(--r-[\w-]+\))$/
// 视觉配套特例（永久豁免，非债务）：小尺寸品牌元素的配套圆角与滚动条 thumb
const RADIUS_WL: WlEntry[] = [
  { file: 'ui', re: /border-radius:7px/, why: 'logo（26px 品牌图标）与 seg 内嵌按钮的视觉配套圆角' },
  { file: 'ui', re: /border-radius:3px/, why: '滚动条 thumb 刻意小圆角' },
]
// 自定义投影特例（永久豁免）：品牌元素投影
const SHADOW_WL: WlEntry[] = [
  { file: 'ui', re: /\.logo svg\{[^{}]*box-shadow/, why: 'logo 品牌投影' },
]

function violatingLines(src: string, re: RegExp, okValue: (m: RegExpExecArray) => boolean, wl: WlEntry[], file: 'ui' | 'lan'): string[] {
  const { blanked } = extractRootBlocks(src)
  const bad: string[] = []
  blanked.split('\n').forEach((lineText, i) => {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(lineText))) {
      if (okValue(m)) continue
      if (wl.some(e => e.file === file && e.re.test(lineText))) continue
      bad.push(`  ${file}.ts:${i + 1} [${m[0].slice(0, 80)}]`)
    }
  })
  return bad
}

describe('④ 字号 / 圆角 / z-index / box-shadow 封闭集', () => {
  it('ui.ts 字号只经 --fs-*（零裸 px）', () => {
    const bad = violatingLines(SRC_UI, /font-size:\s*\d+(?:\.\d+)?px/g, () => false, [], 'ui')
    expect(bad, '字号必须用 var(--fs-*)，新档位先加令牌（见 ui-kit §字级）').toEqual([])
  })

  it('lan.ts 字号仅限移动变体契约档（16px 输入=iOS 防聚焦缩放；11px badge；13px 降级页）', () => {
    const allowed = new Set(['16px', '11px', '13px'])
    const bad = violatingLines(SRC_LAN, /font-size:\s*(\d+(?:\.\d+)?)px/g, m => allowed.has(`${m[1]}px`), [], 'lan')
    expect(bad, 'lan.ts 新字号先进本用例 allowed 集合并写明理由').toEqual([])
  })

  it('圆角只走 --r-* / 50% / 0 / 999px（存量视觉配套圆角走白名单）', () => {
    const check = (src: string, file: 'ui' | 'lan') => {
      const bad = violatingLines(src, /border-radius:\s*([^;}\n]+)/g, m => m[1].trim().split(/\s+/).every(p => RADIUS_OK.test(p)), RADIUS_WL, file)
      expect(bad, `新圆角必须用 var(--r-*)（见 ui-kit §令牌）；确需特例到 RADIUS_WL 登记理由`).toEqual([])
    }
    check(SRC_UI, 'ui')
    check(SRC_LAN, 'lan')
  })

  it('圆角/投影白名单条目必须全部命中（防陈旧）', () => {
    for (const e of [...RADIUS_WL, ...SHADOW_WL]) {
      const src = e.file === 'ui' ? SRC_UI : SRC_LAN
      const hit = src.split('\n').some(l => e.re.test(l))
      expect(hit, `白名单条目已无命中对象，应删除：${e.file}: ${e.re} — ${e.why}`).toBe(true)
    }
  })

  it('ui.ts z-index 只走 --z-* / calc(var(--z-*)) / 组件内局部叠序 1|2', () => {
    const bad = violatingLines(SRC_UI, /z-index:\s*([^;}\n]+)/g, m => /^(var\(--z-|calc\(var\(--z-|[12]$)/.test(m[1].trim()), [], 'ui')
    expect(bad, '弹层/浮层层级必须走 --z-*（见 ui-kit §令牌层级表）；组件内局部叠序只允许 1|2').toEqual([])
  })

  it('box-shadow 只走 --shadow-*；inset 竖条 / 呼吸光晕允许 var()/transparent/inset 组合（存量自定义投影走白名单）', () => {
    // 非投影类 box-shadow（.service.cur 的 accent 竖条、inuse-pulse 光晕 keyframes）由 var()/inset/transparent 组成，
    // 裸色投影（rgba/hex）除白名单外一律拒绝
    const ok = (m: RegExpExecArray) => {
      const stripped = m[1].replace(/var\(--[\w-]+\)/g, '').replace(/\b(inset|transparent|none)\b/g, '')
      return !/[#(]|rgb/.test(stripped)
    }
    const bad = violatingLines(SRC_UI, /box-shadow:\s*([^;}\n]+)/g, ok, SHADOW_WL, 'ui')
    expect(bad, '新投影必须用 var(--shadow-sm|md|lg)；确需特例到 SHADOW_WL 登记理由').toEqual([])
  })
})

// ---------------------------------------------------------------- ⑤ 核心令牌对 WCAG 2.2 对比度

// 只断言明暗两主题都达标的令牌对（AA 4.5:1 正文 / 3:1 UI 部件）；
// 亮色主题 ok/warn/star 小字、warn 弱底等存量不足对（3.2~2.0:1）记 ui-kit 技术债，不在此断言。
const AA_PAIRS: [string, string][] = [
  ['--text', '--bg'], ['--text', '--card'], ['--muted', '--card'],
  ['--accent', '--bg'], ['--accent', '--card'], ['--err', '--card'],
]
const UI3_PAIRS: [string, string][] = [['#ffffff', '--accent']]
const TOOLTIP_PAIRS: [string, string][] = [['#f5f5f5', '#111827']]

function luminance(hex: string): number {
  const h = hex.replace('#', '')
  const full = h.length === 3 ? [...h].map(c => c + c).join('') : h
  const [r, g, b] = [0, 2, 4].map(i => parseInt(full.slice(i, i + 2), 16) / 255)
    .map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrast(fg: string, bg: string): number {
  const [a, b] = [luminance(fg), luminance(bg)].sort((x, y) => y - x)
  return (a + 0.05) / (b + 0.05)
}

function hexOf(map: Map<string, string>, token: string): string {
  const v = map.get(token)
  if (!v || !/^#[0-9a-fA-F]{3,8}$/.test(v)) throw new Error(`令牌 ${token} 不是实色 hex（当前值：${v}）——对比度断言需同步维护`)
  return v
}

function checkPairs(theme: string, map: Map<string, string>, pairs: [string, string][], min: number): string[] {
  const fail: string[] = []
  for (const [fg, bg] of pairs) {
    const f = fg.startsWith('#') ? fg : hexOf(map, fg)
    const b = bg.startsWith('#') ? bg : hexOf(map, bg)
    const ratio = contrast(f, b)
    if (ratio < min) fail.push(`  ${theme}: ${fg} on ${bg} = ${ratio.toFixed(2)}:1（要求 ≥${min}:1）`)
  }
  return fail
}

describe('⑤ 核心令牌对 WCAG 2.2 对比度', () => {
  it('暗色/亮色两主题正文与关键前景 ≥4.5:1，on-accent/焦点 ≥3:1', () => {
    const fail = [
      ...checkPairs('暗色', UI_ROOT, AA_PAIRS, 4.5),
      ...checkPairs('亮色', UI_LIGHT_ATTR, AA_PAIRS, 4.5),
      ...checkPairs('暗色', UI_ROOT, UI3_PAIRS, 3),
      ...checkPairs('亮色', UI_LIGHT_ATTR, UI3_PAIRS, 3),
      ...checkPairs('tooltip（主题无关）', new Map(), TOOLTIP_PAIRS, 4.5),
    ]
    expect(fail, '对比度跌破 AA——调令牌值是设计决策，先过用户评审；断言对清单与本用例同步维护').toEqual([])
  })
})
