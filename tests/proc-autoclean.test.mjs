/**
 * 自动清理残留进程：宁可少清，不可错杀。
 *
 * 用户任务管理器里堆了 162 个终端窗口，反复启停留下的。
 * 自动清理必须满足：只清我们自己的、只清旧的、绝不碰正在用的。
 */
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { autoCleanOnStart } from '../core/proc-autoclean.mjs';

const ROOT = process.cwd();
const TMP = path.join(ROOT, '.tmp', 'autoclean-test');

/** 造一批假进程；startedAt 用 CIM 的 /Date(ms)/ 格式 */
function fakeProcs({ oldMs = 30 * 60000, newMs = 60 * 1000 } = {}) {
  const now = Date.now();
  return [
    { pid: 9001, name: 'node.exe', cmd: ROOT + '\\runtime\\node.exe app.mjs', startedAt: `/Date(${now - oldMs})/` },
    { pid: 9002, name: 'cmd.exe', cmd: ROOT + '\\panel.bat', startedAt: `/Date(${now - oldMs})/` },
    { pid: 9003, name: 'python.exe', cmd: ROOT + '\\adapter\\bridge.py', startedAt: `/Date(${now - newMs})/` },
    { pid: 9004, name: 'notepad.exe', cmd: ROOT + '\\readme.txt', startedAt: `/Date(${now - oldMs})/` },
    { pid: 9005, name: 'node.exe', cmd: ROOT + '\\x.mjs', startedAt: '' },
  ];
}

function run(procs, opts = {}) {
  const killed = [];
  const logs = [];
  const r = autoCleanOnStart(ROOT, {
    scanFn: () => procs,
    killFn: (pids) => {
      killed.push(...pids);
      return { killed: [...pids], failed: [] };
    },
    log: (m) => logs.push(m),
    ...opts,
  });
  return { r, killed, logs };
}

test('只清「旧的 + 控制台类 + 我们的」', () => {
  const { r, killed } = run(fakeProcs());
  assert.deepEqual(killed.sort(), [9001, 9002], '应该只清两个旧的 node/cmd');
  assert.ok(r.skipped.some((s) => s.pid === 9003 && /太新|分钟/.test(s.why)));
  assert.ok(r.skipped.some((s) => s.pid === 9004 && /不是控制台/.test(s.why)));
  assert.ok(r.skipped.some((s) => s.pid === 9005 && /启动时间/.test(s.why)));
});

test('受保护的适配器不清（读 pid 文件）', () => {
  fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
  const pidFile = path.join(ROOT, 'data', 'adapter-test999.pid');
  fs.writeFileSync(pidFile, '9001', 'utf8');
  try {
    const { killed } = run(fakeProcs());
    assert.equal(killed.includes(9001), false, '正在跑的适配器不能被杀');
  } finally {
    fs.unlinkSync(pidFile);
  }
});

test('没有可清的时候也留一行日志（能确认跑过）', () => {
  const { logs } = run([]);
  assert.ok(logs.some((l) => /自动清理/.test(l)), '一条日志都没有就没法确认它跑过');
});

test('门槛可调：minAgeMinutes 变大就都不清', () => {
  const { killed } = run(fakeProcs(), { minAgeMinutes: 600 });
  assert.deepEqual(killed, []);
});

test('默认门槛 10 分钟', () => {
  const procs = [
    { pid: 9101, name: 'node.exe', cmd: ROOT + '\\a', startedAt: `/Date(${Date.now() - 9 * 60000})/` },
    { pid: 9102, name: 'node.exe', cmd: ROOT + '\\b', startedAt: `/Date(${Date.now() - 11 * 60000})/` },
  ];
  const { killed } = run(procs);
  assert.deepEqual(killed, [9102], '9 分钟的不清，11 分钟的才清');
});
