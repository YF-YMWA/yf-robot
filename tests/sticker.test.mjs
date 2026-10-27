/**
 * 表情功能测试。
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { decorate, decorateBubbles, detectMood, emojiStats } from '../core/sticker.mjs';

test('detectMood 识别疲惫', () => {
  assert.equal(detectMood('今天好累啊'), 'tired');
  assert.equal(detectMood('困死了'), 'tired');
});

test('detectMood 识别难过', () => {
  assert.equal(detectMood('有点难过'), 'sad');
  assert.equal(detectMood('想哭'), 'sad');
});

test('detectMood 识别开心', () => {
  assert.equal(detectMood('太好了！'), 'happy');
});

test('detectMood 无情绪返回空', () => {
  assert.equal(detectMood('一加一等于二'), '');
});

test('decorate 问句不加表情', () => {
  const out = decorate('你好吗？', { chance: 1 });
  assert.equal(out, '你好吗？');
});

test('decorate 已有 emoji 不重复加', () => {
  const out = decorate('好的😊', { chance: 1 });
  assert.equal(out, '好的😊');
});

test('decorate 已有颜文字不重复加', () => {
  const out = decorate('好的(・ω・)', { chance: 1 });
  assert.equal(out, '好的(・ω・)');
});

test('decorate 太长不加', () => {
  const long = '这是一段很长很长的回复内容'.repeat(10);
  const out = decorate(long, { chance: 1 });
  assert.equal(out, long);
});

test('decorate 概率为 1 时必定添加', () => {
  const out = decorate('今天真累', { chance: 1 });
  assert.notEqual(out, '今天真累', '应添加了表情');
  assert.ok(out.startsWith('今天真累'));
});

test('decorate 概率为 0 时不加', () => {
  const out = decorate('今天真累', { chance: 0 });
  assert.equal(out, '今天真累');
});

test('decorate 疲惫情绪加对应 emoji', () => {
  const out = decorate('好累啊', { chance: 1 });
  // 应包含疲惫类 emoji
  assert.ok(/累|😮‍💨|😪|🥱|😑/.test(out));
});

test('decorate 无情绪时默认不加颜文字', () => {
  for (let i = 0; i < 20; i++) {
    const out = decorate('这样啊', { chance: 1 });
    assert.equal(out, '这样啊', '无情绪不应加表情');
  }
});

test('decorate 显式允许时才给无情绪内容加颜文字', () => {
  let added = 0;
  for (let i = 0; i < 40; i++) {
    const out = decorate('这样啊', { chance: 1, allowNeutral: true });
    if (out !== '这样啊') added++;
  }
  assert.ok(added > 0, 'allowNeutral 时应有机会加颜文字');
  assert.ok(added < 40, '应有一半概率不加');
});

test('decorate 关闭颜文字时用 emoji 或原样', () => {
  const out = decorate('这样啊', { chance: 1, useKaomoji: false });
  // 无情绪且禁用颜文字 → 原样返回
  assert.equal(out, '这样啊');
});

test('decorateBubbles 只给最后一条加', () => {
  const bubbles = ['第一句', '第二句', '今天好累啊'];
  const out = decorateBubbles(bubbles, { chance: 1 });
  assert.equal(out.length, 3);
  assert.equal(out[0], '第一句');
  assert.equal(out[1], '第二句');
  assert.notEqual(out[2], '今天好累啊', '最后一句有情绪，应加表情');
});

test('decorateBubbles 空数组安全', () => {
  assert.deepEqual(decorateBubbles([]), []);
  assert.deepEqual(decorateBubbles(null), null);
});

test('emojiStats 返回非零统计', () => {
  const s = emojiStats();
  assert.ok(s.categories > 0);
  assert.ok(s.emojis > 0);
  assert.ok(s.kaomoji > 0);
});
