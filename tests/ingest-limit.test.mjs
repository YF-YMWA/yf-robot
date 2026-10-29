/**
 * 大素材上传的回归测试。
 *
 * 真实事故：默认请求体上限 256KB，图片转 base64 后动辄几 MB，
 * 服务端直接把连接掐了 —— 适配器看到的是 ConnectionError，
 * 只好退回本地存，用户感受就是「收藏了但控制台看不到」。
 * 这里用 1MB 级 payload 验证 ingest 能收下。
 */
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

const BASE = 'http://127.0.0.1:8899';

function token() {
  try {
    return fs.readFileSync(path.join(process.cwd(), 'data', 'token.txt'), 'utf8').trim();
  } catch {
    return '';
  }
}

async function alive() {
  try {
    const r = await fetch(BASE + '/api/adapter/config', { signal: AbortSignal.timeout(1500) });
    return r.status < 500;
  } catch {
    return false;
  }
}

test('素材上传：1MB 级 base64 不会被连接掐断', async (t) => {
  if (!(await alive())) {
    t.skip('服务没在跑');
    return;
  }

  // 造一张真实 PNG（1x1 重复填充到 ~1MB 不现实，直接用随机字节拼合法 PNG 头会解不出尺寸）
  // 这里用一张 800x800 纯色 PNG，压缩后不大，但 JSON 体积足够验证「超过 256KB」这条
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  // 把图片重复填充：内容不变，但 payload 体积变大（模拟大图）
  const big = Buffer.concat([png, Buffer.alloc(600 * 1024, 0x20)]);

  const r = await fetch(BASE + '/api/media/ingest', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-local-token': token() },
    body: JSON.stringify({ kind: 'sticker', data: big.toString('base64') }),
    signal: AbortSignal.timeout(20000),
  });

  // 不管入没入库，测试都不该往真实素材库里塞东西
  // （以前这里塞进了一张 1×1 的 614KB 假图，后来还被真的发出去过）

  assert.ok(r.status === 200, `期望 200，实际 ${r.status}（连接被掐说明请求体上限太小）`);
  const j = await r.json();
  assert.equal(typeof j, 'object');

  // 如果能入库，就把测试自己造的那份删掉 —— 测试不该污染用户素材库
  if (j.ok && j.name) {
    try {
      await fetch(BASE + '/api/admin/media/delete-batch', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-local-token': token() },
        body: JSON.stringify({ kind: 'stickers', names: [j.name] }),
        signal: AbortSignal.timeout(8000),
      });
    } catch {}
  }
});
