/**
 * Web 控制台 · usage.ts —— 用量徽标与用量弹层（svc-usage-pill）。
 * UI_JS_USAGE：服务卡用量徽标槽位（今日 tokens+花费，pollLive 定向填充）+ 统一用量弹层
 * （顶部徽标入口=全部服务视图，服务卡徽标入口=该服务按模型视图；今日/7 天/30 天窗口切换，
 * 数据源 GET /_modeldock/usage 流式聚合）。读取类弹层，关路径三件套（头部 × + Esc +
 * closeOnScrim:true 遮罩），foot 只留 msg 槽（ui-kit §9 2026-11 修订口径）。
 * 片段为模板字面量源文本：ui.ts 经 UI_JS_MIN 拼装；新增片段须在 scripts/gen-ui-min.mjs 的 ORDER 登记。
 */
export const UI_JS_USAGE = `  // ===== 用量徽标 + 用量弹层 =====
  // 服务卡徽标槽位：renderServices 只画空 span（易变数据不进 overview 主载荷的既定约定），
  // pollLive / render 后由 updateSvcUsage 从 liveUsage 定向填充——同 data-svcms 延迟显示配方
  function usageBadgeSlotHtml(pid) {
    return ' <span data-svcusage="' + esc(pid) + '"></span>'
  }
  function svcUsagePillHtml(row) {
    var tok = row.tokens.input + row.tokens.output
    if (!tok) return '' // 零流量不出徽标（对齐 usageHtml 无流量不显示口径）；失败请求无 tokens 不出
    var cost = row.cost > 0 ? ' · ' + fmtUsd(row.cost) : ''
    var tip = t('今日输入 ', 'Input today ') + fmtTok(row.tokens.input) + ' · ' + t('输出 ', 'Output ') + fmtTok(row.tokens.output) +
      (row.tokens.cache_read ? ' · ' + t('缓存读 ', 'Cache read ') + fmtTok(row.tokens.cache_read) : '') +
      ' · ' + t('成本按百万 token 牌价估算（点击查看该服务按模型的用量明细）', 'Cost is estimated from per-million-token list prices (click for per-model usage)')
    return '<button type="button" class="pill" title="' + esc(tip) + '">' + esc(fmtTok(tok) + cost) + '</button>'
  }
  function updateSvcUsage() {
    var u = liveUsage && liveUsage.usageToday
    Array.prototype.forEach.call(document.querySelectorAll('[data-svcusage]'), function (el) {
      var row = u && u.by_provider ? u.by_provider[el.getAttribute('data-svcusage')] : null
      el.innerHTML = row ? svcUsagePillHtml(row) : ''
    })
  }
  // 统一用量弹层：usageScope=null=全部服务（行=服务，可点下钻），服务 id=该服务（行=模型）
  var usageScope = null
  var usageWin = 'today' // today | 7d | 30d
  var usageM = createModal({
    id: 'usageOverlay',
    titleId: 'usageTitle',
    align: 'top',
    modalClass: 'svcmodal',
    bodyHtml: '<p class="testline" data-i18n="加载中…||Loading…"></p>',
    closeOnScrim: true,
    foot: [
      { slot: 'msg', id: 'usageMsg', kind: 'err' },
    ],
  })
  function usageDayStr(offsetDays) {
    var d = new Date()
    d.setDate(d.getDate() + offsetDays)
    return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2)
  }
  function usageSvcLabel(pid) {
    if (view && view.services) {
      for (var i = 0; i < view.services.length; i++) {
        if (view.services[i].id === pid) return view.services[i].label
      }
    }
    return null
  }
  // 弹层窗口 tab（今日/7 天/30 天，7/30=含今天的滚动窗口）：usageWin 变化只重拉重渲染
  function usageTabsHtml() {
    var defs = [['today', t('今日', 'Today')], ['7d', t('7 天', '7 days')], ['30d', t('30 天', '30 days')]]
    var out = '<div class="seg" id="usageWinTabs">'
    for (var i = 0; i < defs.length; i++) {
      out += '<button data-win="' + defs[i][0] + '"' + (usageWin === defs[i][0] ? ' class="on"' : '') + '>' + esc(defs[i][1]) + '</button>'
    }
    return out + '</div>'
  }
  function usageRowsHtml(rows, labelHeader, clickable) {
    var rowsHtml = ''
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i]
      var label = esc(r.label)
      if (r.del) label += ' <span class="delnote">' + esc(t('（已删除）', '(removed)')) + '</span>'
      rowsHtml += '<tr' + (clickable && !r.del ? ' class="click" data-svc="' + esc(r.id) + '"' : '') + '><td>' + label + '</td>' +
        '<td class="num">' + fmtTok(r.t) + '</td><td class="num">' + fmtUsd(r.c) + '</td><td class="num">' + r.r + '</td></tr>'
    }
    if (!rows.length) {
      rowsHtml = '<tr><td colspan="4" class="empty">' + esc(t('该窗口内没有用量', 'No usage in this window')) + '</td></tr>'
    }
    return '<div class="usage-total">' + esc(t('合计 ', 'Total ')) + fmtTok(usageRowsTotal.t) + ' tokens · ' + fmtUsd(usageRowsTotal.c) + ' · ' + usageRowsTotal.r + esc(t(' 请求', ' req')) + '</div>' +
      '<div class="tablescroll"><table id="usageTable"><thead><tr><th>' + esc(labelHeader) + '</th><th class="num">Tokens</th><th class="num">' + esc(t('花费', 'Cost')) + '</th><th class="num">' + esc(t('请求', 'Req')) + '</th></tr></thead><tbody>' + rowsHtml + '</tbody></table></div>'
  }
  var usageRowsTotal = { t: 0, c: 0, r: 0 }
  function renderUsageView(j) {
    var u = j && j.usage
    if (!u) throw new Error('bad payload')
    var title = document.getElementById('usageTitle')
    if (title) title.textContent = usageScope ? t('用量 · ', 'Usage · ') + (usageSvcLabel(usageScope) || usageScope) : t('用量', 'Usage')
    // 三张分桶表求键并集（by_* 计数是超集，但旧版日志极端缺键时以并集兜底不丢行）
    var isAll = !usageScope
    var countMap = isAll ? u.by_provider : u.by_model
    var tokenMap = (isAll ? u.tokens_by_provider : u.tokens_by_model) || {}
    var costMap = (u.cost && (isAll ? u.cost.by_provider : u.cost.by_model)) || {}
    var rows = []
    var total = { t: 0, c: 0, r: 0 }
    for (var id in countMap) {
      var tk = tokenMap[id]
      var c = costMap[id] || 0
      // tokens 主列 = 总口径（输入含缓存读写 + 输出），与徽标/悬浮提示一致
      var t4 = tk ? tk.input_tokens + tk.output_tokens : 0
      var lbl = isAll ? (usageSvcLabel(id) || id) : id
      rows.push({ id: id, label: lbl, del: isAll && !usageSvcLabel(id), t: t4, c: c, r: countMap[id] })
      total.t += t4
      total.c += c
      total.r += countMap[id]
    }
    rows.sort(function (a, b) { return b.t - a.t || b.c - a.c })
    usageRowsTotal = total
    var body = '<div class="row"><button class="btn small" id="usageBack"' + (isAll ? ' hidden' : '') + '>' + esc(t('返回全部服务', 'All services')) + '</button>' + usageTabsHtml() + '</div>' +
      usageRowsHtml(rows, isAll ? t('服务', 'Service') : t('模型', 'Model'), isAll) +
      '<p class="help">' + esc(t('成本按百万 token 牌价估算，实际以服务商账单为准。', 'Cost is estimated from per-million-token list prices; vendor bills are authoritative.')) +
      (usageWin !== 'today' ? esc(t('窗口受请求日志保留期限制，超期日志已清理。', 'Windows are limited by the request-log retention period; expired day files are pruned.')) : '') +
      (u.unpriced_models && u.unpriced_models.length ? esc(t('未匹配单价（按 $0 计）：', 'No price matched (counted as $0): ')) + esc(u.unpriced_models.join(', ')) : '') + '</p>'
    usageM.body.innerHTML = body
    var back = document.getElementById('usageBack')
    if (back) back.onclick = function () { openUsageModal(null) }
    var tabs = document.getElementById('usageWinTabs')
    if (tabs) {
      Array.prototype.forEach.call(tabs.querySelectorAll('button'), function (b) {
        b.onclick = function () { setUsageWin(b.getAttribute('data-win')) }
      })
    }
    if (isAll) {
      Array.prototype.forEach.call(usageM.body.querySelectorAll('tr.click'), function (tr) {
        tr.onclick = function () { openUsageModal(tr.getAttribute('data-svc')) }
      })
    }
  }
  function loadUsageView() {
    usageM.body.innerHTML = '<p class="testline">' + esc(t('加载中…', 'Loading…')) + '</p>'
    var qs = []
    if (usageWin === '7d') { qs.push('from=' + usageDayStr(-6)); qs.push('to=' + usageDayStr(0)) }
    else if (usageWin === '30d') { qs.push('from=' + usageDayStr(-29)); qs.push('to=' + usageDayStr(0)) }
    if (usageScope) qs.push('provider=' + encodeURIComponent(usageScope))
    fetch('/_modeldock/usage' + (qs.length ? '?' + qs.join('&') : ''), { headers: { 'x-modeldock-lang': LANG } }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status)
      return r.json()
    }).then(function (j) {
      renderUsageView(j)
    }).catch(function (e) {
      // 打开状态下失败写底栏 msg 槽（遮罩盖 toast，禁走全局 toast）；重开/切窗自动清
      var msg = document.getElementById('usageMsg')
      if (usageM.isOpen() && msg) msg.textContent = t('用量加载失败：', 'Failed to load usage: ') + ((e && e.message) || e)
    })
  }
  function setUsageWin(w) { usageWin = w; loadUsageView() }
  function openUsageModal(scope) {
    usageScope = scope || null
    usageM.open()
    loadUsageView()
  }
  // 服务卡徽标点击：容器委托一次绑定（卡片 innerHTML 随轮询重建，徽标自身绑定会丢）
  var svcList = document.getElementById('services')
  if (svcList) svcList.addEventListener('click', function (e) {
    var hit = e.target && e.target.closest && e.target.closest('[data-svcusage]')
    if (hit) openUsageModal(hit.getAttribute('data-svcusage'))
  })
  // 顶部今日徽标点击（usageHtml 渲染的 #usageTodayPill）：#health 三路重建 innerHTML，
  // 容器委托一次绑定（同 probeSelfPill 配方）
  var healthBarUsage = document.getElementById('health')
  if (healthBarUsage) healthBarUsage.addEventListener('click', function (e) {
    if (e.target && e.target.closest && e.target.closest('#usageTodayPill')) openUsageModal(null)
  })

`
