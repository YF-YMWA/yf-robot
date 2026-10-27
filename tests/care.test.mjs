/**
 * 测试新增功能：
 *   - care 模块（主动搭话判断与生成）
 *   - 能力测试接口
 *   - Key 管理（掩码、清空）
 *   - 打包脚本的敏感信息扫描
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { checkCareDue, composeCare, CARE_LINES } from '../core/care.mjs';

// ===== care 模块 =====

test('care：安静时段不搭话', () => {
  const night = new Date('2026-10-26T02:00:00');
  const r = checkCareDue({ lastTs: 0, sentToday: 0, now: night, cfg: {} });
  assert.equal(r.due, false);
  assert.match(r.reason, /安静时段/);
});

test('care：白天可以搭话', () => {
  const day = new Date('2026-10-26T14:00:00');
  const r = checkCareDue({ lastTs: 0, sentToday: 0, now: day, cfg: {} });
  assert.equal(r.due, true);
});

test('care：达到每日上限不搭话', () => {
  const day = new Date('2026-10-26T14:00:00');
  const r = checkCareDue({ lastTs: 0, sentToday: 3, now: day, cfg: { maxPerDay: 3 } });
  assert.equal(r.due, false);
  assert.match(r.reason, /上限/);
});

test('care：间隔不够不搭话', () => {
  const day = new Date('2026-10-26T14:00:00');
  const lastTs = day.getTime() - 30 * 60000; // 30 分钟前
  const r = checkCareDue({ lastTs, sentToday: 1, now: day, cfg: { minIntervalMinutes: 120 } });
  assert.equal(r.due, false);
  assert.match(r.reason, /还需等/);
});

test('care：间隔够了可以搭话', () => {
  const day = new Date('2026-10-26T14:00:00');
  const lastTs = day.getTime() - 180 * 60000; // 3 小时前
  const r = checkCareDue({ lastTs, sentToday: 1, now: day, cfg: { minIntervalMinutes: 120 } });
  assert.equal(r.due, true);
});

test('care：关闭时不搭话', () => {
  const day = new Date('2026-10-26T14:00:00');
  const r = checkCareDue({ lastTs: 0, sentToday: 0, now: day, cfg: { enabled: false } });
  assert.equal(r.due, false);
  assert.match(r.reason, /关闭/);
});

test('care：跨午夜安静时段判断', () => {
  // 23:00 - 09:00 跨午夜
  const at23 = new Date('2026-10-26T23:30:00');
  const at8 = new Date('2026-10-26T08:00:00');
  const at10 = new Date('2026-10-26T10:00:00');

  assert.equal(checkCareDue({ now: at23, cfg: {} }).due, false, '23:30 应安静');
  assert.equal(checkCareDue({ now: at8, cfg: {} }).due, false, '08:00 应安静');
  assert.equal(checkCareDue({ now: at10, cfg: {} }).due, true, '10:00 可搭话');
});

test('care：按时段生成内容', () => {
  const morning = composeCare({ now: new Date('2026-10-26T07:00:00'), pick: (a) => a[0] });
  assert.match(morning, /早/);

  const noon = composeCare({ now: new Date('2026-10-26T12:00:00'), pick: (a) => a[0] });
  assert.match(noon, /中午|饭/);

  const evening = composeCare({ now: new Date('2026-10-26T19:00:00'), pick: (a) => a[0] });
  assert.match(evening, /晚上|晚饭|累/);
});

test('care：所有时段都有模板', () => {
  for (const slot of ['morning', 'forenoon', 'noon', 'afternoon', 'evening', 'night']) {
    assert.ok(Array.isArray(CARE_LINES[slot]), `${slot} 应有模板数组`);
    assert.ok(CARE_LINES[slot].length > 0, `${slot} 模板不能为空`);
  }
});

test('care：生成的内容不为空', () => {
  for (const hour of [6, 10, 13, 16, 20, 23]) {
    const now = new Date(`2026-10-26T${String(hour).padStart(2, '0')}:00:00`);
    const text = composeCare({ now });
    assert.ok(text && text.length > 0, `${hour} 点应生成内容`);
    assert.equal(typeof text, 'string');
  }
});
