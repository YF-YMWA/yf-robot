/**
 * 「没发却声称发了」的兜底逻辑测试。
 *
 * 这个兜底写在 engine 里（依赖整轮上下文），所以这里用一个纯函数版本
 * 复现同样的规则，锁住「哪些话会被改」「哪些不该改」。
 *
 * 规则来源：真实事故 —— 用户要表情包，这轮概率没命中（系统没发任何图），
 * 她却回「发你了，收了没」，用户在微信那头等半天。
 */

/** 与 engine 里那段保持一致的判定与改写 */
function softenClaim(bubbles, sentSomething) {
  const text = bubbles.join(' ');
  const CLAIM = /发你了|给你发了|发过去了|发出了|发了张|发了张图/;
  if (sentSomething || !CLAIM.test(text)) return bubbles;

  return bubbles.map((b) =>
    b
      .replace(/发你了/g, '没发出去')
      .replace(/给你发了/g, '没发出去')
      .replace(/发过去了/g, '没发出去')
      .replace(/发了张图?/g, '想发张图没发出去'),
  );
}

import { test } from 'node:test';
import assert from 'node:assert';

test('没发却声称发了 → 改成没发出去', () => {
  const out = softenClaim(['发你了，收了没'], false);
  assert.equal(out[0], '没发出去，收了没');
  assert.ok(!/发你了/.test(out.join('')));
});

test('真的发了 → 不动', () => {
  const original = ['发你了，收了没'];
  const out = softenClaim(original, true);
  assert.deepEqual(out, original);
});

test('没发但没声称 → 不动', () => {
  const original = ['在', '有事说吧'];
  assert.deepEqual(softenClaim(original, false), original);
});

test('各种声称写法都会被改掉', () => {
  const cases = [
    ['给你发了'],
    ['发过去了'],
    ['我发了张图给你'],
    ['发了张给你看看'],
  ];
  for (const [s] of cases) {
    const out = softenClaim([s], false).join('');
    assert.ok(
      !/发你了|给你发了|发过去了|发了张/.test(out),
      `「${s}」没被改掉，结果是「${out}」`,
    );
  }
});

test('多气泡时只改声称的那一条', () => {
  const out = softenClaim(['在', '发你了', '看看'], false);
  assert.equal(out[0], '在');
  assert.equal(out[1], '没发出去');
  assert.equal(out[2], '看看');
});

test('改了之后读起来通顺（不是半截话）', () => {
  const out = softenClaim(['发你了，收了没'], false).join('');
  assert.ok(out.startsWith('没发出去'));
  assert.ok(out.length > 4);
});
