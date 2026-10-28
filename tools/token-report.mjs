/**
 * 测每种功能的 token 消耗。
 *
 * 做法：重置统计 → 跑一个场景 → 读统计 → 相减。
 * 这样每一行都是真实调用产生的数字，不是估的。
 *
 * 用法：node tools/token-report.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const TOKEN = fs.readFileSync(path.join(ROOT, 'data', 'token.txt'), 'utf8').trim();
const BASE = 'http://127.0.0.1:8899';
const H = { 'x-local-token': TOKEN, 'content-type': 'application/json' };

/** 读当前累计用量 */
async function usage() {
  const r = await fetch(`${BASE}/api/admin/usage`, { headers: H });
  return r.json();
}

/** 跑一句对话 */
async function chat(text, chatId, extra = {}) {
  const t0 = Date.now();
  const r = await fetch(`${BASE}/api/wechat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      chat_type: 'private',
      senderId: 'wxid_owner_placeholder',
      senderName: 'YF',
      text,
      msg_id: 'tk' + Date.now() + Math.random().toString(36).slice(2, 6),
      ...extra,
    }),
  });
  const j = await r.json();
  return { ms: Date.now() - t0, reply: (j.bubbles || []).join('') };
}

/** 一段场景：跑前后各读一次统计 */
async function scenario(name, fn) {
  const before = await usage();
  let detail = '';
  try {
    detail = (await fn()) || '';
  } catch (e) {
    detail = '（失败：' + e.message + '）';
  }
  const after = await usage();
  return {
    name,
    calls: after.calls - before.calls,
    input: after.input - before.input,
    output: after.output - before.output,
    detail,
  };
}

const rows = [];
const id = 'tok-' + Date.now();

console.log('开始测量（每个场景单独计时，会话按场景隔离）…\n');

// 1. 最简对话：无历史、无工具
rows.push(
  await scenario('纯对话（首条，无历史）', async () => {
    const r = await chat('你好', id + '-a');
    return `${r.ms}ms`;
  }),
);

// 2. 带若干轮历史
rows.push(
  await scenario('带 6 轮历史', async () => {
    const cid = id + '-b';
    for (const q of ['我叫小明', '我喜欢吃火锅', '我在杭州', '今天有点累', '你会做饭吗', '记得我说过什么吗']) {
      await chat(q, cid);
    }
    return '6 轮累积';
  }),
);

// 3. 联网搜索（会多一轮工具调用）
rows.push(
  await scenario('联网搜索（1 次工具调用）', async () => {
    const r = await chat('帮我查一下今天杭州的天气', id + '-c');
    return `${r.ms}ms`;
  }),
);

// 4. 插件工具
rows.push(
  await scenario('插件工具（掷骰子）', async () => {
    const r = await chat('帮我掷两个骰子', id + '-d');
    return `${r.ms}ms`;
  }),
);

// 5. 知识库命中
rows.push(
  await scenario('知识库命中（注入参考片段）', async () => {
    const r = await chat('我们之前定的作息是怎么安排的', id + '-e');
    return `${r.ms}ms`;
  }),
);

// 6. 长回复（要求写长）
rows.push(
  await scenario('长回复（约 300 字）', async () => {
    const r = await chat('用三百字讲讲你今天想干什么', id + '-f');
    return `${r.reply.length} 字`;
  }),
);

// ===== 汇总 =====
const pad = (s, n) => String(s).padEnd(n);
const num = (n) => n.toLocaleString('en-US');

console.log('═'.repeat(78));
console.log(`  ${pad('场景', 26)} ${pad('调用', 6)} ${pad('输入', 9)} ${pad('输出', 9)} 合计`);
console.log('─'.repeat(78));
for (const r of rows) {
  const total = r.input + r.output;
  console.log(
    `  ${pad(r.name, 26)} ${pad(r.calls, 6)} ${pad(num(r.input), 9)} ${pad(num(r.output), 9)} ${num(total)}`,
  );
}
console.log('═'.repeat(78));

// ===== 单轮均值 =====
const simple = rows[0];
if (simple.calls) {
  console.log('');
  console.log('  参考：');
  console.log(`    纯对话一轮     输入约 ${num(simple.input)} / 输出约 ${num(simple.output)} token`);
  const hist = rows[1];
  if (hist.calls) {
    console.log(
      `    带 6 轮历史    平均每轮 输入约 ${num(Math.round(hist.input / 6))}（历史越长越贵）`,
    );
  }
}

// ===== 换算成钱（官方 deepseek-flash 单价，美元/百万 token） =====
// 来源：api-docs.deepseek.com/quick_start/pricing（2026-10）
// 峰时：UTC 01:00-04:00、06:00-10:00 的工作日；其余时段五折
const USD_IN_PEAK = Number(process.env.USD_IN_PEAK || 0.3); // 缓存未命中
const USD_IN_OFF = USD_IN_PEAK / 2;
const USD_OUT_PEAK = Number(process.env.USD_OUT_PEAK || 1.2);
const USD_OUT_OFF = USD_OUT_PEAK / 2;
const USD_CACHE_HIT = Number(process.env.USD_CACHE_HIT || 0.006);
const CNY = Number(process.env.CNY || 7.1);

const costOf = (r, inPrice, outPrice) =>
  (r.input / 1e6) * inPrice + (r.output / 1e6) * outPrice;

const pad2 = (s, n) => String(s).padEnd(n);

console.log('');
console.log('  钱（官方单价，缓存全未命中，最保守的算法）');
console.log('─'.repeat(72));
console.log(`  ${pad2('场景', 26)} ${pad2('峰时', 12)} ${pad2('谷时', 12)} 合计/次`);
for (const r of rows) {
  const peak = costOf(r, USD_IN_PEAK, USD_OUT_PEAK);
  const off = costOf(r, USD_IN_OFF, USD_OUT_OFF);
  console.log(
    `  ${pad2(r.name, 26)} ${pad2('$' + peak.toFixed(5), 12)} ${pad2('$' + off.toFixed(5), 12)} ¥${(off * CNY).toFixed(4)}`,
  );
}

// 每天 200 句的日常用量（按带一点历史的均值）
const daily = 200;
const perChatIn = Math.round(simple.input * 1.15); // 带点历史，约 +15%
const perChatOut = Math.max(simple.output, 60);
const dailyPeak = ((perChatIn * daily) / 1e6) * USD_IN_PEAK + ((perChatOut * daily) / 1e6) * USD_OUT_PEAK;
const dailyOff = dailyPeak / 2;

console.log('');
console.log('─'.repeat(72));
console.log(`  每天 ${daily} 句：峰时 $${dailyPeak.toFixed(2)}（¥${(dailyPeak * CNY).toFixed(1)}）` +
  ` / 谷时 $${dailyOff.toFixed(2)}（¥${(dailyOff * CNY).toFixed(1)}）`);
console.log(`  一个月 30 天：峰时 ¥${(dailyPeak * CNY * 30).toFixed(0)} / 谷时 ¥${(dailyOff * CNY * 30).toFixed(0)}`);
console.log('');
console.log(`  如果固定前缀命中缓存（$ ${USD_CACHE_HIT}/M，只有未命中的 1/50）：`);
const cachedIn = 1135; // tools + 人设，见 token-breakdown
const chatInMiss = Math.max(0, perChatIn - cachedIn);
const dailyCached =
  ((cachedIn * daily) / 1e6) * USD_CACHE_HIT * 2 + // 峰时按两倍算，粗略
  ((chatInMiss * daily) / 1e6) * USD_IN_PEAK +
  ((perChatOut * daily) / 1e6) * USD_OUT_PEAK;
console.log(`    每天 ${daily} 句：约 $${dailyCached.toFixed(2)}（¥${(dailyCached * CNY).toFixed(1)}）`);

fs.writeFileSync(
  path.join(ROOT, 'data', 'token-report.json'),
  JSON.stringify({ rows, usd: { inPeak: USD_IN_PEAK, outPeak: USD_OUT_PEAK, cacheHit: USD_CACHE_HIT }, cny: CNY }, null, 2),
  'utf8',
);
