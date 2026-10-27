/**
 * 云端控制台页（docs/design-cloud-sync.md §7.6）：手机优先静态单页，内嵌 HTML/JS/CSS，
 * 独立实现不 import 网关 ui.ts；双语走 data-i18n="中||EN" 同款机制。
 * 三区：设备列表（在线点/当前/云端期望）+ 切换（单台/批量）+ 配对码生成。
 * 服务下拉数据 = 各设备心跳上报的服务目录并集（云端只见密文，拿不到清单）。
 */
export function renderConsolePage(): string {
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>ModelDock Cloud</title>
<style>
  /* 语义色与桌面控制台（src/gateway/ui.ts）同源，见 .agents/conventions/ui-kit.md §3；
     字号 16px 是移动端特例（iOS 聚焦防缩放），控件为移动变体 */
  :root{--bg:#0f1115;--card:#171a21;--border:#2a2f3a;--text:#e5e7eb;--muted:#9ca3af;--ok:#22c55e;--warn:#d97706;--err:#ef4444;--accent:#3b82f6}
  *{box-sizing:border-box}
  body{font-family:system-ui,-apple-system,"PingFang SC",sans-serif;background:var(--bg);color:var(--text);margin:0;font-size:16px}
  .wrap{max-width:480px;margin:0 auto;padding:16px 16px 48px}
  h1{font-size:20px;margin:8px 0 16px}
  h2{font-size:15px;color:var(--muted);margin:24px 0 8px;font-weight:600}
  .card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:14px;margin-bottom:10px}
  .hint{color:var(--muted);font-size:13px;line-height:1.6}
  .err{color:var(--err);font-size:13px}
  input,select,button{font-size:16px;min-height:44px;border-radius:10px;border:1px solid var(--border);background:#12151b;color:var(--text);padding:8px 12px}
  select{appearance:none;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%239ca3af' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 10px center;padding-right:26px}
  input{width:100%}
  button{background:var(--accent);border:none;color:#fff;font-weight:600;cursor:pointer}
  .row{display:flex;gap:8px;align-items:center}
  .row select{flex:1;min-width:0}
  .devhead{display:flex;align-items:center;gap:8px}
  .devhead b{font-size:16px}
  .dot{width:10px;height:10px;border-radius:50%;background:#555;flex:0 0 auto}
  .dot.on{background:var(--ok)}
  .ver{color:var(--muted);font-size:12px;margin-left:auto}
  .devline{color:var(--muted);font-size:13px;margin:6px 0}
  .devline b{color:var(--text);font-weight:600}
  .pend{color:var(--warn);font-size:13px;margin:6px 0}
  .devctl{display:flex;gap:8px;margin-top:10px}
  .devctl select{flex:1;min-width:0}
  .code{font-size:32px;letter-spacing:4px;text-align:center;font-weight:700;color:var(--accent);margin:8px 0}
  .meta{color:var(--muted);font-size:13px}
  .toast{position:fixed;left:50%;transform:translateX(-50%);bottom:24px;background:#262a33;border:1px solid var(--border);color:var(--text);padding:10px 18px;border-radius:10px;max-width:90vw}
  .empty{color:var(--muted);text-align:center;padding:24px 0}
</style>
</head>
<body>
<div class="wrap">
  <h1>ModelDock <span data-i18n="云控制台||Cloud">云控制台</span></h1>

  <section id="loginView" hidden>
    <div class="card">
      <p class="hint" data-i18n="输入云端令牌登录。令牌 consoleToken 在服务端首次启动时打印，存于服务器数据目录的 cloud.json。||Enter the cloud token. The consoleToken is printed when the server first starts and saved in cloud.json under the server data directory.">输入云端令牌登录。令牌 consoleToken 在服务端首次启动时打印，存于服务器数据目录的 cloud.json。</p>
      <input type="password" id="tokenInput" placeholder="mdkcloud_…" autocomplete="off">
      <p class="err" id="loginErr" hidden></p>
      <p><button id="loginBtn" data-i18n="登录||Log in">登录</button></p>
    </div>
  </section>

  <section id="mainView" hidden>
    <p class="meta"><span data-i18n="配置更新于||Config updated">配置更新于</span> <span id="docTs">—</span> · <span data-i18n="第||rev">第</span> <span id="docRev">0</span> <span data-i18n="版||">版</span></p>

    <h2 data-i18n="设备||Devices">设备</h2>
    <div id="devList"><p class="empty" data-i18n="加载中…||Loading…">加载中…</p></div>

    <h2 data-i18n="全部设备||All devices">全部设备</h2>
    <div class="card">
      <div class="row">
        <select id="allSvcSel"></select>
        <button id="allApplyBtn" data-i18n="应用到全部||Apply to all">应用到全部</button>
      </div>
      <p class="hint" data-i18n="批量切换走各设备的同一服务，分钟级生效。||Switch every device to the same service; takes effect within minutes.">批量切换走各设备的同一服务，分钟级生效。</p>
    </div>

    <h2 data-i18n="新设备入网||Enroll a device">新设备入网</h2>
    <div class="card">
      <button id="pairBtn" data-i18n="生成配对码||Generate pair code">生成配对码</button>
      <div id="pairOut" hidden>
        <p class="code" id="pairCode"></p>
        <p class="hint" id="pairHint"></p>
      </div>
    </div>
  </section>
  <div class="toast" id="toast" hidden></div>
</div>
<script>
(function () {
  var LANG = (navigator.language || 'zh-CN').toLowerCase().indexOf('zh') === 0 ? 'zh' : 'en'
  function t(zh, en) { return LANG === 'en' && en != null ? en : zh }
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  }
  function applyI18n() {
    var els = document.querySelectorAll('[data-i18n]')
    for (var i = 0; i < els.length; i++) {
      var pair = els[i].getAttribute('data-i18n').split('||')
      els[i].textContent = LANG === 'en' && pair[1] != null ? pair[1] : pair[0]
    }
  }
  var toastTimer
  function toast(msg) {
    var el = document.getElementById('toast')
    el.textContent = msg
    el.hidden = false
    clearTimeout(toastTimer)
    toastTimer = setTimeout(function () { el.hidden = true }, 3500)
  }
  function api(path, opts) {
    opts = opts || {}
    return fetch(path, {
      method: opts.method || 'GET',
      headers: opts.body ? { 'content-type': 'application/json' } : {},
      body: opts.body ? JSON.stringify(opts.body) : undefined
    }).then(function (r) {
      if (r.status === 401) { showLogin(); throw new Error('unauthorized') }
      return r.json().then(function (j) { return { ok: r.ok, status: r.status, json: j } })
    })
  }
  function showLogin() {
    document.getElementById('loginView').hidden = false
    document.getElementById('mainView').hidden = true
  }
  function showMain() {
    document.getElementById('loginView').hidden = true
    document.getElementById('mainView').hidden = false
  }
  function localTs(iso) {
    if (!iso) return '—'
    var d = new Date(iso)
    if (isNaN(d.getTime())) return '—'
    function p(n) { return (n < 10 ? '0' : '') + n }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
  }

  // 服务目录并集：id → 显示名（取任一设备上报名）
  function unionServices(devices) {
    var names = {}
    devices.forEach(function (d) {
      ;(d.services || []).forEach(function (s) { if (!names[s.id]) names[s.id] = s.name || s.id })
    })
    return Object.keys(names).sort().map(function (id) { return { id: id, name: names[id] } })
  }
  function svcOptions(list, selectedId) {
    return list.map(function (s) {
      return '<option value="' + esc(s.id) + '"' + (s.id === selectedId ? ' selected' : '') + '>' + esc(s.name) + '</option>'
    }).join('')
  }
  function svcName(list, id) {
    for (var i = 0; i < list.length; i++) { if (list[i].id === id) return list[i].name }
    return id
  }

  function render(data) {
    showMain()
    document.getElementById('docTs').textContent = localTs(data.docUpdatedAt)
    document.getElementById('docRev').textContent = String(data.docRev || 0)
    var list = unionServices(data.devices || [])
    document.getElementById('allSvcSel').innerHTML = svcOptions(list, '')
    var host = document.getElementById('devList')
    if (!(data.devices || []).length) {
      host.innerHTML = '<div class="card"><p class="empty">' + t('还没有设备入网。点「生成配对码」，在电脑上运行 enroll 命令。', 'No devices yet. Tap "Generate pair code" and run the enroll command on a computer.') + '</p></div>'
      return
    }
    host.innerHTML = data.devices.map(function (d) {
      var cur = d.reportedProfile
      var curName = cur ? svcName(list, cur) : null
      var pend = d.desiredProfile && d.desiredProfile !== d.reportedProfile
        ? '<p class="pend">' + t('云端期望 ', 'Cloud wants ') + esc(svcName(list, d.desiredProfile)) + (d.online ? t('，等待本机应用…', ' — waiting for the device…') : t('（设备离线，上线后应用）', ' (device offline; applies when it comes back)')) + '</p>'
        : ''
      var svcSel = list.length
        ? '<div class="devctl"><select id="sel-' + esc(d.devid) + '">' + svcOptions(list, d.desiredProfile || cur || '') + '</select>' +
          '<button data-switch="' + esc(d.devid) + '">' + t('切换', 'Switch') + '</button></div>'
        : '<p class="hint">' + t('该设备尚未上报服务目录（等一次心跳）。', 'This device has not reported its service catalog yet (waiting for a heartbeat).') + '</p>'
      return '<div class="card">' +
        '<div class="devhead"><span class="dot' + (d.online ? ' on' : '') + '"></span><b>' + esc(d.name) + '</b>' +
        '<span class="ver">' + esc(d.clientVersion || '') + '</span></div>' +
        '<p class="devline">' + t('当前：', 'Current: ') + (curName ? '<b>' + esc(curName) + '</b>' : t('未知', 'unknown')) +
        ' · ' + (d.online ? t('在线', 'online') : t('离线', 'offline')) + '</p>' +
        pend + svcSel + '</div>'
    }).join('')
    var btns = host.querySelectorAll('[data-switch]')
    for (var i = 0; i < btns.length; i++) {
      btns[i].onclick = function () { doSwitch(this.getAttribute('data-switch')) }
    }
  }

  function doSwitch(devid) {
    var sel = document.getElementById('sel-' + devid)
    if (!sel || !sel.value) return
    api('/v1/desire', { method: 'POST', body: { devid: devid, service: sel.value } })
      .then(function (r) {
        if (!r.ok) { toast(t('下发失败：', 'Failed: ') + (r.json && r.json.error ? r.json.error.message : r.status)); return }
        toast(t('已下发，设备将在一分钟内应用', 'Sent; the device will apply within a minute'))
        load()
      })
      .catch(function () {})
  }

  function load() {
    return api('/v1/devices').then(function (r) {
      if (!r.ok) { toast((r.json && r.json.error ? r.json.error.message : '') || String(r.status)); return }
      render(r.json)
    }).catch(function () {})
  }

  document.getElementById('loginBtn').onclick = function () {
    var v = document.getElementById('tokenInput').value.trim()
    var err = document.getElementById('loginErr')
    if (!v) { err.textContent = t('请输入令牌', 'Enter the token'); err.hidden = false; return }
    fetch('/v1/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: v }) })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, json: j } }) })
      .then(function (r) {
        if (!r.ok) { err.textContent = (r.json && r.json.error && r.json.error.message) || t('登录失败', 'Login failed'); err.hidden = false; return }
        err.hidden = true
        load()
      })
      .catch(function () { err.textContent = t('网络错误，稍后再试', 'Network error; try again later'); err.hidden = false })
  }
  document.getElementById('tokenInput').onkeydown = function (e) { if (e && e.key === 'Enter') document.getElementById('loginBtn').onclick() }

  document.getElementById('allApplyBtn').onclick = function () {
    var sel = document.getElementById('allSvcSel')
    if (!sel.value) return
    api('/v1/desire', { method: 'POST', body: { devid: 'all', service: sel.value } })
      .then(function (r) {
        if (!r.ok) { toast(t('下发失败：', 'Failed: ') + (r.json && r.json.error ? r.json.error.message : r.status)); return }
        toast(t('已下发到全部设备', 'Sent to all devices'))
        load()
      })
      .catch(function () {})
  }

  document.getElementById('pairBtn').onclick = function () {
    api('/v1/paircode', { method: 'POST', body: {} })
      .then(function (r) {
        if (!r.ok) { toast((r.json && r.json.error ? r.json.error.message : '') || String(r.status)); return }
        document.getElementById('pairOut').hidden = false
        document.getElementById('pairCode').textContent = r.json.pairCode
        document.getElementById('pairHint').textContent = t(
          '15 分钟内有效、用一次即焚。在电脑上运行：modeldock sync enroll --server ' + location.origin + ' --code ' + r.json.pairCode,
          'Valid for 15 minutes, single use. On the computer run: modeldock sync enroll --server ' + location.origin + ' --code ' + r.json.pairCode
        )
      })
      .catch(function () {})
  }

  applyI18n()
  load()
  // 后台标签不轮询（手机常驻页多标签并存时，10s 轮询会互相挤占 60/min 限速配额触发 429）；
  // 回前台立刷一次（与桌面控制台 / 手机同步页的 visibilitychange 门控同款）
  setInterval(function () { if (!document.hidden) load() }, 10000)
  document.addEventListener('visibilitychange', function () { if (!document.hidden) load() })
})()
</script>
</body>
</html>`
}
