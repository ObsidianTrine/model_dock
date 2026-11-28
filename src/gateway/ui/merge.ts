/**
 * Web 控制台 · merge.ts —— 导入预览域逻辑（provider-probe-suite 任务 11；2026-11-27 导入预览统一）。
 * UI_JS_MERGE：三入口（配置包文件 1..N / 粘贴链接 / 附近的电脑）全部汇入本片段的 mergeReviewOverlay
 * 审阅宽弹层——configpack.ts 分流构造来源（chips+逐包口令行 / 链接文本 / nearby ticket），预览成功后
 * mgSetApplySource 注入 apply 载荷构造器，勾选模式（追加默认/整体替换迁移）后 /merge/apply。
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
  // 2026-11-27 导入预览统一：三入口（文件/链接/附近）共用本弹层，新增 追加/替换模式 radio 与「与本机关系」列
  var mgM = createModal({
    id: 'mergeReviewOverlay',
    title: '导入预览 · 选择要导入的服务||Import preview · select services',
    align: 'top',
    modalClass: 'svcmodal',
    bodyHtml: '<div class="modes" id="mgModeRow">' +
      '<label><input type="radio" name="mgMode" id="mgModeAdd" checked><span data-i18n="追加所选（默认）——本机现有服务不动，选中的加进来||Add selected (default) — local services stay, the selection is added">追加所选（默认）——本机现有服务不动，选中的加进来</span></label>' +
      '<label class="warnmode"><input type="radio" name="mgMode" id="mgModeReplace"><span data-i18n="整体替换（迁移）——本机服务将由所选取代||Replace all (migration) — local services are replaced by the selection">整体替换（迁移）——本机服务将由所选取代</span></label></div>' +
      '<p class="testline" id="mgReviewLine" style="margin:0 0 8px"></p>' +
      '<div class="tablescroll"><table id="mgReviewTable"><thead><tr>' +
      // 勾选列 th 放全选框（船东批准原型 selAll 形态）：行多时逐个点已是纯体力，联动语义见 mgSelAllBox
      '<th><input type="checkbox" id="mgSelAll" data-i18n-title="全选 / 全不选||Select all / none" title="全选 / 全不选"></th><th data-i18n="服务||Service">服务</th><th data-i18n="地址与 Key||Endpoint and key">地址与 Key</th><th data-i18n="探针||Probe">探针</th><th data-i18n="建议||Suggestion">建议</th><th data-i18n="与本机关系||Relation">与本机关系</th>' +
      '</tr></thead><tbody id="mgReviewRows"></tbody></table></div>' +
      '<p class="help" data-i18n="同 base_url + 同 key 的服务自动合并为一条；探针结论继承自本机探针记录（key 只显示指纹）。追加模式：本机现有配置全部保留，只并入勾选项（id 撞名 = 勾选即覆盖；路由/预设已有 id 保留本机版）；整体替换则未勾选项连同本机其余服务一并移除。改动前自动快照。||Services with the same base_url + same key merge into one; verdicts come from local probe records (keys shown as fingerprints). Additive mode keeps everything local and adds only the selection (same id = overwrite when checked; local profiles/presets with existing ids are kept). Full replace also removes local services outside the selection. A snapshot is taken first.">' +
      '同 base_url + 同 key 的服务自动合并为一条；探针结论继承自本机探针记录（key 只显示指纹）。追加模式：本机现有配置全部保留，只并入勾选项（id 撞名 = 勾选即覆盖；路由/预设已有 id 保留本机版）；整体替换则未勾选项连同本机其余服务一并移除。改动前自动快照。</p>',
    foot: [
      { slot: 'msg', id: 'mgReviewErr', kind: 'err' },
      { id: 'mgReviewBack', label: '返回||Back' },
      { id: 'mgReviewApply', label: '应用所选||Apply selected', primary: true, end: true },
    ],
  })
  var mgFiles = []   // multi 模式的 File 清单：chips/口令行/上传共用同一来源，避免「行删了、input 还有」的不一致
  var mgPendingToken = ''
  // 追加/替换模式（2026-11-27 导入预览统一）：add=追加所选（默认）；replace=整体替换（迁移）
  var mgMode = 'add'
  var mgLastPreview = null // 最近一次预览响应的 preview 对象（汇总行/勾选默认随模式重渲染的依据）
  // 预览来源的 apply 载荷构造器（configpack.ts 预览成功后注入）：packages=重传清单；url/ticket=暂存票据。
  // 预览与 apply 之间文件清单变化由服务端 confirmToken 兜底（内容不一致即 400 重预览）
  var mgApplySourceFn = null
  function mgSetApplySource(fn) { mgApplySourceFn = fn }
  // 口令草稿按包名键控（merge 载荷里包的身份就是 name）：删 chip 后口令行按新索引全量重建，
  // 只有按名回填才能保住已填值不被索引移位清空；条目随 mgFiles 增删同步（mgSetFiles/mgClearMulti 清空、rm 删键）
  var mgPwSaved = {}
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
        var gone = mgFiles.splice(i, 1)[0]
        delete mgPwSaved[gone.name]
        mgHideMergePreview()
        setImpErr('')
        if (mgFiles.length > 1) { mgRenderChips(); mgRenderPwRows(); updateImpPrimary() }
        else if (mgFiles.length === 1) {
          // 删到只剩一个：退回单包流展示形态，但保留 mgFiles 作文件来源（multi 进入时 input.value 已清，input.files 不可用）
          mgExitMultiUi()
          showImpFileChip(mgFiles[0])
          // 已填口令迁进单包输入（单流读 impPw2 不读 store；无值时 || '' 顺带清掉跨清单残留的旧草稿）
          var pw2 = document.getElementById('impPw2')
          if (pw2) pw2.value = mgPwSaved[mgFiles[0].name] || ''
          delete mgPwSaved[mgFiles[0].name]
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
      input.value = mgPwSaved[file.name] || ''
      // 动态节点不经 applyI18nTree：占位符渲染时 t() 直译（与 chips title 同款取舍）
      input.placeholder = t('该包导出时设置的同步口令', 'The passphrase this package was exported with')
      input.addEventListener('input', function () { mgPwSaved[file.name] = input.value; setImpErr('') })
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
    mgPwSaved = {}
    mgExitMultiUi()
  }
  // change 分流入口（configpack.ts 调用）：>1 个文件进入 multi 模式
  function mgSetFiles(files) {
    mgFiles = files
    mgPwSaved = {}
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
    mgApplySourceFn = null
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
  // 与本机关系（追加导入碰撞标注，服务端 classifyRelations 对账回填）：overwrite=勾选即覆盖本机
  // 同名（红）；same-source=base_url+key 同源异名（橙）；new=全新（灰）。overwrite/same-source
  // 默认不勾——覆盖/重复是显式决策，默认只追加新东西
  var MG_REL = {
    'new': { cls: 'dim', zh: '全新', en: 'New' },
    'overwrite': { cls: 'err', zh: '覆盖本机', en: 'Overwrites', tip: ['勾选 = 接受覆盖本机同名服务（服务 id 保留，路由引用不断）', 'Checking overwrites the same-id local service (id kept so profile references stay intact)'] },
    'same-source': { cls: 'warn', zh: '已有同源', en: 'Same source', tip: ['base_url + key 与本机某服务相同但 id 不同；勾选将新增一条同源服务', 'Same base_url + key as a local service under a different id; checking adds it as another same-source service'] },
  }
  function mgRelationBadge(rel) {
    var m = MG_REL[rel || 'new'] || MG_REL['new']
    return '<span class="pill ' + m.cls + '">' + esc(t(m.zh, m.en)) + '</span>'
  }
  // 勾选默认按模式：替换=建议保留的（历史口径）；追加=全新且建议保留的（覆盖/重复是显式决策）
  function mgDefaultChecked(c) {
    if (mgMode === 'replace') return c.suggestion === 'keep'
    return (c.relation || 'new') === 'new' && c.suggestion === 'keep'
  }
  // 预览结果渲染进审阅宽弹层（mgRenderPreview 由 configpack.ts 的「预览」按钮回调触发，三入口共用）；
  // confirmToken 存 mgPendingToken 待 apply。列结构（勾选/服务/地址与Key/探针/建议/与本机关系）进
  // styles.ts 配方：地址格两行块形态（船东批准原型 /tmp/merge-proto/merge-flow.html）：首行 URL 剥
  // scheme 渲染 + direction:rtl 左截断保尾部（host/path 是服务间差异所在），title 悬浮全量含 scheme；
  // 次行 key 指纹，仅 duplicateCount > 1 才标「同源 ×n」——=1 是去重正常态，每行都标即纯噪音；来源清单并入服务列悬浮
  function mgRenderPreview(j) {
    mgLastPreview = j.preview || {}
    mgPendingToken = j.confirmToken || ''
    // 每次预览重置为追加默认（radio 与勾选默认随之重置——换模式是重语义操作，回默认最可预期）
    mgMode = 'add'
    var rAdd = document.getElementById('mgModeAdd')
    var rRep = document.getElementById('mgModeReplace')
    if (rAdd) rAdd.checked = true
    if (rRep) rRep.checked = false
    mgRenderRows()
    mgRenderSummary()
    mgM.open()
  }
  function mgRenderRows() {
    var pv = mgLastPreview || {}
    var cands = pv.candidates || []
    var rows = ''
    for (var i = 0; i < cands.length; i++) {
      var c = cands[i]
      var srcs = (c.sources || []).join(', ')
      var dupTxt = c.duplicateCount > 1 ? t('同源 ×{n}', 'same-source ×{n}', { n: c.duplicateCount }) : ''
      var rel = MG_REL[c.relation || 'new'] || MG_REL['new']
      rows += '<tr><td><input type="checkbox" class="mgKeep" data-id="' + esc(c.id) + '"' + (mgDefaultChecked(c) ? ' checked' : '') + '></td>' +
        '<td title="' + esc(c.id + (srcs ? ' · ' + srcs : '')) + '"><b>' + esc(c.id) + '</b></td>' +
        '<td class="mgurl"><span class="mgu" title="' + esc(c.base_url) + '">' + esc(c.base_url.replace(/^https?:\\/\\//, '')) + '</span><span class="mgsub">key ' + esc(c.key_fp || '-') + (dupTxt ? ' · <span class="mgdup">' + esc(dupTxt) + '</span>' : '') + '</span></td>' +
        '<td>' + mgVerdictBadge(c.verdict_state) + '</td>' +
        '<td>' + mgSuggestionBadge(c.suggestion) + '</td>' +
        '<td title="' + esc(rel.tip ? t(rel.tip[0], rel.tip[1]) : '') + '">' + mgRelationBadge(c.relation) + '</td></tr>'
    }
    if (!cands.length) rows = '<tr><td colspan="6" class="empty">' + esc(t('包内没有可合并的服务', 'No services to merge in the packages')) + '</td></tr>'
    var tbody = document.getElementById('mgReviewRows')
    if (tbody) tbody.innerHTML = rows
    mgSyncSelAll()
  }
  // 汇总行 + 应用按钮随模式与勾选联动：追加报 新增/覆盖/追加同源 计数；替换整行换 ⚠ 警示文案
  function mgCheckedIds() {
    return Array.prototype.map.call(document.querySelectorAll('#mgReviewRows .mgKeep:checked'), function (el) { return el.getAttribute('data-id') })
  }
  function mgRenderSummary() {
    var pv = mgLastPreview || {}
    var cands = pv.candidates || []
    var line = document.getElementById('mgReviewLine')
    var applyBtn = document.getElementById('mgReviewApply')
    var ids = mgCheckedIds()
    if (!cands.length) {
      if (line) line.textContent = t('包内没有可合并的服务', 'No services to merge in the packages')
      if (applyBtn) applyBtn.disabled = true
      return
    }
    if (applyBtn) applyBtn.disabled = !ids.length
    if (mgMode === 'add') {
      var n = { nw: 0, ov: 0, sm: 0 }
      for (var i = 0; i < cands.length; i++) {
        if (!ids.includes(cands[i].id)) continue
        var rel = cands[i].relation || 'new'
        if (rel === 'overwrite') n.ov++
        else if (rel === 'same-source') n.sm++
        else n.nw++
      }
      if (line) line.textContent = t('追加导入：本机现有 {l} 个服务不动 · 新增 {a} · 覆盖 {o} · 追加同源 {s} · 路由 {r}（悬空自动剔除）· 预设 {p} · 定时 {w}', 'Additive: {l} local services kept · {a} added · {o} overwritten · {s} same-source appended · {r} profiles (dangling auto-dropped) · {p} presets · {w} schedule rules', { l: pv.localProviders || 0, a: n.nw, o: n.ov, s: n.sm, r: pv.profileTotal || 0, p: pv.presetCount || 0, w: pv.scheduleRules || 0 })
      if (applyBtn) applyBtn.textContent = t('应用所选（{n}）', 'Apply selected ({n})', { n: ids.length })
    } else {
      if (line) line.textContent = '⚠ ' + t('整体替换（迁移）：本机现有 {l} 个服务将由所选 {k} 个取代（未勾选的包内服务一并丢弃），先自动快照', 'Replace all (migration): {l} local services will be replaced by the {k} selected (unchecked package services are dropped too); a snapshot is taken first', { l: pv.localProviders || 0, k: ids.length })
      if (applyBtn) applyBtn.textContent = t('替换为所选（{n}）', 'Replace with selected ({n})', { n: ids.length })
    }
  }
  // 模式切换：radio 监听（modal bodyHtml 静态节点，直接挂）→ 重渲染勾选默认与汇总——换模式是重
  // 语义操作，勾选回到该模式默认（用户可再手动调）
  var mgModeAddBtn = document.getElementById('mgModeAdd')
  if (mgModeAddBtn) mgModeAddBtn.addEventListener('change', function () { if (mgModeAddBtn.checked) { mgMode = 'add'; mgRenderRows(); mgRenderSummary() } })
  var mgModeRepBtn = document.getElementById('mgModeReplace')
  if (mgModeRepBtn) mgModeRepBtn.addEventListener('change', function () { if (mgModeRepBtn.checked) { mgMode = 'replace'; mgRenderRows(); mgRenderSummary() } })
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
    mgRenderSummary()
  })
  var mgReviewRowsBody = document.getElementById('mgReviewRows')
  if (mgReviewRowsBody) mgReviewRowsBody.addEventListener('change', function (e) {
    if (e.target && e.target.classList && e.target.classList.contains('mgKeep')) { mgSyncSelAll(); mgRenderSummary() }
  })
  function mgSetErr(msg) {
    var el = document.getElementById('mgReviewErr')
    if (el) el.textContent = msg || ''
  }
  var mgReviewBackBtn = document.getElementById('mgReviewBack')
  if (mgReviewBackBtn) mgReviewBackBtn.onclick = function () { mgM.close() }
  // 应用所选/替换为所选：成功=关审阅弹层+关配置包弹层 → 主页面 toast（动作关闭了弹层，toast 归宿合规）→ 整页刷新；
  // 失败=同样关审阅弹层回 tab，错误写 pkgErr 槽位（pkgM 仍开着，就近反馈；重试=再点一次预览，口令行原样保留）。
  // 载荷构造器 mgApplySourceFn 由 configpack.ts 在预览成功时注入（packages 重传 / url·ticket 暂存票据），
  // mode 随 radio（追加默认）；服务端 confirmToken 绑定内容摘要——预览与应用间内容变化即 400 重预览
  var mgReviewApplyBtn = document.getElementById('mgReviewApply')
  if (mgReviewApplyBtn) {
    mgReviewApplyBtn.onclick = function () {
      var ids = mgCheckedIds()
      if (!ids.length) { mgSetErr(t('请至少勾选一个要保留的服务', 'Select at least one service to keep')); return }
      if (!mgApplySourceFn) { mgSetErr(t('预览来源已失效，请重新预览', 'Preview source expired; preview again')); return }
      mgReviewApplyBtn.disabled = true
      mgSetErr('')
      Promise.resolve(mgApplySourceFn()).then(function (src) {
        return api('/merge/apply', { method: 'POST', body: JSON.stringify(Object.assign({ keep: ids, mode: mgMode, confirmToken: mgPendingToken }, src)) })
      }).then(function (j) {
        if (mgM.isOpen()) mgM.close()
        importToggle(false)
        var rep = j.report || {}
        var dropped = (j.droppedProfiles || []).length
        if (mgMode === 'add') {
          var ov = (rep.overwrittenProviders || []).length
          var skipped = (rep.skippedProfiles || []).length
          toast(t('已追加导入：新增 {n} · 覆盖 {o} · 路由 {r} · 预设 {p} · 定时 {w}', 'Added: {n} new · {o} overwritten · {r} profiles · {p} presets · {w} schedule rules', { n: Math.max(0, (rep.providers || []).length - ov), o: ov, r: (rep.profiles || []).length, p: rep.presetsAdded != null ? rep.presetsAdded : rep.presetCount || 0, w: rep.scheduleRulesAdded != null ? rep.scheduleRulesAdded : rep.scheduleRules || 0 })
            + (dropped ? t('；剔除悬空路由 {d} 条', '; {d} dangling profiles removed', { d: dropped }) : '')
            + (skipped ? t('；保留本机同名路由 {d} 条', '; {d} existing profiles kept', { d: skipped }) : ''), true)
        } else {
          toast(t('已整体替换：服务 {n} · 路由 {r}', 'Replaced: {n} services · {r} profiles', { n: (rep.providers || []).length, r: (rep.profiles || []).length })
            + (dropped ? t('；剔除悬空路由 {d} 条', '; {d} dangling profiles removed', { d: dropped }) : ''), true)
        }
        setTimeout(function () { location.reload() }, 1200)
      }).catch(function (e) {
        mgReviewApplyBtn.disabled = false
        if (mgM.isOpen()) mgM.close()
        setImpErr(t('应用失败：', 'Apply failed: ') + ((e && e.message) || e))
      })
    }
  }

`
