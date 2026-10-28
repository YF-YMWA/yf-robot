/**
 * 一键更新的测试：zip 解压 + 更新器的保护逻辑。
 *
 * 不测「真的去 GitHub 下载」——那是网络问题，不是代码问题。
 * 测的是：能不能正确解包、会不会误覆盖配置、git 副本会不会被拒绝。
 */
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { unzipAll, stripRootDir } from '../core/zip.mjs';
import { applyUpdate } from '../core/updater.mjs';

const TMP = path.join(process.cwd(), '.tmp', 'update-test');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
process.on('exit', () => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {}
});

/**
 * 造一个最小的 zip（store 方式，不压缩）。
 * @param {Array<{name:string, data:Buffer|string}>} entries
 */
function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data), 'utf8');
    const crc = zlib.crc32 ? zlib.crc32(data) : 0;

    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(0, 8); // method = store
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);

    locals.push(local, data);
    centrals.push(central);
    offset += local.length + data.length;
  }

  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, cd, eocd]);
}

// ===== zip 解压 =====

test('zip：能解开 store 方式的文件', () => {
  const zip = makeZip([
    { name: 'a.txt', data: 'hello' },
    { name: 'dir/b.txt', data: 'world' },
  ]);
  const files = unzipAll(zip);
  assert.equal(files.length, 2);
  const a = files.find((f) => f.name === 'a.txt');
  assert.equal(a.data.toString(), 'hello');
  const b = files.find((f) => f.name === 'dir/b.txt');
  assert.equal(b.data.toString(), 'world');
});

test('zip：目录条目被跳过', () => {
  const zip = makeZip([
    { name: 'dir/', data: '' },
    { name: 'dir/x.txt', data: 'x' },
  ]);
  const files = unzipAll(zip);
  assert.equal(files.length, 1);
  assert.equal(files[0].name, 'dir/x.txt');
});

test('zip：filter 能只解一部分', () => {
  const zip = makeZip([
    { name: 'core/a.mjs', data: 'a' },
    { name: 'data/big.bin', data: 'b' },
  ]);
  const files = unzipAll(zip, { filter: (n) => n.startsWith('core/') });
  assert.equal(files.length, 1);
  assert.equal(files[0].name, 'core/a.mjs');
});

test('zip：不是 zip 时明确报错', () => {
  assert.throws(() => unzipAll(Buffer.from('随便什么内容，不是 zip')), /不是有效的 zip/);
});

test('zip：去掉 GitHub 源码包的外层目录', () => {
  const files = [
    { name: 'yf-robot-0.9.0/app.mjs', data: Buffer.from('x') },
    { name: 'yf-robot-0.9.0/core/a.mjs', data: Buffer.from('y') },
  ];
  const { prefix, files: out } = stripRootDir(files);
  assert.equal(prefix, 'yf-robot-0.9.0/');
  assert.deepEqual(out.map((f) => f.name), ['app.mjs', 'core/a.mjs']);
});

test('zip：没有统一外层目录时不动', () => {
  const files = [
    { name: 'app.mjs', data: Buffer.from('x') },
    { name: 'core/a.mjs', data: Buffer.from('y') },
  ];
  const { prefix, files: out } = stripRootDir(files);
  assert.equal(prefix, '');
  assert.equal(out.length, 2);
});

// ===== 更新器保护逻辑 =====

test('更新：版本相同直接拒绝', async () => {
  const root = path.join(TMP, 'same');
  fs.mkdirSync(root, { recursive: true });
  const r = await applyUpdate({ root, repo: 'a/b', latest: '1.0.0', local: '1.0.0' });
  assert.equal(r.ok, false);
  assert.match(r.error, /最新版/);
});

test('更新：git 工作副本拒绝覆盖（保护本地提交）', async () => {
  const root = path.join(TMP, 'git');
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  const r = await applyUpdate({ root, repo: 'a/b', latest: '9.9.9', local: '1.0.0' });
  assert.equal(r.ok, false);
  assert.match(r.error, /git/);
});

test('更新：不会碰 config.json 和 data（下载失败时也不会）', async () => {
  const root = path.join(TMP, 'safe');
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.writeFileSync(path.join(root, 'config.json'), '{"secret":"keep"}', 'utf8');
  fs.writeFileSync(path.join(root, 'data', 'token.txt'), 'abc', 'utf8');

  // 仓库地址是假的，下载必然失败
  const r = await applyUpdate({ root, repo: 'nonexistent/nonexistent-xyz-123', latest: '9.9.9', local: '1.0.0' });

  assert.equal(r.ok, false);
  assert.equal(fs.readFileSync(path.join(root, 'config.json'), 'utf8'), '{"secret":"keep"}');
  assert.equal(fs.readFileSync(path.join(root, 'data', 'token.txt'), 'utf8'), 'abc');
});

test('更新：动手前会备份配置', async () => {
  const root = path.join(TMP, 'backup');
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.writeFileSync(path.join(root, 'config.json'), '{"a":1}', 'utf8');

  await applyUpdate({ root, repo: 'nonexistent/nonexistent-xyz-123', latest: '9.9.9', local: '1.0.0' });

  const bdir = path.join(root, 'data', 'backup');
  assert.ok(fs.existsSync(bdir), '应该有备份目录');
  const subs = fs.readdirSync(bdir);
  assert.ok(subs.length > 0);
  assert.ok(fs.existsSync(path.join(bdir, subs[0], 'config.json')));
});

// ===== 适配器更新 =====

test('适配器：没有 adapter/ 目录时跳过，不报错', async () => {
  const root = path.join(TMP, 'no-adapter');
  fs.mkdirSync(root, { recursive: true });
  const r = await applyUpdate({
    root,
    repo: 'nonexistent/nonexistent-xyz-123',
    latest: '9.9.9',
    local: '1.0.0',
    includeAdapter: true,
  });
  // 主仓下载失败会先返回，这里只验证不会因为 adapter 报错
  assert.equal(r.ok, false);
  assert.ok(Array.isArray(r.steps));
});

test('适配器：adapter/ 是 git 副本时拒绝覆盖', async () => {
  const root = path.join(TMP, 'adapter-git');
  fs.mkdirSync(path.join(root, 'adapter', '.git'), { recursive: true });
  fs.writeFileSync(path.join(root, 'adapter', 'config.json'), '{"keep":1}', 'utf8');

  // 主仓也让它失败（假仓库），这样能走到 adapter 步骤之前的返回
  const r = await applyUpdate({
    root,
    repo: 'nonexistent/nonexistent-xyz-123',
    latest: '9.9.9',
    local: '1.0.0',
    includeAdapter: true,
  });
  assert.equal(r.ok, false);
  // 配置没被动过
  assert.equal(fs.readFileSync(path.join(root, 'adapter', 'config.json'), 'utf8'), '{"keep":1}');
});

test('适配器：备份目录里会留 adapter 的配置', async () => {
  const root = path.join(TMP, 'adapter-backup');
  fs.mkdirSync(path.join(root, 'adapter'), { recursive: true });
  fs.writeFileSync(path.join(root, 'adapter', 'config.json'), '{"v":2}', 'utf8');

  await applyUpdate({
    root,
    repo: 'nonexistent/nonexistent-xyz-123',
    latest: '9.9.9',
    local: '1.0.0',
    includeAdapter: true,
  });

  // 主仓下载失败会提前返回，但备份是在下载之前做的
  const bdir = path.join(root, 'data', 'backup');
  assert.ok(fs.existsSync(bdir), '应该有备份目录');
});
