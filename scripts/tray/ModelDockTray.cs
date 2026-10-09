// ModelDockTray — ModelDock Windows 托盘（右下角 NotifyIcon）
//
// 职责与 macOS 版对齐：常驻托盘图标；打开控制台（Chromium --app 独立窗口，与双击 app
// 同源）；在浏览器打开；开机自启开关（复用主程序 CLI gateway install/uninstall）；
// 在资源管理器中打开日志；退出 = 停止网关 + 托盘退出。
//
// 编译：csc（.NET Framework 4.x 随 Windows 10/11 预装）——
//   csc /target:winexe /out:ModelDockTray.exe /win32icon:modeldock.ico
//       /r:System.Windows.Forms.dll /r:System.Drawing.dll ModelDockTray.cs
// 语法限制：C# 5（无 $"" 插值、无 ?. ）——目标编译器是 Framework 自带的 v4.0.30319。

using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Threading;
using System.Windows.Forms;

namespace ModelDockTray
{
    static class Program
    {
        /// 双击安装后的快捷方式 = 运行本程序（GUI 子系统，无黑窗）：
        /// 首次运行 → 确保网关拉起 + 弹控制台 + 常驻托盘；托盘已在时 → 仅确保网关 + 再弹一次控制台。
        /// 主程序 modeldock.exe 是控制台子系统（SEA），直接双击会带黑窗——快捷方式一律指向本程序。
        [STAThread]
        static void Main()
        {
            bool owned;
            var mutex = new Mutex(true, "Local\\ModelDockTray", out owned);
            if (!owned)
            {
                // 托盘已在：把这次双击当作「打开控制台」
                EnsureGateway();
                OpenConsoleWhenAlive();
                return;
            }
            GC.KeepAlive(mutex);

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            var ctx = new TrayContext();
            EnsureGateway();
            OpenConsoleWhenAlive();
            Application.Run(ctx);
        }

        /// 网关健康则不动；未健康则拉起守护并等就绪（≤15s）。后台线程执行，不阻塞托盘。
        public static void EnsureGateway()
        {
            var t = new Thread(delegate()
            {
                if (TrayActions.HealthOk()) return;
                StartGatewayDaemon();
                for (int i = 0; i < 30; i++)
                {
                    Thread.Sleep(500);
                    if (TrayActions.HealthOk()) break;
                }
                OpenConsoleWhenAlive();
            });
            t.IsBackground = true;
            t.Start();
        }

        private static void StartGatewayDaemon()
        {
            var bin = TrayActions.GatewayBinaryPath();
            if (bin == null) return;
            try
            {
                Process.Start(new ProcessStartInfo
                {
                    FileName = bin,
                    Arguments = "--sea-gateway",
                    UseShellExecute = false,
                    CreateNoWindow = true, // 守护进程不弹黑窗
                });
            }
            catch { }
        }

        // 启动自动弹窗一次性守卫：Main 主线程与 EnsureGateway 后台线程都等网关就绪后弹控制台，
        // Interlocked 保证两条并发路径只弹一个窗口；用户手点（托盘/菜单）直调 OpenConsole 不受此限
        private static int _autoOpened;

        private static void OpenConsoleWhenAlive()
        {
            // 就绪即弹；未就绪（拉起失败/超时）静默放弃，托盘菜单仍有「启动网关」
            for (int i = 0; i < 35; i++)
            {
                if (TrayActions.HealthOk())
                {
                    if (Interlocked.Exchange(ref _autoOpened, 1) == 0) TrayActions.OpenConsole();
                    return;
                }
                Thread.Sleep(400);
            }
        }
    }

    /// 托盘与启动入口共用的无状态动作（静态，供双线程上下文调用）
    internal static class TrayActions
    {
        private static string _port, _token;

        public static string CurrentPort { get { return _port ?? "0"; } }

        public static string Home()
        {
            var env = Environment.GetEnvironmentVariable("MODELRDOCK_HOME");
            if (!string.IsNullOrEmpty(env)) return env;
            return Environment.GetFolderPath(Environment.SpecialFolder.UserProfile) + "\\.modeldock";
        }

