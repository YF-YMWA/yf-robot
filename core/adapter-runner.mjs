/**
 * 从面板启动 / 停止微信适配器。
 *
 * 为什么需要提权：
 *   适配器要操作微信窗口（UIA），而微信是更高权限的进程 ——
 *   不带管理员跑的话，能收消息但发不出去（UIA 被 UIPI 拦）。
 *
 * 所以启动方式是：让 Windows 弹一次 UAC，用户点「是」，
 * 然后以管理员身份跑 cmd → python wechatauto_bridge.py，输出重定向到日志。
 *
 * 安全边界：
 *   · 只启动固定的那个入口文件，不接受任意命令
 *   · 工作目录固定为适配器目录
 *   · 停止时只杀自己记录的 PID（不按名字杀，避免误伤别的 python）
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';

const ENTRY = 'wechatauto_bridge.py';
const PID_FILE = path.join('data', 'adapter.panel.pid');
const LOG_FILE = path.join('data', 'panel-run.log');

/**
 * 找适配器目录：打包形态在 `adapter/`，开发形态在隔壁仓库。
 * @returns {{dir:string, mode:'bundled'|'sibling'}|null}
 */
export function findAdapter(root) {
  const bundled = path.join(root, 'adapter');
  if (fs.existsSync(path.join(bundled, ENTRY))) return { dir: bundled, mode: 'bundled' };

  const sibling = path.join(path.dirname(root), 'yf-robot-wechat-adapter');
  if (fs.existsSync(path.join(sibling, ENTRY))) return { dir: sibling, mode: 'sibling' };

  return null;
}

