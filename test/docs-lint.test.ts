import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// 对外文档规范门禁（docs-lint）：把 .agents/conventions/docs-writing.md 与
// .agents/workflows/docs-sync.md 两份规范 checklist 里的**可机检项**变成 CI 红灯，防文档规范回潮。
// 规则只消费这两份既有约定，不新造规范；每条规则上方注明「为什么」与规范出处。
//
// 【显式留人工的不可机检项】（docs-writing「自检清单」/ docs-sync checklist 其余条目）：
// - 条目是否「用户视角 / 一条一事 / 说人话 / ≤2 行」、有无内部术语混入——语义判断；
// - README 首屏三问（是什么 / 解决什么 / 怎么开始）是否成立、截图与当前 UI 是否一致（UI 大改版后重拍）；
// - CHANGELOG 范围完整性（tag..HEAD 全部提交有无漏记——对照提交记录，机器无法判定「该记未记」）;
// - 新增能力是否同步能力表 / 命令块 / 支持列表（语义 diff，标题结构同步只能兜底结构层）；
// - AGENTS.md「多 Agent 并行开发约定」工作流列表是否随新增工作流文件同步；
// - config-reference.md 与代码的新鲜度——已有 test/config-reference.test.ts 专测，此处不重复。
//
// 实现为纯文本扫描，不 vi.mock 任何模块（singleFork 共享注册表，见测试指南）；
// 全部路径 path.join/resolve、断言前换行归一化，三平台一致（win32 兼容）。

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// ---------------------------------------------------------------- 文件集合（规范口径）

// 中文对外文档：docs-writing「文档体系」表的用户文档 + docs-sync checklist 点名文件。
// 内部文档（docs/design*、known-issues、backlog、AGENTS.md、REVIEW.md 等）不在规范的自检范围，不扫。
const ZH_ROOT_DOCS = ['README.md', 'CHANGELOG.md', 'CONTRIBUTING.md', 'SECURITY.md']
const ZH_DOCS_DIR_DOCS = ['usage.md', 'config-reference.md', 'multi-machine-sync.md', 'deploy-cloud.md']

// zh → en 镜像对：docs-writing「多语言文档结构」点名的镜像清单（七件套）。
// config-reference.md 虽有 en 镜像，但是脚本生成文件（新鲜度有专测），不参与结构类断言；链接扫描仍覆盖它。
const MIRROR_PAIRS: [string, string][] = [
  ['README.md', 'docs/en/README.md'],
  ['CHANGELOG.md', 'docs/en/CHANGELOG.md'],
  ['CONTRIBUTING.md', 'docs/en/CONTRIBUTING.md'],
  ['SECURITY.md', 'docs/en/SECURITY.md'],
  ['docs/usage.md', 'docs/en/usage.md'],
  ['docs/multi-machine-sync.md', 'docs/en/multi-machine-sync.md'],
  ['docs/deploy-cloud.md', 'docs/en/deploy-cloud.md'],
]

// 切换行 / 链接可达的扫描集：中文对外文档 + docs/en/ 全量镜像（未来新增镜像文件自动纳入）。
function walkEnDocs(root: string): string[] {
  const dir = path.join(root, 'docs', 'en')
  if (!existsSync(dir)) return []
  const out: string[] = []
  const walk = (d: string, rel: string[]) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(d, e.name), [...rel, e.name])
      else if (e.name.endsWith('.md')) out.push(path.join('docs', 'en', ...rel, e.name))
    }
  }
  walk(dir, [])
  return out.sort()
}

// ---------------------------------------------------------------- 文本预处理

