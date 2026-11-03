// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeAll, afterAll } from 'vitest'
import { UI_HTML } from '../src/gateway/ui.js'

// PERF-23 渲染上限 DOM 测试：编辑弹层 ModelRows / FetchRows 对数百模型初始只渲染
// RENDER_CAP 行、「显示全部」展开；勾选经容器级事件委托生效并更新「已选 N」计数；
// 截断态下保存（collect）不丢未渲染尾部模型。挂载方式与 webui-dom.test.ts 同款
// （happy-dom 全页 + stub fetch），singleFork 共享进程：afterAll 必须还原全部桩。

function scriptBlocks(html: string): string[] {
  const blocks: string[] = []
  const re = /<script>([\s\S]*?)<\/script>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(html))) blocks.push(m[1])
  return blocks
}

const BODY_HTML = UI_HTML.slice(UI_HTML.indexOf('<body>') + 6, UI_HTML.lastIndexOf('</body>')).replace(/<script>[\s\S]*?<\/script>/g, '')
const PAGE_SCRIPT = scriptBlocks(UI_HTML).join('\n')

function modelN(i: number) {
  return { id: `model-${String(i).padStart(3, '0')}`, context_window: 100000 + i, max_output: 4096, capabilities: i % 7 === 0 ? ['vision'] : [], display_name: i % 5 === 0 ? `Display ${i}` : undefined }
}

const MANY = Array.from({ length: 500 }, (_, i) => modelN(i))
// 拉取集与已配模型同 id 但参数不同 → 全部判「可更新」（可勾选），勾选/计数/填入语义才有断言面
const FETCH_MANY = MANY.map((m, i) => ({ ...modelN(i), context_window: 200000 + i }))

const OVERVIEW_FIXTURE = {
  ok: true,
  gateway: { port: 18999, running: true, sandbox: false, home: '/tmp/mdk-dom-fixture', autoRoute: { on: false, failoverOn429: false, autoFallback: true }, autostart: { installed: false } },
  current: null,
  defaultRoute: null,
  services: [
    // 500 模型的服务：编辑弹层 load() 即以截断态渲染
    { id: 'big', label: 'Big 服务', base_url: 'https://big.example.com', protocol: 'anthropic', hasKey: true, modelsCount: 500, defaultModel: 'model-000', fallback: [], inUse: true, isCurrent: true, enabled: true, priority: 0, down: false, usedBy: [], models: MANY },
  ],
  clients: [],
  presets: [],
  knownModels: {},
  sync: null,
  syncRequest: null,
}

const savedBodies: unknown[] = []

function stubFetch(): void {
  const routes: Record<string, () => { body: unknown }> = {
    '/_modeldock/overview': () => ({ body: OVERVIEW_FIXTURE }),
    '/_modeldock/health': () => ({ body: { ok: true } }),
    '/_modeldock/admin/update/status': () => ({ body: { current: '1.0.0', available: false } }),
    '/_modeldock/model-catalog': () => ({ body: { ok: true, models: {} } }),
    '/_modeldock/logs': () => ({ body: { logs: [], total: 0, page: 1, pages: 1 } }),
    '/_modeldock/lan': () => ({ body: { ok: true, enabled: false } }),
    '/_modeldock/service/fetch-models': () => ({ body: { ok: true, from: 'known', models: FETCH_MANY } }),
  }
  vi.stubGlobal('fetch', (url: string, init?: { method?: string; body?: string }) => {
    const p = String(url).split('?')[0]
    if (p === '/_modeldock/service/update' && init?.body) {
      savedBodies.push(JSON.parse(String(init.body)))
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }), text: () => Promise.resolve('{"ok":true}') })
    }
    const hit = routes[p]?.()
    if (!hit) {
      console.warn('[ui-edit-cap] 未配夹具的端点（回退 {ok:true}）:', p)
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }), text: () => Promise.resolve('{"ok":true}') })
    }
    const raw = JSON.stringify(hit.body)
    return Promise.resolve({ ok: true, json: () => Promise.resolve(JSON.parse(raw)), text: () => Promise.resolve(raw) })
  })
}

async function flush(times = 25): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve()
}

function mountPage(): void {
  document.body.innerHTML = BODY_HTML
  new Function(PAGE_SCRIPT)()
}

async function openBigEdit() {
  mountPage()
  await flush()
  savedBodies.length = 0
  ;(document.querySelector('[data-edit="big"]') as HTMLElement)!.click()
  await flush()
}

