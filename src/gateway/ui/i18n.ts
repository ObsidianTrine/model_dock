/**
 * Web 控制台 · i18n.ts —— 由单文件 ui.ts 按域拆分（T04 Phase 1，行为零变化）。
 * UI_JS_I18N：i18n 运行时：LANG/t/applyLang 与主题按钮（浏览器端机制，与 util/i18n.ts 无关）
 * 片段为模板字面量源文本：ui.ts 按原次序拼装后与拆分前逐字节一致；勿改动片段内换行/转义/次序。
 */
export const UI_JS_I18N = `  var LANG = localStorage.getItem('mdk_lang') || 'zh'
  function t(zh, en) { return LANG === 'en' && en != null ? en : zh }
  function i18nPick(pairAttr) {
    var pair = pairAttr.split('||')
    return LANG === 'en' && pair[1] != null ? pair[1] : pair[0]
  }
  // 只替换元素里第一个非空文本节点：label 内嵌 input、h2 内嵌按钮等混合内容不会被清掉
  function setI18nText(el, txt) {
    for (var i = 0; i < el.childNodes.length; i++) {
      var n = el.childNodes[i]
      if (n.nodeType === 3 && n.nodeValue.trim()) { n.nodeValue = txt; return }
    }
    el.insertBefore(document.createTextNode(txt), el.firstChild)
  }
  function applyLang() {
    document.documentElement.lang = LANG === 'en' ? 'en' : 'zh-CN'
    // 静态节点文案扫描与 applyI18nTree 同源：全树委托，避免整页逐节点遍历写两遍（见 DUP-06）
    applyI18nTree(document)
    Array.prototype.forEach.call(document.querySelectorAll('#langSwitch button'), function (b) { b.className = b.getAttribute('data-lang') === LANG ? 'on' : '' })
    renderThemeBtn()
    pollHealth() // 横幅健康文案也是动态的，切语言后立即重取
    if (view) render()
    // 状态行 pill 的文案在组件内自绘（render() 不一定逐个 set）：惰性 label 依赖这次重绘才换语言，根 title 同步跟上
    Array.prototype.forEach.call([autoRouteApi, errApi, fbApi, asApi, lanApi, schedApi], function (p) { if (p) p.render() })
  }

  // 主题：auto（跟随系统）/ dark / light，localStorage 持久化（head 早脚本已按存储值预设 data-theme）
  var THEME_LABELS = { auto: ['🎨 自动', '🎨 Auto'], dark: ['🌙 暗色', '🌙 Dark'], light: ['☀️ 亮色', '☀️ Light'] }
  function renderThemeBtn() {
    var btn = document.getElementById('themeBtn')
    if (!btn) return
    var cur = localStorage.getItem('mdk_theme')
    if (cur !== 'dark' && cur !== 'light') cur = 'auto'
    var labels = THEME_LABELS[cur]
    btn.textContent = LANG === 'en' ? labels[1] : labels[0]
  }
  document.getElementById('themeBtn').onclick = function () {
    var order = ['auto', 'dark', 'light']
    var cur = localStorage.getItem('mdk_theme')
    if (cur !== 'dark' && cur !== 'light') cur = 'auto'
    var next = order[(order.indexOf(cur) + 1) % order.length]
    localStorage.setItem('mdk_theme', next)
    document.documentElement.setAttribute('data-theme', next)
    renderThemeBtn()
  }

`
