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
        static void Main()
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
                Application.Run(new TrayContext());
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

        public TrayContext()
        {
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

        void OpenConsole() { OpenAppWindow("/console"); }

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
}
