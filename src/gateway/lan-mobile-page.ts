// lan-mobile-page.ts — LAN 手机页模板（纯字符串渲染，零 I/O、零模块状态）。
// 自 lan.ts 整函数切片搬移（T22 split-lan-mobile-page）：renderMobilePage 唯一插值是
// ${CONSOLE_SHARED_JS}（桌面/手机共享 JS，console-shared.ts 单源）；renderDeniedPage 是
// 同一 HTTP 面的鉴权失败页。装配（进程内缓存/ETag/304/CSP）留在 lan.ts；对拍纪律：
// 函数体与搬移前逐字节一致（diff 切片），输出经 cmp 全等验证（NOTES.md 存结论）。

import { CONSOLE_SHARED_JS } from './console-shared.js'

export function renderMobilePage(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark">
<meta name="theme-color" content="#0f1115">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="ModelDock">
<link rel="manifest" href="/m/manifest.webmanifest">
<link rel="apple-touch-icon" href="/m/icon-192.png">
<title data-i18n="ModelDock · 手机||ModelDock · Mobile">ModelDock · 手机</title>
<style>
/* 令牌与桌面控制台（src/gateway/ui.ts）同源，见 .agents/conventions/ui-kit.md；
 * 控件（.act/.badge/#toast/#confirm）为移动变体保留：16px 输入=iOS 聚焦防缩放特例，44px=触控最小高度 */
:root{--bg:#0f1115;--card:#171a21;--text:#e5e7eb;--muted:#9ca3af;--border:#2a2f3a;--accent:#3b82f6;--accent-weak:#16233c;--ok:#22c55e;--ok-weak:#10241a;--warn:#d97706;--err:#ef4444;--scrim:rgba(0,0,0,.55);--on-accent:#fff;
--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
--fs-xs:12px;--fs-sm:13px;--fs-md:14px;--fs-base:15px;--fs-lg:17px;--fs-xl:18px;
--r-sm:8px;--r-md:10px;--r-lg:14px;--r-full:999px;
--shadow-sm:0 1px 2px rgba(0,0,0,.25);--shadow-md:0 4px 14px rgba(0,0,0,.2);--shadow-lg:0 18px 50px rgba(0,0,0,.35);
--z-sticky:35;--z-fab:40;--z-toast:50;--z-pop:70;--z-modal:100;
--dur:.15s}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:var(--fs-base)/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;padding:0 14px calc(20px + env(safe-area-inset-bottom))}
/* 主屏独立窗口（standalone）下页面顶到状态栏：header 让出安全区 */
header{display:flex;align-items:center;gap:8px;padding:calc(14px + env(safe-area-inset-top)) 0 10px}
.dot{width:8px;height:8px;border-radius:var(--r-full);background:var(--ok);flex:0 0 auto}
.brand{font-weight:700;font-size:var(--fs-xl)}
.host{margin-left:auto;color:var(--muted);font-size:var(--fs-xs);border:1px solid var(--border);border-radius:var(--r-full);padding:2px 10px;max-width:45%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.card{background:var(--card);border:1px solid var(--border);border-radius:var(--r-lg);padding:14px 16px;margin-bottom:12px}
.label{color:var(--muted);font-size:var(--fs-xs);margin:0 0 6px}
.sname{font-weight:700;font-size:var(--fs-xl);color:var(--accent);word-break:break-all}
.model{color:var(--muted);font-size:var(--fs-sm);margin:4px 0 0;word-break:break-all}
.models{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
.chip{border:1px solid var(--border);background:var(--bg);border-radius:var(--r-sm);padding:3px 9px;font-size:var(--fs-xs);font-family:var(--mono);max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.chip small{color:var(--muted);margin-left:4px}
.row{display:flex;align-items:center;gap:10px;padding:11px 0;border-bottom:1px solid var(--border)}
.row:last-child{border-bottom:none}
.row .info{flex:1;min-width:0}
.row .nm{font-weight:600;word-break:break-all}
.row .meta{color:var(--muted);font-size:var(--fs-xs)}
.badge{display:inline-block;padding:1px 8px;border-radius:var(--r-full);font-size:11px;border:1px solid var(--ok);color:var(--ok);margin-left:6px;vertical-align:1px}
.why{color:var(--muted);font-size:var(--fs-sm);margin:6px 0 0;word-break:break-all}
.why .mini{margin-left:4px;font-size:var(--fs-xs)}
/* 路由控制行（与桌面路由行同构）：label + select；select 16px 避免 iOS 聚焦自动放大 */
.rrow{display:flex;align-items:center;gap:8px;margin:0 0 10px}
.rrow label{font-size:var(--fs-sm);color:var(--muted);flex:0 0 auto}
.rrow select{flex:1;min-width:0;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:var(--r-md);padding:8px 12px;font:inherit;font-size:16px}
.rpill{flex:0 0 auto;border:1px solid var(--border);background:var(--bg);color:var(--muted);border-radius:var(--r-full);padding:8px 12px;font:inherit;font-size:var(--fs-xs);cursor:pointer;white-space:nowrap}
.rpill.on{border-color:var(--ok);color:var(--ok)}
.rpill:disabled{opacity:.6;cursor:wait}
.rsep{border:none;border-top:1px solid var(--border);margin:12px 0 8px}
.rlabel2{color:var(--muted);font-size:var(--fs-xs);margin:0 0 2px}
/* 配置同步：文本输入与 select 同款（16px 防 iOS 聚焦放大） */
.tinput{flex:1;min-width:0;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:var(--r-md);padding:8px 12px;font:inherit;font-size:16px}
.hint{color:var(--muted);font-size:var(--fs-xs);margin:6px 0 0;word-break:break-all}
input[type=file]{color:var(--muted);font-size:var(--fs-sm);max-width:100%}
button.act{border:1px solid var(--border);background:var(--bg);color:var(--accent);border-radius:var(--r-md);padding:9px 14px;font:inherit;font-size:var(--fs-md);cursor:pointer;min-height:44px}
button.act:disabled{color:var(--muted);cursor:not-allowed}
button.act.on{background:var(--accent);border-color:var(--accent);color:var(--on-accent)}
button.mini{border:none;background:none;color:var(--muted);font:inherit;font-size:var(--fs-xs);cursor:pointer;padding:2px 0}
button.mini:hover{color:var(--accent)}
#toast{position:fixed;left:18px;bottom:24px;background:var(--card);border:1px solid var(--border);border-radius:var(--r-md);padding:10px 16px;font-size:var(--fs-md);display:none;max-width:88%;z-index:var(--z-toast)}
#confirm{position:fixed;inset:0;background:var(--scrim);display:flex;align-items:center;justify-content:center;z-index:20}
#confirm[hidden]{display:none}
.confirm-box{background:var(--card);border:1px solid var(--border);border-radius:var(--r-lg);padding:18px;max-width:86%;width:320px}
.confirm-box p{margin:0 0 16px;font-size:var(--fs-base);line-height:1.5;word-break:break-all}
.confirm-box p.chint{color:var(--muted);font-size:var(--fs-sm);margin:-6px 0 14px}
.confirm-btns{display:flex;gap:10px;justify-content:flex-end}
button.cbtn{border:1px solid var(--border);background:var(--bg);color:var(--text);border-radius:var(--r-md);padding:9px 18px;font:inherit;font-size:var(--fs-base);cursor:pointer;min-height:44px}
#confirmYes{background:var(--accent);border-color:var(--accent);color:var(--on-accent)}
footer{color:var(--muted);font-size:var(--fs-xs);text-align:center;margin-top:6px}
.empty{color:var(--muted);font-size:var(--fs-md);text-align:center;padding:18px 0}
.a2hsrow{text-align:center;margin:2px 0 6px}
</style>
</head>
<body>
<header><span class="dot"></span><span class="brand">ModelDock</span><span class="host" id="host"></span></header>
<div class="card">
  <p class="label" data-i18n="路由||Routing">路由</p>
  <div id="active"></div>
</div>
<div class="card">
  <p class="label" data-i18n="切换服务||Switch service">切换服务</p>
  <div id="services"></div>
</div>
<div class="card">
  <p class="label" data-i18n="配置包||Config package">配置包</p>
  <p class="rlabel2" data-i18n="导出配置包（AES-256-GCM 加密）||Export config package (AES-256-GCM encrypted)">导出配置包（AES-256-GCM 加密）</p>
  <p class="rrow">
    <input type="password" id="expPw" class="tinput" autocomplete="new-password" data-i18n-ph="口令（导入方需输同一口令）||Passphrase (importer types the same one)" placeholder="口令（导入方需输同一口令）">
    <button type="button" class="act on" id="expBtn" data-i18n="导出||Export">导出</button>
  </p>
  <hr class="rsep">
  <p class="rlabel2" data-i18n="导入配置包（文件或分享链接）||Import config package (file or share link)">导入配置包（文件或分享链接）</p>
  <!-- 不设 accept：iOS 选择器按文件类型过滤，.msync 未注册会被灰掉选不中（实测 .json 可选、.txt 与 .msync 不可选），放开才列得出文件 -->
  <p class="rrow"><input type="file" id="impFile"></p>
  <p class="rrow">
    <input type="password" id="impPw" class="tinput" autocomplete="new-password" data-i18n-ph="导出时设置的口令||Passphrase set at export time" placeholder="导出时设置的口令">
    <button type="button" class="act" id="impBtn" data-i18n="导入||Import">导入</button>
  </p>
  <p class="rrow"><textarea id="impLinkUrl" class="tinput" rows="2" data-i18n-ph="或粘贴分享链接：http://192.168.x.x:8787/…#p=…||Or paste a share link: http://192.168.x.x:8787/…#p=…" placeholder="或粘贴分享链接：http://192.168.x.x:8787/…#p=…"></textarea></p>
  <p class="hint" data-i18n="导入会整体替换现有配置，导入前自动快照。||Importing replaces the whole config; a snapshot is taken first.">导入会整体替换现有配置，导入前自动快照。</p>
</div>
<p class="a2hsrow"><button type="button" class="mini" id="a2hsBtn" data-i18n="常驻到手机桌面 · 怎么做？||Keep on home screen · how?">常驻到手机桌面 · 怎么做？</button></p>
<div class="card" id="a2hsCard" hidden><p class="hint" id="a2hsText"></p></div>
<footer data-i18n="仅限局域网 · 状态 / 切换 / 配置包 · 不显示 Key||LAN only · status / switch / config package · keys never shown">仅限局域网 · 状态 / 切换 / 配置包 · 不显示 Key</footer>
<div id="toast" role="status" aria-live="polite"></div>
<div id="confirm" hidden role="dialog" aria-modal="true">
  <div class="confirm-box">
    <p id="confirmMsg"></p>
    <p id="confirmHint" class="chint" hidden></p>
    <div class="confirm-btns">
      <button type="button" class="cbtn" id="confirmNo" data-i18n="取消||Cancel">取消</button>
      <button type="button" class="cbtn" id="confirmYes" data-i18n="确定||OK">确定</button>
    </div>
  </div>
</div>
<script>
// 语言：显式选择（localStorage）优先；未选择时英文浏览器兜底 en、其余缺省 zh（与桌面同口径）。
// 旧写法把 navigator.language 并进首判断、又只在 localStorage==='en' 时才取 en——navigator 分支是死逻辑，英文系统手机永远中文。
var _savedLang = localStorage.getItem('mdk_lang')
var LANG = _savedLang === 'en' || (_savedLang === null && /^en/i.test(navigator.language || '')) ? 'en' : 'zh'
function tr(zh, en) { return LANG === 'en' ? en : zh }
// 与桌面控制台（ui.ts）同源的共用逻辑（parseTarget/impWarnList/routeSelectHtml）：注入单份共享片段，trT=本页翻译函数
var trT = tr
${CONSOLE_SHARED_JS}
Array.prototype.forEach.call(document.querySelectorAll('[data-i18n]'), function (el) {
  var pair = el.getAttribute('data-i18n').split('||')
  el.textContent = tr(pair[0], pair[1])
})
Array.prototype.forEach.call(document.querySelectorAll('[data-i18n-ph]'), function (el) {
  var pair = el.getAttribute('data-i18n-ph').split('||')
  el.setAttribute('placeholder', tr(pair[0], pair[1]))
})
// ── 常驻手机桌面引导（UA 分辨步骤；桌面端隐藏）。添加到主屏幕后图标直达本页（URL 含令牌，持久有效）──
;(function () {
  var btn = document.getElementById('a2hsBtn')
  if (!btn) return
  var ua = navigator.userAgent || ''
  if (!/Mobi|Android|iPhone|iPad|iPod/i.test(ua)) { btn.parentNode.style.display = 'none'; return }
  var isWeChat = /MicroMessenger/i.test(ua)
  var isIOS = /iPhone|iPad|iPod/i.test(ua)
  var steps = isWeChat
    ? tr('微信内不支持直接添加：点右上角「···」→ 在浏览器中打开 → 在浏览器的分享/菜单里选「添加到主屏幕」。', 'Not supported inside WeChat: tap "···" (top right) → Open in browser → use the browser\\'s share/menu to "Add to Home Screen".')
    : isIOS
      ? tr('用 Safari 打开本页 → 点分享按钮 → 选「添加到主屏幕」。', 'Open this page in Safari → tap Share → "Add to Home Screen".')
      : tr('点浏览器菜单（右上角 ⋮ / ⋯）→ 选「添加到主屏幕」或「安装应用」。', 'Open the browser menu (⋮ / ⋯ top right) → "Add to Home Screen" or "Install app".')
  btn.onclick = function () {
    var card = document.getElementById('a2hsCard')
    var show = card.hidden
    card.hidden = !show
    document.getElementById('a2hsText').textContent = steps
    btn.textContent = show ? tr('收起', 'Hide') : tr('常驻到手机桌面 · 怎么做？', 'Keep on home screen · how?')
  }
})()
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] }) }
function toast(msg) { var t = document.getElementById('toast'); t.textContent = msg; t.style.display = 'block'; clearTimeout(t._h); t._h = setTimeout(function () { t.style.display = 'none' }, 2600) }
// 自绘确认弹层（浏览器原生 confirm 的按钮顺序不可控）：右侧确定、左侧取消；hint 为灰色补充说明（路由被自动路由接管时提示切换的实际效果）。
// 基础键盘路径：打开即聚焦确定键、Esc=取消、关闭还原出发点（桌面 createModal 有完整焦点管理，此处按移动页最小集实现）
function confirmDialog(msg, hint) {
  return new Promise(function (resolve) {
    var box = document.getElementById('confirm')
    var msgEl = document.getElementById('confirmMsg')
    var hintEl = document.getElementById('confirmHint')
    var yes = document.getElementById('confirmYes')
    var no = document.getElementById('confirmNo')
    msgEl.textContent = msg
    if (hint) { hintEl.textContent = hint; hintEl.hidden = false } else { hintEl.textContent = ''; hintEl.hidden = true }
    box.hidden = false
    var lastFocus = document.activeElement
    yes.focus()
    function onKey(ev) {
      if (ev.key === 'Escape') { ev.stopPropagation(); done(false) }
    }
    function done(v) {
      box.hidden = true
      yes.onclick = null
      no.onclick = null
      document.removeEventListener('keydown', onKey, true)
      if (lastFocus && lastFocus.focus) { try { lastFocus.focus() } catch (e) { /* 出发点已移除 */ } }
      resolve(v)
    }
    document.addEventListener('keydown', onKey, true)
    yes.onclick = function () { done(true) }
    no.onclick = function () { done(false) }
  })
}
function chipHtml(m) { return '<span class="chip">' + esc(m.name) + (m.id !== m.name ? ' <small>' + esc(m.id) + '</small>' : '') + '</span>' }
// ── 配置同步：导出/导入。包体恒为密文；口令只出现在请求体（LAN HTTP + mdklan 令牌同一信任域）──
// 导入一键直达（apply 直发 file，不再有预览确认步）；/m 无磨砂弹层，toast 本就可见
document.getElementById('expBtn').onclick = function () {
  var pw = document.getElementById('expPw').value
  if (!pw) { toast(tr('请先输入口令（导入方需输同一口令）', 'Enter a passphrase first (the importer must type the same one)')); return }
  var btn = this
  btn.disabled = true
  fetch('/m/api/sync/export', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ passphrase: pw }) })
    .then(function (r) {
      if (!r.ok) return r.json().then(function (j) { throw new Error(j.error || r.status) })
      // 文件名以服务端 content-disposition 为准（同一份带时间的名字），页面不再自造，避免两处口径漂移
      var name = 'modeldock-config.msync'
      var m = /filename="([^"]+)"/.exec(r.headers.get('content-disposition') || '')
      if (m) name = m[1]
      return r.blob().then(function (b) { return { blob: b, name: name } })
    })
    .then(function (res) {
      var b = res.blob
      var u = URL.createObjectURL(b)
      var a = document.createElement('a')
      a.href = u
      a.download = res.name
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(function () { URL.revokeObjectURL(u) }, 5000)
      // iOS 上下载落在「文件」App，不提示的话用户找不到；其它平台浏览器的下载目录各不相同，不硬说
      var tip = /iPhone|iPad|iPod/.test(navigator.userAgent) ? tr('，存到「文件」App →「下载项」', ' — saved to Files → Downloads') : ''
      toast(tr('已生成加密配置包，浏览器开始下载', 'Encrypted package created — download started') + tip)
      btn.disabled = false
    })
    .catch(function (e) { toast(tr('导出失败：', 'Export failed: ') + e.message); btn.disabled = false })
}
document.getElementById('impBtn').onclick = function () {
  var link = (document.getElementById('impLinkUrl').value || '').trim()
  var f = document.getElementById('impFile').files[0]
  var pw = document.getElementById('impPw').value
  var btn = this
  var bodyP
  if (link) {
    // 链接自带口令（#p= fragment），口令输入框只服务文件导入
    var i = link.indexOf('#p=')
    if (i < 0) { toast(tr('链接缺口号段（#p=…）：请回旧电脑复制完整链接', 'The link lacks the passphrase part (#p=…): copy the full link on the old computer')); return }
    bodyP = Promise.resolve({ phase: 'apply', url: link.slice(0, i), passphrase: link.slice(i + 3) })
  } else {
    if (!f) { toast(tr('请先选择 .msync 配置包文件，或粘贴分享链接', 'Pick a .msync package file first, or paste a share link')); return }
    if (!pw) { toast(tr('请输入导出时设置的口令', 'Enter the passphrase set at export time')); return }
    bodyP = f.text().then(function (txt) { return { phase: 'apply', file: txt, passphrase: pw } })
  }
  btn.disabled = true
  bodyP
    .then(function (b2) {
      return fetch('/m/api/sync/import', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b2) })
        .then(function (r) { return r.json().then(function (aj) { if (!r.ok || !aj.ok) throw new Error(aj.error || r.status); return aj }) })
    })
    .then(function (aj) {
      var rep2 = aj.report || {}
      toast(tr('已导入：服务 {n} · 路由 {n2} · 预设 {n3} · 定时规则 {n4}', 'Imported: {n} providers · {n2} profiles · {n3} presets · {n4} schedule rules').replace('{n}', (rep2.providers || []).length).replace('{n2}', (rep2.profiles || []).length).replace('{n3}', rep2.presetCount || 0).replace('{n4}', rep2.scheduleRules || 0))
      var warns = impWarnList(rep2)
      if (warns.length) toast(warns.join(tr('；', '; ')))
      load()
    })
    .catch(function (e) { toast(tr('导入失败：', 'Import failed: ') + e.message) })
    .then(function () { btn.disabled = false })
}
function render(j) {
  document.getElementById('host').textContent = j.hostname || ''
  var r = j.route || {}
  var sch = r.schedule || {}
  var wins = sch.windows || []
  function svcName(id) {
    for (var i = 0; i < j.services.length; i++) if (j.services[i].id === id) return j.services[i].name
    return id
  }
  function targetLabel(t) { var p = parseTarget(t); return svcName(p.p) + (p.m ? ' · ' + p.m : '') }
  function dayLabel(w) {
    if (w.dayFilter === 'workday') return tr('工作日', 'Weekdays')
    if (w.dayFilter === 'weekend') return tr('周末', 'Weekend')
    if (w.dayFilter === 'holiday') return tr('法定节假日', 'Holidays')
    if (w.days && w.days.length && w.days.length < 7) return w.days.map(function (d) { return tr('周', 'Day ') + d }).join('/')
    return tr('每天', 'Every day')
  }
  // 与桌面路由行同口径同行为（扫谁的码就与谁的桌面一致）：双槽位——「当前」=实际使用的主服务（自动·A / 人工钉定）、
  // 「下一个切换」=主服务不可达时切到谁（自动·B / 人工钉定）；人工修改优先于程序自动（含定时窗口）
  // 「当前」槽：自动态显示「自动 · A」（A=程序会选的：定时窗口/默认路由），人工钉定时显示钉定服务
  var curAutoOpt = !r.forced && r.autoPrimaryLabel ? tr('自动 · ', 'Auto · ') + r.autoPrimaryLabel : tr('自动', 'Auto')
  var curOpts = routeSelectHtml(j.services || [], curAutoOpt, r.forced, r.label || r.forced)
  // 「下一个切换」槽：自动态显示「自动 · B」（B=自动态真会切到的下一跳，桌面同源 autoNextLabel）；没得切时明说无备用服务
  var nextAutoOpt = r.autoNextLabel ? tr('自动 · ', 'Auto · ') + r.autoNextLabel : tr('自动 · 无备用服务', 'Auto · no fallback')
  var nextOpts = routeSelectHtml(j.services || [], nextAutoOpt, r.routeNext, r.routeNextLabel || r.routeNext)
  var effSvc = null
  if (r.provider) { for (var i = 0; i < j.services.length; i++) if (j.services[i].id === r.provider) { effSvc = j.services[i]; break } }
  var effName = effSvc ? effSvc.name : (j.active ? j.active.name : null)
  var model = r.model != null ? r.model : (j.active ? j.active.default_model : null)
  var why = []
  if (sch.enabled === false && wins.length) why.push(tr('定时切换已停用', 'Timed switching is disabled'))
  if (sch.active) why.push(tr('定时 ', 'Schedule ') + sch.active.start + '–' + sch.active.end + ' · ' + tr('优先 ', 'prefer ') + targetLabel(sch.active.target))
  var av = sch.activeAvoids || []
  if (av.length) why.push(tr('定时避开 ', 'Avoiding ') + av.map(function (w) { return targetLabel(w.target) }).join(tr('、', ', ')) + ' · ' + av[0].start + '–' + av[0].end)
  if (r.source === 'pinned') why.push(tr('主服务已人工钉定 · 定时窗口暂停，选回「自动」恢复', 'Primary pinned manually — schedule windows paused; pick "Auto" to resume'))
  if (r.degradedFrom === 'pinned') why.push(tr('钉定的主服务不可用，已临时切到其他服务', 'Pinned primary unavailable — temporarily on another service'))
  if (r.degradedFrom === 'schedule') why.push(tr('定时目标不可用，已临时切到其他服务', 'Schedule target unavailable — temporarily on another service'))
  if (!r.on && wins.length) why.push(tr('自动选主未开启：时段不生效（故障切换不受影响）', 'Auto primary selection is off: windows are inactive (failover still works)'))
  // 故障切换常开：主服务不可达即按候选链切换，与自动选主开关无关
  why.push(tr('限流(429)/网关错误(503) 切备用 · ', 'Fallback on 429/503 · ') + (r.failover429 ? tr('开', 'on') : tr('关', 'off')))
  why.push(tr('自动备用链 · ', 'Auto fallback chain · ') + (r.autoFallback ? tr('开', 'on') : tr('关', 'off')))
  var schedBtn = wins.length
    ? '<p class="why"><button type="button" class="mini" id="schedShow">' + tr('定时时段', 'Timed windows') + ' · ' + wins.length + tr(' 个 · 展开', ' · show') + '</button></p>' +
      '<div class="models" id="schedList" style="display:none">' + wins.map(function (w) {
        return '<span class="chip">' + esc(dayLabel(w) + ' ' + w.start + '–' + w.end + ' · ' + (w.mode === 'avoid' ? tr('避开', 'avoid') : tr('优先', 'prefer')) + ' ' + targetLabel(w.target)) + '</span>'
      }).join('') + '</div>'
    : ''
  var a = document.getElementById('active')
  a.innerHTML =
    '<p class="rrow"><label>' + tr('当前', 'Current') + '</label><select id="curSvc">' + curOpts + '</select></p>' +
    '<p class="rrow"><label>' + tr('下一个切换', 'Next failover') + '</label><select id="nextSvc">' + nextOpts + '</select>' +
    '<button type="button" class="rpill' + (r.on ? ' on' : '') + '" id="arPill">' + (r.on ? tr('自动路由 · 开', 'Auto route · on') : tr('自动路由 · 关', 'Auto route · off')) + '</button></p>' +
    '<hr class="rsep">' +
    '<p class="rlabel2">' + tr('实际生效', 'Actually serving') + '</p>' +
    (effName
      ? '<p class="sname">' + esc(effName) + '</p>' +
        '<p class="model">' + tr('模型', 'Model') + ': ' + esc(model || tr('未设置', 'not set')) + '</p>' +
        '<p class="model">' + tr('下一个切换', 'Next failover') + ': ' + esc(r.nextLabel || tr('无备用服务', 'no fallback')) + (r.routeNext && r.routeNext !== r.provider ? tr('（人工钉定）', ' (pinned)') : '') + '</p>'
      : '<p class="empty">' + (j.services.length
        ? tr('这台电脑还没选当前服务：在上面「当前」里选一个即可', 'No service selected on this computer yet — pick one in Current above')
        : tr('服务不可用', 'unavailable')) + '</p>') +
    (why.length ? '<p class="why">' + why.map(esc).join('<br>') + '</p>' : '') +
    schedBtn
  var curSel = document.getElementById('curSvc')
  if (curSel) {
    curSel.value = r.forced || ''
    // 与桌面「当前」下拉同款快捷路径：选服务=/m/api/switch（写钉定+默认路由），选「自动」=清除钉定；失败经 load() 用服务端真相回滚
    curSel.onchange = function () {
      var id = this.value
      if (id === (r.forced || '')) return
      curSel.disabled = true
      if (!id) {
        fetch('/m/api/auto-route', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider: null }) })
          .then(function (resp) { return resp.json().then(function (j2) { if (!resp.ok || !j2.ok) throw new Error(j2.error || resp.status); return j2 }) })
          .then(function () { toast(tr('已恢复自动选路', 'Back to auto selection')); load() })
          .catch(function (e) { toast(tr('切换失败：', 'Switch failed: ') + e.message); load() })
        return
      }
      fetch('/m/api/switch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ service: id }) })
        .then(function (resp) { return resp.json().then(function (j2) { if (!resp.ok || !j2.ok) throw new Error(j2.error || resp.status); return j2 }) })
        .then(function () { toast(tr('已切换，新请求立即生效', 'Switched; new requests take effect immediately')); load() })
        .catch(function (e) { toast(tr('切换失败：', 'Switch failed: ') + e.message); load() })
    }
  }
  var nSel = document.getElementById('nextSvc')
  if (nSel) {
    nSel.value = r.routeNext || ''
    // 与桌面「下一个切换」下拉同款：选服务=钉定该槽（插备用链首位），选「自动」=恢复按优先级/实测耗时排序
    nSel.onchange = function () {
      var v = this.value || null
      nSel.disabled = true
      fetch('/m/api/auto-route', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ next: v }) })
        .then(function (resp) { return resp.json().then(function (j2) { if (!resp.ok || !j2.ok) throw new Error(j2.error || resp.status); return j2 }) })
        .then(function () { toast(v ? tr('已钉定下一个切换「', 'Next failover pinned to "') + svcName(v) + tr('」', '"') : tr('下一个切换已恢复自动', 'Next failover back to auto')); load() })
        .catch(function (e) { toast(tr('设置失败：', 'Failed: ') + e.message); load() })
    }
  }
  var pill = document.getElementById('arPill')
  if (pill) {
    pill.onclick = function () {
      pill.disabled = true
      pill.textContent = tr('自动路由 · …', 'Auto route · …')
      fetch('/m/api/auto-route', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: !r.on }) })
        .then(function (resp) { return resp.json().then(function (j2) { if (!resp.ok || !j2.ok) throw new Error(j2.error || resp.status); return j2 }) })
        .then(function (j2) {
          pill.disabled = false
          pill.className = 'rpill' + (j2.enabled ? ' on' : '')
          pill.textContent = j2.enabled ? tr('自动路由 · 开', 'Auto route · on') : tr('自动路由 · 关', 'Auto route · off')
          toast(j2.enabled ? tr('已开启自动路由', 'Auto route enabled') : tr('已关闭自动路由', 'Auto route disabled'))
          load()
        })
        .catch(function (e) { toast(tr('设置失败：', 'Failed: ') + e.message); load() })
    }
  }
  var schedShow = document.getElementById('schedShow')
  if (schedShow) {
    schedShow.onclick = function () {
      var list = document.getElementById('schedList')
      if (!list) return
      var show = list.style.display === 'none'
      list.style.display = show ? 'flex' : 'none'
      schedShow.textContent = tr('定时时段', 'Timed windows') + ' · ' + wins.length + (show ? tr(' 个 · 收起', ' · hide') : tr(' 个 · 展开', ' · show'))
    }
  }
  var box = document.getElementById('services')
  if (!j.services.length) { box.innerHTML = '<p class="empty">' + tr('还没有服务，请先在电脑端添加', 'No services yet — add one on the computer') + '</p>'; return }
  box.innerHTML = j.services.map(function (s) {
    // 「使用中」= 全局生效主服务（钉定/定时窗口/默认，含可用性过滤），与桌面服务卡徽标、
    // 「实际生效」行、/v1/models 同源，不再写 active_profile 的旧口径
    var badge = s.active ? '<span class="badge">' + tr('使用中', 'in use') + '</span>' : ''
    return '<div class="row"><div class="info"><div class="nm">' + esc(s.name) + badge + '</div>' +
      '<div class="meta">' + tr('{n} 个模型', '{n} models').replace('{n}', s.count) + ' <button type="button" class="mini" data-expand="' + esc(s.id) + '">' + tr('展开', 'show') + '</button></div>' +
      '<div class="models" data-models="' + esc(s.id) + '" style="display:none">' + s.models.map(chipHtml).join('') + '</div></div>' +
      '<button type="button" class="act' + (s.active ? '' : ' on') + '" data-switch="' + esc(s.id) + '" data-name="' + esc(s.name) + '"' + (s.active ? ' disabled' : '') + '>' + tr('切换', 'Switch') + '</button></div>'
  }).join('')
  Array.prototype.forEach.call(box.querySelectorAll('[data-expand]'), function (b) {
    b.onclick = function () {
      var box2 = box.querySelector('[data-models="' + CSS.escape(b.getAttribute('data-expand')) + '"]')
      if (!box2) return
      var show = box2.style.display === 'none'
      box2.style.display = show ? 'flex' : 'none'
      b.textContent = show ? tr('收起', 'hide') : tr('展开', 'show')
    }
  })
  Array.prototype.forEach.call(box.querySelectorAll('[data-switch]'), function (b) {
    b.onclick = function () {
      var name = b.getAttribute('data-name')
      // 人工钉定优先于程序自动：切换即钉定该服务（压过定时窗口），直到「当前」选回「自动」
      var hint = r.on
        ? tr('切换会人工钉定该服务：定时时段内也走它，直到「当前」选回「自动」恢复程序自动。', 'This pins the service manually — it applies during schedule windows too, until you pick "Auto" in Current to resume program selection.')
        : ''
      confirmDialog(tr('切换到「' + name + '」？已接入的客户端会立即改走它。', 'Switch to "' + name + '"? Attached clients take effect immediately.'), hint).then(function (ok) {
        if (!ok) return
        b.disabled = true
        fetch('/m/api/switch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ service: b.getAttribute('data-switch') }) })
          .then(function (r) { return r.json().then(function (j2) { if (!r.ok || !j2.ok) throw new Error(j2.error || r.status); return j2 }) })
          .then(function () { toast(tr('已切换', 'Switched')); load() })
          .catch(function (e) { toast(tr('切换失败：', 'Switch failed: ') + e.message); b.disabled = false })
      })
    }
  })
}
var lastState = null
function load() {
  fetch('/m/api/state').then(function (r) { if (r.status === 403) throw new Error(tr('令牌失效，请重新扫码', 'Token expired — scan the QR again')); return r.json() })
    .then(function (j) {
      if (j) delete j.uptime_ms // 每次轮询都变的字段不参与 diff：数据没变就不重绘，避免打断正在操作的下拉
      var s = JSON.stringify(j)
      if (s === lastState) return
      lastState = s
      render(j)
    })
    .catch(function (e) { document.getElementById('services').innerHTML = '<p class="empty">' + esc(e.message) + '</p>' })
}
load()
// 后台标签停止轮询（与桌面控制台同款门控）；切回前台立即刷一次
setInterval(function () { if (!document.hidden) load() }, 30000)
document.addEventListener('visibilitychange', function () { if (!document.hidden) load() })
</script>
</body>
</html>`
}

export function renderDeniedPage(): string {
  const zh = '请从电脑端控制台的二维码进入（令牌缺失或不正确）。'
  const en = 'Open via the QR code shown in the desktop console (token missing or incorrect).'
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>ModelDock</title></head><body style="background:#0f1115;color:#e5e7eb;font:15px/1.7 -apple-system,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;text-align:center"><p style="padding:0 28px">${zh}<br><span style="color:#9ca3af;font-size:13px">${en}</span></p></body></html>`
}
