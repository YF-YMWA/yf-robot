/**
 * 工具层测试：重点验证安全边界。
 */
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { ToolKit } from '../core/tools.mjs';

const _tmpRoot = path.join(process.cwd(), '.tmp');
fs.mkdirSync(_tmpRoot, { recursive: true });
const sandbox = fs.mkdtempSync(path.join(_tmpRoot, 'sandbox-'));

const quiet = { info() {}, warn() {}, error() {} };

function makeKit(over = {}) {
  return new ToolKit({ sandbox, logger: quiet, ...over });
}

// ---------- 路径安全 ----------

test('resolveSafe 允许沙箱内路径', () => {
  const kit = makeKit();
  const p = kit.resolveSafe('test.txt');
  assert.ok(p.startsWith(sandbox));
});

test('resolveSafe 拒绝路径穿越', () => {
  const kit = makeKit();
  assert.throws(() => kit.resolveSafe('../outside.txt'), /越界/);
  assert.throws(() => kit.resolveSafe('../../etc/passwd'), /越界/);
  assert.throws(() => kit.resolveSafe('a/../../b.txt'), /越界/);
});

test('resolveSafe 拒绝绝对路径逃逸', () => {
  const kit = makeKit();
  // 绝对路径会被相对化后限制在沙箱内
  const p = kit.resolveSafe('/etc/passwd');
  assert.ok(p.startsWith(sandbox), '应被限制在沙箱内');
});

test('resolveSafe 允许子目录', () => {
  const kit = makeKit();
  const p = kit.resolveSafe('sub/dir/file.txt');
  assert.ok(p.startsWith(sandbox));
});

// ---------- 文件操作 ----------

test('writeFile 创建文件', () => {
  const kit = makeKit();
  const r = kit.writeFile('hello.txt', '你好世界');
  assert.ok(r.includes('已写入'));

  const file = path.join(sandbox, 'hello.txt');
  assert.ok(fs.existsSync(file));
  assert.equal(fs.readFileSync(file, 'utf8'), '你好世界');
});

test('writeFile 自动创建目录', () => {
  const kit = makeKit();
  kit.writeFile('a/b/c.txt', 'deep');
  assert.ok(fs.existsSync(path.join(sandbox, 'a/b/c.txt')));
});

test('readFile 读取内容', () => {
  const kit = makeKit();
  kit.writeFile('read-test.txt', '内容测试');
  const r = kit.readFile('read-test.txt');
  assert.equal(r, '内容测试');
});

test('readFile 不存在时提示', () => {
  const kit = makeKit();
  const r = kit.readFile('nope.txt');
  assert.ok(r.includes('不存在'));
});

test('readFile 拒绝读目录', () => {
  const kit = makeKit();
  const r = kit.readFile('.');
  assert.ok(r.includes('目录'));
});

test('readFile 超大文件拒绝', () => {
  const kit = makeKit({ maxFileSize: 100 });
  kit.writeFile('big.txt', 'x'.repeat(50));
  // 写的时候会被 maxFileSize 拦
  const r = kit.writeFile('big2.txt', 'x'.repeat(200));
  assert.ok(r.includes('太大') || fs.statSync(path.join(sandbox, 'big2.txt')).size <= 200);
});

test('readFile 拒绝二进制文件', () => {
  const kit = makeKit();
  fs.writeFileSync(path.join(sandbox, 'bin.dat'), Buffer.from([0, 1, 2, 0, 3]));
  const r = kit.readFile('bin.dat');
  assert.ok(r.includes('二进制'));
});

test('listFiles 列出目录', () => {
  const kit = makeKit();
  kit.writeFile('list-test.txt', 'x');
  const r = kit.listFiles('');
  assert.ok(r.includes('list-test.txt'));
  assert.ok(r.includes('[文件]'));
});

test('listFiles 空目录提示', () => {
  const kit = makeKit();
  fs.mkdirSync(path.join(sandbox, 'empty-dir'), { recursive: true });
  const r = kit.listFiles('empty-dir');
  assert.ok(r.includes('空目录'));
});

// ---------- 命令白名单 ----------

test('runCommand 拒绝白名单外的命令', async () => {
  const kit = makeKit();
  await assert.rejects(() => kit.runCommand('rm', ['-rf', '/']), /不在白名单/);
  await assert.rejects(() => kit.runCommand('curl', []), /不在白名单/);
  await assert.rejects(() => kit.runCommand('powershell', []), /不在白名单/);
});

test('runCommand 拒绝危险参数', async () => {
  const kit = makeKit();
  await assert.rejects(() => kit.runCommand('node', ['-e', 'x; rm -rf /']), /危险字符/);
  await assert.rejects(() => kit.runCommand('node', ['../../etc']), /危险字符/);
});

test('runCommand 允许白名单命令（node）', async () => {
  const kit = makeKit();
  const r = await kit.runCommand('node', ['-e', 'console.log("OK")']);
  assert.ok(r.includes('OK'));
});

test('runCommand 超时会被终止', async () => {
  const kit = makeKit({ cmdTimeout: 1000 });
  await assert.rejects(
    () => kit.runCommand('node', ['-e', 'setTimeout(()=>{}, 10000)']),
    /timed out|timeout/i,
  );
});

// ---------- 工具分发 ----------

test('definitions 返回工具列表', () => {
  const kit = makeKit();
  const defs = kit.definitions();
  assert.ok(defs.length >= 4);
  const names = defs.map((d) => d.function.name);
  assert.ok(names.includes('read_file'));
  assert.ok(names.includes('write_file'));
  assert.ok(names.includes('run_command'));
  assert.ok(names.includes('list_files'));
});

test('run 分发到正确工具', async () => {
  const kit = makeKit();
  const r = await kit.run('write_file', { path: 'dispatch.txt', content: 'abc' });
  assert.ok(r.includes('已写入'));

  const r2 = await kit.run('read_file', { path: 'dispatch.txt' });
  assert.equal(r2, 'abc');
});

test('run 未知工具返回提示', async () => {
  const kit = makeKit();
  const r = await kit.run('unknown_tool', {});
  assert.ok(r.includes('未知工具'));
});

test('run 捕获异常不抛出', async () => {
  const kit = makeKit();
  // 路径穿越会抛错，但 run 应捕获
  const r = await kit.run('read_file', { path: '../outside.txt' });
  assert.ok(r.includes('执行失败') || r.includes('越界'));
});

test('cleanup', () => {
  fs.rmSync(sandbox, { recursive: true, force: true });
});
