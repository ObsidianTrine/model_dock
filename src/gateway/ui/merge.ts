/**
 * Web 控制台 · merge.ts —— 多包合并域逻辑（provider-probe-suite 任务 11，merge-import-integration 收编）。
 * UI_JS_MERGE：多包合并已融入「配置包文件」tab 的多选流——impFile2 选 >1 个文件时由 configpack.ts
 * 分流进来（chips + 逐包口令行 → /merge/preview 三档清单 → 勾选 → /merge/apply）；独立
 * 「合并多个配置包…」按钮与 mgM 弹层入口已移除（t11 双入口割裂修复）。单包流（/sync/import）不走本片段。
 * 预览/展示全程不落盘；key 只出指纹（服务端红线）。片段为模板字面量源文本：ui.ts 经 UI_JS_MIN 拼装；
 * 本片段仍在 scripts/gen-ui-min.mjs 的 ORDER 登记。
 */
export const UI_JS_MERGE = `  // ===== 多包合并（融入「配置包文件」tab 的多选流）=====
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
  var mgFiles = []   // multi 模式的 File 清单：chips/口令行/上传共用同一来源，避免「行删了、input 还有」的不一致
  var mgPendingToken = ''
  // File → {name, content_b64}：内容经 base64 随 JSON 上传（TextEncoder 分块转二进制串再 btoa，UTF-8 安全不爆栈）
  function mgFileToB64(file) {
    return file.text().then(function (txt) {
      var bytes = new TextEncoder().encode(txt)
      var bin = ''
      for (var i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
      return { name: file.name, content_b64: btoa(bin) }
    })
  }
  function mgReadFiles() {
    return Promise.all(mgFiles.map(mgFileToB64))
  }
  function mgRenderChips() {
    var box = document.getElementById('impChips')
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
      rm.onclick = function () {
        mgFiles.splice(i, 1)
        mgHideMergePreview()
        setImpErr('')
        if (mgFiles.length > 1) { mgRenderChips(); mgRenderPwRows(); updateImpPrimary() }
        else if (mgFiles.length === 1) {
          // 删到只剩一个：退回单包流展示形态，但保留 mgFiles 作文件来源（multi 进入时 input.value 已清，input.files 不可用）
          mgExitMultiUi()
          showImpFileChip(mgFiles[0])
          updateImpPrimary()
        } else { mgClearMulti(); showImpFileChip(null); updateImpPrimary() }
      }
      chip.appendChild(nm)
      chip.appendChild(rm)
      box.appendChild(chip)
    })
  }
  // 逐包口令行：每文件一行（文件名 + password 输入），可见可改；全同口令时逐行填同值即可
  function mgRenderPwRows() {
    var box = document.getElementById('impPwRows')
    if (!box) return
    box.innerHTML = ''
    mgFiles.forEach(function (file, i) {
      var row = document.createElement('p')
      row.className = 'row'
      row.style.margin = '6px 0 0'
      var nm = document.createElement('span')
      nm.className = 'fname'
      nm.textContent = file.name
      var input = document.createElement('input')
      input.type = 'password'
      input.id = 'mgPw' + i
      input.setAttribute('autocomplete', 'new-password')
      // 动态节点不经 applyI18nTree：占位符渲染时 t() 直译（与 chips title 同款取舍）
      input.placeholder = t('口令（导出时设置）', 'Passphrase (set at export)')
      input.style.width = '100%'
      input.style.boxSizing = 'border-box'
      input.addEventListener('input', function () { setImpErr('') })
      row.appendChild(nm)
      row.appendChild(input)
      box.appendChild(row)
    })
  }
  function mgCollectPassphrases() {
    return mgFiles.map(function (_, i) {
      var el = document.getElementById('mgPw' + i)
      return el ? el.value || '' : ''
    })
  }
  // 退出 multi 的展示形态（不动 mgFiles）：chips/口令行隐藏、单口令输入恢复
  function mgExitMultiUi() {
    var chips = document.getElementById('impChips')
    if (chips) { chips.hidden = true; chips.innerHTML = '' }
    var rows = document.getElementById('impPwRows')
    if (rows) { rows.hidden = true; rows.innerHTML = '' }
    var pw2 = document.getElementById('impPw2')
    if (pw2) pw2.hidden = false
    var pv = document.getElementById('impMergePreview')
    if (pv) pv.hidden = true
    mgPendingToken = ''
  }
  function mgClearMulti() {
    mgFiles = []
    mgExitMultiUi()
  }
  // change 分流入口（configpack.ts 调用）：>1 个文件进入 multi 模式
  function mgSetFiles(files) {
    mgFiles = files
    mgHideMergePreview()
    if (files.length > 1) {
      mgRenderChips()
      mgRenderPwRows()
      showImpFileChip(null)
      var pw2 = document.getElementById('impPw2')
      if (pw2) pw2.hidden = true
      var chips = document.getElementById('impChips')
      if (chips) chips.hidden = false
      var rows = document.getElementById('impPwRows')
      if (rows) rows.hidden = false
      // 单包流以 input.files 为来源，multi 改由 mgFiles 驱动：清 input 防两个来源各说各话
      var f = document.getElementById('impFile2')
      if (f) f.value = ''
    }
  }
  function mgHideMergePreview() {
    mgPendingToken = ''
    var pv = document.getElementById('impMergePreview')
    if (pv) pv.hidden = true
  }
  function mgSuggestionBadge(sug) {
    var m = MG_SUG[sug] || MG_SUG.keep
    return '<span class="pill ' + m.cls + '">' + esc(t(m.zh, m.en)) + '</span>'
  }
  function mgVerdictBadge(state) {
    var m = MG_META[state] || { cls: 'dim', zh: '无探针记录', en: 'No probe record' }
    return '<span class="pill ' + m.cls + '">' + esc(t(m.zh, m.en)) + '</span>'
  }
  // 预览结果渲染进 tab 内的合并预览块（位置=原单包预览步）；confirmToken 存 mgPendingToken 待 apply
  function mgRenderPreview(j) {
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
    var tbody = document.getElementById('impMergeRows')
    if (tbody) tbody.innerHTML = rows
    var line = document.getElementById('impMergeLine')
    if (line) line.textContent = t('合并 {n} 个包 → {p} 个服务、{r} 条路由（去重 {d} 条）· 预设 {s} · 定时 {w}', 'Merging {n} packages → {p} services, {r} profiles ({d} merged) · {s} presets · {w} schedule rules')
      .replace('{n}', (pv.packages || []).length).replace('{p}', cands.length).replace('{r}', pv.profileTotal || 0).replace('{d}', pv.duplicatesMerged || 0).replace('{s}', pv.presetCount || 0).replace('{w}', pv.scheduleRules || 0)
    var box = document.getElementById('impMergePreview')
    if (box) box.hidden = false
  }
  var impMergeBackBtn = document.getElementById('impMergeBackBtn')
  if (impMergeBackBtn) impMergeBackBtn.onclick = mgHideMergePreview
  var impMergeApplyBtn = document.getElementById('impMergeApplyBtn')
  if (impMergeApplyBtn) {
    impMergeApplyBtn.onclick = function () {
      var ids = Array.prototype.map.call(document.querySelectorAll('#impMergeRows .mgKeep:checked'), function (el) { return el.getAttribute('data-id') })
      if (!ids.length) { setImpErr(t('请至少勾选一个要保留的服务', 'Select at least one service to keep')); return }
      impMergeApplyBtn.disabled = true
      setImpErr('')
      mgReadFiles().then(function (packages) {
        return api('/merge/apply', { method: 'POST', body: JSON.stringify({ packages: packages, passphrases: mgCollectPassphrases(), keep: ids, confirmToken: mgPendingToken }) })
      }).then(function (j) {
        // 成功即关弹层 → 反馈走主页面 toast（弹层开着时禁止 toast 的红线只约束关闭前的反馈）
        importToggle(false)
        var rep = j.report || {}
        var n = (rep.providers || []).length
        var dropped = (j.droppedProfiles || []).length
        toast(t('已合并导入：服务 {n} · 路由 {r}', 'Merged and imported: {n} services · {r} profiles').replace('{n}', n).replace('{r}', (rep.profiles || []).length) + (dropped ? t('；剔除悬空路由 {d} 条', '; {d} dangling profiles removed').replace('{d}', dropped) : ''), true)
        setTimeout(function () { location.reload() }, 1200)
      }).catch(function (e) {
        setImpErr(t('应用失败：', 'Apply failed: ') + ((e && e.message) || e))
        impMergeApplyBtn.disabled = false
      })
    }
  }

`
