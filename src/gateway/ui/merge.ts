/**
 * Web 控制台 · merge.ts —— 多包合并（provider-probe-suite 任务 11）。
 * UI_JS_MERGE：合并弹层——多选 .msync 包 + 口令 → preview 拿去重候选与探针三档建议 → 勾选保留 → apply。
 * 预览/展示全程不落盘；key 只出指纹（服务端红线）。片段为模板字面量源文本：ui.ts 经 UI_JS_MIN 拼装；
 * 新增片段须在 scripts/gen-ui-min.mjs 的 ORDER 登记。
 */
export const UI_JS_MERGE = `  // ===== 多包合并（config merge）=====
  var MG_META = {
    healthy: { cls: 'ok', zh: '健康', en: 'Healthy' },
    degraded: { cls: 'warn', zh: '降级', en: 'Degraded' },
    quota: { cls: 'warn', zh: '额度', en: 'Quota' },
    'auth-dead': { cls: 'err', zh: '失效', en: 'Auth dead' },
    unreachable: { cls: 'err', zh: '不可达', en: 'Unreachable' },
    unverified: { cls: 'dim', zh: '未验证', en: 'Unverified' },
    stale: { cls: 'dim', zh: '过期', en: 'Stale' },
  }
  var MG_SUG = {
    keep: { cls: 'ok', zh: '保留候选', en: 'Keep' },
    review: { cls: 'warn', zh: '存疑', en: 'Suspect' },
    dead: { cls: 'err', zh: '失效', en: 'Dead' },
  }
  var mgFiles = []   // File 对象（chips 与上传共用同一来源，避免「chips 删了、input 还有」的不一致）
  var mgPendingToken = ''
  var mgM = createModal({
    id: 'mergeOverlay',
    title: '合并配置包||Merge packages',
    align: 'top',
    bodyHtml: '<p class="row" style="margin:0 0 10px;align-items:center">' +
      '<button type="button" class="btn" id="mgFileBtn" data-i18n="选择配置包（可多选）||Choose packages (multi-select)">选择配置包（可多选）</button>' +
      // 不设 accept：iOS 选择器会把未注册的 .msync 灰掉（impFile2 同款取舍）
      '<input type="file" id="mgFiles" multiple hidden></p>' +
      '<div id="mgChips" class="chips"></div>' +
      '<input type="password" id="mgPw" autocomplete="new-password" data-i18n-ph="配置包口令（导出时设置；各包需相同口令）||Package passphrase (set at export; same for all packages)" placeholder="配置包口令（导出时设置；各包需相同口令）" style="width:100%;box-sizing:border-box;margin-top:10px">' +
      '<div id="mgPreview" hidden style="margin-top:10px"><p class="shint" id="mgSummary"></p>' +
      '<div class="tablescroll"><table id="mgTable"><thead><tr>' +
      // 表头走 data-i18n（弹层静态节点），语言切换随 applyI18nTree 全树重译
      '<th></th><th data-i18n="服务||Service">服务</th><th data-i18n="探针||Probe">探针</th><th data-i18n="建议||Suggestion">建议</th><th data-i18n="来源||Sources">来源</th>' +
      '</tr></thead><tbody id="mgRows"></tbody></table></div>' +
      '<p class="help" data-i18n="同 base_url + 同 key 的服务自动合并为一条；探针结论继承自本机探针记录（key 只显示指纹）。应用会整体替换现有服务/路由/预设/定时规则（未勾选的将被移除），改动前自动快照。||Services with the same base_url + same key merge into one; verdicts come from local probe records (keys shown as fingerprints). Applying replaces providers/routes/presets/schedule rules (unchecked ones are removed); a snapshot is taken first.">' +
      '同 base_url + 同 key 的服务自动合并为一条；探针结论继承自本机探针记录（key 只显示指纹）。应用会整体替换现有服务/路由/预设/定时规则（未勾选的将被移除），改动前自动快照。</p></div>',
    foot: [
      { slot: 'msg', id: 'mgMsg', kind: 'err' },
      { id: 'mgPreviewBtn', label: '预览合并||Preview merge', primary: true },
      { id: 'mgApplyBtn', label: '应用所选||Apply selected', primary: true, end: true, disabled: true },
    ],
  })
  function setMgErr(msg) {
    var el = document.getElementById('mgMsg')
    if (el) el.textContent = msg || ''
  }
  function mgReadFiles() {
    // 内容经 base64 随 JSON 上传（TextEncoder 分块转二进制串再 btoa，UTF-8 安全不爆栈）
    return Promise.all(mgFiles.map(function (file) {
      return file.text().then(function (txt) {
        var bytes = new TextEncoder().encode(txt)
        var bin = ''
        for (var i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
        return { name: file.name, content_b64: btoa(bin) }
      })
    }))
  }
  function mgRenderChips() {
    var box = document.getElementById('mgChips')
    if (!box) return
    box.innerHTML = ''
    mgFiles.forEach(function (file, i) {
      var chip = document.createElement('span')
      chip.className = 'filechip'
      var nm = document.createElement('span')
      nm.className = 'fname'
      nm.textContent = file.name
      var rm = document.createElement('button')
      rm.type = 'button'
      rm.title = t('移除', 'Remove')
      rm.innerHTML = icon('close', 11)
      rm.onclick = function () { mgFiles.splice(i, 1); mgRenderChips(); mgHidePreview() }
      chip.appendChild(nm)
      chip.appendChild(rm)
      box.appendChild(chip)
    })
  }
  function mgHidePreview() {
    mgPendingToken = ''
    mgRenderFoot()
    var pv = document.getElementById('mgPreview')
    if (pv) pv.hidden = true
  }
  function mgRenderFoot() {
    var pb = document.getElementById('mgPreviewBtn')
    var ab = document.getElementById('mgApplyBtn')
    if (pb) pb.hidden = !!mgPendingToken
    if (ab) { ab.hidden = !mgPendingToken; ab.disabled = !mgPendingToken }
  }
  function mgSuggestionBadge(sug) {
    var m = MG_SUG[sug] || MG_SUG.keep
    return '<span class="pill ' + m.cls + '">' + esc(t(m.zh, m.en)) + '</span>'
  }
  function mgVerdictBadge(state) {
    var m = MG_META[state] || { cls: 'dim', zh: '无探针记录', en: 'No probe record' }
    return '<span class="pill ' + m.cls + '">' + esc(t(m.zh, m.en)) + '</span>'
  }
  var mgPreviewBtn = document.getElementById('mgPreviewBtn')
  if (mgPreviewBtn) {
    mgPreviewBtn.onclick = function () {
      var pw = (document.getElementById('mgPw').value || '')
      if (mgFiles.length < 2) { setMgErr(t('请选择至少两个配置包', 'Pick at least two packages')); return }
      if (!pw) { setMgErr(t('请输入配置包口令（各包需相同口令）', 'Enter the package passphrase (same for all packages)')); return }
      mgPreviewBtn.disabled = true
      setMgErr('')
      mgHidePreview()
      mgReadFiles().then(function (packages) {
        return api('/merge/preview', { method: 'POST', body: JSON.stringify({ packages: packages, passphrase: pw }) })
      }).then(function (j) {
        var pv = j.preview || {}
        var cands = pv.candidates || []
        mgPendingToken = j.confirmToken || ''
        var rows = ''
        for (var i = 0; i < cands.length; i++) {
          var c = cands[i]
          rows += '<tr><td><input type="checkbox" class="mgKeep" data-id="' + esc(c.id) + '"' + (c.suggestion === 'keep' ? ' checked' : '') + '></td>' +
            '<td><b>' + esc(c.id) + '</b><br><span class="hint">' + esc(c.base_url) + '<br>key ' + esc(c.key_fp || '-') + (c.duplicateCount > 0 ? ' · ' + esc(t('合并 {n} 条重复', '{n} duplicates merged', { n: c.duplicateCount })) : '') + '</span></td>' +
            '<td>' + mgVerdictBadge(c.verdict_state) + '</td>' +
            '<td>' + mgSuggestionBadge(c.suggestion) + '</td>' +
            '<td class="hint">' + esc((c.sources || []).join(', ')) + '</td></tr>'
        }
        if (!cands.length) rows = '<tr><td colspan="5" class="empty">' + esc(t('包内没有可合并的服务', 'No services to merge in the packages')) + '</td></tr>'
        var tbody = document.getElementById('mgRows')
        if (tbody) tbody.innerHTML = rows
        var sum = document.getElementById('mgSummary')
        if (sum) sum.textContent = t('合并 {n} 个包 → {p} 个服务、{r} 条路由（去重 {d} 条）· 预设 {s} · 定时 {w}', 'Merging {n} packages → {p} services, {r} profiles ({d} merged) · {s} presets · {w} schedule rules')
          .replace('{n}', (pv.packages || []).length).replace('{p}', cands.length).replace('{r}', pv.profileTotal || 0).replace('{d}', pv.duplicatesMerged || 0).replace('{s}', pv.presetCount || 0).replace('{w}', pv.scheduleRules || 0)
        var box = document.getElementById('mgPreview')
        if (box) box.hidden = false
        mgRenderFoot()
        mgPreviewBtn.disabled = false
      }).catch(function (e) {
        setMgErr(t('预览失败：', 'Preview failed: ') + ((e && e.message) || e))
        mgPreviewBtn.disabled = false
      })
    }
  }
  var mgApplyBtn = document.getElementById('mgApplyBtn')
  if (mgApplyBtn) {
    mgApplyBtn.onclick = function () {
      var ids = Array.prototype.map.call(document.querySelectorAll('#mgRows .mgKeep:checked'), function (el) { return el.getAttribute('data-id') })
      if (!ids.length) { setMgErr(t('请至少勾选一个要保留的服务', 'Select at least one service to keep')); return }
      var pw = (document.getElementById('mgPw').value || '')
      mgApplyBtn.disabled = true
      setMgErr('')
      mgReadFiles().then(function (packages) {
        return api('/merge/apply', { method: 'POST', body: JSON.stringify({ packages: packages, passphrase: pw, keep: ids, confirmToken: mgPendingToken }) })
      }).then(function (j) {
        // 成功即关弹层 → 反馈走主页面 toast（弹层开着时禁止 toast 的红线只约束关闭前的反馈）
        mgM.close()
        var rep = j.report || {}
        var n = (rep.providers || []).length
        var dropped = (j.droppedProfiles || []).length
        toast(t('已合并导入：服务 {n} · 路由 {r}', 'Merged and imported: {n} services · {r} profiles').replace('{n}', n).replace('{r}', (rep.profiles || []).length) + (dropped ? t('；剔除悬空路由 {d} 条', '; {d} dangling profiles removed').replace('{d}', dropped) : ''), true)
        setTimeout(function () { location.reload() }, 1200)
      }).catch(function (e) {
        setMgErr(t('应用失败：', 'Apply failed: ') + ((e && e.message) || e))
        mgApplyBtn.disabled = false
      })
    }
  }
  var mgFileBtn = document.getElementById('mgFileBtn')
  if (mgFileBtn) mgFileBtn.onclick = function () { var f = document.getElementById('mgFiles'); if (f) f.click() }
  var mgFilesInput = document.getElementById('mgFiles')
  if (mgFilesInput) {
    mgFilesInput.addEventListener('change', function () {
      mgFiles = Array.prototype.slice.call(this.files || [])
      mgRenderChips()
      mgHidePreview()
      setMgErr('')
    })
  }
  // 入口：配置包弹层「导入」面板里的合并按钮（modals.ts pkgImportPane）
  var mergePkgBtn = document.getElementById('mergePkgBtn')
  if (mergePkgBtn) mergePkgBtn.onclick = function () {
    mgFiles = []
    if (mgFilesInput) mgFilesInput.value = ''
    mgRenderChips()
    mgHidePreview()
    setMgErr('')
    mgRenderFoot()
    mgM.open()
  }

`
