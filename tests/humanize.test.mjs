/**
 * 拟人化后处理测试：错字改口、标点自然化、偶尔只说一句。
 */
import { test } from 'node:test';
import assert from 'node:assert';
import {
  makeTypo,
  addTypoSlip,
  naturalizePunctuation,
  sometimesTerse,
} from '../core/humanize.mjs';


// ===== 标点自然化 =====

test('标点：短句结尾句号会被删掉', () => {
  const out = naturalizePunctuation(['在的。'], { chance: 1 });
  assert.equal(out[0], '在的');
});

test('标点：问号感叹号不动', () => {
  assert.equal(naturalizePunctuation(['在吗？'], { chance: 1 })[0], '在吗？');
  assert.equal(naturalizePunctuation(['太好了！'], { chance: 1 })[0], '太好了！');
});

test('标点：多句保留（句中的句号有意义）', () => {
  const s = '先歇会儿。活儿又不会跑。';
  assert.equal(naturalizePunctuation([s], { chance: 1 })[0], s);
});

test('标点：太长的不动', () => {
  const s = '这是一段很长的话'.repeat(6) + '。';
  assert.equal(naturalizePunctuation([s], { chance: 1 })[0], s);
});

test('标点：概率为 0 时不改', () => {
  assert.equal(naturalizePunctuation(['在的。'], { chance: 0 })[0], '在的。');
});

test('标点：没有句号的原样返回', () => {
  assert.equal(naturalizePunctuation(['在的'], { chance: 1 })[0], '在的');
});

test('标点：空数组不崩', () => {
  assert.deepEqual(naturalizePunctuation([], {}), []);
});

// ===== 偶尔只说一句 =====

test('简短：概率 1 时只留第一条', () => {
  const out = sometimesTerse(['在的，你说吧', '我听着呢'], { chance: 1 });
  assert.equal(out.length, 1);
  assert.equal(out[0], '在的，你说吧');
});

test('简短：第一条太短时带上第二条', () => {
  const out = sometimesTerse(['嗯', '我听着呢'], { chance: 1 });
  assert.equal(out.length, 2);
});

test('简短：概率 0 时不动', () => {
  const out = sometimesTerse(['一', '二'], { chance: 0 });
  assert.equal(out.length, 2);
});

test('简短：本来只有一条时不动', () => {
  const out = sometimesTerse(['就一句'], { chance: 1 });
  assert.equal(out.length, 1);
});
