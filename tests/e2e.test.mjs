/**
 * 端到端测试：用 mock 模型跑通「引擎 → 网页通道」全链路。
 * 不调用真实 API，不依赖网络。
 */
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ChatEngine } from '../core/engine.mjs';
import { WebChannel } from '../channels/web.mjs';
import { loadConfig } from '../core/config.mjs';
import { loadPersona, PERSONA_DEFAULTS } from '../core/persona.mjs';

/**
 * 测试专用数据目录。
 *
 * 绝对不能让测试往真实 data/ 里写东西 —— 以前 e2e 用 18083 起通道，
 * 把 actual-port.txt 覆盖成了 18083，导致下次双击鲸鲸.bat 时
 * 启动脚本打开一个死链接（用户看到「突然无法运行」）。
 *
 * 放在工作区内的 .tmp（本机沙箱不允许 node 写系统临时目录）。
 */
const TEST_DATA_DIR = fs.mkdtempSync(
  path.join(process.cwd(), '.tmp', 'e2e-'),
);
process.on('exit', () => {
  try {
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  } catch {}
});

/** 构造一个假的 fetch，模拟 OpenAI 流式响应。 */
function mockFetch(replyText, { failTimes = 0 } = {}) {
  let calls = 0;
  return async (url, init) => {
    calls++;
    if (calls <= failTimes) {
      return new Response('server error', { status: 500 });
    }
    const body = JSON.parse(init.body);
    const wantsStream = body.stream !== false;

    if (!wantsStream) {
      return new Response(
        JSON.stringify({ choices: [{ message: { content: replyText } }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }

    const chunks = [...replyText].map(
      (ch) => `data: ${JSON.stringify({ choices: [{ delta: { content: ch } }] })}\n\n`,
    );
    const stream = new ReadableStream({
      start(controller) {
        for (const c of chunks) controller.enqueue(new TextEncoder().encode(c));
        controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
        controller.close();
      },
    });
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
}

function makeConfig(over = {}) {
  return loadConfig({
    root: process.cwd(),
    env: {},
    override: {
      llm: { baseUrl: 'http://mock.local', apiKey: 'test-key', model: 'mock' },
      channels: { web: { enabled: true } },
      reply: { bubbleDelayMs: 0 },
      // 测试默认不启用工具，走普通流式路径（mock 只支持流式）
      tools: { enabled: false },
      // 测试不许落盘：否则上一轮的会话历史会被读进来，
      // 「两轮 = 4 条」这种断言就会变成 8 条、12 条
      session: { persist: false },
      ...over,
    },
  });
}

test('引擎：完整对话流程', async () => {
  const config = makeConfig();
  const engine = new ChatEngine({
    config,
    persona: { ...PERSONA_DEFAULTS, name: '鲸鲸' },
    logger: { error() {}, warn() {}, info() {} },
    fetchImpl: mockFetch('你好呀，今天过得怎么样'),
  });

  const result = await engine.handle({ sessionId: 's1', text: '你好', speakerName: '主人' });
  assert.ok(result.bubbles.length > 0, '应有回复气泡');
  assert.equal(result.reason, 'ok');
  assert.ok(result.text.includes('你好'));
});

test('引擎：会话历史被记录', async () => {
  const config = makeConfig();
  const engine = new ChatEngine({
    config,
    persona: PERSONA_DEFAULTS,
    logger: { error() {}, warn() {}, info() {} },
    fetchImpl: mockFetch('收到'),
  });

  await engine.handle({ sessionId: 's2', text: '第一句' });
  await engine.handle({ sessionId: 's2', text: '第二句' });

  const session = engine.sessions.get('s2');
  assert.equal(session.history.length, 4, '两轮 = 4 条');
});

test('引擎：不同会话相互隔离', async () => {
  const config = makeConfig();
  const engine = new ChatEngine({
    config,
    persona: PERSONA_DEFAULTS,
    logger: { error() {}, warn() {}, info() {} },
    fetchImpl: mockFetch('好'),
  });

  await engine.handle({ sessionId: 'a', text: '我叫小明' });
  await engine.handle({ sessionId: 'b', text: '你好' });

  const a = engine.sessions.get('a');
  const b = engine.sessions.get('b');
  assert.equal(a.facts.get('名字'), '小明');
  assert.equal(b.facts.get('名字'), undefined, 'b 不应知道 a 的名字');
});

test('引擎：流式回调收到增量', async () => {
  const config = makeConfig();
  const deltas = [];
  const engine = new ChatEngine({
    config,
    persona: PERSONA_DEFAULTS,
    logger: { error() {}, warn() {}, info() {} },
    fetchImpl: mockFetch('abc'),
  });

  await engine.handle({ sessionId: 's3', text: 'hi', onDelta: (d) => deltas.push(d) });
  assert.ok(deltas.length >= 3, `应收到多个增量，实际 ${deltas.length}`);
});

test('引擎：模型失败时返回错误而非崩溃', async () => {
  const config = makeConfig();
  const engine = new ChatEngine({
    config,
    persona: PERSONA_DEFAULTS,
    logger: { error() {}, warn() {}, info() {} },
    fetchImpl: mockFetch('', { failTimes: 99 }),
  });

  const result = await engine.handle({ sessionId: 's4', text: '你好' });
  assert.equal(result.reason, 'llm_error');
  assert.equal(result.bubbles.length, 0);
});

test('引擎：备用服务商生效', async () => {
  const config = makeConfig({
    llm: {
      baseUrl: 'http://mock.local',
      apiKey: 'k',
      model: 'mock',
      fallbacks: [{ baseUrl: 'http://backup.local', apiKey: 'k2', model: 'mock2' }],
    },
  });

  let host = '';
  const fetchImpl = async (url, init) => {
    host = url;
    if (url.includes('mock.local')) {
      return new Response('boom', { status: 503 });
    }
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(
          new TextEncoder().encode(
            `data: ${JSON.stringify({ choices: [{ delta: { content: '备用回复' } }] })}\n\n`,
          ),
        );
        c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
        c.close();
      },
    });
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };

  const engine = new ChatEngine({
    config,
    persona: PERSONA_DEFAULTS,
    logger: { error() {}, warn() {}, info() {} },
    fetchImpl,
  });

  const result = await engine.handle({ sessionId: 's5', text: '你好' });
  assert.ok(result.text.includes('备用回复'));
  assert.ok(host.includes('backup.local'));
});

test('引擎：同一会话并发消息串行处理', async () => {
  const config = makeConfig();
  let active = 0;
  let maxActive = 0;

  const fetchImpl = async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 30));
    active--;
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(
          new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\n\n`),
        );
        c.close();
      },
    });
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };

  const engine = new ChatEngine({
    config,
    persona: PERSONA_DEFAULTS,
    logger: { error() {}, warn() {}, info() {} },
    fetchImpl,
  });

  await Promise.all([
    engine.handle({ sessionId: 'same', text: 'a' }),
    engine.handle({ sessionId: 'same', text: 'b' }),
    engine.handle({ sessionId: 'same', text: 'c' }),
  ]);

  assert.equal(maxActive, 1, '同一会话不应并发调用模型');
});

test('网页通道：SSE 返回 done 事件', async () => {
  const config = makeConfig({ server: { host: '127.0.0.1', port: 18081 } });
  const engine = new ChatEngine({
    config,
    persona: PERSONA_DEFAULTS,
    logger: { error() {}, warn() {}, info() {} },
    fetchImpl: mockFetch('测试回复'),
  });

  const web = new WebChannel({ engine, config, logger: { error() {} }, dataDir: TEST_DATA_DIR });
  const url = await web.start();

  try {
    const res = await fetch(`${url}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'w1', text: '你好' }),
    });
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(text.includes('event: done'), '应收到 done 事件');
    assert.ok(text.includes('bubbles'), 'done 事件应含 bubbles');
  } finally {
    await web.stop();
  }
});