        /// 读 gateway.json 并验证 pid 存活；成功后 Port/Token 可用
        public static bool ReadState()
        {
            _port = _token = null;
            try
            {
                var file = Home() + "\\gateway.json";
                if (!File.Exists(file)) return false;
                var text = File.ReadAllText(file);
                var pid = System.Text.RegularExpressions.Regex.Match(text, "\"pid\"\\s*:\\s*(\\d+)");
                var port = System.Text.RegularExpressions.Regex.Match(text, "\"port\"\\s*:\\s*(\\d+)");
                var token = System.Text.RegularExpressions.Regex.Match(text, "\"admin_token\"\\s*:\\s*\"([^\"]+)\"");
                if (!pid.Success || !port.Success || !token.Success) return false;
                try { Process.GetProcessById(int.Parse(pid.Groups[1].Value)); }
                catch { return false; }
                _port = port.Groups[1].Value;
                _token = token.Groups[1].Value;
                return true;
            }
            catch { return false; }
        }

        public static bool HealthOk()
        {
            if (!ReadState()) return false;
            try
            {
                var req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + _port + "/_modeldock/health");
                req.Timeout = 2000;
                req.Method = "GET";
                using (var resp = (HttpWebResponse)req.GetResponse())
                {
                    return (int)resp.StatusCode == 200;
                }
            }
            catch { return false; }
        }

        public static string ConsoleUrl()
        {
            return "http://127.0.0.1:" + _port + "/_modeldock/ui?token=" + Uri.EscapeDataString(_token ?? "");
        }

