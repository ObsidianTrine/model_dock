import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { UI_HTML } from '../src/gateway/ui.js'
import { renderMobilePage } from '../src/gateway/lan.js'

// Web 控制台静态契约（docs/web-testing-plan.md L0）：对内嵌页面的求值产物做可执行规则，
// 把 AGENTS.md 的 UI 纪律（双语对、弹层提示归宿、惰性 label、端点不漂移）变成 CI 红灯。
// 本文件不 vi.mock 任何模块（singleFork 共享注册表，见测试指南）；脚本语法编译检查在
// dedup-smoke.test.ts（L0 第 4 条），此处不重复。

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const LAN_HTML = renderMobilePage()
// 源码读取统一归一化换行（\r\n → \n）：Windows CI checkout 出 CRLF，多行 toContain 断言按 LF 写
const SERVER_SRC = readFileSync(path.join(ROOT, 'src', 'gateway', 'server.ts'), 'utf8').replace(/\r\n/g, '\n')
const LAN_SRC = readFileSync(path.join(ROOT, 'src', 'gateway', 'lan.ts'), 'utf8').replace(/\r\n/g, '\n')
// ui.ts 源码单读一份（L0-2 的 foot 块解析作用在源码模板上，而非求值产物）
const SRC_UI = readFileSync(path.join(ROOT, 'src', 'gateway', 'ui.ts'), 'utf8').replace(/\r\n/g, '\n')

/** 内嵌页面的全部 <script> 块（求值后的最终 HTML，含 ${CONSOLE_SHARED_JS} 注入段） */
function scriptBlocks(html: string): string[] {
  const blocks: string[] = []
  const re = /<script>([\s\S]*?)<\/script>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(html))) blocks.push(m[1])
  return blocks
}

// L0-1 i18n 完整性：静态节每个 data-i18n* 属性值必须是「中文||English」对（两侧非空）
describe('L0-1 静态 i18n 双语对完整', () => {
  const ATTR_RE = /data-i18n(?:-ph|-title|-tip|-aria)?="([^"]*)"/g

  function badPairs(page: string, html: string): string[] {
    const bad: string[] = []
    let m: RegExpExecArray | null
    while ((m = ATTR_RE.exec(html))) {
      const pair = m[1]
      const segs = pair.split('||')
      if (segs.length !== 2 || !segs[0].trim() || !segs[1].trim()) bad.push(`${page}: "${pair.slice(0, 60)}"`)
    }
    return bad
  }

  it.each([
    ['ui.ts', UI_HTML],
    ['lan.ts', LAN_HTML],
  ])('%s 所有 data-i18n* 属性都是「中文||English」对且两侧非空', (_page, html) => {
    expect(badPairs(_page, html)).toEqual([])
  })

  it('静态节不存在单引号写法的 data-i18n 属性（防止正则漏扫）', () => {
    expect(UI_HTML).not.toMatch(/data-i18n[a-z-]*='/)
    expect(LAN_HTML).not.toMatch(/data-i18n[a-z-]*='/)
  })
})

