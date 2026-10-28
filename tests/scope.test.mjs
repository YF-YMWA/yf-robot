/**
 * 按角色卡隔离的测试：路径、迁移、互不串味。
 */
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import {
  scopeName,
  scopeDir,
  kbDir,
  logicFile,
  memoryDir,
  migrateLegacyToScope,
} from '../core/scoped-paths.mjs';
import { KnowledgeBase } from '../core/kb.mjs';
import { LogicLibrary } from '../core/logic.mjs';
import { MemoryStore } from '../core/memory.mjs';

const TMP = path.join(process.cwd(), '.tmp', 'scope-test');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
process.on('exit', () => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {}
});

test('作用域名：清洗危险字符', () => {
  assert.equal(scopeName('dafeiyu'), 'dafeiyu');
  assert.equal(scopeName('a/b\\c'), 'a_b_c');
  assert.equal(scopeName(''), 'default');
  assert.equal(scopeName('../../etc'), '.._.._etc');
});

test('路径：每张卡一个目录', () => {
  const root = TMP;
  assert.equal(kbDir(root, 'a'), path.join(root, 'data', 'a', 'kb'));
  assert.equal(logicFile(root, 'a'), path.join(root, 'data', 'a', 'logic.json'));
  assert.equal(memoryDir(root, 'a'), path.join(root, 'data', 'a', 'memory'));
  assert.notEqual(kbDir(root, 'a'), kbDir(root, 'b'));
});

test('知识库：两张卡的文档互不可见', async () => {
  const root = path.join(TMP, 'kbcase');
  fs.mkdirSync(root, { recursive: true });

  const a = new KnowledgeBase({ root, config: {}, log: () => {}, card: 'cardA' });
  const b = new KnowledgeBase({ root, config: {}, log: () => {}, card: 'cardB' });

  // 直接塞文档（跳过嵌入，避免联网）
  fs.mkdirSync(a.dir, { recursive: true });
  fs.writeFileSync(
    path.join(a.dir, 'd1.json'),
    JSON.stringify({ id: 'd1', name: 'A 的文档', chunks: [{ text: '只属于 A 的内容' }] }),
    'utf8',
  );
  a.load();

  b.load();
  assert.equal(b.docs.size, 0, 'B 不该看到 A 的文档');

  const a2 = new KnowledgeBase({ root, config: {}, log: () => {}, card: 'cardA' });
  a2.load();
  assert.equal(a2.docs.size, 1, 'A 重新加载应该还在');
});

test('逻辑库：两张卡的经验互不可见', () => {
  const root = path.join(TMP, 'logiccase');
  fs.mkdirSync(root, { recursive: true });

  const a = new LogicLibrary({ root, config: {}, log: () => {}, card: 'cardA' });
  const r = a.add({ title: 'A 的经验', rule: '这是只属于 A 卡的一条经验，内容足够长' });
  assert.equal(r.ok, true);

  const b = new LogicLibrary({ root, config: {}, log: () => {}, card: 'cardB' });
  assert.equal(b.list().length, 0, 'B 不该看到 A 的经验');

  const a2 = new LogicLibrary({ root, config: {}, log: () => {}, card: 'cardA' });
  assert.equal(a2.list().length, 1);
});

test('记忆：两张卡同一个会话也不串', () => {
  const root = path.join(TMP, 'memcase');
  fs.mkdirSync(root, { recursive: true });

  const a = new MemoryStore({ dir: memoryDir(root, 'cardA') });
  a.setFact('wxid_same', '名字', '小明');

  const b = new MemoryStore({ dir: memoryDir(root, 'cardB') });
  const got = b.load('wxid_same');
  assert.equal(Object.keys(got.facts || {}).length, 0, 'B 卡不该记得 A 卡记的事');

  const a2 = new MemoryStore({ dir: memoryDir(root, 'cardA') });
  assert.deepEqual(a2.load('wxid_same').facts, { 名字: '小明' });
});

test('迁移：老数据搬进当前卡，只搬一次', () => {
  const root = path.join(TMP, 'migrate');
  fs.mkdirSync(path.join(root, 'data', 'kb'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data', 'kb', 'old.json'), '{"id":"old"}', 'utf8');
  fs.writeFileSync(path.join(root, 'data', 'logic.json'), '{"rules":[]}', 'utf8');

  const r1 = migrateLegacyToScope(root, 'mycard');
  assert.ok(r1.moved.includes('kb'), `应该搬了 kb：${JSON.stringify(r1)}`);
  assert.ok(fs.existsSync(path.join(root, 'data', 'mycard', 'kb', 'old.json')));
  assert.ok(!fs.existsSync(path.join(root, 'data', 'kb')), '老目录应该没了');

  // 第二次跑：老位置已经没有了，不该再搬
  const r2 = migrateLegacyToScope(root, 'mycard');
  assert.equal(r2.moved.length, 0);
});

test('迁移：目标已有数据时不覆盖', () => {
  const root = path.join(TMP, 'migrate2');
  fs.mkdirSync(path.join(root, 'data', 'kb'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data', 'kb', 'old.json'), 'old', 'utf8');
  fs.mkdirSync(path.join(root, 'data', 'c1', 'kb'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data', 'c1', 'kb', 'new.json'), 'new', 'utf8');

  const r = migrateLegacyToScope(root, 'c1');
  assert.ok(r.skipped.some((s) => s.startsWith('kb')), '应该跳过 kb');
  assert.ok(fs.existsSync(path.join(root, 'data', 'c1', 'kb', 'new.json')), '新数据不能被覆盖');
  assert.ok(fs.existsSync(path.join(root, 'data', 'kb', 'old.json')), '老数据留着让人自己处理');
});

test('迁移：没有老数据时什么都不做', () => {
  const root = path.join(TMP, 'empty');
  fs.mkdirSync(root, { recursive: true });
  const r = migrateLegacyToScope(root, 'x');
  assert.equal(r.moved.length, 0);
  assert.equal(r.skipped.length, 0);
});
