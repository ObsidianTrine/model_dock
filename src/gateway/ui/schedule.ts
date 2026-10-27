/**
 * Web 控制台 · schedule.ts —— 由单文件 ui.ts 按域拆分（T04 Phase 1，行为零变化）。
 * UI_JS_SCHED_STATE：定时面板：状态变量与 schedApi pill
 * UI_JS_SCHEDULE：定时面板：时段行渲染/持久化/时间选择弹层
 * 片段为模板字面量源文本：ui.ts 按原次序拼装后与拆分前逐字节一致；勿改动片段内换行/转义/次序。
 */
export const UI_JS_SCHED_STATE = `  var schedStatus = { windows: 0, autoOn: false, active: null, activeAvoids: [], applied: false, suppressedBy: null }
  // 启用态的唯一事实来源：切换即时落盘（不走防抖），切换在飞期间轮询重绘不回灌开关态——
  // 否则 5s 轮询会在防抖窗口内把服务端旧值写回，POST 就带回了旧值（实测复现过的竞态）
  var schedEnabledState = true
  var schedToggleBusy = false
  // 时段行的权威来源：面板未打开时按 DOM 抓行会得到空数组，POST 出去就把已存时段清掉了（实测过的数据丢失），
  // 故未渲染时用服务端快照；只有面板真实渲染过（用户在编辑）才以 DOM 为准
  var schedWindowsSnapshot = []
  var schedRowsRendered = false
  var schedApi = pillSwitch('schedPill', {
    label: function () { return t('定时', 'Schedule') },
    // 文案是「状态」不是「开/关」：命中时段=时间区间（绿）/ 开启未命中=N 个时段（灰）/ 关=已停用（灰）
    text: function (on) {
      var n = schedStatus.windows
      if (!on) return t('定时 · 已停用', 'Schedule · off')
      if (!n) return t('定时 · 开', 'Schedule · on') // 无时段时也明示开关态（原 pill 无开关，故为新增文案）
      if (schedStatus.autoOn && schedStatus.active) {
        var span = schedStatus.active.start + '–' + schedStatus.active.end
        // 绿色只代表「真的接管了」：命中但被钉定/目标不可用时写清原因，不再用绿点伪装生效
        if (schedStatus.applied) return t('定时 · ', 'Schedule · ') + span
        var why = schedStatus.suppressedBy === 'pin' ? t('钉定暂停', 'pinned')
          : schedStatus.suppressedBy === 'unavailable' ? t('目标不可用', 'target unavailable')
          : t('未生效', 'inactive')
        return t('定时 · ', 'Schedule · ') + span + t('（', ' (') + why + t('）', ')')
      }
      if (schedStatus.autoOn && schedStatus.activeAvoids.length) return t('定时 · ', 'Schedule · ') + schedStatus.activeAvoids[0].start + '–' + schedStatus.activeAvoids[0].end + (schedStatus.activeAvoids.length > 1 ? t(' 等', ' etc.') : '')
      return t('定时 · ', 'Schedule · ') + n + t(' 个时段', ' windows')
    },
    okOn: function (on) { return !!on && schedStatus.autoOn && ((!!schedStatus.active && schedStatus.applied) || schedStatus.activeAvoids.length > 0) },
    panel: function () { return document.getElementById('schedPanel') },
    onToggle: function (next, pill) {
      pill.set({ on: next })
      if (!next) { pill.set({ open: false }); document.getElementById('schedPanel').hidden = true; schedRowsRendered = false }
      schedEnabledState = next
      schedToggleBusy = true
      schedPersistNow() // 开关切换即时落盘；保存链结束再放开回灌保护
    },
    onExpand: function (open) { schedOpen = open; if (open) renderSchedPanel(); else schedRowsRendered = false },
  })

  // 同网直拉迁移（sync-lan-pull）：A 侧「导出链接/让对方来拉」/ B 侧「导入 → 附近的电脑/粘贴链接」
  // 链接含口令（#p= fragment，不出本机也不进审计）；附近直拉链路凭对方放行的一次性 ticket 应用
  // shareM/importM 已并入 pkgM 统一弹层：两个旧开关名保留为薄封装，调用方（createOffer/impApplyResult 等）零改动
`
export const UI_JS_SCHEDULE = `  var schedOpen = false
  var schedSeedDismissed = false // 用户保存过空时段后不再预填默认时段
  function schedSvcOptions(sel) {
    var opts = '<option value="">' + t('选择服务…', 'Pick a service…') + '</option>'
    view.services.forEach(function (x) {
      opts += '<option value="' + esc(x.id) + '"' + (x.id === sel ? ' selected' : '') + '>' + esc(x.label) + '</option>'
    })
    return opts
  }
  function schedModelOptions(svcId, model) {
    var opts = '<option value="">' + t('透传原模型名', 'Pass through original model') + '</option>'
    view.services.forEach(function (x) {
      if (x.id !== svcId) return
      ;(x.models || []).forEach(function (m) {
        opts += '<option value="' + esc(m.id) + '"' + (m.id === model ? ' selected' : '') + '>' + esc(m.id) + '</option>'
      })
    })
    return opts
  }
  // 服务列表指纹（id+名+模型表拼接）：定时面板下拉只在列表真变时重建选项，2s 轮询零开销
  function viewServicesSig() {
    return (view.services || []).map(function (s) {
      return s.id + '\\u0001' + s.label + '\\u0001' + (s.models || []).map(function (m) { return m.id }).join(',')
    }).join('\\u0002')
  }
  var schedSvcSig = ''
  // 服务增删/改名/改模型表后只重建定时面板的 <option>，不动行结构与未保存输入——整体重渲染会冲掉
  // 正在编辑的时段时间、把预填时段灌回来（见 schedRowsEl click 处注释）；已选值原样带回，
  // 行内服务/模型已被删除时补一项原值兜底（与 routeSelectHtml 钉定兜底同口径），不静默清空已保存配置
  function refreshSchedSvcOptions() {
    if (!schedRowsRendered || !view) return
    var sig = viewServicesSig()
    if (sig === schedSvcSig) return
    schedSvcSig = sig
    var ns = document.getElementById('schedNewSvc'), nm = document.getElementById('schedNewModel')
    if (ns) {
      var curSvc = ns.value
      ns.innerHTML = schedSvcOptions(curSvc)
      if (nm) nm.innerHTML = schedModelOptions(ns.value, nm.value)
    }
    Array.prototype.forEach.call(document.querySelectorAll('#schedRows .srow'), function (r) {
      var svcSel = r.querySelector('.ssvc'), modSel = r.querySelector('.smod')
      if (!svcSel) return
      var keepSvc = svcSel.value
      svcSel.innerHTML = schedSvcOptions(keepSvc)
      // 先赋值再判断：选项列表里已无原值（服务被删）时补一项原值兜底，行不静默变成“未选服务”
      if (keepSvc && svcSel.value !== keepSvc) {
        svcSel.innerHTML += '<option value="' + esc(keepSvc) + '" selected>' + esc(keepSvc) + '</option>'
      }
      if (modSel && !modSel.disabled) {
        var keepModel = modSel.value
        modSel.innerHTML = schedModelOptions(svcSel.value, keepModel)
        if (keepModel && modSel.value !== keepModel) {
          modSel.innerHTML += '<option value="' + esc(keepModel) + '" selected>' + esc(keepModel) + '</option>'
        }
      }
    })
  }
  // 生效日下拉：''=每天；wd/we/hol=日类型过滤（工作日/周末/法定节假日）；自定义星期几回显为 custom（原值以逗号串存 data-days，保存时沿用）
  function daysSelectHtml(cls, days, dayFilter, title) {
    var key = (days || []).slice().sort().join(',')
    var val = dayFilter === 'workday' ? 'wd' : dayFilter === 'weekend' ? 'we' : dayFilter === 'holiday' ? 'hol' : key === '' ? '' : 'custom'
    return '<select class="' + cls + '"' + (title ? ' title="' + esc(title) + '"' : '') + (val === 'custom' ? ' data-days="' + key + '"' : '') + '>' +
      '<option value=""' + (val === '' ? ' selected' : '') + '>' + t('每天', 'Every day') + '</option>' +
      '<option value="wd"' + (val === 'wd' ? ' selected' : '') + '>' + t('工作日', 'Weekdays') + '</option>' +
      '<option value="we"' + (val === 'we' ? ' selected' : '') + '>' + t('周末', 'Weekend') + '</option>' +
      '<option value="hol"' + (val === 'hol' ? ' selected' : '') + '>' + t('法定节假日', 'Holidays') + '</option>' +
      (val === 'custom' ? '<option value="custom" selected>' + t('自定义', 'Custom') + '</option>' : '') +
      '</select>'
  }
  function daysValueOf(sel) {
    if (sel.value === 'wd') return { dayFilter: 'workday' }
    if (sel.value === 'we') return { dayFilter: 'weekend' }
    if (sel.value === 'hol') return { dayFilter: 'holiday' }
    if (sel.value === 'custom') {
      var arr = String(sel.getAttribute('data-days') || '').split(',').map(Number).filter(function (n) { return n >= 1 && n <= 7 })
      if (arr.length) return { days: arr }
    }
    return {}
  }
  function schedRowHtml(mode, days, dayFilter, start, end, target) {
    var p = parseTarget(target)
    var avoid = mode === 'avoid'
    var tTitle = t('点击选择时间，也可直接键入 HH:mm', 'Click to pick a time, or type HH:mm')
    var modeTitle = t('优先走=时段内优先使用该服务/模型；避开=时段内不使用该服务，其余服务照常优先级', 'Prefer = use this service/model first inside the window; Avoid = skip this service inside the window, others apply as usual')
    var daysTitle = t('工作日=周一至五与调休补班日，不含法定节假日；周末=周六、周日；法定节假日=国务院公布的放假日', 'Weekdays = Mon–Fri plus makeup workdays, excluding statutory holidays; Weekend = Sat & Sun; Holidays = statutory off days per State Council announcements')
    return '<div class="srow">' +
      '<select class="smode" title="' + modeTitle + '">' +
      '<option value=""' + (!avoid ? ' selected' : '') + '>' + t('优先走', 'Prefer') + '</option>' +
      '<option value="avoid"' + (avoid ? ' selected' : '') + '>' + t('避开', 'Avoid') + '</option></select>' +
      daysSelectHtml('sdays', days, dayFilter, daysTitle) +
      '<span class="tfield"><input type="text" class="tinput" inputmode="numeric" maxlength="5" placeholder="--:--" value="' + esc(start) + '" title="' + tTitle + '"></span>' +
      '<span class="tfield"><input type="text" class="tinput" inputmode="numeric" maxlength="5" placeholder="--:--" value="' + esc(end) + '" title="' + tTitle + '"></span>' +
      '<select class="ssvc">' + schedSvcOptions(p.p) + '</select>' +
      '<select class="smod"' + (avoid ? ' disabled' : '') + '>' + (avoid ? '<option value="">' + t('按整个服务避开', 'Whole service avoided') + '</option>' : schedModelOptions(p.p, p.m || '')) + '</select>' +
      '<button type="button" class="sdel" title="' + t('删除时段', 'Delete window') + '">' + icon('close', 12) + '</button></div>'
  }
  function renderSchedPanel() {
    var sch = (view.gateway && view.gateway.autoRoute && view.gateway.autoRoute.schedule) || {}
    var wins = (sch.windows || []).slice()
    var seeded = false
    // 首次使用且未配置过任何时段时，按 DeepSeek 低谷半价时段预填（00:30–08:30 半价走 DeepSeek，其余时间走 Coding Plan）；仅预填不落盘，保存后以用户修改为准
    if (!wins.length && !schedSeedDismissed) {
      var seed = defaultScheduleSeed()
      if (seed.length) {
        wins = seed
        seeded = true
        $('#schedMsg').textContent = t('已按 DeepSeek 低谷半价时段（00:30–08:30）预填，其余时间走 Coding Plan——可直接修改后保存，不需要就清空时段再保存', 'Pre-filled with DeepSeek off-peak half-price windows (00:30–08:30), Coding Plan the rest of the time — edit then save, or clear the windows and save to dismiss')
        $('#schedMsg').className = 'testline'
      }
    }
    schedEnabledState = sch.enabled !== false
    if (schedApi && !schedToggleBusy) schedApi.set({ on: schedEnabledState })
    schedRowsRendered = true
    document.getElementById('schedRows').innerHTML = wins
      .map(function (w) { return schedRowHtml(w.mode, w.days, w.dayFilter, w.start, w.end, w.target) }).join('') ||
      '<div class="mempty">' + t('暂无时段。添加后，命中时段的请求优先走指定服务/模型。', 'No windows yet. Once added, requests inside a window prefer the specified service/model.') + '</div>'
    // 今天的日类型：只在需要解释窗口生效情况的日子显示（普通工作日无信息量，整行隐藏）
    var todayType = sch.today || 'workday'
    document.getElementById('schedToday').textContent =
      todayType === 'holiday' ? t('今日法定节假日：「工作日」时段不生效，「法定节假日」时段生效', 'Statutory holiday today: "Weekday" windows are off; "Holiday" windows apply')
      : todayType === 'makeup' ? t('今日调休补班（周末上班）：视同工作日', 'Makeup workday today (weekend shift): treated as a weekday')
      : todayType === 'weekend' ? t('今日周末：「工作日」时段不生效，「周末」时段生效', 'Weekend today: "Weekday" windows are off; "Weekend" windows apply')
      : ''
    document.getElementById('schedNewStart').value = ''
    document.getElementById('schedNewEnd').value = ''
    document.getElementById('schedNewMode').value = ''
    document.getElementById('schedNewDays').value = ''
    document.getElementById('schedNewSvc').innerHTML = schedSvcOptions('')
    document.getElementById('schedNewModel').innerHTML = schedModelOptions('', '')
    schedSvcSig = viewServicesSig()
    if (!seeded) $('#schedMsg').textContent = ''
    renderSchedUpcoming()
  }
  var schedRowsEl = document.getElementById('schedRows')
  // 即时保存：面板内任何增删改（含时间选择器的 change 冒泡）都触发防抖保存，不再有独立「保存」按钮
  function schedPersist() {
    if (!schedOpen) return
    clearTimeout(schedPersistTimer)
    schedPersistTimer = setTimeout(schedPersistNow, 600)
  }
  var schedPersistTimer = null
  function schedPersistNow() {
    var windows = [], bad = ''
    if (!schedRowsRendered) {
      // 面板未打开（如直接在 pill 上启用/停用）：原样带服务端时段，只改 enabled，避免误清时段
      windows = schedWindowsSnapshot.map(function (w) { return Object.assign({}, w) })
    } else {
    Array.prototype.forEach.call(document.querySelectorAll('#schedRows .srow'), function (r) {
      if (bad) return
      var times = r.querySelectorAll('.tinput')
      var start = parseTimeInput(times[0] ? times[0].value : ''), end = parseTimeInput(times[1] ? times[1].value : '')
      var svc = r.querySelector('.ssvc').value
      if (!start || !end || !svc) { bad = (!start || !end) ? t('时段时间格式应为 HH:mm（如 09:30），点时间框即可选择，请补全或删除该行', 'Window times must be HH:mm (e.g. 09:30); click the time box to pick, or fix/delete the row') : t('有时段未选服务，请补全或删除该行', 'A window has no service; fix or delete the row'); return }
      var mode = r.querySelector('.smode').value
      var model = r.querySelector('.smod').value
      var dv = daysValueOf(r.querySelector('.sdays'))
      // 避开窗口按整个服务生效：target 不带模型部分（服务端同样剥掉，双保险）
      var base = mode === 'avoid' ? { start: start, end: end, target: svc, mode: 'avoid' } : { start: start, end: end, target: model ? svc + ':' + model : svc }
      windows.push(Object.assign({}, base, dv.days ? { days: dv.days } : {}, dv.dayFilter ? { dayFilter: dv.dayFilter } : {}))
    })
    }
    if (bad) { $('#schedMsg').textContent = bad; $('#schedMsg').className = 'testline err'; return }
    if (schedRowsRendered && !windows.length) schedSeedDismissed = true // 用户明确删空时段：不再预填默认时段
    api('/auto-route/schedule', {
      method: 'POST',
      body: JSON.stringify({ enabled: schedEnabledState, windows: windows }),
    })
      .then(function () {
        $('#schedMsg').textContent = '✓ ' + t('已保存', 'Saved')
        $('#schedMsg').className = 'testline ok'
        return load()
      })
      .catch(function (e) { $('#schedMsg').textContent = t('保存失败：', 'Save failed: ') + e.message; $('#schedMsg').className = 'testline err' })
      .then(function () { schedToggleBusy = false })
  }
  schedRowsEl.addEventListener('click', function (e) {
    var t = e.target
    if (!t || !t.classList || !t.classList.contains('sdel')) return
    t.closest('.srow').remove()
    // 删光只放占位行、不整体重渲染：重新 render 会把预填时段灌回来（导致无法清空保存），还会丢掉未保存的节假日输入
    if (!schedRowsEl.querySelector('.srow')) {
      schedRowsEl.innerHTML = '<div class="mempty">' + t('暂无时段。添加后，命中时段的请求优先走指定服务/模型。', 'No windows yet. Once added, requests inside a window prefer the specified service/model.') + '</div>'
    }
    schedPersist()
  })
  schedRowsEl.addEventListener('change', function (e) {
    var el = e.target
    if (!el || !el.classList) return
    // 避开按整个服务生效：切到避开时模型下拉禁用，切回优先走时按当前服务恢复
    if (el.classList.contains('smode')) {
      var row = el.closest('.srow'), mod = row.querySelector('.smod')
      if (el.value === 'avoid') {
        mod.innerHTML = '<option value="">' + t('按整个服务避开', 'Whole service avoided') + '</option>'
        mod.disabled = true
      } else {
        mod.innerHTML = schedModelOptions(row.querySelector('.ssvc').value, '')
        mod.disabled = false
      }
    } else if (el.classList.contains('ssvc')) {
      el.closest('.srow').querySelector('.smod').innerHTML = schedModelOptions(el.value, '')
    }
    schedPersist()
  })
  document.getElementById('schedNewSvc').addEventListener('change', function () {
    document.getElementById('schedNewModel').innerHTML = schedModelOptions(this.value, '')
  })
  document.getElementById('schedAdd').onclick = function () {
    var start = parseTimeInput($('#schedNewStart').value), end = parseTimeInput($('#schedNewEnd').value)
    var svc = $('#schedNewSvc').value
    if (!start || !end || !svc) { $('#schedMsg').textContent = !start || !end ? t('请填好起止时间（HH:mm，如 09:30），点时间框可弹出选择', 'Fill in start/end times (HH:mm, e.g. 09:30); click the time box to pick') : t('请先选择服务', 'Pick a service first'); $('#schedMsg').className = 'testline err'; return }
    var mode = document.getElementById('schedNewMode').value
    var dv = daysValueOf(document.getElementById('schedNewDays'))
    var model = $('#schedNewModel').value
    var el = document.getElementById('schedRows')
    if (el.querySelector('.mempty')) el.innerHTML = ''
    el.insertAdjacentHTML('beforeend', schedRowHtml(mode, dv.days, dv.dayFilter, start, end, mode !== 'avoid' && model ? svc + ':' + model : svc))
    $('#schedNewStart').value = ''
    $('#schedNewEnd').value = ''
    // 模式/生效日保留：连续添加多个同配置的避开时段（如上午、下午各一条）不用每次重选
    $('#schedNewSvc').innerHTML = schedSvcOptions('')
    $('#schedNewModel').innerHTML = schedModelOptions('', '')
    $('#schedMsg').textContent = ''
    schedPersist()
  }
  // 「最近节假日」：overview 随载荷下发（网关每日自动更新日历，无需手动刷新），面板打开时被动展示
  function renderSchedUpcoming() {
    var sch = (view.gateway && view.gateway.autoRoute && view.gateway.autoRoute.schedule) || {}
    var up = sch.upcomingHolidays || []
    var row = document.getElementById('schedUpcomingRow')
    var el = document.getElementById('schedUpcoming')
    if (!row || !el) return
    row.hidden = !up.length
    if (!up.length) { el.textContent = ''; return }
    var md = function (d) { return String(d || '').slice(5) } // YYYY-MM-DD → MM-DD
    el.textContent = t('最近节假日：', 'Upcoming holidays: ') + up.map(function (h) {
      var mk = (h.makeup || []).length ? t('（', ' (') + h.makeup.map(md).join(t('、', ', ')) + t(' 调休上班', ' makeup workday') + t('）', ')') : ''
      return h.name + ' ' + md(h.start) + '～' + md(h.end) + mk
    }).join(t(' · ', ' · '))
  }

  // 时段选择（Ant Design TimePicker 式交互）：点击输入框直接弹出「时/分」两列滚动面板，
  //    点选即生效、面板保持打开便于连续微调；输入框同时可键入（宽容解析，键入时两列实时联动高亮）；
  //    点外部 / Esc / Enter / 滚动页面 关闭
  function parseTimeInput(v) {
    var s = String(v || '').trim()
    var m = /^(\\d{1,2}):(\\d{1,2})$/.exec(s)
    if (m) {
      var h = +m[1], mi = +m[2]
      if (h > 23 || mi > 59) return null
      return pad2(h) + ':' + pad2(mi)
    }
    // 纯数字 3~4 位：末两位为分钟，其余为小时（0930 → 09:30，930 → 09:30）
    if (/^\\d{3,4}$/.test(s)) {
      var h2 = +s.slice(0, s.length - 2), mi2 = +s.slice(-2)
      if (h2 > 23 || mi2 > 59) return null
      return pad2(h2) + ':' + pad2(mi2)
    }
    return null
  }
  function normalizeTimeInput(el) {
    var v = parseTimeInput(el.value)
    if (v) { el.value = v; el.classList.remove('bad') }
    else if (el.value.trim()) el.classList.add('bad')
    else el.classList.remove('bad')
    return v
  }
  function defaultScheduleSeed() {
    // 按服务 id/名称匹配低谷服务商（DeepSeek）与高峰套餐（Coding Plan）；找不到对应服务就不预填
    var find = function (re) {
      var hit = null
      ;(view.services || []).forEach(function (s) { if (!hit && re.test((s.id || '') + ' ' + (s.label || ''))) hit = s })
      return hit
    }
    var off = find(/deepseek/i), peak = find(/coding[-_. ]?plan/i)
    if (!off || !peak || off.id === peak.id) return []
    return [
      { start: '00:30', end: '08:30', target: off.id },
      { start: '08:30', end: '00:30', target: peak.id },
    ]
  }
  function pad2(n) { return n < 10 ? '0' + n : '' + n }
  var timePop = null, timePopFor = null, timeSel = { h: -1, m: -1 }
  function closeTimePop() { if (timePop) { timePop.remove(); timePop = null; timePopFor = null } }
  function tpHighlight(input, scroll) {
    if (!timePop) return
    var v = parseTimeInput(input.value)
    timeSel.h = v ? +v.slice(0, 2) : -1
    timeSel.m = v ? +v.slice(3) : -1
    var cols = timePop.querySelectorAll('.tpcol')
    if (cols.length < 2) return
    Array.prototype.forEach.call(cols[0].querySelectorAll('.tpcell'), function (c) { c.classList.toggle('on', +c.dataset.v === timeSel.h) })
    Array.prototype.forEach.call(cols[1].querySelectorAll('.tpcell'), function (c) { c.classList.toggle('on', +c.dataset.v === timeSel.m) })
    if (scroll) {
      var on1 = cols[0].querySelector('.tpcell.on'), on2 = cols[1].querySelector('.tpcell.on')
      if (on1) on1.scrollIntoView({ block: 'center' })
      if (on2) on2.scrollIntoView({ block: 'center' })
    }
  }
  function tpApply(input) {
    if (timeSel.h < 0 || timeSel.m < 0) return
    input.value = pad2(timeSel.h) + ':' + pad2(timeSel.m)
    input.classList.remove('bad')
    input.dispatchEvent(new Event('change', { bubbles: true }))
  }
  function openTimePop(input) {
    if (timePop && timePopFor === input) return
    closeTimePop()
    var v = parseTimeInput(input.value)
    timeSel.h = v ? +v.slice(0, 2) : -1
    timeSel.m = v ? +v.slice(3) : -1
    timePopFor = input
    timePop = document.createElement('div')
    timePop.id = 'timePickPop'
    var title = document.createElement('div')
    title.className = 'tptitle'
    title.textContent = t('选择时间（也可直接键入）', 'Pick a time (or type it)')
    timePop.appendChild(title)
    var cols = document.createElement('div')
    cols.className = 'tpcols'
    // 一列缺省时点另一列的兜底值：点小时没定分钟 → 分钟取 0；点分钟没定小时 → 小时取 0
    var defs = [timeSel.m < 0 ? 0 : timeSel.m, timeSel.h < 0 ? 0 : timeSel.h]
    ;[0, 1].forEach(function (ci) {
      var col = document.createElement('div')
      col.className = 'tpcol'
      var n = ci === 0 ? 24 : 60
      for (var i = 0; i < n; i++) {
        (function (i2) {
          var c = document.createElement('button')
          c.type = 'button'
          c.className = 'tpcell'
          c.dataset.v = i2
          c.textContent = pad2(i2)
          c.onclick = function () {
            if (ci === 0) { timeSel.h = i2; if (timeSel.m < 0) timeSel.m = defs[0] }
            else { timeSel.m = i2; if (timeSel.h < 0) timeSel.h = defs[1] }
            tpApply(input)
            tpHighlight(input, false)
          }
          col.appendChild(c)
        })(i)
      }
      cols.appendChild(col)
    })
    timePop.appendChild(cols)
    document.body.appendChild(timePop)
    var r = input.getBoundingClientRect()
    timePop.style.visibility = 'hidden'
    timePop.style.display = 'block'
    requestAnimationFrame(function () {
      if (!timePop) return
      var w = timePop.offsetWidth, ph = timePop.offsetHeight
      var left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8))
      var top = r.bottom + 6
      if (top + ph > window.innerHeight - 8) top = Math.max(8, r.top - ph - 6)
      timePop.style.left = left + 'px'
      timePop.style.top = top + 'px'
      timePop.style.visibility = 'visible'
      tpHighlight(input, true) // 打开时滚到当前值
    })
  }
  document.addEventListener('focusin', function (e) {
    var t = e.target
    if (t && t.classList && t.classList.contains('tinput')) { openTimePop(t); return }
    // 焦点落到面板以外（含点面板单元格获焦）之外的地方时收起
    if (timePop && !(t && timePop.contains(t))) closeTimePop()
  }, true)
  document.addEventListener('input', function (e) {
    if (timePop && e.target && e.target.classList && e.target.classList.contains('tinput') && timePopFor === e.target) {
      tpHighlight(e.target, false) // 键入时两列实时联动高亮（不滚动，避免与手动滚动打架）
    }
  }, true)
  document.addEventListener('click', function (e) {
    var t = e.target
    if (timePop && !(t && timePop.contains(t)) && !(t && t.classList && t.classList.contains('tinput'))) closeTimePop()
  }, true)
  document.addEventListener('change', function (e) {
    if (e.target && e.target.classList && e.target.classList.contains('tinput')) normalizeTimeInput(e.target)
  }, true)
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { closeTimePop(); return }
    if (e.key === 'Enter' && timePop && e.target && e.target.classList && e.target.classList.contains('tinput')) {
      normalizeTimeInput(e.target)
      closeTimePop()
    }
  }, true)
  window.addEventListener('scroll', function (e) {
    if (timePop && !(e.target && timePop.contains(e.target))) closeTimePop()
  }, true)
  // 「当前」下拉：人工钉定实际使用的主服务（选服务 → /switch 写钉定+默认路由，优先于定时窗口；
  // 选「自动 · X」→ 清除钉定交还程序自动）。快捷路径不弹确认；toast 反馈，失败经 load() 用服务端真相回滚选中值
  $('#curSvcSel').onchange = function () {
    var id = this.value
    if (!id) {
      // 选回「自动」：清除钉定，定时窗口/自动选路接管
      api('/auto-route', { method: 'POST', body: JSON.stringify({ provider: null }) })
        .then(function () { toast('✓ ' + t('已恢复自动选路', 'Back to auto selection'), true); return load() })
        .catch(function (e) { toast(t('切换失败：', 'Switch failed: ') + e.message, false); return load() })
      return
    }
    api('/switch', { method: 'POST', body: JSON.stringify({ service: id }) })
      .then(function (r) {
        var extra = (r && r.refreshed && r.refreshed.length)
          ? t('（dsh 等客户端的模型列表已同步重写，重启对应客户端生效）', ' (model lists of dsh-like clients rewritten; restart them to take effect)')
          : ''
        // 人工钉定压过定时窗口：窗口命中期间如实说明钉定效果，避免「定时怎么不动了」的误读
        var sch = view.gateway && view.gateway.autoRoute ? view.gateway.autoRoute.schedule : null
        if (sch && sch.active) {
          extra += t('（已人工钉定，定时时段内也走该服务；「当前」选回「自动」恢复定时）', ' (pinned manually — applies during schedule windows too; pick "Auto" in Current to resume the schedule)')
        }
        toast('✓ ' + t('已切换，新请求立即生效', 'Switched; new requests take effect immediately') + extra, true)
        return load()
      })
      .catch(function (e) {
        toast(t('切换失败：', 'Switch failed: ') + e.message, false)
        return load()
      })
  }
  // 「下一个切换」下拉：主服务不可达时切到谁。选服务=钉定该槽（插备用链首位）；选「自动」=恢复按优先级/实测耗时排序
  $('#autoRouteSel').onchange = function () {
    var v = this.value || null
    api('/auto-route', { method: 'POST', body: JSON.stringify({ next: v }) })
      .then(function () {
        toast(v ? '✓ ' + t('已钉定下一个切换目标', 'Next failover target pinned') : '✓ ' + t('下一个切换已恢复自动排序', 'Next failover target back to auto'), true)
        return load()
      })
      .catch(function (e) { toast(t('切换路由服务商失败：', 'Failed to switch routed service: ') + e.message, false); return load() })
  }
  $('#svcSort').addEventListener('change', function () { svcSort = this.value; renderServices() })
  $('#svcFilter').addEventListener('change', function () { svcFilter = this.value; renderServices() })

`
