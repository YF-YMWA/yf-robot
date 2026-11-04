// YF-Robot 托盘启动器（C# 5 语法，用系统自带 csc 编译，无第三方依赖）
//
// 解决三个体验问题：
//   1. 双击 bat 会闪黑窗口，看起来不像软件
//   2. 关掉窗口服务就没了，用户不知道还在不在跑
//   3. 没有托盘入口，开控制台、看日志要记命令
//
// 行为：
//   · 只允许一个实例（Mutex），重复点击会提示并退出
//   · 启动时如果服务没在跑，就在后台拉起（不显示控制台）
//   · 托盘菜单：打开控制台 / 重启服务 / 打开数据目录 / 开机自启 / 退出
using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Net;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

namespace YFRobot
{
    static class Program
    {
        public const string AppName = "YF-Robot";
        public static string Root;

        [STAThread]
        static void Main(string[] args)
        {
            bool created;
            using (var mutex = new Mutex(true, "YF-Robot-Tray-App", out created))
            {
                if (!created)
                {
                    MessageBox.Show(AppName + " 已经在运行了，看右下角托盘图标。", AppName,
                        MessageBoxButtons.OK, MessageBoxIcon.Information);
                    return;
                }

                Root = FindRoot();
                if (Root == null)
                {
                    MessageBox.Show("找不到程序目录（config.json 所在的文件夹）。", AppName,
                        MessageBoxButtons.OK, MessageBoxIcon.Error);
                    return;
                }

                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                var ctx = new TrayContext();
                Application.Run(ctx);
            }
        }

        /// <summary>从 exe 所在目录往上找 config.json（兼容放在根目录或 tools 下）。</summary>
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
    }

    class TrayContext : ApplicationContext
    {
        readonly NotifyIcon _tray;
        readonly System.Windows.Forms.Timer _timer;
        Process _child;
        int _port = 8899;

        public TrayContext()
        {
            _port = ReadPort();

            _tray = new NotifyIcon();
            _tray.Icon = BuildIcon();
            _tray.Text = Program.AppName;
            _tray.Visible = true;
            _tray.DoubleClick += delegate { OpenConsole(); };
            _tray.ContextMenuStrip = BuildMenu();

            EnsureService(false);

            _timer = new System.Windows.Forms.Timer();
            _timer.Interval = 5000;
            _timer.Tick += delegate { RefreshTip(); };
            _timer.Start();

            RefreshTip();
        }

        ContextMenuStrip BuildMenu()
        {
            var m = new ContextMenuStrip();
            m.Items.Add("打开控制台", null, delegate { OpenConsole(); });
            m.Items.Add("重启服务", null, delegate { RestartService(); });
            m.Items.Add("打开数据目录", null, delegate { OpenFolder(Path.Combine(Program.Root, "data")); });
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
            m.Items.Add("退出（停止服务）", null, delegate { ExitApp(); });
            return m;
        }

        // ---------- 服务控制 ----------

        int ReadPort()
        {
            try
            {
                var cfg = File.ReadAllText(Path.Combine(Program.Root, "config.json"));
                var i = cfg.IndexOf("\"port\"");
                if (i > 0)
                {
                    var j = cfg.IndexOf(':', i);
                    var end = j + 1;
                    while (end < cfg.Length && (char.IsDigit(cfg[end]) || cfg[end] == ' ')) end++;
                    int p;
                    if (int.TryParse(cfg.Substring(j + 1, end - j - 1).Trim(), out p) && p > 0) return p;
                }
            }
            catch { }
            return 8899;
        }

        string BaseUrl()
        {
            return "http://127.0.0.1:" + _port;
        }

        bool IsServiceUp()
        {
            try
            {
                var req = (HttpWebRequest)WebRequest.Create(BaseUrl() + "/api/adapter/config");
                req.Timeout = 800;
                req.Proxy = null;
                using (var resp = (HttpWebResponse)req.GetResponse())
                {
                    return (int)resp.StatusCode < 500;
                }
            }
            catch { return false; }
        }

        string NodePath()
        {
            var local = Path.Combine(Program.Root, "runtime", "node.exe");
            if (File.Exists(local)) return local;
            return "node";
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
                psi.WindowStyle = ProcessWindowStyle.Hidden;
                _child = Process.Start(psi);
            }
            catch (Exception ex)
            {
                MessageBox.Show("启动服务失败：" + ex.Message, Program.AppName,
                    MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        void RestartService()
        {
            try
            {
                if (_child != null && !_child.HasExited) _child.Kill();
            }
            catch { }

            // 服务可能是别的入口起的，按端口找人：用 taskkill 按命令行筛
            try
            {
                var p = Process.Start(new ProcessStartInfo("cmd.exe",
                    "/c for /f \"tokens=2\" %i in ('tasklist /fi \"imagename eq node.exe\" /fo list ^| find \"PID:\"') do @echo %i")
                { CreateNoWindow = true, UseShellExecute = false, RedirectStandardOutput = true });
                var ids = p.StandardOutput.ReadToEnd();
                p.WaitForExit(3000);
                foreach (var line in ids.Split('\n'))
                {
                    int pid;
                    if (int.TryParse(line.Trim(), out pid) && pid > 0 && pid != Process.GetCurrentProcess().Id)
                    {
                        try { Process.GetProcessById(pid).Kill(); } catch { }
                    }
                }
            }
            catch { }

            Thread.Sleep(1200);
            EnsureService(true);
            RefreshTip();
        }

        void OpenConsole()
        {
            try { Process.Start(BaseUrl() + "/console"); }
            catch (Exception ex)
            {
                MessageBox.Show("打不开控制台：" + ex.Message + "\n服务是不是还没起来？", Program.AppName);
            }
        }

        void OpenFolder(string path)
        {
            try
            {
                if (!Directory.Exists(path)) Directory.CreateDirectory(path);
                Process.Start("explorer.exe", path);
            }
            catch { }
        }

        void RefreshTip()
        {
            bool up = IsServiceUp();
            _tray.Text = Program.AppName + (up ? " · 运行中" : " · 已停止");
        }

        // ---------- 开机自启 ----------

        const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";

        bool IsAutoStart()
        {
            try
            {
                using (var k = Registry.CurrentUser.OpenSubKey(RunKey))
                {
                    return k != null && k.GetValue(Program.AppName) != null;
                }
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

        static Icon BuildIcon()
        {
            var bmp = new Bitmap(32, 32);
            using (var g = Graphics.FromImage(bmp))
            {
                g.SmoothingMode = SmoothingMode.AntiAlias;
                g.Clear(Color.Transparent);
                using (var b = new SolidBrush(Color.FromArgb(58, 122, 214)))
                    g.FillEllipse(b, 1, 1, 30, 30);
                using (var f = new Font("Segoe UI", 16, FontStyle.Bold, GraphicsUnit.Pixel))
                using (var w = new SolidBrush(Color.White))
                {
                    var s = "Y";
                    var size = g.MeasureString(s, f);
                    g.DrawString(s, f, w, (32 - size.Width) / 2, (32 - size.Height) / 2);
                }
            }
            return Icon.FromHandle(bmp.GetHicon());
        }

        void ExitApp()
        {
            var r = MessageBox.Show("退出会停止服务（聊天也会断）。确定？", Program.AppName,
                MessageBoxButtons.YesNo, MessageBoxIcon.Question);
            if (r != DialogResult.Yes) return;

            try
            {
                if (_child != null && !_child.HasExited) _child.Kill();
            }
            catch { }

            _tray.Visible = false;
            Application.Exit();
        }
    }
}
