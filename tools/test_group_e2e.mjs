/**
 * 群聊端到端验证：启动通道 → 模拟桥接推送 → 拉取回复。
 */
import { WeChatGroupChannel } from '../channels/wechat-group.mjs';
import { ChatEngine } from '../core/engine.mjs';
import { loadConfig } from '../core/config.mjs';
import { PERSONA_DEFAULTS } from '../core/persona.mjs';
import fs from 'node:fs';
import path from 'node:path';

const config = loadConfig({
  root: process.cwd(),
  env: {},
  override: {
    llm: { baseUrl: 'http://mock.local', apiKey: 'k', model: 'mock' },
    channels: {
      web: { enabled: false },
      'wechat-group': { enabled: true, listenHost: '127.0.0.1', listenPort: 8898, token: '' },
    },
    reply: { bubbleDelayMs: 0 },
  },
});

// 模拟模型：根据输入给出不同回复，验证不同场景
let replyIndex = 0;
const replies = [
  '唔，我在呢。',
  '这个我也不是很清楚诶。',
  '好呀，那就这么定了。',
];
const fetchImpl = async () => {
  const text = replies[replyIndex % replies.length];
  replyIndex++;
  const stream = new ReadableStream({
    start(c) {
      c.enqueue(
        new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`),
      );
      c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
      c.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
};

const engine = new ChatEngine({
  config,
  persona: { ...PERSONA_DEFAULTS, name: '鲸鲸', ownerName: '群友', identity: '鲸鲸' },
  logger: { error() {}, warn() {}, info() {} },
  fetchImpl,
});

const ch = new WeChatGroupChannel({ engine, config, logger: console });
const url = await ch.start();

const H = { 'content-type': 'application/json' };

async function push(msg) {
  const r = await fetch(`${url}/group/inbound`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify(msg),
  });
  return r.json();
}

async function outbox() {
  const r = await fetch(`${url}/group/outbox`);
  return (await r.json()).messages;
}

console.log('=== 模拟一段群聊 ===\n');

const steps = [
  { name: '张三', text: '今天加班到九点，累死了', atMe: false, expect: false },
  { name: '老张', text: '你那个项目不是下周才交吗', atMe: false, expect: false },
  { name: '张三', text: '@鲸鲸 你说他说得对不对', atMe: true, expect: true },
  { name: '老张', text: '然后呢', atMe: false, expect: true }, // 接话窗口内
  { name: '老张', text: '算了别提了，换个话题', atMe: false, expect: false }, // 主动退出
  { name: '老王', text: '随便聊聊', atMe: false, expect: false },
];

let msgId = 0;
for (const s of steps) {
  const r = await push({
    groupId: 'demo@chatroom',
    from: `wxid_${s.name}`,
    name: s.name,
    text: s.text,
    msgId: `msg_${++msgId}`,
    atMe: s.atMe,
  });

  const result = r.results[0];
  const got = result.reply ? (result.bubbles || []).join(' / ') : '（不回复）';
  const mark = result.reply === s.expect ? '✓' : '✗';

  console.log(`${mark} ${s.name}：${s.text}`);
  console.log(`   → ${got}  [${result.reason}]`);
  console.log('');
}

console.log('=== 待桥接发送的队列 ===');
const msgs = await outbox();
for (const m of msgs) {
  console.log(`   ${m.groupId}: ${m.text}`);
}

console.log('');
console.log('=== 群状态 ===');
console.log(JSON.stringify(await ch.stats(), null, 1));

await ch.stop();
process.exit(0);