        public static string GatewayBinaryPath()
        {
            var selfDir = Path.GetDirectoryName(Application.ExecutablePath);
            var candidates = new[]
            {
                selfDir + "\\modeldock.exe",
                Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles) + "\\ModelDock\\modeldock.exe",
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData) + "\\Programs\\ModelDock\\modeldock.exe",
            };
            foreach (var c in candidates)
                if (File.Exists(c)) return c;
            return null;
        }

        /// 与双击 app（cli.ts openAppWindow）同源：Edge/Chrome --app 独立窗口
        public static void OpenConsole()
        {
            if (!ReadState()) return;
            var url = ConsoleUrl();
            var pf86 = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86);
            var pf = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
            var candidates = new[]
            {
                pf86 + "\\Microsoft\\Edge\\Application\\msedge.exe",
                pf + "\\Microsoft\\Edge\\Application\\msedge.exe",
                pf86 + "\\Google\\Chrome\\Application\\chrome.exe",
                pf + "\\Google\\Chrome\\Application\\chrome.exe",
            };
            foreach (var c in candidates)
            {
                if (!File.Exists(c)) continue;
                try
                {
                    Process.Start(new ProcessStartInfo
                    {
                        FileName = c,
                        Arguments = "--app=" + url + " --no-first-run --no-default-browser-check",
                        UseShellExecute = false,
                    });
                    return;
                }
                catch { }
            }
            OpenWeb(); // 无 Chromium 内核浏览器：系统默认浏览器
        }

        public static void OpenWeb()
        {
            if (!ReadState()) return;
            Process.Start(new ProcessStartInfo { FileName = ConsoleUrl(), UseShellExecute = true });
        }

        public static void RunGatewayCli(string args)
        {
            var bin = GatewayBinaryPath();
            if (bin == null) return;
            try
            {
                Process.Start(new ProcessStartInfo
                {
                    FileName = bin,
                    Arguments = args,
                    UseShellExecute = false,
                    CreateNoWindow = true, // CLI 子进程不弹黑窗
                });
            }
            catch { }
        }

        public static bool AutostartOn()
        {
            var startup = Environment.GetFolderPath(Environment.SpecialFolder.Startup);
            return File.Exists(startup + "\\modeldock-gateway.vbs");
        }

        /// 检查更新（工作线程跑 CLI，不卡托盘）：CLI 无 TTY 输出纯文本（UTF-8），按内容弹窗；
        /// 有新版弹说明窗（正文 = CLI 输出：那边已去 markdown 标记 + 摘要收口）+ 可点发布页链接，
        /// 点「立即更新」即就地更新（与控制台一键升级同一条链路）；
        /// 失败（含未配置令牌）原样展示输出——本身就是可操作指引。
        public static void CheckUpdate()
        {
            var bin = GatewayBinaryPath();
            if (bin == null) return;
            ThreadPool.QueueUserWorkItem(delegate
            {
                string output = "";
                int exit = 1;
                try
                {
                    var psi = new ProcessStartInfo
                    {
                        FileName = bin,
                        Arguments = "update --check",
                        UseShellExecute = false,
                        CreateNoWindow = true,
                        RedirectStandardOutput = true,
                        RedirectStandardError = true,
                        StandardOutputEncoding = System.Text.Encoding.UTF8,
                        StandardErrorEncoding = System.Text.Encoding.UTF8,
                    };
                    using (var p = Process.Start(psi))
                    {
                        if (p != null)
                        {
                            output = p.StandardOutput.ReadToEnd() + p.StandardError.ReadToEnd();
                            p.WaitForExit();
                            exit = p.ExitCode;
                        }
                    }
                }
                catch (Exception ex) { output = ex.Message; }
                string text = output.Trim();
                if (exit == 0 && text.Contains("已是最新"))
                {
                    MessageBox.Show("已是最新版本。", "ModelDock", MessageBoxButtons.OK, MessageBoxIcon.Information);
                }
                else if (exit == 0 && text.Contains("有新版本"))
                {
                    string ver = FirstVersion(text);
                    string title = ver.Length > 0 ? "ModelDock 有新版本 v" + ver : "ModelDock 有新版本";
                    if (ShowUpdateDialog(title, text, LastUrl(text)) == DialogResult.OK)
                    {
                        StartUpdate();
                        MessageBox.Show("正在更新" + (ver.Length > 0 ? "到 v" + ver : "") + "：下载校验完成后自动重启，期间网关会短暂中断。", "ModelDock", MessageBoxButtons.OK, MessageBoxIcon.Information);
                    }
                }
                else
                {
                    MessageBox.Show(text.Length > 0 ? text : "未知错误，请稍后重试。", "ModelDock 检查更新失败", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                }
            });
        }

        /// 就地更新：分离跑 `modeldock update --yes`（弹窗里的「立即更新」即用户确认）。
        /// 不重定向输出——更新流程会停掉托盘自身（换包后由新版拉起），托盘死了日志也写不成；
        /// 失败原因更新后可在控制台或命令行复查。
        public static void StartUpdate()
        {
            var bin = GatewayBinaryPath();
            if (bin == null) return;
            try
            {
                Process.Start(new ProcessStartInfo
                {
                    FileName = bin,
                    Arguments = "update --yes",
                    UseShellExecute = false,
                    CreateNoWindow = true,
                });
            }
            catch { }
        }

        /// 清理数据：确认弹窗后分离跑 `modeldock reset --yes --deep`（清理逻辑全在 CLI，
        /// 托盘只做确认与结果展示）。清理含停网关，无法同步等子进程输出，故提示后异步收尾报告。
        public static void CleanData()
        {
            if (MessageBox.Show(
                    "还原被接管的客户端，然后删除 ModelDock 保存的全部数据：\r\n配置与密钥、请求日志、同步状态与本机缓存。\r\n\r\n快照保留（可 modeldock restore 回溯）。清理后需重新运行 modeldock init 配置。",
                    "清理数据？", MessageBoxButtons.OKCancel, MessageBoxIcon.Warning) != DialogResult.OK)
                return;
            if (!StartCleanCli())
            {
                MessageBox.Show("无法启动清理程序，请改用命令行：modeldock reset --deep", "ModelDock 清理数据", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }
            MessageBox.Show("正在清理：会先还原被接管的客户端，再删除配置、密钥与日志，完成后自动提示。", "ModelDock 清理数据", MessageBoxButtons.OK, MessageBoxIcon.Information);
        }

        /// 管理线程跑 CLI（清理耗时数秒，不能卡住托盘消息循环）
        private static bool StartCleanCli()
        {
            var bin = GatewayBinaryPath();
            if (bin == null) return false;
            var psi = new ProcessStartInfo
            {
                FileName = bin,
                Arguments = "reset --yes --deep",
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                StandardOutputEncoding = System.Text.Encoding.UTF8,
                StandardErrorEncoding = System.Text.Encoding.UTF8,
                // cwd 绝不落在 %USERPROFILE%\.modeldock 内：清理要删的就是它，被占用会删不掉
                WorkingDirectory = Application.StartupPath,
            };
            try
            {
                var p = new Process();
                p.StartInfo = psi;
                p.Start();
                ThreadPool.QueueUserWorkItem(delegate
                {
                    string text = "";
                    int exit = 1;
                    try
                    {
                        text = p.StandardOutput.ReadToEnd() + p.StandardError.ReadToEnd();
                        p.WaitForExit();
                        exit = p.ExitCode;
                    }
                    catch (Exception ex) { text = ex.Message; }
                    try { p.Dispose(); } catch { }
                    string trimmed = text.Trim();
                    string body = trimmed.Length > 0
                        ? trimmed
                        : (exit == 0 ? "数据已清理。重新配置请运行 modeldock init。" : "清理未完成，请改用命令行：modeldock reset --deep");
                    MessageBox.Show(body, "ModelDock 清理数据", MessageBoxButtons.OK,
                        exit == 0 ? MessageBoxIcon.Information : MessageBoxIcon.Warning);
                });
                return true;
            }
            catch { return false; }
        }

        /// 说明窗跑在专用 STA 线程上：ThreadPool 线程是 MTA，而只读文本框的复制走 OLE 剪贴板，
        /// MTA 下会抛 ThreadStateException（既有 MessageBox 是纯 Win32 才没这问题）。
        /// 调用方（ThreadPool 线程）本就为这个弹窗存在，故 Join 等用户选完再返回。
        private static DialogResult ShowUpdateDialog(string title, string body, string releaseUrl)
        {
            DialogResult result = DialogResult.Cancel;
            var t = new Thread(delegate()
            {
                try
                {
                    using (var dlg = new UpdateDialog(title, body, releaseUrl)) { result = dlg.ShowDialog(); }
                }
                catch (Exception ex)
                {
                    // 线程体里的未处理异常会直接结束进程（.NET 2.0+），而这条线程不在 WinForms 的兜底上：
                    // 兜住并回落成「稍后」，说明仍可从控制台或命令行查看
                    MessageBox.Show("无法显示更新说明（" + ex.Message + "）。可改用命令行 modeldock update --check 查看。", "ModelDock", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                }
            });
            t.SetApartmentState(ApartmentState.STA);
            t.IsBackground = true;
            t.Start();
            t.Join();
            return result;
        }

        /// 从 CLI 输出里取版本号（「有新版本：v1.2.2（当前 v1.2.1）」）
        private static string FirstVersion(string text)
        {
            var m = System.Text.RegularExpressions.Regex.Match(text, @"v([0-9]+\.[0-9]+\.[0-9]+)");
            return m.Success ? m.Groups[1].Value : "";
        }

        /// 从 CLI 输出里取发布页地址（「完整说明：https://github.com/.../releases/tag/v1.2.3」）。
        /// 取最后一个匹配：说明正文里可能带别的链接（降级后的行内链接写作「文字 (url)」），
        /// 而发布页那行是输出末尾的固定收尾（按位置而非中文前缀取，英文界面下同样成立）
        private static string LastUrl(string text)
        {
            var ms = System.Text.RegularExpressions.Regex.Matches(text, @"https?://\S+");
            return ms.Count > 0 ? ms[ms.Count - 1].Value : "";
        }

        /// 用系统默认浏览器打开外链
        public static void OpenUrl(string url)
        {
            try { Process.Start(new ProcessStartInfo { FileName = url, UseShellExecute = true }); }
            catch { }
        }

        public static void ToggleAutostart()
        {
            RunGatewayCli(AutostartOn() ? "gateway uninstall" : "gateway install");
        }

        public static void RevealLogs()
        {
            var dir = Home() + "\\logs";
            try { Directory.CreateDirectory(dir); } catch { }
            try { Process.Start(new ProcessStartInfo { FileName = "explorer.exe", Arguments = "\"" + dir + "\"", UseShellExecute = false }); }
            catch { }
        }
    }

    /// 更新说明窗：正文是可选中复制的纯文本（说明已在 CLI 侧去 markdown 标记 + 收口成摘要：
    /// 首段 + 几条点题，细节看发布页），发布页给可点链接——MessageBox 放不了超链接，故用最小 WinForms 窗体。
    /// 由 TrayActions.ShowUpdateDialog 在专用 STA 线程上弹出（文本框复制走 OLE 剪贴板，MTA 下会抛异常）。
    internal class UpdateDialog : Form
    {
        public UpdateDialog(string title, string body, string releaseUrl)
        {
            Text = title;
            Font = SystemFonts.MessageBoxFont;
            FormBorderStyle = FormBorderStyle.FixedDialog;
            StartPosition = FormStartPosition.CenterScreen;
            MinimizeBox = false;
            MaximizeBox = false;
            ShowInTaskbar = true;
            ClientSize = new Size(560, 400);

            var box = new TextBox();
            box.Multiline = true;
            box.ReadOnly = true;
            box.AcceptsReturn = false; // 回车交给「立即更新」默认按钮
            box.WordWrap = true;
            box.ScrollBars = ScrollBars.Vertical;
            box.BorderStyle = BorderStyle.FixedSingle;
            box.BackColor = SystemColors.Window; // 只读文本框默认灰底，看着像禁用，改回白底但内容仍不可编辑
            box.ForeColor = SystemColors.WindowText;
            box.TabStop = false;
            box.SetBounds(14, 14, 532, 290);
            box.Text = body;
            Controls.Add(box);

            // 无链接（自建更新源等）时不摆无用控件，说明区已有全部信息
            if (!string.IsNullOrEmpty(releaseUrl))
            {
                var link = new LinkLabel();
                link.Text = "在浏览器打开发布页（完整说明）";
                link.AutoSize = true;
                link.Location = new Point(14, 312);
                string url = releaseUrl;
                link.LinkClicked += delegate { TrayActions.OpenUrl(url); };
                Controls.Add(link);
            }

            var hint = new Label();
            hint.Text = "点击「立即更新」自动下载并校验新版本，完成后网关与托盘自动重启，无需手动操作。";
            hint.AutoSize = false;
            hint.ForeColor = SystemColors.GrayText;
            hint.SetBounds(14, 336, 532, 18);
            Controls.Add(hint);

            var go = new Button();
            go.Text = "立即更新";
            go.DialogResult = DialogResult.OK;
            go.SetBounds(378, 362, 80, 26);

            var later = new Button();
            later.Text = "稍后";
            later.DialogResult = DialogResult.Cancel;
            later.SetBounds(466, 362, 80, 26);

            Controls.Add(go);
            Controls.Add(later);
            AcceptButton = go;
            CancelButton = later; // Esc = 稍后
        }
    }

    internal class TrayContext : ApplicationContext
    {
        private readonly NotifyIcon _icon;
        private readonly ContextMenuStrip _menu = new ContextMenuStrip();
        private readonly System.Windows.Forms.Timer _poll = new System.Windows.Forms.Timer();
        private bool _running;
        private int _port;

        public TrayContext()
        {
            _icon = new NotifyIcon
            {
                Icon = ExtractIcon(),
                Text = "ModelDock 网关未运行",
                Visible = true,
                ContextMenuStrip = _menu,
            };
            _icon.MouseClick += delegate(object sender, MouseEventArgs e)
            {
                if (e.Button == MouseButtons.Left) TrayActions.OpenConsole();
            };
            _menu.Opening += delegate(object sender, System.ComponentModel.CancelEventArgs e)
            {
                BuildMenu();
            };
            _poll.Interval = 5000;
            _poll.Tick += delegate { PollHealth(); };
            _poll.Start();
            PollHealth();
        }

        private static Icon ExtractIcon()
        {
            try { return Icon.ExtractAssociatedIcon(Application.ExecutablePath); }
            catch { return SystemIcons.Application; }
        }

        // ---------- 轮询（health 200 才算真活着；状态读取委托 TrayActions 单一实现） ----------

        private void PollHealth()
        {
            _running = TrayActions.HealthOk();
            if (_running) TrayActions.ReadState();
            _port = _running ? int.Parse(TrayActions.CurrentPort) : 0;
            try
            {
                _icon.Text = _running ? "ModelDock 网关运行中（端口 " + _port + "）" : "ModelDock 网关未运行";
            }
            catch { }
            if (_menu.Visible) BuildMenu();
        }

        // ---------- 菜单（每次展开重建，状态实时） ----------

        private void BuildMenu()
        {
            var menu = _menu.Items;
            menu.Clear();

            var status = new ToolStripMenuItem(_running ? "网关运行中 · 端口 " + _port : "网关未运行");
            status.Enabled = false;
            menu.Add(status);
            menu.Add(new ToolStripSeparator());

            var open = new ToolStripMenuItem("打开控制台");
            open.Click += delegate { TrayActions.OpenConsole(); };
            open.Enabled = _running;
            menu.Add(open);

            var web = new ToolStripMenuItem("在浏览器打开");
            web.Click += delegate { TrayActions.OpenWeb(); };
            web.Enabled = _running;
            menu.Add(web);

            var auto = new ToolStripMenuItem(TrayActions.AutostartOn() ? "开机自启 ✓" : "开机自启");
            auto.Click += delegate { TrayActions.ToggleAutostart(); };
            auto.Enabled = TrayActions.GatewayBinaryPath() != null;
            menu.Add(auto);

            var logs = new ToolStripMenuItem("在资源管理器中打开日志");
            logs.Click += delegate { TrayActions.RevealLogs(); };
            menu.Add(logs);

            // 清理数据：还原客户端 + 删配置/密钥/日志/同步状态（确认弹窗在动作里）
            var clean = new ToolStripMenuItem("清理数据…");
            clean.Click += delegate { TrayActions.CleanData(); };
            clean.Enabled = TrayActions.GatewayBinaryPath() != null;
            menu.Add(clean);

            // 检查更新：调主程序 CLI `update --check`；有新版弹窗直接给「立即更新」（就地升级，同控制台链路）
            var upd = new ToolStripMenuItem("检查更新…");
            upd.Click += delegate { TrayActions.CheckUpdate(); };
            upd.Enabled = TrayActions.GatewayBinaryPath() != null;
            menu.Add(upd);

            if (!_running)
            {
                var start = new ToolStripMenuItem("启动网关");
                start.Click += delegate { TrayActions.RunGatewayCli("--sea-gateway"); };
                start.Enabled = TrayActions.GatewayBinaryPath() != null;
                menu.Add(start);
            }
            menu.Add(new ToolStripSeparator());

            var quit = new ToolStripMenuItem(_running ? "退出（停止网关）" : "退出");
            quit.Click += delegate { QuitClicked(); };
            menu.Add(quit);
        }

        // ---------- 动作（薄壳：实现收敛在 TrayActions） ----------

        private void QuitClicked()
        {
            if (TrayActions.HealthOk()) TrayActions.RunGatewayCli("gateway stop");
            var t = new System.Windows.Forms.Timer { Interval = 400 };
            t.Tick += delegate { t.Stop(); _icon.Visible = false; Application.Exit(); };
            t.Start();
        }
    }
}
