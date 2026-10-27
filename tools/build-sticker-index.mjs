/** 给现有素材库的图片生成描述索引，供按语气挑图用。 */
import fs from 'node:fs';
import path from 'node:path';

const TOKEN = fs.readFileSync(path.join(process.cwd(), 'data', 'token.txt'), 'utf8').trim();
const BASE = 'http://127.0.0.1:8899';

const DIRS = ['stickers', 'images', 'generated'];
const INDEX = path.join(process.cwd(), 'data', 'stickers', 'index.json');

// 情绪 → 关键词（与桥接里的 EMOJI_TAGS 保持一致）
const EMOJI_TAGS = {
  开心: ['开心', '高兴', '笑', '哈哈', '快乐', '兴奋', '棒', '好耶', '赞', '喜欢'],
  难过: ['难过', '伤心', '哭', '委屈', '失落', '郁闷'],
  生气: ['生气', '愤怒', '气', '怒', '火大', '不爽'],
  惊讶: ['惊讶', '震惊', '吃惊', '哇', '竟然', '没想到'],
  无语: ['无语', '无奈', '服了', '算了', '离谱', '沉默'],
  害羞: ['害羞', '脸红', '不好意思', '羞', '撒娇'],
  困倦: ['困', '累', '睡', '疲惫', '打哈欠', '晚安'],
  得意: ['得意', '骄傲', '炫', '厉害', '牛', '哼'],
  安慰: ['安慰', '抱抱', '摸头', '别难过', '没事'],
  吃饭: ['吃', '饭', '饿', '美食', '馋'],
};

function tagsOf(desc) {
  const out = [];
  for (const [tag, words] of Object.entries(EMOJI_TAGS)) {
    if (words.some((w) => desc.includes(w))) out.push(tag);
  }
  return out;
}

async function describe(buf, mime) {
  const res = await fetch(`${BASE}/api/vision`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      image: buf.toString('base64'),
      mime,
      prompt:
        '描述这张表情包：画面里是什么（人物/动物/物体）、什么表情、什么颜色、有没有文字。' +
        '用一句话说清楚，不超过 40 字。',
    }),
  });
  const j = await res.json();
  return String(j.text || '').trim();
}

console.log('=== 表情包描述索引生成 ===');
console.log('');

let index = {};
try {
  index = JSON.parse(fs.readFileSync(INDEX, 'utf8'));
} catch {}
console.log(`已有索引: ${Object.keys(index).length} 条`);
console.log('');

let done = 0;
let skipped = 0;
let failed = 0;

for (const kind of DIRS) {
  const dir = path.join(process.cwd(), 'data', kind);
  if (!fs.existsSync(dir)) continue;

  const files = fs
    .readdirSync(dir)
    .filter((n) => /\.(gif|png|jpe?g|webp)$/i.test(n))
    .filter((n) => fs.statSync(path.join(dir, n)).size > 256);

  console.log(`【${kind}】${files.length} 个`);

  for (const name of files) {
    if (index[name]?.desc) {
      skipped++;
      continue;
    }

    const full = path.join(dir, name);
    try {
      const buf = fs.readFileSync(full);
      const ext = path.extname(name).toLowerCase();
      const mime = ext === '.png' ? 'image/png' : ext === '.gif' ? 'image/gif' : 'image/jpeg';

      const desc = await describe(buf, mime);
      if (!desc || /看不清/.test(desc)) {
        console.log(`  - ${name}: 看不清，跳过`);
        failed++;
        continue;
      }

      index[name] = { desc, tags: tagsOf(desc), addedAt: Math.floor(Date.now() / 1000) };
      done++;
      console.log(`  ✓ ${name}: ${desc.slice(0, 40)}  [${index[name].tags.join(',') || '无标签'}]`);

      // 每张之间歇一下，别把接口打爆
      await new Promise((r) => setTimeout(r, 300));
    } catch (e) {
      console.log(`  ✗ ${name}: ${e.message}`);
      failed++;
    }
  }
  console.log('');
}

fs.mkdirSync(path.dirname(INDEX), { recursive: true });
fs.writeFileSync(INDEX, JSON.stringify(index, null, 2), 'utf8');

console.log(`结果：新增 ${done}，已有跳过 ${skipped}，失败 ${failed}`);
console.log(`索引共 ${Object.keys(index).length} 条 → ${INDEX}`);
console.log('');

// 展示一下标签分布
const tagCount = {};
for (const v of Object.values(index)) {
  for (const t of v.tags || []) tagCount[t] = (tagCount[t] || 0) + 1;
}
console.log('标签分布:', JSON.stringify(tagCount, null, 0));
