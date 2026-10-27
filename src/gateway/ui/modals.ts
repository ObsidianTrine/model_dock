/**
 * Web 控制台 · modals.ts —— 由单文件 ui.ts 按域拆分（T04 Phase 1，行为零变化）。
 * UI_JS_MODALS：弹层实例：pkg/legacy/confirm/upd/edit/add 各 createModal 装配
 * 片段为模板字面量源文本：ui.ts 按原次序拼装后与拆分前逐字节一致；勿改动片段内换行/转义/次序。
 */
export const UI_JS_MODALS = `  var pkgM = createModal({
    id: 'pkgOverlay',
    title: '配置包||Config package',
    align: 'top',
    closeOnScrim: true,
    // 关闭路径（✕/Esc/遮罩）也要停「附近的电脑」等待轮询：否则 1Hz /remote-status 空转到
    // 65s deadline，票据/授权结果不再被消费（openPkgOverlay 与 importToggle 只盖住了部分入口）
    onClose: function () { stopNearbyPoll() },
    bodyHtml: '<div id="pkgDir" class="seg grow">' +
      '<button type="button" class="on" id="pkgDirExport" data-i18n="导出||Export">导出</button>' +
      '<button type="button" id="pkgDirImport" data-i18n="导入||Import">导入</button></div>' +
      '<div id="pkgExportPane">' +
      '<div id="pkgExpTabs" class="seg grow" style="margin-top:10px">' +
      '<button type="button" id="segExpNearby" data-i18n="附近的电脑||Nearby computers">附近的电脑</button>' +
      '<button type="button" id="segExpLink" data-i18n="导出链接||Export a link">导出链接</button>' +
      '<button type="button" class="on" id="segExpFile" data-i18n="导出配置包||Export package file">导出配置包</button></div>' +
      '<div id="panelExpNearby" hidden style="margin-top:10px">' +
      '<p class="testline" id="expNearbyState"></p>' +
      '<p class="row" style="margin:6px 0 0"><button type="button" class="btn small" id="expLanOn" hidden data-i18n="立即开启||Enable now">立即开启</button></p>' +
      '<p class="help" data-i18n="无需导出操作：对方在「导入 → 附近的电脑」里选中这台电脑即可直接拉取；对方发起时你会收到授权请求，点「允许拉取」完成。Windows 首次开启会弹防火墙提示，选「允许访问」。||Nothing to export here: on the other computer, pick this machine under Import → Nearby computers to pull directly. When they initiate, you get an approval prompt — click Allow. On Windows, first enable pops a firewall alert; choose Allow access.">无需导出操作：对方在「导入 → 附近的电脑」里选中这台电脑即可直接拉取；对方发起时你会收到授权请求，点「允许拉取」完成。Windows 首次开启会弹防火墙提示，选「允许访问」。</p></div>' +
      '<div id="panelExpLink" hidden style="margin-top:10px">' +
      '<div id="shareUrls"></div><button type="button" class="alt-toggle" id="shareAltToggle" hidden></button><div class="altlist" id="shareAlts" hidden></div>' +
      '<p class="help" data-i18n="10 分钟内有效 · 拉取一次即作废 · 链接含口令，仅发本人；两台电脑需连同一局域网。||Valid for 10 minutes and works once; the link carries the passphrase — send it only to the intended recipient. Both computers need the same LAN.">10 分钟内有效 · 拉取一次即作废 · 链接含口令，仅发本人；两台电脑需连同一局域网。</p></div>' +
      '<div id="panelExpFile" style="margin-top:10px">' +
      '<span class="keywrap"><input type="password" id="pkgPw" autocomplete="new-password" data-i18n-ph="设置口令||Set a passphrase" placeholder="设置口令">' +
      '<button type="button" id="pkgPwToggle" data-i18n-title="显示明文||Show plaintext" title="显示明文" class="iconbtn"></button></span>' +
      '<p class="help" data-i18n="文件含全部 Key · 口令丢失无法找回，建议与文件分开发送；不要求同一局域网。||The file carries every key (encrypted); a lost passphrase cannot be recovered — send it separately from the file. No LAN needed.">文件含全部 Key · 口令丢失无法找回，建议与文件分开发送；不要求同一局域网。</p></div>' +
      '</div>' +
      '<div id="pkgImportPane" hidden>' +
      '<div id="importTabs" class="seg grow" style="margin-top:10px">' +
      '<button type="button" class="on" id="segNearby" data-i18n="附近的电脑||Nearby computers">附近的电脑</button>' +
      '<button type="button" id="segLink" data-i18n="粘贴链接||Paste a link">粘贴链接</button>' +
      '<button type="button" id="segFile" data-i18n="配置包文件||Package file">配置包文件</button></div>' +
      '<div id="importPanels"><div id="panelNearby"><p class="shint" id="nearbyStatus" style="margin-top:0"></p><div id="impPeers"></div></div>' +
      '<div id="panelLink" hidden><textarea id="impUrl" data-i18n-ph="粘贴分享链接：http://192.168.x.x:8787/…#p=…||Paste the share link: http://192.168.x.x:8787/…#p=…" placeholder="粘贴分享链接：http://192.168.x.x:8787/…#p=…"></textarea></div>' +
      '<div id="panelFile" hidden><p class="row" style="margin:0 0 10px;align-items:center">' +
      '<button type="button" class="btn" id="impFileBtn" data-i18n="选择文件||Choose file">选择文件</button>' +
      '<span id="impFileChip" class="filechip" hidden></span>' +
      // 不设 accept：iOS 选择器会把未注册的 .msync 灰掉（见 lan.ts 同处说明）
      '<input type="file" id="impFile2" hidden></p>' +
      '<input type="password" id="impPw2" data-i18n-ph="配置包口令（导出时设置）||Package passphrase (set at export)" placeholder="配置包口令（导出时设置）" style="width:100%;box-sizing:border-box"></div></div>' +
      '<div id="impPreview" hidden style="margin-top:8px"><p class="testline" id="impPreviewLine"></p>' +
      '<p class="row" style="margin:8px 0 0;align-items:center"><button type="button" class="btn small" id="impBackBtn" data-i18n="返回||Back">返回</button>' +
      '<button type="button" class="btn small primary" id="impConfirmBtn" data-i18n="确认导入||Confirm import">确认导入</button></p></div>' +
      '<p class="help" data-i18n="导入会整体替换现有服务、路由、预设与定时规则，导入前自动快照；客户端接入与网关设置不受影响。||Importing replaces providers, routes, presets and schedule rules; a snapshot is taken first — client attaches and gateway settings are untouched.">导入会整体替换现有服务、路由、预设与定时规则，导入前自动快照；客户端接入与网关设置不受影响。</p></div>',
    foot: [
      { slot: 'msg', id: 'pkgErr', kind: 'err' },
      { id: 'shareRegen', label: '重新生成||Regenerate', end: true, title: '作废当前链接并生成新的||Invalidate the current link and create a new one' },
      { id: 'shareCopyBtn', primary: true, html: '<span id="shareCopyIc"></span><span id="shareCopyTxt" data-i18n="复制链接||Copy link">复制链接</span>' },
      { id: 'impImportBtn', label: '导入||Import', primary: true, end: true, disabled: true },
      { id: 'pkgSaveBtn', label: '生成并下载||Create and download', primary: true, end: true },
    ],
  })
  // 存量收编重开入口（设计定稿）：首启横幅之外的常驻路径——从「添加服务」进入，勾选式导入；
  // 与配置包导入是两个概念（收编=本机客户端配置；配置包=.msync 文件/链接/附近）。
  var legacyM = createModal({
    id: 'legacyOverlay',
    title: '导入存量配置||Import existing configs',
    align: 'top',
    closeOnScrim: true,
    bodyHtml: '<p class="shint" id="legacyDesc" style="margin-top:0"></p><div id="legacyList"></div>' +
      '<p class="help" data-i18n="只读收编：读取一份副本建服务，原客户端不受影响；导入后可在「我的服务」里切换。||Read-only: a copy is read to create services; your original apps stay untouched. Switch them under My services afterwards.">只读收编：读取一份副本建服务，原客户端不受影响；导入后可在「我的服务」里切换。</p>',
    foot: [
      { slot: 'msg', id: 'legacyErr', kind: 'err' },
      { id: 'legacyGo', label: '导入所选||Import selected', primary: true, end: true, disabled: true },
    ],
  })
  var confirmM = createModal({
    id: 'overlay',
    titleId: 'mTitle',
    closeButton: false, // 确认类小弹层无 ✕：取消=唯一反悔路径（kit 底栏规则）
    closeOnScrim: false,
    bodyHtml: '<ul id="mList"></ul>',
    foot: [
      { id: 'mCancel', label: '取消||Cancel', end: true, onClick: function () { confirmM.close() } },
      { id: 'mOk', primary: true, onClick: function () { var cb = mCb; confirmM.close(); if (cb) cb() } },
    ],
    onClose: function () { mCb = null },
  })
  // 存量收编勾选列表已并入上方 legacyM；检查更新弹窗保持独立
  var updM = createModal({
    id: 'updOverlay',
    modalClass: 'upmodal',
    titleId: 'updTitle',
    closeOnScrim: true, // 点遮罩/Esc = 稍后（下个会话仍会提醒），与旧语义一致
    bodyHtml: '<div class="desc-sm" id="updSub"></div>' +
      // 更新进度（v1.1.1 起由 update-progress.json 驱动）：下载/校验/替换/重启各阶段 + 百分比
      '<div id="updProgress" hidden style="margin:8px 0 4px"><div class="progress"><div class="progress-fill" id="updProgressFill" style="width:0%"></div></div>' +
      '<p class="shint" id="updProgressText" style="margin:6px 0 0"></p></div>' +
      '<div class="upnotes" id="updNotes" hidden></div><div class="upmore" id="updMore" hidden></div>' +
      '<div class="uphint" data-i18n="更新时网关会短暂中断，完成后本页自动重连。||The gateway restarts briefly during the update; this page reconnects automatically.">更新时网关会短暂中断，完成后本页自动重连。</div>',
    foot: [
      { slot: 'msg', id: 'updMsg', kind: 'info' },
      { id: 'updCopy', label: '复制说明||Copy notes' },
      { id: 'updDismiss', label: '此版本不再提醒||Skip this version' },
      { id: 'updGo', primary: true },
    ],
  })
  // 三期迁入：编辑服务 / 添加模型服务（门户模式：addCard 内联卡与弹窗双宿主，open/close 时搬入搬出）
  var editM = createModal({
    id: 'editOverlay',
    align: 'top',
    modalClass: 'svcmodal',
    titleId: 'editTitle',
    bodyClass: 'editform svcform',
    bodyHtml: '<div id="efEpHost"></div>' +
      '<label>API Key<span class="keywrap"><input type="password" id="efKey" placeholder="已保存（留空不修改；点右侧按钮查看并拷贝）">' +
      '<button type="button" id="efKeyToggle" data-i18n-title="显示明文||Show plaintext" title="显示明文" class="iconbtn"></button></span></label>' +
      '<div id="efModelHost"></div><div id="efFbHost"></div>',
    foot: [
      { slot: 'msg', id: 'efMsg', kind: 'info' },
      { id: 'efCancel', label: '取消||Cancel', onClick: function () { closeEdit() } },
      { id: 'efSave', label: '保存||Save', primary: true },
    ],
    onClose: function () { editing = null },
  })
  var addM = createModal({
    id: 'addOverlay',
    align: 'top',
    modalClass: 'svcmodal',
    title: '添加模型服务||Add a model service',
    bodyId: 'addModalBody',
    bodyClass: 'addmodal',
    footId: 'addFoot',
    footHidden: true,
    foot: [],
    closeOnScrim: true,
    onClose: function () {
      // 动作区随表单回内联宿主（原位=表单尾），卡片搬回页面槽位
      addOpen = false
      document.getElementById('addFoot').hidden = true
      document.getElementById('addform').appendChild(document.getElementById('afActions'))
      document.getElementById('addCardSlot').appendChild(document.getElementById('addCard'))
      if (view && view.services.length > 0) {
        document.getElementById('addCard').hidden = true
        $('#fabAdd').hidden = false
      }
    },
  })
  // 静态 HTML 里的图标按钮在此一次性填充（innerHTML 不含文本，applyI18n 只改 title 不受影响）
`
