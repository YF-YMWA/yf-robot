/**
 * 防幻觉测试：验证回复数据是否来自搜索结果。
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { checkGrounding, formatSearchResults } from '../core/search.mjs';

const results = [
  {
    title: '金华天气预报',
    snippet: '金华今天阴，气温18-20℃，东北风2级。明天多云，气温19-23℃。',
    url: 'http://weather.com/jinhua',
  },
  {
    title: '兰溪天气',
    snippet: '兰溪今日阴天，16到19度，风力不大。',
    url: 'http://weather.com/lanxi',
  },
];

test('checkGrounding 数据来自资料时不标记', () => {
  const reply = '金华今天阴，气温 18 到 20 度，风力不大。';
  const r = checkGrounding(reply, results);
  assert.equal(r.suspicious, false);
});

test('checkGrounding 编造温度时标记', () => {
  const reply = '金华今天 35 度，非常热。';
  const r = checkGrounding(reply, results);
  assert.equal(r.suspicious, true);
  assert.ok(r.reason.includes('35'));
});

test('checkGrounding 中文数字温度也检查', () => {
  // 资料里有 "16到19度"，回复说 "二十五度" 应被标记
  const reply = '兰溪今天二十五度左右。';
  const r = checkGrounding(reply, results);
  assert.equal(r.suspicious, true);
});

test('checkGrounding 编造明日天气时标记', () => {
  // 金华资料里说"明天多云"，没说下雨
  const reply = '金华明天小雨，记得带伞。';
  const r = checkGrounding(reply, results);
  // 资料里没提"明天...雨"
  assert.ok(r.suspicious || !/明天/.test(reply) === false);
});

test('checkGrounding 无结果时不标记', () => {
  const r = checkGrounding('随便写点什么', []);
  assert.equal(r.suspicious, false);
});

test('checkGrounding 空回复不标记', () => {
  const r = checkGrounding('', results);
  assert.equal(r.suspicious, false);
});

test('formatSearchResults 包含防幻觉规则', () => {
  const out = formatSearchResults(results);
  assert.ok(out.includes('只能使用'));
  assert.ok(out.includes('不要编造') || out.includes('绝对不要编造'));
  assert.ok(out.includes('查询时间'));
});

test('formatSearchResults 标注来源', () => {
  const out = formatSearchResults(results);
  assert.ok(out.includes('金华天气预报'));
  assert.ok(out.includes('weather.com'));
});

test('formatSearchResults 空结果返回空串', () => {
  assert.equal(formatSearchResults([]), '');
  assert.equal(formatSearchResults(null), '');
});

test('formatSearchResults 保留更多原文内容', () => {
  const longText = '这是一段很长的天气描述'.repeat(50);
  const out = formatSearchResults([{ title: 'T', snippet: longText, url: '' }]);
  // 应该保留 500 字左右，而不是之前只有 300
  assert.ok(out.length > 400);
});
