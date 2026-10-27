/**
 * Web 控制台 · kit.ts —— 由单文件 ui.ts 按域拆分（T04 Phase 1，行为零变化）。
 * UI_JS_KIT：组件层：$ 查询、图标表 IC/icon、createModal 弹层工厂与 Esc/栈管理
 * UI_JS_WIRING：组件接线：close-btn 图标注入、pillSwitch 开关组件、页面态变量
 * 片段为模板字面量源文本：ui.ts 按原次序拼装后与拆分前逐字节一致；勿改动片段内换行/转义/次序。
 */
export const UI_JS_KIT = `(function () {
  var $ = function (s) { return document.querySelector(s) }
  // SVG 图标集（kit 组件）：24 网格 / currentColor / stroke 2，替代跨平台不一致的字符字形；
  //    句子文案内嵌的 ✓⚠ 等保留文本形态，只有「控件上的图标」走这里
  var IC = {
    check: '<path d="M20 6L9 17l-5-5"/>',
    close: '<path d="M18 6L6 18M6 6l12 12"/>',
    copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    eye: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>',
    'eye-off': '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><path d="M1 1l22 22"/>',
    star: '<path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    'arrow-up': '<path d="M12 19V5M5 12l7-7 7 7"/>',
    'arrow-down': '<path d="M12 5v14M19 12l-7 7-7-7"/>',
    // 状态/语义图标：锁=由本网关托管、链=独立直连、齿轮=控制台操作、外链箭头=打开外部文档
    lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
    link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1"/>',
    'arrow-up-right': '<path d="M7 17L17 7M8 7h9v9"/>',
    // 路由来源徽标：时钟=定时窗口生效、图钉=人工钉定、闪电=故障切换、三角叹号=已降级
    clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
    pin: '<path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1z"/>',
    zap: '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
    'alert-triangle': '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 20h16a2 2 0 0 0 1.73-2Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  }
  function icon(name, size) {
    var w = size || 14
    return '<svg width="' + w + '" height="' + w + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (IC[name] || '') + '</svg>'
  }
  // 行内图标（pill / 表格单元格 / 标题前缀）：包一层与文字基线对齐的壳，间距由调用方的空格掌控
  function iconInline(name, size) {
    return '<span class="ic">' + icon(name, size) + '</span>'
  }
  // 弹层壳组件（kit「Modal 壳」代码化）：统一磨砂遮罩 / head+body+foot 三层 / Esc+遮罩关闭 / aria / 底栏槽位。
  // 此前 6 份手写壳两种背景、Esc 与遮罩关闭各有各的写法；底栏=可配置槽位（msg 槽 + 按钮序列），
  // 谁有取消、谁是主按钮仍由调用方定（评审定稿语义不变）。scrim 沿用既有 overlay id——
  // id 作用域的 CSS/JS 引用全部保持有效；壳逐期迁入（未迁壳走原静态 HTML，互不影响）。
  var modalStack = []
  function createModal(opts) {
    var scrim = document.createElement('div')
    scrim.className = 'modal-scrim ' + (opts.align === 'top' ? 'top' : 'center')
    scrim.id = opts.id
    scrim.hidden = true
    var modal = document.createElement('div')
    modal.className = 'modal pad0' + (opts.modalClass ? ' ' + opts.modalClass : '')
    modal.setAttribute('role', 'dialog')
    modal.setAttribute('aria-modal', 'true')
    var head = document.createElement('div')
    head.className = 'modal-head'
    var h3 = document.createElement('h3')
    if (opts.titleId) h3.id = opts.titleId
    if (opts.title) { h3.setAttribute('data-i18n', opts.title); h3.textContent = t(opts.title.split('||')[0], opts.title.split('||')[1]) }
    head.appendChild(h3)
    if (opts.closeButton !== false) {
      var xrow = document.createElement('div')
      xrow.className = 'close-row'
      var x = document.createElement('button')
      x.type = 'button'
      x.className = 'close-btn'
      x.setAttribute('data-i18n-title', '关闭||Close')
      x.title = t('关闭', 'Close')
      x.onclick = function () { m.close() }
      xrow.appendChild(x)
      head.appendChild(xrow)
    }
    modal.appendChild(head)
    var body = document.createElement('div')
    body.className = 'modal-body' + (opts.bodyClass ? ' ' + opts.bodyClass : '')
    if (opts.bodyId) body.id = opts.bodyId
    if (opts.bodyHtml) body.innerHTML = opts.bodyHtml
    modal.appendChild(body)
    var foot = document.createElement('div')
    foot.className = 'modal-foot'
    if (opts.footId) foot.id = opts.footId
    ;(opts.foot || []).forEach(function (it) {
      if (it.slot === 'msg') {
        var s = document.createElement(it.kind === 'err' ? 'span' : 'div')
        s.id = it.id
        s.className = it.kind === 'err' ? 'mferr' : 'testline'
        foot.appendChild(s)
        return
      }
      var b = document.createElement('button')
      b.type = 'button'
      b.id = it.id
      b.className = 'btn' + (it.primary ? ' primary' : '') + (it.end ? ' end' : '')
      if (it.html) b.innerHTML = it.html
      else if (it.label) { b.setAttribute('data-i18n', it.label); b.textContent = t(it.label.split('||')[0], it.label.split('||')[1]) }
      if (it.title) { b.setAttribute('data-i18n-title', it.title); b.title = t(it.title.split('||')[0], it.title.split('||')[1]) }
      if (it.disabled) b.disabled = true
      if (it.onClick) b.onclick = it.onClick
      foot.appendChild(b)
    })
    if (opts.footHidden) foot.hidden = true
    modal.appendChild(foot)
    scrim.appendChild(modal)
    document.body.appendChild(scrim)
    if (opts.closeOnScrim) {
      scrim.addEventListener('click', function (e) { if (e.target === scrim) m.close() })
    }
    var m = {
      scrim: scrim, body: body, foot: foot,
      _closeOnEsc: opts.closeOnEsc !== false,
      isOpen: function () { return !scrim.hidden },
      open: function () {
        if (!scrim.hidden) return
        Array.prototype.forEach.call(foot.querySelectorAll('.mferr'), function (el) { el.textContent = '' })
        scrim.hidden = false
        modalStack.push(m)
        // 焦点管理（ui-kit §9 声明的壳内置能力）：open 移焦入弹层、close 还原出发点、
        // Tab 圈闭（下方全局 keydown）——否则键盘/读屏用户会 Tab 进遮罩后面的页面内容
        m._lastFocus = document.activeElement
        if (!modal.hasAttribute('tabindex')) modal.setAttribute('tabindex', '-1')
        var f = firstFocusable()
        ;(f || modal).focus()
        if (opts.onOpen) opts.onOpen()
      },
      close: function () {
        if (scrim.hidden) return
        scrim.hidden = true
        var at = modalStack.indexOf(m)
        if (at >= 0) modalStack.splice(at, 1)
        if (m._lastFocus && m._lastFocus.focus) { try { m._lastFocus.focus() } catch (e) { /* 出发点已移除 */ } }
        m._lastFocus = null
        if (opts.onClose) opts.onClose()
      },
    }
    function firstFocusable() {
      var sel = 'a[href], button:not([disabled]), input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      var list = modal.querySelectorAll(sel)
      return list.length ? list[0] : null
    }
    return m
  }
  // Esc 只关最上层弹层：closeOnEsc:false 的壳（如轻量模式提示层）盖着时按键就地吞掉——
  // 此前的循环写法会穿透关掉被遮住的弹层（编辑弹层的未保存输入静默丢弃）。
  // Tab 在弹层打开时圈闭于最上层壳内（createModal 焦点管理配套）。
  document.addEventListener('keydown', function (ev) {
    if (!modalStack.length) return
    var top = modalStack[modalStack.length - 1]
    if (ev.key === 'Escape') {
      if (top._closeOnEsc !== false) top.close()
      return
    }
    if (ev.key !== 'Tab') return
    var sel = 'a[href], button:not([disabled]), input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    var list = top.scrim.querySelectorAll(sel)
    if (!list.length) return
    var inside = top.scrim.contains(document.activeElement)
    var first = list[0], last = list[list.length - 1]
    if (ev.shiftKey && (document.activeElement === first || !inside)) { last.focus(); ev.preventDefault() }
    else if (!ev.shiftKey && (document.activeElement === last || !inside)) { first.focus(); ev.preventDefault() }
  })
  // 配置包统一弹层（导出|导入 一级方向 Seg；导出=附近的电脑/导出链接/导出配置包 三方式，
  // 与导入面板同名同序镜像）。吸收原 shareM（链接）与 importM（导入三来源），
  // 导入内部结构原样保留（segNearby/segLink/segFile 等 id 不变，JS 接线零改动）。
`
export const UI_JS_WIRING = `  document.querySelectorAll('.close-btn').forEach(function (el) { el.innerHTML = icon('close', 15) })
  var fabAddIc = document.getElementById('fabAdd')
  if (fabAddIc) fabAddIc.innerHTML = icon('plus', 24)
  var schedAddIc = document.getElementById('schedAdd')
  if (schedAddIc) schedAddIc.innerHTML = icon('plus', 13)
  var afKeyIc = document.getElementById('afKeyToggle')
  if (afKeyIc) afKeyIc.innerHTML = icon('eye', 14)
  var efKeyIc = document.getElementById('efKeyToggle')
  if (efKeyIc) efKeyIc.innerHTML = icon('eye', 14)
  var pkgPwIc = document.getElementById('pkgPwToggle')
  if (pkgPwIc) pkgPwIc.innerHTML = icon('eye', 14)
  var shareCopyIc = document.getElementById('shareCopyIc')
  if (shareCopyIc) shareCopyIc.innerHTML = icon('copy', 14)
  /* pillSwitch：状态行开关（kit 组件，见 .agents/conventions/ui-kit.md）。
     视觉 = 原 pill（.ptext 内嵌文案 + 可选 caret）；主体与 caret 是两个真实按钮（各自可 Tab）。
     封装四个历史坑：① 文案写内嵌 .ptext（直写根 textContent 会冲掉 caret）
     ② 唯一 set({on,busy,open}) 写入口（轮询重绘与回调共用，避免回灌旧值）
     ③ caret 点击 stopPropagation（不触发热区开关，收起面板不停服务）
     ④ busy 期显示「· …」并防连点；失败回弹由调用方 set({on:旧值}) */
  function pillSwitch(rootId, opt) {
    var root = document.getElementById(rootId)
    if (!root) return null
    var mainBtn = root.querySelector('.psw-main')
    var textEl = root.querySelector('.ptext') || mainBtn || root
    var caret = root.querySelector('.caret')
    var st = { on: !!opt.on, busy: false, open: false }
    var tipOverride = ''
    function fmt() {
      // label 允许传函数（惰性求值）：接线在模块顶层只跑一次，字符串 label 会把 t() 固化在加载时的语言里
      var label = typeof opt.label === 'function' ? opt.label() : opt.label
      if (st.busy) return label + t(' · …', ' · …')
      return opt.text ? opt.text(st.on) : label + ' · ' + (st.on ? t('开', 'on') : t('关', 'off'))
    }
    function render() {
      textEl.textContent = fmt()
      root.classList.toggle('ok', !st.busy && (opt.okOn ? opt.okOn(st.on) : st.on))
      if (mainBtn) mainBtn.setAttribute('aria-checked', st.on ? 'true' : 'false')
      // 悬停整颗 pill 都能看到提示：动态 tipOverride 优先，否则用主体按钮上的静态 i18n title
      root.title = tipOverride || (mainBtn ? (mainBtn.title || '') : '')
      if (caret) {
        caret.hidden = !st.on
        caret.setAttribute('aria-expanded', st.open ? 'true' : 'false')
        caret.classList.toggle('open', st.open)
      }
    }
    var api = {
      set: function (patch) {
        if (patch.on !== undefined) st.on = !!patch.on
        if (patch.busy !== undefined) st.busy = !!patch.busy
        if (patch.open !== undefined) st.open = !!patch.open
        render()
      },
      isOn: function () { return st.on },
      isOpen: function () { return st.open },
      setTip: function (text) { tipOverride = text || ''; render() },
      render: render,
    }
    root.addEventListener('click', function (e) {
      if (caret && e.target.closest && e.target.closest('.caret')) {
        e.stopPropagation()
        if (st.busy) return
        st.open = !st.open
        if (opt.panel) opt.panel().hidden = !st.open
        render()
        if (opt.onExpand) opt.onExpand(st.open)
        return
      }
      if (st.busy) return
      if (opt.onToggle) opt.onToggle(!st.on, api)
      else { st.on = !st.on; render() }
    })
    render()
    return api
  }
  var COMMON = ['custom', 'deepseek-anthropic', 'openai', 'anthropic']
  // 「更多服务」Top 10 白名单（2026-10 热度排序）：按服务商合并，选完表单协议地址按预设自动填好。
  // 协议变体与长尾厂商不再在 UI 列出（预设库保留，CLI / presets.json 仍可用）。
  // bigmodel 只列 openai 预设——其 anthropic 兼容端点已下线（2026-10 实测），anthropic 变体预设已移除
  var MORE_TOP = ['bigmodel-openai', 'kimi-anthropic-cn', 'ark-coding-plan', 'ark-agent-plan', 'zai-anthropic', 'kimi-anthropic-global', 'mimo-token-plan-cn', 'dashscope-openai', 'openrouter', 'gemini-openai']
  var view = null
  var overviewLastText = '' // 上次 overview 原始响应串：pollOverview 文本级 diff 用
  var svcQ = '', svcSort = 'default', svcFilter = 'all'
  // 长列表防撑高：服务默认只渲染前 N 个（一键展开/收起，不用分页——切换服务不该翻页找）；客户端未安装项默认折叠
  var SVC_COLLAPSE_N = 8
  var svcExpanded = false
  var cliShowUninstalled = false
  // 正在自动安装的客户端（harness id → true）。做模块级标记而非按钮临时状态：5s 轮询整页重绘时会
  // 重建客户端列表，仅靠按钮上的「正在安装…」会被冲掉，导致安装未完成按钮就变回「安装并接入」，
  // 让人误以为点击没生效。标记由 renderClients 消费，跨重绘保持，安装完成/失败后才解除。
  var cliInstalling = {}

  // i18n：动态文案用 t(中文, English)；静态节点用 data-i18n(-ph/-title)="中文||English"，applyLang 统一切换
`
