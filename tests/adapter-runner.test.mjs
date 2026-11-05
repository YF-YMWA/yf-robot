import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

import { buildStartCommand } from '../core/adapter-runner.mjs';

const TMP = path.join(process.cwd(), '.tmp', 'adapter-runner-test');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
process.on('exit', () => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {}
});

function makeAdapter(id, manifest, entry, body = '') {
  const root = path.join(TMP, id + '-root');
  const dir = path.join(root, 'adapters', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'adapter.json'), JSON.stringify(manifest), 'utf8');
  fs.writeFileSync(path.join(dir, entry), body, 'utf8');
  return root;
}

test('Node 适配器用 node 启动，并把 stdout 收进 panel-run.log', () => {
  const root = makeAdapter(
    'node-demo',
    { name: 'Node Demo', entry: 'main.mjs', runtime: 'node', needsAdmin: false, log: 'data/adapter.log' },
    'main.mjs',
  );
  const c = buildStartCommand(root, 'node-demo');
  assert.ok(c);
  assert.equal(c.runtime, 'node');
  assert.equal(c.entry, 'main.mjs');
  assert.ok(c.bat.includes('main.mjs'));
  assert.ok(c.bat.includes('node.exe') || c.bat.includes('node'));
  assert.ok(c.bat.includes('panel-run.log'));
  assert.ok(c.logPath.endsWith(path.join('data', 'adapter.log')));
  assert.ok(c.capturePath.endsWith('panel-run.log'));
});

test('Python 适配器仍走 python，不强制重定向窗口输出', () => {
  const root = makeAdapter(
    'py-demo',
    { name: 'Py Demo', entry: 'bot.py', runtime: 'python', needsAdmin: false },
    'bot.py',
  );
  const c = buildStartCommand(root, 'py-demo');
  assert.ok(c);
  assert.equal(c.runtime, 'python');
  assert.ok(c.bat.includes('python.exe') || c.bat.includes('python'));
  assert.ok(c.bat.includes('bot.py'));
});

test('没有适配器时 buildStartCommand 返回 null', () => {
  assert.equal(buildStartCommand(path.join(TMP, 'empty-root'), 'nope'), null);
});