// 剥掉「不是正文」的行内容，返回与原文件逐行等长的行数组（被剥处为空串，保住行号）：
// 1) HTML 注释——必须先于链接提取：切换行下的 i18n-slot 注释里含「新增语言示例链接」
//    （如 docs/ja/README.md，并不存在），不剥必误报；
// 2) 围栏代码块（```）——README/usage 的 bash 示例里有行首 `#` 注释，会被当成标题；块内也不该有可点链接；
// 3) 行内代码——`[x](y)` 在反引号里不是可点链接。
// 只处理 ``` 围栏（本仓文档不用 ~~~）；单个未闭合 ``` 之后的行视为围栏内容（漏报方向，不误报）。
function stripIgnoredLines(text: string): string[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  let fence = false
  let comment = false
  return lines.map((raw) => {
    let line = raw
    if (comment) {
      const end = line.indexOf('-->')
      if (end === -1) return ''
      line = line.slice(end + 3)
      comment = false
    }
    line = line.replace(/<!--.*?-->/g, '')
    const open = line.indexOf('<!--')
    if (open !== -1) {
      line = line.slice(0, open)
      comment = true
    }
    if (/^\s*```/.test(line)) {
      fence = !fence
      return ''
    }
    if (fence) return ''
    // 行内代码置空：按反引号切段，偶数段（非代码段）保留
    return line.split('`').map((seg, i) => (i % 2 === 0 ? seg : '')).join('')
  })
}

const readLines = (root: string, rel: string): string[] | null => {
  const abs = path.join(root, rel)
  if (!existsSync(abs)) return null
  return readFileSync(abs, 'utf8').replace(/\r\n/g, '\n').split('\n')
}

// ---------------------------------------------------------------- 规则 1：内链与图片可达性

// 为什么：docs-writing「自检清单」「对外文档里的相对链接与图片（含截图）全部可达吗（改完跑一次链接自检）」
// + docs-sync「README 收尾核对：README / usage 里的相对链接与截图（docs/images/）全部可达」
// + docs-sync「英文镜像：顺手核对新旧文档顶部语言切换行的链接都未断」。
// 只查仓库内相对路径；http(s)/mailto/纯锚点跳过（外链连通性是网络问题，不进门禁）；
// 锚点存在性不校验——GitHub 对中文标题的 slug 规则复杂，误报率高（宁少勿滥，显式不做）；
// 路径逐段按目录项**精确大小写**匹配——NTFS 大小写不敏感会让坏大小写在 Windows 本地放行、Linux CI 必挂。
export interface LintViolation {
  file: string
  line?: number
  message: string
}

const LINK_RE = /!?\[([^\]\n]*)\]\(([^()\s]+)\)/g

function resolveExact(root: string, fromDir: string, target: string): string | null {
  // 返回 null 表示可达；否则返回原因。target 已去锚点、已 URL 解码、以 / 分段。
  // 剔除 '.' 段：path.dirname('README.md') 返回 '.'，不剔除的话 '..' 会先弹出它，
  // 逃出仓库根的守卫（stack.length===0）永远轮不到触发（首个负例 fixture 抓出的真 bug）。
  const stack = fromDir.split(path.sep).filter((p) => p !== '' && p !== '.')
  for (const rawPart of target.split('/')) {
    if (rawPart === '' || rawPart === '.') continue
    if (rawPart === '..') {
      if (stack.length === 0) return '链接逃出仓库根'
      stack.pop()
      continue
    }
    let part = rawPart
    try {
      part = decodeURIComponent(rawPart)
    } catch {
      return `URL 编码非法：${rawPart}`
    }
    let entries: string[]
    try {
      entries = readdirSync(path.join(root, ...stack))
    } catch {
      return `目录不存在：${stack.join('/') || '<仓库根>'}`
    }
    const exact = entries.find((e) => e === part)
    if (exact) {
      stack.push(exact)
      continue
    }
    const ci = entries.find((e) => e.toLowerCase() === part.toLowerCase())
    if (ci) return `大小写不匹配：链接写 ${part}，实际是 ${ci}（Windows 本地放行、Linux CI 必挂）`
    return `路径不存在：${[...stack, part].join('/')}`
  }
  return null
}

