/**
 * Web 控制台 · shared.ts —— 由单文件 ui.ts 按域拆分（T04 Phase 1，行为零变化）。
 * UI_JS_SHARED：共享工具：esc/toast/copyText/api；内嵌控制台共用片段注入点 CONSOLE_SHARED_JS
 * 片段为模板字面量源文本：ui.ts 按原次序拼装后与拆分前逐字节一致；勿改动片段内换行/转义/次序。
 */
import { CONSOLE_SHARED_JS } from '../console-shared.js'
export const UI_JS_SHARED = `  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    })
  }
  // 与手机同步页（lan.ts）同源的共用逻辑（parseTarget/impWarnList/routeSelectHtml）：注入单份共享片段，trT=本页翻译函数
  var trT = t
  ${CONSOLE_SHARED_JS}
  function toast(msg, ok) {
    var wrap = document.getElementById('toastWrap')
    if (!wrap) return
    // 消息用 textContent 填充（上游错误文本不可信）；复制按钮把完整报错一键进剪贴板，✕ 可手动关
    var el = document.createElement('div')
    el.className = 'toast ' + (ok === false ? 'err' : 'ok')
    var span = document.createElement('span')
    span.className = 'tmsg'
    span.textContent = msg
    el.appendChild(span)
    var btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'tcopy'
    btn.title = t('复制完整内容', 'Copy full text')
    btn.innerHTML = icon('copy', 14)
    btn.onclick = function () {
      copyText(msg, function () {
        btn.innerHTML = icon('check', 12)
        setTimeout(function () { btn.innerHTML = icon('copy', 14) }, 1200)
      })
    }
    el.appendChild(btn)
    var x = document.createElement('button')
    x.type = 'button'
    x.className = 'tx'
    x.title = t('关闭', 'Close')
    x.innerHTML = icon('close', 13)
    x.onclick = function () { el.remove() }
    el.appendChild(x)
    wrap.appendChild(el)
    // 错误停留更久（且不与成功提示互相挤掉彼此该有的可读时间）
    setTimeout(function () { el.remove() }, ok === false ? 8000 : 4200)
  }
  // 剪贴板 API 不可用时的兜底（非安全上下文/老 webview）
  function fallbackCopy(text) {
    var ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    try { document.execCommand('copy') } catch (e) { /* 尽力而为 */ }
    ta.remove()
  }

  function api(path, opts) {
    opts = opts || {}
    // 请求级语言：服务端为本请求生成的文案（报错/卡片描述/审计条目）跟随控制台界面语言
    opts.headers = Object.assign({ 'content-type': 'application/json', 'x-modeldock-lang': LANG }, opts.headers || {})
    // 默认 15s 超时；install/fetch-models 等慢端点由调用方传 timeoutMs 放宽
    opts.signal = AbortSignal.timeout(opts.timeoutMs || 15000)
    return fetch('/_modeldock' + path, opts).then(
      function (res) {
        return res.text().then(function (text) {
          var j = null
          try { j = text ? JSON.parse(text) : null } catch (e) { /* 非 JSON 响应 */ }
          if (!res.ok) {
            var m = (j && j.error && j.error.message) || ('HTTP ' + res.status + (text ? '：' + text.slice(0, 120) : ''))
            if (j && j.modeldock && j.modeldock.hint) m = m + '（' + j.modeldock.hint + '）'
            var err = new Error(m)
            err.status = res.status
            throw err
          }
          if (j === null) throw new Error(t('网关返回了非 JSON 响应，请刷新页面重试', 'The gateway returned a non-JSON response; refresh the page and retry'))
          return j
        })
      },
      function (e) {
        if (e && e.name === 'TimeoutError') throw new Error(t('请求超时：', 'Request timed out: the gateway did not respond in ') + Math.round((opts.timeoutMs || 15000) / 1000) + t('s 内未响应', 's'))
        if (e && e.name === 'AbortError') throw new Error(t('请求已取消', 'Request cancelled'))
        throw new Error(t('无法连接本地网关（', 'Cannot reach the local gateway (') + (e && e.message) + t('）。请确认网关在运行：modeldock gateway start', '). Make sure it is running: modeldock gateway start'))
      }
    )
  }

`
