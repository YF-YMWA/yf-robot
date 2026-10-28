/**
 * 配置 schema 的测试。
 *
 * 重点不是测某个字段的值，而是锁住「加字段只改一处」这个性质：
 *   · 声明过的每个字段都能补默认值
 *   · 声明过的每个字段都能写进去、读出来
 *   · 没声明的字段会被忽略并报告（而不是静默失败）
 *   · 越界数字被夹住、枚举非法值被挡回
 *   · 密钥永远不出现在对外配置里
 */
import { test } from 'node:test';
import assert from 'node:assert';
import {
  SECTION_SCHEMA,
  SECRET_FIELDS,
  defaults,
  fillDefaults,
  applyPatch,
  toPublic,
  paths,
} from '../core/config-schema.mjs';

// ===== 声明本身 =====

test('schema：每个段落都有 label 和 fields', () => {
  for (const [name, def] of Object.entries(SECTION_SCHEMA)) {
    assert.ok(def.fields && typeof def.fields === 'object', `${name} 缺 fields`);
  }
});

test('schema：每个字段都有类型和默认值', () => {
  for (const p of paths()) {
    const parts = p.split('.');
    let def = SECTION_SCHEMA[parts[0]];
    let field;
    if (parts.length === 2) field = def.fields[parts[1]];
    else field = def.nested[parts[1]].fields[parts[2]];
    assert.ok(field, `${p} 找不到声明`);
    assert.ok(
      ['string', 'number', 'boolean', 'array', 'object'].includes(field.type),
      `${p} 类型不合法: ${field.type}`,
    );
    assert.notStrictEqual(field.default, undefined, `${p} 缺默认值`);
  }
});

test('schema：字段类型和默认值类型一致', () => {
  const d = defaults();
  for (const p of paths()) {
    const parts = p.split('.');
    let v = d[parts[0]];
    for (const k of parts.slice(1)) v = v?.[k];

    const parts2 = p.split('.');
    let def = SECTION_SCHEMA[parts2[0]];
    const field =
      parts2.length === 2 ? def.fields[parts2[1]] : def.nested[parts2[1]].fields[parts2[2]];

    if (field.type === 'array') assert.ok(Array.isArray(v), `${p} 应该是数组`);
    else if (field.type === 'object') assert.ok(v && typeof v === 'object', `${p} 应该是对象`);
    else assert.equal(typeof v, field.type, `${p} 类型不符`);
  }
});

// ===== 默认值与补缺 =====

test('defaults：能生成完整配置', () => {
  const d = defaults();
  assert.ok(d.tools && d.reply && d.wechat);
  assert.equal(typeof d.reply.maxBubbles, 'number');
});

test('defaults：每次调用都是新对象（数组/对象不共享）', () => {
  const a = defaults();
  const b = defaults();
  a.tools.off.push('run_command');
  assert.equal(b.tools.off.length, 0, '默认值不能共享引用');
});

test('fillDefaults：空配置会被补全，并报告补了哪些', () => {
  const cfg = {};
  const added = fillDefaults(cfg);
  assert.ok(added.length >= paths().length - 10, `补的太少：${added.length}`);
  assert.equal(cfg.reply.maxBubbles, defaults().reply.maxBubbles);
});

test('fillDefaults：已有的值不动', () => {
  const cfg = { reply: { maxBubbles: 5 } };
  fillDefaults(cfg);
  assert.equal(cfg.reply.maxBubbles, 5);
});

test('fillDefaults：嵌套段也会补', () => {
  const cfg = { tools: { enabled: true } };
  fillDefaults(cfg);
  assert.equal(typeof cfg.tools.dsh.enabled, 'boolean');
  assert.ok(cfg.tools.dsh.timeoutMs > 0);
});

// ===== 写入 =====

test('applyPatch：声明过的字段能写进去', () => {
  const cfg = defaults();
  const r = applyPatch(cfg, { mood: { enabled: false }, wechat: { voiceChance: 0.42 } });
  assert.equal(cfg.mood.enabled, false);
  assert.equal(cfg.wechat.voiceChance, 0.42);
  assert.deepEqual(r.applied.sort(), ['mood.enabled', 'wechat.voiceChance']);
});

test('applyPatch：没声明的段落/字段会被忽略并报告', () => {
  const cfg = defaults();
  const r = applyPatch(cfg, { bogus: { x: 1 }, reply: { noSuchField: 3 } });
  assert.ok(r.ignored.some((x) => x.startsWith('bogus')));
  assert.ok(r.ignored.some((x) => x.includes('noSuchField')));
});

