/**
 * Web 控制台 · services.ts —— 由单文件 ui.ts 按域拆分（T04 Phase 1，行为零变化）。
 * UI_JS_SERVICES：服务卡：列表渲染/过滤排序与状态 pill 的开关 API
 * 片段为模板字面量源文本：ui.ts 按原次序拼装后与拆分前逐字节一致；勿改动片段内换行/转义/次序。
 */
export const UI_JS_SERVICES = `  function visibleServices() {
    var list = view.services.filter(function (s) {
      if (svcFilter === 'key') return s.hasKey
      if (svcFilter === 'nokey') return !s.hasKey
      if (svcFilter === 'current') return s.inUse
      return true
    })
    var q = svcQ.trim().toLowerCase()
    if (q) {
      list = list.filter(function (s) {
        if (String(s.label).toLowerCase().indexOf(q) >= 0) return true
        if (String(s.base_url).toLowerCase().indexOf(q) >= 0) return true
        return (s.models || []).some(function (m) { return String(m.id).toLowerCase().indexOf(q) >= 0 })
      })
    }
    var byName = function (a, b) { return String(a.label).localeCompare(String(b.label), 'zh') }
    if (svcSort === 'name-az') {
      list = list.slice().sort(byName)
    } else if (svcSort === 'name-za') {
      list = list.slice().sort(function (a, b) { return byName(b, a) })
    } else if (svcSort === 'cnt-desc') {
      list = list.slice().sort(function (a, b) { return (b.modelsCount || 0) - (a.modelsCount || 0) || byName(a, b) })
    } else if (svcSort === 'cnt-asc') {
      list = list.slice().sort(function (a, b) { return (a.modelsCount || 0) - (b.modelsCount || 0) || byName(a, b) })
    } else {
      list = list.slice().sort(function (a, b) {
        if (a.inUse !== b.inUse) return a.inUse ? -1 : 1
        return byName(a, b)
      })
    }
    return list
  }

  function renderServices() {
    var el = $('#services')
    if (!view.services.length) {
      el.innerHTML = '<div class="empty">' + t('还没有服务。先在上方 ① 选一个服务商，粘贴 Key。', 'No services yet. Pick a provider in step ① above and paste your key.') +
        '<br><button class="btn small" id="svcImportBtn" style="margin-top:10px">' + t('从其他电脑导入…', 'Import from another computer…') + '</button></div>'
      var ib = document.getElementById('svcImportBtn')
      if (ib) ib.onclick = openImportOverlay
      return
    }
    var list = visibleServices()
    if (!list.length) {
      el.innerHTML = '<div class="empty">' + t('没有匹配的服务。试试清空搜索或换一个过滤条件。', 'No matching services. Try clearing the search or changing the filter.') + '</div>'
      return
    }
    var arOn = !!(view.gateway && view.gateway.autoRoute && view.gateway.autoRoute.on)
    // 折叠切片：默认只渲染前 N 个；使用中的服务即便排序靠后也强制保留（收起视图必须能切换当前服务）
    var slice = list, moreHtml = ''
    if (list.length > SVC_COLLAPSE_N) {
      if (svcExpanded) {
        moreHtml = '<div class="listmore"><button class="btn small" id="svcMore">' + t('收起', 'Collapse') + '</button></div>'
      } else {
        slice = list.slice(0, SVC_COLLAPSE_N)
        var curSvc = null
        list.forEach(function (s) { if (s.inUse) curSvc = s })
        if (curSvc && slice.indexOf(curSvc) < 0) slice = slice.concat([curSvc])
        moreHtml = '<div class="listmore"><button class="btn small" id="svcMore">' + t('显示全部 ', 'Show all ') + list.length + t(' 个服务', ' services') + '</button></div>'
      }
    }
    el.innerHTML = slice.map(function (s) {
      var useBtn = s.inUse
        ? '<span class="pill ok">' + t('正在使用', 'In use') + '</span>'
        : '<button class="btn small primary" data-use="' + esc(s.id) + '">' + t('应用', 'Apply') + '</button>'
      return '<div class="service' + (s.inUse ? ' cur' : '') + '">' +
        '<div class="info"><span class="name" title="' + esc(s.base_url) + '">' + esc(s.label) + '</span><br>' +
        '<span class="meta">' + t('默认 ', 'Default ') + esc(s.defaultModel || t('未设置', 'not set')) +
        (s.lastMs != null ? t(' · 延迟 ', ' · latency ') + s.lastMs + 'ms' : '') + ' · ' + s.modelsCount + t(' 个模型', ' models') +
        (s.hasKey ? '' : ' · <b class="hint-warn">' + t('Key 未设置', 'key not set') + '</b>') + (s.usedBy && s.usedBy.length ? t(' · 被 <b>', ' · used by <b>') + s.usedBy.length + t('</b> 个客户端使用', '</b> clients') : '') +
        (s.down && arOn ? ' <span class="pill err" title="' + t('故障熔断中，自动路由会避开该服务，探活恢复后自动回归', 'Down (circuit open); auto route avoids it and brings it back once probes recover') + '">' + t('熔断中', 'down') + '</span>' : '') +
        (s.enabled === false ? ' <span class="pill dim" title="' + t('手动下线，不参与自动路由', 'Manually disabled; excluded from auto route') + '">' + t('已下线', 'offline') + '</span>' : '') +
        '</span></div>' +
        '<span class="testres" id="pingres-' + esc(s.id) + '" hidden></span>' +
        '<button class="btn small" data-ping="' + esc(s.id) + '" data-i18n-title="纯网络延迟（不做模型请求）||Pure network latency (no model request)" title="纯网络延迟（不做模型请求）">' + t('延迟', 'Ping') + '</button>' +
        '<button class="btn small" data-edit="' + esc(s.id) + '">' + t('编辑', 'Edit') + '</button>' +
        '<button class="btn small ghost-danger" data-del="' + esc(s.id) + '">' + t('删除', 'Delete') + '</button>' +
        '<span class="rt">' + useBtn + '</span></div>'
    }).join('') + moreHtml

    var moreBtn = document.getElementById('svcMore')
    if (moreBtn) moreBtn.onclick = function () { svcExpanded = !svcExpanded; renderServices() }
    document.querySelectorAll('[data-use]').forEach(function (b) {
      b.onclick = function () {
        var id = b.getAttribute('data-use')
        var affected = view.clients.filter(function (c) { return c.attached && c.followsActive })
        var pinnedN = view.clients.filter(function (c) { return c.attached && !c.followsActive }).length
        var doSwitch = function () {
          b.disabled = true
          api('/switch', { method: 'POST', body: JSON.stringify({ service: id }) })
            .then(function (r) {
              var extra = (r && r.refreshed && r.refreshed.length)
                ? t('（dsh 等客户端的模型列表已同步重写，重启对应客户端生效）', ' (model lists of dsh-like clients rewritten; restart them to take effect)')
                : ''
              toast('✓ ' + t('已切换，新请求立即生效', 'Switched; new requests take effect immediately') + extra, true)
              return load()
            })
            .catch(function (e) { toast(t('切换失败：', 'Switch failed: ') + e.message, false); b.disabled = false })
        }
        if (affected.length) {
          var lines = [t('以下已接入的客户端会随之改用这个新服务：', 'These attached clients will switch to the new service as well:')].concat(affected.map(function (c) { return c.label }))
          if (pinnedN) lines.push(t('另有 ', 'Plus ') + pinnedN + t(' 个客户端已钉定固定路由，不受影响', ' pinned client(s) keep their fixed route'))
          confirmModal(t('切换当前服务', 'Switch current service'), lines, t('切换', 'Switch'), doSwitch)
        } else {
          doSwitch()
        }
      }
    })
    // 探测失败文案瘦身：api() 抛的「HTTP 5xx: {json}」里若有结构化 err/hint 就只取用这两段，
    // 避免整包 JSON 上屏（截断由 .testres 的 ellipsis 兜底，这里让常用路径本就短）
    function probeErrMsg(e) {
      var m = (e && e.message) || ''
      var i = m.indexOf('{')
      if (i >= 0) {
        try {
          var j = JSON.parse(m.slice(i))
          if (j && (j.err || j.hint)) return (j.err || '') + (j.hint ? (j.err ? ' → ' : '') + j.hint : '')
        } catch (e2) { /* 响应体不是 JSON，原样返回 */ }
      }
      return m
    }
    document.querySelectorAll('[data-ping]').forEach(function (b) {
      b.onclick = function () {
        var id = b.getAttribute('data-ping')
        var lbl = document.getElementById('pingres-' + id)
        if (!lbl) return
        // 点击复制全文（截断后细节不丢，复制反馈=文案翻转）；title 悬浮看全文
        lbl.onclick = function () {
          var full = lbl.title
          if (!full) return
          copyText(full, function () {
            lbl.textContent = '✓ ' + t('已复制', 'Copied')
            if (lbl._copyT) clearTimeout(lbl._copyT)
            lbl._copyT = setTimeout(function () { lbl.textContent = full }, 1600)
          })
        }
        b.disabled = true
        b.textContent = t('测中…', 'Pinging…')
        lbl.hidden = false
        lbl.className = 'testres'
        lbl.textContent = t('检测中…', 'Checking…')
        lbl.title = ''
        api('/test', { method: 'POST', body: JSON.stringify({ provider: id, mode: 'ping' }) })
          .then(function (r) {
            lbl.hidden = false
            lbl.className = 'testres ' + (r.ok ? 'ok' : 'err')
            lbl.textContent = r.ok
              ? '✓ ' + t('延迟 ', 'latency ') + (r.ms ?? '?') + 'ms'
              : '✗ ' + t('网络不通 ', 'unreachable ') + (r.err || '') + (r.hint ? ' → ' + r.hint : '')
            lbl.title = lbl.textContent
          })
          .catch(function (e) {
            lbl.hidden = false
            lbl.className = 'testres err'
            lbl.textContent = '✗ ' + t('探测失败：', 'Ping failed: ') + probeErrMsg(e)
            lbl.title = lbl.textContent
          })
          .then(function () { b.disabled = false; b.textContent = t('延迟', 'Ping') })
      }
    })
    document.querySelectorAll('[data-edit]').forEach(function (b) {
      b.onclick = function () { openEdit(b.getAttribute('data-edit')) }
    })
    document.querySelectorAll('[data-del]').forEach(function (b) {
      b.onclick = function () {
        var id = b.getAttribute('data-del')
        var row = b.closest('.service')
        var name = row ? row.querySelector('.name').textContent : id
        confirmModal(t('删除服务', 'Delete service'), [t('将删除「', 'This deletes "') + name + t('」及其引用的路由、已保存的 Key，不可撤销。', '" plus its routes and saved key. Cannot be undone.')], t('删除', 'Delete'), function () {
          api('/service/delete', { method: 'POST', body: JSON.stringify({ provider: id }) })
            .then(function () { toast('✓ ' + t('已删除服务', 'Service deleted'), true); return load() })
            .catch(function (e) { toast(t('删除失败：', 'Delete failed: ') + e.message, false) })
        })
      }
    })
  }

  $('#svcQ').addEventListener('input', function () { svcQ = this.value; renderServices() })
  // 状态行开关（pillSwitch；视觉=原 pill，布局/顺序不变）
  // 自动路由：主体点击切换；失败回弹并提示（busy 期组件防连点）
  var autoRouteApi = pillSwitch('autoRoutePill', {
    label: function () { return t('自动路由', 'Auto route') },
    onToggle: function (next, pill) {
      pill.set({ busy: true })
      api('/auto-route', { method: 'POST', body: JSON.stringify({ enabled: next }) })
        .then(function () { pill.set({ busy: false, on: next }); return load() })
        .catch(function (e) { pill.set({ busy: false, on: !next }); toast(t('切换自动路由失败：', 'Failed to toggle auto route: ') + e.message, false) })
    },
  })
  // 临时故障切备用（原「限流(429)/网关错误(503) 切备用」勾选收编；429 限流 / 503 服务不可用同属瞬时故障）
  var errApi = pillSwitch('errPill', {
    label: function () { return t('临时故障切备用', 'Failover on transient errors') },
    onToggle: function (next, pill) {
      pill.set({ busy: true })
      api('/auto-route', { method: 'POST', body: JSON.stringify({ failoverOn429: next }) })
        .then(function () { pill.set({ busy: false, on: next }); return load() })
        .catch(function (e) { pill.set({ busy: false, on: !next }); toast(t('切换失败：', 'Switch failed: ') + e.message, false) })
    },
  })
  // 自动备用链：手动链优先，没配/不够时自动把已启用服务补进切换候选（模型名透传，网关不改模型）
  var fbApi = pillSwitch('fbPill', {
    label: function () { return t('自动备用链', 'Auto fallback chain') },
    onToggle: function (next, pill) {
      pill.set({ busy: true })
      api('/auto-route', { method: 'POST', body: JSON.stringify({ autoFallback: next }) })
        .then(function () { pill.set({ busy: false, on: next }); return load() })
        .catch(function (e) { pill.set({ busy: false, on: !next }); toast(t('切换失败：', 'Switch failed: ') + e.message, false) })
    },
  })
  // 开机自启：轮询重绘与回调共用同一 setter（只等 load() 会让开关在 toast 之后回灌旧值）
  function applyAsPill(on) { if (asApi) asApi.set({ on: !!on }) }
  var asApi = pillSwitch('asPill', {
    label: function () { return t('开机自启', 'Autostart') },
    onToggle: function (next, pill) {
      var asOn = !!(view.gateway && view.gateway.autostart && view.gateway.autostart.installed)
      pill.set({ busy: true })
      api('/autostart', { method: 'POST', body: JSON.stringify({ enabled: next }) })
        .then(function (r) {
          // 用 POST 响应即时更新（与手机远程同款）；overview 有 2s TTL 缓存
          pill.set({ busy: false, on: !!r.installed })
          toast(r.installed ? t('已开启开机自启：下次登录自动启动网关', 'Autostart enabled: the gateway starts at next login') : t('已关闭开机自启', 'Autostart disabled'), true)
          return load()
        })
        .catch(function (e) {
          pill.set({ busy: false, on: asOn })
          toast(t('设置开机自启失败：', 'Failed to set autostart: ') + e.message, false)
        })
    },
  })

  // 手机远程（LAN 简版控制台）：主体=开关，caret=收起/展开二维码面板（不停服务）
  var lanPanel = document.getElementById('lanPanel')
  var lanOn = false // 当前 LAN 开关态（render 轮询重绘与 loadLanStatus、开关回调共用一份）
  function applyLanPill(on) { lanOn = !!on; if (lanApi) lanApi.set({ on: lanOn }) }
  var lanApi = pillSwitch('lanPill', {
    label: function () { return t('手机远程', 'Mobile console') },
    panel: function () { return lanPanel },
    onToggle: function (next, pill) {
      pill.set({ busy: true })
      api('/lan', { method: 'POST', body: JSON.stringify({ enabled: next }) })
        .then(function (r) {
          if (r && r.ok === false) throw new Error(r.error || '')
          lanPanel.hidden = !r.enabled // 先定面板再刷开关，caret 朝向才与面板一致
          lanOn = !!r.enabled
          pill.set({ busy: false, on: !!r.enabled, open: !!r.enabled })
          if (r.enabled) loadLanStatus()
          toast(r.enabled ? t('已开启：手机连同一 Wi-Fi 后扫码进入', 'Enabled: phone on the same Wi-Fi, scan the QR to enter') : t('已关闭：手机端页面立即失效', 'Disabled: the mobile page stops immediately'), true)
          return load()
        })
        .catch(function (e) {
          pill.set({ busy: false, on: lanOn })
          toast(t('设置手机远程失败：', 'Failed to set mobile console: ') + e.message, false)
          loadLanStatus()
        })
    },
  })
  function loadLanStatus() {
    api('/lan').then(function (r) {
      var qr = document.getElementById('lanQr')
      var url = document.getElementById('lanUrl')
      var alt = document.getElementById('lanAlt')
      var altUrls = document.getElementById('lanAltUrls')
      var winHint = document.getElementById('lanWinHint')
      applyLanPill(r.enabled)
      if (winHint) winHint.hidden = r.platform !== 'win32'
      if (r.enabled && r.qrcode) {
        qr.innerHTML = r.qrcode
        url.textContent = (r.urls && r.urls[0]) || ''
        url.onclick = function () { if (url.textContent) copyText(url.textContent, function () { toast(t('已复制', 'Copied'), true) }) }
        // 其余候选地址（服务器已按「手机最可能连上」排序）：主地址不通就换一条，省得用户去猜哪块网卡是物理网卡
        var rest = (r.urls || []).slice(1)
        altUrls.innerHTML = rest.map(function (u) { return '<p class="sharealt">' + esc(u) + '</p>' }).join('')
        Array.prototype.forEach.call(altUrls.querySelectorAll('.sharealt'), function (el) {
          el.onclick = function () { copyText(el.textContent, function () { toast(t('已复制', 'Copied'), true) }) }
        })
        alt.hidden = !rest.length
      } else {
        alt.hidden = true
        altUrls.innerHTML = ''
        qr.innerHTML = '<p class="empty">' + t('未开启', 'Off') + '</p>'
        url.textContent = ''
        url.onclick = null
      }
    }).catch(function (e) { toast(t('获取手机远程状态失败：', 'Failed to load mobile console status: ') + e.message, false) })
  }
  loadLanStatus() // 初始开关状态（开/关一眼可见）

  // 定时：主体=启用定时切换（原面板内勾选提到 pill），caret=展开/收起时段面板
`
