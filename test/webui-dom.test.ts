// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeAll, afterAll } from 'vitest'
import { UI_HTML } from '../src/gateway/ui.js'

// Web 控制台 DOM 行为测试（docs/web-testing-plan.md L2）：把桌面页内嵌脚本挂进 happy-dom
// （纯 JS，无 native，不违反 SEA 依赖约束），stub fetch 返回 /overview 契约夹具，断言渲染与
// 语言切换行为。伪定时器冻结 5s/60s 轮询（singleFork 共享进程：afterAll 必须还原全部桩）。
//
// 夹具形状 = buildOverview 的对外契约（gateway/services/clients/presets/knownModels/sync）；
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

const OVERVIEW_FIXTURE = {
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
  presets: [],
  knownModels: {},
  sync: null,
  syncRequest: null,
}

/** stub fetch：已知端点回夹具，未知端点回 {ok:true} 并打日志（spike 期便于发现漏配） */
function stubFetch(): void {
  const routes: Record<string, () => { body: unknown; raw?: string }> = {
    '/_modeldock/overview': () => ({ body: OVERVIEW_FIXTURE }),
    '/_modeldock/health': () => ({ body: { ok: true } }),
    '/_modeldock/admin/update/status': () => ({ body: { current: '1.0.0', available: false } }),
    '/_modeldock/model-catalog': () => ({ body: { ok: true, models: {} } }),
    '/_modeldock/logs': () => ({ body: { logs: [], total: 0, page: 1, pages: 1 } }),
    '/_modeldock/lan': () => ({ body: { ok: true, enabled: false } }),
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
    // 首屏健康横幅被 load() 填充（静态骨架被替换即证明 load→render 链走通；
    // 横幅端口号取 location.port，happy-dom 下为空，不在此断言）
    const health = document.getElementById('health')
    expect(health?.textContent ?? '').toContain('本地网关运行中')
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
})
