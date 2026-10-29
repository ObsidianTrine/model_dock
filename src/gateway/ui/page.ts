/**
 * Web 控制台 · page.ts —— <body> 静态骨架（由单文件 ui.ts 拆出，T04 Phase 1，行为零变化）。
 * ui.ts 以 ${UI_BODY_HTML} 拼装，与拆分前逐字节一致；勿改动片段内换行/转义。
 */
export const UI_BODY_HTML = `<div class="wrap">
<header>
  <span class="logo"><svg width="26" height="26" viewBox="0 0 64 64" aria-hidden="true"><defs><linearGradient id="hlg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#6d7cff"/><stop offset="1" stop-color="#4f46e5"/></linearGradient></defs><rect width="64" height="64" rx="15" fill="url(#hlg)"/><path d="M14 46V20l18 15 18-15V46" fill="none" stroke="#fff" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/></svg></span><span class="brand">ModelDock</span>
  <span id="health">连接中…</span>
  <span id="syncBadge" class="pill" hidden></span>
  <span id="updBadge" class="pill" hidden></span>
  <span id="langSwitch" class="seg"><button type="button" data-lang="zh">中文</button><button type="button" data-lang="en">EN</button></span>
  <span id="themeSwitch"><button type="button" id="themeBtn" class="tip" data-i18n-tip="主题：自动跟随系统 / 暗色 / 亮色||Theme: auto (follow system) / dark / light" data-tip="主题：自动跟随系统 / 暗色 / 亮色">🎨 自动</button></span>
</header>

<div class="card migrate" id="migrateCard" hidden>
  <h2 data-i18n="🧲 检测到旧配置，可以一键搬进来||🧲 Old configs detected — import them in one click">🧲 检测到旧配置，可以一键搬进来</h2>
  <p class="desc" id="migDesc"></p>
  <div class="row">
    <button class="btn primary" id="migGo" data-i18n="一键导入||Import now">一键导入</button>
    <button class="btn" id="migStill" hidden data-i18n="仍然导入全部（含无 Key）||Import all (incl. keyless)">仍然导入全部（含无 Key）</button>
    <button class="btn" id="migSkip" data-i18n="暂不导入||Not now">暂不导入</button>
  </div>
  <div class="testline" id="migMsg"></div>
</div>

<div class="card migrate" id="shareReqCard" hidden>
  <h2 data-i18n="📲 附近的电脑请求拉取你的配置||📲 A nearby computer requests your config">📲 附近的电脑请求拉取你的配置</h2>
  <p class="desc" id="shareReqDesc"></p>
  <div class="row">
    <button class="btn primary" id="shareReqAllow" data-i18n="允许拉取||Allow">允许拉取</button>
    <button class="btn" id="shareReqDeny" data-i18n="拒绝||Deny">拒绝</button>
  </div>
</div>

<div id="addCardSlot"></div>

<div class="card" id="addCard" hidden>
  <h2 id="addH">① 添加模型服务</h2>
  <p class="desc" data-i18n="选一个服务商，粘贴 Key 即用；Key 只保存在你自己电脑上。||Pick a provider, paste your API key, and you're set. The key stays on your own computer.">选一个服务商，粘贴 Key 即用；Key 只保存在你自己电脑上。</p>
  <div class="chips" id="chips"></div>
  <div class="addform svcform" id="addform" hidden>
    <h3 id="afTitle"></h3>
    <!-- 字段由三个公共块生成（端点/模型/故障切换，与编辑页同构）；壳里只留 Key 与动作区 -->
    <div id="afEpHost"></div>
    <label class="flabel">API Key
      <span class="keywrap">
        <input type="password" id="afKey" data-i18n-ph="粘贴 API Key（输入不回显）||Paste API key (input hidden)" placeholder="粘贴 API Key（输入不回显）">
        <button type="button" id="afKeyToggle" data-i18n-title="显示明文||Show plaintext" title="显示明文" class="iconbtn">👁</button>
      </span>
    </label>
    <div id="afModelHost"></div>
    <div id="afFbHost"></div>
    <div class="addfoot" id="afActions">
      <div class="testline" id="afMsg"></div>
      <button class="btn" id="afCancel" data-i18n="取消||Cancel">取消</button>
      <button class="btn primary" id="afSave" data-i18n="保存||Save">保存</button>
    </div>
    </div>
    <!-- 收编入口放 addCard 直属层（不进 #addform）：不选服务商也要可见可用 -->
    <p class="altline"><button type="button" class="btn small" id="legacyImportLink" data-i18n="从本机客户端导入存量配置…||Import existing configs from local apps…">从本机客户端导入存量配置…</button></p>
  </div>

<div class="inusebar" id="inuseBar" hidden></div>

<div class="card">
  <h2 id="svcH">② 我的服务</h2>
  <p class="desc" data-i18n="点「应用」全局切换，已接入的客户端立即生效。||Click &quot;Apply&quot; to switch globally; attached clients take effect immediately.">点「应用」全局切换，已接入的客户端立即生效。</p>
  <div class="svc-toolbar">
    <input type="text" id="svcQ" data-i18n-ph="搜索名称 / 接口地址 / 模型 ID…||Search name / URL / model ID…" placeholder="搜索名称 / 接口地址 / 模型 ID…">
    <select id="svcSort">
      <option value="default" data-i18n="排序：使用中置顶 · 名称||Sort: in-use first · name">排序：使用中置顶 · 名称</option>
      <option value="name-az" data-i18n="名称 A→Z||Name A→Z">名称 A→Z</option>
      <option value="name-za" data-i18n="名称 Z→A||Name Z→A">名称 Z→A</option>
      <option value="cnt-desc" data-i18n="模型数 多→少||Models high→low">模型数 多→少</option>
      <option value="cnt-asc" data-i18n="模型数 少→多||Models low→high">模型数 少→多</option>
    </select>
    <select id="svcFilter">
      <option value="all" data-i18n="全部||All">全部</option>
      <option value="key" data-i18n="有 Key||Has key">有 Key</option>
      <option value="nokey" data-i18n="缺 Key||Missing key">缺 Key</option>
      <option value="current" data-i18n="使用中||In use">使用中</option>
    </select>
  </div>
  <div id="routebox">
    <div class="rrow1" id="rrow1">
      <label><span data-i18n="当前||Current" data-i18n-title="实际使用中的主服务：「自动 · X」=由程序按定时窗口/默认路由选；人工选某服务=立即钉定使用它（优先于定时窗口，直到选回「自动」）||The primary service in use: &quot;Auto · X&quot; = the program picks it via schedule windows/default route; picking a service pins it immediately (overrides schedule windows until you pick &quot;Auto&quot; again)" title="实际使用中的主服务：「自动 · X」=由程序按定时窗口/默认路由选；人工选某服务=立即钉定使用它（优先于定时窗口，直到选回「自动」）">当前</span>
        <select id="curSvcSel"></select>
      </label>
      <span class="pill sw" id="schedPill">
        <button type="button" class="psw-main" role="switch" aria-checked="true" data-i18n-aria="定时切换||Scheduled switching" data-i18n-title="按时间段自动切换主服务/模型（如：工作日高峰期避开 2 倍计费的服务；法定节假日全天谷价，加一条「法定节假日」时段优先走它）；人工钉定主服务期间窗口暂停；主体=启用/停用，右侧箭头=展开/收起时段列表||Switch primary service/model by time of day (e.g. avoid double-billed services at weekday peaks; add a &quot;Holidays&quot; window to prefer the off-peak service all day on statutory holidays); windows pause while the primary is pinned manually; body = enable/disable, arrow = expand/collapse windows"><span class="ptext">定时</span></button>
        <button type="button" class="caret" id="schedCaret" aria-expanded="false" aria-controls="schedPanel" data-i18n-title="展开/收起时段面板（不停服务）||Expand/collapse the schedule windows (service stays on)"></button>
      </span>
      <label><span data-i18n="下一个切换||Next failover" data-i18n-title="主服务不可用时切换到的服务：「自动 · B」=按故障切换顺序（备用服务优先级/实测耗时）自动选；人工选某服务=把它钉为下一个切换目标（主服务恢复后仍回主服务）；未设故障切换顺序时显示「自动 · 无备用服务」——主服务不可达将无处可切，可在服务编辑页的「故障切换顺序」里添加，或在此直接钉定一个服务||The service to switch to when the primary is down: &quot;Auto · B&quot; = picked by the failover order (fallback priority/latency); picking a service pins it as the next failover target (traffic returns to the primary once it recovers); with no failover order configured it reads &quot;Auto · no fallback&quot; — a failing primary has nowhere to switch to (add fallback services in the service editor, or pin one here)">下一个切换</span>
        <select id="autoRouteSel"><option value="">自动</option></select>
      </label>
    </div>
    <div class="rrow2" id="rrow2">
      <span class="pill sw" id="autoRoutePill">
        <button type="button" class="psw-main" role="switch" aria-checked="true" data-i18n-aria="自动路由||Auto route" data-i18n-title="开启后：定时时段由程序自动接管主服务（按窗口/默认路由选主）。故障切换（主服务不可达时切「下一个切换」）不受此开关影响，始终可用||When on, the program takes over primary selection during schedule windows (by window/default route). Failover (switching to Next when the primary is down) is always available regardless of this switch"><span class="ptext">自动路由</span></button>
      </span>
      <span class="pill sw" id="errPill">
        <button type="button" class="psw-main" role="switch" aria-checked="true" data-i18n-aria="临时故障切备用||Failover on transient errors" data-i18n-title="主服务返回 429 限流或 503 服务不可用（过载）时，若还有备用服务则自动改发（请求未产出内容，无重复计费风险）||When the primary returns 429 (rate limited) or 503 (unavailable/overloaded) and a fallback exists, the request is re-sent automatically (nothing was produced, so no double billing)"><span class="ptext">临时故障切备用</span></button>
      </span>
      <span class="pill sw" id="fbPill">
        <button type="button" class="psw-main" role="switch" aria-checked="true" data-i18n-aria="自动备用链||Auto fallback chain" data-i18n-title="手动备用链之外，自动把已启用的服务补进切换候选（按定时窗口 / 优先级 / 实测耗时排序，上限 3 个）；模型名原样透传，换模型请在客户端里换||Beyond the manual fallback list, eligible enabled services are appended as failover candidates (ranked by schedule window / priority / latency, capped at 3); the model name passes through unchanged — switch models in your client"><span class="ptext">自动备用链</span></button>
      </span>
      <span class="pill sw" id="asPill">
        <button type="button" class="psw-main" role="switch" aria-checked="false" data-i18n-aria="开机自启||Autostart" data-i18n-title="开机自动启动网关、崩溃自动拉起：重启/崩溃不再导致所有客户端断连。macOS 用 LaunchAgent，Linux 用 systemd 用户服务，Windows 用启动文件夹||Auto-start the gateway at login and revive it after crashes: reboots/crashes no longer disconnect every client. macOS uses LaunchAgent, Linux systemd user service, Windows Startup folder"><span class="ptext">开机自启</span></button>
      </span>
      <span class="pill sw" id="lanPill">
        <button type="button" class="psw-main" role="switch" aria-checked="false" data-i18n-aria="手机远程||Mobile console" data-i18n-title="手机扫码查看当前服务并切换（仅限局域网，不含 Key）；点击开关手机远程，点右侧箭头收起/展开二维码||Scan to view the active service and switch from your phone (LAN only, no keys); click to enable/disable, click the arrow to collapse/expand the QR"><span class="ptext">手机远程</span></button>
        <button type="button" class="caret" id="lanCaret" aria-expanded="false" aria-controls="lanPanel" data-i18n-title="展开/收起二维码面板（不停服务）||Expand/collapse the QR panel (service stays on)"></button>
      </span>
      <button type="button" class="btn small" id="pkgPill" data-i18n="配置包||Config package" data-i18n-title="把服务/路由/自定义预设/定时规则封装成口令保护的加密 .msync 文件（含 Key 密文），或生成一次性链接、允许附近电脑直接拉取；也能从文件/链接/附近电脑导入。客户端接入等机器态不随包||Seals providers, routes, custom presets, and schedule rules into a passphrase-protected encrypted .msync file (keys encrypted), or generates a one-time link and lets nearby computers pull directly; import from a file, a link, or nearby computers as well. Client attaches stay put">配置包</button>
    </div>
  </div>
  <div id="lanPanel" hidden>
    <div class="lanflex">
      <div id="lanQr"><p class="empty">…</p></div>
      <div class="laninfo">
        <p class="lanurl" id="lanUrl"></p>
        <div id="lanAlt" hidden>
          <p class="shint" data-i18n="手机连不上？换下面这条地址再试——电脑有多块网卡时，二维码可能选到了手机连不上的那块（VPN / 虚拟机网卡）：||Phone cannot connect? Try another address below — with several network adapters the QR may point at one your phone cannot reach (VPN or virtual-machine adapter):">手机连不上？换下面这条地址再试——电脑有多块网卡时，二维码可能选到了手机连不上的那块（VPN / 虚拟机网卡）：</p>
          <div id="lanAltUrls"></div>
        </div>
        <p class="shint" data-i18n="手机与电脑连同一 Wi-Fi，扫码或输入地址进入；页面只含「看状态 + 切服务」，不含 Key。||Phone on the same Wi-Fi: scan or type the address. The page is view &amp; switch only — no keys.">手机与电脑连同一 Wi-Fi，扫码或输入地址进入；页面只含「看状态 + 切服务」，不含 Key。</p>
        <p class="shint" id="lanWinHint" hidden data-i18n="Windows 首次开启手机远程会弹防火墙提示：请点「允许访问」，且把「专用网络」「公用网络」都勾上；漏点或点「取消」会导致手机打不开。||On Windows, enabling the mobile console pops a firewall alert the first time: click 'Allow access' and keep both Private and Public networks checked. Dismissing it makes the phone page unreachable.">Windows 首次开启手机远程会弹防火墙提示：请点「允许访问」，且把「专用网络」「公用网络」都勾上；漏点或点「取消」会导致手机打不开。</p>
      </div>
    </div>
  </div>
  <div id="schedPanel" hidden>
    <div class="sline">
      <span class="shint big" data-i18n="命中时段优先走指定服务/模型，或避开所选服务；其余时间走默认路由。需先开启自动路由。||Within a window: prefer the chosen service/model, or avoid a service; other times use the default route. Auto route must be on." data-i18n-title="多个优先时段按顺序取首个命中；所选服务全被避开时，其余服务照常优先级使用，不断供。||Multiple prefer windows: first match in order wins. If the avoided services cover everything available, the rest apply in original priority — no downtime." title="多个优先时段按顺序取首个命中；所选服务全被避开时，其余服务照常优先级使用，不断供。">命中时段优先走指定服务/模型，或避开所选服务；其余时间走默认路由。需先开启自动路由。</span>
    </div>
    <div class="shint" id="schedToday"></div>
    <div class="shead"><span data-i18n="模式||Mode">模式</span><span data-i18n="生效日||Days">生效日</span><span data-i18n="开始||Start">开始</span><span data-i18n="结束||End">结束</span><span data-i18n="服务||Service">服务</span><span data-i18n="使用的模型||Model used">使用的模型</span><span></span></div>
    <div id="schedRows"></div>
    <div class="srow">
      <select id="schedNewMode"><option value="" data-i18n="优先走||Prefer">优先走</option><option value="avoid" data-i18n="避开||Avoid">避开</option></select>
      <select id="schedNewDays" data-i18n-title="工作日=周一至五与调休补班日，不含法定节假日；周末=周六、周日；法定节假日=国务院公布的放假日||Weekdays = Mon&ndash;Fri plus makeup workdays, excluding statutory holidays; Weekend = Sat &amp; Sun; Holidays = statutory off days per State Council announcements" title="工作日=周一至五与调休补班日，不含法定节假日；周末=周六、周日；法定节假日=国务院公布的放假日"><option value="" data-i18n="每天||Every day">每天</option><option value="wd" data-i18n="工作日||Weekdays">工作日</option><option value="we" data-i18n="周末||Weekend">周末</option><option value="hol" data-i18n="法定节假日||Holidays">法定节假日</option></select>
      <span class="tfield"><input type="text" class="tinput" id="schedNewStart" inputmode="numeric" maxlength="5" placeholder="--:--" data-i18n-title="点击选择时间，也可直接键入 HH:mm||Click to pick a time, or type HH:mm" title="点击选择时间，也可直接键入 HH:mm"></span>
      <span class="tfield"><input type="text" class="tinput" id="schedNewEnd" inputmode="numeric" maxlength="5" placeholder="--:--" data-i18n-title="点击选择时间，也可直接键入 HH:mm||Click to pick a time, or type HH:mm" title="点击选择时间，也可直接键入 HH:mm"></span>
      <select id="schedNewSvc"></select>
      <select id="schedNewModel"></select>
      <button type="button" class="btn small" id="schedAdd" data-i18n-title="添加时段||Add window" title="添加时段">＋</button>
    </div>
    <div class="sline hol" id="schedUpcomingRow" hidden>
      <span id="schedUpcoming" class="shint"></span>
    </div>
    <div class="testline" id="schedMsg"></div>
  </div>
  <div id="services"></div>
</div>

<div class="card">
  <h2 id="cliH"><span id="cliHText">③ 接入你的 AI 客户端</span> <span class="pill ok" id="cliCount" hidden></span></h2>
  <p class="desc" data-i18n="每个客户端只需接入一次。接入时只改它的「接口地址」，改前自动备份，随时可断开还原。||Attach each client once. Attaching only changes its base URL, with an automatic backup beforehand — detach anytime to restore.">每个客户端只需接入一次。接入时只改它的「接口地址」，改前自动备份，随时可断开还原。</p>
  <div id="clients"></div>
</div>

<div class="card">
  <h2><span data-i18n="MCP 服务器||MCP servers">MCP 服务器</span> <span class="pill ok" id="mcpCount" hidden></span></h2>
  <p class="desc" data-i18n="各 AI 客户端本机配置的 MCP 服务器一览（只读盘点，来自各客户端的配置文件；环境变量只记名字、不收集值）。||All MCP servers configured in your AI clients' local configs (read-only inventory; env vars are listed by name only, values are never collected).">各 AI 客户端本机配置的 MCP 服务器一览（只读盘点，来自各客户端的配置文件；环境变量只记名字、不收集值）。</p>
  <div class="tablescroll"><table id="mcpTable"></table></div>
  <p class="note" id="mcpNote" hidden></p>
</div>

<div class="card">
  <h2><span data-i18n="请求日志||Request log">请求日志</span></h2>
  <p class="desc" data-i18n="仅展示错误请求（4xx/5xx）与控制台操作；正常请求只写入 logs/ 日志文件，不在这里刷屏。||Only error requests (4xx/5xx) and console operations are shown; normal requests are written to the logs/ files only.">仅展示错误请求（4xx/5xx）与控制台操作；正常请求只写入 logs/ 日志文件，不在这里刷屏。</p>
  <div class="tablescroll"><table id="logTable"></table></div>
  <div id="logPager">
    <span class="pglabel">
      <span data-i18n="每页||Per page">每页</span>
      <select id="logPageSize">
        <option value="10">10</option>
        <option value="30">30</option>
        <option value="50">50</option>
        <option value="100">100</option>
      </select>
      <span data-i18n="条||entries">条</span>
    </span>
    <button class="btn small" id="logPrev" data-i18n="上一页||Prev" title="上一页">上一页</button>
    <span id="logPageInfo">1 / 1</span>
    <button class="btn small" id="logNext" data-i18n="下一页||Next" title="下一页">下一页</button>
  </div>
  <p class="note"><span data-i18n="配置和 Key 保存在 ||Config and keys are stored in ">配置和 Key 保存在 </span><code id="cfgPath">~/.modeldock/</code><span data-i18n="。本页覆盖日常操作；模型别名映射等高级配置用命令行 ||. This page covers daily operations; advanced settings like model alias mapping use the CLI ">.本页覆盖日常操作；模型别名映射等高级配置用命令行 </span><code>modeldock --help</code><span data-i18n="。||.">。</span></p>
</div>
</div>

<button class="fab" id="fabAdd" hidden data-i18n-tip="添加模型服务||Add a model service" data-tip="添加模型服务">＋</button>

<button class="snav" id="snavUp" hidden data-i18n-tip="回到页面顶部||Back to top" data-tip="回到页面顶部"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 14.8 12 8.8l6 6"/></svg></button>
<button class="snav" id="snavDown" hidden data-i18n-tip="跳到页面底部||Jump to bottom" data-tip="跳到页面底部"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9.2 12 15.2l6-6"/></svg></button>

<div class="toast-wrap" id="toastWrap" role="status" aria-live="polite"></div>


`
