/**
 * Web 控制台 · mcp.ts —— MCP 服务器盘点卡片（只读）。
 * UI_JS_MCP：拉取 /mcp 聚合清单、签名去抖重建、同名重复标记、语言切换重绘。
 * 片段为模板字面量源文本：ui.ts 按原次序拼装；勿改动片段内换行/转义/次序。
 */
export const UI_JS_MCP = `  var mcpLastSig = ''
  function loadMcp() {
    api('/mcp').then(function (j) {
      var sig = JSON.stringify(j)
      if (sig === mcpLastSig) return
      mcpLastSig = sig
      var list = (j.servers || []).slice().sort(function (a, b) {
        var n = a.name.toLowerCase() < b.name.toLowerCase() ? -1 : a.name.toLowerCase() > b.name.toLowerCase() ? 1 : 0
        return n !== 0 ? n : (a.harness < b.harness ? -1 : a.harness > b.harness ? 1 : 0)
      })
      var errs = j.errors || []
      var count = $('#mcpCount')
      count.hidden = list.length === 0
      count.textContent = String(list.length)
      // 同名出现多次：换 key/改命令容易漏一处，名字旁标记
      var nameCount = {}
      list.forEach(function (s) { nameCount[s.name] = (nameCount[s.name] || 0) + 1 })
      var dupNames = Object.keys(nameCount).filter(function (n) { return nameCount[n] > 1 })
      var rows = list.map(function (s) {
        var envTxt = (s.envKeys || []).length ? ' <span class="muted">· env: ' + esc(s.envKeys.join(', ')) + '</span>' : ''
        var dup = nameCount[s.name] > 1
        var scopeTxt = s.scope === 'project' ? t('项目', 'project') + (s.project ? ' · ' + esc(s.project) : '') : t('全局', 'user')
        return '<tr><td class="mono">' + (dup ? '<span title="' + esc(t('同名服务器在多处重复配置', 'Same-named server configured in more than one place')) + '">' + iconInline('alert-triangle', 12) + ' </span>' : '') + esc(s.name) + '</td>' +
          '<td>' + esc(s.harness === 'claude-code' ? 'Claude Code' : s.harness === 'codex' ? 'Codex' : s.harness === 'zcode' ? 'ZCode' : s.harness === 'opencode' ? 'OpenCode' : s.harness) + '</td>' +
          '<td class="muted mono">' + esc(s.transport) + '</td>' +
          '<td class="mono" title="' + esc(s.target) + '">' + esc(s.target) + envTxt + '</td>' +
          '<td class="muted">' + scopeTxt + '</td></tr>'
      })
      var html = '<thead><tr><th>' + t('名称', 'Name') + '</th><th>' + t('客户端', 'Client') + '</th><th>' + t('类型', 'Type') + '</th><th>' + t('命令 / 地址', 'Command / URL') + '</th><th>' + t('范围', 'Scope') + '</th></tr></thead>' +
        (rows.join('') || '<tr><td colspan="5" class="empty">' + t('未发现 MCP 服务器配置', 'No MCP server configs found') + '</td></tr>')
      $('#mcpTable').innerHTML = html
      var notes = []
      errs.forEach(function (e) { notes.push('<span style="color:var(--warn)">' + esc(e.source) + '：' + esc(e.message) + '</span>') })
      if (dupNames.length) notes.push(esc(t('同名服务器在多处重复配置：', 'Same-named servers configured in more than one place: ')) + esc(dupNames.join(', ')))
      notes.push(esc(t('只盘点用户级配置；各仓库工作区配置（.mcp.json / .zcode/config.json）不在此列。', 'User-level configs only; per-repo workspace configs (.mcp.json / .zcode/config.json) are not included.')))
      var note = $('#mcpNote')
      note.innerHTML = notes.join('<br>')
      note.hidden = false
    }).catch(function () { /* 盘点卡非关键：拉取失败静默保留现状 */ })
  }
  loadMcp()
  setInterval(function () { if (!document.hidden) loadMcp() }, 60000)
  // 语言切换：签名清空强制重绘（表头/范围文案是 JS 渲染的）
  Array.prototype.forEach.call(document.querySelectorAll('#langSwitch button'), function (b) {
    b.addEventListener('click', function () {
      mcpLastSig = ''
      loadMcp()
    })
  })
`
