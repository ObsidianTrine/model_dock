/**
 * Web 控制台 · overview.ts —— 由单文件 ui.ts 按域拆分（T04 Phase 1，行为零变化）。
 * UI_JS_APP：应用级：load/loadCatalog/登录引导/迁移卡/健康轮询
 * UI_JS_OVERVIEW：概览轮询：trayLite 入口、uiPresence、pollOverview
 * UI_JS_BOOT：启动接线：轮询定时器、visibilitychange、侧边导航
 * 片段为模板字面量源文本：ui.ts 按原次序拼装后与拆分前逐字节一致；勿改动片段内换行/转义/次序。
 */
export const UI_JS_APP = `  function load() {
    // 首屏 overview 比常规请求慢：冷启动要等全部 adapter status 探测（Windows 注册表探测单次最长 8s，
    // 见 presence.ts），默认 15s 在低内存/慢盘机器上会误超时，放宽到 45s
    return api('/overview', { timeoutMs: 45000 }).then(function (v) {
      view = v
      knownModels = Object.assign({}, catalogTable, (v && v.knownModels) || {})
      // 首屏同感知轻量模式广播（正常应为 0：服务端在 /ui 加载时已清广播并失效缓存；留守防护真并发）
      var tor = (v && v.gateway && v.gateway.trayLiteRequest) || 0
      if (tor > lastTrayLiteRequestSeen) { lastTrayLiteRequestSeen = tor; enterTrayLite() }
      loadCatalog()
      render()
      // 首次加载即刷新沙箱徽标与配置路径显示（pollOverview 只管后续轮询）
      $('#health').innerHTML = healthHtml()
      var cp = document.getElementById('cfgPath')
      if (cp && v.gateway && v.gateway.home) cp.textContent = v.gateway.home
      return checkMigrate()
    })
  }

  // models.dev 目录大表懒加载（只拉一次）：失败静默，自动补值仍有 overview 内置小表兜底
  function loadCatalog() {
    if (loadCatalog.done) return
    loadCatalog.done = true
    fetch('/_modeldock/model-catalog', { headers: { 'x-modeldock-lang': LANG } }).then(function (r) { return r.ok ? r.json() : null }).then(function (v) {
      if (!v || !v.models) return
      catalogTable = v.models
      knownModels = Object.assign({}, catalogTable, (view && view.knownModels) || {})
    }).catch(function () {})
  }

  // 管理面已全面要求 admin 凭据：未登录（无 ?token= / cookie）打开时给出可操作的恢复路径。
  // 优先「重新登录」按钮：凭 1 年期设备记忆 cookie（首次 ?token= 登录时种下）一键恢复；
  // 无设备记忆（新浏览器/清理过 cookie）→ 按钮自动换成令牌粘贴输入框，Web 用户全流程不碰终端。
  function showLoginRequired() {
    var w = document.querySelector('.wrap')
    if (!w) return
    w.innerHTML = '<div class="loginbox"><span class="name">' + iconInline('lock', 15) + ' ' +
      t('需要登录', 'Login required') + '</span>' +
      '<p class="desc">' + t('控制台已开启令牌保护。本浏览器登录过的话，点「重新登录」即可恢复；新浏览器请粘贴网关令牌。', 'The console is token-protected. If this browser has logged in before, click Re-login to restore; on a new browser, paste the gateway token.') + '</p>' +
      '<p class="desc">' + t('本机菜单栏 / 系统托盘有 ModelDock 图标的话，点它选「打开控制台」或「在浏览器打开」，一键登录，无需粘贴令牌。', 'If the ModelDock icon is in the menu bar / system tray, click it and choose "Open Console" or "Open in Browser" to sign in with one click — no pasting needed.') + '</p>' +
      '<p><button class="btn" id="reloginBtn">' + t('重新登录', 'Re-login') + '</button></p>' +
      '<p id="tokenRow" hidden><input type="text" class="linput" id="tokenInput" placeholder="' + esc(t('粘贴网关令牌（mdkadm_…）', 'Paste the gateway token (mdkadm_…)')) + '"> <button class="btn small" id="tokenBtn">' + t('登录', 'Log in') + '</button></p>' +
      '<p class="desc" id="loginMsg" hidden></p></div>'
    var msg = document.getElementById('loginMsg')
    function fail(m) {
      if (!msg) return
      msg.textContent = m
      msg.hidden = false
    }
    var rb = document.getElementById('reloginBtn')
    if (rb) rb.onclick = function () {
      rb.disabled = true
      fetch('/_modeldock/auth/relogin', { method: 'POST', headers: { 'x-modeldock-lang': LANG } }).then(function (r) {
        if (r.ok) { location.reload(); return }
        var row = document.getElementById('tokenRow')
        if (row) row.hidden = false
        rb.hidden = true
        fail(t('本浏览器没有设备记忆，请粘贴网关令牌登录（令牌见 __MD_GATEWAY_STATE__ 的 admin_token）。', 'No device memory in this browser; paste the gateway token (admin_token in __MD_GATEWAY_STATE__).'))
      }).catch(function (e) {
        rb.disabled = false
        fail(String((e && e.message) || e))
      })
    }
    var tb = document.getElementById('tokenBtn')
    if (tb) tb.onclick = function () {
      var input = document.getElementById('tokenInput')
      var v = input && input.value ? input.value.trim() : ''
      if (!v) return
      location.href = '/_modeldock/ui?token=' + encodeURIComponent(v)
    }
    var ti = document.getElementById('tokenInput')
    if (ti) ti.onkeydown = function (e) { if (e && e.key === 'Enter' && tb) tb.onclick() }
  }

  // 旧配置一键迁移（cc-switch / Claude Code / Codex / dsh / ZCode / OpenCode / MiMo / WorkBuddy / CCR / Crush / Gemini CLI）
  var SRC_LABEL = {
    'cc-switch': 'cc-switch',
    claude: 'Claude Code',
    dsh: 'dsh',
    zcode: 'ZCode',
    codex: 'Codex CLI',
    opencode: 'OpenCode',
    mimocode: 'MiMo Code',
    workbuddy: 'WorkBuddy',
    ccr: 'Claude Code Router',
    crush: 'Crush',
    gemini: 'Gemini CLI',
  }

  // 忽略候选（服务端持久化，跨浏览器生效）：自动弹卡不再提示；失败静默（只影响提醒，不影响功能）
  function dismissCandidates(urls) {
    return api('/import/dismiss', { method: 'POST', body: JSON.stringify({ urls: urls }) }).catch(function () {})
  }

  function checkMigrate() {
    return api('/import/detect')
      .then(function (r) {
        try { localStorage.removeItem('mdk_mig_skip') } catch (e) { /* 旧版按签名的跳过记忆已被服务端 dismissed 取代 */ }
        var card = $('#migrateCard')
        var cands = (r.candidates || []).filter(function (c) { return !c.skipReason && c.base_url && !c.dismissed })
        var keyed = cands.filter(function (c) { return c.hasKey })
        var keyless = cands.filter(function (c) { return !c.hasKey })
        // 只在有 Key 的候选时弹卡：无 Key 的多为登录态/环境变量引用，一键导入不了还添堵（要用「添加服务 → 勾选导入」手动搬）
        if (keyed.length === 0) { card.hidden = true; return }
        var names = keyed.map(function (c) {
          return c.name + (c.isCurrent ? t('（使用中）', ' (in use)') : '')
        }).join('、')
        var srcs = []
        cands.forEach(function (c) {
          var label = SRC_LABEL[c.source] || c.source
          if (srcs.indexOf(label) < 0) srcs.push(label)
        })
        var desc = t('在 <b>', 'Found ') + esc(srcs.join('、')) + t('</b> 里发现 ', ' model services in <b>') + keyed.length + t(' 个模型服务：<b>', '</b>: <b>') +
          esc(names) + t('</b>。导入后它们的 Key 会一并安全搬进 ModelDock，原软件不受任何影响。', '</b>. Importing moves their keys safely into ModelDock; the original apps are untouched.')
        if (keyless.length) {
          desc += '<br>' + t('另有 ', 'Also found ') + keyless.length +
            t(' 个无 Key 的配置不自动导入（多为登录态或环境变量引用）：', ' keyless configs are not auto-imported (OAuth logins or env/file references): ') +
            esc(keyless.map(function (c) { return c.name }).join('、')) +
            t('。需要的话用「添加服务 → 勾选导入」手动搬。', '. Use "Add service → Import" to bring them in manually.')
        }
        $('#migDesc').innerHTML = desc
        card.hidden = false
        // 导入/忽略后记住本轮展示过的全部候选地址（含无 Key 的），删除服务等后续变化不再让卡片回弹
        var dismissAll = function () {
          return dismissCandidates(cands.map(function (c) { return c.base_url }))
        }
        var importIds = function (ids) {
          $('#migGo').disabled = true
          $('#migMsg').textContent = t('导入中…', 'Importing…')
          $('#migMsg').className = 'testline'
          api('/import/apply', { method: 'POST', body: JSON.stringify({ ids: ids }) })
            .then(function (r) {
              var n = (r.imported || []).length
              toast('✓ ' + t('已导入 ', 'Imported ') + n + t(' 个服务，下方「我的服务」里可以查看和切换', ' services. See and switch them under "My services" below'), true)
              card.hidden = true
              return dismissAll().then(function () { return load() })
            })
            .catch(function (e) {
              $('#migMsg').textContent = t('导入失败：', 'Import failed: ') + e.message
              $('#migMsg').className = 'testline err'
              $('#migGo').disabled = false
            })
        }
        $('#migGo').onclick = function () { importIds(keyed.map(function (c) { return c.id })) }
        var still = $('#migStill')
        if (still) {
          still.hidden = keyless.length === 0
          still.onclick = function () { importIds(cands.map(function (c) { return c.id })) }
        }
        $('#migSkip').onclick = function () {
          dismissAll()
          card.hidden = true
        }
      })
      .catch(function () {})
  }

  function healthHtml() {
    var sandbox = view && view.gateway && view.gateway.sandbox
    return '<span class="dot"></span> ' + t('本地网关运行中 · 端口 ', 'Local gateway running · port ') + esc(location.port) +
      (sandbox ? ' <span class="pill warn" title="' + t('dev 沙箱实例：配置、日志与客户端写入均在沙箱目录内，不影响生产', 'dev sandbox instance: config, logs and client writes stay in the sandbox dir; production is untouched') + '">' + t('dev 沙箱', 'dev sandbox') + '</span>' : '')
  }

  function pollHealth() {
    fetch('/_modeldock/health', { headers: { 'x-modeldock-lang': LANG } }).then(function (r) { return r.json() }).then(function (j) {
      $('#health').innerHTML = healthHtml()
    }).catch(function () {
      $('#health').innerHTML = t('网关未响应', 'Gateway not responding')
    })
  }

  // 轻量模式（Clash Verge 式「只留托盘」）：进入动作在托盘发起，服务端把广播时间戳放在
  // overview.gateway.trayLiteRequest；页面看到新于上次所见的请求即自关（--app 窗口可靠；
  // 普通标签页被浏览器拦截脚本关窗时，下方提示层兜底）。打开页面本身即自动退出轻量模式
  // （服务端在 GET /_modeldock/ui 命中时清广播并失效缓存），页面侧无需上报「打开」。
`
export const UI_JS_OVERVIEW = `  var lastTrayLiteRequestSeen = 0
  var trayLiteM = createModal({
    id: 'trayLiteOverlay',
    title: '已进入轻量模式||Lightweight mode is on',
    closeButton: false,
    closeOnEsc: false,
    closeOnScrim: false,
    bodyHtml: '<p class="testline" data-i18n="请手动关闭此窗口。||Please close this window manually."></p>',
    footHidden: true
  })
  // 先开提示层再尝试自关：关窗成功整页（含提示层）一并消失；被拦时提示层已就位，无闪烁窗口期
  function enterTrayLite() {
    if (trayLiteM.isOpen()) return
    trayLiteM.open()
    try { window.close() } catch (e) { /* 浏览器拦截：留在提示层 */ }
  }
  // UI 在场心跳：加载即报一次 + 15s 一次，不受 document.hidden 门控（后台标签页也是「打开的 UI」）。
  // 离场（关闭/刷新/跳转）走 pagehide 的 sendBeacon：服务端即刻收「轻量模式」勾，不等 TTL
  function uiPresence(leaving) {
    if (leaving && navigator.sendBeacon) {
      try {
        if (navigator.sendBeacon('/_modeldock/ui-presence', new Blob(['{"leaving":true}'], { type: 'application/json' }))) return
      } catch (e) { /* 落到下方 fetch 兜底 */ }
    }
    fetch('/_modeldock/ui-presence', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-modeldock-lang': LANG },
      body: leaving ? '{"leaving":true}' : '{}',
      keepalive: leaving
    }).catch(function () {})
  }

  // 状态自动刷新：定时切换窗口翻转、熔断、其他端改配置等发生时页面自动跟上，无需手动刷新。
  // diff 门控——数据没变就不动 DOM（不干扰正在编辑的弹窗/表单），变了才整页重绘一次；失败静默（健康横幅另有提示）
  function pollOverview() {
    // 首屏 /overview 失败（网关重启窗口、冷启动探测慢超时）时 view 仍为空：轮询档自动重试首屏，
    // 否则页面永远停在静态骨架（②③ 空态、pill 全默认），只能手动刷新恢复。静默吞错防 toast 刷屏
    if (!view) { load().catch(function () {}); return }
    fetch('/_modeldock/overview', { headers: { 'x-modeldock-lang': LANG } }).then(function (r) {
      // 401 不能吞成「无变化」：会话过期（cookie 7 天/令牌轮换）后轮询全部静默 401，
      // 健康横幅照常显示运行中，用户看到的是冻结的假实时页面——弹出重新登录。
      // 已在登录页则跳过（重绘会打断用户正在输入的令牌）
      if (r.status === 401) {
        if (!document.querySelector('.loginbox')) showLoginRequired()
        return null
      }
      return r.ok ? r.text() : null
    }).then(function (txt) {
      // 文本级 diff：服务端命中缓存直发缓存串，串相同即整包没变——跳过 parse 与重绘
      //（此前每次轮询对几十–几百 KB 的 overview 做 JSON.stringify 双串比较，纯浪费）
      if (!txt || txt === overviewLastText) return
      var v = null
      try { v = JSON.parse(txt) } catch (e) { return }
      overviewLastText = txt
      view = v
      // 轻量模式广播：请求时间戳新于上次所见即自关（陈旧值靠严格大于去重，不重复触发）
      var tor = (v.gateway && v.gateway.trayLiteRequest) || 0
      if (tor > lastTrayLiteRequestSeen) { lastTrayLiteRequestSeen = tor; enterTrayLite() }
      knownModels = Object.assign({}, catalogTable, v.knownModels || {})
      render()
      // 沙箱徽标挂在健康横幅上：view 就绪后（含首次 load）补一次，避免徽标晚到下一个轮询周期
      $('#health').innerHTML = healthHtml()
      var cp = document.getElementById('cfgPath')
      if (cp && v.gateway && v.gateway.home) cp.textContent = v.gateway.home
    }).catch(function () {})
  }

`
export const UI_JS_BOOT = `  setInterval(function () { if (!document.hidden) refreshUpdStatus() }, 60000)
  load().then(function () { loadLogs() }).catch(function (e) {
    if (e && e.status === 401) { showLoginRequired(); return }
    toast(t('加载失败：', 'Failed to load: ') + e.message, false)
  })
  // 后台标签页暂停轮询（visibilitychange 恢复时立即刷一次），省掉无谓请求与 DOM 重建
  setInterval(function () { if (!document.hidden) pollHealth() }, 5000)
  setInterval(function () { if (!document.hidden) pollOverview() }, 5000)
  setInterval(function () { if (!document.hidden) loadLogs() }, 5000)
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) { pollHealth(); pollOverview(); loadLogs() }
  })
  // 轻量模式在场心跳：加载即报一次 + 15s 一次（不看 document.hidden）；离场走 pagehide 信标
  uiPresence(false)
  setInterval(function () { uiPresence(false) }, 15000)
  window.addEventListener('pagehide', function () { uiPresence(true) })
  // 快速跳转：页面上半部分只显示「↓ 到底部」，滚过中线后只显示「↑ 到顶部」；不足以滚动时都不显示
  var snavUp = $('#snavUp'), snavDown = $('#snavDown')
  function snavUpdate() {
    var max = document.documentElement.scrollHeight - window.innerHeight
    var y = window.pageYOffset || 0
    var ok = max > 60
    var upper = y < window.innerHeight / 2
    snavDown.hidden = !ok || !upper
    snavUp.hidden = !ok || upper
  }
  snavUp.onclick = function () { window.scrollTo({ top: 0, behavior: 'smooth' }) }
  snavDown.onclick = function () { window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' }) }
  window.addEventListener('scroll', snavUpdate, { passive: true })
  window.addEventListener('resize', snavUpdate)
  snavUpdate()
})()
`
