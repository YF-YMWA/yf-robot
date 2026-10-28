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

// ===== 错字不能把句子弄成胡话 =====

test('错字：不会把「说」换成「税」这类词', () => {
  const bad = ['税', '事', '友', '反', '砍', '谁', '池', '药', '梅', '莱', '号', '取', '布'];
  const samples = [
    '它回话说到了，我正在等它再确认一遍',
    '我觉得这样不太好，你说呢',
    '刚才那句话说错了，我得改一下',
    '有没有别的办法啊，我有点累了',
  ];

  for (const s of samples) {
    for (let i = 0; i < 40; i++) {
      const r = makeTypo(s);
      if (!r) continue;
      for (const ch of bad) {
        assert.ok(
          !r.wrong.includes(ch),
          `「${s}」被换成了「${r.wrong}」，出现了不该有的字「${ch}」`,
        );
      }
    }
  }
});

test('错字：改口后的原文能和错字区分开', () => {
  const r = makeTypo('我再说一遍这个事情');
  if (!r) return; // 没命中就跳过（概率性）
  assert.notEqual(r.wrong, r.right, '错字版和原文不该一样');
});
