/**
 * 检查控制台页面结构：入口、标签组、孤儿页。
 *
 * 合并页面之后，很容易出现「页面还在、入口没了」或者反过来的情况。
 * 这个脚本把这类问题查出来，CI 里也跑。
 *
 * 用法：node tools/check-console-pages.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const file = path.join(process.cwd(), 'web', 'console.html');
const html = fs.readFileSync(file, 'utf8');

const pages = [...html.matchAll(/id="page-([a-z0-9-]+)"/g)].map((m) => m[1]);
const nav = [...html.matchAll(/data-page="([a-z0-9-]+)"/g)].map((m) => m[1]);

// 从 JS 里读分组定义（JSON.stringify 生成的是单行，不能靠换行找结尾）
const groups = {};
const start = html.indexOf('const PAGE_GROUPS = ');
if (start >= 0) {
  const from = html.indexOf('{', start);
  // 花括号配对，找到这个对象的结尾
  let depth = 0;
  let end = -1;
  for (let i = from; i < html.length; i++) {
    const ch = html[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  if (end > from) {
    try {
      const parsed = JSON.parse(html.slice(from, end));
      Object.assign(groups, parsed);
    } catch (e) {
      console.log(`  （分组定义解析失败：${e.message}）`);
    }
  }
}

const problems = [];

// 1. 每个页面都要能到达
const groupIds = Object.keys(groups);
const tabPages = Object.values(groups).flatMap((g) => g.tabs.map((t) => t[0]));
const reachable = new Set([...nav.filter((n) => !groupIds.includes(n)), ...tabPages]);

for (const p of pages) {
  if (!reachable.has(p)) problems.push(`页面 ${p} 没有任何入口`);
}

// 2. 每个入口都要有页面
for (const n of nav) {
  if (groupIds.includes(n)) continue;
  if (!pages.includes(n)) problems.push(`入口 ${n} 没有对应页面`);
}

// 3. 分组里引用的页面必须存在
for (const [gid, g] of Object.entries(groups)) {
  if (!nav.includes(gid)) problems.push(`分组 ${gid} 没有侧栏入口`);
  for (const [p] of g.tabs) {
    if (!pages.includes(p)) problems.push(`分组 ${gid} 引用不存在的页面 ${p}`);
  }
}

// 4. 一个页面不能同时是分组和普通页
for (const gid of groupIds) {
  if (pages.includes(gid)) problems.push(`${gid} 既是分组又是页面，会冲突`);
}

// 5. 必须有统一的 showPage 入口（合并后不再各写各的）
if (!html.includes('function showPage(')) problems.push('缺少统一的 showPage 入口');

console.log(`  页面 ${pages.length} 个，侧栏入口 ${nav.length} 个，分组 ${groupIds.length} 个`);
for (const [gid, g] of Object.entries(groups)) {
  console.log(`    ${gid}: ${g.tabs.map((t) => t[1] || t[0]).join(' / ')}`);
}
console.log('');

if (problems.length) {
  console.log(`✗ 有 ${problems.length} 个问题：`);
  for (const p of problems) console.log('   ·', p);
  process.exit(1);
}

console.log('✓ 页面结构正常（无孤儿页、无死入口）');
