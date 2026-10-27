/** 测试智谱 GLM-4V-Flash 的可用性和速度。 */
import fs from 'node:fs';
import path from 'node:path';

const KEY = process.argv[2];
if (!KEY) {
  console.log('用法: node test_zhipu.mjs <apiKey>');
  process.exit(1);
}

const imgPath = path.join(process.cwd(), '.tmp', 'test-vision.png');
if (!fs.existsSync(imgPath)) {
  console.log('测试图不存在，请先运行 test_vision.mjs');
  process.exit(1);
}

const b64 = fs.readFileSync(imgPath).toString('base64');
const BASE = 'https://open.bigmodel.cn/api/paas/v4';

console.log('=== 智谱 GLM-4V-Flash 测试 ===');
console.log('');

// 1. 测试看图
console.log('【1】看图识别');
{
  const t0 = Date.now();
  try {
    const res = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
      body: JSON.stringify({
        model: 'glm-4v-flash',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: b64 } },
              { type: 'text', text: '这张图里有什么？简短描述，50字以内。' },
            ],
          },
        ],
        max_tokens: 512,
      }),
      signal: AbortSignal.timeout(60000),
    });

    const ms = Date.now() - t0;
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      console.log(`  ✗ ${ms}ms HTTP ${res.status}`);
      console.log(`  ${t.slice(0, 200)}`);
    } else {
      const j = await res.json();
      const msg = j.choices?.[0]?.message || {};
      console.log(`  ✓ ${ms}ms`);
      console.log(`  内容: ${(msg.content || '').trim().slice(0, 100)}`);
      console.log(`  usage: ${JSON.stringify(j.usage)}`);
    }
  } catch (e) {
    console.log(`  ✗ ${e.message}`);
  }
}

console.log('');

// 2. 连续 3 次测稳定性
console.log('【2】连续 3 次');
for (let i = 1; i <= 3; i++) {
  const t0 = Date.now();
  try {
    const res = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
      body: JSON.stringify({
        model: 'glm-4v-flash',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: b64 } },
              { type: 'text', text: '这是什么颜色为主？两个字回答。' },
            ],
          },
        ],
        max_tokens: 100,
      }),
      signal: AbortSignal.timeout(60000),
    });
    const ms = Date.now() - t0;
    const j = await res.json();
    const content = (j.choices?.[0]?.message?.content || '').trim();
    console.log(`  第 ${i} 次: ${ms}ms → ${content.slice(0, 30)}`);
  } catch (e) {
    console.log(`  第 ${i} 次: ✗ ${e.message}`);
  }
}
