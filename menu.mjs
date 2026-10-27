/**
 * 鲸鲸 · 控制面板
 *
 * 一个菜单搞定所有操作：启动、停止、打开控制台、配置、诊断。
 *
 * 用法: runtime\node.exe menu.mjs
 */
import { execFile, spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const isWin = process.platform === 'win32';

// ===== 颜色 =====
const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
};
const col = (c, s) => `${C[c]}${s}${C.reset}`;

// ===== 工具 =====

let rl = null;

function ask(prompt) {
  // readline 可能被 launchForeground 关掉过，这里按需重建
  if (!rl) rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    try {
      rl.question(prompt, resolve);
    } catch {
      // 流已关闭，直接返回空
      resolve('');
    }
  });
}

function closeRl() {
  if (rl) {
    try {
      rl.close();
    } catch {}
    rl = null;
  }
}

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  } catch {
    return null;
  }
}

/** 端口是否在监听。 */
function checkPort(port) {
  return new Promise((resolve) => {
    const s = net.createConnection({ host: '127.0.0.1', port, timeout: 800 });
    s.on('connect', () => {
      s.destroy();
      resolve(true);
    });
    s.on('timeout', () => {
      s.destroy();
      resolve(false);
    });
    s.on('error', () => resolve(false));
  });
}

