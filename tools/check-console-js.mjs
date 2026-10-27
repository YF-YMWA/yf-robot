/** 抽取 console.html 里的内联脚本做语法检查。 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const html = fs.readFileSync(path.join(process.cwd(), 'web', 'console.html'), 'utf8');

// 取所有 <script> 块（没有 src 的）
const blocks = [];
const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
let m;
while ((m = re.exec(html)) !== null) {
  blocks.push({ code: m[1], index: m.index });
}

console.log(`找到 ${blocks.length} 段内联脚本`);

const tmpDir = path.join(process.cwd(), 'data', 'tmp');
fs.mkdirSync(tmpDir, { recursive: true });

let bad = 0;

blocks.forEach((b, i) => {
  const f = path.join(tmpDir, `console-script-${i}.mjs`);

  // 找出这段代码在原文的行号，方便定位
  const line = html.slice(0, b.index).split('\n').length;

  // 包一层 async 函数，避免顶层 await / return 报错
  const wrapped = `async function __wrap(){\n${b.code}\n}\n`;

  fs.writeFileSync(f, wrapped, 'utf8');

  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
    console.log(`  [${i}] 行 ${line}  ✓ ${b.code.split('\n').length} 行`);
  } catch (e) {
    bad++;
    const msg = String(e.stderr || e.stdout || '').split('\n').slice(0, 6).join('\n');
    console.log(`  [${i}] 行 ${line}  ✗ 语法错误`);
    console.log(
      msg
        .split('\n')
        .map((l) => '      ' + l)
        .join('\n'),
    );
  } finally {
    try {
      fs.unlinkSync(f);
    } catch {}
  }
});

console.log('');
console.log(bad ? `✗ ${bad} 段有语法错误` : '✓ 全部通过');
