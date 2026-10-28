/**
 * Web 控制台 · clients.ts —— 由单文件 ui.ts 按域拆分（T04 Phase 1，行为零变化）。
 * UI_JS_CLIENTS：客户端接入卡：渲染/接入/改写/环境变量/安装态
 * 片段为模板字面量源文本：ui.ts 按原次序拼装后与拆分前逐字节一致；勿改动片段内换行/转义/次序。
 */
export const UI_JS_CLIENTS = `  function renderClients() {
    var el = $('#clients')
    var cnt = document.getElementById('cliCount')
    if (cnt) {
      var attachedN = view.clients.filter(function (c) { return c.attached }).length
      cnt.textContent = attachedN + '/' + view.clients.length + ' ' + t('已接入', 'attached')
      cnt.hidden = view.clients.length === 0
      cnt.className = 'pill' + (attachedN ? ' ok' : '')
    }
    // 重要在前：已接入 → 已安装未接入 → 未安装（同档保持原顺序）；未安装的默认折叠，冷门客户端不占页面高度
    var rank = function (c) { return c.attached ? 0 : (c.installed ? 1 : 2) }
    var sorted = view.clients.slice().sort(function (a, b) { return rank(a) - rank(b) })
    var uninstalled = sorted.filter(function (c) { return !c.attached && !c.installed })
    var rows = cliShowUninstalled ? sorted : sorted.filter(function (c) { return rank(c) < 2 })
    el.innerHTML = rows.map(function (c) {
      var pill, btn
      var isDirect = c.mode === 'direct'
      if (c.attached) {
        pill = '<span class="pill ok">' + (isDirect ? iconInline('link', 12) + ' ' : c.route ? iconInline('lock', 12) + ' ' : '') + iconInline('check', 12) + ' ' + t('已接入', 'Attached') +
          (isDirect ? ' · ' + t('独立直连', 'direct') : '') + '</span>'
        var modeBtn = isDirect
          ? '<button class="btn small" data-toGateway="' + esc(c.id) + '" title="' +
            t('重新纳入网关统一管理（只改本地文件，不要求网关存活）', 'Back to gateway management (local files only; the gateway need not be running)') + '">' + t('切回网关', 'To gateway') + '</button>'
          : c.directSupported
            ? '<button class="btn small direct" data-direct="' + esc(c.id) + '" title="' +
              t('客户端配置直接写上游 url+真实 Key，网关挂掉后照常可用（作救援通道）', 'Writes the upstream URL and real key into the client config; keeps working if the gateway dies (rescue channel)') + '">' + t('独立直连', 'Go direct') + '</button>'
            : ''
        var envBtn = c.id === 'generic-env'
          ? '<button class="btn small" data-env="' + esc(c.id) + '" title="' +
            t('复制接入本网关用的环境变量，填给其他客户端用', 'Copy the env vars for this gateway, to fill into other clients') + '">' +
            t('复制环境变量', 'Copy env vars') + '</button> '
          : ''
        // 网关模式已接入但客户端文件指向别处（可能由其他端口的 ModelDock 实例写入，或手动修改）：
        // 明示不一致并提供一键抢回——按本网关端口 + 当前路由（钉定优先）重写
        var portMismatch = c.attached && c.mode === 'gateway' && c.pointing === 'other'
        var rewriteBtn = portMismatch
          ? '<button class="btn small" data-rewrite="' + esc(c.id) + '" title="' +
            t('该客户端配置文件被其他端口的 ModelDock 实例（或手动修改）指向了别的地址；点此按本网关端口与当前路由重写（自动快照）', 'The client config was pointed elsewhere by another ModelDock instance (or edited manually); this rewrites it for this gateway and the current route (snapshot taken)') + '">' +
            t('按本网关重写', 'Rewrite for this gateway') + '</button> '
          : ''
        btn = rewriteBtn + envBtn + (modeBtn ? modeBtn + ' ' : '') + '<button class="btn small danger" data-detach="' + esc(c.id) + '">' + t('断开并还原', 'Detach & restore') + '</button>'
      } else if (!c.installed) {
        pill = '<span class="pill dim">' + t('未安装', 'Not installed') + '</span>'
        if (cliInstalling[c.id]) {
          // 安装进行中：渲染未绑定动作的禁用按钮，跨轮询重绘保持「正在安装…」，安装完成才切换（见 setInstalling）
          btn = '<button class="btn small primary" disabled><span class="spin"></span>' + t('正在安装…', 'Installing…') + '</button>'
        } else if (c.install && c.install.auto && c.install.sandboxInstall !== 'unsupported') {
          // 沙箱内 npm 全局安装可重定向进沙箱，自动安装照常可用；脚本类安装降级为指引
          btn = '<button class="btn small primary" data-install="' + esc(c.id) + '">' + t('安装并接入', 'Install & attach') + '</button>'
        } else if (c.install) {
          btn = '<button class="btn small primary" data-install-guide="' + esc(c.id) + '">' + t('安装并接入', 'Install & attach') + '</button>'
        } else {
          btn = ''
        }
      } else {
        pill = '<span class="pill">' + t('未接入', 'Not attached') + '</span>'
        // dsh 等多 profile 客户端：接入前可选只写某些端（桌面版/网页版各自独立配置），默认全部
        var scopeSel = ''
        if (c.clientProfiles && c.clientProfiles.length) {
          var sopts = ['<option value="">' + t('全部端', 'All variants') + '（' + esc(c.clientProfiles.join('、')) + '）</option>']
          c.clientProfiles.forEach(function (n) {
            sopts.push('<option value="' + esc(n) + '">' + t('仅', 'Only ') + esc(n) + '</option>')
          })
          scopeSel = '<select class="routesel" data-cliscope="' + esc(c.id) + '" title="' +
            t('选择接入写入哪些端；桌面版与网页版配置相互独立', 'Choose which variants to write; desktop and web have independent configs') + '">' + sopts.join('') + '</select> '
        }
        // 卸载按钮：仅声明了自动卸载的客户端（npm 类）提供；断开 ≠ 卸载——这里补上生命周期最后一环
        var uninstallBtn = c.install && c.install.uninstall
          ? '<button class="btn small ghost-danger" data-uninstall="' + esc(c.id) + '">' + t('卸载', 'Uninstall') + '</button>'
          : ''
        btn = scopeSel + '<button class="btn small primary" data-attach="' + esc(c.id) + '">' + t('一键接入', 'Attach') + '</button> ' + uninstallBtn
      }
      // 钉定路由下拉（仅已接入）：gateway 模式 = 跟随全局/钉服务（只改服务端内存，即时生效）；
      // direct 模式 = 更换直连目标（重写客户端配置文件，走快照 + 确认）
      var routeSel = ''
      if (c.attached) {
        var opts = []
        if (!isDirect) {
          opts.push('<option value="default"' + (!c.route ? ' selected' : '') + '>' +
            t('跟随全局', 'Follow global') + (view.current ? '（' + esc(view.current.label) + '）' : '') + '</option>')
        }
        view.services.forEach(function (s) {
          opts.push('<option value="' + esc(s.id) + '"' + (c.pinnedProvider === s.id ? ' selected' : '') + '>' +
            esc(s.label) + (s.enabled === false ? t('（已下线）', ' (offline)') : '') + '</option>')
        })
        routeSel = '<select class="routesel" data-route="' + esc(c.id) + '" title="' +
          (isDirect
            ? t('更换直连目标（重写客户端配置，自动快照）', 'Change direct target (rewrites client config; snapshot taken)')
            : t('钉定后该客户端固定走所选服务，不受全局切换影响', 'When pinned, this client always uses the selected service regardless of global switching')) +
          '">' + opts.join('') + '</select>'
      }
      // 网关模式已接入但客户端文件指向别处（可能是另一实例的端口）：明示不一致，重写入口就是「接入」
      var portMismatch = c.attached && c.mode === 'gateway' && c.pointing === 'other'
      return '<div class="service"><div class="info"><span class="name">' + esc(c.label) + '</span> ' + pill +
        (routeSel ? ' ' + routeSel : '') +
        '<br><span class="meta">' + (c.attached && c.service ? ((isDirect ? t('独立直连：', 'Direct: ') : c.route ? t('已钉定：', 'Pinned: ') : t('当前服务：', 'Current service: ')) + '<b>' + esc(c.service) + '</b>' + (c.detail ? ' · ' + esc(c.detail) : '')) : esc(c.detail || '')) +
        (portMismatch ? ' · <span class="hint-warn">⚠ ' + t('客户端文件指向其他地址（可能由其他端口的 ModelDock 实例写入），点「按本网关重写」修复', 'Client file points elsewhere (likely written by another ModelDock instance); click Rewrite for this gateway to fix') + '</span>' : '') +
        (c.attached && c.clientScope && c.clientScope.length ? ' · ' + t('写入端: ', 'writes: ') + esc(c.clientScope.join('、')) : '') + '</span></div>' + btn + '</div>'
    }).join('') + (uninstalled.length ? '<div class="listmore"><button class="btn small" id="cliMore">' +
      (cliShowUninstalled
        ? t('收起未安装的客户端', 'Hide not-installed clients')
        : t('展开未安装的客户端（', 'Show not-installed clients (') + uninstalled.length + t('）', ')')) +
      '</button></div>' : '')

    var cliMoreBtn = document.getElementById('cliMore')
    if (cliMoreBtn) cliMoreBtn.onclick = function () { cliShowUninstalled = !cliShowUninstalled; renderClients() }
    document.querySelectorAll('[data-attach]').forEach(function (b) {
      b.onclick = function () { doAttach(b.getAttribute('data-attach')) }
    })
    document.querySelectorAll('[data-rewrite]').forEach(function (b) {
      b.onclick = function () {
        var id = b.getAttribute('data-rewrite')
        var c = clientOf(id)
        // 钉定路由的客户端按钉定 profile 重写；跟随全局的按当前 active_profile
        doRewrite(id, (c && c.route) || '')
      }
    })
    document.querySelectorAll('[data-env]').forEach(function (b) {
      b.onclick = function () { showEnvVars(b.getAttribute('data-env')) }
    })
    document.querySelectorAll('[data-install]').forEach(function (b) {
      b.onclick = function () {
        var id = b.getAttribute('data-install')
        var c = clientOf(id)
        if (!c || !c.install) return
        confirmModal(
          t('安装并接入「', 'Install & attach "') + labelOf(id) + t('」？', '"?'),
          [
            t('将执行安装命令：', 'Will run install command: ') + c.install.command,
            // 沙箱实例：npm 全局安装落点被重定向进沙箱（真机全局环境零改动），提前讲明
            c.install.sandboxInstall === 'redirect'
              ? t('沙箱模式：程序将安装进沙箱内，不改动真机的全局环境与已装客户端', 'Sandbox mode: the client is installed inside the sandbox; the global environment and installed clients on the real machine are untouched')
              : null,
            t('安装成功后自动写入客户端的空配置文件，再进入接入流程', 'After install, an initial config file is written automatically, then the attach flow starts'),
            t('只安装客户端并写入其初始配置，不影响 ModelDock 其余设置', 'Only installs the client and writes its initial config; other ModelDock settings are untouched')
          ].filter(Boolean),
          t('安装并接入', 'Install & attach'),
          function () {
            setInstalling(id, true)
            api('/install', { method: 'POST', body: JSON.stringify({ harness: id }), timeoutMs: 600000 })
              .then(function (r) {
                if (!r.ok) throw new Error(r.output || t('安装失败，请手动安装', 'Install failed; please install manually'))
                toast('✓ ' + (r.skipped
                  ? t('已检测到客户端命令，跳过安装，正在接入', 'Client command already present; skipping install and attaching')
                  : t('已安装，正在接入', 'Installed; attaching')), true)
                // 安装完成：解除「正在安装」，让 load() 重绘为「一键接入」；随后进入接入确认
                setInstalling(id, false)
                return load().then(function () { doAttach(id) })
              })
              .catch(function (e) { setInstalling(id, false); toast(t('安装失败：', 'Install failed: ') + e.message, false) })
          }
        )
      }
    })
    document.querySelectorAll('[data-install-guide]').forEach(function (b) {
      b.onclick = function () {
        var id = b.getAttribute('data-install-guide')
        var c = clientOf(id)
        if (!c || !c.install) return
        confirmModal(
          t('安装「', 'Install "') + labelOf(id) + t('」', '"'),
          [
            // 沙箱内脚本类安装（curl|bash 等）会写真机、落点无法重定向：明确说不支持自动安装
            c.install.sandboxInstall === 'unsupported'
              ? t('沙箱环境不支持自动安装该客户端（其安装方式会写进真机，无法重定向）；请按下方指引手动安装，装好后回到这里重新检测', 'Sandbox cannot auto-install this client (its install method writes to the real machine and cannot be redirected); install manually per the guide below, then come back and re-detect')
              : null,
            c.install.guide,
            c.install.homepage ? t('官方安装页：', 'Official install page: ') + c.install.homepage : null,
            t('装好后点下方按钮重新检测', 'Once installed, click the button below to re-detect')
          ].filter(Boolean),
          t('我装好了，重新检测', 'Installed — re-detect'),
          function () { load() }
        )
      }
    })
    document.querySelectorAll('[data-uninstall]').forEach(function (b) {
      b.onclick = function () {
        var id = b.getAttribute('data-uninstall')
        var c = clientOf(id)
        if (!c || !c.install || !c.install.uninstall) return
        confirmModal(
          t('卸载「', 'Uninstall "') + labelOf(id) + t('」？', '"?'),
          [
            t('将执行卸载命令：', 'Will run uninstall command: ') + c.install.uninstall.command,
            c.install.uninstall.sandbox
              ? t('沙箱模式：只卸载装进沙箱内的程序，真机全局环境与已装客户端不受影响', 'Sandbox mode: only the copy inside the sandbox is removed; the real machine global environment and installed clients are untouched')
              : t('将从本机全局环境卸载该客户端（其他程序不受影响）', 'The client will be removed from this machine global environment (other programs are untouched)'),
            t('客户端配置文件保留；若仍是安装时写入的空配置会一并删除', 'Client config files are kept; the empty bootstrap config written at install time is removed along with the program')
          ].filter(Boolean),
          t('卸载', 'Uninstall'),
          function () {
            api('/uninstall', { method: 'POST', body: JSON.stringify({ harness: id }), timeoutMs: 120000 })
              .then(function (r) {
                toast('✓ ' + (r.skipped
                  ? t('命令已不在 PATH 上，无需卸载', 'Command already absent from PATH; nothing to uninstall')
                  : t('已卸载', 'Uninstalled')), true)
                return load()
              })
              .catch(function (e) { toast(t('卸载失败：', 'Uninstall failed: ') + e.message, false) })
          }
        )
      }
    })
    document.querySelectorAll('[data-detach]').forEach(function (b) {
      b.onclick = function () {
        var id = b.getAttribute('data-detach')
        // 点击即确认：断开并还原（服务端走快照管线，可随时重新接入），不再弹窗
        api('/detach', { method: 'POST', body: JSON.stringify({ harness: id }), timeoutMs: 60000 })
          .then(function (r) {
            var msg = '✓ ' + t('已断开并还原原配置', 'Detached and original config restored')
            if (r.restored && r.consistent === false) msg = t('已还原（部分文件与备份不完全一致）', 'Restored (some files differ slightly from the backup)')
            if ((r.notes || []).length) msg += '：' + r.notes.join('；')
            toast(msg, true)
            return load()
          })
          .catch(function (e) { toast(t('断开失败：', 'Detach failed: ') + e.message, false) })
      }
    })
    // 钉定路由：gateway 模式选「跟随全局」= default，选某服务 = 钉定（服务端内存，立即生效）；
    // direct 模式选某服务 = 更换直连目标（重写客户端配置，自动快照；选定即确认，不弹窗）
    document.querySelectorAll('[data-route]').forEach(function (sel) {
      sel.onchange = function () {
        var id = sel.getAttribute('data-route')
        var v = sel.value
        var c = clientOf(id)
        if (c && c.mode === 'direct') {
          // 下拉选定即确认：直接换直连目标（服务端改前自动快照，可再选回/切回网关还原）
          api('/harness/mode', { method: 'POST', body: JSON.stringify({ harness: id, mode: 'direct', provider: v }) })
            .then(function () {
              toast('✓ ' + t('直连目标已更换，重启客户端后生效', 'Direct target changed; restart the client'), true)
              return load()
            })
            .catch(function (e) { toast(t('更换失败：', 'Change failed: ') + e.message, false); load() })
          return
        }
        var body = v === 'default' ? { harness: id, default: true } : { harness: id, provider: v }
        api('/harness/route', { method: 'POST', body: JSON.stringify(body) })
          .then(function (r) {
            toast('✓ ' + (v === 'default'
              ? t('已恢复跟随全局', 'Now follows the global service')
              : t('已钉定到 ', 'Pinned to ') + serviceLabel(v)), true)
            return load()
          })
          .catch(function (e) {
            toast(t('设置路由失败：', 'Failed to set route: ') + e.message, false)
            load() // 回滚下拉显示（服务端未改，重取 overview 即恢复原状）
          })
      }
    })
    // 切独立直连 / 切回网关：都点击即执行、不弹确认，重写客户端配置文件（服务端走 switchHarnessMode：快照 + 原子写 + 登记）
    document.querySelectorAll('[data-direct]').forEach(function (b) {
      b.onclick = function () {
        var id = b.getAttribute('data-direct')
        // 点击即确认，不再弹窗；直连目标由服务端按客户端钉定/默认路由（active_profile）解析，
        // 改前自动快照、随时可「切回网关」还原，生效提示走 toast
        api('/harness/mode', { method: 'POST', body: JSON.stringify({ harness: id, mode: 'direct' }) })
          .then(function () {
            toast('✓ ' + t('已切换为独立直连，重启客户端后生效', 'Now in direct mode; restart the client'), true)
            return load()
          })
          .catch(function (e) { toast(t('切换失败：', 'Switch failed: ') + e.message, false) })
      }
    })
    document.querySelectorAll('[data-toGateway]').forEach(function (b) {
      b.onclick = function () {
        var id = b.getAttribute('data-toGateway')
        // 点击即确认：写回本地网关 token（非上游真实 Key），随时可再切直连，不再弹窗
        api('/harness/mode', { method: 'POST', body: JSON.stringify({ harness: id, mode: 'gateway' }) })
          .then(function () {
            toast('✓ ' + t('已切回网关接入，重启客户端后生效', 'Back to gateway mode; restart the client'), true)
            return load()
          })
          .catch(function (e) { toast(t('切换失败：', 'Switch failed: ') + e.message, false) })
      }
    })
  }

  function serviceLabel(id) {
    if (view) {
      for (var i = 0; i < view.services.length; i++) if (view.services[i].id === id) return view.services[i].label
    }
    return id
  }

  function labelOf(id) {
    if (view) {
      for (var i = 0; i < view.clients.length; i++) if (view.clients[i].id === id) return view.clients[i].label
    }
    return id
  }

  function clientOf(id) {
    if (view) {
      for (var i = 0; i < view.clients.length; i++) if (view.clients[i].id === id) return view.clients[i]
    }
    return null
  }

  // 安装进行中：先写模块级标记让 renderClients 在轮询重绘后仍保持「正在安装…」，再就地更新当前按钮以便即时反馈；
  // 安装完成或失败后由调用方 setInstalling(id,false) 解除标记，重绘为对应的下一种状态（一键接入 / 安装并接入）
  function setInstalling(id, on) {
    if (on) cliInstalling[id] = true; else delete cliInstalling[id]
    var el = document.querySelector('[data-install="' + id + '"]')
    if (el) {
      if (on) {
        if (el.dataset.label === undefined) el.dataset.label = el.textContent.trim()
        el.disabled = true
        el.innerHTML = '<span class="spin"></span>' + t('正在安装…', 'Installing…')
      } else {
        el.disabled = false
        el.textContent = el.dataset.label || t('安装并接入', 'Install & attach')
        delete el.dataset.label
      }
      return
    }
    // 按钮已被重绘（5s 轮询）覆盖而不再带 data-install：按模块级标记重建一次客户端列表
    renderClients()
  }

  // generic-env：取网关地址 + token，弹窗展示标准环境变量，一键复制给其他客户端用
  function showEnvVars(id) {
    api('/harness/env', { method: 'POST', body: JSON.stringify({ harness: id }) })
      .then(function (r) {
        var lines = r.lines || []
        if (!lines.length) throw new Error(t('未返回环境变量', 'No env vars returned'))
        var text = lines.join('\\n')
        confirmModal(
          t('环境变量 — ', 'Env vars — ') + labelOf(id),
          [t('写进客户端或 shell 后，即可经本机网关调用所有已配置服务：', 'Write these into the client (or your shell) to reach every configured service through this gateway:')]
            .concat(lines),
          t('复制全部', 'Copy all'),
          function () {
            copyText(text, function () { toast('✓ ' + t('已复制到剪贴板', 'Copied to clipboard'), true) })
          }
        )
      })
      .catch(function (e) { toast(t('获取环境变量失败：', 'Failed to get env vars: ') + e.message, false) })
  }

  function doAttach(id) {
    var b = document.querySelector('[data-attach="' + id + '"]')
    if (b) b.disabled = true
    // 接入范围（dsh 多 profile）：下拉选了「仅 desktop」等就带上 client_profiles；空值 = 全部端
    var scopeSel = document.querySelector('[data-cliscope="' + id + '"]')
    var body = { harness: id, setDefault: true }
    if (scopeSel && scopeSel.value) {
      body.client_profiles = scopeSel.value.split(',').map(function (s) { return s.trim() }).filter(Boolean)
    }
    api('/attach/plan', { method: 'POST', body: JSON.stringify(body) })
      .then(function (p) {
        if (b) b.disabled = false
        confirmModal(
          t('接入「', 'Attach "') + labelOf(id) + t('」？', '"?'),
          [
            t('将修改：', 'Will modify: ') + (p.files.map(function (f) { return f.path }).join('、') || t('（无文件改动）', '(no file changes)')),
            t('只改接口地址和本地密钥，其他内容不动', 'Only the base URL and local credentials change; everything else is untouched'),
            t('修改前自动备份，随时可断开还原', 'An automatic backup is made first; detach anytime to restore')
          ].concat(p.notes || []),
          t('确认接入', 'Attach'),
          function () {
            api('/attach/apply', { method: 'POST', body: JSON.stringify(body) })
              .then(function () {
                if (id === 'generic-env') {
                  // 不写文件、没有"重启客户端生效"的概念：接入即登记，直接把环境变量递到用户面前
                  return load().then(function () { showEnvVars(id) })
                }
                toast('✓ ' + t('已接入，重启 ', 'Attached. Restart ') + labelOf(id) + t(' 后生效', ' to take effect'), true)
                return load()
              })
              .catch(function (e) { toast(t('接入失败：', 'Attach failed: ') + e.message, false) })
          }
        )
      })
      .catch(function (e) { if (b) b.disabled = false; toast(t('读取接入方案失败：', 'Failed to read attach plan: ') + e.message, false) })
  }

  var mCb = null
  function confirmModal(title, lines, okText, cb) {
    // dev 沙箱实例：所有写操作确认弹窗首行明示"只影响沙箱"，生产零接触；
    // 沙箱目录路径取服务端下发的 gateway.home（缺省时不含括号，避免展示写死的默认路径）
    var sandbox = view && view.gateway && view.gateway.sandbox
    var gwHome = (view.gateway && view.gateway.home) || ''
    var prefix = sandbox
      ? [gwHome
          ? '⚠ ' + t('dev 沙箱实例：以下写入只影响沙箱目录（', '⚠ dev sandbox: the writes below only affect the sandbox dir (') + gwHome + t('），生产客户端与配置不受影响', '); production clients and config are untouched')
          : '⚠ ' + t('dev 沙箱实例：以下写入只影响沙箱目录，生产客户端与配置不受影响', '⚠ dev sandbox: the writes below only affect the sandbox dir; production clients and config are untouched')]
      : []
    $('#mTitle').textContent = title
    $('#mList').innerHTML = prefix.concat(lines.filter(Boolean)).map(function (l) { return '<li class="mono">' + linkifyText(l) + '</li>' }).join('')
    $('#mOk').textContent = okText
    mCb = cb
    confirmM.open()
  }

  // 指向不一致修复：客户端文件被其他实例（或手动）改到别的地址，按本网关端口 + 当前路由重写。
  // 复用 attach/plan + attach/apply 管线（快照 + 原子写 + 登记）；不带 setDefault，不改动路由与全局默认。
  function doRewrite(id, route) {
    var b = document.querySelector('[data-rewrite="' + id + '"]')
    if (b) b.disabled = true
    var body = { harness: id }
    if (route) body.profile = route
    api('/attach/plan', { method: 'POST', body: JSON.stringify(body) })
      .then(function (p) {
        if (b) b.disabled = false
        confirmModal(
          t('按本网关重写「', 'Rewrite "') + labelOf(id) + t('」？', '" for this gateway?'),
          [
            t('将把客户端配置的接口地址改回本网关（', 'This points the client config back to this gateway (') + p.port + t('）并按当前路由同步模型列表', ') and syncs the model list with the current route'),
            t('修改前自动备份，随时可断开还原', 'An automatic backup is made first; detach anytime to restore')
          ].concat(p.notes || []),
          t('确认重写', 'Rewrite'),
          function () {
            api('/attach/apply', { method: 'POST', body: JSON.stringify(body) })
              .then(function () {
                toast('✓ ' + t('已按本网关重写，重启 ', 'Rewritten for this gateway. Restart ') + labelOf(id) + t(' 后生效', ' to take effect'), true)
                return load()
              })
              .catch(function (e) { toast(t('重写失败：', 'Rewrite failed: ') + e.message, false) })
          }
        )
      })
      .catch(function (e) { if (b) b.disabled = false; toast(t('读取重写方案失败：', 'Failed to read rewrite plan: ') + e.message, false) })
  }

  // mCancel/mOk/Esc 由工厂底栏与 closeOnEsc 承接（onClose 清 mCb = 放弃回调，与旧语义一致）
  // Enter 确认（焦点在按钮上时交给浏览器默认行为，避免双触发）
  document.addEventListener('keydown', function (e) {
    var ov = document.getElementById('overlay')
    if (!ov || ov.hidden) return
    if (e.key === 'Enter' && (!document.activeElement || document.activeElement.tagName !== 'BUTTON')) {
      $('#mOk').click()
    }
  })

  // 编辑模型服务：壳只留 Key 语义与提交动作；字段块见下方「服务表单公共块」
`
