import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ToolKit } from '../core/tools.mjs';

function makeKit(permission = 'workspace') {
  const base = path.join(process.cwd(), '.tmp', 'sandbox-tests');
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'case-'));
  const sandbox = path.join(root, 'agent-workspace');
  fs.mkdirSync(sandbox, { recursive: true });
  const kit = new ToolKit({
    sandbox,
    maxFileSize: 1024 * 1024,
    logger: { info() {}, warn() {} },
    config: { root, tools: { permission, approval: true } },
    sandboxTask: false,
  });
  return { root, sandbox, kit };
}

test('resolveSafe 拒绝路径穿越、绝对路径、ADS 和保留名', () => {
  const { kit } = makeKit();
  for (const bad of [
    '../outside.txt',
    'a/../../outside.txt',
    'C:\\Windows\\win.ini',
    '/etc/passwd',
    'file.txt:stream',
    'CON',
    'a/COM1.txt',
    'trail.',
    'trail ',
  ]) {
    assert.throws(() => kit.resolveSafe(bad), /越界|冒号|保留|文件名|相对路径/, bad);
  }
});

test('resolveSafe 不跟随 junction 走出沙箱', () => {
  const { root, sandbox, kit } = makeKit();
  const outside = path.join(root, 'outside');
  fs.mkdirSync(outside, { recursive: true });
  const link = path.join(sandbox, 'escape');
  let made = false;
  try {
    fs.symlinkSync(outside, link, 'junction');
    made = true;
  } catch {
    // 某些 Windows 环境禁止创建 junction；这个用例跳过
  }
  if (!made) return;
  assert.throws(() => kit.resolveSafe('escape/evil.txt'), /链接|越界/);
  try {
    fs.rmdirSync(link);
  } catch {}
});

test('resolveSafe 不操作硬链接文件', () => {
  const { root, sandbox, kit } = makeKit();
  const outside = path.join(root, 'outside.txt');
  fs.writeFileSync(outside, 'outside');
  const link = path.join(sandbox, 'hard.txt');
  let made = false;
  try {
    fs.linkSync(outside, link);
    made = true;
  } catch {}
  if (!made) return;
  assert.throws(() => kit.resolveSafe('hard.txt'), /硬链接/);
  fs.unlinkSync(link);
});

test('普通文件读写仍在沙箱内', () => {
  const { kit } = makeKit();
  const out = kit.writeFile('a/b.txt', 'hello');
  assert.match(out, /已写入/);
  assert.equal(kit.readFile('a/b.txt'), 'hello');
});

test('writeFile 覆盖前留快照', () => {
  const { root, kit } = makeKit();
  kit.writeFile('snap.txt', 'one');
  kit.writeFile('snap.txt', 'two');
  const trash = path.join(root, 'data', 'sandbox-trash');
  const dirs = fs.readdirSync(trash, { withFileTypes: true }).filter((e) => e.isDirectory());
  assert.ok(dirs.length >= 1);
  const overwrite = dirs
    .map((e) => ({ id: e.name, m: JSON.parse(fs.readFileSync(path.join(trash, e.name, 'manifest.json'), 'utf8')) }))
    .find((x) => x.m.action === 'overwrite');
  assert.ok(overwrite);
  assert.equal(overwrite.m.path, 'snap.txt');
  assert.equal(fs.readFileSync(path.join(trash, overwrite.id, 'file'), 'utf8'), 'one');
});

test('工作区配额会拒绝超限写入', () => {
  const { root, sandbox } = makeKit();
  const kit = new ToolKit({
    sandbox,
    maxFileSize: 1024 * 1024,
    maxWorkspaceSize: 100,
    logger: { info() {}, warn() {} },
    config: { root, tools: { permission: 'workspace', approval: true } },
  });
  assert.match(kit.writeFile('a.txt', 'x'.repeat(60)), /已写入/);
  assert.match(kit.writeFile('b.txt', 'x'.repeat(60)), /工作区已满/);
});

test('run_command 不再直通 Python/Node', async () => {
  const { kit } = makeKit('full');
  await assert.rejects(() => kit.runCommand('python', ['-c', 'print(1)']), /白名单/);
  await assert.rejects(() => kit.runCommand('node', ['-e', '1']), /白名单/);
  await assert.rejects(() => kit.runCommand('type', ['C:\\Windows\\win.ini']), /绝对路径/);
});

test('run_code 需要 full 权限，且没有审批通道时拒绝', async () => {
  const { kit } = makeKit('workspace');
  const r1 = await kit.run('run_code', { language: 'node', code: 'console.log(1)' }, {
    askApproval: async () => ({ approved: true }),
  });
  assert.match(r1, /完全|权限/);

  const { kit: kit2 } = makeKit('full');
  const r2 = await kit2.run('run_code', { language: 'node', code: 'console.log(1)' }, {});
  assert.match(r2, /审批/);
});

test('run_code 在 full + 审批后可以执行', async () => {
  const { kit } = makeKit('full');
  let asked = false;
  const out = await kit.run(
    'run_code',
    { language: 'node', code: 'console.log("sandbox-ok")' },
    {
      askApproval: async () => {
        asked = true;
        return { approved: true };
      },
    },
  );
  assert.equal(asked, true);
  assert.match(out, /sandbox-ok/);
});
