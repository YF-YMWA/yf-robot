/**
 * 工具白名单 + 语音包的测试。
 */
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { ToolKit } from '../core/tools.mjs';
import { normalizePack, importPack, removePack, readPacks, allVoices, resolveVoice } from '../core/voice-packs.mjs';
import { VOICES, DEFAULT_VOICE } from '../core/tts.mjs';

const TMP = path.join(process.cwd(), '.tmp', 'tools-voice-test');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
process.on('exit', () => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {}
});

const kit = (cfg = {}) =>
  new ToolKit({
    sandbox: TMP,
    logger: { info() {}, warn() {}, error() {} },
    config: cfg,
  });

// ===== 工具白名单 =====

test('默认全开：定义里有 run_command', () => {
  const names = kit().definitions().map((d) => d.function.name);
  assert.ok(names.includes('run_command'));
});

test('关掉之后不再发给模型', () => {
  const names = kit({ tools: { off: ['run_command'] } }).definitions().map((d) => d.function.name);
  assert.ok(!names.includes('run_command'));
});

test('关掉的工具硬调也被拒绝', async () => {
  const k = kit({ tools: { off: ['run_command'] } });
  const r = await k.run('run_command', { command: 'node' });
  assert.match(r, /被主人关掉/);
});

test('allDefinitions 包含被关掉的（否则没法再打开）', () => {
  const k = kit({ tools: { off: ['run_command'] } });
  const all = k.allDefinitions().map((d) => d.function.name);
  const shown = k.definitions().map((d) => d.function.name);
  assert.ok(all.includes('run_command'));
  assert.ok(!shown.includes('run_command'));
  assert.equal(all.length, shown.length + 1);
});

test('allDefinitions 不会污染配置', () => {
  const cfg = { tools: { off: ['run_command'] } };
  const k = kit(cfg);
  k.allDefinitions();
  assert.deepEqual(cfg.tools.off, ['run_command'], '调用后配置应恢复原样');
});

test('关多个工具', () => {
  const k = kit({ tools: { off: ['run_command', 'write_file', 'search_web'] } });
  const names = k.definitions().map((d) => d.function.name);
  for (const n of ['run_command', 'write_file', 'search_web']) {
    assert.ok(!names.includes(n), `${n} 应该被关掉`);
  }
  assert.ok(names.includes('read_file'), '没关的还在');
});

test('配置里 off 不是数组时当作全开', () => {
  const k = kit({ tools: { off: 'oops' } });
  assert.ok(k.definitions().some((d) => d.function.name === 'run_command'));
});

// ===== 语音包 =====

test('语音包：正常内容通过', () => {
  const r = normalizePack({
    name: '我的音色',
    voices: [{ id: 'cosyvoice-v2-abc', label: '我自己', note: '复刻' }],
  });
  assert.equal(r.ok, true);
  assert.equal(r.pack.voices.length, 1);
  assert.equal(r.pack.voices[0].from, '我的音色');
});

test('语音包：路径穿越的 id 被拒', () => {
  const r = normalizePack({ name: 'x', voices: [{ id: '../../etc/passwd' }] });
  assert.equal(r.ok, false);
  assert.match(r.error, /不合法/);
});

test('语音包：空 voices 被拒', () => {
  assert.equal(normalizePack({ name: 'x', voices: [] }).ok, false);
});

test('语音包：不是对象被拒', () => {
  assert.equal(normalizePack('hello').ok, false);
  assert.equal(normalizePack(null).ok, false);
});

test('语音包：超过 50 个被拒', () => {
  const many = { name: 'x', voices: Array.from({ length: 51 }, (_, i) => ({ id: 'v' + i })) };
  assert.equal(normalizePack(many).ok, false);
});

test('音色 id 长度超限被拒', () => {
  const r = normalizePack({ name: 'x', voices: [{ id: 'a'.repeat(100) }] });
  assert.equal(r.ok, false);
});

test('导入、列出、删除', () => {
  const root = path.join(TMP, 'vp');
  fs.mkdirSync(root, { recursive: true });

  const r1 = importPack(root, { name: 'A', voices: [{ id: 'va1', label: 'A1' }] });
  assert.equal(r1.ok, true);
  assert.equal(readPacks(root).length, 1);

  // 同名覆盖
  importPack(root, { name: 'A', voices: [{ id: 'va2', label: 'A2' }] });
  const packs = readPacks(root);
  assert.equal(packs.length, 1);
  assert.equal(packs[0].voices[0].id, 'va2');

  const r2 = removePack(root, 'A');
  assert.equal(r2.ok, true);
  assert.equal(readPacks(root).length, 0);
});

test('可选音色：内置 + 导入，且不重复', () => {
  const root = path.join(TMP, 'vp2');
  fs.mkdirSync(root, { recursive: true });
  importPack(root, { name: 'B', voices: [{ id: 'vb1', label: 'B1' }] });

  const list = allVoices(root);
  assert.equal(list.length, VOICES.length + 1);
  assert.ok(list.some((v) => v.id === 'vb1'));
  assert.ok(list.some((v) => v.from === '内置'));
});

test('可选音色：和内置同 id 的被跳过', () => {
  const root = path.join(TMP, 'vp3');
  fs.mkdirSync(root, { recursive: true });
  importPack(root, { name: 'C', voices: [{ id: VOICES[0].id, label: '重复' }] });
  const list = allVoices(root);
  assert.equal(list.filter((v) => v.id === VOICES[0].id).length, 1);
});

test('解析音色：存在就用，不存在退回默认', () => {
  const root = path.join(TMP, 'vp4');
  fs.mkdirSync(root, { recursive: true });
  importPack(root, { name: 'D', voices: [{ id: 'vd1', label: 'D1' }] });

  assert.equal(resolveVoice(root, 'vd1').id, 'vd1');
  assert.equal(resolveVoice(root, '').id, DEFAULT_VOICE);

  const fb = resolveVoice(root, '不存在');
  assert.equal(fb.id, DEFAULT_VOICE);
  assert.equal(fb.fallback, true);
});

test('语音包文件损坏时不崩', () => {
  const root = path.join(TMP, 'vp5');
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data', 'voice-packs.json'), '{坏掉的 json', 'utf8');
  assert.deepEqual(readPacks(root), []);
  assert.ok(allVoices(root).length >= VOICES.length);
});
