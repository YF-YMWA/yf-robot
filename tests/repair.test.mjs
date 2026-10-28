/**
 * 一键修复的测试。
 *
 * 重点场景：Key 丢了能不能从备份恢复、配置缺段落能不能补、
 * 目录没了能不能建、跑第二遍是不是「无事可做」。
 */
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { runRepair } from '../core/repair.mjs';

const TMP = path.join(process.cwd(), '.tmp', 'repair-test');

function freshRoot(name = 'r') {
  const root = path.join(TMP, name);
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(path.join(root, 'data', 'key-archive'), { recursive: true });
  return root;
}

const noWrite = () => {};

test('Key 丢失：能从归档恢复', async () => {
  const root = freshRoot('restore');
  fs.writeFileSync(
    path.join(root, 'data', 'key-archive', '2026-01-01T00-00-00Z.json'),
    JSON.stringify({ keys: { voice: 'sk-test-voice-0123456789abcdef012345678' } }),
    'utf8',
  );

  const config = { voice: { apiKey: '' }, llm: { apiKey: 'sk-test-llm-1234567890abcdef' } };
  const r = await runRepair({ root, config, writeConfig: noWrite });

  assert.equal(config.voice.apiKey, 'sk-test-voice-0123456789abcdef012345678');
  assert.ok(r.fixed.some((x) => x.includes('voice') && x.includes('恢复')));
});

test('Key 丢失且归档也没有：报问题，不瞎填', async () => {
  const root = freshRoot('norestore');
  const config = { search: { apiKey: '' } };
  const r = await runRepair({ root, config, writeConfig: noWrite });

  assert.equal(config.search.apiKey, '');
  assert.ok(r.problems.some((x) => x.includes('search')));
});

test('Key 正常时不动它', async () => {
  const root = freshRoot('keep');
  const good = 'sk-test-0123456789abcdef0123456789';
  const config = { llm: { apiKey: good } };
  await runRepair({ root, config, writeConfig: noWrite });
  assert.equal(config.llm.apiKey, good);
});

test('缩短的 Key 会被当作无效并尝试恢复', async () => {
  const root = freshRoot('short');
  fs.writeFileSync(
    path.join(root, 'data', 'key-archive', 'x.json'),
    JSON.stringify({ keys: { llm: 'sk-test-full-key-0123456789abcdef01' } }),
    'utf8',
  );
  const config = { llm: { apiKey: 'abc' } };
  await runRepair({ root, config, writeConfig: noWrite });
  assert.equal(config.llm.apiKey, 'sk-test-full-key-0123456789abcdef01');
});

test('配置缺段落：补默认值', async () => {
  const root = freshRoot('sections');
  const config = { llm: { apiKey: 'sk-test-0123456789abcdef0123456789' } };
  const r = await runRepair({ root, config, writeConfig: noWrite });

  assert.ok(config.reply, 'reply 段应该被补上');
  assert.ok(config.tools, 'tools 段应该被补上');
  assert.ok(config.mood, 'mood 段应该被补上');
  assert.ok(r.fixed.some((x) => x.includes('reply') || x.includes('tools')));
});

test('ttsApiKey 无效时清空（退回共用转写那把）', async () => {
  const root = freshRoot('tts');
  const config = { voice: { apiKey: 'sk-test-0123456789abcdef0123456789', ttsApiKey: '短' } };
  const r = await runRepair({ root, config, writeConfig: noWrite });
  assert.equal(config.voice.ttsApiKey, '');
  assert.ok(r.fixed.some((x) => x.includes('语音合成')));
});

test('目录缺失：自动补建', async () => {
  const root = freshRoot('dirs');
  const config = { card: 'dafeiyu' };
  await runRepair({ root, config, writeConfig: noWrite });

  for (const d of ['data/tmp', 'data/stickers', 'data/memory', 'data/dafeiyu']) {
    assert.ok(fs.existsSync(path.join(root, d)), `${d} 应该被建出来`);
  }
});

test('令牌文件缺失：自动生成', async () => {
  const root = freshRoot('token');
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  config0();
  const config = {};
  await runRepair({ root, config, writeConfig: noWrite });

  const f = path.join(root, 'data', 'token.txt');
  assert.ok(fs.existsSync(f), 'token.txt 应该被生成');
  assert.ok(fs.readFileSync(f, 'utf8').trim().length >= 16);
});

test('幂等：第二次跑基本无事可做', async () => {
  const root = freshRoot('idem');
  fs.writeFileSync(
    path.join(root, 'data', 'key-archive', 'a.json'),
    JSON.stringify({
      keys: {
        llm: 'sk-test-0123456789abcdef0123456789',
        vision: '0123456789abcdef0123456789abcdef01234567',
        voice: 'sk-test-voice-0123456789abcdef012345678',
        search: 'sk-test-search-0123456789abcdef0123',
        imagegen: '0123.0123456789abcdef0123456789abcdef',
      },
    }),
    'utf8',
  );

  const config = {};
  const r1 = await runRepair({ root, config, writeConfig: noWrite });
  assert.ok(r1.fixed.length > 0, '第一次应该修了不少');

  const r2 = await runRepair({ root, config, writeConfig: noWrite });
  // 第二遍只可能剩下 ffmpeg 一条（取决于本机）
  const stillFixing = r2.fixed.filter((x) => !x.includes('ffmpeg'));
  assert.equal(stillFixing.length, 0, `第二遍不该再修东西：${JSON.stringify(stillFixing)}`);
});

test('坏掉的归档文件不会让修复崩掉', async () => {
  const root = freshRoot('broken');
  fs.writeFileSync(path.join(root, 'data', 'key-archive', 'bad.json'), '{不是 json', 'utf8');
  const config = { llm: { apiKey: '' } };
  const r = await runRepair({ root, config, writeConfig: noWrite });
  assert.ok(r.problems.length > 0, '应该报「没配 Key」而不是抛异常');
});

function config0() {}
