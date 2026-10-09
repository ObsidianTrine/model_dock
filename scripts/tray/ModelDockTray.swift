// ModelDockTray — ModelDock 菜单栏托盘（macOS）
//
// 职责：常驻菜单栏图标（template 实心圆角方块 + 镂空 M，与系统菜单栏风格一致）；打开控制台
// （带令牌 URL，免登录）；「退出」= 停止网关服务 + 托盘退出，不留后台。
// 单实例用 flock 保证（重复拉起即退出）。
//
// 编译：swiftc -O ModelDockTray.swift -o ModelDockTray
// 单文件直接编译（文件即 main），顶层代码作入口；accessory 策略不占 Dock。

import AppKit
import CoreText
import Darwin

// ---------- 路径与状态读取 ----------

func modeldockHome() -> String {
    if let env = ProcessInfo.processInfo.environment["MODELRDOCK_HOME"], !env.isEmpty {
        return env
    }
    return NSHomeDirectory() + "/.modeldock"
}

struct GatewayState: Decodable {
    let pid: Int
    let port: Int
    let admin_token: String
}

func readState() -> GatewayState? {
    guard let data = FileManager.default.contents(atPath: modeldockHome() + "/gateway.json") else { return nil }
    return try? JSONDecoder().decode(GatewayState.self, from: data)
}

func pidAlive(_ pid: Int) -> Bool {
    kill(pid_t(pid), 0) == 0 || errno == EPERM
}

/// 网关可执行文件：优先打包形态（与托盘同目录的主程序），回落已安装 app 与 CLI 链接
func gatewayBinary() -> String? {
    let selfPath = CommandLine.arguments.first ?? "./ModelDockTray"
    let selfDir = (selfPath as NSString).deletingLastPathComponent
    let candidates = [
        selfDir + "/ModelDock",
        "/Applications/ModelDock.app/Contents/MacOS/ModelDock",
        modeldockHome() + "/modeldock",
        "/usr/local/bin/modeldock",
    ]
    return candidates.first { FileManager.default.isExecutableFile(atPath: $0) }
}

// ---------- 单实例（flock） ----------

var trayLockFD: Int32 = -1

func acquireSingleInstance() -> Bool {
    let dir = modeldockHome()
    try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
    let fd = open((dir + "/tray.lock").cString(using: .utf8)!, O_CREAT | O_RDWR, 0o600)
    if fd < 0 { return false }
    if flock(fd, LOCK_EX | LOCK_NB) != 0 {
        close(fd)
        return false
    }
    trayLockFD = fd
    return true
}

// ---------- 应用委托 ----------

