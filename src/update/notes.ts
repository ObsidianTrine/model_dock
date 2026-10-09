/**
 * 更新说明的展示降级（纯函数，无依赖）。
 *
 * 发布说明的来源是 GitHub Release 正文 = CHANGELOG 段落原文（markdown），而消费它的界面
 * 全是纯文本：菜单栏 / 托盘的原生弹窗（NSAlert / WinForms）没有渲染器，Web 控制台是手写 DOM
 * 不引 markdown 库。因此三面共用这里的一份实现：先「去标记」，再「摘要收口」——
 * 弹窗只留首段 + 几条点题，逐条细节交给发布页链接（业界同类工具即此形态）。
 */

/** 弹窗里最多列几条点题（其余用「另有 N 项」带过，细节看发布页） */
const MAX_ITEMS = 4
/** 没有加粗点题时，整句截断到这里长度 */
const MAX_ITEM_CHARS = 48
/** 首段摘要上限 */
const MAX_SUMMARY_CHARS = 110

const HEADING_RE = /^ {0,3}#{1,6}\s+(.*)$/
const BULLET_RE = /^ {0,3}[-*+]\s+(.*)$/
const ORDERED_RE = /^ {0,3}\d+[.)]\s+(.*)$/
const RULE_RE = /^ {0,3}(?:[-*_]\s*){3,}$/
const FENCE_RE = /^ {0,3}(?:```|~~~)/
/** 加粗点题：`- **文件名带时间**：细节…` → 取「文件名带时间」 */
const LEAD_RE = /^\*\*(.+?)\*\*\s*[:：]/

interface NoteBlock {
  kind: 'heading' | 'bullet' | 'para'
  text: string
  /** bullet 专用：原文里的加粗点题（没有则为空） */
  lead?: string
}

/** 行内标记 → 纯文本（粗体/斜体/行内代码/链接/图片/常见 HTML 标签） */
function inlineToPlain(s: string): string {
  return s
    .replace(/!\[([^\]]*)\]\([^)\s]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, txt: string, url: string) => (txt === url ? txt : `${txt} (${url})`))
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1$2')
    .replace(/(^|[\s(])_([^_\n]+)_/g, '$1$2')
    .replace(/<\/?(?:br|p|div|ul|ol|li|h[1-6]|blockquote|strong|em|b|i|code|span|a|img|hr)\b[^>]*>/gi, '')
    .replace(/\\([\\`*_{}[\]()#+\-.!])/g, '$1')
    .replace(/\s+$/, '')
}

/** 按行切块：标题 / 条目 / 段落（段落内换行合并成一行；代码围栏内原样保留） */
function parseNotes(md: string): NoteBlock[] {
  const blocks: NoteBlock[] = []
  let para: string[] = []
  let inFence = false
  const flushPara = (): void => {
    if (para.length) blocks.push({ kind: 'para', text: para.join(' ') })
    para = []
  }
  for (const raw of md.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim()
    if (FENCE_RE.test(line)) {
      inFence = !inFence
      flushPara()
      continue
    }
    if (inFence) {
      flushPara()
      if (line) blocks.push({ kind: 'para', text: line })
      continue
    }
    if (!line || RULE_RE.test(line)) {
      flushPara()
      continue
    }
    const h = line.match(HEADING_RE)
    if (h) {
      flushPara()
      blocks.push({ kind: 'heading', text: inlineToPlain(h[1].trim()) })
      continue
    }
    const b = line.match(BULLET_RE) ?? line.match(ORDERED_RE)
    if (b) {
      flushPara()
      const lead = b[1].trim().match(LEAD_RE)
      blocks.push({ kind: 'bullet', text: inlineToPlain(b[1].trim()), lead: lead ? inlineToPlain(lead[1].trim()) : undefined })
      continue
    }
    para.push(inlineToPlain(line))
  }
  flushPara()
  return blocks
}

