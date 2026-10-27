/** 检查 console.html 里调用的函数是否都定义了。 */
import fs from 'node:fs';
import path from 'node:path';

const html = fs.readFileSync(path.join(process.cwd(), 'web', 'console.html'), 'utf8');

// 提取内联脚本
const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
let code = '';
let m;
while ((m = re.exec(html)) !== null) code += m[1] + '\n';

// 定义的函数
const defined = new Set();
for (const mm of code.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(/g)) defined.add(mm[1]);
for (const mm of code.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/g)) defined.add(mm[1]);
for (const mm of code.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?function/g)) defined.add(mm[1]);

// 浏览器/JS 内置，不算缺失
const BUILTIN = new Set([
  'if','for','while','switch','catch','return','typeof','new','function','async','await',
  'parseInt','parseFloat','isNaN','encodeURIComponent','decodeURIComponent','setTimeout','setInterval',
  'clearTimeout','clearInterval','confirm','alert','fetch','prompt','Number','String','Boolean','Array',
  'Object','JSON','Math','Date','URL','Blob','FormData','FileReader','Promise','Error','RegExp','Map','Set',
  'console','structuredClone','requestAnimationFrame','atob','btoa',
  'TextDecoder','TextEncoder','Uint8Array','ArrayBuffer','Intl','Uint8ClampedArray',
  'resolve','reject','rgba','var','require','globalThis',
]);

// onclick / onchange 等属性里调用的函数
const attrCalls = new Set();
for (const mm of html.matchAll(/\bon(?:click|change|input|submit|load)\s*=\s*"([^"]*)"/g)) {
  const expr = mm[1];
  for (const c of expr.matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)) attrCalls.add(c[1]);
}

// 脚本里调用的函数
const scriptCalls = new Set();
for (const mm of code.matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)) scriptCalls.add(mm[1]);

// 函数参数也当「已定义」——回调里的参数名会被 (xxx( 这种模式误判成漏定义
const params = new Set();
for (const mm of code.matchAll(/(?:\(([^()]*)\)|([A-Za-z_$][\w$]*))\s*=>/g)) {
  for (const part of String(mm[1] || mm[2] || '').split(',')) {
    const nm = part.trim().split(/[=:]/)[0].trim();
    if (/^[A-Za-z_$][\w$]*$/.test(nm)) params.add(nm);
  }
}
for (const mm of code.matchAll(/function\s*[A-Za-z_$]?[\w$]*\s*\(([^()]*)\)/g)) {
  for (const part of String(mm[1] || '').split(',')) {
    const nm = part.trim().split(/[=:]/)[0].trim();
    if (/^[A-Za-z_$][\w$]*$/.test(nm)) params.add(nm);
  }
}

const missing = [];
for (const fn of [...attrCalls, ...scriptCalls]) {
  if (BUILTIN.has(fn)) continue;
  if (defined.has(fn)) continue;
  if (params.has(fn)) continue;
  // 方法调用（obj.fn()）会匹配到 fn，这类跳过：检查它前面是不是点
  const asMethod = new RegExp(`\\.\\s*${fn.replace(/\$/g, '\\$')}\\s*\\(`).test(html);
  if (asMethod) continue;
  missing.push(fn);
}

console.log(`定义了 ${defined.size} 个函数`);
console.log(`HTML 属性里调用 ${attrCalls.size} 个，脚本里调用 ${scriptCalls.size} 个`);
console.log('');

if (!missing.length) {
  console.log('✓ 没有调用未定义的函数');
} else {
  console.log(`✗ 有 ${missing.length} 个函数找不到定义：`);
  for (const fn of [...new Set(missing)].sort()) {
    // 找它在 html 里的位置
    const idx = html.indexOf(fn + '(');
    const line = idx >= 0 ? html.slice(0, idx).split('\n').length : '?';
    console.log(`    ${fn}   （约第 ${line} 行）`);
  }
}
