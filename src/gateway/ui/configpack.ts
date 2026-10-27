/**
 * Web 控制台 · configpack.ts —— 由单文件 ui.ts 按域拆分（T04 Phase 1，行为零变化）。
 * UI_JS_CONFIGPACK：分享/导入导出/legacy 迁移/nearby 局域网发现
 * 片段为模板字面量源文本：ui.ts 按原次序拼装后与拆分前逐字节一致；勿改动片段内换行/转义/次序。
 */
export const UI_JS_CONFIGPACK = `  function shareToggle(show) { if (show) pkgM.open(); else pkgM.close() }
  function importToggle(show) { if (show) pkgM.open(); else { stopNearbyPoll(); pkgM.close() } }
  // 仅分享弹窗内使用（点击复制链接/备选地址）：成功反馈一律走元素翻转（shareCopyFlip / 条目文案翻转）——
  // 弹窗磨砂遮罩会糊掉全局 toast，toast 在这里属遮挡死文案（AGENTS 弹层提示归宿）
  // 全站剪贴板收敛点（DUP-06）：写 + fallback + 成功反馈一份实现，各调用方只传 feedback。
  // 剪贴板 API 不可用（非安全上下文/老 webview）时回落 fallbackCopy 并同样触发 feedback。
  function copyText(text, feedback) {
    var done = function () { if (feedback) feedback() }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text); done() })
    } else { fallbackCopy(text); done() }
  }
  var shareFirstUrl = '' // 底栏「复制链接」按钮复制的对象（=urls[0]）
  var copyFlipTimer = null
  function shareCopyFlip() {
    var ic = document.getElementById('shareCopyIc')
    var tx = document.getElementById('shareCopyTxt')
    if (!ic || !tx) return
    ic.innerHTML = icon('check', 14)
    tx.textContent = t('已复制', 'Copied')
    if (copyFlipTimer) clearTimeout(copyFlipTimer)
    copyFlipTimer = setTimeout(function () {
      ic.innerHTML = icon('copy', 14)
      tx.textContent = t('复制链接', 'Copy link')
      copyFlipTimer = null
    }, 1600)
  }
  function renderShareUrls(urls) {
    var box = document.getElementById('shareUrls')
    if (!box) return
    var list = urls || []
    var toggle = document.getElementById('shareAltToggle')
    var altsWrap = document.getElementById('shareAlts')
    shareFirstUrl = list[0] || ''
    if (!list.length) { box.innerHTML = ''; if (toggle) toggle.hidden = true; if (altsWrap) altsWrap.hidden = true; return }
    box.innerHTML = '<div class="shareurl" data-i18n-title="对方在新电脑浏览器打开即可导入 · 点击复制||The recipient opens this in a browser on the new computer to import · click to copy" title="对方在新电脑浏览器打开即可导入 · 点击复制"><span class="u">' + esc(list[0]) + '</span></div>'
    applyI18nTree(box)
    var first = box.querySelector('.shareurl')
    if (first) first.onclick = function () { copyText(shareFirstUrl); shareCopyFlip() }
    var alts = list.slice(1)
    if (toggle) {
      toggle.hidden = !alts.length
      toggle.textContent = t('其他网卡地址（' + alts.length + '）', 'Other NIC addresses (' + alts.length + ')')
      toggle.classList.remove('open')
    }
    if (altsWrap) {
      altsWrap.hidden = !alts.length
      altsWrap.classList.remove('open')
      altsWrap.innerHTML = alts.map(function (u) { return '<p class="sharealt">' + esc(u) + '</p>' }).join('')
      Array.prototype.forEach.call(altsWrap.querySelectorAll('.sharealt'), function (el2, i2) {
        el2.onclick = function () {
          copyText(alts[i2])
          // 复制成功反馈 = 条目文案翻转（与「复制链接」按钮同款，1.6s 后还原）
          if (el2._flipT) clearTimeout(el2._flipT)
          el2.textContent = '✓ ' + t('已复制', 'Copied')
          el2._flipT = setTimeout(function () { el2.textContent = alts[i2]; el2._flipT = null }, 1600)
        }
      })
    }
  }
  function setShareErr(msg) {
    // shareM/importM 并入 pkgM 后三套错误归一到底栏同一个 msg 槽位
    var el = document.getElementById('pkgErr')
    if (el) el.textContent = msg || ''
  }
  function createOffer() {
    var btn = document.getElementById('shareRegen')
    if (btn) btn.disabled = true
    api('/sync/offer', { method: 'POST' })
      .then(function (j) {
        if (btn) btn.disabled = false
        setShareErr('')
        renderShareUrls(j.urls || [])
      })
      .catch(function (e) {
        if (btn) btn.disabled = false
        // 只在配置包弹层的「导出链接」tab 内触发（切 tab 自动生成 / 重新生成），错误一律写底栏槽位
        setShareErr(t('生成分享链接失败：', 'Failed to create the share link: ') + e.message)
      })
  }
  var shareAltToggle = document.getElementById('shareAltToggle')
  if (shareAltToggle) shareAltToggle.onclick = function () {
    shareAltToggle.classList.toggle('open')
    var w = document.getElementById('shareAlts')
    if (w) w.classList.toggle('open')
  }
  var shareCopyBtn = document.getElementById('shareCopyBtn')
  if (shareCopyBtn) shareCopyBtn.onclick = function () {
    if (!shareFirstUrl) return
    copyText(shareFirstUrl)
    shareCopyFlip()
  }
  var shareRegen = document.getElementById('shareRegen')
  if (shareRegen) shareRegen.onclick = createOffer

  // 导入弹层选项卡（互斥三来源）：nearby=自动搜索点选 / link=粘贴链接 / file=配置包文件。
  // 「导入」一键直达（apply 单请求）；错误写底栏左侧内联槽（弹层开着时 toast 会被磨砂遮罩糊住）
  var impTab = 'nearby'
  // 配置包统一弹层状态：pkgDirCur=一级方向（导出|导入），pkgExpTab=导出面板三方式
  var pkgDirCur = 'export'
  var pkgExpTab = 'file'
  var IMP_SEGS = { nearby: 'segNearby', link: 'segLink', file: 'segFile' }
  var IMP_PANELS = { nearby: 'panelNearby', link: 'panelLink', file: 'panelFile' }
  function setImpErr(msg) {
    // 与 setShareErr/setPkgErr 同槽：统一弹层只有一个底栏 msg 位
    var el = document.getElementById('pkgErr')
    if (el) el.textContent = msg || ''
  }
  function switchImpTab(tab) {
    impTab = tab
    setImpErr('')
    Object.keys(IMP_PANELS).forEach(function (k) {
      var seg = document.getElementById(IMP_SEGS[k])
      var panel = document.getElementById(IMP_PANELS[k])
      if (seg) seg.className = k === tab ? 'on' : ''
      if (panel) panel.hidden = k !== tab
    })
    updateImpPrimary()
    if (tab === 'nearby') searchNearbyPeers()
  }
  function updateImpPrimary() {
    var btn = document.getElementById('impImportBtn')
    if (!btn) return
    // 只在导入方向显示；附近 tab 无需按钮（对方授权即确认门）
    btn.hidden = pkgDirCur !== 'import' || impTab === 'nearby'
    if (btn.hidden) return
    if (impTab === 'link') {
      var u = document.getElementById('impUrl')
      btn.disabled = !(u && u.value.trim())
    } else {
      var f = document.getElementById('impFile2')
      btn.disabled = !(f && f.files.length)
    }
  }
  function showImpFileChip(file) {
    var chip = document.getElementById('impFileChip')
    if (!chip) return
    if (!file) { chip.hidden = true; chip.innerHTML = ''; return }
    chip.innerHTML = ''
    var nm = document.createElement('span')
    nm.className = 'fname'
    nm.textContent = file.name
    var rm = document.createElement('button')
    rm.type = 'button'
    rm.title = t('移除', 'Remove')
    rm.innerHTML = icon('close', 11)
    rm.onclick = function () {
      var f = document.getElementById('impFile2')
      if (f) f.value = ''
      showImpFileChip(null)
      updateImpPrimary()
    }
    chip.appendChild(nm)
    chip.appendChild(rm)
    chip.hidden = false
  }
  function openImportOverlay() {
    openPkgOverlay('import') // 空态入口固定落在导入方向（附近电脑默认 tab）
  }
  var segNearby = document.getElementById('segNearby')
  if (segNearby) segNearby.onclick = function () { switchImpTab('nearby') }
  var segLink = document.getElementById('segLink')
  if (segLink) segLink.onclick = function () { switchImpTab('link') }
  var segFile = document.getElementById('segFile')
  if (segFile) segFile.onclick = function () { switchImpTab('file') }
  var impFileBtn = document.getElementById('impFileBtn')
  if (impFileBtn) impFileBtn.onclick = function () { var f = document.getElementById('impFile2'); if (f) f.click() }
  var impFile2 = document.getElementById('impFile2')
  if (impFile2) impFile2.addEventListener('change', function () { showImpFileChip(this.files[0]); setImpErr(''); updateImpPrimary() })
  var impUrlInput = document.getElementById('impUrl')
  if (impUrlInput) impUrlInput.addEventListener('input', function () { setImpErr(''); updateImpPrimary() })
  var impPw2Input = document.getElementById('impPw2')
  if (impPw2Input) impPw2Input.addEventListener('input', function () { setImpErr('') })
  var impImportBtn = document.getElementById('impImportBtn')
  if (impImportBtn) {
    impImportBtn.onclick = function () {
      var btn = this
      var bodyP
      if (impTab === 'link') {
        var link = (document.getElementById('impUrl').value || '').trim()
        var i = link.indexOf('#p=')
        if (i < 0) { setImpErr(t('链接缺口号段（#p=…）：请回旧电脑复制完整链接', 'The link lacks the passphrase part (#p=…): copy the full link on the old computer')); return }
        bodyP = Promise.resolve({ kind: 'url', url: link.slice(0, i), passphrase: link.slice(i + 3) })
      } else {
        var f = document.getElementById('impFile2').files[0]
        var pw = document.getElementById('impPw2').value || ''
        if (!pw) { setImpErr(t('请输入导出时设置的口令', 'Enter the passphrase set at export')); return }
        bodyP = f.text().then(function (txt) { return { kind: 'file', file: txt, passphrase: pw } })
      }
      btn.disabled = true
      setImpErr('')
      hideImpPreview()
      // 先预览（服务端解包出 report，包不入库）再确认：对齐 CLI 的「将被替换/不受影响」确认步
      bodyP
        .then(function (src) { return api('/sync/import', { method: 'POST', body: JSON.stringify({ phase: 'preview', source: src }) }) })
        .then(function (j) {
          impPendingTicket = j.ticket || ''
          var rep = j.report || {}
          var meta = j.meta || {}
          var line = document.getElementById('impPreviewLine')
          if (line) {
            line.textContent = t('将导入：服务 {n} · 路由 {n2} · 预设 {n3} · 定时规则 {n4}', 'Will import: {n} providers · {n2} profiles · {n3} presets · {n4} schedule rules')
              .replace('{n}', (rep.providers || []).length).replace('{n2}', (rep.profiles || []).length).replace('{n3}', rep.presetCount || 0).replace('{n4}', rep.scheduleRules || 0)
              + (meta.createdBy ? t('（配置包来自 ', ' (package from ') + meta.createdBy + t('）', ')') : '')
              + t('。导入会整体替换现有配置（自动快照）。', '. This replaces the whole current config (snapshot taken first).')
          }
          var pv = document.getElementById('impPreview')
          if (pv) pv.hidden = false
          btn.disabled = false
        })
        .catch(function (e) { setImpErr(t('读取配置包失败：', 'Failed to read the package: ') + e.message); btn.disabled = false })
    }
  }
  // 预览 → 确认：确认时凭 preview 发放的一次性 ticket 直发 apply（与附近直拉链路同一形态）
  var impPendingTicket = ''
  function hideImpPreview() {
    impPendingTicket = ''
    var pv = document.getElementById('impPreview')
    if (pv) pv.hidden = true
  }
  var impConfirmBtn = document.getElementById('impConfirmBtn')
  if (impConfirmBtn) {
    impConfirmBtn.onclick = function () {
      impConfirmBtn.disabled = true
      setImpErr('')
      api('/sync/import', { method: 'POST', body: JSON.stringify({ phase: 'apply', source: { kind: 'ticket', ticket: impPendingTicket } }) })
        .then(impApplyResult)
        .catch(function (e) { setImpErr(t('导入失败：', 'Import failed: ') + e.message); impConfirmBtn.disabled = false })
    }
  }
  var impBackBtn = document.getElementById('impBackBtn')
  if (impBackBtn) impBackBtn.onclick = hideImpPreview
  // 成功收尾（link/file/nearby 共用）：关弹层 → 主页面 toast 报数量（有需补填的 key 再追一条警告，
  // 并多留几秒看清再刷新）→ 整页刷新拿全新视图
  function impApplyResult(j) {
    var rep = j.report || {}
    var warns = impWarnList(rep)
    importToggle(false)
    toast(t('已导入：服务 {n} · 路由 {n2} · 预设 {n3} · 定时规则 {n4}', 'Imported: {n} providers · {n2} profiles · {n3} presets · {n4} schedule rules')
      .replace('{n}', (rep.providers || []).length).replace('{n2}', (rep.profiles || []).length).replace('{n3}', rep.presetCount || 0).replace('{n4}', rep.scheduleRules || 0), true)
    if (warns.length) toast(warns.join(t('；', '; ')), false)
    setTimeout(function () { location.reload() }, warns.length ? 3000 : 600)
  }
  // 分享/导出/导入/确认/更新弹层的遮罩点击与 Esc 已全部由工厂壳承接，此处不再有手写监听

  // 配置包统一弹层：方向（导出|导入）与导出三方式（附近的电脑/链接/文件）的切换、
  // 底栏按钮随 tab 显隐（一个 msg 槽 + 各方向自己的主按钮）、LAN 前置状态、入口分发
  function setPkgErr(msg) {
    var el = document.getElementById('pkgErr')
    if (el) el.textContent = msg || ''
  }
  function updatePkgFoot() {
    var show = { shareRegen: false, shareCopyBtn: false, impImportBtn: false, pkgSaveBtn: false }
    if (pkgDirCur === 'export') {
      if (pkgExpTab === 'link') { show.shareRegen = true; show.shareCopyBtn = true }
      if (pkgExpTab === 'file') show.pkgSaveBtn = true
    } else {
      show.impImportBtn = true
    }
    Object.keys(show).forEach(function (id) {
      var b = document.getElementById(id)
      if (b) b.hidden = !show[id]
    })
    updateImpPrimary()
  }
  function setPkgDir(dir) {
    pkgDirCur = dir
    var de = document.getElementById('pkgDirExport')
    var di = document.getElementById('pkgDirImport')
    if (de) de.className = dir === 'export' ? 'on' : ''
    if (di) di.className = dir === 'import' ? 'on' : ''
    var ep = document.getElementById('pkgExportPane')
    var ip = document.getElementById('pkgImportPane')
    if (ep) ep.hidden = dir !== 'export'
    if (ip) ip.hidden = dir !== 'import'
    if (dir === 'export') switchExpTab(pkgExpTab || 'file')
    else switchImpTab(impTab || 'nearby')
    updatePkgFoot()
  }
  var EXP_SEGS = { nearby: 'segExpNearby', link: 'segExpLink', file: 'segExpFile' }
  var EXP_PANELS = { nearby: 'panelExpNearby', link: 'panelExpLink', file: 'panelExpFile' }
  function switchExpTab(tab) {
    pkgExpTab = tab
    setPkgErr('')
    hideImpPreview()
    Object.keys(EXP_PANELS).forEach(function (k) {
      var seg = document.getElementById(EXP_SEGS[k])
      var panel = document.getElementById(EXP_PANELS[k])
      if (seg) seg.className = k === tab ? 'on' : ''
      if (panel) panel.hidden = k !== tab
    })
    if (tab === 'nearby') renderExpNearby()
    if (tab === 'link' && !shareFirstUrl) createOffer() // 首次切到链接 tab 自动生成，无需先找按钮
    updatePkgFoot()
  }
  function renderExpNearby() {
    var st = document.getElementById('expNearbyState')
    var on = document.getElementById('expLanOn')
    if (!st) return
    if (lanOn) {
      st.textContent = t('✓ 局域网可达：手机远程已开启，附近电脑可以搜索到这台电脑。', '✓ On the LAN: mobile console is on — nearby computers can find this machine.')
      st.className = 'testline ok'
      if (on) on.hidden = true
    } else {
      st.textContent = t('手机远程未开启：附近电脑暂时搜不到这台电脑。', 'Mobile console is off — nearby computers cannot find this machine yet.')
      st.className = 'testline'
      if (on) on.hidden = false
    }
  }
  function openPkgOverlay(dir) {
    stopNearbyPoll()
    var pw = document.getElementById('pkgPw')
    var u = document.getElementById('impUrl')
    var f = document.getElementById('impFile2')
    var pw2 = document.getElementById('impPw2')
    if (pw) pw.value = ''
    if (u) u.value = ''
    if (f) f.value = ''
    if (pw2) pw2.value = ''
    showImpFileChip(null)
    setPkgErr('')
    hideImpPreview()
    renderShareUrls([])
    // 方向按配置状态推断：空配置=新电脑要导入；有配置=多半是分享/迁移出去
    setPkgDir(dir || (view && view.services && view.services.length ? 'export' : 'import'))
    pkgM.open()
  }
  var pkgPill = document.getElementById('pkgPill')
  if (pkgPill) pkgPill.onclick = function () { openPkgOverlay() }
  var pkgDirExport = document.getElementById('pkgDirExport')
  if (pkgDirExport) pkgDirExport.onclick = function () { setPkgDir('export') }
  var pkgDirImport = document.getElementById('pkgDirImport')
  if (pkgDirImport) pkgDirImport.onclick = function () { setPkgDir('import') }
  var segExpNearby = document.getElementById('segExpNearby')
  if (segExpNearby) segExpNearby.onclick = function () { switchExpTab('nearby') }
  var segExpLink = document.getElementById('segExpLink')
  if (segExpLink) segExpLink.onclick = function () { switchExpTab('link') }
  var segExpFile = document.getElementById('segExpFile')
  if (segExpFile) segExpFile.onclick = function () { switchExpTab('file') }
  var expLanOn = document.getElementById('expLanOn')
  if (expLanOn) {
    expLanOn.onclick = function () {
      expLanOn.disabled = true
      api('/lan', { method: 'POST', body: JSON.stringify({ enabled: true }) })
        .then(function (r) {
          if (r && r.ok === false) throw new Error(r.error || '')
          lanOn = true
          applyLanPill(true) // 与状态行 pill 共用同一份开关状态，别处轮询重绘不回灌
          setPkgErr('')
          renderExpNearby()
          loadLanStatus()
        })
        .catch(function (e) { setPkgErr(t('开启手机远程失败：', 'Failed to enable mobile console: ') + e.message) })
        .then(function () { expLanOn.disabled = false })
    }
  }
  var pkgSaveBtn = document.getElementById('pkgSaveBtn')
  if (pkgSaveBtn) {
    pkgSaveBtn.onclick = function () {
      var pw = (document.getElementById('pkgPw').value || '')
      if (!pw) { setPkgErr(t('请设置导出口令', 'Set an export passphrase')); return }
      pkgSaveBtn.disabled = true
      api('/config/export', { method: 'POST', body: JSON.stringify({ passphrase: pw }) })
        .then(function (j) {
          var blob = new Blob([JSON.stringify(j.envelope, null, 2)], { type: 'application/octet-stream' })
          var a = document.createElement('a')
          a.href = URL.createObjectURL(blob)
          a.download = j.filename || 'modeldock-config.msync'
          document.body.appendChild(a)
          a.click()
          setTimeout(function () { URL.revokeObjectURL(a.href); a.remove() }, 0)
          pkgM.close()
          toast(t('配置包已生成，浏览器开始下载', 'Package created; your browser is downloading it'), true)
        })
        .catch(function (e) { setPkgErr(t('导出失败：', 'Export failed: ') + e.message) })
        .then(function () { pkgSaveBtn.disabled = false })
    }
  }

  // 存量收编重开入口（添加服务弹层 → 勾选导入）：/import/detect 候选可勾选，/import/apply 按 ids 应用；
  // 收编与配置包导入是两个概念（收编=本机客户端配置；配置包=.msync 文件/链接/附近）
  var legacyCands = []
  var legacyChecked = []
  function setLegacyErr(msg) {
    var el = document.getElementById('legacyErr')
    if (el) el.textContent = msg || ''
  }
  function updateLegacyGo() {
    var go = document.getElementById('legacyGo')
    if (!go) return
    var n = legacyChecked.filter(function (x) { return x }).length
    go.disabled = n === 0
    // 浏览器内嵌 t() 只有两参（不支持 params 占位），占位符手动 replace（与 impApplyResult 同法）
    go.textContent = t('导入所选（{n}）', 'Import selected ({n})').replace('{n}', String(n))
  }
  function renderLegacy() {
    var list = document.getElementById('legacyList')
    var desc = document.getElementById('legacyDesc')
    legacyCands = []
    legacyChecked = []
    if (list) list.innerHTML = ''
    if (desc) desc.textContent = t('正在检测本机客户端的存量配置…', 'Scanning local apps for existing configs…')
    setLegacyErr('')
    api('/import/detect', { timeoutMs: 20000 })
      .then(function (r) {
        var cands = (r.candidates || []).filter(function (c) { return !c.skipReason && c.base_url })
        legacyCands = cands
        legacyChecked = cands.map(function () { return true })
        if (desc) desc.textContent = cands.length
          ? t('检测到 {n} 个模型服务，勾选要搬进来的：', 'Found {n} model services. Pick the ones to bring in:').replace('{n}', String(cands.length))
          : t('没有检测到可导入的存量配置。', 'No importable legacy configs found.')
        if (list) {
          list.innerHTML = ''
          cands.forEach(function (c, i) {
            var row = document.createElement('label')
            row.className = 'legacyrow'
            var cb = document.createElement('input')
            cb.type = 'checkbox'
            cb.checked = true
            cb.onchange = function () { legacyChecked[i] = cb.checked; updateLegacyGo() }
            var nm = document.createElement('span')
            nm.className = 'lname'
            nm.textContent = c.name + (c.isCurrent ? t('（使用中）', ' (in use)') : '') +
              (c.hasKey ? '' : t('（无 Key）', ' (no key)')) + (c.sameSite ? ' · ' + c.sameSite : '')
            var src = document.createElement('span')
            src.className = 'lsrc'
            src.textContent = SRC_LABEL[c.source] || c.source
            row.appendChild(cb)
            row.appendChild(nm)
            row.appendChild(src)
            list.appendChild(row)
          })
        }
        updateLegacyGo()
      })
      .catch(function (e) {
        if (desc) desc.textContent = ''
        setLegacyErr(t('检测失败：', 'Detection failed: ') + e.message)
      })
  }
  var legacyImportLink = document.getElementById('legacyImportLink')
  if (legacyImportLink) legacyImportLink.onclick = function () {
    // 切换弹层而非叠加：addM 的壳在 DOM 里更靠后，同 z-index 会盖住 legacyM（实测点击被其遮罩吃掉）
    addM.close()
    legacyM.open()
    renderLegacy()
  }
  var legacyGo = document.getElementById('legacyGo')
  if (legacyGo) {
    legacyGo.onclick = function () {
      var picked = legacyCands.filter(function (_, i) { return legacyChecked[i] })
      var ids = picked.map(function (c) { return c.id })
      if (!ids.length) return
      legacyGo.disabled = true
      api('/import/apply', { method: 'POST', body: JSON.stringify({ ids: ids }) })
        .then(function (r) {
          var n = (r.imported || []).length
          // 导入成功后记住这些候选地址：之后删除该服务，自动弹卡不再拿它回头
          dismissCandidates(picked.map(function (c) { return c.base_url }))
          legacyM.close()
          toast('✓ ' + t('已导入 ', 'Imported ') + n + t(' 个服务，下方「我的服务」里可以查看和切换', ' services. See and switch them under "My services" below'), true)
          return load()
        })
        .catch(function (e) { setLegacyErr(t('导入失败：', 'Import failed: ') + e.message); legacyGo.disabled = false })
    }
  }

  // 附近电脑确认式直拉（sync-nearby）
  // B 侧：切到「附近的电脑」标签即自动搜索 → 点卡片「导入」→ 敲门 → 轮询对方裁决 →
  // granted 直接凭 ticket 应用（A 侧确认卡就是安全门，B 侧不再二次确认）；A 侧：确认卡 [允许][拒绝]（overview 轮询驱动）
  var nearPoll = null
  function stopNearbyPoll() {
    if (nearPoll) { clearInterval(nearPoll); nearPoll = null }
    // 恢复所有电脑卡片可点（等待期间它们被置灰防并发）
    Array.prototype.forEach.call(document.querySelectorAll('#impPeers .peercard button'), function (b) { b.disabled = false })
  }
  function setNearbyStatus(text) {
    var st = document.getElementById('nearbyStatus')
    if (st) st.textContent = text || ''
  }
  function addRescanLink(box) {
    if (!box) return
    box.innerHTML = ''
    var link = document.createElement('button')
    link.type = 'button'
    link.className = 'btn small'
    link.textContent = t('重新搜索', 'Search again')
    link.onclick = function () { link.disabled = true; searchNearbyPeers() }
    box.appendChild(link)
  }
  function searchNearbyPeers() {
    var box = document.getElementById('impPeers')
    stopNearbyPoll()
    setNearbyStatus(t('正在搜索附近运行 ModelDock 的电脑…', 'Searching for computers running ModelDock nearby…'))
    if (box) box.innerHTML = ''
    api('/sync/discover', { method: 'POST', timeoutMs: 8000 })
      .then(function (j) {
        var peers = j.peers || []
        if (!peers.length) {
          setNearbyStatus(t('附近没找到电脑：两台电脑需连同一 Wi-Fi，且旧电脑已开启「手机远程」。', 'No nearby computers found: both computers need the same Wi-Fi, and the old computer needs "Mobile console" on.'))
          addRescanLink(box)
          return
        }
        setNearbyStatus('')
        if (box) {
          box.innerHTML = ''
          peers.forEach(function (p) {
            var card = document.createElement('div')
            card.className = 'peercard'
            var nm = document.createElement('span')
            nm.className = 'pname'
            nm.textContent = p.name || (p.ips && p.ips[0]) || '?'
            var go = document.createElement('button')
            go.type = 'button'
            go.className = 'btn small primary'
            go.textContent = t('导入', 'Import')
            go.onclick = function () { requestNearby(p.ips || [p.ip], p.port, p.name || nm.textContent, card, go) }
            card.appendChild(nm)
            card.appendChild(go)
            box.appendChild(card)
          })
        }
      })
      .catch(function (e) {
        setNearbyStatus(t('搜索失败：', 'Search failed: ') + e.message)
        addRescanLink(box)
      })
  }
  function requestNearby(ips, port, name, card, goBtn) {
    // 等待期间置灰全部卡片防并发；就地提示而非 toast（结果要等几十秒）
    Array.prototype.forEach.call(document.querySelectorAll('#impPeers .peercard button'), function (b) { b.disabled = true })
    api('/sync/request-remote', { method: 'POST', body: JSON.stringify({ ips: ips, port: port }), timeoutMs: 10000 })
      .then(function (j) {
        setNearbyStatus(t('已向「', 'Request sent to "') + (name || '?') + t('」发送请求，等待允许…（最多 60 秒）', '" — waiting for approval… (up to 60s)'))
        var deadline = Date.now() + 65000
        nearPoll = setInterval(function () {
          if (Date.now() > deadline) {
            stopNearbyPoll()
            setNearbyStatus(t('对方未响应（超时）。可改用「粘贴链接」或「配置包文件」。', 'No response (timed out). Try "Paste a link" or "Package file" instead.'))
            return
          }
          api('/sync/remote-status?id=' + encodeURIComponent(j.requestId))
            .then(function (st) {
              if (st.status === 'granted') {
                stopNearbyPoll()
                setNearbyStatus(t('对方已允许，正在导入…', 'Approved — importing…'))
                api('/sync/import', { method: 'POST', body: JSON.stringify({ phase: 'apply', source: { kind: 'ticket', ticket: st.ticket } }) })
                  .then(impApplyResult)
                  .catch(function (e) {
                    stopNearbyPoll()
                    setNearbyStatus(t('导入失败：', 'Import failed: ') + e.message)
                  })
              } else if (st.status === 'denied') {
                stopNearbyPoll()
                setNearbyStatus(t('对方已拒绝本次请求。', 'The other computer declined this request.'))
              } else if (st.status === 'failed' || st.status === 'timeout') {
                stopNearbyPoll()
                setNearbyStatus(t('拉取失败：', 'Pull failed: ') + (st.error || t('超时', 'timed out')))
              }
            })
            .catch(function () { /* 单次轮询失败忽略，下一轮再试 */ })
        }, 1000)
      })
      .catch(function (e) {
        stopNearbyPoll()
        setNearbyStatus(t('请求失败：', 'Request failed: ') + e.message)
      })
  }
  // A 侧确认卡按钮（卡片显隐由 renderShareRequest 随 overview 轮询驱动）
  var shareReqAllow = document.getElementById('shareReqAllow')
  if (shareReqAllow) {
    shareReqAllow.onclick = function () {
      var req = view ? view.syncRequest : null
      if (!req) return
      api('/sync/offer-approve', { method: 'POST', body: JSON.stringify({ nonce: req.nonce, approve: true }) })
        .then(function () { toast(t('已允许：一次性直拉链接已生成（10 分钟内有效），对方将自动拉取', 'Approved: one-time pull link created (valid 10 min); the other computer will pull automatically'), true) })
        .catch(function (e) { toast(t('操作失败：', 'Failed: ') + e.message, false) })
    }
  }
  var shareReqDeny = document.getElementById('shareReqDeny')
  if (shareReqDeny) {
    shareReqDeny.onclick = function () {
      var req = view ? view.syncRequest : null
      if (!req) return
      api('/sync/offer-approve', { method: 'POST', body: JSON.stringify({ nonce: req.nonce, approve: false }) })
        .then(function () { toast(t('已拒绝', 'Denied'), true) })
        .catch(function (e) { toast(t('操作失败：', 'Failed: ') + e.message, false) })
    }
  }

  // 定时切换：面板与编辑（窗口按顺序取首个命中；节假日名单日整体跳过）
`
