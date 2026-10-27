/**
 * 群聊 HTTP 接口测试：模拟桥接程序推送消息、拉取回复。
 */
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { WeChatGroupChannel } from '../channels/wechat-group.mjs';
import { ChatEngine } from '../core/engine.mjs';
import { loadConfig } from '../core/config.mjs';
import { PERSONA_DEFAULTS } from '../core/persona.mjs';

const _tmpRoot = path.join(process.cwd(), '.tmp');
fs.mkdirSync(_tmpRoot, { recursive: true });

/** 构造测试用配置。 */
function makeConfig(port, over = {}) {
  return loadConfig({
    root: process.cwd(),
    env: {},
    override: {
      tools: { enabled: false },
      llm: { baseUrl: 'http://mock.local', apiKey: 'k', model: 'm' },
      channels: {
        web: { enabled: false },
        'wechat-group': { enabled: true, listenHost: '127.0.0.1', listenPort: port, token: '' },
      },
      group: {
        requireAt: true,
        aliases: ['鲸鲸'],
        ownerIds: [],
        engagedMinutes: 6,
        freeChat: false,
        ...over.group,
      },
      reply: { bubbleDelayMs: 0 },
      ...over,
    },
  });
}

/** mock 模型，总是回复固定文本。 */
function mockLlm(text = '收到啦') {
  return async () => {
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(
          new TextEncoder().encode(
            `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`,
          ),
        );
        c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
        c.close();
      },
    });
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
}

function makeEngine(config, fetchImpl) {
  return new ChatEngine({
    config,
    persona: { ...PERSONA_DEFAULTS, name: '鲸鲸', ownerName: '群友' },
    logger: { error() {}, warn() {}, info() {} },
    fetchImpl,
  });
}

async function withChannel(port, fn, opts = {}) {
  const config = makeConfig(port, opts.over);
  const engine = makeEngine(config, opts.fetchImpl || mockLlm());
  const ch = new WeChatGroupChannel({ engine, config, logger: { error() {}, warn() {}, info() {} } });
  const url = await ch.start();
  try {
    return await fn({ ch, url, engine, config });
  } finally {
    await ch.stop();
  }
}

test('群聊接口：健康检查', async () => {
  await withChannel(18898, async ({ url }) => {
    const r = await fetch(`${url}/group/health`);
    const j = await r.json();
    assert.equal(j.ok, true);
    assert.ok(Array.isArray(j.groups.groups));
  });
});

test('群聊接口：@ 时回复并放入队列', async () => {
  await withChannel(
    18899,
    async ({ url }) => {
      const r = await fetch(`${url}/group/inbound`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          groupId: 'g1@chatroom',
          from: 'wxid_a',
          name: '张三',
          text: '@鲸鲸 你好',
          msgId: 'm1',
          atMe: true,
        }),
      });
      const j = await r.json();
      assert.equal(j.ok, true);
      assert.equal(j.results.length, 1);
      assert.equal(j.results[0].reply, true);
      assert.equal(j.results[0].reason, 'addressed');

      // 拉取回复
      const o = await (await fetch(`${url}/group/outbox`)).json();
      assert.ok(o.messages.length > 0, '应有一条待发送回复');
      assert.equal(o.messages[0].groupId, 'g1@chatroom');
      assert.ok(o.messages[0].text.includes('收到啦'));
    },
  );
});

test('群聊接口：未 @ 时不回复', async () => {
  await withChannel(18900, async ({ url }) => {
    const r = await fetch(`${url}/group/inbound`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        groupId: 'g1@chatroom',
        from: 'wxid_a',
        name: '张三',
        text: '今天天气不错',
        msgId: 'm2',
        atMe: false,
      }),
    });
    const j = await r.json();
    assert.equal(j.results[0].reply, false);
    assert.equal(j.results[0].reason, 'not_addressed');

    const o = await (await fetch(`${url}/group/outbox`)).json();
    assert.equal(o.messages.length, 0, '不应有回复');
  });
});

test('群聊接口：叫名字也会回复', async () => {
  await withChannel(18901, async ({ url }) => {
    const r = await fetch(`${url}/group/inbound`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        groupId: 'g1@chatroom',
        from: 'wxid_a',
        name: '张三',
        text: '鲸鲸你在吗',
        msgId: 'm3',
        atMe: false,
      }),
    });
    const j = await r.json();
    assert.equal(j.results[0].reply, true);
    assert.equal(j.results[0].reason, 'called_by_name');
  });
});