function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPid(file) {
  try {
    const pid = Number(fs.readFileSync(file, 'utf8').trim());
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

/** 检查服务状态。 */
async function checkStatus() {
  const cfg = readConfig() || {};
  const port = cfg.server?.port || 8899;

  const webAlive = await checkPort(port);
  const bridgeAlive = await checkPort(47821);

  return {
    port,
    webAlive,
    bridgeAlive,
    pid: readPid(path.join(ROOT, 'data', 'app.pid')),
    hasLlmKey: Boolean(cfg.llm?.apiKey),
    hasVisionKey: Boolean(cfg.vision?.apiKey || cfg.llm?.apiKey),
    hasSearchKey: Boolean(cfg.search?.apiKey),
    cfg,
  };
}

/** 打开网址。 */
function openUrl(url) {
  try {
    if (isWin) {
      spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    } else if (process.platform === 'darwin') {
      execFile('open', [url]);
    } else {
      execFile('xdg-open', [url]);
    }
    console.log(col('green', `  ✓ 已打开 ${url}`));
  } catch (e) {
    console.log(col('red', `  ✗ 打开失败: ${e.message}`));
    console.log(col('dim', `  手动访问: ${url}`));
  }
}

// ===== 界面 =====

function printHeader(st) {
  console.log('');
  console.log(col('cyan', '  ╔══════════════════════════════════════════════╗'));
  console.log(col('cyan', '  ║') + '        鲸鲸 · 控制面板                       ' + col('cyan', '║'));
  console.log(col('cyan', '  ╚══════════════════════════════════════════════╝'));
  console.log('');

  const dot = (ok) => (ok ? col('green', '●') : col('dim', '○'));
  const label = (ok, on, off) => (ok ? col('green', on) : col('dim', off));

  console.log(`    服务    ${dot(st.webAlive)} ${label(st.webAlive, '运行中', '已停止')}   ${col('dim', `端口 ${st.port}`)}`);
  console.log(`    适配器  ${dot(st.bridgeAlive)} ${label(st.bridgeAlive, '已接入', '未接入')}`);
  console.log('');

  const keyMark = (ok) => (ok ? col('green', '✓') : col('yellow', '!'));
  console.log(
    `    配置    ${keyMark(st.hasLlmKey)} 对话  ${keyMark(st.hasVisionKey)} 看图  ${keyMark(st.hasSearchKey)} 联网`,
  );
  if (!st.hasLlmKey) {
    console.log(col('yellow', '            ↑ 还没填 API Key，选 1 启动时会引导配置'));
  }
  console.log('');
}

function printMenu(st) {
  console.log(col('dim', '  ────────────────────────────────────────────────'));
  console.log('');
  console.log(`   ${col('cyan', '1')}  启动服务        ${col('dim', st.webAlive ? '（已在运行）' : '配好 Key 后自动开浏览器')}`);
  console.log(`   ${col('cyan', '2')}  打开控制台      ${col('dim', 'Key、角色卡、能力开关')}`);
  console.log(`   ${col('cyan', '3')}  打开聊天页      ${col('dim', '网页版对话')}`);
  console.log(`   ${col('cyan', '4')}  接入聊天平台    ${col('dim', '怎么把微信/QQ 接进来')}`);
  console.log(`   ${col('cyan', '5')}  测试全部能力    ${col('dim', '对话 / 看图 / 联网')}`);
  console.log(`   ${col('cyan', '6')}  查看详细状态`);
  console.log(`   ${col('cyan', '7')}  停止全部`);
  console.log(`   ${col('cyan', '8')}  开机自启说明`);
  console.log(`   ${col('cyan', '9')}  关掉「关网页即停服务」  ${col('dim', '应急用，不依赖服务在跑')}`);
  console.log(`   ${col('cyan', '0')}  退出`);
  console.log('');
}

// ===== 操作 =====

async function startService() {
  const st = await checkStatus();

  if (st.webAlive) {
    console.log(col('yellow', `  ! 服务已在运行（端口 ${st.port}）`));
    console.log(col('dim', '   要重启请先选 7 停止'));
    return;
  }

  // 没 Key 时走前台，让用户按提示配置
  if (!st.hasLlmKey) {
    console.log(col('yellow', '  ! 还没配置 API Key'));
    console.log('');
    console.log('  需要一个对话模型的 Key。推荐 DeepSeek（便宜稳定）：');
    console.log(col('dim', '  https://platform.deepseek.com/api_keys'));
    console.log('');
    const go = (await ask('  现在配置？(Y/n): ')).trim().toLowerCase();
    if (go === 'n') {
      console.log(col('dim', '  取消'));
      return;
    }

    console.log('');
    console.log(col('cyan', '  启动服务，请按提示填写…'));
    console.log('');
    await launchForeground();
    return;
  }

  console.log(col('dim', '  正在后台启动…'));
  const r = await launchBackground();

  if (r.ok) {
    console.log(col('green', '  ✓ 服务已启动'));
    console.log(col('dim', `    http://127.0.0.1:${st.port}`));
    await new Promise((res) => setTimeout(res, 1800));
    openUrl(`http://127.0.0.1:${st.port}/console`);
  } else {
    console.log(col('red', `  ✗ 启动失败: ${r.error}`));
  }
}

function launchBackground() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'launch_background.mjs')], {
      cwd: ROOT,
      stdio: 'pipe',
      windowsHide: true,
    });

    let out = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (out += d.toString()));

    const timer = setTimeout(() => resolve({ ok: true, out }), 15000);
    timer.unref?.();

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? { ok: true, out } : { ok: false, error: out.slice(-300) || `退出码 ${code}` });
    });
  });
}

function launchForeground() {
  return new Promise((resolve) => {
    closeRl(); // 让子进程能独占 stdin
    const child = spawn(process.execPath, [path.join(ROOT, 'app.mjs')], {
      cwd: ROOT,
      stdio: 'inherit',
    });
    child.on('close', () => resolve());
  });
}

