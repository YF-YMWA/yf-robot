/** 测试联网搜索能力。 */
import { SearchClient, needsSearch, checkGrounding } from '../core/search.mjs';
import { loadConfig } from '../core/config.mjs';

const cfg = loadConfig();

console.log('=== 联网搜索测试 ===');
console.log(`服务商: ${cfg.search.provider}`);
console.log('');

const search = new SearchClient(cfg.search, { logger: console });

// 1. 测试是否需要搜索的判断
console.log('--- 1. 搜索触发判断 ---');
const triggers = [
  '今天天气怎么样',
  '明天会下雨吗',
  '最近有什么新闻',
  '今天好累啊',          // 情绪，不该搜
  '你好',                // 闲聊，不该搜
  'DeepSeek 最新版本是什么',
  '现在几点了',
];
for (const t of triggers) {
  const need = needsSearch(t);
  console.log(`  ${need ? '搜索' : '不搜'}  ${t}`);
}

console.log('');
console.log('--- 2. 实际搜索 ---');

const queries = ['今天北京时间', 'DeepSeek 公司简介'];

for (const q of queries) {
  console.log(`\n查询: ${q}`);
  const t0 = Date.now();
  try {
    const results = await search.search(q);
    console.log(`  耗时: ${Date.now() - t0}ms，结果 ${results.length} 条`);

    if (results.length) {
      for (const r of results.slice(0, 3)) {
        console.log(`  · ${r.title}`);
        console.log(`    ${(r.snippet || '').slice(0, 80)}`);
      }
    } else {
      console.log('  （无结果）');
    }
  } catch (e) {
    console.log(`  ✗ 失败: ${e.message}`);
  }
}

console.log('');
console.log('--- 3. 防幻觉校验 ---');
const src = [
  { title: '北京天气预报', snippet: '今天北京天气：晴，气温 12 到 22 度，北风 2 级。', url: 'http://example.com' },
];
const tests = [
  { reply: '今天北京晴，12 到 22 度', label: '数字一致', expect: true },
  { reply: '今天北京晴，15 到 25 度', label: '数字不符', expect: false },
  { reply: '今天北京下雨，气温 5 度', label: '内容不符', expect: false },
];
for (const t of tests) {
  const ok = checkGrounding(t.reply, src);
  const mark = ok === t.expect ? '✓' : '✗';
  console.log(`  ${mark} ${t.label}: checkGrounding=${ok}（期望 ${t.expect}）`);
}
