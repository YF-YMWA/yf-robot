/**
 * 定时任务：到点起一个后台作业。
 *
 * 场景：「每天 8 点发早安」「每 2 小时看看有没有人找我」「今晚 11 点提醒睡觉」。
 * 不做完整 cron，只支持 daily / every / once —— 覆盖日常够用，也不容易写错。
 */
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { Scheduler } from '../core/scheduler.mjs';
import { JobStore } from '../core/jobs.mjs';

const TMP = path.join(process.cwd(), '.tmp', 'sched-test');

function fresh() {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  const jobs = new JobStore(TMP, { logger: { info() {}, warn() {} } });
  const sch = new Scheduler(TMP, { logger: { info() {}, warn() {} }, jobs });
  return { sch, jobs };
}

test('一次性任务：到点触发一次，之后自动停用', async () => {
  const { sch, jobs } = fresh();
  const at = Date.now() + 1000;
  const r = sch.add({ kind: 'once', timestamp: at, chatId: 'c1', text: '睡觉' });
  assert.equal(r.ok, true);

  // 还没到点
  await sch.tick(new Date(at - 500));
  assert.equal(jobs.takeOutbox('c1').length, 0, '没到点不该触发');

  // 到点
  await sch.tick(new Date(at + 100));
  await new Promise((r) => setTimeout(r, 30));
  const out = jobs.takeOutbox('c1');
  assert.equal(out.length, 1);
  assert.equal(out[0].text, '睡觉');

  // 再 tick 不该重复
  await sch.tick(new Date(at + 5000));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(jobs.takeOutbox('c1').length, 0, '一次性任务不该重复');
});

test('间隔任务：过了间隔才再触发', async () => {
  const { sch, jobs } = fresh();
  sch.add({ kind: 'every', everyMinutes: 60, chatId: 'c2', text: '看看群' });

  const now = new Date();
  await sch.tick(now); // 第一次（lastAt=0）应该触发
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(jobs.takeOutbox('c2').length, 1, '第一次应触发');

  // 30 分钟后再 tick：没到 60 分钟，不该触发
  await sch.tick(new Date(now.getTime() + 30 * 60000));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(jobs.takeOutbox('c2').length, 0, '没到间隔不该触发');

  // 61 分钟后：该触发
  await sch.tick(new Date(now.getTime() + 61 * 60000));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(jobs.takeOutbox('c2').length, 1, '过了间隔应该触发');
});

test('每天任务：当天只触发一次', async () => {
  const { sch, jobs } = fresh();
  sch.add({ kind: 'daily', at: '08:00', chatId: 'c3', text: '早安' });

  const day = new Date(2026, 0, 5);
  const at8 = new Date(2026, 0, 5, 8, 0, 30);
  const at8again = new Date(2026, 0, 5, 8, 1, 0);

  await sch.tick(at8);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(jobs.takeOutbox('c3').length, 1, '到点应触发');

  await sch.tick(at8again);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(jobs.takeOutbox('c3').length, 0, '同一天不该再发');

  // 第二天同一时刻
  await sch.tick(new Date(2026, 0, 6, 8, 0, 10));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(jobs.takeOutbox('c3').length, 1, '第二天应该再发');
});

test('参数校验：写错就明确拒绝，不静默', () => {
  const { sch } = fresh();
  assert.match(sch.add({ kind: 'daily', at: '25:99', chatId: 'c', text: 'x' }).error, /HH:MM/);
  assert.match(sch.add({ kind: 'every', everyMinutes: 0, chatId: 'c', text: 'x' }).error, /everyMinutes/);
  assert.match(sch.add({ kind: 'once', timestamp: 1, chatId: 'c', text: 'x' }).error, /未来/);
  assert.match(sch.add({ kind: 'daily', at: '08:00', chatId: '', text: 'x' }).error, /发给谁/);
  assert.match(sch.add({ kind: 'daily', at: '08:00', chatId: 'c' }).error, /内容/);
});

test('删除：删掉后不再触发', async () => {
  const { sch, jobs } = fresh();
  const r = sch.add({ kind: 'every', everyMinutes: 60, chatId: 'c4', text: 'x' });
  const id = r.item.id;
  assert.equal(sch.remove(id).ok, true);
  await sch.tick(new Date());
  await new Promise((res) => setTimeout(res, 30));
  assert.equal(jobs.takeOutbox('c4').length, 0);
});
