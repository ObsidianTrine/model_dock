/**
 * Web 控制台 · logs.ts —— 由单文件 ui.ts 按域拆分（T04 Phase 1，行为零变化）。
 * UI_JS_LOGS：日志页：分页/复制/签名去抖重建
 * 片段为模板字面量源文本：ui.ts 按原次序拼装后与拆分前逐字节一致；勿改动片段内换行/转义/次序。
 */
export const UI_JS_LOGS = `  var logsLastGood = ''
  var logPageEntries = [] // 当前页错误行的原始条目，供 ⧉ 复制按钮按索引取用
  var logsFailStreak = 0
  var logsLastSig = '' // 上次成功响应的整体签名：没变化就跳过整表重建（否则每 5s 白重建一次，打断选中文本/复制）
  // 分页状态：page 从 1 数起（服务端第 1 页 = 最新 n 条）；每页条数记忆在 localStorage
  var logPage = 1
  var logPages = 1
  var logPageSize = Number(localStorage.getItem('mdk_log_size')) || 10
  if ([10, 30, 50, 100].indexOf(logPageSize) === -1) logPageSize = 10
  $('#logPageSize').value = String(logPageSize)
  // 错误行 ⧉ 复制：把整条日志格式化为纯文本进剪贴板，方便贴给排障/issue
  function logCopyText(l) {
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
    if (l.err) lines.push(t('错误', 'Error') + ': ' + l.err)
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
    api('/logs?n=' + logPageSize + '&page=' + logPage).then(function (j) {
      var logs = (j.logs || []).slice().reverse() // 最新在最上
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
        if (l.kind === 'audit') {
          // 操作审计行：齿轮图标 操作名 | 目标 | 变更摘要 | 成功/失败
          var ok = l.ok !== false
          var opTxt = pick('op') || t('操作', 'op')
          var detTxt = pick('detail') || ''
          var errTxt = pick('err') || ''
          return '<tr><td class="muted mono">' + esc((l.ts || '').slice(11, 19)) + '</td>' +
            '<td>' + iconInline('gear', 12) + ' ' + esc(opTxt) + '</td>' +
            '<td>' + esc(pick('target') || '-') + '</td>' +
            '<td class="muted" title="' + esc(detTxt) + '">' + esc(detTxt) + '</td>' +
            '<td class="' + (ok ? 'st-ok' : 'st-err') + '" title="' + esc(ok ? t('成功', 'ok') : t('失败', 'failed')) + '">' + iconInline(ok ? 'check' : 'close', 13) + '</td>' +
            '<td>-</td>' +
            '<td class="muted" title="' + esc(errTxt) + '">' + esc(errTxt.slice(0, 60)) + '</td></tr>'
        }
        var copyBtn = ''
        if (bad) {
          logPageEntries.push(l)
          copyBtn = '<button type="button" class="lcopy" data-li="' + (logPageEntries.length - 1) + '" title="' + t('复制日志详情', 'Copy log details') + '">' + icon('copy', 12) + '</button>'
        }
        return '<tr><td class="muted mono">' + esc((l.ts || '').slice(11, 19)) + '</td>' +
          '<td>' + esc(l.harness) + '</td>' +
          '<td>' + esc(l.profile) + '</td>' +
          '<td class="mono">' + esc(l.model || '-') + '</td>' +
          '<td style="color:' + (bad ? 'var(--err)' : 'var(--ok)') + '">' + esc(l.status == null ? '-' : l.status) + '</td>' +
          '<td>' + (l.ms == null ? '-' : l.ms + 'ms') + '</td>' +
          '<td class="muted" title="' + esc(pick('err') || '') + '">' + esc((pick('err') || '').slice(0, 60)) + copyBtn + '</td></tr>'
      }).join('')
      var html = '<thead><tr><th>' + t('时间', 'Time') + '</th><th>' + t('客户端 / 操作', 'Client / op') + '</th><th>' + t('服务 / 目标', 'Service / target') + '</th><th>' + t('模型 / 详情', 'Model / detail') + '</th><th>' + t('状态', 'Status') + '</th><th>' + t('耗时', 'Took') + '</th><th>' + t('错误', 'Error') + '</th></tr></thead>' +
        (rows || '<tr><td colspan="7" class="empty">' + t('暂无记录（错误请求与控制台操作）', 'No entries yet (error requests and console operations)') + '</td></tr>')
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
          '<tfoot><tr><td colspan="7" class="muted">（' + t('日志刷新失败，以上为最后一次成功的数据', 'Log refresh failed — the table above shows the last successful data') + '）</td></tr></tfoot>'
      }
    })
  }
  $('#logPageSize').onchange = function () {
    logPageSize = Number(this.value) || 10
    localStorage.setItem('mdk_log_size', String(logPageSize))
    logPage = 1
    loadLogs()
  }
  $('#logPrev').onclick = function () { if (logPage > 1) { logPage--; loadLogs() } }
  $('#logNext').onclick = function () { if (logPage < logPages) { logPage++; loadLogs() } }

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
