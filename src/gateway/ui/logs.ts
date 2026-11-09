/**
 * Web 控制台 · logs.ts —— 由单文件 ui.ts 按域拆分（T04 Phase 1，行为零变化）。
 * UI_JS_LOGS：日志页：筛选 tab/分页/全行复制/复制本页/签名去抖重建
 * 片段为模板字面量源文本：ui.ts 按原次序拼装后与拆分前逐字节一致；勿改动片段内换行/转义/次序。
 */
export const UI_JS_LOGS = `  var logsLastGood = ''
  var logPageEntries = [] // 当前页渲染行的原始条目（请求/操作/事件全含），供行复制与「复制本页」按索引取用
  var logsFailStreak = 0
  var logsLastSig = '' // 上次成功响应的整体签名：没变化就跳过整表重建（否则每 5s 白重建一次，打断选中文本/复制）
  // 分页状态：page 从 1 数起（服务端第 1 页 = 最新 n 条）；每页条数与筛选 tab 都记忆在 localStorage
  var logPage = 1
  var logPages = 1
  var logPageSize = Number(localStorage.getItem('mdk_log_size')) || 10
  if ([10, 30, 50, 100].indexOf(logPageSize) === -1) logPageSize = 10
  $('#logPageSize').value = String(logPageSize)
  // 筛选 tab：err=错误请求+事件（默认）/ audit=控制台操作 / all=ring 全部 / ok=成功请求小缓冲。
  // err/audit 是服务端过滤（kind 参数，分页计数按过滤后口径，不翻稀页）；ok 走独立缓冲（src=ok）
  var logTab = localStorage.getItem('mdk_log_tab') || 'err'
  if (['err', 'audit', 'all', 'ok'].indexOf(logTab) === -1) logTab = 'err'
  function logApplyTab() {
    Array.prototype.forEach.call(document.querySelectorAll('#logTabs button'), function (b) {
      b.className = b.getAttribute('data-lt') === logTab ? 'on' : ''
    })
  }
  logApplyTab()
  // 错误归类短码 → 可读文案（服务端只写码不固化语言，显示文案前端按界面语言映射）
  function logCauseLabel(code) {
    switch (code) {
      case 'proto_endpoint_missing': return t('协议端点缺失', 'missing protocol endpoint')
      case 'key_pool_empty': return t('无可用 key', 'no usable key')
      case 'key_cooldown': return t('key 冷却中', 'keys cooling down')
      case 'key_pool_rejected': return t('key 被上游拒绝', 'keys rejected upstream')
      case 'queue_full': return t('并发排队超时', 'concurrency queue timeout')
      case 'connect_failed': return t('连接失败', 'connection failed')
      case 'headers_timeout': return t('响应头超时', 'response headers timeout')
      case 'quota': return t('额度耗尽', 'quota exhausted')
      case 'upstream_4xx': return t('上游 4xx', 'upstream 4xx')
      case 'upstream_5xx': return t('上游 5xx', 'upstream 5xx')
      case 'unauthorized': return t('认证失败', 'unauthorized')
      case 'local_limit': return t('触发本地限额', 'local token limit')
      case 'client_abort': return t('客户端断开', 'client disconnected')
      case 'stream_interrupt': return t('流中断', 'stream interrupted')
      case 'skip_all': return t('全部候选不可用', 'all candidates unavailable')
      case 'down_all': return t('全部候选连接失败', 'all candidates failed to connect')
      default: return code || ''
    }
  }
  // 改发链摘要：如「bigmodel 跳过(协议端点缺失) → coding-plan 404」；无 attempts 回退 cause 短码标签
  function logChainText(l, withMs) {
    var att = l.attempts
    if (att && att.length) {
      var parts = []
      for (var i = 0; i < att.length; i++) {
        var a = att[i]
        var s = a.provider
        if (a.note) s += ' ' + t('跳过', 'skipped') + '(' + logCauseLabel(a.note) + ')'
        else if (a.status != null) s += ' ' + a.status
        if (withMs && a.ms != null) s += ' (' + a.ms + 'ms)'
        parts.push(s)
      }
      return parts.join(' → ')
    }
    return l.cause ? logCauseLabel(l.cause) : ''
  }
  // 行复制（每行都有 ⧉）：请求行=人类可读摘要+关键字段（含链路/根因/建议/用量）；操作行=动作+目标+摘要
  function logCopyText(l) {
    if (l.kind === 'audit') {
      function apick(f) { return LANG === 'en' && l[f + '_en'] != null ? l[f + '_en'] : l[f] }
      var alines = [
        t('时间', 'Time') + ': ' + String(l.ts || '').slice(11, 19),
        t('控制台操作', 'Operation') + ': ' + (apick('op') || '-'),
        t('目标', 'Target') + ': ' + (apick('target') || '-'),
        t('结果', 'Result') + ': ' + (l.ok !== false ? t('成功', 'ok') : t('失败', 'failed')),
        t('来源', 'Source') + ': ' + (l.source || '-'),
      ]
      var det = apick('detail')
      if (det) alines.push(t('详情', 'Detail') + ': ' + det)
      var aerr = apick('err')
      if (aerr) alines.push(t('错误', 'Error') + ': ' + aerr)
      return alines.join('\\n')
    }
    var lines = [
      t('时间', 'Time') + ': ' + String(l.ts || '').slice(11, 19),
      t('客户端', 'Client') + ': ' + (l.harness || '-'),
      t('路由', 'Profile') + ': ' + (l.profile || '-'),
      t('服务', 'Provider') + ': ' + (l.provider || '-'),
      t('模型', 'Model') + ': ' + (l.model || '-'),
      t('路径', 'Path') + ': ' + (l.path || '-'),
      t('状态', 'Status') + ': ' + (l.status == null ? '-' : l.status),
      t('耗时', 'Took') + ': ' + (l.ms == null ? '-' : l.ms + 'ms'),
    ]
    if (l.reason) lines.push(t('改发', 'Reroute') + ': ' + l.reason)
    var chain = logChainText(l, true)
    if (chain) lines.push(t('链路', 'Chain') + ': ' + chain)
    if (l.cause) lines.push(t('根因', 'Cause') + ': ' + logCauseLabel(l.cause))
    if (l.hint) lines.push(t('建议', 'Fix') + ': ' + l.hint)
    if (l.err) lines.push(t('错误', 'Error') + ': ' + l.err)
    if (l.usage) lines.push(t('用量', 'Usage') + ': ' + t('输入', 'in') + ' ' + l.usage.input_tokens + ' / ' + t('输出', 'out') + ' ' + l.usage.output_tokens + ' (' + t('缓存读', 'cache read') + ' ' + l.usage.cache_read_tokens + ')')
    return lines.join('\\n')
  }
  function bindLogCopy() {
    Array.prototype.forEach.call(document.querySelectorAll('#logTable .lcopy'), function (b) {
      b.onclick = function () {
        var l = logPageEntries[Number(b.getAttribute('data-li'))]
        if (!l) return
        copyText(logCopyText(l), function () { b.innerHTML = icon('check', 11); setTimeout(function () { b.innerHTML = icon('copy', 12) }, 1200) })
      }
    })
  }
  function loadLogs(retried) {
    var qs = '/logs?n=' + logPageSize + '&page=' + logPage
    if (logTab === 'ok') qs += '&src=ok'
    else if (logTab === 'err') qs += '&kind=err'
    else if (logTab === 'audit') qs += '&kind=audit'
    api(qs).then(function (j) {
      var logs = (j.logs || []).slice().reverse()
      var total = j.total || 0
      logPages = j.pages || Math.max(1, Math.ceil(total / logPageSize))
      // 环形缓冲滚动挤掉了旧记录导致当前页越界时，退回最后一页再取一次
      if (!retried && logPage > logPages) { logPage = logPages; loadLogs(true); return }
      // 响应与上次完全一致则不动 DOM（与 load() 的 stringify diff 同款）：分页文案/滚动位置/选中态都保住
      var sig = JSON.stringify(j)
      if (!retried && sig === logsLastSig) { logsFailStreak = 0; return }
      logsLastSig = sig
      logPageEntries = []
      var rows = logs.map(function (l) {
        var bad = l.status >= 400 || !!l.err
        // 双语条目按界面语言取字段（服务端审计条目存 op_en/detail_en/err_en；旧条目缺省回退主字段）
        function pick(f) { return LANG === 'en' && l[f + '_en'] != null ? l[f + '_en'] : l[f] }
        var copyBtn = '<button type="button" class="lcopy" data-li="' + logPageEntries.length + '" title="' + t('复制日志详情', 'Copy log details') + '">' + icon('copy', 12) + '</button>'
        logPageEntries.push(l)
        if (l.kind === 'audit') {
          // 操作审计行：齿轮图标 操作名 | 目标 | 变更摘要 | 成功/失败
          var ok = l.ok !== false
          var opTxt = pick('op') || t('操作', 'op')
          var detTxt = pick('detail') || ''
          var errTxt = pick('err') || ''
          return '<tr><td class="muted mono">' + esc((l.ts || '').slice(11, 19)) + '</td>' +
            '<td>' + iconInline('gear', 12) + ' ' + esc(opTxt) + '</td>' +
            '<td><div>' + esc(pick('target') || '-') + '</div></td>' +
            '<td class="muted" title="' + esc(detTxt) + '"><div>' + esc(detTxt) + '</div></td>' +
            '<td class="' + (ok ? 'st-ok' : 'st-err') + '" title="' + esc(ok ? t('成功', 'ok') : t('失败', 'failed')) + '">' + iconInline(ok ? 'check' : 'close', 13) + '</td>' +
            '<td>-</td>' +
            '<td class="muted" title="' + esc(errTxt) + '"><div>' + esc(errTxt.slice(0, 60)) + '</div></td>' +
            '<td>' + copyBtn + '</td></tr>'
        }
        // 错误列两行化：第一行=改发链摘要（如 bigmodel 跳过(协议端点缺失) → coding-plan 404）或根因短码，
        // 第二行=可操作建议（hint，title 挂自身——悬浮可见被截断的建议）；原始 err 收进 title 悬浮与复制内容。
        // 各分支一律包 div：CSS 对 td:nth-child(7)>div 做定宽单行省略（last-child 已是复制列，吃不到截断规则）
        var chain = logChainText(l, false)
        var reqErr = pick('err') || ''
        var cell
        if (chain) {
          cell = '<div title="' + esc(reqErr) + '">' + esc(chain) + '</div>'
          if (l.hint) cell += '<div class="lhint muted" title="' + esc(l.hint) + '">' + esc(l.hint) + '</div>'
        } else {
          cell = '<div class="muted" title="' + esc(reqErr) + '">' + esc(reqErr.slice(0, 60)) + '</div>'
        }
        return '<tr><td class="muted mono">' + esc((l.ts || '').slice(11, 19)) + '</td>' +
          '<td>' + esc(l.harness) + '</td>' +
          '<td>' + esc(l.profile) + '</td>' +
          '<td class="mono">' + esc(l.model || '-') + '</td>' +
          '<td style="color:' + (bad ? 'var(--err)' : 'var(--ok)') + '">' + esc(l.status == null ? '-' : l.status) + '</td>' +
          '<td>' + (l.ms == null ? '-' : l.ms + 'ms') + '</td>' +
          '<td>' + cell + '</td>' +
          '<td>' + copyBtn + '</td></tr>'
      }).join('')
      var html = '<thead><tr><th>' + t('时间', 'Time') + '</th><th>' + t('客户端 / 操作', 'Client / op') + '</th><th>' + t('服务 / 目标', 'Service / target') + '</th><th>' + t('模型 / 详情', 'Model / detail') + '</th><th>' + t('状态', 'Status') + '</th><th>' + t('耗时', 'Took') + '</th><th>' + t('错误', 'Error') + '</th><th>' + t('操作', 'Actions') + '</th></tr></thead>' +
        (rows || '<tr><td colspan="8" class="empty">' + t('暂无记录', 'No entries yet') + '</td></tr>')
      logsLastGood = html
      logsFailStreak = 0
      $('#logTable').innerHTML = html
      bindLogCopy()
      $('#logPageInfo').textContent = t('第 ', 'Page ') + logPage + ' / ' + logPages + t(' 页 · 共 ', ' · ') + total + t(' 条', ' entries')
      $('#logPrev').disabled = logPage <= 1
      $('#logNext').disabled = logPage >= logPages
    }).catch(function () {
      // 刷新失败时保留最后成功的数据并明确标注，别让用户误以为是最新
      logsFailStreak++
      if (logsFailStreak >= 2 && logsLastGood && !document.getElementById('logTable').querySelector('tfoot')) {
        $('#logTable').innerHTML = logsLastGood +
          '<tfoot><tr><td colspan="8" class="muted">（' + t('日志刷新失败，以上为最后一次成功的数据', 'Log refresh failed — the table above shows the last successful data') + '）</td></tr></tfoot>'
      }
    })
  }
  // 筛选 tab 接线：切视图重置页码并强制重建（不同视图的响应可能恰好同签名）
  Array.prototype.forEach.call(document.querySelectorAll('#logTabs button'), function (b) {
    b.onclick = function () {
      var nt = b.getAttribute('data-lt')
      if (!nt || nt === logTab) return
      logTab = nt
      localStorage.setItem('mdk_log_tab', logTab)
      logApplyTab()
      logPage = 1
      logsLastSig = ''
      loadLogs()
    }
  })
  $('#logPageSize').onchange = function () {
    logPageSize = Number(this.value) || 10
    localStorage.setItem('mdk_log_size', String(logPageSize))
    logPage = 1
    loadLogs()
  }
  $('#logPrev').onclick = function () { if (logPage > 1) { logPage--; loadLogs() } }
  $('#logNext').onclick = function () { if (logPage < logPages) { logPage++; loadLogs() } }
  // 复制本页（右下角）：当前筛选视图的整页条目复制为 JSONL（每行一条原始 JSON），便于整段贴排障
  $('#logCopyPage').onclick = function () {
    var btn = this
    if (!logPageEntries.length) return
    var lines = []
    for (var i = 0; i < logPageEntries.length; i++) lines.push(JSON.stringify(logPageEntries[i]))
    var orig = btn.innerHTML
    copyText(lines.join('\\n'), function () { btn.innerHTML = icon('check', 12); setTimeout(function () { btn.innerHTML = orig }, 1200) })
  }

  // 语言切换：写入 localStorage 后立即应用（静态节点 + 重绘动态区域）
  Array.prototype.forEach.call(document.querySelectorAll('#langSwitch button'), function (b) {
    b.onclick = function () {
      LANG = b.getAttribute('data-lang')
      localStorage.setItem('mdk_lang', LANG)
      applyLang()
      loadLogs() // 日志表头是 JS 渲染的，单独刷一次
      pollOverview() // 客户端卡片描述等服务端文案随语言重取重绘
    }
  })
  applyLang()
  pollHealth()
  // 更新完成重连回来：报「已更新到 vX.Y.Z」（apply 时记入 sessionStorage）。
  // 核验版本真的到位才提示——失败重载时 current 未变，静默清掉，不弹假完成
  try {
    var toV = sessionStorage.getItem('mdk_upd_to')
    if (toV) {
      sessionStorage.removeItem('mdk_upd_to')
      api('/admin/update/status').then(function (s) {
        if (cmpSemver(s.current, toV) >= 0) toast(t('已更新到 v' + s.current, 'Updated to v' + s.current))
      }).catch(function () {})
    }
  } catch (e) { /* 隐私模式等 */ }
  refreshUpdStatus()
`
