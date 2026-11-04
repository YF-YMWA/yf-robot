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
                if (!created) return; // 已有实例，静默退出

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
                if (silent) Application.Run(ctx);
                else Application.Run(new MainForm(ctx));
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

        public string VersionText { get { return _version; } }
        public int PortText { get { return _port; } }
        public bool ServiceUp { get { return IsServiceUp(); } }
        public void StartSvc() { EnsureService(true); }
        public void StopSvc() { StopService(); }
        public void DoRestart() { RestartService(); }
        public void DoBackup() { BackupMemory(); }
        public void DoRestore() { RestoreLatest(); }
        public void OpenConsole() { OpenAppWindow("/console"); }
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
                    psi.Arguments = "--app=" + url + " --window-size=1280,860 --user-data-dir=\"" + profile + "\"";
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
    /// 原生启动器面板。
    ///
    /// 目标：不打开浏览器也能看状态、管服务、备份恢复。
    /// 网页控制台仍然保留，但只作为「打开控制台」这个可选入口。
    /// </summary>
    class MainForm : Form
    {
        readonly TrayContext _ctx;
        readonly Label _svcDot, _svcText, _adpDot, _adpText, _verText;
        readonly CheckBox _auto;
        readonly System.Windows.Forms.Timer _timer;

        static readonly Color Bg = Color.FromArgb(11, 14, 20);
        static readonly Color Card = Color.FromArgb(20, 25, 35);
        static readonly Color Brd = Color.FromArgb(40, 48, 66);
        static readonly Color Txt = Color.FromArgb(232, 237, 247);
        static readonly Color DimC = Color.FromArgb(139, 149, 168);
        static readonly Color Acc = Color.FromArgb(99, 102, 241);
        static readonly Color Green = Color.FromArgb(52, 211, 153);
        static readonly Color Red = Color.FromArgb(251, 113, 133);

        public MainForm(TrayContext ctx)
        {
            _ctx = ctx;
            Text = "YF-Robot 启动器";
            ClientSize = new Size(560, 520);
            StartPosition = FormStartPosition.CenterScreen;
            FormBorderStyle = FormBorderStyle.FixedSingle;
            MaximizeBox = false;
            BackColor = Bg;
            ForeColor = Txt;
            Font = new Font("Microsoft YaHei UI", 9f);

            var title = new Label();
            title.Text = "YF-Robot";
            title.Font = new Font("Microsoft YaHei UI", 18f, FontStyle.Bold);
            title.ForeColor = Txt;
            title.Location = new Point(26, 20);
            title.AutoSize = true;
            Controls.Add(title);

            _verText = new Label();
            _verText.Text = "v" + ctx.VersionText + "　·　端口 " + ctx.PortText;
            _verText.ForeColor = DimC;
            _verText.Location = new Point(29, 58);
            _verText.AutoSize = true;
            Controls.Add(_verText);

            // ── 状态卡
            var card = Card2(26, 92, 508, 88);
            Controls.Add(card);

            _svcDot = Dot(16, 18, card);
            _svcText = Line(42, 20, "服务：检查中…", card, Txt);

            _adpDot = Dot(16, 50, card);
            _adpText = Line(42, 52, "适配器：检查中…", card, DimC);

            // ── 服务控制
            Section("服务", 26, 196);
            Btn("打开控制台", 26, 224, 160, delegate { _ctx.OpenConsole(); }, true);
            Btn("聊天窗口", 196, 224, 160, delegate { _ctx.OpenChat(); }, false);
            Btn("重启服务", 366, 224, 168, delegate { _ctx.DoRestart(); }, false);
            Btn("停止服务", 26, 270, 160, delegate { StopAll(); }, false);
            Btn("查看日志", 196, 270, 160, delegate { _ctx.OpenLogs(); }, false);
            Btn("数据目录", 366, 270, 168, delegate { _ctx.OpenDataDir(); }, false);

            // ── 记忆
            Section("记忆", 26, 322);
            Btn("备份记忆", 26, 350, 250, delegate { _ctx.DoBackup(); }, false);
            Btn("恢复最近备份…", 286, 350, 248, delegate { _ctx.DoRestore(); }, false);

            // ── 设置
            Section("设置", 26, 402);
            _auto = new CheckBox();
            _auto.Text = "开机自动启动（只驻留托盘，不弹窗）";
            _auto.ForeColor = DimC;
            _auto.Location = new Point(26, 430);
            _auto.AutoSize = true;
            _auto.Checked = ctx.AutoStartOn;
            _auto.CheckedChanged += delegate
            {
                try { _ctx.AutoStartOn = _auto.Checked; }
                catch { _auto.Checked = _ctx.AutoStartOn; }
            };
            Controls.Add(_auto);

            var hide = Btn("缩到托盘", 286, 428, 248, delegate { HideToTray(); }, false);

            var tip = new Label();
            tip.Text = "关掉窗口 = 缩到托盘，服务继续跑";
            tip.ForeColor = DimC;
            tip.Location = new Point(29, 476);
            tip.AutoSize = true;
            Controls.Add(tip);

            _timer = new System.Windows.Forms.Timer();
            _timer.Interval = 3000;
            _timer.Tick += delegate { Refresh(); };
            _timer.Start();
            Refresh();

            FormClosing += delegate(object s2, FormClosingEventArgs e2)
            {
                if (e2.CloseReason == CloseReason.UserClosing)
                {
                    e2.Cancel = true;
                    HideToTray();
                }
            };
        }

        void StopAll()
        {
            if (MessageBox.Show("停止服务会让聊天中断，确定？", "YF-Robot",
                    MessageBoxButtons.YesNo, MessageBoxIcon.Question) != DialogResult.Yes) return;
            _ctx.StopSvc();
            Refresh();
        }

        void HideToTray()
        {
            Hide();
            ShowInTaskbar = false;
            _ctx.ShowTrayMenu();
        }

        void Refresh()
        {
            var up = _ctx.ServiceUp;
            _svcDot.ForeColor = up ? Green : Red;
            _svcText.Text = up ? "服务：运行中　127.0.0.1:" + _ctx.PortText : "服务：未运行";
            _svcText.ForeColor = up ? Txt : Red;

            var adp = _ctx.AdapterOnline();
            if (adp == null)
            {
                // 服务在线但接口没给结果：按未接入显示，别让用户以为坏了
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

        // ── 小工具
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

        void Section(string text, int x, int y)
        {
            var l = new Label();
            l.Text = text;
            l.ForeColor = DimC;
            l.Font = new Font("Microsoft YaHei UI", 8.5f, FontStyle.Bold);
            l.Location = new Point(x, y);
            l.AutoSize = true;
            Controls.Add(l);
        }

        Button Btn(string text, int x, int y, int w, EventHandler onClick, bool primary)
        {
            var b = new Button();
            b.Text = text;
            b.Location = new Point(x, y);
            b.Size = new Size(w, 36);
            b.FlatStyle = FlatStyle.Flat;
            b.Font = new Font("Microsoft YaHei UI", 9f);
            b.Cursor = Cursors.Hand;
            b.ForeColor = primary ? Color.White : Txt;
            b.BackColor = primary ? Acc : Card;
            b.FlatAppearance.BorderColor = primary ? Acc : Brd;
            b.Click += onClick;
            Controls.Add(b);
            return b;
        }
    }

}
