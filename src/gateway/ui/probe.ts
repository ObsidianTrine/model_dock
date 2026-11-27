/**
 * Web 控制台 · probe.ts —— 服务探针（provider-probe-suite 任务 6）。
 * UI_JS_PROBE：verdict 徽标数据轮询 + 服务卡徽标渲染（异常才显 + 点击下钻，diag-modal-probe-ui
 * v2）+ 服务健康·诊断统一弹层（双入口：卡片「诊断」按钮落诊断动作区、徽标点击落当前结论/
 * 健康变化区；四段 = 延迟快照 / 当前结论 / 诊断动作 ping+P1+P14 两段式成本确认 / 预算与健康
 * 变化时间线）+ 探针自耗 pill（融进 #health 今日用量仪表）与其明细弹层（月度总花费/预算余量/
 * 按探针分解）。
 * 片段为模板字面量源文本：ui.ts 经 UI_JS_MIN 拼装；新增片段须在 scripts/gen-ui-min.mjs 的 ORDER 登记。
 */
export const UI_JS_PROBE = `  // ===== 服务探针：verdict 徽标 + 统一诊断弹层 =====
  var probeVerdicts = []
  var probeVsSig = ''
  var diagConfirmTokens = {} // 两段式成本确认的 confirmToken（probeId → token，来自第一段响应）
  // 徽标异常才显（diag-modal-probe-ui v2）：降级/额度/失效/不可达四态出徽标，健康/未验证/过期
  // 一律静默——服务卡 pill 语义统一为「异常态才显示」（熔断中/已下线同语言）；全量状态（含健康）
  // 只在诊断弹层「当前结论」区展示。轮询签名随之收敛为「服务 → 异常态集合」（经 badgePool 让位
  // 过滤）：evidence 刷新（at/ms/status 变化）不再触发整卡重绘，可见面真正变化（异常出现/消失/
  // 升级/被主动实证取代）才重绘
  var BADGE_STATES = { degraded: 1, quota: 1, 'auth-dead': 1, unreachable: 1 }
  // verdict 轮询（15s 档足够：结论只随探针运行变化）；签名去重，可见面变了才重绘服务卡
  function pollProbe() {
    fetch('/_modeldock/probe/verdicts', { headers: { 'x-modeldock-lang': LANG } }).then(function (r) { return r.ok ? r.json() : null }).then(function (j) {
      if (!j || !j.verdicts) return
      probeVerdicts = j.verdicts
      var sig = ''
      var byP = {}
      for (var i = 0; i < probeVerdicts.length; i++) {
        var v = probeVerdicts[i]
        ;(byP[v.provider] = byP[v.provider] || []).push(v)
      }
      for (var pid in byP) {
        var pool = badgePool(byP[pid])
        for (var j = 0; j < pool.length; j++) {
          if (BADGE_STATES[pool[j].state]) sig += pid + ':' + pool[j].state + '|'
        }
      }
      if (sig === probeVsSig) return
      probeVsSig = sig
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
  // 徽标取该服务全部结论里最差的一条（坏结论不该被健康结论盖住）；无结论不出徽标（缺席 ≠ 健康）；
  // 最差结论非异常态（healthy/unverified/stale）同样静默（BADGE_STATES）。
  // 旧账让位（2026-11-26 用户实证：换 key 重测健康后徽标仍失效）："-" 占位结论（被动 P15
  // provider 级，不带 key 归属）若已有「真实 key 指纹且证据更新」的同服务结论，则不参与最差
  // 排序——主动实证新于被动旧账，坏消息优先只在同代证据内比较；历史明细仍在诊断弹层全量可见
  var VS_RANK = { 'auth-dead': 6, unreachable: 5, quota: 4, degraded: 3, healthy: 2, unverified: 1, stale: 0 }
  function badgePool(vs) {
    return vs.filter(function (v) {
      var fp = v.key_fp
      if (fp && fp !== '-') return true
      var at = (v.evidence || {}).at || 0
      for (var j = 0; j < vs.length; j++) {
        var rfp = vs[j].key_fp
        if (rfp && rfp !== '-' && (((vs[j].evidence || {}).at || 0) > at)) return false
      }
      return true
    })
  }
  function verdictBadgeHtml(pid) {
    var vs = probeVerdicts.filter(function (v) { return v.provider === pid })
    if (!vs.length || !view) return ''
    var pool = badgePool(vs)
    if (!pool.length) return ''
    var worst = null
    for (var i = 0; i < pool.length; i++) {
      var v = pool[i]
      if (!worst || (VS_RANK[v.state] || 0) > (VS_RANK[worst.state] || 0)) worst = v
    }
    if (!BADGE_STATES[worst.state]) return ''
    var m = VS_META[worst.state] || VS_META.unverified
    var ev = worst.evidence || {}
    var tip = t('来源 ', 'source ') + (ev.source || '-')
    if (ev.at) {
      var mins = Math.max(0, Math.round((Date.now() - ev.at) / 60000))
      tip += ' · ' + t('证据 ', 'evidence ') + (mins >= 60 ? Math.floor(mins / 60) + t(' 小时前', 'h ago') : mins + t(' 分钟前', 'm ago'))
    }
    if (ev.status != null) tip += ' · HTTP ' + ev.status
    if (ev.err) tip += ' · ' + ev.err
    if (pool.length > 1) tip += ' · ' + t('共 ', '') + pool.length + t(' 条结论，取最差', ' verdicts, worst shown')
    // 徽标即下钻入口（健康历史的最近邻动作：徽标=当前结论，点击看 30 天变化轴）；tip 尾部追加点按提示
    return ' <button type="button" class="pill ' + m.cls + '" data-probehist="' + esc(pid) + '" title="' + esc(tip + t('（点击查看健康变化历史）', ' (click to view health change history)')) + '">' + esc(t(m.zh, m.en)) + '</button>'
  }
  // 服务健康·诊断统一弹层（diag-modal-probe-ui）：以读取为主 + 内嵌诊断动作。关路径三件套
  // （头部 × + Esc + closeOnScrim:true 遮罩，foot 只留 msg 槽，ui-kit §9 2026-11 修订口径）；
  // 错误一律写 msg 槽，禁 toast（磨砂遮罩会盖住 toast）。双入口落点：卡片「诊断」按钮 →
  // 诊断动作区；徽标点击 → 当前结论/健康变化区（徽标 tooltip 的承诺即「查看健康变化历史」）。
  // 健康历史两段加载（svc-timeline-lazy）：打开弹层只拉本服务最近 10 条（GET /probe/timeline，
  // 服务端按 provider 裁剪 + 尾部截取，不再整包下载全 provider 的 /probe/trend 响应——spend
  // 曲线本弹层不消费），点「展开全部」再拉全窗口（limit=0）
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
  var probeSvcTrend = null // 当前弹层服务的 timeline 缓存 {pid, rows, total, expanded}：模型过滤切换只重渲染、不重发请求
  var diagPid = null // 弹层当前服务的 id（诊断动作请求的 provider 参数）
  function diagSvcLabel(pid) {
    if (view) for (var i = 0; i < (view.services || []).length; i++) {
      if (view.services[i].id === pid) return view.services[i].label
    }
    return pid
  }
  function diagSvc(pid) {
    if (view) for (var i = 0; i < (view.services || []).length; i++) {
      if (view.services[i].id === pid) return view.services[i]
    }
    return null
  }
  function diagSvcPillHtml(state) {
    var meta = VS_META[state] || VS_META.unverified
    return '<span class="pill ' + meta.cls + '">' + esc(t(meta.zh, meta.en)) + '</span>'
  }
  // 延迟快照行：取该服务带 advisory.latency 的最新一条结论（P15 被动聚合，分位与错误分布同窗）
  function diagLatencyHtml(pid) {
    var best = null
    for (var i = 0; i < probeVerdicts.length; i++) {
      var v = probeVerdicts[i]
      if (v.provider !== pid || !v.advisory || !v.advisory.latency) continue
      var at = (v.evidence && v.evidence.at) || 0
      if (!best || at > (((best.evidence || {}).at) || 0)) best = v
    }
    if (!best) return ''
    var l = best.advisory.latency
    var src = (best.evidence && best.evidence.source) || '-'
    return '<p class="shint" title="' + esc(t('数据源：被动探针聚合真实请求日志的耗时分布（成功与失败同计，滚动窗口）。', 'Source: passive probe aggregates latency of real request-log entries (successes and failures alike) over a rolling window.')) + '">' +
      esc(t('真实流量延迟 ', 'Real-traffic latency ')) +
      '<b class="mono">p50 ' + (l.p50 == null ? '-' : l.p50 + 'ms') + '</b> · <b class="mono">p95 ' + (l.p95 == null ? '-' : l.p95 + 'ms') + '</b>（' + (l.n || 0) + esc(t(' 条）', ' samples)')) +
      ' · ' + esc(src) + '</p>'
  }
  // 当前结论区：逐三元组全量状态（健康也在列）——徽标静默后的唯一全量展示面
  function diagCurrentHtml(pid) {
    var vs = probeVerdicts.filter(function (v) { return v.provider === pid })
    if (!vs.length) {
      return '<p class="help">' + esc(t('暂无探针结论：还没有被动信号或主动探针记录，可点下方「运行」立即验证。', 'No probe verdicts yet: no passive signals or manual probe results; run a check below to verify now.')) + '</p>'
    }
    var rows = ''
    for (var i = 0; i < vs.length; i++) {
      var v = vs[i]
      var meta = VS_META[v.state] || VS_META.unverified
      var ev = v.evidence || {}
      var age = ''
      if (ev.at) {
        var mins = Math.max(0, Math.round((Date.now() - ev.at) / 60000))
        age = t('证据 ', 'evidence ') + (mins >= 60 ? Math.floor(mins / 60) + t(' 小时前', 'h ago') : mins + t(' 分钟前', 'm ago'))
      }
      rows += '<div class="curline">' + diagSvcPillHtml(v.state) +
        '<span class="mono">' + esc(v.model || '-') + ' @' + esc(v.key_fp || '-') + '</span>' +
        '<span class="cinfo">' + esc(age + (age && ev.source ? ' · ' : '') + (ev.source || '')) + '</span></div>'
      // 错误详情行（diag-err-copy）：非健康且有 evidence.err 的三元组补一行摘要——打开弹层
      // 不重跑也能看到上次失败原因；全文换行可见，点击复制（绑定在 openDiag 渲染后统一挂）
      if (v.state !== 'healthy' && ev.err) rows += '<div class="cureline">' + esc(ev.err) + '</div>'
    }
    return rows
  }
  // 预算行（数据源 /probe/ledger，与探针自耗 pill 共用 probeLedgerLite 缓存；打开弹层即拉新）
  function diagBudgetHtml() {
    var j = probeLedgerLite
    if (!j || !j.budget) return '<p class="shint">' + esc(t('探针账本加载中…', 'Probe ledger loading…')) + '</p>'
    var bd = j.breakdown || {}
    var bu = j.budget
    return '<p class="shint">' + esc(t('探针本月 ', 'Probe this month ')) + '<b class="mono">' + esc(fmtTok(bd.total || 0)) + '</b> tokens · ' +
      esc(t('月预算 ', 'monthly budget ')) + esc(fmtTok(bu.budget)) + ' · ' + esc(t('剩余 ', 'remaining ')) + esc(fmtTok(bu.remaining)) +
      (bu.exhausted ? ' · <b class="hint-warn">' + esc(t('预算耗尽：探针硬停', 'Budget exhausted: probes hard-stop')) + '</b>' : '') + '</p>'
  }
  function loadDiagBudget() {
    fetch('/_modeldock/probe/ledger', { headers: { 'x-modeldock-lang': LANG } }).then(function (r) { return r.ok ? r.json() : null }).then(function (j) {
      if (!j || !j.breakdown || !j.budget) return
      probeLedgerLite = j
      var el = document.getElementById('diagBudgetLine')
      if (el) el.innerHTML = diagBudgetHtml()
      diagPaidGuard()
    }).catch(function () {})
  }
  // 探测失败文案瘦身：api() 抛的「HTTP 5xx: {json}」里若有结构化 err/hint 就只取用这两段，
  // 避免整包 JSON 上屏（自 services.ts 迁入：卡片 data-ping handler 移除后唯一消费方在诊断动作区）
  function probeErrMsg(e) {
    var m = (e && e.message) || ''
    var i = m.indexOf('{')
    if (i >= 0) {
      try {
        var j = JSON.parse(m.slice(i))
        if (j && (j.err || j.hint)) return (j.err || '') + (j.hint ? (j.err ? ' → ' : '') + j.hint : '')
      } catch (e2) { /* 响应体不是 JSON，原样返回 */ }
    }
    return m
  }
  function diagSkipCopy(reason) {
    if (reason === 'budget-exhausted') return t('预算耗尽：探针已硬停（本月预算用完）', 'Budget exhausted: probes hard-stop (monthly budget spent)')
    if (reason === 'unconfirmed') return t('未确认花费', 'Spend not confirmed')
    if (reason === 'cooldown') return t('该服务探针冷却中（上游 429 负缓存 10 分钟）', 'Probe cooldown active for this service (10-minute backoff after upstream 429)')
    if (reason === 'no-key') return t('服务没有可用 key', 'Service has no usable key')
    if (reason === 'busy') return t('该服务已有探针在跑，稍后再试', 'A probe is already running for this service; retry later')
    if (reason === 'not-implemented') return t('该探针未实现', 'Probe not implemented')
    if (reason === 'disabled') return t('探针已被停用（[probe] enabled=false）', 'Probes are disabled ([probe] enabled=false)')
    return reason
  }
  // 探针运行结果 → 结果行（verdicts 空 = 全部被闸拦下，取首条 skip 原因；P14 附 TTFT/吞吐分位）
  function diagRunLine(r) {
    var vs = (r && r.verdicts) || []
    if (!vs.length) {
      var sk = (r && r.skipped) || []
      var reason = sk.length ? sk[0].reason : ((r && r.reason) || '')
      return { cls: 'err', text: '✗ ' + diagSkipCopy(reason) }
    }
    var v = vs[0]
    var meta = VS_META[v.state] || VS_META.unverified
    var ok = v.state === 'healthy'
    var parts = [(ok ? '✓ ' : '✗ ') + t(meta.zh, meta.en)]
    if (v.model) parts.push(v.model + ' @' + (v.key_fp || '-'))
    if (r && r.tokens != null) parts.push(r.tokens + ' tokens')
    var adv = v.advisory || {}
    if (adv.ttft_p50 != null) parts.push('TTFT p50 ' + adv.ttft_p50 + 'ms' + (adv.ttft_p95 != null ? ' · p95 ' + adv.ttft_p95 + 'ms' : ''))
    if (adv.tps_p50 != null) parts.push(t('吞吐 p50 ', 'throughput p50 ') + adv.tps_p50 + ' tok/s')
    if (v.evidence && v.evidence.err) parts.push(v.evidence.err)
    return { cls: ok ? 'ok' : 'err', text: parts.join(' · ') }
  }
  function diagActionsHtml(pid) {
    var noKey = !!(diagSvc(pid) && diagSvc(pid).hasKey === false)
    var noKeyTip = t('服务未配置 key，付费探针无法发请求', 'Service has no key configured; paid probes cannot send requests')
    function payBtn(id) {
      return '<button class="btn small" id="' + id + '"' + (noKey ? ' disabled title="' + esc(noKeyTip) + '"' : '') + '>' + esc(t('运行', 'Run')) + '</button>'
    }
    var html = ''
    html += '<div class="diagrow"><div class="dtop"><span class="dname">' + esc(t('纯网络延迟', 'Network ping')) + '</span>' +
      '<span class="dact"><span class="costchip free">' + esc(t('免费', 'Free')) + '</span>' +
      '<button class="btn small" id="diagPingBtn">' + esc(t('立即测量', 'Measure now')) + '</button></span></div>' +
      '<p class="ddesc">' + esc(t('不做模型请求、不需要 key，只测到服务地址的网络往返；用于区分「网络不通」与「API 报错」。', 'No model request and no key needed; measures the network round trip to the service address to tell network failures from API errors.')) + '</p>' +
      '<p class="dres" id="diagPingRes"></p></div>'
    html += '<div class="diagrow"><div class="dtop"><span class="dname">' + esc(t('鉴权回声', 'Auth echo')) + ' <span class="dim mono">P1</span></span>' +
      '<span class="dact"><span class="costchip">' + esc(t('预估 ≤200 tokens', '≤200 tokens est.')) + '</span>' + payBtn('diagP1Btn') + '</span></div>' +
      '<p class="ddesc">' + esc(t('发一次最小真实推理请求，验证 key 与推理链路是否有效。', 'Sends one minimal real inference request to verify the key and inference path.')) + '</p>' +
      '<div class="dconfirm" id="diagP1Confirm" hidden><span class="cest">' + esc(t('本次预估 ≤200 tokens，确认后发出并记入探针账本', '~200 tokens max; sent after confirmation and charged to the probe ledger')) + '</span>' +
      '<button class="btn small" id="diagP1Go">' + esc(t('确认花费', 'Confirm spend')) + '</button>' +
      '<button class="btn small" id="diagP1Cancel">' + esc(t('取消', 'Cancel')) + '</button></div>' +
      '<p class="dres" id="diagP1Res"></p></div>'
    html += '<div class="diagrow"><div class="dtop"><span class="dname">' + esc(t('性能画像', 'Performance profile')) + ' <span class="dim mono">P14</span></span>' +
      '<span class="dact"><span class="costchip">' + esc(t('预估 ≤10,000 tokens', '≤10,000 tokens est.')) + '</span>' + payBtn('diagP14Btn') + '</span></div>' +
      '<p class="ddesc">' + esc(t('5 轮流式小请求测首字延迟与吞吐（TTFT / tok·s 分位数），3 采样共识防抖动。', '5 streaming mini-requests measure first-token latency and throughput (TTFT / tok·s percentiles); 3-sample consensus absorbs jitter.')) + '</p>' +
      '<div class="dconfirm" id="diagP14Confirm" hidden><span class="cest">' + esc(t('本次预估 ≤10,000 tokens（共识采样实际最高约 3 倍），确认后发出并记入探针账本', '~10,000 tokens max (up to ~3x with consensus sampling); sent after confirmation and charged to the probe ledger')) + '</span>' +
      '<button class="btn small" id="diagP14Go">' + esc(t('确认花费', 'Confirm spend')) + '</button>' +
      '<button class="btn small" id="diagP14Cancel">' + esc(t('取消', 'Cancel')) + '</button></div>' +
      '<p class="dres" id="diagP14Res"></p></div>'
    return html
  }
  // 探针模型下拉行（probe-model-select）：显式值回显，未指定=「跟随默认模型」；选项 = 该服务
  // 模型表（贵模型可换成便宜模型当代表）。保存写在 bindDiag（onchange 即持久化，不走保存按钮）
  function diagProbeModelHtml(pid) {
    var s = diagSvc(pid)
    if (!s || !s.models || !s.models.length) return ''
    var opts = '<option value=""' + (s.probeModelExplicit ? '' : ' selected') + '>' + esc(t('跟随默认模型', 'Follow default model')) + '</option>'
    for (var i = 0; i < s.models.length; i++) {
      var m = s.models[i]
      var lbl = m.display_name && m.display_name !== m.id ? m.id + ' · ' + m.display_name : m.id
      opts += '<option value="' + esc(m.id) + '"' + (s.probeModelExplicit && s.probeModel === m.id ? ' selected' : '') + '>' + esc(lbl) + '</option>'
    }
    return '<span class="help"><b>' + esc(t('探针模型', 'Probe model')) + '</b></span>' +
      '<select id="diagProbeModelSel">' + opts + '</select>' +
      '<span class="help">' + esc(t('探针与被动聚合用它代表本服务，保存即生效', 'Probes and passive aggregation use it to represent this service; saved at once')) + '</span>'
  }
  function diagBodyHtml(pid) {
    return '<div id="diagSecHealth">' +
      diagLatencyHtml(pid) +
      '<div class="sechead"><b>' + esc(t('当前结论', 'Current verdicts')) + '</b><span class="help">' + esc(t('逐三元组全量状态（健康也在列）——服务卡徽标已改异常才显，这里是唯一全量展示面', 'Full per-triple states (healthy included) — card badges surface anomalies only, so this is the only full view')) + '</span></div>' +
      '<div id="diagCurrentBox">' + diagCurrentHtml(pid) + '</div>' +
      '</div>' +
      '<div class="divider"></div>' +
      '<div id="diagSecActions">' +
      '<div class="row">' + diagProbeModelHtml(pid) + '</div>' +
      '<div class="sechead"><b>' + esc(t('诊断动作', 'Diagnostics')) + '</b><span class="help">' + esc(t('按成本分层：免费动作即时执行；付费动作先确认后发出并记入探针账本', 'Tiered by cost: free actions run at once; paid actions require confirmation and are charged to the probe ledger')) + '</span></div>' +
      diagActionsHtml(pid) +
      '<div id="diagBudgetLine">' + diagBudgetHtml() + '</div>' +
      '</div>' +
      '<div class="divider"></div>' +
      '<div id="diagTrendBox"><p class="testline" data-i18n="加载中…||Loading…"></p></div>'
  }
  function diagSetRes(id, line) {
    var el = document.getElementById(id)
    if (!el) return
    el.className = 'dres' + (line && line.cls ? ' ' + line.cls : '') + (line && line.text ? ' copyable' : '')
    el.textContent = line ? line.text : ''
    // 整行点击复制（diag-err-copy，先例=服务卡延迟结果行）：换行放开后全文可见，仍提供一键
    // 拷贝完整组合行（状态·模型·tokens·err 全文）；复制成功反馈=文案翻转「✓ 已复制」1.6s
    // （kit 规约：弹层内复制反馈不走 toast 不走槽位）
    if (line && line.text) {
      el._full = line.text
      el.title = line.text
      el.onclick = function () {
        if (el._copied) return
        el._copied = true
        copyText(el._full, function () {
          el.textContent = '✓ ' + t('已复制', 'Copied')
          setTimeout(function () { el.textContent = el._full; el._copied = false }, 1600)
        })
      }
    } else {
      el._full = ''
      el.title = ''
      el.onclick = null
    }
  }
  function diagBtnBusy(id, on, label) {
    var b = document.getElementById(id)
    if (!b) return
    if (on) { b._t = b.textContent; b.disabled = true; b.textContent = label }
    else { b.disabled = false; if (b._t) b.textContent = b._t }
  }
  function diagFoot(msg, ok) {
    var el = document.getElementById('probeSvcTimelineMsg')
    if (!el) return
    el.textContent = msg || ''
    el.className = ok ? 'testline ok' : 'mferr'
  }
  // 预算耗尽时禁用付费动作（loadDiagBudget 拉到账本后复核一次；no-key 禁用在 markup 侧已带）
  function diagPaidGuard() {
    var j = probeLedgerLite
    if (!(j && j.budget && j.budget.exhausted)) return
    var ids = ['diagP1Btn', 'diagP14Btn']
    for (var i = 0; i < ids.length; i++) {
      var b = document.getElementById(ids[i])
      if (b) { b.disabled = true; b.title = t('预算耗尽：探针硬停', 'Budget exhausted: probes hard-stop') }
    }
  }
  function bindDiag(pid) {
    var pb = document.getElementById('diagPingBtn')
    if (pb) pb.onclick = function () {
      diagSetRes('diagPingRes', null)
      diagBtnBusy('diagPingBtn', true, t('测量中…', 'Measuring…'))
      api('/test', { method: 'POST', body: JSON.stringify({ provider: pid, mode: 'ping' }) })
        .then(function (r) {
          diagBtnBusy('diagPingBtn', false, t('立即测量', 'Measure now'))
          diagSetRes('diagPingRes', r && r.ok
            ? { cls: 'ok', text: '✓ ' + t('延迟 ', 'latency ') + (r.ms != null ? r.ms : '?') + 'ms' }
            : { cls: 'err', text: '✗ ' + t('网络不通 ', 'unreachable ') + ((r && r.err) || '') + (r && r.hint ? ' → ' + r.hint : '') })
        })
        .catch(function (e) {
          diagBtnBusy('diagPingBtn', false, t('立即测量', 'Measure now'))
          diagSetRes('diagPingRes', { cls: 'err', text: '✗ ' + t('探测失败：', 'Ping failed: ') + probeErrMsg(e) })
        })
    }
    // 两段式成本确认（POST /probe/run 原生协议）：第一段无 token 只出预估与 confirmToken（零上游
    // 请求），「确认花费」带 token 重发才执行；结果写行内 dres，预算行随之刷新
    function diagStage1(btnId, probeId, confId, resId) {
      diagFoot('')
      diagSetRes(resId, null)
      diagBtnBusy(btnId, true, t('检测中…', 'Checking…'))
      api('/probe/run', { method: 'POST', timeoutMs: 120000, body: JSON.stringify({ provider: pid, probes: [probeId] }) })
        .then(function (r) {
          diagBtnBusy(btnId, false, t('运行', 'Run'))
          if (r && r.needConfirm) {
            diagConfirmTokens[probeId] = r.confirmToken || ''
            var conf = document.getElementById(confId)
            if (conf) conf.hidden = false
            diagFoot(t('等待确认：确认后才发上游请求并记账', 'Awaiting confirmation: the upstream request is only sent and charged after you confirm'))
            return
          }
          diagRunApply(r, resId) // 无 token 恒 needConfirm，此分支只是契约兜底
        })
        .catch(function (e) {
          diagBtnBusy(btnId, false, t('运行', 'Run'))
          diagSetRes(resId, { cls: 'err', text: '✗ ' + probeErrMsg(e) })
        })
    }
    function diagRunApply(r, resId) {
      var line = diagRunLine(r)
      diagSetRes(resId, line)
      if (line.cls === 'ok') diagFoot(t('✓ 已记入探针账本', '✓ Charged to the probe ledger'), true)
    }
    function diagStage2(btnId, probeId, confId, resId) {
      var conf = document.getElementById(confId)
      if (conf) conf.hidden = true
      diagFoot('')
      diagSetRes(resId, null)
      diagBtnBusy(btnId, true, t('检测中…', 'Checking…'))
      // 轮次进度（p14-progress）：P14 同步跑 5 轮耗时 15~30s+，只有静态「检测中…」易被当成
      // 卡死。前端生成 runId 随运行请求带上，POST 在飞期间 800ms 轮询引擎进度刷新按钮文案；
      // 结果返回/出错即停。直接改 textContent 不走 diagBtnBusy——它每次把当前文案存进 _t，
      // 轮询刷新会污染最终恢复文案。旧网关无端点（非 200）静默保持「检测中…」
      var rid = Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
      var poll = null
      var stopPoll = function () { if (poll) { clearInterval(poll); poll = null } }
      if (probeId === 'p14') {
        poll = setInterval(function () {
          fetch('/_modeldock/probe/run-progress?run=' + rid, { headers: { 'x-modeldock-lang': LANG } }).then(function (r) { return r.ok ? r.json() : null }).then(function (j) {
            if (!j || !j.active || !j.rounds) return
            var b = document.getElementById(btnId)
            if (b && b.disabled) b.textContent = t('检测中 · 第 ', 'Checking · round ') + j.round + '/' + j.rounds + t(' 轮', '')
          }).catch(function () { stopPoll() })
        }, 800)
      }
      // timeoutMs 放宽到 120s（diag-run-timeout）：P14 一次串行跑 5 轮流式请求，思考型模型
      // （如 glm-5-3-flash，不支持关思考）单轮 3~6s，5 轮 15~30s 必撞 api() 默认 15s 上限；
      // 引擎侧无 15s 限制（空闲上限 10min），放宽后正常完成
      api('/probe/run', { method: 'POST', timeoutMs: 120000, body: JSON.stringify({ provider: pid, probes: [probeId], confirmToken: diagConfirmTokens[probeId] || '', runId: rid }) })
        .then(function (r) {
          stopPoll()
          diagBtnBusy(btnId, false, t('运行', 'Run'))
          diagRunApply(r, resId)
          loadDiagBudget()
          pollProbe() // 运行产出新证据：立即刷一次 verdict（徽标/当前结论随后跟上）
        })
        .catch(function (e) {
          stopPoll()
          diagBtnBusy(btnId, false, t('运行', 'Run'))
          var msg = probeErrMsg(e)
          // 超时不等于失败：客户端断开后引擎仍在后台跑完，结论稍后照常落库——别让用户以为白跑
          if (/请求超时|Request timed out/.test(msg)) {
            msg += t('（引擎仍在后台运行，结论稍后出现在「当前结论」区）', ' (the engine keeps running in the background; the verdict will appear under Current verdicts shortly)')
          }
          diagSetRes(resId, { cls: 'err', text: '✗ ' + msg })
        })
    }
    function wirePaid(btnId, probeId, confId, goId, cancelId, resId) {
      var runB = document.getElementById(btnId)
      if (!runB) return
      runB.onclick = function () {
        if (runB.disabled) return
        diagStage1(btnId, probeId, confId, resId)
      }
      var go = document.getElementById(goId)
      if (go) go.onclick = function () { diagStage2(btnId, probeId, confId, resId) }
      var cancel = document.getElementById(cancelId)
      if (cancel) cancel.onclick = function () {
        var conf = document.getElementById(confId)
        if (conf) conf.hidden = true
        diagFoot('')
      }
    }
    // 探针模型下拉（probe-model-select）：onchange 即持久化（写 provider.probe_model；选
    // 「跟随默认模型」= 空值清除字段回随默认）。成功反馈写弹层底栏 msg 槽（弹层开着不走全局
    // toast），失败回弹旧值；_saved 记最近落盘值——打开时是显式值或空（未指定），保存成功才前移
    var pmSel = document.getElementById('diagProbeModelSel')
    if (pmSel) {
      var s0 = diagSvc(pid)
      pmSel._saved = s0 && s0.probeModelExplicit ? s0.probeModel : ''
      // 显式设值：markup 的 selected 属性在部分环境（happy-dom）回读不稳，JS 设值跨环境确定性
      pmSel.value = pmSel._saved
      pmSel.onchange = function () {
        var v = pmSel.value
        pmSel.disabled = true
        diagFoot('')
        api('/service/update', { method: 'POST', body: JSON.stringify({ provider: pid, probe_model: v }) })
          .then(function () {
            pmSel.disabled = false
            pmSel._saved = v
            var s = diagSvc(pid)
            if (s) { s.probeModelExplicit = !!v; s.probeModel = v || s.probeModel }
            diagFoot('✓ ' + t('已保存，手动与周期探针、被动聚合立即用它', 'Saved; manual and scheduled probes and passive aggregation use it at once'), true)
            pollProbe() // 结论三元组随模型变化：立即刷一次 verdict（徽标/当前结论随后跟上）
          })
          .catch(function (e) {
            pmSel.disabled = false
            pmSel.value = pmSel._saved
            diagFoot(t('探针模型保存失败：', 'Failed to save probe model: ') + probeErrMsg(e))
          })
      }
    }
    wirePaid('diagP1Btn', 'p1', 'diagP1Confirm', 'diagP1Go', 'diagP1Cancel', 'diagP1Res')
    wirePaid('diagP14Btn', 'p14', 'diagP14Confirm', 'diagP14Go', 'diagP14Cancel', 'diagP14Res')
  }
  function renderProbeSvcTimeline(pid, model) {
    var box = document.getElementById('diagTrendBox')
    if (!box) return
    // 数据 = 本服务 timeline 缓存（端点已按 provider 裁剪，不再客户端过滤）；缓存不匹配当前
    // 服务时按空数据处理（重开弹层会重新拉取，旧服务数据不得误读为本服务）
    var data = probeSvcTrend && probeSvcTrend.pid === pid ? probeSvcTrend : { pid: pid, rows: [], total: 0, expanded: false }
    var all = (data.rows || []).filter(function (it) { return !model || it.model === model })
    // 最新在上（引擎 at 升序 → 渲染倒序）：诊断弹层核心问题是「最近发生了什么」，截断态
    // 更要保证最新结论在顶、不用滚动就能看到
    all.reverse()
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
          ? '<span class="dim">—</span> → ' + diagSvcPillHtml(it.to)
          : diagSvcPillHtml(it.from) + ' → ' + diagSvcPillHtml(it.to)
        rows += '<tr><td class="mono" title="' + esc(it.at) + '">' + tm + '</td>' +
          '<td title="' + esc(it.provider + '/' + it.model + ' @' + it.key_fp) + '"><span class="mono">' + esc(it.provider + '/' + it.model) + '</span> <span class="dim">@' + esc(it.key_fp) + '</span></td>' +
          '<td>' + changeHtml + '</td>' +
          '<td class="dim">' + esc(it.source) + '</td></tr>'
      }
    }
    // 模型选项 = 已加载条目（截断态=最近 10 条；展开后=全窗口）distinct model + 「全部模型」；
    // 选项不受当前模型过滤收窄（收窄后「全部模型」就回不去了）
    var seen = {}
    var models = []
    var src = data.rows || []
    for (var m = 0; m < src.length; m++) {
      if (!seen[src[m].model]) { seen[src[m].model] = true; models.push(src[m].model) }
    }
    var opts = '<option value="">' + esc(t('全部模型', 'All models')) + '</option>'
    for (var n = 0; n < models.length; n++) {
      opts += '<option value="' + esc(models[n]) + '"' + (models[n] === model ? ' selected' : '') + '>' + esc(models[n]) + '</option>'
    }
    // 截断态且窗口内还有更多（total > 已加载条数）→ 出「展开全部」按钮，点击拉全窗口重渲染；
    // 展开态不再出。加载两段化（svc-timeline-lazy）：打开只拉最近 10 条小响应，展开才拉全量
    var expandHtml = ''
    if (!data.expanded && data.total > (data.rows || []).length) {
      expandHtml = '<div class="row"><button type="button" class="btn small" id="probeSvcTimelineExpand">' +
        esc(t('展开全部 ', 'Show all ')) + data.total + esc(t(' 条', ' entries')) + '</button></div>'
    }
    box.innerHTML =
      '<div class="row"><span class="help">' + esc(t('按模型过滤：', 'Filter by model: ')) + '</span><select id="probeSvcTimelineModelSel">' + opts + '</select></div>' +
      '<div class="tablescroll"><table id="probeSvcTimelineTable"><thead><tr><th>' + esc(t('时间', 'Time')) + '</th><th>' + esc(t('三元组', 'Triple')) + '</th><th>' + esc(t('变化', 'Change')) + '</th><th>' + esc(t('来源', 'Source')) + '</th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
      expandHtml +
      '<p class="help">' + esc(t('健康变化只在结论翻转时记录；结论由真实流量聚合与手动探针共同刷新。', 'Health history records verdict flips only; verdicts refresh from real-traffic aggregation and manual probes.')) + '</p>'
    var sel = document.getElementById('probeSvcTimelineModelSel')
    if (sel) sel.addEventListener('change', function () { renderProbeSvcTimeline(pid, this.value) })
    var exp = document.getElementById('probeSvcTimelineExpand')
    if (exp) exp.addEventListener('click', function () { loadProbeSvcTimeline(pid, 0, model) })
  }
  // limit=10 打开加载 / limit=0 展开全量（keepModel=展开前的模型过滤，重渲染保持选中）
  function loadProbeSvcTimeline(pid, limit, keepModel) {
    fetch('/_modeldock/probe/timeline?provider=' + encodeURIComponent(pid) + '&limit=' + limit, { headers: { 'x-modeldock-lang': LANG } }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status)
      return r.json()
    }).then(function (j) {
      if (!j || !j.timeline) throw new Error('bad payload')
      probeSvcTrend = { pid: pid, rows: j.timeline, total: j.total != null ? j.total : j.timeline.length, expanded: limit === 0 }
      renderProbeSvcTimeline(pid, keepModel || '')
    }).catch(function (e) {
      var msg = document.getElementById('probeSvcTimelineMsg')
      if (msg) msg.textContent = t('时间线加载失败：', 'Failed to load health history: ') + ((e && e.message) || e)
    })
  }
  function openDiag(pid, section) {
    diagPid = pid
    var titleEl = document.getElementById('probeSvcTimelineTitle')
    if (titleEl) titleEl.textContent = t('服务健康 · ', 'Service health · ') + diagSvcLabel(pid)
    probeSvcTimelineM.open()
    // 打开即渲染静态区段（快照/结论/动作/预算缓存）+ 拉取健康历史（最近 10 条）与最新预算；
    // 重开整体重建——上一服务的旧内容不得被误读成本服务数据
    probeSvcTimelineM.body.innerHTML = diagBodyHtml(pid)
    // 错误详情行（.cureline）点击复制全文（diag-err-copy）：textContent 即落库 err 全文
    // （verdict 层 ≤400 字符摘要），反馈同 .dres 文案翻转；重开整体重建后随渲染重绑
    Array.prototype.forEach.call(probeSvcTimelineM.body.querySelectorAll('.cureline'), function (el) {
      el.onclick = function () {
        if (el._copied) return
        el._copied = true
        var full = el.textContent
        copyText(full, function () {
          el.textContent = '✓ ' + t('已复制', 'Copied')
          setTimeout(function () { el.textContent = full; el._copied = false }, 1600)
        })
      }
    })
    bindDiag(pid)
    loadDiagBudget()
    loadProbeSvcTimeline(pid, 10, '')
    var anchor = document.getElementById(section === 'actions' ? 'diagSecActions' : 'diagSecHealth')
    if (anchor && anchor.scrollIntoView) {
      try { anchor.scrollIntoView({ block: 'start' }) } catch (e2) { /* 无滚动几何的环境忽略 */ }
    }
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
    // 零消耗不出 pill（slim-probe-pill）：tokens=0 即无自耗——旧口径「有过调用就显示」让
    // 0-token 调用（上游未回 usage 按 0 记）也常驻占位；预算耗尽例外，硬停警示必须常驻。
    // 完整信息在悬浮提示与点击弹层（明细分解 + 月预算），横幅只留最短信号
    if (!bd.total && !bu.exhausted) return ''
    var tip = t('探针花费记独立账本，不进请求日志与今日用量；点击查看按探针明细与月预算余量', 'Probe spend is kept in a separate ledger, outside the request log and daily usage; click for per-probe breakdown and monthly budget headroom')
    // 预算耗尽升级 warn 语义色并在 title 追加硬停警示：探针预算闸已硬停，用户必须知道探针为何全挂
    if (bu.exhausted) tip += ' · ' + t('预算耗尽：探针硬停', 'Budget exhausted: probes hard-stop')
    return ' <button type="button" class="pill ' + (bu.exhausted ? 'warn' : 'dim') + '" id="probeSelfPill" title="' + esc(tip) + '">' +
      esc(t('探针 ', 'Probe ') + fmtTok(bd.total) + ' · ' + t('余 ', 'left ') + fmtTok(bu.remaining)) + '</button>'
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
