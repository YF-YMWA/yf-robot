/**
 * 语音、搜索、B站分享的单元测试。（群聊见 group.test.mjs）
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { sniffAudioFormat, probeDuration, toMp3, VoiceClient, VoiceError } from '../core/voice.mjs';
import { SearchClient, formatSearchResults, needsSearch, SearchError } from '../core/search.mjs';
import { findFfmpeg } from '../core/image.mjs';
import { formatCount, BilibiliClient } from '../core/share.mjs';

const execFileAsync = promisify(execFile);
const FFMPEG = findFfmpeg();
const _tmpRoot = path.join(process.cwd(), ".tmp");
fs.mkdirSync(_tmpRoot, { recursive: true });
const tmpDir = fs.mkdtempSync(path.join(_tmpRoot, "t-"));

// ---------- 语音格式识别 ----------

test('sniffAudioFormat 识别 AMR', () => {
  const buf = Buffer.from('#!AMR\n\x00\x00', 'binary');
  assert.equal(sniffAudioFormat(buf), 'amr');
});

test('sniffAudioFormat 识别 SILK', () => {
  const buf = Buffer.concat([Buffer.from([0x02]), Buffer.from('#!SILK_V3', 'ascii')]);
  assert.equal(sniffAudioFormat(buf), 'silk');
});

test('sniffAudioFormat 识别 WAV', () => {
  const buf = Buffer.concat([
    Buffer.from('RIFF', 'ascii'),
    Buffer.alloc(4),
    Buffer.from('WAVE', 'ascii'),
    Buffer.alloc(8),
  ]);
  assert.equal(sniffAudioFormat(buf), 'wav');
});

test('sniffAudioFormat 识别 MP3（ID3）', () => {
  const buf = Buffer.concat([Buffer.from('ID3', 'ascii'), Buffer.alloc(20)]);
  assert.equal(sniffAudioFormat(buf), 'mp3');
});

test('sniffAudioFormat 识别 MP3（帧同步）', () => {
  const buf = Buffer.from([0xff, 0xfb, 0x90, 0x00, 0, 0, 0, 0]);
  assert.equal(sniffAudioFormat(buf), 'mp3');
});

test('sniffAudioFormat 识别 M4A', () => {
  const buf = Buffer.concat([
    Buffer.from([0, 0, 0, 0x20]),
    Buffer.from('ftypM4A ', 'ascii'),
    Buffer.alloc(16),
  ]);
  assert.equal(sniffAudioFormat(buf), 'm4a');
});

test('sniffAudioFormat 未知返回 unknown', () => {
  assert.equal(sniffAudioFormat(Buffer.alloc(20)), 'unknown');
});

// ---------- 语音转码与识别 ----------

async function makeWav(seconds = 1) {
  const file = path.join(tmpDir, `t${Math.random().toString(36).slice(2)}.wav`);
  try {
    await execFileAsync(
      FFMPEG,
      ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`, file],
      { timeout: 20000 },
    );
  } catch {
    return null;
  }
  return fs.existsSync(file) ? fs.readFileSync(file) : null;
}

test('probeDuration 读出音频时长', async (t) => {
  const wav = await makeWav(2);
  if (!wav) return t.skip('ffmpeg 不可用');
  const d = await probeDuration(wav);
  assert.ok(d >= 1.9 && d <= 2.1, `实际 ${d}`);
});

test('toMp3 转码后可被识别', async (t) => {
  const wav = await makeWav(1);
  if (!wav) return t.skip('ffmpeg 不可用');
  const mp3 = await toMp3(wav);
  assert.equal(sniffAudioFormat(mp3), 'mp3');
});

test('VoiceClient 未启用时抛错', async () => {
  const c = new VoiceClient({ enabled: false });
  await assert.rejects(() => c.transcribe(Buffer.alloc(10)), VoiceError);
});

test('VoiceClient 走 chat 模式识别', async (t) => {
  const wav = await makeWav(1);
  if (!wav) return t.skip('ffmpeg 不可用');

  const c = new VoiceClient(
    {
      enabled: true,
      baseUrl: 'http://asr.mock',
      apiKey: 'k',
      model: 'qwen3-asr-flash',
      mode: 'chat',
      timeoutMs: 5000,
      maxSeconds: 60,
    },
    {
      fetchImpl: async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: '今天天气不错' } }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    },
  );

  const r = await c.transcribe(wav);
  assert.equal(r.text, '今天天气不错');
});

test('VoiceClient 超长语音拒绝', async (t) => {
  const wav = await makeWav(3);
  if (!wav) return t.skip('ffmpeg 不可用');

  const c = new VoiceClient(
    {
      enabled: true,
      baseUrl: 'http://asr.mock',
      apiKey: 'k',
      model: 'm',
      mode: 'chat',
      timeoutMs: 5000,
      maxSeconds: 2,
    },
    { fetchImpl: async () => new Response('{}', { status: 200 }) },
  );

  await assert.rejects(() => c.transcribe(wav), /太长/);
});

// ---------- 搜索 ----------

test('needsSearch 识别时效性提问', () => {
  assert.ok(needsSearch('今天的新闻有什么'));
  assert.ok(needsSearch('现在北京天气怎么样'));
  assert.ok(needsSearch('帮我查一下股价'));
  assert.ok(!needsSearch('你好呀'));
  assert.ok(!needsSearch('一加一等于几'));
});

test('needsSearch 不因情绪词误触发（回归）', () => {
  assert.ok(!needsSearch('今天好累啊'), '情绪表达不该触发搜索');
  assert.ok(!needsSearch('有点难过'), '情绪表达不该触发搜索');
  assert.ok(!needsSearch('我饿了'), '情绪表达不该触发搜索');
  assert.ok(!needsSearch('你在干嘛'), '闲聊不该触发搜索');
});

test('needsSearch 明确查询意图仍然触发', () => {
  assert.ok(needsSearch('帮我查一下最新的政策'));
  assert.ok(needsSearch('比特币现在多少钱'));
  assert.ok(needsSearch('谁是李白'));
});

test('formatSearchResults 拼装结果', () => {
  const out = formatSearchResults([
    { title: '标题A', snippet: '摘要A', url: 'http://a.com' },
  ]);
  assert.ok(out.includes('标题A'));
  assert.ok(out.includes('摘要A'));
  assert.ok(out.includes('资料结束'));
});

test('formatSearchResults 空结果返回空串', () => {
  assert.equal(formatSearchResults([]), '');
  assert.equal(formatSearchResults(null), '');
});

test('SearchClient 未启用时抛错', async () => {
  const c = new SearchClient({ enabled: false });
  await assert.rejects(() => c.search('test'), SearchError);
});

test('SearchClient bocha 解析结果', async () => {
  const c = new SearchClient(
    { enabled: true, provider: 'bocha', apiKey: 'k', maxResults: 3 },
    {
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            data: {
              webPages: {
                value: [
                  { name: '结果1', summary: '摘要1', url: 'http://1.com' },
                  { name: '结果2', summary: '摘要2', url: 'http://2.com' },
                ],
              },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    },
  );

  const r = await c.search('测试');
  assert.equal(r.length, 2);
  assert.equal(r[0].title, '结果1');
});

// ---------- B站 ----------

test('formatCount 数字格式化', () => {
  assert.equal(formatCount(500), '500');
  assert.equal(formatCount(12345), '1.2万');
  assert.equal(formatCount(123456789), '1.2亿');
  assert.equal(formatCount(null), '');
});

test('BilibiliClient 解析热门列表', async () => {
  const c = new BilibiliClient(
    { enabled: true, count: 2, keywords: [], recentIds: [] },
    {
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            code: 0,
            data: {
              list: [
                { bvid: 'BV1', title: '视频1', desc: '', owner: { name: 'up1' }, stat: { view: 10000 }, cid: 1 },
                { bvid: 'BV2', title: '视频2', desc: '', owner: { name: 'up2' }, stat: { view: 5000 }, cid: 2 },
              ],
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    },
  );

  const list = await c.fetchPopular();
  assert.equal(list.length, 2);
  assert.equal(list[0].url, 'https://www.bilibili.com/video/BV1');
});

test('BilibiliClient 关键词优先', async () => {
  const c = new BilibiliClient(
    { enabled: true, keywords: ['鲸鱼'], recentIds: [] },
    {
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            code: 0,
            data: {
              list: [
                { bvid: 'A', title: '普通视频', desc: '', owner: {}, stat: {}, cid: 1 },
                { bvid: 'B', title: '鲸鱼纪录片', desc: '', owner: {}, stat: {}, cid: 2 },
              ],
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    },
  );

  const v = await c.pick();
  assert.equal(v.bvid, 'B', '应优先选含关键词的');
});

test('BilibiliClient 排除最近分享过的', async () => {
  const c = new BilibiliClient(
    { enabled: true, keywords: [], recentIds: ['A'] },
    {
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            code: 0,
            data: { list: [{ bvid: 'A', title: 'x', desc: '', owner: {}, stat: {}, cid: 1 }] },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    },
  );

  const v = await c.pick();
  // 只有一个且被排除，应回退到列表首项
  assert.equal(v.bvid, 'A');
});

test('cleanup', () => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
