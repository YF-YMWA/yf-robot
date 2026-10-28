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
 */
export function status(root) {
  const a = findAdapter(root);
  if (!a) {
    return { found: false, running: false, message: '没有适配器（这是纯框架包）' };
  }

  const pid = readPid(root);
  const running = alive(pid);
  return {
    found: true,
    mode: a.mode,
    dir: a.dir,
    running,
    pid: running ? pid : 0,
    entry: ENTRY,
    log: tailLog(root, 20),
  };
}

/**
 * 拼出「以管理员身份运行适配器」的命令（抽出来是为了能测，不用真弹 UAC）。
 *
 * 用 cmd 包一层的原因：PowerShell 的 Start-Process -Verb RunAs 不能同时
 * 重定向输出，而我们需要日志 —— 让 cmd 负责重定向，PowerShell 只负责提权。
 */
export function buildStartCommand(root) {
  const a = findAdapter(root);
  if (!a) return null;

  const py = findPython(root, a.dir);
  const logPath = path.join(a.dir, LOG_FILE);
  const cmdLine = `"${py}" ${ENTRY} > "${logPath}" 2>&1`;
  const safeCmd = cmdLine.replace(/'/g, "''");
  const safeDir = a.dir.replace(/'/g, "''");

  return {
    adapterDir: a.dir,
    python: py,
    logPath,
    cmdLine,
    psArgs: [
      '-NoProfile',
      '-Command',
      `$p = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c','${safeCmd}' -WorkingDirectory '${safeDir}' -Verb RunAs -PassThru; if ($p) { $p.Id }`,
    ],
  };
}

/**
 * 启动（会弹 UAC）。
 *
 * @returns {Promise<{ok:boolean, pid?:number, error?:string, note?:string}>}
 */
export async function start(root, log = () => {}) {
  const a = findAdapter(root);
  if (!a) return { ok: false, error: '没有适配器目录（这是纯框架包）' };

  const cur = readPid(root);
  if (alive(cur)) return { ok: true, pid: cur, note: '已经在跑了' };

  const cmd = buildStartCommand(root);
  if (!cmd) return { ok: false, error: '没有适配器目录（这是纯框架包）' };

  fs.mkdirSync(path.dirname(cmd.logPath), { recursive: true });

  return await new Promise((resolve) => {
    // windowsHide 关掉：UAC 弹窗要能看见
    const child = spawn('powershell.exe', cmd.psArgs, { windowsHide: false });

    let out = '';
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (out += c));

    child.on('error', (e) => resolve({ ok: false, error: '启动失败：' + e.message }));

    child.on('exit', (code) => {
      const pid = Number(String(out).trim().split(/\s+/).pop());
      if (code === 0 && Number.isFinite(pid) && pid > 0) {
        try {
          fs.writeFileSync(path.join(root, PID_FILE), String(pid), 'utf8');
        } catch {}
        log('[adapter] 已启动 pid=' + pid + '（' + a.mode + '）');
        resolve({
          ok: true,
          pid,
          note: '已启动。如果没弹出 UAC，说明系统拒绝了提权，请手动双击适配器的启动脚本。',
        });
      } else {
        // 用户点了「否」，或者 UAC 被策略禁止
        resolve({
          ok: false,
          error:
            '没有启动成功。多半是 UAC 被取消了 —— 适配器需要管理员权限才能操作微信窗口，' +
            '请重试并在弹窗点「是」。',
        });
      }
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
