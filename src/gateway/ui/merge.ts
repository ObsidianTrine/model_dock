/**
 * Web 控制台 · merge.ts —— 多包合并域逻辑（provider-probe-suite 任务 11，merge-import-integration 收编）。
 * UI_JS_MERGE：多包合并已融入「配置包文件」tab 的多选流——impFile2 选 >1 个文件时由 configpack.ts
 * 分流进来（chips + 逐包口令行 → /merge/preview → 审阅宽弹层勾选 → /merge/apply）；独立
 * 「合并多个配置包…」按钮与旧独立弹层入口已移除（t11 双入口割裂修复）。单包流（/sync/import）不走本片段。
 * 审阅清单呈现走 mgReviewOverlay 宽弹层（svcmodal 680px，merge-preview-wide-modal 呈现层替换）：
 * 审阅面需要行列结构与宽度，tab 内嵌窄列已删；端点/confirmToken 链路不动。
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
  // 审阅宽弹层：审阅清单≠表单输入——逐行勾选需要宽度与行列结构，svcmodal 680px 与编辑/添加弹层同款变体
  // （styles.ts 既有宽度令牌，勿另开档）。表格列宽/截断口径进 styles.ts（#mgReviewTable，日志表配方）；
  // 关闭路径只有 返回/✕/Esc 三种（无遮罩点击关）：勾选清单是易丢的手工输入，防误触一抖全没
  var mgM = createModal({
    id: 'mergeReviewOverlay',
    title: '合并审阅||Merge review',
    align: 'top',
    modalClass: 'svcmodal',
    bodyHtml: '<p class="testline" id="mgReviewLine" style="margin:0 0 8px"></p>' +
      '<div class="tablescroll"><table id="mgReviewTable"><thead><tr>' +
      // 勾选列 th 放全选框（船东批准原型 selAll 形态）：行多时逐个点已是纯体力，联动语义见 mgSelAllBox
      '<th><input type="checkbox" id="mgSelAll" data-i18n-title="全选 / 全不选||Select all / none" title="全选 / 全不选"></th><th data-i18n="服务||Service">服务</th><th data-i18n="地址与 Key||Endpoint and key">地址与 Key</th><th data-i18n="探针||Probe">探针</th><th data-i18n="建议||Suggestion">建议</th>' +
      '</tr></thead><tbody id="mgReviewRows"></tbody></table></div>' +
      '<p class="help" data-i18n="同 base_url + 同 key 的服务自动合并为一条；探针结论继承自本机探针记录（key 只显示指纹）。应用会整体替换现有服务/路由/预设/定时规则（未勾选的将被移除），改动前自动快照。||Services with the same base_url + same key merge into one; verdicts come from local probe records (keys shown as fingerprints). Applying replaces providers/routes/presets/schedule rules (unchecked ones are removed); a snapshot is taken first.">' +
      '同 base_url + 同 key 的服务自动合并为一条；探针结论继承自本机探针记录（key 只显示指纹）。应用会整体替换现有服务/路由/预设/定时规则（未勾选的将被移除），改动前自动快照。</p>',
    foot: [
      { slot: 'msg', id: 'mgReviewErr', kind: 'err' },
      { id: 'mgReviewBack', label: '返回||Back' },
      { id: 'mgReviewApply', label: '应用所选||Apply selected', primary: true, end: true },
    ],
  })
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
  // 逐包口令行：每文件一行（船东批准原型 .prow 紧凑形态——包名右对齐截断 label + 口令 input flex，
  // 样式在 styles.ts #pkgOverlay .prow；label 悬浮 title 出全量文件名）；全同口令时逐行填同值即可
  function mgRenderPwRows() {
    var box = document.getElementById('impPwRows')
    if (!box) return
    box.innerHTML = ''
    mgFiles.forEach(function (file, i) {
      var row = document.createElement('div')
      row.className = 'prow'
      var nm = document.createElement('label')
      nm.title = file.name
      nm.htmlFor = 'mgPw' + i
      nm.textContent = file.name + ' ' + t('口令', 'passphrase')
      var input = document.createElement('input')
      input.type = 'password'
      input.id = 'mgPw' + i
      input.setAttribute('autocomplete', 'new-password')
      // 动态节点不经 applyI18nTree：占位符渲染时 t() 直译（与 chips title 同款取舍）
      input.placeholder = t('该包导出时设置的同步口令', 'The passphrase this package was exported with')
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
  // 退出 multi 的展示形态（不动 mgFiles）：chips/口令行隐藏、单口令输入恢复；空态提示块随文件来源刷新
  function mgExitMultiUi() {
    var chips = document.getElementById('impChips')
    if (chips) { chips.hidden = true; chips.innerHTML = '' }
    var rows = document.getElementById('impPwRows')
    if (rows) { rows.hidden = true; rows.innerHTML = '' }
    var pw2 = document.getElementById('impPw2')
    if (pw2) pw2.hidden = false
    mgPendingToken = ''
    updateImpEmptyHint()
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
    // 预览态 = confirmToken + 审阅弹层：文件清单一变即整体失效（token 绑定包与勾选清单，重用必被服务端 400）
    mgPendingToken = ''
    if (mgM.isOpen()) mgM.close()
  }
  function mgSuggestionBadge(sug) {
    var m = MG_SUG[sug] || MG_SUG.keep
    return '<span class="pill ' + m.cls + '">' + esc(t(m.zh, m.en)) + '</span>'
  }
  function mgVerdictBadge(state) {
    var m = MG_META[state] || { cls: 'dim', zh: '无探针记录', en: 'No probe record' }
    return '<span class="pill ' + m.cls + '">' + esc(t(m.zh, m.en)) + '</span>'
  }
  // 预览结果渲染进审阅宽弹层（mgRenderPreview 由 configpack.ts 的导入按钮回调触发）；
  // confirmToken 存 mgPendingToken 待 apply。列结构（勾选/服务/地址与Key/探针/建议）进 styles.ts 配方：
  // 地址格两行块形态（船东批准原型 /tmp/merge-proto/merge-flow.html）：首行 URL 剥 scheme 渲染 +
  // direction:rtl 左截断保尾部（host/path 是服务间差异所在），title 悬浮全量含 scheme；次行 key 指纹，
  // 仅 duplicateCount > 1 才标「同源 ×n」——=1 是去重正常态，每行都标即纯噪音；来源清单并入服务列悬浮
  function mgRenderPreview(j) {
    var pv = j.preview || {}
    var cands = pv.candidates || []
    mgPendingToken = j.confirmToken || ''
    var rows = ''
    for (var i = 0; i < cands.length; i++) {
      var c = cands[i]
      var srcs = (c.sources || []).join(', ')
      var dupTxt = c.duplicateCount > 1 ? t('同源 ×{n}', 'same-source ×{n}', { n: c.duplicateCount }) : ''
      rows += '<tr><td><input type="checkbox" class="mgKeep" data-id="' + esc(c.id) + '"' + (c.suggestion === 'keep' ? ' checked' : '') + '></td>' +
        '<td title="' + esc(c.id + (srcs ? ' · ' + srcs : '')) + '"><b>' + esc(c.id) + '</b></td>' +
        '<td class="mgurl"><span class="mgu" title="' + esc(c.base_url) + '">' + esc(c.base_url.replace(/^https?:\\/\\//, '')) + '</span><span class="mgsub">key ' + esc(c.key_fp || '-') + (dupTxt ? ' · <span class="mgdup">' + esc(dupTxt) + '</span>' : '') + '</span></td>' +
        '<td>' + mgVerdictBadge(c.verdict_state) + '</td>' +
        '<td>' + mgSuggestionBadge(c.suggestion) + '</td></tr>'
    }
    if (!cands.length) rows = '<tr><td colspan="5" class="empty">' + esc(t('包内没有可合并的服务', 'No services to merge in the packages')) + '</td></tr>'
    var tbody = document.getElementById('mgReviewRows')
    if (tbody) tbody.innerHTML = rows
    mgSyncSelAll()
    var line = document.getElementById('mgReviewLine')
    if (line) line.textContent = t('合并 {n} 个包 → {p} 个服务、{r} 条路由（去重 {d} 条）· 预设 {s} · 定时 {w}', 'Merging {n} packages → {p} services, {r} profiles ({d} merged) · {s} presets · {w} schedule rules', { n: (pv.packages || []).length, p: cands.length, r: pv.profileTotal || 0, d: pv.duplicatesMerged || 0, s: pv.presetCount || 0, w: pv.scheduleRules || 0 })
    var applyBtn = document.getElementById('mgReviewApply')
    if (applyBtn) applyBtn.disabled = !cands.length
    mgM.open()
  }
  // 行勾选变化回写表头态（船东批准原型 refreshApply 形态）：全勾=勾、部分/空=不勾；
  // 不用 indeterminate 三态——易误读且原型未用。空清单也回写不勾，防上一次预览的陈旧勾态残留
  function mgSyncSelAll() {
    var boxes = document.querySelectorAll('#mgReviewRows .mgKeep')
    var sel = document.getElementById('mgSelAll')
    if (!sel) return
    var n = 0
    Array.prototype.forEach.call(boxes, function (el) { if (el.checked) n++ })
    sel.checked = boxes.length > 0 && n === boxes.length
  }
  // 全选联动：表头 change 统一置位全行（原型直接重渲染整表，这里只翻转 checked 同效且少一次重建）；
  // 行变化经 tbody 事件委托回写表头——tbody 是常驻节点，行 innerHTML 重建不丢监听，免逐行挂
  var mgSelAllBox = document.getElementById('mgSelAll')
  if (mgSelAllBox) mgSelAllBox.addEventListener('change', function () {
    Array.prototype.forEach.call(document.querySelectorAll('#mgReviewRows .mgKeep'), function (el) { el.checked = mgSelAllBox.checked })
  })
  var mgReviewRowsBody = document.getElementById('mgReviewRows')
  if (mgReviewRowsBody) mgReviewRowsBody.addEventListener('change', function (e) {
    if (e.target && e.target.classList && e.target.classList.contains('mgKeep')) mgSyncSelAll()
  })
  function mgSetErr(msg) {
    var el = document.getElementById('mgReviewErr')
    if (el) el.textContent = msg || ''
  }
  var mgReviewBackBtn = document.getElementById('mgReviewBack')
  if (mgReviewBackBtn) mgReviewBackBtn.onclick = function () { mgM.close() }
  // 应用所选：成功=关审阅弹层+关配置包弹层 → 主页面 toast（动作关闭了弹层，toast 归宿合规）→ 整页刷新；
  // 失败=同样关审阅弹层回 tab，错误写 pkgErr 槽位（pkgM 仍开着，就近反馈；重试=再点一次导入，口令行原样保留）
  var mgReviewApplyBtn = document.getElementById('mgReviewApply')
  if (mgReviewApplyBtn) {
    mgReviewApplyBtn.onclick = function () {
      var ids = Array.prototype.map.call(document.querySelectorAll('#mgReviewRows .mgKeep:checked'), function (el) { return el.getAttribute('data-id') })
      if (!ids.length) { mgSetErr(t('请至少勾选一个要保留的服务', 'Select at least one service to keep')); return }
      mgReviewApplyBtn.disabled = true
      mgSetErr('')
      mgReadFiles().then(function (packages) {
        return api('/merge/apply', { method: 'POST', body: JSON.stringify({ packages: packages, passphrases: mgCollectPassphrases(), keep: ids, confirmToken: mgPendingToken }) })
      }).then(function (j) {
        if (mgM.isOpen()) mgM.close()
        importToggle(false)
        var rep = j.report || {}
        var n = (rep.providers || []).length
        var dropped = (j.droppedProfiles || []).length
        toast(t('已合并导入：服务 {n} · 路由 {r}', 'Merged and imported: {n} services · {r} profiles', { n: n, r: (rep.profiles || []).length }) + (dropped ? t('；剔除悬空路由 {d} 条', '; {d} dangling profiles removed', { d: dropped }) : ''), true)
        setTimeout(function () { location.reload() }, 1200)
      }).catch(function (e) {
        if (mgM.isOpen()) mgM.close()
        setImpErr(t('应用失败：', 'Apply failed: ') + ((e && e.message) || e))
      })
    }
  }

`
