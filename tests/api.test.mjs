/**
 * 测试桥接配套接口：
 *   - /api/wechat 返回 reply 和 bubbles
 *   - /api/care/due、/api/care
 *   - /api/vision
 *   - 管理接口的 Key 掩码
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import { WebChannel } from '../channels/web.mjs';
import { ChatEngine } from '../core/engine.mjs';
import { AdminApi } from '../core/admin.mjs';
import { loadConfig } from '../core/config.mjs';
import fs from 'node:fs';
import path from 'node:path';

/** 测试用的独立根目录：配置、数据都写这里，不碰真实 data/ 和 config.json */
const _tmpRoot = path.join(process.cwd(), '.tmp');
// 干净检出（clone）里没有 .tmp，mkdtemp 会 ENOENT —— 先建父目录
fs.mkdirSync(_tmpRoot, { recursive: true });
const TEST_ROOT = fs.mkdtempSync(path.join(_tmpRoot, 'api-test-'));
fs.mkdirSync(path.join(TEST_ROOT, 'data'), { recursive: true });

// 写一份最小 config.json：管理接口保存时会读它，没有就会 500
fs.writeFileSync(
  path.join(TEST_ROOT, 'config.json'),
  JSON.stringify(
    {
      llm: { baseUrl: 'http://mock.local', apiKey: 'sk-test-mock-key-123456', model: 'mock' },
      vision: { enabled: true, apiKey: '', baseUrl: 'https://mock', model: 'mock-vision' },
      voice: { enabled: false, apiKey: '', baseUrl: '', model: '' },
      search: { enabled: true, provider: 'bocha', apiKey: '' },
      imagegen: { enabled: false, apiKey: '' },
      sticker: {},
      words: {},
      server: { host: '127.0.0.1', port: 19021 },
    },
    null,
    2,
  ),
  'utf8',
);
process.on('exit', () => {
  try {
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  } catch {}
});

let channel;
let base;
let engine;
let adminToken;

function makeMockFetch(reply = '测试回复') {
  return async (url, opts) => {
    // 流式响应要用 delta.content（解析器读的是这个字段）
    const chunk = JSON.stringify({
      choices: [{ delta: { content: reply }, finish_reason: null }],
    });
    const done = JSON.stringify({
      choices: [{ delta: {}, finish_reason: 'stop' }],
    });

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${chunk}\n\n`));
        controller.enqueue(encoder.encode(`data: ${done}\n\n`));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    });
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
}

before(async () => {
  const config = loadConfig({
    root: process.cwd(),
    env: {},
    override: {
      llm: { baseUrl: 'http://mock.local', apiKey: 'sk-test-mock-key-123456', model: 'mock' },
      channels: { web: { enabled: true } },
      server: { host: '127.0.0.1', port: 19021, autoPort: true },
      reply: { bubbleDelayMs: 0 },
      tools: { enabled: false },
      vision: { enabled: true, apiKey: '', baseUrl: 'https://mock', model: 'mock-vision' },
      search: { enabled: true, provider: 'bocha', apiKey: '' },
      voice: { enabled: false, apiKey: '' },
    },
  });

  const persona = { name: '测试角色', aliases: ['测试'], description: '', personality: '', rules: [] };
  const mockFetch = makeMockFetch('测试回复');

  engine = new ChatEngine({ config, persona, fetchImpl: mockFetch, logger: { info() {}, warn() {}, error() {} } });
  /**
   * 测试专用根目录。
   *
   * AdminApi 会把配置写回 root/config.json。以前这里没传 root，
   * 于是测试里那句「设置一个假语音 Key」直接改掉了用户真实的 config.json ——
   * 审计日志：voice:117→21→0，用户的语音 Key 就这么没了。
   * 现在给它一个临时目录，测试爱怎么写都碰不到生产数据。
   */
  const admin = new AdminApi({
    engine,
    config,
    channels: ['web'],
    logger: { info() {}, warn() {}, error() {} },
    root: TEST_ROOT,
  });

  channel = new WebChannel({ engine, config, admin, logger: { info() {}, warn() {}, error() {} } });
  base = await channel.start();
  // 管理接口需要本地令牌，测试里直接取
  adminToken = channel.token;
});

/** 带 token 请求管理接口。 */
function adminFetch(path, opts = {}) {
  const headers = { 'x-local-token': adminToken, ...(opts.headers || {}) };
  if (opts.body) headers['content-type'] = 'application/json';
  return fetch(`${base}${path}`, { ...opts, headers });
}

after(async () => {
  if (channel) await channel.stop();
});

test('接口：/api/wechat 返回 reply 字段', async () => {
  const res = await fetch(`${base}/api/wechat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: 'wxid_test',
      chat_type: 'private',
      senderId: 'wxid_test',
      senderName: '测试',
      text: '你好',
      msg_id: 'm1',
    }),
  });

  const j = await res.json();
  assert.equal(j.action, 'reply', `实际返回: ${JSON.stringify(j)}`);
  // 关键：桥接靠 reply 字段判断是否发送
  assert.ok(j.reply, 'reply 字段必须存在');
  assert.equal(typeof j.reply, 'string');
  assert.ok(Array.isArray(j.bubbles));
});

