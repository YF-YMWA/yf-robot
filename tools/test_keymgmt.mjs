/** 测试控制台的 Key 管理功能。 */
const BASE = 'http://127.0.0.1:8899/api/admin';

async function api(path, opts = {}) {
  const res = await fetch(`${BASE}/${path}`, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'content-type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return res.json();
}

console.log('=== Key 管理功能测试 ===');
console.log('');

// 1. 读取当前状态
console.log('【1】当前配置');
const c1 = await api('config');
console.log(`  对话: ${c1.llm.hasKey ? c1.llm.apiKeyMasked : '未配置'}`);
console.log(`  看图: ${c1.vision.hasKey ? c1.vision.apiKeyMasked : '未配置'}`);
console.log(`  联网: ${c1.search.hasKey ? c1.search.apiKeyMasked : '未配置'}`);
console.log(`  语音: ${c1.voice.hasKey ? c1.voice.apiKeyMasked : '未配置'}`);
console.log('');

// 2. 测试各项能力
console.log('【2】能力测试');
for (const [name, label] of [['llm', '对话'], ['vision', '看图'], ['search', '联网']]) {
  const t0 = Date.now();
  const r = await api('test/' + name, { method: 'POST', body: {} });
  const ms = Date.now() - t0;
  if (r.ok) {
    console.log(`  ✓ ${label}: ${r.ms || ms}ms`);
  } else {
    console.log(`  ✗ ${label}: ${r.error}`);
  }
}
console.log('');

// 3. 测试传掩码时不修改 Key（模拟前端回传）
console.log('【3】掩码保护（传 **** 不应修改）');
const before = c1.llm.apiKeyMasked;
await api('config', { method: 'POST', body: { llm: { apiKey: 'sk-e****e0b5' } } });
const c2 = await api('config');
const unchanged = c2.llm.hasKey && c2.llm.apiKeyMasked === before;
console.log(`  ${unchanged ? '✓' : '✗'} Key 未被掩码覆盖: ${c2.llm.apiKeyMasked}`);
console.log('');

// 4. 测试清空（用一个临时字段验证机制，不动真实 Key）
console.log('【4】清空机制（验证 voice 空 Key）');
await api('config', { method: 'POST', body: { voice: { apiKey: '' } } });
const c3 = await api('config');
console.log(`  voice.hasKey: ${c3.voice.hasKey}（应为 false）`);
console.log(`  ${c3.voice.hasKey === false ? '✓ 清空有效' : '✗ 清空无效'}`);
console.log('');

// 5. 最终状态确认
console.log('【5】最终状态');
const c4 = await api('config');
console.log(`  对话: ${c4.llm.hasKey ? '已配置 ' + c4.llm.apiKeyMasked : '未配置'}`);
console.log(`  看图: ${c4.vision.hasKey ? '已配置 ' + c4.vision.apiKeyMasked : '未配置'}`);
console.log(`  联网: ${c4.search.hasKey ? '已配置 ' + c4.search.apiKeyMasked : '未配置'}`);
