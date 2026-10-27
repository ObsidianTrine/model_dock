// ModelDockTray — ModelDock Windows 托盘（右下角 NotifyIcon）
//
// 职责与 macOS 版对齐：常驻托盘图标；打开控制台（Chromium --app 独立窗口，与双击 app
// 同源）；在浏览器打开；快速操作区——切当前服务、切默认模型、接入/断开客户端、
// 客户端钉定路由，全部直调网关管理端点（admin 头 + x-modeldock-source: tray），控制台
// 仅在托盘按需打开；开机自启开关（复用主程序 CLI gateway install/uninstall）；
// 在资源管理器中打开日志；退出 = 停止网关 + 托盘退出。
//
// 编译：csc（.NET Framework 4.x 随 Windows 10/11 预装）——
//   csc /target:winexe /out:ModelDockTray.exe /win32manifest:ModelDockTray.manifest
//       /win32icon:modeldock.ico /r:System.Windows.Forms.dll /r:System.Drawing.dll
//       /r:System.Web.Extensions.dll ModelDockTray.cs ModelDockTray.Version.generated.cs
//   第二个文件由 scripts/build-sea.mjs 构建时生成（TrayMeta.Version 常量，git tag 版本号）；
//   手动重编译时缺它可自建同名常量，否则 TrayMeta.Version 引用编译不过。
// 语法限制：C# 5（无 $"" 插值、无 ?. ）——目标编译器是 Framework 自带的 v4.0.30319。

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Net;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace ModelDockTray
{
    static class Program
    {
        /// 双击安装后的快捷方式 = 运行本程序（GUI 子系统，无黑窗）：
        /// 首次运行 → 确保网关拉起 + 弹控制台 + 常驻托盘；托盘已在时 → 仅确保网关 + 再弹一次控制台。
        /// 程序拉起（守护补拉 / cli.ts launchGui，spawnTrayIfPresent 注入 MODELRDOCK_TRAY_AUTOSPAWN=1）
        /// 不是用户意图弹控制台：标记进程内一律不自动弹（见 OpenConsoleWhenAlive）——否则 setup.exe
        /// 装完「[Run] 托盘 → 守护 → 补拉托盘」链会把控制台弹两份（2026-10 v1.3.0 安装双窗口报障）。
        /// 主程序 modeldock.exe 是控制台子系统（SEA），直接双击会带黑窗——快捷方式一律指向本程序。
        /// 单实例互斥必须 static 持有：原先 GC.KeepAlive(mutex) 写在 Application.Run 之前，
        /// 进入消息循环后局部变量即成死引用，GC 一回收句柄即关、命名 Mutex 随之销毁——之后
        /// 每次双击都 Owned=true 再起真实例，托盘区多一个图标（2026-10 Windows 多图标报障）。
        private static Mutex _singleton;

        [STAThread]
        static void Main()
        {
            bool owned;
            _singleton = new Mutex(true, "Local\\ModelDockTray", out owned);
            if (!owned)
            {
                // 托盘已在：用户双击 → 把这次当作「打开控制台」；
                // 程序拉起（带 AUTOSPAWN 标记）→ OpenConsoleWhenAlive 内静默跳过
                EnsureGateway();
                OpenConsoleWhenAlive();
                return;
            }

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
        // Interlocked 保证两条并发路径只弹一个窗口；用户手点（托盘/菜单）直调 OpenConsole 不受此限。
        // 程序拉起标记（MODELRDOCK_TRAY_AUTOSPAWN=1，src/tray.ts spawnTrayIfPresent 注入）：本次不是
        // 用户双击，全进程不自动弹——标记只在进程内生效，跨进程的重复弹窗正靠它在源头上避免
        private static int _autoOpened;

        /// 程序拉起的托盘（守护补拉 / GUI 路径）不自动弹控制台：控制台由调用方（launchGui 自开）
        /// 或用户手点负责；开机自启补拉的真实例同样只常驻托盘、不弹窗
        private static readonly bool AutoSpawn =
            Environment.GetEnvironmentVariable("MODELRDOCK_TRAY_AUTOSPAWN") == "1";

        private static void OpenConsoleWhenAlive()
        {
            if (AutoSpawn) return;
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

    /// 双语文案：托盘是独立进程（不读网关 config.toml），语言来源 MODELRDOCK_LANG（daemon
    /// 拉起时继承，zh/en）> 系统 UI 语言（zh* → 中文，其余英文）；都取不到回退中文
    /// （与 src/config/lang.ts 缺省一致）。
    internal static class I18n
    {
        public static readonly bool Zh = DetectZh();

        private static bool DetectZh()
        {
            var env = Environment.GetEnvironmentVariable("MODELRDOCK_LANG");
            if (env == "zh") return true;
            if (env == "en") return false;
            try { return CultureInfo.CurrentUICulture.TwoLetterISOLanguageName == "zh"; }
            catch { return true; }
        }

        public static string L(string zh, string en) { return Zh ? zh : en; }
    }

    /// tray-state JSON 的解析辅助（JavaScriptSerializer 在 System.Web.Extensions，随 Framework 预装；
    /// 载荷是 overview 的瘦身投影（几 KB），嵌套数组用 TrayActions 里的正则解析吃不动）
    internal static class JsonMap
    {
        public static string Str(Dictionary<string, object> d, string k)
        {
            object v;
            return d.TryGetValue(k, out v) ? v as string : null;
        }

        public static bool Bool(Dictionary<string, object> d, string k)
        {
            object v;
            return d.TryGetValue(k, out v) && v is bool && (bool)v;
        }
    }

    /// 托盘状态（GET /_modeldock/tray-state，服务端 overview 的瘦身投影）
    internal class TrayStateData
    {
        public class Svc
        {
            public string Id, Label, DefaultModel;
            public bool InUse, Enabled, Down;
            public readonly List<string[]> Models = new List<string[]>(); // 每项 [id, display]
        }

        public class Cli
        {
            public string Id, Label, Mode, Route, PinnedProvider, Service;
            public bool Attached;
        }

        public bool TrayOnly = true;
        public string CurrentId, CurrentLabel, CurrentModel;
        public string AutoPin;
        public bool ScheduleApplied;
        public readonly List<Svc> Services = new List<Svc>();
        public readonly List<Cli> Clients = new List<Cli>();

        public static TrayStateData Parse(string json)
        {
            var root = new JavaScriptSerializer { MaxJsonLength = int.MaxValue }.DeserializeObject(json) as Dictionary<string, object>;
            if (root == null) return null;
            var st = new TrayStateData();
            object v;
            if (root.TryGetValue("trayOnly", out v)) st.TrayOnly = JsonMap.Bool(root, "trayOnly");
            if (root.TryGetValue("autoPin", out v)) st.AutoPin = v as string;
            if (root.TryGetValue("scheduleApplied", out v)) st.ScheduleApplied = JsonMap.Bool(root, "scheduleApplied");
            if (root.TryGetValue("current", out v))
            {
                var cur = v as Dictionary<string, object>;
                if (cur != null)
                {
                    st.CurrentId = JsonMap.Str(cur, "id");
                    st.CurrentLabel = JsonMap.Str(cur, "label");
                    st.CurrentModel = JsonMap.Str(cur, "model");
                }
            }
            object services;
            if (root.TryGetValue("services", out services))
            {
                var arr = services as object[];
                if (arr != null)
                    foreach (object o in arr)
                    {
                        var d = o as Dictionary<string, object>;
                        if (d == null) continue;
                        var s = new Svc();
                        s.Id = JsonMap.Str(d, "id");
                        s.Label = JsonMap.Str(d, "label");
                        s.DefaultModel = JsonMap.Str(d, "defaultModel");
                        s.InUse = JsonMap.Bool(d, "inUse");
                        s.Enabled = JsonMap.Bool(d, "enabled");
                        s.Down = JsonMap.Bool(d, "down");
                        object models;
                        if (d.TryGetValue("models", out models))
                        {
                            var ms = models as object[];
                            if (ms != null)
                                foreach (object mo in ms)
                                {
                                    var md = mo as Dictionary<string, object>;
                                    if (md == null) continue;
                                    s.Models.Add(new[] { JsonMap.Str(md, "id"), JsonMap.Str(md, "display") });
                                }
                        }
                        st.Services.Add(s);
                    }
            }
            object clients;
            if (root.TryGetValue("clients", out clients))
            {
                var arr = clients as object[];
                if (arr != null)
                    foreach (object o in arr)
                    {
                        var d = o as Dictionary<string, object>;
                        if (d == null) continue;
                        var c = new Cli();
                        c.Id = JsonMap.Str(d, "id");
                        c.Label = JsonMap.Str(d, "label");
                        c.Attached = JsonMap.Bool(d, "attached");
                        c.Mode = JsonMap.Str(d, "mode");
                        c.Route = JsonMap.Str(d, "route");
                        c.PinnedProvider = JsonMap.Str(d, "pinnedProvider");
                        c.Service = JsonMap.Str(d, "service");
                        st.Clients.Add(c);
                    }
            }
            return st;
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

        // ---------- 托盘状态（tray-state 轮询 + 管理端点直调，对齐 macOS 托盘） ----------

        /// 托盘状态缓存：后台线程写、UI 线程读（引用赋值原子；菜单只在 UI 线程构建，
        /// 故无需跨线程 Marshal——菜单在下次 Opening / 轮询 tick 用上新数据）
        public static TrayStateData State;

        /// 后台拉托盘状态（fire-and-forget）：5s 轮询与菜单展开时各拉一次；
        /// 服务端与控制台共享 6s 缓存，不抬高 overview 重建频率
        public static void FetchStateAsync()
        {
            ThreadPool.QueueUserWorkItem(delegate
            {
                if (!ReadState()) { State = null; return; }
                try
                {
                    State = TrayStateData.Parse(HttpGet("http://127.0.0.1:" + _port + "/_modeldock/tray-state", _token));
                }
                catch { State = null; }
            });
        }

        /// JSON 字符串转义（id/label 拼进请求体）
        internal static string JsonEscape(string v)
        {
            return v == null ? "" : v.Replace("\\", "\\\\").Replace("\"", "\\\"");
        }

        /// 直调网关管理端点（admin 头 + 来源标记 tray）：切服务/模型、接入断开、钉定、仅托盘开关统一出口。
        /// 成功返回 null；失败返回可展示消息（4xx 的 JSON 报错服务端文案本身可操作，原样透出）。
        /// attach/detach 要快照 + 重写客户端文件，超时放宽到 30s
        public static string PostAdmin(string path, string json)
        {
            if (!ReadState()) return I18n.L("网关未运行", "Gateway not running");
            try
            {
                var req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + _port + path);
                req.Timeout = 30000;
                req.Method = "POST";
                req.ContentType = "application/json";
                req.Headers["x-modeldock-admin"] = _token;
                req.Headers["x-modeldock-source"] = "tray";
                var body = System.Text.Encoding.UTF8.GetBytes(json);
                req.ContentLength = body.Length;
                using (var rs = req.GetRequestStream()) { rs.Write(body, 0, body.Length); }
                using (var resp = (HttpWebResponse)req.GetResponse())
                {
                    return (int)resp.StatusCode == 200 ? null : "HTTP " + (int)resp.StatusCode;
                }
            }
            catch (WebException ex)
            {
                try
                {
                    var resp = ex.Response as HttpWebResponse;
                    if (resp != null)
                        using (var sr = new StreamReader(resp.GetResponseStream(), System.Text.Encoding.UTF8))
                        {
                            var text = sr.ReadToEnd();
                            if (text.Length > 0) return text;
                        }
                }
                catch { }
                return ex.Message;
            }
            catch (Exception ex) { return ex.Message; }
        }

        /// 快捷动作统一收口（工作线程跑，不卡托盘消息循环）：成功后立即重拉状态
        /// （服务端动作已 bump reloads，下一次 tray-state 必是新状态），失败弹可操作报错
        public static void QuickAction(string path, string json)
        {
            ThreadPool.QueueUserWorkItem(delegate
            {
                var err = PostAdmin(path, json);
                if (err == null)
                {
                    if (ReadState())
                    {
                        try { State = TrayStateData.Parse(HttpGet("http://127.0.0.1:" + _port + "/_modeldock/tray-state", _token)); }
                        catch { }
                    }
                }
                else
                {
                    MessageBox.Show(I18n.L("操作失败：", "Action failed: ") + err, "ModelDock", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                }
            });
        }

        /// 检查更新（工作线程跑 CLI，不卡托盘）：CLI 无 TTY 输出纯文本（UTF-8），按内容弹窗；
        /// 有新版弹说明窗（正文 = CLI 输出：那边已去 markdown 标记 + 摘要收口）+ 可点发布页链接，
        /// 点「立即更新」即就地更新（与控制台一键升级同一条链路）；
        /// 失败（含未配置令牌）原样展示输出——本身就是可操作指引。
        private static bool _checkingUpdate = false;
        private static UpdateProgressForm _progressForm;
        // 更新子进程在途标志：进度文件尚未首写的短窗兜底（拉起后几秒内），长窗以磁盘进度为准（对齐 macOS 托盘）
        private static bool _updating = false;
        private static DateTime _updatingSince = DateTime.MinValue;

        public static bool CheckingUpdate { get { return _checkingUpdate; } }

        /// 检查更新入口：网关存活走网关缓存接口（控制台/托盘/网关三方同源，TTL 内不打 GitHub），
        /// 网关未运行退回 CLI 现查。点击后立刻弹「检查中」进度窗——此前静默等待最长 15s，
        /// 用户以为点击无效（v1.1.1 实测反馈）。检查期间菜单项置灰，这里再兜底防连点。
        public static void CheckUpdate()
        {
            if (_checkingUpdate) { ShowProgressForm(I18n.L("正在检查更新…", "Checking for updates…")); return; }
            if (GatewayBinaryPath() == null) return;
            _checkingUpdate = true;
            ShowProgressForm(I18n.L("正在检查更新…", "Checking for updates…"));
            if (ReadState())
            {
                ThreadPool.QueueUserWorkItem(delegate { CheckViaGateway(); });
            }
            else
            {
                ThreadPool.QueueUserWorkItem(delegate { CheckViaCli(); });
            }
        }

        private static void FinishCheck()
        {
            _checkingUpdate = false;
            CloseProgressForm();
        }

        /// 网关缓存路径：GET /admin/update/status 自带惰性检查（成功 24h TTL / 失败 30min 退避），
        /// checking=true 轮询至 false 取结果；HTTP 不通退回 CLI 现查
        private static void CheckViaGateway()
        {
            for (int attempt = 0; attempt < 60; attempt++)
            {
                string json;
                try { json = HttpGet("http://127.0.0.1:" + _port + "/_modeldock/admin/update/status", _token); }
                catch { CheckViaCli(); return; }
                if (!JsonBool(json, "checking"))
                {
                    FinishCheck();
                    ShowStatusResult(json);
                    return;
                }
                Thread.Sleep(500);
            }
            FinishCheck();
            MessageBox.Show(I18n.L("检查更新超过 30 秒仍未返回（网络异常？）。可稍后重试，或用命令行 modeldock update --check 查看。", "No result after 30 seconds (network issue?). Retry later, or run `modeldock update --check` for details."), I18n.L("ModelDock 检查更新超时", "ModelDock Update Check Timed Out"), MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }

        /// CLI 现查兜底：工作线程跑 CLI（不卡托盘），按输出弹窗；40s 看门狗防 CLI 真挂住后永久沉默
        private static void CheckViaCli()
        {
            var bin = GatewayBinaryPath();
            if (bin == null) { FinishCheck(); return; }
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
                FinishCheck();
                MessageBox.Show(UpToDateText(FirstVersion(text)), "ModelDock", MessageBoxButtons.OK, MessageBoxIcon.Information);
            }
            else if (exit == 0 && text.Contains("有新版本"))
            {
                string ver = FirstVersion(text);
                string title = NewVersionTitle(ver, CurrentVersion(text));
                DialogResult r = ShowUpdateDialog(title, text, LastUrl(text));
                FinishCheck();
                if (r == DialogResult.OK)
                {
                    if (StartUpdate()) ShowProgressForm(I18n.L("正在更新到 v", "Updating to v") + (ver.Length > 0 ? ver : ""));
                }
            }
            else
            {
                FinishCheck();
                MessageBox.Show(text.Length > 0 ? text : I18n.L("未知错误，请稍后重试。", "Unknown error; try again later."), I18n.L("ModelDock 检查更新失败", "ModelDock Update Check Failed"), MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
        }

        private static void ShowStatusResult(string json)
        {
            bool available = JsonBool(json, "available");
            string latest = JsonString(json, "latest");
            string lastError = JsonString(json, "lastError");
            string htmlUrl = JsonString(json, "htmlUrl");
            string notes = JsonUnescape(JsonString(json, "notes"));
            // summary = 服务端摘要收口（首段+要点，与命令行检查输出同形）；旧版网关没有该字段时回落全文
            string summary = JsonUnescape(JsonString(json, "summary"));
            if (available)
            {
                string title = NewVersionTitle(latest, JsonString(json, "current"));
                // 小窗只放摘要（全文塞进 560×400 会变成一面墙的长段落）；底部 hint Label 常驻说明，
                // 正文不再重复拼一遍（原先正文和 Label 各一份同文案）
                string body = string.IsNullOrEmpty(summary) ? (notes ?? "") : summary;
                DialogResult r = ShowUpdateDialog(title, body, htmlUrl);
                if (r == DialogResult.OK)
                {
                    if (StartUpdate()) ShowProgressForm(I18n.L("正在更新到 v", "Updating to v") + (latest ?? ""));
                }
                return;
            }
            if (string.IsNullOrEmpty(latest) && !string.IsNullOrEmpty(lastError))
            {
                // 从未成功检查到任何版本：按失败对待（GitHub 不可达等），错误原样展示
                MessageBox.Show(lastError, I18n.L("ModelDock 检查更新失败", "ModelDock Update Check Failed"), MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }
            MessageBox.Show(UpToDateText(JsonString(json, "current")), "ModelDock", MessageBoxButtons.OK, MessageBoxIcon.Information);
        }

        private static string HttpGet(string url, string token)
        {
            var req = (HttpWebRequest)WebRequest.Create(url);
            req.Timeout = 5000;
            req.Method = "GET";
            if (!string.IsNullOrEmpty(token)) req.Headers["x-modeldock-admin"] = token;
            using (var resp = (HttpWebResponse)req.GetResponse())
            using (var sr = new StreamReader(resp.GetResponseStream(), System.Text.Encoding.UTF8))
            {
                return sr.ReadToEnd();
            }
        }

        private static bool JsonBool(string json, string field)
        {
            return Regex.IsMatch(json, "\"" + field + "\"\\s*:\\s*true");
        }

        internal static string JsonString(string json, string field)
        {
            var m = Regex.Match(json, "\"" + field + "\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)\"");
            if (!m.Success) return null;
            return JsonUnescape(m.Groups[1].Value);
        }

        internal static string JsonUnescape(string v)
        {
            if (v == null) return null;
            return v.Replace("\\\\", "\u0001").Replace("\\n", "\n").Replace("\\r", "\r").Replace("\\t", "\t").Replace("\\/", "/").Replace("\\\"", "\"").Replace("\u0001", "\\\\");
        }

        internal static long JsonLong(string json, string field)
        {
            var m = Regex.Match(json, "\"" + field + "\"\\s*:\\s*(-?[0-9]+)");
            long v;
            return (m.Success && long.TryParse(m.Groups[1].Value, out v)) ? v : 0;
        }

        /// 更新是否在途（对齐 macOS 托盘口径）：磁盘进度为准（update --yes 子进程写的进度，
        /// 10 分钟未刷新按上次残留过期）；内存标志只兜进度文件尚未首写的短窗。
        /// done/failed 一律视为已收尾，即使进度小窗没开着。
        public static bool UpdateInFlight()
        {
            if (_updating && (DateTime.UtcNow - _updatingSince).TotalSeconds < 60) return true;
            try
            {
                var file = Home() + "\\update-progress.json";
                if (!File.Exists(file)) return false;
                var text = File.ReadAllText(file);
                var stage = JsonString(text, "stage");
                if (stage == null || stage == "done" || stage == "failed") return false;
                var at = JsonLong(text, "at");
                if (at > 0)
                {
                    long epochMs = (long)(DateTime.UtcNow - new DateTime(1970, 1, 1)).TotalMilliseconds;
                    if (epochMs - at > 10 * 60 * 1000) return false; // 残留过期
                }
                return true;
            }
            catch { return false; }
        }

        /// 就地更新：分离跑 `modeldock update --yes`（弹窗里的「立即更新」即用户确认）。
        /// 不重定向输出——更新流程会停掉托盘自身（换包后由新版拉起），托盘死了日志也写不成；
        /// 失败原因更新后可在控制台或命令行复查。
        /// 返回是否真正拉起：在途更新被拒绝时返回 false，调用方不再弹进度窗（对齐 macOS 托盘）。
        public static bool StartUpdate()
        {
            if (UpdateInFlight())
            {
                MessageBox.Show(I18n.L("上一个更新流程尚未完成，请等它结束（或查看进度小窗）后再试。", "A previous update is still running; wait for it to finish (or check the progress window) and try again."), I18n.L("更新正在进行中", "Update in Progress"), MessageBoxButtons.OK, MessageBoxIcon.Information);
                return false;
            }
            var bin = GatewayBinaryPath();
            if (bin == null) return false;
            _updating = true;
            _updatingSince = DateTime.UtcNow;
            try
            {
                Process.Start(new ProcessStartInfo
                {
                    FileName = bin,
                    Arguments = "update --yes",
                    UseShellExecute = false,
                    CreateNoWindow = true,
                });
                return true;
            }
            catch
            {
                _updating = false; // 拉起失败：放开防重入，否则这一轮托盘永远点不动更新
                return false;
            }
        }

        /// 进度小窗（自有 STA 线程 + 消息循环，跨线程 Close 走 BeginInvoke）：
        /// 每秒自轮询 update-progress.json 刷新阶段与百分比；替换段托盘被更新流程停掉，窗随之消失属预期
        public static void ShowProgressForm(string title)
        {
            if (_progressForm != null && !_progressForm.IsDisposed) { _progressForm.BringToFront(); return; }
            _progressForm = new UpdateProgressForm(title);
            var t = new Thread(delegate() { Application.Run(_progressForm); });
            t.SetApartmentState(ApartmentState.STA);
            t.IsBackground = true;
            t.Start();
        }

        public static void CloseProgressForm()
        {
            var f = _progressForm;
            _progressForm = null;
            if (f != null && !f.IsDisposed)
            {
                try { f.BeginInvoke(new Action(delegate { f.Close(); })); } catch { }
            }
        }

        /// 清理数据：确认弹窗后分离跑 `modeldock reset --yes --deep`（清理逻辑全在 CLI，
        /// 托盘只做确认与结果展示）。清理含停网关，无法同步等子进程输出，故提示后异步收尾报告。
        public static void CleanData()
        {
            if (MessageBox.Show(
                    I18n.L("还原被接管的客户端，然后删除 ModelDock 保存的全部数据：\r\n配置与密钥、请求日志、同步状态与本机缓存。\r\n\r\n快照保留（可 modeldock restore 回溯）。清理后需重新运行 modeldock init 配置。", "Restore taken-over clients, then delete all data ModelDock has saved:\r\nconfig & keys, request logs, sync state and local cache.\r\n\r\nSnapshots are kept (recoverable via `modeldock restore`). Run `modeldock init` to set up again."),
                    I18n.L("清理数据？", "Reset Data?"), MessageBoxButtons.OKCancel, MessageBoxIcon.Warning) != DialogResult.OK)
                return;
            if (!StartCleanCli())
            {
                MessageBox.Show(I18n.L("无法启动清理程序，请改用命令行：modeldock reset --deep", "Failed to launch the reset process; run `modeldock reset --deep` instead."), "ModelDock " + I18n.L("清理数据", "Reset Data"), MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }
            MessageBox.Show(I18n.L("正在清理：会先还原被接管的客户端，再删除配置、密钥与日志，完成后自动提示。", "Resetting: taken-over clients are restored first, then config, keys and logs are deleted; you will be notified when done."), "ModelDock " + I18n.L("清理数据", "Reset Data"), MessageBoxButtons.OK, MessageBoxIcon.Information);
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
                        : (exit == 0
                            ? I18n.L("数据已清理。重新配置请运行 modeldock init。", "Data reset. Run `modeldock init` to set up again.")
                            : I18n.L("清理未完成，请改用命令行：modeldock reset --deep", "Reset incomplete; run `modeldock reset --deep` to see the error."));
                    MessageBox.Show(body, "ModelDock " + I18n.L("清理数据", "Reset Data"), MessageBoxButtons.OK,
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
                    MessageBox.Show(I18n.L("无法显示更新说明（", "Cannot show the release notes (") + ex.Message + I18n.L("）。可改用命令行 modeldock update --check 查看。", "). Run `modeldock update --check` for details instead."), "ModelDock", MessageBoxButtons.OK, MessageBoxIcon.Warning);
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

        /// 从 CLI 输出取「当前 vX.Y.Z」括注里的版本（「有新版本：v1.2.2（当前 v1.2.1）」）；
        /// 「已是最新版本（v1.2.3）」没有该括注，当前版本直接用 FirstVersion 取（全文唯一版本号）
        private static string CurrentVersion(string text)
        {
            var m = Regex.Match(text, @"当前 v([0-9]+\.[0-9]+\.[0-9]+)");
            return m.Success ? m.Groups[1].Value : "";
        }

        /// 「已是最新版本 vX.Y.Z。」：当前版本取得到就带上（CLI 输出 / 网关 status 自带），取不到回落旧文案
        private static string UpToDateText(string current)
        {
            return string.IsNullOrEmpty(current)
                ? I18n.L("已是最新版本。", "Already up to date.")
                : I18n.L("已是最新版本 v" + current + "。", "Already up to date (v" + current + ").");
        }

        /// 「ModelDock 有新版本 vX（当前 vY）」标题：当前版本取得到才带括注
        private static string NewVersionTitle(string latest, string current)
        {
            string title = string.IsNullOrEmpty(latest)
                ? I18n.L("ModelDock 有新版本", "ModelDock update available")
                : I18n.L("ModelDock 有新版本 v" + latest, "ModelDock update available: v" + latest);
            return string.IsNullOrEmpty(current) ? title : title + I18n.L("（当前 v" + current + "）", " (current v" + current + ")");
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
            // 按 DPI 缩放：控件坐标都按 96dpi 设计，配 manifest 的 PerMonitorV2
            // 在 125%/150% 缩放的 Win11 上不再整体位图拉伸发糊
            AutoScaleDimensions = new SizeF(96F, 96F);
            AutoScaleMode = AutoScaleMode.Dpi;
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
                link.Text = I18n.L("在浏览器打开发布页（完整说明）", "Open the release page in browser (full notes)");
                link.AutoSize = true;
                link.Location = new Point(14, 312);
                string url = releaseUrl;
                link.LinkClicked += delegate { TrayActions.OpenUrl(url); };
                Controls.Add(link);
            }

            var hint = new Label();
            hint.Text = I18n.L("点击「立即更新」自动下载并校验新版本，完成后网关与托盘自动重启，无需手动操作。", "Click \"Update Now\" to download and verify the new version automatically; the gateway and tray will restart when done.");
            hint.AutoSize = false;
            hint.ForeColor = SystemColors.GrayText;
            hint.SetBounds(14, 336, 532, 18);
            Controls.Add(hint);

            var go = new Button();
            go.Text = I18n.L("立即更新", "Update Now");
            go.DialogResult = DialogResult.OK;
            go.SetBounds(378, 362, 80, 26);

            var later = new Button();
            later.Text = I18n.L("稍后", "Later");
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
                Text = I18n.L("ModelDock 网关未运行", "ModelDock gateway not running"),
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
                if (_running) TrayActions.FetchStateAsync(); // 展开时顺带刷新，下次打开更新鲜
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
                _icon.Text = _running
                    ? I18n.L("ModelDock 网关运行中（端口 " + _port + "）", "ModelDock gateway running (port " + _port + ")")
                    : I18n.L("ModelDock 网关未运行", "ModelDock gateway not running");
            }
            catch { }
            if (_running) TrayActions.FetchStateAsync();
            if (_menu.Visible) BuildMenu();
        }

        // ---------- 菜单（每次展开重建，状态实时） ----------

        private void BuildMenu()
        {
            var menu = _menu.Items;
            menu.Clear();

            // 版本首项（置灰不可点）：随时可见当前版本，不必专门点「检查更新」
            var verItem = new ToolStripMenuItem("ModelDock v" + TrayMeta.Version);
            verItem.Enabled = false;
            menu.Add(verItem);

            var status = new ToolStripMenuItem(_running
                ? I18n.L("网关运行中 · 端口 " + _port, "Gateway running · port " + _port)
                : I18n.L("网关未运行", "Gateway not running"));
            status.Enabled = false;
            menu.Add(status);

            // 当前生效路由（灰字）：钉定/定时窗口/默认选路后的「正在使用」，与控制台「当前」同口径
            TrayStateData st = _running ? TrayActions.State : null;
            if (st != null && st.CurrentId != null && st.CurrentLabel != null)
            {
                string line = I18n.L("当前：", "Current: ") + st.CurrentLabel;
                if (!string.IsNullOrEmpty(st.CurrentModel)) line += " · " + st.CurrentModel;
                if (st.ScheduleApplied) line += I18n.L("（定时窗口）", " (schedule)");
                var cur = new ToolStripMenuItem(line);
                cur.Enabled = false;
                menu.Add(cur);
            }
            menu.Add(new ToolStripSeparator());

            var open = new ToolStripMenuItem(I18n.L("打开控制台", "Open Console"));
            open.Click += delegate { TrayActions.OpenConsole(); };
            open.Enabled = _running;
            menu.Add(open);

            var web = new ToolStripMenuItem(I18n.L("在浏览器打开", "Open in Browser"));
            web.Click += delegate { TrayActions.OpenWeb(); };
            web.Enabled = _running;
            menu.Add(web);

            // ---- 快速操作区（常开，不再受任何开关门控）：切服务 / 切默认模型 / 接入断开客户端 ----
            if (st != null && st.CurrentId != null)
            {
                BuildQuickSection(menu, st);
                menu.Add(new ToolStripSeparator());
            }

            var auto = new ToolStripMenuItem(TrayActions.AutostartOn() ? I18n.L("开机自启 ✓", "Start at Login ✓") : I18n.L("开机自启", "Start at Login"));
            auto.Click += delegate { TrayActions.ToggleAutostart(); };
            auto.Enabled = TrayActions.GatewayBinaryPath() != null;
            menu.Add(auto);

            var logs = new ToolStripMenuItem(I18n.L("在资源管理器中打开日志", "Reveal Logs in Explorer"));
            logs.Click += delegate { TrayActions.RevealLogs(); };
            menu.Add(logs);

            // 清理数据：还原客户端 + 删配置/密钥/日志/同步状态（确认弹窗在动作里）
            var clean = new ToolStripMenuItem(I18n.L("清理数据…", "Reset Data…"));
            clean.Click += delegate { TrayActions.CleanData(); };
            clean.Enabled = TrayActions.GatewayBinaryPath() != null;
            menu.Add(clean);

            // 检查更新：网关存活走网关缓存接口（三方同源，TTL 内不打 GitHub），未运行退回 CLI 现查；
            // 检查/更新进行中置灰防连点——更新中再拉起会与在途更新互踩安装（对齐 macOS 托盘口径）
            var updBusy = TrayActions.CheckingUpdate || TrayActions.UpdateInFlight();
            var upd = new ToolStripMenuItem(TrayActions.CheckingUpdate ? I18n.L("检查中…", "Checking…") : (updBusy ? I18n.L("更新中…", "Updating…") : I18n.L("检查更新…", "Check for Updates…")));
            upd.Click += delegate { TrayActions.CheckUpdate(); };
            upd.Enabled = !updBusy && TrayActions.GatewayBinaryPath() != null;
            menu.Add(upd);

            if (!_running)
            {
                var start = new ToolStripMenuItem(I18n.L("启动网关", "Start Gateway"));
                start.Click += delegate { TrayActions.RunGatewayCli("--sea-gateway"); };
                start.Enabled = TrayActions.GatewayBinaryPath() != null;
                menu.Add(start);
            }

            // 仅托盘模式：勾选 = 当前没有任何 Web UI 打开（派生态，服务端按页面在场心跳实时求值）。
            // 点击 = 广播关闭请求（已开页面自关，浏览器拦截时页面显示手动关闭提示）；已勾选时点击无操作。
            // 网关未运行时无从读写状态故不显示
            if (st != null)
            {
                var lite = new ToolStripMenuItem(I18n.L("仅托盘模式", "Tray-Only Mode"));
                lite.Checked = st.TrayOnly;
                lite.Click += delegate
                {
                    if (st.TrayOnly) return; // 已在仅托盘态：点击无操作
                    TrayActions.QuickAction("/_modeldock/tray-only", "{}");
                };
                menu.Add(lite);
            }
            menu.Add(new ToolStripSeparator());

            var quit = new ToolStripMenuItem(_running ? I18n.L("退出（停止网关）", "Quit (Stop Gateway)") : I18n.L("退出", "Quit"));
            quit.Click += delegate { QuitClicked(); };
            menu.Add(quit);
        }

        /// 快速操作区：当前服务（整包切换 + 自动选路）、默认模型（当前服务目录）、客户端接入（接入/断开 + 指向）
        private void BuildQuickSection(ToolStripItemCollection menu, TrayStateData st)
        {
            var svcItem = new ToolStripMenuItem(I18n.L("当前服务", "Current Service"));
            var auto = (ToolStripMenuItem)svcItem.DropDownItems.Add(I18n.L("自动选路（跟随程序选择）", "Auto (follow program choice)"));
            auto.Checked = st.AutoPin == null;
            auto.Click += delegate { TrayActions.QuickAction("/_modeldock/auto-route", "{\"provider\":null}"); };
            svcItem.DropDownItems.Add(new ToolStripSeparator());
            foreach (var s in st.Services)
            {
                string title = s.Label + (s.Down ? I18n.L("（不可用）", " (unreachable)") : "");
                var it = (ToolStripMenuItem)svcItem.DropDownItems.Add(title);
                it.Checked = (st.AutoPin ?? st.CurrentId) == s.Id;
                it.Enabled = s.Enabled && !s.Down;
                string sid = s.Id;
                it.Click += delegate { TrayActions.QuickAction("/_modeldock/switch", "{\"service\":\"" + TrayActions.JsonEscape(sid) + "\"}"); };
            }
            menu.Add(svcItem);

            // 默认模型：当前生效服务的模型目录（目录为空不显示）；点击写该服务路由 profile 的 default_model
            var cur = st.Services.Find(x => x.Id == st.CurrentId);
            if (cur != null && cur.Models.Count > 0)
            {
                var mItem = new ToolStripMenuItem(I18n.L("默认模型", "Default Model"));
                foreach (var pair in cur.Models)
                {
                    string title = string.IsNullOrEmpty(pair[1]) ? pair[0] : pair[1];
                    var it = (ToolStripMenuItem)mItem.DropDownItems.Add(title);
                    it.Checked = cur.DefaultModel == pair[0];
                    string pid = cur.Id, mid = pair[0];
                    it.Click += delegate { TrayActions.QuickAction("/_modeldock/service/update", "{\"provider\":\"" + TrayActions.JsonEscape(pid) + "\",\"default_model\":\"" + TrayActions.JsonEscape(mid) + "\"}"); };
                }
                menu.Add(mItem);
            }

            var cliItem = new ToolStripMenuItem(I18n.L("客户端接入", "Clients"));
            if (st.Clients.Count == 0)
            {
                var none = (ToolStripMenuItem)cliItem.DropDownItems.Add(I18n.L("没有已安装的客户端", "No installed clients"));
                none.Enabled = false;
            }
            else
            {
                foreach (var c in st.Clients)
                {
                    var parent = new ToolStripMenuItem(c.Label);
                    string cid = c.Id, clabel = c.Label ?? c.Id;
                    bool attached = c.Attached;
                    var toggle = (ToolStripMenuItem)parent.DropDownItems.Add(attached ? I18n.L("断开并还原…", "Detach & Restore…") : I18n.L("接入", "Attach"));
                    toggle.Click += delegate { ToggleClient(cid, clabel, attached); };
                    if (attached && c.Mode == "gateway")
                    {
                        parent.DropDownItems.Add(new ToolStripSeparator());
                        var follow = (ToolStripMenuItem)parent.DropDownItems.Add(I18n.L("跟随当前服务", "Follow current service"));
                        follow.Checked = string.IsNullOrEmpty(c.Route) || c.Route == "default";
                        follow.Click += delegate { TrayActions.QuickAction("/_modeldock/harness/route", "{\"harness\":\"" + TrayActions.JsonEscape(cid) + "\",\"default\":true}"); };
                        foreach (var s in st.Services)
                        {
                            if (!s.Enabled || s.Down) continue;
                            var pin = (ToolStripMenuItem)parent.DropDownItems.Add(I18n.L("钉到 ", "Pin to ") + s.Label);
                            pin.Checked = c.PinnedProvider == s.Id;
                            string sid = s.Id;
                            pin.Click += delegate { TrayActions.QuickAction("/_modeldock/harness/route", "{\"harness\":\"" + TrayActions.JsonEscape(cid) + "\",\"provider\":\"" + TrayActions.JsonEscape(sid) + "\"}"); };
                        }
                    }
                    cliItem.DropDownItems.Add(parent);
                }
            }
            menu.Add(cliItem);
        }

        /// 接入/断开客户端（断开会还原配置——自动快照、可重接，托盘误点代价高，确认一次）
        private void ToggleClient(string id, string label, bool attached)
        {
            if (!attached)
            {
                TrayActions.QuickAction("/_modeldock/attach/apply", "{\"harness\":\"" + TrayActions.JsonEscape(id) + "\"}");
                return;
            }
            if (MessageBox.Show(
                    I18n.L("该客户端的配置会还原到本次接入前（自动快照），需要时可重新接入。", "The client's config will be restored to its pre-attach state (auto snapshot); attach again anytime."),
                    I18n.L("断开 ", "Detach ") + label + I18n.L("？", "?"),
                    MessageBoxButtons.OKCancel, MessageBoxIcon.Question) != DialogResult.OK)
                return;
            TrayActions.QuickAction("/_modeldock/detach", "{\"harness\":\"" + TrayActions.JsonEscape(id) + "\"}");
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

    /// 更新进度小窗：自有 STA 线程消息循环（ShowProgressForm/CloseProgressForm 跨线程驱动），
    /// 每秒自轮询 update-progress.json 刷新阶段与百分比——进度文件由 `modeldock update --yes`
    /// 子进程写入（src/update/progress.ts）；替换段托盘被更新流程停掉，窗随之消失属预期（新版自动拉起）。
    public class UpdateProgressForm : Form
    {
        private readonly Label _label = new Label();
        private readonly ProgressBar _bar = new ProgressBar();
        private readonly System.Windows.Forms.Timer _timer = new System.Windows.Forms.Timer();
        private readonly string _file;

        public UpdateProgressForm(string title)
        {
            Text = title;
            Font = SystemFonts.MessageBoxFont;
            // 按 DPI 缩放：控件坐标都按 96dpi 设计，配 manifest 的 PerMonitorV2 高分屏不发糊
            AutoScaleDimensions = new SizeF(96F, 96F);
            AutoScaleMode = AutoScaleMode.Dpi;
            Width = 440;
            Height = 140;
            FormBorderStyle = FormBorderStyle.FixedDialog;
            StartPosition = FormStartPosition.CenterScreen;
            MaximizeBox = false;
            ShowInTaskbar = false;
            _label.SetBounds(16, 14, 400, 40);
            _bar.SetBounds(16, 60, 400, 22);
            _label.Text = I18n.L("正在准备更新…", "Preparing update…");
            Controls.Add(_label);
            Controls.Add(_bar);
            _bar.Style = ProgressBarStyle.Marquee;
            _bar.MarqueeAnimationSpeed = 30;
            _file = TrayActions.Home() + "\\update-progress.json";
            _timer.Interval = 1000;
            _timer.Tick += delegate { Poll(); };
            _timer.Start();
        }

        private void Poll()
        {
            try
            {
                if (!File.Exists(_file)) return;
                string text = File.ReadAllText(_file);
                string stage = TrayActions.JsonString(text, "stage");
                if (stage == null) return;
                var at = Regex.Match(text, "\"at\"\\s*:\\s*(\\d+)");
                if (at.Success)
                {
                    // 残留过期（10 分钟未更新）：上次更新留下的进度文件，不再展示
                    double age = (DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds - double.Parse(at.Groups[1].Value);
                    if (age > 10 * 60 * 1000) { _timer.Stop(); Close(); return; }
                }
                if (stage == "failed")
                {
                    _timer.Stop();
                    string err = TrayActions.JsonUnescape(TrayActions.JsonString(text, "error"));
                    MessageBox.Show(string.IsNullOrEmpty(err) ? I18n.L("更新失败，可重试 modeldock update。", "Update failed; retry with `modeldock update`.") : err, I18n.L("ModelDock 更新失败", "ModelDock Update Failed"), MessageBoxButtons.OK, MessageBoxIcon.Warning);
                    Close();
                    return;
                }
                var recv = Regex.Match(text, "\"received\"\\s*:\\s*([0-9.]+)");
                var tot = Regex.Match(text, "\"total\"\\s*:\\s*([0-9.]+)");
                var pct = Regex.Match(text, "\"percent\"\\s*:\\s*(\\d+)");
                double received = recv.Success ? double.Parse(recv.Groups[1].Value) : 0;
                double total = tot.Success ? double.Parse(tot.Groups[1].Value) : 0;
                int percent = pct.Success ? int.Parse(pct.Groups[1].Value) : 0;
                if (stage == "done")
                {
                    _timer.Stop();
                    _bar.Style = ProgressBarStyle.Continuous;
                    _bar.Value = 100;
                    _label.Text = I18n.L("更新完成。网关与托盘将自动重启。", "Update finished. The gateway and tray will restart automatically.");
                    return;
                }
                string name = StageName(stage);
                string mb = total > 0 ? I18n.L("（", " (") + (received / 1048576).ToString("F1") + " / " + (total / 1048576).ToString("F1") + " MB" + I18n.L("）", ")") : "";
                _label.Text = name + (stage == "downloading" && total > 0 ? " " + percent + "%" + mb : "");
                if (total > 0)
                {
                    _bar.Style = ProgressBarStyle.Continuous;
                    _bar.Minimum = 0;
                    _bar.Maximum = 100;
                    _bar.Value = Math.Max(0, Math.Min(100, percent));
                }
                else
                {
                    _bar.Style = ProgressBarStyle.Marquee;
                    _bar.MarqueeAnimationSpeed = 30;
                }
            }
            catch { }
        }

        private static string StageName(string stage)
        {
            if (stage == "downloading") return I18n.L("下载中", "Downloading");
            if (stage == "verifying") return I18n.L("校验安装包", "Verifying package");
            if (stage == "swapping") return I18n.L("停止网关并替换安装", "Stopping gateway and swapping install");
            if (stage == "restarting") return I18n.L("重启服务", "Restarting service");
            if (stage == "done") return I18n.L("更新完成", "Update finished");
            return stage;
        }
    }
}
