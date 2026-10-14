// ModelDockTray — ModelDock 菜单栏托盘（macOS）
//
// 职责：常驻菜单栏图标（template 实心圆角方块 + 镂空 M，与系统菜单栏风格一致）；打开控制台
// （带令牌 URL，免登录）；「退出」= 停止网关服务 + 托盘退出，不留后台。
// 单实例用 flock 保证（重复拉起即退出）。
//
// 编译：swiftc -O ModelDockTray.swift -o ModelDockTray
// 单文件直接编译（文件即 main），顶层代码作入口；accessory 策略不占 Dock。

import AppKit
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

// ---------- 托盘操作日志与弹窗正文封顶 ----------

/// 托盘操作日志目录：~/Library/Logs/ModelDock（macOS 惯例位置，Console.app 可见）。
/// 不能用 ~/.modeldock/logs——「清理数据 --deep」会删掉它，等于自己清掉自己的操作记录。
func trayLogDir() -> String {
    let dir = NSHomeDirectory() + "/Library/Logs/ModelDock"
    try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
    return dir
}

/// CLI 全量输出落盘留档（时间戳命名，回看 / 拷走都方便），返回日志路径；落盘失败返回 nil（弹窗退化为纯摘要）
@discardableResult
func writeTrayLog(_ prefix: String, _ text: String) -> String? {
    let df = DateFormatter()
    df.dateFormat = "yyyyMMdd-HHmmss"
    let stamp = df.string(from: Date())
    let path = trayLogDir() + "/\(prefix)-\(stamp).log"
    let body = "# ModelDock \(prefix) \(stamp)\n\n" + text + "\n"
    return FileManager.default.createFile(atPath: path, contents: Data(body.utf8)) ? path : nil
}

/// 弹窗正文封顶：NSAlert 无滚动、会按文本撑高，超长必须截断并给出完整输出的位置，保证按钮永远在屏内
func cappedInfo(_ text: String, logHint: String?) -> String {
    let maxChars = 1200
    guard text.count > maxChars else { return text }
    var out = String(text.prefix(maxChars)) + "\n\n…（内容过长，已截断"
    if let hint = logHint { out += "；完整输出：\(hint)" }
    out += "）"
    return out
}

/// 网关 /admin/update/status 载荷（只取托盘关心的字段；多余字段 Decodable 自动忽略）
struct UpdateStatusPayload: Decodable {
    let current: String
    let checking: Bool
    let lastError: String?
    let latest: String?
    let available: Bool
    let notes: String?
    let htmlUrl: String?
}

/// update-progress.json（update --yes 子进程写的进度；读方按 at 过期判残留）
struct UpdateProgressFile: Decodable {
    let stage: String
    let received: Double
    let total: Double
    let percent: Int
    let error: String?
    let at: Double
}

