/**
 * 素材清单：她要能说出「有什么、有多少」。
 *
 * 用户报「表情包只能看自己找的图」：
 *   清单只列最新 5 个 → 她以为库里就 5 张；
 *   而且她画的图扫的是老目录，角色卡目录的图她根本看不见。
 */
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

const BASE = 'http://127.0.0.1:8899';

function cfg() {
  return JSON.parse(fs.readFileSync('config.json', 'utf8'));
}

async function alive() {
  try {
    const r = await fetch(BASE + '/api/adapter/config', { signal: AbortSignal.timeout(1500) });
    return r.status < 500;
  } catch {
    return false;
  }
}

async function ask(text) {
  const c = cfg();
  const r = await fetch(BASE + '/api/wechat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: 'libcheck-' + Date.now(),
      chat_type: 'private',
      senderId: (c.owner?.wxids || [])[0],
      senderName: 'YF',
      text,
      msg_id: 'lc' + Date.now(),
    }),
  });
  const j = await r.json();
  return (j.bubbles || []).join(' ');
}

function countIn(dir) {
  try {
    return fs.readdirSync(dir).filter((n) => /\.(jpe?g|png|gif|webp)$/i.test(n)).length;
  } catch {
    return 0;
  }
}

test('她能说出素材库的真实数量（不是只说 5 个）', async (t) => {
  if (!(await alive())) {
    t.skip('服务没在跑');
    return;
  }

  const c = cfg();
  const card = c.card || 'dafeiyu';
  const stickers = countIn(path.join(process.cwd(), 'data', 'stickers'));
  if (!stickers) {
    t.skip('素材库是空的');
    return;
  }

  const reply = await ask('你素材库里都有什么图？一共多少张？');
  if (!reply) {
    t.skip('模型没回');
    return;
  }

  // 回复里应该出现和磁盘一致的数量（允许 ±2 的口径差异：表情包/图片分开数）
  const nums = [...reply.matchAll(/(\d+)\s*(个|张)/g)].map((m) => Number(m[1]));
  const hit = nums.some((n) => Math.abs(n - stickers) <= 2);
  assert.ok(
    hit,
    `磁盘上有 ${stickers} 个表情包，她的回答里没出现相近的数字：${reply.slice(0, 100)}`,
  );
});

test('提示词里不再只写「最新 5 张」', () => {
  const engine = fs.readFileSync('core/engine.mjs', 'utf8');
  assert.ok(
    !/最新 5 张|最新 5 个/.test(engine),
    '还留着「只给 5 个」的说法，模型会以为库里就这些',
  );
  assert.ok(/共 \\$\\{total/.test(engine) || /共 \$\{total/.test(engine), '应该给出总数');
});