async function testAll() {
  const st = await checkStatus();

  if (!st.webAlive) {
    console.log(col('yellow', '  ! 服务未运行，请先选 1'));
    return;
  }

  console.log(col('dim', '  测试中…'));
  console.log('');

  try {
    const res = await fetch(`http://127.0.0.1:${st.port}/api/admin/test/all`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    const j = await res.json();

    const line = (name, r, fmt) => {
      if (r?.ok) console.log(`  ${col('green', '✓')} ${name.padEnd(4)} ${col('dim', fmt(r))}`);
      else console.log(`  ${col('red', '✗')} ${name.padEnd(4)} ${col('red', (r?.error || '失败').slice(0, 50))}`);
    };

    line('对话', j.llm, (r) => `${r.ms}ms`);
    line('看图', j.vision, (r) => `${r.ms}ms  ${r.answer || ''}`);
    line('联网', j.search, (r) => `${r.ms}ms  ${r.count || 0} 条`);

    console.log('');
    const allOk = j.llm?.ok && j.vision?.ok && j.search?.ok;
    console.log(allOk ? col('green', '  全部正常') : col('yellow', '  有项目未通过，选 2 进控制台检查'));
  } catch (e) {
    console.log(col('red', `  ✗ 测试失败: ${e.message}`));
  }
}

async function showStatus() {
  const st = await checkStatus();
  const cfg = st.cfg || {};

  console.log(col('dim', '  ────────────────────────────────────────────────'));
  console.log('');
  console.log('  ' + col('bold', '服务'));
  console.log(`    状态      ${st.webAlive ? col('green', '运行中') : col('dim', '已停止')}`);
  console.log(`    地址      http://127.0.0.1:${st.port}`);
  console.log(`    PID       ${st.pid || '-'}`);
  console.log('');
  console.log('  ' + col('bold', '模型'));
  console.log(`    对话      ${(cfg.llm?.model || '-').padEnd(28)} ${st.hasLlmKey ? col('green', 'Key 已配置') : col('yellow', 'Key 未配置')}`);
  console.log(`    看图      ${(cfg.vision?.model || '-').padEnd(28)} ${st.hasVisionKey ? col('green', 'Key 已配置') : col('yellow', 'Key 未配置')}`);
  console.log(`    联网      ${(cfg.search?.provider || '-').padEnd(28)} ${st.hasSearchKey ? col('green', 'Key 已配置') : col('yellow', 'Key 未配置')}`);
  console.log('');
  console.log('  ' + col('bold', '适配器'));
  console.log(`    状态      ${st.bridgeAlive ? col('green', '已接入') : col('dim', '未接入')}`);
  console.log(col('dim', '    本框架不含平台代码，接入方式见 4'));
  console.log('');
  console.log('  ' + col('bold', '角色'));
  console.log(`    当前      ${cfg.card || '默认'}`);
  console.log('');
}

async function stopAll() {
  console.log(col('dim', '  正在停止…'));

  let stopped = 0;

  const pidFile = path.join(ROOT, 'data', 'app.pid');
  const pid = readPid(pidFile);

  if (pid && isAlive(pid)) {
    try {
      process.kill(pid);
      stopped++;
      console.log(col('green', `  ✓ 已停止服务（PID ${pid}）`));
    } catch (e) {
      console.log(col('red', `  ✗ 停止失败: ${e.message}`));
    }
  } else {
    console.log(col('dim', '  - 服务未运行'));
  }

  try {
    fs.unlinkSync(pidFile);
  } catch {}

  if (stopped === 0) console.log(col('dim', '  没有需要停止的进程'));
  console.log('');
  console.log(col('dim', '  提示：适配器是独立进程，请在它自己的窗口里停止'));
}

async function showAdapterHelp() {
  console.log('');
  console.log(col('bold', '  接入聊天平台'));
  console.log('');
  console.log('  这个程序本身**不包含任何聊天平台的登录或自动化代码**。');
  console.log('  它只对外提供一套 HTTP 接口，由「适配器」把消息送进来。');
  console.log('');
  console.log(col('dim', '  协议：docs/adapter-protocol.md'));
  console.log(col('dim', '  示例：examples/adapter-skeleton/'));
  console.log('');
  console.log('  自己写一个适配器只需要做三件事：');
  console.log(col('dim', '    1. 收到消息 → POST /api/wechat → 拿 bubbles 逐条发出去'));
  console.log(col('dim', '    2. 每 20 秒 POST /api/bridge/heartbeat'));
  console.log(col('dim', '    3. 想收藏图片 → POST /api/media/ingest'));
  console.log('');
  console.log('  想先看看能不能跑通？');
  console.log(col('dim', `    ${process.execPath} examples/adapter-skeleton/adapter.mjs`));
  console.log('');
  console.log('  不接任何平台也能用：控制台网页里可以直接聊。');
  console.log('');
  await ask('  按回车返回');
}

async function autostartHelp() {
  const startupDir = path.join(
    os.homedir(),
    'AppData',
    'Roaming',
    'Microsoft',
    'Windows',
    'Start Menu',
    'Programs',
    'Startup',
  );

  console.log('  ' + col('bold', '设置开机自启'));
  console.log('');
  console.log('  方法一（推荐）：');
  console.log(col('dim', '    1. 按 Win+R，输入 shell:startup 回车'));
  console.log(col('dim', '    2. 在打开的文件夹里，右键 → 新建 → 快捷方式'));
  console.log(col('dim', `    3. 位置填：${path.join(ROOT, '启动服务.bat')}`));
  console.log(col('dim', '    4. 下一步 → 完成'));
  console.log('');
  console.log('  方法二：');
  console.log(col('dim', '    把 启动服务.bat 直接拖进那个启动文件夹'));
  console.log('');
  console.log(col('dim', `  启动文件夹位置：${startupDir}`));
}

// ===== 主循环 =====

/**
 * 应急：关掉「关网页即停服务」。
 *
 * 为什么要单独放一个菜单项：
 *   那个开关一开，关掉网页服务就退出了 —— 万一碰上问题，
 *   网页打不开就没法去界面上关它。这里直接改 config.json，
 *   不依赖服务是否在跑，属于最后一道退路。
 */
async function resetAutoStop() {
  const cfgFile = path.join(ROOT, 'config.json');
  console.log('  ' + col('bold', '关掉「关网页即停服务」'));
  console.log('');

  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  } catch (e) {
    console.log(col('red', `  ✗ 读不到 config.json: ${e.message}`));
    return;
  }

  cfg.server = cfg.server || {};
  const was = cfg.server.stopWhenNoConsole === true;

  if (!was) {
    console.log(col('green', '  ✓ 它本来就是关着的，不用改'));
  } else {
    cfg.server.stopWhenNoConsole = false;
    try {
      fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2), 'utf8');
      console.log(col('green', '  ✓ 已关掉：关网页不会再停服务了'));
    } catch (e) {
      console.log(col('red', `  ✗ 写不进去: ${e.message}`));
      return;
    }
  }

  // 顺手放一个 keep-alive 标记，双保险
  try {
    const flag = path.join(ROOT, 'data', 'keep-alive');
    fs.mkdirSync(path.dirname(flag), { recursive: true });
    if (!fs.existsSync(flag)) {
      fs.writeFileSync(flag, '存在这个文件时，「关网页即停服务」一律不生效\n', 'utf8');
      console.log(col('dim', '  （顺手建了 data/keep-alive，双保险）'));
    }
  } catch {}

  console.log('');
  console.log(col('dim', '  服务如果正在跑，需要重启才生效；没跑就下次启动生效。'));
}

