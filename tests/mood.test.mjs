/**
 * 情绪状态的测试：增量判断、衰减、存储隔离。
 */
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { MoodStore, moodDelta, describeMood, MIN_SCORE, MAX_SCORE } from '../core/mood.mjs';

const TMP = path.join(process.cwd(), '.tmp', 'mood-test');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
process.on('exit', () => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {}
});

const store = (name = 'm') =>
  new MoodStore({ file: path.join(TMP, name + '.json'), log: () => {} });

// ===== 情绪增量 =====

test('骂人：明显往下掉', () => {
  assert.ok(moodDelta('你个傻逼') < -2);
  assert.ok(moodDelta('滚') < -2);
});

test('阴阳怪气：小幅下掉', () => {
  const d = moodDelta('你算老几啊');
  assert.ok(d < 0 && d > -2);
});

test('夸人：明显往上', () => {
  assert.ok(moodDelta('你真厉害，谢谢') > 1);
});

test('玩笑：小幅上浮', () => {
  assert.ok(moodDelta('哈哈哈哈笑死我了') > 0);
});

test('敷衍：小幅下掉（她也会失落）', () => {
  assert.ok(moodDelta('嗯') < 0);
});

test('对方诉苦：让她沉下来', () => {
  assert.ok(moodDelta('今天好累啊') < 0);
});

test('普通寒暄：不变', () => {
  assert.equal(moodDelta('今天几号'), 0);
});

test('增量有上限，单句不会暴走', () => {
  assert.ok(moodDelta('傻逼'.repeat(50)) >= -3);
  assert.ok(moodDelta('谢谢'.repeat(50)) <= 3);
});

test('空输入不变', () => {
  assert.equal(moodDelta(''), 0);
  assert.equal(moodDelta(null), 0);
});

// ===== 分数与描述 =====

test('描述：分档合理', () => {
  assert.equal(describeMood(80).label, '心情很好');
  assert.equal(describeMood(0).label, '平静');
  assert.equal(describeMood(-80).label, '很不爽');
});

test('描述：都带提示语', () => {
  for (const s of [80, 30, 0, -30, -80]) {
    assert.ok(describeMood(s).hint.length > 4);
  }
});

// ===== 存储 =====

test('存储：应用增量并累加', () => {
  const s = store('a');
  assert.equal(s.score('s1'), 0);
  assert.equal(s.apply('s1', 5), 5);
  assert.equal(s.apply('s1', 3), 8);
});

test('存储：上限封顶', () => {
  const s = store('b');
  s.apply('s1', 500);
  assert.equal(s.score('s1'), MAX_SCORE);
});

test('存储：下限封顶', () => {
  const s = store('c');
  s.apply('s1', -500);
  assert.equal(s.score('s1'), MIN_SCORE);
});

test('存储：会话之间互不影响', () => {
  const s = store('d');
  s.apply('alice', -3);
  s.apply('bob', 3);
  assert.ok(s.score('alice') < 0);
  assert.ok(s.score('bob') > 0);
});

test('存储：时间久了往中间回归', () => {
  const s = store('e');
  const now = new Date('2026-10-28T10:00:00Z');
  s.apply('s1', 80, now);

  const later = new Date(now.getTime() + 90 * 60 * 1000);
  const after = s.score('s1', later);
  assert.ok(after < 80, `过 90 分钟应该降下来，实际 ${after}`);
  assert.ok(after > 0, '不会一下归零');

  const muchLater = new Date(now.getTime() + 900 * 60 * 1000);
  assert.ok(Math.abs(s.score('s1', muchLater)) < 5, '过很久应该接近 0');
});

test('存储：落盘后能读回来', () => {
  const file = path.join(TMP, 'persist.json');
  const a = new MoodStore({ file, log: () => {} });
  a.apply('s1', 10);

  const b = new MoodStore({ file, log: () => {} });
  assert.equal(b.score('s1'), 10);
});

test('存储：文件坏了不崩', () => {
  const file = path.join(TMP, 'broken.json');
  fs.writeFileSync(file, '{不是 json', 'utf8');
  const s = new MoodStore({ file, log: () => {} });
  assert.equal(s.score('s1'), 0);
  assert.equal(s.apply('s1', 2), 2);
});

test('render：给模型的句子带标签和提示', () => {
  const s = store('f');
  s.apply('s1', -80);
  const line = s.render('s1');
  assert.match(line, /此刻的心情/);
  assert.match(line, /很不爽/);
});

test('list：列出所有会话', () => {
  const s = store('g');
  s.apply('a', 5);
  s.apply('b', -5);
  const list = s.list();
  assert.equal(list.length, 2);
  assert.ok(list.every((x) => x.sessionId && x.label));
});
