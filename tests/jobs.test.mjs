/**
 * 后台作业：长任务先应答，做完再补一条。
 *
 * 画一张图要 8~12 秒，同步等会让用户以为卡死。
 * 现在先回「画着呢」，图完成后进待发队列，适配器轮询取走。
 */
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { JobStore } from '../core/jobs.mjs';

const TMP = path.join(process.cwd(), '.tmp', 'jobs-test');

function store() {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  return new JobStore(TMP, { logger: { info() {}, warn() {} } });
}

test('作业完成：结果进待发队列，能按会话取走', async () => {
  const s = store();
  s.start({
    chatId: 'abc',
    kind: '画图',
    run: async () => ({ text: '画好了', images: ['gen_1.jpg'] }),
  });

  await new Promise((r) => setTimeout(r, 50));

  const list = s.takeOutbox('abc');
  assert.equal(list.length, 1);
  assert.equal(list[0].text, '画好了');
  assert.deepEqual(list[0].images, ['gen_1.jpg']);

  // 取走即清，不会重复发
  assert.equal(s.takeOutbox('abc').length, 0);
});

test('作业失败：也要告诉用户，而不是静默', async () => {
  const s = store();
  s.start({
    chatId: 'abc',
    kind: '画图',
    run: async () => {
      throw new Error('模型额度用完了');
    },
  });

  await new Promise((r) => setTimeout(r, 50));
  const list = s.takeOutbox('abc');
  assert.equal(list.length, 1, '失败也要有一条消息');
  assert.match(list[0].text, /没成|额度/);
});

test('不同会话的结果不会串', async () => {
  const s = store();
  s.start({ chatId: 'a', kind: '画图', run: async () => ({ text: '给A', images: [] }) });
  s.start({ chatId: 'b', kind: '画图', run: async () => ({ text: '给B', images: [] }) });
  await new Promise((r) => setTimeout(r, 60));

  const a = s.takeOutbox('a');
  assert.equal(a.length, 1);
  assert.equal(a[0].text, '给A');
});

test('running()：作业在跑时能查出来', async () => {
  const s = store();
  s.start({
    chatId: 'x',
    kind: '画图',
    run: () => new Promise((r) => setTimeout(() => r({ text: 'ok' }), 80)),
  });
  assert.equal(s.running('x').length, 1, '刚开始应该在跑');
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(s.running('x').length, 0, '完成后不该还算在跑');
});
