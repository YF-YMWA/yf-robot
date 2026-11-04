/** 编译托盘启动器（用系统自带 csc，不需要装 .NET SDK）。 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const ROOT = process.cwd();
const SRC = path.join(ROOT, 'desktop', 'YFRobotTray.cs');
// 先编译到临时目录再搬过来：某些安全软件会拦 csc 直接往项目目录写 exe
const OUT = path.join(ROOT, '.tmp', 'ctmp', 'YF-Robot.exe');
const FINAL = path.join(ROOT, 'desktop', 'YF-Robot.exe');

/** 找 csc.exe：优先 64 位 .NET Framework 4 */
function findCsc() {
  const candidates = [
    'C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe',
    'C:/Windows/Microsoft.NET/Framework/v4.0.30319/csc.exe',
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
}

const TMPDIR = path.join(ROOT, '.tmp', 'ctmp');
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

console.log('  编译器:', csc);
console.log('  源码:', path.relative(ROOT, SRC));

const args = [
  '/nologo',
  '/target:winexe',
  '/platform:anycpu',
  '/optimize+',
  '/out:' + OUT,
  '/reference:System.dll',
  '/reference:System.Windows.Forms.dll',
  '/reference:System.Drawing.dll',
  '/reference:System.Core.dll',
  '/reference:System.Management.dll',
  SRC,
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

fs.copyFileSync(OUT, FINAL);
 try { fs.unlinkSync(OUT); } catch {}
 const size = fs.statSync(FINAL).size;
console.log(`  ✓ 已生成 ${path.relative(ROOT, FINAL)}（${(size / 1024).toFixed(0)} KB）`);
