// YF-Robot 托盘启动器（C# 5，系统自带 csc 编译，无第三方依赖）
//
// 功能：
//   · 单实例（Mutex），重复双击静默退出
//   · 启动时服务没跑就自动拉起（不显示控制台）
//   · 图标随状态变色：绿=运行中 / 灰=已停止 / 黄=重启中
//   · 服务意外退出自动拉起（最多 3 次，间隔 ≥15 秒）
//   · 菜单：版本/端口、打开控制台、查看日志、重启服务、数据目录、开机自启、退出
//   · 动作记 data\tray.log
using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Management;
using System.Net;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;
using Microsoft.Web.WebView2.WinForms;
using Microsoft.Web.WebView2.Core;

namespace YFRobot
{
    static class Program
    {
        public const string AppName = "YF-Robot";
        public static string Root;
        public static string LogFile;

        [STAThread]
        static void Main(string[] args)
        {
            bool created;
            using (var mutex = new Mutex(true, "YF-Robot-Tray-Exe", out created))
            {
                if (!created)
                {
                    /**
                     * 已经有实例在跑。以前这里直接 return，用户会觉得"双击没反应"
                     * （尤其是第一个实例已经缩到托盘的时候）。
                     * 现在通知它把窗口显示出来。
                     */
                    try
                    {
                        using (var ev = EventWaitHandle.OpenExisting("YF-Robot-Show"))
                            ev.Set();
                    }
                    catch { }
                    return;
                }

                Root = FindRoot();
                if (Root == null)
                {
                    MessageBox.Show("找不到程序目录（config.json 所在文件夹）。", AppName);
                    return;
                }
                LogFile = Path.Combine(Root, "data", "tray.log");

                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                var silent = false;
                foreach (var a in args)
                {
                    if (string.Equals(a, "--silent", StringComparison.OrdinalIgnoreCase)) silent = true;
                }

                var ctx = new TrayContext(silent);
                if (silent) { Application.Run(ctx); }
                else
                {
                    try
                    {
                        Program.Log("启动器窗口已打开");
                        var form = new MainForm(ctx);

                        // 第二次双击时，把已有窗口调出来（而不是再开一个进程）
                        var showEvent = new EventWaitHandle(false, EventResetMode.AutoReset, "YF-Robot-Show");
                        var listener = new System.Threading.Thread(delegate()
                        {
                            while (true)
                            {
                                showEvent.WaitOne();
                                try
                                {
                                    form.BeginInvoke(new Action(delegate()
                                    {
                                        form.Show();
                                        if (form.WindowState == FormWindowState.Minimized)
                                            form.WindowState = FormWindowState.Normal;
                                        form.Activate();
                                        form.BringToFront();
                                    }));
                                }
                                catch { }
                            }
                        });
                        listener.IsBackground = true;
                        listener.Start();

                        Application.Run(form);
                    }
                    catch (Exception ex)
                    {
                        Program.Log("界面初始化失败：" + ex);
                        MessageBox.Show("界面初始化失败：" + ex.Message, Program.AppName);
                        Application.Run(ctx);
                    }
                }
            }
        }

        static string FindRoot()
        {
            var dir = new DirectoryInfo(AppDomain.CurrentDomain.BaseDirectory);
            for (int i = 0; i < 3 && dir != null; i++)
            {
                if (File.Exists(Path.Combine(dir.FullName, "config.json"))) return dir.FullName;
                dir = dir.Parent;
            }
            return null;
        }

