// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeAll, afterAll } from 'vitest'
import { UI_HTML } from '../src/gateway/ui.js'
import { UI_JS_PROBE } from '../src/gateway/ui/probe.js'

// Web 控制台 DOM 行为测试（docs/archive/web-testing-plan.md L2）：把桌面页内嵌脚本挂进 happy-dom
// （纯 JS，无 native，不违反 SEA 依赖约束），stub fetch 返回 /overview 契约夹具，断言渲染与
// 语言切换行为。伪定时器冻结 5s/60s 轮询（singleFork 共享进程：afterAll 必须还原全部桩）。
//
// 夹具形状 = buildOverview 的对外契约（gateway/services/clients/sync；presets/knownModels 已拆
// /_modeldock/presets 与 model-catalog 独立端点，perf-p2-polish）；
// 该契约同时被 L0 的端点审计钉住，前端渲染回归（键改名静默白屏类）在此红灯。

function scriptBlocks(html: string): string[] {
  const blocks: string[] = []
  const re = /<script>([\s\S]*?)<\/script>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(html))) blocks.push(m[1])
  return blocks
}

const BODY_HTML = UI_HTML.slice(UI_HTML.indexOf('<body>') + 6, UI_HTML.lastIndexOf('</body>')).replace(
  /<script>[\s\S]*?<\/script>/g,
  ''
)
const PAGE_SCRIPT = scriptBlocks(UI_HTML).join('\n')

// services 条目运行时 = buildOverview 投影，键随功能演进（probe-model-select 等新增投影键）：
// 放宽为索引签名让用例按需补字段，不必逐次扩夹具字面量类型（tsconfig.test 前置门禁）
const OVERVIEW_FIXTURE: Record<string, any> = {
  ok: true,
  gateway: {
    port: 18999,
    running: true,
    sandbox: false,
    home: '/tmp/mdk-dom-fixture',
    autoRoute: { on: false, failoverOn429: false, autoFallback: true },
    autostart: { installed: false },
  },
  current: null,
  defaultRoute: null,
  services: [
    { id: 'alpha', label: 'Alpha 服务', base_url: 'https://a.example.com', protocol: 'anthropic', hasKey: true, modelsCount: 2, defaultModel: 'a-model', fallback: [], inUse: true, isCurrent: true, enabled: true, priority: 0, down: false, usedBy: [], models: [] },
    { id: 'beta', label: 'Beta 服务', base_url: 'https://b.example.com', protocol: 'openai', hasKey: true, modelsCount: 1, defaultModel: null, fallback: [], inUse: false, isCurrent: false, enabled: true, priority: 0, down: false, usedBy: [], models: [] },
  ],
  clients: [],
  sync: null,
  syncRequest: null,
}

// /usage-live 实时字段夹具（usageToday/lastMs 已从 overview 主载荷拆出，UI 从本端点定向更新；
// 字段名对齐 UsageTodayView 真实契约：failed/cache_creation/by_provider，防新用例建立在漂移字段上）
const USAGE_LIVE_FIXTURE = {
  ok: true,
  usageToday: {
    date: '2026-11-06', requests: 3, ok: 3, failed: 0,
    tokens: { input: 1200, output: 340, cache_read: 0, cache_creation: 0 },
    cost: { total: 0.0042 },
    unpriced_models: [],
    by_provider: {
      alpha: { requests: 3, tokens: { input: 1200, output: 340, cache_read: 0, cache_creation: 0 }, cost: 0.0042 },
    },
  },
  ms: { alpha: 120 },
}

/** /_modeldock/usage 聚合夹具（用量弹层用例按需改写；形状 = UsageSummary 对外契约子集） */
const USAGE_AGG_FIXTURE: { ok: boolean; usage: Record<string, unknown> } = {
  ok: true,
  usage: {
    requests: 3, ok: 3, failed: 0,
    by_provider: { alpha: 3 },
    by_model: { 'a-model': 3 },
    tokens_by_provider: { alpha: { input_tokens: 1200, output_tokens: 340, cache_read_tokens: 0, cache_creation_tokens: 0 } },
    tokens_by_model: { 'a-model': { input_tokens: 1200, output_tokens: 340, cache_read_tokens: 0, cache_creation_tokens: 0 } },
    cost: { total: 0.0042, by_provider: { alpha: 0.0042 }, by_model: { 'a-model': 0.0042 } },
    unpriced_models: null,
  },
}

/** /logs 端点夹具（模块级可变：日志面板用例按需改写，finally 还原） */
const LOGS_FIXTURE: { logs: any[]; total: number; page: number; pages: number } = { logs: [], total: 0, page: 1, pages: 1 }

/** /_modeldock/probe/verdicts 夹具（健康下钻用例按需改写；默认空 = 全部服务无结论、不出徽标） */
const PROBE_VERDICTS_FIXTURE: { verdicts: any[] } = { verdicts: [] }

/** /_modeldock/probe/timeline 夹具（单服务响应形态：timeline=该 provider 条目（服务端已裁剪），
 *  total=窗口内翻转总数；截断态 total>timeline.length 出「展开全部」钮。用例按需改写，finally 还原） */
const PROBE_TIMELINE_FIXTURE: { timeline: any[]; total: number } = { timeline: [], total: 0 }

/** /_modeldock/probe/ledger 夹具（探针自耗 pill/明细弹层用例按需改写；默认无 budget/breakdown
 *  = 账本未就绪，lite 缓存不落、pill 不出——存量用例零感知） */
const PROBE_LEDGER_FIXTURE: {
  ok: boolean
  budget?: Record<string, unknown> | null
  breakdown?: Record<string, unknown> | null
  probe_labels?: Record<string, string>
} = { ok: true }

/** stub fetch：已知端点回夹具，未知端点回 {ok:true} 并打日志（spike 期便于发现漏配） */
function stubFetch(): void {
  const routes: Record<string, () => { body: unknown; raw?: string }> = {
    '/_modeldock/overview': () => ({ body: OVERVIEW_FIXTURE }),
    '/_modeldock/health': () => ({ body: { ok: true } }),
    '/_modeldock/admin/update/status': () => ({ body: { current: '1.0.0', available: false } }),
    '/_modeldock/model-catalog': () => ({ body: { ok: true, models: {} } }),
    '/_modeldock/presets': () => ({ body: { ok: true, presets: [] } }),
    '/_modeldock/usage-live': () => ({ body: USAGE_LIVE_FIXTURE }),
    '/_modeldock/usage': () => ({ body: USAGE_AGG_FIXTURE }),
    '/_modeldock/logs': () => ({ body: LOGS_FIXTURE }),
    '/_modeldock/lan': () => ({ body: { ok: true, enabled: false } }),
    '/_modeldock/ui-presence': () => ({ body: { ok: true } }),
    '/_modeldock/probe/verdicts': () => ({ body: PROBE_VERDICTS_FIXTURE }),
    '/_modeldock/probe/timeline': () => ({ body: PROBE_TIMELINE_FIXTURE }),
    '/_modeldock/probe/ledger': () => ({ body: PROBE_LEDGER_FIXTURE }),
  }
  vi.stubGlobal('fetch', (url: string) => {
    const p = String(url).split('?')[0]
    const hit = routes[p]?.()
    if (!hit) {
      console.warn('[webui-dom] 未配夹具的端点（回退 {ok:true}）:', p)
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }), text: () => Promise.resolve('{"ok":true}') })
    }
    const raw = JSON.stringify(hit.body)
    return Promise.resolve({ ok: true, json: () => Promise.resolve(JSON.parse(raw)), text: () => Promise.resolve(raw) })
  })
}

/** 微任务冲刷：让 load() → fetch → .then → render() 链在断言前跑完（无真定时器依赖） */
async function flush(times = 25): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve()
}

/** 挂载页面并执行内嵌脚本（happy-dom 的 innerHTML 不执行 <script>，手动求值） */
function mountPage(): void {
  document.body.innerHTML = BODY_HTML
  new Function(PAGE_SCRIPT)()
}

beforeAll(() => {
  vi.useFakeTimers() // 冻结 5s/60s 轮询与复制翻转等 setTimeout，避免真实定时器在共享进程里滞留
  stubFetch()
})

