/**
 * 工具权限分级的行为。
 *
 * 背景：她能写文件、能跑命令，但以前没有任何分级 ——
 * 提示词一旦被绕过（陌生人套话、群友发恶意指令），就能改真实文件。
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { ToolKit } from '../core/tools.mjs';

function kit(permission) {
  return new ToolKit({
    config: { tools: { enabled: true, off: [], permission } },
    sandbox: '.tmp',
    logger: { info() {}, warn() {} },
  });
}

test('只读档：读类工具照常', async () => {
  const k = kit('read-only');
  const out = await k.run('list_files', { dir: '' }, { isOwner: true });
  assert.ok(!/只读/.test(out), '读取不该被挡：' + out);
});

test('只读档：写文件被挡，而且说清原因', async () => {
  const k = kit('read-only');
  const out = await k.run('write_file', { path: 'x.txt', content: 'hi' }, { isOwner: true });
  assert.match(out, /只读/);
  assert.ok(!/已写入|写入成功/.test(out));
});

test('只读档：执行命令被挡', async () => {
  const k = kit('read-only');
  const out = await k.run('run_command', { command: 'node', args: ['-v'] }, { isOwner: true });
  assert.match(out, /只读/);
});

test('只读档：发图也被挡（会产生对外动作）', async () => {
  const k = kit('read-only');
  const out = await k.run('send_image', { name: 'x.gif' }, { isOwner: true });
  assert.match(out, /只读/);
});

test('workspace 档：能写文件', async () => {
  const k = kit('workspace');
  const out = await k.run('write_file', { path: 'perm-test.txt', content: 'ok' }, { isOwner: true });
  assert.ok(!/只读|权限/.test(out), '不该被挡：' + out);
});

test('workspace 档：管理动作（改设置/清素材）要 full', async () => {
  const k = kit('workspace');
  const out = await k.run('admin_config', { key: 'voiceChance', value: '0' }, { isOwner: true });
  assert.match(out, /完全|权限/);
});

test('full 档：管理动作放行到业务层（不再是权限问题）', async () => {
  const k = kit('full');
  // 没注入 adminSaveConfig 时会提示「不是一个函数」，说明已经通过权限闸门
  const out = await k.run('admin_config', { key: 'voiceChance', value: '0' }, { isOwner: true });
  assert.ok(!/完全|只读/.test(out), '权限不该再拦：' + out);
});

test('危险命令：即使 full 也拒绝', async () => {
  const k = kit('full');
  const cases = [
    ['python', ['-c', 'import shutil; shutil.rmtree("/")']],
    ['node', ['-e', 'require("fs").rmSync("data",{recursive:true})']],
    ['ffmpeg', ['-i', 'a', 'format c:']],
  ];
  for (const [cmd, args] of cases) {
    const out = await k.run('run_command', { command: cmd, args }, { isOwner: true });
    assert.match(out, /删东西|改系统|不执行/, `${cmd} 应该被挡，实际：${out}`);
  }
});

test('未知档位按 workspace 处理（不因为写错就全开）', async () => {
  const k = kit('typo-mode');
  const write = await k.run('write_file', { path: 'perm-x.txt', content: 'ok' }, { isOwner: true });
  const admin = await k.run('admin_config', { key: 'voiceChance', value: '0' }, { isOwner: true });
  assert.ok(!/只读/.test(write), '写文件应放行（workspace 语义）');
  assert.match(admin, /完全|权限/, '管理动作仍要 full');
});
