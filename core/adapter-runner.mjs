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
import net from 'node:net';
import { getAdapter } from './adapter-registry.mjs';

const ENTRY = 'wechatauto_bridge.py';

/** 每个适配器各自的 PID 文件 / 启动脚本，互不干扰 */
function pidFile(id) {
  return path.join('data', 'adapter-' + (id || 'default') + '.pid');
}

/** 旧的单适配器 PID 文件（升级兼容：读到就迁过来） */
const LEGACY_PID = path.join('data', 'adapter.panel.pid');
const LOG_FILE = path.join('data', 'panel-run.log');

/**
 * 找适配器目录：打包形态在 `adapter/`，开发形态在隔壁仓库。
 * @returns {{dir:string, mode:'bundled'|'sibling'}|null}
 */
export function findAdapter(root, id) {
  const a = getAdapter(root, id);
  if (!a) return null;
  return { dir: a.dir, mode: a.mode, id: a.id, entry: a.entry, name: a.name, needsAdmin: a.needsAdmin };
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
function readPid(root, id) {
  const mine = path.join(root, pidFile(id));
  try {
    const n = Number(fs.readFileSync(mine, 'utf8').trim());
    if (Number.isFinite(n) && n > 0) return n;
  } catch {}

  // 升级兼容：老版本只写 data/adapter.panel.pid
  try {
    const n = Number(fs.readFileSync(path.join(root, LEGACY_PID), 'utf8').trim());
    if (Number.isFinite(n) && n > 0) {
      try {
        fs.writeFileSync(mine, String(n), 'utf8');
      } catch {}
      return n;
    }
  } catch {}

  return 0;
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
 * 适配器单实例锁的端口：启动时 bind 它，占住就说明有实例在跑。
 *
 * 为什么不只查进程：**提权进程的命令行对普通权限不可见**。
 * 面板的服务不是管理员时，去查管理员启动的桥接，会拿到空 CommandLine，
 * 于是误判「未运行」—— 用户明明看到它在跑。
 */
const LOCK_PORT = 47821;

/** 锁端口被占了吗（= 有实例在跑） */
export function isLockPortBusy(port = LOCK_PORT) {
  /**
   * 用 netstat 看「LISTENING」而不是直接 connect。
   *
   * 教训：适配器的锁是 `listen(1)` —— 只有 1 个排队位。
   * 我一开始用 TCP connect 探测，第一次能连上，之后 backlog 被占满，
   * 后面的探测全被拒 → 一会儿说有实例、一会儿说没有，自相矛盾。
   * netstat 只读内核状态，不占用连接。
   */
  return new Promise((resolve) => {
    execFile('netstat', ['-ano'], { timeout: 6000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve(false);
      const re = new RegExp(':' + port + '\\s', 'i');
      const listening = String(stdout || '')
        .split('\n')
        .filter((l) => /LISTENING/i.test(l))
        .some((l) => re.test(l));
      resolve(listening);
    });
  });
}

/**
 * 找出在跑的桥接进程。
 *
 * 三条路，按可靠性排：
 *   1. 进程命令行匹配 → 拿得到真实 PID（仅限当前权限看得见的进程）
 *   2. 锁端口被占 → 确实有实例，但可能拿不到 PID（返回 -1）
 *   3. 都没有 → 没在跑（返回 0）
 *
 * @returns {Promise<number>} PID / -1（有实例但看不到 PID）/ 0
 */
export async function findBridgePid() {
  const pids = await new Promise((resolve) => {
    const ps = [
      '-NoProfile',
      '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='python.exe'\" | Where-Object { $_.CommandLine -like '*wechatauto_bridge.py*' } | Select-Object -ExpandProperty ProcessId",
    ];
    execFile('powershell.exe', ps, { timeout: 8000 }, (err, stdout) => {
      if (err) return resolve([]);
      resolve(
        String(stdout || '')
          .split(/\s+/)
          .map(Number)
          .filter((n) => Number.isFinite(n) && n > 0),
      );
    });
  });

  if (pids.length) return pids[0];
  return (await isLockPortBusy()) ? -1 : 0;
}

/**
 * 反查「谁在监听这个端口」——提权实例看不到命令行时靠它拿 PID。
 *
 * @returns {Promise<number>} PID，查不到返回 0
 */
export function pidListeningOn(port = LOCK_PORT) {
  return new Promise((resolve) => {
    execFile('netstat', ['-ano'], { timeout: 6000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve(0);

      for (const line of String(stdout || '').split('\n')) {
        if (!/LISTENING/i.test(line)) continue;
        // 形如：  TCP    127.0.0.1:47821    0.0.0.0:0    LISTENING    12345
        const parts = line.trim().split(/\s+/);
        const local = parts[1] || '';
        if (!local.endsWith(':' + port)) continue;
        const pid = Number(parts[parts.length - 1]);
        if (Number.isFinite(pid) && pid > 0) return resolve(pid);
      }
      resolve(0);
    });
  });
}

/**
 * 日志尾巴。
 *
 * 优先读适配器自己写的 `data/wechat-bridge-4x.log` —— 它的 log() 每行都落盘，
 * 内容最全（包括识别过程）。panel-run.log 是早期重定向产物，留作兜底。
 */
export function tailLog(root, lines = 40, id) {
  const a = findAdapter(root, id);
  if (!a) return { ok: false, error: '没找到适配器目录' };

  const candidates = [
    path.join(a.dir, 'data', 'wechat-bridge-4x.log'),
    path.join(a.dir, 'data', 'bridge.log'),
    path.join(a.dir, LOG_FILE),
  ];

  for (const f of candidates) {
    try {
      if (!fs.existsSync(f)) continue;
      const st = fs.statSync(f);
      if (!st.size) continue;
      const buf = fs.readFileSync(f, 'utf8');
      return {
        ok: true,
        file: f.replace(a.dir, 'adapter'),
        at: st.mtimeMs,
        text: buf.split('\n').slice(-lines).join('\n'),
      };
    } catch {}
  }
  return { ok: false, error: '还没有日志（还没启动过）' };
}

/**
 * 当前状态。
 *
 * 三路判断（任一成立就算在跑）：
 *   · 记录的 PID 还活着
 *   · 查到了桥接进程
 *   · 锁端口被占（提权实例看不到命令行，只能靠这个）
 */
export async function status(root, id) {
  const a = findAdapter(root, id);
  if (!a) {
    return { found: false, running: false, message: '没有适配器（这是纯框架包）' };
  }

  const pid = readPid(root, id);
  const byPid = alive(pid);
  // 非微信适配器：只看 PID（findBridgePid 是按 wechatauto 的锁端口找的）
  const found =
    a.needsAdmin === false ? (byPid ? pid : 0) : byPid ? pid : await findBridgePid();
  const running = Boolean(found); // -1 也算「有实例」

  // 顺手把 PID 文件纠正过来（-1 表示有实例但看不到 PID，就不写）
  if (running && found > 0 && found !== pid) {
    try {
      fs.writeFileSync(path.join(root, pidFile(id)), String(found), 'utf8');
    } catch {}
  }

  return {
    found: true,
    mode: a.mode,
    dir: a.dir,
    running,
    pid: running && found > 0 ? found : 0,
    entry: ENTRY,
    // 服务是管理员的话，启动适配器不需要弹 UAC
    elevated: await isElevated(),
    log: tailLog(root, 20, id),
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
 *
 * windowsHide 必须是 false —— 用户要看那个窗口里滚动的识别过程，
 * 藏起来就等于「启动了什么都没看见」。
 */
function startDirect(cmd) {
  return new Promise((resolve) => {
    const child = spawn('cmd.exe', ['/c', cmd.launcher], {
      cwd: cmd.adapterDir,
      detached: true,
      windowsHide: false,
      stdio: 'ignore',
    });
    child.unref();

    child.on('error', (e) => resolve({ ok: false, error: '启动失败：' + e.message }));
    // pid 要给出来：非微信适配器靠它判断进程是否还活着
    child.on('spawn', () => resolve({ ok: true, pid: child.pid || 0, direct: true }));
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
export function buildStartCommand(root, id) {
  const a = findAdapter(root, id);
  if (!a) return null;

  const py = findPython(root, a.dir);
  const logPath = path.join(a.dir, LOG_FILE);
  // 每个适配器一份启动脚本，别互相覆盖
  const launcher = path.join(a.dir, 'data', 'panel-launch.bat');

  /**
   * bat 内容。
   *
   * 关键：**不要重定向 stdout**。
   * 适配器自己就把每一行写进 data/wechat-bridge-4x.log（log() 里先写文件再 print），
   * 所以面板读文件就够了。之前把输出重定向到 panel-run.log，
   * 结果是那个命令行窗口里一片空白 —— 用户以为「看不到识别信息了」。
   * 现在窗口正常显示所有识别过程，面板日志也照样有。
   */
  /**
   * 入口用适配器自己声明的（adapter.json 里的 entry）。
   *
   * 之前这里写死 wechatauto_bridge.py，导致面板加了第二个适配器之后，
   * 点启动还是去跑微信那个脚本 —— 报「文件不存在」，看着像启动失败。
   */
  const entry = a.entry || ENTRY;
  const title = (a.name || '适配器') + '（YF-Robot）— 关掉窗口即停止';

  const bat = [
    '@echo off',
    'chcp 65001 >nul',
    // Python 默认按系统编码输出，中文会乱码；强制 UTF-8
    'set PYTHONIOENCODING=utf-8',
    'set PYTHONUTF8=1',
    // 面板启动：让桥接忽略 Ctrl+C —— 点窗口复制日志时很容易误触，一按就退出了
    'set YF_NO_SIGINT=1',
    `title ${title}`,
    `cd /d "${a.dir}"`,
    `"${py}" ${entry}`,
    'echo.',
    'echo [适配器已退出] 按任意键关闭窗口',
    'pause >nul',
    '',
  ].join('\r\n');

  const safeLauncher = launcher.replace(/'/g, "''");
  const safeDir = a.dir.replace(/'/g, "''");

  return {
    adapterDir: a.dir,
    python: py,
    entry,
    logPath,
    launcher,
    bat,
    cmdLine: `"${py}" ${entry} > "${logPath}" 2>&1`,
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
export async function start(root, log = () => {}, id) {
  const a = findAdapter(root, id);
  if (!a) return { ok: false, error: '没有适配器目录（这是纯框架包）' };

  // 已经在跑（按 PID 或按进程名找，别重复起）
  const cur = readPid(root, id);
  if (alive(cur)) return { ok: true, pid: cur, note: '已经在跑了' };
  const existing = await findBridgePid();
  if (existing) return { ok: true, pid: existing, note: '已经在跑了（pid ' + existing + '）' };

  const cmd = buildStartCommand(root, id);
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

  /**
   * 两条路，按适配器自己的声明决定：
   *
   *   needsAdmin = false（例如 QQ / 自定义协议适配器）
   *       → 直接起，永不弹 UAC。以前不管什么适配器都走提权，
   *         导致「不需要管理员的适配器」也弹窗、还会被当成本地启动失败。
   *
   *   needsAdmin = true（微信这种要操作别人窗口的）
   *       → 服务已经是管理员就直接起；不是才弹 UAC。
   */
  const elevated = await isElevated();
  const needElevation = a.needsAdmin !== false && !elevated;

  if (!needElevation) {
    const r = await startDirect(cmd);
    if (!r.ok) return r;

    /**
     * 等它真的活下来。
     *
     * 微信适配器有自己的单实例锁端口，能用 findBridgePid() 精确判断；
     * 其它适配器没有这个约定，就按 spawn 出来的 PID 看它是否还活着。
     */
    let realPid = 0;
    for (let i = 0; i < 12 && !realPid; i++) {
      await new Promise((x) => setTimeout(x, 500));

      if (a.needsAdmin !== false) {
        realPid = await findBridgePid();
      } else {
        const childPid = r.pid || 0;
        realPid = childPid && alive(childPid) ? childPid : 0;
      }
    }

    if (!realPid) {
      return {
        ok: false,
        error:
          '进程起了但没活下来，多半是启动后立刻退出了。点「看日志」看原因' +
          (a.needsAdmin !== false ? '（微信没开？已有实例？）' : '（脚本报错？）'),
      };
    }

    try {
      fs.writeFileSync(path.join(root, pidFile(id)), String(realPid), 'utf8');
    } catch {}

    log('[adapter] ' + (a.name || id || '适配器') + ' 已启动 pid=' + realPid);
    return {
      ok: true,
      pid: realPid,
      elevated,
      note: elevated
        ? '已启动（pid ' + realPid + '）。服务本身是管理员，没有弹 UAC。'
        : '已启动（pid ' + realPid + '）。这个适配器不需要管理员权限。',
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
      const psOk = code === 0 && Number.isFinite(spawnedPid) && spawnedPid > 0;

      /**
       * 判断成功不看 PowerShell 的退出码，而是看「桥接进程是不是真起来了」。
       *
       * 实测：UAC 点「是」之后桥接确实跑起来了，但 PowerShell 的退出码
       * 和 -PassThru 拿到的 PID 都不可靠（提权进程的父子关系被系统改写），
       * 于是面板误报「UAC 被取消」。以进程/端口为准。
       */
      let realPid = 0;
      const rounds = psOk ? 10 : 6; // UAC 被拒时也给几秒，避免误判
      for (let i = 0; i < rounds && !realPid; i++) {
        await new Promise((r) => setTimeout(r, 700));
        realPid = await findBridgePid();
      }

      let hasLog = false;
      try {
        hasLog = fs.existsSync(cmd.logPath) && fs.statSync(cmd.logPath).size > 0;
      } catch {}

      // 桥接真的起来了（哪怕拿不到 PID：-1 表示有实例但看不到进程号）
      if (realPid) {
        if (realPid > 0) {
          try {
            fs.writeFileSync(path.join(root, pidFile(id)), String(realPid), 'utf8');
          } catch {}
        }
        log('[adapter] 已启动 ' + (realPid > 0 ? 'pid=' + realPid : '（提权实例，PID 不可见）'));
        resolve({
          ok: true,
          pid: realPid > 0 ? realPid : 0,
          logStarted: hasLog,
          elevated: true,
          note:
            '已启动' +
            (realPid > 0 ? '（pid ' + realPid + '）' : '（管理员实例）') +
            (hasLog ? '，日志在 adapter/data/panel-run.log。' : '。'),
        });
        return;
      }

      resolve({
        ok: false,
        error:
          '没有启动成功。多半是 UAC 被取消了 —— 适配器需要管理员权限才能操作微信窗口，' +
          '请重试并在弹窗点「是」。也可以手动右键 adapter/data/panel-launch.bat 用管理员运行。',
      });
    });
  });
}

/**
 * 停止。
 *
 * 优先按记录的 PID 杀（连带子进程）；拿不到 PID 时（提权实例），
 * 用锁端口反查到底是哪个进程在监听，再杀它。
 */
export async function stop(root, log = () => {}, id) {
  const pid = readPid(root, id);

  if (pid && alive(pid)) {
    return await killPid(root, pid, log, id);
  }

  // 记录里没有，但可能真有实例在跑（提权启动的那种）
  const found = await findBridgePid();

  if (found > 0) return await killPid(root, found, log, id);

  if (found === -1) {
    // 有实例但看不到 PID：用 netstat 反查监听 47821 的进程号
    const owner = await pidListeningOn(LOCK_PORT);
    if (owner && owner > 0) return await killPid(root, owner, log, id);

    return {
      ok: false,
      error:
        '检测到适配器在跑，但它是管理员权限启动的，面板这边看不到它的进程号，也杀不掉。' +
        '请到任务管理器结束 python.exe，或者手动关掉那个黑色命令行窗口。',
    };
  }

  try {
    fs.rmSync(path.join(root, pidFile(id)), { force: true });
  } catch {}
  return { ok: true, note: '本来就没在跑' };
}

/** 杀掉某个 PID（连带子进程），并清掉记录 */
function killPid(root, pid, log = () => {}, id) {
  return new Promise((resolve) => {
    // /T 连带子进程（cmd → python）
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], (err) => {
      try {
        fs.rmSync(path.join(root, pidFile(id)), { force: true });
      } catch {}
      if (err) {
        /**
         * 常见情况：适配器是管理员启动的，而面板不是 ——
         * Windows 不允许低权限进程结束高权限进程，taskkill 会报「找不到这个进程」
         * （其实是被挡住了，不是真的不存在）。这时给可操作的提示。
         */
        resolve({
          ok: false,
          error:
            '停止失败：适配器是管理员权限启动的，普通权限的面板结束不了它。' +
            '三选一：① 关掉那个黑色命令行窗口（桥接会跟着退出）；' +
            '② 任务管理器 → 详细信息 → 结束 python.exe；' +
            '③ 用管理员身份运行 桌面控制台.bat，再点停止。',
        });
      } else {
        log('[adapter] 已停止 pid=' + pid);
        resolve({ ok: true, note: '已停止' });
      }
    });
  });
}
