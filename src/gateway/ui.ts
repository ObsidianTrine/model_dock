/**
 * Web 控制台 v2：面向用户任务而非内部概念。
 * 三步式：① 添加模型服务（粘贴 Key 即可）→ ② 点「应用」切换 → ③ 一键接入 AI 客户端。
 * 管理面读写一律要求 admin 凭据（x-modeldock-admin 头，或 ?token= 登录种下的 mdk_admin cookie）；
 * 未带凭据打开时由 showLoginRequired 给出可操作指引。
 */
/** 拼装壳：页面骨架（head/标签开闭）留在此处，CSS/正文/JS 按域拆在 ./ui/* 各模块。
 *  片段按原次序拼接、与拆分前逐字节一致（拆分脚本自检 + webui-static/ui-lint 门禁保证）。
 *  token/port 的 replaceAll 注入逻辑在 server.ts 侧，维持原状未动。 */
import { UI_CSS } from './ui/styles.js'
import { UI_BODY_HTML } from './ui/page.js'
import { UI_JS_KIT, UI_JS_WIRING } from './ui/kit.js'
import { UI_JS_MODALS } from './ui/modals.js'
import { UI_JS_I18N } from './ui/i18n.js'
import { UI_JS_SHARED } from './ui/shared.js'
import { UI_JS_APP, UI_JS_OVERVIEW, UI_JS_BOOT } from './ui/overview.js'
import { UI_JS_UPDATE } from './ui/update.js'
import { UI_JS_AUTOROUTE } from './ui/autoroute.js'
import { UI_JS_SERVICES } from './ui/services.js'
import { UI_JS_SCHED_STATE, UI_JS_SCHEDULE } from './ui/schedule.js'
import { UI_JS_CONFIGPACK } from './ui/configpack.js'
import { UI_JS_CLIENTS } from './ui/clients.js'
import { UI_JS_EDIT } from './ui/edit.js'
import { UI_JS_LOGS } from './ui/logs.js'

export const UI_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark light">
<title>ModelDock</title>
<script>try{document.documentElement.setAttribute('data-theme',localStorage.getItem('mdk_theme')||'auto')}catch(e){}</script>
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Cdefs%3E%3ClinearGradient id='g' x1='0' y1='0' x2='1' y2='1'%3E%3Cstop offset='0' stop-color='%236d7cff'/%3E%3Cstop offset='1' stop-color='%234f46e5'/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect width='64' height='64' rx='15' fill='url(%23g)'/%3E%3Cpath d='M14 46V20l18 15 18-15V46' fill='none' stroke='%23fff' stroke-width='7' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E">
<style>
${UI_CSS}</style>
</head>
<body>
${UI_BODY_HTML}<script>
${UI_JS_KIT}${UI_JS_MODALS}${UI_JS_WIRING}${UI_JS_I18N}${UI_JS_SHARED}${UI_JS_APP}${UI_JS_OVERVIEW}${UI_JS_UPDATE}${UI_JS_AUTOROUTE}${UI_JS_SERVICES}${UI_JS_SCHED_STATE}${UI_JS_CONFIGPACK}${UI_JS_SCHEDULE}${UI_JS_CLIENTS}${UI_JS_EDIT}${UI_JS_LOGS}${UI_JS_BOOT}</script>
</body>
</html>
`