// L0-2 弹层提示归宿：带动作按钮的弹层 foot 必须配 {slot:'msg'} 槽位（磨砂遮罩会糊掉全局
// toast，弹层内动作的错误/进度反馈必须写弹层底栏）；全局 toast 容器每页至多一个
describe('L0-2 弹层 foot 的 msg 槽位与全局 toast 容器唯一', () => {
  /** 提取 ui.ts 源码里全部 `foot: [ ... ]` 块（括号配平切片） */
  function footBlocks(src: string): string[] {
    const blocks: string[] = []
    const re = /foot:\s*\[/g
    let m: RegExpExecArray | null
    while ((m = re.exec(src))) {
      let depth = 1
      let i = m.index + m[0].length
      for (; i < src.length && depth > 0; i++) {
        const c = src[i]
        if (c === '[') depth++
        else if (c === ']') depth--
      }
      blocks.push(src.slice(m.index, i))
    }
    return blocks
  }

  it('ui.ts 每个「带动作按钮」的弹层 foot 都有 {slot:\'msg\'} 槽位', () => {
    const offenders: string[] = []
    for (const block of footBlocks(SRC_UI)) {
      const hasButton = /\{\s*id:\s*'/.test(block) && !/^\s*foot:\s*\[\s*\]/.test(block)
      if (!hasButton) continue // foot: []（无弹层内动作，动作区在别处）不适用本规则
      // 白名单：通用确认弹层（mCancel/mOk）——先关弹层再执行回调，反馈按分流规则落主页面 toast
      if (block.includes("id: 'mCancel'") && block.includes("id: 'mOk'")) continue
      if (!/slot:\s*'msg'/.test(block)) offenders.push(block.split('\n')[0])
    }
    expect(offenders).toEqual([])
  })

  it('桌面页全局 toast 容器（#toastWrap）恰好一个', () => {
    expect((UI_HTML.match(/id="toastWrap"/g) ?? []).length).toBe(1)
  })
})

// L0-3 惰性 label 纪律：长生命周期组件的 label/title 传参禁止 t(...) 直接求值
// （会把语言固化在页面加载时刻，切语言不跟随——2026-10 状态行 pill 事故）
describe('L0-3 组件 label/title 传参不做语言固化', () => {
  it.each([
    ['ui.ts', scriptBlocks(UI_HTML).join('\n')],
    ['lan.ts', scriptBlocks(LAN_HTML).join('\n')],
  ])('%s 脚本内无 `label: t(` / `title: t(` 直接求值（应传惰性函数）', (_page, js) => {
    expect(js).not.toMatch(/label:\s*t\(/)
    expect(js).not.toMatch(/title:\s*t\(/)
  })
})

// L0-5 端点漂移审计：前端调用的每个管理端点必须存在于对应服务端路由源码；
// 反向（有路由无前端引用）只 console.log 清单供人工确认，不阻断
describe('L0-5 前端端点 ↔ 服务端路由不漂移', () => {
  /** 服务端 admin 路由路径全集：admin 门之前的三条 tier-1 豁免端点仍是 if 链形态
   *  （url === '/_modeldock/…'），门后端点收敛为路由表键（'GET /_modeldock/…'）——
   *  两种形态都提取，按路径合并去重 */
  function serverAdminRoutes(): Set<string> {
    const routes = new Set<string>()
    for (const m of SERVER_SRC.matchAll(/url === '(\/_modeldock[^']*)'/g)) routes.add(m[1])
    for (const m of SERVER_SRC.matchAll(/'(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) (\/_modeldock[^']*)'/g)) routes.add(m[1])
    return routes
  }

  /** 页面脚本里实际调用的端点全集（api() 相对路径补 /_modeldock 前缀；查询串剥掉） */
  function frontendPaths(html: string): string[] {
    const out = new Set<string>()
    for (const m of html.matchAll(/api\('([^']*)'/g)) out.add('/_modeldock' + m[1].split('?')[0])
    for (const m of html.matchAll(/fetch\('([^']*)'/g)) {
      const raw = m[1]
      if (raw === '/_modeldock') continue // api() 助手自身的 base 前缀拼接，非端点调用
      if (!raw.startsWith('/_modeldock') && !raw.startsWith('/m/api')) continue
      out.add(raw.split('?')[0])
    }
    return [...out]
  }

  it('桌面/手机页调用的每个端点都能在服务端路由源码中找到', () => {
    const adminRoutes = serverAdminRoutes()
    const missing: string[] = []
    for (const p of frontendPaths(UI_HTML)) {
      if (!adminRoutes.has(p)) missing.push(p)
    }
    for (const p of frontendPaths(LAN_HTML)) {
      // 手机页模板与 /m/api 路由同在 lan.ts：按「url === '路径'」的路由形态断言，排除模板自身字面量的自证
      if (!LAN_SRC.includes(`url === '${p}'`)) missing.push(p)
    }
    expect(missing).toEqual([])
  })

  it('反向审计：无前端引用的路由只列清单不阻断', () => {
    const fe = new Set([...frontendPaths(UI_HTML), ...frontendPaths(LAN_HTML)])
    const routes = serverAdminRoutes()
    for (const m of LAN_SRC.matchAll(/url === '(\/m\/api[^']*)'/g)) routes.add(m[1])
    const unreferenced = [...routes].filter((r) => !fe.has(r))
    // 预期少量无前端引用（CLI/运维专用端点，如 reload/reset/holidays-cn/use/profile/key）：
    // 打印供人工确认，出现新增条目时在这里补充已知豁免说明
    if (unreferenced.length) console.log('[webui-static] 无前端引用的路由（人工确认）:', unreferenced.join(', '))
    expect(true).toBe(true)
  })
})

// 更新核验的版本比较必须逐段数值（字典序 '1.9.0' >= '1.10.0' 为真：跨位版本对会提前 reload
// 丢下载进度、重载后弹「已更新」假完成——恰是核验要防的）。三处核验共用 cmpSemver。
describe('L0-6 更新流程版本核验', () => {
  it('ui.ts 定义 cmpSemver 且无 s.current 字符串 >= 残留', () => {
    expect(SRC_UI).toContain('function cmpSemver(')
    expect(SRC_UI).not.toMatch(/s\.current\s*>=/)
  })
})

// 弹层壳键盘路径（ui-kit §9 焦点管理内置 + Esc 不穿透）：createModal open 移焦/close 还原、
// 全局 keydown 只处理最上层、closeOnEsc:false 的壳盖着时 Esc 就地吞掉（不穿透关被遮弹层）；
// 手机页 toast 语义播报（桌面已有 role=status）
describe('L0-7 弹层键盘路径与 toast 语义', () => {
  it('createModal 含焦点管理与 Tab 圈闭，Esc 分派只看最上层', () => {
    expect(SRC_UI).toContain('function firstFocusable(')
    expect(SRC_UI).toContain('_lastFocus')
    expect(SRC_UI).toContain("if (ev.key === 'Escape') {\n      if (top._closeOnEsc !== false) top.close()\n      return\n    }")
  })
  it('手机页 toast 带 role=status aria-live，确认弹层是 dialog', () => {
    expect(LAN_HTML).toContain('id="toast" role="status" aria-live="polite"')
    expect(LAN_HTML).toContain('id="confirm" hidden role="dialog"')
  })
})