async function main() {
  try {
    process.stdout.write('\x1b[2J\x1b[H');
  } catch {}

  while (true) {
    const st = await checkStatus();
    printHeader(st);
    printMenu(st);

    const choice = (await ask('  请选择: ')).trim();
    console.log('');

    switch (choice) {
      case '1':
        await startService();
        break;
      case '2':
        if (!st.webAlive) console.log(col('yellow', '  ! 服务未运行，请先选 1'));
        else openUrl(`http://127.0.0.1:${st.port}/console`);
        break;
      case '3':
        if (!st.webAlive) console.log(col('yellow', '  ! 服务未运行，请先选 1'));
        else openUrl(`http://127.0.0.1:${st.port}`);
        break;
      case '4':
        await showAdapterHelp();
        break;
      case '5':
        await testAll();
        break;
      case '6':
        await showStatus();
        break;
      case '7':
        await stopAll();
        break;
      case '8':
        await autostartHelp();
        break;
      case '9':
        await resetAutoStop();
        break;
      case '0':
        closeRl();
        console.log(col('dim', '  再见'));
        return;
      default:
        console.log(col('dim', '  请输入 0-9'));
    }

    console.log('');
    await ask(col('dim', '  按回车继续…'));
    try {
      process.stdout.write('\x1b[2J\x1b[H');
    } catch {}
  }
}

main().catch((e) => {
  console.error(col('red', '\n出错了: ' + e.message));
  closeRl();
  process.exit(1);
});
