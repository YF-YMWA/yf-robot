/**
 * 多适配器注册表的测试。
 *
 * 重点验证「一个文件夹一个适配器」这个约定：
 *   · adapters/<名字>/ + adapter.json 能被发现
 *   · 没有清单时按入口文件名猜
 *   · needsAdmin 默认 true（微信这种要提权）
 *   · 同一个目录不会被重复列出
 */
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { listAdapters, getAdapter } from '../core/adapter-registry.mjs';

const TMP = path.join(process.cwd(), '.tmp', 'adapter-registry-test');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
process.on('exit', () => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {}
});

function makeRoot(name) {
  const root = path.join(TMP, name);
  fs.mkdirSync(path.join(root, 'adapters'), { recursive: true });
  return root;
}

function makeAdapter(root, id, files) {
  const dir = path.join(root, 'adapters', id);
  fs.mkdirSync(dir, { recursive: true });
  for (const [f, content] of Object.entries(files)) {
    const full = path.join(dir, f);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  }
  return dir;
}

test('发现：带 adapter.json 的适配器', () => {
  const root = makeRoot('with-manifest');
  makeAdapter(root, 'qq', {
    'adapter.json': JSON.stringify({
      name: 'QQ',
      entry: 'bot.py',
      needsAdmin: false,
      description: '通过 OneBot 接入',
    }),
    'bot.py': 'print(1)',
  });

  const list = listAdapters(root);
  assert.equal(list.length, 1);
  assert.equal(list[0].id, 'qq');
  assert.equal(list[0].name, 'QQ');
  assert.equal(list[0].entry, 'bot.py');
  assert.equal(list[0].needsAdmin, false);
  assert.match(list[0].description, /OneBot/);
});

test('发现：没有清单时按入口文件名猜', () => {
  const root = makeRoot('no-manifest');
  makeAdapter(root, 'skeleton', { 'main.py': 'print(1)' });

  const list = listAdapters(root);
  assert.equal(list.length, 1);
  assert.equal(list[0].entry, 'main.py');
  // 没声明 needsAdmin 时，保守默认需要（宁可多弹一次 UAC）
  assert.equal(list[0].needsAdmin, true);
});

test('发现：没有入口脚本的目录不算适配器', () => {
  const root = makeRoot('no-entry');
  makeAdapter(root, 'empty', { 'readme.txt': 'hello' });
  assert.equal(listAdapters(root).length, 0);
});

test('发现：多个适配器都能列出来', () => {
  const root = makeRoot('multi');
  makeAdapter(root, 'qq', { 'adapter.json': '{"entry":"a.py"}', 'a.py': '' });
  makeAdapter(root, 'tg', { 'adapter.json': '{"entry":"b.py"}', 'b.py': '' });

  const list = listAdapters(root);
  assert.equal(list.length, 2);
  assert.deepEqual(list.map((x) => x.id).sort(), ['qq', 'tg']);
});

test('发现：损坏的 adapter.json 不会让整个列表挂掉', () => {
  const root = makeRoot('broken-manifest');
  makeAdapter(root, 'broken', { 'adapter.json': '{不是 json', 'bridge.py': '' });

  const list = listAdapters(root);
  assert.equal(list.length, 1);
  assert.equal(list[0].entry, 'bridge.py', '清单坏了应该退回猜入口');
});

test('发现：git 副本会被标记', () => {
  const root = makeRoot('git');
  const dir = makeAdapter(root, 'g', { 'adapter.json': '{"entry":"a.py"}', 'a.py': '' });
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });

  assert.equal(listAdapters(root)[0].hasGit, true);
});

test('选择：按 id 取，取不到返回 null', () => {
  const root = makeRoot('pick');
  makeAdapter(root, 'qq', { 'adapter.json': '{"entry":"a.py"}', 'a.py': '' });

  assert.equal(getAdapter(root, 'qq').id, 'qq');
  assert.equal(getAdapter(root, 'nope'), null);
});

test('选择：不传 id 时返回第一个（兼容旧的单适配器调用）', () => {
  const root = makeRoot('default');
  makeAdapter(root, 'only', { 'adapter.json': '{"entry":"a.py"}', 'a.py': '' });

  const a = getAdapter(root);
  assert.ok(a);
  assert.equal(a.id, 'only');
});

test('发现：空项目返回空数组，不报错', () => {
  const root = makeRoot('empty');
  assert.deepEqual(listAdapters(root), []);
});

test('发现：bundled 的 adapter/ 目录也能识别', () => {
  const root = path.join(TMP, 'bundled');
  fs.mkdirSync(path.join(root, 'adapter'), { recursive: true });
  fs.writeFileSync(path.join(root, 'adapter', 'wechatauto_bridge.py'), '', 'utf8');

  const list = listAdapters(root);
  assert.equal(list.length, 1);
  assert.equal(list[0].mode, 'bundled');
});
