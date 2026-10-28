/**
 * 语音回复决策的测试：清洗、长度、内容类型、概率。
 */
import { test } from 'node:test';
import assert from 'node:assert';
import {
  cleanForSpeech,
  speechCandidate,
  decideVoiceReply,
  MAX_SPEECH_CHARS,
  MIN_SPEECH_CHARS,
} from '../core/voice-reply.mjs';

const always = () => 0; // 随机值固定 0 = 必中
const never = () => 0.99;

// ===== 清洗 =====

test('清洗：去掉括号里的动作描写', () => {
  const out = cleanForSpeech('（尾巴拍了拍）在的，你说');
  assert.equal(out, '在的，你说');
});

test('清洗：英文括号也去掉', () => {
  assert.equal(cleanForSpeech('(smiles) hello there'), 'hello there');
});

test('清洗：去掉 emoji', () => {
  const out = cleanForSpeech('今天好累啊😮‍💨');
  assert.ok(!out.includes('😮'));
  assert.ok(out.includes('今天好累啊'));
});

test('清洗：去掉代码块', () => {
  const out = cleanForSpeech('写好了\n```js\nconsole.log(1)\n```\n放在文件里');
  assert.ok(!out.includes('console.log'));
  assert.ok(out.includes('放在文件里'));
});

test('清洗：去掉行内代码和 URL', () => {
  const out = cleanForSpeech('见 `config.json` 和 https://example.com/a');
  assert.ok(!out.includes('config.json'));
  assert.ok(!out.includes('example.com'));
});

test('清洗：去掉 markdown 记号', () => {
  const out = cleanForSpeech('**重点**内容');
  assert.ok(!out.includes('*'));
  assert.ok(out.includes('重点'));
});

// ===== 该不该念 =====

test('太短不念', () => {
  const r = speechCandidate('在。');
  assert.equal(r.ok, false);
  assert.match(r.reason, /太短/);
});

test('太长不念', () => {
  const long = '这是一段很长的话'.repeat(30);
  const r = speechCandidate(long);
  assert.equal(r.ok, false);
  assert.match(r.reason, /太长/);
});

test('中文占比太低不念（代码/链接）', () => {
  const r = speechCandidate('POST /api/admin/config 返回 200 并且 content-type 是 json');
  assert.equal(r.ok, false);
});

test('正常短句可以念', () => {
  const r = speechCandidate('今天有点累，先歇会儿吧');
  assert.equal(r.ok, true);
  assert.ok(r.text.length > 0);
  assert.ok(r.chars <= MAX_SPEECH_CHARS);
});

test('清洗后变太短也不念', () => {
  // 全是动作描写，清洗完就没了
  const r = speechCandidate('（挪了挪）');
  assert.equal(r.ok, false);
});

test('气泡拼接后按整体判断', () => {
  const r = speechCandidate('在的，一直趴这儿呢 （尾巴拍了下水） 有活就丢过来');
  assert.equal(r.ok, true);
  assert.ok(!r.text.includes('尾巴'));
});

// ===== 概率与开关 =====

test('开关关着不发', () => {
  const v = decideVoiceReply({ text: '今天有点累先歇会儿', chance: 1, enabled: false });
  assert.equal(v.speak, false);
  assert.match(v.reason, /没开/);
});

test('概率 0 不发', () => {
  const v = decideVoiceReply({ text: '今天有点累先歇会儿', chance: 0, enabled: true });
  assert.equal(v.speak, false);
  assert.match(v.reason, /概率/);
});

test('概率 1 必发', () => {
  const v = decideVoiceReply({ text: '今天有点累先歇会儿', chance: 1, rand: always });
  assert.equal(v.speak, true);
  assert.equal(v.text, '今天有点累先歇会儿');
});

test('没命中概率不发', () => {
  const v = decideVoiceReply({ text: '今天有点累先歇会儿', chance: 0.5, rand: never });
  assert.equal(v.speak, false);
  assert.match(v.reason, /没命中/);
});

test('内容不合适时，即使概率 1 也不发', () => {
  const v = decideVoiceReply({ text: '在。', chance: 1, rand: always });
  assert.equal(v.speak, false);
});

test('下限常量合理', () => {
  assert.ok(MIN_SPEECH_CHARS >= 2 && MIN_SPEECH_CHARS <= 10);
  assert.ok(MAX_SPEECH_CHARS >= 40 && MAX_SPEECH_CHARS <= 200);
});
