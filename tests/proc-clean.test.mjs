/**
 * 残留进程清理：只认自己的，不误杀。
 *
 * 起因：用户截图任务管理器里「终端」堆了 162 个窗口 —— 反复启停留下的。
 */
import { test } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { scan, ownRoots, listAll } from '../core/proc-clean.mjs';

const root = process.cwd();

test('认领目录包含程序根和隔壁适配器', () => {
  const roots = ownRoots(root);
  assert.ok(roots.includes(root));
  assert.ok(roots.some((r) => r.includes('yf-robot-wechat-adapter')));
});

test('列出来的进程，命令行里必须真的含我们的目录（不误杀）', () => {
  const roots = ownRoots(root);
  const ours = scan(roots);
  for (const p of ours) {
    const cmd = String(p.cmd || '').toLowerCase();
    assert.ok(
      roots.some((r) => cmd.includes(r.toLowerCase())),
      `进程 ${p.pid} 的命令行里没有我们的目录：${p.cmd}`,
    );
  }
});

test('不会把自己列进去（否则清理会自杀）', () => {
  const ours = scan(ownRoots(root));
  assert.equal(
    ours.some((p) => p.pid === process.pid),
    false,
    '列表里出现了当前进程，清理时会把自己杀掉',
  );
});

test('列表结构完整（面板要显示 pid / 名字 / 命令行）', (t) => {
  const ours = scan(ownRoots(root));
  if (!ours.length) {
    t.skip('当前没有属于本程序的进程');
    return;
  }
  for (const p of ours) {
    assert.equal(typeof p.pid, 'number');
    assert.ok(p.name);
    assert.ok(typeof p.cmd === 'string');
  }
});

test('非 Windows 平台不炸（返回空数组）', () => {
  const all = listAll();
  assert.ok(Array.isArray(all));
});
