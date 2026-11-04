/**
 * 桌面软件化自检。
 *
 * 检查那些「不报错但用不了」的问题，例如：
 *   · ps1 没 BOM → PowerShell 5.1 按 ANSI 读，中文注释把引号吃掉 → 语法崩
 *   · vbs 不是 CRLF → wscript 解析异常
 *   · 快捷方式指向错的脚本 → 双击没反应
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = process.cwd();
const D = path.join(ROOT, 'desktop');

const results = [];
const record = (name, ok, detail = '') => results.push({ name, ok, detail });

/** ps1 必须是 UTF-8 BOM + CRLF */
function checkPs1(file) {
  const p = path.join(D, file);
  if (!fs.existsSync(p)) return record(file, false, '文件不存在');
  const buf = fs.readFileSync(p);
  const hasBom = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  const text = buf.toString('utf8');
  const lfOnly = /\r?\n/.test(text) && !text.includes('\r\n');
  record(file + ' 有 BOM', hasBom, hasBom ? '' : 'PowerShell 5.1 会按 ANSI 读，中文会崩');
  record(file + ' 行尾 CRLF', !lfOnly, lfOnly ? '只有 LF' : '');
}

/** vbs 必须 CRLF */
function checkVbs(file) {
  const p = path.join(D, file);
  if (!fs.existsSync(p)) return record(file, false, '文件不存在');
  const text = fs.readFileSync(p, 'utf8');
  const lfOnly = text.includes('\n') && !text.includes('\r\n');
  record(file + ' 行尾 CRLF', !lfOnly, lfOnly ? '只有 LF，wscript 可能解析失败' : '');
}

/** ps1 语法（用 PowerShell 解析器） */
function checkSyntax(file) {
  const p = path.join(D, file);
  if (!fs.existsSync(p)) return record(file + ' 语法', false, '文件不存在');
  try {
    const out = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        `$e=$null; [System.Management.Automation.Language.Parser]::ParseFile('${p.replace(/'/g, "''")}',[ref]$null,[ref]$e) | Out-Null; if($e){$e[0].Message}else{'OK'}`,
      ],
      { encoding: 'utf8', timeout: 20000, windowsHide: true },
    ).trim();
    record(file + ' 语法', out === 'OK', out === 'OK' ? '' : out.slice(0, 120));
  } catch (e) {
    record(file + ' 语法', false, String(e.message).slice(0, 120));
  }
}

/** 桌面快捷方式（装了才有） */
function checkShortcut() {
  const desktop = path.join(process.env.USERPROFILE || '', 'Desktop', 'YF-Robot.lnk');
  if (!fs.existsSync(desktop)) {
    record('桌面快捷方式', true, '未安装（可选）');
    return;
  }
  record('桌面快捷方式', true, '已安装');

  /**
   * 快捷方式必须带脚本参数。
   *
   * 真实事故：安装脚本里函数参数叫 $args（PowerShell 自动变量），
   * 赋值不生效 → 快捷方式参数为空 → 双击只弹「Windows 脚本宿主设置」窗口。
   * 这里用临时 ps1 去读，避免内联 -Command 的 $ 转义问题。
   */
  try {
    const tmp = path.join(ROOT, '.tmp', 'check-shortcut.ps1');
    fs.mkdirSync(path.dirname(tmp), { recursive: true });
    fs.writeFileSync(
      tmp,
      [
        '$sh = New-Object -ComObject WScript.Shell',
        `$sc = $sh.CreateShortcut('${desktop.replace(/'/g, "''")}')`,
        "if (-not (Test-Path $sc.TargetPath)) { 'MISSING' } elseif ($sc.TargetPath -like '*YF-Robot.exe') { 'EXE' } elseif ($sc.Arguments) { 'OK' } else { 'EMPTY' }",
      ].join('\r\n'),
      'utf8',
    );
    const out = execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', tmp], {
      encoding: 'utf8',
      timeout: 20000,
      windowsHide: true,
    }).trim();

    /**
     * 三种合法情况：
     *   EXE      直接指向根目录 YF-Robot.exe（参数本来就该为空）
     *   OK       wscript.exe + 脚本参数（回退方案）
     * 旧版本装过、exe 又被挪走的快捷方式会报 MISSING。
     */
    if (out === 'EXE') record('快捷方式参数', true, '指向根目录 exe，无需参数');
    else if (out === 'OK') record('快捷方式参数', true, 'wscript + 脚本路径');
    else if (out === 'MISSING') record('快捷方式参数', false, '快捷方式指向的文件不存在，重新跑一次安装软件.bat');
    else record('快捷方式参数', false, 'wscript 但没有脚本参数 → 双击只会打开脚本宿主设置');
  } catch (e) {
    record('快捷方式参数', false, String(e.message).slice(0, 80));
  }
}

