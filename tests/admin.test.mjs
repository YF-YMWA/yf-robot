/**
 * 管理接口测试。
 */
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { AdminApi } from '../core/admin.mjs';
import { ChatEngine } from '../core/engine.mjs';
import { loadConfig } from '../core/config.mjs';
import { PERSONA_DEFAULTS } from '../core/persona.mjs';

function makeApi(over = {}) {
  const config = loadConfig({
    root: process.cwd(),
    env: {},
    override: {
      llm: { baseUrl: 'http://mock.local', apiKey: 'sk-test-key-123456', model: 'mock' },
      channels: { web: { enabled: true } },
      ...over,
    },
  });

  const engine = new ChatEngine({
    config,
    persona: { ...PERSONA_DEFAULTS, name: '鲸鲸' },
    logger: { error() {}, warn() {}, info() {} },
    fetchImpl: async () =>
      new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
  });

  return { api: new AdminApi({ engine, config, channels: ['web'] }), config, engine };
}

test('status 返回运行状态', async () => {
  const { api } = makeApi();
  const r = await api.handle('GET', '/api/admin/status');
  assert.equal(r.code, 200);
  assert.equal(r.body.ok, true);
  assert.ok(r.body.uptime >= 0);
  assert.equal(r.body.hasKey, true);
  assert.ok(Array.isArray(r.body.channels));
});

test('config 脱敏返回 Key', async () => {
  const { api } = makeApi();
  const r = await api.handle('GET', '/api/admin/config');
  assert.equal(r.code, 200);
  assert.ok(r.body.llm.apiKeyMasked.includes('****'), 'Key 应脱敏');
  assert.ok(!r.body.llm.apiKeyMasked.includes('test-key'), '不应暴露完整 Key');
  assert.equal(r.body.llm.hasKey, true);
});

test('非管理路径返回 null', async () => {
  const { api } = makeApi();
  const r = await api.handle('GET', '/api/chat', null);
  assert.equal(r, null);
});

test('sessions 返回会话统计', async () => {
  const { api } = makeApi();
  const r = await api.handle('GET', '/api/admin/sessions');
  assert.equal(r.code, 200);
  assert.ok('count' in r.body);
});

test('cards 返回人物卡列表', async () => {
  const { api } = makeApi();
  const r = await api.handle('GET', '/api/admin/cards');
  assert.equal(r.code, 200);
  assert.ok(Array.isArray(r.body.cards));
});

test('logs 返回日志结构', async () => {
  const { api } = makeApi();
  const r = await api.handle('GET', '/api/admin/logs');
  assert.equal(r.code, 200);
  assert.ok('out' in r.body);
  assert.ok('err' in r.body);
});