afterAll(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('桌面控制台 DOM（happy-dom 挂载）', () => {
  it('spike：4700 行内嵌脚本可在 happy-dom 求值，首屏 load() 正常完成', async () => {
    try {
      mountPage()
    } catch (e) {
      console.error('[webui-dom] mountPage threw:', (e as Error).stack)
      throw e
    }
    await flush()
    const toast = document.getElementById('toastWrap')
    if (toast && toast.textContent) console.error('[webui-dom] toast 内容（load 失败信息）:', toast.textContent)
    // 首屏健康横幅被 load() 填充（静态骨架被替换即证明 load→render 链走通）；
    // 横幅已瘦身为绿点+端口号，「本地网关运行中」说明文字挪进原生 title；
    // 端口号取 location.port，happy-dom 下为空，故断言 title 文案而非端口号
    const health = document.getElementById('health')
    expect(health?.querySelector('.dot')?.parentElement?.getAttribute('title') ?? '').toContain('本地网关运行中')
  })

  it('overview 渲染契约：2 个服务渲染 2 张卡，使用中服务带「正在使用」pill', async () => {
    mountPage()
    await flush()
    const cards = document.querySelectorAll('#services .service')
    expect(cards.length).toBe(2)
    expect(cards[0].querySelector('.name')?.textContent).toContain('Alpha 服务')
    expect(cards[0].textContent).toContain('正在使用')
    expect(cards[1].textContent).not.toContain('正在使用')
  })

  it('usage-live 定向更新：用量徽标（今日 tokens+花费）与服务卡延迟 span 来自 /usage-live（主载荷不再携带易变字段）', async () => {
    mountPage()
    await flush(60) // pollLive 挂在 load() 链尾（多一跳 fetch），比常规断言多冲几轮微任务
    // 顶部徽标新形态：tokens 合计（input 含缓存 + output）· 花费；请求数挪进悬浮提示
    expect(document.getElementById('health')?.textContent ?? '').toContain('今日 1.5k · $0.0042')
    const topPill = document.getElementById('usageTodayPill')
    expect(topPill?.getAttribute('title') ?? '').toContain('今日 3 请求')
    const ms = document.querySelector('[data-svcms="alpha"]')
    expect(ms?.textContent).toContain('延迟 120ms')
    // 服务卡用量徽标：有流量的 alpha 填充、无流量的 beta 空槽
    const alphaPill = document.querySelector('[data-svcusage="alpha"] button')
    expect(alphaPill?.textContent ?? '').toContain('1.5k · $0.0042')
    expect(document.querySelector('[data-svcusage="beta"]')?.textContent ?? '').toBe('')
  })

  it('用量弹层：顶部徽标点击开全部服务视图，服务行可下钻按模型、可返回', async () => {
    mountPage()
    await flush(60)
    ;(document.getElementById('usageTodayPill') as HTMLElement)!.click()
    const scrim = document.getElementById('usageOverlay') as HTMLElement | null
    expect(scrim && scrim.hidden === false).toBe(true)
    await flush()
    expect(document.getElementById('usageTitle')?.textContent).toContain('用量')
    // 关闭按钮 ✕ 图标在工厂创建时就地注入（fix-modal-close-icon）：后置片段创建的弹层吃不到
    // WIRING 的一次性扫描，此前关闭按钮是空壳不可见——此处钉住「工厂创建即带图标」
    const usageClose = document.querySelector('#usageOverlay .close-btn') as HTMLElement | null
    expect(usageClose?.querySelector('svg')).not.toBeNull()
    const rows = document.querySelectorAll('#usageTable tbody tr')
    expect(rows.length).toBe(1)
    expect(rows[0].textContent).toContain('Alpha 服务')
    // 下钻：点服务行 → 标题切到该服务、模型行出现、返回按钮可见
    ;(document.querySelector('#usageTable tr.click') as HTMLElement)!.click()
    await flush()
    expect(document.getElementById('usageTitle')?.textContent).toContain('Alpha 服务')
    expect(document.querySelector('#usageTable tbody tr')?.textContent).toContain('a-model')
    expect((document.getElementById('usageBack') as HTMLElement)!.hidden).toBe(false)
    // 返回全部服务
    ;(document.getElementById('usageBack') as HTMLElement)!.click()
    await flush()
    expect(document.querySelector('#usageTable tbody tr')?.textContent).toContain('Alpha 服务')
    // Esc 关闭（读取类弹层关路径三件套之一，遮罩点击同款走 createModal 内建）
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(scrim!.hidden).toBe(true)
  })

  it('语言切换重渲染：点 EN 后静态 data-i18n 节点与服务卡文案随语言变化', async () => {
    mountPage()
    await flush()
    const h2 = document.querySelector('#shareReqCard h2[data-i18n]') as HTMLElement | null
    expect(h2).toBeTruthy()
    const zhText = h2!.textContent ?? ''
    expect(zhText).toContain('附近的电脑请求拉取')

    const enBtn = document.querySelector('#langSwitch button[data-lang="en"]') as HTMLElement | null
    expect(enBtn).toBeTruthy()
    enBtn!.click()
    await flush()

    // 静态节点经 applyI18nTree 换英文（惰性 label 纪律的实测面：切语言必须即时跟随）
    expect(h2!.textContent).not.toBe(zhText)
    expect(h2!.textContent).toContain('A nearby computer requests your config')
    // 动态重渲染区（服务卡）也换语言
    expect(document.querySelector('#services .service')?.textContent ?? '').toContain('In use')

    // 切回中文可逆
    ;(document.querySelector('#langSwitch button[data-lang="zh"]') as HTMLElement)!.click()
    await flush()
    expect(h2!.textContent).toBe(zhText)
  })

  it('弹层校验失败写 foot 槽位而非全局 toast：编辑弹层清空地址后保存', async () => {
    mountPage()
    await flush()
    // 打开「编辑 Alpha」弹层（服务卡上的 data-edit 按钮）
    ;(document.querySelector('[data-edit="alpha"]') as HTMLElement)!.click()
    const scrim = document.getElementById('editOverlay') as HTMLElement | null
    expect(scrim && scrim.hidden === false).toBe(true)
    // 清空全部协议地址 → 点保存 → 服务端前校验失败（地址缺失）
    ;(document.getElementById('efEndAnthropic') as HTMLInputElement)!.value = ''
    ;(document.getElementById('efEndOpenai') as HTMLInputElement)!.value = ''
    ;(document.getElementById('efEndResponses') as HTMLInputElement)!.value = ''
    ;(document.getElementById('efSave') as HTMLElement)!.click()
    await flush()
    // 错误落在弹层底栏 msg 槽位（.testline.err），全局 toast 容器保持为空（弹层提示归宿纪律）
    const msg = document.getElementById('efMsg')
    expect(msg?.className).toContain('err')
    expect(msg?.textContent ?? '').toContain('请至少填写一个协议接口地址')
    expect(document.querySelectorAll('#toastWrap .toast').length).toBe(0)
  })

  it('编辑弹层探针模型字段（probe-model-select）：回显显式值；未改动不随保存提交，改动后带 probe_model', async () => {
    const updateCalls: Array<Record<string, unknown>> = []
    const prev = globalThis.fetch
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
      const p = String(url).split('?')[0]
      if (p === '/_modeldock/service/update' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>
        updateCalls.push(body)
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }), text: () => Promise.resolve('{"ok":true}') })
      }
      return (prev as (u: string, i?: RequestInit) => unknown)(String(url), init)
    })
    const prevModels = OVERVIEW_FIXTURE.services[0].models
    try {
      OVERVIEW_FIXTURE.services[0].models = [
        { id: 'm1', display_name: '贵模型' },
        { id: 'm2', display_name: 'M2' },
      ]
      OVERVIEW_FIXTURE.services[0].probeModel = 'm1'
      OVERVIEW_FIXTURE.services[0].probeModelExplicit = true
      mountPage()
      await flush()
      ;(document.querySelector('[data-edit="alpha"]') as HTMLElement)!.click()
      const sel = document.getElementById('efProbeModel') as HTMLSelectElement
      expect(sel).not.toBeNull()
      expect(sel.value).toBe('m1')
      expect(sel.textContent).toContain('跟随默认模型')
      // 未改动直接保存：body 不带 probe_model（无关保存不得把解析值固化成显式配置）
      ;(document.getElementById('efSave') as HTMLElement)!.click()
      await flush()
      expect(updateCalls.length).toBeGreaterThanOrEqual(1)
      for (const c of updateCalls) expect('probe_model' in c).toBe(false)
      // 改成「跟随默认模型」再保存：带 probe_model=''（服务端删除字段）
      ;(document.querySelector('[data-edit="alpha"]') as HTMLElement)!.click()
      const sel2 = document.getElementById('efProbeModel') as HTMLSelectElement
      sel2.value = ''
      ;(document.getElementById('efSave') as HTMLElement)!.click()
      await flush()
      const last = updateCalls[updateCalls.length - 1]
      expect('probe_model' in last).toBe(true)
      expect(last.probe_model).toBe('')
    } finally {
      OVERVIEW_FIXTURE.services[0].models = prevModels
      delete OVERVIEW_FIXTURE.services[0].probeModel
      delete OVERVIEW_FIXTURE.services[0].probeModelExplicit
      vi.stubGlobal('fetch', prev)
    }
  })

  it('请求日志面板：8 列含操作列、错误行链路两行化（跳过原因可见）、全行复制按钮、筛选 tab 切换记忆', async () => {
    // 2026-11-08 真实事故形态：bigmodel（openai-only）被 candidateSkip 跳过 → 改发 coding-plan 404
    LOGS_FIXTURE.logs = [
      {
        ts: '2026-11-08T09:33:38.291+08:00', harness: 'claude-code', profile: 'auto-bigmodel', provider: 'coding-plan',
        model: 'glm-4.5-air', path: '/v1/messages?beta=true', status: 404, ms: 104,
        err: '{"error":{"code":"UnsupportedModel","message":"The requested model does not support the coding plan feature."}}',
        reason: 'failover_to:coding-plan,replayed_from:bigmodel', cause: 'upstream_4xx', level: 'error',
        hint: '给 bigmodel 补 anthropic 端点',
        attempts: [{ provider: 'bigmodel', note: 'proto_endpoint_missing' }, { provider: 'coding-plan', status: 404, ms: 104 }],
      },
      { ts: '2026-11-08T09:49:18.000+08:00', kind: 'audit', op: '编辑服务', op_en: 'Edit service', target: 'bigmodel', detail: '已更新', ok: true, source: 'web' },
    ]
    LOGS_FIXTURE.total = 2
    LOGS_FIXTURE.pages = 1
    localStorage.setItem('mdk_lang', 'zh')
    localStorage.setItem('mdk_log_tab', 'all') // 夹具里两类条目都有：切到「全部」保证都进 DOM
    try {
      mountPage()
      await flush()
      const table = document.getElementById('logTable') as HTMLElement
      // 8 列表头：新增「操作」列
      expect(table.querySelectorAll('thead th').length).toBe(8)
      expect(table.textContent).toContain('操作')
      // 审计目标列是行数截断盒（td>div），全文必须在 title 悬浮可见（截断口径：title+⧉ 双通道）
      const targetTd = [...table.querySelectorAll('tbody td')].find((td) => (td.querySelector('div')?.textContent ?? '') === 'bigmodel')
      expect(targetTd?.getAttribute('title')).toBe('bigmodel')
      // 错误行两行化：链路摘要直出「bigmodel 跳过(协议端点缺失) → coding-plan 404」，建议为第二行
      expect(table.textContent).toContain('bigmodel 跳过(协议端点缺失) → coding-plan 404')
      expect(table.textContent).toContain('给 bigmodel 补 anthropic 端点')
      // 全行复制：请求行 + 操作行都有 ⧉
      expect(table.querySelectorAll('.lcopy').length).toBe(2)
      // 复制本页按钮在（pager 右下角）
      expect(document.getElementById('logCopyPage')).toBeTruthy()
      // 筛选 tab 切换：选中态迁移 + localStorage 记忆
      ;(document.querySelector('#logTabs button[data-lt="ok"]') as HTMLElement)!.click()
      await flush()
      expect(localStorage.getItem('mdk_log_tab')).toBe('ok')
      expect((document.querySelector('#logTabs button[data-lt="ok"]') as HTMLElement).className).toBe('on')
      expect((document.querySelector('#logTabs button[data-lt="all"]') as HTMLElement).className).not.toBe('on')
    } finally {
      LOGS_FIXTURE.logs = []
      LOGS_FIXTURE.total = 0
      LOGS_FIXTURE.pages = 1
      localStorage.removeItem('mdk_log_tab')
      localStorage.setItem('mdk_lang', 'zh')
    }
  })

  it('错误页 200+reason 偏离条目：错误列兜底出 reason 短标（429 退避重试成功不再渲染成空白行）', async () => {
    // 2026-11-21 用户实证：探针施工高压期 bigmodel 429 带 Retry-After → 原地退避重试成功，
    // 470 条 200 躺进「错误」页且错误列全空（reason 无渲染位、attempts/err/cause 也全空）
    LOGS_FIXTURE.logs = [
      {
        ts: '2026-11-21T18:03:59.000+08:00', harness: 'dsh', profile: 'auto-bigmodel', provider: 'bigmodel',
        model: 'glm-4.5-air', path: '/v1/messages', status: 200, ms: 4385,
        reason: 'retried_429:bigmodel', level: 'warn',
      },
      {
        ts: '2026-11-21T18:04:01.000+08:00', harness: 'dsh', profile: 'auto-bigmodel', provider: 'bigmodel',
        model: 'glm-4.5-air', path: '/v1/messages', status: 200, ms: 1119,
        reason: 'retried_429:bigmodel,fallback_to:glm-4.5-air', level: 'warn',
      },
    ]
    LOGS_FIXTURE.total = 2
    LOGS_FIXTURE.pages = 1
    localStorage.setItem('mdk_lang', 'zh')
    localStorage.setItem('mdk_log_tab', 'err')
    try {
      mountPage()
      await flush()
      const table = document.getElementById('logTable') as HTMLElement
      // 单 mark：错误列出「429 退避重试 · bigmodel」，原始 reason 收进 title 悬浮
      // （title 挂在 td 内层 div 上，与 chain 分支同构；行序 reverse 不影响按 title 定位）
      expect(table.textContent).toContain('429 退避重试 · bigmodel')
      const singleDiv = [...table.querySelectorAll('tbody td > div')].find((d) => d.getAttribute('title') === 'retried_429:bigmodel')
      expect(singleDiv?.textContent?.trim()).toBe('429 退避重试 · bigmodel')
      // 多 marks 逗号串逐段映射：429 退避重试 · bigmodel · 模型容灾 · glm-4.5-air
      expect(table.textContent).toContain('429 退避重试 · bigmodel · 模型容灾 · glm-4.5-air')
      // EN 界面同链路（重挂生效，双语标签两参同写）
      localStorage.setItem('mdk_lang', 'en')
      mountPage()
      await flush()
      expect((document.getElementById('logTable') as HTMLElement).textContent).toContain('429 backoff retry · bigmodel')
    } finally {
      LOGS_FIXTURE.logs = []
      LOGS_FIXTURE.total = 0
      LOGS_FIXTURE.pages = 1
      localStorage.removeItem('mdk_log_tab')
      localStorage.setItem('mdk_lang', 'zh')
    }
  })

  it('日志表定宽截断回归：EN 短表头放得下（Code/Copy）、窄列留白腾位与长 token 折行的 CSS 在页', async () => {
    // 2026-11-12 审查回归：定宽按中文表头调优后，EN 全称 Status/Actions 被省略成 St…/Ac…、
    // 8 位毫秒（≥100s）被截断误导读数——修复=窄列减侧留白 + EN 短标签，列宽/min-width 不动
    localStorage.setItem('mdk_lang', 'en')
    try {
      mountPage()
      await flush()
      const thead = document.querySelector('#logTable thead')
      expect(thead?.textContent).toContain('Code')
      expect(thead?.textContent).toContain('Copy')
      expect(thead?.textContent).not.toContain('Status')
      expect(thead?.textContent).not.toContain('Actions')
    } finally {
      localStorage.setItem('mdk_lang', 'zh')
    }
    // 截断防线是 CSS 而非 JS：DOM 行为测试够不着渲染级断言（happy-dom 不做布局），
    // 对页内样式源钉两条规则——被误删即红（客户端/路由列 anywhere 折行 + 窄列留白腾位）
    expect(UI_HTML).toContain('#logTable td:nth-child(2),#logTable td:nth-child(3){overflow-wrap:anywhere}')
    expect(UI_HTML).toContain('#logTable th:nth-child(5),#logTable th:nth-child(6),#logTable th:nth-child(8),#logTable td:nth-child(6){padding-left:4px;padding-right:4px}')
  })

  // 清空模型（草稿两段式确认）：夹具需带模型目录，局部重桩 fetch（finally 还原 beforeAll 桩）
  function stubOverviewWithModels(ms: Array<Record<string, unknown>>, defaultModel: string): () => void {
    const prev = globalThis.fetch
    const fix = JSON.parse(JSON.stringify(OVERVIEW_FIXTURE)) // any：夹具深拷贝后放宽 models 形状
    fix.services[0].models = ms
    fix.services[0].defaultModel = defaultModel
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
      const p = String(url).split('?')[0]
      if (p === '/_modeldock/overview') {
        const raw = JSON.stringify(fix)
        return Promise.resolve({ ok: true, json: () => Promise.resolve(fix), text: () => Promise.resolve(raw) })
      }
      return (prev as (u: string, i?: RequestInit) => unknown)(String(url), init)
    })
    return () => vi.stubGlobal('fetch', prev)
  }

  it('清空模型两段式确认：一击武装、再击清空草稿、空态禁用、保存载荷为空目录且不发 default_model', async () => {
    const cap: { body: Record<string, unknown> | null } = { body: null }
    const restore = stubOverviewWithModels([
      { id: 'm1', context_window: 100, max_output: 10, capabilities: [] },
      { id: 'm2', context_window: 200, max_output: 20, capabilities: ['vision'] },
    ], 'm1')
    const stubbed = globalThis.fetch
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
      const p = String(url).split('?')[0]
      if (p === '/_modeldock/service/update' && init?.method === 'POST') {
        cap.body = JSON.parse(String(init.body)) as Record<string, unknown>
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }), text: () => Promise.resolve('{"ok":true}') })
      }
      return (stubbed as (u: string, i?: RequestInit) => unknown)(String(url), init)
    })
    try {
      mountPage()
      await flush()
      ;(document.querySelector('[data-edit="alpha"]') as HTMLElement)!.click()
      await flush()
      const btn = document.getElementById('efClearAll') as HTMLButtonElement
      expect(btn).not.toBeNull()
      expect(btn.disabled).toBe(false)
      // 清空/拉取成组右对齐（fsec-btns）：fsec-row 是 space-between，裸放会被撑开分居
      expect(btn.parentElement?.classList.contains('fsec-btns')).toBe(true)
      expect(btn.nextElementSibling?.id).toBe('efFetch')
      expect(document.querySelectorAll('#efModelRows .mrow').length).toBe(2)
      // 一击武装：文案翻转、不清行
      btn.click()
      expect(btn.textContent).toContain('再点一次确认清空')
      expect(document.querySelectorAll('#efModelRows .mrow').length).toBe(2)
      // 再击执行：清空草稿（含空态提示）、按钮禁用、反馈写弹层底栏 msg 槽
      btn.click()
      expect(document.querySelectorAll('#efModelRows .mrow').length).toBe(0)
      expect(document.querySelector('#efModelRows .mempty')).not.toBeNull()
      expect(btn.disabled).toBe(true)
      expect(document.getElementById('efMsg')?.textContent ?? '').toContain('已清空全部模型')
      // 保存：models 全量替换为空目录；默认模型已随清空回落 → 不发 default_model
      ;(document.getElementById('efSave') as HTMLElement)!.click()
      await flush()
      expect(cap.body).not.toBeNull()
      expect(cap.body!.models).toEqual({})
      expect('default_model' in cap.body!).toBe(false)
    } finally {
      restore()
    }
  })

  it('清空模型 3s 未再击自动还原（假定时器推进），还原后再击=重新武装而非执行', async () => {
    const restore = stubOverviewWithModels([
      { id: 'm1', context_window: 100, max_output: 10, capabilities: [] },
      { id: 'm2', context_window: 200, max_output: 20, capabilities: [] },
    ], 'm1')
    try {
      mountPage()
      await flush()
      ;(document.querySelector('[data-edit="alpha"]') as HTMLElement)!.click()
      await flush()
      const btn = document.getElementById('efClearAll') as HTMLButtonElement
      btn.click()
      expect(btn.textContent).toContain('再点一次确认清空')
      vi.advanceTimersByTime(3000)
      expect(btn.textContent).not.toContain('再点一次')
      // 还原后再击 = 重新武装而非执行
      btn.click()
      expect(btn.textContent).toContain('再点一次确认清空')
      expect(document.querySelectorAll('#efModelRows .mrow').length).toBe(2)
    } finally {
      restore()
    }
  })

  // 多包合并删包回填口令（fix-merge-rm-pw-keep）：口令草稿按包名键控——删 chip 重建逐包口令行时按名
  // 回填，已填值不随索引移位清空；删到剩 1 包时该包口令迁进单包输入 impPw2（单流读 impPw2 不读 store）
  it('多包合并删 chip：其余口令行保值且与包对应关系不错位，删到剩 1 包迁移进单口令输入', async () => {
    mountPage()
    await flush()
    const mk = (name: string) => new File(['pkg'], name)
    // happy-dom 造不出真 FileList：实例上覆写 files（change 处理器只做 Array.prototype.slice 兼容任意数组）
    const select = (files: File[]) => {
      const input = document.getElementById('impFile2') as HTMLInputElement
      Object.defineProperty(input, 'files', { value: files, configurable: true })
      input.dispatchEvent(new Event('change'))
    }
    const fill = (id: string, v: string) => {
      const el = document.getElementById(id) as HTMLInputElement
      el.value = v
      el.dispatchEvent(new Event('input')) // store 只在 input 监听里更新：派发才等价真实键入
    }
    select([mk('a.msync'), mk('b.msync'), mk('c.msync')])
    expect(document.querySelectorAll('#impChips .filechip').length).toBe(3)
    fill('mgPw0', 'pw-a')
    fill('mgPw2', 'pw-c')
    // 删中间 chip（b.msync）→ 剩 a/c 两行，值按名回填不错位
    ;(document.querySelectorAll('#impChips .filechip')[1].querySelector('button') as HTMLElement).click()
    const rows = [...document.querySelectorAll('#impPwRows .prow')]
    expect(rows.length).toBe(2)
    const valOf = (name: string) =>
      (rows.find((r) => (r.querySelector('label')?.textContent ?? '').startsWith(name))!.querySelector('input') as HTMLInputElement).value
    expect(valOf('a.msync')).toBe('pw-a')
    expect(valOf('c.msync')).toBe('pw-c')
    // 再删一个 → 剩 1 包退回单包流：impPw2 回填该包口令，逐包行清场
    ;(document.querySelectorAll('#impChips .filechip')[0].querySelector('button') as HTMLElement).click()
    expect((document.getElementById('impPw2') as HTMLInputElement).value).toBe('pw-c')
    expect(document.getElementById('impPwRows')?.hidden).toBe(true)
    // 重新多选=新清单从空草稿开始（store 已随 mgSetFiles 清空，不回填上一轮的值）
    select([mk('d.msync'), mk('e.msync')])
    expect((document.getElementById('mgPw0') as HTMLInputElement).value).toBe('')
    expect((document.getElementById('mgPw1') as HTMLInputElement).value).toBe('')
  })

  // 多包口令换选单文件清草稿（fix-merge-single-pw-draft）：change 单文件分流是 impPw2 的最后一种
  // 进法（弹层重开清场、删到 1 包迁移回填各有自己的清/覆写口径）——漏了它，上一来源的口令会残留
  // 在单流唯一口令读点上，换选新文件后被误用
  it('多包填口令（删到 1 包迁进 impPw2）后 change 重选单文件：单流口令输入从空开始', async () => {
    mountPage()
    await flush()
    const mk = (name: string) => new File(['pkg'], name)
    // happy-dom 造不出真 FileList：实例上覆写 files（change 处理器只做 Array.prototype.slice 兼容任意数组）
    const select = (files: File[]) => {
      const input = document.getElementById('impFile2') as HTMLInputElement
      Object.defineProperty(input, 'files', { value: files, configurable: true })
      input.dispatchEvent(new Event('change'))
    }
    const fill = (id: string, v: string) => {
      const el = document.getElementById(id) as HTMLInputElement
      el.value = v
      el.dispatchEvent(new Event('input')) // store 只在 input 监听里更新：派发才等价真实键入
    }
    select([mk('a.msync'), mk('b.msync')])
    fill('mgPw0', 'pw-a')
    fill('mgPw1', 'pw-b')
    // 删 a 的 chip → 剩 b 一包：impPw2 迁入 b 的口令（52f47a5 口径，此时是合法态）
    ;(document.querySelector('#impChips .filechip button') as HTMLElement).click()
    expect((document.getElementById('impPw2') as HTMLInputElement).value).toBe('pw-b')
    // change 重选单文件=换新来源：impPw2 必须从空开始，上一来源口令不得残留误用在新包
    select([mk('c.msync')])
    expect((document.getElementById('impPw2') as HTMLInputElement).value).toBe('')
    // 新文件来源正常接管：chip 换成新文件（清草稿不清文件来源）
    expect(document.getElementById('impFileChip')?.textContent).toContain('c.msync')
  })

  // —— 健康下钻（probe-ui-into-usage-health 任务 2）：服务卡徽标点击 → 该服务 verdict 变化时间线 ——

  it('健康下钻：verdict 徽标 button 化（无结论服务不出），点击打开按服务拉取的时间线弹层（最近 10 条）', async () => {
    PROBE_VERDICTS_FIXTURE.verdicts = [
      { provider: 'alpha', state: 'healthy', evidence: { source: 'scheduled', at: Date.now() - 60000 } },
      { provider: 'alpha', state: 'degraded', evidence: { source: 'manual', at: Date.now() - 120000 } },
    ]
    // 夹具 = 服务端对 provider=alpha 的裁剪响应形态（beta 条目不会出现在该服务的响应里）
    PROBE_TIMELINE_FIXTURE.timeline = [
      { at: '2026-11-20T10:00:00.000+08:00', provider: 'alpha', model: 'a-model', key_fp: 'ab12', from: null, to: 'healthy', source: 'manual' },
    ]
    PROBE_TIMELINE_FIXTURE.total = 1
    const urls: string[] = []
    const prev = globalThis.fetch
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
      urls.push(String(url))
      return (prev as (u: string, i?: RequestInit) => unknown)(String(url), init)
    })
    try {
      mountPage()
      await flush()
      // R3.1：有结论 → button.pill 徽标，语义色取最差结论（degraded=warn）；无结论服务不出徽标亦不出入口
      const badge = document.querySelector('[data-probehist="alpha"]') as HTMLButtonElement | null
      expect(badge).not.toBeNull()
      expect(badge!.tagName).toBe('BUTTON')
      expect(badge!.className).toContain('pill')
      expect(badge!.className).toContain('warn')
      expect(badge!.textContent).toContain('降级')
      expect(badge!.title).toContain('点击查看健康变化历史')
      expect(document.querySelector('[data-probehist="beta"]')).toBeNull()
      // R3.2：点击徽标 → 打开弹层，打开动作内按服务拉取最近 10 条（provider 服务端裁剪 + limit 截断）
      badge!.click()
      const scrim = document.getElementById('probeSvcTimelineOverlay') as HTMLElement | null
      expect(scrim && scrim.hidden === false).toBe(true)
      expect(urls.some((u) => u.startsWith('/_modeldock/probe/timeline?provider=alpha&limit=10'))).toBe(true)
      await flush()
      // 标题动态拼服务名（titleId 先例）；端点已按 provider 裁剪，弹层直接渲染响应条目
      expect(document.getElementById('probeSvcTimelineTitle')?.textContent).toBe('服务健康 · Alpha 服务')
      const table = document.getElementById('probeSvcTimelineTable') as HTMLElement
      expect(table.textContent).toContain('alpha/a-model')
      // 截断态无更多（total=1 不超已加载）→ 不出「展开全部」
      expect(document.getElementById('probeSvcTimelineExpand')).toBeNull()
    } finally {
      PROBE_VERDICTS_FIXTURE.verdicts = []
      PROBE_TIMELINE_FIXTURE.timeline = []
      PROBE_TIMELINE_FIXTURE.total = 0
      vi.stubGlobal('fetch', prev)
    }
  })

  // 旧账让位（2026-11-26 用户实证：「-」占位被动失效把换 key 后的健康结论压在徽标下）：
  // 同服务存在「真实 key 指纹且证据更新」的结论时，「-」占位结论不参与徽标最差排序
  it('健康下钻：「-」占位旧账让位——真实指纹且更新的健康结论压住被动失效不出徽标；占位更新时照常出', async () => {
    const at0 = Date.now()
    // 场景 1：占位失效（21 分钟前 passive）+ 真实指纹健康（刚刚 probe）→ 徽标消失
    PROBE_VERDICTS_FIXTURE.verdicts = [
      { provider: 'alpha', key_fp: '-', model: 'a-model', state: 'auth-dead', evidence: { source: 'passive:p15', at: at0 - 21 * 60000, status: 401 } },
      { provider: 'alpha', key_fp: '0d732852', model: 'a-model', state: 'healthy', evidence: { source: 'probe:p1', at: at0 } },
    ]
    try {
      mountPage()
      await flush()
      expect(document.querySelector('[data-probehist="alpha"]')).toBeNull()
      // 场景 2：占位失效比真实指纹结论更新 → 照常出徽标（坏消息优先不被健康盖住）
      PROBE_VERDICTS_FIXTURE.verdicts = [
        { provider: 'alpha', key_fp: '-', model: 'a-model', state: 'auth-dead', evidence: { source: 'passive:p15', at: at0, status: 401 } },
        { provider: 'alpha', key_fp: '0d732852', model: 'a-model', state: 'healthy', evidence: { source: 'probe:p1', at: at0 - 60000 } },
      ]
      mountPage()
      await flush()
      const badge = document.querySelector('[data-probehist="alpha"]') as HTMLButtonElement | null
      expect(badge).not.toBeNull()
      expect(badge!.className).toContain('err')
      expect(badge!.textContent).toContain('失效')
    } finally {
      PROBE_VERDICTS_FIXTURE.verdicts = []
    }
  })

  it('健康下钻：模型过滤 select 按 (provider, model) 重渲染；该服务无翻转条目出「近 30 天无 verdict 变化」空态', async () => {
    PROBE_VERDICTS_FIXTURE.verdicts = [{ provider: 'alpha', state: 'degraded', evidence: { source: 'manual', at: Date.now() - 60000 } }]
    PROBE_TIMELINE_FIXTURE.timeline = [
      { at: '2026-11-20T10:00:00.000+08:00', provider: 'alpha', model: 'a-model', key_fp: 'ab12', from: null, to: 'healthy', source: 'manual' },
      { at: '2026-11-21T11:30:00.000+08:00', provider: 'alpha', model: 'b-model', key_fp: 'cd34', from: 'healthy', to: 'degraded', source: 'scheduled' },
    ]
    PROBE_TIMELINE_FIXTURE.total = 2
    try {
      mountPage()
      await flush()
      ;(document.querySelector('[data-probehist="alpha"]') as HTMLElement).click()
      await flush()
      // R3.3：选项 = 该服务 distinct model + 「全部模型」（value=''，不受当前过滤收窄）
      const sel = document.getElementById('probeSvcTimelineModelSel') as HTMLSelectElement
      expect([...sel.options].map((o) => o.value)).toEqual(['', 'a-model', 'b-model'])
      expect(sel.options[0].textContent).toContain('全部模型')
      expect(document.querySelectorAll('#probeSvcTimelineTable tbody tr').length).toBe(2)
      // 切到 a-model：只重渲染该 (provider, model) 子集，选中态随重渲染保持
      sel.value = 'a-model'
      sel.dispatchEvent(new Event('change'))
      expect(document.querySelectorAll('#probeSvcTimelineTable tbody tr').length).toBe(1)
      expect(document.getElementById('probeSvcTimelineTable')!.textContent).toContain('a-model')
      expect(document.getElementById('probeSvcTimelineTable')!.textContent).not.toContain('b-model')
      expect((document.getElementById('probeSvcTimelineModelSel') as HTMLSelectElement).value).toBe('a-model')
      // 切回全部模型：子集约束解除，两行回来
      const selAll = document.getElementById('probeSvcTimelineModelSel') as HTMLSelectElement
      selAll.value = ''
      selAll.dispatchEvent(new Event('change'))
      expect(document.querySelectorAll('#probeSvcTimelineTable tbody tr').length).toBe(2)
      // R3.4 空态：徽标在（有结论）但 30 天窗口内该服务无翻转 → 服务端裁剪响应为空 → 空态行
      PROBE_TIMELINE_FIXTURE.timeline = []
      PROBE_TIMELINE_FIXTURE.total = 0
      mountPage()
      await flush()
      ;(document.querySelector('[data-probehist="alpha"]') as HTMLElement).click()
      await flush()
      const tbody = document.querySelector('#probeSvcTimelineTable tbody') as HTMLElement
      expect(tbody.querySelectorAll('tr').length).toBe(1)
      expect(tbody.textContent).toContain('近 30 天无 verdict 变化')
    } finally {
      PROBE_VERDICTS_FIXTURE.verdicts = []
      PROBE_TIMELINE_FIXTURE.timeline = []
      PROBE_TIMELINE_FIXTURE.total = 0
    }
  })

  it('健康下钻：变化列 from→to 出两端语义 pill；窗口内首现 from=null 渲染「— → to」；最新在上', async () => {
    PROBE_VERDICTS_FIXTURE.verdicts = [{ provider: 'alpha', state: 'auth-dead', evidence: { source: 'manual', at: Date.now() - 60000 } }]
    PROBE_TIMELINE_FIXTURE.timeline = [
      { at: '2026-11-20T10:00:00.000+08:00', provider: 'alpha', model: 'a-model', key_fp: 'ab12', from: null, to: 'healthy', source: 'manual' },
      { at: '2026-11-21T11:30:00.000+08:00', provider: 'alpha', model: 'a-model', key_fp: 'ab12', from: 'healthy', to: 'auth-dead', source: 'scheduled' },
      { at: '2026-11-22T09:00:00.000+08:00', provider: 'alpha', model: 'a-model', key_fp: 'ab12', from: 'auth-dead', to: 'unverified', source: 'scheduled' },
    ]
    PROBE_TIMELINE_FIXTURE.total = 3
    try {
      mountPage()
      await flush()
      ;(document.querySelector('[data-probehist="alpha"]') as HTMLElement).click()
      await flush()
      const rows = document.querySelectorAll('#probeSvcTimelineTable tbody tr')
      expect(rows.length).toBe(3)
      const changeOf = (i: number) => rows[i].querySelectorAll('td')[2]
      // 最新在上：第一行 = 最新翻转（auth-dead → unverified：err → dim 两枚 pill）
      expect(changeOf(0).querySelectorAll('.pill').length).toBe(2)
      expect(changeOf(0).querySelector('.pill.err')?.textContent).toBe('失效')
      expect(changeOf(0).querySelector('.pill.dim')?.textContent).toBe('未验证')
      expect(changeOf(1).querySelectorAll('.pill').length).toBe(2)
      expect(changeOf(1).querySelector('.pill.ok')?.textContent).toBe('健康')
      expect(changeOf(1).querySelector('.pill.err')?.textContent).toBe('失效')
      // from=null：「—」（dim span）→ to pill（ok=健康）
      expect(changeOf(2).querySelector('.dim')?.textContent).toBe('—')
      expect(changeOf(2).querySelector('.pill.ok')?.textContent).toBe('健康')
      // 时间列最新在上（引擎升序 → 渲染倒序）
      expect(rows[0].querySelector('td')?.textContent).toContain('2026-11-22')
      expect(rows[2].querySelector('td')?.textContent).toContain('2026-11-20')
      // 时间列 title 兜底（svc-timeline-time-fix）：完整 ISO 含秒——列宽省略时悬浮可见全量
      expect((rows[0].querySelector('td') as HTMLElement).title).toBe('2026-11-22T09:00:00.000+08:00')
    } finally {
      PROBE_VERDICTS_FIXTURE.verdicts = []
      PROBE_TIMELINE_FIXTURE.timeline = []
      PROBE_TIMELINE_FIXTURE.total = 0
    }
  })

  it('健康下钻：截断态出「展开全部 N 条」，点击拉 limit=0 全量重渲染且按钮消失', async () => {
    PROBE_VERDICTS_FIXTURE.verdicts = [{ provider: 'alpha', state: 'degraded', evidence: { source: 'manual', at: Date.now() - 60000 } }]
    const mk = (i: number) => ({
      at: `2026-11-${10 + i}T10:00:00.000+08:00`,
      provider: 'alpha',
      model: 'a-model',
      key_fp: 'ab12',
      from: i % 2 ? 'degraded' : 'healthy',
      to: i % 2 ? 'healthy' : 'degraded',
      source: 'manual',
    })
    // 截断态：服务端只回最近 10 条（夹具模拟），total=12（窗口内还有 2 条未回）
    PROBE_TIMELINE_FIXTURE.timeline = Array.from({ length: 10 }, (_, i) => mk(i))
    PROBE_TIMELINE_FIXTURE.total = 12
    const urls: string[] = []
    const prev = globalThis.fetch
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
      urls.push(String(url))
      return (prev as (u: string, i?: RequestInit) => unknown)(String(url), init)
    })
    try {
      mountPage()
      await flush()
      ;(document.querySelector('[data-probehist="alpha"]') as HTMLElement).click()
      await flush()
      expect(document.querySelectorAll('#probeSvcTimelineTable tbody tr').length).toBe(10)
      // 最新在上：首行时间 = 夹具最大 at（10 条 → 2026-11-19）
      expect(document.querySelector('#probeSvcTimelineTable tbody tr td')?.textContent).toContain('2026-11-19')
      // 截断态按钮：文案带窗口内总数
      const expBtn = document.getElementById('probeSvcTimelineExpand') as HTMLButtonElement | null
      expect(expBtn?.textContent).toBe('展开全部 12 条')
      // 展开点击 → limit=0 全量拉取；夹具换成服务端全量形态
      PROBE_TIMELINE_FIXTURE.timeline = Array.from({ length: 12 }, (_, i) => mk(i))
      expBtn!.click()
      await flush()
      expect(urls.some((u) => u.startsWith('/_modeldock/probe/timeline?provider=alpha&limit=0'))).toBe(true)
      expect(document.querySelectorAll('#probeSvcTimelineTable tbody tr').length).toBe(12)
      // 展开态不再出按钮；模型过滤切换仍走本地缓存（不重发请求）
      expect(document.getElementById('probeSvcTimelineExpand')).toBeNull()
      const urlCount = urls.length
      const sel = document.getElementById('probeSvcTimelineModelSel') as HTMLSelectElement
      sel.value = 'a-model'
      sel.dispatchEvent(new Event('change'))
      await flush()
      expect(urls.length).toBe(urlCount)
      expect(document.querySelectorAll('#probeSvcTimelineTable tbody tr').length).toBe(12)
    } finally {
      PROBE_VERDICTS_FIXTURE.verdicts = []
      PROBE_TIMELINE_FIXTURE.timeline = []
      PROBE_TIMELINE_FIXTURE.total = 0
      vi.stubGlobal('fetch', prev)
    }
  })

  it('健康下钻：读取类弹层关路径三件套（头部 ×、Esc、遮罩点击均可关闭，foot 无关闭/刷新按钮），加载失败写 msg 槽不出 toast', async () => {
    PROBE_VERDICTS_FIXTURE.verdicts = [{ provider: 'alpha', state: 'degraded', evidence: { source: 'manual', at: Date.now() - 60000 } }]
    PROBE_TIMELINE_FIXTURE.timeline = [
      { at: '2026-11-20T10:00:00.000+08:00', provider: 'alpha', model: 'a-model', key_fp: 'ab12', from: null, to: 'healthy', source: 'manual' },
    ]
    PROBE_TIMELINE_FIXTURE.total = 1
    try {
      mountPage()
      await flush()
      const badge = document.querySelector('[data-probehist="alpha"]') as HTMLElement
      badge.click()
      const scrim = document.getElementById('probeSvcTimelineOverlay') as HTMLElement
      expect(scrim.hidden).toBe(false)
      // 加载态：打开即拉取，拉取未完成 body 为加载占位
      expect(scrim.querySelector('.modal-body')?.textContent).toContain('加载中…')
      const modal = scrim.querySelector('.modal') as HTMLElement
      const foot = modal.querySelector('.modal-foot') as HTMLElement
      // R3.5：foot 仅 msg 槽——零按钮（无「关闭」无「刷新」），msg 槽为 err 形态（.mferr）
      expect(foot.querySelectorAll('button').length).toBe(0)
      expect(document.getElementById('probeSvcTimelineMsg')?.className).toContain('mferr')
      // 关路径一：头部 ×
      ;(modal.querySelector('.close-btn') as HTMLElement).click()
      expect(scrim.hidden).toBe(true)
      // 关路径二：Esc（closeOnEsc 默认开）
      badge.click()
      expect(scrim.hidden).toBe(false)
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
      expect(scrim.hidden).toBe(true)
      // 关路径三：遮罩点击（closeOnScrim:true 显式传入；点弹层内部不关由工厂 e.target 判定兜住）
      badge.click()
      expect(scrim.hidden).toBe(false)
      scrim.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      expect(scrim.hidden).toBe(true)
      // 错误态：timeline 拉取失败 → foot msg 槽就近报错，全局 toast 容器保持为空（弹层提示归宿纪律）
      const prev = globalThis.fetch
      vi.stubGlobal('fetch', (url: string) => {
        const p = String(url).split('?')[0]
        if (p === '/_modeldock/probe/timeline') return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}), text: () => Promise.resolve('{}') })
        return (prev as (u: string) => unknown)(String(url))
      })
      try {
        mountPage()
        await flush()
        ;(document.querySelector('[data-probehist="alpha"]') as HTMLElement).click()
        await flush()
        expect(document.getElementById('probeSvcTimelineMsg')?.textContent ?? '').toContain('时间线加载失败')
        expect(document.querySelectorAll('#toastWrap .toast').length).toBe(0)
      } finally {
        vi.stubGlobal('fetch', prev)
      }
    } finally {
      PROBE_VERDICTS_FIXTURE.verdicts = []
      PROBE_TIMELINE_FIXTURE.timeline = []
      PROBE_TIMELINE_FIXTURE.total = 0
    }
  })

  // —— 诊断统一弹层（diag-modal-probe-ui）：徽标异常才显 + 卡片「诊断」按钮 + 两段式成本确认 ——

  it('diag-modal-probe-ui：健康徽标异常才显——healthy/unverified 静默，degraded 出 warn、auth-dead 出 err', async () => {
    try {
      PROBE_VERDICTS_FIXTURE.verdicts = [{ provider: 'alpha', state: 'healthy', evidence: { source: 'manual', at: Date.now() - 60000 } }]
      mountPage()
      await flush()
      expect(document.querySelector('[data-probehist="alpha"]')).toBeNull() // 健康静默（全量状态只在弹层「当前结论」区）
      PROBE_VERDICTS_FIXTURE.verdicts = [{ provider: 'alpha', state: 'unverified', evidence: { source: 'probe:p14', at: Date.now() - 60000 } }]
      mountPage()
      await flush()
      expect(document.querySelector('[data-probehist="alpha"]')).toBeNull() // 未验证静默
      PROBE_VERDICTS_FIXTURE.verdicts = [{ provider: 'alpha', state: 'degraded', evidence: { source: 'manual', at: Date.now() - 60000 } }]
      mountPage()
      await flush()
      const badge = document.querySelector('[data-probehist="alpha"]') as HTMLElement | null
      expect(badge).not.toBeNull()
      expect(badge!.className).toContain('warn')
      PROBE_VERDICTS_FIXTURE.verdicts = [{ provider: 'alpha', state: 'auth-dead', evidence: { source: 'manual', at: Date.now() - 60000 } }]
      mountPage()
      await flush()
      expect((document.querySelector('[data-probehist="alpha"]') as HTMLElement).className).toContain('err')
    } finally {
      PROBE_VERDICTS_FIXTURE.verdicts = []
    }
  })

  it('diag-modal-probe-ui：免费 ping 即时执行写行内结果；no-key 服务付费动作按钮禁用', async () => {
    const prev = globalThis.fetch
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
      const p = String(url).split('?')[0]
      if (p === '/_modeldock/test') {
        const body = { ok: true, ms: 42 }
        return Promise.resolve({ ok: true, json: () => Promise.resolve(body), text: () => Promise.resolve(JSON.stringify(body)) })
      }
      return (prev as (u: string, i?: RequestInit) => unknown)(String(url), init)
    })
    const betaKey = OVERVIEW_FIXTURE.services[1].hasKey
    OVERVIEW_FIXTURE.services[1].hasKey = false
    try {
      mountPage()
      await flush()
      ;(document.querySelector('[data-diag="alpha"]') as HTMLElement).click()
      const scrim = document.getElementById('probeSvcTimelineOverlay') as HTMLElement
      expect(scrim.hidden).toBe(false)
      expect(document.getElementById('probeSvcTimelineTitle')?.textContent).toBe('服务健康 · Alpha 服务')
      expect(document.getElementById('diagPingBtn')).not.toBeNull()
      ;(document.getElementById('diagPingBtn') as HTMLElement).click()
      await flush()
      const res = document.getElementById('diagPingRes') as HTMLElement
      expect(res.className).toContain('ok')
      expect(res.textContent).toContain('42ms')
      // no-key 服务：付费动作禁用（免费 ping 恒可用）
      ;(document.querySelector('[data-diag="beta"]') as HTMLElement).click()
      await flush()
      const p1 = document.getElementById('diagP1Btn') as HTMLButtonElement
      expect(p1.disabled).toBe(true)
      expect(p1.title).toContain('key')
      expect((document.getElementById('diagPingBtn') as HTMLButtonElement).disabled).toBe(false)
    } finally {
      OVERVIEW_FIXTURE.services[1].hasKey = betaKey
      vi.stubGlobal('fetch', prev)
    }
  })

  it('diag-modal-probe-ui：探针模型下拉回显与保存（probe-model-select）——onchange 即持久化，失败回弹写 foot 槽', async () => {
    const updateCalls: Array<Record<string, unknown>> = []
    const prev = globalThis.fetch
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
      const p = String(url).split('?')[0]
      if (p === '/_modeldock/service/update' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>
        updateCalls.push(body)
        if (body.probe_model === 'm3') return Promise.resolve({ ok: false, status: 400, json: () => Promise.resolve({ ok: false, err: '不在模型表', modeldock: { hint: '填模型表内的 ID' } }), text: () => Promise.resolve('{"ok":false,"err":"不在模型表"}') })
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }), text: () => Promise.resolve('{"ok":true}') })
      }
      return (prev as (u: string, i?: RequestInit) => unknown)(String(url), init)
    })
    const prevModels = OVERVIEW_FIXTURE.services[0].models
    try {
      OVERVIEW_FIXTURE.services[0].models = [
        { id: 'm1', display_name: '贵模型' },
        { id: 'm2', display_name: 'M2' },
        { id: 'm3', display_name: 'M3' },
      ]
      OVERVIEW_FIXTURE.services[0].defaultModel = 'm2'
      OVERVIEW_FIXTURE.services[0].probeModel = 'm2'
      OVERVIEW_FIXTURE.services[0].probeModelExplicit = false
      mountPage()
      await flush()
      ;(document.querySelector('[data-diag="alpha"]') as HTMLElement).click()
      const sel = document.getElementById('diagProbeModelSel') as HTMLSelectElement
      expect(sel).not.toBeNull()
      // 未显式指定 → 选中「跟随默认模型」（空值）；选项含模型表全部模型
      expect(sel.value).toBe('')
      expect(sel.textContent).toContain('跟随默认模型')
      expect(sel.textContent).toContain('m1 · 贵模型')
      // 选 m2 → POST /service/update {provider, probe_model:'m2'}，成功写 foot 槽 + 快照同步
      sel.value = 'm2'
      sel.dispatchEvent(new Event('change'))
      await flush()
      expect(updateCalls).toHaveLength(1)
      expect(updateCalls[0]).toEqual({ provider: 'alpha', probe_model: 'm2' })
      expect(document.getElementById('probeSvcTimelineMsg')?.textContent).toContain('已保存')

      // 快照同步：重开弹层（body 自 view 重建）回显显式值——view 是夹具的深拷贝，内存快照
      // 的变更只能经重开渲染观察（5s 轮询后服务端权威值亦同）
      ;(document.getElementById('probeSvcTimelineOverlay') as HTMLElement).hidden = true
      ;(document.querySelector('[data-diag="alpha"]') as HTMLElement).click()
      const sel2 = document.getElementById('diagProbeModelSel') as HTMLSelectElement
      expect(sel2.value).toBe('m2')
      // 失败路径：选 m3（stub 回 400）→ select 回弹旧值 + foot 槽报错（不走全局 toast）
      sel2.value = 'm3'
      sel2.dispatchEvent(new Event('change'))
      await flush()
      expect(sel2.value).toBe('m2')
      expect(document.getElementById('probeSvcTimelineMsg')?.textContent).toContain('保存失败')
      // 改回「跟随默认模型」→ 空串提交（服务端删除字段），重开回显空值
      sel2.value = ''
      sel2.dispatchEvent(new Event('change'))
      await flush()
      expect(updateCalls[updateCalls.length - 1]).toEqual({ provider: 'alpha', probe_model: '' })
      ;(document.getElementById('probeSvcTimelineOverlay') as HTMLElement).hidden = true
      ;(document.querySelector('[data-diag="alpha"]') as HTMLElement).click()
      expect((document.getElementById('diagProbeModelSel') as HTMLSelectElement).value).toBe('')
    } finally {
      OVERVIEW_FIXTURE.services[0].models = prevModels
      delete OVERVIEW_FIXTURE.services[0].probeModel
      delete OVERVIEW_FIXTURE.services[0].probeModelExplicit
      vi.stubGlobal('fetch', prev)
    }
  })

  it('diag-run-timeout：探针运行请求放宽 api 超时到 120s（P14 五轮串行超 15s 默认上限），超时文案说明引擎仍在后台', () => {
    expect(UI_JS_PROBE).toContain('timeoutMs: 120000')
    expect(UI_JS_PROBE).toContain('引擎仍在后台运行')
  })

  it('diag-modal-probe-ui：错误全文可读可拷（diag-err-copy）——结果行换行不截断、点击复制翻转反馈；当前结论补 err 行', async () => {
    const prev = globalThis.fetch
    const prevVerdicts = PROBE_VERDICTS_FIXTURE.verdicts
    let runCalls = 0
    const LONG_ERR = '探针 P1 回显不匹配：期望「MODELDOCK-OK」，实际「好的，我已经明白您的要求，下面是回复内容：MODELDOCK-OK 以上就是全部回复」（服务可达但 canary 未以独立词出现，人工复核）'
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
      const p = String(url).split('?')[0]
      if (p === '/_modeldock/probe/run') {
        runCalls++
        const body = runCalls === 1
          ? { ok: false, needConfirm: true, reason: 'unconfirmed', provider: 'alpha', probes: ['p1'], targets: 1, estimate: 200, per_probe_cost: { p1: 200 }, budget: {}, confirmToken: 'tok-copy', verdicts: [], skipped: [] }
          : { ok: true, reason: 'ok', provider: 'alpha', probes: ['p1'], targets: 1, dispatched: 1, upstreamRequests: 1, tokens: 40, estimate: 200, per_probe_cost: { p1: 200 }, budget: {}, verdicts: [{ provider: 'alpha', key_fp: '2ad4cc96', model: 'glm-5-3-flash-260828', state: 'degraded', evidence: { source: 'probe:p1', at: Date.now(), status: 200, err: LONG_ERR } }], skipped: [] }
        return Promise.resolve({ ok: true, json: () => Promise.resolve(body), text: () => Promise.resolve(JSON.stringify(body)) })
      }
      return (prev as (u: string, i?: RequestInit) => unknown)(String(url), init)
    })
    try {
      PROBE_VERDICTS_FIXTURE.verdicts = [{ provider: 'alpha', state: 'degraded', evidence: { source: 'passive:p15', at: Date.now() - 60000, status: 502, err: '历史失败摘要——来自被动聚合的证据（上一轮）' } }]
      mountPage()
      await flush()
      // 当前结论区：非健康且有 evidence.err 的三元组补 err 行，全文可见可点
      ;(document.querySelector('[data-diag="alpha"]') as HTMLElement)!.click()
      const cure = document.querySelector('#diagCurrentBox .cureline') as HTMLElement | null
      expect(cure).not.toBeNull()
      expect(cure!.textContent).toContain('历史失败摘要')
      cure!.click() // .click() 同步触发 onclick（happy-dom onclick 期望 PointerEvent，直接构造 Event 类型不过）
      await flush() // copyText 反馈走 clipboard promise 微任务（happy-dom 有 clipboard API），断言前冲刷
      expect(cure!.textContent).toContain('已复制')
      // 健康三元组不出 err 行（fixture 只有一条 degraded——健康路径用另一服务验证）
      expect(document.querySelectorAll('#diagCurrentBox .cureline').length).toBe(1)
      // 运行 P1 两段式：结果行写长 err → 点击复制翻转 → 1.6s 后还原（fake timers 手动推进）
      runCalls = 0
      ;(document.getElementById('diagP1Btn') as HTMLElement)!.click()
      await flush()
      ;(document.getElementById('diagP1Go') as HTMLElement)!.click()
      await flush()
      const dres = document.getElementById('diagP1Res') as HTMLElement
      expect(dres.className).toContain('copyable')
      expect(dres.textContent).toContain('MODELDOCK-OK')
      expect(dres.textContent).toContain('人工复核')
      dres.click()
      await flush()
      expect(dres.textContent).toContain('已复制')
      vi.advanceTimersByTime(1600)
      expect(dres.textContent).toBe('✗ 降级 · glm-5-3-flash-260828 @2ad4cc96 · 40 tokens · ' + LONG_ERR)
      // 空结果行不可点（无 copyable）
      expect(document.getElementById('diagPingRes')?.className ?? '').not.toContain('copyable')
    } finally {
      PROBE_VERDICTS_FIXTURE.verdicts = prevVerdicts
      vi.stubGlobal('fetch', prev)
    }
  })

  it('diag-modal-probe-ui：P1 两段式成本确认——第一段零执行只出确认态，确认后带 confirmToken 重发，结果行写 verdict', async () => {
    const runCalls: Array<{ url: string; body: any }> = []
    const prev = globalThis.fetch
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
      const p = String(url).split('?')[0]
      if (p === '/_modeldock/probe/run') {
        runCalls.push({ url: String(url), body: init && init.body ? JSON.parse(String(init.body)) : {} })
        const body = runCalls.length >= 2
          ? { ok: true, reason: 'ok', provider: 'alpha', probes: ['p1'], targets: 1, dispatched: 1, upstreamRequests: 1, tokens: 86, estimate: 200, per_probe_cost: { p1: 200 }, budget: {}, verdicts: [{ provider: 'alpha', key_fp: 'ab12', model: 'a-model', state: 'healthy', evidence: { source: 'probe:p1', at: Date.now() } }], skipped: [] }
          : { ok: false, needConfirm: true, reason: 'unconfirmed', provider: 'alpha', probes: ['p1'], targets: 1, estimate: 200, per_probe_cost: { p1: 200 }, budget: {}, confirmToken: 'tok-1', verdicts: [], skipped: [] }
        return Promise.resolve({ ok: true, json: () => Promise.resolve(body), text: () => Promise.resolve(JSON.stringify(body)) })
      }
      return (prev as (u: string, i?: RequestInit) => unknown)(String(url), init)
    })
    try {
      mountPage()
      await flush()
      ;(document.querySelector('[data-diag="alpha"]') as HTMLElement).click()
      const p1 = document.getElementById('diagP1Btn') as HTMLElement
      p1.click()
      await flush()
      // 第一段：无 token 只出预估确认态（needConfirm），confirmToken 缓存待第二段
      expect(runCalls.length).toBe(1)
      expect(runCalls[0].body).toEqual({ provider: 'alpha', probes: ['p1'] })
      expect((document.getElementById('diagP1Confirm') as HTMLElement).hidden).toBe(false)
      // 取消：确认态收起，不重发
      ;(document.getElementById('diagP1Cancel') as HTMLElement).click()
      expect((document.getElementById('diagP1Confirm') as HTMLElement).hidden).toBe(true)
      // 再运行 → stage1 重发预估（token 重取）→ 确认花费：第二段带 confirmToken；结果行 ok 语义色 + verdict 摘要
      p1.click()
      await flush()
      ;(document.getElementById('diagP1Go') as HTMLElement).click()
      await flush()
      expect(runCalls.length).toBe(3)
      // 第二段带 confirmToken + runId（p14-progress：前端生成随运行请求带上，后端字符白名单净化）
      expect(runCalls[2].body.provider).toBe('alpha')
      expect(runCalls[2].body.probes).toEqual(['p1'])
      expect(runCalls[2].body.confirmToken).toBe('tok-1')
      expect(typeof runCalls[2].body.runId).toBe('string')
      expect((runCalls[2].body.runId as string).length).toBeGreaterThanOrEqual(8)
      const res = document.getElementById('diagP1Res') as HTMLElement
      expect(res.className).toContain('ok')
      expect(res.textContent).toContain('健康')
      expect(res.textContent).toContain('a-model')
      expect(res.textContent).toContain('86 tokens')
      // 弹层提示归宿纪律：全程零全局 toast
      expect(document.querySelectorAll('#toastWrap .toast').length).toBe(0)
    } finally {
      vi.stubGlobal('fetch', prev)
    }
  })

  it('diag-modal-probe-ui：P14 轮次进度——runId 随第二段带上，POST 在飞时轮询 run-progress 刷按钮文案，结束停轮询恢复「运行」', async () => {
    let resolveRun!: (v: unknown) => void
    let pollCount = 0
    const prev = globalThis.fetch
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
      const p = String(url).split('?')[0]
      if (p === '/_modeldock/probe/run') {
        const body = init && init.body ? JSON.parse(String(init.body)) : {}
        if (!body.confirmToken) {
          const est = { ok: false, needConfirm: true, reason: 'unconfirmed', provider: 'alpha', probes: ['p14'], targets: 1, estimate: 10000, per_probe_cost: { p14: 10000 }, budget: {}, confirmToken: 'tok-14', verdicts: [], skipped: [] }
          return Promise.resolve({ ok: true, json: () => Promise.resolve(est), text: () => Promise.resolve(JSON.stringify(est)) })
        }
        return new Promise((r) => { resolveRun = r }) // 在飞挂起：给轮询留观察窗
      }
      if (p === '/_modeldock/probe/run-progress') {
        pollCount++
        // 采样维度（p14-progress 2/3 · 3/5）：引擎上报 jittery 采样序号，弹层拼「采样 2/3 · 第 3/5 轮」
        const body = { ok: true, active: true, probe: 'p14', provider: 'alpha', round: 3, rounds: 5, sample: 2, samples: 3 }
        return Promise.resolve({ ok: true, json: () => Promise.resolve(body), text: () => Promise.resolve(JSON.stringify(body)) })
      }
      return (prev as (u: string, i?: RequestInit) => unknown)(String(url), init)
    })
    // 定时器沿用文件级 beforeAll 的 fake timers（冻结 60s 轮询等）：本测试只推进自己的 800ms
    // 轮询周期，finally 不得 useRealTimers——会把文件级冻结态换回真实定时器，殃及后续用例
    try {
      mountPage()
      await flush()
      ;(document.querySelector('[data-diag="alpha"]') as HTMLElement).click()
      ;(document.getElementById('diagP14Btn') as HTMLElement).click()
      await flush()
      ;(document.getElementById('diagP14Go') as HTMLElement).click()
      await flush()
      // POST 在飞：首tick前仍是「检测中…」，一个轮询周期后按钮出现轮次文案（不走 diagBtnBusy
      // 刷新——它会把中间文案存进 _t 污染恢复；恢复文案由首次 diagBtnBusy(true) 存的「检测中…」无关）
      expect((document.getElementById('diagP14Btn') as HTMLElement).textContent).toBe('检测中…')
      vi.advanceTimersByTime(800)
      await flush()
      // 采样段 + 轮次段同显：samples>1 拼采样维度，15 轮（3×5）总量可预期
      expect((document.getElementById('diagP14Btn') as HTMLElement).textContent).toContain('采样 2/3')
      expect((document.getElementById('diagP14Btn') as HTMLElement).textContent).toContain('3/5')
      // 结束：POST resolve → 停轮询恢复「运行」，后续周期不再发请求
      const done = { ok: true, reason: 'ok', provider: 'alpha', probes: ['p14'], targets: 1, dispatched: 1, upstreamRequests: 5, tokens: 240, estimate: 10000, per_probe_cost: { p14: 10000 }, budget: {}, verdicts: [{ provider: 'alpha', key_fp: 'ab12', model: 'a-model', state: 'healthy', evidence: { source: 'probe:p14', at: Date.now() }, advisory: { ttft_p50: 296, ttft_p95: 311 } }], skipped: [] }
      resolveRun({ ok: true, json: () => Promise.resolve(done), text: () => Promise.resolve(JSON.stringify(done)) })
      await flush()
      expect((document.getElementById('diagP14Btn') as HTMLElement).textContent).toBe('运行')
      expect((document.getElementById('diagP14Res') as HTMLElement).textContent).toContain('240 tokens')
      const before = pollCount
      vi.advanceTimersByTime(2400)
      await flush()
      expect(pollCount).toBe(before)
    } finally {
      vi.stubGlobal('fetch', prev)
    }
  })

  // —— 探针自耗融入用量仪表 + 入口收敛（probe-ui-selfusage-and-entry-removal）——
  // 本文件 isolate:false 共享进程：此前用例挂载的页面脚本轮询定时器全部存活，且探针自耗 pill
  // 的数据走每份闭包各自的 probeLedgerLite 缓存（只在挂载求值与 60s 档重拉时刷新）。
  // mountAndConverge 推进 60s 让所有闭包的账本缓存都收敛到当前夹具——此后任何闭包的 #health
  // 重建写的都是同一 pill，断言与「哪个闭包最后写」解耦；夹具变更后再收敛一次即模拟到点重拉。

  function seedLedger(total: number, requests: number, spent: number, remaining: number, exhausted: boolean): void {
    PROBE_LEDGER_FIXTURE.budget = { month: '2026-11', budget: 50000, spent, remaining, exhausted }
    PROBE_LEDGER_FIXTURE.breakdown = {
      month: '2026-11', total, estimated_total: 24000, requests,
      by_probe: total > 0 ? { p11: Math.round(total * 0.6) } : {},
      by_probe_requests: requests > 0 ? { p11: requests } : {},
    }
    PROBE_LEDGER_FIXTURE.probe_labels = { p11: '输出上限||Output limit' }
  }

  function resetLedger(): void {
    PROBE_LEDGER_FIXTURE.budget = null
    PROBE_LEDGER_FIXTURE.breakdown = null
    PROBE_LEDGER_FIXTURE.probe_labels = undefined
  }

  async function mountAndConverge(): Promise<void> {
    mountPage()
    await flush(60)
    vi.advanceTimersByTime(60000)
    await flush()
  }

  it('探针自耗 pill 渲染进健康横幅：tokens/预算余取 breakdown.total 与 budget.remaining（slim 短文案），dim 形态带引导 title', async () => {
    seedLedger(18240, 17, 18240, 31760, false)
    try {
      await mountAndConverge()
      const health = document.getElementById('health')!
      const pill = document.getElementById('probeSelfPill') as HTMLButtonElement | null
      expect(pill).not.toBeNull()
      expect(pill!.tagName).toBe('BUTTON')
      expect(pill!.className).toBe('pill dim')
      // slim-probe-pill：横幅只留最短信号「探针 X · 余 Y」，完整信息在 title 与明细弹层
      expect(pill!.textContent).toContain('探针 18.2k · 余 31.8k')
      expect(pill!.textContent).not.toContain('tokens')
      expect(pill!.title).toContain('探针花费记独立账本，不进请求日志与今日用量')
      expect(pill!.title).toContain('点击查看按探针明细与月预算余量')
      // 融入位置：探针 pill 与今日用量 pill 在同一横幅、usageHtml 之后并列
      expect(health.textContent).toContain('今日 1.5k')
      expect(health.textContent!.indexOf('今日 1.5k')).toBeLessThan(health.textContent!.indexOf('探针 18.2k'))
    } finally {
      resetLedger()
    }
  })

  it('探针自耗零值不出 pill：requests=0 且 spent=0 时横幅无探针入口（对齐 usage 无流量不显示）', async () => {
    seedLedger(0, 0, 0, 50000, false)
    try {
      await mountAndConverge()
      expect(document.getElementById('probeSelfPill')).toBeNull()
      // 明细弹层壳仍存在（脚本创建），只是无 pill 入口
      expect(document.getElementById('probeLedgerOverlay')).not.toBeNull()
    } finally {
      resetLedger()
    }
  })

  it('探针自耗 0-token 调用不出 pill（slim-probe-pill）：requests>0 但 total=0 且未耗尽 → 隐藏（旧口径常驻占位）', async () => {
    // 上游未回 usage 的调用按 0 tokens 入账（调用发生本身入账）——有过调用 ≠ 有消耗
    seedLedger(0, 3, 0, 50000, false)
    try {
      await mountAndConverge()
      expect(document.getElementById('probeSelfPill')).toBeNull()
    } finally {
      resetLedger()
    }
  })

  it('探针自耗预算耗尽：pill 升 warn 语义色且 title 追加硬停警示', async () => {
    seedLedger(50000, 20, 50000, 0, true)
    try {
      await mountAndConverge()
      const pill = document.getElementById('probeSelfPill') as HTMLButtonElement | null
      expect(pill).not.toBeNull()
      expect(pill!.className).toBe('pill warn')
      expect(pill!.className).not.toContain('dim')
      expect(pill!.title).toContain('预算耗尽：探针硬停')
    } finally {
      resetLedger()
    }
  })

  it('探针自耗明细弹层五态与关路径三件套：打开即拉取、svcmodal 壳、foot 只留 msg 槽（无刷新按钮）', async () => {
    seedLedger(18240, 17, 18240, 31760, false)
    try {
      await mountAndConverge()
      // 打开即拉取：点击 pill 开弹层，body 先为加载占位（重开清旧数据面），拉取完成换数据面
      ;(document.getElementById('probeSelfPill') as HTMLElement).click()
      const scrim = document.getElementById('probeLedgerOverlay') as HTMLElement
      expect(scrim.hidden).toBe(false)
      expect(scrim.querySelector('.modal-body')?.textContent).toContain('加载中…')
      await flush()
      // 成功态：标题「探针自耗」、账期/月度总花费/预算行/按探针分解（标签取 probe_labels 当前语言半边）
      expect(scrim.querySelector('.modal-head h3')?.textContent).toBe('探针自耗')
      const body = scrim.querySelector('.modal-body') as HTMLElement
      expect(body.textContent).toContain('账期 2026-11 · 月度总花费 18.2k tokens · 预估 24.0k · 17 次调用')
      expect(body.textContent).toContain('月预算 50.0k · 已用 18.2k · 剩余 31.8k')
      expect(body.textContent).toContain('探针花费记独立账本，不进请求日志与今日用量')
      const table = document.getElementById('probeLedgerTable') as HTMLElement
      expect(table.textContent).toContain('p11')
      expect(table.textContent).toContain('输出上限')
      expect(table.textContent).toContain('10.9k')
      // 读取类弹层呈现面：svcmodal 680px 宽壳；foot 仅 msg 槽（.mferr），零按钮——孤儿「刷新」消灭
      expect(scrim.querySelector('.modal')?.className).toContain('svcmodal')
      const foot = scrim.querySelector('.modal-foot') as HTMLElement
      expect(foot.querySelectorAll('button').length).toBe(0)
      // 关闭按钮 ✕ 图标工厂内注入（fix-modal-close-icon）：probe 弹层创建晚于 WIRING 一次性
      // 扫描，此前吃不到图标注入呈空壳——后置片段创建的弹层同样必须自带图标
      const ledgerClose = scrim.querySelector('.close-btn') as HTMLElement | null
      expect(ledgerClose?.querySelector('svg')).not.toBeNull()
      expect(document.getElementById('probeLedgerMsg')?.className).toContain('mferr')
      // 关路径三件套（读取类口径）：头部 × / Esc / 遮罩点击，三条均可关闭
      ;(scrim.querySelector('.close-btn') as HTMLElement).click()
      expect(scrim.hidden).toBe(true)
      ;(document.getElementById('probeSelfPill') as HTMLElement).click()
      expect(scrim.hidden).toBe(false)
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
      expect(scrim.hidden).toBe(true)
      ;(document.getElementById('probeSelfPill') as HTMLElement).click()
      expect(scrim.hidden).toBe(false)
      scrim.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      expect(scrim.hidden).toBe(true)
      // 空态行：by_probe 无键 → 「本月暂无探针调用」。slim-probe-pill 后 total=0 不再出 pill
      //（无入口），故空态夹具给微量消耗（total=spent=300 同源一致）保住 pill 入口，
      // 再把分解表清空（seedLedger 的 by_probe 与 total 联动，空态需解耦）
      seedLedger(300, 2, 300, 49700, false)
      ;(PROBE_LEDGER_FIXTURE.breakdown as Record<string, unknown>)!.by_probe = {}
      await mountAndConverge()
      ;(document.getElementById('probeSelfPill') as HTMLElement).click()
      await flush()
      expect((document.getElementById('probeLedgerTable') as HTMLElement).textContent).toContain('本月暂无探针调用')
      // 错误态：弹层内拉取失败 → foot msg 槽就近报错（body 保守留加载占位），全局 toast 容器为空。
      // 首拉（pill 缓存）放行保住入口，其后失败——lite 轮询与弹层拉取同端点，按调用次计数分流
      let ledgerCalls = 0
      const prev = globalThis.fetch
      vi.stubGlobal('fetch', (url: string) => {
        const p = String(url).split('?')[0]
        if (p === '/_modeldock/probe/ledger') {
          ledgerCalls++
          if (ledgerCalls > 1) return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}), text: () => Promise.resolve('{}') })
        }
        return (prev as (u: string) => unknown)(String(url))
      })
      try {
        await mountAndConverge()
        ;(document.getElementById('probeSelfPill') as HTMLElement).click()
        await flush()
        expect(document.getElementById('probeLedgerMsg')?.textContent ?? '').toContain('账本加载失败')
        expect(document.querySelectorAll('#toastWrap .toast').length).toBe(0)
      } finally {
        vi.stubGlobal('fetch', prev)
      }
    } finally {
      resetLedger()
    }
  })

  it('入口收敛：探针账本/趋势两按钮与趋势弹层壳从页面消失（费用并入探针 pill、健康历史并入服务徽标）', async () => {
    mountPage()
    await flush()
    expect(document.getElementById('probeLedgerBtn')).toBeNull()
    expect(document.getElementById('probeTrendBtn')).toBeNull()
    // probeTrendM 在脚本求值时开壳挂 body：趋势弹层删除后壳不得存在（探针自耗壳照常创建）
    expect(document.getElementById('probeTrendOverlay')).toBeNull()
    expect(document.getElementById('probeLedgerOverlay')).not.toBeNull()
    // 静态骨架与内嵌脚本源均不再携带入口与趋势弹层（防按钮删了、脚本残留死代码）
    expect(UI_HTML).not.toContain('probeLedgerBtn')
    expect(UI_HTML).not.toContain('probeTrendBtn')
    expect(UI_HTML).not.toContain('probeTrendOverlay')
  })

  it('探针自耗 60s 低频轮询：advanceTimersByTime(60000) 重拉账本，缓存更新经重建点回填横幅新值', async () => {
    seedLedger(18240, 17, 18240, 31760, false)
    try {
      await mountAndConverge()
      expect((document.getElementById('probeSelfPill') as HTMLElement).textContent).toContain('31.8k')
      // 探针人工触发后账本变化：60s 档到点重拉，全部闭包缓存收敛到新夹具后横幅换新值
      seedLedger(20000, 18, 20000, 30000, false)
      vi.advanceTimersByTime(60000)
      await flush()
      const pill = document.getElementById('probeSelfPill') as HTMLElement
      expect(pill.textContent).toContain('探针 20.0k · 余 30.0k')
    } finally {
      resetLedger()
    }
  })
})
