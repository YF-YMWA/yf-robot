/**
 * writeConfig 的 Key 守卫测试。
 *
 * 这些用例对应真实踩过的坑：
 *   · Key 被「空值覆盖」而丢失
 *   · config.json 读到一半损坏 → 守卫被跳过 → Key 全丢
 *   · 非原子写留下半个 JSON
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { writeConfig } from '../core/admin.mjs';

/** 建一个临时目录，返回里面的 config.json 路径。 */
function tmpConfig(initial) {
  // 用工作区内的 .tmp：本机沙箱不允许 node 写系统临时目录（mkdtemp EPERM）
  const base = path.join(process.cwd(), '.tmp');
  fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, 'cfg-test-'));
  const file = path.join(dir, 'config.json');
  if (initial !== undefined) {
    fs.writeFileSync(file, JSON.stringify(initial, null, 2), 'utf8');
  }
  return { dir, file };
}

const KEYS = {
  llm: { apiKey: 'sk-llm-abcdefghijklmnopqrstuvwxyz' },
  voice: { apiKey: 'sk-voice-0123456789abcdef0123456789abcdef' },
  vision: { apiKey: '' },
  search: { apiKey: '' },
  imagegen: { apiKey: '' },
};

const quiet = { info() {}, warn() {}, error() {} };

test('守卫：新对象里缺 Key 时自动补回磁盘的值', () => {
  const { file } = tmpConfig({ ...KEYS, llm: { ...KEYS.llm }, voice: { ...KEYS.voice } });

  // 模拟某个调用方构造了「少了 voice」的配置
  const cfg = { llm: { apiKey: KEYS.llm.apiKey } };
  const r = writeConfig(file, cfg, 'test', quiet);

  assert.ok(r.restored.includes('voice'), '应该恢复 voice');
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(after.voice.apiKey, KEYS.voice.apiKey);
  assert.equal(after.llm.apiKey, KEYS.llm.apiKey);
});

test('守卫：空字符串不会覆盖已有 Key', () => {
  const { file } = tmpConfig({ llm: { apiKey: KEYS.llm.apiKey } });

  const cfg = { llm: { apiKey: '' } };
  writeConfig(file, cfg, 'test', quiet);

  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(after.llm.apiKey, KEYS.llm.apiKey, '空值不该覆盖真实 Key');
});

test('守卫：显式 __clearKeys 才允许清空', () => {
  const { file } = tmpConfig({ voice: { apiKey: KEYS.voice.apiKey } });

  const cfg = { voice: { apiKey: '' }, __clearKeys: ['voice'] };
  writeConfig(file, cfg, 'test', quiet);

  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(after.voice.apiKey, '', '显式声明后应该真的清掉');
  // 守卫字段不能落到文件里
  assert.equal(after.__clearKeys, undefined);
  assert.equal(after.__guardKeys, undefined);
});

test('文件损坏时拒绝写入，不拿空配置覆盖', () => {
  const { dir, file } = tmpConfig();
  // 造一个损坏的 config.json，同时留一份好的 .bak
  fs.writeFileSync(file, '{ "llm": { "apiKey": "sk-real-key-here-1234"', 'utf8');
  fs.writeFileSync(
    `${file}.bak`,
    JSON.stringify({ llm: { apiKey: 'sk-from-backup-1234567890' } }),
    'utf8',
  );

  const cfg = { llm: { apiKey: '' }, voice: { apiKey: '' } };

  // 有 .bak 可读 → 用备份当 before，守卫生效，正常写入
  writeConfig(file, cfg, 'test', quiet);

  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(after.llm.apiKey, 'sk-from-backup-1234567890', '应该从 .bak 恢复');
  assert.ok(fs.existsSync(file));
  void dir;
});

test('文件损坏且没有备份时，抛错而不是清空 Key', () => {
  const { file } = tmpConfig();
  fs.writeFileSync(file, 'NOT JSON AT ALL', 'utf8');

  const cfg = { llm: { apiKey: '' }, voice: { apiKey: '' } };

  assert.throws(
    () => writeConfig(file, cfg, 'test', quiet),
    /读不出来|放弃本次保存/,
    '读不到旧配置就该拒绝写，而不是把 Key 抹掉',
  );

  // 原文件必须原样还在，没被覆盖
  assert.equal(fs.readFileSync(file, 'utf8'), 'NOT JSON AT ALL');
});

test('首次运行（文件不存在）能正常写', () => {
  const { file } = tmpConfig(); // 不创建文件

  const cfg = { llm: { apiKey: 'sk-first-run-1234567890' } };
  writeConfig(file, cfg, 'test', quiet);

  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(after.llm.apiKey, 'sk-first-run-1234567890');
});

test('原子写：写完不留临时文件', () => {
  const { dir, file } = tmpConfig({ llm: { apiKey: KEYS.llm.apiKey } });

  writeConfig(file, { llm: { apiKey: KEYS.llm.apiKey } }, 'test', quiet);

  const leftovers = fs.readdirSync(dir).filter((n) => n.includes('.tmp-'));
  assert.deepEqual(leftovers, [], '不该留下临时文件');

  // 内容必须是完整 JSON
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(after.llm.apiKey, KEYS.llm.apiKey);
});

test('写盘前会留 .bak', () => {
  const { file } = tmpConfig({ llm: { apiKey: KEYS.llm.apiKey } });

  writeConfig(file, { llm: { apiKey: 'sk-new-key-000000000000' } }, 'test', quiet);

  assert.ok(fs.existsSync(`${file}.bak`), '应该生成 .bak');
  const bak = JSON.parse(fs.readFileSync(`${file}.bak`, 'utf8'));
  assert.equal(bak.llm.apiKey, KEYS.llm.apiKey, '.bak 存的是写之前的内容');
});

test('Key 变更会记进 key-audit.log', () => {
  const { dir, file } = tmpConfig({ llm: { apiKey: KEYS.llm.apiKey } });

  writeConfig(file, { llm: { apiKey: 'sk-brand-new-111111111111' } }, 'test-tag', quiet);

  const audit = path.join(dir, 'data', 'key-audit.log');
  assert.ok(fs.existsSync(audit), '应该生成审计日志');
  const text = fs.readFileSync(audit, 'utf8');
  assert.ok(text.includes('test-tag'), '审计里要有调用方标记');
  assert.ok(/llm:\d+→\d+/.test(text), '审计里要写明长度变化');
});