/** 启动器界面（desktop/ui）：缺一个文件就是白屏 */
function checkUi() {
  const dir = path.join(D, 'ui');
  for (const f of ['index.html', 'style.css', 'app.js', 'icon.png']) {
    const p = path.join(dir, f);
    const ok = fs.existsSync(p) && fs.statSync(p).size > 200;
    record(`ui/${f}`, ok, ok ? '' : '文件缺失或内容为空');
  }

  const htmlPath = path.join(dir, 'index.html');
  const jsPath = path.join(dir, 'app.js');
  if (!fs.existsSync(htmlPath) || !fs.existsSync(jsPath)) return;

  const html = fs.readFileSync(htmlPath, 'utf8');
  record('index.html 引用本地样式', html.includes('href="style.css"'));
  record('index.html 引用本地脚本', html.includes('src="app.js"'));
  record('index.html 引用品牌图标', html.includes('src="icon.png"'));
  const offline = !/(?:src|href)="https?:/.test(html);
  record('index.html 不依赖外网资源', offline, offline ? '' : '不要引用 CDN，离线会白屏');
  const js = fs.readFileSync(jsPath, 'utf8');
  record('app.js 连接 C# 桥', js.includes('hostObjects') && js.includes('launcher'));
  record('app.js 调用后台动作', js.includes("call('Act'"));
}

/** exe 放最外层 + 图标（双击前第一眼看到的东西） */
function checkLauncher() {
  const exe = path.join(ROOT, 'YF-Robot.exe');
  const hasExe = fs.existsSync(exe) && fs.statSync(exe).size > 20000;
  record('根目录 YF-Robot.exe', hasExe, hasExe ? '' : '先跑 tools/build-desktop.mjs');

  const old = path.join(D, 'YF-Robot.exe');
  record('旧 desktop/exe 已移除', !fs.existsSync(old), 'exe 只放根目录，避免用户点错');

  const ico = path.join(D, 'YF-Robot.ico');
  const hasIco = fs.existsSync(ico) && fs.statSync(ico).size > 10000;
  record('品牌图标 YF-Robot.ico', hasIco, hasIco ? '' : '图标缺失，exe/快捷方式会退回默认图标');
}

console.log('  检查桌面软件化组件…\n');

checkPs1('YFRobotTray.ps1');
checkPs1('安装.ps1');
checkPs1('卸载.ps1');
checkVbs('YF-Robot.vbs');
checkVbs('安装.vbs');
checkVbs('卸载.vbs');
checkSyntax('YFRobotTray.ps1');
checkSyntax('安装.ps1');
checkSyntax('卸载.ps1');
checkUi();
checkLauncher();
checkShortcut();

let bad = 0;
for (const r of results) {
  if (!r.ok) bad++;
  const mark = r.ok ? '✓' : '✗';
  console.log(`  ${mark} ${r.name}${r.detail ? '  — ' + r.detail : ''}`);
}

console.log('');
console.log(bad ? `  ${bad} 项有问题` : '  全部正常');
process.exit(bad ? 1 : 0);
