/**
 * 记忆备份 / 恢复的测试。
 *
 * 存在的原因：用户踩过「更新后记忆全没了」——把新版本解压到新文件夹，
 * 新目录没有 data/，看起来就是谁都不认识。有了备份/恢复才有退路。
 */
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import {
  exportBundle,
  restoreBundle,
  listSnapshots,
  pruneSnapshots,
} from '../core/memory-backup.mjs';

const TMP = path.join(process.cwd(), '.tmp', 'backup-test');
process.on('exit', () => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {}
});

function makeRoot(name = 'r') {
  const root = path.join(TMP, name);
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(path.join(root, 'data', 'card1', 'memory'), { recursive: true });
  fs.mkdirSync(path.join(root, 'data', 'card1', 'sessions'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'data', 'card1', 'memory', 'a.json'),
    JSON.stringify({ facts: ['我叫 YF'] }),
    'utf8',
  );
  fs.writeFileSync(
    path.join(root, 'data', 'card1', 'sessions', 's1.json'),
    JSON.stringify({ history: [{ role: 'user', content: '在吗' }] }),
    'utf8',
  );
  fs.writeFileSync(
    path.join(root, 'data', 'card1', 'logic.json'),
    JSON.stringify({ items: [] }),
    'utf8',
  );
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ card: 'card1' }), 'utf8');
  return root;
}

test('导出：能打出备份文件并统计内容', () => {
  const root = makeRoot('export');
  const r = exportBundle(root);

  assert.ok(fs.existsSync(r.file));
  assert.ok(r.bytes > 100);
  assert.deepEqual(r.cards, ['card1']);
  assert.equal(r.counts.memories, 1);
  assert.equal(r.counts.sessions, 1);
  assert.equal(r.counts.logic, 1);
});

test('导出：不含素材图片（不然备份文件会巨大）', () => {
  const root = makeRoot('nomedia');
  fs.mkdirSync(path.join(root, 'data', 'stickers'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data', 'stickers', 'x.gif'), 'GIF89a', 'utf8');

  const r = exportBundle(root);
  assert.ok(!r.cards.includes('stickers'), '素材目录不该被当成卡片备份');

  const bundle = JSON.parse(fs.readFileSync(r.file, 'utf8'));
  assert.ok(!JSON.stringify(bundle).includes('GIF89a'));
});

test('恢复：改坏的记忆能被还原', () => {
  const root = makeRoot('restore');
  const snap = exportBundle(root).file;

  // 破坏
  fs.writeFileSync(
    path.join(root, 'data', 'card1', 'memory', 'a.json'),
    JSON.stringify({ facts: ['被改坏了'] }),
    'utf8',
  );

  const bundle = JSON.parse(fs.readFileSync(snap, 'utf8'));
  const r = restoreBundle(root, bundle);
  assert.equal(r.ok, true);

  const back = JSON.parse(fs.readFileSync(path.join(root, 'data', 'card1', 'memory', 'a.json'), 'utf8'));
  assert.deepEqual(back.facts, ['我叫 YF']);
});

test('恢复：动手前会先存一份安全快照', () => {
  const root = makeRoot('safety');
  const snap = exportBundle(root).file;
  const before = listSnapshots(root).length;

  const bundle = JSON.parse(fs.readFileSync(snap, 'utf8'));
  const r = restoreBundle(root, bundle);

  assert.ok(r.safety, '应该返回安全快照路径');
  assert.ok(listSnapshots(root).length > before, '快照数量应该变多');
});

test('恢复：配置也会跟着回来', () => {
  const root = makeRoot('config');
  const snap = exportBundle(root).file;

  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ card: '改过了' }), 'utf8');

  const bundle = JSON.parse(fs.readFileSync(snap, 'utf8'));
  restoreBundle(root, bundle);

  const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
  assert.equal(cfg.card, 'card1');
});

test('恢复：拒绝不是本程序备份的文件', () => {
  const root = makeRoot('reject');
  assert.throws(() => restoreBundle(root, { kind: 'something-else' }), /不是 YF-Robot 的记忆备份/);
});

test('恢复：dryRun 只报计划，不动文件', () => {
  const root = makeRoot('dry');
  const snap = exportBundle(root).file;
  fs.writeFileSync(path.join(root, 'data', 'card1', 'memory', 'a.json'), '{"facts":["改过"]}', 'utf8');

  const bundle = JSON.parse(fs.readFileSync(snap, 'utf8'));
  const r = restoreBundle(root, bundle, { dryRun: true });

  assert.equal(r.dryRun, true);
  assert.equal(r.plan.memories, 1);

  const still = JSON.parse(fs.readFileSync(path.join(root, 'data', 'card1', 'memory', 'a.json'), 'utf8'));
  assert.deepEqual(still.facts, ['改过'], 'dryRun 不该真的改文件');
});

test('快照：只保留最近 N 份', () => {
  const root = makeRoot('prune');
  for (let i = 0; i < 5; i++) exportBundle(root);

  // 不能假设「5 次导出一定有 5 个文件」：同一毫秒内可能重名。
  // 按实际数量算，才是对「只保留 N 份」这件事的真正断言。
  const before = listSnapshots(root).length;
  assert.ok(before >= 3, '至少应该有几份快照，实际 ' + before);

  const removed = pruneSnapshots(root, 2);
  assert.equal(removed, before - 2, '应删掉多出来的那些');
  assert.equal(listSnapshots(root).length, 2);
});

test('快照：没有目录时 list 返回空数组而不抛错', () => {
  const root = path.join(TMP, 'empty-root');
  fs.mkdirSync(root, { recursive: true });
  assert.deepEqual(listSnapshots(root), []);
});
