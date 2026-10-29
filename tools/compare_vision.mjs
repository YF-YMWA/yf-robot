/** 对比不同视觉模型的响应速度。 */
import fs from 'node:fs';
import path from 'node:path';

const cfg = JSON.parse(fs.readFileSync('config.json', 'utf8'));
const imgPath = path.join(process.cwd(), '.tmp', 'test-vision.png');

if (!fs.existsSync(imgPath)) {
  console.log('测试图不存在');
  process.exit(1);
}

const b64 = fs.readFileSync(imgPath).toString('base64');
const prompt = '这张图里有什么？简短描述，50字以内。';

async function testModel(name, baseUrl, apiKey, model, maxTokens = 1024) {
  const t0 = Date.now();
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 90000);

    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } },
            ],
          },
        ],
        max_tokens: maxTokens,
      }),
      signal: ac.signal,
    });
    clearTimeout(timer);

    const ms = Date.now() - t0;

    if (!res.ok) {
      const t = await res.text().catch(() => '');
      return { name, ok: false, ms, error: `HTTP ${res.status}: ${t.slice(0, 100)}` };
    }

    const j = await res.json();
    const msg = j.choices?.[0]?.message || {};
    const content = (msg.content || '').trim();
    const reasoning = (msg.reasoning_content || '').trim();

    return {
      name,
      ok: Boolean(content),
      ms,
      content: content.slice(0, 60),
      hasReasoning: Boolean(reasoning),
      reasoningLen: reasoning.length,
      usage: j.usage,
    };
  } catch (e) {
    return { name, ok: false, ms: Date.now() - t0, error: e.message };
  }
}

console.log('=== 视觉模型速度对比 ===');
console.log(`测试图: ${imgPath}`);
console.log('');

const results = [];

// 1. DeepSeek 的 vision 模型（当前用的）
results.push(
  await testModel(
    'DeepSeek vision-exp',
    cfg.llm.baseUrl,
    cfg.vision.apiKey || cfg.llm.apiKey,
    'deepseek-v4-flash-vision-exp',
    2048,
  ),
);

// 2. 智谱 GLM-4V-Flash（有免费额度）
const zhipuKey = process.env.ZHIPU_API_KEY || '';
if (zhipuKey) {
  results.push(
    await testModel('智谱 GLM-4V-Flash', 'https://open.bigmodel.cn/api/paas/v4', zhipuKey, 'glm-4v-flash', 1024),
  );
} else {
  console.log('（没有智谱 Key，跳过 GLM-4V-Flash 测试）');
  console.log('');
}

// 输出对比
for (const r of results) {
  console.log(`【${r.name}】`);
  if (r.ok) {
    console.log(`  ✓ ${r.ms}ms`);
    console.log(`  内容: ${r.content}`);
    if (r.hasReasoning) console.log(`  含思考过程: ${r.reasoningLen} 字`);
    if (r.usage) console.log(`  tokens: ${JSON.stringify(r.usage)}`);
  } else {
    console.log(`  ✗ ${r.ms}ms  ${r.error}`);
  }
  console.log('');
}
