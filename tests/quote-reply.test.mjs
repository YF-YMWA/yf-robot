/**
 * 引用回复：能看到在回哪条。
 *
 * 用户报「无法看见引用」。根因是适配器 config.json 里 quoteReply=false，
 * 而面板上根本没有这个开关 —— 想开都没地方开。
 */
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';

const BASE = 'http://127.0.0.1:8899';

async function alive() {
  try {
    const r = await fetch(BASE + '/api/adapter/config', { signal: AbortSignal.timeout(1500) });
    return r.status < 500;
  } catch {
    return false;
  }
}

test('配置 schema 里有 quoteReply（否则改了会被静默丢弃）', () => {
  const s = fs.readFileSync('core/config-schema.mjs', 'utf8');
  assert.ok(/quoteReply: F\('boolean'/.test(s), 'schema 里没有 quoteReply');
});

test('核心会把它传给适配器', async (t) => {
  if (!(await alive())) {
    t.skip('服务没在跑');
    return;
  }
  const j = await fetch(BASE + '/api/adapter/config').then((r) => r.json());
  assert.equal(typeof j.quoteReply, 'boolean', '接口应该返回 quoteReply 布尔值');
});

test('面板上有这个开关', () => {
  const s = fs.readFileSync('web/console.html', 'utf8');
  assert.ok(s.includes('swQuoteReply'), '面板里没有引用回复开关');
  assert.ok(s.includes('saveQuoteReply'), '没有保存逻辑');
});

test('适配器会从核心策略里读它', () => {
  const p = '../yf-robot-wechat-adapter/wechatauto_bridge.py';
  if (!fs.existsSync(p)) {
    return; // 单独检出主仓时跳过
  }
  const s = fs.readFileSync(p, 'utf8');
  assert.ok(
    /j\.get\("quoteReply"\)/.test(s),
    '适配器没接受核心的 quoteReply，面板开了也不会生效',
  );
});
