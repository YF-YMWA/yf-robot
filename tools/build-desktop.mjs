/** 编译启动器（用系统自带 csc，不需要装 .NET SDK）。 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = process.cwd();
const SRC = path.join(ROOT, 'desktop', 'YFRobotTray.cs');
const ICON = path.join(ROOT, 'desktop', 'YF-Robot.ico');
const TMPDIR = path.join(ROOT, '.tmp', 'ctmp');
// 先编译到临时目录再搬过来：某些安全软件会拦 csc 直接往项目目录写 exe
const OUT = path.join(TMPDIR, 'YF-Robot.exe');
// exe 放在最外层：解压后第一眼就能看到，不用进 desktop/ 找
const FINAL = path.join(ROOT, 'YF-Robot.exe');
const OLD = path.join(ROOT, 'desktop', 'YF-Robot.exe');
const VERSION_CS = path.join(TMPDIR, 'VersionInfo.cs');

/** 找 csc.exe：优先 64 位 .NET Framework 4 */
function findCsc() {
  const candidates = [
    'C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe',
    'C:/Windows/Microsoft.NET/Framework/v4.0.30319/csc.exe',
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
}

fs.mkdirSync(TMPDIR, { recursive: true });

const csc = findCsc();
if (!csc) {
  console.error('  [X] 找不到 csc.exe（Windows 自带的 C# 编译器）');
  process.exit(1);
}
if (!fs.existsSync(SRC)) {
  console.error('  [X] 找不到源码：' + SRC);
  process.exit(1);
}
if (!fs.existsSync(ICON)) {
  console.error('  [X] 找不到图标：' + ICON);
  process.exit(1);
}

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const ver = String(pkg.version || '0.0.0');
const parts = ver.split('.').map((n) => parseInt(n, 10) || 0);
while (parts.length < 4) parts.push(0);
const asmVer = parts.slice(0, 4).join('.');

fs.writeFileSync(
  VERSION_CS,
  `using System.Reflection;
[assembly: AssemblyTitle("YF-Robot 启动器")]
[assembly: AssemblyDescription("YF-Robot 桌面启动器（托盘 + 本地面板）")]
[assembly: AssemblyProduct("YF-Robot")]
[assembly: AssemblyCompany("YF-YMWA")]
[assembly: AssemblyCopyright("YF-YMWA")]
[assembly: AssemblyVersion("${asmVer}")]
[assembly: AssemblyFileVersion("${asmVer}")]
[assembly: AssemblyInformationalVersion("${ver}")]
`,
  'utf8',
);

console.log('  编译器:', csc);
console.log('  源码:', path.relative(ROOT, SRC));
console.log('  版本:', ver);

const args = [
  '/nologo',
  '/target:winexe',
  '/platform:anycpu',
  '/optimize+',
  '/win32icon:' + ICON,
  '/out:' + OUT,
  '/reference:System.dll',
  '/reference:System.Windows.Forms.dll',
  '/reference:System.Drawing.dll',
  '/reference:System.Core.dll',
  '/reference:System.Management.dll',
  '/reference:System.IO.Compression.dll',
  '/reference:System.IO.Compression.FileSystem.dll',
  '/reference:' + path.join(ROOT, 'desktop', 'lib', 'Microsoft.Web.WebView2.Core.dll'),
  '/reference:' + path.join(ROOT, 'desktop', 'lib', 'Microsoft.Web.WebView2.WinForms.dll'),
  SRC,
  VERSION_CS,
];

try {
  const out = execFileSync(csc, args, {
    encoding: 'utf8',
    timeout: 120000,
    // 临时目录指到项目内：csc 默认写系统 TEMP，某些安全软件会拦（CS1567）
    env: { ...process.env, TMP: TMPDIR, TEMP: TMPDIR },
  });
  if (out.trim()) console.log(out.trim());
} catch (e) {
  console.error('  编译失败：');
  console.error(String(e.stdout || e.message).slice(0, 1200));
  process.exit(1);
}

try {
  fs.copyFileSync(OUT, FINAL);
  fs.unlinkSync(OUT);
} catch (e) {
  console.error('  [X] 写入 ' + path.relative(ROOT, FINAL) + ' 失败：' + e.message);
  console.error('      （关掉正在运行的 YF-Robot 再试一次）');
  process.exit(1);
}

// 旧位置留着的 exe 会让人误点，直接清掉
try {
  if (fs.existsSync(OLD)) fs.unlinkSync(OLD);
} catch {}

const size = fs.statSync(FINAL).size;
console.log(`  ✓ 已生成 ${path.relative(ROOT, FINAL)}（${(size / 1024).toFixed(0)} KB，含图标与版本信息）`);
