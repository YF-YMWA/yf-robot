/**
 * 本机看图的权限。
 *
 * 真实事故：画图成功、文件也在，但面板里显示成裂图 ——
 * 因为 <img src> 带不了自定义请求头，媒体接口一律要 token，就 403。
 * 用户看到的现象是「画图坏了」，其实图早就画好了。
 *
 * 规则：本机请求免令牌（服务默认只监听 127.0.0.1），远程请求仍要 token。
 */
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

const BASE = 'http://127.0.0.1:8899';

async function alive() {
  try {
    const r = await fetch(BASE + '/api/adapter/config', { signal: AbortSignal.timeout(1500) });
    return r.status < 500;
  } catch {
    return false;
  }
}

test('本机看图：<img> 那种不带令牌的请求也要能拿到图', async (t) => {
  if (!(await alive())) {
    t.skip('服务没在跑');
    return;
  }

  const dir = path.join(process.cwd(), 'data', 'generated');
  let name = '';
  try {
    name = fs.readdirSync(dir).find((n) => /\.(jpe?g|png|gif|webp)$/i.test(n)) || '';
  } catch {}
  if (!name) {
    t.skip('没有 generated 图片可测');
    return;
  }

  const r = await fetch(`${BASE}/api/media/generated/${encodeURIComponent(name)}`);
  assert.equal(r.status, 200, '本机不带令牌应该能看图，否则面板会显示裂图');

  const ctype = r.headers.get('content-type') || '';
  assert.match(ctype, /image\//, '返回的应该是图片类型，实际：' + ctype);

  const buf = Buffer.from(await r.arrayBuffer());
  assert.ok(buf.length > 100, '图片不该是空的');
});

test('素材（表情包）同样能不带令牌预览', async (t) => {
  if (!(await alive())) {
    t.skip('服务没在跑');
    return;
  }

  const dir = path.join(process.cwd(), 'data', 'stickers');
  let name = '';
  try {
    name = fs.readdirSync(dir).find((n) => /\.(jpe?g|png|gif|webp)$/i.test(n)) || '';
  } catch {}
  if (!name) {
    t.skip('没有表情包可测');
    return;
  }

  const r = await fetch(`${BASE}/api/media/stickers/${encodeURIComponent(name)}`);
  assert.equal(r.status, 200);
});

test('不存在的图：给 404，不要 500', async (t) => {
  if (!(await alive())) {
    t.skip('服务没在跑');
    return;
  }

  const r = await fetch(BASE + '/api/media/generated/__nope__.jpg');
  assert.ok(r.status === 404 || r.status === 400, '应该是 404/400，实际 ' + r.status);
});