/** markdown → 纯文本：只去标记，保留标题 / 段落 / `· ` 条目的行结构（控制台详情框用） */
export function notesToPlain(md: string): string {
  const lines: string[] = []
  let prev: NoteBlock['kind'] | null = null
  for (const b of parseNotes(md)) {
    // 标题前、段落后空一行：纯文本里靠空行分层，条目之间不空行（保持列表成块）
    if (lines.length && (b.kind === 'heading' || (b.kind === 'bullet' && prev === 'para') || (b.kind === 'para' && prev !== 'bullet'))) lines.push('')
    lines.push(b.kind === 'bullet' ? `· ${b.text}` : b.text)
    prev = b.kind
  }
  return lines.join('\n').trim()
}

/** 摘掉行内链接：摘要里不放网址——发布页链接由调用方单独给（见 run.ts 的「完整说明：」行），
 *  否则托盘按「输出里最后一个网址」取链接时会取到说明正文里随便一条。
 *  网址终止符同控制台的 linkifyText（见 gateway/ui.ts）：中文句子没有空格，
 *  只用 `\S+` 会把网址后面的整段正文一并吃掉 */
const URL_BODY = /[^\s，。；：！？、（）()【】《》"']+/

function stripLinks(s: string): string {
  return s
    // 行内链接降级后的「文字 (url) / 文字（url）」→「文字」（连括号一起去掉，不留悬挂括号）
    .replace(new RegExp(`\\s*[（(]\\s*https?://${URL_BODY.source}\\s*[）)]`, 'g'), '')
    .replace(new RegExp(`https?://${URL_BODY.source}`, 'g'), '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+([，。；：！？、）)】》（])/g, '$1') // 摘掉网址后别在标点/全角括号前留空格
    .trim()
}

/** 截断到 max 个码点：优先切在上一个中文标点处收尾，加省略号；代理对（emoji）不被劈成半个 */
function clamp(text: string, max: number): string {
  const cps = Array.from(text)
  if (cps.length <= max) return text
  const head = cps.slice(0, max).join('')
  let cut = -1
  for (const ch of '，、；：）)') cut = Math.max(cut, head.lastIndexOf(ch))
  const body = cut >= Math.floor(max * 0.6) ? head.slice(0, cut) : head
  return `${body.replace(/[，、；：\s]+$/, '')}…`
}

export interface NotesSummary {
  /** 首段摘要（正文以条目开头时为空串） */
  summary: string
  /** 至多 maxItems 条点题，按原文顺序 */
  items: string[]
  /** 原文条目总数：大于 items.length 时调用方可提示「另有 N 项」 */
  total: number
}

/** 摘要收口：首段 + 最多 maxItems 条点题（原生弹窗、终端检查输出用） */
export function notesSummary(
  md: string,
  opts: { maxItems?: number; maxItemChars?: number; maxSummaryChars?: number } = {}
): NotesSummary {
  const maxItems = opts.maxItems ?? MAX_ITEMS
  const maxItemChars = opts.maxItemChars ?? MAX_ITEM_CHARS
  const maxSummaryChars = opts.maxSummaryChars ?? MAX_SUMMARY_CHARS
  const blocks = parseNotes(md)

  // 首段摘要只认第一条条目之前的那一段（正文若以列表开头，就没有摘要段）
  let summaryText = ''
  for (const b of blocks) {
    if (b.kind === 'bullet') break
    if (b.kind === 'para') {
      summaryText = b.text
      break
    }
  }
  const bullets = blocks.filter((b) => b.kind === 'bullet')
  return {
    summary: clamp(stripLinks(summaryText), maxSummaryChars),
    // 摘掉网址后条目可能空掉（如整条就是一个链接）：丢弃空条目，并用后面的条目补位，
    // 否则弹窗里会多一行孤零零的「· 」；total 仍是原文条目数（调用方据此提示「共 N 项」）
    items: bullets
      .map((b) => clamp(stripLinks(b.lead ?? b.text), maxItemChars))
      .filter((t) => t.length > 0)
      .slice(0, maxItems),
    total: bullets.length,
  }
}
