/**
 * 「用户明确要表情包」的识别。
 *
 * 存在的原因：随机补图是锦上添花，但用户点名要的时候再掷骰子，
 * 表现就是「我说了三遍发个表情包，她就是不发」。
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { wantsSticker } from '../core/sticker.mjs';

test('明确索取：发个表情包', () => {
  assert.equal(wantsSticker('发个表情包给我看看'), true);
  assert.equal(wantsSticker('发张表情包'), true);
  assert.equal(wantsSticker('来一张动图'), true);
});

test('明确索取：发回来 / 再发一次', () => {
  assert.equal(wantsSticker('发回给我看看'), true);
  assert.equal(wantsSticker('再发一次'), true);
  assert.equal(wantsSticker('来张梗图'), true);
});

test('英文也算', () => {
  assert.equal(wantsSticker('send me a sticker'), true);
  assert.equal(wantsSticker('发个 gif'), true);
});

test('不是索取：描述性的句子不触发', () => {
  assert.equal(wantsSticker('他的表情很奇怪'), false);
  assert.equal(wantsSticker('今天心情不错'), false);
  assert.equal(wantsSticker(''), false);
});

test('太长的话不触发（防止长段落里夹着「表情」）', () => {
  const long = '我今天看了一个特别长的视频，里面的人一直在做各种奇怪的表情和动作，' +
    '然后还有很多人评论说这个视频很好笑，我也想发个表情包但是不知道发什么';
  assert.equal(wantsSticker(long), false);
});

test('要动图：wantsGif 认得出来', async () => {
  const { wantsGif } = await import('../core/sticker.mjs');
  assert.equal(wantsGif('发张动图给我看看'), true);
  assert.equal(wantsGif('来个会动的'), true);
  assert.equal(wantsGif('发个 gif'), true);
  assert.equal(wantsGif('发张图给我看看'), false);
  assert.equal(wantsGif('发个表情包'), false);
});

test('发回来 vs 随便发：上下文提示只在「要回原图」时出现', () => {
  // 与 context.mjs 里那条正则保持一致
  const askBack = /(刚才那[张个]|刚收的|发回来|发回给|再发一次|同一张|原图)/;

  assert.ok(askBack.test('发回来给我看看'), '要回原图');
  assert.ok(askBack.test('刚才那张再发一下'), '指代刚才那张');
  assert.ok(!askBack.test('发张图给我看看'), '泛泛要图不该锁死到刚收的那张');
  assert.ok(!askBack.test('发张动图'), '要动图不该锁死');
});