test('接口：/api/wechat 缺参数时返回 ignore', async () => {
  const res = await fetch(`${base}/api/wechat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: '', text: '' }),
  });
  const j = await res.json();
  assert.equal(j.action, 'ignore');
});

test('接口：/api/care/due 返回结构化判断', async () => {
  const res = await fetch(`${base}/api/care/due?last=0&sentToday=0`);
  const j = await res.json();
  assert.equal(typeof j.due, 'boolean');
  assert.equal(typeof j.reason, 'string');
});

test('接口：/api/care 返回文本', async () => {
  const res = await fetch(`${base}/api/care`);
  const j = await res.json();
  assert.ok(j.text, '应返回 text');
  assert.equal(typeof j.text, 'string');
});

test('接口：/api/vision 无图时返回 400', async () => {
  const res = await fetch(`${base}/api/vision`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 400);
});

test('管理接口：config 返回各 Key 的掩码', async () => {
  const res = await adminFetch(`/api/admin/config`);
  const c = await res.json();

  // llm 有 Key，应返回掩码
  assert.equal(c.llm.hasKey, true);
  assert.match(c.llm.apiKeyMasked, /\*\*\*\*/);

  // vision/search/voice 没有独立 Key
  assert.equal(c.vision.hasKey, false);
  assert.equal(c.search.hasKey, false);
  assert.equal(c.voice.hasKey, false);
});

test('管理接口：空字符串不会清空 Key（防误删）', async () => {
  // 先设置一个 Key
  await adminFetch(`/api/admin/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ voice: { apiKey: 'test-voice-key-abcdef' } }),
  });

  let res = await adminFetch(`/api/admin/config`);
  let c = await res.json();
  assert.equal(c.voice.hasKey, true, '设置后应有 Key');

  // 传空字符串：应视为「不修改」，不能抹掉 Key
  // （前端输入框默认是空的，如果空值算清空会导致 Key 被反复误删）
  await adminFetch(`/api/admin/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ voice: { enabled: true, apiKey: '' } }),
  });

  res = await adminFetch(`/api/admin/config`);
  c = await res.json();
  assert.equal(c.voice.hasKey, true, '传空字符串不应清空 Key');
});

test('管理接口：clearApiKey 可明确删除 Key', async () => {
  // 先确保有 Key
  await adminFetch(`/api/admin/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ voice: { apiKey: 'test-voice-key-abcdef' } }),
  });

  // 明确删除
  await adminFetch(`/api/admin/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ voice: { clearApiKey: true } }),
  });

  const c = await (await adminFetch(`/api/admin/config`)).json();
  assert.equal(c.voice.hasKey, false, 'clearApiKey 应删除 Key');
});

test('管理接口：传掩码不会覆盖真实 Key', async () => {
  const before = await (await adminFetch(`/api/admin/config`)).json();
  const masked = before.llm.apiKeyMasked;

  await adminFetch(`/api/admin/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ llm: { apiKey: masked } }),
  });

  const after = await (await adminFetch(`/api/admin/config`)).json();
  assert.equal(after.llm.apiKeyMasked, masked, '掩码不应改变 Key');
  assert.equal(after.llm.hasKey, true);
});

test('管理接口：词库列表', async () => {
  const res = await adminFetch(`/api/admin/words`);
  const j = await res.json();
  assert.ok(Array.isArray(j.banks));
});