beforeAll(() => {
  vi.useFakeTimers()
  stubFetch()
})

afterAll(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('PERF-23 编辑弹层渲染上限', () => {
  it('ModelRows：500 模型初始渲染 = 上限 200，显示全部后 = 500；截断态保存不丢尾部', async () => {
    await openBigEdit()
    const rows = () => document.querySelectorAll('#efModelRows .mrow')
    expect(rows().length).toBe(200) // RENDER_CAP（断言具体常量：改上限需同步改此用例）
    const wrap = document.getElementById('efModelMoreWrap') as HTMLElement
    expect(wrap.hidden).toBe(false)
    expect(document.getElementById('efModelMoreN')?.textContent).toContain('200 / 500')
    ;(document.getElementById('efModelMore') as HTMLElement)!.click()
    expect(rows().length).toBe(500)
    expect((document.getElementById('efModelMoreWrap') as HTMLElement).hidden).toBe(true)

    // 截断态数据完整性：重新打开（回到截断态）直接保存，500 条全部在提交体里
    await openBigEdit()
    expect(document.querySelectorAll('#efModelRows .mrow').length).toBe(200)
    ;(document.getElementById('efSave') as HTMLElement)!.click()
    await flush()
    expect(savedBodies.length).toBeGreaterThan(0)
    const body = savedBodies[savedBodies.length - 1] as { models?: Record<string, unknown> }
    expect(Object.keys(body.models ?? {}).length).toBe(500)
    expect(body.models?.['model-499']).toBeTruthy() // 未渲染尾部的最后一行
  })

  it('FetchRows：拉取 500 初始渲染 = 上限，展开后全量；勾选委托生效且更新「已选 N」；搜索自动展开', async () => {
    await openBigEdit()
    ;(document.getElementById('efFetch') as HTMLElement)!.click()
    await flush()
    const frows = () => document.querySelectorAll('#efFetchRows .frow')
    expect(frows().length).toBe(200)
    const wrap = document.getElementById('efFetchMoreWrap') as HTMLElement
    expect(wrap.hidden).toBe(false)

    // 勾选经事件委托生效：click 第 2 行 fpick（默认勾选 → 取消勾选），「已选」计数与表头联动
    const row2 = frows()[1] as HTMLElement
    const cb = row2.querySelector('.fpick') as HTMLInputElement
    expect(cb.checked).toBe(true)
    cb.click()
    expect(cb.checked).toBe(false)
    const sel = document.getElementById('efFetchSel')
    expect(sel?.textContent).toContain('已选')
    // 全选框状态随行勾选变化回写（200 行全勾 → 勾掉 1 → 不再全勾）
    const all = document.getElementById('efFetchAll') as HTMLInputElement
    expect(all.checked).toBe(false)

    // 搜索 = 全表语义：输入过滤词自动展开
    const q = document.getElementById('efFetchQ') as HTMLInputElement
    q.value = 'model-499'
    q.dispatchEvent(new Event('input', { bubbles: true }))
    expect(frows().length).toBe(500)
    const visible = Array.from(frows()).filter((r) => (r as HTMLElement).style.display !== 'none')
    expect(visible.length).toBe(1)
    expect(visible[0].getAttribute('data-id')).toBe('model-499')
    q.value = ''
    q.dispatchEvent(new Event('input', { bubbles: true }))

    // 「显示全部」按钮兜底路径（无搜索场景）
    ;(document.getElementById('efFetchMore') as HTMLElement)!.click()
    expect(frows().length).toBe(500)

    // 填入所选只作用于渲染且勾选的行：取消勾选 1 行后填入 → 499 条参数更新进模型表
    ;(frows()[0].querySelector('.fpick') as HTMLInputElement)!.click()
    ;(document.getElementById('efFetchFill') as HTMLElement)!.click()
    await flush()
    // 填入触发的 renderRows：500 条仍为截断态（未渲染尾部透传保数据），保存时 500 条齐
    ;(document.getElementById('efSave') as HTMLElement)!.click()
    await flush()
    const body = savedBodies[savedBodies.length - 1] as { models?: Record<string, unknown> }
    expect(Object.keys(body.models ?? {}).length).toBe(500)
    // 参数确实被拉取值更新（可更新行填入语义）：未勾的第 0 行保留原值，其余被更新
    expect((body.models?.['model-000'] as { context_window?: number }).context_window).toBe(100000)
    expect((body.models?.['model-001'] as { context_window?: number }).context_window).toBe(200001)
  })
})
