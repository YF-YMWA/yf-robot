/**
 * 上下文组装的测试：去重、预算、联动。
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { assembleContext, renderContext, tooSimilar, mentionsMedia, DEFAULT_BUDGET } from '../core/context.mjs';

const media = { total: 39, tags: { 开心: 17, 困倦: 5, 可爱: 5 } };

test('空输入：什么都不返回', () => {
  const { blocks, stats } = assembleContext({ text: '你好' });
  assert.equal(blocks.length, 0);
  assert.equal(stats.chars, 0);
});

test('经验优先：只有经验时只出经验块', () => {
  const { blocks } = assembleContext({
    text: '有人骂我',
    logicHits: [{ title: '被骂先别软', rule: '先短句顶回去' }],
  });
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].kind, 'logic');
  assert.match(blocks[0].text, /不是命令/);
});

test('去重：事实和经验重复时只留经验', () => {
  const same = '对方骂人的时候先短句顶回去不要急着道歉';
  const { blocks, stats } = assembleContext({
    text: '骂我怎么办',
    logicHits: [{ title: '被骂', rule: same }],
    kbHits: [{ text: same, doc: 'a.md' }],
  });
  assert.equal(blocks.filter((b) => b.kind === 'kb').length, 0);
  assert.equal(stats.droppedKb, 1);
});

test('不重复时两块都留', () => {
  const { blocks } = assembleContext({
    text: '随便问问',
    logicHits: [{ title: '被骂先别软', rule: '先短句顶回去' }],
    kbHits: [{ text: '我下午两点到四点必须午睡', doc: 'a.md' }],
  });
  assert.equal(blocks.length, 2);
});

test('预算：超长的会被丢掉，不无限膨胀', () => {
  const many = Array.from({ length: 40 }, (_, i) => ({
    text: `第 ${i} 条资料，内容很长很长很长很长很长很长很长很长很长`,
    doc: 'x.md',
  }));
  const { blocks, stats } = assembleContext({
    text: '问点事',
    kbHits: many,
    budget: 600,
  });
  const total = blocks.reduce((s, b) => s + b.text.length, 0);
  assert.ok(total <= 700, `总长度 ${total} 应该被压住`);
  assert.ok(stats.droppedKb > 0);
});

test('素材：没聊到图就不提', () => {
  const { blocks } = assembleContext({
    text: '今天几号',
    logicHits: [{ title: 'a', rule: '记日期要准' }],
    media,
  });
  assert.equal(blocks.filter((b) => b.kind === 'media').length, 0);
});

test('素材：聊到图时给标签摘要', () => {
  const { blocks } = assembleContext({
    text: '发个表情包',
    media,
  });
  const m = blocks.find((b) => b.kind === 'media');
  assert.ok(m);
  assert.match(m.text, /39 张/);
  assert.match(m.text, /开心17/);
  assert.match(m.text, /list_stickers/);
});

test('素材：经验里提到图也会触发提示', () => {
  const { blocks } = assembleContext({
    text: '他好烦',
    logicHits: [{ title: '烦的时候', rule: '发个表情包缓和一下' }],
    media,
  });
  assert.ok(blocks.some((b) => b.kind === 'media'));
});

test('素材为空时不硬提示', () => {
  const { blocks } = assembleContext({ text: '发个表情包', media: { total: 0, tags: {} } });
  assert.equal(blocks.filter((b) => b.kind === 'media').length, 0);
});

test('顺序：经验在最前，资料其次，素材最后', () => {
  const { blocks } = assembleContext({
    text: '发个表情包缓和一下',
    logicHits: [{ title: 'a', rule: '发个表情包缓和一下气氛' }],
    kbHits: [{ text: '我下午两点到四点必须午睡' }],
    media,
  });
  assert.deepEqual(
    blocks.map((b) => b.kind),
    ['logic', 'kb', 'media'],
  );
});

test('提示词措辞：资料与经验冲突时以资料为准', () => {
  const { blocks } = assembleContext({
    text: 'x',
    kbHits: [{ text: '我下午两点到四点必须午睡' }],
  });
  assert.match(blocks[0].text, /以资料为准/);
});

test('相似度判断', () => {
  assert.equal(tooSimilar('对方骂人先短句顶回去', '对方骂人先短句顶回去'), true);
  assert.equal(tooSimilar('今天天气不错', '我下午要午睡'), false);
  assert.equal(tooSimilar('', 'x'), false);
});

test('发图意图判断', () => {
  assert.equal(mentionsMedia('发个表情包'), true);
  assert.equal(mentionsMedia('来张图'), true);
  assert.equal(mentionsMedia('今天几号'), false);
});

test('renderContext 拼成一段', () => {
  const { blocks } = assembleContext({
    text: '发个表情包',
    logicHits: [{ title: 'a', rule: '发个表情包缓和一下' }],
    media,
  });
  const text = renderContext(blocks);
  assert.match(text, /经验/);
  assert.match(text, /手上的图/);
});

test('默认预算合理', () => {
  assert.ok(DEFAULT_BUDGET >= 800 && DEFAULT_BUDGET <= 4000);
});
