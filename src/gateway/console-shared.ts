/**
 * 桌面控制台（ui.ts）与手机同步页（lan.ts）内嵌脚本共用的纯 JS 片段。
 *
 * 两页都以内嵌 <script> 模板串形式服务端吐给浏览器，这里把三处逐字重复的逻辑
 * （parseTarget / impWarnList / 路由下拉选项构建）收敛成单份字符串，经 ${CONSOLE_SHARED_JS}
 * 插值注入两页，杜绝双份漂移。
 *
 * 取值约定（注入页必须提供同名变量）：
 *   - `trT`  = 各页的翻译函数（ui 的 `t` / lan 的 `tr`）；
 *   - `esc`  = 各页自带的非法字符转义函数。
 * 片段内只用单/双引号拼接、不用反引号与 ${}，避免在宿主模板串里二次转义。
 */
export const CONSOLE_SHARED_JS = `// ═══ 桌面 / 手机控制台共用逻辑（console-shared.ts 注入；trT=各页翻译函数、esc=各页转义函数）═══
function parseTarget(t) {
  var s = String(t || '')
  var i = s.indexOf(':')
  return i < 0 ? { p: s } : { p: s.slice(0, i), m: s.slice(i + 1) }
}
function impWarnList(rep) {
  var warns = []
  ;(rep.envKeyRefs || []).forEach(function (id) { warns.push(trT('「' + id + '」的 key 走环境变量引用，不随包迁移', '"' + id + '" references its key via env var; not included')) })
  ;(rep.missingKeys || []).forEach(function (id) { warns.push(trT('「' + id + '」的 key 未随包迁移，导入后需补填', '"' + id + '" key not included; fill it in after import')) })
  return warns
}
function routeSelectHtml(items, autoLabel, pinned, pinnedLabel) {
  // 自动路由/故障切换的下拉选项：自动态占位 + enabled 服务 + 钉定项兜底（被下线也保留一项显示）
  // 兜底判定按 enabled 列表（与 lan.ts 原 enList.some 同口径）：钉定被下线（enabled=false）时仍补一项，避免选项消失。
  var opts = '<option value="">' + esc(autoLabel) + '</option>'
  var hit = false
  ;(items || []).forEach(function (s) {
    if (s.enabled !== false) { opts += '<option value="' + esc(s.id) + '">' + esc(s.name != null ? s.name : s.label) + '</option>'; if (s.id === pinned) hit = true }
  })
  if (pinned && !hit) opts += '<option value="' + esc(pinned) + '">' + esc(pinnedLabel || pinned) + '</option>'
  return opts
}
// ═══ 共用逻辑结束 ═══`