export function checkLinks(root: string): LintViolation[] {
  const files = [...ZH_ROOT_DOCS, ...ZH_DOCS_DIR_DOCS.map((f) => path.join('docs', f)), ...walkEnDocs(root)]
  const violations: LintViolation[] = []
  for (const rel of files) {
    const abs = path.join(root, rel)
    if (!existsSync(abs)) continue
    const lines = stripIgnoredLines(readFileSync(abs, 'utf8'))
    lines.forEach((line, idx) => {
      LINK_RE.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = LINK_RE.exec(line))) {
        const target = m[2]
        if (/^(https?:|mailto:)/i.test(target)) continue
        const noAnchor = target.split('#')[0].split('?')[0]
        if (!noAnchor) continue // 纯锚点（本页内跳转）
        const reason = resolveExact(root, path.dirname(rel), noAnchor)
        if (reason) violations.push({ file: rel, line: idx + 1, message: `${reason}（链接目标：${target}）` })
      }
    })
  }
  return violations
}

// ---------------------------------------------------------------- 规则 2：en 镜像文件齐全

// 为什么：docs-writing「多语言文档结构」——「英文版是翻译镜像……文件与目录结构和中文一一对应」点名的
// 七件套；docs-sync「英文镜像」节要求同一交付里更新对应镜像。中文存在而 en 缺镜像 = 同步违规。
// 只单向查（zh 存在 → en 必须存在）：中文是唯一事实来源，zh 不存在时跳过；en 有而 zh 无规范未禁止，不查。
export function checkMirrors(root: string): LintViolation[] {
  return MIRROR_PAIRS.filter(([zh]) => existsSync(path.join(root, zh)))
    .filter(([, en]) => !existsSync(path.join(root, ...en.split('/'))))
    .map(([zh, en]) => ({ file: en, message: `英文镜像缺失：${zh} 存在但 ${en} 不存在（docs-writing「多语言文档结构」：中文对外文档须有 en 镜像）` }))
}

// ---------------------------------------------------------------- 规则 3：语言切换行 + i18n-slot

// 为什么：docs-writing「多语言文档结构」——「每篇对外文档 H1 标题下第一行是切换行——当前语言加粗、
// 其他语言是相对链接；其下紧跟一行 <!-- i18n-slot：… --> 注释（新增语言的预留插入位）」。
// 宽松判定防误报：只要求「含粗体 + 含相对链接」（不校验具体语言文案/链接数）与「下一非空行是含
// i18n-slot 的 HTML 注释」。切换行链接本身的可达性由规则 1 覆盖。在原始行上检查（注释正是被检对象）。
export function checkSwitchers(root: string): LintViolation[] {
  const files = [...ZH_ROOT_DOCS, ...ZH_DOCS_DIR_DOCS.map((f) => path.join('docs', f)), ...walkEnDocs(root)]
  const violations: LintViolation[] = []
  for (const rel of files) {
    const raw = readLines(root, rel)
    if (!raw) continue
    const h1 = raw.findIndex((l) => /^# /.test(l))
    if (h1 === -1) {
      violations.push({ file: rel, message: '缺 H1 标题（切换行规范：H1 下第一行是语言切换行）' })
      continue
    }
    const after = raw.slice(h1 + 1).filter((l) => l.trim() !== '')
    const switcher = after[0] ?? ''
    const slot = after[1] ?? ''
    if (!(/\*\*/.test(switcher) && /\]\((?!https?:)[^)]+\)/.test(switcher))) {
      violations.push({ file: rel, line: h1 + 2, message: `H1 下第一行不是语言切换行（应为「当前语言加粗 ｜ [其他语言](相对链接)」），实际：${switcher.slice(0, 60)}` })
      continue
    }
    if (!(slot.startsWith('<!--') && slot.includes('i18n-slot'))) {
      violations.push({ file: rel, line: h1 + 3, message: `切换行下缺少 i18n-slot 预留注释行，实际：${slot.slice(0, 60)}` })
    }
  }
  return violations
}

// ---------------------------------------------------------------- 规则 4：en 镜像 H2 章节结构同步

