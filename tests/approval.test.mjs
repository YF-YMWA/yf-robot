/**
 * 危险操作要主人点头。
 *
 * 档位是「事先定死」的，真正危险的是「这一次」：
 * 她突然要写文件、跑命令。这里验证挂起 → 问人 → 批准才执行。
 */
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { ToolKit } from '../core/tools.mjs';
import { ApprovalStore, isApproveText, isDenyText } from '../core/approvals.mjs';

const TMP = path.join(process.cwd(), '.tmp', 'approval-test');

function kit({ approval = true, permission = 'workspace' } = {}) {
  return new ToolKit({
    config: { tools: { enabled: true, off: [], permission, approval } },
    sandbox: TMP,
    logger: { info() {}, warn() {} },
  });
}

test('写文件要审批：挂起时不执行', async () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });

  const k = kit();
  let asked = null;
  const out = await k.run(
    'write_file',
    { path: 'need-approval.txt', content: 'hello' },
    { isOwner: true, askApproval: async (req) => ((asked = req), { pending: true, id: 'ap1' }) },
  );

  assert.ok(asked, '应该发起审批');
  assert.equal(asked.tool, 'write_file');
  assert.match(out, /等主人|问主人/);
  assert.equal(fs.existsSync(path.join(TMP, 'need-approval.txt')), false, '审批前绝不能真的写');
});

test('批准后（approved=true）直接执行', async () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });

  const k = kit();
  const out = await k.run(
    'write_file',
    { path: 'approved.txt', content: 'ok' },
    { isOwner: true, askApproval: async () => ({ approved: true }) },
  );

  assert.ok(!/等主人|问主人/.test(out), '不该再问：' + out);
  assert.equal(fs.existsSync(path.join(TMP, 'approved.txt')), true, '批准后应该写成功');
});

test('拒绝后不执行', async () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });

  const k = kit();
  const out = await k.run(
    'write_file',
    { path: 'denied.txt', content: 'no' },
    { isOwner: true, askApproval: async () => ({ approved: false }) },
  );

  assert.match(out, /没同意|不做了/);
  assert.equal(fs.existsSync(path.join(TMP, 'denied.txt')), false);
});

test('关掉审批开关（tools.approval=false）就直接执行', async () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });

  const k = kit({ approval: false });
  let asked = false;
  const out = await k.run(
    'write_file',
    { path: 'no-approval.txt', content: 'ok' },
    { isOwner: true, askApproval: async () => ((asked = true), { pending: true }) },
  );

  assert.equal(asked, false, '关掉开关后不该再问');
  assert.ok(!/等主人/.test(out));
  assert.equal(fs.existsSync(path.join(TMP, 'no-approval.txt')), true);
});

test('只读档优先于审批：直接拒绝，不打扰主人', async () => {
  const k = kit({ permission: 'read-only' });
  let asked = false;
  const out = await k.run(
    'write_file',
    { path: 'x.txt', content: 'x' },
    { isOwner: true, askApproval: async () => ((asked = true), { pending: true }) },
  );

  assert.match(out, /只读/);
  assert.equal(asked, false, '只读档不该走到审批');
});

test('审批队列：登记、取最新、标记结果', () => {
  const store = new ApprovalStore(TMP);
  const a = store.add({ chatId: 'wxid_a', tool: 'write_file', args: { path: 'a' }, reason: '写文件' });
  const b = store.add({ chatId: 'wxid_a', tool: 'run_command', args: { command: 'node' }, reason: '跑命令' });

  assert.equal(store.latest('wxid_a').id, b.id, '应该取最新一条');
  assert.equal(store.latest('wxid_b'), null, '别的会话取不到');

  store.resolve(b.id, 'approved');
  assert.equal(store.latest('wxid_a').id, a.id, '处理完最新的，回退到上一条');
});

test('审批用语的识别', () => {
  for (const t of ['允许', '同意', '可以', '好', 'y', 'yes', 'ok']) assert.equal(isApproveText(t), true, t);
  for (const t of ['拒绝', '不行', '不要', 'n', 'no']) assert.equal(isDenyText(t), true, t);
  assert.equal(isApproveText('今天天气不错'), false);
  assert.equal(isDenyText('不许你吃饭'), false, '长句子不算明确拒绝');
});
