/**
 * Web 控制台 · autoroute.ts —— 由单文件 ui.ts 按域拆分（T04 Phase 1，行为零变化）。
 * UI_JS_AUTOROUTE：自动路由与「添加服务」浮层：预设挑选、端点/模型/回退块装配
 * 片段为模板字面量源文本：ui.ts 按原次序拼装后与拆分前逐字节一致；勿改动片段内换行/转义/次序。
 */
export const UI_JS_AUTOROUTE = `  function renderAutoRoute() {
    var sel = document.getElementById('autoRouteSel')
    if (!autoRouteApi || !view) return
    // 无服务时路由控件无意义：路由上行整块隐藏；开关行保留（手机远程是新机扫码导入的入口，开机自启也与服务无关），
    // 仅藏走路由语义的 429 备用开关、自动备用链与「导出配置包」（空配置无可导出），routebox 加 solo 去掉行间分隔线
    var noSvc = view.services.length === 0
    var rrow1 = document.getElementById('rrow1')
    if (rrow1) rrow1.hidden = noSvc
    var inuseBar = document.getElementById('inuseBar')
    if (inuseBar) inuseBar.hidden = noSvc
    var routebox = document.getElementById('routebox')
    if (routebox) routebox.classList.toggle('solo', noSvc)
    var errPillEl = document.getElementById('errPill')
    if (errPillEl) errPillEl.hidden = noSvc
    var fbPillEl = document.getElementById('fbPill')
    if (fbPillEl) fbPillEl.hidden = noSvc
    var pkgPillEl = document.getElementById('pkgPill')
    if (pkgPillEl) pkgPillEl.hidden = noSvc
    if (noSvc) {
      applyAsPill(!!(view.gateway && view.gateway.autostart && view.gateway.autostart.installed))
      applyLanPill(lanOn)
      return
    }
    var ar = view.gateway && view.gateway.autoRoute ? view.gateway.autoRoute : null
    var on = !!(ar && ar.on)
    autoRouteApi.set({ on: on })
    errApi.set({ on: !!(ar && ar.failoverOn429) })
    fbApi.set({ on: !!(ar && ar.autoFallback) })
    applyAsPill(!!(view.gateway && view.gateway.autostart && view.gateway.autostart.installed))
    applyLanPill(lanOn) // 轮询重绘走共享 setter：开关态与 caret 朝向都由它统一维护
    {
      var sch = (view.gateway && view.gateway.autoRoute && view.gateway.autoRoute.schedule) || {}
      var n = (sch.windows || []).length
      var act = sch.active
      var avoidAct = sch.activeAvoids || []
      var enabled = sch.enabled !== false
      var targetLabel = function (t) {
        var p = parseTarget(t)
        var svc = null
        view.services.forEach(function (x) { if (x.id === p.p) svc = x })
        return (svc ? svc.label : p.p) + (p.m ? ' · ' + p.m : '')
      }
      // pill 只显示时间不显示目标：命中哪个服务看「当前路由」；详情进 tooltip，箭头展开面板编辑。
      // 文案/绿色态由组件读取 schedStatus（轮询重绘只更新这份状态，再让组件重渲染）
      schedWindowsSnapshot = (sch.windows || []).map(function (w) { return Object.assign({}, w) })
      schedStatus.windows = n
      schedStatus.autoOn = on
      schedStatus.active = act || null
      schedStatus.activeAvoids = avoidAct
      schedStatus.applied = !!(sch && sch.applied)
      schedStatus.suppressedBy = sch && sch.suppressedBy ? sch.suppressedBy : null
      schedEnabledState = enabled
      if (!schedToggleBusy) schedApi.set({ on: enabled })
      var tips = []
      if (on && act) {
        // 命中 ≠ 接管：钉定/目标不可用/未开启时如实说明，避免绿色 pill 误导（本次误判的放大器）
        var actWhy = schedStatus.applied ? ''
          : sch.suppressedBy === 'pin' ? t('（人工钉定暂停）', ' (paused: pinned)')
          : sch.suppressedBy === 'unavailable' ? t('（目标不可用）', ' (target unavailable)')
          : ''
        tips.push(t('优先 ', 'prefer ') + targetLabel(act.target) + ' ' + act.start + '–' + act.end + actWhy)
      }
      if (on) avoidAct.forEach(function (w) { tips.push(t('避开 ', 'avoid ') + targetLabel(w.target) + ' ' + w.start + '–' + w.end) })
      if (!on && n) tips.push(t('开启自动选主后时段生效', 'Windows apply once auto primary selection is on'))
      if (ar && ar.source === 'pinned') tips.push(t('已人工钉定主服务，定时窗口暂停；「当前」选回「自动」即恢复', 'Primary is pinned manually; schedule windows are paused. Pick "Auto" in Current to resume'))
      schedApi.setTip(tips.length ? tips.join(t('；', '; ')) : t('按时间段自动切换主服务/模型；主体开关=启用/停用，右侧箭头=编辑时段', 'Switch primary service/model by time of day; body = enable/disable, arrow = edit windows'))
    }
    // 统一「正在使用」状态横栏（hero 单行状态条）：消费服务端 routeState 的唯一口径（服务卡徽标/手机页/模型列表同源）。
    // 一行站住「在用谁/为什么/挂了去哪」：状态点（故障切换/降级时变琥珀）+「正在使用：」蓝色服务名 + 来源小徽 +
    // 右缘「下一个切换」；harness/模型归属不在此列（接入区与服务卡「被 N 个客户端使用」承载）
    if (inuseBar) {
      if (ar && ar.providerLabel) {
        var degradedWhy = ar.degradedFrom === 'pinned' ? t('钉定的服务不可用，已自动切到备用', 'Pinned service unavailable; failed over automatically')
          : ar.degradedFrom === 'schedule' ? t('定时目标不可用，已自动切到备用', 'Schedule target unavailable; failed over automatically')
          : ''
        var chipCls = 'ichip'
        var chipTip = ''
        var chipHtml = ''
        if (degradedWhy) {
          chipCls += ' warn tip'
          chipTip = ' data-tip="' + esc(degradedWhy) + '"'
          chipHtml = iconInline('alert-triangle', 12) + '<span>' + t('已降级', 'Degraded') + '</span>'
        } else if (ar.source === 'schedule') {
          chipCls += ' ok'
          chipHtml = iconInline('clock', 12) + '<span>' + t('定时窗口', 'Schedule window') + '</span>' +
            (ar.schedule && ar.schedule.active ? '<span class="inum">' + esc(ar.schedule.active.start + '–' + ar.schedule.active.end) + '</span>' : '')
        } else if (ar.source === 'pinned') {
          chipCls += ' dim'
          chipHtml = iconInline('pin', 12) + '<span>' + t('人工钉定', 'Pinned') + '</span>'
        } else if (ar.source === 'failover') {
          chipCls += ' warn'
          chipHtml = iconInline('zap', 12) + '<span>' + t('故障切换', 'Failover') + '</span>'
        } else {
          chipCls += ' dim'
          chipHtml = '<span>' + t('默认路由', 'Default route') + '</span>'
        }
        var effHtml = '<div class="olmain">' +
          '<span class="idot' + (degradedWhy || ar.source === 'failover' ? ' warn' : '') + '" aria-hidden="true"></span>' +
          '<span class="ollabel">' + t('正在使用：', 'In use: ') + '</span>' +
          '<span class="iname">' + esc(ar.providerLabel) + '</span>' +
          '<span class="' + chipCls + '"' + chipTip + '>' + chipHtml + '</span>' +
          '</div>' +
          // 「下一个切换」：与在用服务拼成完整路由事实（在用谁 → 挂了去哪）；取真实下一跳
          // （钉定时=钉定服务，自动态=全条件现算），无备用时明说并以琥珀示警，不留空白让人以为有兜底
          '<div class="olnext tip" data-tip="' + esc(t('主服务不可达时切到它；自动态按备用优先级/最近成功耗时实时排序', 'Where traffic goes when the primary is down; in auto mode ranked live by fallback priority / last successful latency')) + '">' +
          '<span class="ollabel">' + t('下一个切换：', 'Next failover: ') + '</span>' +
          '<span class="olvalue' + (ar.nextLabel ? '' : ' warn') + '">' + esc(ar.nextLabel || t('无备用服务', 'no fallback')) + '</span>' +
          '</div>'
        inuseBar.innerHTML = effHtml
      } else {
        inuseBar.textContent = ''
        inuseBar.hidden = true
      }
    }
    if (sel) {
      // 「下一个切换」槽：主服务不可达时切到它。自动态显示程序会选的备用（自动 · B），人工选服务=钉定该槽。
      // 候选链里没有第二个服务（未配故障切换顺序）时写明「无备用服务」——静默显示「自动」会被当成名字没渲染出来，
      // 也掩盖了「主服务不可达时无处可切」这一事实（名字来自服务端 autoNextLabel）
      var routeNext = ar ? ar.routeNext : null
      var nextAutoLabel = ar ? ar.autoNextLabel : null
      var autoNextOpt = nextAutoLabel ? t('自动 · ', 'Auto · ') + nextAutoLabel : t('自动 · 无备用服务', 'Auto · no fallback')
      // 选项由共用 routeSelectHtml 构建（与手机同步页同源）：自动态占位 + enabled 服务 + 钉定项兜底（被下线也保留一项显示）。
      // 兜底项名字必须用钉定服务自己的名字（routeNextLabel）——旧写法传 nextLabel，钉定未生效时会显示成实际切向的别家服务名
      sel.innerHTML = routeSelectHtml(view.services || [], autoNextOpt, routeNext, ar.routeNextLabel || routeNext)
      sel.value = routeNext || ''
      // 钉定未生效（目标不可用/与主候选相同，真实下一跳 ≠ 钉定项）：在钉定项上如实标注，
      // 避免「显示钉了 A、实际切了 B」的误读；文案中性——不区分「不可用」与「与主服务相同」两种原因
      if (routeNext && ar.nextPinnedSkipped) {
        var pinNote = ar.nextLabel
          ? ' ' + t('（实际将切到 ', ' (will switch to ') + ar.nextLabel + t('）', ')')
          : ' ' + t('（实际无可用备用）', ' (no usable fallback)')
        Array.prototype.forEach.call(sel.options, function (o) {
          if (o.value === routeNext) o.textContent += pinNote
        })
      }
    }
    // 「当前」槽 = 实际使用中的主服务：自动态显示「自动 · X」（X=程序会选的：定时窗口/默认路由），人工选服务=钉定（优先于定时窗口，
    // 持续到选回「自动」）。与「下一个切换」槽各自独立，人工修改优先于程序自动
    var curSel = document.getElementById('curSvcSel')
    if (curSel) {
      var forced = ar ? ar.forced : null
      var autoCurOpt = !forced && ar && ar.autoPrimaryLabel ? t('自动 · ', 'Auto · ') + ar.autoPrimaryLabel : t('自动', 'Auto')
      curSel.innerHTML = routeSelectHtml(view.services || [], autoCurOpt, forced, ar.providerLabel || forced)
      curSel.value = forced || ''
    }
  }

  // 添加模型服务：已有服务时收起为右下角 + 号，点击浮层展示
  var addOpen = false

  function layoutAddSection() {
    var has = view.services.length > 0
    $('#fabAdd').hidden = !has || addOpen
    document.getElementById('svcH').textContent = has ? t('我的服务', 'My services') : t('② 我的服务', '② My services')
    document.getElementById('cliHText').textContent = has ? t('接入你的 AI 客户端', 'Attach your AI clients') : t('③ 接入你的 AI 客户端', '③ Attach your AI clients')
    document.getElementById('addH').textContent = has ? t('添加模型服务', 'Add a model service') : t('① 添加模型服务', '① Add a model service')
    if (!has) {
      closeAddOverlay()
      document.getElementById('addCard').hidden = false // 首次使用：内联展示引导
    } else if (!addOpen) {
      document.getElementById('addCard').hidden = true // 已有服务：仅保留右下角 + 号入口
    }
  }

  function openAddOverlay() {
    if (view.services.length === 0) return // 空状态直接内联展示
    document.getElementById('addModalBody').appendChild(document.getElementById('addCard'))
    document.getElementById('addCard').hidden = false
    document.getElementById('addFoot').appendChild(document.getElementById('afActions')) // 动作区提为常驻底栏
    document.getElementById('addFoot').hidden = $('#addform').hidden // 选好服务商展开表单后才亮出
    addOpen = true
    $('#fabAdd').hidden = true
    addM.open()
    renderChips()
  }

  function closeAddOverlay() {
    if (!addOpen) return
    addM.close() // 动作区/卡片还原在 onClose 钩子（✕/遮罩/Esc 同一条路径）
  }

  document.getElementById('fabAdd').onclick = openAddOverlay

  var picked = null

  // 添加壳的三块实例（块实现见编辑区「服务表单公共块」）
  var afEp = createEndpointBlock('afEpHost', 'af')
  var afModelB = createModelBlock('afModelHost', 'af', {
    msg: testlineWriter('afMsg'),
    fetchCtx: function () {
      var ep = afEp.collect()
      return { baseUrl: ep.url, protocol: ep.protocol, key: $('#afKey').value.trim(), serviceId: null }
    },
  })
  var afFbB = createFallbackBlock('afFbHost', 'af', {
    msg: testlineWriter('afMsg'),
    getServices: function () { return view.services || [] },
    getSelfId: function () { return null }, // 新服务尚未进列表，没有“自身”可排除
  })
  // 预设自带目录 → 模型表初始行（★ 默认 = 第一行 = 服务端将采用的默认模型）
  function presetModelList(p) {
    var arr = []
    var pm = p.models || {}
    for (var mid in pm) arr.push({ id: mid, display_name: pm[mid].display_name || '', context_window: pm[mid].context_window, max_output: pm[mid].max_output, capabilities: pm[mid].capabilities || [] })
    return arr
  }

  function renderChips() {
    var byId = {}
    view.presets.forEach(function (p) { byId[p.id] = p })
    var ids = COMMON.filter(function (id) { return byId[id] })
    var moreIds = MORE_TOP.filter(function (id) { return byId[id] && ids.indexOf(id) < 0 })

    // 首屏放「自定义 / DeepSeek / OpenAI / Anthropic」四个常用按钮，「更多服务…」下拉只列 MORE_TOP 白名单：
    // 整行只占一行不换行，放不下时先收窄「更多服务」框（下拉在 innerHTML 之后绑定，此刻 #moreSel 才存在于 DOM）
    var html = ids.slice(0, 4).map(function (id) {
      // 按钮上用简称：「Anthropic 官方」→「Anthropic」，下拉里仍显示完整名
      // 英文标签用半角括号（如 "Anthropic (official)"），一并截掉括号段与 official 字样
      return '<button class="chip" data-preset="' + esc(id) + '">' + esc(byId[id].label.split('（')[0].split(' (')[0].replace('官方', '').replace(' (official)', '').trim()) + '</button>'
    }).join('')
    html += '<select class="chip" id="moreSel"><option value="">' + t('更多服务…', 'More services…') + '</option>' +
      moreIds.map(function (id) { return '<option value="' + esc(id) + '">' + esc(byId[id].label) + '</option>' }).join('') +
      '</select>'
    $('#chips').innerHTML = html

    Array.prototype.forEach.call(document.querySelectorAll('[data-preset]'), function (b) {
      b.onclick = function () { pickPreset(b.getAttribute('data-preset')) }
    })
    $('#moreSel').onchange = function () { if (this.value) pickPreset(this.value) }
  }

  function pickPreset(id) {
    picked = id
    var p = null
    view.presets.forEach(function (x) { if (x.id === id) p = x })
    if (!p) return
    document.querySelectorAll('.chip[data-preset]').forEach(function (b) {
      b.className = 'chip' + (b.getAttribute('data-preset') === id ? ' active' : '')
    })
    $('#addform').hidden = false
    document.getElementById('addFoot').hidden = false // 动作区随表单亮出（弹窗宿主=常驻底栏；内联宿主此脚在壳里不可见，无副作用）
    $('#afTitle').textContent = t('添加「', 'Add "') + p.label + t('」', '"')
    // 名称/协议地址按预设填好（自定义=全空白）；说明收进地址块下的小字
    var isCustom = !p.base_url
    afEp.load({
      name: isCustom ? '' : p.label,
      namePlaceholder: isCustom
        ? '给服务起个名字，如：我的中转站||Name it, e.g. my relay'
        : '留空=用厂商默认名||empty = use vendor default name',
      baseUrl: p.base_url || '',
      protocol: p.protocol || 'openai',
      endpoints: p.endpoints,
      docsHtml: isCustom
        ? docLinkA(t('参考：OpenAI 接口文档', 'Reference: OpenAI API docs'), 'https://platform.openai.com/docs')
        : docLinkA(t('不知道去哪拿 Key？点这里', 'Where to get a key? Click here'), p.docs_url),
    })
    // 模型：预设自带目录直接展示，★ 可改；动过才随保存提交（未动留给服务端做预设合并+在线拉取）
    var pm = presetModelList(p)
    afModelB.load(pm, pm.length ? pm[0].id : '')
    // 故障切换顺序：已有其他服务才显示（首次添加没有可备用对象），初始为空
    afFbB.load([])
    document.getElementById('afFbHost').hidden = !(view.services && view.services.length)
    $('#afKey').value = ''
    $('#afMsg').textContent = ''
    $('#afMsg').className = 'testline'
    $('#afKey').focus()
    $('#addform').scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }
  // 外链图标由这里统一追加（文案里不再写 ↗ 字形）——图标随 <a> 一起打开新窗口。
  // href 只放行 http(s)：docs_url 可来自用户 presets.json，不得携带 javascript: 等危险协议
  function docLinkA(txt, url) {
    return url && /^https?:\\/\\//i.test(url) ? '<a href="' + esc(url) + '" target="_blank" rel="noopener">' + txt + ' ' + iconInline('arrow-up-right', 12) + '</a>' : ''
  }
  // 纯文本行里的网址自动变可点（安装指引等整段文案里的 URL 不必逐条改数据结构）：
  // 按原文切链接以便剔掉句尾标点，展示文本与 href 各自转义；href 只可能以 http(s):// 开头，
  // 没有 javascript: 之类的注入面（文本可能来自上游错误，先切后转义、不解析其中标签）
  function linkifyText(s) {
    var text = String(s == null ? '' : s)
    var out = ''
    var last = 0
    // 句尾标点一般不属于网址（英文文案里 URL 常直接接句号、右括号）
    var trail = '.,;:!?)]}>。，；：！？）】》'
    var re = /https?:\\/\\/\\S+/g
    var m
    while ((m = re.exec(text)) !== null) {
      var url = m[0]
      while (url.length > 8 && trail.indexOf(url.slice(-1)) >= 0) url = url.slice(0, -1)
      if (url.length <= 8) continue
      out += esc(text.slice(last, m.index)) + docLinkA(esc(url), url)
      last = m.index + url.length
    }
    return out + esc(text.slice(last))
  }

  $('#afCancel').onclick = function () {
    $('#addform').hidden = true
    picked = null
    document.querySelectorAll('.chip').forEach(function (b) { b.className = 'chip' })
    closeAddOverlay()
  }

  $('#afSave').onclick = function () {
    if (!picked) return
    var key = $('#afKey').value.trim()
    if (!key) { $('#afMsg').textContent = t('请先粘贴 Key', 'Paste your key first'); $('#afMsg').className = 'testline err'; return }
    var ep = afEp.collect()
    if (!ep.url) { $('#afMsg').textContent = t('请至少填写一个协议接口地址（照抄厂商文档）', 'Fill in at least one protocol endpoint (copy from the vendor docs)'); $('#afMsg').className = 'testline err'; return }
    for (var pk in ep.urls) {
      if (ep.urls[pk] && !/^https?:\\/\\//i.test(ep.urls[pk])) { $('#afMsg').textContent = t('{proto} 接口地址必须以 http:// 或 https:// 开头', 'The {proto} endpoint URL must start with http:// or https://', { proto: pk }); $('#afMsg').className = 'testline err'; return }
    }
    var collected = afModelB.collect()
    var modelErr = validateModelCollect(collected, afModelB.el)
    if (modelErr) { $('#afMsg').textContent = modelErr; $('#afMsg').className = 'testline err'; return }
    var btn = $('#afSave')
    if (btn.disabled) return // 防重复提交：双击会真的创建两个同地址服务
    btn.disabled = true
    $('#afMsg').textContent = t('保存中…', 'Saving…')
    $('#afMsg').className = 'testline'
    var body = { presetId: picked, key: key, protocol: ep.protocol, base_url: ep.url, name: ep.name }
    if (Object.keys(ep.endpoints).length) body.endpoints = ep.endpoints
    // 动过模型目录就整表提交（含删光 = 空对象）：服务端按提交全量落盘，删掉的行不再由预设目录猜回；
    // 未动才留给服务端做预设合并+在线拉取。新模型框手填的行（没点「添加」也在 collect 里）一并提交，用户输入不丢
    var presetCatalog = {}
    ;(view.presets || []).forEach(function (p) { if (p.id === picked) { var pm = p.models || {}; for (var k in pm) presetCatalog[k] = 1 } })
    var hasExtra = Object.keys(collected.models).some(function (k) { return !presetCatalog[k] })
    if (afModelB.isDirty() || hasExtra) {
      body.models = collected.models
      var dm = afModelB.getDefault()
      if (dm && collected.models[dm]) body.default_model = dm
    }
    var fb = afFbB.collect()
    if (fb.length) body.fallback = fb
    api('/service', { method: 'POST', body: JSON.stringify(body), timeoutMs: 120000 })
      .then(function (r) {
        var msg = '✓ ' + t('已添加「', 'Added "') + r.providerId + t('」', '"')
        if (r.fetched > 0) msg += t('，自动拉取到 ', ', fetched ') + r.fetched + t(' 个模型', ' models')
        if (r.fetchError) msg += t('（模型列表没拉到：', ' (model list not fetched: ') + r.fetchError.slice(0, 60) + t('，不影响使用，稍后可重试）', '; harmless, retry later)')
        toast(msg, true)
        $('#addform').hidden = true
        picked = null
        closeAddOverlay()
        btn.disabled = false
        return load()
      })
      .catch(function (e) {
        btn.disabled = false
        $('#afMsg').textContent = t('失败：', 'Failed: ') + e.message
        $('#afMsg').className = 'testline err'
      })
  }

`
