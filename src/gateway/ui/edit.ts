/**
 * Web 控制台 · edit.ts —— 由单文件 ui.ts 按域拆分（T04 Phase 1，行为零变化）。
 * UI_JS_EDIT：编辑弹层：端点/模型/回退块工厂、校验与 openEdit/closeEdit
 * 片段为模板字面量源文本：ui.ts 按原次序拼装后与拆分前逐字节一致；勿改动片段内换行/转义/次序。
 */
export const UI_JS_EDIT = `  var editing = null
  var knownModels = {} // 填模型名时自动补上下文/输出的兜底总表（内置小表 ∪ models.dev 目录懒加载）
  var catalogTable = {} // models.dev 目录大表（/_modeldock/model-catalog 懒加载一次，不进 overview 轮询）

  function bindKeyToggle(inputId, btnId, revealSaved) {
    var input = document.getElementById(inputId)
    var btn = document.getElementById(btnId)
    if (!input || !btn) return
    var setShown = function (shown) {
      input.type = shown ? 'text' : 'password'
      btn.innerHTML = icon(shown ? 'eye-off' : 'eye', 14)
      btn.title = shown ? t('隐藏明文', 'Hide plaintext') : t('显示明文', 'Show plaintext')
    }
    btn.onclick = function () {
      var show = input.type === 'password'
      if (show && revealSaved && input.value === '') {
        // 字段为空 = 服务端没有回传已保存的 Key：点眼睛按需取一次明文填入，供查看/拷贝
        btn.disabled = true
        revealSaved(function (ok) {
          btn.disabled = false
          if (!ok) return
          setShown(true)
          try { input.select() } catch (e) { /* 选中失败不影响显示 */ }
        })
        return
      }
      setShown(show)
    }
  }
  bindKeyToggle('efKey', 'efKeyToggle', function (done) {
    // 编辑壳的提示槽就在左下角：可见 Key 失败别用 toast（会被弹层磨砂遮罩糊住）
    var msg = testlineWriter('efMsg')
    api('/service/reveal-key', { method: 'POST', body: JSON.stringify({ id: editing }) })
      .then(function (r) {
        if (r && r.key) { $('#efKey').value = r.key; done(true) }
        else { msg(t('未能读取已保存的 Key（可能未设置，或系统安全后端拒绝访问）', 'Could not read the saved key (not set, or the OS secure backend refused)'), 'err'); done(false) }
      })
      .catch(function (e) { msg(t('读取 Key 失败：', 'Failed to read key: ') + e.message, 'err'); done(false) })
  })
  bindKeyToggle('afKey', 'afKeyToggle')
  bindKeyToggle('pkgPw', 'pkgPwToggle')

  // 服务表单公共块（添加/编辑两壳共用的一份实现）
  // 三个块：端点(EndpointBlock) / 模型目录+拉取面板(ModelBlock) / 故障切换顺序(FallbackBlock)。
  // HTML 由块生成：文案带 data-i18n（applyLang 的全局扫描会随语言切换刷新），生成时 applyI18nTree 立即生效；
  // 事件全部委托在块根上，load() 重写 innerHTML 不丢监听。两壳各自实例化（id 前缀 ef*/af*），
  // 壳只保留真正差异：装载来源（预设/已有服务）、Key 语义、提交端点。
  function applyI18nTree(root) {
    Array.prototype.forEach.call(root.querySelectorAll('[data-i18n]'), function (el) { setI18nText(el, i18nPick(el.getAttribute('data-i18n'))) })
    Array.prototype.forEach.call(root.querySelectorAll('[data-i18n-ph]'), function (el) { el.setAttribute('placeholder', i18nPick(el.getAttribute('data-i18n-ph'))) })
    Array.prototype.forEach.call(root.querySelectorAll('[data-i18n-title]'), function (el) { el.setAttribute('title', i18nPick(el.getAttribute('data-i18n-title'))) })
    Array.prototype.forEach.call(root.querySelectorAll('[data-i18n-tip]'), function (el) { el.setAttribute('data-tip', i18nPick(el.getAttribute('data-i18n-tip'))) })
    Array.prototype.forEach.call(root.querySelectorAll('[data-i18n-aria]'), function (el) { el.setAttribute('aria-label', i18nPick(el.getAttribute('data-i18n-aria'))) })
  }
  // tokens 输入解析：容忍千分位逗号 / 空格 / 下划线（如 200,000 或 128 000），
  // 仍为数字则返回 number，空返回 null，含非数字字符返回 NaN（保存时提示）
  // 注意：UI_HTML 是 JS 模板字符串，正则里的反斜杠必须双写（\\d、\\s），
  // 否则会被当转义序列吞掉（\d→d、\s→s），导致前端校验静默失效。
  function parseTokens(s) {
    s = String(s == null ? '' : s).trim().replace(/[,\\s_]/g, '')
    return s === '' ? null : (/^\\d+$/.test(s) ? Number(s) : NaN)
  }

  function createEndpointBlock(hostId, prefix) {
    var root = document.getElementById(hostId)
    var st = { docsHtml: '' }
    var gid = function (s) { return prefix + s }
    function html() {
      // 三协议各一行、预设与自定义同构：厂商支持哪个就填哪行，不再有「默认协议」下拉；
      // 哪行落 base_url 由 collect 推导（anthropic > openai > responses），对用户不可见
      return '<div class="egrid">' +
        '<label><span data-i18n="显示名称||Display name">显示名称</span><input type="text" id="' + gid('Name') + '"></label>' +
        '<label><span data-i18n="Anthropic 接口||Anthropic endpoint">Anthropic 接口</span><input type="text" id="' + gid('EndAnthropic') + '" data-i18n-ph="照抄厂商文档，留空 = 不用||copy from vendor docs, empty = unused" placeholder="照抄厂商文档，留空 = 不用"></label>' +
        '</div>' +
        '<div class="egrid">' +
        '<label><span data-i18n="OpenAI 接口 (/v1)||OpenAI endpoint (/v1)">OpenAI 接口 (/v1)</span><input type="text" id="' + gid('EndOpenai') + '" data-i18n-ph="照抄厂商文档，留空 = 不用||copy from vendor docs, empty = unused" placeholder="照抄厂商文档，留空 = 不用"></label>' +
        '<label><span data-i18n="Responses 接口 (/responses)||Responses endpoint (/responses)">Responses 接口 (/responses)</span><input type="text" id="' + gid('EndResponses') + '" data-i18n-ph="照抄厂商文档，留空 = 不用||copy from vendor docs, empty = unused" placeholder="照抄厂商文档，留空 = 不用"></label>' +
        '</div>' +
        '<p class="desc-sm"><span data-i18n="厂商支持哪个协议就填哪行（至少一行）；地址末尾的 /v1、/v3 是厂商自定的版本号，照抄厂商文档即可；Codex 只认 Responses。||Fill in the rows for the protocols your vendor supports (at least one); /v1 and /v3 suffixes are vendor-defined API versions — copy from the docs; Codex speaks Responses only.">厂商支持哪个协议就填哪行（至少一行）；地址末尾的 /v1、/v3 是厂商自定的版本号，照抄厂商文档即可；Codex 只认 Responses。</span>' + (st.docsHtml ? ' ' + st.docsHtml : '') + '</p>'
    }
    function load(o) {
      // o = { name, namePlaceholder, baseUrl, protocol, endpoints, docsHtml }
      st.docsHtml = o.docsHtml || ''
      root.innerHTML = html()
      var nameEl = $('#' + gid('Name'))
      nameEl.value = o.name || ''
      // 占位符随场景变化（预设=留空用厂商默认名；自定义=起名示例），带 data-i18n-ph 让语言切换跟随
      if (o.namePlaceholder) { nameEl.setAttribute('placeholder', i18nPick(o.namePlaceholder)); nameEl.setAttribute('data-i18n-ph', o.namePlaceholder) }
      // 三行协议地址：endpoints 优先，默认协议那行回落 base_url（base_url 即默认协议端点）。
      // 刻意不做厂商预设回填：空行 = 用户显式不用该协议（尤其编辑场景，回填会让删掉的地址复活）
      var proto = o.protocol || 'openai'
      var ep = o.endpoints || {}
      var rows = {
        anthropic: ep.anthropic || (proto === 'anthropic' ? o.baseUrl || '' : ''),
        openai: ep.openai || (proto === 'openai' ? o.baseUrl || '' : ''),
        responses: ep.responses || (proto === 'responses' ? o.baseUrl || '' : ''),
      }
      $('#' + gid('EndAnthropic')).value = rows.anthropic
      $('#' + gid('EndOpenai')).value = rows.openai
      $('#' + gid('EndResponses')).value = rows.responses
      applyI18nTree(root)
    }
    function collect() {
      // 至少一行有值 → 默认协议取 anthropic > openai > responses 里第一个填写的（与本网关主力客户端同序）；
      // 默认协议那行落 base_url，其余填写的行进 endpoints（同一地址不重复存）
      var urls = {
        anthropic: $('#' + gid('EndAnthropic')).value.trim(),
        openai: $('#' + gid('EndOpenai')).value.trim(),
        responses: $('#' + gid('EndResponses')).value.trim(),
      }
      var protocol = urls.anthropic ? 'anthropic' : urls.openai ? 'openai' : 'responses'
      var endpoints = {}
      for (var k in urls) if (urls[k] && k !== protocol) endpoints[k] = urls[k]
      return { name: $('#' + gid('Name')).value.trim(), url: urls[protocol], protocol: protocol, endpoints: endpoints, urls: urls }
    }
    return { load: load, collect: collect, el: root }
  }

  function createModelBlock(hostId, prefix, opts) {
    var root = document.getElementById(hostId)
    // dirty=用户动过模型目录（增删/改数/拉取填入）；defaultDirty=点过 ★ 或默认行被删。
    // 编辑保存只认 defaultDirty（旧行为）；添加保存认 dirty（未动过就不带 models，保留服务端预设合并+在线拉取）。
    var st = { defaultModel: '', defaultDirty: false, dirty: false }
    var gid = function (s) { return prefix + s }
    function rowsHost() { return document.getElementById(gid('ModelRows')) }
    function rowHtml(m) {
      var vision = (m.capabilities || []).indexOf('vision') >= 0
      // 显示名副行：仅当存在且与 ID 不同（忽略大小写/空格）才渲染，避免同一字符串出现两遍
      var dn = m.display_name && String(m.display_name).trim().toLowerCase() !== String(m.id).trim().toLowerCase() ? String(m.display_name).trim() : ''
      return '<div class="mrow">' +
        '<button class="def' + (m.id === st.defaultModel ? ' on' : '') + '" type="button" title="' + t('设为默认', 'Set as default') + '" data-mid="' + esc(m.id) + '">' + icon('star', 13) + '</button>' +
        '<div class="midwrap"><span class="mid" title="' + esc(m.id) + '">' + esc(m.id) + '</span>' + (dn ? '<span class="msub" title="' + esc(dn) + '">' + esc(dn) + '</span>' : '') + '</div>' +
        '<input type="text" inputmode="numeric" data-f="context_window" value="' + (m.context_window == null ? '' : esc(m.context_window)) + '" placeholder="' + t('未知', 'unknown') + '">' +
        '<input type="text" inputmode="numeric" data-f="max_output" value="' + (m.max_output == null ? '' : esc(m.max_output)) + '" placeholder="' + t('未知', 'unknown') + '">' +
        '<input type="checkbox" class="vpick" data-f="vision"' + (vision ? ' checked' : '') + ' title="' + t('该模型支持图片输入（接入客户端会据此声明）', 'This model accepts image input (attached clients are told so)') + '">' +
        '<button class="del" type="button" title="' + t('删除该模型', 'Delete this model') + '">' + icon('close', 12) + '</button></div>'
    }
    function renderRows(models) {
      var el = rowsHost()
      if (!models.length) {
        el.innerHTML = '<div class="mempty">' + t('暂无模型。在下方输入模型 ID 添加；保存后即可在「测速」和新建路由时使用。', 'No models yet. Add a model ID below; saved models appear in speed tests and new routes.') + '</div>'
        return
      }
      el.innerHTML = models.map(rowHtml).join('')
    }
    function load(models, defaultModel) {
      st.defaultModel = defaultModel || ''
      st.defaultDirty = false
      st.dirty = false
      root.innerHTML = html()
      renderRows(models || [])
      applyI18nTree(root)
    }
    function rowsArray() {
      var arr = []
      Array.prototype.forEach.call(root.querySelectorAll('#' + gid('ModelRows') + ' .mrow'), function (row) {
        var mid = row.querySelector('.mid').textContent.trim()
        if (!mid) return
        // 上下文/输出保留输入框原文（可为空字符串），回显原样、保存时才统一解析校验
        // 显示名随行携带：拉取填入等重绘路径把 arr 回传 rowHtml 时副行不丢
        // row 一并带出：拉取面板比差异时要读同行的视觉勾选态
        var sub = row.querySelector('.msub')
        arr.push({
          id: mid,
          context_window: row.querySelector('[data-f="context_window"]').value.trim(),
          max_output: row.querySelector('[data-f="max_output"]').value.trim(),
          display_name: sub ? sub.textContent.trim() : '',
          row: row,
        })
      })
      return arr
    }
    function collect() {
      var out = {}
      var dup = false
      Array.prototype.forEach.call(root.querySelectorAll('#' + gid('ModelRows') + ' .mrow'), function (row) {
        var mid = row.querySelector('.mid').textContent.trim()
        if (!mid) return
        if (out[mid]) { dup = true; return }
        var rec = {}
        var ctx = parseTokens(row.querySelector('[data-f="context_window"]').value)
        var mo = parseTokens(row.querySelector('[data-f="max_output"]').value)
        if (ctx !== null) rec.context_window = ctx
        if (mo !== null) rec.max_output = mo
        // 视觉是可选能力：整列勾选状态即权威值（未勾=空数组，服务端据此清掉旧标记）
        var vp = row.querySelector('[data-f="vision"]')
        rec.capabilities = vp && vp.checked ? ['vision'] : []
        // 显示名只随副行走（渲染时已按「与 ID 不同」去重）；缺失不提交，服务端保留既有
        var dnEl = row.querySelector('.msub')
        if (dnEl && dnEl.textContent.trim()) rec.display_name = dnEl.textContent.trim()
        out[mid] = rec
      })
      // 新增行：仅当输入框里的 id 尚未在列表中时才算新增；
      // 若已存在（含刚点“添加”后输入框残留同一 id 的情况）则跳过，避免误判重复
      var nid = $('#' + gid('NewId')).value.trim()
      if (nid && !out[nid]) {
        var rec2 = {}
        var ctx2 = parseTokens($('#' + gid('NewCtx')).value)
        var mo2 = parseTokens($('#' + gid('NewOut')).value)
        if (ctx2 !== null) rec2.context_window = ctx2
        if (mo2 !== null) rec2.max_output = mo2
        var nv = $('#' + gid('NewVision'))
        rec2.capabilities = nv && nv.checked ? ['vision'] : []
        out[nid] = rec2
      }
      return { models: out, dup: dup }
    }
    function syncDefButtons(mid) {
      root.querySelectorAll('.def').forEach(function (b) {
        var on = b.getAttribute('data-mid') === mid
        b.classList.toggle('on', on)
        b.innerHTML = icon('star', 13)
      })
    }
    function visibleFetchRows() {
      return Array.prototype.filter.call(root.querySelectorAll('#' + gid('FetchRows') + ' .frow'), function (row) {
        return row.style.display !== 'none'
      })
    }
    function syncFetchAll() {
      var rows = visibleFetchRows().filter(function (row) { return !row.querySelector('.fpick').disabled })
      var checked = rows.filter(function (row) { return row.querySelector('.fpick').checked })
      document.getElementById(gid('FetchAll')).checked = rows.length > 0 && checked.length === rows.length
    }
    function applyFetchFilter() {
      var q = document.getElementById(gid('FetchQ')).value.trim().toLowerCase()
      var visible = 0
      Array.prototype.forEach.call(root.querySelectorAll('#' + gid('FetchRows') + ' .frow'), function (row) {
        var mid = row.getAttribute('data-id') || ''
        var show = !q || mid.toLowerCase().indexOf(q) >= 0
        row.style.display = show ? '' : 'none'
        if (show) visible++
      })
      document.getElementById(gid('FetchEmpty')).hidden = visible > 0
      var total = root.querySelectorAll('#' + gid('FetchRows') + ' .frow').length
      document.getElementById(gid('FetchCount')).textContent = q ? visible + ' / ' + total : ''
      syncFetchAll()
    }
    // 拉取行与列表已有行的差异判定（口径）：上下文 / 最大输出按值比（都空算相同），
    // 视觉只在「拉取侧有、列表侧没勾」时算差异——上游多数不报能力，不能反推要清空用户已勾的。
    function diffRow(ex, m, vision) {
      var cw = m.context_window == null ? '' : String(m.context_window)
      var mo = m.max_output == null ? '' : String(m.max_output)
      if (String(ex.context_window || '') !== cw || String(ex.max_output || '') !== mo) return true
      var vp = ex.row.querySelector('[data-f="vision"]')
      return !!vision && !(vp && vp.checked)
    }
    function renderFetch(models) {
      var have = {}
      rowsArray().forEach(function (m) { have[m.id] = m })
      var pickable = 0
      var rows = (models || []).map(function (m) {
        var ex = have[m.id]
        // 三态：新条目=默认勾选；已有且参数一致=「已有」禁用；已有但参数不同=「可更新」默认勾选
        var diff = ex ? diffRow(ex, m) : false
        var same = !!ex && !diff
        if (!same) pickable++
        var vision = (m.capabilities || []).indexOf('vision') >= 0
        // 去重规则同 rowHtml；名字存 data-display，「填入所选」随行带上
        var dn = m.display && String(m.display).trim().toLowerCase() !== String(m.id).trim().toLowerCase() ? String(m.display).trim() : ''
        var dis = same ? ' disabled' : ''
        return '<div class="mrow frow' + (same ? ' dis' : '') + '" data-id="' + esc(m.id) + '"' + (dn ? ' data-display="' + esc(dn) + '"' : '') + '>' +
          // title 文案经 esc() 且右引号不可省：英文文案含双引号，属性漏闭合会把整行后续标签吞进属性（曾致「已有」行 DOM 错乱）
          '<input type="checkbox" class="fpick"' + (same ? ' disabled title="' + esc(t('已在下方模型列表且参数一致，不重复填入', 'Already in the model list with the same numbers')) + '"' : ' checked' + (diff ? ' title="' + esc(t('点「填入所选」把拉取到的参数更新到下方该模型', 'Click "Fill selected" to update this model with the fetched numbers')) + '"' : '')) + '>' +
          '<div class="midwrap"><span class="mid" title="' + esc(m.id) + '">' + esc(m.id) + '</span>' + (dn ? '<span class="msub" title="' + esc(dn) + '">' + esc(dn) + '</span>' : '') + '</div>' +
          '<input type="text" inputmode="numeric" data-f="context_window" value="' + (m.context_window == null ? '' : esc(m.context_window)) + '" placeholder="' + t('未知', 'unknown') + '"' + dis + '>' +
          '<input type="text" inputmode="numeric" data-f="max_output" value="' + (m.max_output == null ? '' : esc(m.max_output)) + '" placeholder="' + t('未知', 'unknown') + '"' + dis + '>' +
          '<input type="checkbox" class="vpick" data-f="vision"' + (vision ? ' checked' : '') + dis + '>' +
          '<span class="ftag">' + (same ? t('已有', 'exists') : diff ? t('可更新', 'update') : '') + '</span></div>'
      }).join('')
      document.getElementById(gid('FetchRows')).innerHTML = rows || '<div class="mempty">' + t('未拉取到模型', 'No models fetched') + '</div>'
      document.getElementById(gid('FetchAll')).checked = pickable > 0 && pickable === (models || []).length
    }
    // 填入语义：列表里没有的模型追加；已有的按拉取到的参数就地更新（勾选行即权威值，
    // 视觉列在行内可改；留空表示不覆盖，避免上游没给值时清掉用户手填的数字）
    function fillSelected() {
      var arr = rowsArray()
      var at = {}
      arr.forEach(function (m) { at[m.id] = m })
      var added = 0, updated = 0
      Array.prototype.forEach.call(root.querySelectorAll('#' + gid('FetchRows') + ' .frow'), function (row) {
        var cb = row.querySelector('.fpick')
        if (!cb || !cb.checked || cb.disabled) return
        var mid = row.getAttribute('data-id')
        if (!mid) return
        var cw = parseTokens(row.querySelector('[data-f="context_window"]').value)
        var mo = parseTokens(row.querySelector('[data-f="max_output"]').value)
        var vp = row.querySelector('[data-f="vision"]')
        var dn = row.getAttribute('data-display')
        var ex = at[mid]
        if (ex) {
          // 已有条目：拉取到的非空值覆盖，留空 = 保留既有值（不清空）；只有真的改了才计入「更新 N」
          var changed = false
          if (cw != null && !isNaN(cw) && String(cw) !== ex.context_window) { ex.context_window = cw; changed = true }
          if (mo != null && !isNaN(mo) && String(mo) !== ex.max_output) { ex.max_output = mo; changed = true }
          if (vp && vp.checked && (ex.capabilities || []).indexOf('vision') < 0) { ex.capabilities = ['vision']; changed = true }
          if (!ex.display_name && dn) ex.display_name = dn
          if (changed) updated++
          return
        }
        var rec = {
          id: mid,
          context_window: cw != null && !isNaN(cw) ? cw : null,
          max_output: mo != null && !isNaN(mo) ? mo : null,
          capabilities: vp && vp.checked ? ['vision'] : [],
        }
        if (dn) rec.display_name = dn
        arr.push(rec)
        at[mid] = rec
        added++
      })
      renderRows(arr)
      document.getElementById(gid('FetchPanel')).hidden = true
      st.dirty = true
      var parts = []
      if (added) parts.push(t('新增 ', 'Added ') + added + t(' 个', ''))
      if (updated) parts.push(t('更新 ', 'Updated ') + updated + t(' 个', ''))
      // 结果写弹层左下角的提示槽（.modal-foot 的 msg 槽）：弹层有毛玻璃遮罩，toast 会被糊住看不见
      if (parts.length) opts.msg(t('已 ', '') + parts.join(t('、', ', ')) + t('；点「保存」后生效', '; click "Save" to apply'), 'ok')
    }
    function doFetch(btn) {
      var ctx = opts.fetchCtx ? opts.fetchCtx() : null
      // 拉取面板/表单挂在弹层（或首用内联卡）里：失败一律写底栏就地提示槽——
      // 弹窗磨砂遮罩（z-modal）会糊掉全局 toast（z-toast），两个宿主的槽位都常驻可见（AGENTS 弹层提示归宿）
      var fail = function (text) { opts.msg(text, 'err') }
      if (!ctx || !ctx.baseUrl || !/^https?:\\/\\//i.test(ctx.baseUrl)) { fail(t('请先填写接口地址（http/https）再拉取模型', 'Fill in the base URL (http/https) before fetching models')); return }
      btn.disabled = true; btn.textContent = t('拉取中…', 'Fetching…')
      var body = { base_url: ctx.baseUrl, protocol: ctx.protocol || 'anthropic' }
      if (ctx.serviceId) body.id = ctx.serviceId
      if (ctx.key) body.key = ctx.key // 手输了 Key 就用手输的（可能正准备保存新 Key）
      api('/service/fetch-models', { method: 'POST', body: JSON.stringify(body), timeoutMs: 90000 })
        .then(function (r) {
          document.getElementById(gid('FetchQ')).value = '' // 重新拉取是新的列表，旧过滤词不再适用
          document.getElementById(gid('FetchCount')).textContent = ''
          renderFetch(r.models || [])
          var panel = document.getElementById(gid('FetchPanel'))
          panel.hidden = false
          opts.msg('') // 面板自带结果提示，清掉底栏上一次的报错
          $('#' + gid('FetchMsg')).textContent = r.from === 'known'
            ? t('在线拉取未成功，以下为该厂商已知模型；勾选需要的后点「填入所选」', 'Online fetch failed; these are known models for this vendor. Tick the ones you want, then click "Fill selected"')
            : t('共 ', 'Fetched ') + (r.models || []).length + t(' 个模型，勾选需要的后点「填入所选」（参数一致的自动跳过）', ' models. Tick the ones you want, then click "Fill selected" (entries with identical numbers are skipped)')
          panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
        })
        .catch(function (e) { fail(t('拉取失败：', 'Fetch failed: ') + e.message) })
        .then(function () { btn.disabled = false; btn.textContent = t('拉取模型', 'Fetch models') })
    }
    function html() {
      return '<div class="fsec-row">' +
        '<label class="fsec" data-i18n="模型（上下文 / 最大输出，单位 tokens，可留空）||Models (context / max output in tokens; optional)">模型（上下文 / 最大输出，单位 tokens，可留空）</label>' +
        '<button class="btn small" type="button" id="' + gid('Fetch') + '" data-i18n-title="从上游拉取模型列表，勾选需要的填入下方||Fetch the model list from upstream, then tick the ones to add below" title="从上游拉取模型列表，勾选需要的填入下方" data-i18n="拉取模型||Fetch models">拉取模型</button>' +
        '</div>' +
        '<div class="mtable">' +
        '<div class="mhead"><span class="defcol" title="设为默认">' + icon('star', 11) + '</span><span data-i18n="模型 ID||Model ID">模型 ID</span><span data-i18n="上下文||Context">上下文</span><span data-i18n="最大输出||Max output">最大输出</span><span class="vcol" data-i18n="视觉||Vision">视觉</span><span></span></div>' +
        '<div id="' + gid('ModelRows') + '"></div>' +
        '<div class="addrow">' +
        '<span class="def-slot"></span>' +
        '<input type="text" id="' + gid('NewId') + '" data-i18n-ph="新模型 ID，如 deepseek-flash||new model ID, e.g. deepseek-flash" placeholder="新模型 ID，如 deepseek-flash">' +
        '<input type="text" class="num" id="' + gid('NewCtx') + '" data-i18n-ph="上下文||context" placeholder="上下文">' +
        '<input type="text" class="num" id="' + gid('NewOut') + '" data-i18n-ph="最大输出||max output" placeholder="最大输出">' +
        '<input type="checkbox" class="vpick" id="' + gid('NewVision') + '" data-i18n-title="该模型支持图片输入（接入客户端会据此声明）||This model accepts image input (attached clients are told so)" title="该模型支持图片输入（接入客户端会据此声明）">' +
        '<button class="btn small" type="button" id="' + gid('AddModel') + '" data-i18n="添加||Add">添加</button>' +
        '</div>' +
        '</div>' +
        '<div class="fetchpanel" id="' + gid('FetchPanel') + '" hidden>' +
        '<div class="fsearch">' +
        '<input type="text" class="fetchq" id="' + gid('FetchQ') + '" data-i18n-ph="搜索模型 ID，如 claude / deepseek…||Search model ID, e.g. claude / deepseek…" placeholder="搜索模型 ID，如 claude / deepseek…">' +
        '<span class="fetchcount" id="' + gid('FetchCount') + '"></span></div>' +
        '<div class="mhead"><input type="checkbox" id="' + gid('FetchAll') + '" data-i18n-title="全选 / 全不选（仅作用于当前可见行）||Select all / none (visible rows only)" title="全选 / 全不选（仅作用于当前可见行）"><span data-i18n="拉取到的模型（勾选后填入）||Fetched models (tick to fill in)">拉取到的模型（勾选后填入）</span><span data-i18n="上下文||Context">上下文</span><span data-i18n="最大输出||Max output">最大输出</span><span class="vcol" data-i18n="视觉||Vision">视觉</span><span></span></div>' +
        '<div id="' + gid('FetchRows') + '"></div>' +
        '<div class="mempty" id="' + gid('FetchEmpty') + '" data-i18n="没有匹配的模型||No matching models" hidden>没有匹配的模型</div>' +
        '<div class="factions">' +
        '<span class="fetchmsg" id="' + gid('FetchMsg') + '"></span>' +
        '<button class="btn small" type="button" id="' + gid('FetchHide') + '" data-i18n="收起||Hide">收起</button>' +
        '<button class="btn small primary" type="button" id="' + gid('FetchFill') + '" data-i18n="填入所选||Fill selected">填入所选</button>' +
        '</div></div>'
    }
    // 按钮内容是 SVG 图标：点击命中的可能是按钮内的 <svg>/<path> 子元素，须经 closest 找到按钮本体再判断
    root.addEventListener('click', function (e) {
      var tg = e.target
      if (!tg || !tg.closest) return
      var defBtn = tg.closest('.def')
      if (defBtn) {
        st.defaultModel = defBtn.getAttribute('data-mid')
        st.defaultDirty = true
        syncDefButtons(st.defaultModel)
        return
      }
      var delBtn = tg.closest('.del')
      if (delBtn) {
        var r = delBtn.closest('.mrow'); if (!r) return
        // 删除的是默认模型 → 默认自动改为剩余第一行
        var wasDefault = !!st.defaultModel && r.querySelector('.def') && r.querySelector('.def').getAttribute('data-mid') === st.defaultModel
        r.remove()
        if (wasDefault) {
          var firstMid = rowsHost().querySelector('.mrow .mid')
          st.defaultModel = firstMid ? firstMid.textContent.trim() : ''
          st.defaultDirty = true
          syncDefButtons(st.defaultModel)
        }
        st.dirty = true
        return
      }
      if (tg.id === gid('AddModel')) {
        var nid = $('#' + gid('NewId')).value.trim()
        if (!nid) { opts.msg(t('请先填写新模型的 ID', 'Enter the new model ID first'), 'err'); return }
        var exist = false
        Array.prototype.forEach.call(root.querySelectorAll('#' + gid('ModelRows') + ' .mid'), function (el) {
          if (el.textContent.trim() === nid) exist = true
        })
        if (exist) { opts.msg(t('模型「', 'Model "') + nid + t('」已在列表里', '" is already in the list'), 'err'); return }
        var host = rowsHost()
        if (host.querySelector('.mempty')) host.innerHTML = ''
        var wrap = document.createElement('div')
        var nvBox = $('#' + gid('NewVision'))
        wrap.innerHTML = rowHtml({ id: nid, context_window: $('#' + gid('NewCtx')).value.trim(), max_output: $('#' + gid('NewOut')).value.trim(), capabilities: nvBox && nvBox.checked ? ['vision'] : [] })
        var row = wrap.firstChild
        host.appendChild(row)
        row.scrollIntoView({ block: 'nearest' })
        $('#' + gid('NewId')).value = ''
        $('#' + gid('NewCtx')).value = ''
        $('#' + gid('NewOut')).value = ''
        if (nvBox) nvBox.checked = false
        opts.msg('', '')
        st.dirty = true
        return
      }
      if (tg.id === gid('Fetch')) { doFetch(tg); return }
      if (tg.id === gid('FetchHide')) { document.getElementById(gid('FetchPanel')).hidden = true; return }
      if (tg.id === gid('FetchFill')) { fillSelected(); return }
    })
    // 输模型名：从已知模型表自动补上下文 / 输出（仅在对应框为空时填充，不覆盖手输）
    root.addEventListener('input', function (e) {
      var tg = e.target
      if (!tg || !tg.getAttribute) return
      if (tg.getAttribute('data-f')) st.dirty = true
      if (tg.id === gid('NewId')) {
        // 手填模型名即算动过目录：保存必带 models（服务端不再自动拉取），没点「添加」按钮也不丢用户输入
        st.dirty = true
        var km = knownModels[tg.value.trim()]
        if (km) {
          var ctx = $('#' + gid('NewCtx')), out = $('#' + gid('NewOut'))
          if (km.context_window != null && ctx.value === '') ctx.value = km.context_window
          if (km.max_output != null && out.value === '') out.value = km.max_output
          // 内置表已知该模型支持图片 → 顺手勾上视觉（用户仍可改；只在当前未勾时补）
          var nv = $('#' + gid('NewVision'))
          if (nv && !nv.checked && (km.capabilities || []).indexOf('vision') >= 0) nv.checked = true
        }
      }
      if (tg.id === gid('FetchQ')) applyFetchFilter()
    })
    root.addEventListener('change', function (e) {
      var tg = e.target
      if (!tg || !tg.classList) return
      // 搜索过滤只控制行显隐，勾选状态保留；全选仅作用于当前可见且可勾选的行
      //（否则搜索后点全选会把藏在过滤外的模型一并选进去），行勾选变化时回写表头状态
      if (tg.classList.contains('fpick')) { syncFetchAll(); return }
      if (tg.id === gid('FetchAll')) {
        var on = tg.checked
        visibleFetchRows().forEach(function (row) {
          var cb = row.querySelector('.fpick')
          if (cb && !cb.disabled) cb.checked = on
        })
      }
    })
    return {
      load: load, collect: collect,
      isDirty: function () { return st.dirty || st.defaultDirty },
      isDefaultDirty: function () { return st.defaultDirty },
      getDefault: function () { return st.defaultModel },
      el: root,
    }
  }

  function createFallbackBlock(hostId, prefix, opts) {
    var root = document.getElementById(hostId)
    var gid = function (s) { return prefix + s }
    function fbRowHtml(providerId, model) {
      var svc = null
      ;(opts.getServices() || []).forEach(function (x) { if (x.id === providerId) svc = x })
      var label = svc ? svc.label : providerId
      return '<div class="mrow fbrow" data-provider="' + esc(providerId) + '" data-model="' + esc(model || '') + '">' +
        '<span class="mid" title="' + esc(providerId) + '">' + esc(label) + '</span>' +
        '<span class="mid">' + esc(model || t('透传原模型名', 'Pass through original model')) + '</span>' +
        '<span class="fbops">' +
        '<button type="button" class="fbup" title="' + t('上移', 'Move up') + '">' + icon('arrow-up', 13) + '</button>' +
        '<button type="button" class="fbdown" title="' + t('下移', 'Move down') + '">' + icon('arrow-down', 13) + '</button>' +
        '<button type="button" class="del" title="' + t('移除', 'Remove') + '">' + icon('close', 12) + '</button></span></div>'
    }
    function html() {
      return '<div class="fsec-row">' +
        '<label class="fsec" data-i18n="故障切换顺序（主服务不可达时依次尝试）||Fallback order (tried in order when the primary is unreachable)">故障切换顺序（主服务不可达时依次尝试）</label>' +
        '<button class="btn small" type="button" id="' + gid('FbAuto') + '" data-i18n-title="把所有启用中的其他服务按优先级排入备用链，模型取各自的默认模型||Queue all other enabled services into the fallback chain by priority, each using its default model" title="把所有启用中的其他服务按优先级排入备用链，模型取各自的默认模型" data-i18n="按优先级自动生成||Auto-generate by priority">按优先级自动生成</button>' +
        '</div>' +
        '<div class="mtable fbtable">' +
        '<div class="mhead"><span data-i18n="备用服务||Fallback service">备用服务</span><span data-i18n="使用的模型||Model used">使用的模型</span><span></span></div>' +
        '<div id="' + gid('FbRows') + '"></div>' +
        '<div class="addrow">' +
        '<select id="' + gid('FbNewSvc') + '"></select>' +
        '<select id="' + gid('FbNewModel') + '"></select>' +
        '<button class="btn small" type="button" id="' + gid('FbAdd') + '" data-i18n="添加||Add">添加</button>' +
        '</div></div>'
    }
    function renderRows(rows) {
      document.getElementById(gid('FbRows')).innerHTML = (rows || []).map(function (f) { return fbRowHtml(f.provider, f.model || '') }).join('') ||
        '<div class="mempty">' + t('暂无备用服务——主服务不可达时将没有可切换的目标。', 'No fallback services yet — if the primary goes down there will be nothing to switch to.') + '</div>'
    }
    // 新增行下拉：排除自身与已在链中的服务；模型下拉随服务联动（默认=透传原模型名）
    function populateAdd() {
      var svcSel = document.getElementById(gid('FbNewSvc'))
      if (!svcSel) return
      var added = {}
      Array.prototype.forEach.call(root.querySelectorAll('#' + gid('FbRows') + ' .fbrow'), function (r) {
        added[r.getAttribute('data-provider')] = true
      })
      var selfId = opts.getSelfId ? opts.getSelfId() : null
      var svcOpts = '<option value="">' + t('选择服务…', 'Pick a service…') + '</option>'
      ;(opts.getServices() || []).forEach(function (x) {
        if (x.id === selfId || added[x.id]) return
        svcOpts += '<option value="' + esc(x.id) + '">' + esc(x.label) + '</option>'
      })
      svcSel.innerHTML = svcOpts
      populateModels()
    }
    function populateModels() {
      var svcSel = document.getElementById(gid('FbNewSvc'))
      var modelSel = document.getElementById(gid('FbNewModel'))
      if (!svcSel || !modelSel) return
      var svc = null
      ;(opts.getServices() || []).forEach(function (x) { if (x.id === svcSel.value) svc = x })
      // 新增行默认「透传原模型名」（value=''），不自动选中服务的默认模型；具体模型由用户主动改选
      var modelOpts = '<option value="">' + t('透传原模型名', 'Pass through original model') + '</option>'
      if (svc) {
        (svc.models || []).forEach(function (m) {
          modelOpts += '<option value="' + esc(m.id) + '">' + esc(m.id) + '</option>'
        })
      }
      modelSel.innerHTML = modelOpts
    }
    function load(rows) {
      root.innerHTML = html()
      renderRows(rows || [])
      populateAdd()
      applyI18nTree(root)
    }
    function collect() {
      var out = []
      Array.prototype.forEach.call(root.querySelectorAll('#' + gid('FbRows') + ' .fbrow'), function (r) {
        var p = r.getAttribute('data-provider')
        if (!p) return
        var m = r.getAttribute('data-model')
        out.push(m ? p + ':' + m : p)
      })
      return out
    }
    root.addEventListener('click', function (e) {
      var tg = e.target
      if (!tg || !tg.classList) return
      if (tg.id === gid('FbAuto')) {
        var selfId = opts.getSelfId ? opts.getSelfId() : null
        var rows = (opts.getServices() || [])
          .filter(function (x) { return x.id !== selfId && x.enabled !== false })
          .sort(function (a, b) { return (b.priority || 0) - (a.priority || 0) })
        document.getElementById(gid('FbRows')).innerHTML = rows.map(function (x) { return fbRowHtml(x.id, x.defaultModel || '') }).join('') ||
          '<div class="mempty">' + t('没有其他可用服务。', 'No other enabled services.') + '</div>'
        populateAdd()
        opts.msg('', '')
        return
      }
      if (tg.id === gid('FbAdd')) {
        var svcId = document.getElementById(gid('FbNewSvc')).value
        if (!svcId) { opts.msg(t('请先选择要追加的备用服务', 'Pick a fallback service first'), 'err'); return }
        var model = document.getElementById(gid('FbNewModel')).value
        var el = document.getElementById(gid('FbRows'))
        if (el.querySelector('.mempty')) el.innerHTML = ''
        el.insertAdjacentHTML('beforeend', fbRowHtml(svcId, model))
        populateAdd()
        opts.msg('', '')
        return
      }
      var r = tg.closest('.fbrow')
      if (!r) return
      if (tg.closest('.del')) { r.remove(); populateAdd(); return }
      var upBtn = tg.closest('.fbup'), downBtn = tg.closest('.fbdown')
      if (upBtn || downBtn) {
        var rowsEl = document.getElementById(gid('FbRows'))
        var arr = Array.prototype.slice.call(rowsEl.querySelectorAll('.fbrow'))
        var i = arr.indexOf(r)
        var j = upBtn ? i - 1 : i + 1
        if (j < 0 || j >= arr.length) return
        if (j < i) rowsEl.insertBefore(r, arr[j])
        else rowsEl.insertBefore(arr[j], r)
      }
    })
    root.addEventListener('change', function (e) {
      if (e.target && e.target.id === gid('FbNewSvc')) populateModels()
    })
    return { load: load, collect: collect, el: root }
  }

  // 两壳的块实例：编辑（ef*）在此创建；添加（af*）在添加表单区创建
  // msg(text, cls)：写弹层左下角提示槽；cls 走 .testline.err / .testline.ok 语义色
  function testlineWriter(elId) {
    return function (text, cls) {
      var el = document.getElementById(elId)
      el.textContent = text
      el.className = cls === 'ok' || cls === 'err' ? 'testline ' + cls : 'testline'
    }
  }
  var efEp = createEndpointBlock('efEpHost', 'ef')
  var efModelB = createModelBlock('efModelHost', 'ef', {
    msg: testlineWriter('efMsg'),
    fetchCtx: function () {
      var ep = efEp.collect()
      var s = null
      ;(view.services || []).forEach(function (x) { if (x.id === editing) s = x })
      return { baseUrl: ep.url, protocol: ep.protocol || (s ? s.protocol : 'anthropic'), key: $('#efKey').value.trim(), serviceId: editing }
    },
  })
  var efFbB = createFallbackBlock('efFbHost', 'ef', {
    msg: testlineWriter('efMsg'),
    getServices: function () { return view.services || [] },
    getSelfId: function () { return editing },
  })
  // 模型目录保存前统一校验：NaN 字段标红该行输入框并提示；重复 id 提示。返回错误文案，无错返回 ''
  function validateModelCollect(collected, blockRoot) {
    for (var mid in collected.models) {
      var r = collected.models[mid]
      // 仅当字段为 NaN（parseTokens 认定非数字）才报错；留空(undefined)合法
      var badField = (r.context_window !== undefined && isNaN(r.context_window)) ? t('上下文', 'context')
        : (r.max_output !== undefined && isNaN(r.max_output)) ? t('最大输出', 'max output') : null
      if (badField) {
        Array.prototype.forEach.call(blockRoot.querySelectorAll('.mrow'), function (row) {
          if (row.querySelector('.mid').textContent.trim() === mid) {
            Array.prototype.forEach.call(row.querySelectorAll('input'), function (inp) {
              if (r.context_window !== undefined && isNaN(r.context_window) && inp.dataset.f === 'context_window') inp.classList.add('bad')
              if (r.max_output !== undefined && isNaN(r.max_output) && inp.dataset.f === 'max_output') inp.classList.add('bad')
            })
          }
        })
        return t('模型「', 'Model "') + mid + t('」的', "'s ") + badField + t('必须是整数（tokens，可用逗号分隔）', ' must be an integer (tokens; commas allowed)')
      }
    }
    if (collected.dup) return t('模型列表有重复项，请检查', 'The model list has duplicates; please check')
    return ''
  }

  function openEdit(id) {
    var s = null
    view.services.forEach(function (x) { if (x.id === id) s = x })
    if (!s) return
    editing = id
    $('#editTitle').textContent = t('编辑「', 'Edit "') + s.label + t('」', '"')
    // 编辑时不做厂商预设回填：表单里每个地址行只反映用户已保存的值，留空 = 用户显式不用该协议。
    // （曾按 host 匹配预设自动补全空行——用户删掉的端点会被猜回来，且回填后保存会把协议静默翻回
    //  anthropic 优先的推导，已移除；添加流程的预设填充见 pickPreset，属用户显式选择，保留。）
    efEp.load({
      name: s.label,
      baseUrl: s.base_url,
      protocol: s.protocol,
      endpoints: {
        anthropic: (s.endpoints && s.endpoints.anthropic) || '',
        openai: (s.endpoints && s.endpoints.openai) || '',
        responses: (s.endpoints && s.endpoints.responses) || '',
      },
    })
    // 安全模型：服务端不再回传 Key 明文；留空 = 不修改（空输入时 efSave 不会带 key 字段）
    $('#efKey').value = ''
    // 提示文案不画眼睛字形（控件图标一律走右侧 SVG 按钮，见 .agents/conventions/ui-kit.md）
    $('#efKey').placeholder = s.hasKey ? t('已保存（留空不修改；点右侧按钮查看并拷贝）', 'Saved (kept unless changed; use the button on the right to view & copy)') : t('尚未设置 Key，可在此填入', 'No key yet; type one here')
    $('#efKey').type = 'password'
    var kt = document.getElementById('efKeyToggle')
    if (kt) { kt.innerHTML = icon('eye', 14); kt.title = t('显示明文', 'Show plaintext') }
    efModelB.load(s.models || [], s.defaultModel ?? '')
    efFbB.load(s.fallback || [])
    $('#efMsg').textContent = ''
    $('#efMsg').className = 'testline'
    editM.open()
  }

  function closeEdit() {
    editM.close() // editing=null 在 onClose 钩子（✕/取消/遮罩/Esc 同一条路径）
  }

  $('#efSave').onclick = function () {
    if (!editing) return
    var body = { provider: editing }
    var ep = efEp.collect()
    // 与添加表单同口径：至少一行协议地址 + 逐行 URL 格式；全清空会让 base_url 与端点脱节
    if (!ep.url) { $('#efMsg').textContent = t('请至少填写一个协议接口地址（照抄厂商文档）', 'Fill in at least one protocol endpoint (copy from the vendor docs)'); $('#efMsg').className = 'testline err'; return }
    for (var pk in ep.urls) {
      if (ep.urls[pk] && !/^https?:\\/\\//i.test(ep.urls[pk])) { $('#efMsg').textContent = t('{proto} 接口地址必须以 http:// 或 https:// 开头', 'The {proto} endpoint URL must start with http:// or https://', { proto: pk }); $('#efMsg').className = 'testline err'; return }
    }
    var key = $('#efKey').value
    var collected = efModelB.collect()
    var modelErr = validateModelCollect(collected, efModelB.el)
    if (modelErr) {
      $('#efMsg').textContent = modelErr
      $('#efMsg').className = 'testline err'
      return
    }
    if (ep.name) body.name = ep.name
    body.base_url = ep.url
    body.protocol = ep.protocol
    if (key) body.key = key
    body.models = collected.models
    body.fallback = efFbB.collect()
    // 全量替换语义（空串=清该协议端点）；默认协议那行落在 base_url，不重复存
    body.endpoints = {
      anthropic: ep.protocol !== 'anthropic' ? ep.urls.anthropic : '',
      openai: ep.protocol !== 'openai' ? ep.urls.openai : '',
      responses: ep.protocol !== 'responses' ? ep.urls.responses : '',
    }
    // 只在用户点过星标时写入默认模型；校验它仍在列表中
    var dm = efModelB.getDefault()
    if (efModelB.isDefaultDirty() && dm && collected.models[dm]) body.default_model = dm
    // 兜底：用户改过默认但所选已被删除 → 默认落到剩余第一行
    else if (efModelB.isDefaultDirty() && Object.keys(collected.models).length) body.default_model = Object.keys(collected.models)[0]
    $('#efSave').disabled = true
    $('#efMsg').textContent = t('保存中…', 'Saving…')
    api('/service/update', { method: 'POST', body: JSON.stringify(body) })
      .then(function () {
        closeEdit()
        $('#efSave').disabled = false
        toast('✓ ' + t('服务信息已更新，立即生效', 'Service updated; effective immediately'), true)
        return load()
      })
      .catch(function (e) {
        $('#efSave').disabled = false
        $('#efMsg').textContent = t('保存失败：', 'Save failed: ') + e.message
        $('#efMsg').className = 'testline err'
      })
  }

`