/** 找一个能用的 python（优先用随包的运行时） */
function findPython(root, adapterDir) {
  const candidates = [
    path.join(root, 'runtime', 'python', 'python.exe'),
    path.join(adapterDir, 'runtime', 'python', 'python.exe'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return 'python';
}

/** 读已记录的 PID */
function readPid(root) {
  try {
    const n = Number(fs.readFileSync(path.join(root, PID_FILE), 'utf8').trim());
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

/** 这个 PID 还活着吗 */
function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * 找出真正在跑桥接的 python 进程。
 *
 * 为什么不直接用 Start-Process 返回的 PID：
 *   那是 cmd.exe / UAC 同意进程的 PID，桥接真正的进程是它的子进程。
 *   实测返回的 PID 早就退了，而 python 还在跑 —— 面板于是显示「未运行」。
 *
 * @returns {Promise<number>} PID，找不到返回 0
 */
export function findBridgePid() {
  return new Promise((resolve) => {
    const ps = [
      '-NoProfile',
      '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='python.exe'\" | Where-Object { $_.CommandLine -like '*wechatauto_bridge.py*' } | Select-Object -ExpandProperty ProcessId",
    ];
    execFile('powershell.exe', ps, { timeout: 8000 }, (err, stdout) => {
      if (err) return resolve(0);
      const pids = String(stdout || '')
        .split(/\s+/)
        .map(Number)
        .filter((n) => Number.isFinite(n) && n > 0);
      resolve(pids.length ? pids[0] : 0);
    });
  });
}

/** 日志尾巴 */
export function tailLog(root, lines = 40) {
  const a = findAdapter(root);
  if (!a) return { ok: false, error: '没找到适配器目录' };

  const files = [path.join(a.dir, LOG_FILE), path.join(a.dir, 'data', 'bridge.log')];
  for (const f of files) {
    try {
      if (!fs.existsSync(f)) continue;
      const buf = fs.readFileSync(f, 'utf8');
      return { ok: true, file: f.replace(a.dir, 'adapter'), text: buf.split('\n').slice(-lines).join('\n') };
    } catch {}
  }
  return { ok: false, error: '还没有日志（还没从面板启动过）' };
}

/**
 * 当前状态。
 *
 * 两路判断：记录的 PID 活着，或者系统里真有桥接进程 ——
 * 只看 PID 文件会因为「父进程先退」而误报未运行。
 */
export async function status(root) {
  const a = findAdapter(root);
  if (!a) {
    return { found: false, running: false, message: '没有适配器（这是纯框架包）' };
  }

  const pid = readPid(root);
  const byPid = alive(pid);
  const realPid = byPid ? pid : await findBridgePid();
  const running = Boolean(realPid);

  // 顺手把 PID 文件纠正过来
  if (running && realPid !== pid) {
    try {
      fs.writeFileSync(path.join(root, PID_FILE), String(realPid), 'utf8');
    } catch {}
  }

  return {
    found: true,
    mode: a.mode,
    dir: a.dir,
    running,
    pid: running ? realPid : 0,
    entry: ENTRY,
    // 服务是管理员的话，启动适配器不需要弹 UAC
    elevated: await isElevated(),
    log: tailLog(root, 20),
  };
}

/**
 * 当前服务是不是管理员权限。
 *
 * 如果是，启动适配器可以直接 spawn —— 子进程继承权限，不用弹 UAC。
 * 这样「用管理员启动面板」之后，之后再启动适配器就是一次点击的事。
 *
 * @returns {Promise<boolean>}
 */
export function isElevated() {
  return new Promise((resolve) => {
    const ps = [
      '-NoProfile',
      '-Command',
      '([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)',
    ];
    execFile('powershell.exe', ps, { timeout: 8000 }, (err, stdout) => {
      if (err) return resolve(false);
      resolve(String(stdout).trim().toLowerCase() === 'true');
    });
  });
}

/**
 * 直接起进程（服务本身已经是管理员时走这条路，不弹 UAC）。
 */
function startDirect(cmd) {
  return new Promise((resolve) => {
    // detached：让桥接不随服务退出；windowsHide：不弹黑窗
    const child = spawn('cmd.exe', ['/c', cmd.launcher], {
      cwd: cmd.adapterDir,
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
    });
    child.unref();

    child.on('error', (e) => resolve({ ok: false, error: '启动失败：' + e.message }));
    child.on('spawn', () => resolve({ ok: true, pid: 0, direct: true }));
  });
}

/**
 * 拼出「以管理员身份运行适配器」的命令（抽出来是为了能测，不用真弹 UAC）。
 *
 * 为什么不再直接把一长串命令塞给 cmd：
 *   第一版是 Start-Process cmd.exe -ArgumentList '/c','"python" 脚本 > 日志 2>&1'。
 *   PowerShell 重新拼参数时会把内层引号转义成 \" —— 而 cmd 只认 ""，
 *   于是 cmd 立刻语法错误退出，界面却因为 Start-Process 成功而显示「已启动」，
 *   日志一个字也没有。这就是用户遇到的「启动失败」。
 *
 * 现在的做法：把命令写进一个 .bat，Start-Process 只传一个路径。
 * 路径再长、含空格都没关系，不需要任何嵌套引号。
 */
export function buildStartCommand(root) {
  const a = findAdapter(root);
  if (!a) return null;

  const py = findPython(root, a.dir);
  const logPath = path.join(a.dir, LOG_FILE);
  const launcher = path.join(a.dir, 'data', 'panel-launch.bat');

  // bat 内容：切到适配器目录，跑入口，输出进日志
  const bat = [
    '@echo off',
    'chcp 65001 >nul',
    // Python 默认按系统编码输出，重定向到文件就成了乱码；强制 UTF-8
    'set PYTHONIOENCODING=utf-8',
    'set PYTHONUTF8=1',
    `cd /d "${a.dir}"`,
    `"${py}" ${ENTRY} > "${logPath}" 2>&1`,
    'echo.',
    'echo [panel] 进程已退出，按任意键关闭',
    'pause >nul',
    '',
  ].join('\r\n');

  const safeLauncher = launcher.replace(/'/g, "''");
  const safeDir = a.dir.replace(/'/g, "''");

  return {
    adapterDir: a.dir,
    python: py,
    logPath,
    launcher,
    bat,
    cmdLine: `"${py}" ${ENTRY} > "${logPath}" 2>&1`,
    psArgs: [
      '-NoProfile',
      '-Command',
      `$p = Start-Process -FilePath '${safeLauncher}' -WorkingDirectory '${safeDir}' -Verb RunAs -PassThru; if ($p) { $p.Id }`,
    ],
  };
}

/**
 * 启动。
 *
 * 两条路：
 *   · 服务本身已经是管理员 → 直接 spawn，不弹 UAC（最省事）
 *   · 不是管理员 → Start-Process -Verb RunAs 弹一次 UAC
 *
 * @returns {Promise<{ok:boolean, pid?:number, error?:string, note?:string}>}
 */
export async function start(root, log = () => {}) {
  const a = findAdapter(root);
  if (!a) return { ok: false, error: '没有适配器目录（这是纯框架包）' };

  // 已经在跑（按 PID 或按进程名找，别重复起）
  const cur = readPid(root);
  if (alive(cur)) return { ok: true, pid: cur, note: '已经在跑了' };
  const existing = await findBridgePid();
  if (existing) return { ok: true, pid: existing, note: '已经在跑了（pid ' + existing + '）' };

  const cmd = buildStartCommand(root);
  if (!cmd) return { ok: false, error: '没有适配器目录（这是纯框架包）' };

  fs.mkdirSync(path.dirname(cmd.logPath), { recursive: true });

  /**
   * 先写启动脚本。
   *
   * 上一版是把整条命令塞进 PowerShell 参数里 —— 引号被转义成 cmd 不认的形式，
   * cmd 秒退，但 Start-Process 本身成功，于是面板显示「已启动」而实际什么都没跑。
   * 现在只传一个 .bat 路径，彻底避开嵌套引号。
   */
  try {
    fs.writeFileSync(cmd.launcher, cmd.bat, 'utf8');
  } catch (e) {
    return { ok: false, error: '写启动脚本失败：' + e.message };
  }

  // ===== 情况一：服务本身是管理员 → 直接起，不弹 UAC =====
  if (await isElevated()) {
    const r = await startDirect(cmd);
    if (!r.ok) return r;

    // 等桥接进程出现（同样不能信 spawn 给的 PID）
    let realPid = 0;
    for (let i = 0; i < 12 && !realPid; i++) {
      await new Promise((x) => setTimeout(x, 700));
      realPid = await findBridgePid();
    }

    if (!realPid) {
      return {
        ok: false,
        error: '进程起了但没找到桥接进程，多半是启动后立刻退出了。点「看日志」看原因（微信没开？已有实例？）。',
      };
    }

    try {
      fs.writeFileSync(path.join(root, PID_FILE), String(realPid), 'utf8');
    } catch {}

    log('[adapter] 已启动 pid=' + realPid + '（直接启动，无需 UAC）');
    return {
      ok: true,
      pid: realPid,
      elevated: true,
      note: '已启动（pid ' + realPid + '）。服务本身是管理员，所以没有弹 UAC。',
    };
  }

  return await new Promise((resolve) => {
    // windowsHide 关掉：UAC 弹窗要能看见
    const child = spawn('powershell.exe', cmd.psArgs, { windowsHide: false });

    let out = '';
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (out += c));

    child.on('error', (e) => resolve({ ok: false, error: '启动失败：' + e.message }));

    child.on('exit', async (code) => {
      const spawnedPid = Number(String(out).trim().split(/\s+/).pop());

      if (!(code === 0 && Number.isFinite(spawnedPid) && spawnedPid > 0)) {
        // 用户点了「否」，或者 UAC 被策略禁止
        resolve({
          ok: false,
          error:
            '没有启动成功。多半是 UAC 被取消了 —— 适配器需要管理员权限才能操作微信窗口，' +
            '请重试并在弹窗点「是」。也可以手动右键 adapter/data/panel-launch.bat 用管理员运行。',
        });
        return;
      }

      /**
       * Start-Process 返回的是 cmd / UAC 进程的 PID，桥接真正的进程是它的子进程。
       * 直接记那个 PID 会「记完就死」，面板显示未运行 —— 所以这里找真正的 python。
       */
      let realPid = 0;
      for (let i = 0; i < 10 && !realPid; i++) {
        await new Promise((r) => setTimeout(r, 700));
        realPid = await findBridgePid();
      }

      const finalPid = realPid || spawnedPid;
      try {
        fs.writeFileSync(path.join(root, PID_FILE), String(finalPid), 'utf8');
      } catch {}

      let hasLog = false;
      try {
        hasLog = fs.existsSync(cmd.logPath) && fs.statSync(cmd.logPath).size > 0;
      } catch {}

      log('[adapter] 已启动 pid=' + finalPid + (realPid ? '（桥接进程）' : '（未找到桥接进程）'));

      if (!realPid) {
        resolve({
          ok: false,
          error:
            '进程起来了但没找到桥接进程，多半是启动后立刻退出了。' +
            '点「看日志」看原因（最常见：微信没开、或已有一个实例在跑）。',
        });
        return;
      }

      resolve({
        ok: true,
        pid: finalPid,
        logStarted: hasLog,
        note: hasLog
          ? '已启动（pid ' + finalPid + '），日志在 adapter/data/panel-run.log。'
          : '桥接进程已起来（pid ' + finalPid + '），日志还在写。',
      });
    });
  });
}

/**
 * 停止（只杀自己记录的那个 PID 及其子进程）。
 */
export function stop(root, log = () => {}) {
  const pid = readPid(root);
  if (!pid || !alive(pid)) {
    try {
      fs.rmSync(path.join(root, PID_FILE), { force: true });
    } catch {}
    return { ok: true, note: '本来就没在跑' };
  }

  return new Promise((resolve) => {
    // /T 连带子进程（cmd → python）
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], (err) => {
      try {
        fs.rmSync(path.join(root, PID_FILE), { force: true });
      } catch {}
      if (err) {
        resolve({ ok: false, error: '停止失败：' + err.message });
      } else {
        log('[adapter] 已停止 pid=' + pid);
        resolve({ ok: true, note: '已停止' });
      }
    });
  });
}
