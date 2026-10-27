/**
 * 分发前扫描 dist/：查 Key、wxid、本机路径、手机号。
 *
 * 和 pack.mjs 内置的扫描互补：这里按「最终目录」再查一遍，
 * 因为打包流程里有几步会额外生成文件（config.json、使用说明.md、bridge 配置）。
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'dist';
const TEXT_EXT = /\.(mjs|js|cjs|json|py|html|htm|bat|ps1|md|txt|yml|yaml|cfg|ini|toml)$/i;

const PATTERNS = [
  ['sk- Key', /sk-[A-Za-z0-9_-]{24,}/g],
  ['智谱 Key', /[a-f0-9]{32}\.[A-Za-z0-9]{16}/g],
  ['wxid', /wxid_(?!x{6,}|0{6,}|1{6,})[a-z0-9]{8,}/g],
  ['ilink bot', /[a-zA-Z0-9_-]{20,}@im\.(bot|wechat)/g],
  [
    '本机路径',
    /C:[\\/]{1,2}Users[\\/]{1,2}(?!<|%|Public|username|user\b)[A-Za-z0-9_.-]{2,}/g,
  ],
  ['手机号', /(?<!\d)1[3-9]\d{9}(?!\d)/g],
  // 打包人的个人痕迹
  ['本机用户名', /\bjunka\b/gi],
  ['桌面旧拷贝', /Desktop[\\/]{1,2}j\b/g],
  ['旧目录名', /bridge_wg/g],
];

const IGNORE = /xxxx|change-me|your|example|placeholder|mock|fake|test-key|sk-xxx|sk-your|demo/i;

let scanned = 0;
let skipped = 0;
const hits = [];

function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const rel = path.relative(ROOT, full).split(path.sep).join('/');

    // 第三方运行时里全是构建路径，查它只会噪声
    if (rel.startsWith('runtime/')) {
      skipped++;
      continue;
    }

    const st = fs.statSync(full);
    if (st.isDirectory()) {
      walk(full);
      continue;
    }
    if (!TEXT_EXT.test(name) || st.size > 3 * 1024 * 1024) continue;

    scanned++;
    let text = '';
    try {
      text = fs.readFileSync(full, 'utf8');
    } catch {
      continue;
    }

    for (const [label, re] of PATTERNS) {
      const m = text.match(re);
      if (!m) continue;
      for (const s of m) {
        if (IGNORE.test(s)) continue;
        hits.push(`${label}  ${rel}  →  ${s.slice(0, 60)}`);
      }
    }
  }
}

walk(ROOT);

console.log('  扫描文件数:', scanned, '（跳过 runtime/ 目录 ' + skipped + ' 个）');
console.log('');

if (hits.length) {
  console.log('  ⚠ 命中', hits.length, '处：');
  for (const h of hits.slice(0, 30)) console.log('    ' + h);
} else {
  console.log('  ✓ 没有敏感字符串');
}

// 顺带列一下根目录都有什么，人工过一眼
console.log('');
console.log('  根目录内容:');
const rootFiles = fs.readdirSync(ROOT).sort();
for (const f of rootFiles) {
  const st = fs.statSync(path.join(ROOT, f));
  console.log(`    ${st.isDirectory() ? '[D]' : '   '} ${f}`);
}

process.exit(hits.length ? 1 : 0);