test('群聊接口：消息去重', async () => {
  await withChannel(18902, async ({ url }) => {
    const msg = {
      groupId: 'g1@chatroom',
      from: 'wxid_a',
      name: '张三',
      text: '@鲸鲸 你好',
      msgId: 'dup-1',
      atMe: true,
    };

    const r1 = await (
      await fetch(`${url}/group/inbound`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(msg),
      })
    ).json();
    assert.equal(r1.results[0].reply, true);

    const r2 = await (
      await fetch(`${url}/group/inbound`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(msg),
      })
    ).json();
    assert.equal(r2.results[0].reply, false);
    assert.equal(r2.results[0].reason, 'duplicate');
  });
});

test('群聊接口：批量推送', async () => {
  await withChannel(18903, async ({ url }) => {
    const r = await fetch(`${url}/group/inbound`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messages: [
          { groupId: 'g1', from: 'u1', name: 'A', text: '闲聊', msgId: 'b1' },
          { groupId: 'g1', from: 'u2', name: 'B', text: '@鲸鲸 在吗', msgId: 'b2', atMe: true },
        ],
      }),
    });
    const j = await r.json();
    assert.equal(j.results.length, 2);
    assert.equal(j.results[0].reply, false);
    assert.equal(j.results[1].reply, true);
  });
});

test('群聊接口：指令 /mute', async () => {
  await withChannel(18904, async ({ url }) => {
    const r = await fetch(`${url}/group/inbound`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        groupId: 'g1',
        from: 'wxid_admin',
        name: '管理',
        text: '/mute 5',
        msgId: 'c1',
        isGroupAdmin: true,
      }),
    });
    const j = await r.json();
    assert.equal(j.results[0].reply, true);
    assert.ok(j.results[0].bubbles[0].includes('5'));

    // 免打扰后不应回复
    const r2 = await fetch(`${url}/group/inbound`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        groupId: 'g1',
        from: 'u1',
        name: '张三',
        text: '@鲸鲸 你好',
        msgId: 'c2',
        atMe: true,
      }),
    });
    const j2 = await r2.json();
    assert.equal(j2.results[0].reply, false);
    assert.equal(j2.results[0].reason, 'muted');
  });
});

test('群聊接口：无权限执行管理指令被拒', async () => {
  await withChannel(18905, async ({ url }) => {
    const r = await fetch(`${url}/group/inbound`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        groupId: 'g1',
        from: 'wxid_anyone',
        name: '路人',
        text: '/mute 5',
        msgId: 'd1',
        isGroupAdmin: false,
      }),
    });
    const j = await r.json();
    assert.ok(j.results[0].bubbles[0].includes('不算'), '应提示无权限');
  });
});

test('群聊接口：token 鉴权', async () => {
  const config = makeConfig(18906, {
    channels: {
      web: { enabled: false },
      'wechat-group': { enabled: true, listenHost: '127.0.0.1', listenPort: 18906, token: 'secret123' },
    },
  });
  const engine = makeEngine(config, mockLlm());
  const ch = new WeChatGroupChannel({ engine, config, logger: { error() {}, warn() {}, info() {} } });
  const url = await ch.start();

  try {
    // 无 token 被拒
    const r1 = await fetch(`${url}/group/health`);
    assert.equal(r1.status, 401);

    // 带 token 通过
    const r2 = await fetch(`${url}/group/health`, { headers: { authorization: 'Bearer secret123' } });
    assert.equal(r2.status, 200);
  } finally {
    await ch.stop();
  }
});

test('群聊接口：清空回复队列', async () => {
  await withChannel(18907, async ({ url }) => {
    await fetch(`${url}/group/inbound`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        groupId: 'g1', from: 'u1', name: 'A', text: '@鲸鲸 hi', msgId: 'e1', atMe: true,
      }),
    });

    const before = await (await fetch(`${url}/group/outbox`)).json();
    assert.ok(before.messages.length > 0);

    await fetch(`${url}/group/clear`, { method: 'POST' });
    const after = await (await fetch(`${url}/group/outbox`)).json();
    assert.equal(after.messages.length, 0);
  });
});