final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    var statusItem: NSStatusItem!
    var running = false
    var port = 0
    var timer: Timer?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory) // 不占 Dock，仅菜单栏
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        let menu = NSMenu()
        menu.autoenablesItems = false
        menu.delegate = self
        statusItem.menu = menu
        refreshIcon()
        timer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
            self?.pollHealth()
        }
        pollHealth()
    }

    func pollHealth() {
        guard let s = readState(), pidAlive(s.pid) else {
            apply(running: false, port: 0)
            return
        }
        guard let url = URL(string: "http://127.0.0.1:\(s.port)/_modeldock/health") else {
            apply(running: false, port: 0)
            return
        }
        var req = URLRequest(url: url)
        req.timeoutInterval = 2
        URLSession.shared.dataTask(with: req) { [weak self] _, resp, _ in
            let ok = (resp as? HTTPURLResponse)?.statusCode == 200
            DispatchQueue.main.async { self?.apply(running: ok, port: ok ? s.port : 0) }
        }.resume()
    }

    private func apply(running: Bool, port: Int) {
        if running == self.running && port == self.port { return }
        self.running = running
        self.port = port
        refreshIcon()
    }

    /// template 图标：实心圆角方块 + 居中镂空 M（与 app 图标形一致，系统自动适配深/浅色菜单栏）；
    /// 未运行时降透明度区分状态（0.4 太灰，菜单栏上看不清，抬到 0.7）
    private func trayImage(running: Bool) -> NSImage {
        let size: CGFloat = 18
        let tileInset: CGFloat = 0.5          // 方块外留白：越小图标越大（原 1.5）
        let tileSide = size - tileInset * 2
        let color = running ? NSColor.black : NSColor.black.withAlphaComponent(0.7)
        let img = NSImage(size: NSSize(width: size, height: size), flipped: false) { _ in
            guard let cg = NSGraphicsContext.current?.cgContext else { return false }
            // 文字绘制不遵守 clear 合成，改用 M 字形轮廓 + even-odd 一次填充把 M 抠成镂空
            // 用 heavy 字重：bold 笔画太细，M 中间的 V 形缺口与竖/斜之间的缝在 17pt 下糊成白斑；
            // heavy 下侧缝基本闭合、只剩中间一条细缝，又不至于像 black 那样过粗
            let ptSize: CGFloat = 12
            let nsFont = NSFont.systemFont(ofSize: ptSize, weight: .heavy)
            let font = CTFontCreateWithFontDescriptor(nsFont.fontDescriptor, ptSize, nil)
            var ch: UniChar = UniChar(UnicodeScalar("M").value)
            var glyph = CGGlyph()
            let combined = CGMutablePath()
            // 圆角半径随方块等比放大，保持原来的观感比例
            let radius = tileSide * (5.5 / 15)
            combined.addPath(CGPath(roundedRect: NSRect(x: tileInset, y: tileInset, width: tileSide, height: tileSide),
                                    cornerWidth: radius, cornerHeight: radius, transform: nil))
            if CTFontGetGlyphsForCharacters(font, &ch, &glyph, 1),
               let m = CTFontCreatePathForGlyph(font, glyph, nil) {
                // 按字形墨迹框居中：必须减去 bbox.minX/minY，只减 width/height 会整体偏右约 1pt
                let bb = m.boundingBoxOfPath
                var tr = CGAffineTransform(translationX: (size - bb.width) / 2 - bb.minX,
                                           y: (size - bb.height) / 2 - bb.minY)
                if let mTranslated = m.copy(using: &tr) {
                    combined.addPath(mTranslated)
                }
            }
            cg.addPath(combined)
            cg.setFillColor(color.cgColor)
            cg.fillPath(using: .evenOdd)
            return true
        }
        img.isTemplate = true
        return img
    }

    private func refreshIcon() {
        guard let button = statusItem.button else { return }
        button.image = trayImage(running: running)
        button.toolTip = running ? "ModelDock 网关运行中（端口 \(port)）" : "ModelDock 网关未运行"
    }

    // 每次展开菜单时重建（状态实时）
    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        let state = readState()
        let alive = state != nil && pidAlive(state!.pid)

        let status = NSMenuItem(
            title: alive ? "网关运行中 · 端口 \(state!.port)" : "网关未运行",
            action: nil, keyEquivalent: ""
        )
        status.isEnabled = false
        menu.addItem(status)
        menu.addItem(.separator())

        let open = NSMenuItem(title: "打开控制台", action: #selector(openConsoleClicked), keyEquivalent: "o")
        open.target = self
        open.isEnabled = alive
        menu.addItem(open)

        // 系统默认浏览器直接跳转 web 控制台（不想弹独立窗口时的日常入口）
        let web = NSMenuItem(title: "在浏览器打开", action: #selector(openWebClicked), keyEquivalent: "")
        web.target = self
        web.isEnabled = alive
        menu.addItem(web)

        // 开机自启开关：plist 存在即开启；切换复用主程序 CLI（plist 生成/校验/bootstrap 权威处理）
        let autoOn = FileManager.default.fileExists(atPath: NSHomeDirectory() + "/Library/LaunchAgents/com.modeldock.gateway.plist")
        let auto = NSMenuItem(title: autoOn ? "开机自启 ✓" : "开机自启", action: #selector(toggleAutostartClicked), keyEquivalent: "")
        auto.target = self
        auto.isEnabled = gatewayBinary() != nil
        menu.addItem(auto)

        // 日志排查入口：service-out/err.log 与网关运行日志所在目录
        let logs = NSMenuItem(title: "在 Finder 中打开日志", action: #selector(revealLogsClicked), keyEquivalent: "")
        logs.target = self
        menu.addItem(logs)

        // 清理数据：还原客户端 + 删配置/密钥/日志/同步状态（确认弹窗在动作里）
        let clean = NSMenuItem(title: "清理数据…", action: #selector(cleanDataClicked), keyEquivalent: "")
        clean.target = self
        clean.isEnabled = gatewayBinary() != nil
        menu.addItem(clean)

        // 检查更新：调主程序 CLI `update --check`；有新版弹窗直接给「立即更新」（就地升级，同控制台链路）
        let upd = NSMenuItem(title: "检查更新…", action: #selector(checkUpdateClicked), keyEquivalent: "")
        upd.target = self
        upd.isEnabled = gatewayBinary() != nil
        menu.addItem(upd)

        if !alive {
            let start = NSMenuItem(title: "启动网关", action: #selector(startGatewayClicked), keyEquivalent: "")
            start.target = self
            start.isEnabled = gatewayBinary() != nil
            menu.addItem(start)
        }
        menu.addItem(.separator())

        // 「退出」= 停止网关服务 + 托盘退出，不留后台
        let quit = NSMenuItem(
            title: alive ? "退出（停止网关）" : "退出",
            action: #selector(quitClicked), keyEquivalent: "q"
        )
        quit.target = self
        menu.addItem(quit)
    }

    /// 打开控制台：与双击 app（cli.ts openAppWindow）同源——Chromium 内核浏览器 --app 独立窗口，
    /// 候选顺序一致（Chrome / Edge / Chromium）；都没有才回落系统默认浏览器普通窗口。
    @objc func openConsoleClicked() {
        guard let s = readState(), pidAlive(s.pid) else { return }
        let raw = "http://127.0.0.1:\(s.port)/_modeldock/ui?token=\(s.admin_token)"
        let url = raw.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? raw
        let candidates = [
            "/Applications/Google Chrome.app",
            "/Applications/Microsoft Edge.app",
            "/Applications/Chromium.app",
        ]
        if let app = candidates.first(where: { FileManager.default.fileExists(atPath: $0) }) {
            let proc = Process()
            proc.executableURL = URL(fileURLWithPath: "/usr/bin/open")
            proc.arguments = ["-na", app, "--args", "--app=" + url, "--no-first-run", "--no-default-browser-check"]
            proc.standardOutput = FileHandle.nullDevice
            proc.standardError = FileHandle.nullDevice
            if (try? proc.run()) != nil { return }
        }
        if let url = URL(string: url) {
            NSWorkspace.shared.open(url) // 无 Chromium 内核浏览器：系统默认浏览器
        }
    }

    @objc func startGatewayClicked() {
        guard let bin = gatewayBinary() else { return }
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: bin)
        proc.arguments = ["--sea-gateway"] // 守护模式：端口取配置，内部自带单实例保护
        proc.standardOutput = FileHandle.nullDevice
        proc.standardError = FileHandle.nullDevice
        try? proc.run()
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in self?.pollHealth() }
    }

    /// 在浏览器打开：系统默认浏览器直接跳转 web 控制台（普通页面，非独立窗口）
    @objc func openWebClicked() {
        guard let s = readState(), pidAlive(s.pid) else { return }
        let raw = "http://127.0.0.1:\(s.port)/_modeldock/ui?token=\(s.admin_token)"
        if let url = URL(string: raw.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? raw) {
            NSWorkspace.shared.open(url)
        }
    }

    /// 开机自启切换：复用主程序 CLI 的 gateway install/uninstall（plist 生成/校验/bootstrap 的唯一事实来源）
    @objc func toggleAutostartClicked() {
        let on = FileManager.default.fileExists(atPath: NSHomeDirectory() + "/Library/LaunchAgents/com.modeldock.gateway.plist")
        toggleAutostartCli(install: !on)
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in self?.pollHealth() }
    }

    private func toggleAutostartCli(install: Bool) {
        guard let bin = gatewayBinary() else { return }
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: bin)
        proc.arguments = install ? ["gateway", "install"] : ["gateway", "uninstall"]
        proc.standardOutput = FileHandle.nullDevice
        proc.standardError = FileHandle.nullDevice
        try? proc.run()
    }

    /// 在 Finder 中打开日志目录（gateway.json 同级的 logs/）
    @objc func revealLogsClicked() {
        let dir = modeldockHome() + "/logs"
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        NSWorkspace.shared.open(URL(fileURLWithPath: dir))
    }

    /// 检查更新：异步跑 CLI `update --check`（CLI 无 TTY 不输出色码，纯文本可直接展示），
    /// 结束后按输出弹窗（有新版给「立即更新」/「打开发布页」）
    @objc func checkUpdateClicked() {
        guard let bin = gatewayBinary() else { return }
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: bin)
        proc.arguments = ["update", "--check"]
        let pipe = Pipe()
        proc.standardOutput = pipe
        proc.standardError = pipe
        var out = Data()
        pipe.fileHandleForReading.readabilityHandler = { h in out.append(h.availableData) }
        do { try proc.run() } catch { return }
        proc.terminationHandler = { [weak self] p in
            pipe.fileHandleForReading.readabilityHandler = nil
            out.append(pipe.fileHandleForReading.readDataToEndOfFile())
            let text = String(data: out, encoding: .utf8) ?? ""
            let exit = p.terminationStatus
            DispatchQueue.main.async { self?.showUpdateCheckResult(text: text, exit: exit) }
        }
    }

    /// 检查结果弹窗：正文直接用 CLI 的检查输出——那边已去 markdown 标记 + 摘要收口
    /// （首段 + 几条点题 + 发布页地址），细节留在发布页，故另给「打开发布页」按钮
    private func showUpdateCheckResult(text: String, exit: Int32) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if exit == 0 && trimmed.contains("已是最新") {
            let a = NSAlert()
            a.messageText = "ModelDock"
            a.informativeText = "已是最新版本。"
            a.runModal()
            return
        }
        if exit == 0 && trimmed.contains("有新版本") {
            let version = firstVersion(in: trimmed) ?? ""
            let releaseUrl = firstUrl(in: trimmed)
            let hint = "点击「立即更新」自动下载并校验新版本，完成后网关与菜单栏图标自动重启，无需手动操作。"
            let a = NSAlert()
            a.messageText = version.isEmpty ? "ModelDock 有新版本" : "ModelDock 有新版本 v\(version)"
            a.informativeText = trimmed.isEmpty ? hint : trimmed + "\n\n" + hint
            a.addButton(withTitle: "立即更新")
            if releaseUrl != nil { a.addButton(withTitle: "打开发布页") } // 无链接就不摆无用按钮
            a.addButton(withTitle: "稍后")
            let answer = a.runModal()
            if answer == .alertFirstButtonReturn {
                startUpdateCli()
                let b = NSAlert()
                b.messageText = version.isEmpty ? "正在更新" : "正在更新到 v\(version)"
                b.informativeText = "下载校验完成后自动重启 ModelDock；期间网关会短暂中断。"
                b.runModal()
            } else if let url = releaseUrl, answer == .alertSecondButtonReturn {
                NSWorkspace.shared.open(url)
            }
            return
        }
        // 失败（含未配置令牌）：输出本身是可操作指引，原样展示
        let a = NSAlert()
        a.messageText = "ModelDock 检查更新失败"
        a.informativeText = trimmed.isEmpty ? "未知错误，请稍后重试。" : trimmed
        a.runModal()
    }

    /// 从 CLI 输出里取版本号（「有新版本：v1.2.2（当前 v1.2.1）」）
    private func firstVersion(in text: String) -> String? {
        guard let re = try? NSRegularExpression(pattern: "v([0-9]+\\.[0-9]+\\.[0-9]+)") else { return nil }
        let range = NSRange(text.startIndex..., in: text)
        guard let m = re.firstMatch(in: text, range: range), let r = Range(m.range(at: 1), in: text) else { return nil }
        return String(text[r])
    }

    /// 从 CLI 输出里取发布页地址（「完整说明：https://github.com/.../releases/tag/v1.2.3」）。
    /// 取最后一个匹配：说明正文里可能带别的链接（降级后的行内链接写作「文字 (url)」），
    /// 而发布页那行是输出末尾的固定收尾（按位置而非中文前缀取，英文界面下同样成立）
    private func firstUrl(in text: String) -> URL? {
        guard let re = try? NSRegularExpression(pattern: "https?://\\S+") else { return nil }
        let range = NSRange(text.startIndex..., in: text)
        guard let m = re.matches(in: text, range: range).last, let r = Range(m.range, in: text) else { return nil }
        return URL(string: String(text[r]))
    }

    /// 就地更新：分离跑 `modeldock update --yes`（弹窗里的「立即更新」即用户确认），
    /// 输出追加到 logs/update-tray.log。更新流程会停掉托盘自身（换包后由新版自动拉起），故不等待子进程。
    private func startUpdateCli() {
        guard let bin = gatewayBinary() else { return }
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: bin)
        proc.arguments = ["update", "--yes"]
        let logDir = modeldockHome() + "/logs"
        try? FileManager.default.createDirectory(atPath: logDir, withIntermediateDirectories: true)
        let logPath = logDir + "/update-tray.log"
        if !FileManager.default.fileExists(atPath: logPath) {
            FileManager.default.createFile(atPath: logPath, contents: nil)
        }
        // 子进程自己持有日志句柄：托盘被更新流程停掉后，日志照常写入（失败原因可查）
        if let fh = FileHandle(forWritingAtPath: logPath) {
            fh.seekToEndOfFile()
            proc.standardOutput = fh
            proc.standardError = fh
        } else {
            proc.standardOutput = FileHandle.nullDevice
            proc.standardError = FileHandle.nullDevice
        }
        try? proc.run()
    }

    /// 清理数据：弹窗确认后调主程序 CLI `reset --yes --deep`（清理逻辑全在 CLI，
    /// 托盘只做确认与结果展示）。清理含停网关，故子进程输出落文件，结束后连文件一起读出来。
    @objc func cleanDataClicked() {
        guard let bin = gatewayBinary() else { return }

        let alert = NSAlert()
        alert.messageText = "清理数据？"
        alert.informativeText = """
        还原被接管的客户端，然后删除 ModelDock 保存的全部数据：
        配置与密钥、请求日志、同步状态与本机缓存。

        快照保留（可 modeldock restore 回溯）。清理后需重新运行 modeldock init 配置。
        """
        alert.addButton(withTitle: "清理")
        alert.addButton(withTitle: "取消")
        guard alert.runModal() == .alertFirstButtonReturn else { return }

        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: bin)
        proc.arguments = ["reset", "--yes", "--deep"]
        // 子进程 cwd 绝不落在 ~/.modeldock 内：清理要删的就是它（Windows 上目录被占用会删不掉）
        proc.currentDirectoryURL = URL(fileURLWithPath: NSTemporaryDirectory())
        let out = Pipe()
        proc.standardOutput = out
        proc.standardError = out
        var text = Data()
        out.fileHandleForReading.readabilityHandler = { h in
            let d = h.availableData
            if !d.isEmpty { text.append(d) }
        }
        proc.terminationHandler = { [weak self] _ in
            out.fileHandleForReading.readabilityHandler = nil
            text.append(out.fileHandleForReading.readDataToEndOfFile())
            let result = String(data: text, encoding: .utf8) ?? ""
            DispatchQueue.main.async {
                self?.pollHealth()
                self?.showCleanResult(result)
            }
        }
        do { try proc.run() } catch {
            let failed = NSAlert()
            failed.messageText = "清理失败"
            failed.informativeText = "无法启动清理程序：\(error.localizedDescription)"
            failed.runModal()
        }
    }

    /// 清理结果：CLI 输出本身含「已删除 …」逐条记录，原样展示（用户需要能拷走）
    private func showCleanResult(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let a = NSAlert()
        a.messageText = "清理完成"
        a.informativeText = trimmed.isEmpty
            ? "数据已清理。重新配置请运行 modeldock init。"
            : trimmed
        a.runModal()
    }

    /// 停网关走主程序 CLI 的 gateway stop：正确处理系统服务托管（bootout 再停，避免 KeepAlive 拉锯）
    private func stopGatewayCli() {
        guard let bin = gatewayBinary() else { return }
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: bin)
        proc.arguments = ["gateway", "stop"]
        proc.standardOutput = FileHandle.nullDevice
        proc.standardError = FileHandle.nullDevice
        try? proc.run()
    }

    @objc func quitClicked() {
        let state = readState()
        if let s = state, pidAlive(s.pid) {
            stopGatewayCli()
            // 给 CLI 子进程一点启动时间，再退出托盘（子进程独立完成停止流程）
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { NSApp.terminate(nil) }
            return
        }
        NSApp.terminate(nil)
    }
}

// ---------- 入口 ----------

guard acquireSingleInstance() else { exit(0) } // 已有托盘在跑：静默退出
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let delegate = AppDelegate()
app.delegate = delegate
app.run()
