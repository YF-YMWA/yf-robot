/**
 * 面板导航自检：指南里每个 goPage('x') 都必须真的能到达。
 *
 * 真实事故：指南里「去接入状态」点了没反应 ——
 * page-bridge 页面存在，但侧边栏没有入口，goPage 找不到 <a> 就静默什么都不做。
 */
import fs from 'node:fs';

const s = fs.readFileSync('web/console.html', 'utf8');

const navPages = new Set([...s.matchAll(/data-page="([a-z-]+)"/g)].map((m) => m[1]));
const pageIds = new Set([...s.matchAll(/id="page-([a-z-]+)"/g)].map((m) => m[1]));

// 分组里的标签也算可达（goPage 会先切分组再选标签）
let groups = {};
try {
  groups = JSON.parse(s.match(/const PAGE_GROUPS = (\{[\s\S]*?\});/)[1]);
} catch {
  groups = {};
}
const tabPages = new Set(
  Object.values(groups).flatMap((g) => (g.tabs || []).map((t) => t[0])),
);

const calls = [...new Set([...s.matchAll(/goPage\('([a-z-]+)'\)/g)].map((m) => m[1]))];

let bad = 0;
console.log('  指南里的跳转：');
for (const c of calls) {
  const exists = pageIds.has(c) || Boolean(groups[c]);
  const reachable =
    (navPages.has(c) && pageIds.has(c)) || (navPages.has(c) && Boolean(groups[c])) || tabPages.has(c);
  if (!reachable || !exists) bad++;
  console.log(
    `  goPage('${c}')`.padEnd(24),
    exists ? '页面✓' : '页面✗',
    reachable ? '可达✓' : '**点了没反应**',
  );
}

// 有页面但既不在导航、也不在任何分组里 = 无法从界面进入
const orphans = [...pageIds].filter(
  (p) => !navPages.has(p) && !tabPages.has(p) && p !== 'guide',
);
console.log('');
console.log('  无法从界面进入的页面:', orphans.length ? orphans.join(', ') : '无');

process.exit(bad || orphans.length ? 1 : 0);
