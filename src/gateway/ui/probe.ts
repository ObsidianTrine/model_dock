/**
 * Web 控制台 · probe.ts —— 服务探针（provider-probe-suite 任务 6）。
 * UI_JS_PROBE：verdict 徽标数据轮询 + 服务卡徽标渲染 + 探针账本弹层（月度总花费/预算余量/按探针分解）。
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
    return ' <span class="pill ' + m.cls + '" title="' + esc(tip) + '">' + esc(t(m.zh, m.en)) + '</span>'
  }
  // 探针账本弹层：月度总花费 + 预算进度 + 按 probe_id 分解表（数据源 GET /_modeldock/probe/ledger，
  // 与 CLI provider test --ledger 同源）；每次打开/刷新都现取现渲染
  var probeLedgerM = createModal({
    id: 'probeLedgerOverlay',
    title: '探针账本||Probe ledger',
    align: 'top',
    bodyHtml: '<p class="testline" data-i18n="加载中…||Loading…"></p>',
    foot: [
      { slot: 'msg', id: 'probeLedgerMsg', kind: 'err' },
      { id: 'probeLedgerRefresh', label: '刷新||Refresh', onClick: function () { loadProbeLedger() } },
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
    loadProbeLedger()
  }
  var probeLedgerBtn = document.getElementById('probeLedgerBtn')
  if (probeLedgerBtn) probeLedgerBtn.onclick = openProbeLedger

`
