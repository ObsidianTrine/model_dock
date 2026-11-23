/**
 * Web 控制台 · probe.ts —— 服务探针（provider-probe-suite 任务 6）。
 * UI_JS_PROBE：verdict 徽标数据轮询 + 服务卡徽标渲染（点击下钻该服务 verdict 变化时间线，
 * probe-ui-into-usage-health 任务 2）+ 探针自耗 pill（融进 #health 今日用量仪表）与其明细弹层
 * （月度总花费/预算余量/按探针分解）。探针账本/趋势独立按钮与趋势弹层已随入口收敛移除
 * （任务 3+4）：费用入口 = 探针 pill 点击，健康历史入口 = 服务卡徽标点击。
 * 片段为模板字面量源文本：ui.ts 经 UI_JS_MIN 拼装；新增片段须在 scripts/gen-ui-min.mjs 的 ORDER 登记。
 */
export const UI_JS_PROBE = `  // ===== 服务探针：verdict 徽标 + 探针账本 =====
  var probeVerdicts = []
  var probeVsSig = ''
  // verdict 轮询（15s 档足够：结论只随探针运行变化）；签名去重，变了才重绘服务卡
  function pollProbe() {
    fetch('/_modeldock/probe/verdicts', { headers: { 'x-modeldock-lang': LANG } }).then(function (r) { return r.ok ? r.json() : null }).then(function (j) {
      if (!j || !j.verdicts) return
      var sig = JSON.stringify(j)
      if (sig === probeVsSig) return
      probeVsSig = sig
      probeVerdicts = j.verdicts
      if (view) renderServices()
    }).catch(function () {})
  }
  var VS_META = {
    healthy: { cls: 'ok', zh: '健康', en: 'Healthy' },
    degraded: { cls: 'warn', zh: '降级', en: 'Degraded' },
    quota: { cls: 'warn', zh: '额度', en: 'Quota' },
    'auth-dead': { cls: 'err', zh: '失效', en: 'Auth dead' },
    unreachable: { cls: 'err', zh: '不可达', en: 'Unreachable' },
    unverified: { cls: 'dim', zh: '未验证', en: 'Unverified' },
    stale: { cls: 'dim', zh: '过期', en: 'Stale' },
  }
  // 徽标取该服务全部结论里最差的一条（坏结论不该被健康结论盖住）；无结论不出徽标（缺席 ≠ 健康）
  var VS_RANK = { 'auth-dead': 6, unreachable: 5, quota: 4, degraded: 3, healthy: 2, unverified: 1, stale: 0 }
  function verdictBadgeHtml(pid) {
    var vs = probeVerdicts.filter(function (v) { return v.provider === pid })
    if (!vs.length || !view) return ''
    var worst = null
    for (var i = 0; i < vs.length; i++) {
      var v = vs[i]
      if (!worst || (VS_RANK[v.state] || 0) > (VS_RANK[worst.state] || 0)) worst = v
    }
    var m = VS_META[worst.state] || VS_META.unverified
    var ev = worst.evidence || {}
    var tip = t('来源 ', 'source ') + (ev.source || '-')
    if (ev.at) {
      var mins = Math.max(0, Math.round((Date.now() - ev.at) / 60000))
      tip += ' · ' + t('证据 ', 'evidence ') + (mins >= 60 ? Math.floor(mins / 60) + t(' 小时前', 'h ago') : mins + t(' 分钟前', 'm ago'))
    }
    if (ev.status != null) tip += ' · HTTP ' + ev.status
    if (ev.err) tip += ' · ' + ev.err
    if (vs.length > 1) tip += ' · ' + t('共 ', '') + vs.length + t(' 条结论，取最差', ' verdicts, worst shown')
    // 徽标即下钻入口（健康历史的最近邻动作：徽标=当前结论，点击看 30 天变化轴）；tip 尾部追加点按提示
    return ' <button type="button" class="pill ' + m.cls + '" data-probehist="' + esc(pid) + '" title="' + esc(tip + t('（点击查看健康变化历史）', ' (click to view health change history)')) + '">' + esc(t(m.zh, m.en)) + '</button>'
  }
  // 服务卡健康徽标下钻弹层（probe-ui-into-usage-health 任务 2）：读取类弹层，关路径三件套
  // （头部 × + Esc + closeOnScrim:true 遮罩，foot 只留 msg 槽，ui-kit §9 2026-11 修订口径）。
  // 数据沿用 trend 端点全量响应、客户端按 provider 过滤（端点契约冻结：探针翻转低频、30 天
  // 条目量级为几十条内，为单消费方加过滤参数属 API 面扩张，见 spec design §2.3 案 A）
  var probeSvcTimelineM = createModal({
    id: 'probeSvcTimelineOverlay',
    titleId: 'probeSvcTimelineTitle',
    align: 'top',
    modalClass: 'svcmodal',
    bodyHtml: '<p class="testline" data-i18n="加载中…||Loading…"></p>',
    closeOnScrim: true,
    foot: [
      { slot: 'msg', id: 'probeSvcTimelineMsg', kind: 'err' },
    ],
  })
  var probeSvcTrend = null // 最近一次 trend 响应缓存：模型过滤切换只重渲染、不重发请求
  function probeSvcPillHtml(state) {
    var meta = VS_META[state] || VS_META.unverified
    return '<span class="pill ' + meta.cls + '">' + esc(t(meta.zh, meta.en)) + '</span>'
  }
  function renderProbeSvcTimeline(pid, model) {
    var title = document.getElementById('probeSvcTimelineTitle')
    if (title) {
      var name = pid
      for (var i = 0; i < (view.services || []).length; i++) {
        if (view.services[i].id === pid) name = view.services[i].label
      }
      title.textContent = t('健康变化 · ', 'Health history · ') + name
    }
    var all = ((probeSvcTrend && probeSvcTrend.timeline) || []).filter(function (it) { return it.provider === pid && (!model || it.model === model) })
    var rows = ''
    if (!all.length) {
      rows = '<tr><td colspan="4" class="empty">' + esc(t('近 30 天无 verdict 变化', 'No verdict changes in the last 30 days')) + '</td></tr>'
    } else {
      for (var k = 0; k < all.length; k++) {
        var it = all[k]
        var d = new Date(it.at)
        var tm = d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2) + ' ' + ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2)
        // 「—」= 30 天窗口内首现（无前态可比）
        var changeHtml = it.from == null
          ? '<span class="dim">—</span> → ' + probeSvcPillHtml(it.to)
          : probeSvcPillHtml(it.from) + ' → ' + probeSvcPillHtml(it.to)
        rows += '<tr><td class="mono">' + tm + '</td>' +
          '<td title="' + esc(it.provider + '/' + it.model + ' @' + it.key_fp) + '"><span class="mono">' + esc(it.provider + '/' + it.model) + '</span> <span class="dim">@' + esc(it.key_fp) + '</span></td>' +
          '<td>' + changeHtml + '</td>' +
          '<td class="dim">' + esc(it.source) + '</td></tr>'
      }
    }
    // 模型选项 = 该服务条目 distinct model + 「全部模型」；选项按 provider 全集算、不受当前
    // 模型过滤收窄（收窄后「全部模型」就回不去了）
    var seen = {}
    var models = []
    var src = (probeSvcTrend && probeSvcTrend.timeline) || []
    for (var m = 0; m < src.length; m++) {
      if (src[m].provider === pid && !seen[src[m].model]) { seen[src[m].model] = true; models.push(src[m].model) }
    }
    var opts = '<option value="">' + esc(t('全部模型', 'All models')) + '</option>'
    for (var n = 0; n < models.length; n++) {
      opts += '<option value="' + esc(models[n]) + '"' + (models[n] === model ? ' selected' : '') + '>' + esc(models[n]) + '</option>'
    }
    probeSvcTimelineM.body.innerHTML =
      '<div class="row"><span class="help">' + esc(t('按模型过滤：', 'Filter by model: ')) + '</span><select id="probeSvcTimelineModelSel">' + opts + '</select></div>' +
      '<div class="tablescroll"><table id="probeSvcTimelineTable"><thead><tr><th>' + esc(t('时间', 'Time')) + '</th><th>' + esc(t('三元组', 'Triple')) + '</th><th>' + esc(t('变化', 'Change')) + '</th><th>' + esc(t('来源', 'Source')) + '</th></tr></thead><tbody>' + rows + '</tbody></table></div>'
    var sel = document.getElementById('probeSvcTimelineModelSel')
    if (sel) sel.addEventListener('change', function () { renderProbeSvcTimeline(pid, this.value) })
  }
  function loadProbeSvcTimeline(pid) {
    fetch('/_modeldock/probe/trend?days=30&months=6', { headers: { 'x-modeldock-lang': LANG } }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status)
      return r.json()
    }).then(function (j) {
      if (!j || !j.timeline) throw new Error('bad payload')
      probeSvcTrend = j
      renderProbeSvcTimeline(pid, '')
    }).catch(function (e) {
      var msg = document.getElementById('probeSvcTimelineMsg')
      if (msg) msg.textContent = t('时间线加载失败：', 'Failed to load health history: ') + ((e && e.message) || e)
    })
  }
  function openProbeSvcTimeline(pid) {
    probeSvcTimelineM.open()
    // 打开即拉取；重开先回加载占位——上一服务的旧表不得被误读成本服务数据
    probeSvcTimelineM.body.innerHTML = '<p class="testline">' + esc(t('加载中…', 'Loading…')) + '</p>'
    loadProbeSvcTimeline(pid)
  }
  // 探针自耗明细弹层（原「探针账本」，probe-ui-into-usage-health 任务 3 原地改造；入口收敛后由
  // #health 探针 pill 点击打开）：月度总花费 + 预算进度 + 按 probe_id 分解表（数据源
  // GET /_modeldock/probe/ledger，与 CLI provider test --ledger 同源）。读取类弹层：svcmodal
  // 680px 宽壳 + 关路径三件套（头部 × + Esc + closeOnScrim:true 遮罩），foot 只留 msg 槽——
  // 孤儿「刷新」消灭，新鲜度由打开即拉取 + pill 60s 轮询保证（ui-kit §9 2026-11 修订口径）
  var probeLedgerM = createModal({
    id: 'probeLedgerOverlay',
    title: '探针自耗||Probe self-usage',
    align: 'top',
    modalClass: 'svcmodal',
    bodyHtml: '<p class="testline" data-i18n="加载中…||Loading…"></p>',
    closeOnScrim: true,
    foot: [
      { slot: 'msg', id: 'probeLedgerMsg', kind: 'err' },
    ],
  })
  function loadProbeLedger() {
    fetch('/_modeldock/probe/ledger', { headers: { 'x-modeldock-lang': LANG } }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status)
      return r.json()
    }).then(function (j) {
      if (!j || !j.breakdown || !j.budget) throw new Error('bad payload')
      var bd = j.breakdown
      var bu = j.budget
      var pct = bu.budget > 0 ? Math.min(100, Math.round((bu.spent / bu.budget) * 100)) : 0
      var ids = Object.keys(bd.by_probe || {}).sort()
      var rows = ''
      if (!ids.length) {
        rows = '<tr><td colspan="3" class="empty">' + esc(t('本月暂无探针调用', 'No probe calls this month')) + '</td></tr>'
      } else {
        for (var i = 0; i < ids.length; i++) {
          var pid = ids[i]
          var lbl = j.probe_labels && j.probe_labels[pid] ? i18nPick(j.probe_labels[pid]) : pid
          var req = bd.by_probe_requests && bd.by_probe_requests[pid] != null ? bd.by_probe_requests[pid] : '-'
          rows += '<tr><td><span class="mono">' + esc(pid) + '</span> ' + esc(lbl) + '</td>' +
            '<td class="mono">' + esc(fmtTok(bd.by_probe[pid])) + '</td>' +
            '<td>' + req + '</td></tr>'
        }
      }
      var exhausted = bu.exhausted ? ' · <b class="hint-warn">' + esc(t('预算耗尽：探针硬停', 'Budget exhausted: probes hard-stop')) + '</b>' : ''
      probeLedgerM.body.innerHTML =
        '<p class="shint">' + esc(t('账期 ', 'Period ')) + esc(bd.month) +
        ' · ' + esc(t('月度总花费 ', 'Monthly spend ')) + '<b class="mono">' + esc(fmtTok(bd.total)) + '</b> tokens' +
        ' · ' + esc(t('预估 ', 'estimated ')) + esc(fmtTok(bd.estimated_total)) +
        ' · ' + bd.requests + esc(t(' 次调用', ' calls')) + '</p>' +
        '<p class="help">' + esc(t('探针花费记独立账本，不进请求日志与今日用量；tokens 为上游 usage 合计。', 'Probe spend is kept in a separate ledger, outside the request log and daily usage; tokens are upstream usage totals.')) + '</p>' +
        '<div class="progress" title="' + esc(t('月预算 ', 'Monthly budget ') + fmtTok(bu.budget)) + '"><div class="progress-fill" style="width:' + pct + '%"></div></div>' +
        '<p class="shint">' + esc(t('月预算 ', 'Monthly budget ')) + esc(fmtTok(bu.budget)) + ' · ' + esc(t('已用 ', 'spent ')) + esc(fmtTok(bu.spent)) + ' · ' + esc(t('剩余 ', 'remaining ')) + esc(fmtTok(bu.remaining)) + exhausted + '</p>' +
        '<div class="tablescroll"><table id="probeLedgerTable"><thead><tr><th>' + esc(t('探针', 'Probe')) + '</th><th>tokens</th><th>' + esc(t('调用', 'Calls')) + '</th></tr></thead><tbody>' + rows + '</tbody></table></div>'
    }).catch(function (e) {
      var msg = document.getElementById('probeLedgerMsg')
      if (msg) msg.textContent = t('账本加载失败：', 'Failed to load the ledger: ') + ((e && e.message) || e)
    })
  }
  function openProbeLedger() {
    probeLedgerM.open()
    // 重开先回加载占位：上一账期的旧表不得被误读为本月最新（打开即拉取，拉取完成才换新）
    probeLedgerM.body.innerHTML = '<p class="testline">' + esc(t('加载中…', 'Loading…')) + '</p>'
    loadProbeLedger()
  }

  // 探针自耗 pill（任务 3）：融进 #health 今日用量仪表（overview.ts healthHtml 在 usageHtml 后拼接）。
  // 数据来自下方 60s 低频缓存的账本响应，#health 三路重建点共用同一拼装函数即天然覆盖
  var probeLedgerLite = null // 最近一次 /probe/ledger 响应缓存：#health 每 5s 重建时即时拼 pill，不触发额外请求
  var probeLedgerLiteSig = '' // pill 相关字段签名：值没变不重建 #health（省无谓 DOM 写）
  function probeSelfUsageHtml() {
    var j = probeLedgerLite
    if (!j || !j.breakdown || !j.budget) return ''
    var bd = j.breakdown
    var bu = j.budget
    // 零值不出 pill：对齐 usageHtml「无流量不显示」先例，横幅不为空状态常驻占位
    if (!bd.requests && !bu.spent) return ''
    var tip = t('探针花费记独立账本，不进请求日志与今日用量；点击查看按探针明细与月预算余量', 'Probe spend is kept in a separate ledger, outside the request log and daily usage; click for per-probe breakdown and monthly budget headroom')
    // 预算耗尽升级 warn 语义色并在 title 追加硬停警示：探针预算闸已硬停，用户必须知道探针为何全挂
    if (bu.exhausted) tip += ' · ' + t('预算耗尽：探针硬停', 'Budget exhausted: probes hard-stop')
    return ' <button type="button" class="pill ' + (bu.exhausted ? 'warn' : 'dim') + '" id="probeSelfPill" title="' + esc(tip) + '">' +
      esc(t('探针本月 ', 'Probe this month ') + fmtTok(bd.total) + ' tokens · ' + t('预算余 ', 'budget left ') + fmtTok(bu.remaining)) + '</button>'
  }
  // 账本读侧是全文件同步读，不进 5s 热路径档；预算只在探针人工触发时变化，60s 足够
  // （对齐 refreshUpdStatus 60s 档写法）。失败静默：pill 缺席不报错，下一周期重试
  function pollProbeLedgerLite() {
    fetch('/_modeldock/probe/ledger', { headers: { 'x-modeldock-lang': LANG } }).then(function (r) { return r.ok ? r.json() : null }).then(function (j) {
      if (!j || !j.breakdown || !j.budget) return
      probeLedgerLite = j
      var sig = JSON.stringify([j.breakdown.total, j.breakdown.requests, j.budget.spent, j.budget.remaining, j.budget.exhausted])
      if (sig === probeLedgerLiteSig) return
      probeLedgerLiteSig = sig
      if (view) $('#health').innerHTML = healthHtml()
    }).catch(function () {})
  }
  // #health 被 pollHealth/pollLive/pollOverview 三路 5s 轮询整体重建 innerHTML：绑定挂在 pill
  // 自身每次重建都会丢，容器委托一次绑定（#health 元素本体不随重建替换）即三路重建不丢
  var healthBar = document.getElementById('health')
  if (healthBar) healthBar.addEventListener('click', function (e) {
    if (e.target && e.target.closest && e.target.closest('#probeSelfPill')) openProbeLedger()
  })

`