        /// <summary>托盘日志：只留最近 300 行。</summary>
        public static void Log(string msg)
        {
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(LogFile));
                var lines = new System.Collections.Generic.List<string>();
                if (File.Exists(LogFile))
                {
                    lines.AddRange(File.ReadAllLines(LogFile, Encoding.UTF8));
                    if (lines.Count > 300) lines.RemoveRange(0, lines.Count - 300);
                }
                lines.Add(DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "  " + msg);
                File.WriteAllLines(LogFile, lines, new UTF8Encoding(false));
            }
            catch { }
        }
    }

    class TrayContext : ApplicationContext
    {
        readonly NotifyIcon _tray;
        readonly System.Windows.Forms.Timer _timer;
        readonly Icon _iconUp, _iconDown, _iconBusy;
        readonly string _version;
        int _port = 8899;
        int _autoRestarts;
        DateTime _lastRestart = DateTime.Now.AddHours(-1);
        bool? _wasUp;
        bool _exiting;
        readonly bool OpenOnStart;

        public string BaseUrlOut { get { return BaseUrl(); } }
        public string VersionText { get { return _version; } }
        public int PortText { get { return _port; } }
        public bool ServiceUp { get { return IsServiceUp(); } }
        public void StartSvc() { EnsureService(true); }
        public void StopSvc() { StopService(); }
        public void DoRestart() { RestartService(); }
        public void DoBackup() { BackupMemory(); }
        public void DoRestore() { RestoreLatest(); }
        public void OpenConsole() { OpenAppWindow("/console"); }

        /// <summary>用系统默认浏览器打开（用户明确要网页版时用）。</summary>
        public void OpenInBrowser()
        {
            try { Process.Start(BaseUrl() + "/console"); }
            catch (Exception ex) { MessageBox.Show("打不开浏览器：" + ex.Message, Program.AppName); }
        }
        public void OpenChat() { OpenAppWindow("/"); }
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
                req.Timeout = 4000;
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
                req.Timeout = 8000;
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

        /// <summary>本机令牌文件 data/token.txt。</summary>
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
            // 窗口「缩到托盘」时给个提示
            _tray.ShowBalloonTip(2000, Program.AppName, "已缩到托盘，双击图标可再打开面板", ToolTipIcon.Info);
        }

        public TrayContext(bool silent)
        {
            OpenOnStart = !silent;
            _version = ReadVersion();
            _port = ReadPort();

            _iconUp = BuildIcon(Color.FromArgb(46, 160, 67));
            _iconDown = BuildIcon(Color.FromArgb(128, 128, 128));
            _iconBusy = BuildIcon(Color.FromArgb(214, 158, 46));

            _tray = new NotifyIcon();
            _tray.Icon = _iconDown;
            _tray.Text = Program.AppName + " v" + _version;
            _tray.Visible = true;
            _tray.DoubleClick += delegate { OpenConsole(); };
            _tray.ContextMenuStrip = BuildMenu();

            Program.Log("托盘启动（版本 " + _version + "，端口 " + _port + "）");
            EnsureService(false);

            // 第一次显示气泡：否则图标若在托盘溢出区，用户会以为"运行了但什么都没发生"
            // 启动即打开面板：纯托盘程序用户会以为"运行了但什么都没有"
            if (OpenOnStart) StartWindowWhenReady();

            _tray.ShowBalloonTip(3500, Program.AppName + " 已启动",
                "右键托盘图标可以打开控制台 / 重启服务 / 退出。双击直接开控制台。",
                ToolTipIcon.Info);

            _timer = new System.Windows.Forms.Timer();
            _timer.Interval = 5000;
            _timer.Tick += delegate { UpdateState(); };
            _timer.Start();

            UpdateState();
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
            _tray.Icon = _iconBusy;
            _tray.Text = Program.AppName + " · 重启中…";
            Program.Log("手动重启服务");
            StopService();
            Thread.Sleep(1200);
            EnsureService(true);
            Thread.Sleep(1500);
            UpdateState();
        }

        // ---------- 状态 ----------

        void UpdateState()
        {
            bool up = IsServiceUp();

            if (_wasUp.HasValue && _wasUp.Value != up)
                Program.Log("[state] " + _wasUp.Value + " -> " + up);

            if (up)
            {
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

                // 服务意外退出：自动拉起，最多 3 次，间隔 ≥15 秒
                if (_wasUp.HasValue && _wasUp.Value && _autoRestarts < 3)
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

            m.Items.Add("打开控制台", null, delegate { OpenConsole(); });

            m.Items.Add("聊天窗口", null, delegate { OpenAppWindow("/"); });

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
                _exiting = true;
                _timer.Stop();
                StopService();
                _tray.Visible = false;
                Application.Exit();
            });

            return m;
        }

        /// <summary>
        /// 打开控制台。
        ///
        /// 用 Edge/Chrome 的 --app 模式：没有地址栏和标签页，看起来像独立软件，
        /// 而不是"在浏览器里开了个网页"。都没有时才退回默认浏览器。
        /// </summary>
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

        void BackupMemory()
        {
            Program.Log("手动备份记忆");
            var outText = RunNode("tools\\memory-tool.mjs export", 60000);
            Program.Log("备份结果：" + outText.Replace("\r", "").Replace("\n", " | "));
            _tray.ShowBalloonTip(3000, Program.AppName + " · 记忆已备份",
                FirstLine(outText), ToolTipIcon.Info);
            MessageBox.Show(outText, "备份记忆", MessageBoxButtons.OK, MessageBoxIcon.Information);
        }

        void RestoreLatest()
        {
            var list = RunNode("tools\\memory-tool.mjs list", 60000);
            if (MessageBox.Show("要从最近的备份恢复吗？\n\n当前记忆和会话会被覆盖（备份本身不会删）。\n\n" + FirstLine(list),
                    "恢复记忆", MessageBoxButtons.YesNo, MessageBoxIcon.Warning) != DialogResult.Yes) return;

            Program.Log("从最近备份恢复记忆");
            var outText = RunNode("tools\\memory-tool.mjs restore --latest", 120000);
            Program.Log("恢复结果：" + outText.Replace("\r", "").Replace("\n", " | "));
            MessageBox.Show(outText, "恢复记忆", MessageBoxButtons.OK, MessageBoxIcon.Information);
        }

        static string FirstLine(string text)
        {
            if (string.IsNullOrEmpty(text)) return "";
            var i = text.IndexOf('\n');
            var line = i < 0 ? text : text.Substring(0, i);
            return line.Trim();
        }

        /// <summary>后台等服务就绪，然后打开面板窗口（用户双击后能立刻看到东西）。</summary>
        void StartWindowWhenReady()
        {
            var t = new System.Threading.Thread(delegate()
            {
                for (int i = 0; i < 40; i++) // 最多 20 秒
                {
                    if (IsServiceUp()) break;
                    System.Threading.Thread.Sleep(500);
                }
                try
                {
                    var mi = _tray.ContextMenuStrip;
                    // 直接用内部方法打开（与菜单同一套逻辑）
                    OpenAppWindow("/console");
                }
                catch (Exception ex) { Program.Log("启动时打开面板失败：" + ex.Message); }
            });
            t.IsBackground = true;
            t.Start();
        }



        /// <summary>用浏览器应用窗口打开某个路径（无地址栏，像独立软件）。</summary>
        void OpenAppWindow(string pathPart)
        {
            // 服务没起来就开窗口会白屏：先等一会儿
            for (int i = 0; i < 30 && !IsServiceUp(); i++) System.Threading.Thread.Sleep(500);
            var url = BaseUrl() + pathPart;
            var candidates = new[]
            {
                Environment.ExpandEnvironmentVariables(@"%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"),
                Environment.ExpandEnvironmentVariables(@"%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"),
                Environment.ExpandEnvironmentVariables(@"%ProgramFiles%\Google\Chrome\Application\chrome.exe"),
                Environment.ExpandEnvironmentVariables(@"%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"),
            };

            foreach (var exe in candidates)
            {
                if (!File.Exists(exe)) continue;
                try
                {
                    // 单独的 profile 目录：不影响用户自己的浏览器会话
                    var profile = Path.Combine(Program.Root, "data", "ui-profile");
                    Directory.CreateDirectory(profile);
                    var psi = new ProcessStartInfo();
                    psi.FileName = exe;
                    psi.Arguments = "--app=" + url + " --window-size=1280,860 --no-first-run --no-default-browser-check"
                                   + " --user-data-dir=\"" + profile + "\"";
                    psi.UseShellExecute = false;
                    Process.Start(psi);
                    return;
                }
                catch (Exception ex) { Program.Log("用应用窗口打开失败：" + ex.Message); }
            }

            try { Process.Start(url); }
            catch (Exception ex)
            {
                MessageBox.Show("打不开控制台：" + ex.Message + "\n服务是不是还没起来？", Program.AppName);
            }
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

        // ---------- 图标 ----------

        static Icon BuildIcon(Color color)
        {
            var bmp = new Bitmap(32, 32);
            using (var g = Graphics.FromImage(bmp))
            {
                g.SmoothingMode = SmoothingMode.AntiAlias;
                g.Clear(Color.Transparent);
                using (var b = new SolidBrush(color)) g.FillEllipse(b, 1, 1, 30, 30);
                using (var f = new Font("Segoe UI", 16, FontStyle.Bold, GraphicsUnit.Pixel))
                using (var w = new SolidBrush(Color.White))
                {
                    var size = g.MeasureString("Y", f);
                    g.DrawString("Y", f, w, (32 - size.Width) / 2, (32 - size.Height) / 2);
                }
            }
            return Icon.FromHandle(bmp.GetHicon());
        }
    }

    /// <summary>
    /// 启动器主窗口：左侧导航 + 右侧内容。
    ///
    /// 之前用标签页，观感更像"设置对话框"；改成侧栏后更接近常见的桌面应用
    /// （概览 / 插件 / 市场 / 设置），网页控制台仍然只是其中一个入口。
    /// </summary>
    class MainForm : Form
    {
        readonly TrayContext _ctx;
        readonly System.Windows.Forms.Timer _timer;

        Panel _content;
        readonly System.Collections.Generic.List<Label> _nav = new System.Collections.Generic.List<Label>();
        int _page;

        // 概览
        Label _svcDot, _svcText, _adpDot, _adpText;
        // 插件
        ListView _plist;
        Label _pHint;
        // 市场
        ListView _mlist;
        Label _mHint;
        // 设置
        CheckBox _auto;
        Label _updText;

        static readonly Color Bg = Color.FromArgb(10, 13, 20);
        static readonly Color Side = Color.FromArgb(14, 18, 27);
        static readonly Color Card = Color.FromArgb(20, 25, 36);
        static readonly Color Brd = Color.FromArgb(38, 46, 63);
        static readonly Color Txt = Color.FromArgb(232, 237, 247);
        static readonly Color DimC = Color.FromArgb(135, 146, 166);
        static readonly Color Acc = Color.FromArgb(99, 102, 241);
        static readonly Color Green = Color.FromArgb(52, 211, 153);
        static readonly Color Red = Color.FromArgb(251, 113, 133);

        static readonly string[] Pages = { "控制台", "聊天", "概览", "插件", "市场", "设置" };
        static readonly string[] PageIcons = { "▤", "✎", "◎", "⬡", "⇩", "⚙" };

        public MainForm(TrayContext ctx)
        {
            _ctx = ctx;
            Text = "YF-Robot";
            ClientSize = new Size(788, 556);
            StartPosition = FormStartPosition.CenterScreen;
            // 无边框：自绘标题栏，观感更接近现代启动器
            FormBorderStyle = FormBorderStyle.None;
            MinimumSize = new Size(900, 620);
            Icon = IconFromText("Y", Color.FromArgb(99, 102, 241));
            DoubleBuffered = true;
            Padding = new Padding(1);
            BackColor = Bg;
            ForeColor = Txt;
            Font = new Font("Microsoft YaHei UI", 9f);

            // 注意顺序：Fill 的面板要先加，Dock.Left 的侧栏后加，
            // 否则 Fill 会把侧栏盖住（WinForms 按反向 z 序排版）。
            var bar = BuildTitleBar();
            Controls.Add(bar);

            var body = new Panel();
            body.Dock = DockStyle.Fill;
            body.BackColor = Bg;
            Controls.Add(body);

            _content = new Panel();
            _content.Dock = DockStyle.Fill;
            _content.BackColor = Bg;
            body.Controls.Add(_content);

            BuildSidebar(body);

            ShowPage(0);

            _timer = new System.Windows.Forms.Timer();
            _timer.Interval = 3000;
            _timer.Tick += delegate { if (_page == 2) RefreshOverview(); };
            _timer.Start();

            Resize += delegate { RoundCorners(); };
            Shown += delegate { RoundCorners(); };

            FormClosing += delegate(object s2, FormClosingEventArgs e2)
            {
                if (e2.CloseReason == CloseReason.UserClosing)
                {
                    e2.Cancel = true;
                    Hide();
                    ShowInTaskbar = false;
                    _ctx.ShowTrayMenu();
                }
            };
        }

        // ================= 无边框窗口 =================
        [System.Runtime.InteropServices.DllImport("user32.dll")]
        static extern bool ReleaseCapture();
        [System.Runtime.InteropServices.DllImport("user32.dll")]
        static extern IntPtr SendMessage(IntPtr hWnd, int msg, int wParam, int lParam);

        const int WM_NCLBUTTONDOWN = 0xA1;
        const int HTCAPTION = 0x2;
        const int WM_NCHITTEST = 0x84;
        const int HTLEFT = 10, HTRIGHT = 11, HTTOP = 12, HTTOPLEFT = 13,
                  HTTOPRIGHT = 14, HTBOTTOM = 15, HTBOTTOMLEFT = 16, HTBOTTOMRIGHT = 17;

        void DragWindow()
        {
            ReleaseCapture();
            SendMessage(Handle, WM_NCLBUTTONDOWN, HTCAPTION, 0);
        }

        /// <summary>无边框窗口默认不能拖边缘缩放，这里自己算命中区域。</summary>
        protected override void WndProc(ref Message m)
        {
            if (m.Msg == WM_NCHITTEST)
            {
                base.WndProc(ref m);
                var p = PointToClient(new Point(m.LParam.ToInt32() & 0xFFFF, m.LParam.ToInt32() >> 16));
                const int g = 6;
                bool l = p.X <= g, r = p.X >= ClientSize.Width - g;
                bool t = p.Y <= g, b = p.Y >= ClientSize.Height - g;
                if (t && l) m.Result = (IntPtr)HTTOPLEFT;
                else if (t && r) m.Result = (IntPtr)HTTOPRIGHT;
                else if (b && l) m.Result = (IntPtr)HTBOTTOMLEFT;
                else if (b && r) m.Result = (IntPtr)HTBOTTOMRIGHT;
                else if (l) m.Result = (IntPtr)HTLEFT;
                else if (r) m.Result = (IntPtr)HTRIGHT;
                else if (t) m.Result = (IntPtr)HTTOP;
                else if (b) m.Result = (IntPtr)HTBOTTOM;
                return;
            }
            base.WndProc(ref m);
        }

        /// <summary>圆角窗口（改尺寸时重算）。</summary>
        void RoundCorners()
        {
            try
            {
                var path = new System.Drawing.Drawing2D.GraphicsPath();
                int r = 14;
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

        /// <summary>自绘标题栏：拖动 + 最小化/最大化/关闭。</summary>
        Panel BuildTitleBar()
        {
            var bar = new Panel();
            bar.Dock = DockStyle.Top;
            bar.Height = 44;
            bar.BackColor = Side;
            bar.MouseDown += delegate(object s2, MouseEventArgs e2) { if (e2.Button == MouseButtons.Left) DragWindow(); };

            var dot = new Label();
            dot.Text = "◉";
            dot.Font = new Font("Segoe UI", 11f);
            dot.ForeColor = Acc;
            dot.Location = new Point(16, 12);
            dot.AutoSize = true;
            dot.MouseDown += delegate(object s2, MouseEventArgs e2) { if (e2.Button == MouseButtons.Left) DragWindow(); };
            bar.Controls.Add(dot);

            var t = new Label();
            t.Text = "YF-Robot";
            t.Font = new Font("Microsoft YaHei UI", 9.5f, FontStyle.Bold);
            t.ForeColor = Txt;
            t.Location = new Point(38, 13);
            t.AutoSize = true;
            t.MouseDown += delegate(object s2, MouseEventArgs e2) { if (e2.Button == MouseButtons.Left) DragWindow(); };
            bar.Controls.Add(t);

            var min = TitleButton("—", bar);
            var max = TitleButton("□", bar);
            var close = TitleButton("✕", bar);
            min.Click += delegate { WindowState = FormWindowState.Minimized; };
            max.Click += delegate
            {
                WindowState = WindowState == FormWindowState.Maximized
                    ? FormWindowState.Normal : FormWindowState.Maximized;
            };
            close.Click += delegate
            {
                Hide();
                ShowInTaskbar = false;
                _ctx.ShowTrayMenu();
            };
            close.MouseEnter += delegate { close.BackColor = Color.FromArgb(196, 43, 28); };
            close.MouseLeave += delegate { close.BackColor = Side; };

            // 从右往左排
            int right = 8;
            foreach (var b in new[] { close, max, min })
            {
                b.Location = new Point(bar.Width - right - 40, 8);
                right += 44;
                b.Anchor = AnchorStyles.Top | AnchorStyles.Right;
            }
            bar.Resize += delegate
            {
                int rr = 8;
                foreach (var b in new[] { close, max, min })
                {
                    b.Location = new Point(bar.Width - rr - 40, 8);
                    rr += 44;
                }
            };
            return bar;
        }

        Label TitleButton(string text, Control bar)
        {
            var b = new Label();
            b.Text = text;
            b.Size = new Size(40, 28);
            b.ForeColor = DimC;
            b.TextAlign = ContentAlignment.MiddleCenter;
            b.Font = new Font("Segoe UI", 10f);
            b.Cursor = Cursors.Hand;
            bar.Controls.Add(b);
            b.MouseEnter += delegate { b.BackColor = Color.FromArgb(28, 34, 48); b.ForeColor = Txt; };
            b.MouseLeave += delegate { b.BackColor = Side; b.ForeColor = DimC; };
            return b;
        }

        // ================= 侧栏 =================
        void BuildSidebar(Control host)
        {
            var side = new Panel();
            side.Dock = DockStyle.Left;
            side.Width = 176;
            side.BackColor = Side;
            side.Paint += delegate(object s3, PaintEventArgs e3)
            {
                using (var pen = new Pen(Brd))
                    e3.Graphics.DrawLine(pen, side.Width - 1, 0, side.Width - 1, side.Height);
            };
            host.Controls.Add(side);

            var logo = new Label();
            logo.Text = "◉";
            logo.Font = new Font("Segoe UI", 17f);
            logo.ForeColor = Acc;
            logo.Location = new Point(18, 20);
            logo.AutoSize = true;
            side.Controls.Add(logo);

            var name = new Label();
            name.Text = "YF-Robot";
            name.Font = new Font("Microsoft YaHei UI", 11.5f, FontStyle.Bold);
            name.ForeColor = Txt;
            name.Location = new Point(44, 24);
            name.AutoSize = true;
            side.Controls.Add(name);

            var ver = new Label();
            ver.Text = "v" + _ctx.VersionText;
            ver.ForeColor = DimC;
            ver.Font = new Font("Microsoft YaHei UI", 8f);
            ver.Location = new Point(46, 46);
            ver.AutoSize = true;
            side.Controls.Add(ver);

            for (int i = 0; i < Pages.Length; i++)
            {
                var idx = i;
                var item = new Label();
                item.Text = PageIcons[i] + "   " + Pages[i];
                item.Font = new Font("Microsoft YaHei UI", 10f);
                item.ForeColor = DimC;
                item.Location = new Point(0, 92 + i * 40);
                item.Size = new Size(176, 36);
                item.TextAlign = ContentAlignment.MiddleLeft;
                item.Padding = new Padding(24, 0, 0, 0);
                item.Cursor = Cursors.Hand;
                item.Click += delegate { ShowPage(idx); };
                item.MouseEnter += delegate { if (idx != _page) item.BackColor = Color.FromArgb(22, 27, 38); };
                item.MouseLeave += delegate { if (idx != _page) item.BackColor = Side; };
                side.Controls.Add(item);
                _nav.Add(item);
            }

            var foot = new Label();
            foot.Text = "端口 " + _ctx.PortText + "　·　本地面板";
            foot.ForeColor = Color.FromArgb(90, 99, 116);
            foot.Font = new Font("Microsoft YaHei UI", 8f);
            foot.Location = new Point(20, side.Height - 30);
            foot.Anchor = AnchorStyles.Left | AnchorStyles.Bottom;
            foot.AutoSize = true;
            side.Controls.Add(foot);
        }

        void ShowPage(int index)
        {
            _page = index;
            for (int i = 0; i < _nav.Count; i++)
            {
                var on = i == index;
                _nav[i].ForeColor = on ? Txt : DimC;
                _nav[i].Font = new Font("Microsoft YaHei UI", 10f, on ? FontStyle.Bold : FontStyle.Regular);
                _nav[i].BackColor = on ? Color.FromArgb(24, 29, 42) : Side;
            }

            _content.Controls.Clear();
            switch (index)
            {
                case 0: BuildWeb(_content, "/console?embed=1"); break;
                case 1: BuildWeb(_content, "/"); break;
                case 2: BuildOverview(_content); break;
                case 3: BuildPlugins(_content); break;
                case 4: BuildMarket(_content); break;
                default: BuildSettings(_content); break;
            }
            _content.Refresh();
        }

        // ================= 控制台（内嵌网页） =================
        WebView2 _web;

        /// <summary>
        /// 把网页控制台嵌进窗口。
        ///
        /// 之前是另开一个 Edge 应用窗口，观感割裂、还容易白屏；
        /// 本机自带 WebView2 运行时，直接嵌进来即可。
        /// </summary>
        void BuildWeb(Panel page, string path)
        {
            try
            {
                // 用户数据放到 data/ 下，别乱写到 desktop/（那是源码目录）
                Environment.SetEnvironmentVariable("WEBVIEW2_USER_DATA_FOLDER", Path.Combine(Program.Root, "data", "webview2"));
                _web = new WebView2();
                _web.Dock = DockStyle.Fill;
                page.Controls.Add(_web);

                _web.CoreWebView2InitializationCompleted += delegate(object s3, CoreWebView2InitializationCompletedEventArgs e3)
                {
                    if (!e3.IsSuccess) return;
                    _web.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
                    _web.CoreWebView2.Settings.IsStatusBarEnabled = false;
                    // 记住上次滚动位置会让人以为页面缺了头部，导航完回到顶部
                    _web.NavigationCompleted += delegate(object s4, CoreWebView2NavigationCompletedEventArgs e4)
                    {
                        try { _web.ExecuteScriptAsync("window.scrollTo(0,0)"); } catch { }
                    };
                    try { _web.Source = new Uri(_ctx.BaseUrlOut + path); } catch { }
                };

                // 初始化是异步的：先发起，完成后在回调里导航
                _web.EnsureCoreWebView2Async(null);
            }
            catch (Exception ex)
            {
                var tip = new Label();
                tip.Text = "内嵌浏览器起不来：" + ex.Message + "\n\n点左侧「概览」→「网页版（浏览器）」照样能用。";
                tip.ForeColor = DimC;
                tip.Dock = DockStyle.Fill;
                tip.TextAlign = ContentAlignment.MiddleCenter;
                page.Controls.Add(tip);
                Program.Log("WebView2 初始化失败：" + ex.Message);
            }
        }

        // ================= 概览 =================
        void BuildOverview(Panel page)
        {
            Header(page, "概览", "服务状态与常用操作");

            var card = Card2(24, 84, 560, 92);
            page.Controls.Add(card);

            _svcDot = Dot(20, 20, card);
            _svcText = Line(44, 22, "服务：检查中…", card, Txt);
            _adpDot = Dot(20, 54, card);
            _adpText = Line(44, 56, "适配器：检查中…", card, DimC);

            Section(page, "服务", 24, 192);
            Btn(page, "打开控制台", 24, 218, 176, delegate { ShowPage(0); }, true);
            Btn(page, "聊天窗口", 208, 218, 176, delegate { ShowPage(1); }, false);
            Btn(page, "重启服务", 392, 218, 192, delegate { _ctx.DoRestart(); }, false);

            Btn(page, "停止服务", 24, 262, 176, delegate { StopAll(); }, false);
            Btn(page, "查看日志", 208, 262, 176, delegate { _ctx.OpenLogs(); }, false);
            Btn(page, "数据目录", 392, 262, 192, delegate { _ctx.OpenDataDir(); }, false);

            Section(page, "记忆", 24, 316);
            Btn(page, "网页版（浏览器）", 24, 342, 560, delegate { _ctx.OpenInBrowser(); }, false);
            Btn(page, "备份记忆", 24, 390, 268, delegate { _ctx.DoBackup(); }, false);
            Btn(page, "恢复最近备份…", 300, 390, 284, delegate { _ctx.DoRestore(); }, false);

            RefreshOverview();
        }

        void StopAll()
        {
            if (MessageBox.Show("停止服务会让聊天中断，确定？", "YF-Robot",
                    MessageBoxButtons.YesNo, MessageBoxIcon.Question) != DialogResult.Yes) return;
            _ctx.StopSvc();
            RefreshOverview();
        }

        void RefreshOverview()
        {
            if (_svcText == null || _svcText.IsDisposed) return;
            var up = _ctx.ServiceUp;
            _svcDot.ForeColor = up ? Green : Red;
            _svcText.Text = up ? "服务：运行中　127.0.0.1:" + _ctx.PortText : "服务：未运行";
            _svcText.ForeColor = up ? Txt : Red;

            var adp = _ctx.AdapterOnline();
            if (adp == null)
            {
                _adpDot.ForeColor = DimC;
                _adpText.Text = up ? "适配器：未接入（只影响微信收发）" : "适配器：未知（服务未就绪）";
            }
            else if (adp.Value)
            {
                _adpDot.ForeColor = Green;
                _adpText.Text = "适配器：已接入";
            }
            else
            {
                _adpDot.ForeColor = DimC;
                _adpText.Text = "适配器：未接入（只影响微信收发）";
            }
        }

        // ================= 插件 =================
        void BuildPlugins(Panel page)
        {
            Header(page, "插件", "放在 plugins/ 目录下的扩展");

            var bar = new Panel();
            bar.Location = new Point(24, 84);
            bar.Size = new Size(560, 40);
            bar.BackColor = Bg;
            page.Controls.Add(bar);

            Btn(bar, "刷新", 0, 0, 88, delegate { LoadPlugins(); }, false);
            Btn(bar, "启用 / 禁用", 96, 0, 112, delegate { TogglePlugin(); }, false);
            Btn(bar, "插件目录", 216, 0, 104, delegate { _ctx.OpenFolder(Path.Combine(Program.Root, "plugins")); }, false);

            _plist = new ListView();
            _plist.Location = new Point(24, 132);
            _plist.Size = new Size(560, 352);
            _plist.View = View.Details;
            _plist.FullRowSelect = true;
            _plist.BackColor = Card;
            _plist.ForeColor = Txt;
            _plist.BorderStyle = BorderStyle.None;
            _plist.Columns.Add("名称", 290);
            _plist.Columns.Add("版本", 70);
            _plist.Columns.Add("状态", 80);
            _plist.Columns.Add("工具", 120);
            page.Controls.Add(_plist);

            _pHint = new Label();
            _pHint.Location = new Point(24, 492);
            _pHint.Size = new Size(560, 40);
            _pHint.ForeColor = DimC;
            _pHint.Text = " ";
            page.Controls.Add(_pHint);

            LoadPlugins();
        }

        void LoadPlugins()
        {
            if (_plist == null || _plist.IsDisposed) return;
            _plist.Items.Clear();
            var json = _ctx.ApiGet("/api/admin/plugins");
            if (json == null)
            {
                _pHint.Text = "读不到插件列表（服务没起来？）";
                return;
            }
            foreach (var obj in JsonObjects(json, "plugins"))
            {
                var name = JStr(obj, "name");
                var item = new ListViewItem(string.IsNullOrEmpty(name) ? JStr(obj, "id") : name);
                item.SubItems.Add(JStr(obj, "version"));
                var st = JStr(obj, "state");
                item.SubItems.Add(st == "loaded" ? "已启用" : (string.IsNullOrEmpty(st) ? "未加载" : st));
                item.SubItems.Add(JStr(obj, "tools"));
                item.Tag = JStr(obj, "id");
                _plist.Items.Add(item);
            }
            _pHint.Text = _plist.Items.Count == 0
                ? "还没有插件。把插件文件夹放到 plugins/ 下，然后点刷新。"
                : "共 " + _plist.Items.Count + " 个插件；启停后需要重启服务生效。";
        }

        void TogglePlugin()
        {
            if (_plist.SelectedItems.Count == 0) { MessageBox.Show("先选中一个插件", "YF-Robot"); return; }
            var id = Convert.ToString(_plist.SelectedItems[0].Tag);
            var cur = _plist.SelectedItems[0].SubItems[2].Text == "已启用";
            var r = _ctx.ApiPost("/api/admin/plugins/toggle",
                "{\"id\":\"" + id + "\",\"enabled\":" + (cur ? "false" : "true") + "}");
            if (r == null) { MessageBox.Show("操作失败（服务没起来？）", "YF-Robot"); return; }
            LoadPlugins();
        }

        // ================= 市场 =================
        void BuildMarket(Panel page)
        {
            Header(page, "市场", "从 market\\index.json 读取可安装插件");

            var bar = new Panel();
            bar.Location = new Point(24, 84);
            bar.Size = new Size(560, 40);
            bar.BackColor = Bg;
            page.Controls.Add(bar);

            Btn(bar, "刷新列表", 0, 0, 96, delegate { LoadMarket(); }, false);
            Btn(bar, "安装选中", 104, 0, 96, delegate { InstallSelected(); }, true);
            Btn(bar, "编辑索引", 208, 0, 96, delegate
            {
                var f = Path.Combine(Program.Root, "market", "index.json");
                if (File.Exists(f)) Process.Start("notepad.exe", "\"" + f + "\"");
                else MessageBox.Show("还没有索引文件：\n" + f, "YF-Robot");
            }, false);

            _mlist = new ListView();
            _mlist.Location = new Point(24, 132);
            _mlist.Size = new Size(560, 330);
            _mlist.View = View.Details;
            _mlist.FullRowSelect = true;
            _mlist.BackColor = Card;
            _mlist.ForeColor = Txt;
            _mlist.BorderStyle = BorderStyle.None;
            _mlist.Columns.Add("插件", 200);
            _mlist.Columns.Add("版本", 70);
            _mlist.Columns.Add("说明", 280);
            page.Controls.Add(_mlist);

            _mHint = new Label();
            _mHint.Location = new Point(24, 470);
            _mHint.Size = new Size(560, 62);
            _mHint.ForeColor = DimC;
            _mHint.Text = " ";
            page.Controls.Add(_mHint);

            LoadMarket();
        }

        void LoadMarket()
        {
            if (_mlist == null || _mlist.IsDisposed) return;
            _mlist.Items.Clear();

            var file = Path.Combine(Program.Root, "market", "index.json");
            if (!File.Exists(file))
            {
                _mHint.Text = "还没有市场索引。新建 market\\index.json，格式：\n" +
                              "{ \"items\": [ { \"id\":\"id\", \"name\":\"名字\", \"version\":\"1.0.0\", " +
                              "\"description\":\"说明\", \"download\":\"https://.../x.zip\" } ] }";
                return;
            }

            string json;
            try { json = File.ReadAllText(file, Encoding.UTF8); }
            catch (Exception ex) { _mHint.Text = "读索引失败：" + ex.Message; return; }

            foreach (var obj in JsonObjects(json, "items"))
            {
                var item = new ListViewItem(JStr(obj, "name"));
                item.SubItems.Add(JStr(obj, "version"));
                item.SubItems.Add(JStr(obj, "description"));
                item.Tag = JStr(obj, "download");
                _mlist.Items.Add(item);
            }
            _mHint.Text = _mlist.Items.Count == 0
                ? "索引里还没有插件"
                : "共 " + _mlist.Items.Count + " 个可安装插件（来源：market\\index.json）";
        }

        void InstallSelected()
        {
            if (_mlist.SelectedItems.Count == 0) { MessageBox.Show("先选中要安装的插件", "YF-Robot"); return; }
            var url = Convert.ToString(_mlist.SelectedItems[0].Tag);
            if (string.IsNullOrEmpty(url)) { MessageBox.Show("这一项没有下载地址", "YF-Robot"); return; }

            var dir = Path.Combine(Program.Root, "plugins");
            Directory.CreateDirectory(dir);
            var zip = Path.Combine(Path.GetTempPath(), "yf-plugin-" + DateTime.Now.Ticks + ".zip");

            try
            {
                var wc = new WebClient();
                wc.Proxy = null;
                wc.DownloadFile(new Uri(url), zip);
                System.IO.Compression.ZipFile.ExtractToDirectory(zip, dir);
                File.Delete(zip);
                MessageBox.Show("已解压到 plugins/。\n重启服务后生效（概览 → 重启服务）。", "YF-Robot");
                LoadPlugins();
            }
            catch (Exception ex)
            {
                MessageBox.Show("安装失败：" + ex.Message + "\n\n也可以手动把压缩包解压到 plugins/。", "YF-Robot");
            }
        }

        // ================= 设置 =================
        void BuildSettings(Panel page)
        {
            Header(page, "设置", "启动项与版本信息");

            _auto = new CheckBox();
            _auto.Text = "开机自动启动（只驻留托盘，不弹窗）";
            _auto.ForeColor = DimC;
            _auto.Location = new Point(24, 92);
            _auto.AutoSize = true;
            _auto.Checked = _ctx.AutoStartOn;
            _auto.CheckedChanged += delegate
            {
                try { _ctx.AutoStartOn = _auto.Checked; }
                catch { _auto.Checked = _ctx.AutoStartOn; }
            };
            page.Controls.Add(_auto);

            Section(page, "更新", 24, 136);
            Btn(page, "检查更新", 24, 162, 132, delegate { CheckUpdate(); }, false);
            _updText = new Label();
            _updText.Text = " ";
            _updText.ForeColor = DimC;
            _updText.Location = new Point(172, 172);
            _updText.AutoSize = true;
            page.Controls.Add(_updText);

            Section(page, "关于", 24, 212);
            var about = new Label();
            about.Text = "YF-Robot　v" + _ctx.VersionText + "\n"
                       + "本地面板不依赖浏览器，网页控制台是可选的。\n"
                       + "插件市场索引：market\\index.json（以后可换成远程地址）";
            about.ForeColor = DimC;
            about.Location = new Point(24, 238);
            about.AutoSize = true;
            page.Controls.Add(about);
        }

        void CheckUpdate()
        {
            _updText.Text = "检查中…";
            var json = _ctx.ApiGet("/api/admin/update/check");
            if (json == null) { _updText.Text = "检查失败（服务没起来？）"; return; }
            var local = JStr(json, "local");
            var latest = JStr(json, "latest");
            var has = json.IndexOf("\"hasUpdate\":true") >= 0;
            _updText.Text = has
                ? "有新版本：" + latest + "（当前 " + local + "）"
                : "已是最新（" + (string.IsNullOrEmpty(local) ? _ctx.VersionText : local) + "）";
        }

        /// <summary>画一个圆底字母图标（窗口/任务栏用）。</summary>
        static Icon IconFromText(string text, Color color)
        {
            var bmp = new Bitmap(32, 32);
            using (var g = Graphics.FromImage(bmp))
            {
                g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
                g.Clear(Color.Transparent);
                using (var b = new SolidBrush(color)) g.FillEllipse(b, 1, 1, 30, 30);
                using (var f = new Font("Segoe UI", 16, FontStyle.Bold, GraphicsUnit.Pixel))
                using (var w = new SolidBrush(Color.White))
                {
                    var size = g.MeasureString(text, f);
                    g.DrawString(text, f, w, (32 - size.Width) / 2, (32 - size.Height) / 2);
                }
            }
            return Icon.FromHandle(bmp.GetHicon());
        }

        // ================= 小工具 =================
        void Header(Control parent, string title, string sub)
        {
            var t = new Label();
            t.Text = title;
            t.Font = new Font("Microsoft YaHei UI", 15f, FontStyle.Bold);
            t.ForeColor = Txt;
            t.Location = new Point(24, 24);
            t.AutoSize = true;
            parent.Controls.Add(t);

            var d = new Label();
            d.Text = sub;
            d.ForeColor = DimC;
            d.Location = new Point(26, 56);
            d.AutoSize = true;
            parent.Controls.Add(d);
        }

        Panel Card2(int x, int y, int w, int h)
        {
            var p = new Panel();
            p.Location = new Point(x, y);
            p.Size = new Size(w, h);
            p.BackColor = Card;
            p.Paint += delegate(object s3, PaintEventArgs e3)
            {
                using (var pen = new Pen(Brd)) e3.Graphics.DrawRectangle(pen, 0, 0, p.Width - 1, p.Height - 1);
            };
            return p;
        }

        Label Dot(int x, int y, Control parent)
        {
            var l = new Label();
            l.Text = "●";
            l.Font = new Font("Segoe UI", 13f);
            l.ForeColor = DimC;
            l.Location = new Point(x, y);
            l.AutoSize = true;
            parent.Controls.Add(l);
            return l;
        }

        Label Line(int x, int y, string text, Control parent, Color color)
        {
            var l = new Label();
            l.Text = text;
            l.ForeColor = color;
            l.Location = new Point(x, y);
            l.AutoSize = true;
            parent.Controls.Add(l);
            return l;
        }

        void Section(Control parent, string text, int x, int y)
        {
            var l = new Label();
            l.Text = text;
            l.ForeColor = DimC;
            l.Font = new Font("Microsoft YaHei UI", 8.5f, FontStyle.Bold);
            l.Location = new Point(x, y);
            l.AutoSize = true;
            parent.Controls.Add(l);
        }

        Button Btn(Control parent, string text, int x, int y, int w, EventHandler onClick, bool primary)
        {
            var b = new Button();
            b.Text = text;
            b.Location = new Point(x, y);
            b.Size = new Size(w, 38);
            b.FlatStyle = FlatStyle.Flat;
            b.Font = new Font("Microsoft YaHei UI", 9.5f);
            b.Cursor = Cursors.Hand;
            b.ForeColor = primary ? Color.White : Txt;
            b.BackColor = primary ? Acc : Card;
            b.FlatAppearance.BorderColor = primary ? Acc : Brd;
            b.FlatAppearance.MouseOverBackColor = primary ? Color.FromArgb(116, 120, 245) : Color.FromArgb(28, 34, 48);
            b.Click += onClick;
            parent.Controls.Add(b);
            return b;
        }

        /// <summary>极简 JSON 取值：够用即可，不引依赖。</summary>
        static string JStr(string json, string key)
        {
            if (string.IsNullOrEmpty(json)) return "";
            var k = "\"" + key + "\":";
            var i = json.IndexOf(k);
            if (i < 0) return "";
            var j = i + k.Length;
            while (j < json.Length && (json[j] == ' ' || json[j] == '\n' || json[j] == '\r')) j++;
            if (j >= json.Length) return "";
            if (json[j] == '"')
            {
                var e = json.IndexOf('"', j + 1);
                if (e < 0) return "";
                return json.Substring(j + 1, e - j - 1);
            }
            var end = j;
            while (end < json.Length && ",}\n\r ".IndexOf(json[end]) < 0) end++;
            return json.Substring(j, end - j);
        }

        static System.Collections.Generic.List<string> JsonObjects(string json, string arrayKey)
        {
            var list = new System.Collections.Generic.List<string>();
            if (string.IsNullOrEmpty(json)) return list;
            var k = "\"" + arrayKey + "\":";
            var i = json.IndexOf(k);
            if (i < 0) return list;
            var open = json.IndexOf('[', i);
            if (open < 0) return list;

            int depth = 0, startIdx = -1;
            for (int p = open; p < json.Length; p++)
            {
                var c = json[p];
                if (c == '{')
                {
                    if (depth == 1 && startIdx < 0) startIdx = p;
                    depth++;
                }
                else if (c == '}')
                {
                    depth--;
                    if (depth == 1 && startIdx >= 0)
                    {
                        list.Add(json.Substring(startIdx, p - startIdx + 1));
                        startIdx = -1;
                    }
                }
                else if (c == ']' && depth == 1) break;
            }
            return list;
        }
    }
}