test('applyPatch：嵌套段能写', () => {
  const cfg = defaults();
  const r = applyPatch(cfg, { tools: { dsh: { enabled: true, cwd: '/tmp' } } });
  assert.equal(cfg.tools.dsh.enabled, true);
  assert.equal(cfg.tools.dsh.cwd, '/tmp');
  assert.ok(r.applied.includes('tools.dsh.enabled'));
});

test('applyPatch：越界数字被夹住', () => {
  const cfg = defaults();
  applyPatch(cfg, { reply: { maxBubbles: 999, jitter: -5 } });
  assert.equal(cfg.reply.maxBubbles, 6);
  assert.equal(cfg.reply.jitter, 0);
});

test('applyPatch：枚举外的值被挡回原值', () => {
  const cfg = defaults();
  const before = cfg.search.provider;
  applyPatch(cfg, { search: { provider: '不存在的供应商' } });
  assert.equal(cfg.search.provider, before);
});

test('applyPatch：类型不对时退回原值', () => {
  const cfg = defaults();
  const before = cfg.reply.maxBubbles;
  applyPatch(cfg, { reply: { maxBubbles: '不是数字' } });
  assert.equal(cfg.reply.maxBubbles, before);
});

test('applyPatch：空 patch 不改任何东西', () => {
  const cfg = defaults();
  const r = applyPatch(cfg, {});
  assert.equal(r.applied.length, 0);
  assert.deepEqual(cfg, defaults());
});

test('applyPatch：密钥字段不算「被忽略」（交给 admin 处理）', () => {
  const cfg = defaults();
  const r = applyPatch(cfg, { search: { apiKey: 'sk-xxx' } });
  assert.ok(!r.ignored.some((x) => x.includes('apiKey')));
});

// ===== 对外展示 =====

test('toPublic：包含所有声明过的段', () => {
  const p = toPublic(defaults());
  for (const section of Object.keys(SECTION_SCHEMA)) {
    assert.ok(p[section], `对外配置缺段落 ${section}`);
  }
});

test('toPublic：包含所有声明过的字段', () => {
  const p = toPublic(defaults());
  for (const path of paths()) {
    const [section, ...rest] = path.split('.');
    let v = p[section];
    for (const k of rest) v = v?.[k];
    assert.notStrictEqual(v, undefined, `对外配置缺字段 ${path}`);
  }
});

test('toPublic：密钥只给掩码和「有没有」', () => {
  const cfg = defaults();
  // llm 不在 SECTION_SCHEMA 里（字段由客户端自己管），手动补上
  cfg.llm = { apiKey: 'sk-real-key-0123456789abcdef0123456789' };
  cfg.vision.apiKey = '';

  const p = toPublic(cfg, { mask: (s) => (s ? s.slice(0, 4) + '****' : '') });

  assert.ok(!JSON.stringify(p).includes('sk-real-key'), '明文 Key 不能出现在对外配置里');
  assert.equal(p.llm.apiKeyMasked, 'sk-r****');
  assert.equal(p.llm.apiKeyPresent, true);
  assert.equal(p.vision.apiKeyPresent, false);
});

test('toPublic：每个密钥段落都声明了，不会漏', () => {
  const p = toPublic(defaults());
  for (const [section, keys] of Object.entries(SECRET_FIELDS)) {
    for (const k of keys) {
      assert.ok(
        k + 'Masked' in p[section],
        `${section}.${k} 没被脱敏输出`,
      );
    }
  }
});

// ===== 关键性质：加字段只改一处 =====

test('性质：给 schema 加一个字段，补默认/写入/展示三处自动生效', () => {
  // 用现有字段模拟：只要它在 schema 里，三个函数都要认识它
  const probe = 'tools.maxFileSize';

  const d = defaults();
  assert.notStrictEqual(d.tools.maxFileSize, undefined, '默认值');

  const cfg = {};
  const r = applyPatch(cfg, { tools: { maxFileSize: 123456 } });
  assert.equal(cfg.tools.maxFileSize, 123456, '写入');
  assert.ok(r.applied.includes(probe));

  const p = toPublic(cfg);
  assert.equal(p.tools.maxFileSize, 123456, '展示');

  const added = fillDefaults({});
  assert.ok(added.includes(probe), '补缺');
});
