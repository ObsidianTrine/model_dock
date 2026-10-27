/**
 * Web 控制台 · update.ts —— 由单文件 ui.ts 按域拆分（T04 Phase 1，行为零变化）。
 * UI_JS_UPDATE：更新面板：状态徽标、更新弹层、应用更新与重启收敛
 * 片段为模板字面量源文本：ui.ts 按原次序拼装后与拆分前逐字节一致；勿改动片段内换行/转义/次序。
 */
export const UI_JS_UPDATE = `  function render() {
    layoutAddSection()
    renderChips()
    renderSyncBadge()
    renderServices()
    renderAutoRoute()
    refreshSchedSvcOptions()
    renderClients()
    renderShareRequest()
  }

  // 附近电脑的待确认拉取请求（sync-nearby）：顶部确认卡，随 2s overview 轮询出现/消失
  function renderShareRequest() {
    var card = document.getElementById('shareReqCard')
    if (!card) return
    var req = view ? view.syncRequest : null
    card.hidden = !req
    if (!req) return
    document.getElementById('shareReqDesc').textContent =
      t('电脑「', 'Computer "') + (req.from || '?') + t(
        '」请求拉取你的配置（服务 / 路由 / 预设 / 定时，含 Key）。允许后生成 10 分钟内有效的一次性直拉链接，仅该请求可取走一次。',
        '" requests to pull your config (providers, routes, presets, schedules — including keys). Approving creates a one-time pull link valid for 10 minutes, retrievable only by this request.'
      )
  }

  // 多机同步徽标（顶栏）：正常态一枚安静的灰 pill，冲突/错误/暂停才变色提醒；
  // 长路径、版本号、CLI 指引全部收进悬浮详情——控制台不做同步配置，管理在电脑端命令行
  function renderSyncBadge() {
    var el = document.getElementById('syncBadge')
    if (!el) return
    var s = view && view.sync
    if (!s || s.mode === 'off') { el.hidden = true; return }
    var cls = 'pill', txt
    if (s.paused) { txt = t('同步已暂停', 'Sync paused'); cls += ' dim' }
    else if (s.lastConflictTs) { txt = t('同步冲突待处理', 'Sync conflict pending'); cls += ' warn' }
    else if (s.lastError) { txt = t('同步错误', 'Sync error'); cls += ' err' }
    else { txt = t('多机同步 · 已开启', 'Device sync · on') }
    var tip = []
    if (s.targetLabel) tip.push(t('目标：', 'Target: ') + s.targetLabel)
    if (typeof s.lastAppliedRev === 'number' && s.lastAppliedRev > 0) tip.push(t('已同步到第 ', 'Synced to rev ') + s.lastAppliedRev + t(' 版', ''))
    if (s.lastPushTs) tip.push(t('最近推送：', 'Last push: ') + fmtLocal(s.lastPushTs))
    if (s.lastPullTs) tip.push(t('最近拉取：', 'Last pull: ') + fmtLocal(s.lastPullTs))
    if (s.lastConflictTs) tip.push(t('最近冲突：', 'Last conflict: ') + fmtLocal(s.lastConflictTs) + t('（本机当时改动已快照到 backups/ 目录）', ' (local changes then were snapshotted to the backups/ folder)'))
    if (s.lastError) tip.push(t('最近错误：', 'Last error: ') + s.lastError)
    tip.push(t('管理：modeldock sync --help', 'Manage with: modeldock sync --help'))
    el.className = cls
    el.textContent = txt
    el.title = tip.join('\\n')
    el.hidden = false
  }

  // ISO 时间转本地可读；解析失败原样返回
  function fmtLocal(iso) {
    var d = new Date(iso)
    return isNaN(d.getTime()) ? String(iso) : d.toLocaleString()
  }

  // 一键更新（顶栏徽标 + 居中模态）：安静模式——有新版才徽标 + toast 提醒一次，无新版零打扰；
  // 「此版本不再提醒」记忆在 localStorage（同版本不再提醒，更新到该版本后自动清除）；
  // 手动检查走命令行 modeldock update --check 或托盘「检查更新」，网页端不做检查入口
  var upd = null // 最近一次 /admin/update/status
  var updAnnounced = false // 本次页面会话只 toast 提醒一次
  var updApplying = false // 已点更新、等待网关重启重连（按钮态机：更新到 vX → 更新中…）

  function updDismissedVersion() {
    try { return localStorage.getItem('mdk_upd_dismissed') } catch (e) { return null }
  }

  // 版本号比较（x.y.z 逐段数值）：字典序 '1.9.0' >= '1.10.0' 为真，会把跨位版本对误判成
  // 「已到位」——更新轮询提前 reload 丢进度 UI、启动核验弹假完成。三处核验共用本函数。
  function cmpSemver(a, b) {
    var pa = String(a || '').split('.'), pb = String(b || '').split('.')
    for (var i = 0; i < 3; i++) {
      var x = parseInt(pa[i], 10) || 0, y = parseInt(pb[i], 10) || 0
      if (x !== y) return x < y ? -1 : 1
    }
    return 0
  }

  function renderUpdBadge() {
    var el = document.getElementById('updBadge')
    if (!el) return
    if (!upd || !upd.available || updDismissedVersion() === upd.latest) { el.hidden = true; return }
    el.className = 'pill warn'
    el.textContent = t('可更新 ', 'Update: ') + upd.latest
    el.title = t('发现新版本，点击查看更新内容并一键升级', 'New version found — click to review and update')
    el.hidden = false
  }

  function refreshUpdStatus(cb) {
    api('/admin/update/status').then(function (s) {
      upd = s
      // 已更新到被跳过的版本：清掉记忆（dismissed 一定晚于写入时的 current）
      var dismissed = updDismissedVersion()
      if (dismissed && cmpSemver(s.current, dismissed) >= 0) {
        try { localStorage.removeItem('mdk_upd_dismissed') } catch (e) { /* 隐私模式等 */ }
        dismissed = null
      }
      renderUpdBadge()
      // 发现新版：按全站标准 toast 形态提醒一次（左下角、可复制）；持续入口是顶栏徽标
      if (s.available && !updAnnounced && dismissed !== s.latest) {
        updAnnounced = true
        toast(t('发现新版本 v' + s.latest + '：点击顶栏「可更新」查看说明并一键升级（或命令行 modeldock update）', 'New version v' + s.latest + ' available: click "Update" in the top bar to review and install (or run modeldock update)'))
      }
      if (cb) cb(s)
    }).catch(function () {})
  }

  function updModalRender() {
    var title = document.getElementById('updTitle'),
      sub = document.getElementById('updSub'),
      notes = document.getElementById('updNotes'),
      more = document.getElementById('updMore'),
      go = document.getElementById('updGo'),
      copy = document.getElementById('updCopy'),
      dismiss = document.getElementById('updDismiss')
    if (!title || !upd) return
    setUpdMsg('')
    title.textContent = t('可更新到 ', 'Update to ') + upd.latest
    var subText = t('发现新版本 · 当前 v' + upd.current, 'New version · current v' + upd.current)
    if (upd.sizeBytes > 0) subText += t(' · 安装包 ', ' · package ') + (upd.sizeBytes / 1048576).toFixed(1) + ' MB'
    sub.textContent = subText
    // 说明是纯文本（服务端已去 markdown 标记）：弹层不渲染富文本，只给「去发布页看全文」的外链
    notes.hidden = !upd.notes
    notes.textContent = upd.notes || ''
    more.hidden = !upd.htmlUrl
    more.innerHTML = more.hidden ? '' : docLinkA(t('在 GitHub 查看完整说明', 'View full notes on GitHub'), upd.htmlUrl)
    go.textContent = updApplying ? t('更新中…', 'Updating…') : t('更新到 ', 'Update to ') + upd.latest
    go.disabled = updApplying
    copy.disabled = updApplying
    dismiss.disabled = updApplying
    updProgressRender(upd)
  }

  function updModalToggle(forceHide) {
    if (forceHide) { updM.close(); return }
    if (updM.isOpen()) { updM.close(); return } // toggle 语义保留：已开再调即收起
    refreshUpdStatus()
    updM.open()
    updModalRender()
  }

  // 更新弹窗底栏提示槽（updMsg）：弹层开着时错误/进度写槽位——磨砂遮罩会糊掉全局 toast；
  // 弹层已关（用户中途关掉后在等轮询）才回落主页面 toast（AGENTS 弹层提示归宿约定）
  function setUpdMsg(text, cls) {
    var el = document.getElementById('updMsg')
    if (el) { el.textContent = text || ''; el.className = cls === 'err' || cls === 'ok' ? 'testline ' + cls : 'testline' }
  }
  function updFail(text) {
    if (updM.isOpen()) setUpdMsg(text, 'err')
    else toast(text, false)
  }
  // 更新进度渲染：s.progress 来自 update --yes 子进程写的 update-progress.json（stale 过期时载荷为 null）。
  // 仅在本页发起的一键更新（updApplying）时展示；非确定态（下载总量未知）用 .indet 往复动画兜底
  function updProgressRender(s) {
    var box = document.getElementById('updProgress')
    if (!box) return
    var p = s && s.progress
    var show = !!(updApplying && p && p.stage !== 'failed')
    box.hidden = !show
    if (!show) return
    var fill = document.getElementById('updProgressFill')
    var txt = document.getElementById('updProgressText')
    var names = { downloading: t('下载中', 'Downloading'), verifying: t('校验安装包', 'Verifying package'), swapping: t('停止网关并替换安装', 'Stopping gateway and swapping'), restarting: t('重启服务', 'Restarting'), done: t('更新完成', 'Update complete') }
    var stageText = names[p.stage] || p.stage
    var indet = !(p.total > 0) && p.stage !== 'done'
    if (fill) {
      fill.parentNode.className = 'progress' + (indet ? ' indet' : '')
      fill.style.width = indet ? '' : (p.stage === 'done' ? '100%' : p.percent + '%')
    }
    if (txt) {
      var mbInfo = p.total > 0 ? '（' + (p.received / 1048576).toFixed(1) + ' / ' + (p.total / 1048576).toFixed(1) + ' MB）' : ''
      txt.textContent = stageText + (p.stage === 'downloading' && p.total > 0 ? ' ' + p.percent + '%' + mbInfo : '')
    }
  }

  function updApply() {
    if (updApplying) return
    updApplying = true
    updModalRender()
    api('/admin/update/apply', { method: 'POST' }).then(function (r) {
      if (r && r.started) {
        try { sessionStorage.setItem('mdk_upd_to', String(r.latest || '')) } catch (e) { /* 隐私模式等 */ }
        setUpdMsg(t('开始更新到 v' + r.latest + '，完成后本页自动重连', 'Updating to v' + r.latest + '; this page reconnects when done'))
        pollApplyAndGateway(0, false)
      } else {
        updApplying = false
        updModalRender()
        updFail(r && r.reason === 'in_progress' ? t('更新已在进行中，请稍候', 'An update is already in progress') : t('当前没有可安装的新版本', 'No new version to install'))
      }
    }).catch(function (e) {
      updApplying = false
      updModalRender()
      updFail(e.message)
    })
  }



  // 更新等待循环（2s）：同时盯 status 与 health——
  // 失败=子进程退出而网关一直活着（status.applyError 带出原因，立即提示并恢复按钮）；
  // 成功=网关先被停掉（health 出现过失败）再恢复 → 重载进新版；
  // 下载阶段网关活着是预期，不触发重载（修复点：此前 health 正常即重载，失败时秒重载假完成）。
  // 极端竞态（网关在两次轮询间完成下线+恢复）：current 已到目标版本也视为成功。
  function pollApplyAndGateway(n, sawDown, lastProgressKey) {
    if (n > 300) {
      updApplying = false
      updFail(t('等待更新完成超时。网关可能仍在更新中；若长时间无响应，请查看 __MD_LOGS_DIR__ 下的 update 日志或重跑 modeldock update', 'Timed out waiting for the update. The gateway may still be updating; if it stays unreachable, check the update log under __MD_LOGS_DIR__/ or rerun modeldock update'))
      return
    }
    setTimeout(function () {
      var proceed = function (down) {
        api('/admin/update/status').then(function (s) {
          updProgressRender(s)
          if (updApplying && s.applyError) {
            updApplying = false
            updModalRender()
            updFail(s.applyError)
            return
          }
          var wanted = String(sessionStorage.getItem('mdk_upd_to') || '')
          if (down || (wanted && cmpSemver(s.current, wanted) >= 0)) { location.reload(); return }
          // 超时只按「毫无动静」计（300 轮 ≈ 10 分钟）：进度有推进（阶段/字节变化）就重新计时，
          // 大安装包走慢链路下载超 5 分钟是常态，固定总时长会把健康下载误报成超时
          var key = s.progress ? s.progress.stage + ':' + (s.progress.received != null ? s.progress.received : '') : ''
          pollApplyAndGateway(key === lastProgressKey ? n + 1 : 0, down, key)
        }).catch(function () { pollApplyAndGateway(n + 1, true, lastProgressKey) })
      }
      api('/health').then(function () { proceed(sawDown) }, function () { proceed(true) })
    }, 2000)
  }

  var updBadge = document.getElementById('updBadge')
  if (updBadge) updBadge.onclick = function () { updModalToggle() }
  var updGo = document.getElementById('updGo')
  if (updGo) updGo.onclick = updApply
  var updCopy = document.getElementById('updCopy')
  if (updCopy) updCopy.onclick = function () {
    if (!upd) return
    // 模板串内换行必须写 \\n（见 ui.ts 模板串转义坑）
    var text = t('可更新到 ', 'Update to ') + upd.latest + t('（当前 v' + upd.current + '）', ' (current v' + upd.current + ')') + (upd.notes ? '\\n\\n' + upd.notes : '') + (upd.htmlUrl ? '\\n\\n' + upd.htmlUrl : '')
    // 复制成功的即时反馈用 SVG 对号（与 toast 的复制按钮同一套），不写字符字形
    copyText(text, function () { updCopy.innerHTML = icon('check', 14); setTimeout(function () { updCopy.textContent = t('复制说明', 'Copy notes') }, 1200) })
  }
  var updDismiss = document.getElementById('updDismiss')
  if (updDismiss) updDismiss.onclick = function () {
    if (!upd) return
    try { localStorage.setItem('mdk_upd_dismissed', String(upd.latest)) } catch (e) { /* 隐私模式等 */ }
    updModalToggle(true)
    renderUpdBadge()
    toast(t('已隐藏 v' + upd.latest + ' 的更新提醒；下个新版本会再次提醒', 'Muted update reminders for v' + upd.latest + '; you will be notified again for the next release'))
  }

`
