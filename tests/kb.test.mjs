/**
 * 知识库单元测试：切块、解析、检索、去重。
 *
 * 不依赖网络的部分（切块/解析/余弦）必须全过；
 * 依赖嵌入接口的部分标 SKIP（没 Key 时）。
 */
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { chunkText, cosine, parseDocument, KnowledgeBase } from '../core/kb.mjs';

const TMP = path.join(process.cwd(), '.tmp', 'kb-test');
fs.mkdirSync(TMP, { recursive: true });
process.on('exit', () => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {}
});

test('切块：短文本不切', () => {
  const out = chunkText('很短的一句话。');
  assert.equal(out.length, 1);
  assert.equal(out[0], '很短的一句话。');
});

test('切块：长文本会被切开但保留重叠', () => {
  const text = Array.from({ length: 40 }, (_, i) => `第${i}句话说完了。`).join('');
  const out = chunkText(text, { size: 100, overlap: 20 });
  assert.ok(out.length > 3, '应该被切成多块');
  // 每块都不应为空
  assert.ok(out.every((c) => c.length > 0));
});

test('切块：尽量在句号处断开', () => {
  const text = '甲'.repeat(80) + '。' + '乙'.repeat(80) + '。';
  const out = chunkText(text, { size: 100, overlap: 10 });
  assert.ok(out.some((c) => c.endsWith('。')), '应该有以句号结尾的块');
});

test('切块：空文本返回空数组', () => {
  assert.deepEqual(chunkText(''), []);
  assert.deepEqual(chunkText('   '), []);
});

test('余弦：相同向量为 1，正交为 0', () => {
  assert.equal(Math.round(cosine([1, 0], [1, 0]) * 100) / 100, 1);
  assert.equal(cosine([1, 0], [0, 1]), 0);
  assert.equal(cosine([], [1]), 0);
});

test('解析：txt 直接读', () => {
  const f = path.join(TMP, 'a.txt');
  fs.writeFileSync(f, '你好，知识库。', 'utf8');
  const r = parseDocument(f);
  assert.equal(r.ok, true);
  assert.match(r.text, /你好/);
});

test('解析：md 保留内容', () => {
  const f = path.join(TMP, 'b.md');
  fs.writeFileSync(f, '# 标题\n\n正文内容。', 'utf8');
  const r = parseDocument(f);
  assert.equal(r.ok, true);
  assert.match(r.text, /正文内容/);
});

test('解析：html 去掉标签', () => {
  const f = path.join(TMP, 'c.html');
  fs.writeFileSync(f, '<p>第一段</p><script>bad()</script><p>第二段</p>', 'utf8');
  const r = parseDocument(f);
  assert.equal(r.ok, true);
  assert.match(r.text, /第一段/);
  assert.match(r.text, /第二段/);
  assert.doesNotMatch(r.text, /bad\(\)/);
  assert.doesNotMatch(r.text, /<p>/);
});

test('解析：pdf 给出明确提示而不是静默失败', () => {
  const f = path.join(TMP, 'd.pdf');
  fs.writeFileSync(f, '%PDF-1.4 fake', 'utf8');
  const r = parseDocument(f);
  assert.equal(r.ok, false);
  assert.match(r.error, /PDF/);
});

test('解析：不支持的格式被拒绝', () => {
  const f = path.join(TMP, 'e.exe');
  fs.writeFileSync(f, 'x', 'utf8');
  const r = parseDocument(f);
  assert.equal(r.ok, false);
  assert.match(r.error, /不支持/);
});

test('解析：空文件被拒绝', () => {
  const f = path.join(TMP, 'f.txt');
  fs.writeFileSync(f, '   \n  ', 'utf8');
  const r = parseDocument(f);
  assert.equal(r.ok, false);
});

test('知识库：没有文档时检索返回空', async () => {
  const kb = new KnowledgeBase({
    root: path.join(TMP, 'kbroot1'),
    config: { vision: { apiKey: 'x' } },
  });
  const hits = await kb.search('随便问点什么');
  assert.deepEqual(hits, []);
});

test('提示词渲染：带资料编号和用法说明', () => {
  const s = KnowledgeBase.render([{ text: '大肥鱼爱吃米饭。', score: 0.9, doc: 'a.txt' }]);
  assert.match(s, /参考资料/);
  assert.match(s, /资料1/);
  assert.match(s, /大肥鱼爱吃米饭/);
  assert.match(s, /不要编/);
});

test('提示词渲染：没有命中返回空串', () => {
  assert.equal(KnowledgeBase.render([]), '');
  assert.equal(KnowledgeBase.render(null), '');
});