test('网页通道：status 接口', async () => {
  const config = makeConfig({ server: { host: '127.0.0.1', port: 18082 } });
  const engine = new ChatEngine({
    config,
    persona: PERSONA_DEFAULTS,
    logger: { error() {}, warn() {}, info() {} },
    fetchImpl: mockFetch('ok'),
  });
  const web = new WebChannel({ engine, config, logger: { error() {} }, dataDir: TEST_DATA_DIR });
  const url = await web.start();
  try {
    const s = await (await fetch(`${url}/api/status`)).json();
    assert.ok(s.model);
    assert.ok(s.sessions);
  } finally {
    await web.stop();
  }
});

test('网页通道：重置会话', async () => {
  const config = makeConfig({ server: { host: '127.0.0.1', port: 18083 } });
  const engine = new ChatEngine({
    config,
    persona: PERSONA_DEFAULTS,
    logger: { error() {}, warn() {}, info() {} },
    fetchImpl: mockFetch('ok'),
  });
  const web = new WebChannel({ engine, config, logger: { error() {} }, dataDir: TEST_DATA_DIR });
  const url = await web.start();
  try {
    await engine.handle({ sessionId: 'r1', text: '你好' });
    assert.equal(engine.sessions.stats().count, 1);

    await fetch(`${url}/api/reset`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'r1' }),
    });
    assert.equal(engine.sessions.stats().count, 0);
  } finally {
    await web.stop();
  }
});