func readUpdateProgressFile() -> UpdateProgressFile? {
    let path = modeldockHome() + "/update-progress.json"
    guard let data = FileManager.default.contents(atPath: path) else { return nil }
    guard let p = try? JSONDecoder().decode(UpdateProgressFile.self, from: data) else { return nil }
    if Date().timeIntervalSince1970 * 1000 - p.at > 10 * 60_000 { return nil } // 残留过期
    return p
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

// ---------- 更新进度小窗：检查中 / 更新中复用（非模态，更新期间可见，替换段随托盘退出消失） ----------

final class ProgressPanel: NSObject, NSWindowDelegate {
    private let win: NSWindow
    private let label = NSTextField(labelWithString: "")
    private let bar = NSProgressIndicator()
    private var closedByUser = false

    var visible: Bool { win.isVisible }

    override init() {
        win = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 400, height: 88),
                       styleMask: [.titled, .closable], backing: .buffered, defer: false)
        win.title = "ModelDock"
        win.isReleasedWhenClosed = false
        let view = win.contentView!
        label.frame = NSRect(x: 20, y: 52, width: 360, height: 18)
        label.font = NSFont.systemFont(ofSize: 13)
        label.lineBreakMode = .byTruncatingTail
        bar.frame = NSRect(x: 20, y: 24, width: 360, height: 20)
        bar.style = .bar
        bar.isIndeterminate = true
        view.addSubview(label)
        view.addSubview(bar)
        win.center()
        super.init()
        win.delegate = self
    }
    func windowWillClose(_ notification: Notification) { closedByUser = true }

    /// 展示/复用小窗；文本刷新，percent=nil 表示不确定态（转圈）
    func show(title: String, text: String, percent: Double? = nil) {
        closedByUser = false
        win.title = title
        label.stringValue = text
        if let p = percent {
            bar.isIndeterminate = false
            bar.doubleValue = min(100, max(0, p))
        } else {
            bar.isIndeterminate = true
            bar.startAnimation(nil)
        }
        win.center()
        win.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func close() { win.orderOut(nil) }
    var wasClosedByUser: Bool { closedByUser }
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
    // 更新检查/进度状态：gen 计数让迟到的异步回调（超时/慢网）自动作废
    var checkingUpdate = false
    var updateActionGen = 0
    var updatePanel: ProgressPanel?
    var updateTimer: Timer?

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
            // 圆角半径随方块等比放大，保持原来的观感比例
            let radius = tileSide * (5.5 / 15)
            let tile = CGPath(roundedRect: NSRect(x: tileInset, y: tileInset, width: tileSide, height: tileSide),
                              cornerWidth: radius, cornerHeight: radius, transform: nil)
            cg.addPath(tile)
            cg.setFillColor(color.cgColor)
            cg.fillPath()
            // 镂空 M：先填方块，再用 .clear 合成把 M 笔画抠掉。字标与 app 图标同源
            // （build-sea.mjs ICON_M_SEGS 四段圆头笔画，坐标按方块边长归一）。
            // 不走字体字形：17pt 下 V 形缺口与笔画间缝是亚像素宽，抗锯齿糊成半透明白斑；
            // 圆头笔画在 @2x 下笔画约 3.4px、缝 ≥3px，任意尺寸都干净，且无字体依赖
            let k = tileSide / 0.8046 // app 图标中方块占画布 0.8046，换算归一坐标 → pt
            let segs: [(CGFloat, CGFloat, CGFloat, CGFloat)] = [
                (0.295, 0.360, 0.295, 0.645), // 左竖
                (0.295, 0.360, 0.500, 0.565), // 左斜（下探至中部）
                (0.500, 0.565, 0.705, 0.360), // 右斜
                (0.705, 0.360, 0.705, 0.645), // 右竖
            ]
            cg.setBlendMode(.clear)
            cg.setLineWidth(0.081 * k)
            cg.setLineCap(.round)
            for (u1, v1, u2, v2) in segs {
                // app 图标 v 轴向下，翻成 CG y 向上；M 墨迹纵向中心 0.5025 对齐方块中心
                let x1 = size / 2 + (u1 - 0.5) * k
                let y1 = size / 2 + (0.5025 - v1) * k
                let x2 = size / 2 + (u2 - 0.5) * k
                let y2 = size / 2 + (0.5025 - v2) * k
                cg.move(to: CGPoint(x: x1, y: y1))
                cg.addLine(to: CGPoint(x: x2, y: y2))
                cg.strokePath()
            }
            cg.setBlendMode(.normal)
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

        // 检查更新：网关运行中走网关缓存接口（24h TTL / 失败 30min 退避，与控制台同源，TTL 内不打 GitHub）；
        // 网关未运行退回 CLI 现查。进行中菜单项置灰防连点，进度在小窗可见
        let upd = NSMenuItem(title: checkingUpdate ? "检查中…" : "检查更新…", action: checkingUpdate ? nil : #selector(checkUpdateClicked), keyEquivalent: "")
        upd.target = self
        upd.isEnabled = !checkingUpdate && gatewayBinary() != nil
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

    /// 检查更新入口：网关存活走网关缓存接口（控制台/托盘/网关三方同源），否则退回 CLI 现查。
    /// 点击后立刻弹「正在检查更新…」小窗——此前静默等待最长 15s，用户以为点击无效（v1.1.1 实测反馈）。
    @objc func checkUpdateClicked() {
        guard !checkingUpdate else { return } // 菜单项已置灰，这里兜底防连点
        guard gatewayBinary() != nil else { return }
        checkingUpdate = true
        updateActionGen += 1
        let gen = updateActionGen
        updatePanel = updatePanel ?? ProgressPanel()
        updatePanel!.show(title: "ModelDock", text: "正在检查更新…")
        let state = readState()
        if let s = state, pidAlive(s.pid) {
            pollGatewayUpdateStatus(state: s, attempts: 0, gen: gen)
        } else {
            checkViaCli(gen: gen)
        }
    }

    /// 网关缓存路径：GET /admin/update/status 自带惰性检查（24h TTL / 失败 30min 退避），
    /// checking=true 表示首次检查在飞，0.5s 轮询到 false 取结果；HTTP 不通退回 CLI 现查
    private func pollGatewayUpdateStatus(state: GatewayState, attempts: Int, gen: Int) {
        guard checkingUpdate, gen == updateActionGen else { return } // 已被超时/新操作作废
        guard let url = URL(string: "http://127.0.0.1:\(state.port)/_modeldock/admin/update/status") else {
            checkViaCli(gen: gen)
            return
        }
        var req = URLRequest(url: url)
        req.timeoutInterval = 5
        req.setValue(state.admin_token, forHTTPHeaderField: "x-modeldock-admin")
        URLSession.shared.dataTask(with: req) { [weak self] data, resp, err in
            DispatchQueue.main.async {
                guard let self = self, self.checkingUpdate, gen == self.updateActionGen else { return }
                let ok = (resp as? HTTPURLResponse)?.statusCode == 200
                guard err == nil, ok, let data = data,
                      let st = try? JSONDecoder().decode(UpdateStatusPayload.self, from: data) else {
                    self.checkViaCli(gen: gen)
                    return
                }
                if st.checking && attempts < 60 {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                        self.pollGatewayUpdateStatus(state: state, attempts: attempts + 1, gen: gen)
                    }
                    return
                }
                self.finishUpdateCheck(gen: gen)
                self.showUpdateCheckResultPayload(st)
            }
        }.resume()
    }

    /// CLI 现查（网关未运行 / 网关接口不可达时的兜底）：与旧流程一致，异步跑 `update --check`
    private func checkViaCli(gen: Int) {
        guard let bin = gatewayBinary() else { finishUpdateCheck(gen: gen); return }
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: bin)
        proc.arguments = ["update", "--check"]
        let pipe = Pipe()
        proc.standardOutput = pipe
        proc.standardError = pipe
        var out = Data()
        pipe.fileHandleForReading.readabilityHandler = { h in out.append(h.availableData) }
        do { try proc.run() } catch {
            finishUpdateCheck(gen: gen)
            let a = NSAlert()
            a.messageText = "ModelDock 检查更新失败"
            a.informativeText = "无法启动更新检查程序：\(error.localizedDescription)"
            a.runModal()
            return
        }
        // 40s 看门狗：CLI 自带 15s 网络超时，正常必在此前返回；真挂住也给用户交代而非永久沉默
        DispatchQueue.main.asyncAfter(deadline: .now() + 40) { [weak self] in
            guard let self = self, self.checkingUpdate, gen == self.updateActionGen else { return }
            self.finishUpdateCheck(gen: gen)
            let a = NSAlert()
            a.messageText = "ModelDock 检查更新超时"
            a.informativeText = "检查用时超过 40 秒仍未返回（网络异常？）。可稍后重试，或用命令行 modeldock update --check 查看详情。"
            a.runModal()
        }
        proc.terminationHandler = { [weak self] p in
            pipe.fileHandleForReading.readabilityHandler = nil
            out.append(pipe.fileHandleForReading.readDataToEndOfFile())
            let text = String(data: out, encoding: .utf8) ?? ""
            let exit = p.terminationStatus
            DispatchQueue.main.async {
                self?.finishUpdateCheck(gen: gen)
                self?.showUpdateCheckResult(text: text, exit: exit)
            }
        }
    }

    /// 收尾：关进度小窗、放开检查中状态（gen 不匹配的迟到回调自动作废）
    private func finishUpdateCheck(gen: Int) {
        guard gen == updateActionGen else { return }
        checkingUpdate = false
        updatePanel?.close()
    }

    /// 检查结果弹窗（网关路径）：字段齐全，不再解析 CLI 文本
    private func showUpdateCheckResultPayload(_ st: UpdateStatusPayload) {
        if st.available {
            let hint = "点击「立即更新」自动下载并校验新版本，完成后网关与菜单栏图标自动重启，无需手动操作。"
            let a = NSAlert()
            a.messageText = "ModelDock 有新版本 v\(st.latest ?? "")"
            a.informativeText = cappedInfo((st.notes ?? "") + "\n\n" + hint, logHint: nil)
            a.addButton(withTitle: "立即更新")
            if st.htmlUrl != nil { a.addButton(withTitle: "打开发布页") } // 无链接就不摆无用按钮
            a.addButton(withTitle: "稍后")
            let answer = a.runModal()
            if answer == .alertFirstButtonReturn {
                startUpdateCli()
                showUpdateApplyPanel(target: st.latest ?? "")
            } else if let urlStr = st.htmlUrl, answer == .alertSecondButtonReturn, let url = URL(string: urlStr) {
                NSWorkspace.shared.open(url)
            }
            return
        }
        if st.latest == nil, let err = st.lastError {
            // 从未成功检查到任何版本：按失败对待（GitHub 不可达等），错误原样展示
            let a = NSAlert()
            a.messageText = "ModelDock 检查更新失败"
            a.informativeText = cappedInfo(err, logHint: nil)
            a.runModal()
            return
        }
        let a = NSAlert()
        a.messageText = "ModelDock"
        a.informativeText = "已是最新版本。"
        a.runModal()
    }

    /// 更新进度窗：每秒读 update-progress.json 刷新阶段与百分比；
    /// 替换段托盘会被更新流程停掉（换包后新版自动拉起），小窗随之消失属预期
    private func showUpdateApplyPanel(target: String) {
        updatePanel = updatePanel ?? ProgressPanel()
        updatePanel!.show(title: "正在更新到 v\(target)", text: "正在启动更新程序…")
        updateTimer?.invalidate()
        updateTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            self?.refreshUpdateApplyPanel(target: target)
        }
    }

    private func refreshUpdateApplyPanel(target: String) {
        guard let panel = updatePanel else { updateTimer?.invalidate(); return }
        if !panel.visible { updateTimer?.invalidate(); return } // 用户手动关窗：停止刷新
        guard let p = readUpdateProgressFile() else { return } // 阶段间隙暂无进度：保留上一帧
        if p.stage == "failed" {
            updateTimer?.invalidate()
            panel.close()
            let a = NSAlert()
            a.messageText = "ModelDock 更新失败"
            a.informativeText = cappedInfo(p.error ?? "未知错误，可重试 modeldock update。", logHint: nil)
            a.runModal()
            return
        }
        let names = ["downloading": "下载中", "verifying": "校验安装包", "swapping": "停止网关并替换安装", "restarting": "重启服务", "done": "更新完成"]
        let name = names[p.stage] ?? p.stage
        let mbInfo = p.total > 0 ? "（\(String(format: "%.1f", p.received / 1048576)) / \(String(format: "%.1f", p.total / 1048576)) MB）" : ""
        let text = p.stage == "done" ? "更新完成。网关与菜单栏将自动重启。" : name + (p.stage == "downloading" && p.total > 0 ? " \(p.percent)%\(mbInfo)" : "")
        panel.show(title: "正在更新到 v\(target)", text: text, percent: p.total > 0 ? Double(p.percent) : (p.stage == "done" ? 100 : nil))
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
            a.informativeText = cappedInfo(trimmed.isEmpty ? hint : trimmed + "\n\n" + hint, logHint: nil)
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
        // 失败（含未配置令牌）：输出本身是可操作指引，原样展示（超长封顶，按钮不可被顶出屏幕）
        let a = NSAlert()
        a.messageText = "ModelDock 检查更新失败"
        a.informativeText = cappedInfo(trimmed.isEmpty ? "未知错误，请稍后重试。" : trimmed, logHint: nil)
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
        proc.terminationHandler = { [weak self] p in
            out.fileHandleForReading.readabilityHandler = nil
            text.append(out.fileHandleForReading.readDataToEndOfFile())
            let result = String(data: text, encoding: .utf8) ?? ""
            let code = p.terminationStatus
            DispatchQueue.main.async {
                self?.pollHealth()
                self?.showCleanResult(result, exit: code)
            }
        }
        do { try proc.run() } catch {
            let failed = NSAlert()
            failed.messageText = "清理失败"
            failed.informativeText = "无法启动清理程序：\(error.localizedDescription)"
            failed.runModal()
        }
    }

    /// 清理结果：弹窗只放结论（与 Windows 托盘同口径），CLI 全量输出落日志供回看/拷走。
    /// NSAlert 的 informativeText 会按文本撑高且无滚动——原样贴输出曾把按钮顶出屏幕（点不到）。
    private func showCleanResult(_ text: String, exit: Int32) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let logPath = trimmed.isEmpty ? nil : writeTrayLog("clean", trimmed)

        let a = NSAlert()
        let failed = exit != 0
        a.messageText = failed ? "清理未完成" : "清理完成"
        if failed {
            // 失败才是需要展开细节的场景：取末尾几行（报错在结尾），仍封顶防撑爆弹窗
            let lines = trimmed.components(separatedBy: .newlines)
            let tail = trimmed.isEmpty ? "清理未完成，请改用命令行 modeldock reset --deep 查看错误。" : lines.suffix(8).joined(separator: "\n")
            a.informativeText = cappedInfo(tail, logHint: logPath)
        } else {
            var body = "已还原被接管的客户端，并删除配置、密钥、请求日志、同步状态与本机缓存。\n快照保留，可随时 modeldock restore 回溯；重新配置请运行 modeldock init。"
            if let lp = logPath { body += "\n\n完整输出：\(lp)" }
            a.informativeText = body
        }
        a.addButton(withTitle: "好")
        if logPath != nil { a.addButton(withTitle: "查看完整日志") }
        let answer = a.runModal()
        if answer == .alertSecondButtonReturn, let lp = logPath {
            NSWorkspace.shared.open(URL(fileURLWithPath: lp))
        }
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