// 为什么：docs-writing「多语言文档结构·同步规则」——改动中文对外文档须同一交付更新 en 镜像，
// 「文件与目录结构和中文一一对应」。比较 H2 层级序列（剥围栏/注释后，行首 `## `）：
// - 只比层级**序列**、不比标题文本：en 分节名存在合法变体（zh「改进」→ en「Changed」/「Improvements」），比文本必误报；
// - 只比 H2 不比 H3：现行 zh usage.md 有「### MCP 服务器盘点（只读）」而 en 镜像缺该子节（真实同步滞后，
//   已另行上报；本任务红线禁止改对外文档正文），纳入 H3 会让门禁立即红——待镜像补齐后可收紧到 H3。
export function checkH2Sync(root: string): LintViolation[] {
  const violations: LintViolation[] = []
  for (const [zh, en] of MIRROR_PAIRS) {
    const zhLines = readLines(root, zh)
    const enLines = readLines(root, en)
    if (!zhLines || !enLines) continue // 文件存在性由规则 2 负责
    const h2 = (lines: string[]) => stripIgnoredLines(lines.join('\n')).filter((l) => /^## /.test(l)).length
    const zhCount = h2(zhLines)
    const enCount = h2(enLines)
    if (zhCount !== enCount) {
      violations.push({ file: en, message: `en 镜像 H2 章节数与中文不同步：${zh} 有 ${zhCount} 个 H2，${en} 有 ${enCount} 个（docs-writing「同步规则」：中文改动须同一交付更新 en 镜像）` })
    }
  }
  return violations
}

// ---------------------------------------------------------------- 规则 5：CHANGELOG 条目粗体点题

// 为什么：docs-writing「总原则 2：一条一事——粗体短语点题」+ CHANGELOG 模板条目形态 `- **功能点**：说明`。
// 只查规范点名的三节（zh「新增 / 修复 / 改进」；en 对应 Added / Fixed / Improved / Improvements / Changed——
// 后两个是本仓 CHANGELOG 既有的合法 en 分节名变体）。其余分节不查：v1.0.0 的「### 国际化」等历史分节
// 存在平条目（规范晚于内容，红线禁止改正文）；缩进子列表（补充说明）不查；每遇任何标题行重置当前分节。
export function checkChangelogBold(root: string): LintViolation[] {
  const targets: { rel: string; sect: RegExp }[] = [
    { rel: 'CHANGELOG.md', sect: /^(新增|修复|改进)$/ },
    { rel: 'docs/en/CHANGELOG.md', sect: /^(Added|Fixed|Improved|Improvements|Changed)$/ },
  ]
  const violations: LintViolation[] = []
  for (const { rel, sect } of targets) {
    const raw = readLines(root, rel)
    if (!raw) continue
    // 剥围栏/注释/行内代码后再判：目标分节里若出现 ``` 代码块，围栏内的 `- ` 行不是条目，
    // 直接扫原文会误报；stripIgnoredLines 与原文逐行等长，违规行号保持不变。
    const lines = stripIgnoredLines(raw.join('\n'))
    let current: string | null = null
    lines.forEach((line, idx) => {
      if (/^## /.test(line)) {
        current = null
        return
      }
      const h3 = line.match(/^###\s+(.+?)\s*$/)
      if (h3) {
        current = sect.test(h3[1]) ? h3[1] : null
        return
      }
      if (current && /^- /.test(line) && !/^- \*\*/.test(line)) {
        violations.push({ file: rel, line: idx + 1, message: `${rel} 的「### ${current}」分节条目未粗体点题（规范：每条以 **粗体短语** 开头）：${line.slice(0, 60)}` })
      }
    })
  }
  return violations
}

// ---------------------------------------------------------------- 规则 6：版本链接表同步

// 为什么：docs-writing「CHANGELOG 归并规则：打 tag 前把「未发布」段归并进版本段……文末版本链接表同步补一行」。
// 每个 `## [x.y.z] - 日期` 版本段必须在文末有 `[x.y.z]: <链接>` 引用定义；「未发布 / Unreleased」是工作区，
// 归并前无链接定义是合法状态，豁免。
export function checkVersionLinks(root: string): LintViolation[] {
  const violations: LintViolation[] = []
  for (const rel of ['CHANGELOG.md', 'docs/en/CHANGELOG.md']) {
    const raw = readLines(root, rel)
    if (!raw) continue
    // 同规则 5：剥围栏/注释后再判，防止示例代码块里的 `## [x.y.z]` 被当成版本段（行号不变）。
    const lines = stripIgnoredLines(raw.join('\n'))
    const versions: { ver: string; line: number }[] = []
    const defs = new Set<string>()
    lines.forEach((line, idx) => {
      const v = line.match(/^## \[([^\]]+)\] - \d{4}-\d{2}-\d{2}\s*$/)
      if (v) versions.push({ ver: v[1], line: idx + 1 })
      const d = line.match(/^\[([^\]]+)\]:\s*\S/)
      if (d) defs.add(d[1])
    })
    for (const { ver, line } of versions) {
      if (/^(未发布|unreleased)$/i.test(ver)) continue
      if (!defs.has(ver)) violations.push({ file: rel, line, message: `版本 [${ver}] 在文末链接表缺少引用定义（规范：文末版本链接表同步补一行 [${ver}]: <compare 链接>）` })
    }
  }
  return violations
}

// ---------------------------------------------------------------- 规则 7：README 核心能力表 ≤8 行

// 为什么：docs-writing「README 结构蓝图 5：核心能力表格（领域｜你能得到什么，≤8 行）」——防 README
// 回到长 bullet 墙。数表格数据行（剥围栏后 `|` 开头、排除分隔行与表头行），zh「## 核心能力」与
// en「## Core capabilities」各自计数；章节缺失本身算违规（蓝图要求该表存在）。
export function checkCapabilityTable(root: string): LintViolation[] {
  const targets: { rel: string; heading: RegExp }[] = [
    { rel: 'README.md', heading: /^## 核心能力/ },
    { rel: 'docs/en/README.md', heading: /^## Core capabilities/ },
  ]
  const violations: LintViolation[] = []
  for (const { rel, heading } of targets) {
    const lines = readLines(root, rel)
    if (!lines) continue
    const stripped = stripIgnoredLines(lines.join('\n'))
    const start = stripped.findIndex((l) => heading.test(l))
    if (start === -1) {
      violations.push({ file: rel, message: '缺「核心能力」表格章节（README 结构蓝图第 5 项）' })
      continue
    }
    let rows = 0
    for (const line of stripped.slice(start + 1)) {
      if (/^## /.test(line)) break
      if (!/^\|/.test(line)) continue
      if (/^\|[\s:|-]+\|?\s*$/.test(line)) continue // 分隔行
      rows++
    }
    const dataRows = Math.max(0, rows - 1) // 减表头行
    if (dataRows > 8) violations.push({ file: rel, message: `核心能力表 ${dataRows} 行，超过结构蓝图上限 8 行（README 不堆长文）` })
  }
  return violations
}

// ---------------------------------------------------------------- 真实文档：develop 现行必须全绿

const REAL_DOCS = checkAll(ROOT)

function checkAll(root: string): LintViolation[] {
  return [
    ...checkLinks(root),
    ...checkMirrors(root),
    ...checkSwitchers(root),
    ...checkH2Sync(root),
    ...checkChangelogBold(root),
    ...checkVersionLinks(root),
    ...checkCapabilityTable(root),
  ]
}

describe('docs-lint：现行对外文档（develop 基线零误报）', () => {
  it('扫描集非空且中文对外文档齐全（防文件集配置失效导致静默通过）', () => {
    for (const rel of [...ZH_ROOT_DOCS, ...ZH_DOCS_DIR_DOCS.map((f) => path.join('docs', f))]) {
      expect(existsSync(path.join(ROOT, rel)), `扫描集文件缺失：${rel}`).toBe(true)
    }
    expect(walkEnDocs(ROOT).length).toBeGreaterThanOrEqual(7)
  })

  it('规则 1：相对链接与图片全部可达', () => {
    expect(checkLinks(ROOT)).toEqual([])
  })

  it('规则 2：en 镜像文件齐全', () => {
    expect(checkMirrors(ROOT)).toEqual([])
  })

  it('规则 3：语言切换行 + i18n-slot 就位', () => {
    expect(checkSwitchers(ROOT)).toEqual([])
  })

  it('规则 4：en 镜像 H2 章节结构与中文同步', () => {
    expect(checkH2Sync(ROOT)).toEqual([])
  })

  it('规则 5：CHANGELOG 条目粗体点题', () => {
    expect(checkChangelogBold(ROOT)).toEqual([])
  })

  it('规则 6：版本链接表同步', () => {
    expect(checkVersionLinks(ROOT)).toEqual([])
  })

  it('规则 7：README 核心能力表 ≤8 行', () => {
    expect(checkCapabilityTable(ROOT)).toEqual([])
  })

  it('全部规则合计零违规', () => {
    expect(REAL_DOCS).toEqual([])
  })
})

// ---------------------------------------------------------------- 负例 fixture：每条规则必须能红

// 用临时目录构造坏文档，断言 lint 能抓到（不许只测 happy path）。
// win32 兼容：临时目录 os.tmpdir() + path.join；清理 rmSync 带重试（Windows 句柄延迟释放 EBUSY/EPERM）。

const fixtureDirs: string[] = []

function makeFixture(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'docs-lint-fixture-'))
  fixtureDirs.push(dir)
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel)
    mkdirSync(path.dirname(abs), { recursive: true })
    writeFileSync(abs, content)
  }
  return dir
}

afterEach(() => {
  while (fixtureDirs.length) {
    const dir = fixtureDirs.pop()!
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

describe('docs-lint 负例：坏文档必须被抓到', () => {
  it('规则 1：坏链接 / 坏图片路径 / 大小写不匹配 能红；围栏、注释、行内代码里的示例不误报', () => {
    const dir = makeFixture({
      'README.md': [
        '# T',
        '',
        '[好链](docs/ok.md) ![好图](docs/images/ok.png)',
        '[坏链](docs/missing.md)',
        '![坏图](docs/images/nope.png)',
        '[逃逸](../outside.md)',
        '[锚点](#ok-节) [外链](https://example.com/x) [邮](mailto:a@b.c)',
        '```bash',
        '# 围栏里的 [示例](docs/fenced.md) 不该被抓',
        '```',
        '<!-- 注释里的 [示例](docs/commented.md) 不该被抓：i18n-slot 示例链接不存在是合法的 -->',
        '行内代码 `[示例](docs/inline.md)` 不该被抓',
        '[中文锚](docs/ok.md#一-节) [带空格](docs/has%20space.md)',
        '',
      ].join('\n'),
      'docs/ok.md': '# ok\n',
      'docs/images/ok.png': 'png',
      'docs/has space.md': '# spaced\n',
      'docs/en/README.md': '# T\n\n**English** | [中文](../../README.md)\n',
    })
    const v = checkLinks(dir)
    const msgs = v.map((x) => `${x.file}:${x.line} ${x.message}`)
    expect(msgs.some((m) => m.includes('README.md:4') && m.includes('docs/missing.md'))).toBe(true)
    expect(msgs.some((m) => m.includes('README.md:5') && m.includes('nope.png'))).toBe(true)
    expect(msgs.some((m) => m.includes('逃出仓库根'))).toBe(true)
    expect(v).toHaveLength(3)
    // en 镜像大小写：Windows 上 existsSync 会放行 ../../readme.md，精确匹配必须抓到
    const dir2 = makeFixture({ 'README.md': '# T\n', 'docs/en/README.md': '# T\n\n**English** | [zh](../../Readme.md)\n' })
    const v2 = checkLinks(dir2)
    expect(v2.map((x) => x.message).join('\n')).toContain('大小写不匹配')
  })

  it('规则 2：zh 存在而 en 镜像缺失能红；zh 不存在不误报', () => {
    const dir = makeFixture({ 'README.md': '# T\n' })
    expect(checkMirrors(dir).map((x) => x.message).join('; ')).toContain('docs/en/README.md')
    const clean = makeFixture({ 'docs/usage.md': '# T\n' }) // zh usage 存在但 en 缺 → 红
    expect(checkMirrors(clean).map((x) => x.message).join('; ')).toContain('docs/en/usage.md')
    const untouched = makeFixture({}) // zh/en 都不存在 → 跳过
    expect(checkMirrors(untouched)).toEqual([])
  })

  it('规则 3：缺切换行 / 缺 i18n-slot 能红；齐备不误报', () => {
    const bad1 = makeFixture({ 'README.md': '# T\n\n正文没有切换行\n' })
    expect(checkSwitchers(bad1).map((x) => x.message).join('; ')).toContain('不是语言切换行')
    const bad2 = makeFixture({ 'README.md': '# T\n\n**中文** | [English](docs/en/README.md)\n\n正文\n' })
    expect(checkSwitchers(bad2).map((x) => x.message).join('; ')).toContain('i18n-slot')
    const ok = makeFixture({
      'README.md': '# T\n\n**中文** | [English](docs/en/README.md)\n<!-- i18n-slot：新增语言时在上一行末尾追加链接 -->\n',
      'docs/en/README.md': '# T\n\n**English** | [中文](../../README.md)\n<!-- i18n-slot: append new-language links above -->\n',
    })
    expect(checkSwitchers(ok)).toEqual([])
  })

  it('规则 4：H2 章节数不同步能红；层级同、文本异不误报', () => {
    const bad = makeFixture({
      'README.md': '# T\n\n## A\n\n## B\n',
      'docs/en/README.md': '# T\n\n## A\n',
    })
    expect(checkH2Sync(bad).map((x) => x.message).join('; ')).toContain('H2 章节数与中文不同步')
    const ok = makeFixture({
      'README.md': '# T\n\n## 改进\n\n内容\n',
      'docs/en/README.md': '# T\n\n## Changed\n\ncontent\n', // 文本不同、层级同 → 合法
    })
    expect(checkH2Sync(ok)).toEqual([])
  })

  it('规则 5：目标分节的平条目能红；粗体条目与非目标分节不误报', () => {
    const bad = makeFixture({
      'CHANGELOG.md': ['# Changelog', '', '## [1.0.0] - 2026-10-11', '', '### 新增', '', '- **功能点**：好的', '- 没粗体的条目', '', '### 国际化', '', '- 历史分节的平条目不查', ''].join('\n'),
    })
    const v = checkChangelogBold(bad)
    expect(v).toHaveLength(1)
    expect(v[0].message).toContain('没粗体的条目')
    expect(v[0].message).toContain('### 新增')
    const ok = makeFixture({
      'CHANGELOG.md': ['# Changelog', '', '## [未发布]', '', '### 修复', '', '  - 缩进子列表不查', '- **修好了**：好', '', '### 安全', '', '- 非目标分节平条目不查', ''].join('\n'),
    })
    expect(checkChangelogBold(ok)).toEqual([])
  })

  it('规则 6：版本缺链接定义能红；未发布段豁免', () => {
    const bad = makeFixture({ 'CHANGELOG.md': '# C\n\n## [1.2.3] - 2026-01-01\n\nx\n' })
    expect(checkVersionLinks(bad).map((x) => x.message).join('; ')).toContain('[1.2.3]')
    const ok = makeFixture({
      'CHANGELOG.md': ['# C', '', '## [未发布]', '', '## [1.2.3] - 2026-01-01', '', 'x', '', '[1.2.3]: https://example.com/compare/v1.2.2...v1.2.3', ''].join('\n'),
    })
    expect(checkVersionLinks(ok)).toEqual([])
  })

  it('规则 7：能力表 9 行能红；8 行与表头/分隔行不误报', () => {
    const row = (i: number) => `| 能力${i} | 说明${i} |`
    const bad = makeFixture({
      'README.md': ['# T', '', '## 核心能力', '', '| 领域 | 你能得到什么 |', '|------|--------------|', ...Array.from({ length: 9 }, (_, i) => row(i + 1)), ''].join('\n'),
    })
    expect(checkCapabilityTable(bad).map((x) => x.message).join('; ')).toContain('超过结构蓝图上限 8 行')
    const ok = makeFixture({
      'README.md': ['# T', '', '## 核心能力', '', '| 领域 | 你能得到什么 |', '|------|--------------|', ...Array.from({ length: 8 }, (_, i) => row(i + 1)), '', '## 下一节', ''].join('\n'),
    })
    expect(checkCapabilityTable(ok)).toEqual([])
  })
})
