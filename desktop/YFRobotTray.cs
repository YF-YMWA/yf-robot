// YF-Robot 桌面启动器（C# 5，系统自带 csc 编译，无第三方依赖）
//
// 结构：
//   · Program        —— 入口、单实例、预览/截图模式、静态入口
//   · TrayContext    —— 托盘、服务启停/守护、备份恢复、自启
//   · LauncherBridge —— 暴露给网页界面的桥（GetState / Act / Window）
//   · MainForm       —— 无边框窗口，界面本体是 desktop/ui 下的单页应用
//   · ConsoleWindow  —— 控制台 / 聊天的独立原生窗口（WebView2）
//
// 界面不再手摆 WinForms 控件：HTML/CSS 负责观感，C# 只做宿主与动作。
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.IO.Compression;
using System.Management;
using System.Net;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Win32;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace YFRobot
{
    static class Program
    {
        public const string AppName = "YF-Robot";
        public static string Root;
        public static string LogFile;
        public static string BaseUrl = "http://127.0.0.1:8899";
        public static Icon AppIcon;

        /// <summary>系统 DPI 缩放比（150% 就 1.5）。界面按这个放大，文字才是原生物理像素。</summary>
        public static float DpiScale = 1f;

        [DllImport("user32.dll")]
        static extern bool SetProcessDPIAware();
        [DllImport("user32.dll")]
        static extern IntPtr GetDC(IntPtr hWnd);
        [DllImport("user32.dll")]
        static extern int ReleaseDC(IntPtr hWnd, IntPtr hDC);
        [DllImport("gdi32.dll")]
        static extern int GetDeviceCaps(IntPtr hdc, int index);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern bool SetDllDirectory(string path);

        /// <summary>
        /// exe 在根目录，WebView2 的托管 DLL / 原生 loader 仍在 desktop\lib。
        /// 装一个程序集解析器 + 原生 DLL 搜索目录，根目录就不必摆一堆 DLL。
        /// </summary>
        static void EnableDesktopLib()
        {
            try
            {
                var lib = Path.Combine(Root, "desktop", "lib");
                if (!Directory.Exists(lib)) return;

                AppDomain.CurrentDomain.AssemblyResolve += delegate(object sender, ResolveEventArgs e)
                {
                    try
                    {
                        var simple = new AssemblyName(e.Name).Name;
                        var file = Path.Combine(lib, simple + ".dll");
                        if (File.Exists(file))
                        {
                            // 用字节加载而不是 LoadFrom：解压来的 DLL 带 MOTW，
                            // LoadFrom 会以「远程程序集」为由拒绝（0x80131515）
                            return Assembly.Load(File.ReadAllBytes(file));
                        }
                    }
                    catch (Exception ex) { Log("加载 WebView2 组件失败：" + ex.Message); }
                    return null;
                };

                SetDllDirectory(lib);
            }
            catch { }
        }

        /// <summary>
        /// 声明进程为系统 DPI 感知。
        ///
        /// 不声明的话 Windows 会把整个窗口（含 WebView2）当位图放大，
        /// 150% 缩放下字全是糊的；声明后按物理像素渲染，再自己按比例放大尺寸。
        /// </summary>
        static void EnableDpiAwareness()
        {
            try { SetProcessDPIAware(); } catch { }
            try
            {
                var hdc = GetDC(IntPtr.Zero);
                var dpi = GetDeviceCaps(hdc, 88); // LOGPIXELSX
                ReleaseDC(IntPtr.Zero, hdc);
                if (dpi > 0) DpiScale = Math.Max(1f, dpi / 96f);
            }
            catch { }
        }

        /// <summary>把 96 DPI 下的设计尺寸换算成当前 DPI 的物理像素。</summary>
        public static int Scale(int px)
        {
            return (int)Math.Round(px * DpiScale);
        }

        /// <summary>当前启动器窗口（托盘回调要用）。</summary>
        public static MainForm MainForm;

        /// <summary>托盘上下文；静默模式下按需创建启动器窗口时要用。</summary>
        public static TrayContext Context;

        /// <summary>预览模式：不建托盘、不拉起服务，用来调界面。</summary>
        public static bool PreviewMode;
        /// <summary>--shot=路径：界面载入后截图并退出。</summary>
        public static string ShotPath;
        /// <summary>--page=plugins：预览时直接打开某一页（自检用）。</summary>
        public static string StartPage;

        static readonly object LogLock = new object();

        [STAThread]
        static void Main(string[] args)
        {
            EnableDpiAwareness();

            bool silent = false;
            foreach (var a in args)
            {
                if (string.Equals(a, "--silent", StringComparison.OrdinalIgnoreCase)) silent = true;
                else if (string.Equals(a, "--preview", StringComparison.OrdinalIgnoreCase)) PreviewMode = true;
                else if (a.StartsWith("--shot=", StringComparison.OrdinalIgnoreCase)) ShotPath = a.Substring(7).Trim('"');
                else if (a.StartsWith("--page=", StringComparison.OrdinalIgnoreCase)) StartPage = a.Substring(7).Trim().ToLowerInvariant();
            }
            if (!string.IsNullOrEmpty(ShotPath)) PreviewMode = true;

            Root = FindRoot();
            if (Root == null)
            {
                MessageBox.Show("找不到程序目录（config.json 所在文件夹）。", AppName);
                return;
            }
            LogFile = Path.Combine(Root, "data", "tray.log");
            EnableDesktopLib();
            AppIcon = LoadAppIcon();

            // 预览用独立的 WebView2 数据目录：正常启动的实例正占着 data/webview2，
            // 同一个目录不能被两个进程同时使用。
            var udf = Path.Combine(Root, "data", PreviewMode ? "webview2-preview" : "webview2");
            try { Directory.CreateDirectory(udf); } catch { }
            Environment.SetEnvironmentVariable("WEBVIEW2_USER_DATA_FOLDER", udf);

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            // 预览模式不抢单实例锁、不碰服务，可以随时和正式实例并存
            if (PreviewMode)
            {
                Log("预览模式启动" + (string.IsNullOrEmpty(ShotPath) ? "" : "（截图）"));
                var previewCtx = new TrayContext(true, true);
                var previewForm = new MainForm(previewCtx);
                MainForm = previewForm;
                Application.Run(previewForm);
                return;
            }

            bool created;
            using (var mutex = new Mutex(true, "YF-Robot-Tray-Exe", out created))
            {
                if (!created)
                {
                    // 已有实例：把它叫出来，而不是「双击没反应」
                    try
                    {
                        using (var ev = EventWaitHandle.OpenExisting("YF-Robot-Show"))
                            ev.Set();
                    }
                    catch { }
                    return;
                }

                var ctx = new TrayContext(silent);
                Context = ctx;

                // 第二次双击 / 开始菜单再次启动：把已有窗口调出来（而不是再开一个进程）
                var showEvent = new EventWaitHandle(false, EventResetMode.AutoReset, "YF-Robot-Show");
                var listener = new Thread(delegate()
                {
                    while (true)
                    {
                        showEvent.WaitOne();
                        ShowLauncher();
                    }
                });
                listener.IsBackground = true;
                listener.Start();

                if (silent)
                {
                    Log("静默启动完成（只驻留托盘）");
                    Application.Run(ctx);
                    return;
                }

                try
                {
                    Log("启动器窗口已打开");
                    var form = new MainForm(ctx);
                    MainForm = form;
                    Application.Run(form);
                }
                catch (Exception ex)
                {
                    Log("界面初始化失败：" + ex);
                    MessageBox.Show("界面初始化失败：" + ex.Message, AppName);
                    Application.Run(ctx);
                }
            }
        }

        /// <summary>把启动器窗口调出来；静默模式下第一次调用时才创建窗口。</summary>
        public static void ShowLauncher()
        {
            var ctx = Context;
            if (ctx == null) return;

            ctx.OnUi(delegate()
            {
                var f = MainForm;
                if (f == null || f.IsDisposed)
                {
                    try
                    {
                        Log("按需打开启动器窗口");
                        f = new MainForm(ctx);
                        MainForm = f;
                        f.Show();
                    }
                    catch (Exception ex)
                    {
                        Log("打开启动器失败：" + ex.Message);
                        return;
                    }
                }
                f.ShowFromTray();
            });
        }

        /// <summary>打开控制台 / 聊天的独立窗口。</summary>
        public static void OpenConsoleWindow(string path, string title)
        {
            ConsoleWindow.Open(BaseUrl + path, path, title);
        }

        /// <summary>后台任务完成后，把结果推给网页界面。</summary>
        public static void NotifyResult(string json)
        {
            var f = MainForm;
            if (f == null || f.IsDisposed) return;
            try
            {
                f.BeginInvoke(new Action(delegate() { f.PostRaw(json); }));
            }
            catch { }
        }

        public static void Log(string msg)
        {
            try
            {
                var line = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "  " + msg;
                // 预览/截图的日志单独放，别把「最近活动」刷成开发记录
                var file = PreviewMode ? Path.Combine(Root, "data", "tray-preview.log") : LogFile;
                lock (LogLock)
                {
                    var dir = Path.GetDirectoryName(file);
                    if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
                    // 只留最近 300 行，避免无限增长
                    if (File.Exists(file))
                    {
                        var old = File.ReadAllLines(file, Encoding.UTF8);
                        if (old.Length > 300)
                        {
                            var keep = new string[300];
                            Array.Copy(old, old.Length - 300, keep, 0, 300);
                            File.WriteAllLines(file, keep, new UTF8Encoding(false));
                        }
                    }
                    File.AppendAllText(file, line + Environment.NewLine, new UTF8Encoding(false));
                }
            }
            catch { }
        }

        static string FindRoot()
        {
            var dir = new DirectoryInfo(AppDomain.CurrentDomain.BaseDirectory);
            for (int i = 0; i < 4 && dir != null; i++)
            {
                if (File.Exists(Path.Combine(dir.FullName, "config.json"))) return dir.FullName;
                dir = dir.Parent;
            }
            return null;
        }

        /// <summary>窗口 / 托盘状态图标的底图来源。</summary>
        public static string IconPath;

        /// <summary>加载品牌图标；找不到就退回旧的渐变圆标。</summary>
        static Icon LoadAppIcon()
        {
            try
            {
                IconPath = Path.Combine(Root, "desktop", "YF-Robot.ico");
                if (File.Exists(IconPath))
                {
                    // 给一个大尺寸帧，任务栏/高 DPI 下更清楚
                    return new Icon(IconPath, Scale(48), Scale(48));
                }
                var exeIcon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
                if (exeIcon != null) return exeIcon;
            }
            catch { }
            return BuildFallbackIcon();
        }

        /// <summary>没有图标文件时的兜底：渐变圆 + Y。</summary>
        static Icon BuildFallbackIcon()
        {
            var bmp = new Bitmap(64, 64);
            using (var g = Graphics.FromImage(bmp))
            {
                g.SmoothingMode = SmoothingMode.AntiAlias;
                g.Clear(Color.Transparent);
                using (var brush = new LinearGradientBrush(
                    new Rectangle(2, 2, 60, 60),
                    Color.FromArgb(99, 102, 241),
                    Color.FromArgb(6, 182, 212),
                    45f))
                {
                    g.FillEllipse(brush, 2, 2, 60, 60);
                }
                using (var f = new Font("Segoe UI", 34, FontStyle.Bold, GraphicsUnit.Pixel))
                using (var w = new SolidBrush(Color.White))
                {
                    var size = g.MeasureString("Y", f);
                    g.DrawString("Y", f, w, (64 - size.Width) / 2, (64 - size.Height) / 2);
                }
            }
            return Icon.FromHandle(bmp.GetHicon());
        }
    }

    /// <summary>极简 JSON 转义，够用即可，不引依赖。</summary>
    static class Json
    {
        public static string Str(string s)
        {
            if (string.IsNullOrEmpty(s)) return "";
            var sb = new StringBuilder(s.Length + 8);
            foreach (var c in s)
            {
                switch (c)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        if (c < ' ') sb.Append("\\u").Append(((int)c).ToString("x4"));
                        else sb.Append(c);
                        break;
                }
            }
            return sb.ToString();
        }
    }

    // =====================================================================
    //  托盘 / 服务
    // =====================================================================

    class TrayContext : ApplicationContext
    {
        readonly NotifyIcon _tray;
        readonly Icon _iconUp, _iconDown, _iconBusy;
        readonly System.Windows.Forms.Timer _timer;
        /// <summary>只用来把回调切回 UI 线程的隐藏控件，不显示。</summary>
        readonly Control _marshal = new Control();
        readonly string _version;
        int _port = 8899;
        int _autoRestarts;
        DateTime _lastRestart = DateTime.Now.AddHours(-1);
        bool? _wasUp;
        bool _manualStop;
        readonly bool _preview;

        public string BaseUrlOut { get { return BaseUrl(); } }
        public string VersionText { get { return _version; } }
        public int PortText { get { return _port; } }
        public bool Preview { get { return _preview; } }
        public bool ServiceUp { get { return IsServiceUp(); } }
        public void StartSvc() { _manualStop = false; EnsureService(true); }
        public void StopSvc() { _manualStop = true; Program.Log("手动停止服务"); StopService(); }
        public void DoRestart() { RestartService(); }
        public void DoBackup() { BackupMemory(); }
        public void DoRestore() { RestoreLatest(); }

        /// <summary>打开控制台（独立窗口，不再另开 Edge）。</summary>
        public void OpenConsole() { Program.OpenConsoleWindow("/console", "控制台"); }
        public void OpenChat() { Program.OpenConsoleWindow("/", "聊天"); }

        /// <summary>用系统默认浏览器打开（用户明确要网页版时用）。</summary>
        public void OpenInBrowser()
        {
            var url = BaseUrl() + "/console";
            try
            {
                var psi = new ProcessStartInfo(url);
                psi.UseShellExecute = true;
                Process.Start(psi);
                return;
            }
            catch { }
            try { Process.Start("explorer.exe", url); }
            catch (Exception ex) { MessageBox.Show("打不开浏览器：" + ex.Message + "\n地址：" + url, Program.AppName); }
        }

        public bool AutoStartOn { get { return IsAutoStart(); } set { SetAutoStart(value); } }

        public void OpenLogs()
        {
            var log = Path.Combine(Program.Root, "data", "app.out.log");
            if (File.Exists(log)) Process.Start("notepad.exe", "\"" + log + "\"");
            else MessageBox.Show("还没有日志文件：\n" + log, Program.AppName);
        }

        public void OpenDataDir()
        {
            var d = Path.Combine(Program.Root, "data");
            if (!Directory.Exists(d)) Directory.CreateDirectory(d);
            Process.Start("explorer.exe", "\"" + d + "\"");
        }

        /// <summary>读接入状态（适配器是否在线）。失败返回 null。</summary>
        public bool? AdapterOnline()
        {
            try
            {
                var req = (HttpWebRequest)WebRequest.Create(BaseUrl() + "/api/admin/bridge");
                req.Timeout = 1500;
                req.Proxy = null;
                using (var resp = (HttpWebResponse)req.GetResponse())
                using (var sr = new StreamReader(resp.GetResponseStream(), Encoding.UTF8))
                {
                    var json = sr.ReadToEnd();
                    var i = json.IndexOf("\"online\":");
                    if (i < 0) return null;
                    var start = i + 9;
                    var seg = json.Substring(start, Math.Min(6, json.Length - start)).Trim();
                    return seg.StartsWith("true");
                }
            }
            catch { return null; }
        }

        /// <summary>读一个管理接口（自动带本机令牌）。失败返回 null。</summary>
        public string ApiGet(string path)
        {
            try
            {
                var url = BaseUrl() + path;
                var token = ReadToken();
                if (!string.IsNullOrEmpty(token)) url += (path.IndexOf('?') >= 0 ? "&" : "?") + "token=" + token;

                var req = (HttpWebRequest)WebRequest.Create(url);
                req.Timeout = 5000;
                req.Proxy = null;
                if (!string.IsNullOrEmpty(token)) req.Headers.Add("x-local-token", token);
                using (var resp = (HttpWebResponse)req.GetResponse())
                using (var sr = new StreamReader(resp.GetResponseStream(), Encoding.UTF8))
                    return sr.ReadToEnd();
            }
            catch { return null; }
        }

        /// <summary>POST 一个管理接口。失败返回 null。</summary>
        public string ApiPost(string path, string jsonBody)
        {
            try
            {
                var url = BaseUrl() + path;
                var token = ReadToken();
                var req = (HttpWebRequest)WebRequest.Create(url);
                req.Method = "POST";
                req.Timeout = 10000;
                req.Proxy = null;
                req.ContentType = "application/json; charset=utf-8";
                if (!string.IsNullOrEmpty(token)) req.Headers.Add("x-local-token", token);
                var bytes = Encoding.UTF8.GetBytes(jsonBody);
                req.ContentLength = bytes.Length;
                using (var st = req.GetRequestStream()) st.Write(bytes, 0, bytes.Length);
                using (var resp = (HttpWebResponse)req.GetResponse())
                using (var sr = new StreamReader(resp.GetResponseStream(), Encoding.UTF8))
                    return sr.ReadToEnd();
            }
            catch { return null; }
        }

        string ReadToken()
        {
            try
            {
                var f = Path.Combine(Program.Root, "data", "token.txt");
                return File.Exists(f) ? File.ReadAllText(f).Trim() : "";
            }
            catch { return ""; }
        }

        public void OpenFolder(string path)
        {
            try
            {
                if (!Directory.Exists(path)) Directory.CreateDirectory(path);
                Process.Start("explorer.exe", "\"" + path + "\"");
            }
            catch { }
        }

        public void ShowTrayMenu()
        {
            if (_tray == null) return;
            _tray.ShowBalloonTip(2000, Program.AppName, "已缩到托盘，双击图标可再打开面板", ToolTipIcon.Info);
        }

        public TrayContext(bool silent) : this(silent, false) { }

        public TrayContext(bool silent, bool preview)
        {
            _preview = preview;
            _version = ReadVersion();
            _port = ReadPort();
            Program.BaseUrl = BaseUrl();

            if (preview)
            {
                // 预览：不建托盘、不拉服务、不写后台状态
                Program.Log("预览模式（版本 " + _version + "，端口 " + _port + "）");
                return;
            }

            _iconUp = BuildStatusIcon(Color.FromArgb(52, 211, 153));
            _iconDown = BuildStatusIcon(Color.FromArgb(139, 149, 168));
            _iconBusy = BuildStatusIcon(Color.FromArgb(251, 191, 36));

            // 用于把后台回调切回 UI 线程（静默模式下按需开窗口）
            try { _marshal.CreateControl(); } catch { }

            _tray = new NotifyIcon();
            _tray.Icon = _iconDown;
            _tray.Text = Program.AppName + " v" + _version;
            _tray.Visible = true;
            _tray.DoubleClick += delegate { OpenConsole(); };
            _tray.ContextMenuStrip = BuildMenu();

            Program.Log("托盘启动（版本 " + _version + "，端口 " + _port + "）");
            EnsureService(false);

            _tray.ShowBalloonTip(3500, Program.AppName + " 已启动",
                "右键托盘图标可打开控制台 / 重启服务 / 退出。双击直接开控制台。",
                ToolTipIcon.Info);

            _timer = new System.Windows.Forms.Timer();
            _timer.Interval = 5000;
            _timer.Tick += delegate { UpdateState(); };
            _timer.Start();

            UpdateState();
        }

        /// <summary>在 UI 线程上执行（托盘回调、二次启动线程都可能从别的线程进来）。</summary>
        public void OnUi(Action action)
        {
            try
            {
                if (_marshal.IsDisposed) return;
                if (_marshal.InvokeRequired) _marshal.BeginInvoke(action);
                else action();
            }
            catch
            {
                try { action(); } catch { }
            }
        }

        // ---------- 配置 ----------

        string ReadVersion()
        {
            try
            {
                var txt = File.ReadAllText(Path.Combine(Program.Root, "package.json"), Encoding.UTF8);
                var key = "\"version\"";
                var i = txt.IndexOf(key);
                if (i < 0) return "0.0.0";
                var q1 = txt.IndexOf('"', txt.IndexOf(':', i) + 1);
                var q2 = txt.IndexOf('"', q1 + 1);
                return txt.Substring(q1 + 1, q2 - q1 - 1);
            }
            catch { return "0.0.0"; }
        }

        int ReadPort()
        {
            try
            {
                var cfg = File.ReadAllText(Path.Combine(Program.Root, "config.json"), Encoding.UTF8);
                var i = cfg.IndexOf("\"port\"");
                if (i < 0) return 8899;
                var j = cfg.IndexOf(':', i) + 1;
                var end = j;
                while (end < cfg.Length && (char.IsDigit(cfg[end]) || cfg[end] == ' ')) end++;
                int p;
                if (int.TryParse(cfg.Substring(j, end - j).Trim(), out p) && p > 0) return p;
            }
            catch { }
            return 8899;
        }

        string BaseUrl() { return "http://127.0.0.1:" + _port; }

        // ---------- 服务 ----------

        bool IsServiceUp()
        {
            try
            {
                var req = (HttpWebRequest)WebRequest.Create(BaseUrl() + "/api/adapter/config");
                req.Timeout = 1500;
                req.Proxy = null;
                using (var resp = (HttpWebResponse)req.GetResponse())
                    return (int)resp.StatusCode < 500;
            }
            catch { return false; }
        }

        string NodePath()
        {
            var local = Path.Combine(Program.Root, "runtime", "node.exe");
            return File.Exists(local) ? local : "node";
        }

        void EnsureService(bool force)
        {
            if (!force && IsServiceUp()) return;
            try
            {
                var psi = new ProcessStartInfo();
                psi.FileName = NodePath();
                psi.Arguments = "launch_background.mjs";
                psi.WorkingDirectory = Program.Root;
                psi.CreateNoWindow = true;
                psi.UseShellExecute = false;
                var p = Process.Start(psi);
                Program.Log("服务已启动 pid=" + p.Id);
            }
            catch (Exception ex)
            {
                Program.Log("启动服务失败：" + ex.Message);
                MessageBox.Show("启动服务失败：" + ex.Message, Program.AppName);
            }
        }

        /// <summary>只杀本项目的 node（命令行同时包含本目录和入口脚本），不按端口杀。</summary>
        void StopService()
        {
            try
            {
                var q = "SELECT ProcessId, CommandLine FROM Win32_Process WHERE Name='node.exe'";
                using (var searcher = new ManagementObjectSearcher(q))
                {
                    foreach (ManagementObject mo in searcher.Get())
                    {
                        var cmd = Convert.ToString(mo["CommandLine"]);
                        if (string.IsNullOrEmpty(cmd)) continue;
                        var isOurs = cmd.IndexOf("launch_background.mjs", StringComparison.OrdinalIgnoreCase) >= 0
                                  || cmd.IndexOf("app.mjs", StringComparison.OrdinalIgnoreCase) >= 0;
                        var inRoot = cmd.IndexOf(Program.Root, StringComparison.OrdinalIgnoreCase) >= 0;
                        if (isOurs && inRoot)
                        {
                            try { Process.GetProcessById(Convert.ToInt32(mo["ProcessId"])).Kill(); } catch { }
                        }
                    }
                }
            }
            catch (Exception ex) { Program.Log("停止服务异常：" + ex.Message); }
        }

        void RestartService()
        {
            if (_tray != null) _tray.Icon = _iconBusy;
            if (_tray != null) _tray.Text = Program.AppName + " · 重启中…";
            Program.Log("手动重启服务");
            _manualStop = true;      // 重启的空档里别让守护逻辑再拉一个
            try
            {
                StopService();
                Thread.Sleep(1200);
                EnsureService(true);
                Thread.Sleep(1500);
            }
            finally { _manualStop = false; }
            UpdateState();
        }

        /// <summary>
        /// 界面触发的重启：不能卡住 UI 线程（托盘菜单里可以用阻塞版）。
        /// </summary>
        public void RestartServiceQuiet()
        {
            Program.Log("界面重启服务");
            var t = new Thread(delegate()
            {
                try
                {
                    _manualStop = true;
                    try
                    {
                        StopService();
                        Thread.Sleep(1200);
                        EnsureService(true);
                        Thread.Sleep(1200);
                    }
                    finally { _manualStop = false; }
                    var up = IsServiceUp();
                    Program.Log("服务已重启：" + (up ? "运行中" : "未就绪"));
                    Program.NotifyResult("{\"type\":\"result\",\"ok\":" + (up ? "true" : "false")
                        + ",\"title\":\"" + (up ? "服务已重启" : "服务重启超时")
                        + "\",\"text\":\"" + (up ? "本地服务已重新就绪。" : "12 秒后仍未就绪，看下日志。") + "\"}");
                }
                catch (Exception ex)
                {
                    Program.Log("重启服务失败：" + ex.Message);
                    Program.NotifyResult("{\"type\":\"result\",\"ok\":false,\"title\":\"重启失败\",\"text\":\""
                        + Json.Str(ex.Message) + "\"}");
                }
            });
            t.IsBackground = true;
            t.Start();
        }

        // ---------- 状态 ----------

        void UpdateState()
        {
            if (_tray == null) return;
            bool up = IsServiceUp();

            if (_wasUp.HasValue && _wasUp.Value != up)
                Program.Log("[state] " + _wasUp.Value + " -> " + up);

            if (up)
            {
                _manualStop = false;   // 服务起来了（不管是哪条路径拉起的），恢复守护
                _tray.Icon = _iconUp;
                _tray.Text = Program.AppName + " v" + _version + " · 运行中（:" + _port + "）";
                _autoRestarts = 0;
                if (_wasUp.HasValue && !_wasUp.Value)
                    _tray.ShowBalloonTip(2500, Program.AppName,
                        "服务已就绪（端口 " + _port + "），双击图标打开控制台", ToolTipIcon.Info);
            }
            else
            {
                _tray.Icon = _iconDown;
                _tray.Text = Program.AppName + " v" + _version + " · 已停止";

                // 服务意外退出：自动拉起，最多 3 次，间隔 ≥15 秒。
                // 用户手动点「停止」时不自动拉起，否则按钮等于没用。
                if (!_manualStop && _wasUp.HasValue && _wasUp.Value && _autoRestarts < 3)
                {
                    if ((DateTime.Now - _lastRestart).TotalSeconds >= 15)
                    {
                        _autoRestarts++;
                        _lastRestart = DateTime.Now;
                        Program.Log("检测到服务退出，第 " + _autoRestarts + " 次自动重启");
                        _tray.ShowBalloonTip(3000, Program.AppName,
                            "服务好像退出了，正在自动重启（第 " + _autoRestarts + " 次）", ToolTipIcon.Warning);
                        EnsureService(true);
                    }
                }
            }

            _wasUp = up;
        }

        // ---------- 菜单 ----------

        ContextMenuStrip BuildMenu()
        {
            var m = new ContextMenuStrip();

            var info = new ToolStripMenuItem(Program.AppName + " v" + _version + " · 端口 " + _port);
            info.Enabled = false;
            m.Items.Add(info);
            m.Items.Add(new ToolStripSeparator());

            m.Items.Add("打开启动器", null, delegate { Program.ShowLauncher(); });
            m.Items.Add("打开控制台", null, delegate { OpenConsole(); });
            m.Items.Add("聊天窗口", null, delegate { OpenChat(); });

            m.Items.Add(new ToolStripSeparator());

            m.Items.Add("备份记忆", null, delegate { BackupMemory(); });
            m.Items.Add("恢复最近备份…", null, delegate { RestoreLatest(); });

            m.Items.Add("查看日志", null, delegate
            {
                var log = Path.Combine(Program.Root, "data", "app.out.log");
                if (File.Exists(log)) Process.Start("notepad.exe", "\"" + log + "\"");
                else MessageBox.Show("还没有日志文件：\n" + log, Program.AppName);
            });

            m.Items.Add("重启服务", null, delegate { RestartService(); });

            m.Items.Add("打开数据目录", null, delegate
            {
                var d = Path.Combine(Program.Root, "data");
                if (!Directory.Exists(d)) Directory.CreateDirectory(d);
                Process.Start("explorer.exe", "\"" + d + "\"");
            });

            m.Items.Add(new ToolStripSeparator());

            var auto = new ToolStripMenuItem("开机自启");
            auto.Checked = IsAutoStart();
            auto.Click += delegate
            {
                SetAutoStart(!auto.Checked);
                auto.Checked = IsAutoStart();
            };
            m.Items.Add(auto);

            m.Items.Add(new ToolStripSeparator());

            m.Items.Add("退出（停止服务）", null, delegate
            {
                if (MessageBox.Show("退出会停止服务（聊天也会断）。确定？", Program.AppName,
                        MessageBoxButtons.YesNo, MessageBoxIcon.Question) != DialogResult.Yes) return;
                Program.Log("退出托盘，停止服务");

                if (_timer != null) _timer.Stop();
                StopService();
                if (_tray != null) _tray.Visible = false;
                Application.Exit();
            });

            return m;
        }

        /// <summary>跑一个 node 工具并返回输出（用于备份/恢复这类一次性动作）。</summary>
        string RunNode(string args, int timeoutMs)
        {
            try
            {
                var psi = new ProcessStartInfo();
                psi.FileName = NodePath();
                psi.Arguments = args;
                psi.WorkingDirectory = Program.Root;
                psi.CreateNoWindow = true;
                psi.UseShellExecute = false;
                psi.RedirectStandardOutput = true;
                psi.RedirectStandardError = true;
                psi.StandardOutputEncoding = Encoding.UTF8;
                psi.StandardErrorEncoding = Encoding.UTF8;
                var p = Process.Start(psi);
                var output = p.StandardOutput.ReadToEnd();
                var err = p.StandardError.ReadToEnd();
                if (!p.WaitForExit(timeoutMs))
                {
                    try { p.Kill(); } catch { }
                    return "（超时）" + output;
                }
                return (output + err).Trim();
            }
            catch (Exception ex)
            {
                return "执行失败：" + ex.Message;
            }
        }

        public string BackupMemoryText()
        {
            Program.Log("手动备份记忆");
            var outText = RunNode("tools\\memory-tool.mjs export", 60000);
            Program.Log("备份结果：" + outText.Replace("\r", "").Replace("\n", " | "));
            return outText;
        }

        public string RestoreMemoryText()
        {
            Program.Log("从最近备份恢复记忆");
            var outText = RunNode("tools\\memory-tool.mjs restore --latest", 120000);
            Program.Log("恢复结果：" + outText.Replace("\r", "").Replace("\n", " | "));
            return outText;
        }

        void BackupMemory()
        {
            var outText = BackupMemoryText();
            _tray.ShowBalloonTip(3000, Program.AppName + " · 记忆已备份",
                FirstLine(outText), ToolTipIcon.Info);
            MessageBox.Show(outText, "备份记忆", MessageBoxButtons.OK, MessageBoxIcon.Information);
        }

        void RestoreLatest()
        {
            var list = RunNode("tools\\memory-tool.mjs list", 60000);
            if (MessageBox.Show("要从最近的备份恢复吗？\n\n当前记忆和会话会被覆盖（备份本身不会删）。\n\n" + FirstLine(list),
                    "恢复记忆", MessageBoxButtons.YesNo, MessageBoxIcon.Warning) != DialogResult.Yes) return;

            var outText = RestoreMemoryText();
            MessageBox.Show(outText, "恢复记忆", MessageBoxButtons.OK, MessageBoxIcon.Information);
        }

        public static string FirstLine(string text)
        {
            if (string.IsNullOrEmpty(text)) return "";
            var i = text.IndexOf('\n');
            var line = i < 0 ? text : text.Substring(0, i);
            return line.Trim();
        }

        // ---------- 开机自启 ----------

        const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";

        bool IsAutoStart()
        {
            try
            {
                using (var k = Registry.CurrentUser.OpenSubKey(RunKey))
                    return k != null && k.GetValue(Program.AppName) != null;
            }
            catch { return false; }
        }

        void SetAutoStart(bool on)
        {
            try
            {
                using (var k = Registry.CurrentUser.CreateSubKey(RunKey))
                {
                    if (on) k.SetValue(Program.AppName, "\"" + Application.ExecutablePath + "\"");
                    else k.DeleteValue(Program.AppName, false);
                }
            }
            catch (Exception ex)
            {
                MessageBox.Show("设置开机自启失败：" + ex.Message, Program.AppName);
            }
        }

        // ---------- 托盘状态图标（品牌图标 + 右下角状态点） ----------

        /// <summary>品牌图标右下角加一个状态点：绿=运行中 / 灰=已停止 / 黄=重启中。</summary>
        static Icon BuildStatusIcon(Color color)
        {
            try
            {
                if (Program.AppIcon != null)
                {
                    using (var baseBmp = Program.AppIcon.ToBitmap())
                    using (var bmp = new Bitmap(64, 64))
                    {
                        using (var g = Graphics.FromImage(bmp))
                        {
                            g.SmoothingMode = SmoothingMode.AntiAlias;
                            g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                            g.Clear(Color.Transparent);
                            g.DrawImage(baseBmp, new Rectangle(0, 0, 64, 64));

                            const int d = 26;
                            var x = 64 - d - 2;
                            var y = 64 - d - 2;
                            using (var ring = new SolidBrush(Color.FromArgb(235, 11, 14, 20)))
                                g.FillEllipse(ring, x - 4, y - 4, d + 8, d + 8);
                            using (var dot = new SolidBrush(color))
                                g.FillEllipse(dot, x, y, d, d);
                        }
                        return Icon.FromHandle(bmp.GetHicon());
                    }
                }
            }
            catch { }
            return BuildTintIcon(Program.AppIcon, color);
        }

        static Icon BuildTintIcon(Icon source, Color color)
        {
            var bmp = new Bitmap(64, 64);
            using (var g = Graphics.FromImage(bmp))
            {
                g.SmoothingMode = SmoothingMode.AntiAlias;
                g.Clear(Color.Transparent);
                using (var b = new SolidBrush(color)) g.FillEllipse(b, 2, 2, 60, 60);
                using (var f = new Font("Segoe UI", 34, FontStyle.Bold, GraphicsUnit.Pixel))
                using (var w = new SolidBrush(Color.White))
                {
                    var size = g.MeasureString("Y", f);
                    g.DrawString("Y", f, w, (64 - size.Width) / 2, (64 - size.Height) / 2);
                }
            }
            return Icon.FromHandle(bmp.GetHicon());
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                if (_tray != null) _tray.Dispose();
                if (_marshal != null && !_marshal.IsDisposed) _marshal.Dispose();
            }
            base.Dispose(disposing);
        }
    }

    // =====================================================================
    //  网页界面 ⇄ C# 的桥
    // =====================================================================

    [ComVisible(true)]
    [ClassInterface(ClassInterfaceType.AutoDual)]
    public class LauncherBridge
    {
        readonly TrayContext _ctx;
        readonly MainForm _form;

        internal LauncherBridge(TrayContext ctx, MainForm form)
        {
            _ctx = ctx;
            _form = form;
        }

        public string Ping() { return "pong"; }

        /// <summary>界面轮询的状态快照。</summary>
        public string GetState()
        {
            var up = _ctx.ServiceUp;
            bool? adp = up ? _ctx.AdapterOnline() : null;

            var sb = new StringBuilder();
            sb.Append("{\"version\":\"").Append(Json.Str(_ctx.VersionText)).Append("\",");
            sb.Append("\"port\":").Append(_ctx.PortText).Append(",");
            sb.Append("\"serviceUp\":").Append(up ? "true" : "false").Append(",");
            sb.Append("\"adapterOnline\":").Append(!adp.HasValue ? "null" : (adp.Value ? "true" : "false")).Append(",");
            sb.Append("\"autoStart\":").Append(_ctx.AutoStartOn ? "true" : "false").Append(",");
            sb.Append("\"base\":\"").Append(Json.Str(_ctx.BaseUrlOut)).Append("\",");
            sb.Append("\"trayLog\":[");

            try
            {
                var log = Path.Combine(Program.Root, "data", "tray.log");
                if (File.Exists(log))
                {
                    var lines = File.ReadAllLines(log, Encoding.UTF8);
                    var start = Math.Max(0, lines.Length - 24);
                    var first = true;
                    for (int i = start; i < lines.Length; i++)
                    {
                        if (lines[i].Trim().Length == 0) continue;
                        if (!first) sb.Append(",");
                        first = false;
                        sb.Append("\"").Append(Json.Str(lines[i])).Append("\"");
                    }
                }
            }
            catch { }

            sb.Append("]}");
            return sb.ToString();
        }

        public string GetPlugins()
        {
            var raw = _ctx.ApiGet("/api/admin/plugins");
            return raw ?? "{\"error\":\"服务未响应\"}";
        }

        public string GetMarket()
        {
            try
            {
                var file = Path.Combine(Program.Root, "market", "index.json");
                if (!File.Exists(file)) return "{\"items\":[]}";
                return File.ReadAllText(file, Encoding.UTF8);
            }
            catch (Exception ex)
            {
                return "{\"items\":[],\"error\":\"" + Json.Str(ex.Message) + "\"}";
            }
        }

        public string CheckUpdate()
        {
            var raw = _ctx.ApiGet("/api/admin/update/check");
            return raw ?? "{\"error\":\"服务未响应\"}";
        }

        /// <summary>界面动作总入口；失败也返回 JSON，前端不用 try/catch。</summary>
        public string Act(string action, string arg)
        {
            try
            {
                switch (action)
                {
                    case "start":
                        _ctx.StartSvc();
                        Thread.Sleep(400);
                        return "{\"ok\":true}";
                    case "stop":
                        _ctx.StopSvc();
                        Thread.Sleep(300);
                        return "{\"ok\":true}";
                    case "restart":
                        _ctx.RestartServiceQuiet();
                        return "{\"ok\":true}";
                    case "backup":
                        RunInBackground("记忆已备份", "备份失败", delegate { return _ctx.BackupMemoryText(); }, null);
                        return "{\"ok\":true}";
                    case "restore":
                        RunInBackground("记忆已恢复", "恢复失败", delegate { return _ctx.RestoreMemoryText(); }, null);
                        return "{\"ok\":true}";
                    case "logs":
                        _ctx.OpenLogs();
                        return "{\"ok\":true}";
                    case "data":
                        _ctx.OpenDataDir();
                        return "{\"ok\":true}";
                    case "pluginsDir":
                        _ctx.OpenFolder(Path.Combine(Program.Root, "plugins"));
                        return "{\"ok\":true}";
                    case "marketDir":
                        _ctx.OpenFolder(Path.Combine(Program.Root, "market"));
                        return "{\"ok\":true}";
                    case "marketEdit":
                        return EditMarketIndex();
                    case "browser":
                        _ctx.OpenInBrowser();
                        return "{\"ok\":true}";
                    case "github":
                        OpenUrl("https://github.com/YF-YMWA/yf-robot");
                        return "{\"ok\":true}";
                    case "open":
                        return OpenApp(arg);
                    case "update":
                        return CheckUpdate();
                    case "autoStart":
                        var on = string.Equals(arg, "true", StringComparison.OrdinalIgnoreCase);
                        _ctx.AutoStartOn = on;
                        return "{\"ok\":true,\"autoStart\":" + (_ctx.AutoStartOn ? "true" : "false") + "}";
                    case "togglePlugin":
                        return TogglePlugin(arg);
                    case "install":
                        return InstallPlugin(arg);
                    default:
                        return "{\"ok\":false,\"error\":\"未知操作：" + Json.Str(action) + "\"}";
                }
            }
            catch (Exception ex)
            {
                Program.Log("操作失败（" + action + "）：" + ex.Message);
                return "{\"ok\":false,\"error\":\"" + Json.Str(ex.Message) + "\"}";
            }
        }

        string OpenApp(string which)
        {
            if (string.Equals(which, "console", StringComparison.OrdinalIgnoreCase))
            {
                _ctx.OpenConsole();
                return "{\"ok\":true}";
            }
            if (string.Equals(which, "chat", StringComparison.OrdinalIgnoreCase))
            {
                _ctx.OpenChat();
                return "{\"ok\":true}";
            }
            if (string.Equals(which, "browser", StringComparison.OrdinalIgnoreCase))
            {
                _ctx.OpenInBrowser();
                return "{\"ok\":true}";
            }
            return "{\"ok\":false,\"error\":\"未知入口\"}";
        }

        string EditMarketIndex()
        {
            var f = Path.Combine(Program.Root, "market", "index.json");
            if (!File.Exists(f)) return "{\"ok\":false,\"error\":\"还没有索引文件：" + Json.Str(f) + "\"}";
            Process.Start("notepad.exe", "\"" + f + "\"");
            return "{\"ok\":true}";
        }

        static void OpenUrl(string url)
        {
            try
            {
                var psi = new ProcessStartInfo(url);
                psi.UseShellExecute = true;
                Process.Start(psi);
            }
            catch (Exception ex) { Program.Log("打开链接失败：" + ex.Message); }
        }

        string TogglePlugin(string arg)
        {
            var parts = arg.Split('|');
            if (parts.Length < 2) return "{\"ok\":false,\"error\":\"参数不完整\"}";
            var id = parts[0];
            var enabled = string.Equals(parts[1], "true", StringComparison.OrdinalIgnoreCase);
            var body = "{\"id\":\"" + Json.Str(id) + "\",\"enabled\":" + (enabled ? "true" : "false") + "}";
            var r = _ctx.ApiPost("/api/admin/plugins/toggle", body);
            if (r == null) return "{\"ok\":false,\"error\":\"服务没起来？\"}";
            return "{\"ok\":true}";
        }

        string InstallPlugin(string arg)
        {
            var sep = arg.IndexOf('|');
            if (sep < 0) return "{\"ok\":false,\"error\":\"参数不完整\"}";
            var id = arg.Substring(0, sep);
            var url = arg.Substring(sep + 1);

            RunInBackground("插件安装完成", "插件安装失败", delegate
            {
                var dir = Path.Combine(Program.Root, "plugins");
                Directory.CreateDirectory(dir);
                var zip = Path.Combine(Path.GetTempPath(), "yf-plugin-" + DateTime.Now.Ticks + ".zip");
                try
                {
                    var wc = new WebClient();
                    wc.Proxy = null;
                    wc.DownloadFile(new Uri(url), zip);
                    ZipFile.ExtractToDirectory(zip, dir);
                    return "「" + id + "」已解压到 plugins/，重启服务后生效。";
                }
                finally
                {
                    try { if (File.Exists(zip)) File.Delete(zip); } catch { }
                }
            }, "plugins");

            return "{\"ok\":true}";
        }

        /// <summary>后台跑一次性操作，完成后用 WebMessage 通知界面。</summary>
        void RunInBackground(string okTitle, string failTitle, Func<string> work, string refresh)
        {
            var t = new Thread(delegate()
            {
                string text;
                var ok = true;
                try { text = work(); }
                catch (Exception ex)
                {
                    ok = false;
                    text = ex.Message;
                    Program.Log(failTitle + "：" + ex.Message);
                }

                if (text != null && text.Length > 600) text = text.Substring(0, 600) + "…";
                var json = "{\"type\":\"result\",\"ok\":" + (ok ? "true" : "false")
                    + ",\"title\":\"" + Json.Str(ok ? okTitle : failTitle)
                    + "\",\"text\":\"" + Json.Str(text == null ? "" : text.Trim())
                    + "\"" + (string.IsNullOrEmpty(refresh) ? "" : ",\"refresh\":\"" + refresh + "\"") + "}";
                Program.NotifyResult(json);
            });
            t.IsBackground = true;
            t.Start();
        }

        /* ---------------- 窗口 ---------------- */

        public void Window(string action)
        {
            switch (action)
            {
                case "drag": _form.BeginDrag(); break;
                case "min": _form.WindowState = FormWindowState.Minimized; break;
                case "max": _form.ToggleMaximize(); break;
                case "close": _form.Close(); break;
            }
        }
    }

    // =====================================================================
    //  启动器主窗口
    // =====================================================================

    class MainForm : Form
    {
        readonly TrayContext _ctx;
        readonly LauncherBridge _bridge;
        WebView2 _web;
        Panel _loading;
        bool _webReady;
        bool _shotDone;

        [DllImport("user32.dll")]
        static extern bool ReleaseCapture();
        [DllImport("user32.dll")]
        static extern IntPtr SendMessage(IntPtr hWnd, int msg, int wParam, int lParam);

        const int WM_NCLBUTTONDOWN = 0xA1;
        const int HTCAPTION = 0x2;

        public MainForm(TrayContext ctx)
        {
            _ctx = ctx;
            Text = Program.AppName;
            AutoScaleMode = AutoScaleMode.None;   // 所有尺寸由 Program.Scale 统一换算
            ClientSize = new Size(Program.Scale(1080), Program.Scale(720));
            MinimumSize = new Size(Program.Scale(900), Program.Scale(620));
            StartPosition = FormStartPosition.CenterScreen;
            FormBorderStyle = FormBorderStyle.None;
            BackColor = Color.FromArgb(11, 14, 20);
            ForeColor = Color.FromArgb(233, 238, 249);
            Icon = Program.AppIcon;
            DoubleBuffered = true;
            // 留一圈可抓取的边：WebView2 子窗口会盖住客户区，
            // 没有这圈边的话无边框窗口在网页区域拖不到边、改不了尺寸。
            Padding = new Padding(Program.Scale(5));

            // 最大化时不要盖住任务栏
            var wa = Screen.PrimaryScreen.WorkingArea;
            MaximizedBounds = wa;

            _loading = BuildLoading();
            Controls.Add(_loading);

            _bridge = new LauncherBridge(ctx, this);
            BuildWeb();

            Resize += delegate { RoundCorners(); };
            Shown += delegate { RoundCorners(); };

            FormClosing += delegate(object s2, FormClosingEventArgs e2)
            {
                if (e2.CloseReason == CloseReason.UserClosing && !Program.PreviewMode)
                {
                    e2.Cancel = true;
                    HideToTray();
                }
            };
        }

        Panel BuildLoading()
        {
            var p = new Panel();
            p.Dock = DockStyle.Fill;
            p.BackColor = Color.FromArgb(11, 14, 20);

            var logo = new Label();
            logo.Text = "Y";
            logo.Font = new Font("Segoe UI", 26f, FontStyle.Bold);
            logo.ForeColor = Color.White;
            logo.BackColor = Color.FromArgb(99, 102, 241);
            logo.Size = new Size(Program.Scale(58), Program.Scale(58));
            logo.TextAlign = ContentAlignment.MiddleCenter;
            logo.Location = new Point((ClientSize.Width - logo.Width) / 2, ClientSize.Height / 2 - Program.Scale(70));
            logo.Anchor = AnchorStyles.None;
            p.Controls.Add(logo);

            var tip = new Label();
            tip.Text = "正在载入启动器…";
            tip.ForeColor = Color.FromArgb(139, 149, 168);
            tip.Font = new Font("Microsoft YaHei UI", 10f);
            tip.AutoSize = true;
            tip.Location = new Point(ClientSize.Width / 2, ClientSize.Height / 2 + Program.Scale(4));
            tip.Anchor = AnchorStyles.None;
            p.Controls.Add(tip);

            p.Resize += delegate
            {
                logo.Location = new Point((p.Width - logo.Width) / 2, p.Height / 2 - Program.Scale(70));
                tip.Location = new Point((p.Width - tip.Width) / 2, p.Height / 2 + Program.Scale(4));
            };
            return p;
        }

        void BuildWeb()
        {
            try
            {
                _web = new WebView2();
                _web.Dock = DockStyle.Fill;
                _web.DefaultBackgroundColor = Color.FromArgb(11, 14, 20);
                Controls.Add(_web);
                _web.BringToFront();

                _web.CoreWebView2InitializationCompleted += delegate(object s, CoreWebView2InitializationCompletedEventArgs e)
                {
                    if (!e.IsSuccess)
                    {
                        ShowFallback("内嵌浏览器初始化失败：" + (e.InitializationException == null ? "未知错误" : e.InitializationException.Message));
                        return;
                    }
                    var core = _web.CoreWebView2;
                    core.Settings.AreDefaultContextMenusEnabled = false;
                    core.Settings.IsStatusBarEnabled = false;
                    core.Settings.IsZoomControlEnabled = false;
                    core.Settings.AreDevToolsEnabled = Program.PreviewMode;

                    // 本地界面走虚拟域名：既能用相对路径，也不受 file:// 限制
                    var ui = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "ui");
                    if (!Directory.Exists(ui)) ui = Path.Combine(Program.Root, "desktop", "ui");
                    if (!File.Exists(Path.Combine(ui, "index.html")))
                    {
                        ShowFallback("找不到界面文件：" + Path.Combine(ui, "index.html"));
                        return;
                    }

                    try
                    {
                        core.SetVirtualHostNameToFolderMapping("launcher.local", ui,
                            CoreWebView2HostResourceAccessKind.Allow);
                    }
                    catch (Exception ex) { Program.Log("界面域名映射失败：" + ex.Message); }

                    core.AddHostObjectToScript("launcher", _bridge);
                    core.NavigationCompleted += OnWebNavigated;

                    var url = "https://launcher.local/index.html";
                    if (!string.IsNullOrEmpty(Program.StartPage)) url += "?page=" + Program.StartPage;
                    try { _web.Source = new Uri(url); }
                    catch (Exception ex) { ShowFallback("载入界面失败：" + ex.Message); }
                };

                _web.EnsureCoreWebView2Async(null);
            }
            catch (Exception ex)
            {
                ShowFallback("内嵌浏览器起不来：" + ex.Message);
                Program.Log("WebView2 初始化失败：" + ex.Message);
            }
        }

        void OnWebNavigated(object sender, CoreWebView2NavigationCompletedEventArgs e)
        {
            if (!e.IsSuccess)
            {
                ShowFallback("界面载入失败（WebView2 错误码 " + e.WebErrorStatus + "）");
                return;
            }

            _webReady = true;
            if (_loading != null) _loading.Visible = false;
            Program.Log("启动器界面已载入");

            if (!string.IsNullOrEmpty(Program.ShotPath))
            {
                var timer = new System.Windows.Forms.Timer();
                timer.Interval = 1600; // 等前端拉完状态、动画落定
                timer.Tick += delegate
                {
                    timer.Stop();
                    timer.Dispose();
                    CaptureShot(Program.ShotPath);
                };
                timer.Start();
            }
        }

        /// <summary>--shot=路径：把网页区域截成 PNG（自检/截图用，不影响正常启动）。</summary>
        void CaptureShot(string path)
        {
            if (_shotDone) return;
            _shotDone = true;
            try
            {
                var fs = new FileStream(path, FileMode.Create, FileAccess.Write);
                _web.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, fs)
                    .ContinueWith(delegate(Task t)
                    {
                        try { fs.Close(); } catch { }
                        if (t.IsFaulted)
                            Program.Log("截图失败：" + (t.Exception == null ? "未知" : t.Exception.GetBaseException().Message));
                        else
                            Program.Log("截图已保存：" + path);

                        try
                        {
                            BeginInvoke(new Action(delegate()
                            {
                                Close();
                                Application.Exit();
                            }));
                        }
                        catch { }
                    });
            }
            catch (Exception ex)
            {
                Program.Log("截图失败：" + ex.Message);
            }
        }

        void ShowFallback(string message)
        {
            if (IsDisposed) return;
            try
            {
                if (_web != null) _web.Visible = false;
                if (_loading != null) _loading.Visible = false;
                Program.Log("界面回退：" + message);

                var panel = new Panel();
                panel.Dock = DockStyle.Fill;
                panel.BackColor = Color.FromArgb(11, 14, 20);
                Controls.Add(panel);
                panel.BringToFront();

                var title = new Label();
                title.Text = "启动器界面没能载入";
                title.Font = new Font("Microsoft YaHei UI", 15f, FontStyle.Bold);
                title.ForeColor = Color.FromArgb(233, 238, 249);
                title.AutoSize = true;
                title.Location = new Point(40, 44);
                panel.Controls.Add(title);

                var desc = new Label();
                desc.Text = message + "\n\n你仍然可以打开控制台或网页版继续使用。";
                desc.Font = new Font("Microsoft YaHei UI", 9.5f);
                desc.ForeColor = Color.FromArgb(139, 149, 168);
                desc.AutoSize = true;
                desc.MaximumSize = new Size(620, 0);
                desc.Location = new Point(42, 82);
                panel.Controls.Add(desc);

                var console = MakeFallbackButton("打开控制台", 42, 170, true);
                console.Click += delegate { _ctx.OpenConsole(); };

                var browser = MakeFallbackButton("网页版（浏览器）", 166, 170, false);
                browser.Click += delegate { _ctx.OpenInBrowser(); };

                var quit = MakeFallbackButton("退出", 330, 170, false);
                quit.Click += delegate { Application.Exit(); };
                panel.Controls.Add(console);
                panel.Controls.Add(browser);
                panel.Controls.Add(quit);
            }
            catch (Exception ex)
            {
                Program.Log("回退界面也失败了：" + ex.Message);
            }
        }

        static Button MakeFallbackButton(string text, int x, int y, bool primary)
        {
            var b = new Button();
            b.Text = text;
            b.Location = new Point(x, y);
            b.Size = new Size(text.Length > 6 ? 150 : 110, 38);
            b.FlatStyle = FlatStyle.Flat;
            b.Font = new Font("Microsoft YaHei UI", 9.5f);
            b.ForeColor = Color.White;
            b.BackColor = primary ? Color.FromArgb(99, 102, 241) : Color.FromArgb(28, 34, 48);
            b.FlatAppearance.BorderColor = primary ? Color.FromArgb(99, 102, 241) : Color.FromArgb(56, 66, 84);
            b.Cursor = Cursors.Hand;
            return b;
        }

        // ---------- 给桥用 ----------

        public void BeginDrag()
        {
            ReleaseCapture();
            SendMessage(Handle, WM_NCLBUTTONDOWN, HTCAPTION, 0);
        }

        public void ToggleMaximize()
        {
            if (WindowState == FormWindowState.Maximized)
            {
                WindowState = FormWindowState.Normal;
            }
            else
            {
                MaximizedBounds = Screen.FromControl(this).WorkingArea;
                WindowState = FormWindowState.Maximized;
            }
            RoundCorners();
        }

        public void ShowFromTray()
        {
            Show();
            ShowInTaskbar = true;
            if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
            Activate();
            BringToFront();
            if (_webReady && _web != null) _web.Focus();
        }

        void HideToTray()
        {
            Hide();
            ShowInTaskbar = false;
            _ctx.ShowTrayMenu();
        }

        /// <summary>把一条后台结果发给网页界面。</summary>
        public void PostRaw(string json)
        {
            if (_web == null || _web.CoreWebView2 == null) return;
            try { _web.CoreWebView2.PostWebMessageAsJson(json); }
            catch (Exception ex) { Program.Log("推送结果失败：" + ex.Message); }
        }

        // ---------- 无边框辅助 ----------

        const int WM_NCHITTEST = 0x84;
        const int HTLEFT = 10, HTRIGHT = 11, HTTOP = 12, HTTOPLEFT = 13,
                  HTTOPRIGHT = 14, HTBOTTOM = 15, HTBOTTOMLEFT = 16, HTBOTTOMRIGHT = 17;

        /// <summary>
        /// 无边框窗口默认不能拖边缘缩放。Padding 留出的那一圈由窗体自己接管，
        /// WebView2 只占中间，所以这里按光标位置回报缩放命中区。
        /// </summary>
        protected override void WndProc(ref Message m)
        {
            if (m.Msg == WM_NCHITTEST)
            {
                base.WndProc(ref m);
                if (WindowState == FormWindowState.Maximized) return;

                var lp = m.LParam.ToInt32();
                var screenPoint = new Point((short)(lp & 0xFFFF), (short)((lp >> 16) & 0xFFFF));
                var p = PointToClient(screenPoint);
                var g = Program.Scale(5);   // 可抓取的边框宽度也跟着 DPI 放大
                var w = ClientSize.Width;
                var h = ClientSize.Height;
                if (p.X < 0 || p.Y < 0 || p.X > w || p.Y > h) return;

                bool l = p.X <= g, r = p.X >= w - g;
                bool t = p.Y <= g, b = p.Y >= h - g;
                if (!(l || r || t || b)) return;

                if (t && l) m.Result = (IntPtr)HTTOPLEFT;
                else if (t && r) m.Result = (IntPtr)HTTOPRIGHT;
                else if (b && l) m.Result = (IntPtr)HTBOTTOMLEFT;
                else if (b && r) m.Result = (IntPtr)HTBOTTOMRIGHT;
                else if (l) m.Result = (IntPtr)HTLEFT;
                else if (r) m.Result = (IntPtr)HTRIGHT;
                else if (t) m.Result = (IntPtr)HTTOP;
                else m.Result = (IntPtr)HTBOTTOM;
                return;
            }
            base.WndProc(ref m);
        }

        /// <summary>圆角窗口（改尺寸时重算）。</summary>
        void RoundCorners()
        {
            try
            {
                if (WindowState == FormWindowState.Maximized)
                {
                    Region = null;
                    return;
                }
                var path = new GraphicsPath();
                int r = Program.Scale(14);
                var b = new Rectangle(0, 0, Width, Height);
                path.AddArc(b.X, b.Y, r, r, 180, 90);
                path.AddArc(b.Right - r, b.Y, r, r, 270, 90);
                path.AddArc(b.Right - r, b.Bottom - r, r, r, 0, 90);
                path.AddArc(b.X, b.Bottom - r, r, r, 90, 90);
                path.CloseFigure();
                Region = new Region(path);
            }
            catch { }
        }
    }

    // =====================================================================
    //  控制台 / 聊天 独立窗口
    // =====================================================================

    class ConsoleWindow : Form
    {
        static readonly Dictionary<string, ConsoleWindow> OpenWindows = new Dictionary<string, ConsoleWindow>();

        readonly string _url;
        readonly string _key;
        WebView2 _web;
        Panel _cover;
        bool _failed;

        [DllImport("dwmapi.dll")]
        static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int attrValue, int attrSize);

        public static void Open(string url, string key, string title)
        {
            ConsoleWindow win;
            if (OpenWindows.TryGetValue(key, out win) && win != null && !win.IsDisposed)
            {
                if (win.WindowState == FormWindowState.Minimized) win.WindowState = FormWindowState.Normal;
                win.Show();
                win.Activate();
                win.BringToFront();
                return;
            }

            win = new ConsoleWindow(url, key, title);
            OpenWindows[key] = win;
            win.Show();
        }

        ConsoleWindow(string url, string key, string title)
        {
            _url = url;
            _key = key;
            Text = Program.AppName + " · " + title;
            AutoScaleMode = AutoScaleMode.None;
            ClientSize = new Size(Program.Scale(1280), Program.Scale(860));
            MinimumSize = new Size(Program.Scale(900), Program.Scale(620));
            StartPosition = FormStartPosition.CenterScreen;
            BackColor = Color.FromArgb(11, 14, 20);
            Icon = Program.AppIcon;

            _cover = new Panel();
            _cover.Dock = DockStyle.Fill;
            _cover.BackColor = Color.FromArgb(11, 14, 20);

            var tip = new Label();
            tip.Text = "正在载入 " + title + "…";
            tip.ForeColor = Color.FromArgb(139, 149, 168);
            tip.Font = new Font("Microsoft YaHei UI", 10f);
            tip.AutoSize = true;
            tip.Location = new Point(40, 40);
            _cover.Controls.Add(tip);

            Controls.Add(_cover);

            Shown += delegate
            {
                UseDarkTitleBar();
                BuildWeb();
            };

            FormClosing += delegate(object s, FormClosingEventArgs e)
            {
                if (e.CloseReason == CloseReason.UserClosing)
                {
                    // 关掉只隐藏：下次打开是秒开，服务端状态也还在
                    e.Cancel = true;
                    Hide();
                }
            };
        }

        void BuildWeb()
        {
            if (_web != null) return;
            try
            {
                _web = new WebView2();
                _web.Dock = DockStyle.Fill;
                _web.DefaultBackgroundColor = Color.FromArgb(11, 14, 20);
                Controls.Add(_web);
                _web.BringToFront();

                _web.CoreWebView2InitializationCompleted += delegate(object s, CoreWebView2InitializationCompletedEventArgs e)
                {
                    if (!e.IsSuccess)
                    {
                        Fail(e.InitializationException == null ? "初始化失败" : e.InitializationException.Message);
                        return;
                    }
                    var core = _web.CoreWebView2;
                    core.Settings.AreDefaultContextMenusEnabled = false;
                    core.Settings.IsStatusBarEnabled = false;
                    core.Settings.IsZoomControlEnabled = false;
                    core.Settings.AreDevToolsEnabled = Program.PreviewMode;

                    core.NavigationCompleted += delegate(object s2, CoreWebView2NavigationCompletedEventArgs e2)
                    {
                        if (e2.IsSuccess && _cover != null)
                        {
                            _cover.Visible = false;
                        }
                        else if (!e2.IsSuccess)
                        {
                            Fail("页面载入失败：" + e2.WebErrorStatus + "（服务没起来？）");
                        }
                    };

                    try { _web.Source = new Uri(_url); }
                    catch (Exception ex) { Fail(ex.Message); }
                };

                _web.EnsureCoreWebView2Async(null);
            }
            catch (Exception ex)
            {
                Fail(ex.Message);
            }
        }

        void Fail(string message)
        {
            if (_failed) return;
            _failed = true;
            Program.Log("控制台窗口失败：" + message);
            if (_web != null) _web.Visible = false;

            if (_cover == null || _cover.IsDisposed) return;
            _cover.Visible = true;
            _cover.Controls.Clear();

            var title = new Label();
            title.Text = "控制台没能载入";
            title.Font = new Font("Microsoft YaHei UI", 14f, FontStyle.Bold);
            title.ForeColor = Color.FromArgb(233, 238, 249);
            title.AutoSize = true;
            title.Location = new Point(40, 40);
            _cover.Controls.Add(title);

            var desc = new Label();
            desc.Text = message + "\n\n可以先用浏览器打开：" + _url;
            desc.Font = new Font("Microsoft YaHei UI", 9.5f);
            desc.ForeColor = Color.FromArgb(139, 149, 168);
            desc.MaximumSize = new Size(720, 0);
            desc.AutoSize = true;
            desc.Location = new Point(42, 80);
            _cover.Controls.Add(desc);

            var open = new Button();
            open.Text = "用浏览器打开";
            open.Location = new Point(42, 150);
            open.Size = new Size(140, 38);
            open.FlatStyle = FlatStyle.Flat;
            open.ForeColor = Color.White;
            open.BackColor = Color.FromArgb(99, 102, 241);
            open.FlatAppearance.BorderColor = Color.FromArgb(99, 102, 241);
            open.Cursor = Cursors.Hand;
            open.Click += delegate
            {
                try { Process.Start(_url); } catch { }
            };
            _cover.Controls.Add(open);
        }

        void UseDarkTitleBar()
        {
            try
            {
                int flag = 1;
                // 20 = DWMWA_USE_IMMERSIVE_DARK_MODE（Win10 20H1+），19 是老版本
                if (DwmSetWindowAttribute(Handle, 20, ref flag, sizeof(int)) != 0)
                    DwmSetWindowAttribute(Handle, 19, ref flag, sizeof(int));
            }
            catch { }
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing) OpenWindows.Remove(_key);
            base.Dispose(disposing);
        }
    }
}
